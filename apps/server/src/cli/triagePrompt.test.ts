// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import {
  buildTriageContext,
  buildTriageLaunchPrompt,
  buildTriageSeedPrompt,
  TRIAGE_PLAYBOOK,
  type TriageContextInput,
} from "./triagePrompt.ts";

it("stays byte-identical to .github/triage/PLAYBOOK.md", () => {
  // Pylon has no runtime playbook fetch — the repo is private, so there is no
  // unauthenticated raw URL — which makes the embedded copy the only playbook a
  // release follows. The `.md` stays the human-editable source; this assertion
  // is what stops the shipped copy from drifting away from it. Edit both files
  // together, or regenerate the constant from the `.md`.
  const canonicalPath = NodePath.join(
    import.meta.dirname,
    "../../../../.github/triage/PLAYBOOK.md",
  );
  assert.equal(TRIAGE_PLAYBOOK, NodeFS.readFileSync(canonicalPath, "utf8"));
});

it("seed prompt names the context file and embeds the playbook", () => {
  const prompt = buildTriageSeedPrompt("/tmp/triage-run/context.md");
  assert.include(prompt, "/tmp/triage-run/context.md");
  assert.include(prompt, TRIAGE_PLAYBOOK);
});

it("launch prompt stays a single argv-safe line naming the prompt file", () => {
  // The launch argument goes through cmd.exe on Windows (.cmd shims), which
  // cannot carry newlines; the playbook itself must stay on disk.
  const launch = buildTriageLaunchPrompt(String.raw`C:\Users\a b\.t3\userdata\triage\x\prompt.md`);
  assert.notInclude(launch, "\n");
  assert.include(launch, String.raw`C:\Users\a b\.t3\userdata\triage\x\prompt.md`);
  assert.isBelow(launch.length, 1_000);
});

const baseContextInput = {
  generatedAt: "2026-08-13T00:00:00.000Z",
  version: "0.0.33",
  releaseTag: "v0.0.33",
  isNightly: false,
  issueRepository: null,
  sourceRepository: null,
  os: "linux x64 (7.0.0)",
  nodeVersion: "v24.0.0",
  launchedAs: "npx t3 triage",
  server: "running (pid 42, http://127.0.0.1:4501)",
  paths: {
    stateDir: "/home/u/.t3/userdata",
    dbPath: "/home/u/.t3/userdata/state.sqlite",
    settingsPath: "/home/u/.t3/userdata/settings.json",
    logsDir: "/home/u/.t3/userdata/logs",
    serverLogPath: "/home/u/.t3/userdata/logs/server.log",
    serverTracePath: "/home/u/.t3/userdata/logs/server.trace.ndjson",
    providerEventLogPath: "/home/u/.t3/userdata/logs/provider/events.log",
    terminalLogsDir: "/home/u/.t3/userdata/logs/terminals",
    providerStatusCacheDir: "/home/u/.t3/caches",
    secretsDir: "/home/u/.t3/userdata/secrets",
    sourceCacheDir: "/home/u/.t3/source",
  },
} satisfies TriageContextInput;

it("context file carries every path the playbook depends on", () => {
  const context = buildTriageContext(baseContextInput);
  assert.include(context, "/home/u/.t3/userdata/state.sqlite");
  assert.include(context, "/home/u/.t3/userdata/logs/server.trace.ndjson");
  assert.include(context, "/home/u/.t3/userdata/logs/provider/events.log");
  assert.include(context, "/home/u/.t3/userdata/secrets");
  assert.include(context, "/home/u/.t3/source");
  assert.include(context, "npx t3 triage");
  assert.include(context, "v0.0.33");
});

it("context file tells the agent not to post when no issue repository is configured", () => {
  // The default. `pylon-code/pylon` is private, so an agent that tried to file
  // there would send the user to a 404 and lose the issue it just wrote.
  const context = buildTriageContext({ ...baseContextInput, issueRepository: null });
  assert.include(context, "not configured");
  assert.include(context, "write it to a file");
});

it("context file keeps the source and issue repositories distinct", () => {
  // One value cannot serve both roles: an issues-only repo carries no code, so
  // cloning it would leave the agent mapping stack traces against an empty tree.
  const context = buildTriageContext({
    ...baseContextInput,
    sourceRepository: "https://github.com/example/pylon",
    issueRepository: "https://github.com/example/pylon-issues",
  });
  assert.include(
    context,
    "Source repository (clone this to read code): https://github.com/example/pylon",
  );
  assert.include(
    context,
    "Issue repository (search and file here): https://github.com/example/pylon-issues",
  );
});

it("release tag stays a bare git ref, with the nightly caveat on its own line", () => {
  // The playbook substitutes the tag straight into `git clone --branch`, so a
  // parenthetical inside it becomes part of the ref and the clone fails.
  const context = buildTriageContext({ ...baseContextInput, isNightly: true });
  assert.include(context, "- Release tag for this version: v0.0.33\n");
  assert.include(context, "Nightly build: this tag may not exist");
});
