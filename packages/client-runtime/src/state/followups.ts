import {
  WS_METHODS,
  type FollowUp,
  type FollowUpSnapshot,
  type FollowUpStreamItem,
} from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { subscribe } from "../rpc/client.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentSubscriptionAtomFamily,
} from "./runtime.ts";

export interface FollowUpClientState {
  readonly snapshot: FollowUpSnapshot;
  readonly synchronized: boolean;
}

export const EMPTY_FOLLOW_UP_CLIENT_STATE: FollowUpClientState = Object.freeze({
  snapshot: Object.freeze({ sequence: 0, items: Object.freeze([]) }),
  synchronized: false,
});

function sortItems(items: Iterable<FollowUp>): FollowUp[] {
  return [...items].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
}

export function applyFollowUpStreamItem(
  state: FollowUpClientState,
  item: FollowUpStreamItem,
): FollowUpClientState {
  if (item.kind === "snapshot") {
    return {
      snapshot: {
        ...item.snapshot,
        items: sortItems(item.snapshot.items),
      },
      synchronized: true,
    };
  }
  if (!state.synchronized || item.event.sequence <= state.snapshot.sequence) {
    return state;
  }

  const items = new Map(state.snapshot.items.map((candidate) => [candidate.id, candidate]));
  items.set(item.event.payload.item.id, item.event.payload.item);

  return {
    synchronized: true,
    snapshot: {
      sequence: item.event.sequence,
      items: sortItems(items.values()),
    },
  };
}

export function createFollowUpEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const commandScheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  };

  return {
    list: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:follow-ups:list",
      subscribe: (_input: null) =>
        subscribe(WS_METHODS.followUpSubscribe, {}).pipe(
          Stream.scan(EMPTY_FOLLOW_UP_CLIENT_STATE, applyFollowUpStreamItem),
        ),
    }),
    file: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:follow-ups:file",
      tag: WS_METHODS.followUpFile,
      scheduler: commandScheduler,
      concurrency,
    }),
    updateStatus: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:follow-ups:update-status",
      tag: WS_METHODS.followUpUpdateStatus,
      scheduler: commandScheduler,
      concurrency,
    }),
  };
}
