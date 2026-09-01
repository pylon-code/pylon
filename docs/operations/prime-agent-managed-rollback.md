# Prime Agent managed rollback

Use this runbook when a Pylon-managed Prime build is unhealthy and an environment must select a
previously verified build or return to its stock/configured Prime binary.

## Safety rules

- Do not edit `managed-tool-state-v1.json`, provider settings, build markers, or receipts by hand.
- Do not replace a build directory or `.bin/prime-agent` link in place.
- Do not delete a build until no provider selection or scheduled switch references it.
- Do not stop a user turn for maintenance. Let the exact provider instance drain.
- Do not run npm, pnpm, yarn, bun, or Homebrew against a managed build path.

The server command owns the provider fence, complete-binding compare-and-set, selection journal, and
provider refresh. Manual file or settings changes bypass those guarantees.

## Roll back to a verified build

1. Open **Settings → Providers** and select the affected environment and Prime Agent instance.
2. Read the **Pylon-managed Prime** status. Record the selected build id, channel, sequence, operation
   message, and any scheduled command.
3. Under **Verified rollback builds**, choose **Roll back** on the intended build.
4. If Pylon reports **waiting for quiescence**, leave the command scheduled. Confirm that no new work
   is started on that instance and wait for its current admission, turn, session, daemon, and loaded
   runtime context to exit.
5. Confirm the status changes to **succeeded** and the chosen build shows **Selected**.
6. Start a new Prime thread and verify provider readiness. Existing work must not be used as a
   maintenance probe.

A rollback selects an already installed build whose marker and private #193 receipt validate offline.
It does not lower the signed channel high-water. A missing build is not downloaded implicitly.

## Return to stock/configured Prime

1. Choose **Use stock/configured Prime** for the affected instance.
2. Wait for quiescence if scheduled.
3. Confirm the status says the instance uses its stock or configured binary.
4. Verify that the configured stock installation still works outside Pylon if the incident requires
   that check.

This action restores the binary path captured before the first managed selection. It does not install,
upgrade, rewrite, or remove stock bytes.

## Cleanup after recovery

Use **Prune unreferenced builds** only after the desired selection is healthy. Cleanup validates
ownership again and removes only unreferenced receipt-owned build directories. A selected build or a
build referenced by a scheduled switch is retained. Unknown, linked, partial, or invalid-receipt paths
are not cleanup authority and need separate investigation.

## Failure and crash recovery

- **Feed offline, rate limited, or invalid:** Keep the current verified build. Do not infer update
  availability from SemVer or a package registry.
- **Replay or implicit downgrade rejected:** Do not clear high-water state. Use explicit rollback to an
  installed verified build, or investigate the signed channel publication.
- **Interrupted staging:** Restart the Pylon server. Startup removes exact unmarked staging and
  incomplete build directories without changing the selected binding.
- **Interrupted around selection:** Restart the Pylon server or reopen maintenance status. The durable
  selection intent reconciles whether the complete settings CAS occurred and records a terminal
  receipt.
- **Binding changed or command superseded:** Re-read Provider Settings. A user or another client chose
  a newer binding. Submit a new command only after confirming the intended target.
- **Invalid receipt or marker:** Do not select or delete the directory manually. Preserve it for
  diagnosis and choose a different verified build or stock.
- **Native Windows:** No managed I/O should have started. Run Pylon and Prime Agent inside WSL2 and
  operate on that Linux environment.

For server-side diagnosis, correlate the maintenance error and trace id with the selected environment.
The managed store is below that environment's runtime `userdata/provider-tools/prime-agent/` path.
Read it only for incident evidence; use the RPC/UI commands for changes.
