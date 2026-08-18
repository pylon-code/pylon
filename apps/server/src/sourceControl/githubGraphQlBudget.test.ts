import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import * as GitHubGraphQlBudget from "./githubGraphQlBudget.ts";

const RESET_AT = "2026-08-13T14:00:00.000Z";
const NEXT_RESET_AT = "2026-08-13T15:00:00.000Z";
const BEFORE_RESET = Date.parse("2026-08-13T13:30:00.000Z");
const AFTER_RESET = Date.parse("2026-08-13T14:00:01.000Z");

function rateLimit(remaining: number, limit = 5_000, resetAt = RESET_AT): string {
  return JSON.stringify({
    data: {
      viewer: { login: "bilal" },
      rateLimit: { cost: 14, limit, remaining, resetAt },
    },
  });
}

/** The same answer with its price named, for the tests that turn on how much a read cost. */
function rateLimitCosting(cost: number, remaining: number, limit = 5_000): string {
  return JSON.stringify({
    data: { rateLimit: { cost, limit, remaining, resetAt: RESET_AT } },
  });
}

describe("GitHub GraphQL budget", () => {
  it.effect("adds rate metadata to a read query", () =>
    Effect.gen(function* () {
      const budget = yield* GitHubGraphQlBudget.GitHubGraphQlBudget;

      const query = yield* budget.query(
        "github.com",
        'query { repository(owner: "acme", name: "web") { name } }',
      );

      expect(query).toContain("rateLimit { cost limit remaining resetAt }");
      expect(query).toContain('repository(owner: "acme", name: "web") { name }');
    }).pipe(Effect.provide(GitHubGraphQlBudget.layer)),
  );

  it.effect("protects the last ten percent with the shared provider cooldown error", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(BEFORE_RESET);
      const budget = yield* GitHubGraphQlBudget.GitHubGraphQlBudget;
      yield* budget.observe("github.com", rateLimit(500));

      const error = yield* Effect.flip(budget.query("github.com", "query { viewer { login } }"));
      expect(error).toMatchObject({
        _tag: "SourceControlRateLimitPausedError",
        provider: "github",
        host: "github.com",
        retryAt: Date.parse(RESET_AT),
      });
      expect(error.message).toBe(
        "github requests to github.com are paused until the rate limit resets.",
      );

      yield* TestClock.setTime(AFTER_RESET);
      expect(yield* budget.query("github.com", "query { viewer { login } }")).toContain(
        "rateLimit",
      );
    }).pipe(Effect.provide(GitHubGraphQlBudget.layer)),
  );

  it.effect("keeps hosts isolated", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(BEFORE_RESET);
      const budget = yield* GitHubGraphQlBudget.GitHubGraphQlBudget;
      yield* budget.observe("github.com", rateLimit(0));

      const error = yield* Effect.flip(budget.query("github.com", "query { viewer { login } }"));
      expect(error._tag).toBe("SourceControlRateLimitPausedError");
      expect(yield* budget.query("github.example.com", "query { viewer { login } }")).toContain(
        "rateLimit",
      );
    }).pipe(Effect.provide(GitHubGraphQlBudget.layer)),
  );

  it.effect("keeps the lower remaining value from out-of-order responses", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(BEFORE_RESET);
      const budget = yield* GitHubGraphQlBudget.GitHubGraphQlBudget;
      yield* budget.observe("github.com", rateLimit(400));
      yield* budget.observe("github.com", rateLimit(600));

      const error = yield* Effect.flip(budget.query("github.com", "query { viewer { login } }"));
      expect(error).toMatchObject({
        _tag: "SourceControlRateLimitPausedError",
        retryAt: Date.parse(RESET_AT),
      });
    }).pipe(Effect.provide(GitHubGraphQlBudget.layer)),
  );

  it.effect("ignores a response from an older reset window", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(BEFORE_RESET);
      const budget = yield* GitHubGraphQlBudget.GitHubGraphQlBudget;
      yield* budget.observe("github.com", rateLimit(400, 5_000, NEXT_RESET_AT));
      yield* budget.observe("github.com", rateLimit(1_000, 5_000, RESET_AT));

      const error = yield* Effect.flip(budget.query("github.com", "query { viewer { login } }"));
      expect(error).toMatchObject({
        _tag: "SourceControlRateLimitPausedError",
        retryAt: Date.parse(NEXT_RESET_AT),
      });
    }).pipe(Effect.provide(GitHubGraphQlBudget.layer)),
  );

  it.effect("accepts a response from a later reset window", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(BEFORE_RESET);
      const budget = yield* GitHubGraphQlBudget.GitHubGraphQlBudget;
      yield* budget.observe("github.com", rateLimit(1_000));
      yield* budget.observe("github.com", rateLimit(400, 5_000, NEXT_RESET_AT));

      const error = yield* Effect.flip(budget.query("github.com", "query { viewer { login } }"));
      expect(error).toMatchObject({
        _tag: "SourceControlRateLimitPausedError",
        retryAt: Date.parse(NEXT_RESET_AT),
      });
    }).pipe(Effect.provide(GitHubGraphQlBudget.layer)),
  );

  it.effect("allows reads above the reserve", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(BEFORE_RESET);
      const budget = yield* GitHubGraphQlBudget.GitHubGraphQlBudget;
      yield* budget.observe("github.com", rateLimit(515));

      expect(yield* budget.query("github.com", "query { viewer { login } }")).toContain(
        "rateLimit",
      );
    }).pipe(Effect.provide(GitHubGraphQlBudget.layer)),
  );

  it.effect("allows an interactive read to use the reserve", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(BEFORE_RESET);
      const budget = yield* GitHubGraphQlBudget.GitHubGraphQlBudget;
      yield* budget.observe("github.com", rateLimit(500));

      expect(
        yield* budget.query("github.com", "query { viewer { login } }", {
          allowReserve: true,
        }),
      ).toContain("rateLimit");
    }).pipe(Effect.provide(GitHubGraphQlBudget.layer)),
  );

  it.effect("reserves an admitted query cost before its response", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(BEFORE_RESET);
      const budget = yield* GitHubGraphQlBudget.GitHubGraphQlBudget;
      yield* budget.observe("github.com", rateLimit(514));

      expect(yield* budget.query("github.com", "query { viewer { login } }")).toContain(
        "rateLimit",
      );
      const error = yield* Effect.flip(budget.query("github.com", "query { viewer { login } }"));

      expect(error).toMatchObject({
        _tag: "SourceControlRateLimitPausedError",
        retryAt: Date.parse(RESET_AT),
      });
    }).pipe(Effect.provide(GitHubGraphQlBudget.layer)),
  );

  // The reserve is deducted from what GitHub last said, so an honest answer always looks
  // higher than the running figure. Judging staleness against it discarded every truthful
  // response, leaving the estimate to climb only when a read cost more than the one before —
  // one 100-point read then priced every 1-point read at 100 for the rest of the window.
  it.effect("takes a cheaper answer that lands above the reserved figure", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(BEFORE_RESET);
      const budget = yield* GitHubGraphQlBudget.GitHubGraphQlBudget;
      yield* budget.observe("github.com", rateLimitCosting(100, 600));

      // Reserves 100 against 600, which leaves exactly the floor.
      expect(yield* budget.query("github.com", "query { viewer { login } }")).toContain(
        "rateLimit",
      );
      // GitHub spent one point, not another hundred. 599 is above the reserved 500 and below
      // the 600 it last reported, so it is news and not an answer that arrived out of order.
      yield* budget.observe("github.com", rateLimitCosting(1, 599));

      expect(yield* budget.query("github.com", "query { viewer { login } }")).toContain(
        "rateLimit",
      );
    }).pipe(Effect.provide(GitHubGraphQlBudget.layer)),
  );

  // A read that never answers — a network flap, a `gh` failure — keeps its reserve, because
  // only the success path observes. The next answer carries the host's own figure, so it puts
  // the estimate back rather than leaving the leak to accumulate until the window resets.
  it.effect("clears reserves left behind by reads that never answered", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(BEFORE_RESET);
      const budget = yield* GitHubGraphQlBudget.GitHubGraphQlBudget;
      yield* budget.observe("github.com", rateLimitCosting(100, 900));

      for (let attempt = 0; attempt < 4; attempt += 1) {
        expect(yield* budget.query("github.com", "query { viewer { login } }")).toContain(
          "rateLimit",
        );
      }
      // Four reserves took the estimate to the floor while GitHub barely moved.
      yield* Effect.flip(budget.query("github.com", "query { viewer { login } }"));

      yield* budget.observe("github.com", rateLimitCosting(1, 899));

      expect(yield* budget.query("github.com", "query { viewer { login } }")).toContain(
        "rateLimit",
      );
    }).pipe(Effect.provide(GitHubGraphQlBudget.layer)),
  );

  it.effect("ignores malformed or partial rate metadata", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(BEFORE_RESET);
      const budget = yield* GitHubGraphQlBudget.GitHubGraphQlBudget;
      yield* budget.observe("github.com", "{");
      yield* budget.observe(
        "github.com",
        '{"data":{"rateLimit":{"limit":0,"remaining":-1,"resetAt":"never"}}}',
      );

      expect(yield* budget.query("github.com", "query { viewer { login } }")).toContain(
        "rateLimit",
      );
    }).pipe(Effect.provide(GitHubGraphQlBudget.layer)),
  );

  it.effect("does not add a read field to a mutation", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(BEFORE_RESET);
      const budget = yield* GitHubGraphQlBudget.GitHubGraphQlBudget;
      const mutation = "mutation { addComment(input: {}) { clientMutationId } }";
      yield* budget.observe("github.com", rateLimit(0));

      expect(yield* budget.query("github.com", mutation)).toBe(mutation);
    }).pipe(Effect.provide(GitHubGraphQlBudget.layer)),
  );
});
