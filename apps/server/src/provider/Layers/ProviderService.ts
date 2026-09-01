import * as NodeCrypto from "node:crypto";

/**
 * ProviderServiceLive - Cross-provider orchestration layer.
 *
 * Routes validated transport/API calls to provider adapters through
 * `ProviderAdapterRegistry` and `ProviderSessionDirectory`, and exposes a
 * unified provider event stream for subscribers.
 *
 * It does not implement provider protocol details (adapter concern).
 *
 * @module ProviderServiceLive
 */
import {
  CommandId,
  ModelSelection,
  NonNegativeInt,
  PROVIDER_SESSION_AGENT_DEPTH_MAX_SETTABLE,
  RuntimeSessionId,
  ThreadId,
  ProviderAbortSessionCompactionInput,
  ProviderAskSessionSideQuestionInput,
  ProviderCancelSessionAgentInput,
  ProviderCancelSessionSideQuestionInput,
  ProviderClearSessionInputQueueInput,
  ProviderCompactSessionInput,
  ProviderFollowUpInput,
  ProviderMessageSessionAgentInput,
  ProviderWatchSessionAgentActivityInput,
  PROVIDER_SESSION_AGENT_MESSAGE_MAX_CHARS,
  ProviderGetSessionAgentDepthInput,
  ProviderGetSessionCompactionInput,
  ProviderGetSessionInputQueueInput,
  ProviderInterruptTurnInput,
  ProviderRemoveOnlySessionInputQueueItemInput,
  ProviderReloadSessionResourcesInput,
  ProviderRefineSessionHarnessInput,
  ProviderSetSessionAgentDepthInput,
  ProviderSetSessionAutoCompactionInput,
  ProviderSetSessionInputQueueModeInput,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderRespondToInteractionInput,
  ProviderSendTurnInput,
  ProviderSessionStartInput,
  ProviderStopSessionInput,
  ProviderUploadFeedbackInput,
  type ProviderInstanceId,
  type ProviderDriverKind,
  type ProviderRuntimeEvent,
  type ProviderSession,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SchemaIssue from "effect/SchemaIssue";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import * as ServerConfig from "../../config.ts";
import {
  increment,
  providerMetricAttributes,
  providerRuntimeEventsTotal,
  providerSessionsTotal,
  providerTurnDuration,
  providerTurnsTotal,
  providerTurnMetricAttributes,
  withMetrics,
} from "../../observability/Metrics.ts";
import {
  ProviderAdapterRequestError,
  type ProviderAdapterError,
  ProviderUnsupportedError,
  ProviderValidationError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../Services/ProviderAdapterRegistry.ts";
import * as ProviderService from "../Services/ProviderService.ts";
import * as ProviderSessionDirectory from "../Services/ProviderSessionDirectory.ts";
import { type EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import * as ProviderEventLoggers from "./ProviderEventLoggers.ts";
import * as AnalyticsService from "../../telemetry/AnalyticsService.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
const isModelSelection = Schema.is(ModelSelection);

/**
 * Hook for tests that want to override the canonical event logger pulled
 * from `ProviderEventLoggers`. Production wiring leaves this undefined and
 * reads the logger off the tag.
 */
export interface ProviderServiceLiveOptions {
  readonly canonicalEventLogger?: EventNdjsonLogger;
  /**
   * Overrides MCP credential issuance. The real issuer reads a module-global
   * registry that only a running MCP server installs, which makes the
   * agent-browser-access gate unobservable from a unit test; this seam lets a
   * test see whether a credential was requested at all.
   */
  readonly issueMcpCredential?: typeof McpSessionRegistry.issueActiveMcpCredential;
  /** Same seam as `issueMcpCredential`, for observing session credential revocation. */
  readonly revokeMcpCredential?: typeof McpSessionRegistry.revokeActiveMcpThread;
  /** Test-only observation seam for proving idle reservation lanes are reclaimed. */
  readonly onStartReservationCountChange?: (count: number) => void;
}

type ProviderServiceMethod<Name extends keyof ProviderService.ProviderService["Service"]> =
  ProviderService.ProviderService["Service"][Name];

const ProviderRollbackConversationInput = Schema.Struct({
  threadId: ThreadId,
  numTurns: NonNegativeInt,
});

function toValidationError(
  operation: string,
  issue: string,
  cause?: unknown,
): ProviderValidationError {
  return new ProviderValidationError({
    operation,
    issue,
    ...(cause !== undefined ? { cause } : {}),
  });
}

const decodeInputOrValidationError = <S extends Schema.Top>(input: {
  readonly operation: string;
  readonly schema: S;
  readonly payload: unknown;
}) => {
  const decodeProviderRequestInput = Schema.decodeUnknownEffect(input.schema);
  return decodeProviderRequestInput(input.payload).pipe(
    Effect.mapError(
      (schemaError) =>
        new ProviderValidationError({
          operation: input.operation,
          issue: SchemaIssue.makeFormatterDefault()(schemaError.issue),
          cause: schemaError,
        }),
    ),
  );
};

function toRuntimeStatus(session: ProviderSession): "starting" | "running" | "stopped" | "error" {
  switch (session.status) {
    case "connecting":
      return "starting";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    case "running":
    default:
      return "running";
  }
}

function toRuntimePayloadFromSession(
  session: ProviderSession,
  extra?: {
    readonly modelSelection?: unknown;
    readonly lastRuntimeEvent?: string;
    readonly lastRuntimeEventAt?: string;
  },
): Record<string, unknown> {
  return {
    cwd: session.cwd ?? null,
    model: session.model ?? null,
    activeTurnId: session.activeTurnId ?? null,
    sessionIncarnationId: session.sessionIncarnationId ?? null,
    lastError: session.lastError ?? null,
    ...(extra?.modelSelection !== undefined ? { modelSelection: extra.modelSelection } : {}),
    ...(extra?.lastRuntimeEvent !== undefined ? { lastRuntimeEvent: extra.lastRuntimeEvent } : {}),
    ...(extra?.lastRuntimeEventAt !== undefined
      ? { lastRuntimeEventAt: extra.lastRuntimeEventAt }
      : {}),
  };
}

function readPersistedModelSelection(
  runtimePayload: ProviderSessionDirectory.ProviderRuntimeBinding["runtimePayload"],
): ModelSelection | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const raw = "modelSelection" in runtimePayload ? runtimePayload.modelSelection : undefined;
  return isModelSelection(raw) ? raw : undefined;
}

function readPersistedCwd(
  runtimePayload: ProviderSessionDirectory.ProviderRuntimeBinding["runtimePayload"],
): string | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const rawCwd = "cwd" in runtimePayload ? runtimePayload.cwd : undefined;
  if (typeof rawCwd !== "string") return undefined;
  const trimmed = rawCwd.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readRuntimePayloadString(
  runtimePayload: ProviderSessionDirectory.ProviderRuntimeBinding["runtimePayload"],
  key: string,
): string | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const record = runtimePayload as Record<string, unknown>;
  const value = key in record ? record[key] : undefined;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

const dieOnMissingBindingInstanceId = (
  operation: string,
  payload: {
    readonly providerInstanceId?: ProviderInstanceId | undefined;
    readonly provider?: ProviderDriverKind | undefined;
  },
): ProviderInstanceId => {
  if (payload.providerInstanceId !== undefined) {
    return payload.providerInstanceId;
  }
  throw new Error(
    payload.provider
      ? `${operation}: provider instance id is required for provider '${payload.provider}'.`
      : `${operation}: provider instance id is required.`,
  );
};

const correlateRuntimeEventWithInstance = (
  source: {
    readonly instanceId: ProviderInstanceId;
    readonly provider: ProviderDriverKind;
  },
  event: ProviderRuntimeEvent,
): ProviderRuntimeEvent => {
  if (event.provider !== source.provider) {
    throw new Error(
      `ProviderService.streamEvents: provider instance '${source.instanceId}' is backed by driver '${source.provider}' but emitted driver '${event.provider}'.`,
    );
  }
  if (event.providerInstanceId !== undefined && event.providerInstanceId !== source.instanceId) {
    throw new Error(
      `ProviderService.streamEvents: provider instance '${source.instanceId}' emitted event for instance '${event.providerInstanceId}'.`,
    );
  }
  return { ...event, providerInstanceId: source.instanceId };
};

/**
 * Appends an on-disk path line for every attachment so the model's tools can
 * dereference the actual file.
 *
 * Every attachment also reaches the adapter, and each adapter decides what its
 * provider ingests natively: OpenCode sends generic files as file parts, the
 * others send images only and rely on these lines for everything else. That
 * makes the path line the sole channel a non-image attachment has on those
 * providers, which is why follow-ups need it exactly as much as turns do.
 *
 * Unresolvable ids are skipped here and surface as adapter errors when the file
 * is read.
 */
const appendAttachmentPathLines = (
  attachmentsDir: string,
  input: string | undefined,
  attachments: ReadonlyArray<{
    readonly id: string;
    readonly type: string;
    readonly name: string;
  }>,
): string | undefined => {
  const lines = attachments.flatMap((attachment) => {
    const attachmentPath = resolveAttachmentPath({
      attachmentsDir,
      attachment: attachment as Parameters<typeof resolveAttachmentPath>[0]["attachment"],
    });
    return attachmentPath === null
      ? []
      : [`[Attached ${attachment.type} "${attachment.name}" is saved at: ${attachmentPath}]`];
  });
  if (lines.length === 0) return input;
  return [input, lines.join("\n")]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\n\n");
};

const makeProviderService = Effect.fn("makeProviderService")(function* (
  options?: ProviderServiceLiveOptions,
) {
  const analytics = yield* Effect.service(AnalyticsService.AnalyticsService);
  const serverConfig = yield* ServerConfig.ServerConfig;
  const eventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
  // Options-provided logger wins (test overrides); otherwise we take whatever
  // the `ProviderEventLoggers` tag exposes — `undefined` means "no canonical
  // log writer is attached", which downstream code already handles as a
  // no-op.
  const canonicalEventLogger = options?.canonicalEventLogger ?? eventLoggers.canonical;

  const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistry;
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const issueMcpCredential =
    options?.issueMcpCredential ?? McpSessionRegistry.issueActiveMcpCredential;
  const revokeMcpCredential =
    options?.revokeMcpCredential ?? McpSessionRegistry.revokeActiveMcpThread;
  const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const currentSessionIncarnations = new Map<
    ThreadId,
    {
      readonly id: RuntimeSessionId;
      readonly instanceId: ProviderInstanceId;
      readonly adapter: ProviderAdapterShape<ProviderAdapterError>;
    }
  >();
  const activeTurnAdmissions = new Map<
    ThreadId,
    {
      readonly requestId: NonNullable<ProviderSendTurnInput["admissionRequestId"]>;
      readonly sessionIncarnationId: NonNullable<ProviderSendTurnInput["sessionIncarnationId"]>;
      readonly turnId: ProviderRuntimeEvent["turnId"];
    }
  >();
  type StartReservationToken = string;
  type StartReservationEntry = {
    readonly currentToken: StartReservationToken;
    readonly activeTokens: ReadonlySet<StartReservationToken>;
    readonly semaphore: Semaphore.Semaphore;
  };
  const startReservations = yield* SynchronizedRef.make(new Map<ThreadId, StartReservationEntry>());
  const makeStartReservationToken = (): StartReservationToken => NodeCrypto.randomUUID();
  const reportStartReservationCount = options?.onStartReservationCountChange
    ? SynchronizedRef.get(startReservations).pipe(
        Effect.tap((current) =>
          Effect.sync(() => options.onStartReservationCountChange?.(current.size)),
        ),
        Effect.asVoid,
      )
    : Effect.void;
  const instanceMaintenanceState = yield* SynchronizedRef.make(
    new Map<ProviderInstanceId, { readonly pendingStarts: number; readonly fenceToken?: string }>(),
  );
  const beginInstanceStart = (instanceId: ProviderInstanceId) =>
    SynchronizedRef.modify(instanceMaintenanceState, (current) => {
      const state = current.get(instanceId) ?? { pendingStarts: 0 };
      if (state.fenceToken !== undefined) return [false, current] as const;
      const next = new Map(current);
      next.set(instanceId, { ...state, pendingStarts: state.pendingStarts + 1 });
      return [true, next] as const;
    });
  const finishInstanceStart = (instanceId: ProviderInstanceId) =>
    SynchronizedRef.update(instanceMaintenanceState, (current) => {
      const state = current.get(instanceId);
      if (!state) return current;
      const next = new Map(current);
      const pendingStarts = Math.max(0, state.pendingStarts - 1);
      if (pendingStarts === 0 && state.fenceToken === undefined) next.delete(instanceId);
      else next.set(instanceId, { ...state, pendingStarts });
      return next;
    });
  const reserveStartSession = (threadId: ThreadId) =>
    SynchronizedRef.modify(startReservations, (current) => {
      const previous = current.get(threadId);
      const token = makeStartReservationToken();
      const activeTokens = new Set(previous?.activeTokens ?? []);
      activeTokens.add(token);
      const reservation = {
        token,
        semaphore: previous?.semaphore ?? Semaphore.makeUnsafe(1),
      };
      const next = new Map(current);
      next.set(threadId, {
        currentToken: token,
        activeTokens,
        semaphore: reservation.semaphore,
      });
      return [reservation, next] as const;
    }).pipe(Effect.tap(() => reportStartReservationCount));
  const isStartReservationCurrent = (threadId: ThreadId, token: StartReservationToken) =>
    SynchronizedRef.get(startReservations).pipe(
      Effect.map((reservations) => reservations.get(threadId)?.currentToken === token),
    );
  const releaseStartReservation = (threadId: ThreadId, token: StartReservationToken) =>
    SynchronizedRef.update(startReservations, (current) => {
      const previous = current.get(threadId);
      if (previous === undefined || !previous.activeTokens.has(token)) return current;
      const activeTokens = new Set(previous.activeTokens);
      activeTokens.delete(token);
      const next = new Map(current);
      if (activeTokens.size === 0) {
        // Tokens are process-globally unique, so deleting an idle tombstone
        // cannot make any older reservation current again through an ABA reset.
        next.delete(threadId);
      } else {
        next.set(threadId, { ...previous, activeTokens });
      }
      return next;
    }).pipe(Effect.tap(() => reportStartReservationCount));
  // Stop is a cancellation boundary, not another participant in the start
  // semaphore. Replace the current token before any directory read so a first
  // start with no persisted binding still quarantines itself when it returns.
  const invalidateStartSession = (threadId: ThreadId) =>
    SynchronizedRef.update(startReservations, (current) => {
      const previous = current.get(threadId);
      if (previous === undefined || previous.activeTokens.size === 0) {
        // There is no work that can observe this token. Do not retain a
        // historical-thread tombstone indefinitely.
        return current;
      }
      const next = new Map(current);
      next.set(threadId, {
        ...previous,
        currentToken: makeStartReservationToken(),
      });
      return next;
    }).pipe(Effect.tap(() => reportStartReservationCount));
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  /**
   * Attach the `t3-code` MCP server to the session that is about to start.
   *
   * This is the only place a credential is minted, so withholding one here is
   * what disables agent browser access everywhere: every adapter already
   * treats a missing session as "no MCP server", and the `/mcp` endpoint
   * accepts nothing but tokens issued from this path.
   */
  /**
   * Deny on an unreadable settings file rather than letting the read failure
   * escape: adding `ServerSettingsError` to `ProviderServiceError` would widen
   * a union every caller handles, for a branch that only decides whether one
   * optional toolset is attached. Denying is the safe direction — an explicit
   * "off" silently becoming "on" would violate the user's stated choice,
   * whereas the reverse costs an agent one toolset and is visible immediately.
   */
  const agentBrowserAccessEnabled = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.enableAgentBrowserAccess),
    Effect.catch((cause) =>
      Effect.logWarning(
        "Could not read server settings; withholding agent browser access for this session.",
        { cause },
      ).pipe(Effect.as(false)),
    ),
  );

  const prepareMcpSession = (threadId: ThreadId, providerInstanceId: ProviderInstanceId) =>
    Effect.gen(function* () {
      if (!(yield* agentBrowserAccessEnabled)) {
        // Revoke as well as clear. Every other prepare path reaches
        // `issueActiveMcpCredential`, which revokes the thread first, so
        // skipping it here would leave a previously issued bearer token valid
        // against `/mcp` for the rest of its liveness window — and later turns
        // would keep refreshing it. A session restart (runtime mode, cwd,
        // model) re-prepares without stopping, so it relies on this.
        yield* revokeMcpCredential(threadId);
        yield* Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId));
        return undefined;
      }
      const credential = yield* issueMcpCredential({ threadId, providerInstanceId });
      if (credential) {
        yield* Effect.sync(() => McpProviderSession.setMcpProviderSession(credential.config));
      }
      return credential;
    });
  const clearMcpSession = (threadId: ThreadId) =>
    revokeMcpCredential(threadId).pipe(
      Effect.ensuring(Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId))),
    );
  const clearAllMcpSessions = McpSessionRegistry.revokeAllActiveMcpCredentials().pipe(
    Effect.ensuring(Effect.sync(() => McpProviderSession.clearAllMcpProviderSessions())),
  );

  const publishRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
    Effect.succeed(event).pipe(
      Effect.tap((canonicalEvent) =>
        canonicalEventLogger
          ? canonicalEventLogger.write(canonicalEvent, canonicalEvent.threadId)
          : Effect.void,
      ),
      Effect.flatMap((canonicalEvent) => PubSub.publish(runtimeEventPubSub, canonicalEvent)),
      Effect.asVoid,
    );

  const requireBindingInstanceId = (
    operation: string,
    payload: {
      readonly providerInstanceId?: ProviderInstanceId | undefined;
      readonly provider?: ProviderDriverKind | undefined;
    },
  ): Effect.Effect<ProviderInstanceId, ProviderValidationError> =>
    payload.providerInstanceId !== undefined
      ? Effect.succeed(payload.providerInstanceId)
      : Effect.fail(
          toValidationError(
            operation,
            payload.provider
              ? `Provider instance id is required for provider '${payload.provider}'.`
              : "Provider instance id is required.",
          ),
        );

  const upsertSessionBinding = (
    session: ProviderSession,
    threadId: ThreadId,
    extra?: {
      readonly modelSelection?: unknown;
      readonly lastRuntimeEvent?: string;
      readonly lastRuntimeEventAt?: string;
    },
  ) =>
    Effect.gen(function* () {
      const providerInstanceId = yield* requireBindingInstanceId(
        "ProviderService.upsertSessionBinding",
        session,
      );
      yield* directory.upsert({
        threadId,
        provider: session.provider,
        providerInstanceId,
        runtimeMode: session.runtimeMode,
        status: toRuntimeStatus(session),
        ...(session.resumeCursor !== undefined ? { resumeCursor: session.resumeCursor } : {}),
        runtimePayload: toRuntimePayloadFromSession(session, extra),
      });
    });

  // `subscribedAdapters` is our source-of-truth for "which instance adapters
  // are currently wired into the runtime event bus". It both tracks the set
  // of live subscriptions (so `reconcileInstanceSubscriptions` can diff and
  // fork only the *new* or *rebuilt* ones) and serves as the dynamic adapter
  // list consumed by `stopStaleSessionsForThread`, `listSessions`, and
  // `runStopAll` — replacing the pre-Slice-D startup snapshot so hot-added
  // instances become visible to those call sites as soon as settings edits
  // land.
  const subscribedAdapters = yield* Ref.make(
    new Map<ProviderInstanceId, ProviderAdapterShape<ProviderAdapterError>>(),
  );

  const getAdapterEntries = Ref.get(subscribedAdapters).pipe(
    Effect.map((map) => Array.from(map.entries())),
  );

  const restorePreviousIncarnationIfLive = Effect.fn(
    "ProviderService.restorePreviousIncarnationIfLive",
  )(function* (
    threadId: ThreadId,
    attemptedIncarnationId: RuntimeSessionId,
    previousIncarnation:
      | {
          readonly id: RuntimeSessionId;
          readonly instanceId: ProviderInstanceId;
          readonly adapter: ProviderAdapterShape<ProviderAdapterError>;
        }
      | undefined,
  ) {
    const currentIncarnation = currentSessionIncarnations.get(threadId);
    if (currentIncarnation !== undefined && currentIncarnation.id !== attemptedIncarnationId) {
      return;
    }
    if (previousIncarnation === undefined) {
      if (currentIncarnation?.id === attemptedIncarnationId) {
        currentSessionIncarnations.delete(threadId);
      }
      return;
    }

    const currentAdapters = yield* Ref.get(subscribedAdapters);
    const exactPreviousSessionIsLive = yield* previousIncarnation.adapter.listSessions().pipe(
      Effect.map(
        (sessions) =>
          currentAdapters.get(previousIncarnation.instanceId) === previousIncarnation.adapter &&
          sessions.some(
            (session) =>
              session.threadId === threadId &&
              session.sessionIncarnationId === previousIncarnation.id,
          ),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("provider.session.restore-incarnation-inventory-failed", {
          threadId,
          provider: previousIncarnation.adapter.provider,
          cause,
        }).pipe(Effect.as(false)),
      ),
    );

    const retainedIncarnation = currentSessionIncarnations.get(threadId);
    if (retainedIncarnation !== undefined && retainedIncarnation.id !== attemptedIncarnationId) {
      return;
    }
    if (exactPreviousSessionIsLive) {
      currentSessionIncarnations.set(threadId, previousIncarnation);
    } else if (retainedIncarnation?.id === attemptedIncarnationId) {
      currentSessionIncarnations.delete(threadId);
    }
  });

  const processRuntimeEvent = (
    source: {
      readonly instanceId: ProviderInstanceId;
      readonly provider: ProviderDriverKind;
      readonly adapter: ProviderAdapterShape<ProviderAdapterError>;
    },
    event: ProviderRuntimeEvent,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      // Adapter replacement is a hard event boundary. An old subscription can
      // still drain after settings rebuild its instance, but it must not write
      // lifecycle or output into the replacement session.
      const currentAdapters = yield* Ref.get(subscribedAdapters);
      if (currentAdapters.get(source.instanceId) !== source.adapter) return;

      const currentIncarnation = currentSessionIncarnations.get(event.threadId);
      if (
        currentIncarnation === undefined ||
        currentIncarnation.instanceId !== source.instanceId ||
        currentIncarnation.adapter !== source.adapter
      ) {
        return;
      }
      // Incarnation-aware sessions accept only events stamped by the adapter
      // context that produced them. Never turn an unstamped late event into a
      // current event here: after replacement that would assign the old
      // adapter's output to the new session.
      if (event.sessionIncarnationId !== currentIncarnation.id) {
        return;
      }

      let canonicalEvent: ProviderRuntimeEvent = {
        ...correlateRuntimeEventWithInstance(source, event),
        sessionIncarnationId: currentIncarnation.id,
      };
      const activeAdmission = activeTurnAdmissions.get(canonicalEvent.threadId);
      if (
        canonicalEvent.type !== "turn.started" &&
        activeAdmission !== undefined &&
        activeAdmission.sessionIncarnationId === currentIncarnation.id &&
        (canonicalEvent.admissionRequestId === undefined ||
          canonicalEvent.admissionRequestId === activeAdmission.requestId) &&
        (canonicalEvent.turnId === undefined ||
          activeAdmission.turnId === undefined ||
          canonicalEvent.turnId === activeAdmission.turnId)
      ) {
        canonicalEvent = {
          ...canonicalEvent,
          admissionRequestId: activeAdmission.requestId,
        };
      }

      if (
        canonicalEvent.type === "turn.started" &&
        canonicalEvent.admissionRequestId !== undefined
      ) {
        activeTurnAdmissions.set(canonicalEvent.threadId, {
          requestId: canonicalEvent.admissionRequestId,
          sessionIncarnationId: currentIncarnation.id,
          turnId: canonicalEvent.turnId,
        });
      }

      yield* increment(providerRuntimeEventsTotal, {
        provider: canonicalEvent.provider,
        eventType: canonicalEvent.type,
      });
      yield* publishRuntimeEvent(canonicalEvent);

      if (
        canonicalEvent.type === "turn.completed" ||
        canonicalEvent.type === "turn.aborted" ||
        canonicalEvent.type === "session.exited"
      ) {
        const retained = activeTurnAdmissions.get(canonicalEvent.threadId);
        if (
          retained?.sessionIncarnationId === currentIncarnation.id &&
          (canonicalEvent.admissionRequestId === undefined ||
            canonicalEvent.admissionRequestId === retained.requestId)
        ) {
          activeTurnAdmissions.delete(canonicalEvent.threadId);
        }
      }
      if (canonicalEvent.type === "session.exited") {
        const retained = currentSessionIncarnations.get(canonicalEvent.threadId);
        if (retained?.id === currentIncarnation.id) {
          currentSessionIncarnations.delete(canonicalEvent.threadId);
        }
        const mcpSession = McpProviderSession.readMcpProviderSession(canonicalEvent.threadId);
        if (mcpSession?.providerInstanceId !== source.instanceId) return;
        const stillActive = yield* source.adapter.hasSession(canonicalEvent.threadId);
        if (!stillActive) yield* clearMcpSession(canonicalEvent.threadId);
      }
    });

  // Rebuild the map of id → adapter from the registry and fork a new event
  // subscription for every instance that is either brand new or whose adapter
  // identity changed (indicating the underlying `ProviderInstance` was torn
  // down and rebuilt by `ProviderInstanceRegistry.reconcile`). Orphaned
  // fibers for removed/replaced instances exit on their own because their
  // adapter's `streamEvents` source terminates when the old scope closes.
  const reconcileInstanceSubscriptions = Effect.gen(function* () {
    const previous = yield* Ref.get(subscribedAdapters);
    const currentIds = yield* registry.listInstances();
    const next = new Map<ProviderInstanceId, ProviderAdapterShape<ProviderAdapterError>>();
    for (const id of currentIds) {
      const adapterOption = yield* registry
        .getByInstance(id)
        .pipe(Effect.tapError(Effect.logWarning), Effect.option);
      if (Option.isNone(adapterOption)) continue;
      const adapter = adapterOption.value;
      next.set(id, adapter);
      if (previous.get(id) !== adapter) {
        yield* Stream.runForEach(adapter.streamEvents, (event) =>
          processRuntimeEvent(
            {
              instanceId: id,
              provider: adapter.provider,
              adapter,
            },
            event,
          ),
        ).pipe(Effect.forkScoped);
      }
    }
    yield* Ref.set(subscribedAdapters, next);
  });

  const instanceChanges = yield* registry.subscribeChanges;
  yield* reconcileInstanceSubscriptions;
  yield* Stream.runForEach(
    Stream.fromSubscription(instanceChanges),
    () => reconcileInstanceSubscriptions,
  ).pipe(Effect.forkScoped);

  const recoverSessionForThread = Effect.fn("recoverSessionForThread")(function* (input: {
    readonly binding: ProviderSessionDirectory.ProviderRuntimeBinding;
    readonly operation: string;
  }) {
    const bindingInstanceId = yield* requireBindingInstanceId(input.operation, input.binding);
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "recover-session",
      "provider.kind": input.binding.provider,
      "provider.instance_id": bindingInstanceId,
      "provider.thread_id": input.binding.threadId,
    });
    return yield* Effect.gen(function* () {
      const adapter = yield* registry.getByInstance(bindingInstanceId);
      const hasResumeCursor =
        input.binding.resumeCursor !== null && input.binding.resumeCursor !== undefined;
      const hasActiveSession = yield* adapter.hasSession(input.binding.threadId);
      if (hasActiveSession) {
        const activeSessions = yield* adapter.listSessions();
        const existing = activeSessions.find(
          (session) => session.threadId === input.binding.threadId,
        );
        if (existing) {
          if (existing.sessionIncarnationId !== undefined) {
            currentSessionIncarnations.set(input.binding.threadId, {
              id: existing.sessionIncarnationId,
              instanceId: bindingInstanceId,
              adapter,
            });
          }
          yield* upsertSessionBinding(
            { ...existing, providerInstanceId: bindingInstanceId },
            input.binding.threadId,
          );
          yield* analytics.record("provider.session.recovered", {
            provider: existing.provider,
            strategy: "adopt-existing",
            hasResumeCursor: existing.resumeCursor !== undefined,
          });
          return { adapter, session: existing } as const;
        }
      }

      if (!hasResumeCursor) {
        return yield* toValidationError(
          input.operation,
          `Cannot recover thread '${input.binding.threadId}' because no provider resume state is persisted.`,
        );
      }

      const persistedCwd = readPersistedCwd(input.binding.runtimePayload);
      const persistedModelSelection = readPersistedModelSelection(input.binding.runtimePayload);

      const sessionIncarnationId = RuntimeSessionId.make(NodeCrypto.randomUUID());
      const previousIncarnation = currentSessionIncarnations.get(input.binding.threadId);
      const restorePreviousIncarnation = restorePreviousIncarnationIfLive(
        input.binding.threadId,
        sessionIncarnationId,
        previousIncarnation,
      );
      currentSessionIncarnations.set(input.binding.threadId, {
        id: sessionIncarnationId,
        instanceId: bindingInstanceId,
        adapter,
      });
      yield* prepareMcpSession(input.binding.threadId, bindingInstanceId);
      const resumed = yield* adapter
        .startSession({
          threadId: input.binding.threadId,
          provider: input.binding.provider,
          providerInstanceId: bindingInstanceId,
          sessionIncarnationId,
          ...(persistedCwd ? { cwd: persistedCwd } : {}),
          ...(persistedModelSelection ? { modelSelection: persistedModelSelection } : {}),
          ...(hasResumeCursor ? { resumeCursor: input.binding.resumeCursor } : {}),
          runtimeMode: input.binding.runtimeMode ?? "full-access",
        })
        .pipe(
          Effect.onError(() =>
            clearMcpSession(input.binding.threadId).pipe(
              Effect.ensuring(restorePreviousIncarnation),
            ),
          ),
        );
      if (resumed.provider !== adapter.provider) {
        yield* clearMcpSession(input.binding.threadId);
        yield* restorePreviousIncarnation;
        return yield* toValidationError(
          input.operation,
          `Adapter/provider mismatch while recovering thread '${input.binding.threadId}'. Expected '${adapter.provider}', received '${resumed.provider}'.`,
        );
      }
      const resumedWithIncarnation = {
        ...resumed,
        providerInstanceId: bindingInstanceId,
        sessionIncarnationId,
      };

      yield* upsertSessionBinding(resumedWithIncarnation, input.binding.threadId);
      yield* analytics.record("provider.session.recovered", {
        provider: resumed.provider,
        strategy: "resume-thread",
        hasResumeCursor: resumed.resumeCursor !== undefined,
      });
      return { adapter, session: resumedWithIncarnation } as const;
    }).pipe(
      withMetrics({
        counter: providerSessionsTotal,
        attributes: providerMetricAttributes(input.binding.provider, {
          operation: "recover",
        }),
      }),
    );
  });

  const resolveRoutableSession = Effect.fn("resolveRoutableSession")(function* (input: {
    readonly threadId: ThreadId;
    readonly operation: string;
    readonly allowRecovery: boolean;
  }) {
    const bindingOption = yield* directory.getBinding(input.threadId);
    const binding = Option.getOrUndefined(bindingOption);
    if (!binding) {
      return yield* toValidationError(
        input.operation,
        `Cannot route thread '${input.threadId}' because no persisted provider binding exists.`,
      );
    }
    const instanceId = yield* requireBindingInstanceId(input.operation, binding);
    const adapter = yield* registry.getByInstance(instanceId);

    const hasRequestedSession = yield* adapter.hasSession(input.threadId);
    if (hasRequestedSession) {
      if (currentSessionIncarnations.get(input.threadId) === undefined) {
        const persistedIncarnationId = readRuntimePayloadString(
          binding.runtimePayload,
          "sessionIncarnationId",
        );
        if (persistedIncarnationId !== undefined) {
          currentSessionIncarnations.set(input.threadId, {
            id: RuntimeSessionId.make(persistedIncarnationId),
            instanceId,
            adapter,
          });
        }
      }
      return {
        adapter,
        instanceId,
        threadId: input.threadId,
        runtimeMode: binding.runtimeMode,
        isActive: true,
      } as const;
    }

    if (!input.allowRecovery) {
      return {
        adapter,
        instanceId,
        threadId: input.threadId,
        runtimeMode: binding.runtimeMode,
        isActive: false,
      } as const;
    }

    if (!(yield* beginInstanceStart(instanceId))) {
      return yield* toValidationError(
        input.operation,
        `Provider instance '${instanceId}' is fenced for scheduled host maintenance.`,
      );
    }
    const recovered = yield* recoverSessionForThread({
      binding,
      operation: input.operation,
    }).pipe(Effect.ensuring(finishInstanceStart(instanceId)));
    return {
      adapter: recovered.adapter,
      instanceId,
      threadId: input.threadId,
      runtimeMode: recovered.session.runtimeMode,
      isActive: true,
    } as const;
  });

  const stopStaleSessionsForThread = Effect.fn("stopStaleSessionsForThread")(function* (input: {
    readonly threadId: ThreadId;
    readonly currentInstanceId: ProviderInstanceId;
  }) {
    const currentAdapters = yield* getAdapterEntries;
    yield* Effect.forEach(
      currentAdapters,
      ([instanceId, adapter]) =>
        instanceId === input.currentInstanceId
          ? Effect.void
          : Effect.gen(function* () {
              const hasSession = yield* adapter.hasSession(input.threadId);
              if (!hasSession) {
                return;
              }

              yield* adapter.stopSession(input.threadId).pipe(
                Effect.tap(() =>
                  analytics.record("provider.session.stopped", {
                    provider: adapter.provider,
                  }),
                ),
                Effect.catchCause((cause) =>
                  Effect.logWarning("provider.session.stop-stale-failed", {
                    threadId: input.threadId,
                    provider: adapter.provider,
                    cause,
                  }),
                ),
              );
            }),
      { discard: true },
    );
  });

  const startSession: ProviderServiceMethod<"startSession"> = Effect.fn("startSession")(
    function* (threadId, rawInput) {
      const parsed = yield* decodeInputOrValidationError({
        operation: "ProviderService.startSession",
        schema: ProviderSessionStartInput,
        payload: rawInput,
      });

      const resolvedInstanceId = yield* requireBindingInstanceId(
        "ProviderService.startSession",
        parsed,
      );
      if (!(yield* beginInstanceStart(resolvedInstanceId))) {
        return yield* toValidationError(
          "ProviderService.startSession",
          `Provider instance '${resolvedInstanceId}' is fenced for scheduled host maintenance.`,
        );
      }
      let metricProvider = parsed.provider ?? String(resolvedInstanceId);
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "start-session",
        "provider.instance_id": resolvedInstanceId,
        "provider.thread_id": threadId,
        "provider.runtime_mode": parsed.runtimeMode,
      });
      // Reserve before waiting for the per-thread permit. A newer caller can
      // supersede work already in progress, but adapters still start one at a
      // time for this thread.
      const reservation = yield* reserveStartSession(threadId);
      return yield* reservation.semaphore
        .withPermit(
          Effect.gen(function* () {
            if (!(yield* isStartReservationCurrent(threadId, reservation.token))) {
              return yield* toValidationError(
                "ProviderService.startSession",
                `Provider session start for thread '${threadId}' was superseded by a newer request.`,
              );
            }
            const instanceInfo = yield* registry.getInstanceInfo(resolvedInstanceId);
            const resolvedProvider = instanceInfo.driverKind;
            metricProvider = resolvedProvider;
            if (parsed.provider !== undefined && parsed.provider !== resolvedProvider) {
              return yield* toValidationError(
                "ProviderService.startSession",
                `Provider instance '${resolvedInstanceId}' belongs to driver '${resolvedProvider}', not '${parsed.provider}'.`,
              );
            }
            const input = {
              ...parsed,
              threadId,
              provider: resolvedProvider,
            };
            if (!instanceInfo.enabled) {
              return yield* toValidationError(
                "ProviderService.startSession",
                `Provider instance '${resolvedInstanceId}' is disabled in Pylon settings.`,
              );
            }
            const persistedBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
            const effectiveResumeCursor =
              input.resumeCursor ??
              (persistedBinding?.providerInstanceId === resolvedInstanceId
                ? persistedBinding.resumeCursor
                : undefined);
            const effectiveCwd =
              input.cwd ??
              (persistedBinding?.providerInstanceId === resolvedInstanceId
                ? readPersistedCwd(persistedBinding.runtimePayload)
                : undefined);
            yield* Effect.annotateCurrentSpan({
              "provider.kind": resolvedProvider,
              "provider.resume_cursor.source":
                input.resumeCursor !== undefined
                  ? "request"
                  : effectiveResumeCursor !== undefined &&
                      persistedBinding?.providerInstanceId === resolvedInstanceId
                    ? "persisted"
                    : "none",
              "provider.resume_cursor.present": effectiveResumeCursor !== undefined,
              "provider.cwd.source":
                input.cwd !== undefined
                  ? "request"
                  : effectiveCwd !== undefined &&
                      persistedBinding?.providerInstanceId === resolvedInstanceId
                    ? "persisted"
                    : "none",
              "provider.cwd.effective": effectiveCwd ?? "",
            });
            const adapter = yield* registry.getByInstance(resolvedInstanceId);
            const sessionIncarnationId = RuntimeSessionId.make(NodeCrypto.randomUUID());
            const previousIncarnation = currentSessionIncarnations.get(threadId);
            const restorePreviousIncarnation = restorePreviousIncarnationIfLive(
              threadId,
              sessionIncarnationId,
              previousIncarnation,
            );
            currentSessionIncarnations.set(threadId, {
              id: sessionIncarnationId,
              instanceId: resolvedInstanceId,
              adapter,
            });
            yield* prepareMcpSession(threadId, resolvedInstanceId);
            const session = yield* adapter
              .startSession({
                ...input,
                providerInstanceId: resolvedInstanceId,
                sessionIncarnationId,
                ...(effectiveCwd !== undefined ? { cwd: effectiveCwd } : {}),
                ...(effectiveResumeCursor !== undefined
                  ? { resumeCursor: effectiveResumeCursor }
                  : {}),
              })
              .pipe(
                Effect.onError(() =>
                  clearMcpSession(threadId).pipe(Effect.ensuring(restorePreviousIncarnation)),
                ),
              );

            if (session.provider !== adapter.provider) {
              yield* clearMcpSession(threadId);
              yield* restorePreviousIncarnation;
              return yield* toValidationError(
                "ProviderService.startSession",
                `Adapter/provider mismatch: requested '${adapter.provider}', received '${session.provider}'.`,
              );
            }
            const sessionWithInstance = {
              ...session,
              providerInstanceId: resolvedInstanceId,
              sessionIncarnationId,
            };
            const requireCurrentStartReservation = Effect.fnUntraced(function* () {
              if (yield* isStartReservationCurrent(threadId, reservation.token)) return;
              yield* adapter.stopSession(threadId).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("provider.session.stop-superseded-start-failed", {
                    threadId,
                    provider: adapter.provider,
                    cause,
                  }),
                ),
              );
              yield* clearMcpSession(threadId);
              if (currentSessionIncarnations.get(threadId)?.id === sessionIncarnationId) {
                currentSessionIncarnations.delete(threadId);
              }
              activeTurnAdmissions.delete(threadId);
              // The invalidation can land between the pre-upsert check and the
              // directory write. Remove only the exact late incarnation; a
              // newer start may already own the thread and must remain intact.
              yield* directory.removeExact({
                threadId,
                providerInstanceId: resolvedInstanceId,
                sessionIncarnationId,
              });
              return yield* toValidationError(
                "ProviderService.startSession",
                `Provider session start for thread '${threadId}' was superseded by a newer request.`,
              );
            });

            yield* requireCurrentStartReservation();
            yield* stopStaleSessionsForThread({
              threadId,
              currentInstanceId: resolvedInstanceId,
            });
            yield* requireCurrentStartReservation();
            yield* upsertSessionBinding(sessionWithInstance, threadId, {
              modelSelection: input.modelSelection,
            });
            yield* requireCurrentStartReservation();
            yield* analytics.record("provider.session.started", {
              provider: sessionWithInstance.provider,
              runtimeMode: input.runtimeMode,
              hasResumeCursor: sessionWithInstance.resumeCursor !== undefined,
              hasCwd: typeof effectiveCwd === "string" && effectiveCwd.trim().length > 0,
              hasModel:
                typeof input.modelSelection?.model === "string" &&
                input.modelSelection.model.trim().length > 0,
            });

            // Changing runtime mode restarts the session, so the transition is only
            // observable here, by diffing against the mode the previous session for
            // this thread was bound to. Recording it separately is what makes the
            // "started supervised, switched to full access" funnel answerable.
            const previousRuntimeMode = persistedBinding?.runtimeMode;
            if (previousRuntimeMode !== undefined && previousRuntimeMode !== input.runtimeMode) {
              yield* analytics.record("provider.runtime_mode.changed", {
                provider: sessionWithInstance.provider,
                from: previousRuntimeMode,
                to: input.runtimeMode,
              });
            }

            yield* requireCurrentStartReservation();
            return sessionWithInstance;
          }).pipe(
            withMetrics({
              counter: providerSessionsTotal,
              attributes: () =>
                providerMetricAttributes(metricProvider, {
                  operation: "start",
                }),
            }),
          ),
        )
        .pipe(
          Effect.ensuring(releaseStartReservation(threadId, reservation.token)),
          Effect.ensuring(finishInstanceStart(resolvedInstanceId)),
        );
    },
  );

  const sendTurn: ProviderServiceMethod<"sendTurn"> = Effect.fn("sendTurn")(function* (rawInput) {
    const parsed = yield* decodeInputOrValidationError({
      operation: "ProviderService.sendTurn",
      schema: ProviderSendTurnInput,
      payload: rawInput,
    });

    const attachments = parsed.attachments ?? [];
    if (!parsed.input && attachments.length === 0) {
      return yield* toValidationError(
        "ProviderService.sendTurn",
        "Either input text or at least one attachment is required",
      );
    }

    const inputTextWithAttachmentPaths = appendAttachmentPathLines(
      serverConfig.attachmentsDir,
      parsed.input,
      attachments,
    );

    const input = {
      ...parsed,
      ...(inputTextWithAttachmentPaths !== undefined
        ? { input: inputTextWithAttachmentPaths }
        : {}),
    };
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "send-turn",
      "provider.thread_id": input.threadId,
      "provider.interaction_mode": input.interactionMode,
      "provider.attachment_count": attachments.length,
    });
    let metricProvider = "unknown";
    let metricModel = input.modelSelection?.model;
    return yield* Effect.gen(function* () {
      if (input.modelSelection !== undefined) {
        const persistedBinding = Option.getOrUndefined(yield* directory.getBinding(input.threadId));
        if (persistedBinding !== undefined) {
          const boundInstanceId = yield* requireBindingInstanceId(
            "ProviderService.sendTurn",
            persistedBinding,
          );
          if (input.modelSelection.instanceId !== boundInstanceId) {
            return yield* toValidationError(
              "ProviderService.sendTurn",
              `Provider session for thread '${input.threadId}' is bound to instance '${boundInstanceId}', but the model selection belongs to '${input.modelSelection.instanceId}'.`,
            );
          }
        }
      }
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.sendTurn",
        allowRecovery: true,
      });
      metricProvider = routed.adapter.provider;
      metricModel = input.modelSelection?.model;
      if (
        input.modelSelection !== undefined &&
        input.modelSelection.instanceId !== routed.instanceId
      ) {
        return yield* toValidationError(
          "ProviderService.sendTurn",
          `Provider session for thread '${input.threadId}' is bound to instance '${routed.instanceId}', but the model selection belongs to '${input.modelSelection.instanceId}'.`,
        );
      }
      yield* Effect.annotateCurrentSpan({
        "provider.kind": routed.adapter.provider,
        ...(input.modelSelection?.model ? { "provider.model": input.modelSelection.model } : {}),
      });
      // A turn is the clearest sign a session is still alive. The MCP
      // credential is minted once at session start and cannot be rotated into
      // an already-spawned agent process, so we keep the existing token valid
      // rather than issuing a new one: sessions that go a long time between
      // browser tool calls used to lose the toolkit outright.
      yield* McpSessionRegistry.touchActiveMcpThread(input.threadId);
      if (input.sessionIncarnationId !== undefined) {
        const currentIncarnation = currentSessionIncarnations.get(input.threadId);
        if (
          currentIncarnation?.id !== input.sessionIncarnationId ||
          currentIncarnation.instanceId !== routed.instanceId ||
          currentIncarnation.adapter !== routed.adapter
        ) {
          return yield* toValidationError(
            "ProviderService.sendTurn",
            `Provider session incarnation '${input.sessionIncarnationId}' is no longer current for thread '${input.threadId}'.`,
          );
        }
      }
      if (input.admissionRequestId !== undefined && input.sessionIncarnationId !== undefined) {
        const binding = Option.getOrUndefined(yield* directory.getBinding(input.threadId));
        yield* directory.upsert({
          threadId: input.threadId,
          provider: routed.adapter.provider,
          providerInstanceId: routed.instanceId,
          runtimeMode: routed.runtimeMode ?? binding?.runtimeMode ?? "full-access",
          status: "starting",
          ...(binding?.resumeCursor !== undefined ? { resumeCursor: binding.resumeCursor } : {}),
          runtimePayload: {
            ...(typeof binding?.runtimePayload === "object" && binding.runtimePayload !== null
              ? binding.runtimePayload
              : {}),
            admissionRequestId: input.admissionRequestId,
            sessionIncarnationId: input.sessionIncarnationId,
          },
        });
      }
      if (routed.adapter.prepareTurnRecovery !== undefined) {
        yield* routed.adapter.prepareTurnRecovery(input);
      }
      const turn = yield* routed.adapter.sendTurn(input);
      yield* directory.upsert({
        threadId: input.threadId,
        provider: routed.adapter.provider,
        providerInstanceId: routed.instanceId,
        status: "running",
        ...(turn.resumeCursor !== undefined ? { resumeCursor: turn.resumeCursor } : {}),
        runtimePayload: {
          ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
          activeTurnId: turn.turnId,
          ...(input.admissionRequestId !== undefined
            ? { activeTurnRequestId: input.admissionRequestId }
            : {}),
          ...(input.sessionIncarnationId !== undefined
            ? { sessionIncarnationId: input.sessionIncarnationId }
            : {}),
          lastRuntimeEvent: "provider.sendTurn",
          lastRuntimeEventAt: yield* nowIso,
        },
      });
      yield* analytics.record("provider.turn.sent", {
        provider: routed.adapter.provider,
        model: input.modelSelection?.model,
        interactionMode: input.interactionMode,
        // Session-start events alone skew runtime mode toward users who toggle
        // often, since every toggle restarts the session. Recording it per turn
        // gives a usage-weighted view and lets it cross with interactionMode.
        runtimeMode: routed.runtimeMode,
        attachmentCount: attachments.length,
        hasInput: typeof input.input === "string" && input.input.trim().length > 0,
      });
      return turn;
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        timer: providerTurnDuration,
        attributes: () =>
          providerTurnMetricAttributes({
            provider: metricProvider,
            model: metricModel,
            extra: {
              operation: "send",
            },
          }),
      }),
    );
  });

  const recoverRestartSessions: ProviderServiceMethod<"recoverRestartSessions"> = Effect.fn(
    "recoverRestartSessions",
  )(function* () {
    const bindings = yield* directory.listBindings();
    for (const binding of bindings) {
      let adoptedAdapter: ProviderAdapterShape<ProviderAdapterError> | undefined;
      let mcpPrepared = false;
      yield* Effect.gen(function* () {
        const instanceId = yield* requireBindingInstanceId(
          "ProviderService.recoverRestartSessions",
          binding,
        );
        const adapter = yield* registry.getByInstance(instanceId);
        if (
          adapter.recoverSession === undefined ||
          adapter.activateRecoveredSession === undefined
        ) {
          return;
        }
        const rawIncarnation = readRuntimePayloadString(
          binding.runtimePayload,
          "sessionIncarnationId",
        );
        const cwd = readPersistedCwd(binding.runtimePayload);
        if (
          rawIncarnation === undefined ||
          cwd === undefined ||
          binding.resumeCursor === undefined ||
          binding.resumeCursor === null
        ) {
          return;
        }
        yield* prepareMcpSession(binding.threadId, instanceId);
        mcpPrepared = true;
        const modelSelection = readPersistedModelSelection(binding.runtimePayload);
        const recovered = yield* adapter.recoverSession({
          threadId: binding.threadId,
          providerInstanceId: instanceId,
          sessionIncarnationId: RuntimeSessionId.make(rawIncarnation),
          runtimeMode: binding.runtimeMode ?? "full-access",
          cwd,
          ...(modelSelection === undefined ? {} : { modelSelection }),
          resumeCursor: binding.resumeCursor,
        });
        if (recovered === null) {
          yield* clearMcpSession(binding.threadId);
          return;
        }
        adoptedAdapter = adapter;
        currentSessionIncarnations.set(binding.threadId, {
          id: RuntimeSessionId.make(rawIncarnation),
          instanceId,
          adapter,
        });
        yield* upsertSessionBinding(
          { ...recovered, providerInstanceId: instanceId },
          binding.threadId,
          {
            lastRuntimeEvent: "provider.restart-adopted",
            lastRuntimeEventAt: yield* nowIso,
          },
        );
        yield* adapter.activateRecoveredSession(binding.threadId);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            if (adoptedAdapter !== undefined) {
              yield* adoptedAdapter.stopSession(binding.threadId).pipe(
                Effect.catchCause((cleanupCause) =>
                  Effect.logWarning("failed to clean up adopted provider session", {
                    threadId: binding.threadId,
                    errorTag: causeErrorTag(cleanupCause),
                  }),
                ),
              );
              const current = currentSessionIncarnations.get(binding.threadId);
              if (current?.adapter === adoptedAdapter) {
                currentSessionIncarnations.delete(binding.threadId);
              }
            }
            if (mcpPrepared) yield* clearMcpSession(binding.threadId);
            yield* Effect.logWarning("failed to adopt recoverable provider session", {
              threadId: binding.threadId,
              errorTag: causeErrorTag(cause),
            });
          }),
        ),
      );
    }
  });

  const interruptTurn: ProviderServiceMethod<"interruptTurn"> = Effect.fn("interruptTurn")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.interruptTurn",
        schema: ProviderInterruptTurnInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.interruptTurn",
          allowRecovery: true,
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "interrupt-turn",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
          "provider.turn_id": input.turnId,
        });
        yield* routed.adapter.interruptTurn(routed.threadId, input.turnId);
        yield* analytics.record("provider.turn.interrupted", {
          provider: routed.adapter.provider,
        });
      }).pipe(
        withMetrics({
          counter: providerTurnsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "interrupt",
            }),
        }),
      );
    },
  );

  const respondToRequest: ProviderServiceMethod<"respondToRequest"> = Effect.fn("respondToRequest")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.respondToRequest",
        schema: ProviderRespondToRequestInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.respondToRequest",
          allowRecovery: true,
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "respond-to-request",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
          "provider.request_id": input.requestId,
        });
        yield* routed.adapter.respondToRequest(routed.threadId, input.requestId, input.decision);
        yield* analytics.record("provider.request.responded", {
          provider: routed.adapter.provider,
          decision: input.decision,
        });
      }).pipe(
        withMetrics({
          counter: providerTurnsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "approval-response",
            }),
        }),
      );
    },
  );

  const respondToUserInput: ProviderServiceMethod<"respondToUserInput"> = Effect.fn(
    "respondToUserInput",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.respondToUserInput",
      schema: ProviderRespondToUserInputInput,
      payload: rawInput,
    });
    let metricProvider = "unknown";
    return yield* Effect.gen(function* () {
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.respondToUserInput",
        allowRecovery: true,
      });
      metricProvider = routed.adapter.provider;
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "respond-to-user-input",
        "provider.kind": routed.adapter.provider,
        "provider.thread_id": input.threadId,
        "provider.request_id": input.requestId,
      });
      yield* routed.adapter.respondToUserInput(routed.threadId, input.requestId, input.answers);
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        outcomeAttributes: () =>
          providerMetricAttributes(metricProvider, {
            operation: "user-input-response",
          }),
      }),
    );
  });

  const respondToInteraction: ProviderServiceMethod<"respondToInteraction"> = Effect.fn(
    "respondToInteraction",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.respondToInteraction",
      schema: ProviderRespondToInteractionInput,
      payload: rawInput,
    });
    let metricProvider = "unknown";
    return yield* Effect.gen(function* () {
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.respondToInteraction",
        allowRecovery: true,
      });
      metricProvider = routed.adapter.provider;
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "respond-to-interaction",
        "provider.kind": routed.adapter.provider,
        "provider.thread_id": input.threadId,
        "provider.request_id": input.requestId,
      });
      const respond = routed.adapter.respondToInteraction;
      if (respond === undefined) {
        return yield* new ProviderAdapterRequestError({
          provider: routed.adapter.provider,
          method: "session/interaction/respond",
          detail: "Session interaction responses are not supported by this provider adapter.",
          reason: "unsupported",
        });
      }
      yield* respond(routed.threadId, input.requestId, input.response);
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        outcomeAttributes: () =>
          providerMetricAttributes(metricProvider, {
            operation: "interaction-response",
          }),
      }),
    );
  });

  const reloadSessionResources: ProviderServiceMethod<"reloadSessionResources"> = Effect.fn(
    "reloadSessionResources",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.reloadSessionResources",
      schema: ProviderReloadSessionResourcesInput,
      payload: rawInput,
    });
    const routed = yield* resolveRoutableSession({
      threadId: input.threadId,
      operation: "ProviderService.reloadSessionResources",
      allowRecovery: false,
    });
    if (!routed.isActive) {
      return yield* toValidationError(
        "ProviderService.reloadSessionResources",
        `Thread '${input.threadId}' does not have an active provider session.`,
      );
    }
    const reload = routed.adapter.reloadSessionResources;
    if (reload === undefined) {
      return yield* new ProviderUnsupportedError({ provider: routed.adapter.provider });
    }
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "reload-session-resources",
      "provider.kind": routed.adapter.provider,
      "provider.instance_id": routed.instanceId,
      "provider.thread_id": input.threadId,
    });
    return yield* reload(routed.threadId);
  });

  const askSessionSideQuestion: ProviderServiceMethod<"askSessionSideQuestion"> = Effect.fn(
    "askSessionSideQuestion",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.askSessionSideQuestion",
      schema: ProviderAskSessionSideQuestionInput,
      payload: rawInput,
    });
    const routed = yield* resolveRoutableSession({
      threadId: input.threadId,
      operation: "ProviderService.askSessionSideQuestion",
      allowRecovery: false,
    });
    if (!routed.isActive) {
      return yield* toValidationError(
        "ProviderService.askSessionSideQuestion",
        `Thread '${input.threadId}' does not have an active provider session.`,
      );
    }
    const ask = routed.adapter.askSessionSideQuestion;
    if (ask === undefined) {
      return yield* new ProviderUnsupportedError({ provider: routed.adapter.provider });
    }
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "ask-session-side-question",
      "provider.kind": routed.adapter.provider,
      "provider.instance_id": routed.instanceId,
      "provider.thread_id": input.threadId,
    });
    return yield* ask(routed.threadId, input.requestId, input.question);
  });

  const cancelSessionSideQuestion: ProviderServiceMethod<"cancelSessionSideQuestion"> = Effect.fn(
    "cancelSessionSideQuestion",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.cancelSessionSideQuestion",
      schema: ProviderCancelSessionSideQuestionInput,
      payload: rawInput,
    });
    const routed = yield* resolveRoutableSession({
      threadId: input.threadId,
      operation: "ProviderService.cancelSessionSideQuestion",
      allowRecovery: false,
    });
    if (!routed.isActive) {
      return yield* toValidationError(
        "ProviderService.cancelSessionSideQuestion",
        `Thread '${input.threadId}' does not have an active provider session.`,
      );
    }
    const cancel = routed.adapter.cancelSessionSideQuestion;
    if (cancel === undefined) {
      return yield* new ProviderUnsupportedError({ provider: routed.adapter.provider });
    }
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "cancel-session-side-question",
      "provider.kind": routed.adapter.provider,
      "provider.instance_id": routed.instanceId,
      "provider.thread_id": input.threadId,
    });
    return yield* cancel(routed.threadId, input.requestId);
  });

  const cancelSessionAgent: ProviderServiceMethod<"cancelSessionAgent"> = Effect.fn(
    "cancelSessionAgent",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.cancelSessionAgent",
      schema: ProviderCancelSessionAgentInput,
      payload: rawInput,
    });
    const routed = yield* resolveRoutableSession({
      threadId: input.threadId,
      operation: "ProviderService.cancelSessionAgent",
      allowRecovery: false,
    });
    if (!routed.isActive) {
      return yield* toValidationError(
        "ProviderService.cancelSessionAgent",
        `Thread '${input.threadId}' does not have an active provider session.`,
      );
    }
    const cancelAgent = routed.adapter.cancelSessionAgent;
    if (cancelAgent === undefined) {
      return yield* new ProviderUnsupportedError({ provider: routed.adapter.provider });
    }
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "cancel-session-agent",
      "provider.kind": routed.adapter.provider,
      "provider.instance_id": routed.instanceId,
      "provider.thread_id": input.threadId,
    });
    return yield* cancelAgent(routed.threadId, input.agentId);
  });

  const messageSessionAgent: ProviderServiceMethod<"messageSessionAgent"> = Effect.fn(
    "messageSessionAgent",
  )(function* (rawInput) {
    const rawMessage =
      typeof rawInput === "object" && rawInput !== null && "message" in rawInput
        ? rawInput.message
        : undefined;
    if (
      typeof rawMessage !== "string" ||
      rawMessage.trim().length === 0 ||
      rawMessage.trim().length > PROVIDER_SESSION_AGENT_MESSAGE_MAX_CHARS
    ) {
      return yield* new ProviderValidationError({
        operation: "ProviderService.messageSessionAgent",
        issue: `Message must contain at most ${PROVIDER_SESSION_AGENT_MESSAGE_MAX_CHARS} non-empty characters.`,
        reason: "invalid-input",
      });
    }
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.messageSessionAgent",
      schema: ProviderMessageSessionAgentInput,
      payload: rawInput,
    });
    const routed = yield* resolveRoutableSession({
      threadId: input.threadId,
      operation: "ProviderService.messageSessionAgent",
      allowRecovery: false,
    });
    if (!routed.isActive) {
      return yield* toValidationError(
        "ProviderService.messageSessionAgent",
        `Thread '${input.threadId}' does not have an active provider session.`,
      );
    }
    const messageAgent = routed.adapter.messageSessionAgent;
    if (messageAgent === undefined) {
      return yield* new ProviderUnsupportedError({ provider: routed.adapter.provider });
    }
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "message-session-agent",
      "provider.kind": routed.adapter.provider,
      "provider.instance_id": routed.instanceId,
      "provider.thread_id": input.threadId,
    });
    return yield* messageAgent(routed.threadId, input.agentId, input.message);
  });

  const watchSessionAgentActivity: ProviderServiceMethod<"watchSessionAgentActivity"> = (
    rawInput,
  ) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const input = yield* decodeInputOrValidationError({
          operation: "ProviderService.watchSessionAgentActivity",
          schema: ProviderWatchSessionAgentActivityInput,
          payload: rawInput,
        });
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.watchSessionAgentActivity",
          allowRecovery: false,
        });
        if (!routed.isActive) {
          return yield* toValidationError(
            "ProviderService.watchSessionAgentActivity",
            `Thread '${input.threadId}' does not have an active provider session.`,
          );
        }
        const watchActivity = routed.adapter.watchSessionAgentActivity;
        if (watchActivity === undefined) {
          return yield* new ProviderUnsupportedError({ provider: routed.adapter.provider });
        }
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "watch-session-agent-activity",
          "provider.kind": routed.adapter.provider,
          "provider.instance_id": routed.instanceId,
          "provider.thread_id": input.threadId,
        });
        return watchActivity(routed.threadId, input.agentId);
      }),
    );

  const getSessionAgentDepth: ProviderServiceMethod<"getSessionAgentDepth"> = Effect.fn(
    "getSessionAgentDepth",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.getSessionAgentDepth",
      schema: ProviderGetSessionAgentDepthInput,
      payload: rawInput,
    });
    const routed = yield* resolveRoutableSession({
      threadId: input.threadId,
      operation: "ProviderService.getSessionAgentDepth",
      allowRecovery: false,
    });
    if (!routed.isActive) {
      return yield* toValidationError(
        "ProviderService.getSessionAgentDepth",
        `Thread '${input.threadId}' does not have an active provider session.`,
      );
    }
    const getDepth = routed.adapter.getSessionAgentDepth;
    if (getDepth === undefined) {
      return yield* new ProviderUnsupportedError({ provider: routed.adapter.provider });
    }
    return yield* getDepth(routed.threadId);
  });

  const setSessionAgentDepth: ProviderServiceMethod<"setSessionAgentDepth"> = Effect.fn(
    "setSessionAgentDepth",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.setSessionAgentDepth",
      schema: ProviderSetSessionAgentDepthInput,
      payload: rawInput,
    });
    if (
      !Number.isInteger(input.maxDepth) ||
      input.maxDepth < 0 ||
      input.maxDepth > PROVIDER_SESSION_AGENT_DEPTH_MAX_SETTABLE
    ) {
      return yield* new ProviderValidationError({
        operation: "ProviderService.setSessionAgentDepth",
        reason: "invalid-input",
        issue: `Agent depth must be an integer from 0 to ${PROVIDER_SESSION_AGENT_DEPTH_MAX_SETTABLE}.`,
      });
    }
    const routed = yield* resolveRoutableSession({
      threadId: input.threadId,
      operation: "ProviderService.setSessionAgentDepth",
      allowRecovery: false,
    });
    if (!routed.isActive) {
      return yield* toValidationError(
        "ProviderService.setSessionAgentDepth",
        `Thread '${input.threadId}' does not have an active provider session.`,
      );
    }
    const setDepth = routed.adapter.setSessionAgentDepth;
    if (setDepth === undefined) {
      return yield* new ProviderUnsupportedError({ provider: routed.adapter.provider });
    }
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "set-session-agent-depth",
      "provider.kind": routed.adapter.provider,
      "provider.instance_id": routed.instanceId,
      "provider.thread_id": input.threadId,
      "provider.agent_depth": input.maxDepth,
    });
    return yield* setDepth(routed.threadId, input.maxDepth);
  });

  const followUp: ProviderServiceMethod<"followUp"> = Effect.fn("followUp")(function* (rawInput) {
    const parsed = yield* decodeInputOrValidationError({
      operation: "ProviderService.followUp",
      schema: ProviderFollowUpInput,
      payload: rawInput,
    });
    const input = { ...parsed, attachments: parsed.attachments ?? [] };
    if (!input.input && input.attachments.length === 0) {
      return yield* new ProviderValidationError({
        operation: "ProviderService.followUp",
        reason: "invalid-input",
        issue: "Either follow-up text or at least one attachment is required.",
      });
    }
    const routed = yield* resolveRoutableSession({
      threadId: input.threadId,
      operation: "ProviderService.followUp",
      allowRecovery: false,
    });
    if (!routed.isActive) {
      return yield* toValidationError(
        "ProviderService.followUp",
        `Thread '${input.threadId}' does not have an active provider session.`,
      );
    }
    const followUpSession = routed.adapter.followUp;
    if (followUpSession === undefined) {
      return yield* new ProviderUnsupportedError({ provider: routed.adapter.provider });
    }
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "follow-up",
      "provider.kind": routed.adapter.provider,
      "provider.instance_id": routed.instanceId,
      "provider.thread_id": input.threadId,
      "provider.attachment_count": input.attachments.length,
    });
    // Same path lines `sendTurn` appends. Without them a generic file attached
    // to a follow-up is lost outright: every adapter except OpenCode skips
    // non-images, so the path line is the only thing that tells the agent the
    // file exists.
    const followUpInputText = appendAttachmentPathLines(
      serverConfig.attachmentsDir,
      input.input,
      input.attachments,
    );
    return yield* followUpSession({
      ...input,
      ...(followUpInputText !== undefined ? { input: followUpInputText } : {}),
    });
  });

  const getSessionInputQueue: ProviderServiceMethod<"getSessionInputQueue"> = Effect.fn(
    "getSessionInputQueue",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.getSessionInputQueue",
      schema: ProviderGetSessionInputQueueInput,
      payload: rawInput,
    });
    const routed = yield* resolveRoutableSession({
      threadId: input.threadId,
      operation: "ProviderService.getSessionInputQueue",
      allowRecovery: false,
    });
    if (!routed.isActive) {
      return yield* toValidationError(
        "ProviderService.getSessionInputQueue",
        `Thread '${input.threadId}' does not have an active provider session.`,
      );
    }
    const getInputQueue = routed.adapter.getSessionInputQueue;
    if (getInputQueue === undefined) {
      return yield* new ProviderUnsupportedError({ provider: routed.adapter.provider });
    }
    return yield* getInputQueue(routed.threadId);
  });

  const clearSessionInputQueue: ProviderServiceMethod<"clearSessionInputQueue"> = Effect.fn(
    "clearSessionInputQueue",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.clearSessionInputQueue",
      schema: ProviderClearSessionInputQueueInput,
      payload: rawInput,
    });
    const routed = yield* resolveRoutableSession({
      threadId: input.threadId,
      operation: "ProviderService.clearSessionInputQueue",
      allowRecovery: false,
    });
    if (!routed.isActive) {
      return yield* toValidationError(
        "ProviderService.clearSessionInputQueue",
        `Thread '${input.threadId}' does not have an active provider session.`,
      );
    }
    const clearInputQueue = routed.adapter.clearSessionInputQueue;
    if (clearInputQueue === undefined) {
      return yield* new ProviderUnsupportedError({ provider: routed.adapter.provider });
    }
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "clear-session-input-queue",
      "provider.kind": routed.adapter.provider,
      "provider.instance_id": routed.instanceId,
      "provider.thread_id": input.threadId,
    });
    return yield* clearInputQueue(routed.threadId);
  });

  const removeOnlySessionInputQueueItem: ProviderServiceMethod<"removeOnlySessionInputQueueItem"> =
    Effect.fn("removeOnlySessionInputQueueItem")(function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.removeOnlySessionInputQueueItem",
        schema: ProviderRemoveOnlySessionInputQueueItemInput,
        payload: rawInput,
      });
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.removeOnlySessionInputQueueItem",
        allowRecovery: false,
      });
      if (!routed.isActive) {
        return yield* toValidationError(
          "ProviderService.removeOnlySessionInputQueueItem",
          `Thread '${input.threadId}' does not have an active provider session.`,
        );
      }
      const removeOnlyInput = routed.adapter.removeOnlySessionInputQueueItem;
      if (removeOnlyInput === undefined) {
        return yield* new ProviderUnsupportedError({ provider: routed.adapter.provider });
      }
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "remove-only-session-input-queue-item",
        "provider.kind": routed.adapter.provider,
        "provider.instance_id": routed.instanceId,
        "provider.thread_id": input.threadId,
        "provider.input_queue_kind": input.queue,
      });
      return yield* removeOnlyInput({ ...input, threadId: routed.threadId });
    });

  const setSessionInputQueueMode: ProviderServiceMethod<"setSessionInputQueueMode"> = Effect.fn(
    "setSessionInputQueueMode",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.setSessionInputQueueMode",
      schema: ProviderSetSessionInputQueueModeInput,
      payload: rawInput,
    });
    const routed = yield* resolveRoutableSession({
      threadId: input.threadId,
      operation: "ProviderService.setSessionInputQueueMode",
      allowRecovery: false,
    });
    if (!routed.isActive) {
      return yield* toValidationError(
        "ProviderService.setSessionInputQueueMode",
        `Thread '${input.threadId}' does not have an active provider session.`,
      );
    }
    const setInputQueueMode = routed.adapter.setSessionInputQueueMode;
    if (setInputQueueMode === undefined) {
      return yield* new ProviderUnsupportedError({ provider: routed.adapter.provider });
    }
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "set-session-input-queue-mode",
      "provider.kind": routed.adapter.provider,
      "provider.instance_id": routed.instanceId,
      "provider.thread_id": input.threadId,
      "provider.input_queue_kind": input.queue,
      "provider.input_queue_mode": input.mode,
    });
    return yield* setInputQueueMode({ ...input, threadId: routed.threadId });
  });

  const getSessionCompaction: ProviderServiceMethod<"getSessionCompaction"> = Effect.fn(
    "getSessionCompaction",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.getSessionCompaction",
      schema: ProviderGetSessionCompactionInput,
      payload: rawInput,
    });
    const routed = yield* resolveRoutableSession({
      threadId: input.threadId,
      operation: "ProviderService.getSessionCompaction",
      allowRecovery: false,
    });
    if (!routed.isActive) {
      return yield* toValidationError(
        "ProviderService.getSessionCompaction",
        `Thread '${input.threadId}' does not have an active provider session.`,
      );
    }
    const getCompaction = routed.adapter.getSessionCompaction;
    if (getCompaction === undefined) {
      return yield* new ProviderUnsupportedError({ provider: routed.adapter.provider });
    }
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "get-session-compaction",
      "provider.kind": routed.adapter.provider,
      "provider.instance_id": routed.instanceId,
      "provider.thread_id": input.threadId,
    });
    return yield* getCompaction(routed.threadId);
  });

  const compactSession: ProviderServiceMethod<"compactSession"> = Effect.fn("compactSession")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.compactSession",
        schema: ProviderCompactSessionInput,
        payload: rawInput,
      });
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.compactSession",
        allowRecovery: false,
      });
      if (!routed.isActive) {
        return yield* toValidationError(
          "ProviderService.compactSession",
          `Thread '${input.threadId}' does not have an active provider session.`,
        );
      }
      const compact = routed.adapter.compactSession;
      if (compact === undefined) {
        return yield* new ProviderUnsupportedError({ provider: routed.adapter.provider });
      }
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "compact-session",
        "provider.kind": routed.adapter.provider,
        "provider.instance_id": routed.instanceId,
        "provider.thread_id": input.threadId,
      });
      return yield* compact(routed.threadId);
    },
  );

  const abortSessionCompaction: ProviderServiceMethod<"abortSessionCompaction"> = Effect.fn(
    "abortSessionCompaction",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.abortSessionCompaction",
      schema: ProviderAbortSessionCompactionInput,
      payload: rawInput,
    });
    const routed = yield* resolveRoutableSession({
      threadId: input.threadId,
      operation: "ProviderService.abortSessionCompaction",
      allowRecovery: false,
    });
    if (!routed.isActive) {
      return yield* toValidationError(
        "ProviderService.abortSessionCompaction",
        `Thread '${input.threadId}' does not have an active provider session.`,
      );
    }
    const abortCompaction = routed.adapter.abortSessionCompaction;
    if (abortCompaction === undefined) {
      return yield* new ProviderUnsupportedError({ provider: routed.adapter.provider });
    }
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "abort-session-compaction",
      "provider.kind": routed.adapter.provider,
      "provider.instance_id": routed.instanceId,
      "provider.thread_id": input.threadId,
    });
    return yield* abortCompaction(routed.threadId);
  });

  const setSessionAutoCompaction: ProviderServiceMethod<"setSessionAutoCompaction"> = Effect.fn(
    "setSessionAutoCompaction",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.setSessionAutoCompaction",
      schema: ProviderSetSessionAutoCompactionInput,
      payload: rawInput,
    });
    const routed = yield* resolveRoutableSession({
      threadId: input.threadId,
      operation: "ProviderService.setSessionAutoCompaction",
      allowRecovery: false,
    });
    if (!routed.isActive) {
      return yield* toValidationError(
        "ProviderService.setSessionAutoCompaction",
        `Thread '${input.threadId}' does not have an active provider session.`,
      );
    }
    const setAutoCompaction = routed.adapter.setSessionAutoCompaction;
    if (setAutoCompaction === undefined) {
      return yield* new ProviderUnsupportedError({ provider: routed.adapter.provider });
    }
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "set-session-auto-compaction",
      "provider.kind": routed.adapter.provider,
      "provider.instance_id": routed.instanceId,
      "provider.thread_id": input.threadId,
      "provider.auto_compaction_enabled": input.enabled,
    });
    return yield* setAutoCompaction({ ...input, threadId: routed.threadId });
  });

  const refineSessionHarness: ProviderServiceMethod<"refineSessionHarness"> = Effect.fn(
    "refineSessionHarness",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.refineSessionHarness",
      schema: ProviderRefineSessionHarnessInput,
      payload: rawInput,
    });
    const routed = yield* resolveRoutableSession({
      threadId: input.threadId,
      operation: "ProviderService.refineSessionHarness",
      allowRecovery: false,
    });
    if (!routed.isActive) {
      return yield* toValidationError(
        "ProviderService.refineSessionHarness",
        `Thread '${input.threadId}' does not have an active provider session.`,
      );
    }
    const refine = routed.adapter.refineSessionHarness;
    if (refine === undefined) {
      return yield* new ProviderUnsupportedError({ provider: routed.adapter.provider });
    }
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "refine-session-harness",
      "provider.kind": routed.adapter.provider,
      "provider.instance_id": routed.instanceId,
      "provider.thread_id": input.threadId,
    });
    return yield* refine(routed.threadId);
  });

  const stopSession: ProviderServiceMethod<"stopSession"> = Effect.fn("stopSession")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.stopSession",
        schema: ProviderStopSessionInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      // Invalidate before the first directory read. A first-turn start can be
      // inside adapter creation without having a persisted binding yet; stop
      // must still win that race and let the late start quarantine itself.
      if (input.invalidateStartReservation !== false) {
        yield* invalidateStartSession(input.threadId);
      }
      const activeAdmission = activeTurnAdmissions.get(input.threadId);
      if (
        input.expectedAdmissionRequestId === undefined ||
        (input.expectedAdmissionRequestId !== null &&
          activeAdmission?.requestId === input.expectedAdmissionRequestId)
      ) {
        activeTurnAdmissions.delete(input.threadId);
      }

      const targetIsExact =
        input.expectedProviderInstanceId !== undefined ||
        input.expectedSessionIncarnationId !== undefined;
      const binding = Option.getOrUndefined(yield* directory.getBinding(input.threadId));
      const currentIncarnation = currentSessionIncarnations.get(input.threadId);
      const persistedIncarnationId =
        binding === undefined
          ? undefined
          : readRuntimePayloadString(binding.runtimePayload, "sessionIncarnationId");
      const instanceMatches =
        input.expectedProviderInstanceId === undefined ||
        (input.expectedProviderInstanceId === null
          ? binding === undefined && currentIncarnation === undefined
          : (binding?.providerInstanceId ?? currentIncarnation?.instanceId) ===
            input.expectedProviderInstanceId);
      const incarnationMatches =
        input.expectedSessionIncarnationId === undefined ||
        (input.expectedSessionIncarnationId === null
          ? persistedIncarnationId === undefined && currentIncarnation === undefined
          : (persistedIncarnationId ?? currentIncarnation?.id) ===
            input.expectedSessionIncarnationId);
      if (!instanceMatches || !incarnationMatches) {
        return;
      }

      if (binding === undefined) {
        // A target with no directory row can only be an in-flight start. Its
        // reservation was invalidated above; if the exact adapter incarnation
        // is already known, stop it now as well.
        if (
          targetIsExact &&
          input.expectedProviderInstanceId != null &&
          input.expectedSessionIncarnationId != null &&
          currentIncarnation !== undefined
        ) {
          metricProvider = currentIncarnation.adapter.provider;
          yield* currentIncarnation.adapter.stopSession(input.threadId).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("provider.session.stop-exact-unbound-failed", {
                threadId: input.threadId,
                provider: currentIncarnation.adapter.provider,
                cause,
              }),
            ),
          );
        }
        if (
          !targetIsExact ||
          currentSessionIncarnations.get(input.threadId) === currentIncarnation
        ) {
          yield* clearMcpSession(input.threadId);
          currentSessionIncarnations.delete(input.threadId);
        }
        return;
      }

      return yield* Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.stopSession",
          allowRecovery: false,
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "stop-session",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
          ...(input.expectedSessionIncarnationId
            ? { "provider.session_incarnation_id": input.expectedSessionIncarnationId }
            : {}),
        });
        if (routed.isActive) {
          yield* routed.adapter
            .stopSession(routed.threadId)
            .pipe(Effect.ensuring(clearMcpSession(input.threadId)));
          // The adapter may hand off its sole stamped session.exited event through
          // an asynchronous relay after stopSession returns. Keep this exact
          // incarnation routable until processRuntimeEvent ingests that exit. A
          // later start safely replaces the map entry before its adapter starts.
        } else if (
          !targetIsExact ||
          (currentIncarnation !== undefined &&
            currentSessionIncarnations.get(input.threadId) === currentIncarnation)
        ) {
          currentSessionIncarnations.delete(input.threadId);
        }
        yield* clearMcpSession(input.threadId);

        const latestBinding = Option.getOrUndefined(yield* directory.getBinding(input.threadId));
        const latestIncarnationId =
          latestBinding === undefined
            ? undefined
            : readRuntimePayloadString(latestBinding.runtimePayload, "sessionIncarnationId");
        const latestIsTarget =
          latestBinding !== undefined &&
          (input.expectedProviderInstanceId === undefined ||
            latestBinding.providerInstanceId === input.expectedProviderInstanceId) &&
          (input.expectedSessionIncarnationId === undefined ||
            latestIncarnationId === input.expectedSessionIncarnationId);
        if (input.removeBinding === true) {
          if (
            latestIsTarget &&
            input.expectedProviderInstanceId != null &&
            input.expectedSessionIncarnationId != null
          ) {
            yield* directory.removeExact({
              threadId: input.threadId,
              providerInstanceId: input.expectedProviderInstanceId,
              sessionIncarnationId: input.expectedSessionIncarnationId,
            });
          }
        } else if (!targetIsExact || latestIsTarget) {
          yield* directory.upsert({
            threadId: input.threadId,
            provider: routed.adapter.provider,
            providerInstanceId: routed.instanceId,
            status: "stopped",
            runtimePayload: {
              activeTurnId: null,
            },
          });
        }
        yield* analytics.record("provider.session.stopped", {
          provider: routed.adapter.provider,
        });
      }).pipe(
        withMetrics({
          counter: providerSessionsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "stop",
            }),
        }),
      );
    },
  );

  const listSessionsForInstance = Effect.fn("listSessionsForInstance")(function* (
    instanceId: ProviderInstanceId,
  ) {
    const adapter = yield* registry.getByInstance(instanceId);
    const sessions = yield* adapter.listSessions();
    return yield* Effect.forEach(
      sessions,
      (session) =>
        Effect.gen(function* () {
          const binding = Option.getOrUndefined(yield* directory.getBinding(session.threadId));
          const currentIncarnation = currentSessionIncarnations.get(session.threadId);
          const persistedIncarnationId =
            binding?.providerInstanceId === instanceId
              ? readRuntimePayloadString(binding.runtimePayload, "sessionIncarnationId")
              : undefined;
          const sessionIncarnationId =
            session.sessionIncarnationId ??
            (currentIncarnation?.instanceId === instanceId ? currentIncarnation.id : undefined) ??
            (persistedIncarnationId === undefined
              ? undefined
              : RuntimeSessionId.make(persistedIncarnationId));
          const activeAdmission = activeTurnAdmissions.get(session.threadId);
          const persistedRequestId =
            binding?.providerInstanceId === instanceId &&
            session.status === "running" &&
            (persistedIncarnationId === undefined ||
              sessionIncarnationId === RuntimeSessionId.make(persistedIncarnationId))
              ? (readRuntimePayloadString(binding.runtimePayload, "activeTurnRequestId") ??
                readRuntimePayloadString(binding.runtimePayload, "admissionRequestId"))
              : undefined;
          return {
            ...session,
            providerInstanceId: instanceId,
            ...(sessionIncarnationId === undefined ? {} : { sessionIncarnationId }),
            ...(activeAdmission !== undefined &&
            activeAdmission.sessionIncarnationId === sessionIncarnationId
              ? { activeTurnRequestId: activeAdmission.requestId }
              : persistedRequestId === undefined
                ? {}
                : { activeTurnRequestId: CommandId.make(persistedRequestId) }),
          };
        }),
      { concurrency: "unbounded" },
    );
  });

  const getSessionContinuation: NonNullable<
    ProviderService.ProviderServiceShape["getSessionContinuation"]
  > = Effect.fn("getSessionContinuation")(function* (threadId) {
    const binding = Option.getOrUndefined(yield* directory.getBinding(threadId));
    if (binding?.resumeCursor === undefined || binding.resumeCursor === null) return null;
    return {
      providerInstanceId: yield* requireBindingInstanceId(
        "ProviderService.getSessionContinuation",
        binding,
      ),
      resumeCursor: binding.resumeCursor,
    };
  });

  const listSessions: ProviderServiceMethod<"listSessions"> = Effect.fn("listSessions")(
    function* () {
      const currentAdapters = yield* getAdapterEntries;
      const sessionsByProvider = yield* Effect.forEach(currentAdapters, ([instanceId, adapter]) =>
        adapter.listSessions().pipe(
          Effect.map((sessions) =>
            sessions.map((session) => ({
              ...session,
              providerInstanceId: instanceId,
            })),
          ),
        ),
      );
      const activeSessions = sessionsByProvider.flatMap((sessions) => sessions);
      const persistedBindings = yield* directory.listThreadIds().pipe(
        Effect.flatMap((threadIds) =>
          Effect.forEach(
            threadIds,
            (threadId) =>
              directory
                .getBinding(threadId)
                .pipe(
                  Effect.orElseSucceed(() =>
                    Option.none<ProviderSessionDirectory.ProviderRuntimeBinding>(),
                  ),
                ),
            { concurrency: "unbounded" },
          ),
        ),
        Effect.orElseSucceed(
          () => [] as Array<Option.Option<ProviderSessionDirectory.ProviderRuntimeBinding>>,
        ),
      );
      const bindingsByThreadId = new Map<
        ThreadId,
        ProviderSessionDirectory.ProviderRuntimeBinding
      >();
      for (const bindingOption of persistedBindings) {
        const binding = Option.getOrUndefined(bindingOption);
        if (binding) {
          bindingsByThreadId.set(binding.threadId, binding);
        }
      }

      const sessions: ProviderSession[] = [];
      for (const session of activeSessions) {
        const binding = bindingsByThreadId.get(session.threadId);
        if (!binding) {
          sessions.push(session);
          continue;
        }

        const overrides: {
          resumeCursor?: ProviderSession["resumeCursor"];
          runtimeMode?: ProviderSession["runtimeMode"];
          providerInstanceId?: ProviderSession["providerInstanceId"];
          activeTurnRequestId?: ProviderSession["activeTurnRequestId"];
          sessionIncarnationId?: ProviderSession["sessionIncarnationId"];
        } = {};
        overrides.providerInstanceId = dieOnMissingBindingInstanceId(
          "ProviderService.listSessions",
          binding,
        );
        if (binding.provider !== session.provider) {
          return yield* Effect.die(
            new Error(
              `ProviderService.listSessions: thread '${session.threadId}' is active on provider '${session.provider}' but persisted binding names provider '${binding.provider}'.`,
            ),
          );
        }
        if (overrides.providerInstanceId !== session.providerInstanceId) {
          return yield* Effect.die(
            new Error(
              `ProviderService.listSessions: thread '${session.threadId}' is active on provider instance '${session.providerInstanceId}' but persisted binding names '${overrides.providerInstanceId}'.`,
            ),
          );
        }
        if (session.resumeCursor === undefined && binding.resumeCursor !== undefined) {
          overrides.resumeCursor = binding.resumeCursor;
        }
        if (binding.runtimeMode !== undefined) {
          overrides.runtimeMode = binding.runtimeMode;
        }
        const incarnation = currentSessionIncarnations.get(session.threadId);
        if (incarnation?.instanceId === session.providerInstanceId) {
          overrides.sessionIncarnationId = incarnation.id;
        }
        const activeAdmission = activeTurnAdmissions.get(session.threadId);
        const persistedRequestId =
          readRuntimePayloadString(binding.runtimePayload, "activeTurnRequestId") ??
          (session.status === "running"
            ? readRuntimePayloadString(binding.runtimePayload, "admissionRequestId")
            : undefined);
        if (activeAdmission !== undefined) {
          overrides.activeTurnRequestId = activeAdmission.requestId;
        } else if (persistedRequestId !== undefined) {
          overrides.activeTurnRequestId = CommandId.make(persistedRequestId);
        }
        sessions.push(Object.assign({}, session, overrides));
      }
      return sessions;
    },
  );

  const releaseProviderMaintenance: ProviderServiceMethod<"releaseProviderMaintenance"> = (
    reservation,
  ) =>
    SynchronizedRef.update(instanceMaintenanceState, (current) => {
      const entry = [...current.entries()].find(
        ([, state]) => state.fenceToken === reservation.token,
      );
      if (!entry) return current;
      const [instanceId, state] = entry;
      const next = new Map(current);
      if (state.pendingStarts === 0) next.delete(instanceId);
      else next.set(instanceId, { pendingStarts: state.pendingStarts });
      return next;
    });

  const reserveProviderMaintenance: ProviderServiceMethod<"reserveProviderMaintenance"> = Effect.fn(
    "reserveProviderMaintenance",
  )(function* (instanceId) {
    const token = NodeCrypto.randomUUID();
    const fenced = yield* SynchronizedRef.modify(instanceMaintenanceState, (current) => {
      const state = current.get(instanceId) ?? { pendingStarts: 0 };
      if (state.fenceToken !== undefined || state.pendingStarts > 0) {
        return [false, current] as const;
      }
      const next = new Map(current);
      next.set(instanceId, { pendingStarts: 0, fenceToken: token });
      return [true, next] as const;
    });
    if (!fenced) {
      return {
        status: "busy",
        reasons: ["a provider session start or another maintenance reservation is pending"],
      } as const;
    }
    const reservation = { token };
    const sessions = yield* listSessionsForInstance(instanceId).pipe(
      Effect.onError(() => releaseProviderMaintenance(reservation)),
    );
    const activeIncarnation = [...currentSessionIncarnations.values()].some(
      (incarnation) => incarnation.instanceId === instanceId,
    );
    if (sessions.length > 0 || activeIncarnation) {
      yield* releaseProviderMaintenance(reservation);
      return {
        status: "busy",
        reasons: [
          sessions.some((session) => session.activeTurnId !== undefined)
            ? "an active or admitted provider turn exists"
            : "an active provider session or owned runtime exists",
        ],
      } as const;
    }
    return { status: "reserved", reservation } as const;
  });

  const getCapabilities: ProviderServiceMethod<"getCapabilities"> = (instanceId) =>
    registry.getByInstance(instanceId).pipe(Effect.map((adapter) => adapter.capabilities));

  const getInstanceInfo: ProviderServiceMethod<"getInstanceInfo"> = (instanceId) =>
    registry.getInstanceInfo(instanceId);

  const rollbackConversation: ProviderServiceMethod<"rollbackConversation"> = Effect.fn(
    "rollbackConversation",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.rollbackConversation",
      schema: ProviderRollbackConversationInput,
      payload: rawInput,
    });
    if (input.numTurns === 0) {
      return;
    }
    let metricProvider = "unknown";
    return yield* Effect.gen(function* () {
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.rollbackConversation",
        allowRecovery: true,
      });
      metricProvider = routed.adapter.provider;
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "rollback-conversation",
        "provider.kind": routed.adapter.provider,
        "provider.thread_id": input.threadId,
        "provider.rollback_turns": input.numTurns,
      });
      yield* routed.adapter.rollbackThread(routed.threadId, input.numTurns);
      yield* analytics.record("provider.conversation.rolled_back", {
        provider: routed.adapter.provider,
        turns: input.numTurns,
      });
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        outcomeAttributes: () =>
          providerMetricAttributes(metricProvider, {
            operation: "rollback",
          }),
      }),
    );
  });

  const uploadFeedback: ProviderServiceMethod<"uploadFeedback"> = Effect.fn("uploadFeedback")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.uploadFeedback",
        schema: ProviderUploadFeedbackInput,
        payload: rawInput,
      });
      let routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.uploadFeedback",
        allowRecovery: false,
      });
      if (routed.adapter.uploadFeedback === undefined) {
        return yield* toValidationError(
          "ProviderService.uploadFeedback",
          `Provider '${routed.adapter.provider}' does not support feedback uploads.`,
        );
      }
      if (!routed.isActive) {
        routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.uploadFeedback",
          allowRecovery: true,
        });
      }
      const uploadFeedback = routed.adapter.uploadFeedback;
      if (uploadFeedback === undefined) {
        return yield* toValidationError(
          "ProviderService.uploadFeedback",
          `Provider '${routed.adapter.provider}' does not support feedback uploads.`,
        );
      }
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "upload-feedback",
        "provider.kind": routed.adapter.provider,
        "provider.thread_id": input.threadId,
      });
      return yield* uploadFeedback(input);
    },
  );

  const runStopAll = Effect.fn("runStopAll")(function* () {
    const threadIds = yield* directory.listThreadIds();
    const currentAdapters = yield* getAdapterEntries;
    const activeSessions = yield* Effect.forEach(currentAdapters, ([instanceId, adapter]) =>
      adapter.listSessions().pipe(
        Effect.map((sessions) =>
          sessions.map((session) => ({
            ...session,
            providerInstanceId: instanceId,
          })),
        ),
      ),
    ).pipe(Effect.map((sessionsByAdapter) => sessionsByAdapter.flatMap((sessions) => sessions)));
    yield* Effect.forEach(activeSessions, (session) =>
      Effect.flatMap(nowIso, (lastRuntimeEventAt) =>
        upsertSessionBinding(session, session.threadId, {
          lastRuntimeEvent: "provider.stopAll",
          lastRuntimeEventAt,
        }),
      ),
    ).pipe(Effect.asVoid);
    yield* Effect.forEach(currentAdapters, ([, adapter]) => adapter.stopAll()).pipe(
      Effect.asVoid,
      Effect.ensuring(clearAllMcpSessions),
    );
    const bindings = yield* directory.listBindings().pipe(Effect.orElseSucceed(() => []));
    yield* Effect.forEach(bindings, (binding) =>
      Effect.gen(function* () {
        const providerInstanceId = dieOnMissingBindingInstanceId(
          "ProviderService.stopAll",
          binding,
        );
        return yield* directory.upsert({
          threadId: binding.threadId,
          provider: binding.provider,
          providerInstanceId,
          status: "stopped",
          runtimePayload: {
            activeTurnId: null,
            lastRuntimeEvent: "provider.stopAll",
            lastRuntimeEventAt: yield* nowIso,
          },
        });
      }),
    ).pipe(Effect.asVoid);
    yield* analytics.record("provider.sessions.stopped_all", {
      sessionCount: threadIds.length,
    });
    yield* analytics.flush;
  });

  const runShutdown = Effect.fn("runShutdown")(function* () {
    const currentAdapters = yield* getAdapterEntries;
    if (currentAdapters.every(([, adapter]) => adapter.shutdown === undefined)) {
      return yield* runStopAll();
    }
    const bindings = yield* directory.listBindings().pipe(Effect.orElseSucceed(() => []));
    yield* Effect.forEach(
      currentAdapters,
      ([instanceId, adapter]) =>
        adapter.shutdown !== undefined
          ? adapter.shutdown()
          : Effect.gen(function* () {
              const activeSessions = yield* adapter.listSessions();
              yield* Effect.forEach(activeSessions, (session) =>
                Effect.flatMap(nowIso, (lastRuntimeEventAt) =>
                  upsertSessionBinding(
                    { ...session, providerInstanceId: instanceId },
                    session.threadId,
                    {
                      lastRuntimeEvent: "provider.stopAll",
                      lastRuntimeEventAt,
                    },
                  ),
                ),
              );
              yield* adapter.stopAll().pipe(
                Effect.ensuring(
                  Effect.forEach(activeSessions, (session) => clearMcpSession(session.threadId), {
                    discard: true,
                  }),
                ),
              );
              yield* Effect.forEach(
                bindings.filter((binding) => binding.providerInstanceId === instanceId),
                (binding) =>
                  Effect.flatMap(nowIso, (lastRuntimeEventAt) =>
                    directory.upsert({
                      threadId: binding.threadId,
                      provider: binding.provider,
                      providerInstanceId: instanceId,
                      status: "stopped",
                      runtimePayload: {
                        activeTurnId: null,
                        lastRuntimeEvent: "provider.stopAll",
                        lastRuntimeEventAt,
                      },
                    }),
                  ),
                { discard: true },
              );
            }),
      { concurrency: "unbounded", discard: true },
    );
  });

  yield* Effect.addFinalizer(() =>
    runShutdown().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to stop provider service", {
          errorTag: causeErrorTag(cause),
        }),
      ),
    ),
  );

  return {
    startSession,
    sendTurn,
    recoverRestartSessions,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    respondToInteraction,
    reloadSessionResources,
    askSessionSideQuestion,
    cancelSessionSideQuestion,
    cancelSessionAgent,
    messageSessionAgent,
    watchSessionAgentActivity,
    getSessionAgentDepth,
    setSessionAgentDepth,
    followUp,
    getSessionInputQueue,
    clearSessionInputQueue,
    removeOnlySessionInputQueueItem,
    setSessionInputQueueMode,
    getSessionCompaction,
    compactSession,
    abortSessionCompaction,
    setSessionAutoCompaction,
    refineSessionHarness,
    stopSession,
    listSessions,
    getSessionContinuation,
    listSessionsForInstance,
    reserveProviderMaintenance,
    releaseProviderMaintenance,
    getCapabilities,
    getInstanceInfo,
    rollbackConversation,
    uploadFeedback,
    // Each access creates a fresh PubSub subscription so that multiple
    // consumers (ProviderRuntimeIngestion, CheckpointReactor, etc.) each
    // independently receive all runtime events.
    get streamEvents(): ProviderServiceMethod<"streamEvents"> {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  } satisfies ProviderService.ProviderService["Service"];
});

export const ProviderServiceLive = Layer.effect(
  ProviderService.ProviderService,
  makeProviderService(),
);

export function makeProviderServiceLive(options?: ProviderServiceLiveOptions) {
  return Layer.effect(ProviderService.ProviderService, makeProviderService(options));
}
