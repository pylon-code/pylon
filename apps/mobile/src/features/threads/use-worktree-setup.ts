import type { EnvironmentId, ThreadId, WorktreeSetupSnapshot } from "@t3tools/contracts";
import {
  findRecordedWorktreeSetup,
  resolveVisibleWorktreeSetup,
} from "@t3tools/client-runtime/worktree-setup";
import { useAtomValue } from "@effect/atom-react";
import { environmentServerConfigsAtom } from "../../state/server";
import { useEffect, useState } from "react";
import { useEnvironmentQuery } from "../../state/query";
import { vcsEnvironment } from "../../state/vcs";

/** Retain the last live snapshot when its subscription closes after setup. */
export function useWorktreeSetup(input: {
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
  activities: ReadonlyArray<{ kind: string; payload: unknown }>;
  preparing: boolean;
  turnStarted: boolean;
  followUpSent: boolean;
}) {
  const configs = useAtomValue(environmentServerConfigsAtom);
  const supported =
    input.environmentId !== null &&
    configs.get(input.environmentId)?.environment.capabilities.worktreeSetupTracking === true;
  const key = JSON.stringify([input.environmentId, input.threadId]);
  const [held, setHeld] = useState<{ key: string; snapshot: WorktreeSetupSnapshot } | null>(null);
  const live = held?.key === key ? held.snapshot : null;
  const recorded = input.threadId
    ? findRecordedWorktreeSetup(input.activities, input.threadId)
    : null;
  const latest = resolveVisibleWorktreeSetup({
    live,
    recorded,
    turnStarted: false,
    followUpSent: false,
  });
  const query = useEnvironmentQuery(
    supported &&
      input.environmentId &&
      input.threadId &&
      (latest?.phase === "running" || (!latest && input.preparing))
      ? vcsEnvironment.worktreeSetup({
          environmentId: input.environmentId,
          input: { threadId: input.threadId },
        })
      : null,
  );
  useEffect(() => {
    if (query.data?.threadId === input.threadId) setHeld({ key, snapshot: query.data });
  }, [key, input.threadId, query.data]);
  return resolveVisibleWorktreeSetup({
    live: query.data ?? live,
    recorded,
    turnStarted: input.turnStarted,
    followUpSent: input.followUpSent,
  });
}
