import {
  compareCuaVersions,
  isComputerSetupRunning,
  type EnvironmentId,
  type ComputerSetupStartInput,
} from "@t3tools/contracts";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { useEffect, useRef, useState } from "react";
import { CheckIcon, MonitorIcon } from "lucide-react";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";

export function ComputerSetupSection({
  environmentId,
  environmentLabel,
  binaryPath,
  connected,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly binaryPath: string;
  readonly connected: boolean;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.computerSetupState({ environmentId, input: {} }),
  );
  const setup = query.data;
  const options = { reportFailure: false, reportDefect: false };
  const refresh = useAtomCommand(serverEnvironment.refreshComputerSetup, options);
  const start = useAtomCommand(serverEnvironment.startComputerSetup, options);
  const cancel = useAtomCommand(serverEnvironment.cancelComputerSetup, options);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ComputerSetupStartInput | null>(null);
  async function run<A, E>(request: () => Promise<AtomCommandResult<A, E>>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await request();
      if (result._tag === "Failure") {
        const failure = squashAtomCommandFailure(result);
        setError(
          failure instanceof Error
            ? failure.message
            : "Computer setup could not finish. Try again.",
        );
      }
    } catch {
      setError("Computer setup could not finish. Check the environment connection and try again.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  useEffect(() => {
    if (connected && binaryPath !== undefined) void refresh({ environmentId, input: {} });
  }, [environmentId, binaryPath, connected, refresh]);
  const active = setup !== null && isComputerSetupRunning(setup.phase);
  const disabled = busy || !connected || query.error !== null;
  const installation = setup?.installation;
  const installed = installation?.status === "ready";
  const release = setup?.latestRelease;
  const hasUpdate =
    installed &&
    release &&
    installation.version !== null &&
    compareCuaVersions(release.version, installation.version) > 0;
  const newerInstalled =
    installed &&
    release &&
    installation.version !== null &&
    compareCuaVersions(installation.version, release.version) > 0;
  const operation =
    installation?.status === "missing" ? "install" : hasUpdate ? "update" : "repair";
  const progress = setup?.totalBytes
    ? Math.min(100, Math.round((setup.downloadedBytes / setup.totalBytes) * 100))
    : null;
  return (
    <div className="border-b border-border/60 px-4 py-4 sm:px-5" data-testid="computer-setup">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <MonitorIcon className="size-4" />
          </div>
          <div>
            <p className="text-sm font-medium">
              Cua Driver{installation?.version ? ` ${installation.version}` : ""}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {installed
                ? `Installed on ${environmentLabel}${installation.source === "custom" ? " · Custom executable" : ""}`
                : (installation?.message ?? "Checking the installation on this environment.")}
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled || active}
          onClick={() => void run(() => refresh({ environmentId, input: { checkUpdates: true } }))}
        >
          {active && setup?.action === "check" ? "Checking…" : "Check for updates"}
        </Button>
      </div>
      {query.error && (
        <p role="alert" className="mt-3 text-xs text-destructive">
          Could not read computer setup. Reconnect or update this environment to use guided setup.
        </p>
      )}
      {(error || setup?.phase === "failed") && (
        <p role="alert" className="mt-3 text-xs text-destructive">
          {error ?? setup?.message}
        </p>
      )}
      {setup?.updateMessage && (
        <p className="mt-3 text-xs text-muted-foreground">{setup.updateMessage}</p>
      )}
      {active && setup?.action !== "check" && (
        <div className="mt-4 space-y-2" role="status" aria-live="polite">
          <p className="text-xs text-muted-foreground">
            {setup?.message ??
              (setup?.action === "permissions"
                ? `Complete the macOS permission prompts on ${environmentLabel}.`
                : "Preparing setup…")}
          </p>
          {setup?.phase === "downloading" && progress !== null && (
            <>
              <progress
                aria-label="Cua Driver download"
                value={progress}
                max={100}
                className="h-1.5 w-full accent-primary"
              />
              <p className="text-xs tabular-nums text-muted-foreground">
                {(setup.downloadedBytes / 1_000_000).toFixed(1)} /{" "}
                {((setup.totalBytes ?? 0) / 1_000_000).toFixed(1)} MB
              </p>
            </>
          )}
          {setup?.operationId && setup.phase !== "activating" && (
            <Button
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={() =>
                void run(() =>
                  cancel({ environmentId, input: { operationId: setup.operationId ?? "" } }),
                )
              }
            >
              Cancel setup
            </Button>
          )}
        </div>
      )}
      {!active && release && installation?.canManage && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            size="sm"
            variant={installed && !hasUpdate ? "outline" : "default"}
            disabled={disabled || Boolean(newerInstalled)}
            onClick={() => setConfirm({ action: operation, expectedVersion: release.version })}
          >
            {operation === "install"
              ? `Install ${release.version}`
              : operation === "update"
                ? `Update to ${release.version}`
                : "Repair installation"}
          </Button>
          <a
            className="text-xs text-muted-foreground underline underline-offset-4"
            href={release.releaseUrl}
            target="_blank"
            rel="noreferrer"
          >
            Release notes
          </a>
          {installed && !hasUpdate && (
            <span className="text-xs text-muted-foreground">
              {newerInstalled ? "Installed version is newer" : "Latest verified release"}
            </span>
          )}
        </div>
      )}
      {confirm && "expectedVersion" in confirm && !active && (
        <div className="mt-4 rounded-lg border border-border bg-muted/30 p-3">
          <p className="text-sm font-medium">
            {confirm.action === "install"
              ? "Install"
              : confirm.action === "update"
                ? "Update"
                : "Reinstall"}{" "}
            Cua Driver {confirm.expectedVersion} on {environmentLabel}?
          </p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Pylon downloads and verifies the official release before installing. Setup restarts the
            Cua desktop service on that computer, including connections from other apps or Pylon
            environments. Finish those desktop tasks first. macOS permission grants stay under your
            control.
          </p>
          <div className="mt-3 flex gap-2">
            <Button
              size="sm"
              disabled={disabled}
              onClick={() => {
                const input = confirm;
                setConfirm(null);
                void run(() => start({ environmentId, input }));
              }}
            >
              Continue
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
              Back
            </Button>
          </div>
        </div>
      )}
      {installed && setup?.platform === "darwin" && (
        <div className="mt-4 border-t border-border/60 pt-3">
          <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs">
            {[
              { label: "Accessibility", value: setup.permissions.accessibility },
              { label: "Screen recording", value: setup.permissions.screenRecording },
            ].map(({ label, value }) => (
              <span key={label} className="flex items-center gap-1.5">
                {value === "granted" && <CheckIcon className="size-3.5 text-success" />}
                {label}
                <span className="text-muted-foreground">
                  {value === "granted"
                    ? "Enabled"
                    : value === "missing"
                      ? "Required"
                      : "Not checked"}
                </span>
              </span>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">{setup.permissions.message}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || active}
              onClick={() =>
                void run(() => start({ environmentId, input: { action: "permissions" } }))
              }
            >
              Open permission setup
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled || active}
              onClick={() => void run(() => refresh({ environmentId, input: {} }))}
            >
              Check permissions again
            </Button>
          </div>
        </div>
      )}
      {setup?.platform !== "darwin" && installed && (
        <p className="mt-3 text-xs text-muted-foreground">{setup?.permissions.message}</p>
      )}
      {setup?.phase === "cancelled" && (
        <p role="status" className="mt-3 text-xs text-muted-foreground">
          {setup.message}
        </p>
      )}
      <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
        Desktop access runs on {environmentLabel}. A remote environment controls its own desktop.
        Installation and permissions are separate from enabling agent access below.
      </p>
    </div>
  );
}
