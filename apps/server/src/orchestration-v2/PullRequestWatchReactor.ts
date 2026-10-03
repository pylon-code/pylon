import {
  CommandId,
  MessageId,
  type OrchestrationV2Notification,
  type ThreadPullRequestLink,
  type ThreadPullRequestWatch,
} from "@t3tools/contracts";
import {
  normalizeThreadPullRequestKey,
  threadPullRequestKeyOf,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { evaluatePullRequestWatch, pullRequestWatchMessage } from "./pullRequestWatch.ts";

/** Passes in a row that could not read a pull request before its watch ends (one a minute). */
const READ_FAILURE_LIMIT = 15;
/**
 * Passes in a row whose wake the orchestrator refused before the watch ends quietly. A wake is
 * refused when its thread settled or was archived during the read, which the next pass sees and
 * waits out; one refused every pass is a thread that can no longer take messages.
 */
const WAKE_REFUSAL_LIMIT = 5;

const isWakeRefusedError = Schema.is(Orchestrator.OrchestratorPullRequestWatchWakeRefusedError);
const isSubagentReadOnlyError = Schema.is(Orchestrator.OrchestratorSubagentThreadReadOnlyError);

const logFailure =
  (message: string, fields: Record<string, unknown>) =>
  <E>(cause: Cause.Cause<E>): Effect.Effect<void> =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.interrupt
      : Effect.logWarning(message, { ...fields, cause });

interface WatchTarget {
  readonly thread: ProjectionStore.ProjectionThreadPullRequests;
  readonly link: ThreadPullRequestLink;
  readonly watch: ThreadPullRequestWatch;
}

const failureKey = ({ thread, link, watch }: WatchTarget) =>
  `${thread.id} ${threadPullRequestKeyOf(link)} ${watch.startedAt}`;

function watchesEqual(left: ThreadPullRequestWatch, right: ThreadPullRequestWatch): boolean {
  return (
    left.startedAt === right.startedAt &&
    left.headSha === right.headSha &&
    left.failedChecks.join("\n") === right.failedChecks.join("\n") &&
    left.passed === right.passed &&
    left.remarksThrough === right.remarksThrough &&
    left.remarkIds.join("\n") === right.remarkIds.join("\n") &&
    left.conflicting === right.conflicting &&
    left.wakes === right.wakes
  );
}

/**
 * Wakes a thread's agent when a pull request it watches (`watch_pull_request`) needs a look:
 * checks finished on the head commit, someone else commented, or the branch started to
 * conflict. One pass a minute reads each watched pull request; settled threads wait until
 * they are active again, and a merged or closed pull request ends its watch.
 */
export class PullRequestWatchReactor extends Context.Service<
  PullRequestWatchReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** One pass over every watched pull request. */
    readonly sweep: Effect.Effect<void>;
  }
>()("t3/orchestration-v2/PullRequestWatchReactor") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const crypto = yield* Crypto.Crypto;

  // Passes in a row that failed, per watch. Kept in memory: a restart only delays the stop.
  const readFailures = new Map<string, number>();
  // Wakes in a row the orchestrator refused, per watch. In memory for the same reason.
  const refusedWakes = new Map<string, number>();

  // Host-level identity, with the repository as linked, the way pull request sync reads it.
  const identityOf = (link: ThreadPullRequestLink) => ({
    host: normalizeThreadPullRequestKey(link).host,
    repository: link.repository,
    number: link.number,
  });

  /**
   * Records what a pass saw, and wakes the agent with it. The orchestrator applies this only
   * while the same watch is on, so a stop or restart that lands during the host read wins.
   */
  const record = (
    target: WatchTarget,
    next: ThreadPullRequestWatch | null,
    wake?: { readonly text: string; readonly notification: OrchestrationV2Notification },
    ended?: "wakes-refused",
  ) =>
    Effect.gen(function* () {
      const uuid = yield* crypto.randomUUIDv4;
      yield* engine.dispatch({
        type: "thread.pull-request-watch.sync",
        commandId: CommandId.make(`server:pr-watch:${target.thread.id}:${uuid}`),
        threadId: target.thread.id,
        ...identityOf(target.link),
        startedAt: target.watch.startedAt,
        watch: next,
        ...(ended === undefined ? {} : { ended }),
        ...(wake === undefined
          ? {}
          : { wake: { ...wake, messageId: MessageId.make(`message:pr-watch:${uuid}`) } }),
      });
    });

  // A watch that cannot read its pull request ends with a wake saying so, rather than showing
  // "Watching" while it learns nothing.
  const giveUp = (target: WatchTarget) =>
    record(target, null, {
      text: `Pylon stopped watching pull request #${target.link.number} (${target.link.url}) because it could not read it from the host for ${READ_FAILURE_LIMIT} minutes. Check it yourself, and call watch_pull_request to watch it again.`,
      notification: {
        source: { kind: "monitor" },
        outcome: "failed",
        summary: `#${target.link.number}: stopped watching, could not read it`,
      },
    }).pipe(Effect.catch(() => record(target, null)));

  /**
   * Counts a pass that failed for anything but a refused wake: the host read, or the server
   * recording what it read. After `READ_FAILURE_LIMIT` in a row the watch ends and says so.
   */
  const countFailure = <E>(target: WatchTarget, cause: Cause.Cause<E>) =>
    Effect.gen(function* () {
      const key = failureKey(target);
      const failures = (readFailures.get(key) ?? 0) + 1;
      readFailures.set(key, failures);
      // The count stays until the stop lands, so a failed stop is tried again next pass.
      if (failures >= READ_FAILURE_LIMIT) {
        yield* giveUp(target);
        readFailures.delete(key);
      }
      return yield* Effect.failCause(cause);
    });

  /** The orchestrator turned the wake itself away: the thread takes no messages right now. */
  const isRefusedWake = <E>(cause: Cause.Cause<E>) => {
    const error = Option.getOrUndefined(Cause.findErrorOption(cause));
    return isWakeRefusedError(error) || isSubagentReadOnlyError(error);
  };

  const check = Effect.fn("PullRequestWatchReactor.check")(function* (target: WatchTarget) {
    const { thread, link, watch } = target;
    const pullRequest = identityOf(link);
    // A merged pull request cannot reopen, so its watch ends without a host read, even on a
    // settled thread. A closed one can, so the host decides on an active thread; a settled
    // thread is not read, so pull request sync's closed state ends it there, rather than a
    // watch nobody can see through outliving the thread's work.
    if (link.snapshot?.state === "merged") return yield* record(target, null);
    if (thread.settledOverride === "settled" || thread.settledAt !== null) {
      if (link.snapshot?.state === "closed") return yield* record(target, null);
      return;
    }

    const reference = { projectId: thread.projectId, ...pullRequest };
    // A host paused by a rate limit is not read at all: the pass is skipped rather than failed,
    // so a pause neither spends budget nor counts towards giving up, and every watch on that
    // host does not end (and wake its agent) at once when the pause outlasts the limit.
    const pausedUntil = () =>
      pullRequests.rateLimitedUntil(reference).pipe(Effect.orElseSucceed(() => null));
    if ((yield* pausedUntil()) !== null) return;
    // The fresh read, not the display read: that one answers from the last value it held and
    // refreshes behind it, which would report each change a pass late and hide a host that has
    // stopped answering.
    const read = yield* Effect.exit(
      Effect.all([pullRequests.freshDetail(reference), pullRequests.activity(reference)], {
        concurrency: 2,
      }),
    );
    const key = failureKey(target);
    if (Exit.isFailure(read)) {
      if (Cause.hasInterruptsOnly(read.cause)) return yield* Effect.failCause(read.cause);
      // A read the host refused for its rate limit records the pause; wait it out uncounted.
      if ((yield* pausedUntil()) !== null) return;
      return yield* countFailure(target, read.cause);
    }
    const [detail, activity] = read.value;

    // A degraded read (GitHub's review thread query failed) is truncated with no long thread to
    // explain it, and would skip review comments, so remarks wait for a later pass. Replies past
    // the first ten of a long review thread are not read.
    const degraded =
      activity.commentsTruncated &&
      !activity.reviewThreads.some((reviewThread) => reviewThread.nextCommentsCursor !== undefined);
    const report =
      detail.state === "open"
        ? evaluatePullRequestWatch(watch, detail, degraded ? null : activity.comments)
        : null;
    const wake =
      report !== null && report.changes.length > 0
        ? pullRequestWatchMessage({
            number: link.number,
            url: link.url,
            baseBranch: detail.baseBranch,
            headSha: report.next.headSha,
            report,
          })
        : undefined;
    const next = report === null || report.exhausted ? null : report.next;
    if (wake === undefined && next !== null && watchesEqual(next, watch)) {
      readFailures.delete(key);
      return;
    }

    const recorded = yield* Effect.exit(record(target, next, wake));
    if (Exit.isSuccess(recorded)) {
      readFailures.delete(key);
      refusedWakes.delete(key);
      return;
    }
    if (Cause.hasInterruptsOnly(recorded.cause)) return yield* Effect.failCause(recorded.cause);
    if (!isRefusedWake(recorded.cause)) return yield* countFailure(target, recorded.cause);
    readFailures.delete(key);
    const refused = (refusedWakes.get(key) ?? 0) + 1;
    refusedWakes.set(key, refused);
    if (refused >= WAKE_REFUSAL_LIMIT) {
      // The thread cannot be told, so the end is recorded on the link for clients to show.
      yield* record(target, null, undefined, "wakes-refused");
      refusedWakes.delete(key);
    }
    return yield* Effect.failCause(recorded.cause);
  });

  const sweep = Effect.gen(function* () {
    const threads = yield* projections.getThreadsWithPullRequests();
    const targets = threads.flatMap((thread) =>
      visibleThreadPullRequests(thread.pullRequests ?? []).flatMap((link) =>
        link.watch === undefined ? [] : [{ thread, link, watch: link.watch }],
      ),
    );
    const keys = new Set(targets.map(failureKey));
    for (const key of readFailures.keys()) if (!keys.has(key)) readFailures.delete(key);
    for (const key of refusedWakes.keys()) if (!keys.has(key)) refusedWakes.delete(key);
    yield* Effect.forEach(
      targets,
      (target) =>
        check(target).pipe(
          Effect.catchCause(
            logFailure("pull request watch check failed", {
              threadId: target.thread.id,
              pullRequest: threadPullRequestKeyOf(target.link),
            }),
          ),
        ),
      { concurrency: 4, discard: true },
    );
  }).pipe(
    Effect.catchCause(logFailure("pull request watch sweep failed", {})),
    Effect.withSpan("PullRequestWatchReactor.sweep"),
  );

  const start: PullRequestWatchReactor["Service"]["start"] = () =>
    forkParked(sweep.pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.asVoid));

  return { start, sweep } satisfies PullRequestWatchReactor["Service"];
});

export const layer = Layer.effect(PullRequestWatchReactor, make);
