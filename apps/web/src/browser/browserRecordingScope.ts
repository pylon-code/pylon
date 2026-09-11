/**
 * Whether an agent's recording must be uploaded to its environment. The desktop's
 * primary environment runs on the desktop's machine, so its agent reads the saved
 * file where the desktop wrote it.
 */
export function shouldTransferBrowserRecording(input: {
  readonly transferRequested: boolean;
  readonly environmentId: string;
  readonly primaryEnvironmentId: string | null;
}): boolean {
  return input.transferRequested && input.environmentId !== input.primaryEnvironmentId;
}

export function resolveBrowserRecordingStopTarget(
  activeTabIds: ReadonlySet<string>,
  implicitTabId: string | null,
  explicitTabId?: string,
): string | null {
  if (explicitTabId !== undefined) {
    return activeTabIds.has(explicitTabId) ? explicitTabId : null;
  }
  if (implicitTabId !== null && activeTabIds.has(implicitTabId)) {
    return implicitTabId;
  }
  if (activeTabIds.size !== 1) return null;
  return activeTabIds.values().next().value ?? null;
}
