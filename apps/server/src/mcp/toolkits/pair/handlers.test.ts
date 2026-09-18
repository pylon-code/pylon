import * as NodeCrypto from "node:crypto";

import {
  CheckpointRef,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type DelegationChildRuntimeMode,
  type ModelSelection,
  type OrchestrationCommand,
  type OrchestrationLatestTurn,
  type OrchestrationMessage,
  type OrchestrationProjectShell,
  type OrchestrationSession,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type { Tool } from "effect/unstable/ai";

import {
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
} from "../../../orchestration/Errors.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { PairToolkitHandlersLive } from "./handlers.ts";
import { PairToolkit } from "./tools.ts";

const NOW = "2026-09-18T12:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-1");
const LEAD_ID = ThreadId.make("thread-lead");
const ANTIGRAVITY = ProviderInstanceId.make("antigravity");
const CODEX = ProviderInstanceId.make("codex");
const PRIME = ProviderInstanceId.make("prime-agent");

const sha256Hex = (input: string) => NodeCrypto.createHash("sha256").update(input).digest("hex");
const executorIdFor = (lead: ThreadId = LEAD_ID) =>
  ThreadId.make(`delegated:${lead}:${sha256Hex(`${lead}\npair`).slice(0, 16)}`);
const EXECUTOR_ID = executorIdFor();

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(7),
  digest: (_algorithm, data) =>
    Effect.succeed(new Uint8Array(NodeCrypto.createHash("sha256").update(data).digest())),
});

const invocation = (
  options: {
    readonly threadId?: ThreadId;
    readonly providerInstanceId?: ProviderInstanceId;
    readonly capabilities?: ReadonlyArray<McpInvocationContext.McpCapability>;
  } = {},
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  threadId: options.threadId ?? LEAD_ID,
  providerSessionId: "provider-session-1",
  providerInstanceId: options.providerInstanceId ?? PRIME,
  capabilities: new Set(options.capabilities ?? ["delegation"]),
  issuedAt: 1,
});

function makeShell(
  id: ThreadId,
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell {
  return {
    id,
    projectId: PROJECT_ID,
    title: "Lead title",
    modelSelection: { instanceId: CODEX, model: "gpt-6-astra" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "feat/work",
    worktreePath: "/wt/repo/lead",
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

const makeExecutor = (overrides: Partial<OrchestrationThreadShell> = {}) =>
  makeShell(EXECUTOR_ID, {
    title: "Executor · Lead title",
    modelSelection: { instanceId: ANTIGRAVITY, model: "gemini-3-flash" },
    ...overrides,
  });

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

const runningSession = (overrides: Partial<OrchestrationSession> = {}): OrchestrationSession => ({
  threadId: EXECUTOR_ID,
  status: "running",
  providerName: "antigravity",
  runtimeMode: "full-access",
  activeTurnId: TurnId.make("turn-1"),
  lastError: null,
  updatedAt: NOW,
  ...overrides,
});

const runningExecutor = (overrides: Partial<OrchestrationThreadShell> = {}) =>
  makeExecutor({ latestTurn: turn(), session: runningSession(), ...overrides });

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

const provider = (
  instanceId: ProviderInstanceId,
  driver: string,
  model: string,
  overrides: Partial<ServerProvider> = {},
): ServerProvider => ({
  instanceId,
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: NOW,
  models: [
    { slug: model, name: model, isCustom: false, capabilities: null, isDefault: true, aliases: [] },
  ],
  slashCommands: [],
  skills: [],
  ...overrides,
});

const antigravity = provider(ANTIGRAVITY, "antigravity", "gemini-3-flash");
const codex = provider(CODEX, "codex", "gpt-6-astra");

type Rejection = OrchestrationCommandInvariantError | OrchestrationCommandPreviouslyRejectedError;

interface HarnessOptions {
  readonly shells?: ReadonlyArray<OrchestrationThreadShell>;
  readonly archived?: ReadonlyArray<OrchestrationThreadShell>;
  readonly details?: ReadonlyArray<OrchestrationThread>;
  readonly providers?: ReadonlyArray<ServerProvider>;
  readonly reject?: (command: OrchestrationCommand) => Rejection | null;
  readonly existingMessageIds?: ReadonlyArray<string>;
  readonly rejectedCommandIds?: ReadonlyArray<string>;
  readonly delegationDefault?: ModelSelection | null;
  readonly childRuntimeMode?: DelegationChildRuntimeMode;
}

const DEFAULT_SELECTION: ModelSelection = { instanceId: ANTIGRAVITY, model: "gemini-3-flash" };

const makeHarness = Effect.fn("makePairHarness")(function* (options: HarnessOptions = {}) {
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const shells = new Map<string, OrchestrationThreadShell>();
  for (const shell of options.shells ?? [makeShell(LEAD_ID)]) shells.set(shell.id, shell);
  const archived = new Map<string, OrchestrationThreadShell>();
  for (const shell of options.archived ?? []) archived.set(shell.id, shell);
  const details = new Map<string, OrchestrationThread>();
  for (const detail of options.details ?? []) details.set(detail.id, detail);
  const messageIds = new Set(options.existingMessageIds ?? []);
  const accepted = new Set<string>();
  const rejected = new Set(options.rejectedCommandIds ?? []);

  const apply = (command: OrchestrationCommand) => {
    if (command.type === "thread.create") {
      shells.set(
        command.threadId,
        makeShell(command.threadId, {
          title: command.title,
          modelSelection: command.modelSelection,
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          branch: command.branch,
          worktreePath: command.worktreePath,
        }),
      );
    }
    if (command.type === "thread.turn.start") messageIds.add(command.message.messageId);
  };

  // Mirrors the receipt store: an accepted command id replays without effect,
  // a rejected one fails as previously rejected forever.
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

  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: (threadId) => Effect.succeed(Option.fromNullishOr(shells.get(threadId))),
      getArchivedShellSnapshot: () =>
        Effect.succeed({
          snapshotSequence: 1,
          projects: [project],
          threads: [...archived.values()],
          updatedAt: NOW,
        }),
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
    Layer.mock(ProviderRegistry)({
      getProviders: Effect.succeed(options.providers ?? [antigravity, codex]),
    }),
    ServerSettings.layerTest({
      enableAgentDelegation: true,
      delegationDefaultModelSelection:
        options.delegationDefault === undefined ? DEFAULT_SELECTION : options.delegationDefault,
      delegationChildRuntimeMode: options.childRuntimeMode ?? "inherit",
    }),
    Layer.succeed(Crypto.Crypto, testCrypto),
  );

  const toolkit = yield* PairToolkit.pipe(
    Effect.provide(PairToolkitHandlersLive.pipe(Layer.provide(dependencies))),
  );
  const call = <Name extends keyof typeof PairToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
    scope: McpInvocationContext.McpInvocationScope = invocation(),
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      // Failure mode is "error", so a delivered result is always the success shape.
      Effect.map((chunk) => chunk.at(-1)!.result as Tool.Success<(typeof PairToolkit.tools)[Name]>),
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provide(dependencies),
    );
  const commandTypes = Ref.get(commands).pipe(
    Effect.map((recorded) => recorded.map((command) => command.type)),
  );
  return { commands, commandTypes, shells, call };
});

const tagOf = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error._tag),
  );

describe("pair toolkit gate", () => {
  it.effect("requires the delegation capability for every tool", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ shells: [makeShell(LEAD_ID), makeExecutor()] });
      const scope = invocation({ capabilities: ["pull-requests"] });
      expect(yield* harness.call("pair_start", {}, scope).pipe(Effect.flip)).toMatchObject({
        _tag: "McpCapabilityUnavailableError",
        capability: "delegation",
      });
      expect(
        yield* tagOf(harness.call("pair_handoff", { messageKey: "m-1", text: "go" }, scope)),
      ).toBe("McpCapabilityUnavailableError");
      expect(yield* tagOf(harness.call("pair_await", {}, scope))).toBe(
        "McpCapabilityUnavailableError",
      );
      expect(yield* tagOf(harness.call("pair_stop", {}, scope))).toBe(
        "McpCapabilityUnavailableError",
      );
      expect(yield* harness.commandTypes).toEqual([]);
    }),
  );

  it.effect("refuses to start a pair from an executor or any delegated thread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ shells: [makeShell(LEAD_ID), makeExecutor()] });
      expect(
        yield* tagOf(harness.call("pair_start", {}, invocation({ threadId: EXECUTOR_ID }))),
      ).toBe("PairDepthExceededError");
      expect(yield* harness.commandTypes).toEqual([]);
    }),
  );
});

describe("pair_start", () => {
  it.effect("creates an idle executor in the lead's worktree with the default model", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        shells: [makeShell(LEAD_ID, { interactionMode: "plan" })],
      });
      const result = yield* harness.call("pair_start", {});
      expect(result).toEqual({
        threadId: EXECUTOR_ID,
        created: true,
        state: "idle",
        providerInstanceId: "antigravity",
        model: "gemini-3-flash",
        runtimeMode: "full-access",
        worktreePath: "/wt/repo/lead",
        branch: "feat/work",
      });
      const recorded = yield* Ref.get(harness.commands);
      // No worktree, no meta update, and no first turn: the executor waits for a brief.
      expect(recorded.map((command) => command.type)).toEqual(["thread.create"]);
      expect(recorded[0]).toMatchObject({
        type: "thread.create",
        commandId: `server:mcp-pair-create:${EXECUTOR_ID}`,
        threadId: EXECUTOR_ID,
        projectId: PROJECT_ID,
        title: "Executor · Lead title",
        modelSelection: { instanceId: ANTIGRAVITY, model: "gemini-3-flash" },
        runtimeMode: "full-access",
        // The lead may plan; the executor always implements.
        interactionMode: "default",
        branch: "feat/work",
        worktreePath: "/wt/repo/lead",
      });
    }),
  );

  it.effect("returns the existing executor without dispatching", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        shells: [makeShell(LEAD_ID), makeExecutor({ latestTurn: completedTurn() })],
      });
      expect(yield* harness.call("pair_start", {})).toMatchObject({
        threadId: EXECUTOR_ID,
        created: false,
        state: "completed",
        providerInstanceId: "antigravity",
        model: "gemini-3-flash",
      });
      expect(yield* harness.commandTypes).toEqual([]);
    }),
  );

  it.effect("refuses while the pair is turned off (archived executor)", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ archived: [makeExecutor({ archivedAt: NOW })] });
      expect(yield* tagOf(harness.call("pair_start", {}))).toBe("PairArchivedError");
      expect(yield* harness.commandTypes).toEqual([]);
    }),
  );

  it.effect("never guesses a provider", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ delegationDefault: null });
      expect(yield* tagOf(harness.call("pair_start", {}))).toBe("PairDefaultMissingError");
      expect(yield* harness.commandTypes).toEqual([]);
    }),
  );

  it.effect("lets an explicit provider win and validates it like the default", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      expect(yield* harness.call("pair_start", { providerInstanceId: CODEX })).toMatchObject({
        created: true,
        providerInstanceId: "codex",
        model: "gpt-6-astra",
      });

      const unavailable = yield* makeHarness({
        providers: [provider(ANTIGRAVITY, "antigravity", "gemini-3-flash", { enabled: false })],
      });
      expect(yield* tagOf(unavailable.call("pair_start", {}))).toBe("PairProviderUnavailableError");

      const unknownModel = yield* makeHarness();
      expect(yield* tagOf(unknownModel.call("pair_start", { model: "no-such-model" }))).toBe(
        "PairModelUnavailableError",
      );
    }),
  );

  it.effect("applies the Supervised child permission setting and never broadens", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ childRuntimeMode: "approval-required" });
      expect(yield* harness.call("pair_start", {})).toMatchObject({
        runtimeMode: "approval-required",
      });
    }),
  );
});

describe("pair_handoff", () => {
  const brief = { messageKey: "m-1", text: "Implement step one" };

  it.effect("fails without an executor and while the pair is turned off", () =>
    Effect.gen(function* () {
      const none = yield* makeHarness();
      expect(yield* tagOf(none.call("pair_handoff", brief))).toBe("PairNotActiveError");
      const off = yield* makeHarness({ archived: [makeExecutor({ archivedAt: NOW })] });
      expect(yield* tagOf(off.call("pair_handoff", brief))).toBe("PairArchivedError");
    }),
  );

  it.effect("starts the first turn of an executor that never ran", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ shells: [makeShell(LEAD_ID), makeExecutor()] });
      expect(yield* harness.call("pair_handoff", brief)).toEqual({
        threadId: EXECUTOR_ID,
        accepted: true,
        messageId: `pair-message:${EXECUTOR_ID}:m-1`,
        steered: false,
      });
      expect((yield* Ref.get(harness.commands))[0]).toMatchObject({
        type: "thread.turn.start",
        commandId: `server:mcp-pair-turn:${EXECUTOR_ID}:m-1`,
        threadId: EXECUTOR_ID,
        message: {
          messageId: `pair-message:${EXECUTOR_ID}:m-1`,
          role: "user",
          text: "Implement step one",
          attachments: [],
        },
        modelSelection: { instanceId: ANTIGRAVITY, model: "gemini-3-flash" },
        runtimeMode: "full-access",
        interactionMode: "default",
        sourceEpoch: 0,
      });
    }),
  );

  it.effect("starts the next turn with the executor's own selection and epoch", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        shells: [makeShell(LEAD_ID), makeExecutor({ latestTurn: completedTurn(), sourceEpoch: 3 })],
      });
      yield* harness.call("pair_handoff", brief);
      expect((yield* Ref.get(harness.commands))[0]).toMatchObject({
        type: "thread.turn.start",
        sourceEpoch: 3,
      });
    }),
  );

  it.effect("refuses a running executor unless asked to steer", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ shells: [makeShell(LEAD_ID), runningExecutor()] });
      expect(yield* tagOf(harness.call("pair_handoff", brief))).toBe("PairExecutorBusyError");
      expect(yield* harness.commandTypes).toEqual([]);
    }),
  );

  it.effect("steers a running turn once, keyed by that turn", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ shells: [makeShell(LEAD_ID), runningExecutor()] });
      expect(yield* harness.call("pair_handoff", { ...brief, steer: true })).toEqual({
        threadId: EXECUTOR_ID,
        accepted: true,
        messageId: `pair-message:${EXECUTOR_ID}:steer:turn-1`,
        steered: true,
      });
      expect((yield* Ref.get(harness.commands))[0]).toMatchObject({
        type: "thread.turn.start",
        commandId: `server:mcp-pair-turn:${EXECUTOR_ID}:m-1`,
        message: { messageId: `pair-message:${EXECUTOR_ID}:steer:turn-1` },
      });
      // The same turn cannot be steered again, under any key.
      expect(
        yield* tagOf(
          harness.call("pair_handoff", { messageKey: "m-2", text: "again", steer: true }),
        ),
      ).toBe("PairSteerLimitError");
      expect(yield* harness.commandTypes).toEqual(["thread.turn.start"]);
    }),
  );

  it.effect("cannot steer before the provider admits a turn", () =>
    Effect.gen(function* () {
      const starting = makeExecutor({
        session: runningSession({ status: "starting", activeTurnId: null }),
      });
      const harness = yield* makeHarness({ shells: [makeShell(LEAD_ID), starting] });
      expect(yield* tagOf(harness.call("pair_handoff", { ...brief, steer: true }))).toBe(
        "PairExecutorBusyError",
      );
    }),
  );

  it.effect("treats steer on an idle executor as an ordinary brief", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        shells: [makeShell(LEAD_ID), makeExecutor({ latestTurn: completedTurn() })],
      });
      expect(yield* harness.call("pair_handoff", { ...brief, steer: true })).toMatchObject({
        messageId: `pair-message:${EXECUTOR_ID}:m-1`,
        steered: false,
      });
    }),
  );

  it.effect("never sends the same messageKey twice", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        shells: [makeShell(LEAD_ID), makeExecutor({ latestTurn: completedTurn() })],
        existingMessageIds: [`pair-message:${EXECUTOR_ID}:m-1`],
      });
      expect(yield* harness.call("pair_handoff", brief)).toMatchObject({ accepted: true });
      expect(yield* harness.commandTypes).toEqual([]);
    }),
  );

  it.effect("rejects an invalid messageKey before any lookup", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ shells: [makeShell(LEAD_ID), makeExecutor()] });
      expect(
        yield* tagOf(harness.call("pair_handoff", { messageKey: "bad key", text: "go" })),
      ).toBe("PairKeyInvalidError");
    }),
  );

  it.effect("maps dispatch rejections to errors the lead can act on", () =>
    Effect.gen(function* () {
      const consumed = yield* makeHarness({
        shells: [makeShell(LEAD_ID), makeExecutor()],
        rejectedCommandIds: [`server:mcp-pair-turn:${EXECUTOR_ID}:m-1`],
      });
      expect(yield* tagOf(consumed.call("pair_handoff", brief))).toBe(
        "PairMessageKeyConsumedError",
      );
      const invariant = yield* makeHarness({
        shells: [makeShell(LEAD_ID), makeExecutor()],
        reject: (command) =>
          command.type === "thread.turn.start"
            ? new OrchestrationCommandInvariantError({
                commandType: command.type,
                detail: "Thread is rolling back.",
              })
            : null,
      });
      expect(yield* invariant.call("pair_handoff", brief).pipe(Effect.flip)).toMatchObject({
        _tag: "PairTurnRejectedError",
        detail: "Thread is rolling back.",
      });
    }),
  );
});

describe("pair_await", () => {
  const finished = makeExecutor({
    latestTurn: completedTurn({ assistantMessageId: MessageId.make("a-1") }),
  });
  const finishedDetail = detailOf(finished, {
    messages: [message("a-1", { text: "Done. Ran vp test." })],
    checkpoints: [
      {
        turnId: TurnId.make("turn-1"),
        checkpointTurnCount: 1,
        checkpointRef: CheckpointRef.make("ref-1"),
        status: "ready",
        files: [{ path: "src/a.ts", kind: "modified", additions: 3, deletions: 1 }],
        assistantMessageId: null,
        completedAt: NOW,
      },
    ],
  });

  it.effect("fails without an executor", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      expect(yield* tagOf(harness.call("pair_await", {}))).toBe("PairNotActiveError");
    }),
  );

  it.effect("returns at once for an executor that is not running, with its result", () =>
    Effect.gen(function* () {
      const idle = yield* makeHarness({ shells: [makeShell(LEAD_ID), makeExecutor()] });
      // No TestClock advancement: waiting would hang this test.
      expect(yield* idle.call("pair_await", { maxSeconds: 45 })).toEqual({
        threadId: EXECUTOR_ID,
        state: "idle",
        waitedSeconds: 0,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        lastError: null,
        assistantMessage: null,
        filesChanged: [],
        turnCount: 0,
      });

      const done = yield* makeHarness({
        shells: [makeShell(LEAD_ID), finished],
        details: [finishedDetail],
      });
      expect(yield* done.call("pair_await", { maxSeconds: 45 })).toEqual({
        threadId: EXECUTOR_ID,
        state: "completed",
        waitedSeconds: 0,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        lastError: null,
        assistantMessage: {
          messageId: "a-1",
          text: "Done. Ran vp test.",
          truncated: false,
          createdAt: NOW,
        },
        filesChanged: [{ path: "src/a.ts", kind: "modified", additions: 3, deletions: 1 }],
        turnCount: 1,
      });
    }),
  );

  it.effect("returns at once when the executor needs the user", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        shells: [makeShell(LEAD_ID), runningExecutor({ hasPendingApprovals: true })],
      });
      expect(yield* harness.call("pair_await", { maxSeconds: 45 })).toMatchObject({
        state: "running",
        waitedSeconds: 0,
        hasPendingApprovals: true,
        assistantMessage: null,
      });
    }),
  );

  it.effect("waits until the executor stops running, then returns its result", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        shells: [makeShell(LEAD_ID), runningExecutor()],
        details: [finishedDetail],
      });
      const fiber = yield* Effect.forkChild(harness.call("pair_await", { maxSeconds: 30 }));
      yield* TestClock.adjust("3 seconds");
      harness.shells.set(EXECUTOR_ID, finished);
      yield* TestClock.adjust("1 second");
      expect(yield* Fiber.join(fiber)).toMatchObject({
        state: "completed",
        waitedSeconds: 4,
        assistantMessage: { text: "Done. Ran vp test." },
        turnCount: 1,
      });
    }),
  );

  it.effect("reports the session error of a failed executor", () =>
    Effect.gen(function* () {
      const failed = makeExecutor({
        latestTurn: completedTurn({ state: "error" }),
        session: runningSession({ status: "error", activeTurnId: null, lastError: "quota" }),
      });
      const harness = yield* makeHarness({ shells: [makeShell(LEAD_ID), failed] });
      expect(yield* harness.call("pair_await", {})).toMatchObject({
        state: "error",
        lastError: "quota",
      });
    }),
  );

  it.effect("lowers the wait to what the lead's provider tool timeout allows", () =>
    Effect.gen(function* () {
      // A Prime lead cancels tool calls at 60 seconds, so 150 becomes 45.
      const prime = yield* makeHarness({ shells: [makeShell(LEAD_ID), runningExecutor()] });
      const primeFiber = yield* Effect.forkChild(prime.call("pair_await", { maxSeconds: 150 }));
      yield* TestClock.adjust("45 seconds");
      expect(yield* Fiber.join(primeFiber)).toMatchObject({ state: "running", waitedSeconds: 45 });

      // Pylon sets Codex's tool timeout itself, so a Codex lead may wait 150.
      const codexLead = yield* makeHarness({ shells: [makeShell(LEAD_ID), runningExecutor()] });
      const codexFiber = yield* Effect.forkChild(
        codexLead.call(
          "pair_await",
          { maxSeconds: 150 },
          invocation({ providerInstanceId: CODEX }),
        ),
      );
      yield* TestClock.adjust("150 seconds");
      expect(yield* Fiber.join(codexFiber)).toMatchObject({
        state: "running",
        waitedSeconds: 150,
      });
    }),
  );

  it.effect("does not wait at all when maxSeconds is omitted", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ shells: [makeShell(LEAD_ID), runningExecutor()] });
      expect(yield* harness.call("pair_await", {})).toMatchObject({
        state: "running",
        waitedSeconds: 0,
      });
    }),
  );
});

describe("pair_stop", () => {
  it.effect("interrupts a running executor with a unique command id", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ shells: [makeShell(LEAD_ID), runningExecutor()] });
      expect(yield* harness.call("pair_stop", {})).toEqual({
        threadId: EXECUTOR_ID,
        interrupted: true,
        state: "running",
      });
      const recorded = yield* Ref.get(harness.commands);
      expect(recorded.map((command) => command.type)).toEqual(["thread.turn.interrupt"]);
      expect(recorded[0]?.commandId.startsWith(`server:mcp-pair-interrupt:${EXECUTOR_ID}:`)).toBe(
        true,
      );
    }),
  );

  it.effect("does nothing when the executor is not running", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        shells: [makeShell(LEAD_ID), makeExecutor({ latestTurn: completedTurn() })],
      });
      expect(yield* harness.call("pair_stop", {})).toEqual({
        threadId: EXECUTOR_ID,
        interrupted: false,
        state: "completed",
      });
      expect(yield* harness.commandTypes).toEqual([]);
    }),
  );
});
