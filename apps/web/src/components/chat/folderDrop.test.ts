import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import { folderDropTarget, resolveDroppedFolderPath } from "./folderDrop";

const environmentId = EnvironmentId.make("environment-1");

describe("folderDropTarget", () => {
  it("targets local when the thread is on the primary environment", () => {
    expect(
      folderDropTarget({
        desktopManagedPrimary: true,
        primaryRunningDistro: null,
        hasNativePathBridge: true,
        environmentId,
        primaryEnvironmentId: environmentId,
      }),
    ).toBe("local");
  });

  it("refuses a browser or configured remote primary even with matching ids", () => {
    expect(
      folderDropTarget({
        desktopManagedPrimary: false,
        primaryRunningDistro: null,
        hasNativePathBridge: true,
        environmentId,
        primaryEnvironmentId: environmentId,
      }),
    ).toBe("unavailable");
  });

  it("refuses an older desktop bridge without native path lookup", () => {
    expect(
      folderDropTarget({
        desktopManagedPrimary: true,
        primaryRunningDistro: null,
        hasNativePathBridge: false,
        environmentId,
        primaryEnvironmentId: environmentId,
      }),
    ).toBe("unavailable");
  });

  it("targets remote when the thread lives on another environment", () => {
    expect(
      folderDropTarget({
        desktopManagedPrimary: true,
        primaryRunningDistro: null,
        hasNativePathBridge: true,
        environmentId: EnvironmentId.make("environment-2"),
        primaryEnvironmentId: environmentId,
      }),
    ).toBe("remote");
  });

  it("targets remote when no primary environment is known", () => {
    expect(
      folderDropTarget({
        desktopManagedPrimary: true,
        primaryRunningDistro: null,
        hasNativePathBridge: true,
        environmentId,
        primaryEnvironmentId: null,
      }),
    ).toBe("remote");
  });

  it("refuses a WSL-backed or unknown primary path namespace", () => {
    for (const primaryRunningDistro of ["Ubuntu", undefined]) {
      expect(
        folderDropTarget({
          desktopManagedPrimary: true,
          primaryRunningDistro,
          hasNativePathBridge: true,
          environmentId,
          primaryEnvironmentId: environmentId,
        }),
      ).toBe("unavailable");
    }
  });
});

describe("resolveDroppedFolderPath", () => {
  it("returns the native path when the bridge provides it", () => {
    const folder = new File([], "contracts");
    expect(resolveDroppedFolderPath(folder, () => "/tmp/project/contracts")).toBe(
      "/tmp/project/contracts",
    );
  });

  it("returns null for an outside-folder drop even when the folder name matches a project directory", () => {
    const folder = new File([], "contracts");
    expect(resolveDroppedFolderPath(folder, undefined)).toBeNull();
  });

  it("returns null when the bridge returns an empty path", () => {
    const folder = new File([], "contracts");
    expect(resolveDroppedFolderPath(folder, () => "")).toBeNull();
  });

  it("rejects relative or unreadable paths and accepts Windows absolute paths", () => {
    const folder = new File([], "contracts");
    expect(resolveDroppedFolderPath(folder, () => "contracts")).toBeNull();
    expect(
      resolveDroppedFolderPath(folder, () => {
        throw new Error("unavailable");
      }),
    ).toBeNull();
    expect(resolveDroppedFolderPath(folder, () => "C:\\work\\contracts")).toBe(
      "C:\\work\\contracts",
    );
  });
});
