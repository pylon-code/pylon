import type {
  ProviderAskSessionSideQuestionResult,
  ProviderCancelSessionSideQuestionResult,
  ProviderSessionSideQuestionRequestId,
} from "@t3tools/contracts";
import { ProviderSessionSideQuestionRequestId as SideQuestionRequestId } from "@t3tools/contracts";
import { type FormEvent, useCallback, useEffect, useReducer, useRef, useState } from "react";

import { randomUUID } from "~/lib/utils";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Textarea } from "../ui/textarea";
import {
  initialQuickQuestionView,
  quickQuestionCanSubmit,
  quickQuestionResultMessage,
  reduceQuickQuestionView,
  type QuickQuestionView,
} from "./QuickQuestion.logic";

export interface QuickQuestionDialogProps {
  readonly available: boolean;
  readonly identity: string | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onAsk: (
    requestId: ProviderSessionSideQuestionRequestId,
    question: string,
  ) => Promise<ProviderAskSessionSideQuestionResult>;
  readonly onCancel: (
    requestId: ProviderSessionSideQuestionRequestId,
  ) => Promise<ProviderCancelSessionSideQuestionResult>;
}

export function QuickQuestionDialogBody(props: {
  readonly view: QuickQuestionView;
  readonly onQuestionChange: (question: string) => void;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  readonly onCancel: () => void;
  readonly onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const { view } = props;

  if (view.status === "prompt") {
    return (
      <form onSubmit={props.onSubmit}>
        <DialogHeader>
          <DialogTitle>Quick question</DialogTitle>
          <DialogDescription>
            Ask a one-shot question without adding it to this thread.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <label className="grid gap-2 text-sm font-medium">
            Question
            <Textarea
              autoFocus
              data-testid="quick-question-input"
              rows={5}
              value={view.question}
              onChange={(event) => props.onQuestionChange(event.currentTarget.value)}
              placeholder="Ask about the current session..."
              aria-describedby="quick-question-disclosure"
            />
          </label>
          <p id="quick-question-disclosure" className="text-muted-foreground text-xs leading-5">
            Uses the session model; answer is temporary, not added to the thread, and may incur
            provider usage. Quick question is available in approval-required sessions.
          </p>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={props.onDismiss}>
            Dismiss
          </Button>
          <Button
            type="submit"
            data-testid="quick-question-submit"
            disabled={!quickQuestionCanSubmit(view.question)}
          >
            Ask
          </Button>
        </DialogFooter>
      </form>
    );
  }

  if (view.status === "pending" || view.status === "cancelling") {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Quick question</DialogTitle>
          <DialogDescription>
            {view.status === "cancelling"
              ? "Requesting cancellation..."
              : "Waiting for an answer..."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <p className="text-sm text-muted-foreground" role="status">
            {view.status === "cancelling"
              ? "Cancellation is being requested."
              : "The session model is considering the question."}
          </p>
        </DialogPanel>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            data-testid="quick-question-cancel"
            disabled={view.status === "cancelling"}
            onClick={props.onCancel}
          >
            Cancel
          </Button>
        </DialogFooter>
      </>
    );
  }

  if (view.status === "answer") {
    const empty = view.answer.length === 0;
    return (
      <>
        <DialogHeader>
          <DialogTitle>Quick question</DialogTitle>
          <DialogDescription>Temporary answer</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div
            data-testid="quick-question-answer"
            className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-muted/40 p-3 text-sm"
          >
            {empty ? (
              <span className="text-muted-foreground">The session returned an empty answer.</span>
            ) : (
              view.answer
            )}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={props.onDismiss}>
            Dismiss
          </Button>
          <Button
            type="button"
            disabled={empty}
            onClick={() => {
              if (!empty && typeof navigator !== "undefined" && navigator.clipboard) {
                void navigator.clipboard.writeText(view.answer).then(
                  () => setCopied(true),
                  () => setCopied(false),
                );
              }
            }}
          >
            {copied ? "Copied" : "Copy"}
          </Button>
        </DialogFooter>
      </>
    );
  }

  const message =
    view.status === "error"
      ? "The quick question could not be completed. Its outcome may be unknown, and Pylon will not retry it."
      : quickQuestionResultMessage(view.disposition);

  return (
    <>
      <DialogHeader>
        <DialogTitle>Quick question</DialogTitle>
        <DialogDescription>Answer unavailable</DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <p className="text-sm text-muted-foreground" role="status">
          {message}
        </p>
      </DialogPanel>
      <DialogFooter>
        <Button type="button" onClick={props.onDismiss}>
          Dismiss
        </Button>
      </DialogFooter>
    </>
  );
}

export function QuickQuestionDialog(props: QuickQuestionDialogProps) {
  const [view, dispatch] = useReducer(reduceQuickQuestionView, initialQuickQuestionView);
  const generationRef = useRef(0);
  const pendingRef = useRef<{
    readonly requestId: ProviderSessionSideQuestionRequestId;
    readonly cancel: QuickQuestionDialogProps["onCancel"];
    cancelled: boolean;
  } | null>(null);
  const identityRef = useRef(props.identity);

  const cancelPendingOnce = useCallback(() => {
    const pending = pendingRef.current;
    if (!pending || pending.cancelled) return null;
    pending.cancelled = true;
    return pending;
  }, []);

  const resetAndClose = useCallback(() => {
    const pending = cancelPendingOnce();
    if (pending) void pending.cancel(pending.requestId).catch(() => undefined);
    generationRef.current += 1;
    pendingRef.current = null;
    dispatch({ type: "reset" });
    props.onOpenChange(false);
  }, [cancelPendingOnce, props.onOpenChange]);

  useEffect(() => {
    if (identityRef.current === props.identity && props.available) return;
    identityRef.current = props.identity;
    resetAndClose();
  }, [props.available, props.identity, resetAndClose]);

  useEffect(
    () => () => {
      const pending = cancelPendingOnce();
      if (pending) void pending.cancel(pending.requestId).catch(() => undefined);
    },
    [cancelPendingOnce],
  );

  const submit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (view.status !== "prompt" || !props.available || !props.identity) return;
      const question = view.question.trim();
      if (!quickQuestionCanSubmit(question)) return;

      const requestId = SideQuestionRequestId.make(randomUUID());
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      pendingRef.current = { requestId, cancel: props.onCancel, cancelled: false };
      dispatch({ type: "submit" });

      void props.onAsk(requestId, question).then(
        (result) => {
          if (
            generationRef.current !== generation ||
            pendingRef.current?.requestId !== requestId ||
            pendingRef.current.cancelled
          ) {
            return;
          }
          pendingRef.current = null;
          dispatch({ type: "resolved", result });
        },
        () => {
          if (
            generationRef.current !== generation ||
            pendingRef.current?.requestId !== requestId ||
            pendingRef.current.cancelled
          ) {
            return;
          }
          pendingRef.current = null;
          dispatch({ type: "failed" });
        },
      );
    },
    [props, view],
  );

  const cancel = useCallback(() => {
    const pending = cancelPendingOnce();
    if (!pending) return;
    generationRef.current += 1;
    dispatch({ type: "cancel" });
    void pending.cancel(pending.requestId).then(
      (result) => {
        pendingRef.current = null;
        dispatch({
          type: "cancelled",
          alreadySettled: result.disposition === "already-settled",
        });
      },
      () => {
        pendingRef.current = null;
        dispatch({ type: "failed" });
      },
    );
  }, [cancelPendingOnce, props.onCancel]);

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) {
          resetAndClose();
          return;
        }
        if (props.available && props.identity) props.onOpenChange(true);
      }}
    >
      <DialogPopup className="max-w-lg" showCloseButton={view.status !== "cancelling"}>
        <QuickQuestionDialogBody
          view={view}
          onQuestionChange={(question) => dispatch({ type: "edit", question })}
          onSubmit={submit}
          onCancel={cancel}
          onDismiss={resetAndClose}
        />
      </DialogPopup>
    </Dialog>
  );
}
