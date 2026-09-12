import type { ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { probeClaudeUsageLimits } from "./Layers/ClaudeProvider.ts";

/** A live read requires positive, stable identity; periodic probes can tolerate unknown identity. */
export const reconcileClaudeUsage = Effect.fn("reconcileClaudeUsage")(function* (input: {
  readonly enabled: boolean;
  readonly getSnapshot: Effect.Effect<ServerProvider>;
  readonly isCurrent: Effect.Effect<boolean>;
  readonly read: Effect.Effect<Effect.Success<ReturnType<typeof probeClaudeUsageLimits>>>;
}) {
  if (!input.enabled || !(yield* input.isCurrent)) return undefined;
  const before = yield* input.getSnapshot;
  const accountIdentity = before.auth.email?.trim();
  if (
    before.auth.status !== "authenticated" ||
    !accountIdentity ||
    before.auth.type === "apiKey" ||
    before.auth.type === "bedrock"
  )
    return undefined;
  const reading = yield* input.read;
  if (!(yield* input.isCurrent)) return undefined;
  const after = yield* input.getSnapshot;
  if (
    after.auth.status !== "authenticated" ||
    after.auth.email?.trim() !== accountIdentity ||
    after.auth.type === "apiKey" ||
    after.auth.type === "bedrock" ||
    reading?.accountIdentity !== accountIdentity ||
    !reading.usageLimits
  )
    return undefined;
  return { accountIdentity, usageLimits: reading.usageLimits };
});
