# Prime Agent managed installation

Pylon's Prime managed tool store is an opt-in server-owned layer on top of the signed distribution
verifier. Stock or configured Prime remains the default. The store never writes a global package
manager or binary installation.

## Layout and ownership

Managed data lives under the environment runtime state directory:

```text
userdata/provider-tools/prime-agent/
  managed-tool-state-v1.json
  <buildId>/
    pylon-managed-build-v1.json
    .pylon-managed-receipt/
    prefix/node_modules/prime-agent/
    prefix/node_modules/.bin/prime-agent
```

A build directory is immutable after promotion. Its build id is the signed content identity, not a
SemVer choice. The build marker binds the package root, POSIX launcher, channel sequence, and root
artifact digest. The adjacent #193 receipt independently authenticates ownership and the exact package
root. Rollback and cleanup revalidate both offline before trusting a directory.

The installer downloads the exact manifests, attestations, and root tarball through the #193 loader.
It verifies provenance and the root digest before parsing any archive header. Extraction uses a
bounded no-follow tar reader. It rejects absolute and traversing paths, Unicode and case collisions,
duplicates, links, devices, extensions, privileged modes, excess entries or bytes, the wrong package
or bin identity, and unexpected lifecycle scripts.

The published root contains the bundled CLI. Pylon constructs the private `node_modules` package and
relative `.bin/prime-agent` link directly from the verified extracted tree. It does not invoke a
package manager, resolve a registry dependency, execute `postinstall`, or run artifact bytes during
installation. Staging directories are fsynced and renamed to the final build id only after launcher
validation. Startup removes exact unmarked staging or incomplete directories; marked builds require
receipt-owned cleanup.

## Selection transaction

Selection changes only the target Prime provider instance's complete settings binding. The server:

1. reads the binary path and opaque binding generation;
2. fences new session starts for that instance;
3. inventories pending starts, admissions, active turns, adapter sessions, owned daemons/runtime
   sessions, and loaded session incarnations;
4. returns a durable scheduled receipt when any exact owner is active;
5. writes and fsyncs a selection intent journal;
6. compare-and-sets the complete expected binding to the new launcher while the fence is held;
7. records the returned binding and selected build, then clears the intent and schedule;
8. releases the fence and refreshes the provider instance.

The intent closes the crash window around settings CAS. Recovery reads the observed binding. If it is
the exact target, recovery records the completed selection. If it is still the complete expected
binding, recovery records an interrupted pre-switch failure. A different binding is treated as a
superseding user/settings change. A later explicit command supersedes an older scheduled command and
marks its receipt terminal rather than leaving two apparent pending switches.

Distinct package roots and quiescent switching prevent a daemon from one build from sharing an
imported SDK module cache from another. Runtime capability still comes only from frozen SDK metadata
and exact post-attach negotiation. Managed distribution identity does not enable a native mode.

## Commands and clients

`serverGetPrimeManagedMaintenance` is read-scoped. `serverRunPrimeManagedMaintenance` is
operate-scoped. Both target one environment and provider instance, so local, remote, relay, tunnel,
multi-environment, and multi-client paths share the same server serialization and receipts. Command
ids are idempotent: reusing one with different input fails. Actions are install, update, rollback,
use-stock, and cleanup. Preview additionally requires `channel: preview` plus `allowPreview: true`.

Web and desktop Provider Settings expose status, signed stable and explicit-preview actions, progress
and terminal errors, exact rollback builds, switch-back, and cleanup. Mobile reads status for every
Prime instance on each connected environment and directs host changes to web or desktop Provider
Settings. Native Windows returns WSL2 guidance before filesystem, network, provider, or runtime I/O.

## Replay, offline, and cleanup rules

Each channel has a persisted signed high-water `(sequenceEpoch, sequence, buildId)`. Lower sequences
and a different build at the same sequence fail. Rollback is allowed only as an explicit selection of
an already installed receipt-owned build; it does not lower the channel high-water. An offline feed
cannot change the selected build and is reported as a failure.

Cleanup computes references from managed selections and scheduled switches. It ignores unrecognized,
linked, incomplete, or invalid-receipt directories and removes only an unreferenced build that passes
full offline marker and receipt validation.
