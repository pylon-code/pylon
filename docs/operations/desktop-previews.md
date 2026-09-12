# Public macOS PR previews

Maintainers can opt a trusted, same-repository PR targeting `pylon` into an unsigned
Apple Silicon DMG. The bot posts a direct public download link, exact commit and
SHA-256 checksum. Downloaders do not need a GitHub account. Fork PRs are excluded.

## Enable a preview

The workflows must first be merged into `pylon`, GitHub's default branch. The
source repository must remain public. No release token, signing credentials or
separate artifact host is needed; the publisher uses its scoped `GITHUB_TOKEN`.

If the label does not exist, create it once:

```sh
gh label create 'preview:mac' --repo pylon-code/pylon \
  --description 'Publish unsigned public macOS previews for this trusted PR' \
  --color '0E8A16'
```

Review the PR's code, dependency scripts and workflow changes before applying
`preview:mac`. The label authorizes public binaries from that branch, including
subsequent pushes while the label remains. Same-repository code is still code
that will run on a build runner and on downloaders' machines; this is a maintainer
trust decision, not a replacement for code review or CI.

```sh
gh pr edit PR_NUMBER --repo pylon-code/pylon --add-label 'preview:mac'
```

Watch **Desktop macOS Preview**, then **Publish Desktop macOS Preview**. The first
builds without signing secrets or write permissions. The second runs trusted
`pylon` scripts, downloads only that build attempt's artifact outside the checkout,
and publishes its DMG without executing or mounting it. The implementation follows
GitHub's [workflow-run privilege separation guidance](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run).

Merging the workflows alone does not build or publish a preview. Applying the
label is the opt-in. An unlabeled PR, unrelated label change or skipped build does
not publish anything.

## Download and install

Use the bot's PR comment for the current link and checksum. Public assets live in
the source repository's rolling `desktop-preview` prerelease. That tag identifies
the collection, not the PR's build commit. Files are named
`Pylon-VERSION-pr.PR.RUN.ATTEMPT-arm64.dmg`; the committed desktop version must be a
plain `MAJOR.MINOR.PATCH` version. The publisher rejects other names, extra files,
symlinks and files larger than 1 GiB.

Compare the downloaded file's `shasum -a 256` output with the comment before
clearing quarantine using the exact `xattr` command in that comment. These builds
are unsigned and unnotarized. They preserve **Pylon (Alpha)**'s application, URL
scheme and data-profile identity. Quit Alpha before installing a preview, and
back up its data before testing; the preview is not an isolated second app.
Nightly retains its separate app/profile identity.

The existing `-pr.` packaging omits updater configuration, and the desktop runtime
disables preview updates. No update manifests or ZIPs are published by this
workflow. The preview prerelease is explicitly excluded from “Latest”; supported
Alpha and Nightly downloads remain in
[`pylon-code/pylon-releases`](https://github.com/pylon-code/pylon-releases/releases).

## Replacement, removal and recovery

A successful newer build uploads before removing that PR's previous assets. A
stale build cannot replace a newer published run or advertise a superseded head.
The bot updates its own existing comment, including comments beyond the first
page. Assets for other PRs and other release files are never pruned.

Removing `preview:mac` or closing the PR removes its public previews and marks the
bot comment as removed. Closing still cleans up after a prior label removal, even
if the head branch or repository has disappeared. Remove the label before
retargeting a PR away from `pylon`; close/unlabel triggers are scoped to that base.
Reopening or reapplying the label builds a fresh preview. Publication and cleanup
share a per-PR lock and recheck live state, so an old cleanup event cannot revoke
a new opt-in.

API outages fail the run instead of being interpreted as a closed PR or missing
release. Failed upload leaves the previous link intact. A later failure can leave
both versions available until retry, and cleanup reports failure if deletion
fails. Rerun the failed publisher/cleanup job after resolving the error; it checks
current state and reuses an identical completed upload. If the build artifact has
expired, rerun the build or remove and reapply the label. Internal Actions
artifacts expire after seven days; public previews persist until replacement or
cleanup. The empty rolling release can remain for future previews.

Focused local checks do not build or publish:

```sh
node --test .github/scripts/desktop-macos-preview.test.cjs
actionlint .github/workflows/desktop-macos-preview.yml \
  .github/workflows/desktop-macos-preview-publish.yml
```
