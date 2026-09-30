import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import type {
  ProviderConsumeResetCreditOutcome,
  ServerProviderAuth,
  ServerProviderUsageLimits,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { describe, expect, it } from "vite-plus/test";

import * as ClaudeResetCredits from "./claudeResetCredits.ts";
import * as ResetCreditCoordinator from "./resetCreditCoordinator.ts";

const NOW = Date.parse("2026-09-22T12:00:00.000Z");
const grant = (overrides: Record<string, unknown>) => ({
  id: "grant_a",
  resets_left: 1,
  usable_now: true,
  ...overrides,
});

describe("claudeResetCreditsToContract", () => {
  it("counts live grants and pins the next usable one", () => {
    expect(
      ClaudeResetCredits.claudeResetCreditsToContract(
        {
          eligible: true,
          next_grant_id: "grant_a",
          grants: [
            grant({ resets_left: 2, ends_at: "2026-10-01T00:00:00Z" }),
            grant({ id: "paused", paused: true }),
            grant({ id: "expired", ends_at: "2026-09-01T00:00:00Z" }),
            grant({ id: "garbled", ends_at: "not a date" }),
            grant({ id: "date_only", ends_at: "2026-10-01" }),
            grant({ id: "impossible", ends_at: "2027-02-30T00:00:00Z" }),
            grant({ id: "empty", ends_at: "" }),
            grant({ id: "Not Valid" }),
            grant({ id: "grant_b", resets_left: 3, usable_now: false }),
          ],
        },
        NOW,
      ),
    ).toEqual({
      availableCount: 2,
      nextCreditId: "grant_a",
      nextExpiresAt: "2026-10-01T00:00:00.000Z",
    });
  });

  it("offers nothing to redeem without a usable next grant or an eligible account", () => {
    expect(
      ClaudeResetCredits.claudeResetCreditsToContract(
        { eligible: true, next_grant_id: "grant_a", grants: [grant({ usable_now: false })] },
        NOW,
      ),
    ).toEqual({ availableCount: 0 });
    expect(
      ClaudeResetCredits.claudeResetCreditsToContract({ eligible: true, grants: [grant({})] }, NOW),
    ).toEqual({ availableCount: 0 });
    expect(
      ClaudeResetCredits.claudeResetCreditsToContract(
        { eligible: false, grants: [grant({})] },
        NOW,
      ),
    ).toBeUndefined();
    expect(ClaudeResetCredits.claudeResetCreditsToContract(undefined, NOW)).toBeUndefined();
  });

  it("marks only a named credit as redeemable", () => {
    expect(
      ClaudeResetCredits.markClaudeResetCreditsRedeemable({
        resetCredits: { availableCount: 1, nextCreditId: "grant_a" },
      }),
    ).toEqual({ resetCredits: { availableCount: 1, nextCreditId: "grant_a", redeemable: true } });
    const empty = { resetCredits: { availableCount: 0 } };
    expect(ClaudeResetCredits.markClaudeResetCreditsRedeemable(empty)).toBe(empty);
  });
});

const EMAIL = "a@example.test";
const CREDENTIAL_KEY = "login-a";
const usageLimits = (
  resetCredits: ServerProviderUsageLimits["resetCredits"],
): ServerProviderUsageLimits => ({
  checkedAt: "2026-09-22T12:00:00.000Z",
  windows: [],
  ...(resetCredits ? { resetCredits } : {}),
});
const DISPLAYED = usageLimits({ availableCount: 1, nextCreditId: "grant_a", redeemable: true });

const decodeClaimBody = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ program: Schema.String, grant_id: Schema.String, request_id: Schema.String }),
  ),
);
const isResetCreditError = Schema.is(ClaudeResetCredits.ClaudeResetCreditError);

interface Claim {
  readonly url: string;
  readonly authorization: string | undefined;
  readonly userAgent: string | undefined;
  readonly body: { readonly request_id: string } | undefined;
}

/** One Claude login on disk, the snapshot a client was shown, and a recorded fake of the claim endpoint. */
const makeHarness = Effect.fn("makeHarness")(function* (
  respond: (claim: Claim, attempt: number) => Effect.Effect<Response>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "pylon-claude-reset-" });
  const accountConfigPath = path.join(directory, ".claude.json");
  const writeAccount = (account: Record<string, unknown>) =>
    fs.writeFileString(accountConfigPath, JSON.stringify({ oauthAccount: account }));
  yield* writeAccount({ organizationUuid: "org-1", emailAddress: EMAIL });

  const claims: Claim[] = [];
  const refreshed: ProviderConsumeResetCreditOutcome[] = [];
  const state = {
    current: true,
    auth: { status: "authenticated", email: EMAIL } as ServerProviderAuth,
    usageLimits: DISPLAYED as ServerProviderUsageLimits | undefined,
    displayedCredentialKey: CREDENTIAL_KEY as string | undefined,
    credential: { token: "oauth-token", credentialKey: CREDENTIAL_KEY, accountConfigPath } as
      | ClaudeResetCredits.ClaudeResetCredential
      | undefined,
    warning: undefined as string | undefined,
  };
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      const claim = {
        url: request.url,
        authorization: request.headers.authorization,
        userAgent: request.headers["user-agent"],
        body:
          request.body._tag === "Uint8Array"
            ? Option.getOrUndefined(decodeClaimBody(new TextDecoder().decode(request.body.body)))
            : undefined,
      };
      claims.push(claim);
      return HttpClientResponse.fromWeb(request, yield* respond(claim, claims.length));
    }),
  );
  const coordinator = yield* ResetCreditCoordinator.ResetCreditCoordinator;
  const redeem = (input: {
    readonly creditId?: string | undefined;
    readonly requestId?: string | undefined;
  }) =>
    ClaudeResetCredits.redeemClaudeResetCredit({
      creditId: "creditId" in input ? input.creditId : "grant_a",
      requestId: input.requestId ?? "request-1",
      attemptScope: directory,
      isCurrent: Effect.sync(() => state.current),
      getSnapshot: Effect.sync(() => ({ auth: state.auth, usageLimits: state.usageLimits })),
      displayedCredentialKey: Effect.sync(() => state.displayedCredentialKey),
      readCredential: Effect.sync(() => state.credential),
      coordinator,
      refresh: (outcome) =>
        Effect.sync(() => {
          refreshed.push(outcome);
          return state.warning;
        }),
    }).pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.result);
  return { state, claims, refreshed, redeem, writeAccount };
});

const answer = (result: string, status = 200) =>
  Effect.succeed(Response.json({ result }, { status }));
const reasonOf = (result: { readonly _tag: string; readonly failure?: unknown }) =>
  result._tag === "Failure" && isResetCreditError(result.failure)
    ? result.failure.reason
    : undefined;

effectIt.layer(Layer.mergeAll(NodeServices.layer, ResetCreditCoordinator.layerTest))(
  "redeemClaudeResetCredit",
  (it) => {
    it.effect("claims the displayed credit once for the displayed account", () =>
      Effect.gen(function* () {
        const release = yield* Deferred.make<void>();
        const harness = yield* makeHarness(() =>
          Deferred.await(release).pipe(Effect.andThen(answer("reset"))),
        );
        // A double submit and a second client confirming the same credit.
        const first = yield* Effect.forkChild(harness.redeem({ requestId: "request-1" }), {
          startImmediately: true,
        });
        const second = yield* Effect.forkChild(harness.redeem({ requestId: "request-1" }), {
          startImmediately: true,
        });
        const third = yield* Effect.forkChild(harness.redeem({ requestId: "request-2" }), {
          startImmediately: true,
        });
        yield* Deferred.succeed(release, undefined);
        for (const fiber of [first, second, third]) {
          expect(yield* Fiber.join(fiber)).toMatchObject({
            _tag: "Success",
            success: { outcome: "reset" },
          });
        }
        expect(harness.claims).toEqual([
          {
            url: "https://api.anthropic.com/api/organizations/org-1/reset_rate_limits",
            authorization: "Bearer oauth-token",
            userAgent: undefined,
            body: { program: "cedar_ember", grant_id: "grant_a", request_id: "request-1" },
          },
        ]);
        expect(harness.refreshed).toEqual(["reset"]);
        // A replayed confirmation is answered from its receipt, not re-sent.
        expect(yield* harness.redeem({ requestId: "request-1" })).toMatchObject({
          success: { outcome: "reset" },
        });
        expect(harness.claims).toHaveLength(1);
      }),
    );

    it.effect("keeps a confirmed outcome when the limits could not be re-read", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness(() => answer("already_used"));
        harness.state.warning = "Refresh to check.";
        expect(yield* harness.redeem({})).toMatchObject({
          success: { outcome: "alreadyRedeemed", warning: "Refresh to check." },
        });
      }),
    );

    it.effect("refuses, without sending anything, once what was displayed no longer holds", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness(() => Effect.die("must not send a request"));
        const { state } = harness;
        const refused = (
          expected: string,
          change: () => void,
          input: Parameters<typeof harness.redeem>[0] = {},
        ) =>
          Effect.gen(function* () {
            const before = { ...state };
            change();
            expect(reasonOf(yield* harness.redeem(input))).toBe(expected);
            Object.assign(state, before);
          });

        // An older client that cannot name the credit it displayed.
        yield* refused("clientOutdated", () => {}, { creditId: undefined });
        yield* refused("malformedCredit", () => {}, { creditId: "Not Valid" });
        // The instance was replaced or removed.
        yield* refused("instanceRetired", () => {
          state.current = false;
        });
        // Signed out, or an account that was never positively identified.
        yield* refused("accountUnverified", () => {
          state.auth = { status: "unauthenticated" };
        });
        yield* refused("accountUnverified", () => {
          state.auth = { status: "authenticated" };
        });
        // The balance moved on, or was never redeemable by this server.
        yield* refused("staleCredit", () => {
          state.usageLimits = usageLimits({
            availableCount: 1,
            nextCreditId: "grant_b",
            redeemable: true,
          });
        });
        yield* refused("staleCredit", () => {
          state.usageLimits = usageLimits({ availableCount: 1, nextCreditId: "grant_a" });
        });
        yield* refused("staleCredit", () => {
          state.usageLimits = undefined;
        });
        // The login on disk is not the one the credit was read with.
        yield* refused("loginChanged", () => {
          state.credential = { ...state.credential!, credentialKey: "login-b" };
        });
        yield* refused("loginChanged", () => {
          state.displayedCredentialKey = undefined;
        });
        yield* refused("signedOut", () => {
          state.credential = undefined;
        });

        // The CLI's account record names another account, or none.
        yield* harness.writeAccount({ organizationUuid: "org-2", emailAddress: "b@example.test" });
        expect(reasonOf(yield* harness.redeem({}))).toBe("accountChanged");
        yield* harness.writeAccount({ organizationUuid: "org-1" });
        expect(reasonOf(yield* harness.redeem({}))).toBe("accountChanged");
        yield* harness.writeAccount({ emailAddress: EMAIL });
        expect(reasonOf(yield* harness.redeem({}))).toBe("signedOut");

        expect(harness.claims).toEqual([]);
        expect(harness.refreshed).toEqual([]);
      }),
    );

    it.effect("refuses a queued confirmation when the account switches while it waits", () =>
      Effect.gen(function* () {
        const release = yield* Deferred.make<void>();
        const started = yield* Deferred.make<void>();
        const harness = yield* makeHarness((_claim, attempt) =>
          attempt === 1
            ? Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(Effect.succeed(Response.json({}, { status: 500 }))),
              )
            : Effect.die("must not send a second request"),
        );
        const first = yield* Effect.forkChild(harness.redeem({ requestId: "request-1" }), {
          startImmediately: true,
        });
        yield* Deferred.await(started);
        const queued = yield* Effect.forkChild(harness.redeem({ requestId: "request-2" }), {
          startImmediately: true,
        });
        harness.state.auth = { status: "authenticated", email: "b@example.test" };
        yield* Deferred.succeed(release, undefined);
        expect(reasonOf(yield* Fiber.join(first))).toBe("requestFailed");
        expect(reasonOf(yield* Fiber.join(queued))).toBe("accountChanged");
        expect(harness.claims).toHaveLength(1);
      }),
    );

    it.effect(
      "retries an unanswered claim as the same claim and a settled one as a new claim",
      () =>
        Effect.gen(function* () {
          const answers = [
            () => Effect.succeed(Response.json({}, { status: 500 })),
            () => answer("unavailable"),
            () => answer("cooldown"),
            () => Effect.succeed(Response.json({}, { status: 429 })),
            () => Effect.succeed(Response.json({}, { status: 401 })),
            () => answer("reset"),
          ];
          const harness = yield* makeHarness((_claim, attempt) => answers[attempt - 1]!());
          const requestIds = () => harness.claims.map((claim) => claim.body?.request_id);

          // No answer, then an answer that could not confirm: the claim keeps its identity,
          // even when another client retries it.
          expect(reasonOf(yield* harness.redeem({ requestId: "request-1" }))).toBe("requestFailed");
          expect(reasonOf(yield* harness.redeem({ requestId: "request-2" }))).toBe("unconfirmed");
          // Claude answered and spent nothing, so each later confirmation is a new claim.
          expect(reasonOf(yield* harness.redeem({ requestId: "request-3" }))).toBe("coolingDown");
          expect(reasonOf(yield* harness.redeem({ requestId: "request-4" }))).toBe("rateLimited");
          expect(reasonOf(yield* harness.redeem({ requestId: "request-5" }))).toBe("signedOut");
          expect(yield* harness.redeem({ requestId: "request-6" })).toMatchObject({
            success: { outcome: "reset" },
          });
          expect(requestIds()).toEqual([
            "request-1",
            "request-1",
            "request-1",
            "request-4",
            "request-5",
            "request-6",
          ]);
          // Only an answered redemption re-reads the limits.
          expect(harness.refreshed).toEqual(["reset"]);
        }),
    );
  },
);
