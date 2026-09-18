import type { PairExecutorPhase, PairState } from "@t3tools/client-runtime/state/pair";
import type { EnvironmentId, ModelSelection, ProviderInstanceId } from "@t3tools/contracts";

import type { ProviderInstanceEntry } from "../../providerInstances";
import type { ComposerControlSize } from "./ComposerControl";
import type { ModelEsque } from "./providerIconUtils";

/**
 * The composer's pair control: one click to pair this thread with an executor,
 * one more to choose the executor's model.
 *
 * STUB: written by the lead so the tests compile. The executor implements the
 * three exports; their names, props, and signatures must not change.
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
}

/** What the executor is doing, in the words the panel and the trigger's label use. */
export function pairPhaseLabel(_phase: PairExecutorPhase): string {
  throw new Error("PairControl.pairPhaseLabel is not implemented");
}

/** The popover's content. Exported so it can be rendered without opening a popover. */
export function PairControlPanel(_props: PairControlProps) {
  return null;
}

export function PairControl(_props: PairControlProps) {
  return null;
}
