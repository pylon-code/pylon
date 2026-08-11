// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

// @ts-expect-error -- Vite Plus provides the Vitest runner transitively to server tests.
import { describe, expect, it } from "vitest";

import {
  JCODE_MAX_UNIX_SOCKET_PATH,
  jcodeDefaultLaunchAliasBase,
  jcodeHomePath,
  jcodeLaunchAliasPath,
  jcodeLaunchHomeFitsUnixLimit,
  jcodeLongestRuntimeSocketPath,
  jcodeProviderRoot,
  jcodeThreadIdentityPath,
} from "./JcodePaths.ts";

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

/**
 * State directories Pylon actually derives, which is where the durable home
 * lives. The compatibility matrix already failed at 104 bytes; every one of
 * these is longer still, so the launch path must stop depending on how deep the
 * state directory happens to be.
 */
const REAL_STATE_DIRS = [
  "/Users/rynfar/.pylon-code/userdata",
  "/Users/rynfar/.pylon-code/dev",
  "/Users/rynfar/.t3/userdata",
  "/home/a-considerably-longer-account-name/.pylon-code/userdata",
  "/Users/rynfar/repos/pylon/.prime/worktrees/prime-agent-integration/.t3/userdata",
];

/** The ID shapes a real provider instance actually gets. */
const REAL_INSTANCE_IDS = [
  "jcode-9f1c2e4a-77b8-4d2e-9a31-5c6b0e7d8f42",
  "01JCODE7ZK9QW3M5N8P2R4T6V8",
];

/** Short enough to fit on a shallow state directory, which is the trap. */
const SHORT_INSTANCE_ID = "instance-1";

describe("JcodePaths launch home", () => {
  it("states the platform limit the SDK's longest runtime socket must fit", () => {
    // `sun_path` is 104 bytes including the NUL terminator, so 103 is the
    // longest bindable path. Measured against the real runtime, not assumed:
    // an 82-character home binds and an 83-character one does not.
    expect(JCODE_MAX_UNIX_SOCKET_PATH).toBe(103);
    expect(jcodeLongestRuntimeSocketPath({ launchHome: "/a" })).toBe(
      NodePath.join("/a", "run", "jcode-debug.sock"),
    );
  });

  it("proves the durable home cannot host sockets for real ids and state directories", () => {
    for (const stateDir of REAL_STATE_DIRS) {
      for (const instanceId of REAL_INSTANCE_IDS) {
        const home = jcodeHomePath({ stateDir, instanceId });
        expect(jcodeLaunchHomeFitsUnixLimit({ launchHome: home })).toBe(false);
      }
    }
  });

  it("shows why shortening the durable path alone would be a fragile fix", () => {
    // A short id on the shallowest real state directory lands on exactly the
    // limit: it works, with one byte to spare. Whether the durable home is
    // usable therefore depends on how the user named their home directory,
    // which is why the launch path is decoupled from it instead of trimmed.
    const borderline = jcodeHomePath({
      stateDir: "/Users/rynfar/.pylon-code/userdata",
      instanceId: SHORT_INSTANCE_ID,
    });
    expect(jcodeLongestRuntimeSocketPath({ launchHome: borderline })).toHaveLength(
      JCODE_MAX_UNIX_SOCKET_PATH,
    );
    expect(jcodeLaunchHomeFitsUnixLimit({ launchHome: borderline })).toBe(true);

    // The same short id one directory deeper no longer fits.
    expect(
      jcodeLaunchHomeFitsUnixLimit({
        launchHome: jcodeHomePath({
          stateDir: "/Users/rynfar/.pylon-code/userdata/x",
          instanceId: SHORT_INSTANCE_ID,
        }),
      }),
    ).toBe(false);
  });

  it("keeps the alias launch home and its longest socket inside the limit", () => {
    const aliasBase = jcodeDefaultLaunchAliasBase({ uid: 501 });
    for (const stateDir of REAL_STATE_DIRS) {
      for (const instanceId of REAL_INSTANCE_IDS) {
        const alias = jcodeLaunchAliasPath({ aliasBase, stateDir, instanceId });
        expect(jcodeLaunchHomeFitsUnixLimit({ launchHome: alias })).toBe(true);
        expect(jcodeLongestRuntimeSocketPath({ launchHome: alias }).length).toBeLessThanOrEqual(
          JCODE_MAX_UNIX_SOCKET_PATH,
        );
      }
    }
  });

  it("maps each environment and instance to one stable non-colliding alias", () => {
    const aliasBase = jcodeDefaultLaunchAliasBase({ uid: 501 });
    const seen = new Set<string>();
    for (const stateDir of REAL_STATE_DIRS) {
      for (const instanceId of [...REAL_INSTANCE_IDS, ...HOSTILE_IDS]) {
        const alias = jcodeLaunchAliasPath({ aliasBase, stateDir, instanceId });
        // Stable across restarts, or a resumed instance would be pointed at a
        // different home and lose its durable sessions.
        expect(jcodeLaunchAliasPath({ aliasBase, stateDir, instanceId })).toBe(alias);
        expect(seen.has(alias)).toBe(false);
        seen.add(alias);
        // One opaque segment: a wire-supplied id never becomes path text.
        expect(NodePath.dirname(alias)).toBe(aliasBase);
        expect(NodePath.basename(alias)).toMatch(/^[0-9a-f]+$/);
      }
    }
    expect(seen.size).toBe(
      REAL_STATE_DIRS.length * (REAL_INSTANCE_IDS.length + HOSTILE_IDS.length),
    );
  });

  it("separates the same instance id across different environments", () => {
    const aliasBase = jcodeDefaultLaunchAliasBase({ uid: 501 });
    expect(
      jcodeLaunchAliasPath({
        aliasBase,
        stateDir: "/Users/rynfar/.pylon-code/userdata",
        instanceId: "instance-1",
      }),
    ).not.toBe(
      jcodeLaunchAliasPath({
        aliasBase,
        stateDir: "/Users/rynfar/.pylon-code/dev",
        instanceId: "instance-1",
      }),
    );
  });

  it("scopes the default alias base to the calling user", () => {
    expect(jcodeDefaultLaunchAliasBase({ uid: 501 })).toBe("/tmp/pylon-jcode-501");
    expect(jcodeDefaultLaunchAliasBase({ uid: 0 })).toBe("/tmp/pylon-jcode-0");
    expect(jcodeDefaultLaunchAliasBase({ uid: 501 })).not.toBe(
      jcodeDefaultLaunchAliasBase({ uid: 502 }),
    );
  });
});
