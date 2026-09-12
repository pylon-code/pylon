import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import { makeCoalescedUsageRefresh } from "./coalescedUsageRefresh.ts";

it.effect("coalesces bursts without extending the deadline or polling an idle account", () =>
  Effect.gen(function* () {
    const reads = yield* Ref.make(0);
    const receipts = yield* Queue.unbounded<number>();
    const job = yield* makeCoalescedUsageRefresh(
      Ref.updateAndGet(reads, (n) => n + 1).pipe(
        Effect.flatMap((n) => Queue.offer(receipts, n)),
        Effect.asVoid,
      ),
    );
    yield* job.request;
    yield* job.request;
    yield* TestClock.adjust("59 seconds");
    assert.strictEqual(yield* Ref.get(reads), 0);
    yield* job.request;
    yield* TestClock.adjust("1 second");
    assert.strictEqual(yield* Queue.take(receipts), 1);
    yield* TestClock.adjust("5 minutes");
    assert.strictEqual(yield* Ref.get(reads), 1);
  }),
);

it.effect("retains a signal arriving during the read for one bounded follow-up", () =>
  Effect.gen(function* () {
    const started = yield* Queue.unbounded<number>();
    const release = yield* Deferred.make<void>();
    const reads = yield* Ref.make(0);
    const job = yield* makeCoalescedUsageRefresh(
      Effect.gen(function* () {
        const count = yield* Ref.updateAndGet(reads, (n) => n + 1);
        yield* Queue.offer(started, count);
        if (count === 1) yield* Deferred.await(release);
      }),
    );
    yield* job.request;
    yield* TestClock.adjust("1 minute");
    assert.strictEqual(yield* Queue.take(started), 1);
    yield* job.request;
    yield* job.request;
    yield* Deferred.succeed(release, undefined);
    yield* TestClock.adjust("1 minute");
    assert.strictEqual(yield* Queue.take(started), 2);
    yield* TestClock.adjust("5 minutes");
    assert.strictEqual(yield* Ref.get(reads), 2);
  }),
);

it.effect("retirement interrupts an owned read and rejects future signals", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const interrupted = yield* Ref.make(false);
    const job = yield* makeCoalescedUsageRefresh(
      Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(Ref.set(interrupted, true)),
      ),
    );
    yield* job.request;
    yield* TestClock.adjust("1 minute");
    yield* Deferred.await(started);
    yield* job.stop;
    assert.strictEqual(yield* Ref.get(interrupted), true);
    yield* job.request;
    yield* TestClock.adjust("5 minutes");
  }),
);
