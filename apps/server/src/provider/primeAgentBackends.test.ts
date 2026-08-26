import { assert, describe, it } from "@effect/vitest";

import { primeAgentSignInsFromAuthFile } from "./primeAgentBackends.ts";

const NOW = Date.parse("2026-08-06T12:00:00.000Z");

// Shaped like a real `~/.prime/agent/auth.json`: one entry per backend, with
// the token fields Pylon never reads alongside the ones it does.
const AUTH_FILE = {
  anthropic: {
    type: "oauth",
    refresh: "refresh-secret",
    access: "access-secret",
    expires: NOW + 30 * 60_000,
  },
  "openai-codex": {
    type: "oauth",
    access: "access-secret",
    refresh: "refresh-secret",
    expires: NOW + 30 * 60_000,
    accountId: "acct_123",
  },
};

describe("primeAgentSignInsFromAuthFile", () => {
  it("keeps the Codex identity and a fresh Anthropic token", () => {
    assert.deepStrictEqual(primeAgentSignInsFromAuthFile(JSON.stringify(AUTH_FILE), NOW), [
      { backend: "anthropic", accessToken: "access-secret" },
      { backend: "openai-codex", accountId: "acct_123" },
    ]);
  });

  // Prime only refreshes the token while it is running on Anthropic; sending
  // an expired one buys a 401 and nothing else.
  it("drops an Anthropic token that has expired or is about to", () => {
    const expired = {
      ...AUTH_FILE,
      anthropic: { ...AUTH_FILE.anthropic, expires: NOW - 1 },
    };
    const expiring = {
      ...AUTH_FILE,
      anthropic: { ...AUTH_FILE.anthropic, expires: NOW + 30_000 },
    };

    assert.deepStrictEqual(primeAgentSignInsFromAuthFile(JSON.stringify(expired), NOW)[0], {
      backend: "anthropic",
    });
    assert.deepStrictEqual(primeAgentSignInsFromAuthFile(JSON.stringify(expiring), NOW)[0], {
      backend: "anthropic",
    });
  });

  it("ignores backends Pylon has no provider for", () => {
    const withExtra = { ...AUTH_FILE, "prime-inference": { type: "api", access: "k" } };

    assert.deepStrictEqual(
      primeAgentSignInsFromAuthFile(JSON.stringify(withExtra), NOW).map((entry) => entry.backend),
      ["anthropic", "openai-codex"],
    );
  });

  it.each([
    ["not JSON", "{oops"],
    ["an empty file", "{}"],
    ["a Codex entry with no account id", JSON.stringify({ "openai-codex": { type: "oauth" } })],
  ])("yields nothing for %s", (_label, raw) => {
    assert.deepStrictEqual(primeAgentSignInsFromAuthFile(raw, NOW), []);
  });
});
