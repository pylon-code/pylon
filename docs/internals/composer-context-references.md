# Composer context references

A message keeps readable prose and typed context separately. Inline references preserve where
context belongs in the instruction; records retain its payload through persistence, copying,
queueing, and draft restoration. Attachment bytes remain on Pylon's existing asset path.

## Identity and persistence

[`composerContext.ts`](../../packages/contracts/src/composerContext.ts) defines versioned records
keyed by `contextId` in `message.context.records`. A reference uses
`[label](t3-context://v1/<kind>/<contextId>)`; image references may use Markdown image syntax.
The label is presentation, never identity. Multiple occurrences may point to one record.
Editor occurrence IDs are local and are regenerated when canonical Markdown is parsed again.

An image or file record binds to a `ChatAttachmentId`. Upload normalization rewrites that binding
to the persisted attachment without changing the context ID or prose. Records contain no bytes
and do not grant asset access. Reads, clipboard downloads, and previews still require the source
environment's authenticated asset path.

`projection_thread_messages.context_json` preserves the record set. Event history is not rewritten.
Commands, queued compaction messages, optimistic rows, and replay must carry context together with
text and attachments; losing just the records leaves otherwise valid references unresolved.
Pylon's source revisions, provider incarnation fences, and durable compaction ownership remain
authoritative over when the message can be delivered.

Unknown record kinds retain their payload for forward compatibility. A malformed known kind cannot
fall through the unknown-kind schema. A bad record can be dropped without making the whole message
undecodable; a reference with no usable record remains visibly unresolved.

## Provider and older-client boundaries

The persisted text contains canonical references. At provider dispatch,
[`projectComposerContextForProvider`](../../packages/shared/src/composerContextReferences.ts)
replaces references with readable markers and appends one context entry per referenced record.
Captured text is escaped so a terminal excerpt or review comment cannot forge the envelope.
Attachment bytes still use the provider's attachment channel; unreferenced image inventory is
retained there. Messages without references keep their original text.

A server advertises `inlineMessageContext` only when it can persist and project records. Clients
connected to an older server must serialize the legacy context form, since that server would drop
unknown record fields and forward raw reference links. This capability decision belongs to the
destination environment, including an offline message that is later delivered after reconnect.

[`composerContextLegacy.ts`](../../packages/shared/src/composerContextLegacy.ts) upgrades older
trailing terminal, element, annotation, and review blocks in memory. Deterministic context IDs make
the conversion repeatable. Old messages and drafts remain readable without rewriting their history.

## Draft and clipboard ownership

Context enters at the mounted composer's caret, with append as the fallback when no editor is
mounted. Deleting an occurrence removes only that reference. A file whose final reference disappears
is removed from the draft; images retain their thumbnail inventory until explicitly removed.
Removing a referenced image requires confirmation before both the inventory entry and its references
are removed.

Structured clipboard fragments contain records and source environment/thread/message identity,
not bytes or arbitrary asset URLs. The destination resolves the registered source environment,
fetches the attachment through its asset API, and attaches a fresh local copy. The new binding and
reference must agree. A failed or stale asynchronous import leaves an unresolved reference and
must not mutate a replacement draft, sent message, or different active thread.

Prompt stash and exact rewind restoration preserve context with its text and attachment bindings.
Rewind restores fresh attachment copies only after the matching durable source/target result;
an unsent draft remains intact. Pylon's ordinary ArrowUp prompt recall deliberately restores only
typed text. These paths must not be collapsed into one generic text-copy operation.

## Preview isolation

Attached documents reuse the workspace file viewer, while the asset API remains responsible for
ownership and bounded reads. Web HTML previews run in a sandbox without same-origin privileges.
Desktop permits frames from Blob URLs and configured runtime network schemes while retaining its
renderer script policy. A preview document must never gain the Pylon renderer's origin or session.
