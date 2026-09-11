import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";

import {
  buildPendingNewTasks,
  makeListedNewTaskDraftsAtom,
  type PendingNewTask,
} from "./pending-new-tasks-model";
import { flattenQueuedThreadMessages } from "./thread-outbox-model";
import { composerDraftsAtom } from "./use-composer-drafts";
import { useThreadOutboxMessages } from "./use-thread-outbox";

// The draft store changes on every keystroke in any composer; the lists only
// need the stamped new-task drafts that have content.
const listedNewTaskDraftsAtom = makeListedNewTaskDraftsAtom(composerDraftsAtom).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:pending-new-tasks:listed-drafts"),
);

export type {
  PendingDraftTask,
  PendingNewTask,
  PendingQueuedTask,
} from "./pending-new-tasks-model";

export function usePendingNewTasks(): ReadonlyArray<PendingNewTask> {
  const queuedMessagesByThreadKey = useThreadOutboxMessages();
  const drafts = useAtomValue(listedNewTaskDraftsAtom);
  return useMemo(
    () =>
      buildPendingNewTasks({
        queuedMessages: flattenQueuedThreadMessages(queuedMessagesByThreadKey),
        drafts,
      }),
    [queuedMessagesByThreadKey, drafts],
  );
}
