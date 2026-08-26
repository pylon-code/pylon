# Model manifest publishing

Pylon uses a small public manifest to decide which Codex and Claude models appear in the model picker's legacy section. The product repository remains the source of truth. The public releases repository is only a mirror.

## Locations

- Source: `apps/server/src/provider/model-manifest.json` in `pylon-code/pylon`.
- Public mirror: `model-manifest.json` on the `main` branch of `pylon-code/pylon-releases`.
- Runtime URL: `https://raw.githubusercontent.com/pylon-code/pylon-releases/main/model-manifest.json`.
- Publisher: `.github/workflows/publish-model-manifest.yml`.

The manifest contains schema version `1` and a map from provider driver kind to current model slugs. A built-in model is legacy when its driver has a manifest entry and its slug is absent from that list. Providers with no entry are not classified. Custom models are never classified.

## Publish an update

1. Edit the source manifest on a task branch in `pylon-code/pylon`.
2. Run `vp test run apps/server/src/provider/ModelManifest.test.ts` and the server typecheck.
3. Open and merge a PR against `pylon`.
4. Confirm the **Publish model manifest** workflow succeeds.
5. Verify the public repository at its exact `main` commit, then compare the JSON value with the source:

   ```bash
   public_sha="$(gh api repos/pylon-code/pylon-releases/commits/main --jq .sha)"
   gh api "repos/pylon-code/pylon-releases/contents/model-manifest.json?ref=$public_sha" --jq .content | base64 --decode | jq -S . > /tmp/public-model-manifest.json
   jq -S . apps/server/src/provider/model-manifest.json > /tmp/source-model-manifest.json
   diff -u /tmp/source-model-manifest.json /tmp/public-model-manifest.json
   ```

The branch-based raw URL can remain cached for up to five minutes after publication. The commit-pinned check above is the authoritative immediate verification.

The workflow fetches only the source manifest blob at the exact merged `pylon` commit that triggered it. Before any release credential is exposed, it confirms that commit is still the current `pylon` head; delayed or rerun older revisions exit without publishing. Runs are serialized so an older revision cannot overwrite a newer mirror. The protected `pylon` branch requires a PR and rejects administrator bypass, force pushes, and deletion. The workflow validates a strict size-bounded schema and constructs a new allowlisted public object instead of copying arbitrary source fields. Its public commit message is the generic `chore: update model manifest`; it does not publish a private source commit, branch name, or commit history.

The public `main` branch rejects force pushes and deletion, including from administrators. Normal fast-forward publication remains enabled for the release bot. A dedicated manifest-only credential would reduce the impact of a future publisher-token compromise; until one exists, keep `RELEASES_REPO_TOKEN` fine-grained and limited to `pylon-code/pylon-releases` contents.

## Retry a failed publication

First fix the cause. The most common setup failure is a missing or expired `RELEASES_REPO_TOKEN` secret with write access to `pylon-code/pylon-releases`. Then rerun the failed trusted `pylon` workflow revision:

```bash
run_id="$(gh run list --repo pylon-code/pylon --workflow publish-model-manifest.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
gh run rerun "$run_id" --repo pylon-code/pylon
```

Rerunning the latest trusted `pylon` revision also covers manual recovery when the previous run succeeded but the public repository needs reconciliation. An older revision exits as superseded instead of rolling the public mirror back. Do not add an unrestricted manual-dispatch path that could expose the cross-repository credential to a branch workflow.

Do not change the runtime URL to the private product repository. Unauthenticated clients cannot depend on private source access.

## Roll back a bad classification

Revert or correct the source manifest through a Pylon PR, then let the publisher mirror that change. Use a direct edit in the public repository only to contain an urgent incident. If you do, make the same correction in the source manifest immediately so the next publication does not restore the bad data.

A fetch failure is not an availability incident by itself. Servers keep the last valid disk cache, then fall back to the bundled manifest. Malformed payloads and unsupported schema versions are ignored. When **provider update checks** are disabled, Pylon does not fetch the public manifest.
