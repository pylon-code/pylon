import { describe, expect, it } from "vite-plus/test";

import {
  cancelledInteractionResponse,
  clampSessionInteractionDraft,
  confirmedInteractionResponse,
  selectedInteractionResponse,
  selectInteractionOptionKey,
  sessionInteractionCardModel,
  submittedInteractionResponse,
} from "./sessionInteractionCard.logic";

describe("PendingSessionInteractionCard model", () => {
  it("presents select options and the selected response", () => {
    expect(
      sessionInteractionCardModel({ kind: "select", title: "Target", options: ["Web", "Mobile"] }),
    ).toEqual({ kind: "select", title: "Target", options: ["Web", "Mobile"] });
    expect(selectedInteractionResponse("Mobile")).toEqual({ kind: "selected", value: "Mobile" });
    expect(
      ["Mobile", "Mobile", "Web"].map((_, index, options) =>
        selectInteractionOptionKey(options, index),
      ),
    ).toEqual(['["Mobile",0]', '["Mobile",1]', '["Web",0]']);
  });

  it("presents confirm copy and exact yes/no responses", () => {
    expect(
      sessionInteractionCardModel({ kind: "confirm", title: "Continue?", message: "Ship it" }),
    ).toEqual({ kind: "confirm", title: "Continue?", message: "Ship it" });
    expect(confirmedInteractionResponse(true)).toEqual({ kind: "confirmed", confirmed: true });
    expect(confirmedInteractionResponse(false)).toEqual({ kind: "confirmed", confirmed: false });
  });

  it("presents a single-line input and submitted response", () => {
    expect(
      sessionInteractionCardModel({ kind: "input", title: "Name", placeholder: "Release" }),
    ).toEqual({
      kind: "input",
      title: "Name",
      initialValue: "",
      placeholder: "Release",
      multiline: false,
    });
    expect(submittedInteractionResponse("Pylon")).toEqual({ kind: "submitted", value: "Pylon" });
  });

  it("caps input and editor drafts at the contract response limit", () => {
    const draft = clampSessionInteractionDraft("x".repeat(100_001));
    expect(draft).toHaveLength(100_000);
  });

  it("presents a prefilled multiline editor", () => {
    expect(
      sessionInteractionCardModel({ kind: "editor", title: "Notes", prefill: "Draft" }),
    ).toEqual({
      kind: "editor",
      title: "Notes",
      initialValue: "Draft",
      placeholder: null,
      multiline: true,
    });
  });

  it("builds the provider-neutral cancellation response", () => {
    expect(cancelledInteractionResponse()).toEqual({ kind: "cancelled" });
  });
});
