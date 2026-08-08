# Prime Agent integration investigation

## Conclusion

Prime Agent can be added to Pylon. The shortest path is a first-party `primeAgent` provider driver that launches `prime-agent --mode acp` and reuses Pylon's existing Agent Client Protocol runtime and canonical event mapping.

This is not a zero-code registration. Prime Agent 0.7.1 speaks stable ACP v1, but its ACP capability profile differs from Cursor and Grok in three important ways: it does not implement ACP `authenticate`, it advertises `loadSession: false`, and it does not expose model or mode configuration through ACP. Pylon must handle those differences explicitly rather than pretending the existing Cursor adapter is generic enough.

A useful, honest MVP is reasonable in roughly one to two engineering weeks after a short compatibility spike. High-fidelity support for Pylon approvals, in-app Prime authentication, durable native session identity, and Prime-specific subagent/goal/heartbeat UI is a larger follow-up best built against Prime Agent's richer RPC protocol.

## Evidence

The investigation used the public `prime-agent` 0.7.1 installation and the Pylon branch based on `origin/pylon` at `7b277718b`.

Prime Agent exposes three machine-facing integration surfaces:

- ACP: `prime-agent --mode acp` (`docs/acp.md` in the distributed package)
- RPC JSONL: `prime-agent --mode rpc` (`docs/rpc.md`)
- a Node SDK exported from `prime-agent` (`dist/index.d.ts`, `docs/sdk.md`)

The ACP surface is the best Pylon MVP boundary because Pylon already owns:

- a stable ACP v1 client in `packages/effect-acp`;
- process/session management in `apps/server/src/provider/acp/AcpSessionRuntime.ts`;
- canonical ACP tool/message event translation in `AcpRuntimeModel.ts` and `AcpCoreRuntimeEvents.ts`;
- production ACP adapters for Cursor and Grok.

A direct stdio smoke test against the installed CLI succeeded for:

1. `initialize` with ACP protocol version 1;
2. `session/new` for the Pylon worktree cwd;
3. `session/close` and clean process exit.

The returned agent info was `Prime Agent` version `0.7.1`; capabilities included images, embedded context, session close, and `loadSession: false`.

A second smoke test confirmed that Pylon's current unconditional ACP `authenticate` call is incompatible: Prime Agent correctly returned JSON-RPC `-32601 Method not found` for `authenticate`.

A disposable-session smoke test also confirmed a practical resume bridge. Launching Prime Agent with a dedicated `--session-dir`, closing it, and relaunching with the same directory plus `--continue` successfully restored the invocation without relying on ACP `session/load`. A short RPC probe using `get_available_models` returned 129 model records with provider, id, display name, reasoning support, and context-window metadata.

Prime Agent is MIT licensed, its package requires Node `>=22.8.0`, and the public repository is `PrimeIntellect-ai/prime-agent`.

## Recommended architecture

### MVP: ACP provider

Add `primeAgent` as a normal first-party provider driver. The server remains the only process owner. Web, desktop, hosted web, relay/tunnel, and mobile continue to use Pylon's existing typed WebSocket contracts; no client talks to Prime Agent directly.

One Pylon thread should own one Prime Agent process and one dedicated Prime session directory. Launch shape:

```text
prime-agent --mode acp --offline \
  --cwd <thread-cwd> \
  --session-dir <pylon-state>/prime-agent/<instance>/<thread> \
  --model <underlying-provider>/<model>
```

On a durable restart, add `--continue` only when Pylon's persisted resume cursor says the thread already owns a Prime session directory. Do not feed Prime's transient ACP UUID back to `session/load`; Prime explicitly does not support that method.

The model slug should preserve Prime's underlying provider qualifier, for example `anthropic/claude-sonnet-5` or `openai/gpt-5.6-sol`. Prime's RPC `get_available_models` response is a suitable health/model probe even if turns themselves use ACP. The configured model must be passed at process launch because Prime ACP does not advertise or implement ACP model configuration.

Declare session model switching unsupported and mark the provider as requiring a new thread for model changes. Pylon's current provider reactor intentionally drops the resume cursor when it restarts an unsupported adapter for a model change, so conversation-preserving model changes are not an MVP feature unless that cross-provider behavior is deliberately changed.

### Full-fidelity follow-up: Prime RPC

Prime's RPC protocol is a better long-term boundary for Prime-specific functionality. It adds:

- `get_state`, including durable Prime session id/file;
- `get_available_models`, `set_model`, and thinking-level controls;
- steering and follow-up queues;
- complete session events, including Prime-native child-agent activity;
- extension UI request/response messages;
- compaction, goals, schedules, heartbeats, observation, and agent messaging.

A dedicated RPC adapter would avoid forcing rich Prime semantics through ACP extensions. It can be staged after the ACP provider proves demand. The ACP adapter and provider catalog work are still useful because the clients and canonical Pylon runtime surface remain the same.

## Required changes for an ACP MVP

### Contracts and settings

- Add `PrimeAgentSettings` in `packages/contracts/src/settings.ts`, initially with `enabled`, `binaryPath`, optional config/session home override or launch arguments, and `customModels`.
- Add the legacy default slot under `ServerSettings.providers` and its patch schema so `ProviderInstanceRegistryHydration.ts` synthesizes a default `primeAgent` instance.
- Add Prime defaults/display metadata in `packages/contracts/src/model.ts` and exports/tests.
- Keep `ProviderDriverKind` open; it already accepts `primeAgent` without widening a literal union.

### Generic ACP runtime

- Make authentication optional/capability-aware in `apps/server/src/provider/acp/AcpSessionRuntime.ts`. Cursor and Grok keep their current auth calls; Prime skips `authenticate` when the initialized agent advertises no auth methods.
- Do not call `session/load` for Prime. The Prime support layer should translate a Pylon resume cursor into CLI `--continue` at spawn time, then call ACP `session/new` normally.
- Extend `AcpRuntimeModel.ts` to retain `agent_thought_chunk` as Pylon `reasoning_text`. Today it drops that update.
- Continue to map `agent_message_chunk`, IPython `tool_call`/`tool_call_update`, images, cancellation, and stop reasons through the shared ACP code.
- Treat unknown Prime `_meta` payloads as optional enhancement data. Today `session_info_update` is ignored, so core chat still works but subagents, goals, refinement, autonomous gates, and rich IPython metadata are not visible as first-class Pylon state.

### Driver, adapter, health, and text generation

Add the sibling modules expected by the driver SPI:

- `apps/server/src/provider/Drivers/PrimeAgentDriver.ts`
- `apps/server/src/provider/Layers/PrimeAgentAdapter.ts`
- `apps/server/src/provider/Layers/PrimeAgentProvider.ts`
- `apps/server/src/provider/acp/PrimeAgentAcpSupport.ts`
- `apps/server/src/provider/Services/PrimeAgentAdapter.ts`
- `apps/server/src/textGeneration/PrimeAgentTextGeneration.ts` (or a typed unsupported implementation for the first slice)

Register the driver and environment union in `builtInDrivers.ts`. Also widen or remove the stale closed `TextGenerationProvider` helper in `TextGeneration.ts`; provider routing itself is already open.

The adapter can follow Grok's ACP lifecycle while removing xAI extensions and ACP model/load assumptions. It must still implement the complete `ProviderAdapterShape`: start, prompt, interrupt, stop, list/read/rollback semantics, event stream, and deterministic scoped process cleanup.

Health probing should:

1. run `prime-agent --version` with a short timeout;
2. report a clear missing-binary/PATH error;
3. use a short-lived offline RPC process and `get_available_models` for the model catalog;
4. leave auth `unknown` for the MVP unless a reliable Prime auth-status API is added;
5. show the terminal install/login instructions when no usable model can run.

Every `ProviderInstance` must supply a text-generation service. The first slice may return a typed unsupported error and prevent Prime from being chosen for titles/branches/PR copy; full support can use a short-lived ACP or RPC process with the requested model and Pylon's existing structured-output prompts.

### Web, desktop, and mobile

- Add Prime to `apps/web/src/session-logic.ts`, `providerDriverMeta.ts`, and `providerIconUtils.ts`.
- Add a Prime branch in `apps/mobile/src/components/ProviderIcon.tsx`; the current unknown-provider fallback incorrectly renders the Codex icon.
- Reuse the generic provider settings card, environment-variable editor, model picker, composer, and projected runtime timeline.
- Add an official Prime mark only after confirming the desired asset/trademark treatment; initials are a safe functional fallback.
- Desktop needs no new IPC contract. It must be able to find the user's CLI. GUI-launched apps often lack `~/.local/bin` in `PATH`, so the binary-path setting and actionable detection message are important.
- Remote web and mobile work naturally because the CLI runs on the Pylon environment host. The host, not the viewing device, needs Prime Agent installed and authenticated.

### Documentation and focused tests

Add user provider setup documentation and update `docs/internals/providers.md`. Focused tests should cover:

- Prime spawn args and environment isolation;
- optional ACP authentication without weakening Cursor/Grok;
- version/model probes, including missing binary and RPC failure;
- session start, streamed assistant/reasoning/IPython events, completion and failure;
- interrupt/cancel and scoped process cleanup;
- dedicated session directory plus `--continue` resume;
- model-change new-thread requirement;
- server driver registration/settings hydration;
- web provider metadata/model picker and mobile icon selection.

Use real Prime Agent only for a small opt-in smoke/integration test. Keep normal tests deterministic with a mock ACP peer.

## Product limitations that must be explicit

### Approval mode

Prime's ACP mode does not request client permissions for IPython cells. Pylon cannot honestly claim that its `approval-required` runtime mode protects Prime turns. The MVP should either:

- expose Prime only as full-access and say so clearly; or
- reject approval-required session starts with an actionable message.

Do not silently auto-run while showing an approval-required badge.

A later RPC adapter can inject a Pylon-owned Prime extension that gates IPython tool calls through RPC extension UI confirmations and maps those requests onto Pylon approvals. That needs threat-model and cancellation work because one IPython cell can execute Python, shell commands, and file changes.

### Authentication

Prime multiplexes many underlying model providers and supports both API keys and subscription OAuth. Pylon's existing in-app provider login coordinator is Claude-specific. For the MVP, rely on existing Prime auth (`prime-agent` then `/login`) or per-instance environment variables such as provider API keys. A first-class login UI requires a Prime-supported headless auth/status contract rather than scraping the interactive TUI.

### Durable sessions

ACP session ids are transient random UUIDs and Prime advertises `loadSession: false`. Dedicated Pylon-owned session directories plus CLI `--continue` are proven workable, but they are a bridge. RPC's durable `sessionId`/`sessionFile` is the cleaner long-term cursor.

### Steering, MCP, and rollback

Prime ACP permits only one prompt at a time and has no steering method. Pylon must reject or queue a second message during a running Prime turn instead of issuing a concurrent `session/prompt`. Prime also ignores the `mcpServers` supplied in ACP `session/new`; Prime's own configured MCP resources work, but Pylon's per-session MCP bridge does not.

Pylon checkpoint revert can restore workspace files, but Prime ACP cannot roll its conversation back. The MVP must mark provider-conversation rollback unsupported or restart a fresh Prime session after a file restore; it must not report a fully synchronized revert when only git state changed.

### Prime-native UI

ACP `_meta.ai.primeintellect.prime-agent` carries subagents, autonomous gates, goals, heartbeats, compaction, refinement, agent messages, and rich IPython attachment/diff metadata. Pylon currently ignores `session_info_update`. The MVP still renders normal text and tools, but Prime's differentiators need explicit contracts/projectors/UI rather than provider-shaped blobs leaking into clients.

### Process ownership and distribution

Start with `supportsMultipleInstances: false` until separate `PRIME_AGENT_CODING_AGENT_DIR`, session directories, daemon sockets, environment credentials, and background-worker ownership are tested together. One live Pylon thread can own a Prime worker, IPython kernel, and descendants, so memory/process cost should be measured before encouraging many simultaneous threads.

Do not bundle Prime Agent in the MVP. Require the independently installed CLI and document Node `>=22.8.0`, Python/IPython bootstrap, and platform requirements. The installed 0.7.1 package is about 262 MiB before any separate kernel environment and includes native dependencies; Electron redistribution would require its own license-attribution audit, native builds, updates, and cold-start UX.

## Suggested delivery sequence

1. **Compatibility spike (1–2 days):** optional ACP auth, Prime spawn support, real handshake test, model probe, disposable resume proof, and instance/daemon ownership experiment.
2. **Shippable ACP MVP (roughly 6–10 additional engineering days):** driver/settings/snapshot, adapter, typed text-generation decision, web/mobile metadata, focused tests, user docs. Full-access only.
3. **Production hardening (roughly 1 additional week):** installation/PATH and cold-start UX, auth diagnostics, Windows validation, model-catalog caching/filtering, crash/lease behavior, packaged desktop smoke, and concurrency/resource measurements.
4. **Prime-native RPC integration (roughly 2–4 weeks depending on scope):** approvals, in-app auth cooperation, durable session identity, thinking/model switching, extension UI, and first-class subagent/goal/heartbeat presentation.

The main feasibility risk is not transport. Transport is already solved and was smoke-tested. The real product decisions are how much Prime-native behavior Pylon should expose and whether MVP full-access semantics are acceptable.
