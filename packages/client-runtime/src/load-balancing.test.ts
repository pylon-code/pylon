import { describe, expect, it } from "vite-plus/test";

import { resolveLoadBalancingStatus } from "./load-balancing.ts";

describe("resolveLoadBalancingStatus", () => {
  it("keeps a stored machine balanced regardless of later checks", () => {
    expect(
      resolveLoadBalancingStatus({
        balancedEnvironmentId: "office",
        pending: true,
        chosenEnvironmentId: null,
      }),
    ).toBe("balanced");
  });

  it("reports checking while resource requests are still running", () => {
    expect(
      resolveLoadBalancingStatus({
        balancedEnvironmentId: null,
        pending: true,
        chosenEnvironmentId: null,
      }),
    ).toBe("checking");
  });

  it("stays balanced while a chosen machine is being saved to the draft", () => {
    expect(
      resolveLoadBalancingStatus({
        balancedEnvironmentId: undefined,
        pending: false,
        chosenEnvironmentId: "office",
      }),
    ).toBe("balanced");
  });

  it("is unavailable when finished checks chose no machine, including with no candidates", () => {
    expect(
      resolveLoadBalancingStatus({
        balancedEnvironmentId: null,
        pending: false,
        chosenEnvironmentId: null,
      }),
    ).toBe("unavailable");
  });
});
