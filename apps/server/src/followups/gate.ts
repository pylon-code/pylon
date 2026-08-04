import { FollowUpOperationError, type FollowUp } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { ServerSettingsService } from "../serverSettings.ts";
import { FollowUpService } from "./FollowUpService.ts";

export function isBlocked(blockers: ReadonlyArray<FollowUp>): boolean {
  return blockers.length > 0;
}

export function describeBlockers(blockers: ReadonlyArray<FollowUp>): string {
  const lines = blockers.map((blocker) => `- ${blocker.title}`).join("\n");
  return [
    `This branch has ${blockers.length} unresolved follow-up ${
      blockers.length === 1 ? "blocker" : "blockers"
    }:`,
    lines,
    "Resolve them, or waive them from the follow-ups list, before shipping.",
  ].join("\n");
}

/**
 * The shipping gate. Call this from a Pylon-owned shipping action — never
 * inline the query, so upstream merges see a single line here.
 */
export const assertNoOpenBlockers = Effect.fn("FollowUps.assertNoOpenBlockers")(function* (
  branchRef: string,
) {
  const settingsService = yield* ServerSettingsService;
  const settings = yield* settingsService.getSettings.pipe(
    Effect.mapError(
      () =>
        new FollowUpOperationError({
          code: "persistence",
          message: "Follow-up settings could not be read.",
        }),
    ),
  );
  if (!settings.followUpsEnabled) {
    return;
  }

  const service = yield* FollowUpService;
  const blockers = yield* service.openBlockersForBranch(branchRef);
  if (isBlocked(blockers)) {
    return yield* new FollowUpOperationError({
      code: "invalid-command",
      message: describeBlockers(blockers),
    });
  }
});
