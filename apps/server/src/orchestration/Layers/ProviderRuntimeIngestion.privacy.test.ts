import { describe, expect, it } from "vite-plus/test";

import {
  redactSessionInteractionRequestForActivity,
  redactSessionInteractionResponseForActivity,
} from "./ProviderRuntimeIngestion.ts";

describe("durable session interaction privacy", () => {
  it("removes editor prefills before activities are persisted or synchronized", () => {
    expect(
      redactSessionInteractionRequestForActivity({
        kind: "editor",
        title: "Edit credentials",
        prefill: "secret draft",
      }),
    ).toEqual({ kind: "editor", title: "Edit credentials" });
  });

  it("never retains submitted input or editor text", () => {
    expect(
      redactSessionInteractionResponseForActivity({ kind: "submitted", value: "secret answer" }),
    ).toEqual({ kind: "submitted", value: "" });
  });

  it("preserves non-sensitive interaction choices", () => {
    expect(
      redactSessionInteractionResponseForActivity({ kind: "selected", value: "Option A" }),
    ).toEqual({ kind: "selected", value: "Option A" });
    expect(
      redactSessionInteractionRequestForActivity({
        kind: "input",
        title: "Name",
        placeholder: "Type a name",
      }),
    ).toEqual({ kind: "input", title: "Name", placeholder: "Type a name" });
  });
});
