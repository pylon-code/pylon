import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { BranchToolbarEnvironmentSelector } from "./BranchToolbarEnvironmentSelector";
import { BranchToolbarEnvModeSelector } from "./BranchToolbarEnvModeSelector";

describe("locked composer context labels", () => {
  it("keeps clipped environment and workspace labels keyboard reachable", () => {
    const environment = renderToStaticMarkup(
      <BranchToolbarEnvironmentSelector
        envLocked
        environmentId={EnvironmentId.make("remote")}
        availableEnvironments={[
          {
            environmentId: EnvironmentId.make("remote"),
            projectId: ProjectId.make("project"),
            label: "Remote build host",
            machine: "server",
            isPrimary: false,
          },
        ]}
      />,
    );
    const workspace = renderToStaticMarkup(
      <BranchToolbarEnvModeSelector
        envLocked
        effectiveEnvMode="local"
        activeWorktreePath="/projects/pylon/worktrees/task"
        onEnvModeChange={() => {}}
      />,
    );

    expect(environment).toContain('tabindex="0"');
    expect(environment).toContain('aria-label="Run on Remote build host"');
    expect(workspace).toContain('tabindex="0"');
    expect(workspace).toContain('aria-label="Workspace');
  });
});
