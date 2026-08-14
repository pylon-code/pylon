import { describe, expect, it } from "vite-plus/test";

import {
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";

import {
  canSetSessionAgentDepth,
  deriveLatestSessionAgentDepth,
  supportsSessionAgentDepth,
} from "./sessionAgentDepth.ts";

const activity = (input: {
  readonly id: string;
  readonly createdAt: string;
  readonly providerInstanceId?: string;
  readonly payload: Record<string, unknown>;
}): OrchestrationThreadActivity =>
  ({
    id: input.id,
    kind: "session.agent-depth.updated",
    tone: "info",
    summary: "Agent spawn depth updated",
    turnId: null,
    payload: {
      provider: "primeAgent",
      providerInstanceId: input.providerInstanceId ?? "prime-work",
      ...input.payload,
    },
    createdAt: input.createdAt,
  }) as OrchestrationThreadActivity;

describe("deriveLatestSessionAgentDepth", () => {
  it("selects the latest valid snapshot for the active provider instance", () => {
    const snapshot = deriveLatestSessionAgentDepth(
      [
        activity({
          id: "depth-1",
          createdAt: "2026-01-01T00:00:00.000Z",
          payload: {
            maxDepth: 1,
            source: "default",
            writable: true,
            settable: true,
            maxSettableDepth: 4,
          },
        }),
        activity({
          id: "depth-other",
          createdAt: "2026-01-01T00:02:00.000Z",
          providerInstanceId: "prime-other",
          payload: {
            maxDepth: 4,
            source: "session",
            writable: true,
            settable: true,
            maxSettableDepth: 4,
          },
        }),
        activity({
          id: "depth-2",
          createdAt: "2026-01-01T00:01:00.000Z",
          payload: {
            maxDepth: 3,
            source: "session",
            writable: true,
            settable: true,
            maxSettableDepth: 4,
          },
        }),
      ],
      ProviderInstanceId.make("prime-work"),
    );

    expect(snapshot).toEqual({
      provider: "primeAgent",
      providerInstanceId: "prime-work",
      maxDepth: 3,
      source: "session",
      writable: true,
      settable: true,
      maxSettableDepth: 4,
      updatedAt: "2026-01-01T00:01:00.000Z",
    });
  });

  it("skips malformed or oversized payloads", () => {
    const snapshot = deriveLatestSessionAgentDepth(
      [
        activity({
          id: "depth-valid",
          createdAt: "2026-01-01T00:00:00.000Z",
          payload: {
            maxDepth: 0,
            source: "policy",
            writable: false,
            settable: false,
            maxSettableDepth: 4,
          },
        }),
        activity({
          id: "depth-invalid",
          createdAt: "2026-01-01T00:01:00.000Z",
          payload: {
            maxDepth: 99,
            source: "session",
            writable: true,
            settable: true,
            maxSettableDepth: 99,
          },
        }),
      ],
      ProviderInstanceId.make("prime-work"),
    );

    expect(snapshot?.maxDepth).toBe(0);
    expect(snapshot?.writable).toBe(false);
  });
});

describe("canSetSessionAgentDepth", () => {
  const provider = {
    featureCapabilities: {
      version: 1 as const,
      agents: { support: "read-write" as const, operations: ["set-depth" as const] },
    },
  };

  it("requires both policy writability and authoritative idle state", () => {
    const snapshot = {
      provider: ProviderDriverKind.make("primeAgent"),
      providerInstanceId: ProviderInstanceId.make("prime-work"),
      maxDepth: 1,
      source: "session" as const,
      writable: true,
      settable: true,
      maxSettableDepth: 4,
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(canSetSessionAgentDepth(provider, snapshot)).toBe(true);
    expect(canSetSessionAgentDepth(provider, { ...snapshot, settable: false })).toBe(false);
    expect(canSetSessionAgentDepth(provider, { ...snapshot, writable: false })).toBe(false);
  });
});

describe("supportsSessionAgentDepth", () => {
  it("requires the set-depth operation", () => {
    expect(supportsSessionAgentDepth(null)).toBe(false);
    expect(
      supportsSessionAgentDepth({
        featureCapabilities: {
          version: 1,
          agents: { support: "read-only", operations: ["observe"] },
        },
      }),
    ).toBe(false);
    expect(
      supportsSessionAgentDepth({
        featureCapabilities: {
          version: 1,
          agents: { support: "read-write", operations: ["set-depth"] },
        },
      }),
    ).toBe(true);
  });
});
