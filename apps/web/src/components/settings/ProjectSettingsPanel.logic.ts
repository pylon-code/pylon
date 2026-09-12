import type {
  EnvironmentId,
  ProjectId,
  ProjectScript,
  ServerConfig,
  ServerSettingsPatch,
} from "@t3tools/contracts";

export function projectGroupTitleNeedsUpdate(
  memberTitles: ReadonlyArray<string>,
  nextTitle: string,
  wasEdited: boolean,
): boolean {
  return wasEdited && memberTitles.some((title) => title !== nextTitle);
}

const PROJECT_DEFAULTS_KEYS = [
  "defaultModelSelection",
  "defaultProjectScripts",
  "defaultAutoPull",
  "projectScriptOverrides",
  "projectAutoPullOverrides",
  "projectAgentBrowserAccessOverrides",
] as const satisfies ReadonlyArray<keyof ServerSettingsPatch>;

/**
 * Whether a server keeps machine project defaults and per-project overrides.
 * Older servers strip those patch keys without an error, and clients decode
 * the missing settings as defaults, so only the capability can tell.
 */
export function supportsProjectDefaults(
  serverConfig:
    | {
        readonly environment: {
          readonly capabilities: Pick<
            ServerConfig["environment"]["capabilities"],
            "projectDefaults"
          >;
        };
      }
    | null
    | undefined,
): boolean {
  return serverConfig?.environment.capabilities.projectDefaults === true;
}

/** Workspace and browser access defaults predate project defaults; the rest need the capability. */
export function settingRequiresProjectDefaults(key: keyof ServerSettingsPatch): boolean {
  const keys: ReadonlyArray<keyof ServerSettingsPatch> = PROJECT_DEFAULTS_KEYS;
  return keys.includes(key);
}

export function patchRequiresProjectDefaults(patch: ServerSettingsPatch): boolean {
  return PROJECT_DEFAULTS_KEYS.some((key) => patch[key] !== undefined);
}

/** Names the machines to update, or speaks about the one selected machine when `labels` is null. */
export function outdatedProjectDefaultsNotice(labels: ReadonlyArray<string> | null): string {
  return labels === null
    ? "Update this machine to change its default model, automatic pull, and actions."
    : `Update ${labels.join(", ")} to change the default model, automatic pull, and actions there. Workspace and browser access still apply.`;
}

export type ProjectScriptsWrite =
  | { readonly kind: "settings"; readonly patch: ServerSettingsPatch }
  | {
      readonly kind: "project";
      readonly projectId: ProjectId;
      readonly scripts: ReadonlyArray<ProjectScript>;
    }
  | { readonly kind: "unsupported" };

/**
 * Where a checkout's actions (or a machine's default actions, when `projectId`
 * is null) are saved. `nextScripts` null resets a checkout to the machine defaults.
 */
export function resolveProjectScriptsWrite(input: {
  readonly supportsProjectDefaults: boolean;
  readonly projectId: ProjectId | null;
  readonly nextScripts: ReadonlyArray<ProjectScript> | null;
}): ProjectScriptsWrite {
  if (input.supportsProjectDefaults) {
    return {
      kind: "settings",
      patch:
        input.projectId === null
          ? { defaultProjectScripts: input.nextScripts ?? [] }
          : { projectScriptOverrides: { [input.projectId]: input.nextScripts } },
    };
  }
  if (input.projectId === null) return { kind: "unsupported" };
  // Older servers keep actions on the project and have no machine defaults to inherit.
  return { kind: "project", projectId: input.projectId, scripts: input.nextScripts ?? [] };
}

export type ProjectOverrideWrite<Member> =
  | {
      readonly kind: "settings";
      readonly environmentId: EnvironmentId;
      readonly patch: ServerSettingsPatch;
    }
  | { readonly kind: "project"; readonly member: Member; readonly autoPull: boolean };

/**
 * Writes that set (or, for `undefined`, reset) a per-project boolean on every
 * checkout in a group. Older servers keep automatic pull on the project record
 * and cannot override browser access, so that plan is null.
 */
export function planProjectOverrideWrites<
  Member extends { readonly environmentId: EnvironmentId; readonly id: ProjectId },
>(input: {
  readonly key: "projectAgentBrowserAccessOverrides" | "projectAutoPullOverrides";
  readonly enabled: boolean | undefined;
  readonly members: ReadonlyArray<Member>;
  readonly supportsProjectDefaults: (environmentId: EnvironmentId) => boolean;
}): ReadonlyArray<ProjectOverrideWrite<Member>> | null {
  const autoPull = input.key === "projectAutoPullOverrides";
  const supported = input.members.filter((member) =>
    input.supportsProjectDefaults(member.environmentId),
  );
  if (!autoPull && supported.length < input.members.length) return null;
  const projectWrites = input.members.flatMap((member): ProjectOverrideWrite<Member>[] => {
    if (!autoPull) return [];
    if (!input.supportsProjectDefaults(member.environmentId)) {
      return [{ kind: "project", member, autoPull: input.enabled ?? false }];
    }
    // Resetting also clears an automatic pull opt-in saved before overrides existed.
    return input.enabled === undefined ? [{ kind: "project", member, autoPull: false }] : [];
  });
  const environmentIds = [...new Set(supported.map((member) => member.environmentId))];
  const settingsWrites = environmentIds.map((environmentId): ProjectOverrideWrite<Member> => ({
    kind: "settings",
    environmentId,
    patch: {
      [input.key]: Object.fromEntries(
        supported
          .filter((member) => member.environmentId === environmentId)
          .map((member) => [member.id, input.enabled ?? null]),
      ),
    },
  }));
  return [...projectWrites, ...settingsWrites];
}
