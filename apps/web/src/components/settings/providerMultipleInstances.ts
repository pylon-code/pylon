import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  resolveProviderInstanceEnabled,
  type ProviderInstanceConfig,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";

export const PRIME_AGENT_INSTANCE_GUIDANCE =
  "Use a distinct, non-nested Agent home for this instance, then sign in separately inside that home. Credentials, settings, model catalogs, sessions, sockets, checkpoints, and MCP state stay with that instance.";
export const PRIME_AGENT_ACP_GUIDANCE =
  "ACP compatibility is selected only for this instance when native attach proof is unavailable. It does not enable multiple Prime instances on this server.";
export const PRIME_AGENT_MAINTENANCE_GUIDANCE =
  "Pylon manages per-instance Prime processes only. OS-user-global Prime update, doctor, shutdown, and stop-all maintenance remains external and is never run for an instance.";

export function getDriverMultipleInstancePresentation(input: {
  readonly driver: string;
  readonly providers: ReadonlyArray<ServerProvider>;
}): { readonly supported: boolean; readonly reason: string | null } {
  const snapshots = input.providers.filter((provider) => provider.driver === input.driver);
  const supported = snapshots.some((provider) => provider.supportsMultipleInstances === true);
  const reason =
    snapshots.find((provider) => provider.multipleInstancesUnavailableReason)
      ?.multipleInstancesUnavailableReason ??
    snapshots.find((provider) => provider.unavailableReason)?.unavailableReason ??
    (supported
      ? null
      : `This server has not proved that ${input.driver} supports multiple enabled instances.`);
  return { supported, reason };
}

export function countEnabledConfiguredInstances(
  settings: Pick<ServerSettings, "providerInstances" | "providers">,
  driver: string,
): number {
  let count = 0;
  const defaultId = defaultInstanceIdForDriver(ProviderDriverKind.make(driver));
  let hasExplicitDefault = false;
  for (const [instanceId, instance] of Object.entries(settings.providerInstances)) {
    if (instance.driver !== driver) continue;
    if (instanceId === defaultId) hasExplicitDefault = true;
    if (resolveProviderInstanceEnabled(instance)) count += 1;
  }
  const legacy = settings.providers[driver as keyof ServerSettings["providers"]];
  if (!hasExplicitDefault && legacy?.enabled === true) count += 1;
  return count;
}

function configuredHome(instance: ProviderInstanceConfig): string {
  if (
    instance.config === null ||
    typeof instance.config !== "object" ||
    Array.isArray(instance.config)
  ) {
    return "";
  }
  const value = (instance.config as { readonly agentHomePath?: unknown }).agentHomePath;
  return typeof value === "string" ? value.trim() : "";
}

function normalizeKnownHome(value: string): string | null {
  const trimmed = value.trim().replaceAll("\\", "/").replace(/\/+$/u, "");
  if (trimmed.length === 0) return "~/.prime/agent";
  if (!(trimmed.startsWith("/") || trimmed === "~" || trimmed.startsWith("~/"))) return null;
  const segments: string[] = [];
  for (const segment of trimmed.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0 || segments.at(-1) === "~") return null;
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return `${trimmed.startsWith("/") ? "/" : ""}${segments.join("/")}`;
}

function knownHomesOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/** Browser-side early check only. The host server remains canonical/symlink authority. */
export function validatePrimeAgentAddHome(input: {
  readonly draftConfig: Readonly<Record<string, unknown>>;
  readonly settings: Pick<ServerSettings, "providerInstances" | "providers">;
}): string | null {
  const draft = input.draftConfig.agentHomePath;
  const draftHome = normalizeKnownHome(typeof draft === "string" ? draft : "");
  if (draftHome === null || draftHome === "~/.prime/agent") {
    return `An additional Prime Agent instance needs an explicit absolute or ~/ Agent home that differs from the default. ${PRIME_AGENT_INSTANCE_GUIDANCE}`;
  }

  const existing: string[] = [];
  const explicitDefault =
    input.settings.providerInstances[
      defaultInstanceIdForDriver(ProviderDriverKind.make("primeAgent"))
    ];
  if (explicitDefault === undefined && input.settings.providers.primeAgent.enabled) {
    existing.push(
      normalizeKnownHome(input.settings.providers.primeAgent.agentHomePath) ?? "~/.prime/agent",
    );
  }
  for (const instance of Object.values(input.settings.providerInstances)) {
    if (instance.driver !== "primeAgent" || !resolveProviderInstanceEnabled(instance)) continue;
    const home = normalizeKnownHome(configuredHome(instance));
    if (home !== null) existing.push(home);
  }
  return existing.some((home) => knownHomesOverlap(home, draftHome))
    ? `This Agent home is equal to or nested inside another enabled Prime Agent home. ${PRIME_AGENT_INSTANCE_GUIDANCE}`
    : null;
}
