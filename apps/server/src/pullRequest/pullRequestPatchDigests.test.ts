import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { fileDigestsFromPatch } from "./pullRequestPatchDigests.ts";

const scope = {
  provider: "gitlab",
  host: "git.example",
  remote: "https://git.example/group/app",
  number: 7,
};

const first = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-old
+new
`;
const second = `diff --git a/src/b.ts b/src/b.ts
index 333..444 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -1 +1 @@
-before
+after
`;

it.effect("binds a digest to one displayed file and repository while preserving page moves", () =>
  Effect.sync(() => {
    const together = fileDigestsFromPatch(first + second, false, scope);
    const moved = fileDigestsFromPatch(second, false, scope);
    assert.strictEqual(together[1]?.digest, moved[0]?.digest);
    assert.notStrictEqual(
      together[0]?.digest,
      fileDigestsFromPatch(first.replace("+new", "+changed"), false, scope)[0]?.digest,
    );
    assert.notStrictEqual(
      together[0]?.digest,
      fileDigestsFromPatch(first, false, { ...scope, host: "other.example" })[0]?.digest,
    );
  }),
);

it.effect("withholds tokens for incomplete, binary, and duplicate path sections", () =>
  Effect.sync(() => {
    assert.deepStrictEqual(fileDigestsFromPatch(first, true, scope), []);
    assert.deepStrictEqual(fileDigestsFromPatch(first.replace("+new\n", ""), false, scope), []);
    assert.deepStrictEqual(
      fileDigestsFromPatch(
        "diff --git a/image.png b/image.png\nBinary files a/image.png and b/image.png differ\n",
        false,
        scope,
      ),
      [],
    );
    assert.deepStrictEqual(fileDigestsFromPatch(first + first, false, scope), []);
    assert.deepStrictEqual(fileDigestsFromPatch(first, false, scope, new Set(["src/a.ts"])), []);
  }),
);
