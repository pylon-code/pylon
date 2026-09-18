import * as NodeCrypto from "node:crypto";
import {
  CommandId,
  EventId,
  type OrchestrationThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import {
  DELEGATION_OBSERVED_ACTIVITY_KIND,
  consumedDelegationObservation,
  delegationObservationReceipt,
} from "./delegationFollowThrough.logic.ts";

const sha256Hex = (text: string): string =>
  NodeCrypto.createHash("sha256").update(text).digest("hex");

export const markDelegationObservationConsumed = (input: {
  readonly parentId: ThreadId;
  readonly child: OrchestrationThreadShell;
}) =>
  Effect.gen(function* () {
    const observation = consumedDelegationObservation(input.child);
    if (observation === null) return;

    const engine = yield* OrchestrationEngine.OrchestrationEngineService;

    const noticeDigest = sha256Hex(observation.noticeKey);
    const commandDigest = sha256Hex(`${input.child.id}:${observation.noticeKey}`);
    const receipt = delegationObservationReceipt({
      observation,
      noticeDigest,
      baseline: true,
    });
    const now = DateTime.formatIso(yield* DateTime.now);

    yield* engine.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.make(`delegation-consumed:${commandDigest}`),
      threadId: input.parentId,
      activity: {
        id: EventId.make(receipt.activityId),
        kind: DELEGATION_OBSERVED_ACTIVITY_KIND,
        tone: "info",
        summary: `Pylon child ${observation.phase}`,
        payload: receipt.payload,
        turnId: null,
        createdAt: now,
      },
      createdAt: now,
    });
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("markDelegationObservationConsumed failed", { cause }),
    ),
  );
