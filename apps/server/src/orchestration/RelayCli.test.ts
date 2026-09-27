import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { resolveRelayCliPath } from "./RelayCli.ts";

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped();
  const plugin = path.join(home, "plugins", "cache", "relay-local", "relay-orchestrator", "1.0.9");
  const cli = path.join(plugin, "scripts", "relay.mjs");
  const registry = path.join(home, "plugins", "installed_plugins.json");
  yield* fs.makeDirectory(path.dirname(cli), { recursive: true });
  yield* fs.writeFileString(cli, "");
  const writeRegistry = (plugins: unknown) =>
    fs.writeFileString(registry, JSON.stringify({ version: 2, plugins }));
  yield* writeRegistry({
    "relay-orchestrator@relay-local": [
      { scope: "user", installPath: plugin },
      { scope: "project", installPath: path.join(home, "old-project-plugin") },
    ],
  });
  return { fs, path, home, plugin, cli, registry, writeRegistry };
});

it.layer(NodeServices.layer)("Relay CLI discovery", (it) => {
  it.effect("finds the registered user plugin in the server's Claude home", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      expect(yield* resolveRelayCliPath({ CLAUDE_CONFIG_DIR: f.home })).toBe(f.cli);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps explicit overrides authoritative, even when invalid or empty", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const override = f.path.join(f.home, "custom-relay.mjs");
      for (const [value, expected] of [
        [override, override],
        ["relative/relay.mjs", undefined],
        ["", undefined],
      ] as const) {
        expect(
          yield* resolveRelayCliPath({ CLAUDE_CONFIG_DIR: f.home, PYLON_RELAY_CLI: value }),
        ).toBe(expected);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("ignores project-only, unrelated, relative, and ambiguous installations", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      for (const plugins of [
        { "relay-orchestrator@relay-local": [{ scope: "project", installPath: f.plugin }] },
        { "other-relay-orchestrator@relay-local": [{ scope: "user", installPath: f.plugin }] },
        { "relay-orchestrator@relay-local": [{ scope: "user", installPath: "relative" }] },
        {
          "relay-orchestrator@relay-local": [{ scope: "user", installPath: f.plugin }],
          "relay-orchestrator@other": [
            { scope: "user", installPath: f.path.join(f.home, "other") },
          ],
        },
      ]) {
        yield* f.writeRegistry(plugins);
        expect(yield* resolveRelayCliPath({ CLAUDE_CONFIG_DIR: f.home })).toBeUndefined();
      }
    }).pipe(Effect.scoped),
  );

  it.effect("tolerates missing or malformed registries and missing CLI files", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.fs.remove(f.cli);
      expect(yield* resolveRelayCliPath({ CLAUDE_CONFIG_DIR: f.home })).toBeUndefined();
      yield* f.fs.makeDirectory(f.cli);
      expect(yield* resolveRelayCliPath({ CLAUDE_CONFIG_DIR: f.home })).toBeUndefined();
      for (const contents of ["not json", "{}", '{"plugins":null}']) {
        yield* f.fs.writeFileString(f.registry, contents);
        expect(yield* resolveRelayCliPath({ CLAUDE_CONFIG_DIR: f.home })).toBeUndefined();
      }
      yield* f.fs.remove(f.registry);
      expect(yield* resolveRelayCliPath({ CLAUDE_CONFIG_DIR: f.home })).toBeUndefined();
    }).pipe(Effect.scoped),
  );
});
