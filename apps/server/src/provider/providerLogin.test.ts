import { assert, describe, it } from "@effect/vitest";

import {
  claudeLoginArgs,
  isAwaitingProviderLoginCode,
  isProviderLoginMethod,
  parseProviderLoginUrl,
  providerLoginFailureMessage,
} from "./providerLogin.ts";

// Captured from `claude auth login` (2.1.220) against an empty config dir.
const REAL_OUTPUT = `Opening browser to sign in…
If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile&code_challenge=KrhszXTIu6L2HObZifZJ85fzqIDgcIzfOywH2ByFZUM&code_challenge_method=S256&state=Z7zfIx0RcnwVsm3pWkP3CcOt8d5sby1sujOPbA8PCBQ
Paste code here if prompted > `;

describe("parseProviderLoginUrl", () => {
  it("recovers the authorization URL from real CLI output", () => {
    const url = parseProviderLoginUrl(REAL_OUTPUT);

    assert.isTrue(url?.startsWith("https://claude.com/cai/oauth/authorize?"));
    // Query string must survive intact — a truncated URL fails after the user
    // has already opened a browser, which is the worst place to fail.
    assert.include(url ?? "", "code_challenge_method=S256");
    assert.include(url ?? "", "state=Z7zfIx0RcnwVsm3pWkP3CcOt8d5sby1sujOPbA8PCBQ");
  });

  // The first reads arrive before the URL is printed. That is normal startup,
  // not an error, and reporting it as one would fail every sign-in.
  it("returns undefined before the URL is printed", () => {
    assert.isUndefined(parseProviderLoginUrl("Opening browser to sign in…\n"));
    assert.isUndefined(parseProviderLoginUrl(""));
  });

  it("drops punctuation the CLI puts after the URL", () => {
    assert.strictEqual(
      parseProviderLoginUrl("visit: https://claude.com/cai/oauth/authorize?code=true."),
      "https://claude.com/cai/oauth/authorize?code=true",
    );
  });
});

describe("isAwaitingProviderLoginCode", () => {
  it("detects the paste prompt so the code box opens at the right moment", () => {
    assert.isTrue(isAwaitingProviderLoginCode(REAL_OUTPUT));
  });

  it("stays false while the CLI is still starting", () => {
    assert.isFalse(isAwaitingProviderLoginCode("Opening browser to sign in…\n"));
  });
});

describe("claudeLoginArgs", () => {
  // A Console account cannot sign in through the subscription flow and vice
  // versa, so these flags are the difference between working and not.
  it.each([
    ["subscription", ["auth", "login", "--claudeai"]],
    ["console", ["auth", "login", "--console"]],
    ["sso", ["auth", "login", "--claudeai", "--sso"]],
  ] as const)("selects the %s flow", (method, expected) => {
    assert.deepStrictEqual(claudeLoginArgs({ method }), expected);
  });

  // Without this the browser is usually still signed in as the existing
  // account, and the user silently authenticates the same one twice.
  it("pre-fills the email so the wrong account is not re-authenticated", () => {
    assert.deepStrictEqual(claudeLoginArgs({ method: "subscription", email: "a@b.com" }), [
      "auth",
      "login",
      "--claudeai",
      "--email",
      "a@b.com",
    ]);
  });

  it("omits a blank email rather than passing an empty flag", () => {
    assert.deepStrictEqual(claudeLoginArgs({ method: "subscription", email: "   " }), [
      "auth",
      "login",
      "--claudeai",
    ]);
  });
});

describe("providerLoginFailureMessage", () => {
  it("says nothing when the CLI exited cleanly", () => {
    assert.isUndefined(providerLoginFailureMessage({ exitCode: 0, output: "done" }));
  });

  it("surfaces the CLI's own last words rather than an exit code", () => {
    assert.strictEqual(
      providerLoginFailureMessage({ exitCode: 1, output: "Opening browser…\nInvalid code\n" }),
      "Invalid code",
    );
  });

  // A URL is not an explanation, and echoing one back as the error would be
  // both confusing and a needless place to leak a code challenge.
  it("never reports the URL line as the failure", () => {
    const message = providerLoginFailureMessage({ exitCode: 1, output: REAL_OUTPUT });

    assert.notInclude(message ?? "", "https://");
  });

  it("falls back to the exit code when the CLI said nothing", () => {
    assert.strictEqual(
      providerLoginFailureMessage({ exitCode: 7, output: "   \n" }),
      "Sign-in exited with code 7.",
    );
  });
});

describe("isProviderLoginMethod", () => {
  it("accepts the supported flows and rejects anything else", () => {
    assert.isTrue(isProviderLoginMethod("console"));
    assert.isFalse(isProviderLoginMethod("magic-link"));
  });
});
