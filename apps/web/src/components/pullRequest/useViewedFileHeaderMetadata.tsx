import type { CodeViewItem } from "@pierre/diffs";
import type { PullRequestOmittedFileStat } from "@t3tools/contracts";
import { useCallback } from "react";

import { resolveFileDiffPath } from "~/lib/diffRendering";

import { Checkbox } from "../ui/checkbox";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PullRequestDiffStat } from "./pullRequestPresentation";
import type { PullRequestFilesViewedView } from "./usePullRequestFilesViewed";

/** The callback identity is part of Pierre's portal cache key. Its displayed answer is a
 * dependency so a committed account/read change redraws the checkbox immediately. */
export function useViewedFileHeaderMetadata<T>(
  filesViewed: PullRequestFilesViewedView,
  omittedFileStats: ReadonlyMap<string, PullRequestOmittedFileStat>,
  setFileViewed: (fileKey: string, path: string, viewed: boolean) => void,
) {
  return useCallback(
    (item: CodeViewItem<T>) => {
      if (item.type !== "diff") return null;
      let additions = 0;
      let deletions = 0;
      for (const hunk of item.fileDiff.hunks) {
        additions += hunk.additionLines;
        deletions += hunk.deletionLines;
      }
      const path = resolveFileDiffPath(item.fileDiff);
      if (additions === 0 && deletions === 0) {
        const withheld = omittedFileStats.get(path);
        if (withheld) ({ additions, deletions } = withheld);
      }
      const stat = (
        <PullRequestDiffStat
          additions={additions}
          deletions={deletions}
          className="font-mono text-[11px]"
        />
      );
      if (!filesViewed.enabled || !filesViewed.isTrackable(path)) return stat;
      const viewed = filesViewed.isViewed(path);
      const stale = filesViewed.isStale(path);
      return (
        <span className="flex items-center gap-3">
          {stat}
          <label
            data-viewed-toggle=""
            className="flex cursor-pointer select-none items-center gap-1.5 text-[11px] text-muted-foreground"
            onClick={(event) => event.stopPropagation()}
          >
            <Checkbox
              aria-label={stale ? "Changed" : "Viewed"}
              checked={viewed}
              onCheckedChange={(next) => setFileViewed(item.id, path, next === true)}
            />
            {stale ? (
              <Tooltip>
                <TooltipTrigger render={<span className="text-amber-600 dark:text-amber-500" />}>
                  Changed
                </TooltipTrigger>
                <TooltipPopup side="bottom">
                  This file has been pushed to since you marked it viewed.
                </TooltipPopup>
              </Tooltip>
            ) : (
              "Viewed"
            )}
          </label>
        </span>
      );
    },
    [filesViewed, omittedFileStats, setFileViewed],
  );
}
