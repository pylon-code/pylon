import { CommandId, FollowUpId, FollowUpOperationError } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";

import { FollowUpService } from "../../../followups/FollowUpService.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { FollowUpToolkit } from "./tools.ts";

const uuidError = () =>
  new FollowUpOperationError({
    code: "persistence",
    message: "A follow-up identifier could not be generated.",
  });

const ensureFollowUpsEnabled = Effect.fn("FollowUpToolkit.ensureEnabled")(function* () {
  const settingsService = yield* ServerSettingsService;
  const settings = yield* settingsService.getSettings.pipe(
    Effect.mapError(
      () =>
        new FollowUpOperationError({
          code: "persistence",
          message: "Follow-up settings could not be read.",
        }),
    ),
  );
  if (!settings.followUpsEnabled) {
    return yield* new FollowUpOperationError({
      code: "forbidden",
      message: "Follow-ups are disabled in server settings.",
    });
  }
});

const handlers = {
  followup_file: (input) =>
    Effect.gen(function* () {
      const service = yield* FollowUpService;
      const invocation = yield* McpInvocationContext;
      yield* ensureFollowUpsEnabled();
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
        sourceKind: "agent",
        sourceThreadId: invocation.threadId,
      });
    }),
  followup_list: (input) =>
    Effect.gen(function* () {
      const service = yield* FollowUpService;
      yield* McpInvocationContext;
      yield* ensureFollowUpsEnabled();
      const snapshot = yield* service.getSnapshot;
      return snapshot.items.filter(
        (item) =>
          item.projectId === input.projectId &&
          (input.status === undefined || item.status === input.status) &&
          (input.kind === undefined || item.kind === input.kind),
      );
    }),
  followup_resolve: (input) =>
    Effect.gen(function* () {
      const service = yield* FollowUpService;
      yield* McpInvocationContext;
      yield* ensureFollowUpsEnabled();
      const crypto = yield* Crypto.Crypto;
      const commandId = yield* crypto.randomUUIDv4.pipe(
        Effect.map(CommandId.make),
        Effect.mapError(uuidError),
      );
      return yield* service.updateStatus({
        ...input,
        commandId,
        actor: "agent",
      });
    }),
  followup_check_gate: (input) =>
    Effect.gen(function* () {
      const service = yield* FollowUpService;
      yield* McpInvocationContext;
      yield* ensureFollowUpsEnabled();
      const blockers = yield* service.openBlockersForBranch(input.branchRef);
      return {
        blocked: blockers.length > 0,
        blockers: [...blockers],
      };
    }),
} satisfies Parameters<typeof FollowUpToolkit.toLayer>[0];

export const FollowUpToolkitHandlersLive = FollowUpToolkit.toLayer(handlers);
