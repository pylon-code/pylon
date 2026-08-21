# Prime Agent native parity plan

> For maintainers. Using T3 Code? See [docs/user](../user/).

## Acceptance bar

The ACP provider on this branch is a validated compatibility fallback, not the finished integration. The finished first-party provider must expose every stable, machine-facing Prime Agent capability that makes sense in Pylon, keep unsupported Prime API gaps explicit, and preserve the same server-owned behavior for local, desktop, hosted web, relay/tunnel, and mobile clients.

Parity means matching outcomes exposed by Prime Agent's public daemon/SDK surface. It does not mean reproducing terminal chrome, raw keybindings, themes, custom TUI components, or parsing terminal output.

## Runtime decision

Use the independently installed Prime Agent package and its public detached-daemon API:

- dynamically locate the `prime-agent` package from the configured CLI executable;
- import `DaemonClient` and `DaemonAgentConnection` from that exact installation at runtime;
- never add or bundle the 260+ MiB Prime package as a Pylon dependency;
- launch one private, scoped daemon per configured Prime provider instance;
- use a short, stable Pylon-owned socket/pipe name so the user's normal Prime daemon is untouched; contain POSIX sockets in an owner-only directory below a trusted private or sticky temporary root;
- strip every inherited `PRIME_AGENT_INTERNAL_*` variable before launch, because Pylon may itself be running inside a Prime worker;
- create one client-owned Prime daemon session per live Pylon thread;
- persist exact Prime session identity in a server-private thread sidecar while keeping the client-visible provider resume cursor opaque, then rehydrate after server restart;
- keep ACP as an explicit compatibility fallback for installations without the supported daemon API and for Windows until Prime's named pipe has verifiable per-user access control or peer authentication.

Prime Agent 0.7.2 exposes `prime-agent.daemon` protocol 7, schema revision 16. Pylon accepts protocol 7 or newer through the installed high-level client and negotiates server capabilities rather than pinning an internal wire schema.

## Upstream-resilient boundary

The main Pylon code must not learn Prime RPC command names or Prime-shaped payloads.

1. `apps/server/src/provider/prime/*` owns dynamic loading, process/socket lifecycle, runtime validation, reconnect, and Prime event normalization.
2. The Prime provider adapter translates normalized events and typed operations to the generic `ProviderAdapterShape` and canonical runtime events.
3. `ProviderRuntimeIngestion` converts durable-safe canonical runtime events to pure orchestration commands. Sensitive interaction responses use a direct provider RPC; only their redacted resolution outcome reaches ingestion.
4. Deciders, projectors, and clients consume provider-neutral contracts.
5. Web adds one generic Session panel seam; mobile uses shared client-runtime folds and native sheets/cards. No growing list of `driver === "primeAgent"` branches in `ChatView`.

`ServerProvider.featureCapabilities` is versioned and additive. Static driver support is narrowed by the installed daemon handshake and current model/session. Existing legacy flags remain compatibility-derived until every upstream client understands the new contract.

## Capability inventory

### Core session and input

- create, attach, reconnect, snapshot replay, stop, and resume;
- prompt, image input, interrupt, steer, follow-up, queue inspection/control, and queue modes;
- extension select/confirm/input requests and bounded nonblocking status/notification/widget updates;
- cancel editor-replacement requests until their potentially sensitive prefills have a requester-owned, non-durable transport.

### Model and transparency

- model catalog, read-only configured-provider authentication readiness, and live model selection;
- thinking levels, scoped models, service tier/fast mode, and transport where supported;
- streamed answer and reasoning separation;
- token/cache/context/cost usage, compaction, retry, and refinement.

### Native agent capabilities

- subagent hierarchy, observation, usage, messaging, cancel/delete, and depth controls;
- goals and autonomous gate status, with direct mutations only when Prime exposes a stable command;
- heartbeats and schedules owned by the server-side daemon;
- side questions that do not alter the main transcript;
- skill, prompt, extension, package, command, and MCP resource catalogs;
- history tree, labels, export/import, and fork-to-new-Pylon-thread.

### Authentication and execution policy

- report configured-provider readiness only from a healthy non-empty sanitized native model catalog, while empty catalogs and non-ready probes leave authentication unknown; do not treat catalog readiness as live network verification;
- keep sign-in/sign-out in the Prime Agent CLI until exported `AuthStorage` callbacks have explicit provider-instance environment, locking, reload, and multi-session ownership;
- never scrape the TUI or expose secrets to clients;
- Prime remains full-access until a Pylon permission-gate extension proves pre-execution enforcement;
- only then advertise approval-required/host-gated runtime modes;
- in-place provider rollback remains hidden until transcript navigation and filesystem checkpoint restore are one coordinated transition.

## Known Prime API gaps

These cannot be honestly synthesized from the Prime Agent 0.7.2 daemon connection and should become small upstream contributions:

- unified daemon auth and MCP CRUD/OAuth;
- deterministic client-side RLM child spawn;
- direct post-create goal mutation and autonomous-gate reconfiguration/live attempts;
- a normalized file-mutation event;
- a first-class sandbox policy if extension-level tool gating is insufficient.

Pylon must expose these as read-only or unavailable with a reason, never as buttons that send hidden chat prompts.

## Vertical delivery slices

Each slice includes contracts, adapter operation/event mapping, command/event/projector flow, web and mobile presentation where applicable, focused tests, and an isolated browser pass.

1. **Foundation:** feature capabilities, dynamic module bridge, scoped daemon manager, strict event decoder.
2. **Safe daemon chat:** durable daemon session, text/images, cancellation, tool events, extension UI, reconnect, ACP fallback.
3. **Live controls:** model/thinking/service tier and steer/follow-up queue.
4. **Transparency:** reasoning, usage/cost/context, compaction, retry, refinement.
5. **Resources:** unified commands/skills/prompts/extensions, reload, and scoped Pylon MCP bridge.
6. **Agents:** snapshot/event bridge to existing Agents panel, controls/observation, mobile Agents sheet.
7. **Goal and automation:** goals/gates, heartbeats, schedules, notifications.
8. **Side questions and history:** independent side cards, history tree, fork to a new Pylon thread/worktree.
9. **Generic provider auth and permission gate:** supported auth callbacks, credential status, host-gated approvals.
10. **Hardening:** packaged desktop, Windows named pipe/process behavior, remote/relay/tunnel, concurrency and resource use, upgrade/reconnect compatibility.

## Verification rules

- Backend behavior gets focused tests with typed receipts and worker drains; no sleep-based tests.
- Old provider snapshots and clients continue to decode and behave unchanged.
- Unknown future capabilities/events degrade to explicit ignored/unavailable state without dropping the provider.
- Every user-visible slice is tested through the isolated Pylon browser environment and then reloaded/reconnected to prove durable reconstruction without duplicates.
- Browser tests assert another provider remains unchanged and that the browser never sees a daemon socket, session file, or secret.
- Approval tests prove denial causes zero side effects before advertising the mode.
- History tests prove the source thread/worktree is unchanged after a fork.
- Mobile, web/desktop, command palette/keybindings, provider settings, reverse actions, docs, and connection modes are considered for every slice.

## Merge discipline

Pylon is a long-lived fork. Keep new behavior behind small provider-neutral seams and new leaf files, preserve compatibility fields during migration, and avoid broad edits to upstream hotspots such as `ChatView.tsx`. Before each delivery commit, fetch `origin/pylon`, inspect divergence, and resolve conflicts Pylon-first. Selectively adopt upstream behavior rather than rebasing onto a T3 remote.
