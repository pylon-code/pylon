import { describe, expect, it } from "vite-plus/test";

import {
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";

import {
  deriveLatestSessionResources,
  formatProviderSlashCommandDescription,
  resolveSessionSlashCommands,
} from "./sessionResources.ts";

const makeActivity = (input: {
  readonly id: string;
  readonly createdAt: string;
  readonly payload: unknown;
}): OrchestrationThreadActivity =>
  ({
    id: input.id,
    kind: "session.resources.updated",
    tone: "info",
    summary: "Session resources updated",
    turnId: null,
    payload: {
      provider: "primeAgent",
      providerInstanceId: "prime-work",
      ...(input.payload as Record<string, unknown>),
    },
    createdAt: input.createdAt,
  }) as OrchestrationThreadActivity;

describe("deriveLatestSessionResources", () => {
  it("returns the latest valid bounded catalog", () => {
    const snapshot = deriveLatestSessionResources(
      [
        makeActivity({
          id: "resource-1",
          createdAt: "2026-01-01T00:00:00.000Z",
          payload: { available: false, skills: [], prompts: [], commands: [] },
        }),
        makeActivity({
          id: "resource-2",
          createdAt: "2026-01-01T00:01:00.000Z",
          payload: {
            available: true,
            skills: [{ name: "review", scope: "project" }],
            prompts: [{ name: "release", argumentHint: "<version>" }],
            commands: [{ name: "skill:review", source: "skill", description: "Review changes" }],
          },
        }),
      ],
      ProviderInstanceId.make("prime-work"),
    );

    expect(snapshot).toEqual({
      provider: "primeAgent",
      providerInstanceId: "prime-work",
      available: true,
      skills: [{ name: "review", scope: "project" }],
      prompts: [{ name: "release", argumentHint: "<version>" }],
      commands: [{ name: "skill:review", source: "skill", description: "Review changes" }],
      updatedAt: "2026-01-01T00:01:00.000Z",
    });
  });

  it("treats an unavailable snapshot as an authoritative barrier", () => {
    const snapshot = deriveLatestSessionResources(
      [
        makeActivity({
          id: "resource-1",
          createdAt: "2026-01-01T00:00:00.000Z",
          payload: {
            available: true,
            skills: [],
            prompts: [],
            commands: [{ name: "release", source: "prompt" }],
          },
        }),
        makeActivity({
          id: "resource-2",
          createdAt: "2026-01-01T00:01:00.000Z",
          payload: { available: false, skills: [], prompts: [], commands: [] },
        }),
      ],
      ProviderInstanceId.make("prime-work"),
    );

    expect(snapshot).toMatchObject({ available: false, commands: [] });
  });

  it("selects only the catalog for the active provider instance", () => {
    const activities = [
      makeActivity({
        id: "resource-a",
        createdAt: "2026-01-01T00:00:00.000Z",
        payload: {
          providerInstanceId: "prime-a",
          available: true,
          skills: [],
          prompts: [],
          commands: [{ name: "command-a", source: "extension" }],
        },
      }),
      makeActivity({
        id: "resource-b",
        createdAt: "2026-01-01T00:01:00.000Z",
        payload: {
          providerInstanceId: "prime-b",
          available: true,
          skills: [],
          prompts: [],
          commands: [{ name: "command-b", source: "extension" }],
        },
      }),
    ];

    expect(
      deriveLatestSessionResources(activities, ProviderInstanceId.make("prime-a"))?.commands,
    ).toEqual([{ name: "command-a", source: "extension" }]);
  });

  it("maps available native commands and falls back only when unavailable", () => {
    const fallback = [{ name: "fallback", description: "Fallback command" }];
    expect(
      formatProviderSlashCommandDescription({
        name: "release",
        description: "Prepare release",
        input: { hint: "<version>" },
      }),
    ).toBe("Prepare release · <version>");
    expect(
      resolveSessionSlashCommands(
        {
          provider: ProviderDriverKind.make("primeAgent"),
          providerInstanceId: ProviderInstanceId.make("prime-work"),
          available: true,
          skills: [],
          prompts: [],
          commands: [
            {
              name: "release",
              source: "prompt",
              description: "Prepare release",
              argumentHint: "<version>",
            },
          ],
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        fallback,
      ),
    ).toEqual([
      {
        name: "release",
        description: "Prepare release",
        input: { hint: "<version>" },
      },
    ]);
    expect(
      resolveSessionSlashCommands(
        {
          provider: ProviderDriverKind.make("primeAgent"),
          providerInstanceId: ProviderInstanceId.make("prime-work"),
          available: false,
          skills: [],
          prompts: [],
          commands: [],
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        fallback,
      ),
    ).toBe(fallback);
  });

  it("skips malformed replacement payloads", () => {
    const snapshot = deriveLatestSessionResources(
      [
        makeActivity({
          id: "resource-1",
          createdAt: "2026-01-01T00:00:00.000Z",
          payload: { available: true, skills: [], prompts: [], commands: [] },
        }),
        makeActivity({
          id: "resource-2",
          createdAt: "2026-01-01T00:01:00.000Z",
          payload: {
            available: true,
            skills: [],
            prompts: [],
            commands: [{ name: "secret", source: "native", path: "/private" }],
          },
        }),
      ],
      ProviderInstanceId.make("prime-work"),
    );

    expect(snapshot?.updatedAt).toBe("2026-01-01T00:00:00.000Z");
  });
});
