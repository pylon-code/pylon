import type { OrchestrationRollbackStatus } from "@t3tools/contracts";
import { Button } from "./ui/button";

export function RollbackStatusBanner(props: {
  readonly status: OrchestrationRollbackStatus | null | undefined;
  readonly recoveryPending: boolean;
  readonly onRecover: (action: "retry-verification" | "resume-compensation") => void;
}) {
  const status = props.status;
  if (!status) return null;
  const severe = status.state === "manual-recovery" || status.state === "failed";
  const label =
    status.state === "pending"
      ? "Rollback pending"
      : status.state === "recovering"
        ? "Rollback recovering"
        : status.state === "manual-recovery"
          ? "Manual recovery required"
          : status.state === "completed"
            ? "Rollback completed"
            : "Rollback failed safely";
  const actions = status.allowedActions ?? [];
  return (
    <section
      role={severe ? "alert" : "status"}
      aria-live={severe ? "assertive" : "polite"}
      aria-atomic="true"
      className={`pointer-events-auto mx-auto mt-2 flex w-[min(48rem,calc(100%-2rem))] items-center gap-3 rounded-lg border px-3 py-2 text-sm shadow-sm ${
        severe
          ? "border-destructive/50 bg-destructive/10 text-destructive"
          : "border-border bg-background/95 text-foreground"
      }`}
    >
      <div className="min-w-0 flex-1">
        <p className="font-medium">{label}</p>
        <p className="text-xs opacity-80">
          {status.detail ?? "Pylon is verifying rollback state."}
        </p>
      </div>
      {actions.includes("retry-verification") ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={props.recoveryPending}
          aria-label="Retry rollback verification"
          onClick={() => props.onRecover("retry-verification")}
        >
          Retry verification
        </Button>
      ) : null}
      {actions.includes("resume-compensation") ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={props.recoveryPending}
          aria-label="Resume rollback compensation"
          onClick={() => props.onRecover("resume-compensation")}
        >
          Resume compensation
        </Button>
      ) : null}
    </section>
  );
}
