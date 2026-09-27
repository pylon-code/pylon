import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";
import { build } from "vite-plus/pack";
import { assert, it } from "vite-plus/test";

import desktopConfig from "../vite.config.ts";

it("keeps lazy Linux imports and worker bundles from executing desktop startup twice", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-desktop-bundle-"));
  try {
    const workerEntries = [
      "src/electron/WindowsForegroundFocusWorker.ts",
      "src/snapShot/GlobalShiftShortcutWorker.ts",
      "src/snapShot/RegionSnapShotWorker.ts",
      "src/snapShot/SnapShotAccessibilityWorker.ts",
    ];
    await Promise.all([
      NodeFSP.mkdir(NodePath.join(directory, "src/electron"), { recursive: true }),
      NodeFSP.mkdir(NodePath.join(directory, "src/snapShot"), { recursive: true }),
    ]);
    await Promise.all([
      NodeFSP.writeFile(
        NodePath.join(directory, "src/main.ts"),
        `import { shared } from "./shared.ts";
process.emit("startup", shared.value);
void import("./linux.ts").then(({ result }) => process.emit("ready", result));`,
      ),
      NodeFSP.writeFile(
        NodePath.join(directory, "src/shared.ts"),
        "export const shared = { value: 42 };",
      ),
      NodeFSP.writeFile(
        NodePath.join(directory, "src/linux.ts"),
        'import { shared } from "./shared.ts"; export const result = shared.value + 1;',
      ),
      ...workerEntries.map((entry) =>
        NodeFSP.writeFile(
          NodePath.join(directory, entry),
          'import { shared } from "../shared.ts"; process.emit("worker", shared.value);',
        ),
      ),
    ]);
    assert.ok(Array.isArray(desktopConfig.pack));
    const fixtureEntries = new Set(["src/main.ts", ...workerEntries]);
    for (const packConfig of desktopConfig.pack) {
      if (!Array.isArray(packConfig.entry)) continue;
      if (!packConfig.entry.some((entry) => fixtureEntries.has(entry))) continue;
      await build({
        ...packConfig,
        config: false,
        cwd: directory,
        tsconfig: false,
        sourcemap: false,
        onSuccess: undefined,
        logLevel: "silent",
      });
    }

    const outputDirectory = NodePath.join(directory, "dist-electron");
    const filenames = (await NodeFSP.readdir(outputDirectory, { recursive: true })).filter(
      (filename) => filename.endsWith(".cjs"),
    );
    const sources = new Map(
      await Promise.all(
        filenames.map(async (filename) => {
          const path = NodePath.join(outputDirectory, filename);
          return [path, await NodeFSP.readFile(path, "utf8")];
        }),
      ),
    );
    const modules = new Map();
    const startups = [];
    const workers = [];
    const ready = Promise.withResolvers();
    const load = (filename, cacheModule = true) => {
      const cached = modules.get(filename);
      if (cached) return cached.exports;
      const module = { exports: {} };
      if (cacheModule) modules.set(filename, module);
      const source = sources.get(filename);
      assert.ok(source, `Missing bundle: ${filename}`);
      NodeVM.runInNewContext(source, {
        exports: module.exports,
        module,
        require: (specifier) => load(NodePath.resolve(NodePath.dirname(filename), specifier)),
        process: {
          emit: (event, value) => {
            if (event === "startup") startups.push(value);
            if (event === "worker") workers.push(value);
            if (event === "ready") ready.resolve(value);
          },
        },
      });
      return module.exports;
    };

    load(NodePath.join(outputDirectory, "main.cjs"), false);
    assert.equal(await ready.promise, 43);
    assert.deepEqual(startups, [42]);
    for (const entry of workerEntries) {
      load(NodePath.join(outputDirectory, entry.replace(/^src\//, "").replace(/\.ts$/, ".cjs")));
    }
    assert.deepEqual(workers, [42, 42, 42, 42]);
    assert.deepEqual(startups, [42]);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("loads the emitted packaged boot entry and backend cache preload", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pylon-desktop-boot-"));
  try {
    const entries = ["src/boot.ts", "src/compileCache.ts"];
    await NodeFSP.mkdir(NodePath.join(directory, "src"));
    await Promise.all(
      entries.map((entry) =>
        NodeFSP.copyFile(new URL(`../${entry}`, import.meta.url), NodePath.join(directory, entry)),
      ),
    );
    assert.ok(Array.isArray(desktopConfig.pack));
    for (const packConfig of desktopConfig.pack) {
      if (!Array.isArray(packConfig.entry)) continue;
      if (!packConfig.entry.some((entry) => entries.includes(entry))) continue;
      await build({
        ...packConfig,
        config: false,
        cwd: directory,
        tsconfig: false,
        sourcemap: false,
        onSuccess: undefined,
        logLevel: "silent",
      });
    }
    const outputDirectory = NodePath.join(directory, "dist-electron");
    const fixture = `console.log(require('node:module').getCompileCacheDir() ? 'cached' : 'uncached');`;
    await NodeFSP.writeFile(NodePath.join(outputDirectory, "main.cjs"), fixture);
    await NodeFSP.writeFile(
      NodePath.join(outputDirectory, "backend.mjs"),
      `import { getCompileCacheDir } from 'node:module'; console.log(getCompileCacheDir() ? 'cached' : 'uncached');`,
    );
    for (const { disabled, appImage } of [
      { disabled: false, appImage: false },
      { disabled: true, appImage: false },
      { disabled: false, appImage: true },
    ]) {
      for (const args of [
        [NodePath.join(outputDirectory, "boot.cjs")],
        [
          "--require",
          NodePath.join(outputDirectory, "compileCache.cjs"),
          NodePath.join(outputDirectory, "backend.mjs"),
        ],
      ]) {
        const child = NodeChildProcess.spawnSync(process.execPath, args, {
          encoding: "utf8",
          env: {
            ...process.env,
            APPIMAGE: appImage ? "/tmp/.mount_pylon/Pylon.AppImage" : "",
            NODE_COMPILE_CACHE: undefined,
            NODE_DISABLE_COMPILE_CACHE: disabled ? "1" : undefined,
            XDG_CACHE_HOME: directory,
            TMPDIR: directory,
            TEMP: directory,
            TMP: directory,
          },
        });
        assert.equal(child.status, 0, child.stderr);
        assert.equal(child.stdout.trim(), disabled || appImage ? "uncached" : "cached");
      }
    }
    const boot = NodePath.join(outputDirectory, "boot.cjs");
    const runBoot = () =>
      NodeChildProcess.spawnSync(process.execPath, [boot], {
        encoding: "utf8",
        env: {
          ...process.env,
          APPIMAGE: "",
          NODE_COMPILE_CACHE: undefined,
          NODE_DISABLE_COMPILE_CACHE: undefined,
          XDG_CACHE_HOME: directory,
          TMPDIR: directory,
          TEMP: directory,
          TMP: directory,
        },
      });
    await NodeFSP.writeFile(NodePath.join(outputDirectory, "main.cjs"), "console.log('before');");
    const before = runBoot();
    assert.equal(before.status, 0, before.stderr);
    assert.equal(before.stdout.trim(), "before");
    await NodeFSP.writeFile(NodePath.join(outputDirectory, "main.cjs"), "console.log('after');");
    const after = runBoot();
    assert.equal(after.status, 0, after.stderr);
    assert.equal(after.stdout.trim(), "after");
    const blockedCacheRoot = NodePath.join(directory, "not-a-directory");
    await NodeFSP.writeFile(blockedCacheRoot, "occupied");
    const blocked = NodeChildProcess.spawnSync(process.execPath, [boot], {
      encoding: "utf8",
      env: {
        ...process.env,
        APPIMAGE: "",
        NODE_COMPILE_CACHE: undefined,
        NODE_DISABLE_COMPILE_CACHE: undefined,
        XDG_CACHE_HOME: blockedCacheRoot,
        TMPDIR: blockedCacheRoot,
        TEMP: blockedCacheRoot,
        TMP: blockedCacheRoot,
      },
    });
    assert.equal(blocked.status, 0, blocked.stderr);
    assert.equal(blocked.stdout.trim(), "after");
    const blockedBackend = NodeChildProcess.spawnSync(
      process.execPath,
      [
        "--require",
        NodePath.join(outputDirectory, "compileCache.cjs"),
        NodePath.join(outputDirectory, "backend.mjs"),
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          APPIMAGE: "",
          NODE_COMPILE_CACHE: undefined,
          NODE_DISABLE_COMPILE_CACHE: undefined,
          XDG_CACHE_HOME: blockedCacheRoot,
          TMPDIR: blockedCacheRoot,
          TEMP: blockedCacheRoot,
          TMP: blockedCacheRoot,
        },
      },
    );
    assert.equal(blockedBackend.status, 0, blockedBackend.stderr);
    assert.equal(blockedBackend.stdout.trim(), "uncached");
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});
