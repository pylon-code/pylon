import {
  KANBAN_STATUSES,
  WS_METHODS,
  type KanbanSnapshot,
  type KanbanStreamItem,
  type KanbanWorkItem,
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

export interface KanbanClientState {
  readonly snapshot: KanbanSnapshot;
  readonly synchronized: boolean;
}

export const EMPTY_KANBAN_CLIENT_STATE: KanbanClientState = Object.freeze({
  snapshot: Object.freeze({ sequence: 0, items: Object.freeze([]) }),
  synchronized: false,
});

const statusOrder = new Map(KANBAN_STATUSES.map((status, index) => [status, index]));

function sortItems(items: Iterable<KanbanWorkItem>): KanbanWorkItem[] {
  return [...items].sort(
    (left, right) =>
      Number(left.archivedAt !== null) - Number(right.archivedAt !== null) ||
      (statusOrder.get(left.status) ?? 0) - (statusOrder.get(right.status) ?? 0) ||
      left.position - right.position ||
      left.id.localeCompare(right.id),
  );
}

export function applyKanbanStreamItem(
  state: KanbanClientState,
  item: KanbanStreamItem,
): KanbanClientState {
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
  for (const position of item.event.payload.positions) {
    const current = items.get(position.itemId);
    if (current !== undefined) {
      items.set(position.itemId, {
        ...current,
        status: position.status,
        position: position.position,
      });
    }
  }

  return {
    synchronized: true,
    snapshot: {
      sequence: item.event.sequence,
      items: sortItems(items.values()),
    },
  };
}

export function createKanbanEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const commandScheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  };

  return {
    board: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:kanban:board",
      subscribe: (_input: null) =>
        subscribe(WS_METHODS.kanbanSubscribe, {}).pipe(
          Stream.scan(EMPTY_KANBAN_CLIENT_STATE, applyKanbanStreamItem),
        ),
    }),
    create: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:kanban:create",
      tag: WS_METHODS.kanbanCreateWorkItem,
      scheduler: commandScheduler,
      concurrency,
    }),
    update: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:kanban:update",
      tag: WS_METHODS.kanbanUpdateWorkItem,
      scheduler: commandScheduler,
      concurrency,
    }),
    move: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:kanban:move",
      tag: WS_METHODS.kanbanMoveWorkItem,
      scheduler: commandScheduler,
      concurrency,
    }),
    archive: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:kanban:archive",
      tag: WS_METHODS.kanbanArchiveWorkItem,
      scheduler: commandScheduler,
      concurrency,
    }),
    restore: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:kanban:restore",
      tag: WS_METHODS.kanbanRestoreWorkItem,
      scheduler: commandScheduler,
      concurrency,
    }),
  };
}
