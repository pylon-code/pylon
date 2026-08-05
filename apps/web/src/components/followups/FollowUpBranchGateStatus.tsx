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

export type FollowUpBranchGatePresentation =
  | { readonly kind: "loading" }
  | { readonly kind: "clear" }
  | { readonly kind: "blocked"; readonly blockerCount: number }
  | { readonly kind: "unavailable"; readonly lastKnownBlockerCount: number | null };

export function resolveFollowUpBranchGatePresentation(input: {
  readonly failed: boolean;
  readonly synchronized: boolean;
  readonly blockerCount: number;
}): FollowUpBranchGatePresentation {
  if (input.failed) {
    return {
      kind: "unavailable",
      lastKnownBlockerCount: input.synchronized ? input.blockerCount : null,
    };
  }
  if (!input.synchronized) return { kind: "loading" };
  return input.blockerCount === 0
    ? { kind: "clear" }
    : { kind: "blocked", blockerCount: input.blockerCount };
}

export function FollowUpBranchGateUnavailable({
  branchRef,
  lastKnownBlockerCount,
}: {
  readonly branchRef: string;
  readonly lastKnownBlockerCount: number | null;
}) {
  const lastKnownLabel =
    lastKnownBlockerCount === null
      ? ""
      : `; last synchronized count was ${lastKnownBlockerCount} ${
          lastKnownBlockerCount === 1 ? "blocker" : "blockers"
        }`;
  const label = `Gate status unavailable for ${branchRef}${lastKnownLabel}`;

  return (
    <span
      aria-label={label}
      className="inline-flex shrink-0 items-center gap-0.5 rounded bg-warning/8 px-1 py-0.5 text-[11px] font-medium text-warning-foreground tabular-nums dark:bg-warning/16"
      data-testid="follow-up-branch-gate-unavailable"
      role="status"
      title={label}
    >
      <ShieldAlertIcon className="size-3" />
      <span>{lastKnownBlockerCount ?? "?"}</span>
    </span>
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
  const blockerCount = state.synchronized
    ? openFollowUpBlockersForBranch(state.snapshot.items, {
        projectId: projectRef.projectId,
        branchRef,
      }).length
    : 0;
  const presentation = resolveFollowUpBranchGatePresentation({
    failed: result._tag === "Failure",
    synchronized: state.synchronized,
    blockerCount,
  });

  switch (presentation.kind) {
    case "unavailable":
      return (
        <FollowUpBranchGateUnavailable
          branchRef={branchRef}
          lastKnownBlockerCount={presentation.lastKnownBlockerCount}
        />
      );
    case "blocked":
      return (
        <FollowUpBranchGateBadge branchRef={branchRef} blockerCount={presentation.blockerCount} />
      );
    case "loading":
    case "clear":
      return null;
  }
}
