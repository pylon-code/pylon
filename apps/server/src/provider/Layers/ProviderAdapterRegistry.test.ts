import {
  DEFAULT_SERVER_PROVIDER_RUNTIME_MODES,
  defaultInstanceIdForDriver,
  PROVIDER_FEATURE_CAPABILITIES_VERSION,
  ProviderDriverKind,
  type ServerProvider,
} from "@t3tools/contracts";
import { it, assert, vi } from "@effect/vitest";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import type * as ClaudeAdapter from "../Services/ClaudeAdapter.ts";
import type * as CodexAdapter from "../Services/CodexAdapter.ts";
import type * as CursorAdapter from "../Services/CursorAdapter.ts";
import type * as OpenCodeAdapter from "../Services/OpenCodeAdapter.ts";
import * as ProviderAdapterRegistry from "../Services/ProviderAdapterRegistry.ts";
import * as ProviderInstanceRegistry from "../Services/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import type * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import * as ProviderAdapterRegistryLayer from "./ProviderAdapterRegistry.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";

const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CLAUDE_AGENT_DRIVER = ProviderDriverKind.make("claudeAgent");
const OPENCODE_DRIVER = ProviderDriverKind.make("opencode");
const CURSOR_DRIVER = ProviderDriverKind.make("cursor");

const fakeCodexAdapter: CodexAdapter.CodexAdapterShape = {
  provider: CODEX_DRIVER,
  capabilities: { sessionModelSwitch: "in-session" },
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  interruptTurn: vi.fn(),
  respondToRequest: vi.fn(),
  respondToUserInput: vi.fn(),
  stopSession: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  readThread: vi.fn(),
  rollbackThread: vi.fn(),
  stopAll: vi.fn(),
  streamEvents: Stream.empty,
};

const fakeClaudeAdapter: ClaudeAdapter.ClaudeAdapterShape = {
  provider: CLAUDE_AGENT_DRIVER,
  capabilities: { sessionModelSwitch: "in-session" },
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  interruptTurn: vi.fn(),
  respondToRequest: vi.fn(),
  respondToUserInput: vi.fn(),
  stopSession: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  readThread: vi.fn(),
  rollbackThread: vi.fn(),
  stopAll: vi.fn(),
  streamEvents: Stream.empty,
};

const fakeOpenCodeAdapter: OpenCodeAdapter.OpenCodeAdapterShape = {
  provider: OPENCODE_DRIVER,
  capabilities: { sessionModelSwitch: "in-session" },
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  interruptTurn: vi.fn(),
  respondToRequest: vi.fn(),
  respondToUserInput: vi.fn(),
  stopSession: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  readThread: vi.fn(),
  rollbackThread: vi.fn(),
  stopAll: vi.fn(),
  streamEvents: Stream.empty,
};

const fakeCursorAdapter: CursorAdapter.CursorAdapterShape = {
  provider: CURSOR_DRIVER,
  capabilities: { sessionModelSwitch: "in-session" },
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  interruptTurn: vi.fn(),
  respondToRequest: vi.fn(),
  respondToUserInput: vi.fn(),
  stopSession: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  readThread: vi.fn(),
  rollbackThread: vi.fn(),
  stopAll: vi.fn(),
  streamEvents: Stream.empty,
};

/**
 * Build the only part of a `ServerProvider` snapshot that routing information
 * reads. Typing the input as a `Pick` keeps the runtime-mode literals and the
 * capability shape checked while eliding the ~20 unrelated required fields.
 */
type ExecutionPolicySnapshotFields = Pick<
  ServerProvider,
  "featureCapabilities" | "supportedRuntimeModes"
>;

const executionPolicySnapshot = (fields: ExecutionPolicySnapshotFields): ServerProvider =>
  fields as unknown as ServerProvider;

// ProviderAdapterRegistryLive is now a facade over ProviderInstanceRegistry —
// it walks `listInstances` once at boot and surfaces the default-instance
// adapter keyed by its driver kind. To test the facade we supply four fake
// instances whose `instanceId === defaultInstanceIdForDriver(driverKind)` so
// they pass the default-instance filter.
const makeFakeInstance = (
  driverKindString: "codex" | "claudeAgent" | "cursor" | "opencode",
  adapter: ProviderInstance["adapter"],
  // Routing information is derived from the live snapshot, so tests that care
  // about a provider's published execution policy hand one in. An absent
  // effect models a legacy producer that declares no policy at all.
  readSnapshot: Effect.Effect<ServerProvider> = Effect.succeed({} as unknown as ServerProvider),
): ProviderInstance => {
  const driverKind = ProviderDriverKind.make(driverKindString);
  return {
    instanceId: defaultInstanceIdForDriver(driverKind),
    driverKind,
    continuationIdentity: {
      driverKind,
      continuationKey: `${driverKind}:instance:${defaultInstanceIdForDriver(driverKind)}`,
    },
    displayName: undefined,
    enabled: true,
    snapshot: {
      maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
        provider: driverKind,
        packageName: null,
      }),
      getSnapshot: readSnapshot,
      refresh: readSnapshot,
      streamChanges: Stream.empty,
    },
    adapter,
    textGeneration: {} as unknown as TextGeneration.TextGeneration["Service"],
  };
};

const fakeInstances: ReadonlyArray<ProviderInstance> = [
  makeFakeInstance("codex", fakeCodexAdapter),
  makeFakeInstance("claudeAgent", fakeClaudeAdapter),
  makeFakeInstance("opencode", fakeOpenCodeAdapter),
  makeFakeInstance("cursor", fakeCursorAdapter),
];

const makeFakeInstanceRegistryLayer = (instances: ReadonlyArray<ProviderInstance>) =>
  Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
    getInstance: (instanceId) =>
      Effect.succeed(instances.find((instance) => instance.instanceId === instanceId)),
    listInstances: Effect.succeed(instances),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    // Tests never drive changes through this fake; acquire a throwaway
    // subscription on an unused PubSub so the shape is satisfied.
    subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
      PubSub.subscribe(pubsub),
    ),
  });

const makeRegistryLayer = (instances: ReadonlyArray<ProviderInstance>) =>
  Layer.mergeAll(
    Layer.provide(
      ProviderAdapterRegistryLayer.ProviderAdapterRegistryLive,
      makeFakeInstanceRegistryLayer(instances),
    ),
    NodeServices.layer,
  );

const layer = makeRegistryLayer(fakeInstances);

it.layer(layer)("ProviderAdapterRegistryLive", (it) => {
  it("resolves adapters and routing metadata from provider instances", () =>
    Effect.gen(function* () {
      const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistry;
      const claudeInstanceId = defaultInstanceIdForDriver(CLAUDE_AGENT_DRIVER);

      const adapter = yield* registry.getByInstance(claudeInstanceId);
      assert.strictEqual(adapter, fakeClaudeAdapter);

      const info = yield* registry.getInstanceInfo(claudeInstanceId);
      assert.deepStrictEqual(info, {
        instanceId: claudeInstanceId,
        driverKind: CLAUDE_AGENT_DRIVER,
        displayName: undefined,
        accentColor: undefined,
        enabled: true,
        continuationIdentity: {
          driverKind: CLAUDE_AGENT_DRIVER,
          continuationKey: "claudeAgent:instance:claudeAgent",
        },
        // A snapshot that declares no execution policy keeps the full legacy
        // mode set, so existing providers route exactly as before.
        supportedRuntimeModes: DEFAULT_SERVER_PROVIDER_RUNTIME_MODES,
      });

      const instances = yield* registry.listInstances();
      assert.deepStrictEqual(instances, [
        defaultInstanceIdForDriver(CODEX_DRIVER),
        claudeInstanceId,
        defaultInstanceIdForDriver(OPENCODE_DRIVER),
        defaultInstanceIdForDriver(CURSOR_DRIVER),
      ]);

      const providers = yield* registry.listProviders();
      assert.deepStrictEqual(providers, [
        CODEX_DRIVER,
        CLAUDE_AGENT_DRIVER,
        OPENCODE_DRIVER,
        CURSOR_DRIVER,
      ]);
    }));
});

// Gate C: runtime-mode support is server-authoritative. Routing information
// carries whatever the live provider snapshot publishes so `ProviderService`
// can reject an unsupported mode without knowing which driver it is talking to.
it.effect("publishes the runtime modes a provider snapshot declares via feature capabilities", () =>
  Effect.gen(function* () {
    const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistry;
    const instanceId = defaultInstanceIdForDriver(CODEX_DRIVER);

    const info = yield* registry.getInstanceInfo(instanceId);
    assert.deepStrictEqual(info.supportedRuntimeModes, ["full-access"]);
  }).pipe(
    Effect.provide(
      makeRegistryLayer([
        makeFakeInstance(
          "codex",
          fakeCodexAdapter,
          Effect.succeed(
            executionPolicySnapshot({
              featureCapabilities: {
                version: PROVIDER_FEATURE_CAPABILITIES_VERSION,
                executionPolicy: {
                  support: "read-only",
                  operations: ["inspect"],
                  runtimeModes: ["full-access"],
                  enforcement: "none",
                },
              },
            }),
          ),
        ),
      ]),
    ),
  ),
);

it.effect("falls back to the legacy supportedRuntimeModes field when capabilities are absent", () =>
  Effect.gen(function* () {
    const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistry;
    const instanceId = defaultInstanceIdForDriver(CODEX_DRIVER);

    const info = yield* registry.getInstanceInfo(instanceId);
    assert.deepStrictEqual(info.supportedRuntimeModes, ["approval-required", "full-access"]);
  }).pipe(
    Effect.provide(
      makeRegistryLayer([
        makeFakeInstance(
          "codex",
          fakeCodexAdapter,
          Effect.succeed(
            executionPolicySnapshot({
              supportedRuntimeModes: ["approval-required", "full-access"],
            }),
          ),
        ),
      ]),
    ),
  ),
);

it.effect("re-reads the live snapshot on every routing lookup", () => {
  // Held outside the layer because the layer needs to read it, so it cannot be
  // created inside the effect the layer is provided to.
  const published = {
    current: executionPolicySnapshot({ supportedRuntimeModes: ["approval-required"] }),
  };
  return Effect.gen(function* () {
    const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistry;
    const instanceId = defaultInstanceIdForDriver(CODEX_DRIVER);

    const before = yield* registry.getInstanceInfo(instanceId);
    assert.deepStrictEqual(before.supportedRuntimeModes, ["approval-required"]);

    // A provider that learns more about itself (probe succeeded, private
    // daemon finally came up) must not stay pinned to its boot-time policy.
    published.current = executionPolicySnapshot({ supportedRuntimeModes: ["full-access"] });

    const after = yield* registry.getInstanceInfo(instanceId);
    assert.deepStrictEqual(after.supportedRuntimeModes, ["full-access"]);
  }).pipe(
    Effect.provide(
      makeRegistryLayer([
        makeFakeInstance(
          "codex",
          fakeCodexAdapter,
          Effect.sync(() => published.current),
        ),
      ]),
    ),
  );
});
