import { describe, expect, it } from "@effect/vitest";

import { FollowUpToolkit } from "./tools.ts";

describe("follow-up toolkit", () => {
  it("exposes the follow-up workflow tools", () => {
    const names = Object.values(FollowUpToolkit.tools)
      .map((tool) => tool.name)
      .sort();
    expect(names).toEqual([
      "followup_check_gate",
      "followup_file",
      "followup_list",
      "followup_record_validation",
      "followup_resolve",
    ]);
  });

  it("states the bright-line rule in the file tool description", () => {
    const fileTool = Object.values(FollowUpToolkit.tools).find(
      (tool) => tool.name === "followup_file",
    );
    expect(fileTool?.description).toContain("was I asked to do this, and can I do it now");
  });

  it("tells agents they cannot waive", () => {
    const resolveTool = Object.values(FollowUpToolkit.tools).find(
      (tool) => tool.name === "followup_resolve",
    );
    expect(resolveTool?.description?.toLowerCase()).toContain("cannot waive");
  });
});
