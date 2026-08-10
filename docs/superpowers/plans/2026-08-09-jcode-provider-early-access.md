# Jcode Provider Early Access Implementation Plan

**Implementation base:** `research/prime-agent-integration` at `d40530040ab7c474a0af263d1a40f8b848d174c2`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an honest, first-party Jcode provider to Pylon on `research/prime-agent-integration`, using the public TypeScript SDK for isolated durable sessions, canonical Pylon runtime events, full-access-only execution, web/mobile presentation, and tested external-binary distribution.

**Architecture:** Each configured Jcode provider instance owns one private Jcode daemon launched with `launchInstance()` under a Pylon-owned persistent home. Each active Pylon thread owns one child `JcodeClient.connect({ socketPath })` connection and one exact native Jcode session identity stored in a server-private sidecar. Jcode SDK events terminate inside `apps/server/src/provider/jcode/` and map into existing provider-neutral contracts before orchestration or clients see them.

**Tech Stack:** TypeScript, Effect, `@1jehuang/jcode-sdk@1.1.0`, NDJSON-over-local-socket through the official SDK, Pylon provider instance SPI, SQLite-backed provider runtime bindings, React/Vite web, React Native mobile, Vitest/Vite Plus.

## Global Constraints

- Implement on `research/prime-agent-integration`, after the current owner commits its in-progress provider-agent messaging changes. Use one writer on this branch at a time.
- The audited Prime base `851cb8c80` is stale. The last clean reviewed checkpoint was `1a9bd180d`, with later uncommitted work observed in shared provider contracts and services. Never reset, stash, amend, or commit another agent's changes.
- Pin the published SDK exactly to `@1jehuang/jcode-sdk@1.1.0`. Do not use the unpublished repository version `1.2.0` without a fresh source and package audit.
- Require an independently installed `jcode` executable for Early Access. Remove the SDK's six optional platform runtime packages through pnpm overrides and verify packaged artifacts do not contain them.
- Use `launchInstance()`, not `JcodeClient.launch()`, because Pylon needs the private socket path for one child connection per active thread.
- One private daemon per configured provider instance. Never launch one daemon per thread and never attach to the user's live Jcode daemon by default.
- Persist state below `<stateDir>/provider-sessions/jcode/<encoded-instance-id>/`. Native homes, sockets, paths, request IDs, and Jcode session IDs must not cross the provider boundary.
- Strip `JCODE_HOME`, `JCODE_RUNTIME_DIR`, `JCODE_API_SOCKET`, and `JCODE_SOCKET` from provider-instance environment overrides before calling the SDK. The SDK applies `options.env` last, so allowing these names would break isolation.
- Advertise and accept only `full-access`. Set both versioned feature capabilities and the legacy `supportedRuntimeModes` field to `['full-access']`. Reject every other runtime mode on the server.
- Do not advertise approvals. The current bridge omits the `permissions` capability and cannot enforce Pylon approval decisions.
- Do not advertise session UI, swarms, agents, memory, skills, MCP management, goals, plans, schedules, account switching, or OAuth controls. These Jcode product features are not first-class SDK v1 features.
- Treat reconnect as lossy. Do not replay flattened history into canonical tool, usage, status, or image events. An active transport failure ends the Pylon turn and closes that attached runtime without automatic retry.
- Preserve Pylon's local, remote/relay, and tunnel architecture. Jcode sockets stay server-local; clients communicate only through Pylon contracts and WebSockets.
- Keep `conversationRollback: 'unsupported'` in Early Access. Jcode rewind needs durable Pylon-turn-to-native-message mapping plus rollback compensation that the current provider interface does not provide.
- Keep background text generation unavailable in Early Access. `runStructured()` does not provide a no-tools execution policy, so using it for titles or source-control copy could run broad host tools unexpectedly.
- Keep SDK soft interrupts and manual compaction out of the initial release. SDK v1 provides no authoritative queued-input counts; its `compacted` reply acknowledges a scheduling request but is not an authoritative compaction-completed lifecycle, while Pylon's generic controls require authoritative state.
- Do not add Jcode-specific wire contracts or client state. Extend existing generic provider settings, models, runtime events, capabilities, and presentation paths only.
- Do not run repository-wide checks. Run the focused tests and package typechecks listed per task.
- Before running any `vp` command, use the worktree-local runner: `export PATH="$PWD/node_modules/.bin:$PATH"`, then verify `command -v vp` resolves below the current worktree. A separately installed global Vite Plus loads a second test-runtime singleton and makes valid suites fail during collection with `Cannot read properties of undefined (reading 'config')`.
- Do not launch browsers, desktop clients, or mobile simulators without explicit user permission.

---

## Audit Review Decisions

### Recommended approach

Use the official SDK with an external executable, a Pylon-owned persistent home, a scoped per-instance manager, and one attached child client per Pylon thread.

This preserves the stable public protocol, uses Prime's provider-neutral foundation, supports concurrent Pylon threads, and keeps Jcode-native complexity at the adapter boundary.

### Rejected alternatives

1. **Implement NDJSON protocol v1 directly.** This duplicates the SDK's framing, handshake, forward compatibility, launch cleanup, credential inheritance, and schema parity work.
2. **Use Jcode CLI/TUI output or private daemon protocol.** This loses stable capability negotiation and creates brittle private-protocol debt.
3. **Bundle the SDK runtime packages immediately.** This adds 75-158 MB per installed platform package plus desktop packaging, update, and artifact-size work. Early Access uses an external binary and proves distribution first.

### Corrections to the supplied audit

- The user explicitly chose the same Prime branch, so the separate-worktree recommendation no longer applies. Single-writer sequencing replaces branch isolation.
- The current Prime foundation includes input-delivery and compaction controls after the audit snapshot. Jcode should consume those generic contracts only where its SDK can provide authoritative state.
- Full public-SDK parity is not automatically safe in Pylon. Rewind, structured background generation, soft interrupts, compaction, and API-key management require additional Pylon or SDK semantics before they can be advertised honestly.
- `launchInstance()` is the correct ownership primitive. `JcodeClient.launch()` hides the socket required for concurrent child connections.
- Adding the SDK normally installs optional runtime packages. Explicit `binary: 'jcode'` changes runtime selection but does not remove the package downloads; pnpm overrides are required.
- The SDK lets `options.env` override its private home and socket variables. Environment sanitization is a release-blocking isolation requirement.

## Planned File Structure

### Create

- `apps/server/scripts/jcode-sdk-compatibility.ts` - opt-in real-runtime compatibility matrix runner.
- `apps/server/src/provider/Drivers/JcodeDriver.ts` - built-in driver registration and scoped instance construction.
- `apps/server/src/provider/Drivers/JcodeDriver.test.ts` - driver metadata, defaults, and registry coverage.
- `apps/server/src/provider/Layers/JcodeAdapter.ts` - provider-neutral adapter composition around Jcode session runtimes.
- `apps/server/src/provider/Layers/JcodeAdapter.test.ts` - full-access enforcement and adapter lifecycle tests.
- `apps/server/src/provider/Layers/JcodeProvider.ts` - installation/version/health/model snapshot construction.
- `apps/server/src/provider/Layers/JcodeProvider.test.ts` - provider status and model catalog tests.
- `apps/server/src/provider/jcode/JcodeEnvironment.ts` - reserved environment filtering.
- `apps/server/src/provider/jcode/JcodeEnvironment.test.ts` - isolation tests.
- `apps/server/src/provider/jcode/JcodeSdkBridge.ts` - narrow typed wrapper around the published SDK.
- `apps/server/src/provider/jcode/JcodeSdkBridge.test.ts` - SDK error/capability normalization tests.
- `apps/server/src/provider/jcode/JcodePaths.ts` - persistent home and private identity paths.
- `apps/server/src/provider/jcode/JcodePaths.test.ts` - instance/thread path isolation tests.
- `apps/server/src/provider/jcode/JcodeResumeCursor.ts` - opaque client-safe continuation marker.
- `apps/server/src/provider/jcode/JcodeResumeCursor.test.ts` - strict cursor compatibility tests.
- `apps/server/src/provider/jcode/JcodeSessionIdentity.ts` - atomic server-private native session identity sidecar.
- `apps/server/src/provider/jcode/JcodeSessionIdentity.test.ts` - validation, permissions, and atomicity tests.
- `apps/server/src/provider/jcode/JcodeInstanceManager.ts` - one private daemon per provider instance.
- `apps/server/src/provider/jcode/JcodeInstanceManager.test.ts` - launch, shutdown, child connection, and multi-instance tests.
- `apps/server/src/provider/jcode/JcodeRuntimeEvents.ts` - pure SDK-to-canonical event mapping.
- `apps/server/src/provider/jcode/JcodeRuntimeEvents.test.ts` - complete mapping and bounds tests.
- `apps/server/src/provider/jcode/JcodeSessionRuntime.ts` - one attached connection and event fiber per Pylon thread.
- `apps/server/src/provider/jcode/JcodeSessionRuntime.test.ts` - create, resume, stream, cancel, image, and disconnect tests.
- `apps/server/src/provider/jcode/JcodeFeatureCapabilities.ts` - honest Jcode feature inventory.
- `apps/server/src/provider/jcode/JcodeFeatureCapabilities.test.ts` - capability and runtime-mode tests.
- `apps/server/src/provider/jcode/JcodeModelOptions.ts` - model catalog and reasoning-effort descriptors.
- `apps/server/src/provider/jcode/JcodeModelOptions.test.ts` - model and option validation tests.
- `apps/server/src/textGeneration/JcodeTextGeneration.ts` - typed unavailable background-generation boundary.
- `apps/server/src/textGeneration/JcodeTextGeneration.test.ts` - predictable unsupported errors.
- `apps/server/src/textGeneration/TextGeneration.ts` - include `jcode` in the server provider union while keeping registry dispatch generic.
- `docs/user/providers-jcode.md` - install, credentials, full-access warning, and troubleshooting.
- `docs/internals/jcode-sdk-compatibility.md` - pinned versions, platform matrix, and artifact measurements.
- `docs/internals/jcode-sdk-blockers.md` - features that remain blocked on SDK or Pylon semantics.

### Modify

- `apps/server/package.json` - exact SDK runtime dependency.
- `pnpm-workspace.yaml` - remove optional Jcode runtime packages.
- `pnpm-lock.yaml` - lock exact SDK graph without platform runtimes.
- `scripts/build-desktop-artifact.test.ts` - prove Jcode runtimes are not staged or bundled.
- `packages/contracts/src/settings.ts` - `JcodeSettings`, legacy default settings, and settings patch.
- `packages/contracts/src/settings.test.ts` - defaults and round-trip coverage.
- `packages/contracts/src/model.ts` - Jcode display name.
- `packages/contracts/src/model.test.ts` - display-name coverage.
- `apps/server/src/provider/builtInDrivers.ts` - register `JcodeDriver` and environment requirements.
- `apps/server/src/provider/Layers/ProviderService.ts` - enforce provider-advertised runtime modes before adapter start, after reconciling the current agent's changes.
- `apps/server/src/provider/Layers/ProviderService.test.ts` - unsupported runtime-mode rejection.
- `apps/server/src/provider/Services/ProviderAdapterRegistry.ts` - carry server-authoritative supported runtime modes in routing information.
- `apps/server/src/provider/Layers/ProviderAdapterRegistry.ts` - derive effective runtime modes from the live provider snapshot.
- `apps/server/src/provider/Layers/ProviderAdapterRegistry.test.ts` - routing metadata and enforcement-boundary coverage.
- `apps/server/src/provider/testUtils/providerAdapterRegistryMock.ts` - explicit runtime-mode metadata in registry test doubles.
- `apps/web/src/components/Icons.tsx` - lightweight monochrome Jcode terminal mark.
- `apps/web/src/components/chat/providerIconUtils.ts` - Jcode icon lookup.
- `apps/web/src/components/chat/providerIconUtils.test.ts` - icon lookup coverage.
- `apps/web/src/components/settings/providerDriverMeta.ts` - Jcode settings definition and Early Access badge.
- `apps/web/src/components/settings/ProviderSettingsForm.test.ts` - Jcode field ordering and switch copy.
- `apps/web/src/session-logic.ts` - Jcode provider option in new-thread flows.
- `apps/mobile/src/components/providerIconKind.ts` - `jcode` icon kind.
- `apps/mobile/src/components/providerIconKind.test.ts` - icon-kind coverage.
- `apps/mobile/src/components/ProviderIcon.tsx` - matching Jcode terminal mark.
- `apps/mobile/src/lib/modelOptions.ts` - Jcode display label.
- `apps/mobile/src/lib/modelOptions.test.ts` - label and model selection coverage.
- `docs/README.md` - provider guide link.
- `docs/user/permission-modes.md` - Jcode full-access-only limitation.
- `docs/internals/providers.md` - daemon/session topology, reconnect semantics, and capability boundary.

---

### Task 0: Establish the Single-Writer Branch Handoff

**Files:**

- Copy after branch is clean: `docs/superpowers/plans/2026-08-09-jcode-provider-early-access.md`

**Interfaces:**

- Consumes: the current owner agent's committed provider-agent messaging work.
- Produces: a named immutable implementation base on `research/prime-agent-integration`.

- [ ] **Step 1: Verify no other agent is writing the branch**

Run:

```bash
export PATH="$PWD/node_modules/.bin:$PATH"
test "$(command -v vp)" = "$PWD/node_modules/.bin/vp"
git status --short --branch
git rev-parse HEAD
```

Expected: the `vp` preflight resolves the worktree-local runner, the branch is `research/prime-agent-integration`, and the worktree is clean. If it is dirty, stop. Do not stash, reset, amend, stage, or commit any listed file.

- [ ] **Step 2: Prove the inherited Prime integration baseline is green**

Run the existing tests that Jcode will extend across contracts, provider lifecycle, persistence, packaging, web metadata, and mobile metadata:

```bash
vp test run \
  packages/contracts/src/settings.test.ts \
  packages/contracts/src/model.test.ts \
  packages/contracts/src/providerCapabilities.test.ts \
  packages/contracts/src/server.test.ts \
  apps/server/src/provider/Layers/ProviderService.test.ts \
  apps/server/src/provider/Layers/ProviderAdapterRegistry.test.ts \
  apps/server/src/orchestration/Layers/CheckpointReactor.test.ts \
  apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts \
  apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts \
  apps/server/src/provider/Layers/ProviderInstanceRegistryHydration.test.ts \
  apps/server/src/provider/Layers/ProviderInstanceRegistryLive.test.ts \
  apps/server/src/provider/Layers/ProviderSessionReaper.test.ts \
  scripts/build-desktop-artifact.test.ts \
  apps/web/src/components/chat/providerIconUtils.test.ts \
  apps/web/src/components/settings/ProviderSettingsForm.test.ts \
  apps/web/src/components/settings/AddProviderInstanceDialog.test.ts \
  apps/web/src/components/settings/ProviderSettingsPanel.logic.test.ts \
  apps/web/src/session-logic.test.ts \
  apps/web/src/providerInstances.test.ts \
  apps/web/src/modelSelection.test.ts \
  apps/mobile/src/components/providerIconKind.test.ts \
  apps/mobile/src/lib/modelOptions.test.ts

vp run --filter @t3tools/contracts typecheck
vp run --filter @t3tools/shared typecheck
vp run --filter t3 typecheck
vp run --filter @t3tools/web typecheck
vp run --filter @t3tools/mobile typecheck
vp run --filter @t3tools/desktop typecheck
```

Expected: all 22 files run and pass, and every named package actually executes its typecheck. At review time the real dirty branch had 433 passing tests and one inherited failure in `ProviderCommandReactor.test.ts` where unsupported/stale interaction failures arrived in the opposite order from the assertion. Contracts, shared, server, and desktop typechecks passed; web and mobile failed because the in-progress Prime changes referenced a missing `createdAt` field. Treat every remaining failure as inherited owner work and stop before adding Jcode so the final release gate has an attributable baseline.

- [ ] **Step 3: Copy this plan into the branch**

Run:

```bash
cp /Users/rynfar/repos/pylon-jcode-provider-implementation-plan.md \
  docs/superpowers/plans/2026-08-09-jcode-provider-early-access.md
```

- [ ] **Step 4: Record the base SHA in the copied plan**

```bash
base_sha=$(git rev-parse HEAD)
python3 - "$base_sha" <<'PY'
from pathlib import Path
import sys

path = Path("docs/superpowers/plans/2026-08-09-jcode-provider-early-access.md")
sha = sys.argv[1]
heading = "# Jcode Provider Early Access Implementation Plan\n"
text = path.read_text()
path.write_text(
    text.replace(
        heading,
        f"{heading}\n**Implementation base:** `research/prime-agent-integration` at `{sha}`.\n",
        1,
    )
)
PY
```

Verify the recorded SHA equals the clean `git rev-parse HEAD` value before committing.

- [ ] **Step 5: Commit only the plan**

```bash
git add docs/superpowers/plans/2026-08-09-jcode-provider-early-access.md
git commit -m "docs(providers): plan Jcode early access integration"
```

---

### Task 1: Pin the SDK and Prove External-Binary Distribution

**Files:**

- Modify: `apps/server/package.json`
- Modify: `pnpm-workspace.yaml`
- Modify: `pnpm-lock.yaml`
- Create: `apps/server/src/provider/jcode/JcodeEnvironment.ts`
- Create: `apps/server/src/provider/jcode/JcodeEnvironment.test.ts`
- Create: `apps/server/scripts/jcode-sdk-compatibility.ts`
- Create: `docs/internals/jcode-sdk-compatibility.md`
- Modify: `scripts/build-desktop-artifact.test.ts`

**Interfaces:**

- Consumes: published `@1jehuang/jcode-sdk@1.1.0`.
- Produces: `sanitizeJcodeLaunchEnvironment(environment)` and a repeatable real-runtime compatibility report.

- [ ] **Step 1: Write the environment isolation test**

```ts
import { describe, expect, it } from "vitest";
import { sanitizeJcodeLaunchEnvironment } from "./JcodeEnvironment.ts";

describe("sanitizeJcodeLaunchEnvironment", () => {
  it("removes SDK-owned home and socket variables while preserving provider credentials", () => {
    expect(
      sanitizeJcodeLaunchEnvironment({
        JCODE_HOME: "/escape/home",
        JCODE_RUNTIME_DIR: "/escape/run",
        JCODE_API_SOCKET: "/escape/api.sock",
        JCODE_SOCKET: "/escape/daemon.sock",
        ANTHROPIC_API_KEY: "secret",
        PATH: "/usr/bin",
      }),
    ).toEqual({ ANTHROPIC_API_KEY: "secret", PATH: "/usr/bin" });
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
vp test run apps/server/src/provider/jcode/JcodeEnvironment.test.ts
```

Expected: FAIL because `JcodeEnvironment.ts` does not exist.

- [ ] **Step 3: Add the exact SDK dependency and remove platform runtimes**

Add to `apps/server/package.json` dependencies:

```json
"@1jehuang/jcode-sdk": "1.1.0"
```

Add to `pnpm-workspace.yaml` overrides:

```yaml
"@1jehuang/jcode-sdk>@1jehuang/jcode-darwin-arm64": "-"
"@1jehuang/jcode-sdk>@1jehuang/jcode-darwin-x64": "-"
"@1jehuang/jcode-sdk>@1jehuang/jcode-linux-arm64": "-"
"@1jehuang/jcode-sdk>@1jehuang/jcode-linux-x64": "-"
"@1jehuang/jcode-sdk>@1jehuang/jcode-win32-arm64": "-"
"@1jehuang/jcode-sdk>@1jehuang/jcode-win32-x64": "-"
```

Run:

```bash
vp i
```

Expected: lockfile contains `@1jehuang/jcode-sdk@1.1.0` and none of the six platform packages.

- [ ] **Step 4: Implement reserved environment filtering**

```ts
const RESERVED_JCODE_ENV = new Set([
  "JCODE_HOME",
  "JCODE_RUNTIME_DIR",
  "JCODE_API_SOCKET",
  "JCODE_SOCKET",
]);

export function sanitizeJcodeLaunchEnvironment(
  environment: NodeJS.ProcessEnv,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).flatMap(([name, value]) =>
      value === undefined || RESERVED_JCODE_ENV.has(name) ? [] : [[name, value]],
    ),
  );
}
```

- [ ] **Step 5: Add the opt-in compatibility runner**

The script must:

1. Resolve `JCODE_BINARY` or default to `jcode`.
2. Create a stable scratch home supplied by `JCODE_COMPAT_HOME`.
3. Call `launchInstance({ binary, jcodeHome, inheritLogins, env: sanitizedEnv })`.
4. Connect a control client to `instance.socketPath`.
5. Create two sessions in separate working directories.
6. Connect one child client per session and attach concurrently.
7. Verify ping, list models, runtime info, exact detach/reattach, and clean shutdown.
8. Run text/reasoning/tool/image/cancel tests only when `JCODE_COMPAT_LIVE_TURNS=1` is set, because these spend model quota.
9. Write one JSON result per check and exit nonzero when a required check fails.

Use the public SDK methods directly. Do not parse TUI output or private daemon frames.

- [ ] **Step 6: Add artifact exclusion tests**

Extend `scripts/build-desktop-artifact.test.ts` with assertions that staged dependencies and copied files contain none of:

```ts
const forbiddenJcodeRuntimePackages = [
  "@1jehuang/jcode-darwin-arm64",
  "@1jehuang/jcode-darwin-x64",
  "@1jehuang/jcode-linux-arm64",
  "@1jehuang/jcode-linux-x64",
  "@1jehuang/jcode-win32-arm64",
  "@1jehuang/jcode-win32-x64",
];
```

- [ ] **Step 7: Run focused verification**

```bash
vp test run apps/server/src/provider/jcode/JcodeEnvironment.test.ts scripts/build-desktop-artifact.test.ts
vp run --filter t3 typecheck
vp run --filter t3 build:bundle
```

Expected: tests pass, server typecheck passes, and the bundle succeeds without embedding a Jcode runtime.

- [ ] **Step 8: Create the compatibility evidence template**

Create `docs/internals/jcode-sdk-compatibility.md` with exact SDK version, Node/Bun runtime, platform/architecture, binary path form, inherited/isolated credential mode, and artifact sizes before/after. Mark every runtime and live-turn result as `Not run` in this task. Task 11 runs the real compatibility matrix and is the only task allowed to replace those markers with pass/fail evidence. Never document a tested Jcode version before the script has observed it.

- [ ] **Step 9: Commit**

```bash
git add apps/server/package.json pnpm-workspace.yaml pnpm-lock.yaml \
  apps/server/src/provider/jcode/JcodeEnvironment.ts \
  apps/server/src/provider/jcode/JcodeEnvironment.test.ts \
  apps/server/scripts/jcode-sdk-compatibility.ts \
  docs/internals/jcode-sdk-compatibility.md \
  scripts/build-desktop-artifact.test.ts
git commit -m "build(providers): pin the Jcode SDK boundary"
```

---

### Task 2: Add Jcode Settings and Generic Client Metadata

**Files:**

- Modify: `packages/contracts/src/settings.ts`
- Modify: `packages/contracts/src/settings.test.ts`
- Modify: `packages/contracts/src/model.ts`
- Modify: `packages/contracts/src/model.test.ts`

**Interfaces:**

- Produces: `JcodeSettings` with `{ enabled, binaryPath, inheritLogins }` and provider driver slug `jcode`.
- Consumers: `JcodeDriver`, generic web settings forms, and provider-instance hydration.

- [ ] **Step 1: Write failing settings tests**

Add expectations that decoding an empty Jcode settings object produces:

```ts
{
  enabled: true,
  binaryPath: "jcode",
  inheritLogins: true,
}
```

Add a round-trip test for `inheritLogins: false` and a settings-patch test that accepts all three fields.

- [ ] **Step 2: Run the focused tests**

```bash
vp test run packages/contracts/src/settings.test.ts packages/contracts/src/model.test.ts
```

Expected: FAIL because Jcode settings and display metadata do not exist.

- [ ] **Step 3: Add the settings schema**

```ts
export const JcodeSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("jcode").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Jcode executable used by this provider instance.",
        providerSettingsForm: { placeholder: "jcode", clearWhenEmpty: "omit" },
      }),
    ),
    inheritLogins: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({
        title: "Inherit provider logins",
        description:
          "Share recognized host credential files with this private Jcode instance. This can spend the connected accounts' quota.",
        providerSettingsForm: { control: "switch" },
      }),
    ),
  },
  { order: ["binaryPath", "inheritLogins"] },
);
export type JcodeSettings = typeof JcodeSettings.Type;
```

Add `jcode` to the legacy `ServerSettings.providers` defaults and `ServerSettingsPatch` provider patches without closing `ProviderDriverKind`.

- [ ] **Step 4: Add display metadata**

In `packages/contracts/src/model.ts`, add:

```ts
const JCODE_DRIVER_KIND = ProviderDriverKind.make("jcode");
```

and:

```ts
[JCODE_DRIVER_KIND]: "Jcode",
```

Do not add a hardcoded default model. Jcode's attached session reports the current model and live catalog.

- [ ] **Step 5: Run focused tests and typecheck**

```bash
vp test run packages/contracts/src/settings.test.ts packages/contracts/src/model.test.ts
vp run --filter @t3tools/contracts typecheck
```

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/settings.ts packages/contracts/src/settings.test.ts \
  packages/contracts/src/model.ts packages/contracts/src/model.test.ts
git commit -m "feat(contracts): add Jcode provider settings"
```

---

### Task 3: Build the Narrow SDK Bridge

**Files:**

- Create: `apps/server/src/provider/jcode/JcodeSdkBridge.ts`
- Create: `apps/server/src/provider/jcode/JcodeSdkBridge.test.ts`

**Interfaces:**

- Produces: `JcodeSdkBridge`, `JcodeSdkClient`, `JcodeLaunchedInstance`, and `JcodeSdkBridgeError`.
- Consumers: `JcodeInstanceManager` and `JcodeSessionRuntime`.

- [ ] **Step 1: Write bridge contract tests**

Cover:

- `launchInstance()` errors become typed `JcodeSdkBridgeError` values without exposing secret environment values.
- native attach failures that authoritatively mean the session no longer exists preserve a distinct `session-not-found` error tag; transport, timeout, and protocol failures remain distinguishable without message-string matching.
- `connect()` preserves server identity and capability strings.
- `supports('permissions')` remains false when the bridge omits it.
- unknown future event kinds are ignored rather than crashing the stream.
- `close()` and `shutdown()` are idempotent at the wrapper boundary.

- [ ] **Step 2: Run the tests and verify failure**

```bash
vp test run apps/server/src/provider/jcode/JcodeSdkBridge.test.ts
```

- [ ] **Step 3: Define the narrow bridge interface**

```ts
export interface JcodeSdkClient {
  readonly server: string;
  readonly capabilities: ReadonlyArray<string>;
  readonly supports: (capability: string) => boolean;
  readonly createSession: (workingDir?: string) => Promise<SessionInfo>;
  readonly attachSession: (sessionId: string) => Promise<SessionInfo>;
  readonly detachSession: (sessionId: string) => Promise<void>;
  readonly listSessions: (options?: { includeArchived?: boolean }) => Promise<SessionInfo[]>;
  readonly listModels: (sessionId: string) => Promise<{ models: string[]; current?: string }>;
  readonly getRuntimeInfo: (sessionId: string) => Promise<RuntimeInfo>;
  readonly setModel: (sessionId: string, model: string) => Promise<void>;
  readonly setReasoningEffort: (sessionId: string, effort: string) => Promise<void>;
  readonly sendMessage: (
    sessionId: string,
    content: string,
    options?: SendMessageOptions,
  ) => Promise<void>;
  readonly cancel: (sessionId: string) => Promise<void>;
  readonly getHistory: (sessionId: string) => Promise<HistoryMessage[]>;
  readonly events: (sessionId?: string) => AsyncIterableIterator<ApiEvent>;
  readonly close: () => Promise<void>;
}

export interface JcodeLaunchedInstance {
  readonly socketPath: string;
  readonly jcodeHome: string;
  readonly shutdown: () => Promise<void>;
}

export class JcodeSessionNotFoundError extends Data.TaggedError("JcodeSessionNotFoundError")<{
  readonly operation: string;
  readonly sessionId: string;
}> {}

export class JcodeSdkOperationError extends Data.TaggedError("JcodeSdkOperationError")<{
  readonly operation: string;
  readonly code?: string;
  readonly detail: string;
  readonly cause?: unknown;
}> {}

export type JcodeSdkBridgeError = JcodeSessionNotFoundError | JcodeSdkOperationError;

export interface JcodeSdkBridge {
  readonly launchInstance: (
    options: LaunchOptions,
  ) => Effect.Effect<JcodeLaunchedInstance, JcodeSdkBridgeError>;
  readonly connect: (options: {
    readonly socketPath: string;
    readonly clientName: string;
  }) => Effect.Effect<JcodeSdkClient, JcodeSdkBridgeError>;
  readonly trySdk: <A>(input: {
    readonly operation: string;
    readonly sessionId?: string;
    readonly run: () => Promise<A>;
  }) => Effect.Effect<A, JcodeSdkBridgeError>;
}
```

Map only SDK `HarnessError.code === "unknown_session"` to `JcodeSessionNotFoundError`; preserve every other stable SDK code on `JcodeSdkOperationError`. Redact environment values and native paths from `detail`. The production implementation imports only public exports from `@1jehuang/jcode-sdk`. Client Promise methods use one shared `Effect.tryPromise` helper in this bridge so manager/runtime consumers do not invent inconsistent error mappings.

- [ ] **Step 4: Keep native payloads inside the Jcode package**

Keep SDK-native types scoped to `apps/server/src/provider/jcode/`. The bridge interface may reference them internally within that folder, but no module outside the folder, no wire contract, and no client projection may import or expose them.

- [ ] **Step 5: Run tests and typecheck**

```bash
vp test run apps/server/src/provider/jcode/JcodeSdkBridge.test.ts
vp run --filter t3 typecheck
```

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/provider/jcode/JcodeSdkBridge.ts \
  apps/server/src/provider/jcode/JcodeSdkBridge.test.ts
git commit -m "feat(providers): wrap the public Jcode SDK"
```

---

### Task 4: Add Private Paths, Opaque Resume Markers, and Session Identity

**Files:**

- Create: `apps/server/src/provider/jcode/JcodePaths.ts`
- Create: `apps/server/src/provider/jcode/JcodePaths.test.ts`
- Create: `apps/server/src/provider/jcode/JcodeResumeCursor.ts`
- Create: `apps/server/src/provider/jcode/JcodeResumeCursor.test.ts`
- Create: `apps/server/src/provider/jcode/JcodeSessionIdentity.ts`
- Create: `apps/server/src/provider/jcode/JcodeSessionIdentity.test.ts`

**Interfaces:**

- Produces: `jcodeProviderRoot`, `jcodeHomePath`, `jcodeThreadIdentityPath`, `JCODE_RESUME_CURSOR`, and atomic identity encode/decode helpers.
- Consumers: `JcodeInstanceManager`, `JcodeSessionRuntime`, and `JcodeAdapter`.

- [ ] **Step 1: Write path isolation tests**

Assert that instance and thread IDs containing slashes, spaces, Unicode, and `..` become direct base64url path segments:

```ts
expect(path.basename(jcodeProviderRoot(input))).toMatch(/^b64-[A-Za-z0-9_-]+$/);
expect(path.basename(jcodeThreadIdentityPath(input))).toMatch(/^b64-[A-Za-z0-9_-]+\.json$/);
```

- [ ] **Step 2: Write strict cursor tests**

Use this exact marker:

```ts
export const JCODE_RESUME_CURSOR = {
  schemaVersion: 1,
  kind: "jcode-private-session",
  continue: true,
} as const;
```

The decoder must reject extra keys, unknown versions, wrong kinds, and any cursor containing a native session ID or path.

- [ ] **Step 3: Write identity sidecar tests**

Use this private schema:

```ts
{
  schemaVersion: 1,
  sessionId: string,
  workingDir: string,
}
```

Test:

- valid IDs and absolute working directories round-trip;
- malformed JSON and oversized IDs fail closed;
- temp-file plus rename writes atomically;
- directories are mode `0700` and files mode `0600` on POSIX;
- no socket path, home path, credential path, or event data is persisted.

- [ ] **Step 4: Run path, cursor, and identity tests RED**

Run the three focused test files from Step 6. Expected: FAIL because the new modules do not exist.

- [ ] **Step 5: Implement paths and identity**

Use the same safe encoding rule already proven by Prime without importing Prime modules:

```ts
function safePathSegment(value: string): string {
  return `b64-${Buffer.from(value, "utf8").toString("base64url")}`;
}
```

Store:

```text
<stateDir>/provider-sessions/jcode/<encoded-instance-id>/home/
<stateDir>/provider-sessions/jcode/<encoded-instance-id>/threads/<encoded-thread-id>.json
```

- [ ] **Step 6: Run focused tests GREEN**

```bash
vp test run \
  apps/server/src/provider/jcode/JcodePaths.test.ts \
  apps/server/src/provider/jcode/JcodeResumeCursor.test.ts \
  apps/server/src/provider/jcode/JcodeSessionIdentity.test.ts
```

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/provider/jcode/JcodePaths.ts \
  apps/server/src/provider/jcode/JcodePaths.test.ts \
  apps/server/src/provider/jcode/JcodeResumeCursor.ts \
  apps/server/src/provider/jcode/JcodeResumeCursor.test.ts \
  apps/server/src/provider/jcode/JcodeSessionIdentity.ts \
  apps/server/src/provider/jcode/JcodeSessionIdentity.test.ts
git commit -m "feat(providers): isolate Jcode session identity"
```

---

### Task 5: Own One Private Jcode Instance per Provider Instance

**Files:**

- Create: `apps/server/src/provider/jcode/JcodeInstanceManager.ts`
- Create: `apps/server/src/provider/jcode/JcodeInstanceManager.test.ts`

**Interfaces:**

- Consumes: `JcodeSdkBridge`, sanitized environment, Pylon state paths, `JcodeSettings`.
- Produces: one scoped `JcodeInstanceManager` with `connectSessionClient`, `probe`, and `shutdown`.

- [ ] **Step 1: Write manager lifecycle tests**

Test with a fake bridge that:

- one manager launches exactly one instance;
- two managers with different provider instance IDs launch different homes;
- two session clients connect to the same private socket without sharing attachment state;
- finalization closes children before the control client and shuts the instance down once;
- advertised `permissions` is recorded for diagnostics but does not enable supervised mode, expose approval-required mode, or send permission responses in Early Access;
- launch environment never contains reserved Jcode variables from provider settings;
- shutdown of one manager never closes another manager or a Prime session;
- a valid `probe.json` reattaches the exact session without creating another;
- missing, malformed, and native-not-found probe identities create exactly one replacement and atomically rewrite the sidecar;
- transient attach failures do not delete the identity or create duplicate probe sessions;
- repeated `probe` calls read fresh model/runtime data and never persist probe results.

- [ ] **Step 2: Run manager lifecycle tests RED**

Run `vp test run apps/server/src/provider/jcode/JcodeInstanceManager.test.ts`. Expected: FAIL because the scoped manager and its typed error boundary do not exist.

- [ ] **Step 3: Define the manager output**

```ts
export interface JcodeInstanceProbe {
  readonly server: string;
  readonly protocolVersion: number;
  readonly capabilities: ReadonlyArray<string>;
  readonly currentModel?: string;
  readonly models: ReadonlyArray<{
    readonly model: string;
    readonly provider?: string;
    readonly available: boolean;
  }>;
}

export class JcodeInstanceManagerError extends Data.TaggedError("JcodeInstanceManagerError")<{
  readonly operation:
    | "launch"
    | "connect-control"
    | "attach-probe"
    | "probe"
    | "connect-session"
    | "shutdown";
  readonly detail: string;
  readonly cause?: unknown;
}> {}

export interface JcodeInstanceManager {
  readonly probe: Effect.Effect<JcodeInstanceProbe, JcodeInstanceManagerError>;
  readonly connectSessionClient: Effect.Effect<JcodeSdkClient, JcodeInstanceManagerError>;
  readonly shutdown: Effect.Effect<void, JcodeInstanceManagerError>;
}
```

- [ ] **Step 4: Implement scoped launch**

Call:

```ts
launchInstance({
  binary: settings.binaryPath,
  jcodeHome: jcodeHomePath({ stateDir, instanceId }),
  inheritLogins: settings.inheritLogins,
  env: sanitizeJcodeLaunchEnvironment(environment),
  inheritStderr: false,
});
```

Create one control client with `JcodeClient.connect({ socketPath })`. Persist only this versioned private identity under the provider-instance root:

```ts
interface JcodeProbeIdentity {
  readonly schemaVersion: 1;
  readonly sessionId: string;
}
```

`probe.json` is not a cache of models, versions, capabilities, credentials, or paths. Write it atomically after a no-prompt probe session is created successfully, with owner-only permissions where supported. On manager start, attach the control client to the recorded session. If the file is missing, malformed, or the bridge returns its distinct authoritative `session-not-found` error tag, remove only that stale sidecar, create one replacement probe session, and atomically persist its identity. Never classify this condition by matching error-message text. Any other attach failure is a typed startup error and must not silently create duplicate sessions.

The manager's `probe` effect always calls `listModels()` and `getRuntimeInfo()` against the attached probe session to produce fresh in-memory results. Detach that session during manager shutdown, never expose it to Pylon thread lists, and do not configure Jcode retention in Early Access.

- [ ] **Step 5: Add fixed resource deadlines**

Use Effect timeouts around launch, connect, probe, close, and shutdown. Convert expected failures into typed manager errors. Do not use sleeps or polling in tests; fake bridge Deferreds drive lifecycle milestones.

- [ ] **Step 6: Run focused tests GREEN**

```bash
vp test run apps/server/src/provider/jcode/JcodeInstanceManager.test.ts
vp run --filter t3 typecheck
```

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/provider/jcode/JcodeInstanceManager.ts \
  apps/server/src/provider/jcode/JcodeInstanceManager.test.ts
git commit -m "feat(providers): manage private Jcode instances"
```

---

### Task 6: Map Jcode Events into Canonical Runtime Events

**Files:**

- Create: `apps/server/src/provider/jcode/JcodeRuntimeEvents.ts`
- Create: `apps/server/src/provider/jcode/JcodeRuntimeEvents.test.ts`

**Interfaces:**

- Produces: `mapJcodeRuntimeEvent(state, event, context): JcodeEventMappingResult`, returning updated adapter-local state plus complete `ProviderRuntimeEvent` values.
- Consumers: `JcodeSessionRuntime`.

- [ ] **Step 1: Write table-driven mapping tests**

Define the exact mapper boundary first:

```ts
export interface JcodeEventMappingContext {
  readonly eventId: ProviderRuntimeEventBase["eventId"];
  readonly providerInstanceId: NonNullable<ProviderRuntimeEventBase["providerInstanceId"]>;
  readonly threadId: ProviderRuntimeEventBase["threadId"];
  readonly turnId: ProviderRuntimeEventBase["turnId"];
  readonly createdAt: ProviderRuntimeEventBase["createdAt"];
}

export interface JcodeEventMappingResult {
  readonly state: JcodeEventMappingState;
  readonly events: ReadonlyArray<ProviderRuntimeEvent>;
  readonly fatal: boolean;
}

export function mapJcodeRuntimeEvent(
  state: JcodeEventMappingState,
  event: ApiEvent,
  context: JcodeEventMappingContext,
): JcodeEventMappingResult;
```

Cover every unsolicited turn/session event that can reach `client.events(sessionId)`:

| SDK event                                                                                                                                                                                                                            | Canonical output                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `text_delta`                                                                                                                                                                                                                         | assistant `item.started` once, then `content.delta` with `assistant_text`                                 |
| `reasoning_delta`                                                                                                                                                                                                                    | reasoning `item.started` once, then `content.delta` with `reasoning_text`                                 |
| `reasoning_done`                                                                                                                                                                                                                     | reasoning `item.completed`                                                                                |
| `tool_start`                                                                                                                                                                                                                         | tool `item.started` with canonical type and bounded title                                                 |
| `tool_input_delta`                                                                                                                                                                                                                   | bounded `item.updated` data; parse JSON only when the full accumulated value is valid                     |
| `tool_exec`                                                                                                                                                                                                                          | `item.updated` with `inProgress` status                                                                   |
| `tool_done`                                                                                                                                                                                                                          | tool `item.completed`, failed when `error` is present                                                     |
| `token_usage`                                                                                                                                                                                                                        | `thread.token-usage.updated` with input/output/cache-read values                                          |
| `background_progress`                                                                                                                                                                                                                | `task.started`, `task.progress`, or `task.completed` keyed by opaque Pylon task ID                        |
| `session_status`                                                                                                                                                                                                                     | bounded `thread.state.changed` mapping; unknown strings become safe detail only                           |
| `model_info`                                                                                                                                                                                                                         | `model.rerouted` when the observed model changes                                                          |
| `turn_done`                                                                                                                                                                                                                          | complete open text/reasoning/tool items, then `turn.completed`                                            |
| `permission_request`                                                                                                                                                                                                                 | `runtime.error` and a fatal invariant result; never auto-approve                                          |
| `message_accepted`                                                                                                                                                                                                                   | no durable activity                                                                                       |
| SDK reply/admin kinds (`hello_ok`, `ok`, `error`, `sessions`, `attached`, `history`, `pong`, `models`, `runtime_info`, `credential_updated`, `file_content`, `files`, `text_matches`, `file_status`, `compacted`, `session_renamed`) | ignored by the runtime mapper; request methods consume them, and `compacted` is not treated as completion |
| unknown future event                                                                                                                                                                                                                 | ignored with no throw                                                                                     |

- [ ] **Step 2: Verify tests fail**

```bash
vp test run apps/server/src/provider/jcode/JcodeRuntimeEvents.test.ts
```

- [ ] **Step 3: Implement bounded state**

```ts
export interface JcodeEventMappingState {
  readonly assistantStarted: boolean;
  readonly reasoningStarted: boolean;
  readonly toolInputs: ReadonlyMap<string, string>;
  readonly startedTasks: ReadonlySet<string>;
  readonly currentModel?: string;
}
```

Bound tool input, output, error, status, task label, and task summary before placing them in canonical payloads. Do not set `raw` on runtime events.

- [ ] **Step 4: Use deterministic provider-local IDs**

Encode SDK call/task IDs into opaque Pylon IDs such as:

```text
jcode-tool:<base64url-call-id>
jcode-task:<base64url-task-id>
```

Do not persist the native ID separately in client-visible fields.

- [ ] **Step 5: Run mapper and ingestion tests**

```bash
vp test run \
  apps/server/src/provider/jcode/JcodeRuntimeEvents.test.ts \
  apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts
```

Expected: all mapped events decode through the existing `ProviderRuntimeEvent` schema and ingestion behavior remains provider-neutral.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/provider/jcode/JcodeRuntimeEvents.ts \
  apps/server/src/provider/jcode/JcodeRuntimeEvents.test.ts
git commit -m "feat(providers): map Jcode runtime events"
```

---

### Task 7: Implement the Per-Thread Session Runtime

**Files:**

- Create: `apps/server/src/provider/jcode/JcodeSessionRuntime.ts`
- Create: `apps/server/src/provider/jcode/JcodeSessionRuntime.test.ts`

**Interfaces:**

- Consumes: one child `JcodeSdkClient`, private identity storage, canonical event mapper.
- Produces: create/attach, model selection, reasoning effort, send, cancel, history, and scoped event stream operations for one Pylon thread.

- [ ] **Step 1: Write create and exact-resume tests**

Test:

- a new thread calls `createSession(cwd)`, persists the exact returned Jcode session ID privately, and returns only `JCODE_RESUME_CURSOR`;
- a resumed thread requires the exact opaque cursor plus a valid private identity file;
- attach verifies the returned working directory matches the Pylon thread cwd;
- missing, malformed, foreign-cwd, or unknown native sessions fail closed and never create a replacement silently;
- the event iterator is active before the first message is sent.

- [ ] **Step 2: Write turn and image tests**

Use `resolveAttachmentPath` and `ServerConfig.attachmentsDir`, read the bytes with `FileSystem`, and convert each image to the SDK tuple:

```ts
[attachment.mimeType, Buffer.from(bytes).toString("base64")];
```

Test text-only, image-only, text-plus-image, invalid attachment ID, missing attachment file, and the eight-attachment contract bound.

- [ ] **Step 3: Write model and effort tests**

Before `sendMessage`:

1. call `setModel` when the selected model differs from the current attached model;
2. call `setReasoningEffort` only when the `reasoningEffort` option is not `jcode-default`;
3. surface `invalid_request` as a typed validation error without sending the message;
4. never change another provider instance's session.

- [ ] **Step 4: Write interruption and disconnect tests**

- `interruptTurn` calls `cancel(sessionId)` exactly once.
- transport failure during an active turn emits `turn.aborted`, `runtime.error`, and `session.exited`, then closes the runtime.
- transport failure while idle closes the runtime without synthesizing missed history.
- no automatic reconnect or mutation retry occurs.

- [ ] **Step 5: Define the runtime contract and run tests RED**

```ts
export class JcodeSessionRuntimeError extends Data.TaggedError("JcodeSessionRuntimeError")<{
  readonly operation:
    | "create"
    | "resume"
    | "attachments"
    | "model"
    | "reasoning"
    | "send"
    | "cancel"
    | "stream"
    | "close";
  readonly detail: string;
  readonly cause?: unknown;
}> {}

export interface JcodeSessionRuntime {
  readonly session: ProviderSession;
  readonly sendTurn: (
    input: ProviderSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, JcodeSessionRuntimeError>;
  readonly interruptTurn: (turnId?: TurnId) => Effect.Effect<void, JcodeSessionRuntimeError>;
  readonly close: Effect.Effect<void, JcodeSessionRuntimeError>;
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
}
```

Run `vp test run apps/server/src/provider/jcode/JcodeSessionRuntime.test.ts`. Expected: FAIL because the runtime and typed error boundary do not exist.

- [ ] **Step 6: Implement the scoped runtime**

The runtime owns one client, one event fiber, one active Pylon turn, and adapter-local mapping state. It closes the child client on scope finalization. Promise callbacks enter Effect only through `Effect.async` or `Effect.tryPromise`; do not call runners inside inner services.

- [ ] **Step 7: Run focused tests GREEN**

```bash
vp test run apps/server/src/provider/jcode/JcodeSessionRuntime.test.ts
vp run --filter t3 typecheck
```

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/provider/jcode/JcodeSessionRuntime.ts \
  apps/server/src/provider/jcode/JcodeSessionRuntime.test.ts
git commit -m "feat(providers): run durable Jcode sessions"
```

---

### Task 8: Register the Full-Access Jcode Provider

**Files:**

- Create: `apps/server/src/provider/jcode/JcodeFeatureCapabilities.ts`
- Create: `apps/server/src/provider/jcode/JcodeFeatureCapabilities.test.ts`
- Create: `apps/server/src/provider/jcode/JcodeModelOptions.ts`
- Create: `apps/server/src/provider/jcode/JcodeModelOptions.test.ts`
- Create: `apps/server/src/provider/Layers/JcodeProvider.ts`
- Create: `apps/server/src/provider/Layers/JcodeProvider.test.ts`
- Create: `apps/server/src/provider/Layers/JcodeAdapter.ts`
- Create: `apps/server/src/provider/Layers/JcodeAdapter.test.ts`
- Create: `apps/server/src/provider/Drivers/JcodeDriver.ts`
- Create: `apps/server/src/provider/Drivers/JcodeDriver.test.ts`
- Create: `apps/server/src/textGeneration/JcodeTextGeneration.ts`
- Create: `apps/server/src/textGeneration/JcodeTextGeneration.test.ts`
- Modify: `apps/server/src/textGeneration/TextGeneration.ts`
- Modify: `apps/server/src/provider/builtInDrivers.ts`
- Modify: `apps/server/src/provider/Services/ProviderAdapterRegistry.ts`
- Modify: `apps/server/src/provider/Layers/ProviderAdapterRegistry.ts`
- Modify: `apps/server/src/provider/Layers/ProviderAdapterRegistry.test.ts`
- Modify: `apps/server/src/provider/testUtils/providerAdapterRegistryMock.ts`
- Modify: `apps/server/src/orchestration/Layers/CheckpointReactor.test.ts`
- Modify: `apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts`
- Modify: `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts`
- Modify: `apps/server/src/provider/Layers/ProviderSessionReaper.test.ts`
- Modify: `apps/server/src/provider/Layers/ProviderService.ts`
- Modify: `apps/server/src/provider/Layers/ProviderService.test.ts`

**Interfaces:**

- Produces: built-in driver kind `jcode`, server snapshot, adapter, model descriptors, and typed unavailable background generation.
- Consumes: all earlier Jcode leaf modules and existing provider-neutral SPI.

- [ ] **Step 1: Write review gate A tests**

Write capability, model-option, provider snapshot, executable-version, and text-generation tests. The capability object exposes only `full-access`, read/write model selection and thinking, read-only reasoning/usage, and explicit unavailable reasons for authentication, planning, goals, gates, agents, automation, resources, input queue, context, history, and session UI.

Use `JCODE_DEFAULT_REASONING_EFFORT = "jcode-default"`; publish `Minimal`, `Low`, `Medium`, `High`, `Extra high`, `Maximum`, and `Jcode default`; use exact SDK model IDs and route providers.

Provider tests mock `ChildProcessSpawner` for `jcode v0.73.0`, `jcode 0.71.1`, malformed output, missing binary, nonzero exit, and timeout. Assert the configured binary is invoked with exactly `--version` under the sanitized environment. Healthy snapshots expose the Early Access badge, only `full-access`, unknown auth, server-reported models, and the approvals warning.

Text-generation tests assert all four operations return the documented `TextGenerationError` and that `"jcode" satisfies TextGenerationProvider`.

- [ ] **Step 2: Run review gate A RED**

```bash
vp test run \
  apps/server/src/provider/Layers/JcodeProvider.test.ts \
  apps/server/src/provider/jcode/JcodeFeatureCapabilities.test.ts \
  apps/server/src/provider/jcode/JcodeModelOptions.test.ts \
  apps/server/src/textGeneration/JcodeTextGeneration.test.ts
```

Expected: FAIL because the gate A modules and `jcode` union member do not exist.

- [ ] **Step 3: Implement review gate A**

Build `JcodeProvider` from two independent observations: manager probe results for models/routes/protocol and a bounded executable version probe. Resolve `settings.binaryPath || "jcode"`, spawn exactly `--version` with `ChildProcessSpawner`, collect output under a 4-second Effect timeout, and parse with `parseGenericCliVersion`.

```ts
export const JCODE_MIN_RUNTIME_VERSION = "0.71.1";
export const JCODE_TESTED_RUNTIME_VERSION = "0.73.0";

export class JcodeVersionProbeError extends Data.TaggedError("JcodeVersionProbeError")<{
  readonly reason: "missing" | "nonzero" | "timeout" | "malformed";
  readonly detail: string;
  readonly cause?: unknown;
}> {}

export function parseJcodeVersionOutput(output: string): string | undefined;
```

Reject versions below the minimum. Warn for versions newer than tested only when protocol version is 1. Never infer executable version from `RuntimeInfo.server`. Implement capability/model descriptors. Add `"jcode"` to `TextGenerationProvider`, keep registry dispatch generic, and make each Jcode text-generation operation fail with:

```text
Jcode background text generation is unavailable because SDK v1 cannot disable broad host tools for structured runs.
```

- [ ] **Step 4: Run and commit review gate A GREEN**

```bash
vp test run \
  apps/server/src/provider/Layers/JcodeProvider.test.ts \
  apps/server/src/provider/jcode/JcodeFeatureCapabilities.test.ts \
  apps/server/src/provider/jcode/JcodeModelOptions.test.ts \
  apps/server/src/textGeneration/JcodeTextGeneration.test.ts
vp run --filter t3 typecheck
```

```bash
git add apps/server/src/provider/Layers/JcodeProvider.ts \
  apps/server/src/provider/Layers/JcodeProvider.test.ts \
  apps/server/src/provider/jcode/JcodeFeatureCapabilities.ts \
  apps/server/src/provider/jcode/JcodeFeatureCapabilities.test.ts \
  apps/server/src/provider/jcode/JcodeModelOptions.ts \
  apps/server/src/provider/jcode/JcodeModelOptions.test.ts \
  apps/server/src/textGeneration/JcodeTextGeneration.ts \
  apps/server/src/textGeneration/JcodeTextGeneration.test.ts \
  apps/server/src/textGeneration/TextGeneration.ts
git commit -m "feat(providers): define Jcode capabilities and status"
```

- [ ] **Step 5: Write review gate B adapter and driver tests**

Test `startSession`, `sendTurn`, `interruptTurn`, `stopSession`, `stopAll`, `listSessions`, `hasSession`, and event streaming. Unsupported approval responses, user input, session interactions, resource reload, agent controls, input queue, compaction, and rollback operations return typed unsupported errors. Driver tests assert metadata, defaults, environment requirements, scoped manager construction, and built-in registration.

- [ ] **Step 6: Run review gate B RED**

```bash
vp test run \
  apps/server/src/provider/Drivers/JcodeDriver.test.ts \
  apps/server/src/provider/Layers/JcodeAdapter.test.ts
```

Expected: FAIL because the adapter and driver do not exist.

- [ ] **Step 7: Implement review gate B**

Compose one `JcodeSessionRuntime` per Pylon thread around the instance manager. Implement supported `ProviderAdapterShape` methods and typed failures for the rest. `JcodeAdapter.startSession` defensively accepts only `full-access`.

Construct the provider instance with snapshot, adapter, continuation identity, and `makeJcodeTextGeneration()`. Register:

```ts
{
  driverKind: ProviderDriverKind.make("jcode"),
  metadata: { displayName: "Jcode", supportsMultipleInstances: true },
}
```

Include `ChildProcessSpawner` and the other consumed services in `JcodeDriverEnv`, add it to `BuiltInDriversEnv`, and append `JcodeDriver` to `BUILT_IN_DRIVERS`.

- [ ] **Step 8: Run and commit review gate B GREEN**

```bash
vp test run \
  apps/server/src/provider/Drivers/JcodeDriver.test.ts \
  apps/server/src/provider/Layers/JcodeAdapter.test.ts \
  apps/server/src/provider/Layers/ProviderSessionReaper.test.ts
vp run --filter t3 typecheck
```

```bash
git add apps/server/src/provider/Drivers/JcodeDriver.ts \
  apps/server/src/provider/Drivers/JcodeDriver.test.ts \
  apps/server/src/provider/Layers/JcodeAdapter.ts \
  apps/server/src/provider/Layers/JcodeAdapter.test.ts \
  apps/server/src/provider/builtInDrivers.ts
git commit -m "feat(providers): register the Jcode adapter"
```

- [ ] **Step 9: Write review gate C runtime-mode boundary tests**

Require `ProviderInstanceRoutingInfo.supportedRuntimeModes: ReadonlyArray<RuntimeMode>`. Add tests proving Jcode rejects `approval-required`, `auto-accept-edits`, and `auto`, accepts `full-access`, and performs no MCP preparation or adapter call after rejection. Retain orchestration, registry hydration/live, and reaper regressions for existing providers.

- [ ] **Step 10: Run review gate C RED**

```bash
vp test run \
  apps/server/src/provider/Layers/ProviderAdapterRegistry.test.ts \
  apps/server/src/provider/Layers/ProviderService.test.ts
```

Expected: FAIL because routing information does not carry server-authoritative runtime modes.

- [ ] **Step 11: Implement review gate C**

Extend `ProviderInstanceRoutingInfo` with:

```ts
readonly supportedRuntimeModes: ReadonlyArray<RuntimeMode>;
```

In `Layers/ProviderAdapterRegistry.ts`, resolve the live `ProviderInstance`, read `instance.snapshot.getSnapshot`, and populate the field with `getServerProviderSupportedRuntimeModes(snapshot)`. Update the registry mock and every affected fixture.

In `ProviderService.startSession`, compare `parsed.runtimeMode` with `instanceInfo.supportedRuntimeModes` after instance/provider and enabled validation, but before MCP preparation or adapter `startSession`. Reject unsupported values with `ProviderValidationError`. Reconcile active provider-agent messaging changes without overwriting them.

- [ ] **Step 12: Run and commit review gate C GREEN**

```bash
vp test run \
  apps/server/src/provider/Layers/ProviderAdapterRegistry.test.ts \
  apps/server/src/provider/Layers/ProviderService.test.ts \
  apps/server/src/orchestration/Layers/CheckpointReactor.test.ts \
  apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts \
  apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts \
  apps/server/src/provider/Layers/ProviderSessionReaper.test.ts \
  apps/server/src/provider/Layers/ProviderInstanceRegistryHydration.test.ts \
  apps/server/src/provider/Layers/ProviderInstanceRegistryLive.test.ts
vp run --filter t3 typecheck
```

```bash
git add apps/server/src/provider/Services/ProviderAdapterRegistry.ts \
  apps/server/src/provider/Layers/ProviderAdapterRegistry.ts \
  apps/server/src/provider/Layers/ProviderAdapterRegistry.test.ts \
  apps/server/src/provider/testUtils/providerAdapterRegistryMock.ts \
  apps/server/src/provider/Layers/ProviderService.ts \
  apps/server/src/provider/Layers/ProviderService.test.ts \
  apps/server/src/orchestration/Layers/CheckpointReactor.test.ts \
  apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts \
  apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts \
  apps/server/src/provider/Layers/ProviderSessionReaper.test.ts
git commit -m "fix(providers): enforce provider runtime modes"
```

---

### Task 9: Harden Recovery, Concurrency, and Provider Isolation

**Files:**

- Modify: `apps/server/src/provider/Layers/JcodeAdapter.test.ts`
- Modify: `apps/server/src/provider/jcode/JcodeInstanceManager.test.ts`
- Modify: `apps/server/src/provider/jcode/JcodeSessionRuntime.test.ts`
- Modify: `apps/server/src/provider/Layers/ProviderInstanceRegistryLive.test.ts`
- Modify: `apps/server/src/provider/Layers/ProviderSessionReaper.test.ts`

**Interfaces:**

- Produces: deterministic behavior across restart, concurrent sessions, multiple provider instances, and daemon failure.

- [ ] **Step 1: Add concurrent-session tests**

Start two Pylon threads on one Jcode provider instance. Assert:

- one daemon launch;
- two child connections;
- distinct native session IDs and private identity files;
- interleaved events remain attached to the correct Pylon thread and turn;
- stopping one thread does not detach or cancel the other.

- [ ] **Step 2: Add multi-instance tests**

Start two configured Jcode provider instances. Assert distinct homes, sockets, control clients, model snapshots, credential modes, and shutdown scopes.

- [ ] **Step 3: Add cold-restart tests**

Persist a provider runtime binding and private session identity, close the manager cleanly, construct a new manager against the same state directory, and attach the exact native session. Do not emit historical tool/usage events during reattach.

- [ ] **Step 4: Add active-disconnect tests**

When the child transport closes during a turn, wait on emitted runtime events and scope closure. Assert no sleep, poll, retry, duplicate `turn.completed`, or synthesized history replay.

- [ ] **Step 5: Add reaper and cross-provider tests**

Assert provider session reaping closes abandoned Jcode child clients while leaving Prime, Codex, Claude, Cursor, Grok, and OpenCode adapters unchanged. Assert Jcode manager shutdown cannot call any Prime manager or process handle.

- [ ] **Step 6: Run focused tests**

```bash
vp test run \
  apps/server/src/provider/Layers/JcodeAdapter.test.ts \
  apps/server/src/provider/jcode/JcodeInstanceManager.test.ts \
  apps/server/src/provider/jcode/JcodeSessionRuntime.test.ts \
  apps/server/src/provider/Layers/ProviderInstanceRegistryLive.test.ts \
  apps/server/src/provider/Layers/ProviderSessionReaper.test.ts
```

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/provider/Layers/JcodeAdapter.test.ts \
  apps/server/src/provider/jcode/JcodeInstanceManager.test.ts \
  apps/server/src/provider/jcode/JcodeSessionRuntime.test.ts \
  apps/server/src/provider/Layers/ProviderInstanceRegistryLive.test.ts \
  apps/server/src/provider/Layers/ProviderSessionReaper.test.ts
git commit -m "test(providers): harden Jcode lifecycle isolation"
```

---

### Task 10: Add Web, Mobile, and Documentation Presentation

**Files:**

- Modify: `apps/web/src/components/Icons.tsx`
- Modify: `apps/web/src/components/chat/providerIconUtils.ts`
- Modify: `apps/web/src/components/chat/providerIconUtils.test.ts`
- Modify: `apps/web/src/components/settings/providerDriverMeta.ts`
- Modify: `apps/web/src/components/settings/ProviderSettingsForm.test.ts`
- Modify: `apps/web/src/components/settings/AddProviderInstanceDialog.test.ts`
- Modify: `apps/web/src/components/settings/ProviderSettingsPanel.logic.test.ts`
- Modify: `apps/web/src/session-logic.ts`
- Modify: `apps/web/src/session-logic.test.ts`
- Modify: `apps/web/src/providerInstances.test.ts`
- Modify: `apps/web/src/modelSelection.test.ts`
- Modify: `apps/mobile/src/components/providerIconKind.ts`
- Modify: `apps/mobile/src/components/providerIconKind.test.ts`
- Modify: `apps/mobile/src/components/ProviderIcon.tsx`
- Modify: `apps/mobile/src/lib/modelOptions.ts`
- Modify: `apps/mobile/src/lib/modelOptions.test.ts`
- Create: `docs/user/providers-jcode.md`
- Modify: `docs/README.md`
- Modify: `docs/user/permission-modes.md`
- Modify: `docs/internals/providers.md`
- Create: `docs/internals/jcode-sdk-blockers.md`

**Interfaces:**

- Consumes: generic provider snapshots, model options, and feature capabilities.
- Produces: consistent Jcode labels/icons/settings across web, desktop-wrapped web, and mobile.

- [ ] **Step 1: Write failing presentation tests**

Web tests must assert:

```ts
expect(DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("jcode")]).toMatchObject({
  label: "Jcode",
  badgeLabel: "Early Access",
});
```

and settings fields are exactly `binaryPath` followed by `inheritLogins`. Also assert that the Add Provider dialog and provider settings panel expose Jcode through `PROVIDER_CLIENT_DEFINITIONS`, that the static provider presentation list contains Jcode, that generic provider-instance derivation exposes an enabled Jcode snapshot to composer/sidebar/model-picker/default-selection consumers, and that model selection accepts that instance with its server-provided models.

Mobile tests must assert `providerIconKind('jcode') === 'jcode'` and provider display label is `Jcode`.

- [ ] **Step 2: Run presentation tests RED**

Run the focused web/mobile tests listed in Step 8. Expected: FAIL because Jcode metadata and icons do not exist.

- [ ] **Step 3: Add a lightweight provider mark**

Add a monochrome terminal-style `JcodeIcon` in web and the matching `react-native-svg` paths on mobile. Use a simple rounded terminal frame with `>_`; do not copy Pylon's product mark or invent a large raster asset pipeline for an Early Access provider icon.

- [ ] **Step 4: Register exact web metadata entry points**

Make the provider-specific changes only at these existing shared metadata boundaries:

- `providerDriverMeta.ts`: add the Jcode settings schema, icon, label, and Early Access badge. `AddProviderInstanceDialog`, `ProviderSettingsPanel`, `ProviderInstanceCard`, and `ProviderSettingsForm` already consume this table, so change those components only if their focused tests expose a real generic-rendering defect.
- `session-logic.ts`: add Jcode to the static provider presentation list consumed by `providerIconUtils`; do not treat this list as the authoritative configured-instance source.
- `providerIconUtils.ts`: add the provider icon mapping used by chat/sidebar/model presentation.
- `providerInstances.test.ts`: prove the existing generic server-snapshot derivation exposes an enabled Jcode instance to composer, model picker, sidebar, and `resolveDefaultProviderModelSelection`, which is the path the command palette and new-task flows use.
- `modelSelection.test.ts`: prove that instance and its server-provided model can be selected without a Jcode-specific selection branch.

Keep `providerInstances.ts` and `providerModels.ts` generic. Their snapshot display-name, default-model, and instance resolution helpers already accept arbitrary driver kinds. Do not add Jcode-specific controls or branches for permissions, session interactions, agents, input queues, or compaction.

- [ ] **Step 5: Register mobile metadata**

Add the icon and label to generic provider/model option helpers. Mobile does not gain host provider configuration; it consumes the environment's server-authoritative provider snapshot.

- [ ] **Step 6: Write the user guide**

`docs/user/providers-jcode.md` must cover:

- install Jcode `0.73.0` on the environment host;
- Settings -> Providers -> Jcode;
- binary path behavior for packaged desktop and GUI PATH differences;
- Windows requirement for a real executable path if npm `.cmd` launch fails;
- inherited versus isolated credentials and quota implications;
- full-access-only execution and unavailable Pylon approvals;
- private Pylon-owned Jcode state and durable sessions;
- lossy reconnect behavior during an active turn;
- supported Early Access features and explicit unsupported features.

- [ ] **Step 7: Write the blocker ledger**

`docs/internals/jcode-sdk-blockers.md` must list the exact requirements before enabling:

1. sequenced event replay/reconnect cursors;
2. permission requests that block before execution;
3. authoritative queued-input observation;
4. compaction completion and cancellation state;
5. structured tool mutation/history data;
6. safe rollback mapping plus Pylon rollback compensation;
7. no-tools structured generation;
8. OAuth/account status and switching;
9. swarms, memory, skills, MCP, goals, schedules, and side-panel events;
10. API-key secret-management UX.

- [ ] **Step 8: Run focused tests and typechecks GREEN**

```bash
vp test run \
  apps/web/src/components/chat/providerIconUtils.test.ts \
  apps/web/src/components/settings/ProviderSettingsForm.test.ts \
  apps/web/src/components/settings/AddProviderInstanceDialog.test.ts \
  apps/web/src/components/settings/ProviderSettingsPanel.logic.test.ts \
  apps/web/src/session-logic.test.ts \
  apps/web/src/providerInstances.test.ts \
  apps/web/src/modelSelection.test.ts \
  apps/mobile/src/components/providerIconKind.test.ts \
  apps/mobile/src/lib/modelOptions.test.ts
vp run --filter @t3tools/web typecheck
vp run --filter @t3tools/mobile typecheck
vp run --filter @t3tools/desktop typecheck
```

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/components/Icons.tsx \
  apps/web/src/components/chat/providerIconUtils.ts \
  apps/web/src/components/chat/providerIconUtils.test.ts \
  apps/web/src/components/settings/providerDriverMeta.ts \
  apps/web/src/components/settings/ProviderSettingsForm.test.ts \
  apps/web/src/components/settings/AddProviderInstanceDialog.test.ts \
  apps/web/src/components/settings/ProviderSettingsPanel.logic.test.ts \
  apps/web/src/session-logic.ts apps/web/src/session-logic.test.ts \
  apps/web/src/providerInstances.test.ts \
  apps/web/src/modelSelection.test.ts \
  apps/mobile/src/components/providerIconKind.ts \
  apps/mobile/src/components/providerIconKind.test.ts \
  apps/mobile/src/components/ProviderIcon.tsx \
  apps/mobile/src/lib/modelOptions.ts apps/mobile/src/lib/modelOptions.test.ts \
  docs/user/providers-jcode.md docs/README.md docs/user/permission-modes.md \
  docs/internals/providers.md docs/internals/jcode-sdk-blockers.md
git commit -m "feat(clients): present Jcode early access"
```

---

### Task 11: Run the Early Access Release Gate

**Files:**

- Modify: `docs/internals/jcode-sdk-compatibility.md`
- Modify only when evidence requires fixes: files changed in Tasks 1-10.

**Interfaces:**

- Produces: evidence that the full workflow works without bundling the runtime or disturbing Prime.

- [ ] **Step 1: Run the deterministic suite**

```bash
vp test run \
  packages/contracts/src/settings.test.ts \
  packages/contracts/src/model.test.ts \
  packages/contracts/src/providerCapabilities.test.ts \
  packages/contracts/src/server.test.ts \
  apps/server/src/provider/Drivers/JcodeDriver.test.ts \
  apps/server/src/provider/Layers/JcodeProvider.test.ts \
  apps/server/src/provider/Layers/JcodeAdapter.test.ts \
  apps/server/src/provider/Layers/ProviderAdapterRegistry.test.ts \
  apps/server/src/orchestration/Layers/CheckpointReactor.test.ts \
  apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts \
  apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts \
  apps/server/src/provider/jcode/JcodeEnvironment.test.ts \
  apps/server/src/provider/jcode/JcodeSdkBridge.test.ts \
  apps/server/src/provider/jcode/JcodePaths.test.ts \
  apps/server/src/provider/jcode/JcodeResumeCursor.test.ts \
  apps/server/src/provider/jcode/JcodeSessionIdentity.test.ts \
  apps/server/src/provider/jcode/JcodeInstanceManager.test.ts \
  apps/server/src/provider/jcode/JcodeRuntimeEvents.test.ts \
  apps/server/src/provider/jcode/JcodeSessionRuntime.test.ts \
  apps/server/src/provider/jcode/JcodeFeatureCapabilities.test.ts \
  apps/server/src/provider/jcode/JcodeModelOptions.test.ts \
  apps/server/src/textGeneration/JcodeTextGeneration.test.ts \
  apps/server/src/provider/Layers/ProviderService.test.ts \
  apps/server/src/provider/Layers/ProviderInstanceRegistryHydration.test.ts \
  apps/server/src/provider/Layers/ProviderInstanceRegistryLive.test.ts \
  apps/server/src/provider/Layers/ProviderSessionReaper.test.ts \
  scripts/build-desktop-artifact.test.ts \
  apps/web/src/components/chat/providerIconUtils.test.ts \
  apps/web/src/components/settings/ProviderSettingsForm.test.ts \
  apps/web/src/components/settings/AddProviderInstanceDialog.test.ts \
  apps/web/src/components/settings/ProviderSettingsPanel.logic.test.ts \
  apps/web/src/session-logic.test.ts \
  apps/web/src/providerInstances.test.ts \
  apps/web/src/modelSelection.test.ts \
  apps/mobile/src/components/providerIconKind.test.ts \
  apps/mobile/src/lib/modelOptions.test.ts
```

Read the output and confirm every named file ran; a zero exit from an empty package filter is not evidence.

- [ ] **Step 2: Run affected package typechecks**

```bash
vp run --filter @t3tools/contracts typecheck
vp run --filter @t3tools/shared typecheck
vp run --filter t3 typecheck
vp run --filter @t3tools/web typecheck
vp run --filter @t3tools/mobile typecheck
vp run --filter @t3tools/desktop typecheck
```

- [ ] **Step 3: Run the real SDK compatibility matrix**

On macOS ARM64, run the compatibility script once without live turns and once with live turns after confirming acceptable model quota use:

```bash
JCODE_BINARY="$(command -v jcode)" \
JCODE_COMPAT_HOME="$PWD/.t3/jcode-compat" \
node apps/server/scripts/jcode-sdk-compatibility.ts

JCODE_BINARY="$(command -v jcode)" \
JCODE_COMPAT_HOME="$PWD/.t3/jcode-compat-live" \
JCODE_COMPAT_LIVE_TURNS=1 \
node apps/server/scripts/jcode-sdk-compatibility.ts
```

After both commands finish, replace only the corresponding `Not run` rows in `docs/internals/jcode-sdk-compatibility.md` with the observed executable version and exact results. Do not claim Linux or Windows support until those rows have been run in matching environments. On Windows, explicitly test a real `.exe` path and an npm `.cmd` shim.

- [ ] **Step 4: Build and inspect packaged artifacts**

```bash
vp run --filter t3 build:bundle
vp run --filter @t3tools/desktop smoke-test
```

Inspect the staged dependency/file manifest and confirm no `@1jehuang/jcode-*` platform runtime package or Jcode binary is present.

- [ ] **Step 5: Perform integrated client verification with permission**

After asking the user for computer-use permission:

- use `/test-pylon-app` for one web/desktop path: add Jcode provider, start a full-access thread, stream text/reasoning/tool activity, attach an image, switch model/effort, stop a turn, restart Pylon, and continue the exact session;
- use `/test-pylon-mobile` for the same remote environment: provider icon/label, model/effort selection, streamed activities, and stop;
- verify one Prime thread and one Jcode thread run simultaneously without shared shutdown or event leakage;
- verify a remote/relay or tunnel client never receives a native socket, home, credential path, or Jcode session ID.

- [ ] **Step 6: Iterate until the matrix and main workflows pass**

Fix observed defects with focused tests first. Re-run only the affected checks plus the relevant end-to-end workflow.

- [ ] **Step 7: Update evidence and commit**

The branch was clean at Task 0 and has one writer. Stage the compatibility evidence plus every tracked release-gate fix under the allowed implementation paths, then prove no unstaged or untracked implementation file remains:

```bash
git add -u -- apps/server packages/contracts apps/web apps/mobile scripts docs \
  pnpm-workspace.yaml pnpm-lock.yaml
git add docs/internals/jcode-sdk-compatibility.md
git diff --quiet
untracked=$(git ls-files --others --exclude-standard -- \
  apps/server packages/contracts apps/web apps/mobile scripts docs)
test -z "$untracked"
git commit -m "fix(providers): pass the Jcode early access gate"
```

---

## Explicitly Deferred Follow-up Plans

The following require separate approved designs rather than being folded into Early Access:

1. **SDK permissions and supervised execution** - enable only after the bridge advertises and emits real blocking permission requests.
2. **Soft interrupt and retract UI** - define a provider-neutral command-only queue model or add authoritative Jcode queue events.
3. **Compaction controls** - add completion/cancellation state before using Pylon's authoritative compaction control surface.
4. **Checkpoint-coordinated rewind/undo** - add durable turn-to-message mapping and a provider rollback compensation interface.
5. **Structured background text generation** - require a no-tools or enforced read-only SDK execution mode.
6. **API-key management** - design provider aliases, secret storage, redaction, removal, remote authorization, and reverse state.
7. **Archive/retention ownership** - decide how native sessions are reclaimed when Pylon threads are permanently deleted.
8. **Bundled downloadable addon** - design external runtime download, verification, updates, platform artifacts, and licensing separately from Electron's application bundle.

## Plan Self-Review

- **Spec coverage:** Core chat, reasoning, tools, usage, background progress, images, models, reasoning effort, cancellation, durable exact sessions, provider metadata, documentation, packaging, and cross-provider isolation each have implementation and verification tasks.
- **Honesty gaps corrected:** approvals, replay, input queue, compaction, rollback, structured generation, account controls, swarms, memory, skills, MCP, goals, schedules, and side panels remain unavailable instead of being simulated.
- **Type consistency:** `JcodeSettings`, `JcodeSdkBridge`, `JcodeInstanceManager`, `JCODE_RESUME_CURSOR`, `JcodeSessionRuntime`, and driver kind `jcode` use the same names throughout.
- **Branch safety:** Task 0 blocks implementation until the current shared worktree is clean and records the actual committed base.
- **Surface coverage:** web, desktop-wrapped web, mobile, local/remote/tunnel boundaries, multi-instance behavior, and one unchanged non-Jcode provider are all covered.
