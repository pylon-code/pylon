/**
 * Hosting a provider CLI's interactive sign-in.
 *
 * `claude auth login` prints an authorization URL, opens a browser, then waits
 * on stdin for the code the browser hands back. That shape is what lets Pylon
 * host it without a terminal: read the URL out, show it, take the code, write
 * it back. The alternative — telling the user to open a shell — is why adding a
 * second account was a maintainer-only operation.
 *
 * The helpers here are the parts worth pinning: which flags select which
 * account type, and how the URL is recovered from CLI chatter that is free to
 * change wording around it.
 *
 * @module provider/providerLogin
 */

/**
 * Which sign-in a provider account uses.
 *
 * These are not interchangeable — a Console (API-billing) account cannot sign
 * in through the subscription flow, and an org that mandates SSO cannot use
 * either. Guessing sends the user through a flow that fails after they have
 * already authenticated in a browser, so the choice is asked for rather than
 * inferred.
 */
export type ProviderLoginMethod = "subscription" | "console" | "sso";

export const PROVIDER_LOGIN_METHODS: ReadonlyArray<ProviderLoginMethod> = [
  "subscription",
  "console",
  "sso",
];

export function isProviderLoginMethod(value: string): value is ProviderLoginMethod {
  return (PROVIDER_LOGIN_METHODS as ReadonlyArray<string>).includes(value);
}

/**
 * Arguments for `claude auth login`.
 *
 * `--email` only pre-fills the login page. It matters because the common
 * failure is signing back into the account you already have: the browser is
 * usually still logged in as that one, and nothing downstream notices until two
 * provider cards show the same address.
 */
export function claudeLoginArgs(input: {
  readonly method: ProviderLoginMethod;
  readonly email?: string | undefined;
}): ReadonlyArray<string> {
  const args = ["auth", "login"];
  if (input.method === "console") {
    args.push("--console");
  } else {
    args.push("--claudeai");
    if (input.method === "sso") args.push("--sso");
  }
  const email = input.email?.trim();
  if (email) args.push("--email", email);
  return args;
}

// Deliberately not anchored to the CLI's sentence: the prose around the URL is
// presentation and is free to change, while the URL itself is the contract.
const LOGIN_URL_PATTERN = /https:\/\/[^\s<>"']+/u;
const TRAILING_PUNCTUATION = /[.,;:)\]}]+$/u;

/**
 * Recover the authorization URL from the CLI's output.
 *
 * Returns `undefined` while the URL has not been printed yet, which is the
 * normal state for the first reads and must not be reported as a failure.
 */
export function parseProviderLoginUrl(output: string): string | undefined {
  const match = LOGIN_URL_PATTERN.exec(output);
  if (!match) return undefined;
  const url = match[0].replace(TRAILING_PUNCTUATION, "");
  return url.length > 0 ? url : undefined;
}

/**
 * Whether the CLI is waiting for the code to be pasted.
 *
 * Used to tell "still starting up" from "ready for the code", so the dialog can
 * enable its input at the right moment instead of accepting a code the process
 * would drop.
 */
export function isAwaitingProviderLoginCode(output: string): boolean {
  return /paste code here/iu.test(output);
}

/**
 * Whether a finished login actually signed in.
 *
 * A zero exit is not sufficient on its own: the CLI can exit cleanly after the
 * user abandons the browser, so the caller re-reads auth status rather than
 * trusting this alone. This only catches the loud failures.
 */
export function providerLoginFailureMessage(input: {
  readonly exitCode: number;
  readonly output: string;
}): string | undefined {
  if (input.exitCode === 0) return undefined;
  const lines = input.output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !LOGIN_URL_PATTERN.test(line));
  return lines.at(-1) ?? `Sign-in exited with code ${input.exitCode}.`;
}
