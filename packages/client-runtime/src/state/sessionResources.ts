import * as Option from "effect/Option";

import {
  decodeOrchestrationSessionActivity,
  type OrchestrationThreadActivity,
  type ProviderInstanceId,
  type ServerProvider,
  type SessionResourcesUpdatedActivityPayload,
} from "@t3tools/contracts";

export type SessionResourcesSnapshot = SessionResourcesUpdatedActivityPayload & {
  readonly updatedAt: string;
};

/** Return the latest valid session-scoped provider resource inventory. */
export function deriveLatestSessionResources(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  providerInstanceId: ProviderInstanceId,
): SessionResourcesSnapshot | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.kind !== "session.resources.updated") continue;
    const decoded = decodeOrchestrationSessionActivity(activity);
    if (Option.isNone(decoded) || decoded.value.kind !== "session.resources.updated") continue;
    if (decoded.value.payload.providerInstanceId !== providerInstanceId) continue;
    return { ...decoded.value.payload, updatedAt: activity.createdAt };
  }
  return null;
}

/** Prefer session-scoped native commands when the live catalog is available. */
export function resolveSessionSlashCommands(
  snapshot: SessionResourcesSnapshot | null,
  fallback: ServerProvider["slashCommands"],
): ServerProvider["slashCommands"] {
  if (snapshot?.available !== true) return fallback;
  return snapshot.commands.map((command) => ({
    name: command.name,
    ...(command.description === undefined ? {} : { description: command.description }),
    ...(command.argumentHint === undefined ? {} : { input: { hint: command.argumentHint } }),
  }));
}

/** Show provider command help without dropping a separately supplied argument hint. */
export function formatProviderSlashCommandDescription(
  command: ServerProvider["slashCommands"][number],
): string {
  const description = command.description?.trim();
  const hint = command.input?.hint.trim();
  if (description && hint) return `${description} · ${hint}`;
  return description || hint || "Run provider command";
}
