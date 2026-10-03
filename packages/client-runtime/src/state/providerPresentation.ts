import {
  IsoDateTime,
  ProviderDriverKind,
  ProviderInstanceId,
  SessionAgentDepthUpdatedPayload,
  SessionCompactionUpdatedPayload,
  SessionGoalUpdatedPayload,
  SessionInputQueueUpdatedPayload,
  SessionResourcesUpdatedPayload,
  type TurnId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/** Pure presentation input for Pylon provider metadata; this is not an orchestration wire type. */
export interface ProviderPresentationActivity {
  readonly id: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly createdAt: string;
  readonly tone: string;
  readonly summary: string;
  readonly turnId: TurnId | null;
  readonly sequence?: number;
}

const providerFields = {
  provider: ProviderDriverKind,
  providerInstanceId: Schema.optional(ProviderInstanceId),
};
export const SessionResourcesPresentation = Schema.Struct({
  ...SessionResourcesUpdatedPayload.fields,
  ...providerFields,
});
export type SessionResourcesPresentation = typeof SessionResourcesPresentation.Type;
export const SessionAgentDepthPresentation = Schema.Struct({
  ...SessionAgentDepthUpdatedPayload.fields,
  ...providerFields,
});
export type SessionAgentDepthPresentation = typeof SessionAgentDepthPresentation.Type;
export const SessionInputQueuePresentation = Schema.Struct({
  ...SessionInputQueueUpdatedPayload.fields,
  ...providerFields,
});
export type SessionInputQueuePresentation = typeof SessionInputQueuePresentation.Type;
export const SessionCompactionPresentation = Schema.Struct({
  ...SessionCompactionUpdatedPayload.fields,
  ...providerFields,
  runStartedAt: Schema.optional(IsoDateTime),
});
export type SessionCompactionPresentation = typeof SessionCompactionPresentation.Type;
export const SessionGoalPresentation = Schema.Struct({
  ...SessionGoalUpdatedPayload.fields,
  ...providerFields,
});
export type SessionGoalPresentation = typeof SessionGoalPresentation.Type;

const ProviderPresentation = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("session.resources.updated"),
    payload: SessionResourcesPresentation,
    createdAt: IsoDateTime,
  }),
  Schema.Struct({
    kind: Schema.Literal("session.agent-depth.updated"),
    payload: SessionAgentDepthPresentation,
    createdAt: IsoDateTime,
  }),
  Schema.Struct({
    kind: Schema.Literal("session.input-queue.updated"),
    payload: SessionInputQueuePresentation,
    createdAt: IsoDateTime,
  }),
  Schema.Struct({
    kind: Schema.Literal("session.compaction.updated"),
    payload: SessionCompactionPresentation,
    createdAt: IsoDateTime,
  }),
  Schema.Struct({
    kind: Schema.Literal("session.goal.updated"),
    payload: SessionGoalPresentation,
    createdAt: IsoDateTime,
  }),
]);
export const decodeProviderPresentation = Schema.decodeUnknownOption(ProviderPresentation);
