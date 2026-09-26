import { DeviceToolVersions } from "../device/DeviceToolVersions";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { AppleIcon, AndroidIcon } from "../Icons";
import { DeviceHostAvailability } from "../device/DeviceHostAvailability";
import { Spinner } from "../ui/spinner";
import type {
  DeviceHostSummary,
  DevicePlatformAvailability,
  EnvironmentId,
  SshDeviceHostConfig,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { randomUUID } from "../../lib/utils";
import { useState } from "react";
import { deviceEnvironment, useDeviceState } from "../../state/device";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { MoreVertical, PlusIcon } from "lucide-react";
import { Menu, MenuTrigger, MenuPopup, MenuItem } from "../ui/menu";
import { SettingsRow } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { planDeviceHostUpdates } from "./deviceHostsSettings.logic";
import { toastManager } from "../ui/toast";
import { useHostConnectionChecks } from "./useHostConnectionChecks";
import { deviceHostChecksKey, parseDeviceHostDraft } from "./deviceHostConnectionChecks";

/** Host names and identity paths belong to the selected environment, never all environments. */
export function DeviceHostsSettings(props: {
  environmentId: EnvironmentId | null;
  hosts: ReadonlyArray<SshDeviceHostConfig>;
}) {
  const { scope, environments, connectedEnvironments } = useSettingsScope();
  const projectScope = scope.kind === "project" || scope.kind === "checkout";
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const test = useAtomCommand(deviceEnvironment.testHost, { reportFailure: false });
  const retry = useAtomCommand(deviceEnvironment.list);
  const { state } = useDeviceState(props.environmentId);
  const targets = environments.map((environment) => ({
    environmentId: environment.environmentId,
    label: environment.label,
    connected: environment.connection.phase === "connected",
  }));
  const { checks: environmentChecks, testConnection: testAcrossEnvironments } =
    useHostConnectionChecks(targets);
  const [editing, setEditing] = useState<SshDeviceHostConfig | null>(null);
  const [originalHost, setOriginalHost] = useState<SshDeviceHostConfig | null>(null);
  const [identityFileEdited, setIdentityFileEdited] = useState(false);
  const parsedEditing = editing ? parseDeviceHostDraft(editing) : Option.none();
  const validEditing = Option.isSome(parsedEditing) && editing?.label.trim() !== "";
  const [busy, setBusy] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [checks, setChecks] = useState<
    Record<
      string,
      {
        pending?: boolean;
        platforms?: ReadonlyArray<DevicePlatformAvailability>;
        tools?: DeviceHostSummary["tools"];
        error?: string;
      }
    >
  >({});
  const setCheck = (id: string, value: (typeof checks)[string]) =>
    setChecks((current) => ({ ...current, [id]: value }));
  const checkKey = (environmentId: EnvironmentId, hostId: string) =>
    JSON.stringify([environmentId, hostId]);
  const save = async (
    host: SshDeviceHostConfig,
    original: SshDeviceHostConfig | null,
    remove = false,
  ) => {
    if (!props.environmentId || projectScope) return;
    setBusy(true);
    try {
      const plan = planDeviceHostUpdates(
        environments.map((environment) => ({
          environmentId: environment.environmentId,
          label: environment.label,
          connected: environment.connection.phase === "connected",
          hosts: environment.serverConfig?.settings.deviceHosts ?? null,
        })),
        host,
        original,
        remove,
        identityFileEdited,
      );
      const results = await Promise.allSettled(
        plan.writes.map((target) =>
          update({
            environmentId: target.environmentId,
            input: { patch: { deviceHosts: target.hosts } },
          }),
        ),
      );
      const failed = [
        ...plan.failed,
        ...plan.writes.flatMap((target, index) => {
          const result = results[index];
          return result?.status !== "fulfilled" || result.value._tag === "Failure"
            ? [target.label]
            : [];
        }),
      ];
      if (failed.length === 0) {
        setEditing(null);
        setOriginalHost(null);
        setIdentityFileEdited(false);
      } else {
        toastManager.add({
          type: "error",
          title: "Device hosts not saved on all environments",
          description: `Could not update ${failed.join(", ")}.`,
        });
      }
    } finally {
      setBusy(false);
    }
  };
  const testConnection = async (host: SshDeviceHostConfig, environmentId: EnvironmentId) => {
    const key = checkKey(environmentId, host.id);
    if (checks[key]?.pending) return;
    setCheck(key, { pending: true });
    try {
      const summary = await test({ environmentId, input: host });
      setCheck(
        key,
        summary._tag === "Failure"
          ? { error: Cause.pretty(summary.cause) }
          : { platforms: summary.value.platforms },
      );
    } catch (error) {
      setCheck(key, { error: error instanceof Error ? error.message : String(error) });
    }
  };
  return (
    <SettingsRow
      id="device-hosts"
      title="Device hosts"
      serverScoped
      settingKeys={["deviceHosts"]}
      description="Add remote machines with simulator or emulator runtimes installed. Changes apply to the selected environments."
      control={
        <Button
          size="sm"
          variant="outline"
          disabled={projectScope || busy || !props.environmentId || editing !== null}
          onClick={() => {
            setOriginalHost(null);
            setIdentityFileEdited(false);
            setEditing({ id: randomUUID(), label: "", target: "" });
          }}
        >
          <PlusIcon className="size-3.5" /> Add host
        </Button>
      }
    >
      <div className="pt-3 pb-2">
        {!props.environmentId ? (
          <p className="text-sm text-muted-foreground">
            Connect a selected environment to manage device hosts.
          </p>
        ) : (
          <>
            {connectedEnvironments.length > 1 ? (
              <p className="pt-2 text-xs text-muted-foreground">
                {
                  connectedEnvironments.find(
                    (environment) => environment.environmentId === props.environmentId,
                  )?.label
                }{" "}
                · local device status
              </p>
            ) : null}
            {props.hosts.map((host) => {
              const status = state.hostStatuses[host.id];
              const check = checks[checkKey(props.environmentId!, host.id)];
              const platforms =
                check?.platforms ??
                state.hosts.find((value) => value.id === host.id)?.platforms ??
                [];
              const progress = check?.pending
                ? "Checking connection…"
                : status?.status === "installing"
                  ? "Installing device support…"
                  : status?.status === "starting"
                    ? "Connecting…"
                    : null;
              const error =
                check?.error ?? (status?.status === "failed" ? status.detail : undefined);
              return (
                <div
                  key={host.id}
                  className="flex items-center gap-2 border-t border-border/50 py-2.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <p className="truncate text-sm font-medium">{host.label}</p>
                      {platforms
                        .filter((platform) => platform.available)
                        .map((platform) => (
                          <Tooltip key={platform.platform}>
                            <TooltipTrigger
                              render={
                                <span
                                  tabIndex={0}
                                  role="img"
                                  aria-label={
                                    platform.platform === "ios"
                                      ? "iOS available"
                                      : "Android available"
                                  }
                                  className="shrink-0 text-muted-foreground"
                                />
                              }
                            >
                              {platform.platform === "ios" ? (
                                <AppleIcon className="size-3.5" />
                              ) : (
                                <AndroidIcon className="size-3.5" />
                              )}
                            </TooltipTrigger>
                            <TooltipPopup>
                              {platform.platform === "ios" ? "iOS available" : "Android available"}
                            </TooltipPopup>
                          </Tooltip>
                        ))}
                    </div>
                    <p className="truncate text-xs text-muted-foreground">{host.target}</p>
                    <DeviceToolVersions
                      error={state.hosts.find((value) => value.id === host.id)?.toolInspectionError}
                      tools={
                        state.hosts.find((value) => value.id === host.id)?.tools ?? check?.tools
                      }
                    />
                    {error ? (
                      <div className="mt-1" role="status">
                        <details className="text-xs text-destructive">
                          <summary>Connection failed</summary>
                          <p className="mt-1 whitespace-pre-wrap break-words">{error}</p>
                        </details>
                      </div>
                    ) : null}
                  </div>
                  {progress ? (
                    <span
                      role="status"
                      className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
                    >
                      <Spinner className="size-3" />
                      {progress}
                    </span>
                  ) : null}
                  <Menu>
                    <MenuTrigger
                      render={
                        <Button
                          size="icon-sm"
                          variant="ghost-muted"
                          disabled={busy || projectScope}
                          aria-label={host.label + " options"}
                        />
                      }
                    >
                      <MoreVertical />
                    </MenuTrigger>
                    <MenuPopup align="end">
                      <MenuItem
                        onClick={() => {
                          setOriginalHost(host);
                          setIdentityFileEdited(false);
                          setEditing(host);
                        }}
                      >
                        Edit
                      </MenuItem>
                      <MenuItem variant="destructive" onClick={() => void save(host, host, true)}>
                        Remove
                      </MenuItem>
                    </MenuPopup>
                  </Menu>
                  {status?.status === "failed" &&
                  state.supportsHostRetry &&
                  state.hostStatus !== "disabled" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || retrying !== null}
                      onClick={() => {
                        if (!props.environmentId) return;
                        setRetrying(host.id);
                        void retry({
                          environmentId: props.environmentId,
                          input: { retryHostId: host.id },
                        }).finally(() => setRetrying(null));
                      }}
                    >
                      {retrying === host.id ? "Retrying…" : "Retry"}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || progress !== null}
                      onClick={() => void testConnection(host, props.environmentId!)}
                    >
                      Test connection
                    </Button>
                  )}
                </div>
              );
            })}
            {connectedEnvironments
              .filter((environment) => environment.environmentId !== props.environmentId)
              .map((environment) => (
                <div key={environment.environmentId} className="border-t border-border/50 pt-3">
                  <p className="pb-1 text-xs font-medium text-muted-foreground">
                    {environment.label}
                  </p>
                  {(environment.serverConfig?.settings.deviceHosts ?? []).map((host) => {
                    const check = checks[checkKey(environment.environmentId, host.id)];
                    return (
                      <div key={host.id} className="py-2">
                        <div className="flex items-center gap-2">
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium">{host.label}</p>
                            <p className="truncate text-xs text-muted-foreground">{host.target}</p>
                          </div>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy || check?.pending}
                            onClick={() => void testConnection(host, environment.environmentId)}
                          >
                            {check?.pending ? "Checking…" : "Test"}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy || projectScope}
                            onClick={() => {
                              setOriginalHost(host);
                              setIdentityFileEdited(false);
                              setEditing(host);
                            }}
                          >
                            Edit
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy || projectScope}
                            onClick={() => void save(host, host, true)}
                          >
                            Remove
                          </Button>
                        </div>
                        {check?.platforms ? (
                          <DeviceHostAvailability platforms={check.platforms} />
                        ) : null}
                        {check?.error ? (
                          <p role="alert" className="text-xs text-destructive">
                            {check.error}
                          </p>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ))}
            {editing ? (
              <form
                className="space-y-3 border-t border-border/50 py-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (validEditing && Option.isSome(parsedEditing)) {
                    void save(parsedEditing.value, originalHost);
                  }
                }}
              >
                <label className="block space-y-1 text-sm">
                  <span>Name</span>
                  <Input
                    required
                    value={editing.label}
                    disabled={busy || projectScope}
                    onChange={(event) => setEditing({ ...editing, label: event.target.value })}
                    placeholder="Mac mini"
                  />
                </label>
                <label className="block space-y-1 text-sm">
                  <span>SSH target</span>
                  <Input
                    required
                    value={editing.target}
                    disabled={busy || projectScope}
                    onChange={(event) => setEditing({ ...editing, target: event.target.value })}
                    placeholder="user@host or SSH alias"
                  />
                </label>
                <label className="block space-y-1 text-sm">
                  <span>Identity file, optional</span>
                  <span className="block text-xs text-muted-foreground">
                    Each environment keeps its own path unless you change this field.
                  </span>
                  <Input
                    value={editing.identityFile ?? ""}
                    disabled={busy || projectScope}
                    onChange={(event) => {
                      setIdentityFileEdited(true);
                      const { identityFile: _, ...rest } = editing;
                      setEditing(
                        event.target.value ? { ...rest, identityFile: event.target.value } : rest,
                      );
                    }}
                    placeholder="~/.ssh/id_ed25519"
                  />
                </label>
                <label className="block space-y-1 text-sm">
                  <span>Port, optional</span>
                  <Input
                    type="number"
                    min={1}
                    max={65535}
                    value={editing.port ?? ""}
                    disabled={busy || projectScope}
                    onChange={(event) => {
                      const { port: _, ...rest } = editing;
                      setEditing(
                        event.target.value ? { ...rest, port: Number(event.target.value) } : rest,
                      );
                    }}
                    placeholder="SSH config default"
                  />
                </label>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" type="submit" disabled={projectScope || busy || !validEditing}>
                    Save host
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    variant="outline"
                    disabled={projectScope || busy || !validEditing}
                    onClick={() => {
                      if (Option.isSome(parsedEditing))
                        void testAcrossEnvironments(parsedEditing.value);
                    }}
                  >
                    Test connection
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      setEditing(null);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
                {targets.map((target) => {
                  const result =
                    environmentChecks[deviceHostChecksKey(editing, targets)]?.[
                      target.environmentId
                    ];
                  if (!result) return null;
                  return (
                    <div key={target.environmentId} className="text-xs" role="status">
                      <span className="font-medium">{target.label}: </span>
                      {result.status === "pending" ? "Checking…" : null}
                      {result.status === "local" ? "Already available locally" : null}
                      {result.status === "failed" ? result.error : null}
                      {result.status === "connected" ? (
                        <DeviceHostAvailability platforms={result.platforms} />
                      ) : null}
                    </div>
                  );
                })}
              </form>
            ) : null}
          </>
        )}
      </div>
    </SettingsRow>
  );
}
