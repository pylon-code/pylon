import { EnvironmentId } from "@t3tools/contracts";
import * as NodeAssert from "node:assert/strict";
import { describe, expect, it } from "vite-plus/test";

import {
  buildFileContextMenuItems,
  isCurrentFileContextMenuScope,
  isFileContextMenuTargetForEnvironment,
  resolveFileContextMenuAbsolutePath,
} from "./fileContextMenu";

const BASE_TARGET = {
  environmentId: EnvironmentId.make("environment-local"),
  filePath: "src/index.ts",
  workspaceRoot: "/workspace/project",
};

describe("resolveFileContextMenuAbsolutePath", () => {
  it("joins workspace-relative diff paths onto the workspace root", () => {
    expect(resolveFileContextMenuAbsolutePath(BASE_TARGET)).toBe("/workspace/project/src/index.ts");
  });

  it("strips the repository prefix when the repo root is nested in the workspace", () => {
    expect(
      resolveFileContextMenuAbsolutePath({
        ...BASE_TARGET,
        workspaceRoot: "/workspace/project/packages/app",
        repositoryRoot: "/workspace/project",
        filePath: "packages/app/src/index.ts",
      }),
    ).toBe("/workspace/project/packages/app/src/index.ts");
  });

  it("returns null for paths outside the workspace when a repository root is set", () => {
    expect(
      resolveFileContextMenuAbsolutePath({
        ...BASE_TARGET,
        workspaceRoot: "/workspace/project/packages/app",
        repositoryRoot: "/workspace/project",
        filePath: "other/src/index.ts",
      }),
    ).toBeNull();
  });

  it("rejects absolute paths without a workspace root, matching diff path resolution", () => {
    expect(
      resolveFileContextMenuAbsolutePath({
        ...BASE_TARGET,
        workspaceRoot: undefined,
        filePath: "/absolute/src/index.ts",
      }),
    ).toBeNull();
  });

  it("does not turn deleted or escaping diff paths into file actions", () => {
    expect(resolveFileContextMenuAbsolutePath({ ...BASE_TARGET, fileExists: false })).toBeNull();
    expect(
      resolveFileContextMenuAbsolutePath({ ...BASE_TARGET, filePath: "../outside.ts" }),
    ).toBeNull();
    expect(
      resolveFileContextMenuAbsolutePath({ ...BASE_TARGET, filePath: "/tmp/outside.ts" }),
    ).toBeNull();
  });

  it("keeps spaces and percent characters literal in an environment-host path", () => {
    expect(resolveFileContextMenuAbsolutePath({ ...BASE_TARGET, filePath: "src/a b%20c.ts" })).toBe(
      "/workspace/project/src/a b%20c.ts",
    );
  });
});

it("rejects a menu result after a workspace switch, return, or unmount", async () => {
  const scopeA = {
    environmentId: BASE_TARGET.environmentId,
    workspaceRoot: BASE_TARGET.workspaceRoot,
  };
  const scopeB = { environmentId: EnvironmentId.make("other"), workspaceRoot: "/other" };
  const otherWorkspace = {
    environmentId: BASE_TARGET.environmentId,
    workspaceRoot: "/workspace/elsewhere",
  };
  let current: typeof scopeA | null = scopeA;
  let resolveMenu!: (value: string) => void;
  const selected = new Promise<string>((resolve) => {
    resolveMenu = resolve;
  });
  const dispatched: string[] = [];
  const pending = selected.then((action) => {
    if (isCurrentFileContextMenuScope(current, scopeA, BASE_TARGET)) dispatched.push(action);
  });
  current = scopeB;
  current = { ...scopeA }; // Same values after a return still belong to a newer committed scope.
  resolveMenu("open");
  await pending;
  expect(dispatched).toEqual([]);
  expect(isCurrentFileContextMenuScope(otherWorkspace, scopeA, BASE_TARGET)).toBe(false);
  expect(isCurrentFileContextMenuScope(current, scopeA, BASE_TARGET)).toBe(false);
  current = null;
  expect(isCurrentFileContextMenuScope(current, scopeA, BASE_TARGET)).toBe(false);
});

it("requires the selected environment before exposing file actions", () => {
  expect(isFileContextMenuTargetForEnvironment(BASE_TARGET.environmentId, BASE_TARGET)).toBe(true);
  expect(isFileContextMenuTargetForEnvironment(EnvironmentId.make("other"), BASE_TARGET)).toBe(
    false,
  );
  expect(isFileContextMenuTargetForEnvironment(null, BASE_TARGET)).toBe(false);
});

describe("buildFileContextMenuItems", () => {
  it("offers open, reveal, and an open-with submenu when all are available", () => {
    const items = buildFileContextMenuItems({
      hasAbsolutePath: true,
      capabilities: {
        revealLabel: "Reveal in Finder",
        canOpenDefault: true,
        editorIds: ["vscode", "cursor", "file-manager"],
      },
    });

    expect(items.map((item) => item.id)).toEqual(["open", "reveal-in-folder", "open-with"]);
    expect(items[0]).toMatchObject({ label: "Open" });
    expect(items[1]).toMatchObject({ label: "Reveal in Finder" });
    const openWith = items[2];
    NodeAssert.ok(openWith);
    expect(openWith.children?.map((child) => child.id)).toEqual(["editor:vscode", "editor:cursor"]);
  });

  it("offers only the reveal item when just reveal is enabled", () => {
    const items = buildFileContextMenuItems({
      hasAbsolutePath: true,
      capabilities: {
        revealLabel: "Reveal in File Explorer",
        canOpenDefault: false,
        editorIds: [],
      },
    });

    expect(items.map((item) => item.id)).toEqual(["reveal-in-folder"]);
    expect(items[0]).toMatchObject({ label: "Reveal in File Explorer" });
  });

  it("offers nothing when the path cannot be resolved", () => {
    expect(
      buildFileContextMenuItems({
        hasAbsolutePath: false,
        capabilities: {
          revealLabel: "Reveal in Finder",
          canOpenDefault: true,
          editorIds: ["vscode"],
        },
      }),
    ).toEqual([]);
  });
});
