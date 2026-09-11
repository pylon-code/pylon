# Prime Agent daemon parity ledger

This ledger records Pylon's treatment of the public `DaemonAgentConnection` surface shipped by
Prime Agent 0.9.4 (daemon protocol 7, schema 27) and Pylon's optional fork extension at protocol 7,
schema 33. Parity here means that every useful public outcome is either integrated through a typed
provider-neutral contract or has an explicit product and safety decision. It does not mean exposing a
raw method tunnel.

Pylon dynamically probes optional methods on the installed package. All native identifiers, paths,
private prompts, diagnostics, and result envelopes terminate at the Prime adapter boundary.

Exact checkpoint rollback is a server-private exception to the otherwise deferred history surface. The managed native adapter uses only public `getState()` and `navigateTree()` calls. It stores opaque leaf anchors in private rollback tables, never in contracts or public events. Availability is per thread and requires an idle, quiescent, full-access session with matching provider, runtime-generation, session-incarnation, and native-session identity. Navigation never summarizes an abandoned branch. A nonterminal saga quarantines Prime output, accepts only its source or target leaf after reconnect, and proves the exact committed target before release. Managed recoverable ownership remains idle and adoptable after a settled turn; the next turn cannot rotate that owner until terminal projection and checkpoint quiescence are durable.

Prime Agent 0.9.4 keeps daemon protocol 7 and advances the shipped stock schema to 27. The Pylon fork uses
schema 33 for its additional capability-gated contract. Pylon supplies the fresh owner runtime
configuration required to recover a client-owned
worker, refreshes the RLM roster from the authoritative snapshot method when available, and retains
event-derived fallback behavior for older installations. Both daemon and ACP launch paths remove
inherited `PRIME_AGENT_INTERNAL_*` and `RLM_DEPTH` process context while preserving public user
configuration such as `RLM_MAX_DEPTH`. This prevents a Pylon-owned root session from accidentally
inheriting another harness worker's private identity or recursion depth. Prime's no-override RLM-depth
fallback is 2, and Pylon
continues to project the authoritative source and value rather than assuming either default. ACP
completion and assistant-boundary changes are handled separately below; live catalog changes remain
provider-discovered rather than pinned in Pylon.

Prime Agent 0.9.4 makes process-owner liveness zombie-aware and reports a known recovering daemon
session through the structured, retryable `session_recovering` error with its active-session identity.
It adds `rlm.create_session` so a daemon-backed root agent can create a separate top-level session.
Provider retries honor bounded `Retry-After` and usage-limit reset delays, the `zai` provider defaults to
`glm-5.3`, and Prime Inference refreshes its public and authorized private model catalog while retaining
bundled and cached fallbacks. Pylon keeps these model and retry changes provider-discovered and preserves
its existing recovery, privacy, and session-ownership boundaries around them.
The fork's schema 33 also forwards validated complete, partial, or unavailable replay proof through
direct-worker and supervisor resync paths; absent proof remains unavailable instead of being synthesized.

## Multiple-instance capability gate

Prime Agent multiple-instance support is disabled. The isolation, fencing, quarantine, and native
preflight code remains in place, but neither static driver metadata nor live provider snapshots advertise
support. Host CAS validation rejects a second enabled Prime instance with the graduation reason.

The earlier opt-in macOS runs are exploratory only. They exercised N=2 and N=4 with temporary copies of
one auth fixture and one package binary. They did not prove distinct account credentials, distinct package
roots, worker-observed settings/auth/model canaries, distinct catalog and capacity results, a real call to
each Pylon MCP bearer endpoint, or a Pylon-created canonical checkpoint. They also did not run N=1 in the
same proof matrix. They therefore cannot graduate the capability.

Graduation requires all of these enforced results on the exact publication candidate:

- signed-in macOS N=1, N=2, and N=4 runs with distinct canonical auth homes and distinct package
  roots/binaries; byte-reproducible builds are acceptable;
- worker-observed credential, model, settings, and home canaries for every participant;
- distinct account-backed catalog and capacity results;
- one authenticated request to every instance's Pylon-created MCP bearer endpoint;
- canonical checkpoint refs read from checkpoints actually created by Pylon, not values computed by the
  test helper;
- removal, reconnect, crash, and teardown barriers without cross-instance signaling or cleanup;
- an enforced hosted Linux contract and a WSL2 path tied to the same publication. A statement that WSL2
  reports `linux` is not a hosted proof.

The proof ceilings below are conservative rejection limits, not product budgets. Any candidate exceeding
one row fails graduation and leaves support disabled.

| Instances | Readiness ceiling | Captured process ceiling | Aggregate RSS ceiling | FD ceiling | Private sockets |
| --------: | ----------------: | -----------------------: | --------------------: | ---------: | --------------: |
|         1 |             120 s |                       32 |                 8 GiB |     62,500 |               1 |
|         2 |             180 s |                       64 |                16 GiB |    125,000 |               2 |
|         4 |             240 s |                      128 |                32 GiB |    250,000 |               4 |

The current fix environment did not have explicit per-instance signed-in auth homes and package roots, so
macOS N=1/2/4 was not run as a graduation proof. No enforced hosted Linux/WSL2 publication path exists yet.
Keeping `supportsMultipleInstances: false` is therefore intentional.

ACP compatibility mode consumes Prime's correlated `ai.primeintellect.prime-agent`
`session_info_update` envelopes. Prime Agent 0.8.1 does not resolve the standard ACP prompt until all
causally admitted descendant and parent work settles; Pylon still validates the matching terminal event
sequence before settling the turn, which also preserves safe behavior with 0.8.0's earlier response
boundary. Prime Agent 0.8.1 also labels assistant chunks with a private message-boundary token. Pylon uses
only token changes to rotate its own opaque assistant segment identifiers, so adjacent autonomous replies
remain distinct without exposing or persisting Prime's identifier. Missing tokens retain older-provider
behavior. Invalid terminal correlation fails closed. Older ACP releases that publish no completion
metadata retain prompt-response settlement.

Prime Agent provider execution is supported on macOS, Linux, and WSL2, which reports itself as Linux.
A native `win32` Pylon server fails closed at `PrimeAgentDriver.create`, before daemon or ACP selection,
status and catalog probes, capacity reads, background writing, or install/update resolution. It exposes
only the typed unavailable provider snapshot with WSL2 guidance and never uses native ACP as a fallback.
Web, desktop, and mobile clients remain supported when they connect to a WSL2 or remote environment.
Revisit native execution only after upstream Prime Agent supports Windows, then revalidate its public
process, transport, SDK, and ACP contracts before changing this ledger or removing the driver gate.

Prime supervisor ownership is recorded outside the agent home. Since Prime Agent 0.8.0, the daemon has retained the registry at `~/.prime/supervisor-owners` so macOS cleanup cannot delete a long-running supervisor's authority record, and the location is deliberately global per user rather than per agent directory. Pylon therefore writes ownership records there even when a provider instance sets its own agent home, and daemon start, stop, and renewal briefly take that registry's advisory lock alongside any other Prime daemon on the machine. This is safe for Pylon because ownership conflicts are keyed on socket path and worker descriptor directory: Pylon derives a unique socket per `(state directory, provider instance)` and the descriptor directory hashes that socket, so a Pylon daemon never claims ownership over a user's interactive `prime-agent` daemon even when both share the default `~/.prime/agent` home. Prime exposes an internal environment override for the registry location; Pylon does not use it, because it strips every `PRIME_AGENT_INTERNAL_*` variable from the daemon environment by design and will not build product behavior on an unsupported knob.

Prime event queues are bounded to 256 entries and preserve FIFO delivery with backpressure during normal operation; no sliding or dropping queue is used. Nonterminal ordinary daemon callbacks wait behind that queue through a separately serialized staging tail bounded to 256 raw events and 64 MiB of conservative structural weight. Reconnect and native-close admission fence new input synchronously, before either callback can wait in that tail. One normalized native close waits for every route admitted before it, but its potentially long worker-recovery operation does not occupy the tail, so later bounded recovery evidence can progress. Events received while that close is still being classified remain provisional; only a bounded assistant-terminal fact is retained until the post-ready snapshot becomes authoritative. Exceeding the staging bound emits one fixed terminal and discards staged work before it can enter provider recovery instead of retaining unbounded callback promises. Pre-snapshot raw and decoded admission reserves count and weight cumulatively and fails closed without waiting for a consumer. Adapter teardown allows one second for a stalled consumer to drain, then logs a structured forced-shutdown outcome and every rejected terminal event's safe type/thread identity before closing. These explicit exceptional paths prevent memory or scope deadlock; they are not silent loss.

Prime session teardown first evicts the session under the adapter permit, then performs interaction cancellation, turn settlement, MCP release, runtime disposal, and terminal publication outside that permit. Each step has a bounded timeout and failure in one step does not skip the others. A start for the same thread waits on the old teardown gate only up to that bound, so a hung daemon finalizer cannot block replacement forever. `stopAll` cleans sessions with bounded parallelism rather than serially or with an unbounded fan-out. `SessionClosed`, explicit stop, scope shutdown, and duplicate late close notifications share the same idempotent cleanup path and publish at most one `session.exited` and one turn completion.

The daemon manager's production syscall path is explicit. It starts the private daemon with
`node:child_process.spawn` and does not register Effect's process-group-signaling child finalizer.
Graceful stop is a typed `shutdown` request over the validated private daemon connection. Node exposes no
API that atomically binds a Unix signal to `{ pid, startIdentity }`, so production installs no forced-signal
callback and refuses `SIGKILL` rather than calling `process.kill`, `ChildProcess.kill`, or signaling a PGID.
The remaining scope owns output drains only; closing it and unrefing the captured handle cannot signal a
naturally exited, PID-reused, or still-live process. An uncertain stop therefore leaves the native ownership
receipt dirty and the overlapping home quarantined.

Daemon assistant messages receive opaque subscriber-local segment identifiers so separate model/tool
cycles within one Pylon turn retain their chronological positions without persisting Prime's native
identifiers. After an ordinary daemon prompt reaches its first response boundary, Pylon invokes Prime
Agent 0.8.1's public RLM-quiescence barrier. Its server-owned FIFO marker carries the Pylon turn and input
generation, so a late marker cannot settle later steering, follow-up, or a different turn. Every admitted
input rearms the barrier. Native barrier calls are serialized so re-arming cannot duplicate autonomous
continuation checks. Prime can cancel an in-flight recursive wait when the parent explicitly deletes its
final child after receiving that child's reply. Pylon retries only that exact cancellation while the owning
Pylon turn remains active and on the same connection generation, at most three times; the completion
boundary is reissued but the prompt is not. Pylon-managed sessions disable Prime's autonomous gates, so
that boundary cannot admit an autonomous continuation. User cancellation suppresses the retry. After an
admitted prompt, the supervisor can also report `Session worker is recovering` while it reconnects a live
worker, including when automatic compaction overlaps a worker snapshot transfer. Pylon then opens one
bounded 60-second recovery gate instead of resubmitting the boundary. At most 16 read-only session-list
probes must observe the exact stable, file, and active session identities change from `recovering` to `ready`
on the same diagnostic worker PID. Once ready, Pylon explicitly reads and routes a post-gate public snapshot;
it must reconcile exactly through the adapter instead of relying on a spontaneous resync event.
A changed PID, Prime's private worker-interruption marker, an incomplete bounded snapshot tail, user abort,
disposal, or daemon connection-generation change fails closed. Only after both worker and transcript proof
succeed does Pylon retry the completion boundary once, and it still requires a recovered public terminal
root response before publishing quiescence. It never resends the prompt. Any other worker state, boundary
error, second recovery response, or exhausted bound fails closed. This is containment for Prime's still-open snapshot identity race
([Prime discussion #1662](https://github.com/PrimeIntellect-ai/prime-agent/discussions/1662)), not a
replacement for fixing snapshot capture in Prime. A daemon connection-generation change pauses that
boundary until the replacement connection publishes its generation-scoped resync. Complete replay metadata proves event continuity. If
replay is unavailable, Pylon accepts only a public snapshot whose bounded completed-message tail and
absolute message count are an exact continuation of the adapter's observed tail and which contains no
unreplayable streaming message. It
projects only the missing assistant and tool lifecycle, replaces the authoritative child roster, and then
allows the serialized barrier to finish on the new generation. If Prime's original `prompt_and_wait`
request remains unresolved after transport recovery, the same proof releases Pylon's admission wait. A
same-generation `Daemon worker client closed` rejection is also adopted only after the first live,
post-registration root user-message completion exactly matches the submitted bounded, non-blank text,
ordered image MIME types, and transient SHA-256 image fingerprints. The fingerprints remain inside the
daemon runtime and never enter provider events or durable state. A different first user message
permanently invalidates the proof; root run, tool, child, assistant, or later repeated user activity is
never admission evidence. Image-only, whitespace-only, oversized, transformed, stale, lossy, cancelled,
generation-ambiguous, or missing evidence fails closed after a bounded grace period. Pylon
never sends the prompt again, and the correlated barrier still owns completion. Older-generation
snapshots are ignored.

Pylon enables `correlated_prompt_lifecycle_v1` only when the installed SDK exports the exact
`negotiated_daemon_session_capabilities_v1` token in its frozen public feature registry and the completed
attachment's public `supportsNegotiatedCapability(...)` accessor proves that capability. A server hello
offer, version, schema, method presence, constructor shape, attach success, or mutable feature array is not
proof. The check occurs only after attach and again after the initial snapshot and asynchronous control-plane
reads. A missing token or a false initial proof keeps the compatible ordinary-prompt path. A true proof
latches strict correlated mode for the session; later proof loss can never switch that session to ordinary
submission.

In strict mode Pylon uses the fork's dedicated correlated submit, cancellation, and read-only lifecycle
commands. The correlation is opaque, provider-private, bound to the exact durable session generation, and
unique for that generation. A foreground prompt may wait behind native background work only when its
requested model, thinking level, and service tier already match the live session controls. Prime marks the
exact delivery crossing, every client-visible event is prompt-owned or session-scoped, and terminal
lifecycle state carries prompt-local usage. Pylon never infers ownership from message text, roster activity,
native busy state, or a proof from an earlier attachment.

Pylon advances a monotonic consumer proof epoch synchronously at reconnect and replacement admission. Every
awaited correlated submit, reconciliation, cancellation, worker snapshot, resync, provider-recovery result,
and final quiescence publication must finish under the same epoch with the current accessor still true before
it can change lifecycle state or commit an event. Proof-sensitive commits never wait behind the bounded event
queue: the proof check, cumulative-weight reservation, queue offer, and internal lifecycle mutation commit as
one synchronous step or fail closed. Serialized proof-route staging is independently bounded to 256 raw
events and 64 MiB of conservative structural weight. Initialization snapshot/event retention and the decoded
runtime queue each have their own 64 MiB cumulative structural budget in addition to count bounds, so neither
a blocked provider verification nor a stalled adapter can retain unbounded private frames. A reconnect may
restore proof before Prime releases held attributed frames; those proved frames are accepted while the
explicit resync is still pending. The resync must then
carry current proof, and `connected` without that proved resync fails closed. An older asynchronous resync or
provider callback is discarded when a newer recovery retires its epoch. New-turn admission and native
correlated commands remain blocked until the adapter settles the exact resync snapshot. Proof loss emits one
fixed payload-free terminal failure, permanently rejects later native commands even if the SDK accessor
returns true again, and discards later native close frames. Pylon never retries or downgrades an already-owned
correlated prompt.

The adapter consumes native events in the session scope, including ordinary startup, deferred first
admission, and recovered activation. Finishing the worker that started a turn must not stop delivery of
later approvals, output, or lifecycle events. Session teardown owns consumer interruption; turn completion
and scoped cancellation retain their existing ownership and terminal-lifecycle checks. After launching
detached teardown, the initiating consumer's receipt wait is interruptible so session-scope closure does
not wait on the consumer while the consumer waits for teardown resources to start.

A strict resync still requires complete replay. At a locally submitted turn's original transcript boundary,
one missing user message may be reconciled only against the exact submitted nonempty text and ordered image
MIME types and digests, within the existing decoded-message bounds. The observed and snapshot lifecycle
must identify the same delivered model prompt, with an unchanged or valid advancing revision; queued steering
or an advanced transcript boundary excludes this case. The submission signature exists only in active-turn
memory and is absent from adopted restart turns. Unknown replay, changed transcript content, missing ownership
proof, and additional unattributed output remain rejected.

Prime 0.9.4 can insert one hidden `harness_digest` before the first submitted user message. Pylon retains
its timestamp and SHA-256 content/details identity in the native transcript, preserving the native absolute
message count without publishing harness content. The first-user case permits that single prefix either
already observed or in the same complete snapshot. Changed or missing observed digests, multiple prefixes,
unknown custom messages, and extra user/assistant/tool output still fail continuity validation.

Ordinary sessions preserve lossless FIFO delivery under transient decoded-queue pressure through a separately
bounded 256-route, 64 MiB raw staging tail. Reconnect and close admission fence public input synchronously at
the subscription boundary. Each recovery-sensitive ordinary frame carries its exact ingress-generation fence
through managed-extension verification, scoped MCP replacement, decoded-queue waits, and the final event
commit. A newer reconnect retires that fence and interrupts its Effect continuation; an older suspended
snapshot can neither retain its raw generator, publish as the new generation, nor settle or clear its provider
latches. Strict proof epochs use the same interruptible provider-route fence, including direct replacement
snapshot reads. One session may have at most one unresolved physical provider-recovery operation across
managed verification, scoped MCP replacement, direct replacement reads, worker-list classification, and
worker snapshot reads. Managed
verification starts each fixed-fanout child behind its own rejection boundary and waits for every child to
settle, so one early rejection cannot release the slot while a sibling remains live. Retiring an Effect route
does not release this slot; only physical Promise settlement does. Same-generation worker classification may
share the one in-flight list read, while a newer generation fails closed rather than starting a second physical
operation. Quiescence MCP reclamation uses generation-owned state plus the same cap
and retirement fence. A settled successful recovery is inert for later same-generation barriers, and reconnect
retirement clears its captured global object, so an older success cannot obstruct a later ordinary barrier. Restoration receives the exact owned recovery
object and generation, so an older barrier cannot reclaim or settle its successor. Disposal releases its Effect waiter, gives the last issued
physical replacement a bounded settlement grace, and then explicitly releases MCP ownership. If the physical
replacement remains unresolved, the pinned negotiated daemon's client-claim identity check and detach path
roll back any late replacement; daemon-client teardown is the terminal cleanup boundary. Proof loss
publishes its one fixed terminal without waiting behind the retired provider tail. Fatal ingress and disposal
retire both modes' waits so pending input and staged callbacks cannot remain hidden behind a provider promise.
Both ordinary and strict close callbacks wait for proof/FIFO work admitted before the close, but do not place
their longer worker-recovery promise in the shared tail. An ordinary close route singleflights only within its
exact ingress fence; a close admitted after reconnect starts an independent generation-owned attempt, and the
older route cannot clear its successor's latch. Generic frames also capture the close route present at their
own admission. Reconnect synchronously clears the mutable global latch so current-generation recovery and
new traffic cannot be suppressed by the retired route; frames admitted behind that old close still stay
quarantined because their captured route no longer owns the latch, while traffic admitted before the close
remains lossless. The captured close route also carries an interruptible retirement signal through managed and
MCP tails, decoded-queue capacity waits, and the final atomic offer/commit. Reconnect, route settlement, fatal
ingress, and disposal retire that signal, so a frame that passed its initial ownership check cannot resume stale. Strict close captures its exact proof epoch and
connection generation at admission; a later proof can never authorize that older close. The same exact fence
remains mandatory after worker recovery starts and through adapter settlement until authoritative quiescence
finally clears the recovery: reconnect or replacement during list, snapshot, gate, or post-settlement waits
fails with the fixed proof-loss terminal. Disposal retires a staged close before it can issue a later worker
request. A capability-independent close latch rejects every
public native operation except the authoritative quiescence barrier. Later native traffic remains provisional
until worker-close classification; only one bounded assistant-terminal fact is retained, and private side
questions fail generically before a matching late completion can resolve them. Fatal ordinary ingress also
fails every active private side question, whose finalizer retains its bounded best-effort native abort. A settled recovery attempt is
never reused for a later genuine close.

Lifecycle records and bounded tombstones survive reconnect and worker recovery only when this current
proof remains valid. The merged SDK invalidates proof before direct daemon replacement, so Pylon fails that
strict session instead of reading a replacement snapshot under stale authority. Live child-activity watching
is also unavailable in strict mode because its same-client `watchSession` attachment would invalidate the
root proof; ordinary sessions retain that feature. A proved direct same-attachment resync receives its own
adapter-settled resolution and passes through the same bounded proof route. Any stale or malformed recovery
snapshot fails the strict session once instead of leaving hidden recovery pending. Pylon still validates
request identity, sequence, provenance, lifecycle successors, and replacement state before advancing its
cursor or projections. Other malformed capable frames become one private protocol violation marker and fail
the correlated turn without exposing their correlation or native payload. Scoped cancellation can stop work only before delivery; after
delivery it remains attached until an authoritative terminal lifecycle arrives. Stock Prime daemons and
feature-absent fork builds remain supported through the conservative observed-activity path. That fallback
returns typed `busy` before Pylon creates a turn when background activity is visible; it cannot eliminate the
narrow race where unobserved native work starts between the activity check and ordinary prompt admission.

Daemon task parity uses one generated, Pylon-owned extension for `pylon_update_plan` and the
optional supervised execution gate. The root-only tool accepts a bounded full plan snapshot; an empty
snapshot clears the visible plan. Pylon decodes only the exact successful `pylon-plan-v1` details from a
finalized root `message_end` tool result whose private call id and exact name match a preceding durable
assistant tool call in the same canonical turn. Generic tool arguments, result text, structured details,
and Prime tool-call identifiers remain private. The adapter binds the update to the exact active turn and
deduplicates the private identifier in memory. Reconnect and replacement-worker recovery disable plan
projection before native events can pass, fence further native input, verify the managed extension path,
marker, exact plan-tool definition, generated source, and supervised depth again, then reconcile every
missing finalized result in one bounded transcript-order pass. Reload performs the same provider checks
and rejects changed generated source both before and after asking Prime to reload. Full-access sessions retain normal user extension discovery and scope unrelated diagnostics out
of Pylon's managed-path check. Approval-required sessions retain the stronger fail-closed policy: one
explicit extension, discovery and automatic reconnect disabled, zero RLM child depth, and no non-warning
extension diagnostic from any path.

This bridge is daemon-only. On supported hosts, ACP fallback is selected when daemon mode is disabled or
unavailable and when custom Prime launch arguments are configured. Native Windows stops at the driver
boundary instead. Prime Agent 0.8.1 ACP does not load
the managed bridge and drops custom tool-result `details`, so those sessions retain only Prime's standard
ACP `PlanUpdated` handling. Matching managed-tool parity in ACP requires a separately reviewed bounded
content envelope and credible extension verifier, or another scoped transport; it is not implied by this
ledger's daemon support. The provider feature snapshot advertises planning as read-only `observe` in both
modes because bounded plan progress reaches Pylon. It does not advertise `propose`, `update`, or
`select-mode`; Prime has no compatible formal Plan interaction mode, and Pylon keeps that composer control
hidden instead of synthesizing one with a hidden prompt.

Any transcript mismatch, incomplete streaming snapshot, MCP reattachment failure, or unvalidated barrier
fails the canonical turn once and disposes the uncertain native session.

### Pylon process restart recovery

An admitted Full access turn can outlive the Pylon server process only when a Pylon-managed Prime
publication, its exact package root and build, the supported macOS/Linux host architecture, and the same
retained supervisor generation all match the private recovery ledger. The ledger also binds the provider
instance and Pylon session incarnation to Prime's protocol, schema, capabilities, active/native session,
correlation, cursor, recovery configuration, exact launch environment, MCP owner, and bounded transcript
progress. It is server-private: recovery handles, native identifiers, correlations, cursors, snapshots,
paths, prompts, tool data, and transport errors never enter public contracts, events, receipts, or logs.

Preparation writes native ownership before prompt submission and records the exact turn only after Prime
admits that prompt. At startup, a replacement claims ownership with a SQLite compare-and-swap before SDK
adoption. It rotates the ledger authority, restores scoped MCP ownership, confirms adoption, installs the
existing Pylon incarnation fence, and only then releases exact retained replay and live events. Startup
performs this adoption pass before generic orphan reconciliation. A terminal reached while Pylon was down
therefore settles the original turn and checkpoint once without another prompt or `turn.started`.

Graceful process shutdown detaches an eligible owned worker and leaves its compatible supervisor alive;
explicit Stop and normal terminal cleanup still require Prime's authoritative owned-session cleanup proof.
The private row is deleted only after that proof, terminal projection delivery, and checkpoint quiescence.
A competing Pylon process cannot win the same ledger generation, and a process that did not spawn a
compatible supervisor never shuts it down.

Supervised and other approval-required sessions, ACP mode, stock/manual or unverified distributions,
native Windows, copied state, a replaced supervisor, an unsupported host, unresolved interaction state,
partial replay, transcript mismatch, or any other unproven identity/continuity retain the existing precise
orphan result. Pylon does not steal, re-submit, disclose, or synthesize native work in those cases. When
both bounded stats reads succeed, the usage delta includes child billing that Prime attributes after the original message event. The native autonomous-status result is
discarded at the provider boundary. Older connections without the barrier retain response-boundary
behavior. An error- or tool-terminated native run completion without a
final public response is also held for a bounded three-second reconnect handoff; a following native run
remains attached to the original Pylon turn, while an exhausted handoff settles as a real failure. Daemon and ACP modes
both emit a fixed provider-neutral status before an authoritative terminal event when no public final
assistant text follows the latest tool boundary. Reasoning, tool data, native errors, and identifiers
are never used to synthesize assistant prose.

| Public API outcome                                                                                                                                         | Pylon status                                                          | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `attach`, root `subscribe`, `getState`, `getInitialSnapshot`, `dispose`                                                                                    | Integrated internally                                                 | Own one private daemon session per active Pylon thread, resume exact verified identity, reconnect through public snapshots/events, and close with the thread scope. On 0.8.1 recovery Pylon resupplies the owner `cwd`, session/agent directories, execution policy, and current Pylon-selected model and thinking level; successful model and thinking mutations update that transient recovery context, which Prime never persists. The root connection's `getMessages` transcript API is never called; Pylon's event-sourced transcript remains authoritative. These are lifecycle primitives, not client RPCs.                                                                                                                               |
| `promptAndWait`, `steer`, `followUp`, `abort`                                                                                                              | Integrated                                                            | Typed turn admission, active steering, explicit follow-up, queue modes, and interruption remain under Pylon turn ownership. On 0.8.1 the prompt boundary is followed by the public RLM-quiescence barrier so descendant-triggered parent continuations remain in the same canonical turn. Every admitted steer or follow-up advances a correlation generation and rearms that boundary. An in-process transport reconnect preserves the same Pylon turn only after complete native replay or exact public-snapshot reconciliation; ambiguity fails the turn and disposes the native session. Admission is never retried.                                                                                                                         |
| `supportsNegotiatedCapability`, `submitCorrelatedPrompt`, `cancelPromptLifecycle`, `getPromptLifecycles`                                                   | Integrated behind frozen SDK feature and post-attach proof            | The exact frozen `negotiated_daemon_session_capabilities_v1` feature enables the proof accessor check only after attach. A false initial proof selects typed-busy ordinary admission; a true proof latches strict correlated mode. Consumer proof epochs fence every asynchronous lifecycle call, worker snapshot, and resync. Proof loss is terminal and never resubmits or downgrades an owned prompt. Direct replacement currently invalidates proof before publication and therefore closes the strict session. Method presence, version, schema, hello offers, and mutable feature registries never enable this path.                                                                                                                       |
| `prompt`, `waitForIdle`                                                                                                                                    | Intentionally redundant                                               | Pylon uses the cancellable `promptAndWait` admission path and daemon events for exact turn settlement. A second fire-and-observe prompt path or an unscoped idle waiter would weaken turn and checkpoint ownership.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `getQueue`, `clearQueue`, `setSteeringMode`, `setFollowUpMode`                                                                                             | Integrated                                                            | Expose only counts and delivery modes. Queued text stays private.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `mutateQueuedMessage`                                                                                                                                      | Partially integrated                                                  | Pylon exposes sole-lane deletion only. Preview text stays server-private. A serialized, non-recovering compare-delete is followed by reconciliation; ambiguous mutations are never retried. Multi-item delete, move, and replace remain unavailable without opaque IDs or revisions.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `abortAndClearQueue`                                                                                                                                       | Intentionally folded into Stop                                        | The public operation combines interruption and queue deletion. Pylon keeps non-interrupting Clear and authoritative Stop separate so the reverse state is unambiguous. Prime Agent 0.8.1 suspends queued-input admission when aborting, so Pylon explicitly resumes that scheduler before reusing the session.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `setModel`, `setThinkingLevel`, `setServiceTier`                                                                                                           | Integrated                                                            | Exact selection is owned by the durable thread model projection and reconciled against sanitized session state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `getAvailableModels`, `getModelCatalog`                                                                                                                    | Integrated provider-catalog and auth-readiness enrichment             | Attached sessions use `getModelCatalog`, with `getAvailableModels` as fallback. Strict decoding maps configured models into the existing provider snapshot and reports authenticated readiness only from a healthy current catalog containing a configured native provider. Empty catalogs and non-ready probes leave authentication unknown. This does not verify live network access or expose credential data. Failed or late reads keep the last good list without letting it override probe health; discovery never creates a session.                                                                                                                                                                                                      |
| `cycleModel`, `cycleThinkingLevel`, `setScopedModels`                                                                                                      | Intentionally redundant                                               | Pylon already has an exact multi-client model picker. Prime's scoped list is memory-only and native cycling cannot atomically update Pylon's durable selection, so exposing both would create split-brain state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `setTransport`                                                                                                                                             | Intentionally excluded                                                | Transport is environment/provider plumbing owned by Pylon, not a per-thread user setting. Prime does not expose authoritative current transport in session state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `getSessionStats`                                                                                                                                          | Integrated                                                            | Only bounded context usage and finite reported turn-cost outcomes cross the boundary.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `compact`, `abortCompaction`, `setAutoCompactionEnabled`                                                                                                   | Integrated                                                            | Manual compaction is argument-free; summaries, instructions, paths, and native results are discarded. Automatic state is reconciled before publication. Prime suspends queued session input when compaction aborts the active run, including when compaction is declined, so the next prompt first performs the same exact-session queue resume used after Stop and fails before admission if that resume cannot be proved.                                                                                                                                                                                                                                                                                                                      |
| `refine({ global: false })`                                                                                                                                | Integrated                                                            | Explicit local-only refinement accepts no instructions or rollback identity. RPC success contains aggregate edit counts only. Timeout/rejection is outcome-unknown and is never retried.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `abortBranchSummary`                                                                                                                                       | Intentionally folded into Stop                                        | Pylon does not start a standalone native branch-summary operation; stopping the owning turn remains authoritative.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `setAutoRetryEnabled`, `abortRetry`                                                                                                                        | Deferred                                                              | Retry lifecycle is observed safely, but enabled state has no authoritative readback and the setter writes shared provider settings. Stop already cancels the owning turn. A distinct retry control needs truthful session state and receipts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `reload`, `getCommands`                                                                                                                                    | Integrated                                                            | Full-access sessions can reload while idle and show bounded safe command metadata. Before and after reload, Pylon verifies its generated source plus the managed extension path, marker, and exact plan-tool definition. Supervised sessions fail closed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `acquireSessionInputPause`                                                                                                                                 | Intentionally redundant                                               | Every Pylon prompt and resource reload is serialized by the per-thread adapter lock, and reload is admitted only while the owned session is idle. Pylon's scoped MCP server is attached before the first snapshot and released only after turn ownership ends, so it is never replaced during live input. Holding a native lease would add reconnect failure modes without fencing additional work. Revisit if Pylon supports live MCP configuration changes.                                                                                                                                                                                                                                                                                    |
| `supportsAcpMcpServers`, `replaceAcpMcpServers`, `releaseAcpMcpServers`                                                                                    | Integrated with scoped Pylon ownership                                | `McpProviderSession` is the single per-thread source of truth. Before the first daemon snapshot, Pylon replaces one `t3-code` HTTP server under the stable owner `pylon:<providerSessionId>` and fails closed if Prime cannot own it. After a daemon reconnect, Pylon reclaims that ownership before publishing the resynced session; if it cannot, the session closes instead of continuing without browser tools. Session teardown releases only that owner and server name before disposing the connection. ACP fallback sends the same scoped server in `session/new`. Browser-disabled sessions send nothing, and Prime-owned MCP settings and catalogs remain private.                                                                     |
| `getResourceSnapshot`                                                                                                                                      | Partially integrated by safe outcome                                  | Commands and safe skill/prompt metadata are decoded internally. Native paths, diagnostics, extensions, themes, packages, and MCP configuration are not sent to clients.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `respondToExtensionUiRequest`                                                                                                                              | Partially integrated by safe outcome                                  | Select, confirm, and input dialogs plus bounded notifications, status, and widgets are correlated without exposing native request envelopes. Submitted free-form input uses a transient provider RPC and is redacted from durable activities. Editor replacement is cancelled because its prefill may contain sensitive model or tool material that cannot safely enter Pylon's synchronized event stream.                                                                                                                                                                                                                                                                                                                                       |
| `getRlmChildSnapshots`, `getRlmMaxDepthStatus`, `setRlmMaxDepth`, `cancelRlmChild`, `sendAgentMessage`                                                     | Integrated                                                            | On 0.8.1 the authoritative roster atomically replaces Pylon's private cache after strict bounded decoding; older versions retain the event-derived roster. Canonical Pylon task IDs resolve through that private live roster. Messaging is ephemeral.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `watchSession`; watcher `subscribe`, `getMessages`, `close`                                                                                                | Integrated for bounded child live activity in ordinary sessions       | A short-lived watcher attaches only to an explicitly selected active descendant. Its `getMessages` supplies one bounded, sanitized committed-message snapshot with assistant text and a coarse safe-label tool skeleton, then watcher message and tool lifecycle events maintain active-only live activity until the watcher closes. Native tool IDs are immediately reduced to attachment-salted in-memory correlation digests; arguments, results, reasoning, paths, timestamps, metadata, and error text never cross the boundary. Strict correlated sessions reject this API before attachment because the same shared-client attachment would invalidate the root proof. This is distinct from, and does not enable, root transcript reads. |
| `getAgentMessageStatus`, `pauseAgentMessages`, `resumeAgentMessages`, `clearAgentMessages`                                                                 | Intentionally excluded                                                | These controls are daemon-global and can change or clear traffic belonging to unrelated sessions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `startSideQuestion`, `abortSideQuestion`                                                                                                                   | Integrated as constrained transient quick questions                   | Supervised, fresh sessions may run one bounded tool-free question through a requester-owned unary RPC. Pylon uses separate public/native IDs, returns only one temporary answer, requests one bounded abort on cancellation, timeout, or disconnect, and never retries or persists the prompt, answer, native errors, or lifecycle. Full-access extension hooks, restored sessions, ACP, follow-up transcripts, and reconnect recovery fail closed.                                                                                                                                                                                                                                                                                              |
| `getHeartbeat`, `setHeartbeat`, `updateHeartbeat`, `listHeartbeats`, `listCronJobs`, `addCronJob`, `cancelCronJob`, `manageHeartbeat`                      | Deferred on lifecycle ownership                                       | Scheduling promotes work to resident ownership, but public APIs do not provide Pylon an authoritative autonomous-turn/checkpoint identity, demotion, reattachment, or fail-safe delete flow. Shipping now could leave invisible mutations or orphaned work.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `getContextTree`                                                                                                                                           | Blocked by upstream execution safety                                  | Prime 0.8.1 synchronously follows and recursively scans unbounded `sub-*` directories before Pylon can decode or time out the result. Until Prime adds intrinsic symlink, cycle, depth, node, and byte bounds, Pylon uses bounded session stats and its own observed agent usage instead; native labels, IDs, model metadata, costs, and history remain private.                                                                                                                                                                                                                                                                                                                                                                                 |
| `getSessionContext`, `getSessionTree`, `getUserMessagesForForking`, `getLastAssistantText`                                                                 | Intentionally redundant/sensitive                                     | Pylon's event-sourced transcript and checkpoints are authoritative; mirroring Prime's private transcript/tree would create a second history source and expose hidden context.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `getSystemPrompt`                                                                                                                                          | Intentionally excluded                                                | Hidden instructions and prompt internals are never read for verification or copied across the provider boundary.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `getToolDefinition("pylon_update_plan")`                                                                                                                   | Integrated internally for one exact verifier                          | Pylon queries only its own managed tool by exact name, strictly decodes and compares the expected public definition, then discards the result. No other tool definition is queried or exposed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `listSavedSessions`, `newSession`, `switchSession`, `fork`, `importFromJsonl`, `exportToHtml`, `exportToJsonl`, `renameSavedSession`, `deleteSavedSession` | Deferred on history coordination                                      | Public DTOs are filesystem/path-shaped and can enumerate unrelated Prime history. Native history mutation must first coordinate atomically with Pylon threads, worktrees, and checkpoints.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `getState().leafId`, `navigateTree(leafId, { summarize: false })`                                                                                          | Integrated privately for exact checkpoint rollback                    | Only the pinned managed full-access daemon path can advertise absolute rollback. Pylon binds immutable checkpoint leaves to provider/runtime/session identity, fences input, quarantines native output, permits only the recorded source or target leaf, proves navigation by rereading `getState()`, and releases only after the committed target is exact. Leaf ids and native identities never cross the adapter-private persistence boundary. Missing methods, approval mode, active work, stale identity, or a third leaf fail closed.                                                                                                                                                                                                      |
| `setSessionName`, `setSessionEntryLabel`                                                                                                                   | Intentionally redundant                                               | Pylon thread titles and durable activities are the user-visible source of truth.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `executeBash`, `executeBashAndWait`, `abortBash`                                                                                                           | Intentionally redundant                                               | Pylon's terminal and an agent turn have separate ownership and audit semantics; a raw session bash tunnel would bypass both.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `waitForHeadlessCompletion({ waitForRlmQuiescence })`                                                                                                      | Integrated as an ordinary-turn barrier; autonomous ownership deferred | Daemon mode uses only the method's authoritative RLM ordering boundary after a Pylon-owned prompt and discards the autonomous-status result. This keeps descendants and their parent continuations inside the canonical Pylon turn without claiming native headless/resident turns. Those autonomous turns remain deferred until they have checkpoint identity, reattachment, stop, and deletion semantics. The valid boundary also supplies the cumulative usage delta used for terminal root, child, and continued-parent billing. ACP compatibility mode uses 0.8.1's terminal standard prompt boundary plus the correlated metadata, while retaining metadata-driven settlement for 0.8.0.                                                   |
| `getSessionHeader`                                                                                                                                         | Intentionally redundant/sensitive                                     | The header can repeat native saved-session identity and metadata. Pylon uses its private verified resume sidecar plus the durable thread projection instead of exposing or persisting a second header source.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `onBeforeSessionInvalidate`                                                                                                                                | Unavailable in daemon mode 0.8.1                                      | The public daemon implementation is a no-op returning only an unsubscribe function, so there is no lifecycle outcome to integrate. Pylon tears down its owned connection scope explicitly.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `promoteToResident`                                                                                                                                        | Intentionally excluded until automation ownership exists              | Client-owned workers must remain stoppable and reapable by their Pylon thread.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

Prime Agent 0.8.1 retains the goal-continuation and durable refinement-message changes as native session
behavior. Pylon continues to project only bounded goal state and aggregate refinement lifecycle; it does
not copy refinement diffs or native goal internals into the event store. Resource reload remains the
single idle, full-access operation that refreshes Prime-owned settings, authentication, MCP providers,
resources, runtime, and extensions before Pylon replaces its safe catalogs.

## Adapter boundary rules

These rules describe how the integrated outcomes above cross Pylon's provider boundary. The
[provider constraints](./providers.md#prime-agent) summarize the runtime selection they depend on.

### Sessions and model catalog

The client-visible continuation cursor stays an opaque marker; a server-private sidecar binds it to
the exact stable Prime transcript identity and verifies the saved file before cold resume. On POSIX
filesystems the thread session directory is owner-only, and its identity, managed-extension, and
native transcript files are protected before the session becomes usable.

Each ready rollback anchor binds one exact leaf to its checkpoint ref, object ID, turn ID, and source
revision, and a conflicting recapture cannot overwrite it. Cleanup releases the rollback quarantine
only after the public projection commit and a final exact-target proof.

A short-lived RPC probe bootstraps the qualified model catalog. After a compatible daemon session
attaches, the adapter reads the public catalog, filters it to configured providers, discards
sensitive native fields, and publishes a bounded last-good model overlay through the existing
provider snapshot stream. Once that overlay exists, provider health checks retain it without
repeating the RPC discovery probe or reporting a stale fallback warning. Cached models never
override a disabled, missing, or unhealthy probe's authentication state. The synthetic `default`
model means "do not force a model", while discovered model metadata drives generic thinking and
service-tier composer options. The ACP fallback snapshot strips daemon-only model options and
capabilities rather than rendering controls ACP would ignore.

### Background text generation

Background text generation is deliberately independent of both interactive backends. The
instance-bound factory resolves the configured executable through the instance's merged environment,
locates that exact installation's package-owned public ESM entry with the daemon bridge's safe
locator, and spawns a fresh Node helper with an explicit non-extending environment and cwd. The
bounded prompt and validated attachment-store image bytes travel over stdin; no prompt is placed in
argv. The helper uses only Prime's public session and resource-loader APIs. The selected home remains
explicit for credentials and models; the file-backed settings manager can read that home, but Pylon
calls only its provider, model, thinking-level, and service-tier default getters before copying those
values into an in-memory manager.

The child overrides Prime's SDK-global home with a separate scoped empty directory, so selected
continual harness entries cannot load. Prime Agent 0.8.1 still adds its fixed zero-entry harness
guidance; Pylon bounds and validates that exact empty block, adds an exact final isolation boundary,
and rejects nonzero entries or extra prompt text. That fixed block has real input-token overhead. The
helper disables tools and every optional resource, persistence, autonomous, retry, refinement,
compaction, kernel, MCP, and telemetry path. It permits one model request and proves the transcript
contains exactly one user and one assistant message with no tool content.

Named selectors split only at the first `/`, while `default` omits a model override. Thinking and
service-tier inheritance stay distinct from an explicit `default` tier; Prime may clamp inherited
values to the selected model's supported controls. The parent owns the exact child in an Effect scope
with a 180-second deadline, bounded output, and bounded TERM-to-KILL cleanup, then applies the shared
JSON extraction, schemas, and text sanitizers. Expected SDK, model, auth, quota, timeout, crash, and
output failures cross the boundary only as safe `TextGenerationError` details. Prime attempts ask the
provider registry to refresh capacity, so its volatile overlay and snapshot stream remain the only
usage publication path. Both daemon and ACP snapshots advertise versioned
`background-text-generation`; daemon snapshots add `side-questions` when that public API is present.

### Input queue and follow-ups

The daemon adapter can switch models before a turn, steer an active turn, admit explicit follow-ups,
choose all-at-once or one-at-a-time delivery independently for steering and follow-up inputs, clear
pending inputs, and remove the sole item in either lane without aborting current work. Only bounded
steering and follow-up counts and normalized delivery modes use the stable
`session.input-queue.updated` activity projection. Sole-item removal privately reads Prime's preview,
performs one compare-and-delete through an isolated non-recovering daemon client, closes that
connection so transport recovery cannot replay an ambiguous outcome, and then reconciles the
authoritative queue. These writes share the thread-mutation lock with lifecycle, reload, depth, and
agent-control mutations. The adapter closes the session only when authoritative queue reconciliation
also fails.

Follow-up text follows the normal durable user-message command path, so an admission failure leaves
the message in history with an explicit not-queued activity rather than deleting user intent.
Clearing pending native inputs likewise does not erase durable history. Queued native runs stay
inside one Pylon turn until the queue settles. Mobile's file-backed device outbox remains a separate
reliability layer.

### Supervised execution gate

Approval-required sessions materialize a server-owned, token-correlated Prime extension, disable
extension discovery, verify the generated source plus the loaded extension-sourced marker through
public resource APIs, set and verify RLM depth zero before prompt admission, reject slash-command
prompts that bypass tool hooks, and disable unverified daemon recovery so transport loss requires a
fresh verified session. Its blocking hooks map reviewable built-in edit, shell, and IPython requests
privately to canonical Pylon approval events; unknown tools and oversized inputs are denied rather
than incompletely presented. Native request IDs and policy tokens remain adapter-local. The gate fails
closed, but it is not an OS sandbox, so approved IPython and shell calls retain host access.

### Session state projections

Provider-exposed final reasoning is bounded into the shared work-log item shape; incremental deltas
and provider-private reasoning metadata are discarded. Public daemon session statistics are decoded
behind an identity check and reduced to the active context estimate, current model window, and exact
automatic-compaction setting. A typed provider-neutral clear barrier retracts stale meters while
Prime reports post-compaction context as unknown; aggregate retained-session counts and native
identity, path, percentage, and cost fields are not conflated with active context usage.

The adapter decodes Prime's RLM depth status into a stable provider-neutral session activity and
accepts only per-session depth writes from 0 through 4 while idle. Explicit session, global, and
`RLM_MAX_DEPTH` sources remain authoritative, and the setter never passes the global persistence
option. The settable-now flag also tracks native runs, bash, child agents, compaction, blocking
interactions, approvals, and resource reloads, so remote clients do not offer a write that would only
fail as busy. Supervised sessions remain policy-fixed at zero.

Compaction start and terminal events replace one provider-neutral lifecycle activity row; native
instructions, summaries, result details, token metadata, and error text are discarded before
canonical runtime mapping. A separate stable `session.compaction.updated` projection carries only
availability, `idle`/`starting`/`compacting`/`abort-requested` status, the authoritative
automatic-compaction boolean, abortability, writability, and idle-only manual settable state. Manual
compaction calls public `compact()` without instructions only after a state-only read confirms there
is no native run, bash action, queued action, child, approval, interaction, resource reload, or
compaction. The long native promise runs under the owned session scope while start and end events
and public state remain lifecycle authority. `abortCompaction()` marks only request acceptance until
terminal state arrives. `setAutoCompactionEnabled()` is exposed with scope
`session-and-provider-default` because Prime persists its provider-wide default. All three mutations
share the thread mutation lock, perform no automatic retry, reconcile once after rejection, and close
an ambiguous session. Supervised sessions and ACP publish unavailable control barriers.

Goal observation follows the same model: `session.goal.updated` stores only availability, active
state, normalized status, a bounded objective, token budget and usage, elapsed seconds, and
continuation count. Native goal IDs, timestamps, reasons, and errors terminate at the boundary.
Clients select the latest stable snapshot for the active provider instance, require the advertised
`goals.observe` capability and a live full-access runtime, and treat unavailable snapshots and
runtime or provider changes as clear barriers. Web, desktop, and mobile expose this state as a
read-only composer control, and Pylon reports goal mutations as unavailable rather than simulating
them. The same ingestion boundary drops compacted-state detail from other providers.

Finite non-negative `turn.completed.totalCostUsd` values become stable, turn-linked `turn.cost`
metadata activities. Clients exclude cost metadata from work logs and show the provider-reported
estimate only beside the terminal assistant message. Prime's retained-session statistics cost is never
treated as a lifetime or per-turn total. Retry and refinement events likewise cross the boundary only
as safe numeric lifecycle state; ingestion replaces stable provider-neutral rows and represents
partially applied refinements separately from total failure.

Explicit local harness refinement is an operate-scoped `provider.refineSessionHarness` RPC with only
`{ threadId }` on the wire. The runtime advertises it only when the public
`DaemonAgentConnection.refine` method is present, and invokes that method exactly once with
`{ global: false }`. Only new full-access daemon sessions are eligible: supervised, restored, ACP,
missing-method, and concurrent-refinement paths fail closed. The sanitized public method response is
authoritative for the RPC; public `refine_complete` and `refine_failed` events remain uncorrelated
observational rows, so automatic or agent-initiated refinement cannot satisfy a Pylon request. A
rejected or timed-out request is reported as outcome-unknown, never retried, and keeps the session
reservation closed to another refinement until teardown, because Prime may still apply it. Pylon
projects only `running`, `available`, or `outcome-unknown` on that session incarnation, so remounted
and remote clients share the same control barrier. Before refinement is available, Pylon creates the
derived native artifact and harness directories as owner-only; after confirmed success it also
protects known harness files as owner-readable and writable only. Stop, close, disposal, and provider
shutdown clear and fail the reservation.

### Agent control

Agent cancellation uses a provider-neutral, operate-scoped RPC keyed by the Pylon thread and the
already-projected opaque task ID. The adapter validates that ID against the thread's known active
descendant roster before calling public `cancelRlmChild`; it never accepts a native active-session
selector. Duplicate requests coalesce while the native terminal update is pending. Native
cancellation has a fixed deadline; `false`, a racing completion, a failed call, or a timed-out
response triggers one reconciliation against the latest decoded roster rather than a mutation retry,
and the session closes if that roster cannot restore authority.

Prime's public `getInitialSnapshot()` does not refetch live children, so the runtime seeds the private
roster from attach and resync snapshots and updates it synchronously from bounded child events before
exposing those events. A previously active child missing from an authoritative live-descendant
snapshot is settled, so clients cannot retain an uncontrollable working row. The first native terminal
child update is authoritative; later terminal repeats are ignored. Tool results containing native
child handles or session paths are replaced at the decoding boundary.

Native agent messaging is a separate operate-scoped RPC keyed by the same task ID. The adapter resolves
that ID through its private roster to a bounded native endpoint and invokes public `sendAgentMessage`
exactly once under the thread mutation lock. Only `delivered` or `queued` acceptance crosses back to
the initiating client; native receipt IDs, sender and target identities, timestamps, echoed text, and
delivery errors are discarded. Pylon persists no sent content or receipt activity, while Prime
necessarily retains the message in the child session's private transcript. Post-invocation failure is
reported as delivery uncertainty without an automatic retry. A provider-neutral `messageable`
boolean tells clients which live rows have an endpoint without exposing it. Web, desktop, and mobile
gate message and stop affordances on the active session's advertised agent operations.

### Tool lifecycle and live child activity

Main-thread tool lifecycle is durable orchestration activity, but its correlation and presentation
are provider-specific at ingestion: stable opaque IDs replace native item IDs, and start, update, and
completion upsert one row. Both daemon and ACP producers are reduced to fixed allowlisted labels before
persistence; arguments, progress text, results, paths, commands, native titles, IDs, and error text are
discarded. Other providers keep their existing event IDs, status, detail, and data behavior.

Live child activity is a separate read-scoped, non-orchestration stream. The client supplies a task ID
already present in the thread's active-agent projection, and the adapter resolves it only through its
private roster before calling public `watchSession`. Concurrent subscribers for the same child share
one reference-counted read-only native attachment, while revisions and lifetime quotas remain
subscriber-local. The existing `entries` field remains assistant-only for older clients;
timeline-aware clients read the additive `activity` field, which holds only non-empty assistant text or
a coarse tool row with a fixed safe label, subscriber-local numeric ID, and status. Known tool names map
to fixed labels (`ipython` and `functions.ipython` become **Code**) and unknown names become **Tool**.

Snapshot size, entry count, update count, lifetime characters, initialization events, and concurrent
watchers are hard-capped. Watcher events are sanitized before bounded initialization admission,
preserving the subscribe-before-read race without retaining native payloads. Duplicate snapshots are
suppressed and assistant event bursts are debounced. No runtime event or
orchestration activity is created, and durable child lifecycle projections discard native answer
previews, recaps, and errors, so neither SQLite nor clients without an open view receive the assistant
text. Stream finalizers close the shared watcher after its last owner leaves, or on WebSocket
cancellation, roster settlement, endpoint replacement, session stop, provider replacement, or scope
shutdown. Prime can attach only to a currently live child and exposes no atomic history cursor, so
capability and UI wording promise only **Live activity**, never a durable transcript.

### Quick questions

Quick questions use a separate operate-scoped unary RPC and never enter provider runtime ingestion or
orchestration. The per-WebSocket handler owns a Pylon request ID, while the adapter maps it to an
unguessable native ID and accepts only exact correlated terminal events. Prompt text, cumulative native
updates, errors, IDs, and lifecycle never cross into durable state or other clients. Questions and
answers have UTF-8 and character bounds, cumulative native traffic is capped, and at most one question
per thread plus a provider-wide concurrency limit can run for two minutes. Cancellation, timeout,
request interruption, disconnect, session replacement, and scope shutdown run one best-effort native
abort without retry. Because side agents inherit provider extension hooks even with `tools: []`, the
operation is admitted only in fresh supervised sessions, where discovery is disabled and Pylon's
verified permission extension cannot act on a tool-free response.

### Heartbeats

Heartbeat methods exist on the public daemon connection but are not advertised. A heartbeat can start
a native run without a dispatch identity that Pylon can map to an autonomous turn and filesystem
checkpoints, and `setHeartbeat` promotes a client-owned worker to resident ownership that the public
connection cannot inspect, demote, or terminate after clear. Pylon's reaper, thread deletion reactor,
and restart attachment model assume client-owned sessions, so shipping creation first would permit
invisible mutations or orphaned scheduled work. This is an integration lifecycle blocker, not a claim
that Prime lacks heartbeat CRUD.

## Outcomes not available from the Prime Agent 0.8.1 daemon connection

These are daemon-connection gaps rather than hidden Pylon omissions: unified login/logout/account
management, direct goal mutation, deterministic client child spawn, plan-mode
mutation, autonomous gate configuration, a native “retry now”, an attachable active-side-question
snapshot, normalized file-mutation/sandbox policy, and authoritative settings retrieval. Prime does
export local file-backed `AuthStorage` and `SettingsManager` SDK APIs, but they are not session daemon
methods and require separate ownership, locking, callback, and reload design before Pylon can expose
them safely.

Returning model choice to Prime's own default belongs on that list. `setModel` demands an explicit
provider and id, and `AgentConnectionModelCatalog` carries only `models` and `configuredProviders`,
so a session that has already run on a named model cannot be handed back to Prime's default. Pylon's
**Prime Agent Default** selection is therefore honored when a session starts and refused mid-session,
rather than leaving a thread on its previous model behind a default label. Revisit when Prime
publishes either a session method that restores its own default or an authoritative default id in the
catalog: either one makes this a real selection, so probe for the capability and apply it in
`applyTurnSelection`'s caller instead of failing.

When Prime adds a public, reconnect-safe outcome, Pylon should add a capability probe and a typed
provider-neutral vertical rather than sending raw daemon commands across the client boundary.

## Opt-in real-daemon verification

The normal suite uses strict fake bridges. To verify a complete native turn against an installed release, provide an executable and a Prime home whose `auth.json` and `settings.json` may be copied read-only into the scoped test home:

```bash
PYLON_REAL_PRIME_AGENT=/absolute/path/to/prime-agent \
PYLON_REAL_PRIME_AGENT_AUTH_HOME=/absolute/path/to/prime-agent-home \
  vp test run apps/server/src/provider/prime/PrimeAgentRealDaemon.integration.test.ts
```

The test uses scoped temporary state, agent-home, session, and socket directories, and copies nothing back into the source Prime home. It does not leave the machine untouched: as of 0.8.0 the daemon records its supervisor ownership in the user-global registry described above, so a run creates and removes one owner entry under `~/.prime/supervisor-owners` regardless of the scoped agent home. It continuously consumes all bounded event streams, runs one exact-answer turn and one event-synchronized cancellation concurrently, forces a client-only transport fault during root tool work and verifies the original prompt completes without replay, exercises catalog/model selection, disposes all sessions, restarts the manager, resumes the exact native identity and history, and verifies socket cleanup. The prompts may consume subscription allowance or incur provider charges, so the test remains opt-in.
