import {
  type EnvironmentId,
  PROVIDER_DISPLAY_NAMES,
  type ServerProvider,
} from "@t3tools/contracts";
import { useMemo, useRef, useState } from "react";

import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import {
  EnvironmentUpdateRow,
  useEnvironmentProviderUpdates,
} from "../ProviderUpdateEnvironmentRows";
import {
  buildConnectedEnvironmentUpdatePlan,
  collectProviderUpdateCandidates,
  describeConnectedEnvironmentUpdateSkip,
  getProviderUpdateRunToastView,
  type ConnectedEnvironmentUpdatePlan,
  type ProviderUpdateCandidate,
} from "../ProviderUpdateLaunchNotification.logic";
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
import { stackedThreadToast, toastManager } from "../ui/toast";
import { buildProviderEnvironmentOptions } from "./ProviderSettingsPanel.logic";
import { useProviderOperateAccessByEnvironment } from "./providerOperateAccess";
import { SettingsRow, SettingsSection } from "./settingsLayout";

function providerName(provider: Pick<ServerProvider, "driver">): string {
  return PROVIDER_DISPLAY_NAMES[provider.driver] ?? provider.driver;
}

function candidateLabel(candidate: ProviderUpdateCandidate): string {
  const latest = candidate.versionAdvisory.latestVersion;
  return `${providerName(candidate)} ${latest.startsWith("v") ? latest : `v${latest}`}`;
}

function manualProviderLabel(provider: ProviderUpdateCandidate): string {
  return provider.driver === "primeAgent"
    ? `${providerName(provider)} (use Prime maintenance)`
    : providerName(provider);
}

function pluralize(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function summarizePlan(plan: ConnectedEnvironmentUpdatePlan): string {
  return `${pluralize(plan.providerCount, "provider update", "provider updates")} on ${pluralize(
    plan.targets.length,
    "connected environment",
    "connected environments",
  )}.`;
}

function ReviewList({
  plan,
  showTargets,
}: {
  readonly plan: ConnectedEnvironmentUpdatePlan;
  readonly showTargets: boolean;
}) {
  return (
    <div className="grid gap-4 text-sm">
      {!showTargets ? null : plan.targets.length > 0 ? (
        <div className="grid gap-1.5">
          <h3 className="text-xs font-medium text-muted-foreground">Will update</h3>
          <ul className="grid gap-1">
            {plan.targets.map((group) => (
              <li key={group.environmentId} className="flex min-w-0 flex-col">
                <span className="truncate font-medium text-foreground">{group.label}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {group.candidates.map(candidateLabel).join(", ")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-muted-foreground">No connected environment has a one-click update.</p>
      )}
      {plan.manual.length > 0 ? (
        <div className="grid gap-1.5">
          <h3 className="text-xs font-medium text-muted-foreground">Needs a manual update</h3>
          <ul className="grid gap-1">
            {plan.manual.map((entry) => (
              <li key={entry.environmentId} className="flex min-w-0 flex-col">
                <span className="truncate text-foreground">{entry.label}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {entry.providers.map(manualProviderLabel).join(", ")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {plan.skipped.length > 0 ? (
        <div className="grid gap-1.5">
          <h3 className="text-xs font-medium text-muted-foreground">Not included</h3>
          <ul className="grid gap-1">
            {plan.skipped.map((entry) => (
              <li key={entry.environmentId} className="flex min-w-0 flex-col">
                <span className="truncate text-foreground">{entry.label}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {describeConnectedEnvironmentUpdateSkip(entry.reason)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Settings → Providers action that updates providers on every connected
 * environment, not only the selected one. The user reviews the target list
 * (machine and providers) first; confirming sends one environment-addressed
 * update per provider, concurrently across environments. Each environment's
 * row then keeps its own outcome and retry, and one toast summarizes the run.
 *
 * Each server still authorizes the command, rejects a duplicate target, and
 * serializes updates that share an installer.
 */
export function ProviderUpdateAllEnvironmentsAction() {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const orderedEnvironments = useMemo(
    () => buildProviderEnvironmentOptions(environments, primaryEnvironmentId),
    [environments, primaryEnvironmentId],
  );
  // Only read the sessions of environments that could be targeted.
  const accessTargets = useMemo(
    () =>
      orderedEnvironments
        .filter(
          (environment) =>
            environment.connection.phase === "connected" &&
            collectProviderUpdateCandidates(environment.serverConfig?.providers ?? []).length > 0,
        )
        .map((environment) => ({
          environmentId: environment.environmentId,
          isPrimary: environment.entry.target._tag === "PrimaryConnectionTarget",
        })),
    [orderedEnvironments],
  );
  const operateAccess = useProviderOperateAccessByEnvironment(accessTargets);
  const plan = useMemo(
    () =>
      buildConnectedEnvironmentUpdatePlan(
        orderedEnvironments.map((environment) => ({
          environmentId: environment.environmentId,
          label: environment.label,
          isPrimary: environment.entry.target._tag === "PrimaryConnectionTarget",
          connectionPhase: environment.connection.phase,
          providers: environment.serverConfig?.providers ?? null,
          operateAccess: operateAccess.get(environment.environmentId) ?? "pending",
        })),
      ),
    [orderedEnvironments, operateAccess],
  );
  const { rows, updateEnvironment } = useEnvironmentProviderUpdates(plan.groups);
  const [open, setOpen] = useState(false);
  // Synchronous guard: state updates land after this handler returns, so a
  // double click must be rejected before any update is sent.
  const runInFlightRef = useRef(false);
  const [isRunning, setIsRunning] = useState(false);
  const [hasStarted, setHasStarted] = useState(false);
  // Read when a run settles, which can happen after the dialog closed.
  const openRef = useRef(false);
  // The run's summary toast describes the initial attempt only; a per-row
  // retry closes it so it never reports a failure the retry may have fixed.
  const summaryToastIdRef = useRef<ReturnType<typeof toastManager.add> | null>(null);

  const hasRowActivity = rows.some((row) => row.status.kind !== "idle");
  if (plan.targets.length === 0 && !isRunning && !hasRowActivity && !open) {
    return null;
  }

  const setDialogOpen = (next: boolean) => {
    openRef.current = next;
    setOpen(next);
    // Closing after a finished run returns the next opening to review.
    if (!next && !runInFlightRef.current) setHasStarted(false);
  };

  const retryEnvironment = (environmentId: EnvironmentId) => {
    if (summaryToastIdRef.current !== null) {
      toastManager.close(summaryToastIdRef.current);
      summaryToastIdRef.current = null;
    }
    void updateEnvironment(environmentId);
  };

  const runAll = async () => {
    if (runInFlightRef.current) return;
    // Dispatch exactly the reviewed targets rendered with this handler.
    const targetEnvironmentIds = plan.targets.map((group) => group.environmentId);
    if (targetEnvironmentIds.length === 0) return;
    runInFlightRef.current = true;
    setIsRunning(true);
    setHasStarted(true);
    try {
      const results = await Promise.all(
        targetEnvironmentIds.map((environmentId) => updateEnvironment(environmentId)),
      );
      const view = getProviderUpdateRunToastView(results.flatMap((runs) => runs ?? []));
      if (view) {
        summaryToastIdRef.current = toastManager.add(
          stackedThreadToast({
            ...view,
            description: <span className="whitespace-pre-line">{view.description}</span>,
          }),
        );
      }
    } finally {
      runInFlightRef.current = false;
      setIsRunning(false);
      // Finished while the dialog was closed: the next opening reviews the
      // current targets rather than showing this run's progress.
      if (!openRef.current) setHasStarted(false);
    }
  };

  const showProgress = hasStarted;

  return (
    <SettingsSection title="Provider updates">
      <SettingsRow
        title="All connected environments"
        description={
          plan.targets.length > 0
            ? `${summarizePlan(plan)} Includes environments other than the one selected below.`
            : "Updates are in progress or finished. Review each environment's result."
        }
        control={
          <Button size="sm" variant="outline" onClick={() => setDialogOpen(true)}>
            {plan.targets.length > 0 ? "Update all connected environments" : "View results"}
          </Button>
        }
      />
      <Dialog open={open} onOpenChange={setDialogOpen}>
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Update providers on all connected environments</DialogTitle>
            <DialogDescription>
              Each environment installs its own updates and reports its own result. New sessions use
              the updated providers.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {showProgress ? (
              <div className="grid gap-4">
                <div className="flex flex-col gap-1">
                  {rows.map(({ group, status }) => (
                    <EnvironmentUpdateRow
                      key={group.environmentId}
                      group={group}
                      status={status}
                      onUpdate={() => retryEnvironment(group.environmentId)}
                    />
                  ))}
                </div>
                {plan.manual.length > 0 || plan.skipped.length > 0 ? (
                  <ReviewList plan={plan} showTargets={false} />
                ) : null}
              </div>
            ) : (
              <ReviewList plan={plan} showTargets />
            )}
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              {showProgress ? "Close" : "Cancel"}
            </Button>
            {showProgress ? null : (
              <Button
                disabled={isRunning || plan.providerCount === 0}
                onClick={() => void runAll()}
              >
                {`Update ${pluralize(plan.providerCount, "provider", "providers")}`}
              </Button>
            )}
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </SettingsSection>
  );
}
