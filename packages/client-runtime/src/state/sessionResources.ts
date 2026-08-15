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

/** Ignore a retained inventory captured before the current provider-session incarnation. */
export function deriveCurrentSessionResources(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  providerInstanceId: ProviderInstanceId,
  sessionStartedAt: string | undefined,
): SessionResourcesSnapshot | null {
  const snapshot = deriveLatestSessionResources(activities, providerInstanceId);
  if (snapshot === null || sessionStartedAt === undefined) return null;
  return Date.parse(snapshot.updatedAt) >= Date.parse(sessionStartedAt) ? snapshot : null;
}

export function sessionResourceViewIdentity(input: {
  readonly environmentId: string;
  readonly threadId: string;
  readonly providerInstanceId: string | undefined;
  readonly sessionStartedAt: string | undefined;
}): string {
  return JSON.stringify([
    input.environmentId,
    input.threadId,
    input.providerInstanceId ?? null,
    input.sessionStartedAt ?? null,
  ]);
}

export type SessionResourceInventory = {
  readonly skills: SessionResourcesSnapshot["skills"];
  readonly prompts: SessionResourcesSnapshot["prompts"];
  readonly showSkills: boolean;
  readonly showPrompts: boolean;
};

/** Project only resource categories the active provider truthfully advertises. */
export function presentSessionResourceInventory(
  snapshot: SessionResourcesSnapshot | null,
  provider: Pick<ServerProvider, "featureCapabilities"> | null | undefined,
): SessionResourceInventory | null {
  const resources = provider?.featureCapabilities?.resources;
  if (snapshot?.available !== true || resources?.support === "unavailable") return null;
  const showSkills = resources?.operations.includes("skills") === true;
  const showPrompts = resources?.operations.includes("prompts") === true;
  if (!showSkills && !showPrompts) return null;
  return {
    skills: showSkills ? snapshot.skills : [],
    prompts: showPrompts ? snapshot.prompts : [],
    showSkills,
    showPrompts,
  };
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

/** Whether the active provider instance advertises explicit session resource reload. */
export function supportsSessionResourceReload(
  provider: Pick<ServerProvider, "featureCapabilities"> | null | undefined,
): boolean {
  const resources = provider?.featureCapabilities?.resources;
  return resources?.support === "read-write" && resources.operations.includes("reload");
}
