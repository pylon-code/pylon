// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

// @ts-expect-error -- Vite Plus provides the Vitest runner transitively to server tests.
import { describe, expect, it } from "vitest";

import { jcodeHomePath, jcodeProviderRoot, jcodeThreadIdentityPath } from "./JcodePaths.ts";

const STATE_DIR = "/state";

/** IDs a hostile or merely careless caller can realistically supply. */
const HOSTILE_IDS = [
  "..",
  ".",
  "../..",
  "../../etc/passwd",
  "a/b/c",
  "a\\b\\c",
  "with space",
  "with\ttab",
  "unicode-\u00e9\u4e2d\u6587-\ud83d\ude80",
  "trailing.",
  ".hidden",
  "~",
  "$HOME",
  "id:with:colons",
  "id\nnewline",
  "-".repeat(512),
];

describe("JcodePaths", () => {
  it("encodes instance and thread ids as direct base64url segments", () => {
    for (const id of HOSTILE_IDS) {
      const root = jcodeProviderRoot({ stateDir: STATE_DIR, instanceId: id });
      expect(NodePath.basename(root)).toMatch(/^b64-[A-Za-z0-9_-]+$/);
      expect(NodePath.basename(root)).toBe(`b64-${Buffer.from(id, "utf8").toString("base64url")}`);

      const identity = jcodeThreadIdentityPath({
        stateDir: STATE_DIR,
        instanceId: "instance-1",
        threadId: id,
      });
      expect(NodePath.basename(identity)).toMatch(/^b64-[A-Za-z0-9_-]+\.json$/);
      expect(NodePath.basename(identity)).toBe(
        `b64-${Buffer.from(id, "utf8").toString("base64url")}.json`,
      );
    }
  });

  it("keeps every derived path inside the jcode provider namespace", () => {
    const namespace = NodePath.resolve(STATE_DIR, "provider-sessions", "jcode");
    for (const id of HOSTILE_IDS) {
      for (const derived of [
        jcodeProviderRoot({ stateDir: STATE_DIR, instanceId: id }),
        jcodeHomePath({ stateDir: STATE_DIR, instanceId: id }),
        jcodeThreadIdentityPath({ stateDir: STATE_DIR, instanceId: id, threadId: id }),
      ]) {
        const resolved = NodePath.resolve(derived);
        const relative = NodePath.relative(namespace, resolved);
        expect(relative.startsWith("..")).toBe(false);
        expect(NodePath.isAbsolute(relative)).toBe(false);
        expect(resolved.startsWith(`${namespace}${NodePath.sep}`)).toBe(true);
      }
    }
  });

  it("lays out home and thread identity under one instance root", () => {
    const input = { stateDir: STATE_DIR, instanceId: "instance-1", threadId: "thread-1" };
    const root = jcodeProviderRoot(input);
    const home = jcodeHomePath(input);
    const identity = jcodeThreadIdentityPath(input);

    expect(root).toBe(
      NodePath.join(
        STATE_DIR,
        "provider-sessions",
        "jcode",
        `b64-${Buffer.from("instance-1", "utf8").toString("base64url")}`,
      ),
    );
    expect(home).toBe(NodePath.join(root, "home"));
    expect(identity).toBe(
      NodePath.join(
        root,
        "threads",
        `b64-${Buffer.from("thread-1", "utf8").toString("base64url")}.json`,
      ),
    );
    expect(NodePath.dirname(NodePath.dirname(identity))).toBe(root);
  });

  it("separates distinct ids and never collides across instances or threads", () => {
    const roots = new Set(
      HOSTILE_IDS.map((id) => jcodeProviderRoot({ stateDir: STATE_DIR, instanceId: id })),
    );
    expect(roots.size).toBe(HOSTILE_IDS.length);

    expect(jcodeProviderRoot({ stateDir: STATE_DIR, instanceId: "a/b" })).not.toBe(
      jcodeProviderRoot({ stateDir: STATE_DIR, instanceId: "a-b" }),
    );
    expect(
      jcodeThreadIdentityPath({ stateDir: STATE_DIR, instanceId: "a", threadId: "b" }),
    ).not.toBe(jcodeThreadIdentityPath({ stateDir: STATE_DIR, instanceId: "b", threadId: "a" }));
  });

  it("handles empty and oversized ids as ordinary opaque segments", () => {
    const empty = jcodeProviderRoot({ stateDir: STATE_DIR, instanceId: "" });
    expect(NodePath.basename(empty)).toBe("b64-");
    expect(NodePath.resolve(empty).startsWith(NodePath.resolve(STATE_DIR))).toBe(true);

    const oversized = "x".repeat(4096);
    const identity = jcodeThreadIdentityPath({
      stateDir: STATE_DIR,
      instanceId: "instance-1",
      threadId: oversized,
    });
    expect(NodePath.basename(identity)).toMatch(/^b64-[A-Za-z0-9_-]+\.json$/);
    expect(NodePath.basename(identity)).not.toContain("/");
  });

  it("accepts a custom join so Effect Path consumers stay platform correct", () => {
    const calls: Array<ReadonlyArray<string>> = [];
    const join = (...segments: ReadonlyArray<string>) => {
      calls.push(segments);
      return segments.join("|");
    };
    expect(jcodeHomePath({ stateDir: STATE_DIR, instanceId: "instance-1", join })).toContain("|");
    expect(calls.length).toBeGreaterThan(0);
  });
});
