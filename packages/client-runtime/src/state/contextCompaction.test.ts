import {
  EnvironmentId,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canAbortSessionCompaction,
  canConfigureSessionAutoCompaction,
  canStartSessionCompaction,
  deriveLatestSessionCompaction,
  isAcceptedSessionCompactionMutationResult,
  isCurrentSessionCompactionRequest,
  isSessionCompactionInProgress,
  isSessionCompactionSubmissionBlocked,
  sessionCompactionScopeKey,
  supportsSessionAbortCompaction,
  supportsSessionAutoCompaction,
  supportsSessionCompactNow,
} from "./contextCompaction.ts";

const activity = (instanceId: string, status: "idle" | "compacting") =>
  ({
    id: EventId.make(`compaction-${instanceId}`),
    kind: "session.compaction.updated",
    tone: "info",
    summary: "Session compaction updated",
    turnId: null,
    createdAt: "2026-08-09T00:00:00.000Z",
    payload: {
      provider: ProviderDriverKind.make("primeAgent"),
      providerInstanceId: ProviderInstanceId.make(instanceId),
      available: true,
      status,
      abortable: status === "compacting",
      autoCompactionEnabled: true,
      autoCompactionWritable: true,
      manualCompactionSettable: status === "idle",
      autoCompactionScope: "session-and-provider-default",
    },
  }) as OrchestrationThreadActivity;

describe("session compaction state", () => {
  it("derives only the active provider instance snapshot", () => {
    const snapshot = deriveLatestSessionCompaction(
      [activity("other", "compacting"), activity("prime-work", "idle")],
      ProviderInstanceId.make("prime-work"),
    );
    expect(snapshot).toMatchObject({
      available: true,
      status: "idle",
      autoCompactionEnabled: true,
      autoCompactionScope: "session-and-provider-default",
    });
    expect(JSON.stringify(snapshot)).not.toContain("summary");
  });

  it("requires provider-advertised read-write operations", () => {
    const provider = {
      featureCapabilities: {
        version: 1 as const,
        context: {
          support: "read-write" as const,
          operations: [
            "observe" as const,
            "compact" as const,
            "abort-compaction" as const,
            "configure-compaction" as const,
          ],
        },
      },
    };
    expect(supportsSessionCompactNow(provider)).toBe(true);
    expect(supportsSessionAbortCompaction(provider)).toBe(true);
    expect(supportsSessionAutoCompaction(provider)).toBe(true);
    expect(
      supportsSessionCompactNow({
        featureCapabilities: {
          version: 1 as const,
          context: {
            support: "read-only" as const,
            operations: ["observe" as const, "compact" as const],
          },
        },
      }),
    ).toBe(false);
  });

  it("uses authoritative status and writability for mutations", () => {
    const provider = {
      featureCapabilities: {
        version: 1 as const,
        context: {
          support: "read-write" as const,
          operations: [
            "observe" as const,
            "compact" as const,
            "abort-compaction" as const,
            "configure-compaction" as const,
          ],
        },
      },
    };
    const idle = deriveLatestSessionCompaction(
      [activity("prime-work", "idle")],
      ProviderInstanceId.make("prime-work"),
    );
    const compacting = deriveLatestSessionCompaction(
      [activity("prime-work", "compacting")],
      ProviderInstanceId.make("prime-work"),
    );
    expect(canStartSessionCompaction(provider, idle)).toBe(true);
    expect(canAbortSessionCompaction(provider, idle)).toBe(false);
    expect(canStartSessionCompaction(provider, compacting)).toBe(false);
    expect(canAbortSessionCompaction(provider, compacting)).toBe(true);
    expect(
      canAbortSessionCompaction(provider, compacting && { ...compacting, abortable: false }),
    ).toBe(false);
    expect(canConfigureSessionAutoCompaction(provider, idle)).toBe(true);
    expect(
      canConfigureSessionAutoCompaction(
        provider,
        idle && { ...idle, autoCompactionScope: undefined },
      ),
    ).toBe(false);
    expect(
      canStartSessionCompaction(provider, idle && { ...idle, manualCompactionSettable: false }),
    ).toBe(false);
  });

  it("blocks composer submission for every active compaction status", () => {
    for (const status of ["starting", "compacting", "abort-requested"] as const) {
      expect(isSessionCompactionInProgress({ status })).toBe(true);
      expect(
        isSessionCompactionSubmissionBlocked({
          hasActiveScope: true,
          current: { status: "idle" },
          activity: { status },
          compactPending: false,
        }),
      ).toBe(true);
    }
    expect(isSessionCompactionInProgress({ status: "idle" })).toBe(false);
    expect(isSessionCompactionInProgress(null)).toBe(false);

    expect(
      isSessionCompactionSubmissionBlocked({
        hasActiveScope: true,
        current: { status: "idle" },
        activity: { status: "idle" },
        compactPending: true,
      }),
    ).toBe(true);
    expect(
      isSessionCompactionSubmissionBlocked({
        hasActiveScope: true,
        current: { status: "idle" },
        activity: { status: "idle" },
        compactPending: false,
      }),
    ).toBe(false);
  });

  it("ignores stale compaction state after the session stops", () => {
    for (const compactPending of [false, true]) {
      expect(
        isSessionCompactionSubmissionBlocked({
          hasActiveScope: false,
          current: { status: "compacting" },
          activity: { status: "compacting" },
          compactPending,
        }),
      ).toBe(false);
    }
  });

  it("accepts only successful mutations superseded by authoritative activity", () => {
    expect(
      isAcceptedSessionCompactionMutationResult({
        succeeded: true,
        isCurrent: false,
        supersededByActivity: true,
      }),
    ).toBe(true);
    expect(
      isAcceptedSessionCompactionMutationResult({
        succeeded: false,
        isCurrent: false,
        supersededByActivity: true,
      }),
    ).toBe(false);
    expect(
      isAcceptedSessionCompactionMutationResult({
        succeeded: true,
        isCurrent: false,
        supersededByActivity: false,
      }),
    ).toBe(false);
  });

  it("scopes requests by environment, thread, and provider instance", () => {
    const scopeKey = sessionCompactionScopeKey({
      environmentId: EnvironmentId.make("remote-environment"),
      threadId: ThreadId.make("thread-1"),
      providerInstanceId: ProviderInstanceId.make("work-account"),
    });
    const request = { scopeKey, id: 3 };
    expect(isCurrentSessionCompactionRequest(scopeKey, 3, request)).toBe(true);
    expect(isCurrentSessionCompactionRequest(scopeKey, 4, request)).toBe(false);
    expect(
      isCurrentSessionCompactionRequest(
        sessionCompactionScopeKey({
          environmentId: EnvironmentId.make("other-environment"),
          threadId: ThreadId.make("thread-1"),
          providerInstanceId: ProviderInstanceId.make("work-account"),
        }),
        3,
        request,
      ),
    ).toBe(false);
  });
});
