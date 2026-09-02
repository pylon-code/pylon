import { AlertTriangleIcon } from "lucide-react";
import { memo } from "react";

import { Button } from "../ui/button";

export const ProviderBindingConflictNotice = memo(function ProviderBindingConflictNotice(props: {
  readonly originalProviderName: string;
  readonly boundProviderName: string;
  readonly canContinueOnBoundProvider: boolean;
  readonly isStartingNewThread: boolean;
  readonly onContinueOnBoundProvider: () => void;
  readonly onStartNewThread: () => void;
}) {
  return (
    <div
      role="alert"
      data-composer-provider-binding-conflict="true"
      className="mx-3 mb-2 flex flex-col gap-2 rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm sm:mx-4"
    >
      <div className="flex items-start gap-2">
        <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-warning" />
        <div className="flex min-w-0 flex-col gap-1">
          <span className="font-medium">Choose where to keep this unsent message</span>
          <span className="text-muted-foreground">
            This draft targets {props.originalProviderName}, but another client bound the thread to{" "}
            {props.boundProviderName}. Nothing will be retargeted until you choose.
          </span>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 ps-6">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!props.canContinueOnBoundProvider || props.isStartingNewThread}
          onClick={props.onContinueOnBoundProvider}
        >
          Continue on {props.boundProviderName}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={props.isStartingNewThread}
          onClick={props.onStartNewThread}
        >
          {props.isStartingNewThread
            ? "Opening new thread…"
            : `Start new thread on ${props.originalProviderName}`}
        </Button>
      </div>
      {!props.canContinueOnBoundProvider ? (
        <span className="ps-6 text-xs text-muted-foreground">
          The bound account settings are still syncing. Starting a new thread keeps the original
          selection now.
        </span>
      ) : null}
    </div>
  );
});
