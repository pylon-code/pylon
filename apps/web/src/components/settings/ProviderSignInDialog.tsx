import {
  ProviderLoginSessionId,
  type EnvironmentId,
  type ProviderInstanceId,
  type ServerProviderLoginMethod,
} from "@t3tools/contracts";
import { ExternalLinkIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

/**
 * Sign in to one provider account.
 *
 * The CLI prints a link and then waits for the code the browser gives back, so
 * the dialog mirrors that: open the link, paste the code. The alternative was
 * telling people to run a shell command, which made a second account something
 * only a maintainer could add.
 */
const METHOD_OPTIONS: ReadonlyArray<{
  readonly value: ServerProviderLoginMethod;
  readonly label: string;
  readonly hint: string;
}> = [
  {
    value: "subscription",
    label: "Claude subscription",
    hint: "Pro, Max, or Team billed through claude.ai",
  },
  { value: "console", label: "Anthropic Console", hint: "API usage billing" },
  { value: "sso", label: "Single sign-on", hint: "Your organization requires SSO" },
];

type Phase =
  | { readonly kind: "choosing" }
  | { readonly kind: "starting" }
  | { readonly kind: "awaitingCode"; readonly sessionId: string; readonly url: string }
  | { readonly kind: "submitting"; readonly sessionId: string; readonly url: string }
  | { readonly kind: "failed"; readonly message: string };

export function ProviderSignInDialog({
  open,
  onOpenChange,
  environmentId,
  instanceId,
  accountLabel,
  knownEmail,
  onSignedIn,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly accountLabel: string;
  readonly knownEmail?: string | undefined;
  readonly onSignedIn?: (() => void) | undefined;
}) {
  const startLogin = useAtomCommand(serverEnvironment.startProviderLogin, {
    reportFailure: false,
  });
  const submitCode = useAtomCommand(serverEnvironment.submitProviderLoginCode, {
    reportFailure: false,
  });
  const cancelLogin = useAtomCommand(serverEnvironment.cancelProviderLogin, {
    reportFailure: false,
  });

  const [method, setMethod] = useState<ServerProviderLoginMethod>("subscription");
  const [phase, setPhase] = useState<Phase>({ kind: "choosing" });
  const [code, setCode] = useState("");

  useEffect(() => {
    if (open) return;
    setPhase({ kind: "choosing" });
    setCode("");
  }, [open]);

  // An abandoned dialog leaves a CLI process waiting on stdin. The server
  // sweeps them eventually; telling it now is cheaper and immediate.
  const activeSessionId =
    phase.kind === "awaitingCode" || phase.kind === "submitting" ? phase.sessionId : null;
  const closeDialog = useCallback(() => {
    if (activeSessionId) {
      void cancelLogin({
        environmentId,
        input: { sessionId: ProviderLoginSessionId.make(activeSessionId) },
      });
    }
    onOpenChange(false);
  }, [activeSessionId, cancelLogin, environmentId, onOpenChange]);

  const begin = useCallback(async () => {
    setPhase({ kind: "starting" });
    const result = await startLogin({
      environmentId,
      input: {
        instanceId,
        method,
        ...(knownEmail ? { email: knownEmail } : {}),
      },
    });
    if (result._tag === "Failure") {
      setPhase({
        kind: "failed",
        message: "Could not start sign-in. Check the provider's binary path and try again.",
      });
      return;
    }
    setPhase({ kind: "awaitingCode", sessionId: result.value.sessionId, url: result.value.url });
    window.open(result.value.url, "_blank", "noopener,noreferrer");
  }, [environmentId, instanceId, knownEmail, method, startLogin]);

  const finish = useCallback(async () => {
    if (phase.kind !== "awaitingCode") return;
    const trimmed = code.trim();
    if (!trimmed) return;
    setPhase({ kind: "submitting", sessionId: phase.sessionId, url: phase.url });
    const result = await submitCode({
      environmentId,
      input: { sessionId: ProviderLoginSessionId.make(phase.sessionId), code: trimmed },
    });
    if (result._tag === "Failure") {
      setPhase({ kind: "failed", message: "That sign-in is no longer running. Start it again." });
      return;
    }
    if (!result.value.signedIn) {
      setPhase({ kind: "failed", message: result.value.message ?? "Sign-in did not complete." });
      return;
    }
    onSignedIn?.();
    onOpenChange(false);
  }, [code, environmentId, onOpenChange, onSignedIn, phase, submitCode]);

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : closeDialog())}>
      <DialogPopup className="max-w-md">
        <DialogTitle>Sign in to {accountLabel}</DialogTitle>
        <DialogDescription>
          {knownEmail
            ? `The login page opens signed in as whichever account your browser last used. This one is ${knownEmail}.`
            : "Signs in the account this provider uses, without touching your other accounts."}
        </DialogDescription>

        <div className="flex flex-col gap-3 py-2">
          {phase.kind === "choosing" || phase.kind === "starting" || phase.kind === "failed" ? (
            <div className="flex flex-col gap-1.5">
              {METHOD_OPTIONS.map((option) => (
                <label
                  key={option.value}
                  className="flex cursor-pointer items-start gap-2 rounded-md border border-border/60 p-2 text-sm hover:bg-muted/40"
                >
                  <input
                    type="radio"
                    name="provider-login-method"
                    className="mt-1"
                    checked={method === option.value}
                    onChange={() => setMethod(option.value)}
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="font-medium">{option.label}</span>
                    <span className="text-xs text-muted-foreground">{option.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          ) : null}

          {phase.kind === "awaitingCode" || phase.kind === "submitting" ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-muted-foreground">
                Finish signing in on the page that opened, then paste the code it gives you.
              </p>
              <a
                href={phase.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-sm underline underline-offset-2"
              >
                <ExternalLinkIcon className="size-3.5" />
                Open the sign-in page again
              </a>
              <Label htmlFor="provider-login-code">Code</Label>
              <Input
                id="provider-login-code"
                autoFocus
                value={code}
                onChange={(event) => setCode(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void finish();
                }}
                placeholder="Paste the code here"
              />
            </div>
          ) : null}

          {phase.kind === "failed" ? (
            <p className="text-sm text-destructive">{phase.message}</p>
          ) : null}
        </div>

        <DialogFooter>
          <DialogClose render={<Button variant="ghost" onClick={closeDialog} />}>
            Cancel
          </DialogClose>
          {phase.kind === "awaitingCode" || phase.kind === "submitting" ? (
            <Button
              onClick={() => void finish()}
              disabled={phase.kind === "submitting" || !code.trim()}
            >
              {phase.kind === "submitting" ? "Signing in…" : "Sign in"}
            </Button>
          ) : (
            <Button onClick={() => void begin()} disabled={phase.kind === "starting"}>
              {phase.kind === "starting" ? "Opening…" : "Continue"}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
