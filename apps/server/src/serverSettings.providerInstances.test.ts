// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProviderInstancesMutationId,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { describe, expect, it } from "@effect/vitest";

import { ServerSettingsService } from "./serverSettings.ts";

const codex = ProviderDriverKind.make("codex");
const aId = ProviderInstanceId.make("codex_a");
const bId = ProviderInstanceId.make("codex_b");
const a: ProviderInstanceConfig = { driver: codex, enabled: true, displayName: "A" };
const b: ProviderInstanceConfig = { driver: codex, enabled: true, displayName: "B" };
const mutationId = (value: string) => ServerProviderInstancesMutationId.make(value);
const prime = ProviderDriverKind.make("primeAgent");
const primeInstance = (home: string, launchArgs = ""): ProviderInstanceConfig => ({
  driver: prime,
  enabled: true,
  config: { agentHomePath: home, ...(launchArgs === "" ? {} : { launchArgs }) },
});

describe("provider instance host CAS receipts", () => {
  it.effect(
    "is idempotent, rejects mutation-id reuse, and preserves unrelated instances on removal",
    () =>
      Effect.gen(function* () {
        const settings = yield* ServerSettingsService;
        const create = {
          mutationId: mutationId("create-a"),
          expectedProviderInstances: {},
          patch: { providerInstances: { [aId]: a, [bId]: b } },
        } as const;
        const applied = yield* settings.mutateProviderInstances(create);
        const repeated = yield* settings.mutateProviderInstances(create);
        expect(applied.disposition).toBe("applied");
        expect(repeated.disposition).toBe("already-applied");

        const reused = yield* settings
          .mutateProviderInstances({
            ...create,
            patch: { providerInstances: { [aId]: { ...a, displayName: "Other" } } },
          })
          .pipe(Effect.flip);
        expect(reused).toMatchObject({
          _tag: "ServerProviderInstancesMutationConflictError",
          reason: "mutation-reused",
        });

        const removed = yield* settings.mutateProviderInstances({
          mutationId: mutationId("remove-a"),
          expectedProviderInstances: { [aId]: a, [bId]: b },
          patch: { providerInstances: { [bId]: b } },
        });
        expect(removed.settings.providerInstances[aId]).toBeUndefined();
        expect(removed.settings.providerInstances[bId]).toEqual(b);
      }).pipe(Effect.provide(ServerSettingsService.layerTest())),
  );

  it.effect("serializes two remote clients against one host snapshot", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettingsService;
      const exits = yield* Effect.all(
        [
          settings.mutateProviderInstances({
            mutationId: mutationId("client-a"),
            expectedProviderInstances: {},
            patch: { providerInstances: { [aId]: a } },
          }),
          settings.mutateProviderInstances({
            mutationId: mutationId("client-b"),
            expectedProviderInstances: {},
            patch: { providerInstances: { [bId]: b } },
          }),
        ].map(Effect.exit),
        { concurrency: "unbounded" },
      );
      expect(exits.filter(Exit.isSuccess)).toHaveLength(1);
      expect(exits.filter(Exit.isFailure)).toHaveLength(1);
      const current = yield* settings.getSettings;
      expect(Object.keys(current.providerInstances)).toHaveLength(1);
    }).pipe(Effect.provide(ServerSettingsService.layerTest())),
  );

  it.effect("rejects invalid native-only Prime sets without mutating the host CAS snapshot", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "prime-host-cas-"))),
      (root) =>
        Effect.gen(function* () {
          const settings = yield* ServerSettingsService;
          const home = (name: string) => {
            const value = NodePath.join(root, name);
            NodeFS.mkdirSync(value, { recursive: true });
            return value;
          };
          const distinct = {
            [ProviderInstanceId.make("prime_a")]: primeInstance(home("a")),
            [ProviderInstanceId.make("prime_b")]: primeInstance(home("b")),
          };
          const invalidSets = [
            {
              ...distinct,
              [ProviderInstanceId.make("prime_b")]: primeInstance(home("b"), "--acp-only"),
            },
            {
              [ProviderInstanceId.make("prime_a")]: primeInstance(home("shared")),
              [ProviderInstanceId.make("prime_b")]: primeInstance(home("shared/nested")),
            },
            Object.fromEntries(
              Array.from({ length: 5 }, (_, index) => [
                ProviderInstanceId.make(index === 0 ? "primeAgent" : `prime_${index}`),
                primeInstance(home(`limit-${index}`)),
              ]),
            ),
          ];

          for (const [index, providerInstances] of invalidSets.entries()) {
            const rejected = yield* settings
              .mutateProviderInstances({
                mutationId: mutationId(`invalid-prime-${index}`),
                expectedProviderInstances: {},
                patch: { providerInstances },
              })
              .pipe(Effect.flip);
            expect(rejected).toMatchObject({ _tag: "ServerSettingsError", operation: "normalize" });
            expect((yield* settings.getSettings).providerInstances).toEqual({});
          }

          const gated = yield* settings
            .mutateProviderInstances({
              mutationId: mutationId("graduation-gated-prime-native-set"),
              expectedProviderInstances: {},
              patch: { providerInstances: distinct },
            })
            .pipe(Effect.flip);
          expect(gated).toMatchObject({ _tag: "ServerSettingsError", operation: "normalize" });
          expect(gated.message).toMatch(/N=1\/2\/4/u);
          expect((yield* settings.getSettings).providerInstances).toEqual({});
        }),
      (root) => Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
    ).pipe(Effect.provide(ServerSettingsService.layerTest())),
  );

  it.effect("recognizes an already-applied mutation after a server service restart", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettingsService;
      const receipt = yield* settings.mutateProviderInstances({
        mutationId: mutationId("retry-after-restart"),
        expectedProviderInstances: {},
        patch: { providerInstances: { [aId]: a } },
      });
      expect(receipt.disposition).toBe("already-applied");
      expect(receipt.settings.providerInstances[aId]).toEqual(a);
    }).pipe(Effect.provide(ServerSettingsService.layerTest({ providerInstances: { [aId]: a } }))),
  );
});
