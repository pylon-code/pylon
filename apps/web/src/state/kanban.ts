import { createKanbanEnvironmentAtoms } from "@t3tools/client-runtime/state/kanban";

import { connectionAtomRuntime } from "../connection/runtime";

export const kanbanEnvironment = createKanbanEnvironmentAtoms(connectionAtomRuntime);
