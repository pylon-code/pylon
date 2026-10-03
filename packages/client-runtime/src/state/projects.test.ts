import { describe, expect, it } from "vite-plus/test";

import { isScratchProject, resolveScratchEnvironmentId } from "./projects.ts";

describe("isScratchProject", () => {
  it("matches the advertised Scratch root, ignoring a trailing separator", () => {
    const root = "/Users/alice/.pylon/userdata/scratch";
    expect(isScratchProject({ workspaceRoot: `${root}/` }, root)).toBe(true);
    expect(isScratchProject({ workspaceRoot: "/Users/alice/code/pylon" }, root)).toBe(false);
  });

  it("is never Scratch when the environment offers none", () => {
    expect(isScratchProject({ workspaceRoot: "/srv/scratch" }, undefined)).toBe(false);
    expect(isScratchProject({ workspaceRoot: "/srv/scratch" }, null)).toBe(false);
  });
});

describe("resolveScratchEnvironmentId", () => {
  it("keeps the current machine when it offers Scratch", () => {
    expect(resolveScratchEnvironmentId("laptop", ["server", "laptop"])).toBe("laptop");
  });

  it("does not swap a current machine without Scratch for another one", () => {
    expect(resolveScratchEnvironmentId("laptop", ["server"])).toBeNull();
  });

  it("picks only a sole offering machine when none is current", () => {
    expect(resolveScratchEnvironmentId(null, ["server"])).toBe("server");
    expect(resolveScratchEnvironmentId(null, ["server", "laptop"])).toBeNull();
    expect(resolveScratchEnvironmentId(null, [])).toBeNull();
  });
});
