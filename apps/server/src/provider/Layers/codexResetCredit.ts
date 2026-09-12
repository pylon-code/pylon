/** Account-scoped reset attempts keep retries and concurrent confirmations on one credit. */
import type { ProviderConsumeResetCreditResult } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

export const CODEX_RESET_CREDIT_TIMEOUT = Duration.seconds(20);
type Outcome = ProviderConsumeResetCreditResult;
interface AttemptState {
  readonly generation: number;
  readonly latest: Outcome | undefined;
  readonly pendingKey: string | undefined;
  readonly pendingRequests: ReadonlySet<string>;
  readonly completed: ReadonlyMap<string, Outcome>;
}
interface AccountState {
  readonly lock: Semaphore.Semaphore;
  readonly attempt: Ref.Ref<AttemptState>;
}

export class CodexResetCreditCoordinator extends Context.Service<
  CodexResetCreditCoordinator,
  {
    readonly redeem: <E, R>(
      accountKey: string,
      requestId: string | undefined,
      consume: (idempotencyKey: string) => Effect.Effect<Outcome, E, R>,
    ) => Effect.Effect<Outcome, E | PlatformError.PlatformError, R>;
  }
>()("t3/provider/Layers/codexResetCredit/CodexResetCreditCoordinator") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const statesRef = yield* Ref.make<ReadonlyMap<string, AccountState>>(new Map());
  const stateFor = Effect.fn("CodexResetCreditCoordinator.stateFor")(function* (
    accountKey: string,
  ) {
    const existing = (yield* Ref.get(statesRef)).get(accountKey);
    if (existing) return existing;
    const candidate = {
      lock: yield* Semaphore.make(1),
      attempt: yield* Ref.make<AttemptState>({
        generation: 0,
        latest: undefined,
        pendingKey: undefined,
        pendingRequests: new Set<string>(),
        completed: new Map(),
      }),
    };
    return yield* Ref.modify(statesRef, (states) => {
      const current = states.get(accountKey);
      return current
        ? ([current, states] as const)
        : ([candidate, new Map(states).set(accountKey, candidate)] as const);
    });
  });
  const redeem: CodexResetCreditCoordinator["Service"]["redeem"] = (
    accountKey,
    suppliedRequestId,
    consume,
  ) =>
    Effect.gen(function* () {
      const state = yield* stateFor(accountKey);
      const requestId = suppliedRequestId ?? (yield* crypto.randomUUIDv4);
      const admittedGeneration = (yield* Ref.get(state.attempt)).generation;
      return yield* state.lock.withPermits(1)(
        Effect.gen(function* () {
          const before = yield* Ref.get(state.attempt);
          const completed = before.completed.get(requestId);
          if (completed !== undefined) return completed;
          // A request admitted during another redemption shares its outcome.
          if (before.generation !== admittedGeneration && before.latest !== undefined) {
            const completed = new Map(before.completed).set(requestId, before.latest);
            if (completed.size > 64) completed.delete(completed.keys().next().value!);
            yield* Ref.set(state.attempt, { ...before, completed });
            return before.latest;
          }
          // A client retry keeps its identity even after this server restarts.
          // Concurrent clients still join any uncertain account-scoped attempt.
          const key = before.pendingKey ?? requestId;
          const pendingRequests = new Set(before.pendingRequests).add(requestId);
          yield* Ref.set(state.attempt, { ...before, pendingKey: key, pendingRequests });
          // Failures and interruption retain the key. A retry cannot start a new spend.
          const outcome = yield* consume(key);
          const receipts = new Map(before.completed);
          for (const request of pendingRequests) receipts.set(request, outcome);
          while (receipts.size > 64) receipts.delete(receipts.keys().next().value!);
          yield* Ref.set(state.attempt, {
            generation: before.generation + 1,
            latest: outcome,
            pendingKey: undefined,
            pendingRequests: new Set<string>(),
            completed: receipts,
          });
          return outcome;
        }),
      );
    });
  return { redeem } satisfies CodexResetCreditCoordinator["Service"];
});

export const layer = Layer.effect(CodexResetCreditCoordinator, make);

export const layerTest = Layer.effect(
  CodexResetCreditCoordinator,
  Effect.gen(function* () {
    let counter = 0;
    return yield* make.pipe(
      Effect.provideService(
        Crypto.Crypto,
        Crypto.make({
          randomBytes: (size) => new Uint8Array(size).fill(++counter),
          digest: (_algorithm, data) => Effect.succeed(data),
        }),
      ),
    );
  }),
);
