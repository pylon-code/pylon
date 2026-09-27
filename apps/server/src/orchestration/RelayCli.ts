import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import { relayCliFromEnvironment } from "../provider/relayMcpConfig.ts";

const decodeInstalledPlugins = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      plugins: Schema.Record(Schema.String, Schema.Unknown),
    }),
  ),
);
const decodeInstallations = Schema.decodeUnknownOption(
  Schema.Array(Schema.Struct({ scope: Schema.String, installPath: Schema.String })),
);

/** Observe an installed plugin without requiring GUI launches to inherit shell configuration. */
export const resolveRelayCliPath = Effect.fn("resolveRelayCliPath")(function* (
  environment: NodeJS.ProcessEnv,
) {
  // An explicit override remains authoritative, including an invalid one. Do
  // not silently observe a different installation when configuration is wrong.
  if (environment.PYLON_RELAY_CLI !== undefined) return relayCliFromEnvironment(environment);

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const claudeHome = yield* resolveClaudeHomePath({ homePath: "" }, environment);
  const contents = yield* fs
    .readFileString(path.join(claudeHome, "plugins", "installed_plugins.json"))
    .pipe(Effect.orElseSucceed(() => undefined));
  if (contents === undefined) return undefined;
  const installed = decodeInstalledPlugins(contents);
  if (installed._tag === "None") return undefined;

  const candidates = new Set<string>();
  for (const [name, value] of Object.entries(installed.value.plugins)) {
    if (!name.startsWith("relay-orchestrator@")) continue;
    const entries = decodeInstallations(value);
    // Unrelated registry entries do not govern Relay. A malformed Relay entry
    // could hide another installation, though, so leave that selection explicit.
    if (entries._tag === "None") return undefined;
    for (const entry of entries.value) {
      // The bridge is environment-wide. A project-scoped plugin must not pick
      // the observer for other projects, nor should an old cached version.
      if (entry.scope !== "user" || !path.isAbsolute(entry.installPath)) continue;
      candidates.add(path.join(entry.installPath, "scripts", "relay.mjs"));
    }
  }
  if (candidates.size !== 1) return undefined;
  const [candidate] = candidates;
  if (candidate === undefined) return undefined;
  const stat = yield* fs.stat(candidate).pipe(Effect.orElseSucceed(() => undefined));
  return stat?.type === "File" ? candidate : undefined;
});
