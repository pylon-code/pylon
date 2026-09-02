import {
  type ChatAttachment,
  CommandId,
  EventId,
  type MessageId,
  type ModelSelection,
  type OrchestrationEvent,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProjectId,
  type OrchestrationSession,
  ThreadId,
  type ProviderSession,
  type TurnId,
} from "@t3tools/contracts";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import { isTemporaryWorktreeBranch, WORKTREE_BRANCH_PREFIX } from "@t3tools/shared/git";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { increment, orchestrationEventsProcessedTotal } from "../../observability/Metrics.ts";
import { ProviderAdapterRequestError } from "../../provider/Errors.ts";
import type { ProviderServiceError } from "../../provider/Errors.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import {
  findUnavailableProviderInstance,
  providerUnavailableDetail,
} from "../../provider/providerUnavailable.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ProviderCommandReactor,
  type ProviderCommandReactorShape,
} from "../Services/ProviderCommandReactor.ts";
import { forkParked, ServerActivation } from "../../serverActivation.ts";
import { canReplaceThreadTitle, DEFAULT_THREAD_TITLE } from "../threadTitles.ts";
import {
  resolveSourceControlWriterModelSelection,
  ServerSettingsService,
} from "../../serverSettings.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
const isProviderAdapterRequestError = Schema.is(ProviderAdapterRequestError);
const isProviderDriverKind = Schema.is(ProviderDriverKind);

type TurnAdmissionIntent = NonNullable<
  Extract<OrchestrationEvent, { type: "thread.turn-start-requested" }>["payload"]["admissionIntent"]
>;

type ProviderIntentEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.meta-updated"
      | "thread.runtime-mode-set"
      | "thread.turn-start-requested"
      | "thread.input-queue-follow-up-requested"
      | "thread.turn-interrupt-requested"
      | "thread.approval-response-requested"
      | "thread.user-input-response-requested"
      | "thread.session-stop-requested"
      | "thread.settled";
  }
>;

function toNonEmptyProviderInput(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

export function providerFollowUpInputFromMessage(message: {
  readonly text: string;
  readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
}): { readonly input?: string; readonly attachments?: ReadonlyArray<ChatAttachment> } {
  return {
    ...(message.text.trim().length === 0 ? {} : { input: message.text }),
    ...(message.attachments === undefined ? {} : { attachments: message.attachments }),
  };
}

function mapProviderSessionStatusToOrchestrationStatus(
  status: "connecting" | "ready" | "running" | "error" | "closed",
): OrchestrationSession["status"] {
  switch (status) {
    case "connecting":
      return "starting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    default:
      return "ready";
  }
}

const turnStartKeyForEvent = (event: ProviderIntentEvent): string =>
  event.commandId !== null ? `command:${event.commandId}` : `event:${event.eventId}`;

const HANDLED_TURN_START_KEY_MAX = 10_000;
const HANDLED_TURN_START_KEY_TTL = Duration.minutes(30);
export const PROVIDER_TURN_ADMISSION_TIMEOUT_MS = 60_000;
const PROVIDER_TURN_RECONCILIATION_CONCURRENCY = 8;
export const PROVIDER_TURN_INVENTORY_ATTEMPT_TIMEOUT_MS = 2_000;
export const PROVIDER_TURN_INVENTORY_RETRY_TIMEOUT_MS = 6_500;
const PROVIDER_TURN_ADMISSION_TIMEOUT_DETAIL =
  "Provider did not start the requested turn within 60 seconds.";
const MAX_REGENERATION_ATTACHMENTS = 4;
const MAX_THREAD_TITLE_CONTEXT_CHARS = 8_000;
const MAX_FIRST_USER_TITLE_CONTEXT_CHARS = 2_000;
const THREAD_TITLE_CONTEXT_TRUNCATION_MARKER = "[Earlier content truncated]\n\n";
const FIRST_USER_CONTEXT_TRUNCATION_MARKER = "\n[First user message truncated]";

type ThreadTitleMessage = {
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
};

function formatThreadTitleSection(message: ThreadTitleMessage): string | undefined {
  if (message.role === "system") {
    return undefined;
  }
  const text = assistantCitationsToPlainText(message.text).trim();
  const attachmentSummary = (message.attachments ?? [])
    .map((attachment) => attachment.name)
    .join(", ");
  const contents = [
    ...(text.length > 0 ? [text] : []),
    ...(attachmentSummary.length > 0 ? [`[Attachments: ${attachmentSummary}]`] : []),
  ].join("\n");
  return contents.length > 0 ? `${message.role.toUpperCase()}:\n${contents}` : undefined;
}

function limitFirstUserSection(section: string): string {
  if (section.length <= MAX_FIRST_USER_TITLE_CONTEXT_CHARS) {
    return section;
  }
  return `${section.slice(
    0,
    MAX_FIRST_USER_TITLE_CONTEXT_CHARS - FIRST_USER_CONTEXT_TRUNCATION_MARKER.length,
  )}${FIRST_USER_CONTEXT_TRUNCATION_MARKER}`;
}

function collectRecentThreadTitleContext(
  messages: ReadonlyArray<ThreadTitleMessage>,
  maxChars: number,
): {
  readonly context: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly truncated: boolean;
} {
  let context = "";
  let truncated = false;
  const retainedAttachments: Array<ChatAttachment> = [];

  for (const message of messages.toReversed()) {
    const section = formatThreadTitleSection(message);
    if (section === undefined) {
      continue;
    }

    const separator = context.length > 0 ? "\n\n" : "";
    const available = maxChars - context.length - separator.length;
    if (section.length > available) {
      if (available > 0) {
        context = `${section.slice(-available)}${separator}${context}`;
        retainedAttachments.unshift(...(message.attachments ?? []));
      }
      truncated = true;
      break;
    }
    context = `${section}${separator}${context}`;
    retainedAttachments.unshift(...(message.attachments ?? []));
  }

  return { context, attachments: retainedAttachments, truncated };
}

function formatThreadTitleContext(messages: ReadonlyArray<ThreadTitleMessage>): {
  readonly message: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
} {
  const recent = collectRecentThreadTitleContext(messages, MAX_THREAD_TITLE_CONTEXT_CHARS);
  if (!recent.truncated) {
    return {
      message: recent.context,
      attachments: recent.attachments.slice(-MAX_REGENERATION_ATTACHMENTS),
    };
  }

  const firstUserMessage = messages.find(
    (message) => message.role === "user" && formatThreadTitleSection(message),
  );
  const firstUserSection = firstUserMessage
    ? formatThreadTitleSection(firstUserMessage)
    : undefined;
  if (!firstUserMessage || !firstUserSection) {
    return {
      message: `${THREAD_TITLE_CONTEXT_TRUNCATION_MARKER}${recent.context}`,
      attachments: recent.attachments.slice(-MAX_REGENERATION_ATTACHMENTS),
    };
  }

  const pinnedSection = limitFirstUserSection(firstUserSection);
  const recentContextBudget =
    MAX_THREAD_TITLE_CONTEXT_CHARS -
    pinnedSection.length -
    "\n\n".length -
    THREAD_TITLE_CONTEXT_TRUNCATION_MARKER.length;
  const retainedRecent = collectRecentThreadTitleContext(messages, recentContextBudget);
  const pinnedAttachment = firstUserMessage.attachments?.[0];
  const recentAttachments = retainedRecent.attachments.filter(
    (attachment) => attachment.id !== pinnedAttachment?.id,
  );

  return {
    message: `${pinnedSection}\n\n${THREAD_TITLE_CONTEXT_TRUNCATION_MARKER}${retainedRecent.context}`,
    attachments: [
      ...(pinnedAttachment ? [pinnedAttachment] : []),
      ...recentAttachments.slice(
        -(MAX_REGENERATION_ATTACHMENTS - (pinnedAttachment === undefined ? 0 : 1)),
      ),
    ],
  };
}

export function providerErrorLabel(value: string | undefined): string {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : "unknown";
}

export function providerErrorLabelFromInstanceHint(input: {
  readonly instanceId?: string | undefined;
  readonly modelSelectionInstanceId?: string | undefined;
  readonly sessionProvider?: string | undefined;
}): string {
  return providerErrorLabel(
    input.instanceId ?? input.modelSelectionInstanceId ?? input.sessionProvider,
  );
}

function findProviderAdapterRequestError(
  cause: Cause.Cause<ProviderServiceError>,
): ProviderAdapterRequestError | undefined {
  const failReason = cause.reasons.find(Cause.isFailReason);
  return isProviderAdapterRequestError(failReason?.error) ? failReason.error : undefined;
}

function isUnknownPendingApprovalRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = findProviderAdapterRequestError(cause);
  if (error) {
    const detail = error.detail.toLowerCase();
    return (
      detail.includes("unknown pending approval request") ||
      detail.includes("unknown pending permission request") ||
      detail.includes("unknown pending codex approval request")
    );
  }
  const message = Cause.pretty(cause).toLowerCase();
  return (
    message.includes("unknown pending approval request") ||
    message.includes("unknown pending permission request") ||
    message.includes("unknown pending codex approval request")
  );
}

function isUnknownPendingUserInputRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = findProviderAdapterRequestError(cause);
  if (error) {
    const detail = error.detail.toLowerCase();
    return (
      detail.includes("unknown pending user-input request") ||
      detail.includes("unknown pending user input request") ||
      detail.includes("unknown pending codex user input request")
    );
  }
  const message = Cause.pretty(cause).toLowerCase();
  return (
    message.includes("unknown pending user-input request") ||
    message.includes("unknown pending user input request") ||
    message.includes("unknown pending codex user input request")
  );
}

function stalePendingRequestDetail(
  requestKind: "approval" | "user-input",
  requestId: string,
): string {
  return `Stale pending ${requestKind} request: ${requestId}. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.`;
}

function buildGeneratedWorktreeBranchName(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, "")
    .replace(/['"`]/g, "");

  const withoutPrefix = normalized.startsWith(`${WORKTREE_BRANCH_PREFIX}/`)
    ? normalized.slice(`${WORKTREE_BRANCH_PREFIX}/`.length)
    : normalized;

  const branchFragment = withoutPrefix
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 64)
    .replace(/[./_-]+$/g, "");

  const safeFragment = branchFragment.length > 0 ? branchFragment : "update";
  return `${WORKTREE_BRANCH_PREFIX}/${safeFragment}`;
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const providerRegistry = yield* ProviderRegistry;
  const gitWorkflow = yield* GitWorkflowService;
  const fileSystem = yield* FileSystem.FileSystem;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;
  const textGeneration = yield* TextGeneration;
  const serverSettingsService = yield* ServerSettingsService;
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const serverCommandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const serverEventId = () => crypto.randomUUIDv4.pipe(Effect.map(EventId.make));
  const handledTurnStartKeys = yield* Cache.make<string, true>({
    capacity: HANDLED_TURN_START_KEY_MAX,
    timeToLive: HANDLED_TURN_START_KEY_TTL,
    lookup: () => Effect.succeed(true),
  });

  const hasHandledTurnStartRecently = (key: string) =>
    Cache.getOption(handledTurnStartKeys, key).pipe(
      Effect.flatMap((cached) =>
        Cache.set(handledTurnStartKeys, key, true).pipe(Effect.as(Option.isSome(cached))),
      ),
    );

  const threadModelSelections = new Map<string, ModelSelection>();
  const admissionFibers = new Map<CommandId, Fiber.Fiber<unknown, unknown>>();
  const admissionFiberThreads = new Map<CommandId, ThreadId>();
  type AdmissionStopToken = object;
  const admissionStopTokens = new Map<CommandId, AdmissionStopToken>();
  const admissionPermits = new Map<ThreadId, Semaphore.Semaphore>();
  const makeAdmissionStopToken = (): AdmissionStopToken => Object.freeze({});
  const admissionStopTokenForRequest = (requestId: CommandId) => {
    const current = admissionStopTokens.get(requestId);
    if (current !== undefined) return current;
    const created = makeAdmissionStopToken();
    admissionStopTokens.set(requestId, created);
    return created;
  };
  const admissionPermitForThread = (threadId: ThreadId) => {
    const current = admissionPermits.get(threadId);
    if (current !== undefined) return current;
    const created = Semaphore.makeUnsafe(1);
    admissionPermits.set(threadId, created);
    return created;
  };
  const releaseAdmissionLaneIfIdle = (threadId: ThreadId) => {
    for (const fiberThreadId of admissionFiberThreads.values()) {
      if (fiberThreadId === threadId) return;
    }
    admissionPermits.delete(threadId);
  };

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const fibers = Array.from(admissionFibers.entries());
      // Keep registry ownership until the admission itself is done. Clearing it
      // before interruption hid detached work from the layer finalizer.
      yield* Effect.forEach(fibers, ([, fiber]) => Fiber.interrupt(fiber).pipe(Effect.forkDetach), {
        concurrency: "unbounded",
        discard: true,
      });
      const joined = yield* Effect.forEach(fibers, ([, fiber]) => Fiber.await(fiber), {
        concurrency: "unbounded",
        discard: true,
      }).pipe(Effect.timeoutOption(Duration.seconds(1)));
      if (Option.isSome(joined)) {
        for (const [requestId, fiber] of fibers) {
          if (admissionFibers.get(requestId) === fiber && fiber.pollUnsafe() !== undefined) {
            const threadId = admissionFiberThreads.get(requestId);
            admissionFibers.delete(requestId);
            admissionFiberThreads.delete(requestId);
            admissionStopTokens.delete(requestId);
            if (threadId !== undefined) releaseAdmissionLaneIfIdle(threadId);
          }
        }
      } else if (fibers.length > 0) {
        yield* Effect.logWarning("provider turn admissions remained after reactor teardown", {
          retainedAdmissionCount: admissionFibers.size,
        });
      }
    }),
  );

  const appendProviderFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly kind:
      | "provider.turn.start.failed"
      | "provider.input-queue.follow-up.failed"
      | "provider.turn.interrupt.failed"
      | "provider.approval.respond.failed"
      | "provider.user-input.respond.failed"
      | "provider.session.stop.failed";
    readonly summary: string;
    readonly detail: string;
    readonly turnId: TurnId | null;
    readonly createdAt: string;
    readonly requestId?: string;
    readonly commandId?: CommandId;
  }) =>
    Effect.all({
      commandId:
        input.commandId === undefined
          ? serverCommandId("provider-failure-activity")
          : Effect.succeed(input.commandId),
      eventId: serverEventId(),
    }).pipe(
      Effect.flatMap(({ commandId, eventId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: eventId,
            tone: "error",
            kind: input.kind,
            summary: input.summary,
            payload: {
              detail: input.detail,
              ...(input.requestId ? { requestId: input.requestId } : {}),
            },
            turnId: input.turnId,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  const formatFailureDetail = (cause: Cause.Cause<unknown>): string => {
    const failReason = cause.reasons.find(Cause.isFailReason);
    const providerError = isProviderAdapterRequestError(failReason?.error)
      ? failReason.error
      : undefined;
    if (providerError) {
      return providerError.detail;
    }
    return Cause.pretty(cause);
  };

  const applyThreadSessionLifecycle = (input: {
    readonly threadId: ThreadId;
    readonly expectedSession: OrchestrationSession | null;
    readonly session: OrchestrationSession;
    readonly createdAt: string;
    readonly allowFailedTurnRequestClear?: true;
  }) =>
    serverCommandId("provider-session-lifecycle").pipe(
      Effect.flatMap((commandId) => {
        const expected = input.expectedSession;
        return orchestrationEngine.dispatch({
          type: "thread.session.apply-lifecycle",
          commandId,
          threadId: input.threadId,
          expectedStatus: expected?.status ?? null,
          expectedProviderInstanceId: expected?.providerInstanceId ?? null,
          expectedSessionIncarnationId: expected?.sessionIncarnationId ?? null,
          expectedPendingTurnRequestId: expected?.pendingTurnRequestId ?? null,
          expectedPendingTurnSessionId: expected?.pendingTurnSessionId ?? null,
          expectedActiveTurnRequestId: expected?.activeTurnRequestId ?? null,
          expectedActiveTurnId: expected?.activeTurnId ?? null,
          expectedFailedTurnRequestId: expected?.failedTurnRequestId ?? null,
          expectedPendingStopRequestId: expected?.pendingStopRequestId ?? null,
          expectedPendingStopSessionIncarnationId:
            expected?.pendingStopSessionIncarnationId ?? null,
          ...(input.allowFailedTurnRequestClear === true
            ? { allowFailedTurnRequestClear: true as const }
            : {}),
          session: input.session,
          createdAt: input.createdAt,
        });
      }),
    );

  const acceptTurnAdmissionIfPending = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly requestId: CommandId;
    readonly messageId: MessageId;
    readonly providerInstanceId: ProviderInstanceId;
    readonly sessionIncarnationId: NonNullable<ProviderSession["sessionIncarnationId"]>;
    readonly turnId: TurnId;
    readonly createdAt: string;
  }) {
    const commandId = yield* serverCommandId("provider-turn-admission-accept");
    const dispatched = yield* orchestrationEngine.dispatch({
      type: "thread.turn.admission.accept",
      commandId,
      threadId: input.threadId,
      requestId: input.requestId,
      messageId: input.messageId,
      providerInstanceId: input.providerInstanceId,
      sessionIncarnationId: input.sessionIncarnationId,
      turnId: input.turnId,
      createdAt: input.createdAt,
    });
    return (dispatched.eventCount ?? 0) > 0;
  });

  const failTurnAdmissionIfPending = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly requestId: CommandId;
    readonly messageId: MessageId;
    readonly detail: string;
    readonly createdAt: string;
  }) {
    const commandId = yield* serverCommandId("provider-turn-admission");
    const dispatched = yield* orchestrationEngine.dispatch({
      type: "thread.turn.admission.fail",
      commandId,
      threadId: input.threadId,
      requestId: input.requestId,
      messageId: input.messageId,
      detail: input.detail,
      createdAt: input.createdAt,
    });
    return (dispatched.eventCount ?? 0) > 0;
  });

  const resolveProject = Effect.fnUntraced(function* (projectId: ProjectId) {
    return yield* projectionSnapshotQuery
      .getProjectShellById(projectId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  /**
   * Recreates a thread's worktree from its branch when the directory has
   * disappeared. Provider sessions resume into the persisted cwd, so a missing
   * worktree makes every later turn fail as a bogus "session not found".
   * Best-effort: on failure the turn proceeds and reports the real error.
   */
  const ensureThreadWorktree = Effect.fnUntraced(function* (thread: {
    readonly id: ThreadId;
    readonly projectId: ProjectId;
    readonly branch: string | null;
    readonly worktreePath: string | null;
  }) {
    const { worktreePath, branch } = thread;
    if (!worktreePath || !branch) {
      return;
    }
    const exists = yield* fileSystem.exists(worktreePath).pipe(Effect.orElseSucceed(() => true));
    if (exists) {
      return;
    }
    const project = yield* resolveProject(thread.projectId);
    if (!project) {
      return;
    }
    const cwd = project.workspaceRoot;
    yield* Effect.logWarning("provider command reactor recreating missing worktree", {
      threadId: thread.id,
      worktreePath,
      branch,
    });
    // A directory deleted without `git worktree remove` leaves an admin entry
    // that makes `git worktree add` refuse the path; prune clears it.
    yield* gitWorkflow.pruneWorktrees({ cwd }).pipe(
      Effect.andThen(gitWorkflow.createWorktree({ cwd, refName: branch, path: worktreePath })),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("provider command reactor failed to recreate worktree", {
              threadId: thread.id,
              worktreePath,
              cause: Cause.pretty(cause),
            }),
      ),
    );
  });

  const resolveThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadDetailById(threadId, { activityKinds: [] })
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const rejectStartedThreadModelChangeIfRequired = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly currentModelSelection: ModelSelection;
    readonly requestedModelSelection: ModelSelection | undefined;
  }) {
    const requestedModelSelection = input.requestedModelSelection;
    if (
      requestedModelSelection === undefined ||
      (input.currentModelSelection.instanceId === requestedModelSelection.instanceId &&
        input.currentModelSelection.model === requestedModelSelection.model)
    ) {
      return;
    }
    const providers = yield* providerRegistry.getProviders;
    const requiresNewThread =
      providers.find((snapshot) => snapshot.instanceId === input.currentModelSelection.instanceId)
        ?.requiresNewThreadForModelChange === true ||
      providers.find((snapshot) => snapshot.instanceId === requestedModelSelection.instanceId)
        ?.requiresNewThreadForModelChange === true;
    if (!requiresNewThread) {
      return;
    }
    return yield* new ProviderAdapterRequestError({
      provider: providerErrorLabelFromInstanceHint({
        instanceId: String(requestedModelSelection.instanceId),
        modelSelectionInstanceId: String(input.currentModelSelection.instanceId),
      }),
      method: "thread.turn.start",
      detail: `Thread '${input.threadId}' cannot switch models after the conversation has started. Start a new thread to use '${requestedModelSelection.model}'.`,
    });
  });

  const ensureSessionForThread = Effect.fn("ensureSessionForThread")(function* (
    threadId: ThreadId,
    createdAt: string,
    options?: {
      readonly modelSelection?: ModelSelection;
      readonly runtimeMode?: OrchestrationSession["runtimeMode"];
      readonly interactionMode?: "default" | "plan";
      readonly pendingTurnStart?: boolean;
      readonly pendingTurnRequestId?: CommandId;
      readonly pendingTurnMessageId?: MessageId;
      readonly pendingTurnRequestedAt?: string;
      readonly pendingTurnDeadlineAt?: string;
      readonly expectedProviderInstanceId?: ProviderInstanceId | null;
      readonly expectedSessionIncarnationId?: TurnAdmissionIntent["expectedSessionIncarnationId"];
    },
  ) {
    const thread = yield* resolveThread(threadId);
    if (!thread) {
      return yield* Effect.die(new Error(`Thread '${threadId}' was not found in read model.`));
    }

    const desiredRuntimeMode = options?.runtimeMode ?? thread.runtimeMode;
    const desiredInteractionMode = options?.interactionMode ?? thread.interactionMode;
    const requestedModelSelection = options?.modelSelection;
    const resolveActiveSession = (threadId: ThreadId) =>
      providerService
        .listSessions()
        .pipe(Effect.map((sessions) => sessions.find((session) => session.threadId === threadId)));

    const activeSession = yield* resolveActiveSession(threadId);
    const observedInstanceId = thread.session?.providerInstanceId;
    const persistedInstanceId =
      options?.expectedProviderInstanceId === undefined
        ? observedInstanceId
        : (options.expectedProviderInstanceId ?? undefined);
    if (
      options?.expectedProviderInstanceId !== undefined &&
      (observedInstanceId ?? null) !== options.expectedProviderInstanceId
    ) {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(String(options.expectedProviderInstanceId ?? "unknown")),
        method: "thread.turn.start",
        detail: `Turn admission observed a different provider binding for thread '${threadId}'.`,
      });
    }
    if (
      options?.expectedSessionIncarnationId !== undefined &&
      (thread.session?.sessionIncarnationId ?? null) !== options.expectedSessionIncarnationId
    ) {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(String(persistedInstanceId ?? "unknown")),
        method: "thread.turn.start",
        detail: `Turn admission observed a different provider session incarnation for thread '${threadId}'.`,
      });
    }
    const activeThreadSession =
      thread.session !== null && thread.session.status !== "stopped" && activeSession
        ? thread.session
        : null;
    if (
      activeThreadSession !== null &&
      activeSession !== undefined &&
      (activeThreadSession.providerInstanceId === undefined ||
        activeSession.providerInstanceId === undefined)
    ) {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(activeThreadSession.providerName ?? undefined),
        method: "thread.turn.start",
        detail: `Thread '${threadId}' has an active provider session without a provider instance id.`,
      });
    }
    if (
      persistedInstanceId !== undefined &&
      activeSession?.providerInstanceId !== undefined &&
      activeSession.providerInstanceId !== persistedInstanceId
    ) {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(String(persistedInstanceId)),
        method: "thread.turn.start",
        detail: `Thread '${threadId}' is bound to provider instance '${persistedInstanceId}', but the active runtime belongs to '${activeSession.providerInstanceId}'.`,
      });
    }

    if (
      options?.expectedSessionIncarnationId !== undefined &&
      activeSession !== undefined &&
      activeSession.sessionIncarnationId !== options.expectedSessionIncarnationId
    ) {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(String(persistedInstanceId ?? "unknown")),
        method: "thread.turn.start",
        detail: `The provider runtime for thread '${threadId}' no longer matches the accepted session incarnation.`,
      });
    }

    // The projected session binding survives provider-runtime restarts. Keep
    // resolving that exact instance when the in-memory session is gone. A model
    // selection from another instance is not repairable by replacing only its
    // routing key: its model and options belong to the other provider.
    const currentInstanceId =
      persistedInstanceId ?? activeSession?.providerInstanceId ?? thread.modelSelection.instanceId;
    const cachedModelSelection = threadModelSelections.get(threadId);
    const persistedModelSelection =
      cachedModelSelection?.instanceId === currentInstanceId
        ? cachedModelSelection
        : activeSession?.providerInstanceId === currentInstanceId && activeSession.model
          ? { instanceId: currentInstanceId, model: activeSession.model }
          : thread.modelSelection.instanceId === currentInstanceId
            ? thread.modelSelection
            : undefined;
    const hasStartedSession =
      activeSession !== undefined ||
      thread.latestTurn !== null ||
      thread.session?.startedAt !== undefined ||
      thread.session?.providerInstanceId !== undefined;
    const desiredModelSelection = requestedModelSelection ?? persistedModelSelection;
    if (desiredModelSelection === undefined) {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(String(currentInstanceId)),
        method: "thread.turn.start",
        detail: `Thread '${threadId}' is bound to provider instance '${currentInstanceId}', but no model selection persisted for that exact instance. Start a new thread or explicitly select a model for the bound provider.`,
      });
    }
    const desiredInstanceId = desiredModelSelection.instanceId;
    const resolveInstanceInfo = Effect.fnUntraced(function* (
      instanceId: ProviderInstanceId,
      role: "current" | "requested",
    ) {
      return yield* providerService.getInstanceInfo(instanceId).pipe(
        Effect.catch(() =>
          providerRegistry.getProviders.pipe(
            Effect.flatMap((providers) => {
              const unavailable = findUnavailableProviderInstance(providers, instanceId);
              return Effect.fail(
                new ProviderAdapterRequestError({
                  provider: providerErrorLabelFromInstanceHint({
                    instanceId: String(instanceId),
                    modelSelectionInstanceId: String(thread.modelSelection.instanceId),
                    sessionProvider: thread.session?.providerName ?? undefined,
                  }),
                  method: "thread.turn.start",
                  detail: unavailable
                    ? providerUnavailableDetail(unavailable)
                    : role === "current"
                      ? `Thread '${threadId}' references unknown provider instance '${instanceId}'. The instance is not configured in this build.`
                      : `Requested provider instance '${instanceId}' is not configured in this build.`,
                }),
              );
            }),
          ),
        ),
      );
    });
    const desiredInfo = yield* resolveInstanceInfo(desiredInstanceId, "requested");
    if (hasStartedSession && desiredInstanceId !== currentInstanceId) {
      const currentInfo = yield* resolveInstanceInfo(currentInstanceId, "current");
      const currentContinuationKey = currentInfo.continuationIdentity.continuationKey.trim();
      const desiredContinuationKey = desiredInfo.continuationIdentity.continuationKey.trim();
      if (currentInfo.driverKind !== desiredInfo.driverKind) {
        return yield* new ProviderAdapterRequestError({
          provider: providerErrorLabel(String(desiredInfo.driverKind)),
          method: "thread.turn.start",
          detail: `Thread '${threadId}' is bound to driver '${currentInfo.driverKind}' and cannot switch to '${desiredInfo.driverKind}'. Start a new thread to change providers.`,
        });
      }
      if (
        currentContinuationKey.length === 0 ||
        desiredContinuationKey.length === 0 ||
        currentContinuationKey !== desiredContinuationKey
      ) {
        return yield* new ProviderAdapterRequestError({
          provider: providerErrorLabel(String(desiredInfo.driverKind)),
          method: "thread.turn.start",
          detail: `Thread '${threadId}' cannot switch from instance '${currentInstanceId}' to '${desiredInstanceId}' because they do not share the same non-empty provider continuation identity. Start a new thread to use that account.`,
        });
      }
    }
    const desiredDriverKind = desiredInfo.driverKind;
    if (!isProviderDriverKind(desiredDriverKind)) {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(String(desiredDriverKind)),
        method: "thread.turn.start",
        detail: `Requested provider instance '${desiredInstanceId}' uses unknown provider driver '${desiredDriverKind}'. The driver is not installed in this build.`,
      });
    }
    const preferredProvider: ProviderDriverKind = desiredDriverKind;
    if (thread.session !== null && hasStartedSession && desiredInstanceId === currentInstanceId) {
      yield* rejectStartedThreadModelChangeIfRequired({
        threadId,
        currentModelSelection: persistedModelSelection ?? desiredModelSelection,
        requestedModelSelection,
      });
    }
    const project = yield* resolveProject(thread.projectId);
    const effectiveCwd = resolveThreadWorkspaceCwd({
      thread,
      projects: project ? [project] : [],
    });

    const startProviderSession = (input?: {
      readonly resumeCursor?: unknown;
      readonly provider?: ProviderDriverKind;
    }) =>
      providerService.startSession(threadId, {
        threadId,
        ...(preferredProvider ? { provider: preferredProvider } : {}),
        providerInstanceId: desiredInstanceId,
        ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
        ...(thread.title ? { title: thread.title } : {}),
        modelSelection: desiredModelSelection,
        ...(input?.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
        runtimeMode: desiredRuntimeMode,
      });

    const bindSessionToThread = (session: ProviderSession) =>
      Effect.gen(function* () {
        if (
          session.providerInstanceId === undefined ||
          session.sessionIncarnationId === undefined
        ) {
          return yield* new ProviderAdapterRequestError({
            provider: providerErrorLabel(session.provider),
            method: "thread.turn.start",
            detail: `Provider session '${session.threadId}' started without a provider instance or session incarnation id.`,
          });
        }
        const sessionBinding: OrchestrationSession = {
          threadId,
          status:
            options?.pendingTurnStart === true && session.status === "ready"
              ? "starting"
              : mapProviderSessionStatusToOrchestrationStatus(session.status),
          providerName: session.provider,
          providerInstanceId: session.providerInstanceId,
          runtimeMode: desiredRuntimeMode,
          ...(session.restored === true ? { restored: true } : {}),
          sessionIncarnationId: session.sessionIncarnationId,
          ...(options?.pendingTurnRequestId === undefined
            ? {}
            : { pendingTurnRequestId: options.pendingTurnRequestId }),
          ...(options?.pendingTurnMessageId === undefined
            ? {}
            : { pendingTurnMessageId: options.pendingTurnMessageId }),
          ...(options?.pendingTurnRequestedAt === undefined
            ? {}
            : { pendingTurnRequestedAt: options.pendingTurnRequestedAt }),
          ...(options?.pendingTurnDeadlineAt === undefined
            ? {}
            : { pendingTurnDeadlineAt: options.pendingTurnDeadlineAt }),
          ...(options?.pendingTurnRequestId === undefined
            ? {}
            : { pendingTurnSessionId: session.sessionIncarnationId }),
          ...(thread.session?.pendingStopRequestId === undefined
            ? {}
            : {
                pendingStopRequestId: thread.session.pendingStopRequestId,
                pendingStopProviderInstanceId: thread.session.pendingStopProviderInstanceId ?? null,
                pendingStopSessionIncarnationId:
                  thread.session.pendingStopSessionIncarnationId ?? null,
                pendingStopTurnRequestId: thread.session.pendingStopTurnRequestId ?? null,
                pendingStopTurnId: thread.session.pendingStopTurnId ?? null,
              }),
          activeTurnRequestId: undefined,
          startedAt: session.createdAt,
          // Provider turn ids are not orchestration turn ids.
          activeTurnId: null,
          lastError: session.lastError ?? null,
          updatedAt: session.updatedAt,
        };
        const commandId = yield* serverCommandId("provider-session-bind");
        const dispatched = yield* orchestrationEngine.dispatch(
          options?.pendingTurnRequestId === undefined
            ? {
                type: "thread.session.set",
                commandId,
                threadId,
                session: sessionBinding,
                createdAt,
              }
            : {
                type: "thread.session.bind-pending",
                commandId,
                threadId,
                requestId: options.pendingTurnRequestId,
                messageId: options.pendingTurnMessageId!,
                expectedProviderInstanceId:
                  options?.expectedProviderInstanceId === undefined
                    ? (persistedInstanceId ?? null)
                    : options.expectedProviderInstanceId,
                modelSelection: desiredModelSelection,
                runtimeMode: desiredRuntimeMode,
                interactionMode: desiredInteractionMode,
                session: sessionBinding,
                createdAt,
              },
        );
        return (dispatched.eventCount ?? 1) > 0;
      });

    const quarantineStartedSession = (session: ProviderSession) => {
      if (session.providerInstanceId === undefined || session.sessionIncarnationId === undefined) {
        return Effect.void;
      }
      return providerService
        .stopSession({
          threadId,
          expectedProviderInstanceId: session.providerInstanceId,
          expectedSessionIncarnationId: session.sessionIncarnationId,
          expectedAdmissionRequestId: options?.pendingTurnRequestId ?? null,
          removeBinding: true,
          invalidateStartReservation: false,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("provider command reactor failed to quarantine superseded session", {
              threadId,
              providerInstanceId: session.providerInstanceId,
              sessionIncarnationId: session.sessionIncarnationId,
              cause: Cause.pretty(cause),
            }),
          ),
        );
    };
    const bindStartedSession = (session: ProviderSession) =>
      bindSessionToThread(session).pipe(
        Effect.tap((bound) => (bound ? Effect.void : quarantineStartedSession(session))),
        Effect.onError(() => quarantineStartedSession(session)),
        // Once an adapter returned a concrete runtime, either its exact CAS
        // binds or that exact runtime is quarantined before interruption lands.
        Effect.uninterruptible,
      );
    const startAndBindSession = (input?: {
      readonly resumeCursor?: unknown;
      readonly provider?: ProviderDriverKind;
    }) =>
      Effect.uninterruptibleMask((restore) =>
        restore(startProviderSession(input)).pipe(
          Effect.flatMap((session) =>
            bindStartedSession(session).pipe(Effect.map((bound) => ({ session, bound }))),
          ),
        ),
      );

    const existingSessionThreadId =
      thread.session && thread.session.status !== "stopped" && activeSession ? thread.id : null;
    if (existingSessionThreadId) {
      const runtimeModeChanged = desiredRuntimeMode !== thread.session?.runtimeMode;
      const cwdChanged = effectiveCwd !== activeSession?.cwd;
      const sessionModelSwitch = (yield* providerService.getCapabilities(desiredInstanceId))
        .sessionModelSwitch;
      const modelChanged =
        requestedModelSelection !== undefined &&
        requestedModelSelection.model !== activeSession?.model;
      const instanceChanged =
        requestedModelSelection !== undefined &&
        activeSession?.providerInstanceId !== requestedModelSelection.instanceId;
      const shouldRestartForModelChange = modelChanged && sessionModelSwitch === "unsupported";
      const previousModelSelection = threadModelSelections.get(threadId);
      const shouldRestartForModelSelectionChange =
        preferredProvider === "claudeAgent" &&
        requestedModelSelection !== undefined &&
        !Equal.equals(previousModelSelection, requestedModelSelection);

      if (
        !runtimeModeChanged &&
        !cwdChanged &&
        !instanceChanged &&
        !shouldRestartForModelChange &&
        !shouldRestartForModelSelectionChange
      ) {
        if (options?.pendingTurnStart === false) return activeSession;
        return (yield* bindSessionToThread(activeSession!)) ? activeSession : undefined;
      }

      const resumeCursor = shouldRestartForModelChange
        ? undefined
        : (activeSession?.resumeCursor ?? undefined);
      yield* Effect.logInfo("provider command reactor restarting provider session", {
        threadId,
        existingSessionThreadId,
        currentProvider: activeSession?.provider,
        currentInstanceId,
        desiredInstanceId,
        desiredProvider: desiredModelSelection.instanceId,
        currentRuntimeMode: thread.session?.runtimeMode,
        desiredRuntimeMode: thread.runtimeMode,
        runtimeModeChanged,
        previousCwd: activeSession?.cwd,
        desiredCwd: effectiveCwd,
        cwdChanged,
        modelChanged,
        instanceChanged,
        shouldRestartForModelChange,
        shouldRestartForModelSelectionChange,
        hasResumeCursor: resumeCursor !== undefined,
      });
      const restarted = yield* startAndBindSession(
        resumeCursor !== undefined ? { resumeCursor } : undefined,
      );
      const restartedSession = restarted.session;
      yield* Effect.logInfo("provider command reactor restarted provider session", {
        threadId,
        previousSessionId: existingSessionThreadId,
        restartedSessionThreadId: restartedSession.threadId,
        provider: restartedSession.provider,
        runtimeMode: restartedSession.runtimeMode,
        cwd: restartedSession.cwd,
      });
      return restarted.bound ? restartedSession : undefined;
    }

    const compatibleColdTransition =
      hasStartedSession && desiredInstanceId !== currentInstanceId
        ? yield* providerService.getSessionContinuation?.(threadId) ?? Effect.succeed(null)
        : null;
    if (hasStartedSession && desiredInstanceId !== currentInstanceId) {
      if (
        compatibleColdTransition === null ||
        compatibleColdTransition.providerInstanceId !== currentInstanceId
      ) {
        return yield* new ProviderAdapterRequestError({
          provider: providerErrorLabel(String(desiredInstanceId)),
          method: "thread.turn.start",
          detail: `Thread '${threadId}' cannot continue on '${desiredInstanceId}' because its exact persisted provider continuation is unavailable.`,
        });
      }
    }
    const started = yield* startAndBindSession(
      compatibleColdTransition === null
        ? undefined
        : { resumeCursor: compatibleColdTransition.resumeCursor },
    );
    return started.bound ? started.session : undefined;
  });

  const buildSendTurnRequestForThread = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly modelSelection?: ModelSelection;
    readonly runtimeMode: OrchestrationSession["runtimeMode"];
    readonly interactionMode: "default" | "plan";
    readonly requestId: CommandId;
    readonly messageId: MessageId;
    readonly admissionIntent?: TurnAdmissionIntent;
    readonly admissionRequestedAt: string;
    readonly admissionDeadlineAt: string;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    if (!thread) {
      return yield* Effect.die(
        new Error(`Thread '${input.threadId}' was not found in read model.`),
      );
    }
    const admissionIntent = input.admissionIntent;
    const requiresExactAdmission =
      admissionIntent === undefined
        ? thread.session?.status !== "running"
        : admissionIntent.kind !== "steer";
    const admittedSession = yield* ensureSessionForThread(input.threadId, input.createdAt, {
      ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
      pendingTurnStart: requiresExactAdmission,
      ...(admissionIntent === undefined
        ? {}
        : {
            expectedProviderInstanceId: admissionIntent.expectedProviderInstanceId,
            expectedSessionIncarnationId: admissionIntent.expectedSessionIncarnationId,
          }),
      ...(requiresExactAdmission
        ? {
            pendingTurnRequestId: input.requestId,
            pendingTurnMessageId: input.messageId,
            pendingTurnRequestedAt: input.admissionRequestedAt,
            pendingTurnDeadlineAt: input.admissionDeadlineAt,
          }
        : {}),
    });
    if (admittedSession === undefined) {
      return yield* new ProviderAdapterRequestError({
        provider: "unknown",
        method: "thread.turn.start",
        detail: `Turn admission '${input.requestId}' was superseded before provider binding completed.`,
      });
    }
    const normalizedInput = toNonEmptyProviderInput(input.messageText);
    const normalizedAttachments = input.attachments ?? [];
    const activeSession = yield* providerService
      .listSessions()
      .pipe(
        Effect.map((sessions) => sessions.find((session) => session.threadId === input.threadId)),
      );
    const admittedInstanceId = admittedSession.providerInstanceId;
    if (admittedInstanceId === undefined) {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(admittedSession.provider),
        method: "thread.turn.start",
        detail: `Admitted provider session '${admittedSession.threadId}' is missing a provider instance id.`,
      });
    }
    const requestedModelSelection =
      input.admissionIntent?.targetModelSelection ??
      input.modelSelection ??
      threadModelSelections.get(input.threadId) ??
      thread.modelSelection;
    if (requestedModelSelection.instanceId !== admittedInstanceId) {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(String(admittedInstanceId)),
        method: "thread.turn.start",
        detail: `Thread '${input.threadId}' is bound to provider instance '${admittedInstanceId}', but its requested model selection belongs to '${requestedModelSelection.instanceId}'. Start a new thread or explicitly select a model for the bound provider.`,
      });
    }
    threadModelSelections.set(input.threadId, requestedModelSelection);
    const sessionModelSwitch = (yield* providerService.getCapabilities(admittedInstanceId))
      .sessionModelSwitch;
    const modelForTurn =
      sessionModelSwitch === "unsupported" &&
      input.modelSelection === undefined &&
      activeSession?.providerInstanceId === admittedInstanceId &&
      activeSession.model !== undefined
        ? {
            ...requestedModelSelection,
            model: activeSession.model,
          }
        : input.modelSelection;

    return {
      threadId: input.threadId,
      ...(normalizedInput ? { input: normalizedInput } : {}),
      ...(normalizedAttachments.length > 0 ? { attachments: normalizedAttachments } : {}),
      ...(modelForTurn !== undefined ? { modelSelection: modelForTurn } : {}),
      ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
      admissionRequestId:
        input.admissionIntent?.kind === "steer"
          ? (input.admissionIntent.expectedActiveTurnRequestId ?? input.requestId)
          : requiresExactAdmission || thread.session?.activeTurnRequestId === undefined
            ? input.requestId
            : thread.session.activeTurnRequestId,
      sessionIncarnationId: admittedSession.sessionIncarnationId!,
    };
  });

  const maybeGenerateAndRenameWorktreeBranchForFirstTurn = Effect.fn(
    "maybeGenerateAndRenameWorktreeBranchForFirstTurn",
  )(function* (input: {
    readonly threadId: ThreadId;
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
  }) {
    if (!input.branch || !input.worktreePath) {
      return;
    }
    if (!isTemporaryWorktreeBranch(input.branch)) {
      return;
    }

    const oldBranch = input.branch;
    const cwd = input.worktreePath;
    const attachments = input.attachments ?? [];
    yield* Effect.gen(function* () {
      const settings = yield* serverSettingsService.getSettings;
      const modelSelection =
        settings.sourceControlWriterModelSelection === null
          ? settings.textGenerationModelSelection
          : resolveSourceControlWriterModelSelection(
              settings,
              yield* providerRegistry.getProviders,
            );

      const generated = yield* textGeneration.generateBranchName({
        cwd,
        message: input.messageText,
        ...(attachments.length > 0 ? { attachments } : {}),
        modelSelection,
      });
      if (!generated) return;

      const targetBranch = buildGeneratedWorktreeBranchName(generated.branch);
      if (targetBranch === oldBranch) return;

      const renamed = yield* gitWorkflow.renameBranch({ cwd, oldBranch, newBranch: targetBranch });
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: yield* serverCommandId("worktree-branch-rename"),
        threadId: input.threadId,
        branch: renamed.branch,
        worktreePath: cwd,
      });
      yield* vcsStatusBroadcaster.refreshStatus(cwd).pipe(Effect.ignoreCause({ log: true }));
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider command reactor failed to generate or rename worktree branch", {
          threadId: input.threadId,
          cwd,
          oldBranch,
          cause: Cause.pretty(cause),
        }),
      ),
    );
  });

  const maybeGenerateThreadTitleForFirstTurn = Effect.fn("maybeGenerateThreadTitleForFirstTurn")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly cwd: string;
      readonly messageText: string;
      readonly attachments?: ReadonlyArray<ChatAttachment>;
      readonly titleSeed?: string;
    }) {
      const attachments = input.attachments ?? [];
      yield* Effect.gen(function* () {
        const { textGenerationModelSelection: modelSelection } =
          yield* serverSettingsService.getSettings;

        const generated = yield* textGeneration
          .generateThreadTitle({
            cwd: input.cwd,
            message: input.messageText,
            ...(attachments.length > 0 ? { attachments } : {}),
            modelSelection,
          })
          .pipe(
            Effect.retry({
              times: 2,
              schedule: Schedule.exponential("2 seconds"),
            }),
          );
        if (!generated) return;

        const thread = yield* resolveThread(input.threadId);
        if (!thread) return;
        if (!canReplaceThreadTitle(thread.title, input.titleSeed)) {
          return;
        }

        yield* orchestrationEngine.dispatch({
          type: "thread.meta.update",
          commandId: yield* serverCommandId("thread-title-rename"),
          threadId: input.threadId,
          title: generated.title,
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider command reactor failed to generate or rename thread title", {
            threadId: input.threadId,
            cwd: input.cwd,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    },
  );

  const regenerateThreadTitle = Effect.fn("regenerateThreadTitle")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.meta-updated" }>,
    requestId: CommandId,
  ) {
    if (event.payload.regenerateTitle !== true) {
      return { _tag: "Superseded" } as const;
    }

    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread || thread.titleRegeneration?.requestId !== requestId) {
      return { _tag: "Superseded" } as const;
    }

    const { message, attachments } = formatThreadTitleContext(thread.messages);
    if (message.length === 0) {
      return { _tag: "Completed", title: undefined } as const;
    }

    const previousTitle = event.payload.previousTitle ?? thread.title;
    if (thread.title !== previousTitle) {
      return { _tag: "Superseded" } as const;
    }
    const project = yield* resolveProject(thread.projectId);
    const cwd =
      resolveThreadWorkspaceCwd({
        thread,
        projects: project ? [project] : [],
      }) ?? process.cwd();
    const { textGenerationModelSelection: modelSelection } =
      yield* serverSettingsService.getSettings;
    const generated = yield* textGeneration.generateThreadTitle({
      cwd,
      message,
      previousTitle,
      ...(attachments.length > 0 ? { attachments } : {}),
      modelSelection,
    });
    if (generated.title === DEFAULT_THREAD_TITLE || generated.title === previousTitle) {
      return { _tag: "Completed", title: undefined } as const;
    }

    const latestThread = yield* resolveThread(event.payload.threadId);
    if (
      !latestThread ||
      latestThread.titleRegeneration?.requestId !== requestId ||
      latestThread.title !== previousTitle
    ) {
      return { _tag: "Superseded" } as const;
    }

    return { _tag: "Completed", title: generated.title } as const;
  });
  const dispatchThreadTitleRegenerationCompletion = Effect.fn(
    "dispatchThreadTitleRegenerationCompletion",
  )(function* (input: {
    readonly threadId: ThreadId;
    readonly requestId: CommandId;
    readonly title?: string;
  }) {
    yield* orchestrationEngine.dispatch({
      type: "thread.title.regeneration.complete",
      commandId: yield* serverCommandId("thread-title-regeneration-complete"),
      threadId: input.threadId,
      requestId: input.requestId,
      ...(input.title !== undefined ? { title: input.title } : {}),
    });
  });
  const findInterruptedThreadTitleRegenerations = Effect.fn(
    "findInterruptedThreadTitleRegenerations",
  )(function* () {
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    return readModel.threads.flatMap((thread) => {
      const requestId = thread.titleRegeneration?.requestId;
      return requestId === undefined ? [] : [{ threadId: thread.id, requestId }];
    });
  });
  const clearInterruptedThreadTitleRegenerations = Effect.fn(
    "clearInterruptedThreadTitleRegenerations",
  )(function* (
    interrupted: ReadonlyArray<{ readonly threadId: ThreadId; readonly requestId: CommandId }>,
  ) {
    yield* Effect.forEach(
      interrupted,
      ({ threadId, requestId }) => {
        return dispatchThreadTitleRegenerationCompletion({
          threadId,
          requestId,
        }).pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) {
              return Effect.interrupt;
            }
            return Effect.logWarning(
              "provider command reactor failed to clear interrupted title regeneration",
              {
                threadId,
                cause: Cause.pretty(cause),
              },
            );
          }),
        );
      },
      { discard: true },
    );
  });
  const processThreadTitleRegenerationSafely = Effect.fn("processThreadTitleRegenerationSafely")(
    function* (event: Extract<ProviderIntentEvent, { type: "thread.meta-updated" }>) {
      if (event.payload.regenerateTitle !== true) {
        return;
      }

      const requestId = event.payload.titleRegeneration?.requestId ?? event.commandId;
      if (requestId === null) {
        return;
      }
      const result = yield* regenerateThreadTitle(event, requestId).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }
          return Effect.logWarning("provider command reactor failed to regenerate thread title", {
            threadId: event.payload.threadId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as({ _tag: "Completed", title: undefined } as const));
        }),
      );
      if (result._tag === "Superseded") {
        return;
      }

      const completion = {
        threadId: event.payload.threadId,
        requestId,
        ...(result.title !== undefined ? { title: result.title } : {}),
      };
      yield* dispatchThreadTitleRegenerationCompletion(completion).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }
          return Effect.logWarning(
            "provider command reactor retrying title regeneration completion",
            {
              threadId: event.payload.threadId,
              cause: Cause.pretty(cause),
            },
          ).pipe(Effect.andThen(dispatchThreadTitleRegenerationCompletion(completion)));
        }),
      );
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }
          return Effect.logWarning(
            "provider command reactor failed to complete title regeneration",
            {
              threadId: event.payload.threadId,
              cause: Cause.pretty(cause),
            },
          );
        }),
      ),
  );
  const threadTitleRegenerationWorker = yield* makeDrainableWorker(
    processThreadTitleRegenerationSafely,
  );

  const processTurnStartRequested = Effect.fn("processTurnStartRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>,
  ) {
    const key = turnStartKeyForEvent(event);
    if (yield* hasHandledTurnStartRecently(key)) return;

    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) return;
    const message = thread.messages.find((entry) => entry.id === event.payload.messageId);
    if (!message || message.role !== "user") {
      yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.start.failed",
        summary: "Provider turn start failed",
        detail: `User message '${event.payload.messageId}' was not found for turn start request.`,
        turnId: null,
        createdAt: event.payload.createdAt,
      });
      return;
    }

    const requestId = event.commandId ?? CommandId.make(`event:${event.eventId}`);
    const admissionRequestedAt =
      event.payload.admissionRequestedAt ?? DateTime.formatIso(yield* DateTime.now);
    const admissionDeadlineAt =
      event.payload.admissionDeadlineAt ??
      DateTime.formatIso(
        DateTime.add(DateTime.makeUnsafe(admissionRequestedAt), {
          milliseconds: PROVIDER_TURN_ADMISSION_TIMEOUT_MS,
        }),
      );
    const admissionDeadlineMs = DateTime.toEpochMillis(DateTime.makeUnsafe(admissionDeadlineAt));
    const failAdmission = (detail: string) =>
      DateTime.now.pipe(
        Effect.flatMap((failedAt) =>
          failTurnAdmissionIfPending({
            threadId: event.payload.threadId,
            requestId,
            messageId: event.payload.messageId,
            detail,
            createdAt: DateTime.formatIso(failedAt),
          }),
        ),
      );
    const handleTurnStartFailure = (cause: Cause.Cause<unknown>) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.succeed(false)
        : failAdmission(formatFailureDetail(cause)).pipe(
            Effect.catchCause((recoveryCause) =>
              Effect.logWarning("provider command reactor failed to recover turn start failure", {
                eventType: event.type,
                threadId: event.payload.threadId,
                cause: Cause.pretty(recoveryCause),
                originalCause: Cause.pretty(cause),
              }).pipe(Effect.as(false)),
            ),
          );

    if ((yield* Clock.currentTimeMillis) >= admissionDeadlineMs) {
      yield* failAdmission(PROVIDER_TURN_ADMISSION_TIMEOUT_DETAIL);
      return;
    }

    // Subscribe before provider admission starts. Only the persisted exact
    // admission CAS disarms the watchdog; observing a raw provider start is not
    // sufficient because ingestion or projection can still reject it.
    const signalSubscriptionReady = yield* Deferred.make<void>();
    const startedSignal = Stream.runHead(
      orchestrationEngine.streamDomainEvents.pipe(
        Stream.onStart(Deferred.succeed(signalSubscriptionReady, undefined)),
        Stream.filter(
          (domainEvent) =>
            domainEvent.type === "thread.session-set" &&
            domainEvent.payload.threadId === event.payload.threadId &&
            domainEvent.payload.session.status === "running" &&
            domainEvent.payload.session.activeTurnRequestId === requestId,
        ),
      ),
    ).pipe(
      Effect.flatMap((started) =>
        Option.isSome(started) ? Effect.succeed({ _tag: "Started" as const }) : Effect.never,
      ),
    );
    const startedSignalFiber = yield* startedSignal.pipe(Effect.forkScoped);
    yield* Deferred.await(signalSubscriptionReady);

    const watchdog = yield* Effect.gen(function* () {
      const remainingMs = Math.max(0, admissionDeadlineMs - (yield* Clock.currentTimeMillis));
      if (remainingMs > 0) yield* Effect.sleep(Duration.millis(remainingMs));
      const applied = yield* failAdmission(PROVIDER_TURN_ADMISSION_TIMEOUT_DETAIL);
      return { _tag: "Deadline" as const, applied };
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.never
          : Effect.logWarning("provider turn admission watchdog failed", {
              threadId: event.payload.threadId,
              requestId,
              cause: Cause.pretty(cause),
            }).pipe(Effect.andThen(Effect.never)),
      ),
      Effect.forkScoped,
    );

    const admissionStopToken = admissionStopTokenForRequest(requestId);
    const admissionEffect = Effect.gen(function* () {
      yield* ensureThreadWorktree(thread);
      const isFirstUserMessageTurn =
        thread.messages.filter((entry) => entry.role === "user").length === 1;
      if (isFirstUserMessageTurn) {
        const project = yield* resolveProject(thread.projectId);
        const generationCwd =
          resolveThreadWorkspaceCwd({
            thread,
            projects: project ? [project] : [],
          }) ?? process.cwd();
        const generationInput = {
          messageText: assistantCitationsToPlainText(message.text),
          ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
          ...(event.payload.titleSeed !== undefined ? { titleSeed: event.payload.titleSeed } : {}),
        };
        yield* maybeGenerateAndRenameWorktreeBranchForFirstTurn({
          threadId: event.payload.threadId,
          branch: thread.branch,
          worktreePath: thread.worktreePath,
          ...generationInput,
        }).pipe(Effect.forkScoped);
        if (canReplaceThreadTitle(thread.title, event.payload.titleSeed)) {
          yield* maybeGenerateThreadTitleForFirstTurn({
            threadId: event.payload.threadId,
            cwd: generationCwd,
            ...generationInput,
          }).pipe(Effect.forkScoped);
        }
      }
      const sendTurnRequest = yield* buildSendTurnRequestForThread({
        threadId: event.payload.threadId,
        messageText: assistantCitationsToPlainText(message.text),
        ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
        ...(event.payload.modelSelection !== undefined
          ? { modelSelection: event.payload.modelSelection }
          : {}),
        runtimeMode: event.payload.runtimeMode,
        interactionMode: event.payload.interactionMode,
        requestId,
        messageId: event.payload.messageId,
        ...(event.payload.admissionIntent === undefined
          ? {}
          : { admissionIntent: event.payload.admissionIntent }),
        admissionRequestedAt,
        admissionDeadlineAt,
        createdAt: event.payload.createdAt,
      });
      if (admissionStopTokens.get(requestId) !== admissionStopToken) {
        return yield* Effect.interrupt;
      }
      return yield* providerService.sendTurn(sendTurnRequest);
    });
    // Event handlers detach provider work so Stop can invalidate a slow start
    // immediately. The keyed permit still preserves accepted event order for
    // the same thread: an earlier steer reaches the provider before a later
    // settings transition starts.
    const orderedAdmissionEffect = admissionPermitForThread(event.payload.threadId).withPermit(
      admissionEffect,
    );
    const admissionFiber = yield* orderedAdmissionEffect.pipe(Effect.forkDetach);
    admissionFibers.set(requestId, admissionFiber);
    admissionFiberThreads.set(requestId, event.payload.threadId);
    yield* Fiber.await(admissionFiber).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (admissionFibers.get(requestId) === admissionFiber) {
            admissionFibers.delete(requestId);
            admissionFiberThreads.delete(requestId);
            admissionStopTokens.delete(requestId);
            releaseAdmissionLaneIfIdle(event.payload.threadId);
          }
        }),
      ),
      // The admission is detached from the reactor scope. Its registry observer
      // must be detached too, or scope shutdown removes the entry before the
      // finalizer can interrupt and join the still-running admission.
      Effect.forkDetach,
    );

    const superviseAdmission = Effect.gen(function* () {
      if (
        event.payload.admissionIntent?.kind === "steer" ||
        (event.payload.admissionIntent === undefined && thread.session?.status === "running")
      ) {
        const steeringExit = yield* Fiber.await(admissionFiber);
        yield* Fiber.interrupt(watchdog);
        if (Exit.isFailure(steeringExit) && !Cause.hasInterruptsOnly(steeringExit.cause)) {
          yield* appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.turn.start.failed",
            summary: "Provider turn start failed",
            detail: formatFailureDetail(steeringExit.cause),
            turnId: thread.session?.activeTurnId ?? null,
            createdAt: yield* nowIso,
            requestId,
          });
        }
        return;
      }
      const admissionFailure = Fiber.await(admissionFiber).pipe(
        Effect.flatMap((exit) =>
          Exit.isFailure(exit)
            ? handleTurnStartFailure(exit.cause).pipe(
                Effect.as({ _tag: "AdmissionFailed" as const }),
              )
            : Effect.never,
        ),
      );
      const outcome = yield* Effect.race(
        Effect.race(Fiber.join(startedSignalFiber), Fiber.join(watchdog)),
        admissionFailure,
      );

      if (
        outcome._tag === "Started" ||
        outcome._tag === "AdmissionFailed" ||
        (outcome._tag === "Deadline" && !outcome.applied)
      ) {
        yield* Fiber.interrupt(watchdog);
        return;
      }

      // Interrupt only when this exact request won the conditional timeout.
      // A CAS-lost or superseded deadline must not cancel newer adapter work.
      // The interrupt request is detached because a provider finalizer may hang;
      // only joining the retained fiber is bounded.
      yield* Fiber.interrupt(admissionFiber).pipe(Effect.forkDetach);
      const interrupted = yield* Fiber.join(admissionFiber).pipe(
        Effect.exit,
        Effect.timeoutOption(Duration.seconds(1)),
      );
      if (Option.isNone(interrupted)) {
        yield* Effect.logWarning("provider turn admission did not release after interruption", {
          threadId: event.payload.threadId,
          requestId,
        });
      }
    }).pipe(
      Effect.ensuring(Fiber.interrupt(startedSignalFiber)),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logWarning("provider turn admission supervisor failed", {
              threadId: event.payload.threadId,
              requestId,
              cause: Cause.pretty(cause),
            }),
      ),
    );
    yield* superviseAdmission.pipe(Effect.forkScoped);
  });

  const processInputQueueFollowUpRequested = Effect.fn("processInputQueueFollowUpRequested")(
    function* (
      event: Extract<ProviderIntentEvent, { type: "thread.input-queue-follow-up-requested" }>,
    ) {
      const thread = yield* resolveThread(event.payload.threadId);
      const message = thread?.messages.find((entry) => entry.id === event.payload.messageId);
      if (!thread || !message || message.role !== "user") {
        return yield* appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.input-queue.follow-up.failed",
          summary: "Follow-up was not queued",
          detail: "The follow-up message could not be resolved.",
          turnId: thread?.latestTurn?.turnId ?? null,
          createdAt: event.payload.createdAt,
        });
      }
      const result = yield* providerService
        .followUp({
          threadId: event.payload.threadId,
          ...providerFollowUpInputFromMessage(message),
        })
        .pipe(Effect.exit);
      if (Exit.isSuccess(result)) return;
      yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.input-queue.follow-up.failed",
        summary: "Follow-up was not queued",
        detail: formatFailureDetail(result.cause),
        turnId: thread.latestTurn?.turnId ?? null,
        createdAt: event.payload.createdAt,
      });
    },
  );

  const processTurnInterruptRequested = Effect.fn("processTurnInterruptRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-interrupt-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const session = thread.session;
    if (!session || session.status === "stopped") {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.interrupt.failed",
        summary: "Provider turn interrupt failed",
        detail: "No active provider session is bound to this thread.",
        turnId: event.payload.turnId ?? null,
        createdAt: event.payload.createdAt,
      });
    }

    const recoverInterruptFailure = (cause: Cause.Cause<unknown>) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.interrupt;
      }

      const detail = formatFailureDetail(cause);
      return Effect.gen(function* () {
        const latestThread = yield* resolveThread(event.payload.threadId);
        const latestSession = latestThread?.session;
        if (
          !latestSession ||
          latestSession.status === "stopped" ||
          latestSession.status === "ready" ||
          (event.payload.turnId !== undefined &&
            latestSession.activeTurnId !== null &&
            latestSession.activeTurnId !== event.payload.turnId)
        ) {
          return;
        }

        yield* providerService.stopSession({ threadId: event.payload.threadId }).pipe(
          Effect.catchCause((stopCause) => {
            if (Cause.hasInterruptsOnly(stopCause)) {
              return Effect.interrupt;
            }
            return Effect.logWarning(
              "provider command reactor failed to stop session after interrupt failure",
              {
                threadId: event.payload.threadId,
                cause: Cause.pretty(stopCause),
                originalCause: Cause.pretty(cause),
              },
            );
          }),
        );
        const stoppedThread = yield* resolveThread(event.payload.threadId);
        const stoppedSession = stoppedThread?.session;
        if (
          !stoppedSession ||
          stoppedSession.status === "stopped" ||
          stoppedSession.status === "ready" ||
          (event.payload.turnId !== undefined &&
            stoppedSession.activeTurnId !== null &&
            stoppedSession.activeTurnId !== event.payload.turnId)
        ) {
          return;
        }

        yield* applyThreadSessionLifecycle({
          threadId: event.payload.threadId,
          expectedSession: stoppedSession,
          session: {
            ...stoppedSession,
            status: "stopped",
            activeTurnId: null,
            lastError: detail,
            updatedAt: event.payload.createdAt,
          },
          createdAt: event.payload.createdAt,
        });
        yield* appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.turn.interrupt.failed",
          summary: "Provider turn interrupt failed",
          detail,
          turnId: event.payload.turnId ?? null,
          createdAt: event.payload.createdAt,
        });
      });
    };

    // Orchestration turn ids are not provider turn ids, so interrupt by session.
    yield* providerService
      .interruptTurn({ threadId: event.payload.threadId })
      .pipe(Effect.catchCause(recoverInterruptFailure));
  });

  const processApprovalResponseRequested = Effect.fn("processApprovalResponseRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.approval-response-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const hasSession = thread.session && thread.session.status !== "stopped";
    if (!hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        detail: "No active provider session is bound to this thread.",
        turnId: null,
        createdAt: event.payload.createdAt,
        requestId: event.payload.requestId,
      });
    }

    yield* providerService
      .respondToRequest({
        threadId: event.payload.threadId,
        requestId: event.payload.requestId,
        decision: event.payload.decision,
      })
      .pipe(
        Effect.catchCause((cause) =>
          appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.approval.respond.failed",
            summary: "Provider approval response failed",
            detail: isUnknownPendingApprovalRequestError(cause)
              ? stalePendingRequestDetail("approval", event.payload.requestId)
              : Cause.pretty(cause),
            turnId: null,
            createdAt: event.payload.createdAt,
            requestId: event.payload.requestId,
          }),
        ),
      );
  });

  const processUserInputResponseRequested = Effect.fn("processUserInputResponseRequested")(
    function* (
      event: Extract<ProviderIntentEvent, { type: "thread.user-input-response-requested" }>,
    ) {
      const thread = yield* resolveThread(event.payload.threadId);
      if (!thread) {
        return;
      }
      const hasSession = thread.session && thread.session.status !== "stopped";
      if (!hasSession) {
        return yield* appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.user-input.respond.failed",
          summary: "Provider user input response failed",
          detail: "No active provider session is bound to this thread.",
          turnId: null,
          createdAt: event.payload.createdAt,
          requestId: event.payload.requestId,
        });
      }

      yield* providerService
        .respondToUserInput({
          threadId: event.payload.threadId,
          requestId: event.payload.requestId,
          answers: event.payload.answers,
        })
        .pipe(
          Effect.catchCause((cause) =>
            appendProviderFailureActivity({
              threadId: event.payload.threadId,
              kind: "provider.user-input.respond.failed",
              summary: "Provider user input response failed",
              detail: isUnknownPendingUserInputRequestError(cause)
                ? stalePendingRequestDetail("user-input", event.payload.requestId)
                : Cause.pretty(cause),
              turnId: null,
              createdAt: event.payload.createdAt,
              requestId: event.payload.requestId,
            }),
          ),
        );
    },
  );

  type PendingSessionStopTarget = {
    readonly threadId: ThreadId;
    readonly stopRequestId: CommandId;
    readonly providerInstanceId: ProviderInstanceId | null;
    readonly sessionIncarnationId: NonNullable<OrchestrationSession["sessionIncarnationId"]> | null;
    readonly turnRequestId: CommandId | null;
    readonly turnId: TurnId | null;
    readonly createdAt: string;
  };

  const sessionRequestId = (session: OrchestrationSession | null | undefined) =>
    session?.pendingTurnRequestId ??
    session?.activeTurnRequestId ??
    session?.failedTurnRequestId ??
    null;

  const pendingStopTargetIsCurrent = (
    session: OrchestrationSession | null | undefined,
    target: PendingSessionStopTarget,
  ) =>
    session?.pendingStopRequestId === target.stopRequestId &&
    (session.pendingStopProviderInstanceId ?? null) === target.providerInstanceId &&
    (session.pendingStopSessionIncarnationId ?? null) === target.sessionIncarnationId &&
    (session.pendingStopTurnRequestId ?? null) === target.turnRequestId &&
    (session.pendingStopTurnId ?? null) === target.turnId;

  const clearPendingSessionStop = Effect.fn("clearPendingSessionStop")(function* (
    target: PendingSessionStopTarget,
  ) {
    const latestThread = yield* resolveThread(target.threadId);
    const latestSession = latestThread?.session;
    if (!latestThread || !latestSession || !pendingStopTargetIsCurrent(latestSession, target)) {
      return;
    }
    const targetStillOwnsProjectedSession =
      latestSession.status === "stopped" &&
      (latestSession.providerInstanceId ?? null) === target.providerInstanceId &&
      (latestSession.sessionIncarnationId ?? null) === target.sessionIncarnationId &&
      sessionRequestId(latestSession) === target.turnRequestId;
    const clearedAt =
      latestSession.updatedAt > target.createdAt ? latestSession.updatedAt : target.createdAt;
    yield* applyThreadSessionLifecycle({
      threadId: target.threadId,
      expectedSession: latestSession,
      allowFailedTurnRequestClear: true,
      session: {
        ...latestSession,
        ...(targetStillOwnsProjectedSession
          ? {
              pendingTurnRequestId: undefined,
              pendingTurnMessageId: undefined,
              pendingTurnRequestedAt: undefined,
              pendingTurnDeadlineAt: undefined,
              pendingTurnSessionId: undefined,
              activeTurnRequestId: undefined,
              failedTurnRequestId: undefined,
              activeTurnId: null,
            }
          : {}),
        pendingStopRequestId: undefined,
        pendingStopProviderInstanceId: undefined,
        pendingStopSessionIncarnationId: undefined,
        pendingStopTurnRequestId: undefined,
        pendingStopTurnId: undefined,
        updatedAt: clearedAt,
      },
      createdAt: clearedAt,
    });
  });

  const stopPendingSessionTarget = Effect.fn("stopPendingSessionTarget")(function* (
    target: PendingSessionStopTarget,
  ) {
    const currentThread = yield* resolveThread(target.threadId);
    const currentSession = currentThread?.session;
    // A later Start can coexist with the old target. Never invalidate that new
    // reservation; the exact provider identity below still cleans only the old
    // runtime. A still-projected stopped target owns the original reservation.
    const invalidateStartReservation =
      currentSession?.status === "stopped" && pendingStopTargetIsCurrent(currentSession, target);
    yield* providerService.stopSession({
      threadId: target.threadId,
      expectedProviderInstanceId: target.providerInstanceId,
      expectedSessionIncarnationId: target.sessionIncarnationId,
      expectedAdmissionRequestId: target.turnRequestId,
      invalidateStartReservation,
    });
    yield* clearPendingSessionStop(target);
    releaseAdmissionLaneIfIdle(target.threadId);
  });

  const processSessionStopRequested = Effect.fn("processSessionStopRequested")(
    function* (event: Extract<ProviderIntentEvent, { type: "thread.session-stop-requested" }>) {
      const targetRequestId = event.payload.targetTurnRequestId ?? null;
      // Invalidate only the admission captured by the persisted stop intent.
      // A later Start has a different globally unique request id and token.
      if (targetRequestId !== null && admissionStopTokens.has(targetRequestId)) {
        admissionStopTokens.set(targetRequestId, makeAdmissionStopToken());
      }
      if (targetRequestId !== null) {
        const targetFiber = admissionFibers.get(targetRequestId);
        if (
          targetFiber !== undefined &&
          admissionFiberThreads.get(targetRequestId) === event.payload.threadId
        ) {
          targetFiber.interruptUnsafe();
        }
      }
      if (event.commandId === null) {
        // Legacy stop events have no durable pending-stop marker. Keep their
        // prior exact-stop behavior, but never manufacture a cleanup target.
        yield* providerService.stopSession({
          threadId: event.payload.threadId,
          ...(event.payload.targetProviderInstanceId !== undefined ||
          event.payload.targetSessionIncarnationId !== undefined ||
          event.payload.targetTurnRequestId !== undefined
            ? {
                expectedProviderInstanceId: event.payload.targetProviderInstanceId ?? null,
                expectedSessionIncarnationId: event.payload.targetSessionIncarnationId ?? null,
                expectedAdmissionRequestId: targetRequestId,
              }
            : {}),
        });
        return;
      }
      yield* stopPendingSessionTarget({
        threadId: event.payload.threadId,
        stopRequestId: event.commandId,
        providerInstanceId: event.payload.targetProviderInstanceId ?? null,
        sessionIncarnationId: event.payload.targetSessionIncarnationId ?? null,
        turnRequestId: targetRequestId,
        turnId: event.payload.targetTurnId ?? null,
        createdAt: event.payload.createdAt,
      });
    },
    (effect, event) =>
      effect.pipe(
        Effect.ensuring(Effect.sync(() => releaseAdmissionLaneIfIdle(event.payload.threadId))),
      ),
  );

  const processDomainEvent = Effect.fn("processDomainEvent")(function* (
    event: ProviderIntentEvent,
  ) {
    yield* Effect.annotateCurrentSpan({
      "orchestration.event_type": event.type,
      "orchestration.thread_id": event.payload.threadId,
      ...(event.commandId ? { "orchestration.command_id": event.commandId } : {}),
    });
    yield* increment(orchestrationEventsProcessedTotal, {
      eventType: event.type,
    });
    switch (event.type) {
      case "thread.meta-updated":
        yield* threadTitleRegenerationWorker.enqueue(event);
        return;
      case "thread.runtime-mode-set": {
        const thread = yield* resolveThread(event.payload.threadId);
        if (!thread?.session || thread.session.status === "stopped") {
          return;
        }
        // The persisted mode applies on the next session ensure. Replacing a
        // starting session here would erase its exact pending-admission CAS.
        if (thread.session.status === "starting") {
          return;
        }
        const cachedModelSelection = threadModelSelections.get(event.payload.threadId);
        yield* ensureSessionForThread(
          event.payload.threadId,
          event.occurredAt,
          cachedModelSelection !== undefined ? { modelSelection: cachedModelSelection } : {},
        );
        return;
      }
      case "thread.turn-start-requested":
        yield* processTurnStartRequested(event);
        return;
      case "thread.input-queue-follow-up-requested":
        yield* processInputQueueFollowUpRequested(event);
        return;
      case "thread.turn-interrupt-requested":
        yield* processTurnInterruptRequested(event);
        return;
      case "thread.approval-response-requested":
        yield* processApprovalResponseRequested(event);
        return;
      case "thread.user-input-response-requested":
        yield* processUserInputResponseRequested(event);
        return;
      case "thread.session-stop-requested":
        yield* processSessionStopRequested(event);
        return;
      case "thread.settled": {
        const thread = yield* projectionSnapshotQuery.getThreadShellById(event.payload.threadId);
        if (
          Option.isNone(thread) ||
          thread.value.session == null ||
          thread.value.session.status === "stopped"
        ) {
          return;
        }
        yield* orchestrationEngine.dispatch({
          type: "thread.session.stop",
          commandId: CommandId.make(`session-stop-for-settle:${event.commandId ?? event.eventId}`),
          threadId: event.payload.threadId,
          createdAt: event.occurredAt,
          onlyIfSettled: true,
        });
        return;
      }
    }
  });

  const reconcilePendingSessionStops = Effect.fn("reconcilePendingSessionStops")(function* () {
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    const pendingTargets = readModel.threads.flatMap((thread) => {
      const session = thread.session;
      if (session?.pendingStopRequestId === undefined) return [];
      return [
        {
          threadId: thread.id,
          stopRequestId: session.pendingStopRequestId,
          providerInstanceId: session.pendingStopProviderInstanceId ?? null,
          sessionIncarnationId: session.pendingStopSessionIncarnationId ?? null,
          turnRequestId: session.pendingStopTurnRequestId ?? null,
          turnId: session.pendingStopTurnId ?? null,
          createdAt: session.updatedAt,
        } satisfies PendingSessionStopTarget,
      ];
    });
    yield* Effect.forEach(pendingTargets, stopPendingSessionTarget, {
      concurrency: PROVIDER_TURN_RECONCILIATION_CONCURRENCY,
      discard: true,
    });
  });

  const reconcileOverdueTurnAdmissions = Effect.fn("reconcileOverdueTurnAdmissions")(function* () {
    const pendingAdmissions = yield* (
      projectionSnapshotQuery.listPendingTurnAdmissions?.() ?? Effect.succeed([])
    );
    if (pendingAdmissions.length === 0) return;

    type PendingAdmission = (typeof pendingAdmissions)[number];
    type AdmissionInventory =
      | { readonly _tag: "Known"; readonly sessions: ReadonlyArray<ProviderSession> }
      | { readonly _tag: "Unknown"; readonly detail: string };

    const boundedInventory = <E, R>(
      effect: Effect.Effect<ReadonlyArray<ProviderSession>, E, R>,
    ): Effect.Effect<AdmissionInventory, never, R> =>
      effect.pipe(
        // Each native inventory attempt gets its own deadline. The outer bound
        // also covers the complete retry chain, so a provider that returns
        // Effect.never cannot pin startup reconciliation indefinitely.
        Effect.timeout(Duration.millis(PROVIDER_TURN_INVENTORY_ATTEMPT_TIMEOUT_MS)),
        Effect.retry({ times: 2 }),
        Effect.timeout(Duration.millis(PROVIDER_TURN_INVENTORY_RETRY_TIMEOUT_MS)),
        Effect.exit,
        Effect.map((inventory) =>
          Exit.isSuccess(inventory)
            ? ({ _tag: "Known", sessions: inventory.value } as const)
            : ({ _tag: "Unknown", detail: Cause.pretty(inventory.cause) } as const),
        ),
      );

    const processPendingAdmission = Effect.fnUntraced(function* (
      pending: PendingAdmission,
      inventory: AdmissionInventory,
    ) {
      const deadlineMs = DateTime.toEpochMillis(DateTime.makeUnsafe(pending.deadlineAt));
      const remainingMs = Math.max(0, deadlineMs - (yield* Clock.currentTimeMillis));
      const failAtDeadline = (detail: string) => {
        const fail = DateTime.now.pipe(
          Effect.flatMap((failedAt) =>
            failTurnAdmissionIfPending({
              threadId: pending.threadId,
              requestId: pending.requestId,
              messageId: pending.messageId,
              detail,
              createdAt: DateTime.formatIso(failedAt),
            }),
          ),
          Effect.asVoid,
        );
        return remainingMs === 0
          ? fail
          : forkParked(Effect.sleep(Duration.millis(remainingMs)).pipe(Effect.andThen(fail)));
      };

      if (inventory._tag === "Unknown") {
        // Unknown inventory is never evidence of absence. Preserve the original
        // admission window so a late exact lifecycle event can still settle it.
        yield* failAtDeadline(
          `Provider turn admission reconciliation could not inventory its provider session: ${inventory.detail}`,
        );
        return;
      }

      const liveSession = inventory.sessions.find(
        (session) => session.threadId === pending.threadId,
      );
      const exactRunningSession =
        liveSession?.status === "running" &&
        liveSession.activeTurnRequestId === pending.requestId &&
        liveSession.activeTurnId !== undefined &&
        pending.sessionIncarnationId !== null &&
        liveSession.sessionIncarnationId === pending.sessionIncarnationId &&
        pending.providerInstanceId !== null &&
        liveSession.providerInstanceId === pending.providerInstanceId;
      if (exactRunningSession) {
        yield* acceptTurnAdmissionIfPending({
          threadId: pending.threadId,
          requestId: pending.requestId,
          messageId: pending.messageId,
          providerInstanceId: pending.providerInstanceId!,
          sessionIncarnationId: pending.sessionIncarnationId!,
          turnId: liveSession.activeTurnId!,
          createdAt: yield* nowIso,
        });
        return;
      }

      yield* failAtDeadline(PROVIDER_TURN_ADMISSION_TIMEOUT_DETAIL);
    });

    const byInstance = new Map<ProviderInstanceId | null, Array<PendingAdmission>>();
    for (const pending of pendingAdmissions) {
      const grouped = byInstance.get(pending.providerInstanceId) ?? [];
      grouped.push(pending);
      byInstance.set(pending.providerInstanceId, grouped);
    }

    // Inventory and restore watchdogs per instance. A blocked provider uses
    // only its own bounded lane and cannot delay healthy instances.
    yield* Effect.forEach(
      byInstance,
      ([instanceId, pendingForInstance]) =>
        Effect.gen(function* () {
          const inventory: AdmissionInventory =
            instanceId === null
              ? {
                  _tag: "Unknown",
                  detail: "Pending admission has no provider instance id.",
                }
              : providerService.listSessionsForInstance !== undefined
                ? yield* boundedInventory(
                    Effect.suspend(() => providerService.listSessionsForInstance!(instanceId)),
                  )
                : yield* boundedInventory(
                    Effect.suspend(() => providerService.listSessions()).pipe(
                      Effect.map((sessions) =>
                        sessions.filter((session) => session.providerInstanceId === instanceId),
                      ),
                    ),
                  );
          yield* Effect.forEach(
            pendingForInstance,
            (pending) => processPendingAdmission(pending, inventory),
            { concurrency: PROVIDER_TURN_RECONCILIATION_CONCURRENCY, discard: true },
          );
        }),
      { concurrency: PROVIDER_TURN_RECONCILIATION_CONCURRENCY, discard: true },
    );
  });

  const processDomainEventSafely = (event: ProviderIntentEvent) =>
    processDomainEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logWarning("provider command reactor failed to process event", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processDomainEventSafely);

  const start: ProviderCommandReactorShape["start"] = Effect.fn("start")(function* () {
    const interruptedTitleRegenerations = yield* findInterruptedThreadTitleRegenerations().pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logWarning(
          "provider command reactor failed to find interrupted title regenerations",
          { cause: Cause.pretty(cause) },
        ).pipe(Effect.as([]));
      }),
    );
    const processEvent = Effect.fn("processEvent")(function* (event: OrchestrationEvent) {
      if (
        (event.type === "thread.meta-updated" && event.payload.regenerateTitle === true) ||
        event.type === "thread.runtime-mode-set" ||
        event.type === "thread.turn-start-requested" ||
        event.type === "thread.input-queue-follow-up-requested" ||
        event.type === "thread.turn-interrupt-requested" ||
        event.type === "thread.approval-response-requested" ||
        event.type === "thread.user-input-response-requested" ||
        event.type === "thread.session-stop-requested" ||
        event.type === "thread.settled"
      ) {
        return yield* worker.enqueue(event);
      }
    });

    yield* forkParked(Stream.runForEach(orchestrationEngine.streamDomainEvents, processEvent));

    // The domain event stream is hot, so work pending before this reactor
    // starts cannot be resumed. Correlated completions only clear the request
    // captured here, leaving any newer request untouched.
    const clearInterrupted = clearInterruptedThreadTitleRegenerations(
      interruptedTitleRegenerations,
    ).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logWarning(
          "provider command reactor failed to clear interrupted title regenerations",
          {
            cause: Cause.pretty(cause),
          },
        );
      }),
    );
    const reconcileStopsThenAdmissions = reconcilePendingSessionStops().pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
        return Effect.logWarning(
          "provider command reactor failed to reconcile pending session stops",
          { cause: Cause.pretty(cause) },
        );
      }),
      Effect.andThen(
        reconcileOverdueTurnAdmissions().pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
            return Effect.logWarning(
              "provider command reactor failed to reconcile overdue turn admissions",
              { cause: Cause.pretty(cause) },
            );
          }),
        ),
      ),
    );
    const activation = yield* ServerActivation;
    if (activation === undefined) {
      yield* clearInterrupted;
      yield* reconcileStopsThenAdmissions;
    } else {
      yield* forkParked(clearInterrupted);
      yield* forkParked(reconcileStopsThenAdmissions);
    }
  });

  return {
    start,
    drain: Effect.gen(function* () {
      yield* worker.drain;
      yield* threadTitleRegenerationWorker.drain;
    }),
    getAdmissionTrackingCounts: () => ({
      fibers: admissionFibers.size,
      fiberThreads: admissionFiberThreads.size,
      stopTokens: admissionStopTokens.size,
      permits: admissionPermits.size,
    }),
  } satisfies ProviderCommandReactorShape;
});

export const ProviderCommandReactorLive = Layer.effect(ProviderCommandReactor, make);
