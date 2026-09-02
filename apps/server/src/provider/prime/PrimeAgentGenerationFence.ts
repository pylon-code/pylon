import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { ProviderAdapterRequestError, type ProviderAdapterError } from "../Errors.ts";
import type { ProviderRuntimeFence } from "../ProviderDriver.ts";
import type { PrimeAgentAdapterShape } from "../Services/PrimeAgentAdapter.ts";

const PROVIDER = ProviderDriverKind.make("primeAgent");

export const stalePrimeAgentGenerationError = (method: string) =>
  new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: "This Prime Agent runtime generation was replaced.",
    reason: "stale",
  });

export const requirePrimeAgentGeneration = (
  fence: ProviderRuntimeFence | undefined,
  method: string,
): Effect.Effect<void, ProviderAdapterRequestError> =>
  fence === undefined
    ? Effect.void
    : fence.isCurrent.pipe(
        Effect.flatMap((current) =>
          current ? Effect.void : Effect.fail(stalePrimeAgentGenerationError(method)),
        ),
      );

/** Fence every public Prime operation while leaving owner-scoped teardown able to finish. */
export function fencePrimeAgentAdapter(
  adapter: PrimeAgentAdapterShape,
  runtimeFence: ProviderRuntimeFence,
): PrimeAgentAdapterShape {
  const fenced = <A>(method: string, effect: Effect.Effect<A, ProviderAdapterError>) =>
    requirePrimeAgentGeneration(runtimeFence, method).pipe(
      Effect.andThen(effect),
      Effect.tap(() => requirePrimeAgentGeneration(runtimeFence, method)),
    );

  return {
    ...adapter,
    runtimeFence,
    startSession: (input) => fenced("startSession", adapter.startSession(input)),
    sendTurn: (input) => fenced("sendTurn", adapter.sendTurn(input)),
    ...(adapter.prepareTurnRecovery === undefined
      ? {}
      : {
          prepareTurnRecovery: (input) =>
            fenced("prepareTurnRecovery", adapter.prepareTurnRecovery!(input)),
        }),
    ...(adapter.recoverSession === undefined
      ? {}
      : { recoverSession: (input) => fenced("recoverSession", adapter.recoverSession!(input)) }),
    ...(adapter.activateRecoveredSession === undefined
      ? {}
      : {
          activateRecoveredSession: (threadId) =>
            fenced("activateRecoveredSession", adapter.activateRecoveredSession!(threadId)),
        }),
    interruptTurn: (threadId, turnId) =>
      fenced("interruptTurn", adapter.interruptTurn(threadId, turnId)),
    respondToRequest: (threadId, requestId, decision) =>
      fenced("respondToRequest", adapter.respondToRequest(threadId, requestId, decision)),
    respondToUserInput: (threadId, requestId, answers) =>
      fenced("respondToUserInput", adapter.respondToUserInput(threadId, requestId, answers)),
    ...(adapter.respondToInteraction === undefined
      ? {}
      : {
          respondToInteraction: (threadId, requestId, response) =>
            fenced(
              "respondToInteraction",
              adapter.respondToInteraction!(threadId, requestId, response),
            ),
        }),
    ...(adapter.reloadSessionResources === undefined
      ? {}
      : {
          reloadSessionResources: (threadId) =>
            fenced("reloadSessionResources", adapter.reloadSessionResources!(threadId)),
        }),
    ...(adapter.askSessionSideQuestion === undefined
      ? {}
      : {
          askSessionSideQuestion: (threadId, requestId, question) =>
            fenced(
              "askSessionSideQuestion",
              adapter.askSessionSideQuestion!(threadId, requestId, question),
            ),
        }),
    ...(adapter.cancelSessionSideQuestion === undefined
      ? {}
      : {
          cancelSessionSideQuestion: (threadId, requestId) =>
            fenced(
              "cancelSessionSideQuestion",
              adapter.cancelSessionSideQuestion!(threadId, requestId),
            ),
        }),
    ...(adapter.cancelSessionAgent === undefined
      ? {}
      : {
          cancelSessionAgent: (threadId, agentId) =>
            fenced("cancelSessionAgent", adapter.cancelSessionAgent!(threadId, agentId)),
        }),
    ...(adapter.messageSessionAgent === undefined
      ? {}
      : {
          messageSessionAgent: (threadId, agentId, message) =>
            fenced("messageSessionAgent", adapter.messageSessionAgent!(threadId, agentId, message)),
        }),
    ...(adapter.watchSessionAgentActivity === undefined
      ? {}
      : {
          watchSessionAgentActivity: (threadId, agentId) =>
            adapter.watchSessionAgentActivity!(threadId, agentId).pipe(
              Stream.filterEffect(() => runtimeFence.isCurrent),
            ),
        }),
    ...(adapter.getSessionAgentDepth === undefined
      ? {}
      : {
          getSessionAgentDepth: (threadId) =>
            fenced("getSessionAgentDepth", adapter.getSessionAgentDepth!(threadId)),
        }),
    ...(adapter.setSessionAgentDepth === undefined
      ? {}
      : {
          setSessionAgentDepth: (threadId, maxDepth) =>
            fenced("setSessionAgentDepth", adapter.setSessionAgentDepth!(threadId, maxDepth)),
        }),
    ...(adapter.followUp === undefined
      ? {}
      : { followUp: (input) => fenced("followUp", adapter.followUp!(input)) }),
    ...(adapter.getSessionInputQueue === undefined
      ? {}
      : {
          getSessionInputQueue: (threadId) =>
            fenced("getSessionInputQueue", adapter.getSessionInputQueue!(threadId)),
        }),
    ...(adapter.clearSessionInputQueue === undefined
      ? {}
      : {
          clearSessionInputQueue: (threadId) =>
            fenced("clearSessionInputQueue", adapter.clearSessionInputQueue!(threadId)),
        }),
    ...(adapter.removeOnlySessionInputQueueItem === undefined
      ? {}
      : {
          removeOnlySessionInputQueueItem: (input) =>
            fenced(
              "removeOnlySessionInputQueueItem",
              adapter.removeOnlySessionInputQueueItem!(input),
            ),
        }),
    ...(adapter.setSessionInputQueueMode === undefined
      ? {}
      : {
          setSessionInputQueueMode: (input) =>
            fenced("setSessionInputQueueMode", adapter.setSessionInputQueueMode!(input)),
        }),
    ...(adapter.getSessionCompaction === undefined
      ? {}
      : {
          getSessionCompaction: (threadId) =>
            fenced("getSessionCompaction", adapter.getSessionCompaction!(threadId)),
        }),
    ...(adapter.compactSession === undefined
      ? {}
      : {
          compactSession: (threadId) => fenced("compactSession", adapter.compactSession!(threadId)),
        }),
    ...(adapter.abortSessionCompaction === undefined
      ? {}
      : {
          abortSessionCompaction: (threadId) =>
            fenced("abortSessionCompaction", adapter.abortSessionCompaction!(threadId)),
        }),
    ...(adapter.setSessionAutoCompaction === undefined
      ? {}
      : {
          setSessionAutoCompaction: (input) =>
            fenced("setSessionAutoCompaction", adapter.setSessionAutoCompaction!(input)),
        }),
    ...(adapter.refineSessionHarness === undefined
      ? {}
      : {
          refineSessionHarness: (threadId) =>
            fenced("refineSessionHarness", adapter.refineSessionHarness!(threadId)),
        }),
    readThread: (threadId) => fenced("readThread", adapter.readThread(threadId)),
    rollbackThread: (threadId, numTurns) =>
      fenced("rollbackThread", adapter.rollbackThread(threadId, numTurns)),
    ...(adapter.uploadFeedback === undefined
      ? {}
      : {
          uploadFeedback: (input) => fenced("uploadFeedback", adapter.uploadFeedback!(input)),
        }),
    listSessions: () =>
      runtimeFence.isCurrent.pipe(
        Effect.flatMap((current) =>
          current
            ? adapter
                .listSessions()
                .pipe(
                  Effect.flatMap((sessions) =>
                    Effect.map(runtimeFence.isCurrent, (stillCurrent) =>
                      stillCurrent ? sessions : [],
                    ),
                  ),
                )
            : Effect.succeed([]),
        ),
      ),
    hasSession: (threadId) =>
      runtimeFence.isCurrent.pipe(
        Effect.flatMap((current) =>
          current
            ? adapter
                .hasSession(threadId)
                .pipe(
                  Effect.flatMap((hasSession) =>
                    Effect.map(runtimeFence.isCurrent, (stillCurrent) =>
                      stillCurrent ? hasSession : false,
                    ),
                  ),
                )
            : Effect.succeed(false),
        ),
      ),
    streamEvents: adapter.streamEvents.pipe(Stream.filterEffect(() => runtimeFence.isCurrent)),
  };
}
