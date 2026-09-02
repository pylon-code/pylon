# Prime Agent distribution verification

Pylon verifies Prime distribution identity at the provider boundary. It does not use distribution
identity to select the daemon SDK, infer capabilities, or suppress ACP fallback. Runtime negotiation
continues to resolve and import the exact configured package and then negotiates post-attach
capabilities.

## Publication contract

The verifier freezes the protected-publication schemas from `pylon-code/prime-agent` PR #42 at
publication head `f4d9ef03b529faf2e07031c8b7cd703363316ae5` (tree
`b9a14b389aa64f54527008fb4d6119a7c57c2b58`):

- `pylon-prime-agent-release-v1.json` binds the four deterministic package assets, full source commit
  and tree, recipe revision 1, Node 22.23.2, npm 11.10.1, lockfile digest, and root package identity.
- `pylon-preview-channel-v1.json` binds the build manifest, preview workflow policy revision, workflow
  run, sequence epoch 1, and monotonic run-number sequence.
- `pylon-stable-channel-v1.json` binds an exact preview, stable sequence/history link, protected policy
  commit/tree, promotion or withdrawal, and cumulative revocations.

Unknown recipes, policy revisions, fields, assets, or tag shapes fail closed. The policy registry pins
both publication workflow byte digests. A publication workflow change therefore needs a new reviewed
policy revision rather than a permissive parser change.

The server uses `@sigstore/bundle`, `@sigstore/core`, `@sigstore/tuf`, and `@sigstore/verify` directly.
It requires a current Sigstore bundle with an inclusion proof, one verified Rekor timestamp, one
verified certificate-transparency timestamp, the GitHub OIDC issuer, and these exact certificate and
SLSA bindings:

- repository `pylon-code/prime-agent` and `refs/heads/pylon`;
- preview or stable signer workflow and its exact signer digest;
- GitHub-hosted runner, canonical repository id, event, run and attempt;
- source commit, full signed source tree in the manifests, and the exact six preview subjects;
- one stable-manifest subject for stable promotion.

The fetch and trusted-root functions are injected. Production keeps Sigstore TUF cache data below the
Pylon runtime state directory rather than writing to an unrelated user cache. Focused tests use
deterministic manifests and a cryptographic-verifier seam, then exercise certificate and SLSA binding separately. Bridge CI can
supply the first immutable artifact set through the fail-closed real-fixture gate. The gate has no
skip or metadata-only success mode.

## Private managed state

Distribution state is scoped by a SHA-256 hash of the provider instance id below:

```text
<stateDir>/provider-state/prime-agent-distribution/<instance-hash>/
  receipt-auth-v1.key
  managed-receipt-v1.json
  channel-high-water-v1.json   # appears after a newer signed build is observed
```

The directory is current-user `0700`. Each file is current-user `0600`. Reads use `O_NOFOLLOW`, a
bounded exact read, descriptor/path identity checks, and before/after metadata checks. The 32-byte
private key authenticates canonical receipt and high-water JSON with HMAC-SHA-256. A receipt binds:

- build id and preview/stable channel;
- sequence epoch and channel sequence;
- source commit and tree;
- recipe revision;
- root package asset name and SHA-256;
- the canonical selected package root.

The status path never creates a managed install receipt. The module exposes an exclusive receipt
persistence function for a future managed installer, and that function accepts the verified
publication result and refuses to replace existing state. It creates the private directory and files
with no replacement only after the exact package metadata matches the verified build. This slice has
no installer caller. The status path can atomically advance the adjacent high-water after a newer
exact signed sequence verifies. It writes an owner-only temporary, fsyncs it, renames it inside the
private directory, and fsyncs the directory. Neither path mutates the selected package.

A lower sequence or a different build at the same sequence is a replay. It cannot replace the local
high-water. If the feed is offline, rate-limited, malformed, or replayed, the authenticated installed
receipt and prior advisory remain usable.

## Classification and clients

The provider snapshot carries one optional, provider-neutral `distribution` record. Prime emits one
of four classifications:

- `stock-or-custom`: no Pylon distribution claim;
- `pylon-unmanaged`: Pylon metadata without a matching managed receipt;
- `pylon-managed`: exact package metadata and package root match an authenticated receipt;
- `invalid-receipt`: private state exists but fails authentication, mode, no-follow, binding, or
  high-water validation.

Classification never changes provider readiness. Only `pylon-managed` can receive a signed build
advisory. Advisory order comes from channel sequence and build ID, never SemVer. The existing optional
version-advisory UI receives that already-decided status only to reuse its provider-neutral update
marker; it never compares the values. Settings also shows the distribution label. Web and desktop use
that shared view. Mobile receives the same optional contract and continues to operate the provider,
but currently has no provider-management detail surface.

Stock Prime Agent 0.8.1 remains ready and manually maintained. Linux and macOS use private receipts;
WSL2 follows Linux. Native Windows and `.cmd` receipt admission are explicitly unavailable until Prime
supports native Windows distributions.

## Scope boundary

This verifier fetches only bounded public manifests, attestation bundles, and trust material for proof
and advisory. It has no download-to-install, package install, switch, update, cleanup, or removal path.
It does not generalize Prime feed semantics to Codex, Claude, Cursor, Grok, OpenCode, or Comet.
