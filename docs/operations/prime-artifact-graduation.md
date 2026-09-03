# Prime artifact graduation

Use this runbook to decide whether one exact public Pylon Prime preview is eligible for a later stable
promotion. This gate is read-only. It does not publish, promote, tag, release, or dispatch the Prime
stable workflow.

## Required repository configuration

The GitHub environment **`prime-graduation`** in `pylon-code/pylon` currently requires this exact
repository-owned configuration:

- required reviewer `rynfar`;
- `prevent_self_review: false`;
- `can_admins_bypass: false`;
- deployment branches limited to protected branches, with no custom branch policies;
- zero environment secrets and zero environment variables.

The workflow only names the environment. It does not create, repair, or verify this GitHub-hosted
configuration. An authorized maintainer must read it back before every dispatch:

```bash
gh api repos/pylon-code/pylon/environments/prime-graduation \
  --jq '{name, protection_rules, deployment_branch_policy, can_admins_bypass}'
gh api repos/pylon-code/pylon/environments/prime-graduation/secrets --jq '.total_count'
gh api repos/pylon-code/pylon/environments/prime-graduation/variables --jq '.total_count'
```

Do not dispatch unless the first response matches every setting above and both counts are `0`. The job
token itself has `contents: read` only. Model credentials are neither configured nor accepted; runtime
proofs use a bounded faux backend.

## Run the protected gate

1. Complete the environment readback above.
2. Open **Actions → Prime artifact graduation → Run workflow**.
3. Enter `preview_tag` as the complete immutable tag, for example
   `pylon-build-g0123456789ab-r1`. Never use a branch, release list position, or `latest` URL.
4. Optionally enter a later immutable `second_preview_tag`. With it, the gate installs, selects, loads,
   and executes the exact second launcher before rollback. Without it, the gate requires an exact signed
   update no-op and explicit same-build rollback.
5. Approve the `prime-graduation` environment deployment after checking the requested tags.

The stock compatibility fixture is not a workflow input. Pylon source freezes stock Prime Agent 0.8.1
to upstream repository id `1232493406`, release id `376894763`, asset id `530304956`, the exact public
asset URL and size `9616163`, SHA-256
`46c24db1782dd31adc35d5c6cbcc75564faba6ced3bf2ccf03d836ee77134475`, and SHA-512
`28ce7328c386d6d54261ba6a7bebe3cd420bf6f625ed6cb6a9fae6ca4815988c767b8f3f0ff3d3a95037ab566a17e074b181039a3da2ec929f4c6712ba51931d`.
The upstream release is not immutable. Its live metadata and optional GitHub digest are only identity
checks and cross-checks; the independently frozen size and two byte digests are the trust root.

The job downloads every preview release asset, manifest, attestation response, source commit/tree
receipt, signer workflow, and the frozen stock tarball into `RUNNER_TEMP`. It verifies the stock
repository, release, asset identity, size, and both byte digests before install or import. It verifies
the preview with the server-owned Sigstore and frozen source policy before a preview archive is parsed,
extracted, imported, or executed. The production managed tool store then installs the bundled CLI
without a package manager or lifecycle script.

The cases cover stock and signed-preview bridge capability, side-by-side installation, real start/use,
update or exact no-op, rollback, stock switch-back, unchanged stock bytes, receipt-owned-only cleanup,
repeated Pylon restart/crash receipt recovery, and native multiple-instance evidence. The native multi
result remains evidence only. It does not enable `supportsMultipleInstances` because the distinct
account, package-root, catalog, capacity, MCP, checkpoint, macOS, Linux, and WSL2 requirements remain
separate.

## Evidence and stable approval

A successful job uploads only bounded JSON with public tags, source identities, artifact digests, case
names, and aggregate test counts. It never uploads packages, executables, managed roots, provider homes,
credentials, tokens, PIDs, sockets, or raw test output. The gate rejects skipped proof tests.

Copy the complete GitHub Actions run URL from the job summary into the Prime stable-promotion approval.
**Do not approve the Prime stable environment without that successful run URL for the exact preview tag.**
A successful Pylon run is evidence for a later human promotion decision. It is not promotion authority.

On failure, do not retry with a mutable URL, relaxed verifier, injected acceptance hook, skipped test, or
lifecycle-enabled install. Fix or republish a new immutable preview and run the protected gate again.
