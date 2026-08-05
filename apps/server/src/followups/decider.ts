import type {
  FollowUp,
  FollowUpEventPayload,
  FollowUpEventType,
  FollowUpFileCommand,
  FollowUpOperationError,
  FollowUpRecordValidationCommand,
  FollowUpSnapshot,
  FollowUpUpdateStatusCommand,
} from "@t3tools/contracts";
import { FollowUpOperationError as FollowUpOperationErrorClass } from "@t3tools/contracts";

export type FollowUpDomainCommand =
  | { readonly type: "file"; readonly input: FollowUpFileCommand }
  | { readonly type: "update-status"; readonly input: FollowUpUpdateStatusCommand }
  | { readonly type: "record-validation"; readonly input: FollowUpRecordValidationCommand };

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
      if (input.kind !== "blocker" && gate !== null) {
        return reject("invalid-command", "Only a blocker may gate a branch.");
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
        lastValidation: null,
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
      if (current.projectId !== input.projectId) {
        return reject("invalid-project", "That follow-up belongs to another project.");
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
      if (input.status === "moot") {
        return reject(
          "invalid-command",
          "Marking a follow-up moot requires a recorded validation result.",
        );
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

    case "record-validation": {
      const { input } = command;
      const current = snapshot.items.find((candidate) => candidate.id === input.itemId) ?? null;
      if (current === null) {
        return reject("not-found", "That follow-up no longer exists.");
      }
      if (current.projectId !== input.projectId) {
        return reject("invalid-project", "That follow-up belongs to another project.");
      }
      if (current.revision !== input.expectedRevision) {
        return reject(
          "conflict",
          "That follow-up changed elsewhere. The list already shows the latest version — try again.",
        );
      }
      if (current.status !== "open") {
        return reject("invalid-command", "Only an open follow-up can be validated.");
      }
      if (input.verifyCheck !== current.verifyCheck) {
        return reject(
          "invalid-command",
          "The validation check is stale. List the follow-up again before recording a result.",
        );
      }
      if (input.outcome === "moot" && input.evidence.length === 0) {
        return reject("invalid-command", "A moot validation requires concrete evidence.");
      }

      const lastValidation = {
        outcome: input.outcome,
        verifyCheck: input.verifyCheck,
        note: input.note,
        evidence: input.evidence,
        threadId: input.threadId,
        checkedCommitSha: input.checkedCommitSha ?? null,
        validatedAt: now,
      } as const;
      const item: FollowUp = {
        ...current,
        status: input.outcome === "moot" ? "moot" : "open",
        resolution:
          input.outcome === "moot"
            ? {
                note: input.note,
                threadId: input.threadId,
                commitSha: input.checkedCommitSha ?? null,
              }
            : null,
        lastValidation,
        revision: current.revision + 1,
        updatedAt: now,
      };
      return accepted("follow-up.validated", item);
    }
  }
}
