import type {
  FollowUp,
  FollowUpEventPayload,
  FollowUpEventType,
  FollowUpFileInput,
  FollowUpOperationError,
  FollowUpSnapshot,
  FollowUpUpdateStatusInput,
} from "@t3tools/contracts";
import { FollowUpOperationError as FollowUpOperationErrorClass } from "@t3tools/contracts";

export type FollowUpDomainCommand =
  | { readonly type: "file"; readonly input: FollowUpFileInput }
  | { readonly type: "update-status"; readonly input: FollowUpUpdateStatusInput };

export interface FollowUpDomainEvent {
  readonly type: FollowUpEventType;
  readonly payload: FollowUpEventPayload;
}

export type FollowUpDecision =
  | { readonly kind: "accepted"; readonly event: FollowUpDomainEvent }
  | { readonly kind: "rejected"; readonly error: FollowUpOperationError };

function reject(
  code: FollowUpOperationError["code"],
  message: string,
): Extract<FollowUpDecision, { readonly kind: "rejected" }> {
  return { kind: "rejected", error: new FollowUpOperationErrorClass({ code, message }) };
}

function accepted(type: FollowUpEventType, item: FollowUp): FollowUpDecision {
  return { kind: "accepted", event: { type, payload: { item } } };
}

export function decideFollowUpCommand(
  snapshot: FollowUpSnapshot,
  command: FollowUpDomainCommand,
  now: string,
): FollowUpDecision {
  switch (command.type) {
    case "file": {
      const { input } = command;
      if (snapshot.items.some((candidate) => candidate.id === input.itemId)) {
        return reject("conflict", "A follow-up with that identifier already exists.");
      }
      // A blocker without a gate is unenforceable: "before shipping" is
      // meaningless unless it names what it blocks.
      const gate = input.gate ?? null;
      if (input.kind === "blocker" && gate === null) {
        return reject("invalid-command", "A blocker must name the branch it gates.");
      }
      const item: FollowUp = {
        id: input.itemId,
        projectId: input.projectId,
        kind: input.kind,
        status: "open",
        title: input.title,
        observation: input.observation,
        deferReason: input.deferReason,
        verifyCheck: input.verifyCheck,
        evidence: input.evidence ?? [],
        gate,
        sourceKind: input.sourceKind,
        sourceThreadId: input.sourceThreadId ?? null,
        resolution: null,
        revision: 0,
        createdAt: now,
        updatedAt: now,
      };
      return accepted("follow-up.filed", item);
    }

    case "update-status": {
      const { input } = command;
      const current = snapshot.items.find((candidate) => candidate.id === input.itemId) ?? null;
      if (current === null) {
        return reject("not-found", "That follow-up no longer exists.");
      }
      if (current.revision !== input.expectedRevision) {
        return reject(
          "conflict",
          "That follow-up changed elsewhere. The list already shows the latest version — try again.",
        );
      }
      // Only a human may waive. If an agent could waive its own blocker the
      // shipping gate would defeat itself.
      if (input.status === "waived" && input.actor !== "human") {
        return reject("forbidden", "Only a person can waive a follow-up.");
      }
      const resolution = input.resolution ?? null;
      if (input.status !== "open" && resolution === null) {
        return reject("invalid-command", "Closing a follow-up requires a resolution note.");
      }
      const item: FollowUp = {
        ...current,
        status: input.status,
        resolution: input.status === "open" ? null : resolution,
        revision: current.revision + 1,
        updatedAt: now,
      };
      return accepted("follow-up.status-changed", item);
    }
  }
}
