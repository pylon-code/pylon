import type { EnvironmentPresentation } from "@t3tools/client-runtime/connection";

import { isDesktopLocalConnectionTarget } from "../connection/desktopLocal";

/** Recheck the live catalog and connection before honoring a delayed UI action. */
export function canManuallyDisconnectEnvironment(
  presentation: EnvironmentPresentation | null,
): boolean {
  return (
    presentation !== null &&
    presentation.entry.enabled &&
    presentation.entry.target._tag !== "PrimaryConnectionTarget" &&
    !isDesktopLocalConnectionTarget(presentation.entry.target) &&
    presentation.connection.phase !== "connected"
  );
}
