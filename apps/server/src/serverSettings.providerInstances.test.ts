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
