import { pairExecutorThreadId } from "@t3tools/shared/delegatedThreads";
import * as NodeCrypto from "node:crypto";

import {
  CheckpointRef,
  CommandId,
  EnvironmentId,
  GitCommandError,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type DelegationChildRuntimeMode,
  type ModelSelection,
  type OrchestrationCheckpointSummary,
  type OrchestrationCommand,
  type OrchestrationLatestTurn,
  type OrchestrationMessage,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type ProjectSettingsOverrides,
  type ServerProvider,
  type VcsStatusLocalResult,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type { Tool } from "effect/unstable/ai";

import * as ServerConfig from "../../../config.ts";
import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import {
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
} from "../../../orchestration/Errors.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadDeletionReactor } from "../../../orchestration/Services/ThreadDeletionReactor.ts";
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as VcsStatusBroadcaster from "../../../vcs/VcsStatusBroadcaster.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { DelegationToolkitHandlersLive } from "./handlers.ts";
import { PAIR_LEAD_PROTOCOL } from "../../../provider/RuntimeInstructions.ts";
import { DelegationToolkit } from "./tools.ts";

const NOW = "2026-09-15T12:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-1");
const PARENT_ID = ThreadId.make("thread-parent");
const ANTIGRAVITY = ProviderInstanceId.make("antigravity");

const sha256Hex = (input: string) => NodeCrypto.createHash("sha256").update(input).digest("hex");
const childIdFor = (key: string, parent: ThreadId = PARENT_ID) =>
  ThreadId.make(`delegated:${parent}:${sha256Hex(`${parent}\n${key}`).slice(0, 16)}`);
const CHILD_ID = childIdFor("k1");
const WORKTREE_PATH = "/wt/repo/t3code-07070707";

// Real SHA-256 so distinct keys never collide. Random bytes start at 7, so the
// first random value in a harness (the child's temporary branch) is always
// t3code/07070707, and advance on every call so later ids stay unique.
const makeTestCrypto = () => {
  let fill = 7;
  return Crypto.make({
    randomBytes: (size) => new Uint8Array(size).fill(fill++ % 256),
    digest: (_algorithm, data) =>
      Effect.succeed(new Uint8Array(NodeCrypto.createHash("sha256").update(data).digest())),
  });
};

const invocation = (
  threadId: ThreadId = PARENT_ID,
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["delegation"],
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  threadId,
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("prime-agent"),
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

function makeShell(
  id: ThreadId,
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell {
  return {
    id,
    projectId: PROJECT_ID,
    title: "thread",
    modelSelection: { instanceId: ANTIGRAVITY, model: "gemini-3-pro" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function turn(overrides: Partial<OrchestrationLatestTurn> = {}): OrchestrationLatestTurn {
  return {
    turnId: TurnId.make("turn-1"),
    state: "running",
    requestedAt: NOW,
    startedAt: NOW,
    completedAt: null,
    assistantMessageId: null,
    ...overrides,
  };
}

const completedTurn = (overrides: Partial<OrchestrationLatestTurn> = {}) =>
  turn({ state: "completed", completedAt: NOW, ...overrides });

function message(id: string, overrides: Partial<OrchestrationMessage> = {}): OrchestrationMessage {
  return {
    id: MessageId.make(id),
    role: "assistant",
    text: id,
    turnId: null,
    streaming: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function checkpoint(
  turnId: string,
  files: OrchestrationCheckpointSummary["files"],
): OrchestrationCheckpointSummary {
  return {
    turnId: TurnId.make(turnId),
    checkpointTurnCount: 1,
    checkpointRef: CheckpointRef.make(`ref-${turnId}`),
    status: "ready",
    files,
    assistantMessageId: null,
    completedAt: NOW,
  };
}

function detailOf(
  shell: OrchestrationThreadShell,
  extra: Pick<OrchestrationThread, "messages" | "checkpoints">,
): OrchestrationThread {
  return {
    id: shell.id,
    projectId: shell.projectId,
    title: shell.title,
    modelSelection: shell.modelSelection,
    runtimeMode: shell.runtimeMode,
    interactionMode: shell.interactionMode,
    branch: shell.branch,
    worktreePath: shell.worktreePath,
    pullRequests: shell.pullRequests,
    latestTurn: shell.latestTurn,
    createdAt: shell.createdAt,
    updatedAt: shell.updatedAt,
    archivedAt: shell.archivedAt,
    settledOverride: shell.settledOverride,
    settledAt: shell.settledAt,
    deletedAt: null,
    proposedPlans: [],
    activities: [],
    session: shell.session,
    ...extra,
  };
}

const project: OrchestrationProjectShell = {
  id: PROJECT_ID,
  title: "Project",
  workspaceRoot: "/repo",
  defaultModelSelection: null,
  scripts: [],
  createdAt: NOW,
  updatedAt: NOW,
};

const antigravity: ServerProvider = {
  instanceId: ANTIGRAVITY,
  driver: ProviderDriverKind.make("antigravity"),
  enabled: true,
  installed: true,
  version: "1.1.1",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: NOW,
  models: [
    {
      slug: "gemini-3-pro",
      name: "Gemini 3 Pro",
      isCustom: false,
      capabilities: null,
      isDefault: true,
      aliases: ["antigravity-default"],
    },
  ],
  slashCommands: [],
  skills: [],
};

const localStatus = (refName: string | null): VcsStatusLocalResult => ({
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: true,
  refName,
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
});

type Rejection = OrchestrationCommandInvariantError | OrchestrationCommandPreviouslyRejectedError;

interface HarnessOptions {
  readonly shells?: ReadonlyArray<OrchestrationThreadShell>;
  readonly archived?: ReadonlyArray<OrchestrationThreadShell>;
  readonly details?: ReadonlyArray<OrchestrationThread>;
  readonly providers?: ReadonlyArray<ServerProvider>;
  /** Rejects a command before it reaches the fake receipt store. */
  readonly reject?: (command: OrchestrationCommand) => Rejection | null;
  readonly existingMessageIds?: ReadonlyArray<string>;
  readonly acceptedCommandIds?: ReadonlyArray<string>;
  readonly rejectedCommandIds?: ReadonlyArray<string>;
  readonly startFromOrigin?: boolean;
  readonly failCreateWorktree?: boolean;
  readonly parentRefName?: string | null;
  readonly delegationDefault?: ModelSelection | null;
  readonly childRuntimeMode?: DelegationChildRuntimeMode;
  readonly projectOverrides?: ProjectSettingsOverrides;
  readonly delegationEnabled?: boolean;
  readonly delegationPreference?: "built-in" | "pylon";
  /** Completed when the first turn start arrives; that dispatch then never returns. */
  readonly holdTurnStart?: Deferred.Deferred<void>;
}

const makeHarness = Effect.fn("makeDelegationHarness")(function* (options: HarnessOptions = {}) {
  const baseConfig = yield* ServerConfig.ServerConfig.pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-delegation-handlers-test-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
  );
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const gitCalls = yield* Ref.make<ReadonlyArray<string>>([]);
  const refreshed = yield* Ref.make<ReadonlyArray<string>>([]);
  const shells = new Map<string, OrchestrationThreadShell>();
  for (const shell of options.shells ?? [makeShell(PARENT_ID)]) shells.set(shell.id, shell);
  const archived = new Map<string, OrchestrationThreadShell>();
  for (const shell of options.archived ?? []) archived.set(shell.id, shell);
  const details = new Map<string, OrchestrationThread>();
  for (const detail of options.details ?? []) details.set(detail.id, detail);
  const messageIds = new Set(options.existingMessageIds ?? []);
  const accepted = new Set(options.acceptedCommandIds ?? []);
  const rejected = new Set(options.rejectedCommandIds ?? []);

  const apply = (command: OrchestrationCommand) => {
    switch (command.type) {
      case "thread.create":
        shells.set(
          command.threadId,
          makeShell(command.threadId, {
            title: command.title,
            modelSelection: command.modelSelection,
            runtimeMode: command.runtimeMode,
            branch: command.branch,
            worktreePath: command.worktreePath,
          }),
        );
        return;
      case "thread.meta.update": {
        const current = shells.get(command.threadId);
        if (current) {
          shells.set(command.threadId, {
            ...current,
            branch: command.branch === undefined ? current.branch : command.branch,
            worktreePath:
              command.worktreePath === undefined ? current.worktreePath : command.worktreePath,
          });
        }
        return;
      }
      case "thread.turn.start":
        messageIds.add(command.message.messageId);
        return;
      case "thread.delete":
        shells.delete(command.threadId);
        return;
      default:
        return;
    }
  };

  // Mirrors the receipt store: an accepted command id replays without effect,
  // a rejected one fails as previously rejected forever.
  // Every fake read and write yields to the scheduler so concurrent calls
  // genuinely interleave, as they do against the real engine and database.
  const dispatch: OrchestrationEngineShape["dispatch"] = (command) =>
    Effect.gen(function* () {
      yield* Effect.yieldNow;
      if (accepted.has(command.commandId)) return { sequence: 1 };
      if (rejected.has(command.commandId)) {
        return yield* new OrchestrationCommandPreviouslyRejectedError({
          commandId: command.commandId,
          detail: "Previously rejected.",
        });
      }
      if (command.type === "thread.turn.start" && options.holdTurnStart !== undefined) {
        yield* Deferred.succeed(options.holdTurnStart, undefined);
        return yield* Effect.never;
      }
      const rejection = options.reject?.(command) ?? null;
      if (rejection !== null) {
        rejected.add(command.commandId);
        return yield* rejection;
      }
      accepted.add(command.commandId);
      yield* Ref.update(commands, (recorded) => [...recorded, command]);
      apply(command);
      return { sequence: 1 };
    });

  const snapshotOf = (threads: Iterable<OrchestrationThreadShell>) => ({
    snapshotSequence: 1,
    projects: [project],
    threads: [...threads],
    updatedAt: NOW,
  });

  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: (threadId) => Effect.succeed(Option.fromNullishOr(shells.get(threadId))),
      getArchivedShellSnapshot: () => Effect.succeed(snapshotOf(archived.values())),
      getShellSnapshot: () =>
        Effect.yieldNow.pipe(Effect.andThen(Effect.sync(() => snapshotOf(shells.values())))),
      getProjectShellById: (projectId) =>
        Effect.succeed(projectId === PROJECT_ID ? Option.some(project) : Option.none()),
      getThreadDetailById: (threadId) =>
        Effect.succeed(Option.fromNullishOr(details.get(threadId))),
      getTurnStartMessage: ({ messageId }) =>
        Effect.succeed(
          messageIds.has(messageId)
            ? Option.some({
                message: message(messageId, { role: "user" }),
                hasOtherUserMessages: false,
              })
            : Option.none(),
        ),
    }),
    Layer.mock(OrchestrationEngineService)({
      dispatch,
      streamDomainEvents: Stream.empty,
      latestSequence: Effect.succeed(0),
    }),
    Layer.mock(ThreadDeletionReactor)({ drainThrough: () => Effect.void }),
    Layer.mock(ProviderRegistry)({
      getProviders: Effect.succeed(options.providers ?? [antigravity]),
    }),
    Layer.mock(GitWorkflowService.GitWorkflowService)({
      localStatus: () =>
        Effect.succeed(
          localStatus(options.parentRefName === undefined ? "main" : options.parentRefName),
        ),
      remoteExists: () => Effect.succeed(false),
      createWorktree: (input) =>
        options.failCreateWorktree
          ? Effect.fail(
              new GitCommandError({
                operation: "createWorktree",
                command: "git",
                cwd: input.cwd,
                detail: "boom",
              }),
            )
          : Ref.update(gitCalls, (all) => [
              ...all,
              `create:${input.refName}:${input.newRefName}`,
            ]).pipe(
              Effect.as({
                worktree: {
                  path: WORKTREE_PATH,
                  refName: input.newRefName ?? "missing",
                },
              }),
            ),
      removeWorktree: (input) =>
        Ref.update(gitCalls, (all) => [...all, `remove:${input.path}:${input.force}`]),
    }),
    Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
      refreshStatus: (cwd) =>
        Ref.update(refreshed, (all) => [...all, cwd]).pipe(
          Effect.as({
            ...localStatus("t3code/07070707"),
            hasUpstream: false,
            aheadCount: 0,
            behindCount: 0,
            pr: null,
          }),
        ),
    }),
    ServerSettings.layerTest({
      enableAgentDelegation: options.delegationEnabled ?? true,
      delegationPreference: options.delegationPreference ?? "built-in",
      newWorktreesStartFromOrigin: options.startFromOrigin ?? false,
      delegationDefaultModelSelection: options.delegationDefault ?? null,
      delegationChildRuntimeMode: options.childRuntimeMode ?? "inherit",
      ...(options.projectOverrides === undefined
        ? {}
        : { projectSettingsOverrides: { [PROJECT_ID]: options.projectOverrides } }),
    }),
    ServerConfig.layer({ ...baseConfig, worktreesDir: "/wt" }),
    Layer.succeed(Crypto.Crypto, makeTestCrypto()),
  );

  const toolkit = yield* DelegationToolkit.pipe(
    Effect.provide(DelegationToolkitHandlersLive.pipe(Layer.provide(dependencies))),
  );
  const call = <Name extends keyof typeof DelegationToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
    scope: McpInvocationContext.McpInvocationScope = invocation(),
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      // Failure mode is "error", so a delivered result is always the success shape.
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof DelegationToolkit.tools)[Name]>,
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provide(dependencies),
    );
  const commandTypes = Ref.get(commands).pipe(
    Effect.map((recorded) => recorded.map((command) => command.type)),
  );
  return { commands, commandTypes, gitCalls, refreshed, shells, call };
});

const delegateInput = {
  delegationKey: "k1",
  task: "Review auth\nDetails follow",
  providerInstanceId: ANTIGRAVITY,
};

describe("delegation toolkit gate", () => {
  it.effect("resolves preference with project overrides and ignores it when disabled", () =>
    Effect.gen(function* () {
      for (const [options, expected] of [
        [{}, "built-in"],
        [{ delegationPreference: "pylon" }, "pylon"],
        [
          { delegationPreference: "pylon", projectOverrides: { delegationPreference: "built-in" } },
          "built-in",
        ],
        [{ projectOverrides: { delegationPreference: "pylon" } }, "pylon"],
        [{ delegationPreference: "pylon", delegationEnabled: false }, "built-in"],
        [
          { delegationPreference: "pylon", projectOverrides: { enableAgentDelegation: false } },
          "built-in",
        ],
      ] as const) {
        const harness = yield* makeHarness(options);
        expect(yield* harness.call("read_delegation_skill", {})).toContain(
          `Current preferred delegation method: ${expected}.`,
        );
        expect(yield* harness.commandTypes).toEqual([]);
      }
    }),
  );

  it.effect("reads the skill without starting a child or touching git", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const skill = yield* harness.call("read_delegation_skill", {});
      expect(skill).toContain("name: pylon-delegation");
      expect(skill).toContain("## Choose the route");
      expect(yield* harness.commandTypes).toEqual([]);
      expect(yield* Ref.get(harness.gitCalls)).toEqual([]);
    }),
  );

  it.effect("refuses a credential without the delegation capability", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      for (const [name, params] of [
        ["delegated_thread_status", { delegationKey: "k1" }],
        ["delegate_thread", delegateInput],
        ["read_delegation_skill", {}],
      ] as const) {
        const error = yield* harness
          .call(name, params, invocation(PARENT_ID, ["pull-requests"]))
          .pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "McpCapabilityUnavailableError",
          capability: "delegation",
        });
      }
      expect(yield* harness.commandTypes).toEqual([]);
    }),
  );

  it.effect("refuses to fan out from a paired thread, and says what to do instead", () =>
    Effect.gen(function* () {
      // Seen live: a paired lead told to "use delegation" started two fan-out
      // children and never briefed its executor. One pair, one executor.
      const executorId = pairExecutorThreadId(PARENT_ID);
      const paired = yield* makeHarness({
        shells: [makeShell(PARENT_ID), makeShell(executorId)],
      });
      const refused = yield* paired.call("delegate_thread", delegateInput).pipe(Effect.flip);
      expect(refused).toMatchObject({ _tag: "DelegationPairedError", threadId: PARENT_ID });
      expect(refused.message).toContain("pair_handoff");
      expect(refused.message).toContain("turn Pair off");
      expect(yield* paired.commandTypes).toEqual([]);

      // The pair protocol replaces the fan-out workflow for a paired thread.
      const skill = yield* paired.call("read_delegation_skill", {});
      expect(skill).toContain(PAIR_LEAD_PROTOCOL);
      expect(skill).not.toContain("Current preferred delegation method");

      // A pair that was turned off archives its executor, and fan-out works again.
      const off = yield* makeHarness({
        shells: [makeShell(PARENT_ID), makeShell(executorId, { archivedAt: NOW })],
      });
      expect(yield* off.call("read_delegation_skill", {})).not.toContain(PAIR_LEAD_PROTOCOL);
      const tag = yield* off
        .call("delegate_thread", delegateInput)
        .pipe(Effect.match({ onFailure: (error) => error._tag, onSuccess: () => "ok" }));
      expect(tag).not.toBe("DelegationPairedError");
    }),
  );

  it.effect("refuses the key reserved for the pair executor on every tool", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const reserved = { _tag: "DelegationKeyReservedError", delegationKey: "pair" };
      expect(
        yield* harness
          .call("delegate_thread", { ...delegateInput, delegationKey: "pair" })
          .pipe(Effect.flip),
      ).toMatchObject(reserved);
      expect(
        yield* harness.call("delegated_thread_status", { delegationKey: "pair" }).pipe(Effect.flip),
      ).toMatchObject(reserved);
      expect(
        yield* harness.call("delegated_thread_result", { delegationKey: "pair" }).pipe(Effect.flip),
      ).toMatchObject(reserved);
      expect(
        yield* harness
          .call("send_to_delegated_thread", {
            delegationKey: "pair",
            messageKey: "m-1",
            text: "hello",
          })
          .pipe(Effect.flip),
      ).toMatchObject(reserved);
      expect(
        yield* harness
          .call("interrupt_delegated_thread", { delegationKey: "pair" })
          .pipe(Effect.flip),
      ).toMatchObject(reserved);
      expect(yield* harness.commandTypes).toEqual([]);
    }),
  );

  it.effect("rejects invalid keys before any lookup or dispatch", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      expect(
        yield* harness
          .call("delegated_thread_status", { delegationKey: "bad key" })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "DelegationKeyInvalidError", field: "delegationKey" });
      expect(
        yield* harness
          .call("send_to_delegated_thread", {
            delegationKey: "k1",
            messageKey: "bad:key",
            text: "hi",
          })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "DelegationKeyInvalidError", field: "messageKey" });
      expect(yield* harness.commandTypes).toEqual([]);
    }),
  );
});

describe("delegated_thread_status", () => {
  it.effect("reports not found for an unknown child", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      expect(
        yield* harness.call("delegated_thread_status", { delegationKey: "k1" }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "DelegatedThreadNotFoundError", delegationKey: "k1" });
    }),
  );

  it.effect("never reads another parent's child", () =>
    Effect.gen(function* () {
      const otherParent = ThreadId.make("thread-other");
      const harness = yield* makeHarness({
        shells: [makeShell(PARENT_ID), makeShell(childIdFor("k1", otherParent))],
      });
      expect(
        yield* harness.call("delegated_thread_status", { delegationKey: "k1" }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "DelegatedThreadNotFoundError" });
    }),
  );

  it.effect("reports an archived child as archived", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ archived: [makeShell(CHILD_ID, { archivedAt: NOW })] });
      expect(yield* harness.call("delegated_thread_status", { delegationKey: "k1" })).toMatchObject(
        {
          threadId: CHILD_ID,
          state: "archived",
          waitedSeconds: 0,
          changed: false,
        },
      );
    }),
  );

  it.effect("returns settled and actionable children immediately even with a wait budget", () =>
    Effect.gen(function* () {
      for (const child of [
        makeShell(CHILD_ID, { latestTurn: completedTurn() }),
        makeShell(CHILD_ID, { latestTurn: completedTurn({ state: "error" }) }),
        makeShell(CHILD_ID, { latestTurn: completedTurn({ state: "interrupted" }) }),
        makeShell(CHILD_ID, { latestTurn: turn(), hasPendingApprovals: true }),
        makeShell(CHILD_ID, { latestTurn: turn(), hasPendingUserInput: true }),
        makeShell(CHILD_ID, { archivedAt: NOW }),
      ]) {
        const harness = yield* makeHarness({ shells: [makeShell(PARENT_ID), child] });
        // No TestClock advancement: waiting would hang this test.
        expect(
          yield* harness.call("delegated_thread_status", {
            delegationKey: "k1",
            waitSeconds: 45,
          }),
        ).toMatchObject({ waitedSeconds: 0, changed: false });
      }
    }),
  );

  it.effect("waits until the state changes, then returns early", () =>
    Effect.gen(function* () {
      const running = makeShell(CHILD_ID, { latestTurn: turn() });
      const harness = yield* makeHarness({ shells: [makeShell(PARENT_ID), running] });
      const fiber = yield* Effect.forkChild(
        harness.call("delegated_thread_status", { delegationKey: "k1", waitSeconds: 20 }),
      );
      yield* TestClock.adjust("3 seconds");
      harness.shells.set(CHILD_ID, { ...running, latestTurn: completedTurn() });
      yield* TestClock.adjust("1 second");
      const result = yield* Fiber.join(fiber);
      expect(result).toMatchObject({ state: "completed", changed: true, waitedSeconds: 4 });
    }),
  );

  it.effect("wakes when the child starts waiting on an approval", () =>
    Effect.gen(function* () {
      const running = makeShell(CHILD_ID, { latestTurn: turn() });
      const harness = yield* makeHarness({ shells: [makeShell(PARENT_ID), running] });
      const fiber = yield* Effect.forkChild(
        harness.call("delegated_thread_status", { delegationKey: "k1", waitSeconds: 45 }),
      );
      yield* TestClock.adjust("1 second");
      harness.shells.set(CHILD_ID, { ...running, hasPendingApprovals: true });
      yield* TestClock.adjust("1 second");
      const result = yield* Fiber.join(fiber);
      expect(result).toMatchObject({ state: "running", changed: true, hasPendingApprovals: true });
    }),
  );

  it.effect("returns after the wait budget when nothing changes", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ shells: [makeShell(PARENT_ID), makeShell(CHILD_ID)] });
      const fiber = yield* Effect.forkChild(
        harness.call("delegated_thread_status", { delegationKey: "k1", waitSeconds: 5 }),
      );
      // A short request is not honored: it waits the whole cap.
      yield* TestClock.adjust("45 seconds");
      expect(yield* Fiber.join(fiber)).toMatchObject({
        state: "queued",
        changed: false,
        waitedSeconds: 45,
      });
    }),
  );

  it.effect(
    "marks delegation observation consumed on a completed child and skips when timed out",
    () =>
      Effect.gen(function* () {
        const completedChild = makeShell(CHILD_ID, {
          latestTurn: completedTurn({ turnId: TurnId.make("turn-2") }),
        });
        const completedHarness = yield* makeHarness({
          shells: [makeShell(PARENT_ID), completedChild],
        });
        yield* completedHarness.call("delegated_thread_status", { delegationKey: "k1" });
        const completedCommands = yield* Ref.get(completedHarness.commands);
        expect(completedCommands).toHaveLength(1);
        expect(completedCommands[0]).toMatchObject({
          type: "thread.activity.append",
          threadId: PARENT_ID,
          activity: {
            kind: "delegation.child-state",
            payload: {
              baseline: true,
              childThreadId: CHILD_ID,
            },
          },
        });

        const running = makeShell(CHILD_ID, { latestTurn: turn() });
        const runningHarness = yield* makeHarness({
          shells: [makeShell(PARENT_ID), running],
        });
        const runningFiber = yield* Effect.forkChild(
          runningHarness.call("delegated_thread_status", { delegationKey: "k1", waitSeconds: 5 }),
        );
        yield* TestClock.adjust("45 seconds");
        yield* Fiber.join(runningFiber);
        const runningCommands = yield* Ref.get(runningHarness.commands);
        expect(runningCommands).toHaveLength(0);
      }),
  );
});

describe("delegated_thread_result", () => {
  it.effect("returns the referenced message, aggregated files, and truncation", () =>
    Effect.gen(function* () {
      const shell = makeShell(CHILD_ID, {
        latestTurn: completedTurn({
          turnId: TurnId.make("turn-2"),
          assistantMessageId: MessageId.make("m2"),
        }),
        worktreePath: "/wt/repo/t3code-1",
        branch: "t3code/1",
      });
      const detail = detailOf(shell, {
        messages: [message("m1"), message("m2", { text: "x".repeat(2_000) })],
        checkpoints: [
          checkpoint("turn-1", [{ path: "a.ts", kind: "added", additions: 1, deletions: 0 }]),
          checkpoint("turn-2", [{ path: "a.ts", kind: "modified", additions: 1, deletions: 1 }]),
        ],
      });
      const harness = yield* makeHarness({
        shells: [makeShell(PARENT_ID), shell],
        details: [detail],
      });
      const result = yield* harness.call("delegated_thread_result", {
        delegationKey: "k1",
        maxChars: 1_000,
      });
      expect(result).toMatchObject({
        state: "completed",
        assistantMessage: { messageId: "m2", truncated: true },
        filesChanged: [{ path: "a.ts", kind: "modified", additions: 2, deletions: 1 }],
        turnCount: 2,
        worktreePath: "/wt/repo/t3code-1",
        branch: "t3code/1",
      });
      expect(result.assistantMessage?.text).toHaveLength(1_000);
    }),
  );

  it.effect("bounds the default result and lets the caller expand truncated output", () =>
    Effect.gen(function* () {
      const shell = makeShell(CHILD_ID, {
        latestTurn: completedTurn({ assistantMessageId: MessageId.make("m1") }),
      });
      const text = "x".repeat(6_000);
      const harness = yield* makeHarness({
        shells: [makeShell(PARENT_ID), shell],
        details: [detailOf(shell, { messages: [message("m1", { text })], checkpoints: [] })],
      });
      const compact = yield* harness.call("delegated_thread_result", { delegationKey: "k1" });
      expect(compact.assistantMessage?.text).toHaveLength(4_000);
      expect(compact.assistantMessage?.truncated).toBe(true);
      const expanded = yield* harness.call("delegated_thread_result", {
        delegationKey: "k1",
        maxChars: 8_000,
      });
      expect(expanded.assistantMessage).toMatchObject({ text, truncated: false });
    }),
  );

  it.effect("returns an empty result for an archived child", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ archived: [makeShell(CHILD_ID, { archivedAt: NOW })] });
      expect(yield* harness.call("delegated_thread_result", { delegationKey: "k1" })).toMatchObject(
        {
          state: "archived",
          assistantMessage: null,
          filesChanged: [],
          turnCount: 0,
        },
      );
    }),
  );
});

describe("delegate_thread", () => {
  it.effect("creates the child, its worktree, and its first turn in order", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("delegate_thread", delegateInput);
      expect(result).toEqual({
        delegationKey: "k1",
        threadId: CHILD_ID,
        created: true,
        state: "queued",
        providerInstanceId: "antigravity",
        model: "gemini-3-pro",
        runtimeMode: "full-access",
        defaultApplied: "none",
        worktreePath: WORKTREE_PATH,
        branch: "t3code/07070707",
        startedFromOrigin: false,
        setupScriptRan: false,
      });
      const recorded = yield* Ref.get(harness.commands);
      expect(recorded.map((command) => command.type)).toEqual([
        "thread.create",
        "thread.meta.update",
        "thread.turn.start",
      ]);
      expect(recorded[0]).toMatchObject({
        commandId: `server:mcp-delegate-create:${CHILD_ID}`,
        threadId: CHILD_ID,
        projectId: PROJECT_ID,
        title: "Review auth",
        modelSelection: { instanceId: "antigravity", model: "gemini-3-pro" },
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
      });
      expect(recorded[1]).toMatchObject({
        commandId: `server:mcp-delegate-meta:${CHILD_ID}`,
        branch: "t3code/07070707",
        worktreePath: WORKTREE_PATH,
      });
      expect(recorded[2]).toMatchObject({
        commandId: `server:mcp-delegate-turn:${CHILD_ID}:initial`,
        message: {
          messageId: `delegated-message:${CHILD_ID}:initial`,
          role: "user",
          text: delegateInput.task,
          attachments: [],
        },
        runtimeMode: "full-access",
        sourceEpoch: 0,
      });
      expect(yield* Ref.get(harness.gitCalls)).toEqual(["create:main:t3code/07070707"]);
      expect(yield* Ref.get(harness.refreshed)).toEqual([WORKTREE_PATH]);
    }),
  );

  it.effect("returns the existing child for a reused key without dispatching", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.call("delegate_thread", delegateInput);
      const replay = yield* harness.call("delegate_thread", delegateInput);
      expect(replay).toMatchObject({
        created: false,
        threadId: CHILD_ID,
        worktreePath: WORKTREE_PATH,
      });
      // The original default choice is not recorded, so a reuse makes no claim about it.
      expect(replay).not.toHaveProperty("defaultApplied");
      expect(yield* harness.commandTypes).toHaveLength(3);
    }),
  );

  it.effect("returns an archived child for a reused key", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ archived: [makeShell(CHILD_ID, { archivedAt: NOW })] });
      expect(yield* harness.call("delegate_thread", delegateInput)).toMatchObject({
        created: false,
        state: "archived",
      });
      expect(yield* harness.commandTypes).toEqual([]);
    }),
  );

  it.effect("cleans up a half-built child whose first message was never recorded", () =>
    Effect.gen(function* () {
      const halfBuilt = makeShell(CHILD_ID, { worktreePath: WORKTREE_PATH, branch: "t3code/1" });
      const harness = yield* makeHarness({ shells: [makeShell(PARENT_ID), halfBuilt] });
      expect(yield* harness.call("delegate_thread", delegateInput).pipe(Effect.flip)).toMatchObject(
        {
          _tag: "DelegationKeyConsumedError",
        },
      );
      expect(yield* Ref.get(harness.gitCalls)).toEqual([`remove:${WORKTREE_PATH}:true`]);
      expect(yield* harness.commandTypes).toEqual(["thread.delete"]);
      expect(harness.shells.has(CHILD_ID)).toBe(false);
    }),
  );

  const readySession = {
    threadId: CHILD_ID,
    status: "ready",
    providerName: "antigravity",
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: NOW,
  } satisfies OrchestrationThreadShell["session"];

  it.effect.each([
    ["a session and a later source epoch", { session: readySession, sourceEpoch: 1 }],
    ["a session only", { session: readySession }],
    ["a later source epoch only", { sourceEpoch: 1 }],
  ] as const)("keeps a child whose first message was rewound, evidenced by %s", ([, evidence]) =>
    Effect.gen(function* () {
      const rewound = makeShell(CHILD_ID, { worktreePath: WORKTREE_PATH, ...evidence });
      const harness = yield* makeHarness({ shells: [makeShell(PARENT_ID), rewound] });
      expect(yield* harness.call("delegate_thread", delegateInput)).toMatchObject({
        created: false,
        threadId: CHILD_ID,
        worktreePath: WORKTREE_PATH,
      });
      expect(yield* Ref.get(harness.gitCalls)).toEqual([]);
      expect(yield* harness.commandTypes).toEqual([]);
      expect(harness.shells.has(CHILD_ID)).toBe(true);
    }),
  );

  it.effect("never force-removes a worktree outside Pylon's managed directory", () =>
    Effect.gen(function* () {
      const halfBuilt = makeShell(CHILD_ID, { worktreePath: "/repo", branch: "main" });
      const harness = yield* makeHarness({ shells: [makeShell(PARENT_ID), halfBuilt] });
      expect(yield* harness.call("delegate_thread", delegateInput).pipe(Effect.flip)).toMatchObject(
        {
          _tag: "DelegationKeyConsumedError",
        },
      );
      expect(yield* Ref.get(harness.gitCalls)).toEqual([]);
      expect(yield* harness.commandTypes).toEqual(["thread.delete"]);
    }),
  );

  it.effect("gives the child the parent's interaction mode", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        shells: [makeShell(PARENT_ID, { interactionMode: "plan" })],
      });
      yield* harness.call("delegate_thread", delegateInput);
      const recorded = yield* Ref.get(harness.commands);
      expect(recorded[0]).toMatchObject({ type: "thread.create", interactionMode: "plan" });
      expect(recorded[2]).toMatchObject({ type: "thread.turn.start", interactionMode: "plan" });
    }),
  );

  it.effect("does not count another parent's children against the limit", () =>
    Effect.gen(function* () {
      const extended = ThreadId.make(`${PARENT_ID}:extended`);
      const others = Array.from({ length: 8 }, (_, index) =>
        makeShell(childIdFor(`busy-${index}`, extended), { latestTurn: turn() }),
      );
      const harness = yield* makeHarness({ shells: [makeShell(PARENT_ID), ...others] });
      expect(yield* harness.call("delegate_thread", delegateInput)).toMatchObject({
        created: true,
      });
    }),
  );

  it.effect("refuses to delegate from a delegated child", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ shells: [makeShell(CHILD_ID)] });
      expect(
        yield* harness
          .call("delegate_thread", delegateInput, invocation(CHILD_ID))
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "DelegationDepthExceededError" });
      expect(yield* harness.commandTypes).toEqual([]);
    }),
  );

  it.effect("refuses unavailable providers and unknown models", () =>
    Effect.gen(function* () {
      for (const provider of [
        { ...antigravity, enabled: false },
        { ...antigravity, availability: "unavailable" as const },
        { ...antigravity, auth: { status: "unauthenticated" as const } },
      ]) {
        const harness = yield* makeHarness({ providers: [provider] });
        expect(
          yield* harness.call("delegate_thread", delegateInput).pipe(Effect.flip),
        ).toMatchObject({ _tag: "DelegationProviderUnavailableError" });
      }
      const missing = yield* makeHarness({ providers: [] });
      expect(yield* missing.call("delegate_thread", delegateInput).pipe(Effect.flip)).toMatchObject(
        { _tag: "DelegationProviderUnavailableError" },
      );
      const unknownAuth = yield* makeHarness({
        providers: [{ ...antigravity, auth: { status: "unknown" } }],
      });
      expect(yield* unknownAuth.call("delegate_thread", delegateInput)).toMatchObject({
        created: true,
      });
      const harness = yield* makeHarness();
      expect(
        yield* harness
          .call("delegate_thread", { ...delegateInput, model: "nope" })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "DelegationModelUnavailableError", model: "nope" });
      expect(yield* harness.commandTypes).toEqual([]);
    }),
  );

  it.effect("never escalates the runtime mode and never falls back", () =>
    Effect.gen(function* () {
      const supervised = yield* makeHarness({
        shells: [makeShell(PARENT_ID, { runtimeMode: "approval-required" })],
      });
      expect(
        yield* supervised
          .call("delegate_thread", { ...delegateInput, runtimeMode: "full-access" })
          .pipe(Effect.flip),
      ).toMatchObject({
        _tag: "DelegationRuntimeModeEscalationError",
        parentMode: "approval-required",
        requested: "full-access",
      });
      const limited = yield* makeHarness({
        providers: [{ ...antigravity, supportedRuntimeModes: ["approval-required"] }],
      });
      expect(yield* limited.call("delegate_thread", delegateInput).pipe(Effect.flip)).toMatchObject(
        { _tag: "DelegationRuntimeModeUnsupportedError", runtimeMode: "full-access" },
      );
      expect(yield* limited.commandTypes).toEqual([]);
      const downgrade = yield* makeHarness();
      expect(
        yield* downgrade.call("delegate_thread", {
          ...delegateInput,
          runtimeMode: "approval-required",
        }),
      ).toMatchObject({ runtimeMode: "approval-required" });
    }),
  );

  it.effect("enforces the live-children limit", () =>
    Effect.gen(function* () {
      const running = Array.from({ length: 8 }, (_, index) =>
        makeShell(childIdFor(`busy-${index}`), { latestTurn: turn() }),
      );
      const settled = makeShell(childIdFor("done"), { latestTurn: completedTurn() });
      const harness = yield* makeHarness({ shells: [makeShell(PARENT_ID), settled, ...running] });
      expect(yield* harness.call("delegate_thread", delegateInput).pipe(Effect.flip)).toMatchObject(
        {
          _tag: "DelegationLimitExceededError",
          limit: 8,
        },
      );
      expect(yield* harness.commandTypes).toEqual([]);
    }),
  );

  it.effect("serializes concurrent delegations from one parent", () =>
    Effect.gen(function* () {
      const running = Array.from({ length: 7 }, (_, index) =>
        makeShell(childIdFor(`busy-${index}`), { latestTurn: turn() }),
      );
      const harness = yield* makeHarness({ shells: [makeShell(PARENT_ID), ...running] });
      const results = yield* Effect.all(
        [
          harness
            .call("delegate_thread", { ...delegateInput, delegationKey: "a" })
            .pipe(Effect.result),
          harness
            .call("delegate_thread", { ...delegateInput, delegationKey: "b" })
            .pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      );
      const outcomes = results
        .map((result) => (result._tag === "Success" ? "ok" : result.failure._tag))
        .sort();
      expect(outcomes).toEqual(["DelegationLimitExceededError", "ok"]);
    }),
  );

  it.effect("removes the worktree and deletes the child when the first turn is rejected", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        reject: (command) =>
          command.type === "thread.turn.start"
            ? new OrchestrationCommandInvariantError({
                commandType: command.type,
                detail: "source epoch mismatch",
              })
            : null,
      });
      expect(yield* harness.call("delegate_thread", delegateInput).pipe(Effect.flip)).toMatchObject(
        {
          _tag: "DelegatedThreadTurnRejectedError",
          detail: "source epoch mismatch",
        },
      );
      expect(yield* Ref.get(harness.gitCalls)).toEqual([
        "create:main:t3code/07070707",
        `remove:${WORKTREE_PATH}:true`,
      ]);
      expect(yield* harness.commandTypes).toEqual([
        "thread.create",
        "thread.meta.update",
        "thread.delete",
      ]);
      // The key is consumed: a retry cannot resurrect the attempt.
      expect(yield* harness.call("delegate_thread", delegateInput).pipe(Effect.flip)).toMatchObject(
        {
          _tag: "DelegationKeyConsumedError",
          delegationKey: "k1",
        },
      );
    }),
  );

  it.effect("cleans up when the caller aborts the tool call mid-sequence", () =>
    Effect.gen(function* () {
      const holdTurnStart = yield* Deferred.make<void>();
      const harness = yield* makeHarness({ holdTurnStart });
      const fiber = yield* Effect.forkChild(harness.call("delegate_thread", delegateInput));
      yield* Deferred.await(holdTurnStart);
      yield* Fiber.interrupt(fiber);
      expect(yield* Ref.get(harness.gitCalls)).toEqual([
        "create:main:t3code/07070707",
        `remove:${WORKTREE_PATH}:true`,
      ]);
      expect(yield* harness.commandTypes).toEqual([
        "thread.create",
        "thread.meta.update",
        "thread.delete",
      ]);
      expect(harness.shells.has(CHILD_ID)).toBe(false);
    }),
  );

  it.effect("deletes the child when the worktree cannot be created", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ failCreateWorktree: true });
      expect(yield* harness.call("delegate_thread", delegateInput).pipe(Effect.flip)).toMatchObject(
        {
          _tag: "DelegationWorktreeError",
        },
      );
      expect(yield* Ref.get(harness.gitCalls)).toEqual([]);
      expect(yield* harness.commandTypes).toEqual(["thread.create", "thread.delete"]);
    }),
  );

  it.effect("fails with a worktree error on a detached parent checkout", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        shells: [makeShell(PARENT_ID, { branch: null })],
        parentRefName: null,
      });
      expect(yield* harness.call("delegate_thread", delegateInput).pipe(Effect.flip)).toMatchObject(
        {
          _tag: "DelegationWorktreeError",
        },
      );
      expect(yield* harness.commandTypes).toEqual(["thread.create", "thread.delete"]);
    }),
  );

  it.effect("reports a consumed key when a create receipt was rejected", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        rejectedCommandIds: [`server:mcp-delegate-create:${CHILD_ID}`],
      });
      expect(yield* harness.call("delegate_thread", delegateInput).pipe(Effect.flip)).toMatchObject(
        {
          _tag: "DelegationKeyConsumedError",
        },
      );
      expect(yield* harness.commandTypes).toEqual([]);
    }),
  );

  it.effect("reports a consumed key when an accepted create replays onto a deleted child", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        acceptedCommandIds: [`server:mcp-delegate-create:${CHILD_ID}`],
      });
      expect(yield* harness.call("delegate_thread", delegateInput).pipe(Effect.flip)).toMatchObject(
        {
          _tag: "DelegationKeyConsumedError",
        },
      );
      expect(yield* harness.commandTypes).toEqual([]);
      expect(yield* Ref.get(harness.gitCalls)).toEqual([]);
    }),
  );
});

describe("delegation defaults", () => {
  const CODEX = ProviderInstanceId.make("codex");
  const codex: ServerProvider = {
    ...antigravity,
    instanceId: CODEX,
    driver: ProviderDriverKind.make("codex"),
    models: [
      {
        slug: "gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        isCustom: false,
        capabilities: null,
        isDefault: true,
      },
    ],
  };
  const flash38: ServerProvider = {
    ...antigravity,
    models: [
      ...antigravity.models,
      {
        slug: "gemini-3.8-flash-medium",
        name: "Gemini 3.8 Flash (Medium)",
        isCustom: false,
        capabilities: null,
      },
    ],
  };
  const flashDefault: ModelSelection = {
    instanceId: ANTIGRAVITY,
    model: "gemini-3.8-flash-medium",
    options: [{ id: "thinking", value: "low" }],
  };
  const unnamed = { delegationKey: "k1", task: "Review auth" };

  it.effect(
    "uses the default provider and model, with its options, when the agent names neither",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          providers: [flash38, codex],
          delegationDefault: flashDefault,
        });
        expect(yield* harness.call("delegate_thread", unnamed)).toMatchObject({
          created: true,
          providerInstanceId: "antigravity",
          model: "gemini-3.8-flash-medium",
          defaultApplied: "provider-and-model",
        });
        expect((yield* Ref.get(harness.commands))[0]).toMatchObject({
          type: "thread.create",
          modelSelection: flashDefault,
        });
      }),
  );

  it.effect(
    "uses the default provider with a model the agent names, without the default's options",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          providers: [flash38, codex],
          delegationDefault: flashDefault,
        });
        expect(
          yield* harness.call("delegate_thread", { ...unnamed, model: "gemini-3-pro" }),
        ).toMatchObject({
          providerInstanceId: "antigravity",
          model: "gemini-3-pro",
          defaultApplied: "provider",
        });
        expect((yield* Ref.get(harness.commands))[0]).toMatchObject({
          modelSelection: { instanceId: ANTIGRAVITY, model: "gemini-3-pro" },
        });
        expect((yield* Ref.get(harness.commands))[0]).not.toHaveProperty("modelSelection.options");
      }),
  );

  it.effect("lets a named provider override the default entirely", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        providers: [flash38, codex],
        delegationDefault: flashDefault,
      });
      expect(
        yield* harness.call("delegate_thread", { ...unnamed, providerInstanceId: CODEX }),
      ).toMatchObject({
        providerInstanceId: "codex",
        model: "gpt-5.6-luna",
        defaultApplied: "none",
      });
    }),
  );

  it.effect("refuses to guess when no default is set and no provider is named", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ providers: [flash38, codex] });
      expect(yield* harness.call("delegate_thread", unnamed).pipe(Effect.flip)).toMatchObject({
        _tag: "DelegationDefaultMissingError",
      });
      expect(yield* harness.commandTypes).toEqual([]);
    }),
  );

  it.effect("fails instead of falling back when the default model is no longer offered", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        providers: [antigravity, codex],
        delegationDefault: flashDefault,
      });
      expect(yield* harness.call("delegate_thread", unnamed).pipe(Effect.flip)).toMatchObject({
        _tag: "DelegationModelUnavailableError",
        providerInstanceId: "antigravity",
        model: "gemini-3.8-flash-medium",
      });
      expect(yield* harness.commandTypes).toEqual([]);
    }),
  );

  it.effect("fails instead of falling back when the default provider is unavailable", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        providers: [{ ...flash38, enabled: false }, codex],
        delegationDefault: flashDefault,
      });
      expect(yield* harness.call("delegate_thread", unnamed).pipe(Effect.flip)).toMatchObject({
        _tag: "DelegationProviderUnavailableError",
        providerInstanceId: "antigravity",
      });
    }),
  );

  it.effect("prefers the project's default over the environment's", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        providers: [flash38, codex],
        delegationDefault: flashDefault,
        projectOverrides: {
          delegationDefaultModelSelection: { instanceId: CODEX, model: "gpt-5.6-luna" },
        },
      });
      expect(yield* harness.call("delegate_thread", unnamed)).toMatchObject({
        providerInstanceId: "codex",
        defaultApplied: "provider-and-model",
      });
    }),
  );

  it.effect("runs children Supervised when the user's child permission is Supervised", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ childRuntimeMode: "approval-required" });
      expect(
        yield* harness.call("delegate_thread", { ...unnamed, providerInstanceId: ANTIGRAVITY }),
      ).toMatchObject({ runtimeMode: "approval-required" });
      const recorded = yield* Ref.get(harness.commands);
      expect(recorded[0]).toMatchObject({
        type: "thread.create",
        runtimeMode: "approval-required",
      });
      expect(recorded[2]).toMatchObject({
        type: "thread.turn.start",
        runtimeMode: "approval-required",
      });
    }),
  );

  it.effect("still lets the agent ask for the parent's own mode when the user asks for it", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ childRuntimeMode: "approval-required" });
      expect(
        yield* harness.call("delegate_thread", {
          ...unnamed,
          providerInstanceId: ANTIGRAVITY,
          runtimeMode: "full-access",
        }),
      ).toMatchObject({ runtimeMode: "full-access" });
    }),
  );
});

describe("send_to_delegated_thread", () => {
  const completed = makeShell(CHILD_ID, { latestTurn: completedTurn(), sourceEpoch: 2 });
  const send = { delegationKey: "k1", messageKey: "m-1", text: "Also fix the tests" };

  it.effect("starts a new turn with the child's own selection and epoch", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ shells: [makeShell(PARENT_ID), completed] });
      expect(yield* harness.call("send_to_delegated_thread", send)).toEqual({
        delegationKey: "k1",
        threadId: CHILD_ID,
        accepted: true,
        messageId: `delegated-message:${CHILD_ID}:m-1`,
      });
      expect((yield* Ref.get(harness.commands))[0]).toMatchObject({
        type: "thread.turn.start",
        commandId: `server:mcp-delegate-turn:${CHILD_ID}:m-1`,
        message: { text: "Also fix the tests", attachments: [] },
        modelSelection: completed.modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        sourceEpoch: 2,
      });
    }),
  );

  it.effect("refuses a second follow-up while the first waits for admission", () =>
    Effect.gen(function* () {
      const pending = makeShell(CHILD_ID, {
        latestTurn: completedTurn(),
        session: {
          threadId: CHILD_ID,
          status: "starting",
          providerName: "antigravity",
          runtimeMode: "full-access",
          activeTurnId: null,
          pendingTurnRequestId: CommandId.make(`server:mcp-delegate-turn:${CHILD_ID}:first`),
          lastError: null,
          updatedAt: NOW,
        },
      });
      const harness = yield* makeHarness({ shells: [makeShell(PARENT_ID), pending] });
      expect(yield* harness.call("send_to_delegated_thread", send).pipe(Effect.flip)).toMatchObject(
        { _tag: "DelegatedThreadBusyError", state: "running" },
      );
      expect(
        yield* harness.call("interrupt_delegated_thread", { delegationKey: "k1" }),
      ).toMatchObject({ interrupted: true, state: "running" });
      expect(yield* harness.commandTypes).toEqual(["thread.turn.interrupt"]);
    }),
  );

  it.effect("accepts a follow-up once a first turn was stopped before admission", () =>
    Effect.gen(function* () {
      const stopped = makeShell(CHILD_ID, {
        session: {
          threadId: CHILD_ID,
          status: "stopped",
          providerName: "antigravity",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW,
        },
      });
      const harness = yield* makeHarness({ shells: [makeShell(PARENT_ID), stopped] });
      expect(yield* harness.call("delegated_thread_status", { delegationKey: "k1" })).toMatchObject(
        { state: "interrupted" },
      );
      expect(yield* harness.call("send_to_delegated_thread", send)).toMatchObject({
        accepted: true,
      });
    }),
  );

  it.effect("refuses while the child is busy and when it is archived", () =>
    Effect.gen(function* () {
      for (const busy of [makeShell(CHILD_ID), makeShell(CHILD_ID, { latestTurn: turn() })]) {
        const harness = yield* makeHarness({ shells: [makeShell(PARENT_ID), busy] });
        expect(
          yield* harness.call("send_to_delegated_thread", send).pipe(Effect.flip),
        ).toMatchObject({ _tag: "DelegatedThreadBusyError" });
      }
      const archived = yield* makeHarness({ archived: [makeShell(CHILD_ID, { archivedAt: NOW })] });
      expect(
        yield* archived.call("send_to_delegated_thread", send).pipe(Effect.flip),
      ).toMatchObject({ _tag: "DelegatedThreadArchivedError" });
    }),
  );

  it.effect("does not resend a message that already exists", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        shells: [makeShell(PARENT_ID), completed],
        existingMessageIds: [`delegated-message:${CHILD_ID}:m-1`],
      });
      expect((yield* harness.call("send_to_delegated_thread", send)).accepted).toBe(true);
      expect(yield* harness.commandTypes).toEqual([]);
    }),
  );

  it.effect("maps rejections to a turn error first and a consumed key on retry", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        shells: [makeShell(PARENT_ID), completed],
        reject: (command) =>
          command.type === "thread.turn.start"
            ? new OrchestrationCommandInvariantError({
                commandType: command.type,
                detail: "rollback pending",
              })
            : null,
      });
      expect(yield* harness.call("send_to_delegated_thread", send).pipe(Effect.flip)).toMatchObject(
        { _tag: "DelegatedThreadTurnRejectedError", detail: "rollback pending" },
      );
      expect(yield* harness.call("send_to_delegated_thread", send).pipe(Effect.flip)).toMatchObject(
        { _tag: "DelegatedMessageKeyConsumedError", messageKey: "m-1" },
      );
    }),
  );
});

describe("interrupt_delegated_thread", () => {
  it.effect("interrupts a running child with a turn-scoped command id", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        shells: [makeShell(PARENT_ID), makeShell(CHILD_ID, { latestTurn: turn() })],
      });
      expect(
        yield* harness.call("interrupt_delegated_thread", { delegationKey: "k1" }),
      ).toMatchObject({ interrupted: true, state: "running" });
      expect((yield* Ref.get(harness.commands))[0]).toMatchObject({
        type: "thread.turn.interrupt",
        commandId: expect.stringMatching(new RegExp(`^server:mcp-delegate-interrupt:${CHILD_ID}:`)),
        threadId: CHILD_ID,
      });
    }),
  );

  it.effect("dispatches every interrupt of a live child, across admission and running", () =>
    Effect.gen(function* () {
      const requestId = CommandId.make(`server:mcp-delegate-turn:${CHILD_ID}:first`);
      const starting = makeShell(CHILD_ID, {
        latestTurn: completedTurn(),
        session: {
          threadId: CHILD_ID,
          status: "starting",
          providerName: "antigravity",
          runtimeMode: "full-access",
          activeTurnId: null,
          pendingTurnRequestId: requestId,
          lastError: null,
          updatedAt: NOW,
        },
      });
      const harness = yield* makeHarness({ shells: [makeShell(PARENT_ID), starting] });
      yield* harness.call("interrupt_delegated_thread", { delegationKey: "k1" });
      // The provider admitted the turn anyway: same request, now running.
      harness.shells.set(
        CHILD_ID,
        makeShell(CHILD_ID, {
          latestTurn: turn({ turnId: TurnId.make("turn-2") }),
          session: {
            threadId: CHILD_ID,
            status: "running",
            providerName: "antigravity",
            runtimeMode: "full-access",
            activeTurnId: TurnId.make("turn-2"),
            activeTurnRequestId: requestId,
            lastError: null,
            updatedAt: NOW,
          },
        }),
      );
      yield* harness.call("interrupt_delegated_thread", { delegationKey: "k1" });
      yield* harness.call("interrupt_delegated_thread", { delegationKey: "k1" });
      const commandIds = (yield* Ref.get(harness.commands)).map((command) => command.commandId);
      expect(commandIds).toHaveLength(3);
      expect(new Set(commandIds).size).toBe(3);
    }),
  );

  it.effect("interrupts a queued child", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ shells: [makeShell(PARENT_ID), makeShell(CHILD_ID)] });
      expect(
        yield* harness.call("interrupt_delegated_thread", { delegationKey: "k1" }),
      ).toMatchObject({ interrupted: true, state: "queued" });
      expect((yield* Ref.get(harness.commands))[0]).toMatchObject({
        commandId: expect.stringMatching(new RegExp(`^server:mcp-delegate-interrupt:${CHILD_ID}:`)),
      });
    }),
  );

  it.effect("does nothing when the child is not running", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        shells: [makeShell(PARENT_ID), makeShell(CHILD_ID, { latestTurn: completedTurn() })],
      });
      expect(
        yield* harness.call("interrupt_delegated_thread", { delegationKey: "k1" }),
      ).toMatchObject({ interrupted: false, state: "completed" });
      expect(yield* harness.commandTypes).toEqual([]);
    }),
  );
});
