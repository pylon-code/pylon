import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { codexAccountIdFromAuthFile, readCodexAccountId } from "./codexAccountIdentity.ts";

describe("codexAccountIdFromAuthFile", () => {
  it("reads the account id and nothing else", () => {
    assert.strictEqual(
      codexAccountIdFromAuthFile(
        JSON.stringify({
          OPENAI_API_KEY: null,
          auth_mode: "chatgpt",
          tokens: {
            access_token: "secret",
            refresh_token: "secret",
            id_token: "secret",
            account_id: "acct_123",
          },
        }),
      ),
      "acct_123",
    );
  });

  it.each([
    ["an API-key login with no tokens", JSON.stringify({ auth_mode: "apikey", tokens: null })],
    ["a blank id", JSON.stringify({ tokens: { account_id: "  " } })],
    ["no tokens at all", JSON.stringify({})],
    ["not JSON", "{oops"],
  ])("yields nothing for %s", (_label, raw) => {
    assert.strictEqual(codexAccountIdFromAuthFile(raw), undefined);
  });
});

it.layer(NodeServices.layer)("readCodexAccountId", (it) => {
  it.effect("reads from the home's auth file and tolerates a missing one", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "pylon-codex-home-" });

      assert.strictEqual(yield* readCodexAccountId(home), undefined);
      yield* fs.writeFileString(
        path.join(home, "auth.json"),
        '{"tokens":{"account_id":"acct_456"}}',
      );
      assert.strictEqual(yield* readCodexAccountId(home), "acct_456");
    }).pipe(Effect.scoped),
  );
});
