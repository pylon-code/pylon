import * as NodeServices from "@effect/platform-node/NodeServices";
import type {
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  OrchestrationEvent,
  OrchestrationProjectShell,
  OrchestrationShellSnapshot,
  OrchestrationThreadShell,
  ProjectId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { CommandId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_URL_SECRET,
  PUBLISH_AGENT_ACTIVITY_SECRET,
} from "../cloud/config.ts";
import * as AgentAwarenessRelay from "./AgentAwarenessRelay.ts";

const encodeSecret = (value: string): Uint8Array => new TextEncoder().encode(value);

function makeMemorySecretStore() {
  const values = new Map<string, Uint8Array>();
  const store = {
    get: ((name) =>
      Effect.sync(() => {
        const value = values.get(name);
        return value === undefined ? Option.none() : Option.some(Uint8Array.from(value));
      })) satisfies ServerSecretStore.ServerSecretStore["Service"]["get"],
    set: ((name, value) =>
      Effect.sync(() => {
        values.set(name, Uint8Array.from(value));
      })) satisfies ServerSecretStore.ServerSecretStore["Service"]["set"],
    create: ((name, value) =>
      Effect.sync(() => {
        values.set(name, Uint8Array.from(value));
      })) satisfies ServerSecretStore.ServerSecretStore["Service"]["create"],
    getOrCreateRandom: ((name, bytes) =>
      Effect.sync(() => {
        const existing = values.get(name);
        if (existing) {
          return existing;
        }
        const generated = new Uint8Array(bytes);
        values.set(name, generated);
        return generated;
      })) satisfies ServerSecretStore.ServerSecretStore["Service"]["getOrCreateRandom"],
    remove: ((name) =>
      Effect.sync(() => {
        values.delete(name);
      })) satisfies ServerSecretStore.ServerSecretStore["Service"]["remove"],
  } satisfies ServerSecretStore.ServerSecretStore["Service"];
  return {
    store,
    setString: (name: string, value: string) => store.set(name, encodeSecret(value)),
  };
}

describe.sequential("AgentAwarenessRelay startup", () => {
  it.effect("does not alert for historical completions after startup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const secrets = makeMemorySecretStore();
        const now = yield* DateTime.now;
        const old = DateTime.formatIso(DateTime.add(now, { days: -7 }));
        const afterStartup = DateTime.formatIso(DateTime.add(now, { minutes: 1 }));
        const threadId = "thread-old" as ThreadId;
        const freshDoneThreadId = "thread-new-done" as ThreadId;
        const invalidatedThreadId = "thread-new-admission" as ThreadId;
        const projectId = "project-1" as ProjectId;
        const environmentId = "env-1" as EnvironmentId;
        const project = {
          id: projectId,
          title: "T3 Code",
          workspaceRoot: "/workspace",
          repositoryIdentity: null,
          defaultModelSelection: null,
          scripts: [],
          createdAt: old,
          updatedAt: old,
        } satisfies OrchestrationProjectShell;
        const completedTurn = {
          turnId: "turn-1" as TurnId,
          state: "completed",
          requestedAt: old,
          startedAt: old,
          completedAt: old,
          assistantMessageId: null,
        } as const;
        const completedThread = {
          id: threadId,
          projectId,
          title: "Old task",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          pullRequests: [],
          latestTurn: completedTurn,
          createdAt: old,
          updatedAt: old,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          session: null,
          latestUserMessageAt: old,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
        } satisfies OrchestrationThreadShell;
        let currentThread: OrchestrationThreadShell | null = completedThread;
        let resolveFreshDoneQuery: (() => void) | undefined;
        const freshDoneQuery = new Promise<void>((resolve) => {
          resolveFreshDoneQuery = resolve;
        });
        let watchFreshDoneQuery = false;
        let invalidatedQueries = 0;
        let resolveInvalidatedQueries: (() => void) | undefined;
        const invalidatedQuery = new Promise<void>((resolve) => {
          resolveInvalidatedQueries = resolve;
        });
        let freshDoneQueries = 0;
        let resolveFreshReadyQuery: (() => void) | undefined;
        const freshReadyQuery = new Promise<void>((resolve) => {
          resolveFreshReadyQuery = resolve;
        });
        let publishes = 0;
        const publishPaths: string[] = [];
        const countFor = (id: ThreadId) =>
          publishPaths.filter((path) => path.includes(`/threads/${id}/`)).length;
        let expectedThreadId = threadId;
        let resolveNewQuery: (() => void) | undefined;
        const newQuery = new Promise<void>((resolve) => {
          resolveNewQuery = resolve;
        });
        let resolvePublished: (() => void) | undefined;
        const published = new Promise<void>((resolve) => {
          resolvePublished = resolve;
        });
        const events = yield* Queue.unbounded<OrchestrationEvent>();
        const originalFetch = globalThis.fetch;
        globalThis.fetch = ((input: Parameters<typeof fetch>[0]) => {
          publishes += 1;
          const path = String(input);
          publishPaths.push(path);
          if (path.includes(`/threads/${expectedThreadId}/`)) resolvePublished?.();
          return Promise.resolve(Response.json({ ok: true, deliveries: [] }));
        }) as unknown as typeof fetch;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            globalThis.fetch = originalFetch;
          }),
        );
        yield* secrets.setString(RELAY_URL_SECRET, "https://relay.example.test");
        yield* secrets.setString(RELAY_ENVIRONMENT_CREDENTIAL_SECRET, "relay-credential");
        yield* secrets.setString(PUBLISH_AGENT_ACTIVITY_SECRET, "true");

        const layer = Layer.mergeAll(
          Layer.succeed(ServerSecretStore.ServerSecretStore, secrets.store),
          Layer.succeed(ServerEnvironment.ServerEnvironment, {
            getEnvironmentId: Effect.succeed(environmentId),
            getDescriptor: Effect.succeed({
              environmentId,
              label: "Test Desktop",
              platform: { os: "darwin", arch: "arm64" },
              serverVersion: "0.0.0-test",
              capabilities: { repositoryIdentity: true },
            } satisfies ExecutionEnvironmentDescriptor),
          }),
          Layer.succeed(OrchestrationEngineService, {
            streamDomainEvents: Stream.fromQueue(events),
          } as OrchestrationEngineShape),
          Layer.succeed(ProjectionSnapshotQuery, {
            getShellSnapshot: () =>
              Effect.succeed({
                snapshotSequence: 1,
                projects: [project],
                threads: currentThread ? [currentThread] : [],
                updatedAt: old,
              } satisfies OrchestrationShellSnapshot),
            getThreadShellById: (requestedThreadId: ThreadId) =>
              Effect.sync(() => {
                if (currentThread?.session?.lastError === "new failure") resolveNewQuery?.();
                if (requestedThreadId === invalidatedThreadId) {
                  invalidatedQueries += 1;
                  if (invalidatedQueries >= 3) resolveInvalidatedQueries?.();
                }
                if (watchFreshDoneQuery && currentThread?.id === freshDoneThreadId) {
                  freshDoneQueries += 1;
                  resolveFreshDoneQuery?.();
                  if (freshDoneQueries >= 2) resolveFreshReadyQuery?.();
                }
                return Option.fromNullishOr(
                  currentThread?.id === requestedThreadId ? currentThread : null,
                );
              }),
            getProjectShellById: () => Effect.succeed(Option.some(project)),
          } as unknown as ProjectionSnapshotQueryShape),
        );

        yield* Effect.gen(function* () {
          const relay = yield* AgentAwarenessRelay.AgentAwarenessRelay;
          yield* relay.start();
          yield* relay.publishThread(threadId);
          expect(publishes).toBe(0);

          currentThread = {
            ...completedThread,
            latestTurn: null,
            latestUserMessageAt: DateTime.formatIso(DateTime.add(now, { seconds: 1 })),
            session: {
              threadId,
              status: "ready",
              providerName: "Codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: DateTime.formatIso(DateTime.add(now, { seconds: 2 })),
            },
          };
          expect(
            AgentAwarenessRelay.resolveAgentAwarenessRelayPublishSnapshot({
              environmentId,
              threadId,
              thread: Option.some(currentThread),
              project: Option.some(project),
            }).state?.phase,
          ).toBe("completed");
          yield* relay.publishThread(threadId);
          expect(publishes).toBe(0);

          currentThread = {
            ...completedThread,
            session: {
              threadId,
              status: "error",
              providerName: "Codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: "old failure",
              updatedAt: old,
            },
          };
          yield* relay.publishThread(threadId);
          expect(publishes).toBe(0);

          currentThread = {
            ...completedThread,
            latestTurn: null,
            session: {
              threadId,
              status: "error",
              providerName: "Codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: "new failure",
              updatedAt: afterStartup,
            },
          };
          yield* Queue.offer(events, {
            type: "thread.session-set",
            sequence: 1,
            eventId: "event-new-failure",
            commandId: CommandId.make("command-new-failure"),
            aggregateKind: "thread",
            aggregateId: threadId,
            actor: { kind: "provider" },
            metadata: {},
            payload: { threadId, session: currentThread.session },
            occurredAt: afterStartup,
          } as unknown as OrchestrationEvent);
          yield* Effect.promise(() => newQuery);
          yield* Effect.promise(() => published);
          expect(publishes).toBe(1);

          let resolveCompleted: (() => void) | undefined;
          const completed = new Promise<void>((resolve) => {
            resolveCompleted = resolve;
          });
          resolvePublished = resolveCompleted;
          currentThread = {
            ...completedThread,
            latestTurn: null,
            session: {
              threadId,
              status: "ready",
              providerName: "Codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: afterStartup,
            },
          };
          yield* Queue.offer(events, {
            type: "thread.session-set",
            sequence: 2,
            eventId: "event-fast-completion",
            commandId: CommandId.make("command-fast-completion"),
            aggregateKind: "thread",
            aggregateId: threadId,
            actor: { kind: "provider" },
            metadata: {},
            payload: { threadId, session: { ...currentThread.session, status: "running" } },
            occurredAt: afterStartup,
          } as unknown as OrchestrationEvent);
          yield* Queue.offer(events, {
            type: "thread.session-set",
            sequence: 3,
            eventId: "event-fast-completion-ready",
            commandId: CommandId.make("command-fast-completion-ready"),
            aggregateKind: "thread",
            aggregateId: threadId,
            actor: { kind: "provider" },
            metadata: {},
            payload: { threadId, session: currentThread.session },
            occurredAt: afterStartup,
          } as unknown as OrchestrationEvent);
          yield* Effect.promise(() => completed);
          expect(publishes).toBe(2);

          expectedThreadId = freshDoneThreadId;
          currentThread = {
            ...completedThread,
            id: freshDoneThreadId,
            latestTurn: null,
            session: {
              threadId: freshDoneThreadId,
              status: "ready",
              providerName: "Codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: afterStartup,
            },
          };
          yield* relay.publishThread(freshDoneThreadId);
          expect(countFor(freshDoneThreadId)).toBe(0);
          let resolveFirstDone: (() => void) | undefined;
          const firstDone = new Promise<void>((resolve) => {
            resolveFirstDone = resolve;
          });
          resolvePublished = resolveFirstDone;
          watchFreshDoneQuery = true;
          yield* Queue.offer(events, {
            type: "thread.session-set",
            sequence: 4,
            eventId: "event-first-done",
            commandId: CommandId.make("command-first-done"),
            aggregateKind: "thread",
            aggregateId: freshDoneThreadId,
            actor: { kind: "provider" },
            metadata: {},
            payload: {
              threadId: freshDoneThreadId,
              session: { ...currentThread.session, status: "running" },
            },
            occurredAt: afterStartup,
          } as unknown as OrchestrationEvent);
          yield* Effect.promise(() => freshDoneQuery);
          expect(countFor(freshDoneThreadId)).toBe(0);
          yield* Queue.offer(events, {
            type: "thread.session-set",
            sequence: 5,
            eventId: "event-first-done-ready",
            commandId: CommandId.make("command-first-done-ready"),
            aggregateKind: "thread",
            aggregateId: freshDoneThreadId,
            actor: { kind: "provider" },
            metadata: {},
            payload: { threadId: freshDoneThreadId, session: currentThread.session },
            occurredAt: afterStartup,
          } as unknown as OrchestrationEvent);
          yield* Effect.promise(() => freshReadyQuery);
          yield* Effect.yieldNow;
          expect(countFor(freshDoneThreadId)).toBe(0);
          yield* TestClock.adjust("5 seconds");
          yield* Effect.promise(() => firstDone);
          expect(countFor(freshDoneThreadId)).toBe(1);

          let resolveTombstone: (() => void) | undefined;
          const tombstone = new Promise<void>((resolve) => {
            resolveTombstone = resolve;
          });
          resolvePublished = resolveTombstone;
          currentThread = null;
          yield* relay.publishThread(freshDoneThreadId);
          expect(countFor(freshDoneThreadId), publishPaths.join(", ")).toBe(1);
          yield* TestClock.adjust("5 seconds");
          yield* Effect.promise(() => tombstone);
          expect(countFor(freshDoneThreadId)).toBe(2);
          yield* relay.publishThread(freshDoneThreadId);
          expect(countFor(freshDoneThreadId)).toBe(2);

          // A new admission invalidates the prior Done proof while the shell
          // still projects the previous ready state.
          currentThread = {
            ...completedThread,
            id: invalidatedThreadId,
            latestTurn: { ...completedTurn, completedAt: afterStartup },
            session: {
              threadId: invalidatedThreadId,
              status: "ready",
              providerName: "Codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: afterStartup,
            },
          };
          yield* Queue.offer(events, {
            type: "thread.session-set",
            sequence: 6,
            eventId: "event-admission-running",
            commandId: CommandId.make("command-admission-running"),
            aggregateKind: "thread",
            aggregateId: invalidatedThreadId,
            actor: { kind: "provider" },
            metadata: {},
            payload: {
              threadId: invalidatedThreadId,
              session: { ...currentThread.session, status: "running" },
            },
            occurredAt: afterStartup,
          } as unknown as OrchestrationEvent);
          yield* Queue.offer(events, {
            type: "thread.session-set",
            sequence: 7,
            eventId: "event-admission-ready",
            commandId: CommandId.make("command-admission-ready"),
            aggregateKind: "thread",
            aggregateId: invalidatedThreadId,
            actor: { kind: "provider" },
            metadata: {},
            payload: { threadId: invalidatedThreadId, session: currentThread.session },
            occurredAt: afterStartup,
          } as unknown as OrchestrationEvent);
          yield* Queue.offer(events, {
            type: "thread.session-set",
            sequence: 8,
            eventId: "event-new-admission-starting",
            commandId: CommandId.make("command-new-admission-starting"),
            aggregateKind: "thread",
            aggregateId: invalidatedThreadId,
            actor: { kind: "provider" },
            metadata: {},
            payload: {
              threadId: invalidatedThreadId,
              session: { ...currentThread.session, status: "starting" },
            },
            occurredAt: afterStartup,
          } as unknown as OrchestrationEvent);
          yield* Effect.promise(() => invalidatedQuery);
          yield* TestClock.adjust("5 seconds");
          expect(countFor(invalidatedThreadId)).toBe(0);
        }).pipe(
          Effect.provide(
            AgentAwarenessRelay.layer.pipe(
              Layer.provide(layer),
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        );
      }),
    ),
  );
});
