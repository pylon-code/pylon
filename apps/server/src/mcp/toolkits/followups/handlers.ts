import { CommandId, FollowUpId, FollowUpOperationError } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";

import { FollowUpService } from "../../../followups/FollowUpService.ts";
import { requireFollowUpsEnabled } from "../../../followups/availability.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { FollowUpToolkit } from "./tools.ts";

const uuidError = () =>
  new FollowUpOperationError({
    code: "persistence",
    message: "A follow-up identifier could not be generated.",
  });

const handlers = {
  followup_file: (input) =>
    Effect.gen(function* () {
      const service = yield* FollowUpService;
      const invocation = yield* McpInvocationContext;
      yield* requireFollowUpsEnabled();
      const projectId = yield* service.projectIdForThread(invocation.threadId);
      const crypto = yield* Crypto.Crypto;
      const commandId = yield* crypto.randomUUIDv4.pipe(
        Effect.map(CommandId.make),
        Effect.mapError(uuidError),
      );
      const itemId = yield* crypto.randomUUIDv4.pipe(
        Effect.map(FollowUpId.make),
        Effect.mapError(uuidError),
      );
      return yield* service.file({
        ...input,
        commandId,
        itemId,
        projectId,
        sourceKind: "agent",
        sourceThreadId: invocation.threadId,
      });
    }),
  followup_list: (input) =>
    Effect.gen(function* () {
      const service = yield* FollowUpService;
      const invocation = yield* McpInvocationContext;
      yield* requireFollowUpsEnabled();
      const projectId = yield* service.projectIdForThread(invocation.threadId);
      const snapshot = yield* service.getSnapshot(projectId);
      return snapshot.items.filter(
        (item) =>
          (input.status === undefined || item.status === input.status) &&
          (input.kind === undefined || item.kind === input.kind),
      );
    }),
  followup_resolve: (input) =>
    Effect.gen(function* () {
      const service = yield* FollowUpService;
      const invocation = yield* McpInvocationContext;
      yield* requireFollowUpsEnabled();
      const projectId = yield* service.projectIdForThread(invocation.threadId);
      const crypto = yield* Crypto.Crypto;
      const commandId = yield* crypto.randomUUIDv4.pipe(
        Effect.map(CommandId.make),
        Effect.mapError(uuidError),
      );
      return yield* service.updateStatus({
        commandId,
        itemId: input.itemId,
        projectId,
        expectedRevision: input.expectedRevision,
        status: "resolved",
        actor: "agent",
        resolution: { ...input.resolution, threadId: invocation.threadId },
      });
    }),
  followup_check_gate: (input) =>
    Effect.gen(function* () {
      const service = yield* FollowUpService;
      const invocation = yield* McpInvocationContext;
      yield* requireFollowUpsEnabled();
      const projectId = yield* service.projectIdForThread(invocation.threadId);
      const blockers = yield* service.openBlockersForBranch(projectId, input.branchRef);
      return {
        blocked: blockers.length > 0,
        blockers: [...blockers],
      };
    }),
  followup_record_validation: (input) =>
    Effect.gen(function* () {
      const service = yield* FollowUpService;
      const invocation = yield* McpInvocationContext;
      yield* requireFollowUpsEnabled();
      const projectId = yield* service.projectIdForThread(invocation.threadId);
      const crypto = yield* Crypto.Crypto;
      const commandId = yield* crypto.randomUUIDv4.pipe(
        Effect.map(CommandId.make),
        Effect.mapError(uuidError),
      );
      return yield* service.recordValidation({
        ...input,
        commandId,
        projectId,
        threadId: invocation.threadId,
      });
    }),
} satisfies Parameters<typeof FollowUpToolkit.toLayer>[0];

export const FollowUpToolkitHandlersLive = FollowUpToolkit.toLayer(handlers);
