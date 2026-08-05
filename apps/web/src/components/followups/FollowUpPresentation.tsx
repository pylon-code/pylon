import type {
  EnvironmentId,
  FollowUp,
  FollowUpResolution,
  FollowUpValidation,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import {
  GitCommitHorizontalIcon,
  MessageSquareIcon,
  MessageSquarePlusIcon,
  RotateCcwIcon,
  ScanSearchIcon,
} from "lucide-react";

import { Button } from "../ui/button";

export function FollowUpPrimaryAction({
  status,
  busy,
  onStartThread,
  onReopen,
}: {
  readonly status: FollowUp["status"];
  readonly busy: boolean;
  readonly onStartThread: () => void;
  readonly onReopen: () => void;
}) {
  if (status === "open") {
    return (
      <Button
        aria-busy={busy || undefined}
        disabled={busy}
        onClick={onStartThread}
        size="sm"
        variant="outline"
      >
        <MessageSquarePlusIcon />
        {busy ? "Starting…" : "Start thread"}
      </Button>
    );
  }

  return (
    <Button
      aria-busy={busy || undefined}
      disabled={busy}
      onClick={onReopen}
      size="sm"
      variant="outline"
    >
      <RotateCcwIcon />
      {busy ? "Reopening…" : "Reopen"}
    </Button>
  );
}

export function FollowUpResolutionDetails({
  environmentId,
  resolution,
}: {
  readonly environmentId: EnvironmentId;
  readonly resolution: FollowUpResolution;
}) {
  const commitSha = resolution.commitSha?.trim() ?? "";

  return (
    <div className="mt-3 rounded-md border border-border/55 bg-background/45 px-2.5 py-2">
      <p className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
        Resolution
      </p>
      <p className="mt-0.5 whitespace-pre-wrap break-words text-xs leading-4 text-foreground/90">
        {resolution.note}
      </p>
      {resolution.threadId || commitSha.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          {resolution.threadId ? (
            <Button
              className="h-auto px-0 py-1 text-xs"
              render={
                <Link
                  params={{ environmentId, threadId: resolution.threadId }}
                  to="/$environmentId/$threadId"
                />
              }
              size="xs"
              variant="link"
            >
              <MessageSquareIcon />
              Open resolution thread
            </Button>
          ) : null}
          {commitSha.length > 0 ? (
            <span
              aria-label={`Resolution commit ${commitSha}`}
              className="inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground"
              title={commitSha}
            >
              <GitCommitHorizontalIcon className="size-3.5" />
              <span aria-hidden>{commitSha.slice(0, 10)}</span>
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const VALIDATION_LABELS: Readonly<Record<FollowUpValidation["outcome"], string>> = {
  "still-needed": "Still needed",
  moot: "Moot",
  uncertain: "Uncertain",
};

export function FollowUpValidationDetails({
  environmentId,
  validation,
}: {
  readonly environmentId: EnvironmentId;
  readonly validation: FollowUpValidation;
}) {
  return (
    <div className="mt-3 rounded-md border border-border/55 bg-background/45 px-2.5 py-2">
      <p className="flex items-center gap-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
        <ScanSearchIcon className="size-3" />
        Last validation · {VALIDATION_LABELS[validation.outcome]}
      </p>
      <p className="mt-0.5 whitespace-pre-wrap break-words text-xs leading-4 text-foreground/90">
        {validation.note}
      </p>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <Button
          className="h-auto px-0 py-1 text-xs"
          render={
            <Link
              params={{ environmentId, threadId: validation.threadId }}
              to="/$environmentId/$threadId"
            />
          }
          size="xs"
          variant="link"
        >
          <MessageSquareIcon />
          Open validation thread
        </Button>
        <span className="text-muted-foreground">
          {validation.evidence.length} evidence{" "}
          {validation.evidence.length === 1 ? "entry" : "entries"}
        </span>
        {validation.checkedCommitSha ? (
          <span className="inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground">
            <GitCommitHorizontalIcon className="size-3.5" />
            {validation.checkedCommitSha.slice(0, 10)}
          </span>
        ) : null}
      </div>
    </div>
  );
}
