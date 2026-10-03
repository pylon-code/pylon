import type { EnvironmentId, ThreadId, WorktreeSetupSnapshot } from "@t3tools/contracts";
import { resolveVisibleWorktreeSetup } from "@t3tools/client-runtime/worktree-setup";
import { useAtomValue } from "@effect/atom-react";
import { environmentServerConfigsAtom } from "../../state/server";
import { useEffect, useState } from "react";
import { useEnvironmentQuery } from "../../state/query";
import { vcsEnvironment } from "../../state/vcs";
import { resolveWorktreeSetupSnapshot } from "./worktree-setup-state";

/** Retain the last live snapshot when its subscription closes after setup. */
export function useWorktreeSetup(input: {
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
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
  const query = useEnvironmentQuery(
    supported &&
      input.environmentId &&
      input.threadId &&
      (live?.phase === "running" || (!live && input.preparing))
      ? vcsEnvironment.worktreeSetup({
          environmentId: input.environmentId,
          input: { threadId: input.threadId },
        })
      : null,
  );
  const snapshot = resolveWorktreeSetupSnapshot(input.threadId, query.data, live);
  useEffect(() => {
    if (snapshot && snapshot !== live) setHeld({ key, snapshot });
  }, [key, live, snapshot]);
  return {
    snapshot,
    visible: resolveVisibleWorktreeSetup({
      live: snapshot,
      recorded: null,
      turnStarted: input.turnStarted,
      followUpSent: input.followUpSent,
    }),
  };
}
