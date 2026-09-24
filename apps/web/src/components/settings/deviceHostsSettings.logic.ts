import type { EnvironmentId, SshDeviceHostConfig } from "@t3tools/contracts";

/** A host ID may differ between environments; a destination is the shared identity. */
function sameDestination(a: SshDeviceHostConfig, b: SshDeviceHostConfig): boolean {
  return a.target === b.target && a.port === b.port;
}

export function updateDeviceHosts(
  hosts: ReadonlyArray<SshDeviceHostConfig>,
  host: SshDeviceHostConfig,
  original: SshDeviceHostConfig | null,
  remove: boolean,
  identityFileChanged: boolean,
): ReadonlyArray<SshDeviceHostConfig> {
  const destination = original ?? host;
  const byId = hosts.find((candidate) => candidate.id === destination.id);
  const matches = hosts.filter((candidate) => sameDestination(candidate, destination));
  if (matches.length > 1) {
    throw new Error(
      "Multiple device hosts use this destination; select one environment to edit it.",
    );
  }
  const existing = byId && sameDestination(byId, destination) ? byId : matches[0];
  if (remove) return existing ? hosts.filter((candidate) => candidate.id !== existing.id) : hosts;
  if (existing === undefined) {
    const newMatches = hosts.filter((candidate) => sameDestination(candidate, host));
    if (newMatches.length > 1) {
      throw new Error(
        "Multiple device hosts use this destination; select one environment to edit it.",
      );
    }
    // A prior target may already have saved while another failed. Only accept the same requested
    // host on retry; a different host at its destination must not be silently overwritten.
    if (
      newMatches.length === 1 &&
      newMatches[0]?.label === host.label &&
      (byId === undefined || byId === newMatches[0])
    )
      return hosts;
    if (byId !== undefined || newMatches.length > 0) {
      throw new Error("A different device host already uses this ID or destination.");
    }
    const added = identityFileChanged ? host : { ...host, identityFile: undefined };
    return [...hosts, added];
  }
  const identityFile = identityFileChanged ? host.identityFile : existing.identityFile;
  const replacement: SshDeviceHostConfig = {
    ...host,
    id: existing.id,
    ...(identityFile === undefined ? {} : { identityFile }),
  };
  return hosts.map((candidate) => (candidate.id === existing.id ? replacement : candidate));
}

/** Plan each selected environment independently; never copy a representative settings list. */
export function planDeviceHostUpdates(
  targets: ReadonlyArray<{
    environmentId: EnvironmentId;
    label: string;
    connected: boolean;
    hosts: ReadonlyArray<SshDeviceHostConfig> | null;
  }>,
  host: SshDeviceHostConfig,
  original: SshDeviceHostConfig | null,
  remove: boolean,
  identityFileEdited: boolean,
) {
  const writes: Array<{
    environmentId: EnvironmentId;
    label: string;
    hosts: ReadonlyArray<SshDeviceHostConfig>;
  }> = [];
  const failed: string[] = [];
  for (const target of targets) {
    if (!target.connected || target.hosts === null) {
      failed.push(target.label);
      continue;
    }
    try {
      const next = updateDeviceHosts(target.hosts, host, original, remove, identityFileEdited);
      if (next === target.hosts) continue;
      writes.push({
        environmentId: target.environmentId,
        label: target.label,
        hosts: next,
      });
    } catch {
      failed.push(target.label);
    }
  }
  return { writes, failed };
}
