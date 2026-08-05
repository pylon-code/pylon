import { describe, expect, it } from "vite-plus/test";
import { FollowUpId, ProjectId, ThreadId, type FollowUp } from "@t3tools/contracts";

import {
  buildFollowUpThreadPrompt,
  buildFollowUpValidationPrompt,
  groupFollowUps,
  mergeFollowUpThreadPrompt,
  mergeFollowUpValidationPrompt,
  openFollowUpBlockersForBranch,
  resolveFollowUpProjectSelection,
} from "./followUps.logic";

function item(overrides: Partial<FollowUp> = {}): FollowUp {
  return {
    id: FollowUpId.make("item-1"),
    projectId: ProjectId.make("project-1"),
    kind: "open",
    status: "open",
    title: "Check the thing",
    observation: "Noticed during unrelated work.",
    deferReason: "out-of-scope",
    verifyCheck: "Does it still happen?",
    evidence: [],
    gate: null,
    sourceKind: "agent",
    sourceThreadId: null,
    resolution: null,
    lastValidation: null,
    revision: 0,
    createdAt: "2026-08-04T12:00:00.000Z",
    updatedAt: "2026-08-04T12:00:00.000Z",
    ...overrides,
  };
}

describe("groupFollowUps", () => {
  it("groups open items by kind and excludes closed ones", () => {
    const grouped = groupFollowUps([
      item({ id: FollowUpId.make("a"), kind: "blocker", gate: { kind: "branch", ref: "main" } }),
      item({ id: FollowUpId.make("b"), kind: "open" }),
      item({ id: FollowUpId.make("c"), kind: "idea" }),
      item({ id: FollowUpId.make("d"), kind: "open", status: "resolved" }),
    ]);
    expect(grouped.blocker).toHaveLength(1);
    expect(grouped.open).toHaveLength(1);
    expect(grouped.idea).toHaveLength(1);
    expect(grouped.closed).toHaveLength(1);
  });

  it("orders each group newest first", () => {
    const grouped = groupFollowUps([
      item({ id: FollowUpId.make("older"), createdAt: "2026-08-01T00:00:00.000Z" }),
      item({ id: FollowUpId.make("newer"), createdAt: "2026-08-03T00:00:00.000Z" }),
    ]);
    expect(grouped.open.map((entry) => entry.id)).toEqual(["newer", "older"]);
  });
});

describe("resolveFollowUpProjectSelection", () => {
  it("waits for bootstrap and then selects the first project", () => {
    expect(
      resolveFollowUpProjectSelection({
        bootstrapped: false,
        selectedProjectKey: undefined,
        projectKeys: ["environment-1:project-1"],
      }),
    ).toBeUndefined();
    expect(
      resolveFollowUpProjectSelection({
        bootstrapped: true,
        selectedProjectKey: null,
        projectKeys: ["environment-1:project-1"],
      }),
    ).toBe("environment-1:project-1");
  });

  it("preserves a valid selection and recovers when it disappears", () => {
    expect(
      resolveFollowUpProjectSelection({
        bootstrapped: true,
        selectedProjectKey: "environment-1:project-2",
        projectKeys: ["environment-1:project-1", "environment-1:project-2"],
      }),
    ).toBe("environment-1:project-2");
    expect(
      resolveFollowUpProjectSelection({
        bootstrapped: true,
        selectedProjectKey: "environment-1:project-2",
        projectKeys: ["environment-1:project-1"],
      }),
    ).toBe("environment-1:project-1");
    expect(
      resolveFollowUpProjectSelection({
        bootstrapped: true,
        selectedProjectKey: "environment-1:project-2",
        projectKeys: [],
      }),
    ).toBeNull();
  });
});

describe("follow-up thread dossier", () => {
  const dossierItem = item({
    id: FollowUpId.make("follow-up-42"),
    kind: "blocker",
    title: "Protect the release branch",
    observation: "The release check can be bypassed.",
    verifyCheck: "Attempt the release with the check failing.",
    evidence: [{ path: "apps/web/src/release.ts", line: 42, commitSha: "abcdef123456" }],
    gate: { kind: "branch", ref: "release" },
    sourceThreadId: ThreadId.make("thread-source"),
  });

  it("includes the evidence and source context needed to revalidate the work", () => {
    const prompt = buildFollowUpThreadPrompt(dossierItem);

    expect(prompt).toMatch(
      /^<!-- PYLON-OWNED FOLLOW-UP v1 mode=work utf16=\d+ sha256=[0-9a-f]{64} -->/,
    );
    expect(prompt).toContain("Protect the release branch");
    expect(prompt).toContain("Follow-up ID: follow-up-42");
    expect(prompt).toContain("The release check can be bypassed.");
    expect(prompt).toContain("Attempt the release with the check failing.");
    expect(prompt).toContain("apps/web/src/release.ts:42 @ abcdef123456");
    expect(prompt).toContain("Branch gate: release");
    expect(prompt).toContain("Filed from thread: thread-source");
  });

  it("preserves existing draft content and does not append the same dossier twice", () => {
    const merged = mergeFollowUpThreadPrompt("Keep this draft instruction.", dossierItem);

    expect(merged).toMatch(/^Keep this draft instruction\./);
    expect(merged).toContain("Follow-up ID: follow-up-42");
    expect(mergeFollowUpThreadPrompt(merged, dossierItem)).toBe(merged);
  });

  it("seeds a fail-closed read-only validation with exact recorder outcomes", () => {
    const prompt = buildFollowUpValidationPrompt(dossierItem);

    expect(prompt).toMatch(
      /^<!-- PYLON-OWNED FOLLOW-UP v1 mode=validation utf16=\d+ sha256=[0-9a-f]{64} -->/,
    );
    expect(prompt).toContain("Investigate read-only");
    expect(prompt).toContain("still-needed, moot, or uncertain");
    expect(prompt).toContain("Uncertain must fail closed");
    expect(prompt).toContain("Never waive");
    expect(prompt).toContain("followup_record_validation");
    expect(prompt).toContain(dossierItem.verifyCheck);
    expect(prompt).toContain("apps/web/src/release.ts:42 @ abcdef123456");
  });

  it("preserves an occupied draft when adding validation instructions", () => {
    const merged = mergeFollowUpValidationPrompt("Do not replace this.", dossierItem);

    expect(merged).toMatch(/^Do not replace this\./);
    expect(merged).toContain("Validation for Follow-up ID: follow-up-42");
    expect(mergeFollowUpValidationPrompt(merged, dossierItem)).toBe(merged);
  });

  it("replaces the owned work block with validation while preserving unrelated bytes", () => {
    const prefix = "\0  Keep this user-authored prefix byte-for-byte.\r\n\t🧪\n";
    const suffix = "\n🧷\r\nKeep this user-authored suffix too.  \t\0";
    const workDraft = `${prefix}${buildFollowUpThreadPrompt(dossierItem)}${suffix}`;
    const switched = mergeFollowUpValidationPrompt(workDraft, dossierItem);

    expect(switched).toBe(`${prefix}${buildFollowUpValidationPrompt(dossierItem)}${suffix}`);
    expect(switched).not.toContain("Take on this saved Pylon follow-up");
    expect(switched.match(/Validation for Follow-up ID: follow-up-42/g)).toHaveLength(1);
  });

  it("replaces the owned validation block with work while preserving unrelated bytes", () => {
    const prefix = "\0\tUser context before the dossier.\r\n\n🧪";
    const suffix = "🧷\nUser context after the dossier.\r\n\t\0";
    const validationDraft = `${prefix}${buildFollowUpValidationPrompt(dossierItem)}${suffix}`;
    const switched = mergeFollowUpThreadPrompt(validationDraft, dossierItem);

    expect(switched).toBe(`${prefix}${buildFollowUpThreadPrompt(dossierItem)}${suffix}`);
    expect(switched).not.toContain("Investigate read-only");
    expect(switched.match(/Follow-up ID: follow-up-42/g)).toHaveLength(1);
  });

  it("preserves an exact valid frame-looking user block before the owned block", () => {
    const prefix = "User-authored prefix\r\n";
    const between = "\nUser-authored middle\n";
    const suffix = "\r\nUser-authored suffix\0";
    const exactFrameLookingText = buildFollowUpThreadPrompt(dossierItem);
    const draft = `${prefix}${exactFrameLookingText}${between}${exactFrameLookingText}${suffix}`;

    expect(mergeFollowUpValidationPrompt(draft, dossierItem)).toBe(
      `${prefix}${exactFrameLookingText}${between}${buildFollowUpValidationPrompt(dossierItem)}${suffix}`,
    );
  });

  it.each([
    ["identifier", (marker: string) => ({ id: FollowUpId.make(marker) })],
    ["title", (marker: string) => ({ title: marker })],
    ["observation", (marker: string) => ({ observation: marker })],
    ["verify check", (marker: string) => ({ verifyCheck: marker })],
    [
      "evidence",
      (marker: string) => ({
        evidence: [{ path: marker, line: 7, commitSha: "PYLON-OWNED FOLLOW-UP" }],
      }),
    ],
    [
      "branch gate",
      (marker: string) => ({
        kind: "blocker" as const,
        gate: { kind: "branch" as const, ref: marker },
      }),
    ],
    ["source thread", (marker: string) => ({ sourceThreadId: ThreadId.make(marker) })],
    [
      "resolution",
      (marker: string) => ({
        status: "resolved" as const,
        resolution: {
          note: marker,
          threadId: ThreadId.make("PYLON-OWNED FOLLOW-UP resolution thread"),
          commitSha: "PYLON-OWNED FOLLOW-UP resolution commit",
        },
      }),
    ],
  ] as const)("does not terminate a frame on marker text in the %s field", (_label, override) => {
    const prefix = "prefix\0\r\n";
    const suffix = "\n\t🧷suffix\0";
    for (const [buildOwned, mergeDesired, buildDesired] of [
      [buildFollowUpThreadPrompt, mergeFollowUpValidationPrompt, buildFollowUpValidationPrompt],
      [buildFollowUpValidationPrompt, mergeFollowUpThreadPrompt, buildFollowUpThreadPrompt],
    ] as const) {
      const marker = buildOwned(dossierItem).split("\n").at(-1) ?? "";
      const markerItem = item({
        ...dossierItem,
        ...override(marker),
      });
      const ownedDraft = `${prefix}${buildOwned(markerItem)}${suffix}`;

      expect(mergeDesired(ownedDraft, markerItem)).toBe(
        `${prefix}${buildDesired(markerItem)}${suffix}`,
      );
    }
  });

  it("includes recorded resolution metadata in both dossier modes", () => {
    const resolvedItem = item({
      status: "resolved",
      resolution: {
        note: "Resolved after checking <!-- PYLON-OWNED FOLLOW-UP -->.",
        threadId: ThreadId.make("resolution-thread"),
        commitSha: "abcdef987654",
      },
    });

    for (const prompt of [
      buildFollowUpThreadPrompt(resolvedItem),
      buildFollowUpValidationPrompt(resolvedItem),
    ]) {
      expect(prompt).toContain("### Recorded resolution");
      expect(prompt).toContain(resolvedItem.resolution?.note);
      expect(prompt).toContain("Resolution thread: resolution-thread");
      expect(prompt).toContain("Resolution commit: abcdef987654");
    }
  });

  it("preserves incomplete, corrupt, and legacy unverifiable frames as user content", () => {
    const validFrame = buildFollowUpThreadPrompt(dossierItem);
    const checksum = /sha256=([0-9a-f]{64})/.exec(validFrame)?.[1];
    const promptLength = /utf16=(\d+)/.exec(validFrame)?.[1];
    if (checksum === undefined || promptLength === undefined) {
      throw new Error("Expected a verifiable follow-up frame.");
    }
    const changedChecksum = `${checksum.startsWith("0") ? "1" : "0"}${checksum.slice(1)}`;
    const checksumCorrupt = validFrame.replaceAll(checksum, changedChecksum);
    const lengthCorrupt = validFrame.replaceAll(
      `utf16=${promptLength}`,
      `utf16=${Number(promptLength) + 1}`,
    );
    const bodyCorrupt = validFrame.replace(
      dossierItem.observation,
      "X".repeat(dossierItem.observation.length),
    );
    const incomplete = validFrame.slice(0, validFrame.lastIndexOf("\n"));
    const legacyUnverifiable = [
      "<!-- PYLON-OWNED FOLLOW-UP WORK START -->",
      "user-authored legacy-looking content",
      "<!-- PYLON-OWNED FOLLOW-UP WORK END -->",
    ].join("\n");
    const corruptions = [
      checksumCorrupt,
      lengthCorrupt,
      bodyCorrupt,
      incomplete,
      legacyUnverifiable,
    ];
    expect(checksumCorrupt).not.toBe(validFrame);
    expect(lengthCorrupt).not.toBe(validFrame);

    for (const corrupt of corruptions) {
      const userDraft = `\0prefix\r\n${corrupt}\n🧷suffix\t\0`;
      expect(mergeFollowUpValidationPrompt(userDraft, dossierItem)).toBe(
        `${userDraft}\n\n---\n\n${buildFollowUpValidationPrompt(dossierItem)}`,
      );

      const suffixDraft = `\0prefix${validFrame}\r\n${corrupt}\tuser suffix\0`;
      expect(mergeFollowUpValidationPrompt(suffixDraft, dossierItem)).toBe(
        `\0prefix${buildFollowUpValidationPrompt(dossierItem)}\r\n${corrupt}\tuser suffix\0`,
      );
    }
  });

  it.each([
    ["work", mergeFollowUpThreadPrompt],
    ["validation", mergeFollowUpValidationPrompt],
  ] as const)("keeps %s mode reuse idempotent around exact user bytes", (_mode, mergePrompt) => {
    const prefix = "\0user prefix\r\n";
    const suffix = "\nuser suffix🧷\t\0";
    const once = `${mergePrompt(prefix, dossierItem)}${suffix}`;

    expect(mergePrompt(once, dossierItem)).toBe(once);
  });

  it("treats incomplete marker-like user content as unrelated text", () => {
    const userDraft = "User note: PYLON-OWNED FOLLOW-UP WORK START (not a complete frame).  ";
    const merged = mergeFollowUpValidationPrompt(userDraft, dossierItem);

    expect(merged.startsWith(userDraft)).toBe(true);
    expect(merged).toContain("PYLON-OWNED FOLLOW-UP");
  });
});

describe("openFollowUpBlockersForBranch", () => {
  it("matches only open blockers for the exact project and branch", () => {
    const matches = openFollowUpBlockersForBranch(
      [
        item({
          id: FollowUpId.make("match"),
          kind: "blocker",
          gate: { kind: "branch", ref: "release" },
        }),
        item({
          id: FollowUpId.make("closed"),
          kind: "blocker",
          status: "resolved",
          gate: { kind: "branch", ref: "release" },
        }),
        item({
          id: FollowUpId.make("other-branch"),
          kind: "blocker",
          gate: { kind: "branch", ref: "main" },
        }),
        item({
          id: FollowUpId.make("other-project"),
          projectId: ProjectId.make("project-2"),
          kind: "blocker",
          gate: { kind: "branch", ref: "release" },
        }),
        item({
          id: FollowUpId.make("not-blocker"),
          kind: "open",
          gate: { kind: "branch", ref: "release" },
        }),
      ],
      { projectId: ProjectId.make("project-1"), branchRef: "release" },
    );

    expect(matches.map((entry) => entry.id)).toEqual(["match"]);
  });
});
