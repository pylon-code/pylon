import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { getProjectEnvironmentPresentation } from "./ProjectEnvironmentBadge";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const build = EnvironmentId.make("build");

describe("project scope environment descriptions", () => {
  it("distinguishes local, remote and grouped projects with the same display name", () => {
    const here = { environmentId: local, environmentLabel: "Laptop" };
    const there = { environmentId: remote, environmentLabel: "Workstation" };
    expect(getProjectEnvironmentPresentation([here], local)).toBeNull();
    expect(getProjectEnvironmentPresentation([there], local)).toEqual({
      environmentId: remote,
      description: "On Workstation",
    });
    expect(getProjectEnvironmentPresentation([here, there], local)).toEqual({
      environmentId: remote,
      description: "Also on Workstation",
    });
  });

  it("keeps hosted-client labels stable, deduplicated and explicit for unnamed environments", () => {
    const members = [
      { environmentId: local, environmentLabel: "Workstation" },
      { environmentId: remote, environmentLabel: "Workstation" },
      { environmentId: build, environmentLabel: null },
    ];
    expect(getProjectEnvironmentPresentation(members, null)).toEqual({
      environmentId: build,
      description: "On Remote, Workstation",
    });
    expect(getProjectEnvironmentPresentation(members.toReversed(), null)).toEqual(
      getProjectEnvironmentPresentation(members, null),
    );
  });
});
