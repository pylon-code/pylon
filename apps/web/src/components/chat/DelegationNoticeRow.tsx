import {
  delegationNoticeHeadline,
  type DelegationNotice,
} from "@t3tools/client-runtime/state/delegation-notice";
import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { cn } from "~/lib/utils";

/**
 * Replaces the raw automatic wake message in the timeline: who finished or
 * needs the user, and a link to that thread.
 */
export function DelegationNoticeRow(props: {
  readonly notice: DelegationNotice;
  readonly environmentId: EnvironmentId;
}) {
  return (
    <div
      role="status"
      data-delegation-notice=""
      data-needs-user={props.notice.needsUser ? "true" : "false"}
      className={cn(
        "w-full rounded-lg border border-border/70 bg-muted/30 px-3 py-2 text-xs",
        props.notice.needsUser && "border-info/60",
      )}
    >
      <ul className="space-y-1.5">
        {props.notice.updates.map((update) => (
          <li
            key={update.threadId}
            data-delegation-notice-item=""
            className="flex flex-col gap-0.5"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-1.5">
                <span
                  aria-hidden
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    update.status === "error"
                      ? "bg-destructive"
                      : update.status === "completed"
                        ? "bg-success"
                        : update.status === "interrupted"
                          ? "bg-muted-foreground/60"
                          : "bg-info",
                  )}
                />
                <span className="font-medium text-foreground">
                  {delegationNoticeHeadline(update)}
                </span>
                <span className="truncate text-muted-foreground">{update.title}</span>
              </div>
              <Link
                to="/$environmentId/$threadId"
                params={{ environmentId: props.environmentId, threadId: update.threadId }}
                className="shrink-0 text-muted-foreground hover:text-foreground hover:underline"
              >
                Open
              </Link>
            </div>
            {update.reason !== null && <div className="text-destructive pl-3">{update.reason}</div>}
          </li>
        ))}
      </ul>
    </div>
  );
}
