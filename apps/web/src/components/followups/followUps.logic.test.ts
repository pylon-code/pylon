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
    const prefix = "  Keep this user-authored prefix byte-for-byte.\n";
    const suffix = "\n\nKeep this user-authored suffix too.  ";
    const workDraft = `${mergeFollowUpThreadPrompt(prefix, dossierItem)}${suffix}`;
    const switched = mergeFollowUpValidationPrompt(workDraft, dossierItem);

    expect(switched.startsWith(prefix)).toBe(true);
    expect(switched.endsWith(suffix)).toBe(true);
    expect(switched).toContain("PYLON-OWNED FOLLOW-UP VALIDATION START");
    expect(switched).toContain("PYLON-OWNED FOLLOW-UP VALIDATION END");
    expect(switched).not.toContain("PYLON-OWNED FOLLOW-UP WORK START");
    expect(switched).not.toContain("Take on this saved Pylon follow-up");
    expect(switched.match(/Validation for Follow-up ID: follow-up-42/g)).toHaveLength(1);
  });

  it("replaces the owned validation block with work while preserving unrelated bytes", () => {
    const prefix = "\tUser context before the dossier.\n\n";
    const suffix = "\nUser context after the dossier.\n";
    const validationDraft = `${mergeFollowUpValidationPrompt(prefix, dossierItem)}${suffix}`;
    const switched = mergeFollowUpThreadPrompt(validationDraft, dossierItem);

    expect(switched.startsWith(prefix)).toBe(true);
    expect(switched.endsWith(suffix)).toBe(true);
    expect(switched).toContain("PYLON-OWNED FOLLOW-UP WORK START");
    expect(switched).toContain("PYLON-OWNED FOLLOW-UP WORK END");
    expect(switched).not.toContain("PYLON-OWNED FOLLOW-UP VALIDATION START");
    expect(switched).not.toContain("Investigate read-only");
    expect(switched.match(/Follow-up ID: follow-up-42/g)).toHaveLength(1);
  });

  it("treats incomplete marker-like user content as unrelated text", () => {
    const userDraft = "User note: PYLON-OWNED FOLLOW-UP WORK START (not a complete frame).  ";
    const merged = mergeFollowUpValidationPrompt(userDraft, dossierItem);

    expect(merged.startsWith(userDraft)).toBe(true);
    expect(merged).toContain("PYLON-OWNED FOLLOW-UP VALIDATION START");
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
