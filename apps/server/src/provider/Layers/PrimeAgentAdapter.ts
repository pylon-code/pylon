import {
  EventId,
  type PrimeAgentSettings,
  type ProviderRuntimeEvent,
  type ProviderSession,
  ProviderDriverKind,
  ProviderInstanceId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
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
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import type * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import {
  makePrimeAgentAcpRuntime,
  parsePrimeAgentAcpTerminalUpdate,
  primeAgentLaunchArgsIssue,
  type PrimeAgentAcpTerminalUpdate,
} from "../acp/PrimeAgentAcpSupport.ts";
import type { PrimeAgentAdapterShape } from "../Services/PrimeAgentAdapter.ts";
import { canonicalPrimeToolItemId } from "../prime/PrimeAgentDaemonRuntimeEvents.ts";
import {
  makePrimeAgentEventPubSub,
  shutdownPrimeAgentEventPubSub,
} from "../prime/PrimeAgentEventBuffer.ts";
import {
  isPrimeAgentCompatibleResumeCursor,
  PRIME_AGENT_ACP_RESUME_CURSOR,
} from "../prime/PrimeAgentResumeCursor.ts";
import {
  PRIME_AGENT_FINISHED_WITHOUT_FINAL_RESPONSE,
  PRIME_AGENT_STOPPED_WITHOUT_FINAL_RESPONSE,
  PRIME_AGENT_TURN_FAILED,
  primeAgentMissingFinalResponseDetail,
} from "../prime/PrimeAgentTerminalResponse.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = ProviderDriverKind.make("primeAgent");

export interface PrimeAgentAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: ProviderInstanceId;
  /** Generic, user-visible explanation when this adapter is an explicit compatibility fallback. */
  readonly startupWarning?: string;
}

type PrimeAgentAcpTerminalSettlement =
  | { readonly state: "settled"; readonly outcome: "result" | "error" }
  | { readonly state: "invalid" };

interface PrimeAgentActiveTurn {
  readonly id: TurnId;
  readonly cancellation: Deferred.Deferred<void>;
  readonly terminalQuiescence: Deferred.Deferred<PrimeAgentAcpTerminalSettlement>;
  cancellationRequested: boolean;
  hasPublicAssistantTextAfterLatestToolBoundary: boolean;
  nativePromptTurnId: number | undefined;
  lastNativeEventSequence: number | undefined;
  terminalQuiescenceExpected: boolean;
}

interface PrimeAgentSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  lastPlanFingerprint: string | undefined;
  activeTurn: PrimeAgentActiveTurn | undefined;
  stopRequested: boolean;
  stopped: boolean;
}

function observePrimeAgentAcpTerminalUpdate(
  ctx: PrimeAgentSessionContext | undefined,
  update: PrimeAgentAcpTerminalUpdate,
): Effect.Effect<void> {
  const activeTurn = ctx?.activeTurn;
  if (activeTurn === undefined) return Effect.void;
  if (update.phase === "invalid") {
    activeTurn.terminalQuiescenceExpected = true;
    return Deferred.succeed(activeTurn.terminalQuiescence, { state: "invalid" }).pipe(
      Effect.asVoid,
    );
  }
  if (
    activeTurn.lastNativeEventSequence !== undefined &&
    update.eventSequence <= activeTurn.lastNativeEventSequence
  ) {
    return Effect.void;
  }
  activeTurn.lastNativeEventSequence = update.eventSequence;

  if (update.phase === "responseBoundary") {
    if (activeTurn.nativePromptTurnId !== undefined) {
      activeTurn.terminalQuiescenceExpected = true;
      return Deferred.succeed(activeTurn.terminalQuiescence, { state: "invalid" }).pipe(
        Effect.asVoid,
      );
    }
    activeTurn.nativePromptTurnId = update.promptTurnId;
    activeTurn.terminalQuiescenceExpected = update.terminalQuiescenceExpected;
    return Effect.void;
  }

  if (
    activeTurn.nativePromptTurnId === undefined ||
    activeTurn.nativePromptTurnId !== update.promptTurnId ||
    !activeTurn.terminalQuiescenceExpected
  ) {
    activeTurn.terminalQuiescenceExpected = true;
    return Deferred.succeed(activeTurn.terminalQuiescence, { state: "invalid" }).pipe(
      Effect.asVoid,
    );
  }
  activeTurn.terminalQuiescenceExpected = true;
  return Deferred.succeed(activeTurn.terminalQuiescence, {
    state: "settled",
    outcome: update.outcome,
  }).pipe(Effect.asVoid);
}

export function parsePrimeAgentResumeMarker(raw: unknown): boolean {
  return isPrimeAgentCompatibleResumeCursor(raw);
}

function safePathSegment(value: string): string {
  return `b64-${Buffer.from(value, "utf8").toString("base64url")}`;
}

export function primeAgentSessionDirectory(input: {
  readonly stateDir: string;
  readonly instanceId: ProviderInstanceId;
  readonly threadId: ThreadId;
  readonly join: (...segments: ReadonlyArray<string>) => string;
}): string {
  return input.join(
    input.stateDir,
    "provider-sessions",
    "prime-agent",
    safePathSegment(input.instanceId),
    safePathSegment(input.threadId),
  );
}

function selectAutoApprovedPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  return (
    request.options.find((option) => option.kind === "allow_once")?.optionId.trim() ||
    request.options.find((option) => option.kind === "allow_always")?.optionId.trim() ||
    undefined
  );
}

export function makePrimeAgentAdapter(
  primeAgentSettings: PrimeAgentSettings,
  options?: PrimeAgentAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("primeAgent");
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* ServerConfig;
    const crypto = yield* Crypto.Crypto;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
    const makeAcpNativeLoggers = yield* makeAcpNativeLoggerFactory();

    const sessions = new Map<ThreadId, PrimeAgentSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* makePrimeAgentEventPubSub<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate Prime Agent runtime identifier.",
            cause,
          }),
      ),
    );
    const makeEventStamp = () =>
      Effect.all({ eventId: Effect.map(randomUUIDv4, EventId.make), createdAt: nowIso });
    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(
        Effect.flatMap((accepted) =>
          accepted
            ? Effect.void
            : Effect.logError("Prime Agent runtime event was not accepted.", {
                component: "acp",
                eventType: event.type,
                threadId: event.threadId,
                outcome: "forced-drop-after-shutdown",
              }),
        ),
      );

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing = Option.fromNullishOr(current.get(threadId));
        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(threadId, semaphore);
                return [semaphore, next] as const;
              }),
            ),
          onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
        });
      });
    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    const logNative = (threadId: ThreadId, method: string, payload: unknown) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = yield* nowIso;
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: yield* randomUUIDv4,
              kind: "notification",
              provider: PROVIDER,
              createdAt: observedAt,
              method,
              threadId,
              payload,
            },
          },
          threadId,
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to write native Prime Agent notification log.", {
            cause,
            threadId,
            method,
          }),
        ),
      );

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<PrimeAgentSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      return !ctx || ctx.stopped || ctx.stopRequested
        ? Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }))
        : Effect.succeed(ctx);
    };

    const settleActiveTurnLocked = (
      ctx: PrimeAgentSessionContext,
      turnId: TurnId,
      outcome:
        | { readonly state: "completed"; readonly stopReason: EffectAcpSchema.StopReason | null }
        | {
            readonly state: "failed";
            readonly errorMessage: string;
            readonly terminalFailure?: boolean;
          }
        | { readonly state: "cancelled" },
      recordCompletedTurn = false,
    ) =>
      Effect.gen(function* () {
        if (
          sessions.get(ctx.threadId) !== ctx ||
          ctx.stopped ||
          ctx.activeTurn?.id !== turnId ||
          ctx.session.activeTurnId !== turnId
        ) {
          return false;
        }

        // ACP notifications and the prompt response travel on independent queues.
        // Keep the turn bound until the event consumer acknowledges this barrier.
        yield* ctx.acp.drainEvents;

        if (
          sessions.get(ctx.threadId) !== ctx ||
          ctx.stopped ||
          ctx.activeTurn?.id !== turnId ||
          ctx.session.activeTurnId !== turnId
        ) {
          return false;
        }

        const effectiveOutcome =
          ctx.stopRequested || ctx.activeTurn.cancellationRequested
            ? ({ state: "cancelled" } as const)
            : outcome;
        if (recordCompletedTurn && effectiveOutcome.state !== "cancelled") {
          ctx.turns.push({ id: turnId, items: [] });
        }

        const missingFinalResponse = !ctx.activeTurn.hasPublicAssistantTextAfterLatestToolBoundary;
        const shouldEmitMissingFinalResponseNotice =
          missingFinalResponse &&
          (effectiveOutcome.state === "completed" ||
            (effectiveOutcome.state === "failed" && effectiveOutcome.terminalFailure === true));
        if (shouldEmitMissingFinalResponseNotice) {
          const failed = effectiveOutcome.state === "failed";
          yield* offerRuntimeEvent({
            type: failed ? "runtime.error" : "runtime.warning",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId,
            payload: {
              message: failed
                ? PRIME_AGENT_STOPPED_WITHOUT_FINAL_RESPONSE
                : PRIME_AGENT_FINISHED_WITHOUT_FINAL_RESPONSE,
              detail: primeAgentMissingFinalResponseDetail(failed ? "failed" : "completed"),
            },
          });
        }

        const { activeTurnId: _activeTurnId, ...readySession } = ctx.session;
        ctx.activeTurn = undefined;
        ctx.session = {
          ...readySession,
          status: "ready",
          updatedAt: yield* nowIso,
        };

        yield* offerRuntimeEvent({
          type: "turn.completed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId,
          payload:
            effectiveOutcome.state === "failed"
              ? {
                  state: "failed",
                  errorMessage:
                    missingFinalResponse && effectiveOutcome.terminalFailure === true
                      ? PRIME_AGENT_STOPPED_WITHOUT_FINAL_RESPONSE
                      : effectiveOutcome.errorMessage,
                }
              : effectiveOutcome.state === "cancelled"
                ? { state: "cancelled", stopReason: "cancelled" }
                : {
                    state: "completed",
                    stopReason: effectiveOutcome.stopReason,
                  },
        });
        return true;
      });

    const settleActiveTurn = (
      ctx: PrimeAgentSessionContext,
      turnId: TurnId,
      outcome:
        | { readonly state: "completed"; readonly stopReason: EffectAcpSchema.StopReason | null }
        | {
            readonly state: "failed";
            readonly errorMessage: string;
            readonly terminalFailure?: boolean;
          }
        | { readonly state: "cancelled" },
      recordCompletedTurn = false,
    ) =>
      Effect.uninterruptible(
        withThreadLock(
          ctx.threadId,
          settleActiveTurnLocked(ctx, turnId, outcome, recordCompletedTurn),
        ),
      );

    /** Must be called while holding the thread lock. */
    const stopSessionInternal = (ctx: PrimeAgentSessionContext) =>
      Effect.gen(function* () {
        if (sessions.get(ctx.threadId) !== ctx || ctx.stopped) return;
        ctx.stopRequested = true;
        const activeTurn = ctx.activeTurn;
        if (activeTurn) {
          activeTurn.cancellationRequested = true;
          yield* Deferred.succeed(activeTurn.cancellation, undefined).pipe(Effect.ignore);
          yield* Effect.ignore(
            ctx.acp.cancel.pipe(
              Effect.mapError((error) =>
                mapAcpToAdapterError(PROVIDER, ctx.threadId, "session/cancel", error),
              ),
            ),
          );
          yield* settleActiveTurnLocked(ctx, activeTurn.id, { state: "cancelled" });
        }

        ctx.stopped = true;
        if (ctx.notificationFiber) yield* Fiber.interrupt(ctx.notificationFiber);
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        if (sessions.get(ctx.threadId) !== ctx) return;
        sessions.delete(ctx.threadId);
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const startSession: PrimeAgentAdapterShape["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          const launchArgsIssue = primeAgentLaunchArgsIssue(primeAgentSettings.launchArgs);
          if (launchArgsIssue) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: launchArgsIssue,
            });
          }
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }
          if (input.runtimeMode !== "full-access") {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "Prime Agent Early Access currently supports only full-access runtime mode.",
            });
          }

          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) yield* stopSessionInternal(existing);

          const cwd = path.resolve(input.cwd.trim());
          const modelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const model = modelSelection?.model?.trim() || "default";
          const sessionDir = primeAgentSessionDirectory({
            stateDir: serverConfig.stateDir,
            instanceId: boundInstanceId,
            threadId: input.threadId,
            join: path.join,
          });
          yield* fileSystem.makeDirectory(sessionDir, { recursive: true }).pipe(
            Effect.andThen(fileSystem.chmod(sessionDir, 0o700)),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: `Failed to prepare Prime Agent session directory: ${cause.message}`,
                  cause,
                }),
            ),
          );

          const sessionScope = yield* Scope.make("sequential");
          let sessionContext: PrimeAgentSessionContext | undefined;
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );
          const acpNativeLoggers = makeAcpNativeLoggers({
            nativeEventLogger,
            provider: PROVIDER,
            threadId: input.threadId,
          });
          const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
          const acp = yield* makePrimeAgentAcpRuntime({
            primeAgentSettings,
            ...(options?.environment ? { environment: options.environment } : {}),
            childProcessSpawner,
            cwd,
            sessionDir,
            continueSession: parsePrimeAgentResumeMarker(input.resumeCursor),
            model,
            ...(mcpSession === undefined
              ? {}
              : {
                  mcpServers: [
                    {
                      type: "http" as const,
                      name: "t3-code",
                      url: mcpSession.endpoint,
                      headers: [
                        {
                          name: "Authorization",
                          value: mcpSession.authorizationHeader,
                        },
                      ],
                    },
                  ],
                }),
            clientInfo: { name: "pylon", version: "0.0.0" },
            observeSessionUpdate: (notification) => {
              const update = parsePrimeAgentAcpTerminalUpdate(notification);
              return update === undefined
                ? Effect.void
                : observePrimeAgentAcpTerminalUpdate(sessionContext, update);
            },
            ...acpNativeLoggers,
          }).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: cause.message,
                  cause,
                }),
            ),
          );

          yield* acp.handleRequestPermission((request) => {
            const optionId = selectAutoApprovedPermissionOption(request);
            return Effect.succeed({
              outcome: optionId
                ? { outcome: "selected" as const, optionId }
                : ({ outcome: "cancelled" } as const),
            });
          });
          const started = yield* acp
            .start()
            .pipe(
              Effect.mapError((error) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
              ),
            );

          const now = yield* nowIso;
          const resumeCursor = PRIME_AGENT_ACP_RESUME_CURSOR;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: "full-access",
            cwd,
            model,
            threadId: input.threadId,
            resumeCursor,
            createdAt: now,
            updatedAt: now,
          };
          const ctx: PrimeAgentSessionContext = {
            threadId: input.threadId,
            session,
            scope: sessionScope,
            acp,
            notificationFiber: undefined,
            turns: [],
            lastPlanFingerprint: undefined,
            activeTurn: undefined,
            stopRequested: false,
            stopped: false,
          };
          sessionContext = ctx;

          const notificationFiber = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                if (event._tag === "EventStreamBarrier") {
                  yield* Deferred.succeed(event.acknowledge, undefined);
                  return;
                }
                if (event._tag === "ModeChanged") return;
                const notificationTurnId = ctx.activeTurn?.id;
                if (notificationTurnId === undefined) return;

                switch (event._tag) {
                  case "AssistantItemStarted":
                  case "AssistantItemCompleted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: notificationTurnId,
                        itemId: event.itemId,
                        lifecycle:
                          event._tag === "AssistantItemStarted" ? "item.started" : "item.completed",
                      }),
                    );
                    return;
                  case "PlanUpdated": {
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    const fingerprint = [
                      notificationTurnId ?? "no-turn",
                      event.payload.explanation ?? "",
                      ...event.payload.plan.map((entry) => `${entry.status}:${entry.step}`),
                    ].join("\0");
                    if (ctx.lastPlanFingerprint === fingerprint) return;
                    ctx.lastPlanFingerprint = fingerprint;
                    yield* offerRuntimeEvent(
                      makeAcpPlanUpdatedEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: notificationTurnId,
                        payload: event.payload,
                        source: "acp.jsonrpc",
                        method: "session/update",
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  }
                  case "ToolCallUpdated":
                    if (ctx.activeTurn?.id === notificationTurnId) {
                      ctx.activeTurn.hasPublicAssistantTextAfterLatestToolBoundary = false;
                    }
                    yield* offerRuntimeEvent(
                      makeAcpToolCallEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: notificationTurnId,
                        toolCall: {
                          toolCallId: canonicalPrimeToolItemId(event.toolCall.toolCallId),
                          ...(event.toolCall.kind === undefined
                            ? {}
                            : { kind: event.toolCall.kind }),
                          ...(event.toolCall.status === undefined
                            ? {}
                            : { status: event.toolCall.status }),
                          data: {},
                        },
                        rawPayload: undefined,
                      }),
                    );
                    return;
                  case "ContentDelta":
                    if (event.text.trim().length > 0 && ctx.activeTurn?.id === notificationTurnId) {
                      ctx.activeTurn.hasPublicAssistantTextAfterLatestToolBoundary = true;
                    }
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* offerRuntimeEvent(
                      makeAcpContentDeltaEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: notificationTurnId,
                        ...(event.itemId ? { itemId: event.itemId } : {}),
                        text: event.text,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                }
              }),
            ),
          ).pipe(
            Effect.catch((cause) =>
              Effect.logError("Failed to process Prime Agent runtime notification.", { cause }),
            ),
            Effect.forkChild,
          );
          ctx.notificationFiber = notificationFiber;
          sessions.set(input.threadId, ctx);
          sessionScopeTransferred = true;

          yield* offerRuntimeEvent({
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { resume: started.initializeResult },
          });
          yield* offerRuntimeEvent({
            type: "session.resources.updated",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: input.threadId,
            payload: { available: false, skills: [], prompts: [], commands: [] },
          });
          yield* offerRuntimeEvent({
            type: "session.compaction.updated",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: input.threadId,
            payload: {
              available: false,
              status: "idle",
              abortable: false,
              autoCompactionWritable: false,
              manualCompactionSettable: false,
            },
          });
          yield* offerRuntimeEvent({
            type: "session.goal.updated",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: input.threadId,
            payload: {
              available: false,
              active: false,
              status: "idle",
              tokensUsed: 0,
              timeUsedSeconds: 0,
              continuationsUsed: 0,
            },
          });
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: "ready", reason: "Prime Agent ACP session ready" },
          });
          yield* offerRuntimeEvent({
            type: "thread.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          });
          if (options?.startupWarning) {
            yield* offerRuntimeEvent({
              type: "runtime.warning",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              payload: { message: options.startupWarning },
            });
          }
          return session;
        }).pipe(Effect.scoped),
      );

    const sendTurn: PrimeAgentAdapterShape["sendTurn"] = (input) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const prepared = yield* withThreadLock(
            input.threadId,
            Effect.gen(function* () {
              const ctx = yield* requireSession(input.threadId);
              if (ctx.activeTurn) {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "sendTurn",
                  issue: "Prime Agent does not support concurrent steering in Early Access.",
                });
              }
              const turnModel =
                input.modelSelection?.instanceId === boundInstanceId
                  ? input.modelSelection.model
                  : undefined;
              if (turnModel && turnModel !== ctx.session.model) {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "sendTurn",
                  issue: "Prime Agent model switching is unsupported after session startup.",
                });
              }
              if (input.interactionMode === "plan") {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "sendTurn",
                  issue: "Prime Agent Early Access does not support plan interaction mode.",
                });
              }

              const prompt: Array<EffectAcpSchema.ContentBlock> = [];
              if (input.input?.trim()) {
                prompt.push({ type: "text", text: input.input.trim() });
              }
              for (const attachment of input.attachments ?? []) {
                const attachmentPath = resolveAttachmentPath({
                  attachmentsDir: serverConfig.attachmentsDir,
                  attachment,
                });
                if (!attachmentPath) {
                  return yield* new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "session/prompt",
                    detail: `Invalid attachment id '${attachment.id}'.`,
                  });
                }
                const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ProviderAdapterRequestError({
                        provider: PROVIDER,
                        method: "session/prompt",
                        detail: cause.message,
                        cause,
                      }),
                  ),
                );
                prompt.push({
                  type: "image",
                  data: Buffer.from(bytes).toString("base64"),
                  mimeType: attachment.mimeType,
                });
              }
              if (prompt.length === 0) {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "sendTurn",
                  issue: "Turn requires non-empty text or attachments.",
                });
              }

              const turnId = TurnId.make(yield* randomUUIDv4);
              const activeTurn: PrimeAgentActiveTurn = {
                id: turnId,
                cancellation: yield* Deferred.make<void>(),
                terminalQuiescence: yield* Deferred.make<PrimeAgentAcpTerminalSettlement>(),
                cancellationRequested: false,
                hasPublicAssistantTextAfterLatestToolBoundary: false,
                nativePromptTurnId: undefined,
                lastNativeEventSequence: undefined,
                terminalQuiescenceExpected: false,
              };
              ctx.activeTurn = activeTurn;
              ctx.lastPlanFingerprint = undefined;
              ctx.session = {
                ...ctx.session,
                activeTurnId: turnId,
                status: "running",
                updatedAt: yield* nowIso,
              };
              return { ctx, activeTurn, turnId, prompt };
            }),
          );
          const { ctx, activeTurn, turnId, prompt } = prepared;

          const promptEffect = Effect.gen(function* () {
            yield* offerRuntimeEvent({
              type: "turn.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId,
              payload: { model: ctx.session.model ?? "default" },
            });
            const promptExit = yield* Effect.raceFirst(
              ctx.acp.prompt({ prompt }),
              Deferred.await(activeTurn.cancellation).pipe(
                Effect.as({ stopReason: "cancelled" as const }),
              ),
            ).pipe(
              Effect.mapError((error) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
              ),
              Effect.exit,
            );
            // Prime Agent 0.8 publishes a response boundary before the ACP response and
            // an authoritative terminal-quiescence envelope after descendant work settles.
            // Older releases publish neither, so their prompt response remains terminal.
            // A stopped session has already shut down its notification consumer, so it
            // must not enqueue a barrier that can no longer be acknowledged.
            const promptCancelled =
              Exit.isSuccess(promptExit) && promptExit.value.stopReason === "cancelled";
            if (!promptCancelled && !activeTurn.cancellationRequested && !ctx.stopRequested) {
              yield* ctx.acp.drainEvents;
            }
            const terminal =
              activeTurn.terminalQuiescenceExpected && !promptCancelled
                ? yield* Effect.raceFirst(
                    Deferred.await(activeTurn.terminalQuiescence),
                    Deferred.await(activeTurn.cancellation).pipe(
                      Effect.as({ state: "cancelled" as const }),
                    ),
                  )
                : undefined;
            if (terminal?.state === "invalid") {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/prompt",
                detail: "Prime Agent returned invalid terminal-quiescence metadata.",
              });
            }
            if (Exit.isFailure(promptExit) && terminal?.state !== "cancelled") {
              return yield* Effect.failCause(promptExit.cause);
            }
            const result = Exit.isSuccess(promptExit)
              ? promptExit.value
              : ({ stopReason: "cancelled" } as const);
            const settled = yield* settleActiveTurn(
              ctx,
              turnId,
              terminal?.state === "settled" && terminal.outcome === "error"
                ? {
                    state: "failed",
                    errorMessage: PRIME_AGENT_TURN_FAILED,
                    terminalFailure: true,
                  }
                : terminal?.state === "cancelled" || result.stopReason === "cancelled"
                  ? { state: "cancelled" }
                  : { state: "completed", stopReason: result.stopReason ?? null },
              true,
            );
            if (!settled && !activeTurn.cancellationRequested && !ctx.stopRequested) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/prompt",
                detail: "Prime Agent session changed before the turn completed.",
              });
            }
            return { threadId: input.threadId, turnId, resumeCursor: ctx.session.resumeCursor };
          });

          return yield* restore(promptEffect).pipe(
            Effect.catch(() =>
              Effect.gen(function* () {
                yield* settleActiveTurn(ctx, turnId, {
                  state: "failed",
                  errorMessage: PRIME_AGENT_TURN_FAILED,
                  terminalFailure: true,
                });
                // Admission succeeded and the runtime event stream already
                // carries the authoritative failed terminal. Returning the
                // admitted turn prevents a second turn-start failure activity.
                return {
                  threadId: input.threadId,
                  turnId,
                  resumeCursor: ctx.session.resumeCursor,
                };
              }),
            ),
            Effect.ensuring(
              settleActiveTurn(ctx, turnId, {
                state: "failed",
                errorMessage: "Prime Agent prompt request was interrupted.",
              }).pipe(
                Effect.asVoid,
                Effect.catchCause((cause) =>
                  Effect.logError("Failed to settle interrupted Prime Agent turn.", {
                    cause,
                    threadId: input.threadId,
                    turnId,
                  }),
                ),
              ),
            ),
          );
        }),
      );

    const interruptTurn: PrimeAgentAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.gen(function* () {
        const observed = yield* Effect.sync(() => {
          const ctx = sessions.get(threadId);
          if (!ctx || ctx.stopped || ctx.stopRequested) {
            return { _tag: "Missing" as const };
          }
          const activeTurn = ctx.activeTurn;
          if (turnId !== undefined && activeTurn?.id !== turnId) {
            return { _tag: "WrongTurn" as const, activeTurnId: activeTurn?.id };
          }
          if (activeTurn) activeTurn.cancellationRequested = true;
          return { _tag: "Observed" as const, ctx, activeTurn };
        });
        if (observed._tag === "Missing") {
          return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
        }
        if (observed._tag === "WrongTurn") {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "interruptTurn",
            issue: `Turn '${turnId}' is not active.`,
          });
        }
        if (observed.activeTurn) {
          yield* Deferred.succeed(observed.activeTurn.cancellation, undefined).pipe(Effect.ignore);
        }

        yield* Effect.uninterruptible(
          withThreadLock(
            threadId,
            Effect.gen(function* () {
              if (sessions.get(threadId) !== observed.ctx || observed.ctx.stopped) return;
              const cancelResult = yield* observed.ctx.acp.cancel.pipe(
                Effect.mapError((error) =>
                  mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", error),
                ),
                Effect.exit,
              );
              if (observed.activeTurn && observed.ctx.activeTurn?.id === observed.activeTurn.id) {
                yield* settleActiveTurnLocked(observed.ctx, observed.activeTurn.id, {
                  state: "cancelled",
                });
              }
              if (Exit.isFailure(cancelResult)) {
                return yield* Effect.failCause(cancelResult.cause);
              }
            }),
          ),
        );
      });

    const respondToRequest: PrimeAgentAdapterShape["respondToRequest"] = (threadId, requestId) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/request_permission",
          detail: `Prime Agent full-access sessions do not expose approval request '${requestId}' for thread '${threadId}'.`,
        }),
      );
    const respondToUserInput: PrimeAgentAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
    ) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/elicitation",
          detail: `Prime Agent Early Access does not expose user-input request '${requestId}' for thread '${threadId}'.`,
        }),
      );
    const readThread: PrimeAgentAdapterShape["readThread"] = (threadId) =>
      Effect.map(requireSession(threadId), (ctx) => ({ threadId, turns: ctx.turns }));
    const rollbackThread: PrimeAgentAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "Prime Agent durable history rollback is unsupported in Early Access.",
        });
      });
    const markStopRequested = (ctx: PrimeAgentSessionContext) =>
      Effect.gen(function* () {
        ctx.stopRequested = true;
        if (ctx.activeTurn) {
          ctx.activeTurn.cancellationRequested = true;
          yield* Deferred.succeed(ctx.activeTurn.cancellation, undefined).pipe(Effect.ignore);
        }
      });

    const stopSession: PrimeAgentAdapterShape["stopSession"] = (threadId) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const ctx = yield* Effect.sync(() => sessions.get(threadId));
          if (!ctx || ctx.stopped) {
            return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
          }
          yield* markStopRequested(ctx);
          yield* withThreadLock(
            threadId,
            sessions.get(threadId) === ctx ? stopSessionInternal(ctx) : Effect.void,
          );
        }),
      );
    const listSessions: PrimeAgentAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (ctx) => ({ ...ctx.session })));
    const hasSession: PrimeAgentAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const ctx = sessions.get(threadId);
        return ctx !== undefined && !ctx.stopped && !ctx.stopRequested;
      });
    const stopAll: PrimeAgentAdapterShape["stopAll"] = () =>
      Effect.gen(function* () {
        const contexts = Array.from(sessions.values());
        yield* Effect.forEach(contexts, markStopRequested, { discard: true });
        yield* Effect.forEach(
          contexts,
          (ctx) => withThreadLock(ctx.threadId, stopSessionInternal(ctx)),
          { discard: true },
        );
      }).pipe(Effect.uninterruptible);

    yield* Effect.addFinalizer(() =>
      shutdownPrimeAgentEventPubSub({
        component: "acp",
        pubSub: runtimeEventPubSub,
        drain: stopAll(),
      }).pipe(Effect.ensuring(managedNativeEventLogger?.close() ?? Effect.void)),
    );

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "unsupported", conversationRollback: "unsupported" },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      readThread,
      rollbackThread,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    } satisfies PrimeAgentAdapterShape;
  });
}
