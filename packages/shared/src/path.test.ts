import { describe, expect, it } from "vite-plus/test";
import {
  isDriveOrPosixAbsolutePath,
  isExplicitRelativePath,
  isUncPath,
  isWindowsAbsolutePath,
  isWindowsDrivePath,
  normalizeProjectPathForComparison,
  normalizeProjectPathForDispatch,
} from "./path.ts";

describe("path helpers", () => {
  it("detects windows drive paths", () => {
    expect(isWindowsDrivePath("C:\\repo")).toBe(true);
    expect(isWindowsDrivePath("D:/repo")).toBe(true);
    expect(isWindowsDrivePath("/repo")).toBe(false);
  });

  it("detects UNC paths", () => {
    expect(isUncPath("\\\\server\\share\\repo")).toBe(true);
    expect(isUncPath("C:\\repo")).toBe(false);
  });

  it("detects windows absolute paths", () => {
    expect(isWindowsAbsolutePath("C:\\repo")).toBe(true);
    expect(isWindowsAbsolutePath("\\\\server\\share\\repo")).toBe(true);
    expect(isWindowsAbsolutePath("./repo")).toBe(false);
  });

  it("accepts drive and POSIX absolute paths but not UNC or device paths", () => {
    expect(isDriveOrPosixAbsolutePath("/tmp/clip.mp4")).toBe(true);
    expect(isDriveOrPosixAbsolutePath("C:\\Users\\demo\\clip.mp4")).toBe(true);
    expect(isDriveOrPosixAbsolutePath("D:/media/frame.png")).toBe(true);
    expect(isDriveOrPosixAbsolutePath("\\\\attacker.example\\share\\x.png")).toBe(false);
    expect(isDriveOrPosixAbsolutePath("\\\\?\\C:\\Users\\demo\\clip.mp4")).toBe(false);
    expect(isDriveOrPosixAbsolutePath("\\\\.\\pipe\\x.png")).toBe(false);
    expect(isDriveOrPosixAbsolutePath("//attacker.example/share/x.png")).toBe(false);
    expect(isDriveOrPosixAbsolutePath("/\\attacker.example\\share\\x.png")).toBe(false);
    expect(isDriveOrPosixAbsolutePath("clip.mp4")).toBe(false);
  });

  it("detects explicit relative paths", () => {
    expect(isExplicitRelativePath(".")).toBe(true);
    expect(isExplicitRelativePath("..")).toBe(true);
    expect(isExplicitRelativePath("./repo")).toBe(true);
    expect(isExplicitRelativePath("..\\repo")).toBe(true);
    expect(isExplicitRelativePath("~/repo")).toBe(false);
  });

  it("normalizes a bare Windows drive root the same as one with a trailing separator", () => {
    // `C:`, `C:\` and `C:/` all refer to the drive root and must compare equal.
    expect(normalizeProjectPathForDispatch("C:")).toBe("C:\\");
    expect(normalizeProjectPathForComparison("C:")).toBe("c:\\");
    expect(normalizeProjectPathForComparison("C:")).toBe(normalizeProjectPathForComparison("C:\\"));
    expect(normalizeProjectPathForComparison("C:")).toBe(normalizeProjectPathForComparison("C:/"));
    // Non-root drive paths keep their trailing separator trimmed as before.
    expect(normalizeProjectPathForDispatch("C:\\repo\\")).toBe("C:\\repo");
  });
});
