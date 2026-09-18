import type { PairExecutorPhase, PairState } from "@t3tools/client-runtime/state/pair";
import type { EnvironmentId, ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { UsersIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Switch } from "../ui/switch";
import { ComposerControl, type ComposerControlSize } from "./ComposerControl";
import { ProviderModelPicker } from "./ProviderModelPicker";
import { getTriggerDisplayModelLabel, type ModelEsque } from "./providerIconUtils";

/**
 * The composer's pair control: one click to pair this thread with an executor,
 * one more to choose the executor's model.
 */
export interface PairControlProps {
  readonly state: PairState;
  /** The executor's own model when the pair is on; the pending or default choice when off. */
  readonly executorSelection: ModelSelection | null;
  readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  readonly environmentId: EnvironmentId;
  readonly size?: ComposerControlSize;
  /** Why the switch cannot change right now, such as the lead being mid-turn. */
  readonly lockedReason?: string | null;
  readonly onToggle: (on: boolean) => void;
  readonly onExecutorChange: (instanceId: ProviderInstanceId, model: string) => void;
  /** Stops the executor's running turn. The button shows only while it holds one. */
  readonly onStopExecutor?: () => void;
}

/**
 * Where the executor picker opens when nothing is chosen yet: the first provider
 * that actually offers models. Opening on a provider with none shows "No models
 * found", which reads as though pairing were unavailable.
 */
export function initialExecutorInstanceId(
  entries: ReadonlyArray<ProviderInstanceEntry>,
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>,
): ProviderInstanceId | undefined {
  const withModels = entries.find(
    (entry) => (modelOptionsByInstance.get(entry.instanceId)?.length ?? 0) > 0,
  );
  return (withModels ?? entries[0])?.instanceId;
}

/** What the executor is doing, in the words the panel and the trigger's label use. */
export function pairPhaseLabel(phase: PairExecutorPhase): string {
  switch (phase) {
    case "idle":
      return "Waiting for a brief";
    case "running":
      return "Working";
    case "needs-approval":
      return "Needs your approval";
    case "needs-input":
      return "Has a question";
    case "completed":
      return "Finished";
    case "interrupted":
      return "Stopped";
    case "error":
      return "Failed";
  }
}

function executorLabel(
  props: Pick<PairControlProps, "executorSelection" | "modelOptionsByInstance">,
): string | null {
  if (props.executorSelection === null) {
    return null;
  }
  const options = props.modelOptionsByInstance.get(props.executorSelection.instanceId);
  const found = options?.find((option) => option.slug === props.executorSelection?.model);
  if (found) {
    return getTriggerDisplayModelLabel(found);
  }
  return props.executorSelection.model;
}

function switchDisabledReason(
  props: Pick<PairControlProps, "state" | "lockedReason" | "executorSelection">,
): string | null {
  if (props.state.kind === "unsupported-lead") {
    return props.state.reason;
  }
  if (typeof props.lockedReason === "string" && props.lockedReason.length > 0) {
    return props.lockedReason;
  }
  if (props.state.kind === "off" && props.executorSelection === null) {
    return "Choose an executor model first.";
  }
  return null;
}

function needsAttention(state: PairState): boolean {
  return state.kind === "on" && (state.phase === "needs-approval" || state.phase === "needs-input");
}

/** The popover's content. Exported so it can be rendered without opening a popover. */
export function PairControlPanel(props: PairControlProps) {
  const disabledReason = switchDisabledReason(props);
  const isSwitchDisabled = disabledReason !== null;

  const activeInstanceId =
    props.executorSelection?.instanceId ??
    initialExecutorInstanceId(props.instanceEntries, props.modelOptionsByInstance);
  const model = props.executorSelection?.model ?? "";

  return (
    <div data-pair-panel className="flex flex-col gap-2.5 p-[var(--floating-content-inset)]">
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium text-foreground text-xs">Pair</span>
        <div data-pair-switch-disabled={isSwitchDisabled ? "true" : "false"}>
          <Switch
            aria-label="Pair with an executor"
            size="sm"
            checked={props.state.kind === "on"}
            disabled={isSwitchDisabled}
            onCheckedChange={(checked) => props.onToggle(checked)}
          />
        </div>
      </div>

      <p className="text-pretty text-xs leading-4 text-muted-foreground">
        The lead plans, briefs, and checks. A faster, cheaper executor implements in the same
        worktree.
      </p>

      {disabledReason !== null && (
        <p data-pair-reason className="text-pretty text-xs leading-4 text-muted-foreground">
          {disabledReason}
        </p>
      )}

      <div className="flex flex-col gap-1.5 border-border/70 border-t pt-2">
        <div className="flex items-center justify-between gap-3">
          <span className="font-medium text-muted-foreground text-xs">Executor</span>
          {activeInstanceId !== undefined && (
            <ProviderModelPicker
              triggerAriaLabel="Executor model"
              triggerVariant="outline"
              size="xs"
              lockedProvider={null}
              instanceEntries={props.instanceEntries}
              modelOptionsByInstance={props.modelOptionsByInstance}
              onInstanceModelChange={props.onExecutorChange}
              activeInstanceId={activeInstanceId}
              model={model}
              {...(props.executorSelection === null ? { triggerLabel: "Choose model" } : {})}
              disabled={props.state.kind !== "off"}
            />
          )}
        </div>
        {props.state.kind === "on" && (
          <p className="text-[11px] leading-4 text-muted-foreground">
            Turn the pair off to change the executor.
          </p>
        )}
      </div>

      {props.state.kind === "on" && (
        <div
          data-pair-phase={props.state.phase}
          className="flex flex-col gap-1 border-border/70 border-t pt-2 text-xs"
        >
          <div className="flex items-center justify-between gap-3">
            <span className="font-medium text-foreground">{pairPhaseLabel(props.state.phase)}</span>
            <Link
              to="/$environmentId/$threadId"
              params={{
                environmentId: props.environmentId,
                threadId: props.state.executorId,
              }}
              className="font-medium text-primary hover:underline"
            >
              Open executor
            </Link>
          </div>
          {props.state.activity !== null && (
            <p
              className={cn(
                "text-pretty text-xs leading-4",
                props.state.phase === "error" ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {props.state.activity}
            </p>
          )}
          {props.onStopExecutor !== undefined &&
            (props.state.phase === "running" ||
              props.state.phase === "needs-approval" ||
              props.state.phase === "needs-input") && (
              <button
                type="button"
                data-pair-stop
                onClick={props.onStopExecutor}
                className="self-start font-medium text-destructive text-xs hover:underline"
              >
                Stop executor
              </button>
            )}
        </div>
      )}
    </div>
  );
}

export function PairControl(props: PairControlProps) {
  const isUnsupported = props.state.kind === "unsupported-lead";
  const isOn = props.state.kind === "on";
  const attention = needsAttention(props.state);
  const exLabel = executorLabel(props);

  const pairState = isUnsupported ? "unsupported" : isOn ? "on" : "off";
  const ariaLabel = isUnsupported
    ? "Pair unavailable"
    : isOn
      ? `Pair with ${exLabel ?? "executor"}: ${pairPhaseLabel(props.state.phase)}`
      : "Pair: off";

  const spanText = isOn ? (exLabel ?? "executor") : "Pair";

  return (
    <Popover>
      <PopoverTrigger
        render={
          <ComposerControl
            variant="ghost"
            size={props.size ?? "sm"}
            data-pair-control
            data-pair-state={pairState}
            data-pair-attention={attention ? "true" : undefined}
            aria-label={ariaLabel}
            aria-pressed={isOn}
            className={cn(isUnsupported && "opacity-60")}
          />
        }
      >
        <UsersIcon className="size-3.5 shrink-0" aria-hidden="true" />
        <span>{spanText}</span>
        {attention && <span className="size-1.5 rounded-full bg-info" aria-hidden="true" />}
      </PopoverTrigger>
      <PopoverPopup
        side="top"
        align="start"
        className="w-72 max-w-none text-left whitespace-normal"
        viewportClassName="overflow-y-auto p-0"
      >
        <PairControlPanel {...props} />
      </PopoverPopup>
    </Popover>
  );
}
