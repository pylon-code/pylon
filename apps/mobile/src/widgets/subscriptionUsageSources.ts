import type { EnvironmentPresentation } from "@t3tools/client-runtime/connection";
import type { ServerConfigProjection } from "@t3tools/client-runtime/state/server";

/** Only a current authenticated config can leave the app for an OS widget. */
export function selectWidgetPresentation(
  presentation: EnvironmentPresentation,
  authenticated: boolean,
  projection: ServerConfigProjection | null,
  sessionOwner: object | null,
): EnvironmentPresentation | null {
  if (
    presentation.connection.phase !== "connected" ||
    !authenticated ||
    projection?.source !== "live" ||
    sessionOwner === null ||
    projection.sessionOwner !== sessionOwner
  ) {
    return null;
  }
  // Published hub sources can be carried across a new config snapshot before
  // their separate update arrives. Native provider quotas have a current
  // config snapshot and suffice for a safe glance widget.
  return {
    ...presentation,
    serverConfig: { ...projection.config, usageLimitSources: undefined },
  };
}
