import {
  compareCuaVersions,
  ComputerSetupError,
  isComputerSetupRunning,
  type ComputerSetupState,
  type ComputerSetupStartInput,
  type ComputerRelease,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient } from "effect/unstable/http";
import { ServerSettingsService } from "../serverSettings.ts";
import { CuaDriverBackend, unknownComputerPermissions } from "./CuaDriverBackend.ts";
import { ComputerRuntimeGate } from "./ComputerRuntimeGate.ts";
import { fetchCuaRelease } from "./CuaRelease.ts";

export class ComputerSetupService extends Context.Service<
  ComputerSetupService,
  {
    readonly changes: Stream.Stream<ComputerSetupState>;
    readonly state: Effect.Effect<ComputerSetupState>;
    readonly refresh: (
      checkUpdates: boolean,
    ) => Effect.Effect<ComputerSetupState, ComputerSetupError>;
    readonly start: (
      input: ComputerSetupStartInput,
    ) => Effect.Effect<ComputerSetupState, ComputerSetupError>;
    readonly cancel: (operationId: string) => Effect.Effect<ComputerSetupState, ComputerSetupError>;
  }
>()("t3/computer/ComputerSetupService") {
  static readonly layer = Layer.effect(
    ComputerSetupService,
    Effect.gen(function* () {
      const backend = yield* CuaDriverBackend;
      const http = yield* HttpClient.HttpClient;
      const fetch = fetchCuaRelease(backend.platform, backend.architecture).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
      );
      return yield* makeComputerSetupService(fetch);
    }),
  );
}
const error = (operation: string, message: string) =>
  new ComputerSetupError({ operation, message });

/** Environment-owned workers survive RPC disconnects; construction never probes the desktop. */
export const makeComputerSetupService = Effect.fn("ComputerSetupService.make")(function* (
  fetchRelease: Effect.Effect<ComputerRelease, ComputerSetupError>,
) {
  const backend = yield* CuaDriverBackend;
  const runtime = yield* ComputerRuntimeGate;
  const settings = yield* ServerSettingsService;
  const crypto = yield* Crypto.Crypto;
  const scope = yield* Effect.scope;
  const admission = yield* Semaphore.make(1);
  let running: { operationId: string; fiber: Fiber.Fiber<void> } | undefined;
  const state = yield* SubscriptionRef.make<ComputerSetupState>({
    platform: backend.platform,
    architecture: backend.architecture,
    installation: {
      status: "unknown",
      source: "system",
      binaryPath: null,
      version: null,
      canManage: false,
      message: null,
    },
    permissions: unknownComputerPermissions,
    latestRelease: null,
    checkedAt: null,
    updateMessage: null,
    operationId: null,
    action: null,
    phase: "idle",
    downloadedBytes: 0,
    totalBytes: null,
    message: null,
  });
  const readSettings = settings.getSettings.pipe(
    Effect.mapError(() =>
      error("settings", "Could not read this environment's computer settings."),
    ),
  );
  const probe = Effect.fn("ComputerSetupService.probe")(function* (configuredPath: string) {
    let candidate = configuredPath;
    for (let attempt = 0; attempt < 3; attempt++) {
      const installation = yield* backend.inspect(candidate);
      const permissions =
        installation.status === "ready" && installation.binaryPath
          ? yield* backend
              .permissions(installation.binaryPath)
              .pipe(
                Effect.catch((cause) =>
                  Effect.succeed({ ...unknownComputerPermissions, message: cause.message }),
                ),
              )
          : unknownComputerPermissions;
      const latest = yield* readSettings;
      if (latest.computerUseBinaryPath !== candidate) {
        candidate = latest.computerUseBinaryPath;
        continue;
      }
      yield* SubscriptionRef.update(state, (current) => ({
        ...current,
        installation,
        permissions,
      }));
      return installation;
    }
    return yield* error(
      "settings",
      "Computer settings kept changing during the check. Check again after choosing an executable.",
    );
  });
  const launch = Effect.fn("ComputerSetupService.launch")(function* (
    action: NonNullable<ComputerSetupState["action"]>,
    phase: ComputerSetupState["phase"],
    work: Effect.Effect<void, ComputerSetupError>,
  ) {
    if (running)
      return yield* error(
        "busy",
        "Computer setup is already running. Wait for it to finish or cancel the current operation.",
      );
    const operationId = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError(() => error("start", "Could not create a setup operation.")),
    );
    yield* SubscriptionRef.update(state, (current) => ({
      ...current,
      operationId,
      action,
      phase,
      message: null,
      downloadedBytes: 0,
      totalBytes: null,
    }));
    const worker = work.pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          if (running?.operationId === operationId) running = undefined;
        }).pipe(
          Effect.andThen(
            SubscriptionRef.update(state, (current) => {
              if (current.operationId !== operationId || current.phase === "succeeded")
                return current;
              if (Exit.isSuccess(exit))
                return { ...current, phase: "succeeded" } satisfies ComputerSetupState;
              const cause = Cause.findErrorOption(exit.cause);
              const cancelled = Cause.hasInterruptsOnly(exit.cause);
              return {
                ...current,
                phase: cancelled ? "cancelled" : "failed",
                message: cancelled
                  ? "Setup cancelled. Check again to refresh the driver and permission status."
                  : Option.isSome(cause)
                    ? cause.value.message
                    : "Computer setup could not finish. Check again before retrying.",
              } satisfies ComputerSetupState;
            }),
          ),
        ),
      ),
      Effect.ignoreCause,
      Effect.ensuring(
        Effect.sync(() => {
          if (running?.operationId === operationId) running = undefined;
        }),
      ),
    );
    const fiber = yield* Effect.forkIn(Effect.interruptible(worker), scope);
    running = { operationId, fiber };
    return yield* SubscriptionRef.get(state);
  });
  const refresh = (checkUpdates: boolean) =>
    admission.withPermit(
      Effect.gen(function* () {
        if (running) return yield* SubscriptionRef.get(state);
        return yield* launch(
          "check",
          "checking",
          Effect.gen(function* () {
            const selected = yield* readSettings;
            yield* probe(selected.computerUseBinaryPath);
            if (checkUpdates) {
              const result = yield* fetchRelease.pipe(Effect.result);
              const now = yield* DateTime.now;
              yield* SubscriptionRef.update(state, (current) => ({
                ...current,
                latestRelease: result._tag === "Success" ? result.success : null,
                checkedAt: DateTime.formatIso(now),
                updateMessage: result._tag === "Failure" ? result.failure.message : null,
              }));
            }
            const latest = yield* readSettings;
            if (latest.computerUseBinaryPath !== selected.computerUseBinaryPath)
              yield* probe(latest.computerUseBinaryPath);
          }),
        );
      }).pipe(Effect.uninterruptible),
    );
  const start = (input: ComputerSetupStartInput) =>
    admission.withPermit(
      Effect.gen(function* () {
        if (running) return yield* error("busy", "Computer setup is already running.");
        const selected = yield* readSettings;
        const current = yield* SubscriptionRef.get(state);
        const installation = current.installation;
        if (input.action === "permissions") {
          if (
            installation.status !== "ready" ||
            !installation.binaryPath ||
            backend.platform !== "darwin"
          )
            return yield* error(
              "permissions",
              "Check the CuaDriver installation before opening macOS permission setup.",
            );
          return yield* launch(
            input.action,
            "permissions",
            runtime.maintenance(
              Effect.gen(function* () {
                const latest = yield* readSettings;
                const checked = yield* backend.inspect(latest.computerUseBinaryPath);
                if (checked.status !== "ready" || !checked.binaryPath)
                  return yield* error(
                    "permissions",
                    "The selected driver is unavailable. Check its installation again.",
                  );
                const binary = checked.binaryPath;
                const permissions = yield* backend.grantPermissions(binary);
                const after = yield* readSettings;
                if (after.computerUseBinaryPath === latest.computerUseBinaryPath)
                  yield* SubscriptionRef.update(state, (value) => ({
                    ...value,
                    installation: checked,
                    permissions,
                  }));
                else yield* probe(after.computerUseBinaryPath);
              }),
            ),
          );
        }
        const release = current.latestRelease;
        if (!release || release.version !== input.expectedVersion)
          return yield* error(
            "release",
            "The selected release is no longer current. Check for updates again.",
          );
        if (
          !installation.canManage ||
          !["", "cua-driver", "cua-driver.exe"].includes(selected.computerUseBinaryPath.trim())
        )
          return yield* error(
            "custom",
            "Automatic setup is unavailable for a custom executable. Select the default Cua Driver path to use managed setup.",
          );
        if (installation.version && compareCuaVersions(release.version, installation.version) < 0)
          return yield* error(
            "version",
            "The installed driver is newer than this release. Pylon will not downgrade it.",
          );
        return yield* launch(
          input.action,
          "downloading",
          backend
            .install(release, {
              report: (progress) =>
                SubscriptionRef.update(state, (value) => ({ ...value, ...progress })),
              activate: (work) =>
                runtime.maintenance(
                  Effect.gen(function* () {
                    const latest = yield* readSettings;
                    if (latest.computerUseBinaryPath !== selected.computerUseBinaryPath)
                      return yield* error(
                        "settings",
                        "The computer executable changed during setup. Nothing was activated; check again.",
                      );
                    yield* work;
                  }),
                ),
            })
            .pipe(
              Effect.onExit(() =>
                Effect.gen(function* () {
                  const latest = yield* readSettings;
                  yield* probe(latest.computerUseBinaryPath);
                }).pipe(Effect.ignore),
              ),
              Effect.asVoid,
            ),
        );
      }).pipe(Effect.uninterruptible),
    );
  const cancel = (operationId: string) =>
    admission.withPermit(
      Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(state);
        if (current.operationId !== operationId)
          return yield* error(
            "cancel",
            "This setup operation is no longer current. Refresh its status before cancelling.",
          );
        if (current.phase === "activating")
          return yield* error(
            "cancel",
            "Cua Driver is being activated. Wait for this step to finish.",
          );
        if (running?.operationId === operationId && isComputerSetupRunning(current.phase))
          yield* Fiber.interrupt(running.fiber);
        return yield* SubscriptionRef.get(state);
      }),
    );
  return ComputerSetupService.of({
    state: SubscriptionRef.get(state),
    changes: SubscriptionRef.changes(state),
    refresh,
    start,
    cancel,
  });
});
