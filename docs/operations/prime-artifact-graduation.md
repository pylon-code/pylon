# Prime artifact graduation

Use this runbook to decide whether one exact public Pylon Prime preview is eligible for a later stable
promotion. This gate is read-only. It does not publish, promote, tag, release, or dispatch the Prime
stable workflow.

## One-time repository configuration

Create the GitHub environment **`prime-graduation`** in `pylon-code/pylon` with:

- required reviewers from the Pylon maintainer team;
- deployment branches limited to the protected Pylon product branch or an approved task branch;
- no environment secrets and no environment variables.

The workflow uses only public GitHub release, GitHub attestation, Git source, Sigstore trust-root, and upstream stock-release
material. Its job token has `contents: read` only. Model credentials are neither configured nor
accepted; runtime proofs use a bounded faux backend.

## Run the protected gate

1. Open **Actions → Prime artifact graduation → Run workflow**.
2. Enter `preview_tag` as the complete immutable tag, for example
   `pylon-build-g0123456789ab-r1`. Never use a branch, release list position, or `latest` URL.
3. Leave `stock_version` at `0.8.1` unless the stock compatibility baseline is deliberately reviewed.
4. Optionally enter a later immutable `second_preview_tag`. With it, the gate proves a real staged update
   and rollback. Without it, the gate requires an exact signed update no-op and explicit same-build
   rollback.
5. Approve the `prime-graduation` environment deployment after checking the requested tags.

The job downloads every release asset, manifest, attestation response, source commit/tree receipt,
signer workflow, and stock tarball into `RUNNER_TEMP`. It verifies the preview with the server-owned
Sigstore and frozen source-policy implementation before a preview archive is parsed, extracted, imported,
or executed. The production managed tool store then installs the bundled CLI without a package manager or
lifecycle script.

The enforced cases cover stock and signed-preview bridge capability, side-by-side installation, real
start/use, update or exact no-op, rollback, stock switch-back, unchanged stock bytes, receipt-owned-only
cleanup, repeated Pylon restart/crash receipt recovery, and native multiple-instance evidence. The native
multi result remains evidence only; it does not enable `supportsMultipleInstances` because the distinct
account, package-root, catalog, capacity, MCP, checkpoint, macOS, Linux, and WSL2 requirements remain
separate.

## Evidence and stable approval

A successful job uploads only bounded JSON with public tags, source identities, artifact digests, case
names, and aggregate test counts. It never uploads packages, executables, managed roots, provider homes,
credentials, tokens, PIDs, sockets, or raw test output. The gate rejects skipped proof tests.

Copy the complete GitHub Actions run URL from the job summary into the Prime stable-promotion approval.
**Do not approve the Prime stable environment without that successful run URL for the exact preview tag.**
A successful Pylon run is evidence for a later human promotion decision; it is not promotion authority.

On failure, do not retry with a mutable URL, relaxed verifier, injected acceptance hook, skipped test, or
lifecycle-enabled install. Fix or republish a new immutable preview and run the protected gate again.
