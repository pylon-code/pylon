import type { ServerSettings } from "@t3tools/contracts";
import { createFollowUpEnvironmentAtoms } from "@t3tools/client-runtime/state/followups";

import { connectionAtomRuntime } from "../connection/runtime";

export const followUpEnvironment = createFollowUpEnvironmentAtoms(connectionAtomRuntime);

export function isFollowUpBetaEnabled(settings: Pick<ServerSettings, "followUpsEnabled">): boolean {
  return settings.followUpsEnabled;
}
