import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  FollowUp,
  FollowUpFileInput,
  FollowUpSubscribeInput,
  FollowUpUpdateStatusInput,
} from "./followups.ts";

const decodeFollowUp = Schema.decodeUnknownSync(FollowUp);
const decodeSubscribeInput = Schema.decodeUnknownSync(FollowUpSubscribeInput);

describe("follow-up public boundaries", () => {
  it("does not expose provenance or actor fields to WebSocket callers", () => {
    expect("sourceKind" in FollowUpFileInput.fields).toBe(false);
    expect("sourceThreadId" in FollowUpFileInput.fields).toBe(false);
    expect("actor" in FollowUpUpdateStatusInput.fields).toBe(false);
    expect("projectId" in FollowUpUpdateStatusInput.fields).toBe(true);
  });

  it("requires project scope for subscriptions", () => {
    expect(() => decodeSubscribeInput({})).toThrow();
    expect(decodeSubscribeInput({ projectId: "project-followups" })).toEqual({
      projectId: "project-followups",
    });
  });

  it("decodes old persisted items with no validation as unvalidated", () => {
    const decoded = decodeFollowUp({
      id: "follow-up-1",
      projectId: "project-followups",
      kind: "open",
      status: "open",
      title: "Recheck the behavior",
      observation: "It looked wrong during unrelated work.",
      deferReason: "out-of-scope",
      verifyCheck: "Run the focused check.",
      evidence: [],
      gate: null,
      sourceKind: "agent",
      sourceThreadId: null,
      resolution: null,
      revision: 0,
      createdAt: "2026-08-04T12:00:00.000Z",
      updatedAt: "2026-08-04T12:00:00.000Z",
    });

    expect(decoded.lastValidation).toBeNull();
  });
});
