import { EnvironmentId, ProjectId, type ProjectScript } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  outdatedProjectDefaultsNotice,
  patchRequiresProjectDefaults,
  planProjectOverrideWrites,
  projectGroupTitleNeedsUpdate,
  resolveProjectScriptsWrite,
  settingRequiresProjectDefaults,
  supportsProjectDefaults,
} from "./ProjectSettingsPanel.logic";

describe("projectGroupTitleNeedsUpdate", () => {
  it("updates divergent member titles even when the next title is the derived group label", () => {
    expect(
      projectGroupTitleNeedsUpdate(["local-title", "remote-title"], "Repository name", true),
    ).toBe(true);
  });

  it("skips an untouched blur when the derived label differs from member titles", () => {
    expect(projectGroupTitleNeedsUpdate(["repo-slug", "repo-slug"], "Repository Name", false)).toBe(
      false,
    );
  });

  it("skips an update when every member already has the next title", () => {
    expect(projectGroupTitleNeedsUpdate(["Shared name", "Shared name"], "Shared name", true)).toBe(
      false,
    );
  });
});

const currentServer = { environment: { capabilities: { projectDefaults: true } } };
const olderServer = { environment: { capabilities: {} } };
const action: ProjectScript = {
  id: "check",
  name: "Check",
  command: "npm test",
  icon: "play",
  runOnWorktreeCreate: false,
};

describe("project defaults support", () => {
  it("trusts only the server capability", () => {
    expect(supportsProjectDefaults(currentServer)).toBe(true);
    expect(supportsProjectDefaults(olderServer)).toBe(false);
    expect(supportsProjectDefaults(null)).toBe(false);
  });

  it("lets older servers keep the workspace and browser access defaults they already saved", () => {
    expect(patchRequiresProjectDefaults({ defaultThreadEnvMode: "worktree" })).toBe(false);
    expect(patchRequiresProjectDefaults({ enableAgentBrowserAccess: false })).toBe(false);
    expect(patchRequiresProjectDefaults({ defaultModelSelection: null })).toBe(true);
    expect(patchRequiresProjectDefaults({ defaultAutoPull: true })).toBe(true);
    expect(patchRequiresProjectDefaults({ defaultProjectScripts: [] })).toBe(true);
    expect(settingRequiresProjectDefaults("defaultThreadEnvMode")).toBe(false);
    expect(settingRequiresProjectDefaults("projectAutoPullOverrides")).toBe(true);
  });

  it("names the machines an older server keeps from changing", () => {
    expect(outdatedProjectDefaultsNotice(["Office", "Laptop"])).toBe(
      "Update Office, Laptop to change the default model, automatic pull, and actions there. Workspace and browser access still apply.",
    );
    expect(outdatedProjectDefaultsNotice(null)).toBe(
      "Update this machine to change its default model, automatic pull, and actions.",
    );
  });
});

describe("resolveProjectScriptsWrite", () => {
  const projectId = ProjectId.make("project-actions");

  it("saves checkout actions as settings overrides on current servers", () => {
    expect(
      resolveProjectScriptsWrite({
        supportsProjectDefaults: true,
        projectId,
        nextScripts: [action],
      }),
    ).toEqual({ kind: "settings", patch: { projectScriptOverrides: { [projectId]: [action] } } });
    expect(
      resolveProjectScriptsWrite({
        supportsProjectDefaults: true,
        projectId: null,
        nextScripts: [],
      }),
    ).toEqual({ kind: "settings", patch: { defaultProjectScripts: [] } });
  });

  it("falls back to the project record on older servers", () => {
    expect(
      resolveProjectScriptsWrite({
        supportsProjectDefaults: false,
        projectId,
        nextScripts: [action],
      }),
    ).toEqual({ kind: "project", projectId, scripts: [action] });
    expect(
      resolveProjectScriptsWrite({ supportsProjectDefaults: false, projectId, nextScripts: null }),
    ).toEqual({ kind: "project", projectId, scripts: [] });
  });

  it("has nowhere to save machine default actions on older servers", () => {
    expect(
      resolveProjectScriptsWrite({
        supportsProjectDefaults: false,
        projectId: null,
        nextScripts: [action],
      }),
    ).toEqual({ kind: "unsupported" });
  });
});

describe("planProjectOverrideWrites", () => {
  const current = EnvironmentId.make("environment-current");
  const older = EnvironmentId.make("environment-older");
  const members = [
    { environmentId: current, id: ProjectId.make("project-current") },
    { environmentId: older, id: ProjectId.make("project-older") },
  ];
  const supports = (environmentId: EnvironmentId) => environmentId === current;

  it("saves automatic pull on the project record for older servers", () => {
    expect(
      planProjectOverrideWrites({
        key: "projectAutoPullOverrides",
        enabled: true,
        members,
        supportsProjectDefaults: supports,
      }),
    ).toEqual([
      { kind: "project", member: members[1], autoPull: true },
      {
        kind: "settings",
        environmentId: current,
        patch: { projectAutoPullOverrides: { "project-current": true } },
      },
    ]);
  });

  it("resets automatic pull by clearing opt-ins and overrides", () => {
    expect(
      planProjectOverrideWrites({
        key: "projectAutoPullOverrides",
        enabled: undefined,
        members,
        supportsProjectDefaults: supports,
      }),
    ).toEqual([
      { kind: "project", member: members[0], autoPull: false },
      { kind: "project", member: members[1], autoPull: false },
      {
        kind: "settings",
        environmentId: current,
        patch: { projectAutoPullOverrides: { "project-current": null } },
      },
    ]);
  });

  it("refuses a browser access override that an older server would drop", () => {
    expect(
      planProjectOverrideWrites({
        key: "projectAgentBrowserAccessOverrides",
        enabled: false,
        members,
        supportsProjectDefaults: supports,
      }),
    ).toBeNull();
    expect(
      planProjectOverrideWrites({
        key: "projectAgentBrowserAccessOverrides",
        enabled: false,
        members: [members[0]!],
        supportsProjectDefaults: supports,
      }),
    ).toEqual([
      {
        kind: "settings",
        environmentId: current,
        patch: { projectAgentBrowserAccessOverrides: { "project-current": false } },
      },
    ]);
  });
});
