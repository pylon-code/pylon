import { describe, expect, it } from "vite-plus/test";
import type {
  ProjectCloneListEvent,
  ProjectId,
  SourceControlDiscoveryResult,
  VcsStatusLocalResult,
  VcsStatusResult,
} from "@t3tools/contracts";
import { SourceControlRepositoryError } from "@t3tools/contracts";
import * as Option from "effect/Option";

import {
  projectCloneListForClient,
  repositoryMetadataForClient,
  sourceControlErrorForClient,
  sourceControlDiscoveryForClient,
  vcsStatusEventForClient,
  vcsStatusForClient,
} from "./forgejoClientCompatibility.ts";

const local: VcsStatusLocalResult = {
  isRepo: true,
  sourceControlProvider: { kind: "forgejo", name: "Forgejo", baseUrl: "https://code.example" },
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feature",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
};
const remote = { hasUpstream: true, aheadCount: 0, behindCount: 0, pr: null };

describe("Forgejo compatibility for older clients", () => {
  it("omits only Forgejo discovery rows for clients without the capability", () => {
    const result: SourceControlDiscoveryResult = {
      versionControlSystems: [],
      sourceControlProviders: [
        {
          kind: "forgejo",
          label: "Forgejo",
          status: "available",
          version: Option.none(),
          installHint: "Install tea",
          detail: Option.none(),
          auth: {
            status: "unauthenticated",
            account: Option.none(),
            host: Option.none(),
            detail: Option.none(),
          },
        },
      ],
    };
    expect(sourceControlDiscoveryForClient(result, false).sourceControlProviders).toEqual([]);
    expect(sourceControlDiscoveryForClient(result, true)).toBe(result);
  });

  it("keeps Git status and remote updates while hiding unsupported provider metadata", () => {
    const full: VcsStatusResult = { ...local, ...remote };
    expect(vcsStatusForClient(full, false)).toEqual({
      ...remote,
      isRepo: true,
      hasPrimaryRemote: true,
      isDefaultRef: false,
      refName: "feature",
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
    });
    expect(vcsStatusForClient(full, true)).toBe(full);
    for (const tag of ["snapshot", "localUpdated"] as const) {
      const event = tag === "snapshot" ? { _tag: tag, local, remote } : { _tag: tag, local };
      const compatible = vcsStatusEventForClient(event, false);
      expect(compatible._tag).toBe(tag);
      if (compatible._tag === "snapshot" || compatible._tag === "localUpdated") {
        expect(compatible.local.sourceControlProvider).toBeUndefined();
      }
      expect(vcsStatusEventForClient(event, true)).toBe(event);
    }
    const remoteEvent = { _tag: "remoteUpdated" as const, remote };
    expect(vcsStatusEventForClient(remoteEvent, false)).toBe(remoteEvent);
  });

  it("keeps clone progress and success while omitting optional Forgejo repository metadata", () => {
    const repository = {
      provider: "forgejo" as const,
      nameWithOwner: "team/app",
      url: "https://code.example/team/app",
      sshUrl: "git@code.example:team/app.git",
    };
    expect(repositoryMetadataForClient(repository, false)).toBeNull();
    expect(repositoryMetadataForClient(repository, true)).toBe(repository);
    const snapshots: ProjectCloneListEvent = [
      {
        projectId: "project-1" as ProjectId,
        remoteUrl: "https://code.example/team/app.git",
        destinationPath: "/tmp/app",
        repository,
        phase: "running",
        stage: "connecting",
        percent: null,
        detail: null,
        error: null,
        startedAt: "2026-09-24T00:00:00Z",
        endedAt: null,
        sequence: 1,
      },
    ];
    expect(projectCloneListForClient(snapshots, false)[0]).toEqual({
      ...snapshots[0],
      repository: null,
    });
    expect(projectCloneListForClient(snapshots, true)).toBe(snapshots);
    const error = new SourceControlRepositoryError({
      provider: "forgejo",
      operation: "cloneRepository",
      detail: "secret host body",
    });
    const compatible = sourceControlErrorForClient(error, false);
    expect(compatible.provider).toBe("unknown");
    expect(compatible.detail).not.toContain("secret host body");
  });
});
