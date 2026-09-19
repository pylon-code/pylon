import {
  ApprovalRequestId,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  RuntimeSessionId,
  RuntimeTaskId,
  TurnId,
  type AntigravitySettings,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderSetupError,
  type ProviderUserInputAnswers,
  type RuntimeTaskStatus,
  type ThreadId,
  type ThreadTokenUsageSnapshot,
  type TurnCompletedPayload,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { ServerConfig } from "../../config.ts";
import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import type { AntigravityAuth } from "../AntigravityAuth.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import {
  ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE,
  isAntigravitySignInRequiredError,
} from "../antigravityAuthSupport.ts";
import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import { parsePermissionRequest, type AcpToolCallState } from "../acp/AcpRuntimeModel.ts";
import type * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import {
  antigravityPermissionMode,
  antigravityModelOptions,
  applyAntigravityAcpModelSelection,
  buildAntigravityPrompt,
  type AntigravityAcpRuntimeInput,
  resolveAntigravityModel,
} from "../acp/AntigravityAcpSupport.ts";
import {
  antigravityApprovalOptions,
  antigravitySubagentOutput,
  classifyAntigravitySubagentToolCall,
  extractAntigravityUserInputQuestion,
  isAntigravityOpenCommand,
  isAntigravitySubagentReplayStart,
  isAntigravityUserInputRequest,
  makeAntigravityUserInputResponse,
  normalizeAntigravityToolCall,
  sanitizeAntigravityToolPayload,
  selectAntigravityPermissionOptionId,
} from "../acp/AntigravityProtocol.ts";
import {
  formatAntigravityErrorMessage,
  isAntigravityCorruptedSessionError,
} from "../acp/AntigravityErrors.ts";
import { AntigravityTaskNotificationBuffer } from "../acp/AntigravityTaskNotification.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { BUILT_IN_ADAPTER_CONVERSATION_ROLLBACK_MODES } from "../Services/ProviderAdapter.ts";

const PROVIDER = ProviderDriverKind.make("antigravity");
const ResumeCursor = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sessionId: Schema.NonEmptyString,
});
const decodeResumeCursor = Schema.decodeUnknownOption(ResumeCursor);
const isAcpError = Schema.is(EffectAcpErrors.AcpError);
const isProviderAdapterRequestError = Schema.is(ProviderAdapterRequestError);
const isProviderAdapterSessionClosedError = Schema.is(ProviderAdapterSessionClosedError);
const isAcpTransportError = Schema.is(EffectAcpErrors.AcpTransportError);

type Adapter = ProviderAdapterShape<ProviderAdapterError>;
type Runtime = Pick<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  | "handleRequestPermission"
  | "handleReadTextFile"
  | "handleWriteTextFile"
  | "start"
  | "setMode"
  | "setModel"
  | "getConfigOptions"
  | "getEvents"
  | "drainEvents"
  | "prompt"
  | "cancel"
>;
type NativePermission = EffectAcpSchema.RequestPermissionRequest;
type NativePermissionResponse = EffectAcpSchema.RequestPermissionResponse;

function mapAntigravityError(threadId: ThreadId, method: string, cause: EffectAcpErrors.AcpError) {
  if (isAntigravitySignInRequiredError(cause)) {
    return new ProviderAdapterRequestError({
      provider: PROVIDER,
      method,
      detail: ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE,
      cause,
    });
  }
  const error = mapAcpToAdapterError(PROVIDER, threadId, method, cause);
  return isProviderAdapterRequestError(error)
    ? new ProviderAdapterRequestError({
        provider: PROVIDER,
        method,
        detail: formatAntigravityErrorMessage(error.detail),
        cause,
      })
    : error;
}

export interface AntigravityAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly makeRuntime: (
    input: Omit<AntigravityAcpRuntimeInput, "spawn" | "childProcessSpawner" | "onAuthorizationUrl">,
  ) => Effect.Effect<Runtime, EffectAcpErrors.AcpError | ProviderSetupError, Scope.Scope>;
  readonly withProcess: AntigravityAuth["withProcess"];
  readonly onSessionStarted?: (
    started: AcpSessionRuntime.AcpSessionRuntimeStartResult,
    cwd: string,
  ) => Effect.Effect<void>;
  readonly onAvailableCommands?: (
    commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
    cwd: string,
  ) => Effect.Effect<void>;
  readonly onConfigOptionsUpdated?: (
    configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  ) => Effect.Effect<void>;
  readonly onAuthRequired?: Effect.Effect<void>;
  /** Model the provider default alias selects, when the account offers it. */
  readonly defaultModel?: Effect.Effect<string | undefined>;
  /** The pinned ACP bridge omits usage; its native conversation DB retains context estimates. */
  readonly readNativeContext?: (
    nativeSessionId: string,
  ) => Effect.Effect<ThreadTokenUsageSnapshot | undefined>;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

interface PendingApproval {
  readonly request: NativePermission;
  readonly response: Deferred.Deferred<{
    readonly decision: ProviderApprovalDecision;
    readonly result: NativePermissionResponse;
  }>;
}

interface PendingQuestion {
  readonly request: NativePermission;
  readonly response: Deferred.Deferred<{
    readonly answers: ProviderUserInputAnswers;
    readonly result: NativePermissionResponse;
  }>;
}

interface OpenCommand {
  readonly toolCall: AcpToolCallState;
  readonly turnId: TurnId | undefined;
  readonly promoted: boolean;
}

interface OpenSubagent {
  readonly turnId: TurnId | undefined;
  readonly status: "pending" | "running" | undefined;
  readonly description?: string;
}

function subagentLinkage(toolCallId: string) {
  return {
    taskId: RuntimeTaskId.make(toolCallId),
    taskType: "subagent_batch",
    toolUseId: toolCallId,
    title: "Antigravity subagent batch",
  };
}

interface TurnIntent {
  readonly turnId: TurnId;
  readonly generation: number;
  settled: boolean;
}

interface SessionContext {
  readonly threadId: ThreadId;
  readonly sessionIncarnationId: RuntimeSessionId;
  readonly cwd: string;
  nativeSessionId: string;
  readonly scope: Scope.Closeable;
  runtime: Runtime;
  readonly promptLock: Semaphore.Semaphore;
  readonly stopLock: Semaphore.Semaphore;
  readonly commandLock: Semaphore.Semaphore;
  readonly approvals: Map<ApprovalRequestId, PendingApproval>;
  readonly questions: Map<ApprovalRequestId, PendingQuestion>;
  readonly commands: Map<string, OpenCommand>;
  readonly assistantMessageLock: Semaphore.Semaphore;
  readonly assistantContinuationCounts: Map<string, number>;
  readonly assistantMessages: Map<
    string,
    {
      buffer: AntigravityTaskNotificationBuffer;
      outputItemId: string;
      lastTextAt: Option.Option<number>;
      turnId: TurnId | undefined;
      started: boolean;
    }
  >;
  /** Keep only IDs after settlement or MCP exclusion so merged late updates cannot change identity. */
  readonly subagents: Map<string, OpenSubagent | "finished" | "mcp">;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  session: ProviderSession;
  activeTurnId: TurnId | undefined;
  promptFiber: Fiber.Fiber<EffectAcpSchema.PromptResponse, EffectAcpErrors.AcpError> | undefined;
  transportId: number;
  transportScope: Scope.Closeable | undefined;
  recoveryFiber: Fiber.Fiber<unknown, unknown> | undefined;
  forcedCancelOccurred: boolean;
  unrecoverableError: string | undefined;
  generation: number;
  stopped: boolean;
  closed: boolean;
  disconnected: boolean;
  userCancelRequested: boolean;
  explicitStopRequested: boolean;
  pendingSteer: boolean;
  anonymousMessageCount: number;
  currentAnonymousItemId: string | undefined;
  fatalError: string | undefined;
}

const CLIENT_FILE_MAX_BYTES = 8 * 1024 * 1024;

function isForcedCancellationError(error: unknown): boolean {
  return (
    isAcpError(error) &&
    error._tag === "AcpTransportError" &&
    error.detail?.startsWith(
      "The ACP agent did not finish cancellation. Its process was stopped.",
    ) === true
  );
}

function extractCauseError<E>(cause: Cause.Cause<E>): E | undefined {
  return Option.getOrUndefined(Cause.findErrorOption(cause));
}

function isInsideRoot(path: Path.Path, root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Resolves an agent-supplied path and rejects anything outside the session roots. */
const resolveClientFilePath = Effect.fn("AntigravityAdapter.resolveClientFilePath")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly allowedRoots: ReadonlyArray<string>;
    readonly requestPath: string;
  }) {
    const { path, fileSystem } = input;
    const resolved = path.resolve(input.requestPath);
    // Follow symlinks by resolving the closest existing ancestor directory so
    // that paths with non-existent subdirectories (like new files) match canonical roots.
    const findExistingAncestorReal = (current: string): Effect.Effect<string> =>
      fileSystem.realPath(current).pipe(
        Effect.catch(() => {
          const parentDir = path.dirname(current);
          if (parentDir === current) return Effect.succeed(current);
          return findExistingAncestorReal(parentDir).pipe(
            Effect.map((realParent) => path.join(realParent, path.basename(current))),
          );
        }),
      );
    const real = yield* findExistingAncestorReal(resolved);
    const roots = yield* Effect.forEach(input.allowedRoots, (root) =>
      fileSystem.realPath(root).pipe(Effect.orElseSucceed(() => root)),
    );
    if (!roots.some((root) => isInsideRoot(path, root, real))) {
      return yield* EffectAcpErrors.AcpRequestError.invalidParams(
        `Path '${input.requestPath}' is outside the session workspace.`,
      );
    }
    return real;
  },
);

const readClientTextFile = Effect.fn("AntigravityAdapter.readClientTextFile")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly allowedRoots: ReadonlyArray<string>;
  readonly request: EffectAcpSchema.ReadTextFileRequest;
}): Effect.fn.Return<EffectAcpSchema.ReadTextFileResponse, EffectAcpErrors.AcpError> {
  const filePath = yield* resolveClientFilePath({ ...input, requestPath: input.request.path });
  const info = yield* input.fileSystem
    .stat(filePath)
    .pipe(
      Effect.mapError(() =>
        EffectAcpErrors.AcpRequestError.resourceNotFound(`File '${input.request.path}' not found.`),
      ),
    );
  if (info.type !== "File" || Number(info.size) > CLIENT_FILE_MAX_BYTES) {
    return yield* EffectAcpErrors.AcpRequestError.invalidParams(
      `File '${input.request.path}' is not a readable text file under ${CLIENT_FILE_MAX_BYTES} bytes.`,
    );
  }
  const text = yield* input.fileSystem
    .readFileString(filePath)
    .pipe(
      Effect.mapError(() =>
        EffectAcpErrors.AcpRequestError.internalError(`Could not read '${input.request.path}'.`),
      ),
    );
  const line = input.request.line ?? undefined;
  const limit = input.request.limit ?? undefined;
  if (line === undefined && limit === undefined) {
    return { content: text };
  }
  // ACP lines are 1-indexed. `limit` is a line count.
  const lines = text.split("\n");
  const start = Math.max(0, (line ?? 1) - 1);
  const end = limit === undefined ? lines.length : Math.min(lines.length, start + limit);
  return { content: lines.slice(start, end).join("\n") };
});

const writeClientTextFile = Effect.fn("AntigravityAdapter.writeClientTextFile")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly allowedRoots: ReadonlyArray<string>;
  readonly request: EffectAcpSchema.WriteTextFileRequest;
}): Effect.fn.Return<EffectAcpSchema.WriteTextFileResponse, EffectAcpErrors.AcpError> {
  const filePath = yield* resolveClientFilePath({ ...input, requestPath: input.request.path });
  yield* input.fileSystem.makeDirectory(input.path.dirname(filePath), { recursive: true }).pipe(
    Effect.andThen(input.fileSystem.writeFileString(filePath, input.request.content)),
    Effect.mapError(() =>
      EffectAcpErrors.AcpRequestError.internalError(`Could not write '${input.request.path}'.`),
    ),
  );
  return {};
});

/** Keeps one official ACP process per thread and drains a cancelled prompt before steering. */
export const makeAntigravityAdapter = Effect.fn("makeAntigravityAdapter")(function* (
  settings: AntigravitySettings,
  options: AntigravityAdapterOptions,
) {
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;
  const ownerScope = yield* Effect.scope;
  const makeNativeLoggers = yield* makeAcpNativeLoggerFactory();
  const sessions = new Map<ThreadId, SessionContext>();
  const locks = yield* SynchronizedRef.make(new Map<ThreadId, Semaphore.Semaphore>());
  const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const randomId = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "crypto/randomUUIDv4",
          detail: "Could not create an Antigravity event ID.",
          cause,
        }),
    ),
  );
  const stamp = Effect.all({
    eventId: Effect.map(randomId, EventId.make),
    createdAt: nowIso,
  });
  const emit = (context: SessionContext, event: ProviderRuntimeEvent) =>
    PubSub.publish(events, {
      ...event,
      // The immutable context owns late events even after routing moves to a
      // replacement session. Never infer the incarnation from the session map.
      sessionIncarnationId: context.sessionIncarnationId,
    }).pipe(Effect.asVoid);

  const assistantMessage = (context: SessionContext, itemId: string) => {
    const key =
      itemId ||
      (context.currentAnonymousItemId ??= `${context.activeTurnId ?? "turn"}:msg-${++context.anonymousMessageCount}`);
    const existing = context.assistantMessages.get(key);
    if (existing) return existing;
    const continuation = context.assistantContinuationCounts.get(key) ?? 0;
    const outputItemId = continuation === 0 ? key : `${key}:continuation:${continuation}`;
    const message = {
      buffer: new AntigravityTaskNotificationBuffer(outputItemId),
      outputItemId,
      lastTextAt: Option.none<number>(),
      turnId: context.activeTurnId,
      started: false,
    };
    context.assistantMessages.set(key, message);
    return message;
  };

  const emitAssistantText = Effect.fn("AntigravityAdapter.emitAssistantText")(function* (
    context: SessionContext,
    itemId: string,
    text: string,
    rawPayload: unknown,
  ) {
    if (context.fatalError) return;
    const message = assistantMessage(context, itemId);
    // ACP content is model-authored data, including quoted logs and errors.
    // Session failure must come from the provider protocol, not this text.
    if (!text) return;
    if (itemId && !message.started) {
      yield* emit(
        context,
        makeAcpAssistantItemEvent({
          stamp: yield* stamp,
          provider: PROVIDER,
          threadId: context.threadId,
          turnId: message.turnId,
          itemId: message.outputItemId,
          lifecycle: "item.started",
        }),
      );
    }
    message.started = true;
    yield* emit(
      context,
      makeAcpContentDeltaEvent({
        stamp: yield* stamp,
        provider: PROVIDER,
        threadId: context.threadId,
        turnId: message.turnId,
        ...(itemId ? { itemId: message.outputItemId } : {}),
        text,
        rawPayload,
      }),
    );
  });

  const completeAssistantText = Effect.fn("AntigravityAdapter.completeAssistantText")(function* (
    context: SessionContext,
    itemId: string,
  ) {
    const message = context.assistantMessages.get(itemId);
    if (itemId && message?.started) {
      yield* emit(
        context,
        makeAcpAssistantItemEvent({
          stamp: yield* stamp,
          provider: PROVIDER,
          threadId: context.threadId,
          turnId: message.turnId,
          itemId: message.outputItemId,
          lifecycle: "item.completed",
        }),
      );
    }
    context.assistantMessages.delete(itemId);
  });

  const finishAssistantMessage = Effect.fn("AntigravityAdapter.finishAssistantMessage")(function* (
    context: SessionContext,
    itemId: string,
  ) {
    const key = itemId || context.currentAnonymousItemId || "";
    const message = context.assistantMessages.get(key);
    if (!message) return;
    let textItemId = key;
    let segment = 0;
    for (const part of message.buffer.finish()) {
      if (part.type === "text") {
        assistantMessage(context, textItemId).turnId = message.turnId;
        yield* emitAssistantText(context, textItemId, part.text, {});
        continue;
      }
      // Completing the previous item is essential: ingestion keeps appending
      // to its active assistant segment until it receives item.completed.
      yield* completeAssistantText(context, textItemId);
      textItemId = `${message.outputItemId}:after-task:${++segment}`;
      const notification = part.notification;
      // Native task IDs are not ACP tool IDs. Do not correlate by command text:
      // the same command may be running more than once at the same time.
      const status =
        notification.status === "completed"
          ? "completed"
          : notification.status !== undefined
            ? "failed"
            : notification.exitCode === 0
              ? "completed"
              : "failed";
      yield* emit(
        context,
        makeAcpToolCallEvent({
          stamp: yield* stamp,
          provider: PROVIDER,
          threadId: context.threadId,
          turnId: message.turnId,
          toolCall: normalizeAntigravityToolCall({
            toolCallId: `antigravity-task:${notification.taskId}`,
            kind: "execute",
            status,
            title: "Background command result",
            data: {
              taskId: notification.taskId,
              rawInput: { CommandLine: notification.command },
              rawOutput: {
                combinedOutput: notification.output,
                ...(notification.exitCode !== undefined ? { exitCode: notification.exitCode } : {}),
                ...(notification.status !== undefined ? { status: notification.status } : {}),
              },
            },
          }),
          rawPayload: { taskId: notification.taskId },
        }),
      );
    }
    yield* completeAssistantText(context, textItemId);
    if (key === context.currentAnonymousItemId) {
      context.currentAnonymousItemId = undefined;
    }
  });

  const finishAssistantMessages = Effect.fn("AntigravityAdapter.finishAssistantMessages")(
    function* (context: SessionContext) {
      yield* context.assistantMessageLock.withPermit(
        Effect.gen(function* () {
          for (const itemId of context.assistantMessages.keys()) {
            yield* finishAssistantMessage(context, itemId);
          }
          context.assistantContinuationCounts.clear();
        }),
      );
    },
  );

  // Antigravity may keep session/prompt open after its final text while a
  // background command is pending. Publish quiet text segments independently
  // of prompt completion; this never completes the turn or cancels a tool.
  const publishIdleAssistantMessages = Effect.fn("AntigravityAdapter.publishIdleAssistantMessages")(
    function* (context: SessionContext) {
      while (!context.stopped) {
        yield* Effect.sleep("2 seconds");
        yield* context.assistantMessageLock.withPermit(
          Effect.gen(function* () {
            if (context.stopped || context.fatalError) return;
            const now = yield* Clock.currentTimeMillis;
            for (const [key, message] of context.assistantMessages) {
              if (
                Option.isNone(message.lastTextAt) ||
                now - message.lastTextAt.value < 2_000 ||
                !message.buffer.canFlushOnIdle()
              )
                continue;
              context.assistantContinuationCounts.set(
                key,
                (context.assistantContinuationCounts.get(key) ?? 0) + 1,
              );
              yield* finishAssistantMessage(context, key);
            }
          }),
        );
      }
    },
  );

  const withThreadLock = <A, E, R>(threadId: ThreadId, task: Effect.Effect<A, E, R>) =>
    SynchronizedRef.modifyEffect(locks, (current) => {
      const existing = current.get(threadId);
      if (existing) return Effect.succeed([existing, current] as const);
      return Semaphore.make(1).pipe(
        Effect.map((lock) => [lock, new Map(current).set(threadId, lock)] as const),
      );
    }).pipe(Effect.flatMap((lock) => lock.withPermit(task)));

  const requireSession = (threadId: ThreadId) => {
    const context = sessions.get(threadId);
    return context && !context.stopped
      ? Effect.succeed(context)
      : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
  };

  const cancelRequests = Effect.fn("AntigravityAdapter.cancelRequests")(function* (
    context: SessionContext,
  ) {
    for (const pending of context.approvals.values()) {
      yield* Deferred.succeed(pending.response, {
        decision: "cancel",
        result: { outcome: { outcome: "cancelled" } },
      });
    }
    for (const pending of context.questions.values()) {
      yield* Deferred.succeed(pending.response, {
        answers: {},
        result: { outcome: { outcome: "cancelled" } },
      });
    }
  });

  const finishBackgroundCommands = (context: SessionContext) =>
    context.commandLock.withPermit(
      Effect.gen(function* () {
        for (const [id, command] of context.commands) {
          if (!command.promoted) continue;
          yield* emit(context, {
            type: "task.completed",
            ...(yield* stamp),
            provider: PROVIDER,
            threadId: context.threadId,
            turnId: command.turnId,
            payload: {
              taskId: RuntimeTaskId.make(id),
              taskType: "local_bash",
              toolUseId: id,
              status: "stopped",
            },
          });
        }
        context.commands.clear();
      }),
    );

  const finishSubagents = (
    context: SessionContext,
    status: Extract<RuntimeTaskStatus, "cancelled" | "failed" | "idle">,
    error?: string,
  ) =>
    context.commandLock.withPermit(
      Effect.gen(function* () {
        for (const [id, subagent] of context.subagents) {
          if (subagent === "finished" || subagent === "mcp") continue;
          yield* emit(context, {
            type: "task.updated",
            ...(yield* stamp),
            provider: PROVIDER,
            threadId: context.threadId,
            turnId: subagent.turnId,
            payload: {
              ...subagentLinkage(id),
              status,
              ...(status === "idle"
                ? {
                    description: "Turn ended. Individual agent status is unavailable.",
                    timelineBypass: true,
                  }
                : {}),
              ...(error ? { error } : {}),
            },
          });
          context.subagents.set(id, "finished");
        }
      }),
    );

  const stopContext = (context: SessionContext) =>
    context.stopLock
      .withPermit(
        Effect.gen(function* () {
          if (context.closed) return;
          context.stopped = true;
          yield* Effect.gen(function* () {
            if (context.recoveryFiber) {
              yield* Fiber.interrupt(context.recoveryFiber);
            }
            yield* cancelRequests(context);
            if (context.promptFiber && !context.disconnected) {
              yield* Effect.ignore(context.runtime.cancel);
            }
          }).pipe(
            Effect.ensuring(
              Effect.all([
                context.transportScope
                  ? Scope.close(context.transportScope, Exit.void)
                  : Effect.void,
                Scope.close(context.scope, Exit.void),
              ]),
            ),
          );
          yield* finishAssistantMessages(context);
          if (context.fatalError) {
            context.session = {
              ...context.session,
              resumeCursor: undefined,
            };
          }
          context.closed = true;
          if (sessions.get(context.threadId) === context) sessions.delete(context.threadId);
          yield* finishBackgroundCommands(context);
          yield* finishSubagents(
            context,
            context.disconnected ? "failed" : "cancelled",
            context.disconnected
              ? (context.fatalError ?? "Antigravity process stopped.")
              : undefined,
          );
          context.subagents.clear();
          yield* emit(context, {
            type: "session.exited",
            ...(yield* stamp),
            provider: PROVIDER,
            threadId: context.threadId,
            payload: {
              exitKind: context.disconnected ? "error" : "graceful",
              ...(context.disconnected
                ? { reason: context.fatalError ?? "Antigravity process stopped." }
                : {}),
            },
          });
        }),
      )
      .pipe(Effect.uninterruptible);

  const handlePermission = Effect.fn("AntigravityAdapter.handlePermission")(function* (
    context: SessionContext,
    request: NativePermission,
    transportId?: number,
  ): Effect.fn.Return<NativePermissionResponse, ProviderAdapterError> {
    if (
      context.stopped ||
      request.sessionId !== context.nativeSessionId ||
      (transportId !== undefined && transportId !== context.transportId)
    ) {
      return { outcome: { outcome: "cancelled" } };
    }
    const requestId = ApprovalRequestId.make(yield* randomId);
    const runtimeRequestId = RuntimeRequestId.make(requestId);
    const turnId = context.activeTurnId;
    const rawPayload = sanitizeAntigravityToolPayload(request);

    if (isAntigravityUserInputRequest(request)) {
      const question = extractAntigravityUserInputQuestion(request);
      if (!question) return { outcome: { outcome: "cancelled" } };
      const response = yield* Deferred.make<{
        answers: ProviderUserInputAnswers;
        result: NativePermissionResponse;
      }>();
      context.questions.set(requestId, { request, response });
      return yield* Effect.gen(function* () {
        yield* emit(context, {
          type: "user-input.requested",
          ...(yield* stamp),
          provider: PROVIDER,
          threadId: context.threadId,
          turnId,
          requestId: runtimeRequestId,
          payload: { questions: [question] },
          raw: { source: "acp.jsonrpc", method: "session/request_permission", payload: rawPayload },
        });
        const answer = yield* Deferred.await(response);
        yield* emit(context, {
          type: "user-input.resolved",
          ...(yield* stamp),
          provider: PROVIDER,
          threadId: context.threadId,
          turnId,
          requestId: runtimeRequestId,
          payload: { answers: answer.answers },
        });
        return answer.result;
      }).pipe(Effect.ensuring(Effect.sync(() => context.questions.delete(requestId))));
    }

    const response = yield* Deferred.make<{
      decision: ProviderApprovalDecision;
      result: NativePermissionResponse;
    }>();
    context.approvals.set(requestId, { request, response });
    const parsed = parsePermissionRequest(request);
    const toolCall = parsed.toolCall ? normalizeAntigravityToolCall(parsed.toolCall) : undefined;
    const permissionRequest = {
      ...parsed,
      ...(toolCall ? { toolCall } : {}),
      detail:
        toolCall?.command ??
        toolCall?.detail ??
        toolCall?.title ??
        "Antigravity requests permission.",
    };
    return yield* Effect.gen(function* () {
      yield* emit(
        context,
        makeAcpRequestOpenedEvent({
          stamp: yield* stamp,
          provider: PROVIDER,
          threadId: context.threadId,
          turnId,
          requestId: runtimeRequestId,
          permissionRequest,
          approvalOptions: antigravityApprovalOptions(request),
          detail: permissionRequest.detail ?? "Antigravity requests permission.",
          args: rawPayload,
          source: "acp.jsonrpc",
          method: "session/request_permission",
          rawPayload,
        }),
      );
      const answer = yield* Deferred.await(response);
      yield* emit(
        context,
        makeAcpRequestResolvedEvent({
          stamp: yield* stamp,
          provider: PROVIDER,
          threadId: context.threadId,
          turnId,
          requestId: runtimeRequestId,
          permissionRequest,
          decision: answer.decision,
        }),
      );
      return answer.result;
    }).pipe(Effect.ensuring(Effect.sync(() => context.approvals.delete(requestId))));
  });

  const resumeTransport = Effect.fn("AntigravityAdapter.resumeTransport")(function* (
    context: SessionContext,
    model?: string,
  ): Effect.fn.Return<void, ProviderAdapterError> {
    if (context.stopped || context.explicitStopRequested) {
      return yield* new ProviderAdapterSessionClosedError({
        provider: PROVIDER,
        threadId: context.threadId,
      });
    }

    const resumeAction = Effect.gen(function* () {
      const oldScope = context.transportScope;
      if (oldScope) {
        yield* Scope.close(oldScope, Exit.void);
      }

      if (context.stopped || context.explicitStopRequested) {
        return yield* new ProviderAdapterSessionClosedError({
          provider: PROVIDER,
          threadId: context.threadId,
        });
      }

      const nextTransportId = ++context.transportId;
      const newTransportScope = yield* Scope.make("sequential");
      context.transportScope = newTransportScope;

      const mcp = McpProviderSession.readMcpProviderSession(context.threadId);
      const cwd = context.cwd;
      const allowedRoots = [cwd, serverConfig.attachmentsDir];

      const runtime = yield* options
        .makeRuntime({
          cwd,
          clientInfo: { name: "t3-code", version: "0.0.0" },
          clientFileSystem: true,
          ...(mcp?.agentDeviceEnvironment
            ? { agentDeviceEnvironment: mcp.agentDeviceEnvironment }
            : {}),
          additionalDirectories: [serverConfig.attachmentsDir],
          resumeSessionId: context.nativeSessionId,
          mcpServers: mcp
            ? [
                {
                  type: "http",
                  name: "t3-code",
                  url: mcp.endpoint,
                  headers: [{ name: "Authorization", value: mcp.authorizationHeader }],
                },
              ]
            : [],
          ...makeNativeLoggers({
            nativeEventLogger: options.nativeEventLogger,
            provider: PROVIDER,
            threadId: context.threadId,
          }),
        })
        .pipe(Effect.provideService(Scope.Scope, newTransportScope));

      if (context.stopped || context.explicitStopRequested) {
        yield* Scope.close(newTransportScope, Exit.void);
        return yield* new ProviderAdapterSessionClosedError({
          provider: PROVIDER,
          threadId: context.threadId,
        });
      }

      yield* runtime.handleReadTextFile((request) => {
        if (nextTransportId !== context.transportId || context.stopped) {
          return Effect.fail(EffectAcpErrors.AcpRequestError.internalError("Transport retired"));
        }
        return readClientTextFile({ fileSystem, path, allowedRoots, request });
      });

      yield* runtime.handleWriteTextFile((request) => {
        if (nextTransportId !== context.transportId || context.stopped) {
          return Effect.fail(EffectAcpErrors.AcpRequestError.internalError("Transport retired"));
        }
        return writeClientTextFile({ fileSystem, path, allowedRoots, request });
      });

      yield* runtime.handleRequestPermission((request) => {
        if (nextTransportId !== context.transportId || context.stopped) {
          return Effect.succeed({
            outcome: { outcome: "cancelled" as const },
          });
        }
        return handlePermission(context, request, nextTransportId).pipe(
          Effect.mapError((cause) =>
            EffectAcpErrors.AcpRequestError.internalError(
              "Could not process an Antigravity permission request.",
              undefined,
              { cause },
            ),
          ),
        );
      });

      const started = yield* runtime
        .start()
        .pipe(
          Effect.mapError((cause) => mapAntigravityError(context.threadId, "session/start", cause)),
        );

      if (context.stopped || context.explicitStopRequested) {
        yield* Scope.close(newTransportScope, Exit.void);
        return yield* new ProviderAdapterSessionClosedError({
          provider: PROVIDER,
          threadId: context.threadId,
        });
      }

      context.nativeSessionId = started.sessionId;
      context.runtime = runtime;
      context.session = {
        ...context.session,
        resumeCursor: { schemaVersion: 1, sessionId: started.sessionId },
      };
      context.disconnected = false;
      context.fatalError = undefined;
      context.unrecoverableError = undefined;

      yield* runtime.getEvents().pipe(
        Stream.runForEach((event) => handleEvent(context, event, nextTransportId)),
        Effect.catchCause(() => Effect.logError("Could not process an Antigravity runtime event.")),
        Effect.forkIn(newTransportScope),
      );

      yield* applyAntigravityAcpModelSelection({
        runtime,
        model: model ?? context.session.model,
        defaultModel: yield* options.defaultModel ?? Effect.succeed(undefined),
        mapError: (cause) => cause,
      }).pipe(
        Effect.mapError((cause) => mapAntigravityError(context.threadId, "session/model", cause)),
      );

      if (context.stopped || context.explicitStopRequested) {
        yield* Scope.close(newTransportScope, Exit.void);
        return yield* new ProviderAdapterSessionClosedError({
          provider: PROVIDER,
          threadId: context.threadId,
        });
      }

      yield* runtime
        .setMode(antigravityPermissionMode(context.session.runtimeMode))
        .pipe(
          Effect.mapError((cause) => mapAntigravityError(context.threadId, "session/mode", cause)),
        );

      if (context.stopped || context.explicitStopRequested) {
        yield* Scope.close(newTransportScope, Exit.void);
        return yield* new ProviderAdapterSessionClosedError({
          provider: PROVIDER,
          threadId: context.threadId,
        });
      }

      yield* options.onSessionStarted?.(started, context.cwd) ?? Effect.void;
      yield* runtime.drainEvents;

      if (context.stopped || context.explicitStopRequested) {
        yield* Scope.close(newTransportScope, Exit.void);
        return yield* new ProviderAdapterSessionClosedError({
          provider: PROVIDER,
          threadId: context.threadId,
        });
      }
    });

    const stopOwned = Effect.suspend(() => stopContext(context).pipe(Effect.ignore));
    return yield* options.withProcess(stopOwned, resumeAction).pipe(
      Effect.provideService(Scope.Scope, context.scope),
      Effect.mapError((cause) =>
        isAcpError(cause)
          ? mapAntigravityError(context.threadId, "session/resume", cause)
          : isProviderAdapterRequestError(cause) || isProviderAdapterSessionClosedError(cause)
            ? cause
            : new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/resume",
                detail: "Could not resume Antigravity. Check the provider setup status.",
                cause,
              }),
      ),
    );
  });

  const handleEvent = Effect.fn("AntigravityAdapter.handleEvent")(function* (
    context: SessionContext,
    event: AcpSessionRuntime.AcpSessionRuntimeEvent,
    transportId?: number,
  ) {
    if (transportId !== undefined && transportId !== context.transportId) {
      if (event._tag === "EventStreamBarrier") {
        yield* Deferred.succeed(event.acknowledge, undefined);
      }
      return;
    }

    if (event._tag === "EventStreamBarrier") {
      yield* Deferred.succeed(event.acknowledge, undefined);
      return;
    }
    if (context.stopped) return;
    if (context.fatalError && event._tag !== "ConnectionTerminated") return;
    switch (event._tag) {
      case "ModeChanged":
        return;
      case "AvailableCommandsUpdated":
        yield* options.onAvailableCommands?.(event.availableCommands, context.cwd) ?? Effect.void;
        return;
      case "ConfigOptionsUpdated":
        yield* options.onConfigOptionsUpdated?.(event.configOptions) ?? Effect.void;
        return;
      case "ConnectionTerminated": {
        context.disconnected = true;
        const isForcedCancel = isForcedCancellationError(event.error);
        if (
          isForcedCancel &&
          context.pendingSteer &&
          !context.explicitStopRequested &&
          !context.stopped
        ) {
          context.forcedCancelOccurred = true;
          return;
        }
        if (context.fatalError === undefined) {
          context.fatalError =
            event.error._tag === "AcpTransportError" && event.error.detail
              ? event.error.detail
              : event.error.message;
        }
        context.unrecoverableError = context.fatalError;
        context.stopped = true;
        yield* stopContext(context).pipe(Effect.forkIn(ownerScope));
        return;
      }
      case "AssistantItemStarted":
        yield* context.assistantMessageLock.withPermit(
          Effect.sync(() => assistantMessage(context, event.itemId)),
        );
        return;
      case "AssistantItemCompleted":
        yield* context.assistantMessageLock.withPermit(
          Effect.gen(function* () {
            yield* finishAssistantMessage(context, event.itemId);
            context.assistantContinuationCounts.delete(event.itemId);
          }),
        );
        return;
      case "ContentDelta": {
        yield* context.assistantMessageLock.withPermit(
          Effect.gen(function* () {
            const itemId = event.itemId ?? event.messageId ?? "";
            const message = assistantMessage(context, itemId);
            if (event.text.length > 0)
              message.lastTextAt = Option.some(yield* Clock.currentTimeMillis);
            const text = message.buffer.push(event.text);
            yield* emitAssistantText(
              context,
              itemId || context.currentAnonymousItemId || "",
              text,
              sanitizeAntigravityToolPayload(event.rawPayload),
            );
          }),
        );
        return;
      }
      case "ThoughtDelta":
        yield* emit(
          context,
          makeAcpContentDeltaEvent({
            stamp: yield* stamp,
            provider: PROVIDER,
            threadId: context.threadId,
            turnId: context.activeTurnId,
            streamKind: "reasoning_text",
            text: event.text,
            rawPayload: sanitizeAntigravityToolPayload(event.rawPayload),
          }),
        );
        return;
      case "PlanUpdated":
        yield* emit(
          context,
          makeAcpPlanUpdatedEvent({
            stamp: yield* stamp,
            provider: PROVIDER,
            threadId: context.threadId,
            turnId: context.activeTurnId,
            payload: event.payload,
            source: "acp.jsonrpc",
            method: "session/update",
            rawPayload: sanitizeAntigravityToolPayload(event.rawPayload),
          }),
        );
        return;
      case "ToolCallUpdated":
        yield* context.commandLock.withPermit(
          Effect.gen(function* () {
            if (context.fatalError) return;
            const toolCall = normalizeAntigravityToolCall(event.toolCall);
            // A failed tool may contain arbitrary command output. It does not
            // establish that the provider session itself has failed.
            const tracked = context.subagents.get(toolCall.toolCallId);
            if (tracked === "finished") return;
            const kind = classifyAntigravitySubagentToolCall(toolCall, event.rawPayload);
            const isMcp = tracked === "mcp" || kind === "mcp";
            if (isMcp) context.subagents.set(toolCall.toolCallId, "mcp");
            const subagent = tracked === "mcp" ? undefined : tracked;
            if (!isMcp && (subagent || kind === "subagent")) {
              const turnId = subagent?.turnId ?? context.activeTurnId;
              const linkage = subagentLinkage(toolCall.toolCallId);
              // Replay starts claim completion before the result says whether the call failed.
              if (
                context.activeTurnId === undefined &&
                isAntigravitySubagentReplayStart(event.rawPayload)
              ) {
                context.subagents.set(toolCall.toolCallId, { turnId, status: undefined });
                return;
              }
              if (toolCall.status === "failed") {
                const summary = antigravitySubagentOutput(toolCall);
                yield* emit(context, {
                  type: "task.completed",
                  ...(yield* stamp),
                  provider: PROVIDER,
                  threadId: context.threadId,
                  turnId,
                  payload: {
                    ...linkage,
                    status: toolCall.status,
                    ...(summary ? { summary } : {}),
                  },
                });
                context.subagents.set(toolCall.toolCallId, "finished");
              } else if (context.activeTurnId === undefined && toolCall.status === "completed") {
                yield* emit(context, {
                  type: "task.updated",
                  ...(yield* stamp),
                  provider: PROVIDER,
                  threadId: context.threadId,
                  turnId,
                  payload: {
                    ...linkage,
                    status: "idle",
                    description: "Individual agent status is unavailable for this earlier batch.",
                    timelineBypass: true,
                  },
                });
                context.subagents.set(toolCall.toolCallId, "finished");
              } else {
                // start_subagent returns after launching a batch. Its output is
                // the launch description, not a child result or completion.
                const status = toolCall.status === "pending" ? "pending" : "running";
                const description =
                  antigravitySubagentOutput(toolCall) ?? subagent?.description ?? linkage.title;
                if (subagent?.status !== status || subagent?.description !== description) {
                  yield* emit(context, {
                    type: "task.progress",
                    ...(yield* stamp),
                    provider: PROVIDER,
                    threadId: context.threadId,
                    turnId,
                    payload: { ...linkage, description, summary: description, status },
                  });
                }
                context.subagents.set(toolCall.toolCallId, { turnId, status, description });
              }
              return;
            }
            const existing = context.commands.get(toolCall.toolCallId);
            yield* emit(
              context,
              makeAcpToolCallEvent({
                stamp: yield* stamp,
                provider: PROVIDER,
                threadId: context.threadId,
                turnId: existing?.turnId ?? context.activeTurnId,
                toolCall,
                rawPayload: sanitizeAntigravityToolPayload(event.rawPayload),
              }),
            );
            if (isAntigravityOpenCommand(toolCall)) {
              context.commands.set(toolCall.toolCallId, {
                toolCall,
                turnId: existing?.turnId ?? context.activeTurnId,
                promoted: existing?.promoted ?? false,
              });
            } else if (toolCall.status === "completed" || toolCall.status === "failed") {
              context.commands.delete(toolCall.toolCallId);
              if (existing?.promoted) {
                yield* emit(context, {
                  type: "task.completed",
                  ...(yield* stamp),
                  provider: PROVIDER,
                  threadId: context.threadId,
                  turnId: existing.turnId,
                  payload: {
                    taskId: RuntimeTaskId.make(toolCall.toolCallId),
                    taskType: "local_bash",
                    toolUseId: toolCall.toolCallId,
                    status: toolCall.status === "failed" ? "failed" : "completed",
                  },
                });
              }
            }
          }),
        );
        return;
    }
  });

  const startSession: Adapter["startSession"] = (input) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        if (!settings.enabled) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "Enable Antigravity in provider settings before starting a thread.",
          });
        }
        if (
          (input.provider !== undefined && input.provider !== PROVIDER) ||
          (input.providerInstanceId !== undefined &&
            input.providerInstanceId !== options.instanceId) ||
          (input.modelSelection !== undefined &&
            input.modelSelection.instanceId !== options.instanceId)
        ) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "The Antigravity provider instance does not match the requested session.",
          });
        }
        if (!input.cwd?.trim()) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "The session requires a workspace directory.",
          });
        }
        const cursor = decodeResumeCursor(input.resumeCursor);
        if (input.resumeCursor !== undefined && Option.isNone(cursor)) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "The saved Antigravity session is invalid. Start a new thread.",
          });
        }
        const previous = sessions.get(input.threadId);
        if (previous) yield* stopContext(previous);
        const cwd = path.resolve(input.cwd);
        const sessionScope = yield* Scope.make("sequential");
        const transportScope = yield* Scope.make("sequential");
        const transportId = 1;
        let transferred = false;
        let context: SessionContext | undefined;
        yield* Effect.addFinalizer(() => {
          if (transferred) return Effect.void;
          sessions.delete(input.threadId);
          return Effect.all([
            Scope.close(transportScope, Exit.void),
            Scope.close(sessionScope, Exit.void),
          ]);
        });
        const stopOwned = Effect.suspend(() =>
          context ? stopContext(context).pipe(Effect.ignore) : Scope.close(sessionScope, Exit.void),
        );

        return yield* options
          .withProcess(
            stopOwned,
            Effect.gen(function* () {
              const mcp = McpProviderSession.readMcpProviderSession(input.threadId);
              // The attachments dir grant lets the agent read pasted files at
              // the paths ProviderService injects into the turn text. It is a
              // leaf directory holding only uploads.
              const runtime = yield* options
                .makeRuntime({
                  cwd,
                  clientInfo: { name: "t3-code", version: "0.0.0" },
                  clientFileSystem: true,
                  ...(mcp?.agentDeviceEnvironment
                    ? { agentDeviceEnvironment: mcp.agentDeviceEnvironment }
                    : {}),
                  additionalDirectories: [serverConfig.attachmentsDir],
                  ...(Option.isSome(cursor) ? { resumeSessionId: cursor.value.sessionId } : {}),
                  mcpServers: mcp
                    ? [
                        {
                          type: "http",
                          name: "t3-code",
                          url: mcp.endpoint,
                          headers: [{ name: "Authorization", value: mcp.authorizationHeader }],
                        },
                      ]
                    : [],
                  ...makeNativeLoggers({
                    nativeEventLogger: options.nativeEventLogger,
                    provider: PROVIDER,
                    threadId: input.threadId,
                  }),
                })
                .pipe(Effect.provideService(Scope.Scope, transportScope));
              // Workspace file access requested through the client fs
              // capability. The agent gates each write behind
              // `session/request_permission`, so only path containment is
              // checked here.
              const allowedRoots = [cwd, serverConfig.attachmentsDir];
              yield* runtime.handleReadTextFile((request) => {
                if (context && (transportId !== context.transportId || context.stopped)) {
                  return Effect.fail(
                    new EffectAcpErrors.AcpRequestError({
                      code: -32000,
                      errorMessage: "Transport retired",
                    }),
                  );
                }
                return readClientTextFile({ fileSystem, path, allowedRoots, request });
              });
              yield* runtime.handleWriteTextFile((request) => {
                if (context && (transportId !== context.transportId || context.stopped)) {
                  return Effect.fail(
                    new EffectAcpErrors.AcpRequestError({
                      code: -32000,
                      errorMessage: "Transport retired",
                    }),
                  );
                }
                return writeClientTextFile({ fileSystem, path, allowedRoots, request });
              });
              yield* runtime.handleRequestPermission((request) =>
                context
                  ? handlePermission(context, request, transportId).pipe(
                      Effect.mapError((cause) =>
                        EffectAcpErrors.AcpRequestError.internalError(
                          "Could not process an Antigravity permission request.",
                          undefined,
                          { cause },
                        ),
                      ),
                    )
                  : Effect.succeed({
                      outcome: { outcome: "cancelled" },
                    } satisfies NativePermissionResponse),
              );
              const started = yield* runtime.start();
              const model = yield* applyAntigravityAcpModelSelection({
                runtime,
                model: input.modelSelection?.model,
                defaultModel: yield* options.defaultModel ?? Effect.succeed(undefined),
                mapError: (cause) => cause,
              });
              yield* runtime.setMode(antigravityPermissionMode(input.runtimeMode));
              yield* options.onSessionStarted?.(started, cwd) ?? Effect.void;
              const createdAt = yield* nowIso;
              const sessionIncarnationId =
                input.sessionIncarnationId ?? RuntimeSessionId.make(yield* randomId);
              const session: ProviderSession = {
                provider: PROVIDER,
                providerInstanceId: options.instanceId,
                threadId: input.threadId,
                cwd,
                status: "ready",
                runtimeMode: input.runtimeMode,
                ...(model ? { model } : {}),
                resumeCursor: { schemaVersion: 1, sessionId: started.sessionId },
                sessionIncarnationId,
                createdAt,
                updatedAt: createdAt,
              };
              context = {
                threadId: input.threadId,
                sessionIncarnationId,
                cwd,
                nativeSessionId: started.sessionId,
                scope: sessionScope,
                transportId,
                transportScope,
                recoveryFiber: undefined,
                forcedCancelOccurred: false,
                unrecoverableError: undefined,
                runtime,
                promptLock: yield* Semaphore.make(1),
                stopLock: yield* Semaphore.make(1),
                commandLock: yield* Semaphore.make(1),
                approvals: new Map(),
                questions: new Map(),
                commands: new Map(),
                assistantMessageLock: yield* Semaphore.make(1),
                assistantContinuationCounts: new Map(),
                assistantMessages: new Map(),
                subagents: new Map(),
                turns: [],
                session,
                activeTurnId: undefined,
                promptFiber: undefined,
                generation: 0,
                stopped: false,
                closed: false,
                disconnected: false,
                userCancelRequested: false,
                explicitStopRequested: false,
                pendingSteer: false,
                anonymousMessageCount: 0,
                currentAnonymousItemId: undefined,
                fatalError: undefined,
              };
              const running = context;
              sessions.set(input.threadId, running);
              yield* publishIdleAssistantMessages(running).pipe(
                Effect.catchCause((cause) =>
                  Effect.logError("Could not publish an idle Antigravity message.", { cause }),
                ),
                Effect.forkIn(sessionScope),
              );
              yield* Stream.runForEach(runtime.getEvents(), (event) =>
                handleEvent(running, event, transportId),
              ).pipe(
                Effect.catchCause(() =>
                  Effect.logError("Could not process an Antigravity runtime event."),
                ),
                Effect.forkIn(transportScope),
              );
              yield* emit(running, {
                type: "session.started",
                ...(yield* stamp),
                provider: PROVIDER,
                threadId: input.threadId,
                payload: { resume: started.initializeResult },
              });
              yield* emit(running, {
                type: "session.state.changed",
                ...(yield* stamp),
                provider: PROVIDER,
                threadId: input.threadId,
                payload: { state: "ready", reason: "Antigravity ACP session ready" },
              });
              yield* emit(running, {
                type: "thread.started",
                ...(yield* stamp),
                provider: PROVIDER,
                threadId: input.threadId,
                payload: { providerThreadId: started.sessionId },
              });
              yield* runtime.drainEvents;
              if (running.stopped) {
                return yield* new ProviderAdapterSessionClosedError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                });
              }
              yield* refreshNativeContext(running, 0);
              transferred = true;
              return session;
            }),
          )
          .pipe(
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.tapError((cause) =>
              isAntigravitySignInRequiredError(cause)
                ? (options.onAuthRequired ?? Effect.void)
                : Effect.void,
            ),
            Effect.mapError((cause) =>
              isAcpError(cause)
                ? mapAntigravityError(input.threadId, "session/start", cause)
                : new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "session/start",
                    detail: "Could not start Antigravity. Check the provider setup status.",
                    cause,
                  }),
            ),
          );
      }).pipe(Effect.scoped),
    );

  const promoteBackgroundCommands = (context: SessionContext) =>
    context.commandLock.withPermit(
      Effect.gen(function* () {
        for (const [id, command] of context.commands) {
          if (command.promoted) continue;
          yield* emit(context, {
            type: "task.started",
            ...(yield* stamp),
            provider: PROVIDER,
            threadId: context.threadId,
            turnId: command.turnId,
            payload: {
              taskId: RuntimeTaskId.make(id),
              taskType: "local_bash",
              toolUseId: id,
              description:
                command.toolCall.command ?? command.toolCall.title ?? "Antigravity command",
            },
          });
          context.commands.set(id, { ...command, promoted: true });
        }
      }),
    );

  const refreshNativeContext = Effect.fn("AntigravityAdapter.refreshNativeContext")(function* (
    context: SessionContext,
    generation: number,
    turnId?: TurnId,
  ) {
    if (!options.readNativeContext || context.stopped || context.generation !== generation) return;
    const usage = yield* options.readNativeContext(context.nativeSessionId);
    if (!usage) return;
    yield* context.promptLock.withPermit(
      Effect.gen(function* () {
        // A read may finish after Stop, a replacement session, or a steering prompt.
        if (
          context.stopped ||
          context.generation !== generation ||
          sessions.get(context.threadId) !== context
        )
          return;
        yield* emit(context, {
          type: "thread.token-usage.updated",
          ...(yield* stamp),
          provider: PROVIDER,
          threadId: context.threadId,
          ...(turnId ? { turnId } : {}),
          payload: { usage },
        });
      }),
    );
  });

  const sendTurn: Adapter["sendTurn"] = Effect.fn("AntigravityAdapter.sendTurn")(function* (input) {
    const context = yield* requireSession(input.threadId);
    if (input.modelSelection && input.modelSelection.instanceId !== options.instanceId) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: "The selected model belongs to another provider instance.",
      });
    }
    const prompt = yield* buildAntigravityPrompt({
      input: input.input,
      attachments: input.attachments,
      attachmentsDir: serverConfig.attachmentsDir,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError((cause) => mapAntigravityError(input.threadId, "session/prompt", cause)),
    );
    let intent: TurnIntent | undefined;
    // The caller holds promptLock while it changes or settles the active turn.
    const finishTurn = (turn: TurnIntent, payload: TurnCompletedPayload) =>
      Effect.gen(function* () {
        if (turn.settled || context.generation !== turn.generation) return;
        turn.settled = true;
        context.userCancelRequested = false;
        context.explicitStopRequested = false;
        context.pendingSteer = false;
        yield* finishAssistantMessages(context);
        yield* promoteBackgroundCommands(context);
        yield* finishSubagents(
          context,
          payload.state === "cancelled"
            ? "cancelled"
            : payload.state === "failed"
              ? "failed"
              : "idle",
          payload.errorMessage,
        );
        context.activeTurnId = undefined;
        context.promptFiber = undefined;
        context.session = {
          ...context.session,
          status: payload.state === "failed" ? "error" : "ready",
          activeTurnId: undefined,
          updatedAt: yield* nowIso,
          ...(payload.errorMessage
            ? { lastError: payload.errorMessage }
            : { lastError: undefined }),
        };
        yield* emit(context, {
          type: "turn.completed",
          ...(yield* stamp),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId: turn.turnId,
          payload,
        });
      }).pipe(Effect.uninterruptible);

    const admitted = yield* Deferred.make<{
      threadId: ThreadId;
      turnId: TurnId;
      resumeCursor: ProviderSession["resumeCursor"];
    }>();
    const runTurn = Effect.gen(function* () {
      const launch = yield* context.promptLock.withPermit(
        Effect.gen(function* () {
          yield* requireSession(input.threadId);
          const requestedModel = input.modelSelection?.model ?? context.session.model;
          const configOptions = yield* context.runtime.getConfigOptions;
          const model = resolveAntigravityModel({
            configOptions,
            model: requestedModel,
            defaultModel: yield* options.defaultModel ?? Effect.succeed(undefined),
          });
          const availableModels = antigravityModelOptions(configOptions);
          if (model && !availableModels.some((option) => option.value === model)) {
            return yield* EffectAcpErrors.AcpRequestError.invalidParams(
              `Antigravity model '${model}' is unavailable for this Google account. Select an available model.`,
            );
          }
          const turnId = context.activeTurnId ?? TurnId.make(yield* randomId);
          const steering = context.activeTurnId !== undefined;
          const turn: TurnIntent = { turnId, generation: ++context.generation, settled: false };
          intent = turn;
          context.userCancelRequested = false;
          context.activeTurnId = turnId;
          if (!steering) {
            yield* emit(context, {
              type: "turn.started",
              ...(yield* stamp),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId,
              ...(input.admissionRequestId === undefined
                ? {}
                : { admissionRequestId: input.admissionRequestId }),
              payload: model ? { model } : {},
            });
          }
          if (context.promptFiber) {
            // A steer supersedes the running prompt at the user's request, so a
            // forced stop here settles the turn as cancelled, not failed.
            context.userCancelRequested = true;
            context.pendingSteer = true;
            yield* cancelRequests(context);
            yield* context.runtime.cancel;
            const promptExit = yield* Fiber.await(context.promptFiber);
            yield* Effect.ignore(context.runtime.drainEvents);
            yield* finishSubagents(context, "cancelled");
            context.promptFiber = undefined;

            if (Exit.isFailure(promptExit)) {
              const err = extractCauseError(promptExit.cause);
              if (err !== undefined) {
                if (isForcedCancellationError(err)) {
                  context.forcedCancelOccurred = true;
                  context.disconnected = true;
                } else {
                  const detail = isAcpTransportError(err)
                    ? err.detail
                    : err instanceof Error
                      ? err.message
                      : String(err);
                  context.unrecoverableError = detail;
                  context.fatalError = detail;
                  context.stopped = true;
                  context.disconnected = true;
                }
              }
            }
          }
          if (context.explicitStopRequested || context.stopped) {
            context.pendingSteer = false;
            context.stopped = true;
            yield* stopContext(context).pipe(Effect.forkIn(ownerScope));
            return yield* new ProviderAdapterSessionClosedError({
              provider: PROVIDER,
              threadId: input.threadId,
            });
          }
          if (context.unrecoverableError !== undefined) {
            context.pendingSteer = false;
            context.stopped = true;
            yield* stopContext(context).pipe(Effect.forkIn(ownerScope));
            return yield* new ProviderAdapterSessionClosedError({
              provider: PROVIDER,
              threadId: input.threadId,
            });
          }
          const shouldRecover =
            context.pendingSteer &&
            context.disconnected &&
            context.forcedCancelOccurred &&
            !context.explicitStopRequested &&
            !context.stopped;

          if (shouldRecover) {
            const recoveryFiber = yield* resumeTransport(context, model).pipe(Effect.forkChild);
            context.recoveryFiber = recoveryFiber;
            const resumed = yield* Fiber.await(recoveryFiber);
            context.recoveryFiber = undefined;
            context.pendingSteer = false;
            context.forcedCancelOccurred = false;
            if (Exit.isFailure(resumed)) {
              if (context.explicitStopRequested) {
                context.stopped = true;
                yield* finishTurn(turn, { state: "cancelled", stopReason: "cancelled" });
                yield* stopContext(context).pipe(Effect.forkIn(ownerScope));
                return yield* new ProviderAdapterSessionClosedError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                });
              }
              const resumeErr = extractCauseError(resumed.cause);
              const errorMessage =
                resumeErr !== undefined
                  ? isProviderAdapterRequestError(resumeErr)
                    ? resumeErr.detail
                    : resumeErr instanceof Error
                      ? resumeErr.message
                      : String(resumeErr)
                  : "Failed to resume native session transport.";
              context.stopped = true;
              context.fatalError = errorMessage;
              yield* finishTurn(turn, {
                state: "failed",
                errorMessage,
                stopReason: "error",
              });
              yield* stopContext(context).pipe(Effect.forkIn(ownerScope));
              return yield* Effect.failCause(resumed.cause);
            }
          } else if (context.disconnected) {
            context.pendingSteer = false;
            context.stopped = true;
            yield* stopContext(context).pipe(Effect.forkIn(ownerScope));
            return yield* new ProviderAdapterSessionClosedError({
              provider: PROVIDER,
              threadId: input.threadId,
            });
          } else {
            context.pendingSteer = false;
            yield* applyAntigravityAcpModelSelection({
              runtime: context.runtime,
              model,
              mapError: (cause) => cause,
            });
            yield* context.runtime.setMode(antigravityPermissionMode(context.session.runtimeMode));
          }
          if (context.explicitStopRequested || context.stopped) {
            return yield* new ProviderAdapterSessionClosedError({
              provider: PROVIDER,
              threadId: input.threadId,
            });
          }
          // Cancellation belonged to the superseded prompt, not this new dispatch.
          context.userCancelRequested = false;
          context.session = {
            ...context.session,
            status: "running",
            activeTurnId: turnId,
            ...(model ? { model } : {}),
            updatedAt: yield* nowIso,
          };
          const dispatched = yield* Deferred.make<void>();
          const fiber = yield* context.runtime
            .prompt(
              {
                prompt: [
                  ...prompt,
                  {
                    type: "text",
                    text: buildRuntimeInstructions({
                      harness: "Antigravity",
                      model,
                      browserAvailable: McpProviderSession.hasMcpProviderCapability(
                        input.threadId,
                        "preview",
                      ),
                      deviceAvailable: McpProviderSession.hasMcpProviderCapability(
                        input.threadId,
                        "device",
                      ),
                    }),
                  },
                ],
              },
              { dispatched },
            )
            .pipe(Effect.forkIn(context.scope));
          context.promptFiber = fiber;
          // Fiber.join can skip a scope-close waiter when the child is interrupted.
          // Unwrap the Exit after Fiber.await returns.
          yield* Effect.raceFirst(
            Deferred.await(dispatched),
            Fiber.await(fiber).pipe(
              Effect.flatMap((exit) => exit),
              Effect.asVoid,
            ),
          );
          return { turn, fiber, runtime: context.runtime };
        }),
      );
      yield* Deferred.succeed(admitted, {
        threadId: input.threadId,
        turnId: launch.turn.turnId,
        resumeCursor: context.session.resumeCursor,
      });
      const workerGeneration = launch.turn.generation;
      const result = yield* Fiber.await(launch.fiber).pipe(Effect.flatMap((exit) => exit));
      if (context.generation !== workerGeneration) {
        return {
          threadId: input.threadId,
          turnId: launch.turn.turnId,
          resumeCursor: context.session.resumeCursor,
        };
      }
      yield* launch.runtime.drainEvents;
      yield* refreshNativeContext(context, launch.turn.generation, launch.turn.turnId);
      if (context.generation !== workerGeneration) {
        return {
          threadId: input.threadId,
          turnId: launch.turn.turnId,
          resumeCursor: context.session.resumeCursor,
        };
      }
      if (context.stopped) {
        return yield* new ProviderAdapterSessionClosedError({
          provider: PROVIDER,
          threadId: input.threadId,
        });
      }
      const record = context.turns.find((turn) => turn.id === launch.turn.turnId);
      if (record) record.items.push(result);
      else context.turns.push({ id: launch.turn.turnId, items: [result] });
      const fatalError =
        context.fatalError ?? (context.disconnected ? "Antigravity process stopped." : undefined);
      if (fatalError) {
        context.session = {
          ...context.session,
          resumeCursor: undefined,
        };
        const settlementState =
          context.disconnected && context.userCancelRequested ? "cancelled" : "failed";
        yield* context.promptLock.withPermit(
          finishTurn(launch.turn, {
            state: settlementState,
            errorMessage: fatalError,
            stopReason: settlementState === "cancelled" ? "cancelled" : "error",
          }),
        );
        if (context.generation !== workerGeneration) {
          return {
            threadId: input.threadId,
            turnId: launch.turn.turnId,
            resumeCursor: context.session.resumeCursor,
          };
        }
        context.stopped = true;
        context.disconnected = true;
        yield* stopContext(context).pipe(Effect.forkIn(ownerScope));
      } else {
        yield* context.promptLock.withPermit(
          finishTurn(launch.turn, {
            state: result.stopReason === "cancelled" ? "cancelled" : "completed",
            stopReason: result.stopReason,
          }),
        );
      }
      return {
        threadId: input.threadId,
        turnId: launch.turn.turnId,
        resumeCursor: context.session.resumeCursor,
      };
    }).pipe(
      Effect.tapError((cause) => {
        if (intent && context.generation !== intent.generation) {
          return Effect.void;
        }
        return isAntigravitySignInRequiredError(cause)
          ? (options.onAuthRequired ?? Effect.void)
          : Effect.void;
      }),
      Effect.tapError((cause) =>
        Effect.sync(() => {
          // A transport-class failure of the prompt means the process is gone.
          // Record that here, before the ConnectionTerminated event is consumed,
          // so settlement below does not race the event consumer.
          if (!isAcpError(cause)) return;
          if (cause._tag !== "AcpTransportError" && cause._tag !== "AcpInputStreamEndedError") {
            return;
          }
          if (intent && context.generation !== intent.generation) {
            return;
          }
          context.disconnected = true;
          if (
            context.fatalError === undefined &&
            cause._tag === "AcpTransportError" &&
            cause.detail
          ) {
            context.fatalError = cause.detail;
          }
        }),
      ),
      Effect.mapError((cause) =>
        isAcpError(cause) ? mapAntigravityError(input.threadId, "session/prompt", cause) : cause,
      ),
      Effect.tapError((cause) =>
        Effect.suspend(() => {
          if (!intent) return Effect.void;
          const turn = intent;
          if (turn.settled || context.generation !== turn.generation) return Effect.void;
          return context.promptLock.withPermit(
            Effect.gen(function* () {
              if (turn.settled || context.generation !== turn.generation) return;
              const isCancelled = context.disconnected && context.userCancelRequested;
              const errorMessage =
                (context.disconnected
                  ? (context.fatalError ?? "Antigravity process stopped.")
                  : undefined) ??
                (isProviderAdapterRequestError(cause)
                  ? cause.detail
                  : formatAntigravityErrorMessage(cause.message));
              yield* finishTurn(turn, {
                state: isCancelled ? "cancelled" : "failed",
                errorMessage,
                stopReason: isCancelled ? "cancelled" : "error",
              });
            }),
          );
        }),
      ),
      Effect.tapError((cause) => {
        if (intent && context.generation !== intent.generation) {
          return Effect.void;
        }
        const errorText = isProviderAdapterRequestError(cause) ? cause.detail : cause.message;
        if (isAntigravityCorruptedSessionError(errorText)) {
          context.stopped = true;
          context.disconnected = true;
          return stopContext(context).pipe(Effect.forkIn(ownerScope));
        }
        return Effect.void;
      }),
      Effect.onInterrupt(() => {
        if (intent && context.generation !== intent.generation) {
          return Effect.void;
        }
        return context.promptLock.withPermit(
          Effect.gen(function* () {
            const turn = intent;
            if (!turn || turn.settled || context.generation !== turn.generation) return;
            const promptFiber = context.promptFiber;
            yield* cancelRequests(context);
            if (!context.disconnected) {
              yield* Effect.ignore(context.runtime.cancel);
            }
            if (promptFiber) yield* Fiber.interrupt(promptFiber);
            const interruptedState =
              !context.disconnected || context.userCancelRequested ? "cancelled" : "failed";
            yield* finishTurn(turn, {
              state: interruptedState,
              stopReason: interruptedState,
              ...(context.disconnected
                ? { errorMessage: context.fatalError ?? "Antigravity process stopped." }
                : {}),
            });
          }),
        );
      }),
    );
    // The reactor serializes admission, not the lifetime of the response.
    // Keep completion and cancellation owned by the session after dispatch so
    // a later steer can enter the adapter while the native prompt is running.
    const worker = yield* runTurn.pipe(Effect.forkIn(context.scope));
    return yield* Effect.raceFirst(
      Deferred.await(admitted),
      Fiber.await(worker).pipe(Effect.flatMap((exit) => exit)),
    ).pipe(Effect.onInterrupt(() => Fiber.interrupt(worker)));
  });

  const interruptTurn: Adapter["interruptTurn"] = (threadId) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      if (context.promptFiber !== undefined || context.activeTurnId !== undefined) {
        context.userCancelRequested = true;
        context.explicitStopRequested = true;
      }
      if (context.recoveryFiber) {
        yield* Fiber.interrupt(context.recoveryFiber);
      }
      yield* context.promptLock
        .withPermit(
          Effect.gen(function* () {
            yield* cancelRequests(context);
            if (!context.disconnected) {
              yield* Effect.ignore(context.runtime.cancel);
            }
            if (context.promptFiber) {
              yield* Fiber.interrupt(context.promptFiber);
            }
          }),
        )
        .pipe(Effect.mapError((cause) => mapAntigravityError(threadId, "session/cancel", cause)));
    });

  const respondToRequest: Adapter["respondToRequest"] = (threadId, requestId, decision) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      const pending = context.approvals.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/request_permission",
          detail: "This approval request is no longer pending.",
        });
      }
      const optionId =
        decision === "cancel"
          ? undefined
          : selectAntigravityPermissionOptionId(pending.request, decision);
      if (decision !== "cancel" && optionId === undefined) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "respondToRequest",
          issue:
            "Antigravity did not offer this permission choice. Select one of the available choices.",
        });
      }
      yield* Deferred.succeed(pending.response, {
        decision,
        result: {
          outcome:
            optionId === undefined ? { outcome: "cancelled" } : { outcome: "selected", optionId },
        },
      });
    });

  const respondToUserInput: Adapter["respondToUserInput"] = (threadId, requestId, answers) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      const pending = context.questions.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/request_permission",
          detail: "This question is no longer pending.",
        });
      }
      const result = makeAntigravityUserInputResponse(pending.request, answers);
      if (!result) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "respondToUserInput",
          issue:
            "Select one of Antigravity's offered answers. Custom answers are not supported for this question.",
        });
      }
      yield* Deferred.succeed(pending.response, { answers, result });
    });

  const stopSession: Adapter["stopSession"] = (threadId) =>
    withThreadLock(threadId, Effect.flatMap(requireSession(threadId), stopContext));
  const stopAll: Adapter["stopAll"] = () =>
    Effect.forEach([...sessions.values()], stopContext, { discard: true });
  yield* Effect.addFinalizer(() =>
    stopAll().pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.void
          : Effect.logError("Could not stop an Antigravity session."),
      ),
      Effect.ensuring(PubSub.shutdown(events)),
    ),
  );

  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "in-session",
      conversationRollback: BUILT_IN_ADAPTER_CONVERSATION_ROLLBACK_MODES.antigravity,
    },
    compaction: { type: "slash-command", command: "/compact" },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    stopAll,
    listSessions: () =>
      Effect.sync(() =>
        [...sessions.values()]
          .filter((context) => !context.stopped)
          .map((context) => ({ ...context.session })),
      ),
    hasSession: (threadId) =>
      Effect.sync(() => sessions.has(threadId) && !sessions.get(threadId)?.stopped),
    readThread: (threadId) =>
      Effect.map(requireSession(threadId), (context) => ({ threadId, turns: context.turns })),
    rollbackThread: (_threadId: ThreadId, _numTurns: number) =>
      Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "Antigravity does not support conversation rewind. Start a new thread instead.",
        }),
      ),
    streamEvents: Stream.fromPubSub(events),
  } satisfies Adapter;
});
