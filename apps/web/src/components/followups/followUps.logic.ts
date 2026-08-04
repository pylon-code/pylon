import type { FollowUp, FollowUpKind } from "@t3tools/contracts";

export const FOLLOW_UP_KIND_LABELS: Readonly<Record<FollowUpKind, string>> = {
  blocker: "Blockers",
  open: "Open",
  idea: "Ideas",
};

export const FOLLOW_UP_DEFER_REASON_LABELS: Readonly<Record<FollowUp["deferReason"], string>> = {
  "out-of-scope": "Out of scope",
  "needs-decision": "Needs a decision",
  "blocked-externally": "Blocked externally",
  idea: "Idea",
};

export interface GroupedFollowUps {
  readonly blocker: ReadonlyArray<FollowUp>;
  readonly open: ReadonlyArray<FollowUp>;
  readonly idea: ReadonlyArray<FollowUp>;
  readonly closed: ReadonlyArray<FollowUp>;
}

export function groupFollowUps(items: ReadonlyArray<FollowUp>): GroupedFollowUps {
  const grouped: Record<"blocker" | "open" | "idea" | "closed", FollowUp[]> = {
    blocker: [],
    open: [],
    idea: [],
    closed: [],
  };
  for (const item of items) {
    if (item.status === "open") grouped[item.kind].push(item);
    else grouped.closed.push(item);
  }
  const newestFirst = (left: FollowUp, right: FollowUp) =>
    right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id);
  grouped.blocker.sort(newestFirst);
  grouped.open.sort(newestFirst);
  grouped.idea.sort(newestFirst);
  grouped.closed.sort(newestFirst);
  return grouped;
}
