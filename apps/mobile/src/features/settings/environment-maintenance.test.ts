import { AuthOrchestrationOperateScope, ServerProvider } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  canMaintainEnvironment,
  canUpdateEnvironmentProvider,
  providerUpdateOutcome,
} from "./environment-maintenance";

const provider = Schema.decodeUnknownSync(ServerProvider)({
  instanceId: "codex-personal",
  driver: "codex",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-23T00:00:00.000Z",
  models: [],
  versionAdvisory: {
    status: "behind_latest",
    currentVersion: "1.0.0",
    latestVersion: "1.1.0",
    canUpdate: true,
    updateCommand: "npm install -g @openai/codex@latest",
    checkedAt: null,
    message: null,
  },
});

describe("mobile environment maintenance access", () => {
  it("requires a connected session with operate permission", () => {
    const session = {
      authenticated: true,
      auth: {
        policy: "remote-reachable" as const,
        bootstrapMethods: [],
        sessionMethods: [],
        sessionCookieName: "session",
      },
      scopes: [AuthOrchestrationOperateScope],
    };
    expect(canMaintainEnvironment(session, true)).toBe(true);
    expect(canMaintainEnvironment(session, false)).toBe(false);
    expect(canMaintainEnvironment({ ...session, authenticated: false }, true)).toBe(false);
    expect(canMaintainEnvironment({ ...session, scopes: [] }, true)).toBe(false);
    const { scopes: _, ...legacy } = session;
    expect(canMaintainEnvironment(legacy, true)).toBe(false);
    expect(canMaintainEnvironment(null, true)).toBe(false);
  });

  it("offers updates only for enabled installed updateable idle providers", () => {
    expect(canUpdateEnvironmentProvider(provider)).toBe(true);
    expect(canUpdateEnvironmentProvider({ ...provider, enabled: false })).toBe(false);
    expect(canUpdateEnvironmentProvider({ ...provider, installed: false })).toBe(false);
    expect(canUpdateEnvironmentProvider({ ...provider, availability: "unavailable" })).toBe(false);
    expect(canUpdateEnvironmentProvider({ ...provider, versionAdvisory: undefined })).toBe(false);
    expect(
      canUpdateEnvironmentProvider({
        ...provider,
        versionAdvisory: { ...provider.versionAdvisory!, canUpdate: false },
      }),
    ).toBe(false);
    expect(
      canUpdateEnvironmentProvider({
        ...provider,
        versionAdvisory: { ...provider.versionAdvisory!, updateCommand: null },
      }),
    ).toBe(false);
    for (const status of ["queued", "running"] as const) {
      expect(
        canUpdateEnvironmentProvider({
          ...provider,
          updateState: { status, startedAt: null, finishedAt: null, message: null, output: null },
        }),
      ).toBe(false);
    }
  });

  it("uses the server's verified update state instead of treating RPC success as install success", () => {
    const updated = (status: "succeeded" | "failed" | "unchanged") => ({
      ...provider,
      updateState: {
        status,
        startedAt: null,
        finishedAt: null,
        message: `${status} result`,
        output: null,
      },
    });
    expect(providerUpdateOutcome([updated("succeeded")], provider.instanceId)).toEqual({
      kind: "success",
      message: "succeeded result",
    });
    expect(providerUpdateOutcome([updated("failed")], provider.instanceId)).toEqual({
      kind: "error",
      message: "failed result",
    });
    expect(providerUpdateOutcome([updated("unchanged")], provider.instanceId)).toEqual({
      kind: "notice",
      message: "unchanged result",
    });
    expect(providerUpdateOutcome([], provider.instanceId)).toBeNull();
    expect(
      providerUpdateOutcome(
        [
          {
            ...provider,
            updateState: {
              status: "idle",
              startedAt: null,
              finishedAt: null,
              message: null,
              output: null,
            },
          },
        ],
        provider.instanceId,
      ),
    ).toBeNull();
    expect(
      providerUpdateOutcome(
        [
          {
            ...provider,
            updateState: {
              status: "running",
              startedAt: null,
              finishedAt: null,
              message: "running",
              output: null,
            },
          },
        ],
        provider.instanceId,
      ),
    ).toBeNull();
  });
});
