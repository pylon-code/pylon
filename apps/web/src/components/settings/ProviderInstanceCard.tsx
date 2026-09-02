"use client";

import {
  ArrowUpCircleIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CopyIcon,
  DownloadIcon,
  LoaderIcon,
  PlusIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import * as Arr from "effect/Array";
import * as Result from "effect/Result";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  isProviderDriverKind,
  resolveProviderInstanceEnabled,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
  type ProviderInstanceId,
  type ProviderDriverKind,
  type ServerPrimeManagedAction,
  type ServerPrimeManagedMaintenance,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";

import { cn } from "../../lib/utils";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import {
  getProviderUnavailablePresentation,
  normalizeProviderAccentColor,
} from "../../providerInstances";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { ProviderSignInDialog } from "./ProviderSignInDialog";
import type { EnvironmentId } from "@t3tools/contracts";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { DraftInput } from "../ui/draft-input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ScrollArea } from "../ui/scroll-area";
import { Switch } from "../ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { DriverOption } from "./providerDriverMeta";
import { providerSettingsTabClassName } from "./providerSettingsTabs";
import { ProviderSettingsForm } from "./ProviderSettingsForm";
import { ProviderModelsSection } from "./ProviderModelsSection";
import { ProviderInstanceIcon, providerInstanceInitials } from "../chat/ProviderInstanceIcon";
import {
  PRIME_AGENT_ACP_GUIDANCE,
  PRIME_AGENT_INSTANCE_GUIDANCE,
  PRIME_AGENT_MAINTENANCE_GUIDANCE,
} from "./providerMultipleInstances";
import { ProviderAccentColorPicker } from "./ProviderAccentColorPicker";
import { RedactedSensitiveText } from "./RedactedSensitiveText";
import { ProviderUsageRows, ProviderUsageSummary } from "../providerUsage/ProviderUsageRows";
import {
  getProviderDistributionLabel,
  getProviderVersionAdvisoryPresentation,
  PROVIDER_STATUS_STYLES,
  getProviderSummary,
  getProviderVersionLabel,
  type ProviderStatusKey,
} from "./providerStatus";

const ENVIRONMENT_VARIABLE_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

let environmentVariableDraftId = 0;
const nextEnvironmentVariableDraftId = () => `provider-env-${environmentVariableDraftId++}`;

type EnvironmentDraftRow = {
  readonly id: string;
  readonly name: string;
  readonly value: string;
  readonly sensitive: boolean;
  readonly valueRedacted?: boolean;
};

function makeEnvironmentDraftRow(
  variable: ProviderInstanceEnvironmentVariable,
  index: number,
): EnvironmentDraftRow {
  return {
    id: `${index}:${variable.name}`,
    name: variable.name,
    value: variable.value,
    sensitive: variable.sensitive,
    ...(variable.valueRedacted !== undefined ? { valueRedacted: variable.valueRedacted } : {}),
  };
}

function providerEnvironmentsEqual(
  left: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
  right: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
): boolean {
  return (
    left.length === right.length &&
    left.every((variable, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        variable.name === other.name &&
        variable.value === other.value &&
        variable.sensitive === other.sensitive &&
        variable.valueRedacted === other.valueRedacted
      );
    })
  );
}

/**
 * Read a string[] at `key` from the opaque config blob, filtering out
 * non-string entries. Used for `customModels`, which is always typed as
 * `string[]` by the concrete driver schemas but arrives here as
 * `Schema.Unknown`.
 */
function readConfigStringArray(config: unknown, key: string): ReadonlyArray<string> {
  if (config === null || typeof config !== "object") return [];
  const value = (config as Record<string, unknown>)[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Set `key` to an arbitrary value on the opaque config blob. Unlike
 * provider settings field updates, does not drop empty-looking values — the
 * caller is responsible for deciding whether an empty array / empty
 * object should be stored explicitly (e.g. `customModels: []` is a
 * meaningful "user cleared their custom list" state distinct from
 * "driver default").
 */
function nextConfigBlobWithValue(
  config: unknown,
  key: string,
  value: unknown,
): Record<string, unknown> {
  const base: Record<string, unknown> =
    config !== null && typeof config === "object" ? { ...(config as Record<string, unknown>) } : {};
  base[key] = value;
  return base;
}

export function deriveProviderModelsForDisplay(input: {
  readonly liveModels: ReadonlyArray<ServerProviderModel> | undefined;
  readonly customModels: ReadonlyArray<string>;
}): ReadonlyArray<ServerProviderModel> {
  const liveCustomModelsBySlug = new Map(
    Arr.filterMap(input.liveModels ?? [], (model) =>
      model.isCustom ? Result.succeed([model.slug, model] as const) : Result.failVoid,
    ),
  );
  const serverModels = input.liveModels?.filter((model) => !model.isCustom) ?? [];
  const customModels = input.customModels.map(
    (slug) =>
      liveCustomModelsBySlug.get(slug) ?? {
        slug,
        name: slug,
        isCustom: true,
        capabilities: null,
      },
  );
  return [...serverModels, ...customModels];
}

function ProviderAuthEmail(props: {
  readonly email: string | undefined;
  readonly prefix?: string;
  readonly separator?: boolean;
}) {
  const trimmed = props.email?.trim();
  if (!trimmed) return null;

  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      {props.separator ? <span aria-hidden>·</span> : null}
      {props.prefix ? <span className="text-muted-foreground/80">{props.prefix}</span> : null}
      <RedactedSensitiveText
        value={trimmed}
        ariaLabel="Toggle account email visibility"
        revealTooltip="Click to reveal email"
        hideTooltip="Click to hide email"
      />
    </span>
  );
}

function ProviderEnvironmentSection(props: {
  readonly environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>;
  readonly onChange: (environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>) => void;
}) {
  const [rows, setRows] = useState<ReadonlyArray<EnvironmentDraftRow>>(() =>
    props.environment.map(makeEnvironmentDraftRow),
  );
  const previousEnvironmentRef = useRef(props.environment);
  const lastPublishedEnvironmentRef = useRef<
    ReadonlyArray<ProviderInstanceEnvironmentVariable> | undefined
  >(undefined);

  useEffect(() => {
    const previousEnvironment = previousEnvironmentRef.current;
    previousEnvironmentRef.current = props.environment;
    // The caller passes `instance.environment ?? []`, so an instance with no
    // variables allocates a new array every render and this effect runs every
    // render. Return before touching the echo guard: clearing it here would
    // spend a pending publish's one-shot suppression on a render that changed
    // nothing, and the real echo would then read as an external edit.
    if (
      previousEnvironment === props.environment ||
      providerEnvironmentsEqual(previousEnvironment, props.environment)
    ) {
      return;
    }
    const lastPublishedEnvironment = lastPublishedEnvironmentRef.current;
    lastPublishedEnvironmentRef.current = undefined;
    if (
      lastPublishedEnvironment !== undefined &&
      providerEnvironmentsEqual(lastPublishedEnvironment, props.environment)
    ) {
      return;
    }
    setRows(props.environment.map(makeEnvironmentDraftRow));
  }, [props.environment]);

  const publishRows = (nextRows: ReadonlyArray<EnvironmentDraftRow>) => {
    const published: ProviderInstanceEnvironmentVariable[] = [];
    for (const row of nextRows) {
      const name = row.name.trim();
      if (!ENVIRONMENT_VARIABLE_NAME_PATTERN.test(name)) {
        if (
          name.length > 0 ||
          row.value.length > 0 ||
          row.sensitive !== true ||
          row.valueRedacted !== undefined
        ) {
          return;
        }
        continue;
      }
      const { id: _id, ...rest } = row;
      published.push({ ...rest, name });
    }
    lastPublishedEnvironmentRef.current = published;
    props.onChange(published);
  };

  const updateVariable = (id: string, patch: Partial<Omit<EnvironmentDraftRow, "id">>) => {
    const nextRows = rows.map((row) =>
      row.id === id
        ? {
            ...row,
            ...patch,
            ...(patch.value !== undefined ? { valueRedacted: false } : {}),
          }
        : row,
    );
    setRows(nextRows);
    publishRows(nextRows);
  };

  const removeVariable = (id: string) => {
    const nextRows = rows.filter((row) => row.id !== id);
    setRows(nextRows);
    publishRows(nextRows);
  };

  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-foreground">Environment variables</span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 px-2 text-xs"
          onClick={() =>
            setRows([
              ...rows,
              {
                id: nextEnvironmentVariableDraftId(),
                name: "",
                value: "",
                sensitive: true,
              },
            ])
          }
        >
          <PlusIcon className="size-3" />
          Add
        </Button>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Add variables to pass API keys, base URLs, or other per-instance CLI settings.
        </p>
      ) : (
        <div className="overflow-hidden rounded-md border border-border/70">
          <Table>
            <TableHeader className="bg-muted/25 text-[11px] text-muted-foreground">
              <TableRow className="hover:bg-transparent">
                <TableHead>Variable</TableHead>
                <TableHead>Value</TableHead>
                <TableHead className="w-20">Sensitive</TableHead>
                <TableHead className="w-12 text-right">
                  <span className="sr-only">Options</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((variable, index) => (
                <TableRow
                  key={variable.id}
                  className="border-border/60 odd:bg-muted/20 even:bg-background/20"
                >
                  <TableCell>
                    <DraftInput
                      value={variable.name}
                      onCommit={(name) => updateVariable(variable.id, { name: name.trim() })}
                      placeholder="VARIABLE_NAME"
                      spellCheck={false}
                      aria-label={`Environment variable name ${index + 1}`}
                    />
                  </TableCell>
                  <TableCell>
                    <DraftInput
                      value={variable.valueRedacted ? "" : variable.value}
                      onCommit={(value) => updateVariable(variable.id, { value })}
                      type={variable.sensitive ? "password" : undefined}
                      autoComplete="off"
                      placeholder={
                        variable.valueRedacted
                          ? "Stored secret - enter a new value to replace"
                          : "Value"
                      }
                      spellCheck={false}
                      aria-label={`Environment variable value ${index + 1}`}
                    />
                  </TableCell>
                  <TableCell className="w-20">
                    <div className="flex h-8 items-center justify-center">
                      <Checkbox
                        checked={variable.sensitive}
                        onCheckedChange={(checked) => {
                          const sensitive = Boolean(checked);
                          updateVariable(variable.id, {
                            sensitive,
                            ...(sensitive && variable.valueRedacted === undefined
                              ? {}
                              : { valueRedacted: sensitive ? variable.valueRedacted : false }),
                          });
                        }}
                        aria-label={`Mark environment variable ${variable.name || index + 1} as sensitive`}
                      />
                    </div>
                  </TableCell>
                  <TableCell className="w-12">
                    <div className="flex justify-end">
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        className="size-8 text-muted-foreground hover:text-destructive"
                        onClick={() => removeVariable(variable.id)}
                        aria-label={`Remove environment variable ${variable.name || index + 1}`}
                      >
                        <XIcon className="size-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <span className="text-xs text-muted-foreground">
        Sensitive values are stored separately and are not returned to the app after saving.
      </span>
    </div>
  );
}

let primeManagedCommandSequence = 0;
function primeManagedCommandId(action: ServerPrimeManagedAction): string {
  primeManagedCommandSequence += 1;
  return `prime-managed:${action}:${Date.now()}:${primeManagedCommandSequence}`;
}

function PrimeManagedMaintenanceSection(props: {
  readonly environmentId: EnvironmentId | undefined;
  readonly instanceId: ProviderInstanceId;
  readonly readOnly: boolean;
  readonly distributionMessage: string | null;
}) {
  const target =
    props.environmentId === undefined
      ? null
      : serverEnvironment.primeManagedMaintenance({
          environmentId: props.environmentId,
          input: { instanceId: props.instanceId },
        });
  const { data, error, isPending, refresh } = useEnvironmentQuery(target);
  const runMaintenance = useAtomCommand(serverEnvironment.runPrimeManagedMaintenance, {
    reportFailure: false,
  });
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const [runningAction, setRunningAction] = useState<ServerPrimeManagedAction | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [previewConfirmed, setPreviewConfirmed] = useState(false);

  const run = async (
    action: ServerPrimeManagedAction,
    options: { readonly channel?: "stable" | "preview"; readonly buildId?: string } = {},
  ) => {
    if (props.environmentId === undefined || runningAction !== null) return;
    setRunningAction(action);
    setCommandError(null);
    const result = await runMaintenance({
      environmentId: props.environmentId,
      input: {
        commandId: primeManagedCommandId(action),
        instanceId: props.instanceId,
        action,
        ...(options.channel ? { channel: options.channel } : {}),
        ...(options.channel === "preview" ? { allowPreview: true } : {}),
        ...(options.buildId ? { buildId: options.buildId } : {}),
        scheduleIfBusy: true,
      },
    });
    setRunningAction(null);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const cause = squashAtomCommandFailure(result);
        setCommandError(cause instanceof Error ? cause.message : "Prime maintenance failed.");
      }
      return;
    }
    await refresh();
    await refreshProviders({ environmentId: props.environmentId, input: {} });
  };

  const maintenance = data as ServerPrimeManagedMaintenance | null;
  const queryError = error;
  const selectedBuildId = maintenance?.selectedBuildId ?? null;
  const operation = maintenance?.scheduled ?? maintenance?.operation ?? null;
  const canWrite = maintenance?.controlsAvailable === true && !props.readOnly;
  const stableAction: ServerPrimeManagedAction =
    maintenance?.mode === "managed" ? "update" : "install";

  return (
    <div className="grid max-w-lg gap-3 rounded-md border border-border/70 bg-muted/20 p-3">
      <div className="grid gap-1">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-medium text-foreground">Pylon-managed Prime</p>
          <Button type="button" size="xs" variant="ghost" onClick={refresh}>
            Refresh status
          </Button>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {maintenance?.message ??
            (isPending
              ? "Reading host maintenance status."
              : "Host maintenance status is unavailable.")}
        </p>
        {props.distributionMessage ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {props.distributionMessage}
          </p>
        ) : null}
        {maintenance?.guidance ? (
          <p className="text-xs leading-relaxed text-warning">{maintenance.guidance}</p>
        ) : null}
        {operation ? (
          <p
            className={cn(
              "text-xs leading-relaxed",
              operation.status === "failed" ? "text-destructive" : "text-muted-foreground",
            )}
          >
            <span className="font-medium capitalize">{operation.status.replaceAll("-", " ")}</span>
            {` · ${operation.message}`}
          </p>
        ) : null}
        {queryError || commandError ? (
          <p className="text-xs leading-relaxed text-destructive">
            {commandError ?? queryError} Check the environment connection and retry. The selected
            Prime binary was not changed unless the status above confirms the switch.
          </p>
        ) : null}
      </div>

      {maintenance?.supported === false ? null : (
        <div className="grid gap-2">
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="xs"
              disabled={!canWrite || runningAction !== null}
              onClick={() => void run(stableAction, { channel: "stable" })}
            >
              {runningAction === stableAction
                ? "Working…"
                : maintenance?.mode === "managed"
                  ? "Update stable"
                  : "Install stable"}
            </Button>
            {maintenance?.mode === "managed" ? (
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={!canWrite || runningAction !== null}
                onClick={() => void run("use-stock")}
              >
                Use stock/configured Prime
              </Button>
            ) : null}
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={!canWrite || runningAction !== null}
              onClick={() => void run("cleanup")}
            >
              Prune unreferenced builds
            </Button>
          </div>

          <label className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
            <Checkbox
              checked={previewConfirmed}
              disabled={!canWrite || runningAction !== null}
              onCheckedChange={(checked) => setPreviewConfirmed(Boolean(checked))}
              aria-label="Confirm Prime preview channel opt-in"
            />
            <span>I understand preview builds are less stable and explicitly opt in.</span>
          </label>
          <Button
            type="button"
            size="xs"
            variant="outline"
            className="w-fit"
            disabled={!canWrite || !previewConfirmed || runningAction !== null}
            onClick={() =>
              void run(maintenance?.mode === "managed" ? "update" : "install", {
                channel: "preview",
              })
            }
          >
            {runningAction === "install" || runningAction === "update"
              ? "Working…"
              : "Install/update preview"}
          </Button>

          {maintenance && maintenance.availableBuilds.length > 0 ? (
            <div className="grid gap-1.5 border-t border-border/60 pt-2">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Verified rollback builds
              </p>
              {maintenance.availableBuilds.map((build) => (
                <div
                  key={build.buildId}
                  className="flex min-w-0 items-center justify-between gap-2"
                >
                  <code className="min-w-0 truncate text-[11px] text-muted-foreground">
                    {build.buildId} · {build.channel} #{build.sequence}
                  </code>
                  {build.buildId === selectedBuildId ? (
                    <Badge size="sm" variant="secondary">
                      Selected
                    </Badge>
                  ) : (
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      disabled={!canWrite || runningAction !== null}
                      onClick={() => void run("rollback", { buildId: build.buildId })}
                    >
                      Roll back
                    </Button>
                  )}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

interface ProviderInstanceCardProps {
  readonly instanceId: ProviderInstanceId;
  /**
   * Enables the sign-in affordance. Optional because a card can render before
   * an environment is known, and an in-app sign-in needs a server to run the
   * provider CLI on.
   */
  readonly environmentId?: EnvironmentId | undefined;
  readonly instance: ProviderInstanceConfig;
  readonly driverOption: DriverOption | undefined;
  readonly liveProvider: ServerProvider | undefined;
  readonly mode: "list" | "editor";
  readonly selected?: boolean | undefined;
  readonly onSelect?: (() => void) | undefined;
  readonly readOnly?: boolean | undefined;
  readonly onUpdate: (nextInstance: ProviderInstanceConfig) => void;
  /**
   * Pass `undefined` to hide the delete button entirely. Built-in default
   * instance slots use `undefined` — they can't be deleted without losing
   * the slot, and their "reset to defaults" affordance lives on an outer
   * reset button instead. Explicit `| undefined` in the type accommodates
   * `exactOptionalPropertyTypes: true`, where an absent key and
   * `{ onDelete: undefined }` are treated as distinct shapes.
   */
  readonly onDelete?: (() => void) | undefined;
  /**
   * Optional outer reset button rendered next to the driver icon. Built-in
   * default slots supply a reset-to-factory control here; custom instances
   * omit it.
   */
  readonly headerAction?: ReactNode | undefined;
  /**
   * Drain-order controls for this account. Pass `undefined` when the driver
   * has a single account — order means nothing then, so the buttons are
   * absent rather than disabled. `onMoveUp` / `onMoveDown` are individually
   * `undefined` at the ends of the list.
   */
  readonly drainOrder?:
    | {
        readonly position: number;
        readonly total: number;
        readonly onMoveUp?: (() => void) | undefined;
        readonly onMoveDown?: (() => void) | undefined;
      }
    | undefined;
  readonly hiddenModels: ReadonlyArray<string>;
  readonly favoriteModels: ReadonlyArray<string>;
  readonly modelOrder: ReadonlyArray<string>;
  readonly onHiddenModelsChange: (next: ReadonlyArray<string>) => void;
  readonly onFavoriteModelsChange: (next: ReadonlyArray<string>) => void;
  readonly onModelOrderChange: (next: ReadonlyArray<string>) => void;
  readonly onRunUpdate?: (() => void) | undefined;
  readonly isUpdating?: boolean | undefined;
  readonly timestampFormat: TimestampFormat;
}

/**
 * Renders one provider instance as either a compact selectable list row or
 * the full editor shown beside that list. Both modes use the same enabled
 * state and provider metadata.
 *
 * Behavior notes:
 *   - `liveProvider` is matched by the caller via `instanceId`; when no
 *     match is available (e.g. the server hasn't probed yet, or the
 *     driver is not shipped by the current build) the card still renders
 *     with a neutral "checking" summary.
 *   - Unknown drivers (`driverOption === undefined`) get a read-only
 *     notice instead of editable fields, so fork instances round-trip
 *     without accidentally destroying their config.
 *   - The enabled Switch writes to the envelope's `instance.enabled`
 *     field, which is the single enabled flag: the server folds any legacy
 *     driver-specific `config.enabled` into the envelope on load and both
 *     sides resolve through `resolveProviderInstanceEnabled` (an explicit
 *     false wins, then envelope, then config, then the driver default).
 */
export function ProviderInstanceCard({
  instanceId,
  environmentId,
  instance,
  driverOption,
  liveProvider,
  mode,
  selected = false,
  onSelect,
  readOnly = false,
  onUpdate,
  onDelete,
  headerAction,
  drainOrder,
  hiddenModels,
  favoriteModels,
  modelOrder,
  onHiddenModelsChange,
  onFavoriteModelsChange,
  onModelOrderChange,
  onRunUpdate,
  isUpdating = false,
  timestampFormat,
}: ProviderInstanceCardProps) {
  const [activeTab, setActiveTab] = useState<"configuration" | "models">("configuration");
  const enabled = resolveProviderInstanceEnabled(instance);
  const unavailable = getProviderUnavailablePresentation(liveProvider);
  // An unavailable shadow is fail-closed as disabled, but its platform or
  // missing-driver reason is the actionable state. Otherwise local settings
  // still outrank a streamed probe that has not caught up yet.
  const statusKey: ProviderStatusKey = unavailable
    ? "error"
    : enabled
      ? ((liveProvider?.status as ProviderStatusKey | undefined) ?? "warning")
      : "disabled";
  const statusStyle = PROVIDER_STATUS_STYLES[statusKey];
  const rawSummary = getProviderSummary(liveProvider);
  const summary = unavailable
    ? unavailable
    : enabled
      ? rawSummary
      : { headline: "Disabled", detail: liveProvider?.message ?? null };
  const authEmail = liveProvider?.auth.email;
  const hasAuthenticatedEmail =
    liveProvider?.auth.status === "authenticated" && Boolean(authEmail?.trim());
  const authenticatedDetail = hasAuthenticatedEmail
    ? (liveProvider?.auth.label ?? liveProvider?.auth.type ?? null)
    : null;
  const [isSignInOpen, setIsSignInOpen] = useState(false);
  // Only offered when the account genuinely reads as signed out. "Unknown"
  // means the probe could not tell, and a sign-in would not fix that.
  const canSignIn =
    environmentId !== undefined &&
    enabled &&
    liveProvider?.auth.status === "unauthenticated" &&
    instance.driver === "claudeAgent";
  // Trouble states carry the server's explanation (a failed probe, a shadow
  // home entry that is not a symlink, a missing binary). It shows wherever the
  // headline shows, so a broken provider is actionable from the list.
  const needsAttention = statusKey === "warning" || statusKey === "error";
  const versionLabel = getProviderVersionLabel(liveProvider?.version);
  const distributionLabel = getProviderDistributionLabel(liveProvider?.distribution);
  const versionAdvisory = getProviderVersionAdvisoryPresentation(liveProvider?.versionAdvisory);
  const updateCommand = versionAdvisory?.updateCommand ?? null;
  const FallbackIconComponent = driverOption?.icon;
  const displayName =
    instance.displayName?.trim() || driverOption?.label || String(instance.driver);
  const accentColor = normalizeProviderAccentColor(instance.accentColor);
  const { copyToClipboard } = useCopyToClipboard<{ providerName: string }>({
    onCopy: ({ providerName }) => {
      toastManager.add({
        type: "success",
        title: `${providerName} update command copied`,
        description: "Run it in a terminal when you are ready to update.",
      });
    },
    onError: (error, { providerName }) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Could not copy ${providerName} update command`,
          description: error.message,
        }),
      );
    },
  });

  // Narrow `instance.driver` for callers that key on the closed
  // `ProviderDriverKind` union (e.g. `normalizeModelSlug`'s alias table). Custom
  // fork drivers pass through as `null` and those callers fall back to
  // verbatim behaviour.
  const driverKind: ProviderDriverKind | null = isProviderDriverKind(instance.driver)
    ? instance.driver
    : null;
  const visibleTab = driverOption === undefined ? "configuration" : activeTab;

  const customModels = readConfigStringArray(instance.config, "customModels");
  // Server-returned models may lag behind settings writes. Treat probe
  // models as the source for built-ins only; custom rows come directly
  // from the current instance config so add/remove reflects immediately.
  const modelsForDisplay = deriveProviderModelsForDisplay({
    liveModels: liveProvider?.models,
    customModels,
  });

  const updateDisplayName = (value: string) => {
    const trimmed = value.trim();
    const { displayName: _omit, ...rest } = instance;
    onUpdate(
      trimmed.length > 0
        ? ({ ...rest, displayName: trimmed } as ProviderInstanceConfig)
        : (rest as ProviderInstanceConfig),
    );
  };

  const updateEnabled = (value: boolean) => {
    onUpdate({ ...instance, enabled: value });
  };

  const updateAccentColor = (value: string) => {
    const normalized = normalizeProviderAccentColor(value);
    const { accentColor: _omit, ...rest } = instance;
    onUpdate(
      normalized
        ? ({ ...rest, accentColor: normalized } as ProviderInstanceConfig)
        : (rest as ProviderInstanceConfig),
    );
  };

  const updateConfig = (nextConfig: Record<string, unknown> | undefined) => {
    const { config: _omit, ...rest } = instance;
    onUpdate(
      nextConfig !== undefined
        ? ({ ...rest, config: nextConfig } as ProviderInstanceConfig)
        : (rest as ProviderInstanceConfig),
    );
  };

  const updateCustomModels = (next: ReadonlyArray<string>) => {
    const nextConfig = nextConfigBlobWithValue(instance.config, "customModels", [...next]);
    const { config: _omit, ...rest } = instance;
    onUpdate({ ...rest, config: nextConfig } as ProviderInstanceConfig);
  };

  const updateEnvironment = (environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>) => {
    const cleaned = environment.filter((variable) => variable.name.trim().length > 0);
    const { environment: _omit, ...rest } = instance;
    onUpdate(
      cleaned.length > 0
        ? ({ ...rest, environment: cleaned } as ProviderInstanceConfig)
        : (rest as ProviderInstanceConfig),
    );
  };

  const titleIconNode = driverKind ? (
    <ProviderInstanceIcon
      driverKind={driverKind}
      displayName={displayName}
      accentColor={accentColor}
      showBadge={Boolean(accentColor)}
      className="size-5"
      iconClassName="size-4 text-foreground/80"
      badgeClassName="right-[-0.125rem] bottom-[-0.125rem] h-3 min-w-3 px-0.5 text-[7px]"
    />
  ) : FallbackIconComponent ? (
    <span className="inline-flex size-5 shrink-0 items-center justify-center">
      <FallbackIconComponent className="size-4 text-foreground/80" aria-hidden />
    </span>
  ) : (
    <span
      className="inline-flex size-5 shrink-0 items-center justify-center text-[10px] font-semibold leading-none text-foreground/80"
      aria-hidden
    >
      {providerInstanceInitials(displayName)}
    </span>
  );

  const titleHeadNode = (
    <>
      {titleIconNode}
      <h3 className="truncate text-sm font-medium tracking-[-0.005em] text-foreground">
        {displayName}
      </h3>
      {String(instanceId) !== String(instance.driver) ? (
        <code className="truncate rounded bg-muted/60 px-1 py-0.5 text-[10px] text-muted-foreground">
          {instanceId}
        </code>
      ) : null}
      {driverOption?.badgeLabel ? (
        <Badge variant="warning" size="sm" className="shrink-0">
          {driverOption.badgeLabel}
        </Badge>
      ) : null}
    </>
  );

  const drainOrderNode = drainOrder ? (
    <span className="inline-flex shrink-0 items-center">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost"
              className="size-5 rounded-sm p-0 text-muted-foreground"
              disabled={!drainOrder.onMoveUp}
              onClick={drainOrder.onMoveUp}
              aria-label={`Use ${displayName} earlier (currently ${drainOrder.position + 1} of ${drainOrder.total})`}
            >
              <ChevronUpIcon className="size-3.5" />
            </Button>
          }
        />
        <TooltipPopup side="top">Use this account earlier</TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost"
              className="size-5 rounded-sm p-0 text-muted-foreground"
              disabled={!drainOrder.onMoveDown}
              onClick={drainOrder.onMoveDown}
              aria-label={`Use ${displayName} later (currently ${drainOrder.position + 1} of ${drainOrder.total})`}
            >
              <ChevronDownIcon className="size-3.5" />
            </Button>
          }
        />
        <TooltipPopup side="top">Use this account later</TooltipPopup>
      </Tooltip>
    </span>
  ) : null;

  const titleTailNode = (
    <>
      {drainOrderNode}
      {headerAction ? (
        <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
          {headerAction}
        </span>
      ) : null}
      {onDelete ? (
        <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-micro"
                  variant="ghost"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={onDelete}
                  aria-label={`Delete provider instance ${instanceId}`}
                >
                  <Trash2Icon className="size-3" />
                </Button>
              }
            />
            <TooltipPopup side="top">Delete instance</TooltipPopup>
          </Tooltip>
        </span>
      ) : null}
    </>
  );

  // Healthy and disabled rows read fine from their text; only trouble gets a dot.
  const statusDotNode = needsAttention ? (
    <span className={cn("size-1.5 shrink-0 rounded-full", statusStyle.dot)} aria-hidden />
  ) : null;
  const statusLineClassName =
    "flex min-w-0 flex-wrap items-center gap-x-1.5 text-[13px] leading-[1.45] text-muted-foreground/80";

  // The editor's status line. It doubles as the account identity row, so the
  // redacted email lives here rather than in the list, where a masked address
  // on every row would be noise you cannot act on. The line stays outside the
  // read-only inert wrapper so the email reveal keeps working; only the
  // sign-in write action freezes.
  const editorStatusNode = (
    <p className={statusLineClassName}>
      {statusDotNode}
      {hasAuthenticatedEmail ? (
        <>
          <span>Authenticated as</span>
          <ProviderAuthEmail email={authEmail} />
          {authenticatedDetail ? <span>· {authenticatedDetail}</span> : null}
        </>
      ) : (
        <>
          <span>{summary.headline}</span>
          <ProviderAuthEmail email={authEmail} separator prefix="Email" />
        </>
      )}
      {summary.detail && !needsAttention ? <span>· {summary.detail}</span> : null}
      {canSignIn ? (
        <span
          inert={readOnly}
          aria-disabled={readOnly || undefined}
          className={cn("inline-flex", readOnly && "opacity-50")}
        >
          <Button
            variant="outline"
            size="sm"
            className="ms-1 h-6 px-2 text-xs"
            onClick={() => setIsSignInOpen(true)}
          >
            Sign in
          </Button>
        </span>
      ) : null}
    </p>
  );

  const versionCodeNode = versionLabel ? (
    <code className="text-xs text-muted-foreground">{versionLabel}</code>
  ) : null;

  // The editor holds the advisory popover, but only for the selected account,
  // so the list needs its own marker or an outdated provider stays invisible
  // until you happen to click it. Not a button: the whole row is one already.
  const listUpdateMarkerNode = versionAdvisory ? (
    <span className="inline-flex shrink-0 items-center">
      <ArrowUpCircleIcon
        aria-hidden
        className={cn(
          "provider-update-marker size-3.5 motion-reduce:animate-none",
          versionAdvisory.emphasis === "strong" ? "text-warning" : "text-update-foreground",
        )}
      />
      <span className="sr-only">Update available</span>
    </span>
  ) : null;

  if (mode === "list") {
    return (
      <div
        className={cn(
          // Sidebar-style selection with an even row floor; the status line
          // clamps to two lines instead of growing. Pylon keeps a minimum
          // rather than a fixed height because a row may also carry the usage
          // summary, which upstream's card has no equivalent of.
          "group flex min-h-19 items-start gap-3 rounded-md px-3 py-2 transition-colors",
          // Foreground-alpha tint so the fill reads the same in light and dark themes.
          selected ? "bg-foreground/8" : "hover:bg-foreground/4",
        )}
      >
        <button
          type="button"
          className={cn(
            "flex min-w-0 flex-1 cursor-pointer items-start gap-3 rounded-sm text-left outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-ring",
            !enabled && !selected && "opacity-60 group-hover:opacity-100",
          )}
          onClick={onSelect}
          aria-pressed={selected}
        >
          {titleIconNode}
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-medium text-foreground">{displayName}</span>
              {String(instanceId) !== String(instance.driver) ? (
                <code className="min-w-0 truncate rounded bg-muted/60 px-1 py-0.5 text-[10px] text-muted-foreground">
                  {instanceId}
                </code>
              ) : null}
              {versionCodeNode}
              {listUpdateMarkerNode}
            </span>
            <span className="mt-0.5 flex items-start gap-1.5 text-[13px] leading-[1.45] text-muted-foreground/80">
              {statusDotNode ? (
                <span className="flex h-[1.45em] shrink-0 items-center">{statusDotNode}</span>
              ) : null}
              <span className="line-clamp-2 [overflow-wrap:anywhere]">
                {summary.headline}
                {needsAttention && summary.detail ? ` · ${summary.detail}` : null}
              </span>
            </span>
            {enabled && liveProvider?.usageLimits ? (
              <span className="mt-0.5 block min-w-0">
                <ProviderUsageSummary usageLimits={liveProvider.usageLimits} />
              </span>
            ) : null}
          </span>
        </button>
        <span className="flex h-5 shrink-0 items-center">
          <Switch
            checked={enabled}
            disabled={readOnly || unavailable !== null}
            onCheckedChange={(checked) => updateEnabled(Boolean(checked))}
            aria-label={`Enable ${displayName}`}
          />
        </span>
      </div>
    );
  }

  return (
    <div className="min-w-0 lg:flex lg:h-full lg:min-h-0 lg:flex-col">
      <div className="flex min-h-16 shrink-0 items-start justify-between gap-3 border-b border-border/70 px-4 py-3">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {titleHeadNode}
            {versionCodeNode}
            {distributionLabel ? (
              <code
                className="rounded bg-muted/60 px-1.5 py-0.5 text-[10px] text-muted-foreground"
                aria-label={liveProvider?.distribution?.message ?? distributionLabel}
              >
                {distributionLabel}
              </code>
            ) : null}
            {/*
              Only the write actions go inert on read-only sessions — the
              update popover, the drain-order chevrons, and the delete button.
              The status line below keeps its email reveal clickable.
            */}
            <span
              inert={readOnly}
              aria-disabled={readOnly || undefined}
              className={cn("inline-flex items-center gap-2", readOnly && "opacity-50")}
            >
              {versionAdvisory ? (
                <Popover>
                  <PopoverTrigger
                    render={
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        className={cn(
                          "size-5 rounded-sm p-0",
                          versionAdvisory.emphasis === "strong"
                            ? "text-warning hover:text-warning"
                            : "text-update-foreground hover:text-update-foreground",
                        )}
                        aria-label="Update available — view details"
                      >
                        <ArrowUpCircleIcon className="size-3.5" />
                      </Button>
                    }
                  />
                  <PopoverPopup
                    side="bottom"
                    align="start"
                    className="w-[min(21rem,calc(100vw-1.5rem))] [--popup-width:min(21rem,calc(100vw-1.5rem))]"
                  >
                    <div className="grid min-w-0 gap-3">
                      <div className="grid gap-0.5">
                        <p className="text-[13px] font-semibold leading-tight text-foreground">
                          Update available
                        </p>
                        <p
                          className={cn(
                            "text-xs leading-snug",
                            versionAdvisory.emphasis === "strong"
                              ? "text-warning"
                              : "text-muted-foreground",
                          )}
                        >
                          {versionAdvisory.detail}
                        </p>
                      </div>
                      {onRunUpdate ? (
                        <Button
                          type="button"
                          size="xs"
                          variant="default"
                          className="w-full"
                          disabled={isUpdating}
                          onClick={onRunUpdate}
                        >
                          {isUpdating ? <LoaderIcon className="animate-spin" /> : <DownloadIcon />}
                          {isUpdating ? "Updating" : "Update now"}
                        </Button>
                      ) : null}
                      {onRunUpdate && updateCommand ? (
                        <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                          <span aria-hidden className="h-px flex-1 bg-border" />
                          or, update manually using
                          <span aria-hidden className="h-px flex-1 bg-border" />
                        </div>
                      ) : null}
                      {updateCommand ? (
                        <div className="flex min-w-0 items-center gap-1 rounded-md border border-border/70 bg-muted/40 py-0.5 pr-0.5 pl-2">
                          <ScrollArea scrollFade className="h-8 min-w-0 flex-1 rounded-none">
                            <code className="flex h-full w-max items-center whitespace-nowrap pr-3 font-mono text-[11px] text-foreground">
                              {updateCommand}
                            </code>
                          </ScrollArea>
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <Button
                                  type="button"
                                  size="icon-xs"
                                  variant="ghost"
                                  className="size-6 shrink-0 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                                  onClick={() =>
                                    copyToClipboard(updateCommand, {
                                      providerName: displayName,
                                    })
                                  }
                                  aria-label="Copy update command"
                                >
                                  <CopyIcon className="size-3" />
                                </Button>
                              }
                            />
                            <TooltipPopup side="top">Copy command</TooltipPopup>
                          </Tooltip>
                        </div>
                      ) : null}
                    </div>
                  </PopoverPopup>
                </Popover>
              ) : null}
              {titleTailNode}
            </span>
          </div>
          {editorStatusNode}
          {summary.detail && needsAttention ? (
            <p className="text-[13px] leading-[1.45] text-muted-foreground/80 [overflow-wrap:anywhere]">
              {summary.detail}
            </p>
          ) : null}
        </div>
      </div>

      <div className="flex h-11 shrink-0 border-b border-border/70 px-1">
        <button
          type="button"
          aria-pressed={visibleTab === "configuration"}
          className={providerSettingsTabClassName(visibleTab === "configuration")}
          onClick={() => setActiveTab("configuration")}
        >
          Configuration
        </button>
        {driverOption !== undefined ? (
          <button
            type="button"
            aria-pressed={visibleTab === "models"}
            className={providerSettingsTabClassName(visibleTab === "models")}
            onClick={() => setActiveTab("models")}
          >
            Models
          </button>
        ) : null}
      </div>

      <div className="lg:min-h-0 lg:flex-1">
        <ScrollArea
          scrollFade
          chainVerticalScroll
          className="lg:h-full"
          hidden={visibleTab !== "configuration"}
        >
          <div
            inert={readOnly}
            aria-disabled={readOnly || undefined}
            className={cn("space-y-5 px-4 py-5", readOnly && "opacity-50 select-none")}
          >
            {enabled && liveProvider?.usageLimits ? (
              <div className="grid max-w-lg gap-2.5">
                <p className="text-xs font-medium text-foreground">Provider usage</p>
                <ProviderUsageRows
                  usageLimits={liveProvider.usageLimits}
                  timestampFormat={timestampFormat}
                />
              </div>
            ) : null}
            <div>
              <label htmlFor={`provider-instance-${instanceId}-display-name`} className="block">
                <span className="text-xs font-medium text-foreground">Display name</span>
                <DraftInput
                  id={`provider-instance-${instanceId}-display-name`}
                  className="mt-1.5"
                  value={instance.displayName ?? ""}
                  onCommit={updateDisplayName}
                  placeholder={driverOption?.label ?? "Instance label"}
                  spellCheck={false}
                />
                <span className="mt-1 block text-xs text-muted-foreground">
                  Optional label shown in the provider list.
                </span>
              </label>
            </div>

            <div>
              <ProviderAccentColorPicker
                displayName={displayName}
                value={accentColor}
                onCommit={updateAccentColor}
                commitDelayMs={120}
                description="Used to distinguish this instance in picker rails and model lists."
              />
            </div>

            {instance.driver === "primeAgent" ? (
              <PrimeManagedMaintenanceSection
                environmentId={environmentId}
                instanceId={instanceId}
                readOnly={readOnly}
                distributionMessage={liveProvider?.distribution?.message ?? null}
              />
            ) : null}

            <div>
              <ProviderEnvironmentSection
                environment={instance.environment ?? []}
                onChange={updateEnvironment}
              />
            </div>

            {instance.driver === "primeAgent" ? (
              <div className="grid max-w-lg gap-1.5 rounded-lg border border-border/70 bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">
                <p>{PRIME_AGENT_INSTANCE_GUIDANCE}</p>
                <p>{PRIME_AGENT_ACP_GUIDANCE}</p>
                <p>{PRIME_AGENT_MAINTENANCE_GUIDANCE}</p>
              </div>
            ) : null}

            {liveProvider?.supportsMultipleInstances === false &&
            liveProvider.multipleInstancesUnavailableReason ? (
              <p className="max-w-lg text-xs text-muted-foreground" role="status">
                {liveProvider.multipleInstancesUnavailableReason}
              </p>
            ) : null}

            {driverOption ? (
              <ProviderSettingsForm
                definition={driverOption}
                value={instance.config}
                idPrefix={`provider-instance-${instanceId}`}
                variant="card"
                onChange={updateConfig}
              />
            ) : null}

            {driverOption === undefined ? (
              <div>
                <p className="text-xs text-muted-foreground">
                  This instance uses a driver (
                  <code className="text-foreground">{String(instance.driver)}</code>) that is not
                  shipped with the current build. Configuration values are preserved but cannot be
                  edited from this surface.
                </p>
              </div>
            ) : null}
          </div>
        </ScrollArea>
        {driverOption !== undefined ? (
          <div
            inert={readOnly}
            aria-disabled={readOnly || undefined}
            className={cn("px-4 py-5 lg:h-full lg:min-h-0", readOnly && "opacity-50 select-none")}
            hidden={visibleTab !== "models"}
          >
            <ProviderModelsSection
              instanceId={instanceId}
              driverKind={driverKind}
              models={modelsForDisplay}
              customModels={customModels}
              hiddenModels={hiddenModels}
              favoriteModels={favoriteModels}
              modelOrder={modelOrder}
              onChange={updateCustomModels}
              onHiddenModelsChange={onHiddenModelsChange}
              onFavoriteModelsChange={onFavoriteModelsChange}
              onModelOrderChange={onModelOrderChange}
            />
          </div>
        ) : null}
      </div>
      {environmentId !== undefined ? (
        <ProviderSignInDialog
          open={isSignInOpen}
          onOpenChange={setIsSignInOpen}
          environmentId={environmentId}
          instanceId={instanceId}
          accountLabel={displayName}
          knownEmail={authEmail ?? undefined}
        />
      ) : null}
    </div>
  );
}
