import { describe, expect, it } from "vite-plus/test";

import { resolveFollowUpsRoutePresentation } from "./followUpsRoute.logic";

describe("Follow-ups route presentation", () => {
  it("renders the list only when an eligible environment is current", () => {
    expect(resolveFollowUpsRoutePresentation({ status: "available" })).toEqual({
      kind: "content",
    });
  });

  it("redirects only permanently settled unavailable states", () => {
    for (const reason of ["disabled", "connection-error", "no-environments"] as const) {
      expect(resolveFollowUpsRoutePresentation({ status: "unavailable", reason })).toEqual({
        kind: "redirect",
      });
    }
  });

  it.each([
    ["catalog", "Loading Follow-ups…"],
    ["server-config", "Loading Follow-ups…"],
    ["connecting", "Connecting to Follow-ups…"],
    ["reconnecting", "Reconnecting to Follow-ups…"],
    [
      "offline",
      "Follow-ups are unavailable while offline. They’ll return when your connection recovers.",
    ],
  ] as const)("keeps %s recoverable with truthful status copy", (reason, message) => {
    expect(resolveFollowUpsRoutePresentation({ status: "pending", reason })).toEqual({
      kind: "status",
      message,
    });
  });
});
