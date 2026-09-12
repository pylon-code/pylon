import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ComputerSetupError,
  isComputerSetupRunning,
  type ComputerRelease,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { ServerSettingsService } from "../serverSettings.ts";
import { ComputerRuntimeGate } from "./ComputerRuntimeGate.ts";
import {
  CuaDriverBackend,
  unknownComputerPermissions,
  type CuaInstallHooks,
} from "./CuaDriverBackend.ts";
import { makeComputerSetupService } from "./ComputerSetupService.ts";

const release: ComputerRelease = {
  version: "0.28.1",
  releaseUrl: "https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.28.1",
  assetName: "driver",
  sha256: "a".repeat(64),
  bytes: 42,
};
const fixture = Effect.gen(function* () {
  let settings = { ...DEFAULT_SERVER_SETTINGS };
  let probes = 0;
  let installs = 0;
  let activated = 0;
  let installWork: (hooks: CuaInstallHooks) => Effect.Effect<void, ComputerSetupError> = (hooks) =>
    hooks.activate(
      Effect.sync(() => {
        activated++;
      }),
    );
  let fetch = Effect.succeed(release).pipe(
    Effect.mapError(() => new ComputerSetupError({ operation: "fetch", message: "offline" })),
  );
  const backend = CuaDriverBackend.of({
    platform: "darwin",
    architecture: "arm64",
    inspect: (configuredPath) =>
      Effect.sync(() => {
        probes++;
        return {
          status: "ready",
          source: "system",
          version: "0.28.0",
          binaryPath: configuredPath,
          message: null,
          canManage: true,
        } as const;
      }),
    resolve: (path) => Effect.succeed(path),
    permissions: () => Effect.succeed(unknownComputerPermissions),
    grantPermissions: () =>
      Effect.succeed({
        ...unknownComputerPermissions,
        accessibility: "granted",
        screenRecording: "granted",
      }),
    install: (_, hooks) =>
      Effect.sync(() => {
        installs++;
      }).pipe(Effect.andThen(() => installWork(hooks))),
  });
  const service = yield* makeComputerSetupService(Effect.suspend(() => fetch)).pipe(
    Effect.provideService(CuaDriverBackend, backend),
    Effect.provide(Layer.mock(ServerSettingsService)({ getSettings: Effect.sync(() => settings) })),
  );
  const settled = service.changes.pipe(
    Stream.filter((value) => value.operationId !== null && !isComputerSetupRunning(value.phase)),
    Stream.take(1),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );
  return {
    service,
    settled,
    probes: () => probes,
    installs: () => installs,
    activated: () => activated,
    setPath: (path: string) =>
      Effect.sync(() => {
        settings = { ...settings, computerUseBinaryPath: path };
      }),
    setInstall: (work: typeof installWork) =>
      Effect.sync(() => {
        installWork = work;
      }),
    setFetch: (next: typeof fetch) =>
      Effect.sync(() => {
        fetch = next;
      }),
    offline: Effect.sync(() => {
      fetch = Effect.fail(new ComputerSetupError({ operation: "fetch", message: "offline" }));
    }),
  };
});
const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(Layer.mergeAll(ComputerRuntimeGate.layer, NodeServices.layer)),
    Effect.scoped,
  );
it.effect(
  "constructs without probing and refreshes installation independently of a failed update check",
  () =>
    provide(
      Effect.gen(function* () {
        const f = yield* fixture;
        expect(f.probes()).toBe(0);
        yield* f.offline;
        yield* f.service.refresh(true);
        const state = yield* f.settled;
        expect(state?.installation.version).toBe("0.28.0");
        expect(state?.updateMessage).toBe("offline");
        expect(f.installs()).toBe(0);
      }),
    ),
);
it.effect("rejects stale releases and custom executables before installation", () =>
  provide(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.service.refresh(true);
      yield* f.settled;
      expect(
        (yield* f.service
          .start({ action: "update", expectedVersion: "0.27.0" })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      yield* f.setPath("/custom/cua");
      expect(
        (yield* f.service
          .start({ action: "update", expectedVersion: release.version })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(f.installs()).toBe(0);
    }),
  ),
);
it.effect("cancels the exact operation and refuses a second install while work is active", () =>
  provide(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.service.refresh(true);
      yield* f.settled;
      const entered = yield* Deferred.make<void>();
      yield* f.setInstall(() =>
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      );
      const started = yield* f.service.start({
        action: "update",
        expectedVersion: release.version,
      });
      yield* Deferred.await(entered);
      expect((yield* f.service.cancel("stale").pipe(Effect.result))._tag).toBe("Failure");
      expect(
        (yield* f.service
          .start({ action: "repair", expectedVersion: release.version })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      const cancelled = yield* f.service.cancel(started.operationId ?? "");
      expect(cancelled.phase).toBe("cancelled");
      expect(f.activated()).toBe(0);
    }),
  ),
);
it.effect("rechecks executable selection after download and before activation", () =>
  provide(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.service.refresh(true);
      yield* f.settled;
      const entered = yield* Deferred.make<void>();
      const continueInstall = yield* Deferred.make<void>();
      yield* f.setInstall((hooks) =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(continueInstall)),
          Effect.andThen(hooks.activate(Effect.die("must not activate"))),
        ),
      );
      yield* f.service.start({ action: "update", expectedVersion: release.version });
      yield* Deferred.await(entered);
      yield* f.setPath("/different");
      yield* Deferred.succeed(continueInstall, undefined);
      expect((yield* f.settled)?.message).toContain("executable changed");
    }),
  ),
);
it.effect("maintenance waits for an active action, closes consumers, and rejects new actions", () =>
  provide(
    Effect.gen(function* () {
      const gate = yield* ComputerRuntimeGate;
      const entered = yield* Deferred.make<void>();
      const releaseAction = yield* Deferred.make<void>();
      const closed = yield* Deferred.make<void>();
      const finishMaintenance = yield* Deferred.make<void>();
      yield* gate.register(Deferred.succeed(closed, undefined).pipe(Effect.asVoid));
      const action = yield* gate
        .access(
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(releaseAction))),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      const maintenance = yield* gate
        .maintenance(Deferred.await(finishMaintenance))
        .pipe(Effect.forkScoped);
      yield* Deferred.succeed(releaseAction, undefined);
      yield* Fiber.join(action);
      yield* Deferred.await(closed);
      expect((yield* gate.access(Effect.void).pipe(Effect.result))._tag).toBe("Failure");
      yield* Deferred.succeed(finishMaintenance, undefined);
      yield* Fiber.join(maintenance);
      yield* gate.access(Effect.void);
    }),
  ),
);

it.effect(
  "refreshes the newly selected executable when settings change during release lookup",
  () =>
    provide(
      Effect.gen(function* () {
        const f = yield* fixture;
        const entered = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        yield* f.setFetch(
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(resume)),
            Effect.as(release),
          ),
        );
        yield* f.service.refresh(true);
        yield* Deferred.await(entered);
        yield* f.setPath("/new-selection");
        yield* f.service.refresh(false);
        yield* Deferred.succeed(resume, undefined);
        expect((yield* f.settled).installation.binaryPath).toBe("/new-selection");
      }),
    ),
);
