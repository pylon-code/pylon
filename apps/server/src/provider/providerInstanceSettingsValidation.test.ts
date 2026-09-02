import { NodeServices } from "@effect/platform-node";
import {
  ProviderDriverKind,
  ServerSettings,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";

import {
  getProviderMultipleInstanceSupport,
  PRIME_AGENT_SUPPORTED_INSTANCE_LIMIT,
  validateProviderInstanceSettings,
} from "./providerInstanceSettingsValidation.ts";

const decodeSettings = Schema.decodeUnknownSync(ServerSettings);
const prime = ProviderDriverKind.make("primeAgent");
const instance = (home: string): ProviderInstanceConfig => ({
  driver: prime,
  enabled: true,
  config: { agentHomePath: home },
});

function settingsWithInstances(providerInstances: Record<string, ProviderInstanceConfig>) {
  return decodeSettings({ providerInstances });
}

describe("provider multiple-instance settings validation", () => {
  it("is explicit for built-ins, fail-closed for unknown drivers, and zero-work on native Windows", () => {
    expect(getProviderMultipleInstanceSupport("codex", "darwin")).toEqual({ supported: true });
    expect(getProviderMultipleInstanceSupport("primeAgent", "linux")).toMatchObject({
      supported: false,
      reason: expect.stringMatching(/N=1\/2\/4/u),
    });
    expect(getProviderMultipleInstanceSupport("primeAgent", "win32")).toMatchObject({
      supported: false,
      reason: expect.stringContaining("WSL2"),
    });
    expect(getProviderMultipleInstanceSupport("forkDriver", "darwin")).toMatchObject({
      supported: false,
      reason: expect.stringContaining("has not proved"),
    });
  });

  it.effect("keeps four independent Prime homes gated until graduation proof", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "pylon-prime-multi-settings-" });
        const providerInstances: Record<string, ProviderInstanceConfig> = {};
        for (let index = 0; index < PRIME_AGENT_SUPPORTED_INSTANCE_LIMIT; index += 1) {
          const home = path.join(root, `account-${index}`);
          yield* fs.makeDirectory(home);
          providerInstances[index === 0 ? "primeAgent" : `prime_${index}`] =
            index === 1
              ? {
                  driver: prime,
                  enabled: true,
                  environment: [
                    { name: "PRIME_AGENT_CODING_AGENT_DIR", value: home, sensitive: false },
                  ],
                  config: {},
                }
              : instance(home);
        }

        const error = yield* validateProviderInstanceSettings({
          settings: settingsWithInstances(providerInstances),
          platform: "darwin",
          hostEnvironment: { HOME: root },
        }).pipe(Effect.flip);
        expect(error.detail).toMatch(/N=1\/2\/4/u);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects an ACP-only participant before persistence", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "pylon-prime-acp-settings-" });
        const first = path.join(root, "first");
        const second = path.join(root, "second");
        yield* fs.makeDirectory(first);
        yield* fs.makeDirectory(second);
        const error = yield* validateProviderInstanceSettings({
          settings: settingsWithInstances({
            primeAgent: instance(first),
            prime_work: {
              driver: prime,
              enabled: true,
              config: { agentHomePath: second, launchArgs: "--verbose" },
            },
          }),
          platform: "darwin",
          hostEnvironment: { HOME: root },
        }).pipe(Effect.flip);

        expect(error.detail).toContain("explicitly ACP-only");
        expect(error.detail).toContain("native-only");
        expect(error.detail).not.toContain(root);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects equal, nested, and symlink-aliased Prime homes before persistence", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "pylon-prime-overlap-settings-" });
        const account = path.join(root, "account");
        const alias = path.join(root, "alias");
        yield* fs.makeDirectory(account);
        yield* fs.symlink(account, alias);

        for (const other of [account, path.join(account, "nested"), alias]) {
          const error = yield* validateProviderInstanceSettings({
            settings: settingsWithInstances({
              primeAgent: instance(account),
              prime_work: instance(other),
            }),
            platform: "darwin",
            hostEnvironment: { HOME: root },
          }).pipe(Effect.flip);
          expect(error.detail).toMatch(/equal|nested|symlink/u);
          expect(error.detail).toContain("separate Prime sign-in");
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a fifth Prime instance and a second enabled unproved driver", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "pylon-prime-limit-settings-" });
        const tooMany: Record<string, ProviderInstanceConfig> = {};
        for (let index = 0; index <= PRIME_AGENT_SUPPORTED_INSTANCE_LIMIT; index += 1) {
          const home = path.join(root, `account-${index}`);
          yield* fs.makeDirectory(home);
          tooMany[index === 0 ? "primeAgent" : `prime_${index}`] = instance(home);
        }
        const limit = yield* validateProviderInstanceSettings({
          settings: settingsWithInstances(tooMany),
          platform: "darwin",
          hostEnvironment: { HOME: root },
        }).pipe(Effect.flip);
        expect(limit.detail).toContain(`at most ${PRIME_AGENT_SUPPORTED_INSTANCE_LIMIT}`);

        const fork = ProviderDriverKind.make("forkDriver");
        const unsupported = yield* validateProviderInstanceSettings({
          settings: settingsWithInstances({
            fork_one: { driver: fork, enabled: true },
            fork_two: { driver: fork, enabled: true },
          }),
          platform: "darwin",
          hostEnvironment: { HOME: root },
        }).pipe(Effect.flip);
        expect(unsupported.detail).toContain("has not proved");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps two ordinary Codex instances unchanged", () =>
    validateProviderInstanceSettings({
      settings: settingsWithInstances({
        codex: { driver: ProviderDriverKind.make("codex"), enabled: true },
        codex_work: { driver: ProviderDriverKind.make("codex"), enabled: true },
      }),
      platform: "darwin",
      hostEnvironment: { HOME: "/tmp" },
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
