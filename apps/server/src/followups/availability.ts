import { FollowUpOperationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { ServerSettingsService } from "../serverSettings.ts";

const disabledError = () =>
  new FollowUpOperationError({
    code: "forbidden",
    message: "Follow-ups are disabled in server settings.",
  });

export const requireFollowUpsEnabled = Effect.fn("FollowUps.requireEnabled")(function* () {
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
    return yield* disabledError();
  }
});

export const guardFollowUpStream = <A, E, R>(stream: () => Stream.Stream<A, E, R>) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const settingsService = yield* ServerSettingsService;
      // Attach before reading the flag so a disable between the initial read
      // and live streaming cannot leak an item.
      const changes = yield* settingsService.subscribeChanges;
      yield* requireFollowUpsEnabled();
      const disabled = changes.pipe(
        Stream.filter((settings) => !settings.followUpsEnabled),
        Stream.take(1),
        Stream.mapEffect(() => Effect.fail(disabledError())),
      );
      return Stream.merge(stream(), disabled);
    }),
  );
