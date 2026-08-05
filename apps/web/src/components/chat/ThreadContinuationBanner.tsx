import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon, ArrowRightIcon } from "lucide-react";
import { memo } from "react";

import type { ThreadContinuationLink } from "./ThreadHandoff.logic";

/**
 * The seam between a thread and the one its work moved to.
 *
 * A handoff leaves two threads behind on purpose — the original stays open so
 * the user can come back to it — and neither reads correctly alone: the
 * continuation looks like it started mid-conversation, and the original looks
 * abandoned. One quiet line on each end is what makes the pair legible.
 */
export const ThreadContinuationBanner = memo(function ThreadContinuationBanner({
  links,
}: {
  readonly links: ReadonlyArray<ThreadContinuationLink>;
}) {
  if (links.length === 0) return null;

  return (
    <div className="flex flex-col gap-px border-b border-border/50 bg-muted/20">
      {links.map((link) => (
        <div
          key={`${link.direction}:${link.threadId}`}
          className="flex min-w-0 items-center gap-1.5 px-3 py-1 text-xs text-muted-foreground"
        >
          {link.direction === "from" ? (
            <ArrowLeftIcon className="size-3 shrink-0" />
          ) : (
            <ArrowRightIcon className="size-3 shrink-0" />
          )}
          <span className="shrink-0">
            {link.direction === "from" ? "Continues" : "Continued"}
            {link.accountName ? (
              <>
                {link.direction === "from" ? " work from " : " on "}
                {link.accentColor ? (
                  <span
                    aria-hidden="true"
                    className="mx-0.5 inline-block size-1.5 shrink-0 rounded-full align-middle"
                    style={{ backgroundColor: link.accentColor }}
                  />
                ) : null}
                {link.accountName}
                {link.direction === "from" ? "" : " in"}
              </>
            ) : link.direction === "from" ? (
              " work from"
            ) : (
              " in"
            )}
          </span>
          <Link
            to="/$environmentId/$threadId"
            params={{ environmentId: link.environmentId, threadId: link.threadId }}
            className="min-w-0 truncate underline underline-offset-2 hover:text-foreground"
          >
            {link.title}
          </Link>
        </div>
      ))}
    </div>
  );
});
