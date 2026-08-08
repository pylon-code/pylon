import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_SERVER_PROVIDER_RUNTIME_MODES,
  getServerProviderSupportedRuntimeModes,
  resolveServerProviderRuntimeMode,
  ServerProvider,
  supportsServerProviderBackgroundTextGeneration,
  supportsServerProviderConversationRollback,
} from "./server.ts";
import {
  PROVIDER_FEATURE_CAPABILITIES_VERSION,
  PROVIDER_FEATURE_SUPPORT_REASON_MAX_CHARS,
  ProviderFeatureCapabilities,
} from "./providerCapabilities.ts";

const decodeCapabilities = Schema.decodeUnknownSync(ProviderFeatureCapabilities);
const encodeCapabilities = Schema.encodeSync(ProviderFeatureCapabilities);
const decodeProvider = Schema.decodeUnknownSync(ServerProvider);
const encodeProvider = Schema.encodeSync(ServerProvider);

const legacyProviderSnapshot = {
  instanceId: "codex",
  driver: "codex",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-08-08T00:00:00.000Z",
  models: [],
};

const primeLikeCapabilities = {
  version: PROVIDER_FEATURE_CAPABILITIES_VERSION,
  authentication: {
    support: "read-write",
    operations: ["status", "login", "logout", "refresh", "accounts", "team-selection"],
  },
  executionPolicy: {
    support: "read-only",
    reason: "Prime Agent does not expose a first-class sandbox policy.",
    operations: ["inspect"],
    runtimeModes: ["full-access"],
    enforcement: "none",
  },
  planning: {
    support: "read-write",
    operations: ["observe", "propose", "update", "select-mode"],
  },
  goals: {
    support: "read-write",
    operations: ["observe", "create", "update", "pause", "resume", "complete", "clear"],
  },
  gates: {
    support: "read-write",
    operations: ["observe", "configure", "run", "retry", "abort"],
  },
  agents: {
    support: "read-write",
    operations: [
      "observe",
      "hierarchy",
      "spawn",
      "message",
      "steer",
      "pause",
      "resume",
      "cancel",
      "stop",
      "delete",
      "set-depth",
    ],
  },
  automation: {
    support: "read-write",
    operations: [
      "autonomous-runs",
      "heartbeats",
      "schedules",
      "side-questions",
      "background-text-generation",
    ],
  },
  resources: {
    support: "read-write",
    operations: ["skills", "prompts", "extensions", "packages", "mcp", "commands"],
  },
  inputQueue: {
    support: "read-write",
    operations: ["observe", "follow-up", "steer", "remove", "clear", "set-modes", "reorder"],
  },
  model: {
    support: "read-write",
    operations: ["select", "thinking", "service-tier", "scoped-models", "transport", "cycle"],
  },
  context: {
    support: "read-write",
    operations: [
      "observe",
      "compact",
      "abort-compaction",
      "configure-compaction",
      "refine",
      "auto-retry",
    ],
  },
  history: {
    support: "read-write",
    operations: ["navigate", "rollback", "fork", "clone", "switch", "import", "export", "labels"],
  },
  reasoning: {
    support: "read-only",
    operations: ["final", "stream"],
  },
  usage: {
    support: "read-only",
    operations: ["token-usage", "cost", "rate-limits"],
  },
  sessionUi: {
    support: "read-write",
    operations: ["dialog", "notification", "status", "widget"],
  },
};

describe("ProviderFeatureCapabilities", () => {
  it("round-trips the versioned provider-neutral schema", () => {
    const decoded = decodeCapabilities(primeLikeCapabilities);

    expect(encodeCapabilities(decoded)).toEqual(primeLikeCapabilities);
    expect(decoded.version).toBe(1);
    expect(decoded.model?.operations).toEqual([
      "select",
      "thinking",
      "service-tier",
      "scoped-models",
      "transport",
      "cycle",
    ]);
    expect(decoded.resources?.operations).toContain("mcp");
    expect(decoded.resources?.operations).toContain("commands");
    expect(decoded.sessionUi?.operations).toEqual(["dialog", "notification", "status", "widget"]);
  });

  it("represents Prime-like native capabilities without provider-specific fields", () => {
    const provider = decodeProvider({
      ...legacyProviderSnapshot,
      instanceId: "primeAgent",
      driver: "primeAgent",
      featureCapabilities: primeLikeCapabilities,
    });

    expect(provider.featureCapabilities?.authentication?.support).toBe("read-write");
    expect(provider.featureCapabilities?.authentication?.operations).toContain("team-selection");
    expect(provider.featureCapabilities?.executionPolicy?.enforcement).toBe("none");
    expect(provider.featureCapabilities?.goals?.operations).toContain("resume");
    expect(provider.featureCapabilities?.gates?.operations).toContain("abort");
    expect(provider.featureCapabilities?.agents?.operations).toContain("hierarchy");
    expect(provider.featureCapabilities?.agents?.operations).toContain("set-depth");
    expect(provider.featureCapabilities?.automation?.operations).toContain("heartbeats");
    expect(provider.featureCapabilities?.inputQueue?.operations).toContain("reorder");
    expect(provider.featureCapabilities?.model?.operations).toContain("scoped-models");
    expect(provider.featureCapabilities?.context?.operations).toContain("abort-compaction");
    expect(provider.featureCapabilities?.history?.operations).toContain("clone");
    expect(provider.featureCapabilities?.reasoning?.operations).toContain("stream");
    expect(provider.featureCapabilities?.usage?.operations).toContain("cost");
    expect(provider.featureCapabilities?.sessionUi?.operations).toContain("dialog");
    expect(encodeProvider(provider).featureCapabilities).toEqual(primeLikeCapabilities);
  });

  it("decodes every execution-policy enforcement while keeping it optional", () => {
    const enforcementValues = ["none", "provider-native", "host-gated"] as const;
    const decodedValues = enforcementValues.map(
      (enforcement) =>
        decodeCapabilities({
          version: 1,
          executionPolicy: {
            support: "read-write",
            operations: ["inspect", "select"],
            runtimeModes: ["approval-required", "full-access"],
            enforcement,
          },
        }).executionPolicy?.enforcement,
    );
    const legacy = decodeCapabilities({
      version: 1,
      executionPolicy: {
        support: "read-only",
        operations: ["inspect"],
        runtimeModes: ["full-access"],
      },
    });

    expect(decodedValues).toEqual(enforcementValues);
    expect(legacy.executionPolicy?.enforcement).toBeUndefined();
  });

  it("accepts future versions and drops only unknown operation names", () => {
    const decoded = decodeCapabilities({
      version: 2,
      agents: {
        support: "read-write",
        operations: ["observe", "teleport"],
        futureAgentMetadata: { protocol: 2 },
      },
      sessionUi: {
        support: "read-write",
        operations: ["dialog", "canvas"],
      },
      futureFeatureGroup: {
        support: "read-write",
      },
    });

    expect(decoded.version).toBe(2);
    expect(decoded.agents?.operations).toEqual(["observe"]);
    expect(decoded.sessionUi?.operations).toEqual(["dialog"]);
  });

  it("bounds human-readable unavailability reasons", () => {
    expect(() =>
      decodeCapabilities({
        version: 1,
        planning: {
          support: "unavailable",
          reason: "x".repeat(PROVIDER_FEATURE_SUPPORT_REASON_MAX_CHARS + 1),
          operations: [],
        },
      }),
    ).toThrow();
  });
});

describe("ServerProvider capability compatibility", () => {
  it("decodes legacy provider snapshots and preserves prior helper defaults", () => {
    const provider = decodeProvider(legacyProviderSnapshot);

    expect(provider.featureCapabilities).toBeUndefined();
    expect(getServerProviderSupportedRuntimeModes(provider)).toEqual(
      DEFAULT_SERVER_PROVIDER_RUNTIME_MODES,
    );
    expect(supportsServerProviderBackgroundTextGeneration(provider)).toBe(true);
    expect(supportsServerProviderConversationRollback(provider)).toBe(true);
  });

  it("derives legacy helpers from advertised feature groups", () => {
    const provider = decodeProvider({
      ...legacyProviderSnapshot,
      supportedRuntimeModes: ["approval-required"],
      supportsBackgroundTextGeneration: false,
      supportsConversationRollback: false,
      featureCapabilities: {
        version: 1,
        executionPolicy: {
          support: "read-only",
          operations: ["inspect"],
          runtimeModes: ["full-access"],
        },
        automation: {
          support: "read-write",
          operations: ["background-text-generation"],
        },
        history: {
          support: "read-write",
          operations: ["rollback", "fork"],
        },
      },
    });

    expect(getServerProviderSupportedRuntimeModes(provider)).toEqual(["full-access"]);
    expect(resolveServerProviderRuntimeMode(provider, "approval-required")).toBe("full-access");
    expect(supportsServerProviderBackgroundTextGeneration(provider)).toBe(true);
    expect(supportsServerProviderConversationRollback(provider)).toBe(true);
  });

  it("treats an advertised group without a write operation as unsupported", () => {
    const provider = decodeProvider({
      ...legacyProviderSnapshot,
      supportsBackgroundTextGeneration: true,
      supportsConversationRollback: true,
      featureCapabilities: {
        version: 1,
        automation: {
          support: "read-only",
          operations: ["background-text-generation"],
        },
        history: {
          support: "read-write",
          operations: ["fork"],
        },
      },
    });

    expect(supportsServerProviderBackgroundTextGeneration(provider)).toBe(false);
    expect(supportsServerProviderConversationRollback(provider)).toBe(false);
  });

  it("falls back group-by-group when a capability snapshot omits a group", () => {
    const provider = decodeProvider({
      ...legacyProviderSnapshot,
      supportsBackgroundTextGeneration: false,
      featureCapabilities: { version: 1 },
    });

    expect(getServerProviderSupportedRuntimeModes(provider)).toEqual(
      DEFAULT_SERVER_PROVIDER_RUNTIME_MODES,
    );
    expect(supportsServerProviderBackgroundTextGeneration(provider)).toBe(false);
    expect(supportsServerProviderConversationRollback(provider)).toBe(true);
  });
});
