// @effect-diagnostics nodeBuiltinImport:off - path helpers keep the runtime-home assertions plain.
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import {
  formatLegacyRuntimeHomeHint,
  hydratePosixHome,
  warnAboutLegacyRuntimeHome,
  resolveBaseDir,
} from "./os-jank.ts";

it("hydrates HOME for minimal service environments from the user account", () => {
  const env: NodeJS.ProcessEnv = {};

  hydratePosixHome(env);

  assert.equal(env.HOME, NodeOS.userInfo().homedir);
});

it("hydrates HOME independently of a blank process HOME", () => {
  const originalHome = process.env.HOME;
  const env: NodeJS.ProcessEnv = { HOME: " " };

  try {
    process.env.HOME = " ";
    hydratePosixHome(env);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }

  assert.equal(env.HOME, NodeOS.userInfo().homedir);
});

it("preserves an explicitly configured HOME", () => {
  const env: NodeJS.ProcessEnv = { HOME: "/custom/home" };

  hydratePosixHome(env, () => {
    throw new Error("HOME lookup should not run");
  });

  assert.equal(env.HOME, "/custom/home");
});

describe("resolveBaseDir", () => {
  // `~/.t3` is T3 Code's install. Defaulting to it would open a database
  // carrying upstream's migration numbering, which fails on the first query.
  it.effect("defaults to the Pylon runtime home", () =>
    Effect.gen(function* () {
      const expected = NodePath.join(NodeOS.homedir(), ".pylon-code");
      assert.equal(yield* resolveBaseDir(undefined), expected);
      assert.equal(yield* resolveBaseDir(""), expected);
      assert.equal(yield* resolveBaseDir("   "), expected);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("resolves an explicit base directory unchanged", () =>
    Effect.gen(function* () {
      assert.equal(yield* resolveBaseDir("/srv/pylon"), "/srv/pylon");
      assert.equal(yield* resolveBaseDir("  /srv/pylon  "), "/srv/pylon");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  // The compatibility path stays reachable: this is how a user keeps an
  // existing `~/.t3` install after the default moved.
  it.effect("still expands a leading tilde", () =>
    Effect.gen(function* () {
      assert.equal(yield* resolveBaseDir("~/.t3"), NodePath.join(NodeOS.homedir(), ".t3"));
      assert.equal(yield* resolveBaseDir("~"), NodeOS.homedir());
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("warnAboutLegacyRuntimeHome", () => {
  /**
   * A throwaway home directory. Nothing here may read the developer's real
   * `~/.pylon-code` or `~/.t3`, so the homedir is always injected.
   */
  const makeHome = Effect.fn(function* (options: {
    readonly pylonState: boolean;
    readonly legacyState: boolean;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const homeDir = yield* fs.makeTempDirectoryScoped({ prefix: "pylon-runtime-home-test-" });
    if (options.pylonState) {
      yield* fs.makeDirectory(NodePath.join(homeDir, ".pylon-code", "userdata"), {
        recursive: true,
      });
    }
    if (options.legacyState) {
      yield* fs.makeDirectory(NodePath.join(homeDir, ".t3", "userdata"), { recursive: true });
    }
    return homeDir;
  });

  const hintMessages = Effect.fn(function* (options: {
    readonly pylonState: boolean;
    readonly legacyState: boolean;
    readonly baseDirIsExplicit?: boolean;
    readonly stateDirName?: string;
    readonly baseDirName?: string;
  }) {
    const homeDir = yield* makeHome(options);
    const baseDir = NodePath.join(homeDir, options.baseDirName ?? ".pylon-code");
    const written: Array<string> = [];
    yield* warnAboutLegacyRuntimeHome({
      baseDir,
      stateDir: NodePath.join(baseDir, options.stateDirName ?? "userdata"),
      baseDirIsExplicit: options.baseDirIsExplicit ?? false,
      homeDir,
      write: (message) => written.push(message),
    });
    return { homeDir, baseDir, messages: written };
  });

  it.effect("names the older state directory on a fresh default launch", () =>
    Effect.gen(function* () {
      const { baseDir, homeDir, messages } = yield* hintMessages({
        pylonState: false,
        legacyState: true,
      });
      const legacyBaseDir = NodePath.join(homeDir, ".t3");
      assert.deepEqual(messages, [
        `${formatLegacyRuntimeHomeHint({
          stateDir: NodePath.join(baseDir, "userdata"),
          legacyStateDir: NodePath.join(legacyBaseDir, "userdata"),
          legacyBaseDir,
        })}\n`,
      ]);
      // The migration is the state directory, not its parent: settings and
      // secrets live inside `userdata`, while the parent also holds caches and
      // worktrees that must not move.
      const hint = messages[0] ?? "";
      assert.include(hint, `move ${NodePath.join(legacyBaseDir, "userdata")}`);
      assert.include(hint, `to ${NodePath.join(baseDir, "userdata")}`);
      assert.notInclude(hint, `move that directory`);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("says nothing once Pylon has its own state", () =>
    Effect.gen(function* () {
      const { messages } = yield* hintMessages({ pylonState: true, legacyState: true });
      assert.deepEqual(messages, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("says nothing when there is no older state directory", () =>
    Effect.gen(function* () {
      const { messages } = yield* hintMessages({ pylonState: false, legacyState: false });
      assert.deepEqual(messages, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("says nothing when the user chose the base directory", () =>
    Effect.gen(function* () {
      const { messages } = yield* hintMessages({
        pylonState: false,
        legacyState: true,
        baseDirIsExplicit: true,
      });
      assert.deepEqual(messages, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  // A dev run keeps its state in `<base>/dev`, so an empty `userdata` says
  // nothing about whether the user has migrated.
  it.effect("says nothing for a dev state directory", () =>
    Effect.gen(function* () {
      const { messages } = yield* hintMessages({
        pylonState: false,
        legacyState: true,
        stateDirName: "dev",
      });
      assert.deepEqual(messages, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("says nothing when the base directory is not the default", () =>
    Effect.gen(function* () {
      const { messages } = yield* hintMessages({
        pylonState: false,
        legacyState: true,
        baseDirName: "elsewhere",
      });
      assert.deepEqual(messages, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
