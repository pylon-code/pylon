import type {
  ProjectCloneListEvent,
  SourceControlRepositoryInfo,
  SourceControlDiscoveryResult,
  VcsStatusLocalResult,
  VcsStatusResult,
  VcsStatusStreamEvent,
} from "@t3tools/contracts";
import { SourceControlRepositoryError } from "@t3tools/contracts";

/** Keep older clients' strict provider-kind decoders usable for existing hosts. */
export function sourceControlDiscoveryForClient(
  result: SourceControlDiscoveryResult,
  supportsForgejo: boolean,
): SourceControlDiscoveryResult {
  return supportsForgejo
    ? result
    : {
        ...result,
        sourceControlProviders: result.sourceControlProviders.filter(
          (provider) => provider.kind !== "forgejo",
        ),
      };
}

function statusLocalForClient<T extends VcsStatusLocalResult>(
  local: T,
  supportsForgejo: boolean,
): T {
  if (supportsForgejo || local.sourceControlProvider?.kind !== "forgejo") return local;
  const { sourceControlProvider: _unsupported, ...compatible } = local;
  return compatible as T;
}

export function vcsStatusForClient(
  status: VcsStatusResult,
  supportsForgejo: boolean,
): VcsStatusResult {
  return statusLocalForClient(status, supportsForgejo);
}

export function vcsStatusEventForClient(
  event: VcsStatusStreamEvent,
  supportsForgejo: boolean,
): VcsStatusStreamEvent {
  if (supportsForgejo) return event;
  switch (event._tag) {
    case "snapshot":
    case "localUpdated":
      return { ...event, local: statusLocalForClient(event.local, supportsForgejo) };
    case "remoteUpdated":
      return event;
  }
}

/** A clone remains successful for older clients; only its optional host metadata is hidden. */
export function repositoryMetadataForClient(
  repository: SourceControlRepositoryInfo | null,
  supportsForgejo: boolean,
): SourceControlRepositoryInfo | null {
  return !supportsForgejo && repository?.provider === "forgejo" ? null : repository;
}

export function projectCloneListForClient(
  snapshots: ProjectCloneListEvent,
  supportsForgejo: boolean,
): ProjectCloneListEvent {
  if (supportsForgejo) return snapshots;
  return snapshots.map((snapshot) => ({
    ...snapshot,
    repository: repositoryMetadataForClient(snapshot.repository, false),
  }));
}

export function sourceControlErrorForClient(
  error: SourceControlRepositoryError,
  supportsForgejo: boolean,
): SourceControlRepositoryError {
  if (supportsForgejo || error.provider !== "forgejo") return error;
  return new SourceControlRepositoryError({
    provider: "unknown",
    operation: error.operation,
    detail: "This source control provider requires a newer client.",
  });
}
