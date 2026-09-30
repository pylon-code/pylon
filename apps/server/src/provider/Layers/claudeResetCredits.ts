/**
 * Claude banked resets (the CLI's `cedar_ember` program). The grants arrive on
 * the OAuth usage reading Pylon already makes, and one is claimed against the
 * account's organization with the login Claude Code signed in with.
 *
 * Redeeming is irreversible, so it only ever follows an explicit user action
 * and is refused unless everything the user was shown still holds: the
 * instance is still the registered one, the signed-in account and the credit
 * are the ones displayed, and the login on disk is the one that credit was
 * read with.
 *
 * @module provider/Layers/claudeResetCredits
 */
import type {
  ProviderConsumeResetCreditOutcome,
  ProviderConsumeResetCreditResult,
  ServerProvider,
  ServerProviderResetCredits,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { authenticatedUsageIdentity } from "../providerUsageRetention.ts";
import { sharedUsageReadKey } from "../sharedUsageReadCache.ts";
import type { ResetCreditCoordinator } from "./resetCreditCoordinator.ts";

const API_BASE = "https://api.anthropic.com";
const OAUTH_BETA_HEADER = "oauth-2025-04-20";
/** The program name is also the usage query parameter and the response key. */
export const CLAUDE_RESET_CREDITS_PROGRAM = "cedar_ember";
const GRANT_ID = /^[a-z0-9_-]{1,40}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
const COMPLETE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const AccountConfig = Schema.Struct({
  oauthAccount: Schema.optional(
    Schema.Struct({
      organizationUuid: Schema.optional(Schema.String),
      emailAddress: Schema.optional(Schema.String),
    }),
  ),
});
const decodeAccountConfig = Schema.decodeUnknownOption(Schema.fromJsonString(AccountConfig));
const Grant = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(GRANT_ID)),
  resets_left: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  ends_at: Schema.optional(Schema.NullOr(Schema.String)),
  paused: Schema.optional(Schema.Boolean),
  usable_now: Schema.optional(Schema.Boolean),
});
const decodeGrant = Schema.decodeUnknownOption(Grant);
const CedarEmber = Schema.Struct({
  eligible: Schema.Boolean,
  grants: Schema.optional(Schema.Array(Schema.Unknown)),
  next_grant_id: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeCedarEmber = Schema.decodeUnknownOption(CedarEmber);
const ClaimResponse = Schema.Struct({
  result: Schema.Literals([
    "reset",
    "already_used",
    "not_limited",
    "cooldown",
    "ineligible",
    "unavailable",
  ]),
});

const RESET_CREDIT_FAILURES = {
  clientOutdated: "This Pylon app cannot redeem Claude resets yet. Update it and try again.",
  malformedCredit: "Claude returned a malformed reset credit.",
  instanceRetired: "This Claude instance changed before the reset could be used. Try again.",
  accountUnverified: "Claude account identity is not verified.",
  staleCredit: "That reset is no longer the one on this account. Refresh usage and try again.",
  accountChanged: "Claude account changed before the reset could be used.",
  loginChanged: "Claude's sign-in changed since this reset was shown. Refresh usage and try again.",
  accountUnreadable: "Claude could not read its account.",
  signedOut: "Sign in to Claude again to redeem resets.",
  rateLimited: "Claude is rate limiting resets. Try again soon.",
  coolingDown: "Claude resets are cooling down. Try again later.",
  unconfirmed:
    "Claude could not confirm the reset. If you are still limited in a moment, try again.",
  requestFailed: "Claude could not redeem the reset. Retry to check the same attempt.",
} as const;
type ResetCreditFailure = keyof typeof RESET_CREDIT_FAILURES;

export class ClaudeResetCreditError extends Schema.TaggedError<ClaudeResetCreditError>()(
  "ClaudeResetCreditError",
  {
    reason: Schema.Literals(Object.keys(RESET_CREDIT_FAILURES) as Array<ResetCreditFailure>),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return RESET_CREDIT_FAILURES[this.reason];
  }
}

const isClaudeResetCreditError = Schema.is(ClaudeResetCreditError);

/**
 * Every reset failure except `requestFailed` and `unconfirmed` is final:
 * Claude answered, or nothing was sent. An unanswered or unconfirmed claim
 * retries with the same request id.
 */
export const isSettledClaudeResetCreditFailure = (error: unknown) =>
  isClaudeResetCreditError(error) &&
  error.reason !== "requestFailed" &&
  error.reason !== "unconfirmed";

/** Rejects unparseable and calendar-invalid timestamps such as February 30. */
const isFutureTimestamp = (value: string, nowMs: number) => {
  if (!COMPLETE_TIMESTAMP.test(value)) return false;
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  return (
    Date.parse(value) > nowMs && Date.UTC(year!, month! - 1, day!) <= Date.UTC(year!, month!, 0)
  );
};

/** Grants that are paused or past `ends_at` cannot be claimed and do not count. */
export function claudeResetCreditsToContract(
  block: unknown,
  nowMs: number,
): ServerProviderResetCredits | undefined {
  const parsed = decodeCedarEmber(block);
  if (Option.isNone(parsed) || !parsed.value.eligible) return undefined;
  const live = (parsed.value.grants ?? [])
    .flatMap((raw) => Option.toArray(decodeGrant(raw)))
    .filter(
      (grant) =>
        !grant.paused &&
        grant.usable_now &&
        (grant.ends_at == null || isFutureTimestamp(grant.ends_at, nowMs)),
    );
  const next = live.find((grant) => grant.id === parsed.value.next_grant_id);
  const nextExpiresAt = next?.ends_at ? DateTime.make(next.ends_at) : Option.none();
  return {
    availableCount: next ? live.reduce((sum, grant) => sum + grant.resets_left, 0) : 0,
    ...(Option.isSome(nextExpiresAt)
      ? { nextExpiresAt: DateTime.formatIso(nextExpiresAt.value) }
      : {}),
    ...(next ? { nextCreditId: next.id } : {}),
  };
}

/** Only a server that can redeem the named credit marks it so; see the contract. */
export function markClaudeResetCreditsRedeemable<
  Limits extends { readonly resetCredits?: ServerProviderResetCredits | undefined },
>(limits: Limits): Limits {
  return limits.resetCredits?.nextCreditId
    ? { ...limits, resetCredits: { ...limits.resetCredits, redeemable: true } }
    : limits;
}

/** The organization a claim is made against, and whose login the CLI recorded beside it. */
const readAccount = Effect.fn("readClaudeResetAccount")(function* (accountConfigPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs
    .readFileString(accountConfigPath)
    .pipe(
      Effect.mapError(
        (cause) => new ClaudeResetCreditError({ reason: "accountUnreadable", cause }),
      ),
    );
  const config = decodeAccountConfig(raw);
  if (Option.isNone(config)) {
    return yield* new ClaudeResetCreditError({ reason: "accountUnreadable" });
  }
  return {
    organization: config.value.oauthAccount?.organizationUuid?.trim() || undefined,
    email: config.value.oauthAccount?.emailAddress?.trim().toLowerCase() || undefined,
  };
});

const CLAIM_OUTCOMES = {
  reset: "reset",
  not_limited: "nothingToReset",
  already_used: "alreadyRedeemed",
  ineligible: "noCredit",
} as const satisfies Record<string, ProviderConsumeResetCreditOutcome>;

/**
 * Claims `grantId`. `requestId` is the idempotency key: a retry with the same
 * id is the same claim. Ids are checked before anything is sent.
 */
export const claimClaudeResetCredit = Effect.fn("claimClaudeResetCredit")(function* (input: {
  readonly token: string;
  readonly organization: string;
  readonly grantId: string;
  readonly requestId: string;
}) {
  if (!GRANT_ID.test(input.grantId) || !REQUEST_ID.test(input.requestId)) {
    return yield* new ClaudeResetCreditError({ reason: "malformedCredit" });
  }
  const client = yield* HttpClient.HttpClient;
  const response = yield* client
    .execute(
      HttpClientRequest.post(
        new URL(
          `/api/organizations/${encodeURIComponent(input.organization)}/reset_rate_limits`,
          API_BASE,
        ),
      ).pipe(
        HttpClientRequest.setHeaders({
          authorization: `Bearer ${input.token}`,
          "anthropic-beta": OAUTH_BETA_HEADER,
          accept: "application/json",
        }),
        HttpClientRequest.bodyJsonUnsafe({
          program: CLAUDE_RESET_CREDITS_PROGRAM,
          grant_id: input.grantId,
          request_id: input.requestId,
        }),
      ),
    )
    .pipe(
      Effect.timeout("25 seconds"),
      Effect.mapError((cause) => new ClaudeResetCreditError({ reason: "requestFailed", cause })),
    );
  if (response.status === 429) {
    return yield* new ClaudeResetCreditError({ reason: "rateLimited" });
  }
  if (response.status === 401 || response.status === 403) {
    return yield* new ClaudeResetCreditError({ reason: "signedOut" });
  }
  const body = yield* HttpClientResponse.filterStatusOk(response).pipe(
    Effect.flatMap(HttpClientResponse.schemaBodyJson(ClaimResponse)),
    Effect.timeout("25 seconds"),
    Effect.mapError((cause) => new ClaudeResetCreditError({ reason: "requestFailed", cause })),
  );
  if (body.result === "cooldown") {
    return yield* new ClaudeResetCreditError({ reason: "coolingDown" });
  }
  // Claude could not say whether the claim landed, so, like the CLI, keep the
  // request id and let the retry ask about the same claim.
  if (body.result === "unavailable") {
    return yield* new ClaudeResetCreditError({ reason: "unconfirmed" });
  }
  return CLAIM_OUTCOMES[body.result];
});

export interface ClaudeResetCredential {
  readonly token: string;
  /** Opaque identity of the login; equal only for the same config dir and token. */
  readonly credentialKey: string;
  readonly accountConfigPath: string;
}

/**
 * Redeem the credit the client displayed, or refuse.
 *
 * The checks run twice: once before queueing, so a stale confirmation never
 * waits on the account lock, and again inside it, because a confirmation that
 * queued behind another may find the account, the credit or the instance gone
 * by the time it runs. Every refusal happens before anything is sent.
 */
export const redeemClaudeResetCredit = Effect.fn("redeemClaudeResetCredit")(function* <R>(input: {
  readonly creditId: string | undefined;
  readonly requestId: string | undefined;
  /** Instances sharing this scope (the config dir) share the login and its attempts. */
  readonly attemptScope: string;
  readonly isCurrent: Effect.Effect<boolean>;
  readonly getSnapshot: Effect.Effect<Pick<ServerProvider, "auth" | "usageLimits">>;
  /** The login the displayed credit was read with. */
  readonly displayedCredentialKey: Effect.Effect<string | undefined>;
  readonly readCredential: Effect.Effect<ClaudeResetCredential | undefined, never, R>;
  readonly coordinator: ResetCreditCoordinator["Service"];
  /** Re-read the limits after Claude answered; a returned string is a warning for the user. */
  readonly refresh: (
    outcome: ProviderConsumeResetCreditOutcome,
  ) => Effect.Effect<string | undefined, never, R>;
}) {
  const creditId = input.creditId;
  if (!creditId) return yield* new ClaudeResetCreditError({ reason: "clientOutdated" });
  if (!GRANT_ID.test(creditId)) {
    return yield* new ClaudeResetCreditError({ reason: "malformedCredit" });
  }
  const displayed = Effect.gen(function* () {
    if (!(yield* input.isCurrent)) {
      return yield* new ClaudeResetCreditError({ reason: "instanceRetired" });
    }
    const { auth, usageLimits } = yield* input.getSnapshot;
    const identity = authenticatedUsageIdentity(auth);
    const email = auth.email?.trim().toLowerCase();
    if (!identity || !email || auth.type === "apiKey" || auth.type === "bedrock") {
      return yield* new ClaudeResetCreditError({ reason: "accountUnverified" });
    }
    const credits = usageLimits?.resetCredits;
    if (!credits?.redeemable || credits.availableCount === 0 || credits.nextCreditId !== creditId) {
      return yield* new ClaudeResetCreditError({ reason: "staleCredit" });
    }
    return { identity, email };
  });
  const confirmed = yield* displayed;
  return yield* input.coordinator.redeem(
    // One attempt per displayed credit: a retry re-sends the same claim, and a
    // later credit on the same account never inherits an earlier claim's id.
    sharedUsageReadKey(["claude-reset", input.attemptScope, confirmed.identity, creditId]),
    input.requestId,
    (
      requestId,
    ): Effect.Effect<
      ProviderConsumeResetCreditResult,
      ClaudeResetCreditError,
      R | FileSystem.FileSystem | HttpClient.HttpClient
    > =>
      Effect.gen(function* () {
        const current = yield* displayed;
        if (current.identity !== confirmed.identity) {
          return yield* new ClaudeResetCreditError({ reason: "accountChanged" });
        }
        const credential = yield* input.readCredential;
        if (!credential) return yield* new ClaudeResetCreditError({ reason: "signedOut" });
        if (credential.credentialKey !== (yield* input.displayedCredentialKey)) {
          return yield* new ClaudeResetCreditError({ reason: "loginChanged" });
        }
        const account = yield* readAccount(credential.accountConfigPath);
        if (!account.organization) {
          return yield* new ClaudeResetCreditError({ reason: "signedOut" });
        }
        // The organization is only trusted when the record naming it names the
        // displayed account too.
        if (account.email !== current.email) {
          return yield* new ClaudeResetCreditError({ reason: "accountChanged" });
        }
        if (!(yield* input.isCurrent)) {
          return yield* new ClaudeResetCreditError({ reason: "instanceRetired" });
        }
        const outcome = yield* claimClaudeResetCredit({
          token: credential.token,
          organization: account.organization,
          grantId: creditId,
          requestId,
        });
        const warning = yield* input.refresh(outcome);
        return warning ? { outcome, warning } : { outcome };
      }),
    isSettledClaudeResetCreditFailure,
  );
});
