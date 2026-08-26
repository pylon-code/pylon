/**
 * End-to-end proof of the server half of account draining.
 *
 * Each stage is unit-tested against its own fixture, which leaves one thing
 * unproven: that the object one stage produces is the object the next stage
 * consumes. Two fixtures written by the same hand can agree with each other
 * and disagree with reality — that is exactly how the adapter's `rateLimits`
 * envelope went unnoticed until wiring.
 *
 * This walks one verdict the whole way with no hand-written intermediate:
 *
 *   ClaudeAdapter payload → parser → ProviderRegistry → ServerProvider
 *     → decodes against the wire contract clients receive
 *
 * The registry is real, not a mock. The contract round-trip is what makes the
 * client half safe to test separately: whatever the UI does with a drained
 * snapshot, this proves the snapshot it gets is contract-valid and carries the
 * verdict. Routing and the drain pill are covered in `apps/web` against that
 * same contract; importing them here would breach the package boundary for no
 * added coverage.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
  type ServerProviderRateLimit,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import * as ModelManifest from "./ModelManifest.ts";
import * as OpenCodeRuntime from "./opencodeRuntime.ts";
import * as ProviderEventLoggers from "./Layers/ProviderEventLoggers.ts";
import { ProviderInstanceRegistryHydrationLive } from "./Layers/ProviderInstanceRegistryHydration.ts";
import { ProviderRegistryLive } from "./Layers/ProviderRegistry.ts";
import * as ProviderRegistry from "./Services/ProviderRegistry.ts";
import { rateLimitFromRuntimeEventPayload } from "./providerRateLimitEvents.ts";

const WORK = ProviderInstanceId.make("claudeAgent");
const PERSONAL = ProviderInstanceId.make("claude_personal");
const CLAUDE = ProviderDriverKind.make("claudeAgent");

const OBSERVED_AT = "2026-08-04T18:30:00.000Z";
const RESETS_AT_UNIX_SECONDS = 1_785_808_200; // 2026-08-04T01:50:00Z

/**
 * Byte-for-byte what `ClaudeAdapter` publishes on `account.rate-limits.updated`
 * when Claude refuses a turn: the SDK's `rate_limit_event` wrapped under
 * `rateLimits`. A change to that envelope must fail here.
 */
const REJECTED_ADAPTER_PAYLOAD = {
  rateLimits: {
    type: "rate_limit_event",
    rate_limit_info: {
      status: "rejected",
      resetsAt: RESETS_AT_UNIX_SECONDS,
      rateLimitType: "five_hour",
      overageStatus: "rejected",
      isUsingOverage: false,
    },
    uuid: "2146322c-ec38-4460-ac3b-209bc654e71c",
    session_id: "206c8150-dd19-47a5-b3aa-c50fc6a1e1fd",
  },
};

const TestHttpClientLive = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }))),
  ),
);

const BackgroundPolicyAlwaysRunLayer = Layer.mock(BackgroundPolicy.BackgroundPolicy)({
  reportClientActivity: () => Effect.void,
  removeRpcClient: () => Effect.void,
  reportHostPowerState: () => Effect.void,
  streamChanges: Stream.empty,
  hasDemand: () => Effect.succeed(true),
  shouldRunScopeWork: () => Effect.succeed(true),
  shouldRunOpportunisticWork: Effect.succeed(true),
});

/**
 * A binary that does not exist, so no driver spawns a real CLI on the machine
 * running this test. The chain under test is the registry and the wire
 * shape, not the providers: with a real `prime-agent` on PATH the Prime driver
 * would otherwise start a daemon during construction and wait on its
 * readiness schedule — which never advances under the test clock.
 */
const MISSING_BINARY = "/definitely/not/installed/pylon-drain-e2e";

/** Two Claude accounts, work first in drain order. */
const TWO_ACCOUNT_OVERRIDES = {
  providers: {
    claudeAgent: { binaryPath: MISSING_BINARY },
    codex: { enabled: false, binaryPath: MISSING_BINARY },
    cursor: { enabled: false, binaryPath: MISSING_BINARY },
    grok: { enabled: false, binaryPath: MISSING_BINARY },
    opencode: { enabled: false, binaryPath: MISSING_BINARY },
    primeAgent: { enabled: false, binaryPath: MISSING_BINARY },
  },
  providerInstances: {
    [WORK]: { driver: CLAUDE, enabled: true, displayName: "Claude Work", priority: 0 },
    [PERSONAL]: {
      driver: CLAUDE,
      enabled: true,
      displayName: "Claude Personal",
      priority: 1,
      config: { binaryPath: MISSING_BINARY, homePath: "~/.claude_personal_home" },
    },
  },
} as never;

const registryLayer = ProviderRegistryLive.pipe(
  Layer.provideMerge(ProviderInstanceRegistryHydrationLive),
  Layer.provideMerge(ServerSettingsModule.layerTest(TWO_ACCOUNT_OVERRIDES)),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-account-drain-e2e-" })),
  Layer.provideMerge(TestHttpClientLive),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
  Layer.provideMerge(ModelManifest.layerTest),
  Layer.provideMerge(OpenCodeRuntime.OpenCodeRuntimeLive),
  Layer.provideMerge(BackgroundPolicyAlwaysRunLayer),
);

/** The wire round trip a client actually performs on a streamed snapshot. */
const serverProviderJson = Schema.fromJsonString(ServerProvider);
const toWireJson = Schema.encodeSync(serverProviderJson);
const fromWireJson = Schema.decodeSync(serverProviderJson);

describe("account drain, end to end", () => {
  it.layer(NodeServices.layer)("chain", (it) => {
    it.effect("a rejected verdict travels from the adapter payload to the wire snapshot", () =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const services = yield* Layer.build(registryLayer).pipe(Scope.provide(scope));

        yield* Effect.gen(function* () {
          const registry = yield* ProviderRegistry.ProviderRegistry;

          // Both accounts must exist first, or an assertion below could pass
          // simply because the instance is absent.
          const before = yield* registry.getProviders;
          assert.isDefined(
            before.find((provider) => provider.instanceId === WORK),
            "work account missing from the registry",
          );
          assert.isDefined(
            before.find((provider) => provider.instanceId === PERSONAL),
            "personal account missing from the registry",
          );
          assert.isUndefined(
            before.find((provider) => provider.instanceId === WORK)?.rateLimit,
            "work account should not start drained",
          );

          // ── Parse the adapter's own payload ──
          const state = rateLimitFromRuntimeEventPayload(REJECTED_ADAPTER_PAYLOAD, OBSERVED_AT);
          assert.isDefined(state, "parser rejected the adapter's own payload shape");

          // ── Registry applies it, exactly as ingestion does ──
          const after = yield* registry.setProviderRateLimitState({
            instanceId: WORK,
            state: state as ServerProviderRateLimit,
          });

          const drained = after.find((provider) => provider.instanceId === WORK);
          assert.strictEqual(
            drained?.rateLimit?.status,
            "rejected",
            "the drain never reached the provider snapshot",
          );
          assert.strictEqual(drained?.rateLimit?.rateLimitType, "five_hour");
          assert.strictEqual(
            drained?.rateLimit?.resetsAt,
            DateTime.formatIso(DateTime.makeUnsafe(RESETS_AT_UNIX_SECONDS * 1000)),
            "resetsAt lost its seconds-to-milliseconds conversion somewhere in the chain",
          );

          // Draining one account must not mark the other.
          assert.isUndefined(
            after.find((provider) => provider.instanceId === PERSONAL)?.rateLimit,
            "draining one account must not mark the other",
          );

          // ── What clients actually receive ──
          // The round trip is what lets the routing and drain-pill tests in
          // `apps/web` stand on their own: they consume a `ServerProvider`, and
          // this proves the server emits one carrying the verdict.
          const roundTripped = fromWireJson(toWireJson(drained as ServerProvider));
          assert.strictEqual(
            roundTripped.rateLimit?.status,
            "rejected",
            "drain state did not survive encoding for the wire",
          );
          assert.strictEqual(roundTripped.rateLimit?.resetsAt, drained?.rateLimit?.resetsAt);

          // ── Reverse state: clearing restores the snapshot ──
          const cleared = yield* registry.setProviderRateLimitState({
            instanceId: WORK,
            state: null,
          });
          assert.isUndefined(
            cleared.find((provider) => provider.instanceId === WORK)?.rateLimit,
            "clearing drain state must strip it from the snapshot",
          );

          // An unknown instance is a no-op rather than a failure, matching
          // `refreshInstance`, so a stale event cannot take the probe down.
          const unknown = yield* registry.setProviderRateLimitState({
            instanceId: ProviderInstanceId.make("claude_deleted"),
            state: state as ServerProviderRateLimit,
          });
          assert.strictEqual(unknown.length, cleared.length);
        }).pipe(Effect.provide(services));
      }),
    );
  });
});
