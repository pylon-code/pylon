/**
 * Which ChatGPT account a Codex home is signed in to.
 *
 * The app-server's `account/read` reports the plan and email but not the
 * account id, and the id is what other sign-ins carry — Prime Agent records
 * the ChatGPT account it authenticated as by id alone. So the id is read from
 * Codex's own `auth.json`, the same file the CLI reads, and nothing else in
 * it is looked at. Read-only: Pylon never refreshes or rewrites another
 * program's credentials.
 *
 * @module provider/codexAccountIdentity
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const CodexAuthFile = Schema.Struct({
  tokens: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        account_id: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});

const decodeCodexAuthFile = Schema.decodeUnknownOption(Schema.fromJsonString(CodexAuthFile));

/** The account id in a Codex `auth.json`, or nothing when it has none this build can read. */
export function codexAccountIdFromAuthFile(raw: string): string | undefined {
  const decoded = decodeCodexAuthFile(raw);
  if (Option.isNone(decoded)) return undefined;
  const accountId = decoded.value.tokens?.account_id?.trim();
  return accountId ? accountId : undefined;
}

export const readCodexAccountId = Effect.fn("readCodexAccountId")(function* (
  sharedHomePath: string,
): Effect.fn.Return<string | undefined, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const raw = yield* fileSystem.readFileString(path.join(sharedHomePath, "auth.json")).pipe(
    Effect.map(Option.some),
    Effect.catchCause(() => Effect.succeed(Option.none<string>())),
  );
  return Option.isNone(raw) ? undefined : codexAccountIdFromAuthFile(raw.value);
});
