import type { EnvironmentId } from "@t3tools/contracts";

export function folderDropTarget(input: {
  desktopManagedPrimary: boolean;
  primaryRunningDistro: string | null | undefined;
  hasNativePathBridge: boolean;
  environmentId: EnvironmentId;
  primaryEnvironmentId: EnvironmentId | null;
}): "local" | "remote" | "unavailable" {
  if (input.primaryEnvironmentId === null || input.environmentId !== input.primaryEnvironmentId) {
    return "remote";
  }
  if (
    !input.desktopManagedPrimary ||
    input.primaryRunningDistro !== null ||
    !input.hasNativePathBridge
  )
    return "unavailable";
  return "local";
}

export function resolveDroppedFolderPath(
  folder: File,
  getPathForFile: ((file: File) => string) | undefined,
): string | null {
  try {
    const path = getPathForFile?.(folder);
    return typeof path === "string" &&
      (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\"))
      ? path
      : null;
  } catch {
    return null;
  }
}
