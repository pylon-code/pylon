import { useAtomValue } from "@effect/atom-react";
import { EMPTY_FOLLOW_UP_CLIENT_STATE } from "@t3tools/client-runtime/state/followups";
import type { ScopedProjectRef } from "@t3tools/contracts";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { ShieldAlertIcon } from "lucide-react";

import { followUpEnvironment } from "~/state/followups";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { openFollowUpBlockersForBranch } from "./followUps.logic";

export function FollowUpBranchGateBadge({
  branchRef,
  blockerCount,
}: {
  readonly branchRef: string;
  readonly blockerCount: number;
}) {
  const label = `${branchRef} is blocked by ${blockerCount} unresolved follow-up ${
    blockerCount === 1 ? "blocker" : "blockers"
  }`;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={label}
            className="inline-flex shrink-0 items-center gap-0.5 rounded bg-destructive/8 px-1 py-0.5 text-[11px] font-medium text-destructive-foreground tabular-nums dark:bg-destructive/16"
            data-testid="follow-up-branch-gate-status"
            role="img"
          />
        }
      >
        <ShieldAlertIcon className="size-3" />
        <span>{blockerCount}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

export function FollowUpBranchGateStatus({
  branchRef,
  projectRef,
}: {
  readonly branchRef: string;
  readonly projectRef: ScopedProjectRef;
}) {
  const result = useAtomValue(
    followUpEnvironment.list({
      environmentId: projectRef.environmentId,
      input: { projectId: projectRef.projectId },
    }),
  );
  const state = AsyncResult.getOrElse(result, () => EMPTY_FOLLOW_UP_CLIENT_STATE);
  if (result._tag === "Failure" || !state.synchronized) return null;

  const blockers = openFollowUpBlockersForBranch(state.snapshot.items, {
    projectId: projectRef.projectId,
    branchRef,
  });
  if (blockers.length === 0) return null;

  return <FollowUpBranchGateBadge branchRef={branchRef} blockerCount={blockers.length} />;
}
