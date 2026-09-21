import { RefreshIcon } from "~/components/ui/refresh-icon";
import { ExternalLinkIcon } from "lucide-react";

import { Button } from "../ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { PullRequestGlyph } from "./pullRequestIcons";

export interface PullRequestExternalLink {
  readonly url: string;
  readonly label?: string;
}

export function PullRequestsUnavailableState({
  title = "Could not load pull requests",
  error,
  onRetry,
  refreshing = false,
  gitHubUrl,
  externalLink,
}: {
  title?: string;
  error: string;
  onRetry?: () => void;
  refreshing?: boolean;
  gitHubUrl?: string;
  externalLink?: PullRequestExternalLink | null;
}) {
  const link = externalLink ?? (gitHubUrl ? { url: gitHubUrl, label: "Open on GitHub" } : null);

  return (
    <Empty className="min-h-0 justify-center-safe overflow-y-auto px-4 py-16 md:px-4 [&>*]:shrink-0">
      <EmptyMedia variant="icon">
        <PullRequestGlyph.pullRequest />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        {/* The caller names the fix — update the environment, install gh, sign in — so this
            shows its message rather than trying to infer one from the failure text. */}
        <EmptyDescription>{error}</EmptyDescription>
      </EmptyHeader>
      {onRetry || link ? (
        <EmptyContent className="flex-row flex-wrap justify-center gap-2">
          {onRetry ? (
            <Button
              size="sm"
              variant="outline"
              onClick={onRetry}
              disabled={refreshing}
              aria-busy={refreshing}
            >
              <RefreshIcon className="size-3.5" refreshing={refreshing} />
              Retry
            </Button>
          ) : null}
          {link ? (
            <Button
              size="sm"
              variant="outline"
              render={<a href={link.url} target="_blank" rel="noopener noreferrer" />}
            >
              <ExternalLinkIcon aria-hidden className="size-3.5" />
              {link.label ?? "Open in browser"}
            </Button>
          ) : null}
        </EmptyContent>
      ) : null}
    </Empty>
  );
}
