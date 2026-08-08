import {
  SESSION_INTERACTION_CONTENT_MAX_CHARS,
  type SessionInteractionResponse,
  type SessionWidgetPlacement,
} from "@t3tools/contracts";
import { memo, useState } from "react";
import { AlertCircleIcon, InfoIcon, TriangleAlertIcon } from "lucide-react";

import type {
  PendingSessionInteraction,
  SessionNotificationActivity,
  SessionStatusPresentation,
  SessionWidgetPresentation,
} from "../../sessionInteraction";
import { cn } from "~/lib/utils";

export interface SessionInteractionSubmissionState {
  readonly requestId: string;
  readonly status: "submitting" | "submitted" | "error";
  readonly response: SessionInteractionResponse;
  readonly ignoredFailureActivityId?: string;
  readonly error?: string;
}

interface ComposerSessionInteractionPanelProps {
  readonly interaction: PendingSessionInteraction | null;
  readonly pendingCount: number;
  readonly submission: SessionInteractionSubmissionState | null;
  readonly activityError: string | null;
  readonly otherSubmissionInFlight: boolean;
  readonly onRespond: (response: SessionInteractionResponse) => void;
}

const controlClass =
  "rounded-lg border border-border/65 bg-background/70 px-3 py-2 text-sm text-foreground outline-none transition-colors hover:bg-accent/45 focus-visible:ring-2 focus-visible:ring-ring/70 disabled:cursor-not-allowed disabled:opacity-50";
const primaryControlClass =
  "rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring/70 disabled:cursor-not-allowed disabled:opacity-50";

function withOccurrenceKeys(values: ReadonlyArray<string>) {
  const occurrences = new Map<string, number>();
  let first = true;
  return values.map((value) => {
    const occurrence = occurrences.get(value) ?? 0;
    occurrences.set(value, occurrence + 1);
    const keyedValue = { value, key: `${value}:${occurrence}`, first };
    first = false;
    return keyedValue;
  });
}

export const ComposerSessionInteractionPanel = memo(function ComposerSessionInteractionPanel({
  interaction,
  pendingCount,
  submission,
  activityError,
  otherSubmissionInFlight,
  onRespond,
}: ComposerSessionInteractionPanelProps) {
  if (interaction === null) return null;
  return (
    <SessionInteractionCard
      key={interaction.requestId}
      interaction={interaction}
      pendingCount={pendingCount}
      submission={submission?.requestId === interaction.requestId ? submission : null}
      activityError={activityError}
      disabled={otherSubmissionInFlight}
      onRespond={onRespond}
    />
  );
});

const SessionInteractionCard = memo(function SessionInteractionCard(props: {
  readonly interaction: PendingSessionInteraction;
  readonly pendingCount: number;
  readonly submission: SessionInteractionSubmissionState | null;
  readonly activityError: string | null;
  readonly disabled: boolean;
  readonly onRespond: (response: SessionInteractionResponse) => void;
}) {
  const { interaction, pendingCount, submission, activityError, onRespond } = props;
  const [value, setValue] = useState(
    interaction.request.kind === "editor" ? (interaction.request.prefill ?? "") : "",
  );
  const controlsDisabled =
    props.disabled || submission?.status === "submitting" || submission?.status === "submitted";
  const titleId = `session-interaction-${interaction.activityId}`;
  const responseLabel = submission?.status === "submitted" ? "Response sent" : null;

  const cancelButton = (
    <button
      type="button"
      className={controlClass}
      disabled={controlsDisabled}
      aria-label={`Cancel ${interaction.request.title}`}
      onClick={() => onRespond({ kind: "cancelled" })}
    >
      Cancel
    </button>
  );

  return (
    <section
      className="border-b border-border/65 bg-muted/20 px-4 py-3 sm:px-5"
      aria-labelledby={titleId}
      data-session-interaction-kind={interaction.request.kind}
    >
      <div className="mb-3 flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-secondary-label text-[11px] font-semibold tracking-widest uppercase">
            Session request
          </p>
          <h2
            id={titleId}
            className="mt-1 max-h-28 overflow-y-auto whitespace-pre-wrap break-words text-sm font-medium text-foreground"
          >
            {interaction.request.title}
          </h2>
        </div>
        {pendingCount > 1 ? (
          <span className="shrink-0 rounded-md bg-muted/60 px-1.5 py-0.5 text-secondary-label text-[10px] tabular-nums">
            1/{pendingCount}
          </span>
        ) : null}
      </div>

      {interaction.request.kind === "select" ? (
        <div className="space-y-2" role="group" aria-label={interaction.request.title}>
          <div className="max-h-48 space-y-1.5 overflow-y-auto pr-1">
            {withOccurrenceKeys(interaction.request.options).map(
              ({ first, key, value: option }) => (
                <button
                  key={key}
                  type="button"
                  className={`${controlClass} w-full whitespace-pre-wrap break-words text-left`}
                  disabled={controlsDisabled}
                  autoFocus={first}
                  aria-label={`Select ${option}`}
                  onClick={() => onRespond({ kind: "selected", value: option })}
                >
                  {option}
                </button>
              ),
            )}
          </div>
          <div className="flex justify-end">{cancelButton}</div>
        </div>
      ) : interaction.request.kind === "confirm" ? (
        <div>
          {interaction.request.message !== undefined ? (
            <p className="mb-3 max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-secondary-label text-sm">
              {interaction.request.message}
            </p>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2" role="group" aria-label="Confirmation">
            {cancelButton}
            <button
              type="button"
              className={controlClass}
              disabled={controlsDisabled}
              autoFocus
              aria-label="No"
              onClick={() => onRespond({ kind: "confirmed", confirmed: false })}
            >
              No
            </button>
            <button
              type="button"
              className={primaryControlClass}
              disabled={controlsDisabled}
              aria-label="Yes"
              onClick={() => onRespond({ kind: "confirmed", confirmed: true })}
            >
              Yes
            </button>
          </div>
        </div>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onRespond({ kind: "submitted", value });
          }}
        >
          {interaction.request.kind === "input" ? (
            <input
              type="text"
              className={`${controlClass} w-full`}
              value={value}
              placeholder={interaction.request.placeholder}
              disabled={controlsDisabled}
              maxLength={SESSION_INTERACTION_CONTENT_MAX_CHARS}
              autoFocus
              aria-label={interaction.request.title}
              onChange={(event) =>
                setValue(event.currentTarget.value.slice(0, SESSION_INTERACTION_CONTENT_MAX_CHARS))
              }
            />
          ) : (
            <textarea
              className={`${controlClass} max-h-56 min-h-28 w-full resize-y whitespace-pre-wrap`}
              value={value}
              disabled={controlsDisabled}
              maxLength={SESSION_INTERACTION_CONTENT_MAX_CHARS}
              autoFocus
              aria-label={interaction.request.title}
              onChange={(event) =>
                setValue(event.currentTarget.value.slice(0, SESSION_INTERACTION_CONTENT_MAX_CHARS))
              }
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.currentTarget.form?.requestSubmit();
                }
              }}
            />
          )}
          <div className="mt-2 flex justify-end gap-2">
            {cancelButton}
            <button type="submit" className={primaryControlClass} disabled={controlsDisabled}>
              Submit
            </button>
          </div>
        </form>
      )}

      {responseLabel ? (
        <p className="mt-2 text-right text-secondary-label text-xs" role="status">
          {responseLabel}
        </p>
      ) : null}
      {submission === null && activityError !== null ? (
        <p className="mt-3 break-words text-destructive text-xs" role="alert">
          {activityError}
        </p>
      ) : null}
      {submission?.status === "error" ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2" role="alert">
          <p className="min-w-0 break-words text-destructive text-xs">
            {submission.error ?? "Failed to send the response."}
          </p>
          <button
            type="button"
            className={controlClass}
            onClick={() => onRespond(submission.response)}
          >
            Retry
          </button>
        </div>
      ) : null}
    </section>
  );
});

interface SessionPresentationAreaProps {
  readonly statuses: ReadonlyArray<SessionStatusPresentation>;
  readonly widgets: ReadonlyArray<SessionWidgetPresentation>;
  readonly placement: SessionWidgetPlacement;
}

export const SessionPresentationArea = memo(function SessionPresentationArea({
  statuses,
  widgets,
  placement,
}: SessionPresentationAreaProps) {
  const placedWidgets = widgets.filter((widget) => widget.placement === placement);
  const showStatuses = placement === "aboveEditor";
  if ((!showStatuses || statuses.length === 0) && placedWidgets.length === 0) return null;

  return (
    <aside
      className="border-b border-border/55 bg-background/55 px-4 py-2 text-xs"
      aria-label={placement === "aboveEditor" ? "Session presentation" : "Session widgets"}
      data-session-presentation-placement={placement}
    >
      {showStatuses ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1" aria-label="Session status">
          {statuses.map((status) => (
            <p key={status.key} className="min-w-0 max-w-full break-words text-secondary-label">
              <span className="font-medium text-foreground/80">{status.key}:</span> {status.text}
            </p>
          ))}
        </div>
      ) : null}
      {placedWidgets.map((widget) => (
        <div
          key={widget.key}
          className={cn(
            "max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted/35 px-2.5 py-2 text-foreground/85",
            showStatuses && statuses.length > 0 && "mt-2",
          )}
          aria-label={widget.key}
        >
          {withOccurrenceKeys(widget.lines).map(({ key, value: line }) => (
            <div key={key}>{line || " "}</div>
          ))}
        </div>
      ))}
    </aside>
  );
});

export const SessionNotificationRow = memo(function SessionNotificationRow({
  notification,
}: {
  readonly notification: SessionNotificationActivity;
}) {
  const Icon =
    notification.level === "error"
      ? AlertCircleIcon
      : notification.level === "warning"
        ? TriangleAlertIcon
        : InfoIcon;
  return (
    <div
      role={notification.level === "error" ? "alert" : "status"}
      data-session-notification-level={notification.level}
      className={cn(
        "flex max-h-40 items-start gap-2 overflow-y-auto rounded-lg border px-3 py-2 text-sm",
        notification.level === "error"
          ? "border-destructive/35 bg-destructive/8 text-destructive"
          : notification.level === "warning"
            ? "border-warning/35 bg-warning/8 text-warning"
            : "border-info/35 bg-info/8 text-info-foreground",
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <p className="min-w-0 whitespace-pre-wrap break-words">{notification.message}</p>
    </div>
  );
});
