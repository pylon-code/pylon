import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const DISABLED_AT = "2025-12-30T00:00:00.000Z";

function makeReadModel(input: {
  readonly autoSettleDisabledAt?: string | null;
  readonly settledOverride?: "settled" | "active" | null;
  /** Omits the field, as in a thread projected before the switch existed. */
  readonly predatesSwitch?: boolean;
}): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        pullRequests: [],
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: input.settledOverride ?? null,
        settledAt: input.settledOverride === "settled" ? NOW : null,
        ...(input.predatesSwitch === true
          ? {}
          : { autoSettleDisabledAt: input.autoSettleDisabledAt ?? null }),
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: NOW,
  };
}

const events = (event: Effect.Success<ReturnType<typeof decideOrchestrationCommand>>) =>
  Array.isArray(event) ? event : [event];

it.layer(NodeServices.layer)("thread.auto-settle.set decider", (it) => {
  it.effect("turning auto-settle off stamps autoSettleDisabledAt and updatedAt together", () =>
    Effect.gen(function* () {
      const [event] = events(
        yield* decideOrchestrationCommand({
          command: {
            type: "thread.auto-settle.set",
            commandId: CommandId.make("cmd-off"),
            threadId: ThreadId.make("thread-1"),
            enabled: false,
          },
          readModel: makeReadModel({}),
        }),
      );
      expect(event?.type).toBe("thread.auto-settle-set");
      if (event?.type === "thread.auto-settle-set") {
        expect(event.payload.autoSettleDisabledAt).toBe(event.payload.updatedAt);
        expect(event.payload.updatedAt).not.toBe(NOW);
      }
    }),
  );

  it.effect("turning it off again keeps the original stamp and updatedAt", () =>
    Effect.gen(function* () {
      const [event] = events(
        yield* decideOrchestrationCommand({
          command: {
            type: "thread.auto-settle.set",
            commandId: CommandId.make("cmd-off-again"),
            threadId: ThreadId.make("thread-1"),
            enabled: false,
          },
          readModel: makeReadModel({ autoSettleDisabledAt: DISABLED_AT }),
        }),
      );
      expect(event?.type).toBe("thread.auto-settle-set");
      if (event?.type === "thread.auto-settle-set") {
        expect(event.payload.autoSettleDisabledAt).toBe(DISABLED_AT);
        expect(event.payload.updatedAt).toBe(NOW);
      }
    }),
  );

  it.effect("turning auto-settle back on clears the stamp", () =>
    Effect.gen(function* () {
      const [event] = events(
        yield* decideOrchestrationCommand({
          command: {
            type: "thread.auto-settle.set",
            commandId: CommandId.make("cmd-on"),
            threadId: ThreadId.make("thread-1"),
            enabled: true,
          },
          readModel: makeReadModel({ autoSettleDisabledAt: DISABLED_AT }),
        }),
      );
      expect(event?.type).toBe("thread.auto-settle-set");
      if (event?.type === "thread.auto-settle-set") {
        expect(event.payload.autoSettleDisabledAt).toBeNull();
        expect(event.payload.updatedAt).not.toBe(NOW);
      }
    }),
  );

  it.effect("automatic settlement is rejected while auto-settle is off", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(
        decideOrchestrationCommand({
          command: {
            type: "thread.auto-settle",
            commandId: CommandId.make("cmd-auto"),
            threadId: ThreadId.make("thread-1"),
            snapshotSequence: 0,
            settledAt: NOW,
          },
          readModel: makeReadModel({ autoSettleDisabledAt: DISABLED_AT }),
        }),
      );
      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("a manual settle still works while auto-settle is off", () =>
    Effect.gen(function* () {
      const [event] = events(
        yield* decideOrchestrationCommand({
          command: {
            type: "thread.settle",
            commandId: CommandId.make("cmd-manual"),
            threadId: ThreadId.make("thread-1"),
          },
          readModel: makeReadModel({ autoSettleDisabledAt: DISABLED_AT }),
        }),
      );
      expect(event?.type).toBe("thread.settled");
    }),
  );

  const autoSettle = (readModel: OrchestrationReadModel) =>
    decideOrchestrationCommand({
      command: {
        type: "thread.auto-settle",
        commandId: CommandId.make("cmd-auto"),
        threadId: ThreadId.make("thread-1"),
        snapshotSequence: 0,
        settledAt: NOW,
      },
      readModel,
    });

  it.effect("a thread that predates the switch still settles automatically", () =>
    Effect.gen(function* () {
      const readModel = makeReadModel({ predatesSwitch: true });
      const [settled] = events(yield* autoSettle(readModel));
      expect(settled?.type).toBe("thread.settled");

      // Enabling what was never disabled keeps the null stamp and updatedAt.
      const [event] = events(
        yield* decideOrchestrationCommand({
          command: {
            type: "thread.auto-settle.set",
            commandId: CommandId.make("cmd-on-legacy"),
            threadId: ThreadId.make("thread-1"),
            enabled: true,
          },
          readModel,
        }),
      );
      expect(event?.type).toBe("thread.auto-settle-set");
      if (event?.type === "thread.auto-settle-set") {
        expect(event.payload.autoSettleDisabledAt).toBeNull();
        expect(event.payload.updatedAt).toBe(NOW);
      }
    }),
  );

  it.effect("automatic settlement resumes once auto-settle is turned back on", () =>
    Effect.gen(function* () {
      const blocked = yield* Effect.exit(
        autoSettle(makeReadModel({ autoSettleDisabledAt: DISABLED_AT })),
      );
      expect(blocked._tag).toBe("Failure");
      const [settled] = events(yield* autoSettle(makeReadModel({ autoSettleDisabledAt: null })));
      expect(settled?.type).toBe("thread.settled");
    }),
  );

  it.effect("rejects the switch on an archived thread", () =>
    Effect.gen(function* () {
      const base = makeReadModel({});
      const result = yield* Effect.exit(
        decideOrchestrationCommand({
          command: {
            type: "thread.auto-settle.set",
            commandId: CommandId.make("cmd-archived"),
            threadId: ThreadId.make("thread-1"),
            enabled: false,
          },
          readModel: {
            ...base,
            threads: base.threads.map((thread) => ({ ...thread, archivedAt: NOW })),
          },
        }),
      );
      expect(result._tag).toBe("Failure");
    }),
  );
});
