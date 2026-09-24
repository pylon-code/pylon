/**
 * Provider-neutral ACP adapter lifecycle and factory.
 *
 * @module AcpAdapter
 */

import {
  ApprovalRequestId,
  type ProviderOptionSelection,
  EventId,
  type ProviderApprovalDecision,
  type ProviderInteractionMode,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  type RuntimeMode,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import {
  type AcpSessionMode,
  type AcpSessionModeState,
  parsePermissionRequest,
} from "../acp/AcpRuntimeModel.ts";
import { buildAcpElicitationForm } from "../acp/AcpElicitation.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

type AcpSessionRuntimeOptions = AcpSessionRuntime.AcpSessionRuntimeOptions;
type AcpSessionRuntimeShape = AcpSessionRuntime.AcpSessionRuntime["Service"];

const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.fromJsonString(Schema.Unknown));
const ACP_RESUME_VERSION = 1 as const;
const ACP_PLAN_MODE_ALIASES = ["plan", "architect"];
const ACP_IMPLEMENT_MODE_ALIASES = ["code", "agent", "default", "chat", "implement"];
const ACP_APPROVAL_MODE_ALIASES = ["ask"];

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

export interface AcpProviderAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  /**
   * Selections are honored when `modelSelection.instanceId` matches this value.
   * Defaults to the definition's built-in instance id.
   */
  readonly instanceId?: ProviderInstanceId;
}

interface AcpProviderRuntimeFactoryInput<Settings> {
  readonly settings: Settings;
  readonly environment?: NodeJS.ProcessEnv;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly cwd: string;
  readonly threadId: ThreadId;
  readonly runtimeMode: RuntimeMode;
  readonly resumeSessionId?: string;
  readonly clientInfo: AcpSessionRuntimeOptions["clientInfo"];
  readonly mcpServers?: AcpSessionRuntimeOptions["mcpServers"];
  readonly nativeLoggers: Pick<AcpSessionRuntimeOptions, "requestLogger" | "protocolLogging">;
}

interface AcpProviderModelSelectionInput {
  readonly runtime: AcpSessionRuntimeShape;
  readonly threadId: ThreadId;
  readonly model: string;
  readonly initialModelId: string | undefined;
  readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
}

export interface AcpProviderAdapterDefinition<Settings> {
  readonly provider: ProviderDriverKind;
  readonly defaultInstanceId: ProviderInstanceId;
  readonly displayName: string;
  readonly settings: Settings;
  readonly options?: AcpProviderAdapterLiveOptions;
  readonly shouldAutoApprovePermission?: (input: {
    readonly runtimeMode: RuntimeMode;
    readonly permissionKind: string | "unknown";
  }) => boolean;
  readonly makeRuntime: (
    input: AcpProviderRuntimeFactoryInput<Settings>,
  ) => Effect.Effect<AcpSessionRuntimeShape, EffectAcpErrors.AcpError, Crypto.Crypto | Scope.Scope>;
  readonly applyModelSelection: (
    input: AcpProviderModelSelectionInput,
  ) => Effect.Effect<void, ProviderAdapterError>;
  readonly resolveModelId: (model: string | null | undefined) => string;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
  readonly kind: string | "unknown";
}

interface PendingUserInput {
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}

export interface AcpSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntimeShape;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  readonly initialModelId: string | undefined;
  lastPlanFingerprint: string | undefined;
  activeTurnId: TurnId | undefined;
  promptsInFlight: number;
  readonly promptCancellations: Set<Deferred.Deferred<void>>;
  stopped: boolean;
}

function settlePendingApprovalsAsCancelled(
  pendingApprovals: ReadonlyMap<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void> {
  const pendingEntries = Array.from(pendingApprovals.values());
  return Effect.forEach(
    pendingEntries,
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    {
      discard: true,
    },
  );
}

function settlePendingUserInputsAsEmptyAnswers(
  pendingUserInputs: ReadonlyMap<ApprovalRequestId, PendingUserInput>,
): Effect.Effect<void> {
  const pendingEntries = Array.from(pendingUserInputs.values());
  return Effect.forEach(
    pendingEntries,
    (pending) => Deferred.succeed(pending.answers, {}).pipe(Effect.ignore),
    {
      discard: true,
    },
  );
}

function settlePromptCancellations(
  promptCancellations: ReadonlySet<Deferred.Deferred<void>>,
): Effect.Effect<void> {
  return Effect.forEach(
    promptCancellations,
    (cancellation) => Deferred.succeed(cancellation, undefined).pipe(Effect.ignore),
    { discard: true },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAcpResume(
  raw: unknown,
): { readonly sessionId: string; readonly initialModelId?: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== ACP_RESUME_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  const initialModelId =
    typeof raw.initialModelId === "string" && raw.initialModelId.trim()
      ? raw.initialModelId.trim()
      : undefined;
  return {
    sessionId: raw.sessionId.trim(),
    ...(initialModelId ? { initialModelId } : {}),
  };
}

function currentAcpModelId(
  options: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): string | undefined {
  const modelOption = options.find(
    (option) => option.category === "model" || option.id === "model",
  );
  return typeof modelOption?.currentValue === "string" && modelOption.currentValue.trim()
    ? modelOption.currentValue.trim()
    : undefined;
}

function normalizeModeSearchText(mode: AcpSessionMode): string {
  return [mode.id, mode.name, mode.description]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function findModeByAliases(
  modes: ReadonlyArray<AcpSessionMode>,
  aliases: ReadonlyArray<string>,
): AcpSessionMode | undefined {
  const normalizedAliases = aliases.map((alias) => alias.toLowerCase());
  for (const alias of normalizedAliases) {
    const exact = modes.find((mode) => {
      const id = mode.id.toLowerCase();
      const name = mode.name.toLowerCase();
      return id === alias || name === alias;
    });
    if (exact) {
      return exact;
    }
  }
  for (const alias of normalizedAliases) {
    const partial = modes.find((mode) => normalizeModeSearchText(mode).split(" ").includes(alias));
    if (partial) {
      return partial;
    }
  }
  return undefined;
}

function isPlanMode(mode: AcpSessionMode): boolean {
  return findModeByAliases([mode], ACP_PLAN_MODE_ALIASES) !== undefined;
}

function resolveRequestedModeId(input: {
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly modeState: AcpSessionModeState | undefined;
}): string | undefined {
  const modeState = input.modeState;
  if (!modeState) {
    return undefined;
  }

  if (input.interactionMode === "plan") {
    return findModeByAliases(modeState.availableModes, ACP_PLAN_MODE_ALIASES)?.id;
  }

  if (input.runtimeMode === "approval-required") {
    return (
      findModeByAliases(modeState.availableModes, ACP_APPROVAL_MODE_ALIASES)?.id ??
      findModeByAliases(modeState.availableModes, ACP_IMPLEMENT_MODE_ALIASES)?.id ??
      modeState.availableModes.find((mode) => !isPlanMode(mode))?.id ??
      modeState.currentModeId
    );
  }

  return (
    findModeByAliases(modeState.availableModes, ACP_IMPLEMENT_MODE_ALIASES)?.id ??
    findModeByAliases(modeState.availableModes, ACP_APPROVAL_MODE_ALIASES)?.id ??
    modeState.availableModes.find((mode) => !isPlanMode(mode))?.id ??
    modeState.currentModeId
  );
}

function applyRequestedSessionConfiguration<E>(input: {
  readonly runtime: AcpSessionRuntimeShape;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly initialModelId: string | undefined;
  readonly modelSelection:
    | {
        readonly model: string;
        readonly options?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
      }
    | undefined;
  readonly applyModelSelection: (input: {
    readonly runtime: AcpSessionRuntimeShape;
    readonly model: string;
    readonly initialModelId: string | undefined;
    readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  }) => Effect.Effect<void, E>;
  readonly mapError: (context: {
    readonly cause: import("effect-acp/errors").AcpError;
    readonly method: "session/set_config_option" | "session/set_mode";
  }) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    if (input.modelSelection) {
      yield* input.applyModelSelection({
        runtime: input.runtime,
        model: input.modelSelection.model,
        initialModelId: input.initialModelId,
        selections: input.modelSelection.options,
      });
    }

    const requestedModeId = resolveRequestedModeId({
      interactionMode: input.interactionMode,
      runtimeMode: input.runtimeMode,
      modeState: yield* input.runtime.getModeState,
    });
    if (!requestedModeId) {
      return;
    }

    yield* input.runtime.setMode(requestedModeId).pipe(
      Effect.mapError((cause) =>
        input.mapError({
          cause,
          method: "session/set_mode",
        }),
      ),
    );
  });
}

function selectAutoApprovedPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  const desiredKinds = ["allow_always", "allow_once"] as const;
  for (const kind of desiredKinds) {
    const option = request.options.find((candidate) => candidate.kind === kind);
    if (typeof option?.optionId === "string" && option.optionId.trim()) {
      return option.optionId.trim();
    }
  }

  const aliases = new Set(desiredKinds.flatMap((kind) => [kind, kind.replaceAll("_", "-")]));
  return request.options.find((option) => aliases.has(option.optionId))?.optionId;
}

function selectPermissionOption(
  decision: ProviderApprovalDecision,
  options: ReadonlyArray<EffectAcpSchema.PermissionOption>,
): string | undefined {
  const desiredKinds =
    decision === "acceptForSession" || decision === "acceptAlways"
      ? (["allow_always"] as const)
      : decision === "accept"
        ? (["allow_once"] as const)
        : (["reject_once", "reject_always"] as const);
  for (const kind of desiredKinds) {
    const optionId = options.find((option) => option.kind === kind)?.optionId;
    if (optionId?.trim()) return optionId.trim();
  }

  const aliases = new Set(desiredKinds.flatMap((kind) => [kind, kind.replaceAll("_", "-")]));
  return options.find((option) => aliases.has(option.optionId))?.optionId;
}

export function makeAcpProviderAdapter<Settings>(
  definition: AcpProviderAdapterDefinition<Settings>,
) {
  return Effect.gen(function* () {
    const PROVIDER = definition.provider;
    const options = definition.options;
    const boundInstanceId = options?.instanceId ?? definition.defaultInstanceId;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const crypto = yield* Crypto.Crypto;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
    const makeAcpNativeLoggers = yield* makeAcpNativeLoggerFactory();

    const sessions = new Map<ThreadId, AcpSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(
      new Map<string, { readonly semaphore: Semaphore.Semaphore; readonly users: number }>(),
    );
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: `Failed to generate ${definition.displayName} runtime identifier.`,
            cause,
          }),
      ),
    );
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });
    const mapExtensionFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new EffectAcpErrors.AcpTransportError({
              detail: `Failed to process ${definition.displayName} ACP extension event.`,
              cause,
            }),
        ),
      );

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const acquireThreadLock = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing = current.get(threadId);
        if (existing) {
          const entry = { ...existing, users: existing.users + 1 };
          const next = new Map(current);
          next.set(threadId, entry);
          return Effect.succeed([entry, next] as const);
        }
        return Semaphore.make(1).pipe(
          Effect.map((semaphore) => {
            const entry = { semaphore, users: 1 } as const;
            const next = new Map(current);
            next.set(threadId, entry);
            return [entry, next] as const;
          }),
        );
      });

    const releaseThreadLock = (
      threadId: string,
      entry: { readonly semaphore: Semaphore.Semaphore },
    ) =>
      SynchronizedRef.modify(threadLocksRef, (current) => {
        const live = current.get(threadId);
        if (!live || live.semaphore !== entry.semaphore) {
          return [undefined, current] as const;
        }
        const next = new Map(current);
        if (live.users <= 1) {
          next.delete(threadId);
        } else {
          next.set(threadId, { ...live, users: live.users - 1 });
        }
        return [undefined, next] as const;
      });

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.acquireUseRelease(
        acquireThreadLock(threadId),
        (entry) => entry.semaphore.withPermit(effect),
        (entry) => releaseThreadLock(threadId, entry),
      );

    const logNative = (
      threadId: ThreadId,
      method: string,
      payload: unknown,
      _source: "acp.jsonrpc" | `acp.${string}.extension`,
    ) =>
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
      });

    const emitPlanUpdate = (
      ctx: AcpSessionContext,
      payload: {
        readonly explanation?: string | null;
        readonly plan: ReadonlyArray<{
          readonly step: string;
          readonly status: "pending" | "inProgress" | "completed";
        }>;
      },
      rawPayload: unknown,
      source: "acp.jsonrpc" | `acp.${string}.extension`,
      method: string,
    ) =>
      Effect.gen(function* () {
        const fingerprint = `${ctx.activeTurnId ?? "no-turn"}:${encodeJsonStringForDiagnostics(payload) ?? "[unserializable payload]"}`;
        if (ctx.lastPlanFingerprint === fingerprint) {
          return;
        }
        ctx.lastPlanFingerprint = fingerprint;
        yield* offerRuntimeEvent(
          makeAcpPlanUpdatedEvent({
            stamp: yield* makeEventStamp(),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            payload,
            source,
            method,
            rawPayload,
          }),
        );
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<AcpSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const stopSessionInternal = (ctx: AcpSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
        yield* settlePromptCancellations(ctx.promptCancellations);
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        if (sessions.get(ctx.threadId) === ctx) {
          sessions.delete(ctx.threadId);
        }
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (input) =>
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
          if (
            input.providerInstanceId !== undefined &&
            input.providerInstanceId !== boundInstanceId
          ) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider instance '${boundInstanceId}' but received '${input.providerInstanceId}'.`,
            });
          }
          if (
            input.modelSelection !== undefined &&
            input.modelSelection.instanceId !== boundInstanceId
          ) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Model selection belongs to provider instance '${input.modelSelection.instanceId}', not '${boundInstanceId}'.`,
            });
          }
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }

          const cwd = path.resolve(input.cwd.trim());
          const selectedModel = input.modelSelection;
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );
          let ctx!: AcpSessionContext;

          const resume = parseAcpResume(input.resumeCursor);
          const resumeSessionId = resume?.sessionId;
          const acpNativeLoggers = makeAcpNativeLoggers({
            nativeEventLogger,
            provider: PROVIDER,
            threadId: input.threadId,
          });
          const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);

          // Per-instance isolation is enforced by the hydration layer rebuilding
          // this adapter whenever the instance configuration changes.
          const effectiveSettings = definition.settings;

          const acp = yield* definition
            .makeRuntime({
              settings: effectiveSettings,
              ...(options?.environment ? { environment: options.environment } : {}),
              childProcessSpawner,
              cwd,
              threadId: input.threadId,
              runtimeMode: input.runtimeMode,
              ...(resumeSessionId ? { resumeSessionId } : {}),
              clientInfo: { name: "pylon", version: "0.0.0" },
              ...(mcpSession
                ? {
                    mcpServers: [
                      {
                        type: "http" as const,
                        name: "pylon",
                        url: mcpSession.endpoint,
                        headers: [
                          {
                            name: "Authorization",
                            value: mcpSession.authorizationHeader,
                          },
                        ],
                      },
                    ],
                  }
                : {}),
              nativeLoggers: acpNativeLoggers,
            })
            .pipe(
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
          const started = yield* Effect.gen(function* () {
            yield* acp.handleElicitation((params) =>
              mapExtensionFailure(
                Effect.gen(function* () {
                  yield* logNative(input.threadId, "session/elicitation", params, "acp.jsonrpc");
                  const form = buildAcpElicitationForm(params);
                  if (!form) {
                    return { action: { action: "cancel" as const } };
                  }
                  const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
                  const runtimeRequestId = RuntimeRequestId.make(requestId);
                  const answers = yield* Deferred.make<ProviderUserInputAnswers>();
                  pendingUserInputs.set(requestId, { answers });
                  yield* offerRuntimeEvent({
                    type: "user-input.requested",
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: ctx?.activeTurnId,
                    requestId: runtimeRequestId,
                    payload: { questions: form.questions },
                    raw: {
                      source: "acp.jsonrpc",
                      method: "session/elicitation",
                      payload: params,
                    },
                  });
                  const resolved = yield* Deferred.await(answers);
                  pendingUserInputs.delete(requestId);
                  yield* offerRuntimeEvent({
                    type: "user-input.resolved",
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: ctx?.activeTurnId,
                    requestId: runtimeRequestId,
                    payload: { answers: resolved },
                  });
                  return form.resolve(resolved);
                }),
              ),
            );
            yield* acp.handleRequestPermission((params) =>
              mapExtensionFailure(
                Effect.gen(function* () {
                  yield* logNative(
                    input.threadId,
                    "session/request_permission",
                    params,
                    "acp.jsonrpc",
                  );
                  const permissionRequest = parsePermissionRequest(params);
                  const autoApprove =
                    input.runtimeMode === "full-access" ||
                    definition.shouldAutoApprovePermission?.({
                      runtimeMode: input.runtimeMode,
                      permissionKind: permissionRequest.kind,
                    }) === true;
                  if (autoApprove) {
                    const autoApprovedOptionId = selectAutoApprovedPermissionOption(params);
                    if (autoApprovedOptionId !== undefined) {
                      return {
                        outcome: {
                          outcome: "selected" as const,
                          optionId: autoApprovedOptionId,
                        },
                      };
                    }
                  }
                  const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
                  const runtimeRequestId = RuntimeRequestId.make(requestId);
                  const decision = yield* Deferred.make<ProviderApprovalDecision>();
                  pendingApprovals.set(requestId, {
                    decision,
                    kind: permissionRequest.kind,
                  });
                  yield* offerRuntimeEvent(
                    makeAcpRequestOpenedEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId: ctx?.activeTurnId,
                      requestId: runtimeRequestId,
                      permissionRequest,
                      detail:
                        permissionRequest.detail ??
                        encodeJsonStringForDiagnostics(params)?.slice(0, 2000) ??
                        "[unserializable params]",
                      args: params,
                      source: "acp.jsonrpc",
                      method: "session/request_permission",
                      rawPayload: params,
                    }),
                  );
                  const resolved = yield* Deferred.await(decision);
                  pendingApprovals.delete(requestId);
                  yield* offerRuntimeEvent(
                    makeAcpRequestResolvedEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId: ctx?.activeTurnId,
                      requestId: runtimeRequestId,
                      permissionRequest,
                      decision: resolved,
                    }),
                  );
                  if (resolved === "cancel") {
                    return { outcome: { outcome: "cancelled" as const } };
                  }
                  const optionId = selectPermissionOption(resolved, params.options);
                  return optionId === undefined
                    ? { outcome: { outcome: "cancelled" as const } }
                    : { outcome: { outcome: "selected" as const, optionId } };
                }),
              ),
            );
            return yield* acp.start();
          }).pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
            ),
          );

          const initialModelId =
            resume?.initialModelId ?? currentAcpModelId(yield* acp.getConfigOptions);
          yield* applyRequestedSessionConfiguration({
            runtime: acp,
            runtimeMode: input.runtimeMode,
            interactionMode: undefined,
            initialModelId,
            modelSelection: selectedModel,
            applyModelSelection: ({ runtime, model, initialModelId, selections }) =>
              definition.applyModelSelection({
                runtime,
                threadId: input.threadId,
                model,
                initialModelId,
                selections,
              }),
            mapError: ({ cause, method }) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, method, cause),
          });

          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model: selectedModel?.model,
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: ACP_RESUME_VERSION,
              sessionId: started.sessionId,
              ...(initialModelId ? { initialModelId } : {}),
            },
            ...(resumeSessionId ? { restored: true } : {}),
            createdAt: now,
            updatedAt: now,
          };

          ctx = {
            threadId: input.threadId,
            session,
            scope: sessionScope,
            acp,
            notificationFiber: undefined,
            pendingApprovals,
            pendingUserInputs,
            turns: [],
            initialModelId,
            lastPlanFingerprint: undefined,
            activeTurnId: undefined,
            promptsInFlight: 0,
            promptCancellations: new Set(),
            stopped: false,
          };

          const nf = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                switch (event._tag) {
                  case "EventStreamBarrier":
                    yield* Deferred.succeed(event.acknowledge, undefined);
                    return;
                  case "AssistantItemStarted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.started",
                      }),
                    );
                    return;
                  case "AssistantItemCompleted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.completed",
                      }),
                    );
                    return;
                  case "PlanUpdated":
                    yield* logNative(
                      ctx.threadId,
                      "session/update",
                      event.rawPayload,
                      "acp.jsonrpc",
                    );
                    yield* emitPlanUpdate(
                      ctx,
                      event.payload,
                      event.rawPayload,
                      "acp.jsonrpc",
                      "session/update",
                    );
                    return;
                  case "ToolCallUpdated":
                    yield* logNative(
                      ctx.threadId,
                      "session/update",
                      event.rawPayload,
                      "acp.jsonrpc",
                    );
                    yield* offerRuntimeEvent(
                      makeAcpToolCallEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        toolCall: event.toolCall,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "ContentDelta":
                    yield* logNative(
                      ctx.threadId,
                      "session/update",
                      event.rawPayload,
                      "acp.jsonrpc",
                    );
                    yield* offerRuntimeEvent(
                      makeAcpContentDeltaEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        ...(event.itemId ? { itemId: event.itemId } : {}),
                        text: event.text,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                }
              }).pipe(
                Effect.catchCause((cause) =>
                  Effect.logError(
                    `Failed to process ${definition.displayName} runtime notification.`,
                    { cause },
                  ),
                ),
              ),
            ),
          ).pipe(Effect.forkIn(sessionScope));

          ctx.notificationFiber = nf;
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
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: "ready", reason: `${definition.displayName} ACP session ready` },
          });
          yield* offerRuntimeEvent({
            type: "thread.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          });

          return session;
        }).pipe(Effect.scoped),
      );
    const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (input) => {
      let cleanup:
        | {
            readonly ctx: AcpSessionContext;
            readonly cancellation: Deferred.Deferred<void>;
          }
        | undefined;
      let promptSettled = false;

      const cleanupPromptSlot = Effect.suspend(() => {
        if (!cleanup || promptSettled) return Effect.void;
        return withThreadLock(
          input.threadId,
          Effect.sync(() => {
            if (!cleanup || promptSettled) return;
            const { ctx, cancellation } = cleanup;
            if (ctx.promptCancellations.delete(cancellation)) {
              ctx.promptsInFlight = Math.max(0, ctx.promptsInFlight - 1);
            }
            if (ctx.promptsInFlight === 0 && sessions.get(input.threadId) === ctx && !ctx.stopped) {
              ctx.activeTurnId = undefined;
              ctx.session = {
                ...ctx.session,
                status: "ready",
                activeTurnId: undefined,
              };
            }
            promptSettled = true;
          }),
        ).pipe(Effect.ignore);
      });

      return Effect.gen(function* () {
        const prepared = yield* withThreadLock(
          input.threadId,
          Effect.gen(function* () {
            const ctx = yield* requireSession(input.threadId);
            if (
              input.modelSelection !== undefined &&
              input.modelSelection.instanceId !== boundInstanceId
            ) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "sendTurn",
                issue: `Model selection belongs to provider instance '${input.modelSelection.instanceId}', not '${boundInstanceId}'.`,
              });
            }
            const promptParts: Array<EffectAcpSchema.ContentBlock> = [];
            if (input.input?.trim()) {
              promptParts.push({ type: "text", text: input.input.trim() });
            }
            if (input.attachments && input.attachments.length > 0) {
              for (const attachment of input.attachments) {
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
                promptParts.push({
                  type: "image",
                  data: Buffer.from(bytes).toString("base64"),
                  mimeType: attachment.mimeType,
                });
              }
            }
            if (promptParts.length === 0) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "sendTurn",
                issue: "Turn requires non-empty text or attachments.",
              });
            }

            const turnModelSelection = input.modelSelection;
            const model = turnModelSelection?.model ?? ctx.session.model;
            const resolvedModel = definition.resolveModelId(model);
            yield* applyRequestedSessionConfiguration({
              runtime: ctx.acp,
              runtimeMode: ctx.session.runtimeMode,
              interactionMode: input.interactionMode,
              initialModelId: ctx.initialModelId,
              modelSelection:
                model === undefined
                  ? undefined
                  : {
                      model,
                      options: turnModelSelection?.options,
                    },
              applyModelSelection: ({ runtime, model: nextModel, initialModelId, selections }) =>
                definition.applyModelSelection({
                  runtime,
                  threadId: input.threadId,
                  model: nextModel,
                  initialModelId,
                  selections,
                }),
              mapError: ({ cause, method }) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, method, cause),
            });

            const steeringTurnId = ctx.promptsInFlight > 0 ? ctx.activeTurnId : undefined;
            const turnId = steeringTurnId ?? TurnId.make(yield* randomUUIDv4);
            const cancellation = yield* Deferred.make<void>();
            cleanup = { ctx, cancellation };
            ctx.promptCancellations.add(cancellation);
            ctx.promptsInFlight += 1;
            ctx.activeTurnId = turnId;
            if (steeringTurnId === undefined) {
              ctx.lastPlanFingerprint = undefined;
            }
            ctx.session = {
              ...ctx.session,
              status: "running",
              activeTurnId: turnId,
              updatedAt: yield* nowIso,
              model: resolvedModel,
            };

            if (steeringTurnId === undefined) {
              yield* offerRuntimeEvent({
                type: "turn.started",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                payload: { model: resolvedModel },
              });
            }

            return { ctx, turnId, cancellation, promptParts, resolvedModel };
          }),
        );

        const promptExit = yield* Effect.exit(
          Effect.raceFirst(
            prepared.ctx.acp
              .prompt({ prompt: prepared.promptParts })
              .pipe(
                Effect.mapError((error) =>
                  mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
                ),
              ),
            Deferred.await(prepared.cancellation).pipe(
              Effect.as({ stopReason: "cancelled" as const }),
            ),
          ),
        );

        yield* withThreadLock(
          input.threadId,
          Effect.gen(function* () {
            const { ctx, cancellation, turnId } = prepared;
            const liveContext = sessions.get(input.threadId);
            if (liveContext !== ctx || ctx.stopped) {
              yield* Effect.uninterruptible(
                Effect.sync(() => {
                  if (ctx.promptCancellations.delete(cancellation)) {
                    ctx.promptsInFlight = Math.max(0, ctx.promptsInFlight - 1);
                  }
                  promptSettled = true;
                }),
              );
              return;
            }

            // The ACP response can overtake queued notifications. Keep this
            // barrier inside the thread lock so Stop cannot close the event
            // consumer before it acknowledges the drain.
            yield* ctx.acp.drainEvents;

            yield* Effect.uninterruptible(
              Effect.gen(function* () {
                if (Exit.isSuccess(promptExit)) {
                  const turnRecord = ctx.turns.find((turn) => turn.id === turnId);
                  if (turnRecord) {
                    turnRecord.items.push({
                      prompt: prepared.promptParts,
                      result: promptExit.value,
                    });
                  } else {
                    ctx.turns.push({
                      id: turnId,
                      items: [{ prompt: prepared.promptParts, result: promptExit.value }],
                    });
                  }
                }

                const remainingPrompts = Math.max(0, ctx.promptsInFlight - 1);
                const settlesTurn = remainingPrompts === 0;
                if (settlesTurn) {
                  yield* offerRuntimeEvent({
                    type: "turn.completed",
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId,
                    payload: Exit.isSuccess(promptExit)
                      ? {
                          state:
                            promptExit.value.stopReason === "cancelled" ? "cancelled" : "completed",
                          stopReason: promptExit.value.stopReason ?? null,
                        }
                      : {
                          state: "failed",
                          errorMessage: `${definition.displayName} ACP prompt failed.`,
                        },
                  });
                }

                ctx.promptCancellations.delete(cancellation);
                ctx.promptsInFlight = remainingPrompts;
                ctx.activeTurnId = settlesTurn ? undefined : turnId;
                ctx.session = {
                  ...ctx.session,
                  status: settlesTurn ? "ready" : "running",
                  activeTurnId: settlesTurn ? undefined : turnId,
                  updatedAt: yield* nowIso,
                  model: prepared.resolvedModel,
                };
                promptSettled = true;
              }),
            );
          }),
        );

        if (Exit.isFailure(promptExit)) {
          return yield* Effect.failCause(promptExit.cause);
        }
        return {
          threadId: input.threadId,
          turnId: prepared.turnId,
          resumeCursor: prepared.ctx.session.resumeCursor,
        };
      }).pipe(Effect.ensuring(cleanupPromptSlot));
    };

    const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = (
      threadId,
      turnId,
    ) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          if (turnId !== undefined && ctx.activeTurnId !== turnId) return;
          yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
          yield* settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
          yield* settlePromptCancellations(ctx.promptCancellations);
          yield* Effect.ignore(
            ctx.acp.cancel.pipe(
              Effect.mapError((error) =>
                mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", error),
              ),
            ),
          );
        }),
      );

    const respondToRequest: ProviderAdapterShape<ProviderAdapterError>["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: ProviderAdapterShape<ProviderAdapterError>["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/elicitation",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.answers, answers);
      });

    const readThread: ProviderAdapterShape<ProviderAdapterError>["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const rollbackThread: ProviderAdapterShape<ProviderAdapterError>["rollbackThread"] = (
      threadId,
      numTurns,
    ) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        // ACP has no rollback operation. Do not trim local history while the
        // provider retains the removed turns; return an explicit error instead.
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/rollback",
          detail: `${definition.displayName} ACP sessions do not support rollback.`,
        });
      });

    const stopSession: ProviderAdapterShape<ProviderAdapterError>["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = sessions.get(threadId);
          if (!ctx || ctx.stopped) return;
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: ProviderAdapterShape<ProviderAdapterError>["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: ProviderAdapterShape<ProviderAdapterError>["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    const stopAll: ProviderAdapterShape<ProviderAdapterError>["stopAll"] = () =>
      Effect.forEach(Array.from(sessions.keys()), (threadId) => stopSession(threadId), {
        discard: true,
      });

    yield* Effect.addFinalizer(() =>
      stopAll().pipe(
        Effect.catch((cause) =>
          Effect.logError(`Failed to stop ${definition.displayName} sessions.`, { cause }),
        ),
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    const streamEvents = Stream.fromPubSub(runtimeEventPubSub);

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents,
    } satisfies ProviderAdapterShape<ProviderAdapterError>;
  });
}
