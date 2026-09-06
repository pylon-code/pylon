# Model manifest publishing

Pylon uses a small public manifest to decide which Codex and Claude models appear in the model picker's legacy section. The product repository remains the source of truth. The public releases repository is only a mirror.

## Locations

- Source: `apps/server/src/provider/model-manifest.json` in `pylon-code/pylon`.
- Public catalog: `model-catalog.json` on the `main` branch of `pylon-code/pylon-releases`.
- Compatibility feed: `model-manifest.json` on the same branch, containing only `version` and `currentModels`.
- Runtime URL: `https://raw.githubusercontent.com/pylon-code/pylon-releases/main/model-catalog.json`. Older releases continue fetching the compatibility feed.
- Publisher: `.github/workflows/publish-model-manifest.yml`.

The catalog contains schema version `1`, current model slugs, and optional provider catalogs. The compatibility feed omits provider catalogs because older releases reject unknown fields. A built-in model is legacy when its driver has a manifest entry and its slug is absent from that list. Providers with no entry are not classified. Custom models are never classified.

## Publish an update

1. Edit the source manifest on a task branch in `pylon-code/pylon`.
2. Run `vp test run apps/server/src/provider/ModelManifest.test.ts apps/server/src/provider/modelManifestPublication.test.ts` and the server typecheck.
3. Open and merge a PR against `pylon`.
4. Confirm the **Publish model manifest** workflow succeeds.
5. Generate both expected files and compare their JSON values with the public repository at its exact `main` commit:

   ```bash
   public_sha="$(gh api repos/pylon-code/pylon-releases/commits/main --jq .sha)"
   node apps/server/scripts/prepare-model-manifests.ts /tmp/pylon-expected-model-manifests
   for manifest_file in model-manifest.json model-catalog.json; do
     gh api "repos/pylon-code/pylon-releases/contents/$manifest_file?ref=$public_sha" --jq .content | base64 --decode | jq -S . > "/tmp/public-$manifest_file"
     jq -S . "/tmp/pylon-expected-model-manifests/$manifest_file" > "/tmp/source-$manifest_file"
     diff -u "/tmp/source-$manifest_file" "/tmp/public-$manifest_file"
   done
   ```

The branch-based raw URL can remain cached for up to five minutes after publication. The commit-pinned check above is the authoritative immediate verification.

The workflow checks out the exact merged `pylon` revision that triggered it without persisting checkout credentials. Before accessing the release credential, it installs the pinned dependencies, validates the source with the server's manifest decoder, prepares both size-bounded public files, and confirms that the source commit is still the current `pylon` head. Delayed or rerun older revisions exit without publishing. Runs are serialized, and both files publish in one public commit. The protected `pylon` branch requires a PR and rejects administrator bypass, force pushes, and deletion. Public output is constructed from the allowlisted `version`, `currentModels`, and `providers` fields. Its generic commit message does not include source commit or branch metadata.

The public `main` branch rejects force pushes and deletion, including from administrators. Normal fast-forward publication remains enabled for the release bot. A dedicated manifest-only credential would reduce the impact of a future publisher-token compromise; until one exists, keep `RELEASES_REPO_TOKEN` fine-grained and limited to `pylon-code/pylon-releases` contents.

## Retry a failed publication

First fix the cause. The most common setup failure is a missing or expired `RELEASES_REPO_TOKEN` secret with write access to `pylon-code/pylon-releases`. Then rerun the failed trusted `pylon` workflow revision:

```bash
run_id="$(gh run list --repo pylon-code/pylon --workflow publish-model-manifest.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
gh run rerun "$run_id" --repo pylon-code/pylon
```

Rerunning the latest trusted `pylon` revision also covers manual recovery when the previous run succeeded but the public repository needs reconciliation. An older revision exits as superseded instead of rolling the public mirror back. Do not add an unrestricted manual-dispatch path that could expose the cross-repository credential to a branch workflow.

Keep runtime feeds in the public releases repository so installed clients have a stable, unauthenticated endpoint independent of product repository access.

## Roll back a bad classification

Revert or correct the source manifest through a Pylon PR, then let the publisher mirror that change. Use a direct edit in the public repository only to contain an urgent incident. If you do, make the same correction in the source manifest immediately so the next publication does not restore the bad data.

A fetch failure is not an availability incident by itself. Servers keep the last valid disk cache, then fall back to the bundled manifest. Malformed payloads and unsupported schema versions are ignored. When **provider update checks** are disabled, Pylon does not fetch the public manifest.
