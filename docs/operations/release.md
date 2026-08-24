# Release Checklist

> For maintainers. Using Pylon? See [docs/user](../user/).

This document covers the unified release workflow for stable and nightly desktop releases.

## Optional publishing surfaces

Desktop releases are the workflow's core and need no paid service: with no
variables or secrets configured at all, a run still builds and publishes
unsigned macOS, Linux, and Windows artifacts with working auto-update metadata.

Everything beyond that is opt-in, gated on a repository variable, and off by
default. Each entry below says what turning it on requires and what staying off
costs.

| Variable                      | Turns on                  | Requires                                               | Cost while off                                     |
| ----------------------------- | ------------------------- | ------------------------------------------------------ | -------------------------------------------------- |
| `PUBLISH_CLI_TO_NPM`          | Publishing the CLI to npm | An npm package this repo owns, with trusted publishing | Remote **Update server** breaks — see below        |
| `DEPLOY_HOSTED_WEB`           | The hosted web app deploy | A Vercel project and its three domains                 | No hosted web app; desktop is unaffected           |
| `FINALIZE_RELEASE_COMMIT`     | The version-bump commit   | A GitHub App with push rights                          | Package versions are not bumped back on the branch |
| `ANNOUNCE_RELEASE_ON_DISCORD` | The release announcement  | A Discord webhook and role IDs                         | No announcement                                    |

Pylon Connect is separate and needs no variable of its own: the workflow detects
whether Cloudflare and Clerk configuration is present and builds without cloud
sign-in when it is not. Partial configuration counts as none.

Set a variable to the literal string `true` to enable it.

## What the workflow does

- Workflow: `.github/workflows/release.yml`
- Triggers:
  - push tag matching `v*.*.*` for stable releases
  - scheduled nightly check every three hours
  - manual `workflow_dispatch` for either channel
- Runs lint, typecheck, and tests alongside artifact builds. Publishing waits for every check.
- Reads the shared production Pylon Connect relay URL and Clerk client configuration before packaging clients.
- Builds four artifacts in parallel for both channels:
  - macOS `arm64` DMG
  - macOS `x64` DMG
  - Linux `x64` AppImage
  - Windows `x64` NSIS installer
- Publishes one GitHub Release with all produced files.
  - Stable tags with a suffix after `X.Y.Z` (for example `1.2.3-alpha.1`) are published as GitHub prereleases.
  - Only plain stable `X.Y.Z` releases are marked as the repository's latest release.
  - Nightly runs are always GitHub prereleases and never marked latest.
  - Automatically generated release notes are pinned to the previous tag in the same channel, so stable compares to the previous stable tag and nightly compares to the previous nightly tag.
- Includes Electron auto-update metadata (for example `latest*.yml`, `nightly*.yml`, and `*.blockmap`) in release assets.
- Publishes the CLI package (`apps/server`, npm package `t3`) with OIDC trusted publishing from the same workflow file:
  - stable releases publish npm dist-tag `latest`
  - nightly releases publish npm dist-tag `nightly`
- Deploys the hosted web app to Vercel only after a release is published:
  - stable releases are aliased to the `latest` hosted app channel
  - nightly releases are aliased to the `nightly` hosted app channel
- Signing is optional and auto-detected per platform from secrets.

## Required release credentials

None. GitHub Release publication uses the repository-scoped workflow token, so publishing desktop
artifacts needs no app, no token, and no third-party account.

The finalize job is the one exception, and it is opt-in via `FINALIZE_RELEASE_COMMIT`. When enabled
it commits and pushes aligned package versions to the `pylon` product branch as the Release App, and
requires these GitHub Actions secrets:

- `RELEASE_APP_ID`
- `RELEASE_APP_PRIVATE_KEY`

Keeping release publication on the workflow token gives it a rate-limit quota independent from the
Release App installation.

## Runners

Every job runs on Blacksmith runners, which requires the Blacksmith app installed on the
`pylon-code` organization — Blacksmith does not support personal accounts.

Tiers are deliberately conservative: `blacksmith-8vcpu-ubuntu-2404`, `blacksmith-8vcpu-windows-2025`,
and `blacksmith-6vcpu-macos-26`. Blacksmith's documentation only evidences these sizes, and **an
unavailable tier does not fail the job — it queues until GitHub's 24-hour limit kills it.** That
silent hang is the single most confusing failure this workflow can produce, so raise a tier only
after confirming the plan grants it, and watch the first run after any change.

Job timeouts are generous for the same reason a ceiling is cheap: preflight runs the whole
repository's check, typecheck, and test suites, and the build matrix packages Electron plus a Rust
target with the macOS legs cross-building a second architecture.

Switching back to GitHub-hosted runners is a pure label swap — `ubuntu-24.04`, `windows-2025`,
`macos-26` — with no other change required.

## Pylon Connect relay deployment

The relay is a shared control plane versioned separately from client releases. Stable and nightly
client builds must point at the same relay so users see the same linked environments when switching
release channels.

`.github/workflows/deploy-relay.yml` deploys Alchemy stage `prod` on every push to `main`. The
release workflow reads the relay URL and Clerk client configuration from the existing `production`
GitHub Actions environment before building desktop, CLI, or hosted web artifacts.

Required repository variables shared by relay deployments:

- `CLOUDFLARE_ACCOUNT_ID`
- `AXIOM_ORG_ID`

Required repository secrets shared by relay deployments:

- `CLOUDFLARE_API_TOKEN`
- `NEON_API_KEY`
- `AXIOM_TOKEN`

Required `production` environment variables:

- `RELAY_API_ZONE_NAME`
- `RELAY_TUNNEL_ZONE_NAME`
- `CLERK_PUBLISHABLE_KEY`
- `CLERK_JWT_AUDIENCE`
- `CLERK_JWT_TEMPLATE`
- `CLERK_CLI_OAUTH_CLIENT_ID`
- `APNS_ENVIRONMENT`
- `APNS_TEAM_ID`
- `APNS_KEY_ID`
- `APNS_BUNDLE_ID`

Optional `production` environment variables:

- `RELAY_DOMAIN` when overriding the derived `relay.<RELAY_API_ZONE_NAME>` domain

Required `production` environment secrets:

- `CLERK_SECRET_KEY`
- `APNS_PRIVATE_KEY`

The account-scoped repository credentials are consumed by Alchemy while provisioning relay stages; they
are not bound into the relay Worker. The production deployment uses an Axiom personal access token,
so `AXIOM_ORG_ID` must accompany `AXIOM_TOKEN`. The `prod` stage owns the retained Neon
project. Local personal stages fork isolated branches from it and are never deployed by CI.
Production adopts the configured relay API and tunnel DNS zones as retained Cloudflare resources.
Personal stages reference the production-owned zones.

Developers deploy personal stages locally rather than through pull-request automation:

```sh
vp run --filter t3code-relay deploy -- --stage "$USER" --env-file .env.local
```

## Hosted web app release deployment

The hosted app is intentionally not deployed by Vercel's Git integration. The
web project disables automatic Git deployments in `apps/web/vercel.ts` via
`git.deploymentEnabled: false`, and `.github/workflows/release.yml` deploys the
web app with Vercel CLI after the GitHub Release succeeds.

Required GitHub Actions secrets:

- `VERCEL_TOKEN`
- `VERCEL_ORG_ID`
- `VERCEL_PROJECT_ID`

Optional GitHub Actions variables:

- `VERCEL_TEAM_SLUG`: overrides the Vercel CLI scope when the team slug is preferred over the `VERCEL_ORG_ID` secret.
- `T3CODE_WEB_ROUTER_URL`: defaults to `https://app.t3.codes`.
- `T3CODE_WEB_LATEST_DOMAIN`: defaults to `latest.app.t3.codes`.
- `T3CODE_WEB_NIGHTLY_DOMAIN`: defaults to `nightly.app.t3.codes`.

Required Vercel domains:

- `app.t3.codes`: the router domain users open, updated by stable releases.
- `latest.app.t3.codes`: channel alias updated by stable releases.
- `nightly.app.t3.codes`: channel alias updated by nightly releases.

The router domain uses `apps/web/vercel.ts` routes. Users opt into a channel by
visiting `/__t3code/channel?channel=latest` or
`/__t3code/channel?channel=nightly`; the router stores the
`t3code_web_channel` cookie and rewrites future requests on `app.t3.codes` to
the matching channel alias.

The release deploy job rewrites release package versions before upload so the
hosted app's About panel renders the release version. Stable deploys alias the
same deployment to both the `latest` channel and the router domain so the router
rules stay current. Nightly deploys only alias the `nightly` channel. The job
also passes `VITE_HOSTED_APP_CHANNEL=latest|nightly`, which renders the hosted
update track selector in the About panel. Changing the selector navigates
through `/__t3code/channel` on the router domain so the user's channel cookie is
updated before redirecting to the hosted app root.

One-time Vercel dashboard setup:

1. Confirm the web project root directory remains `apps/web`.
2. Add the three domains above to the web project.
3. Disable automatic Git deployments in the dashboard if desired; the committed
   `vercel.ts` setting is the source-of-truth, but disconnecting Git in the
   dashboard is also safe.
4. Run one stable release deployment, or manually alias the current stable
   deployment, so `app.t3.codes` points at a deployment containing the router
   rules in `apps/web/vercel.ts`. Future stable releases keep this alias current.

## Nightly builds

- Workflow: `.github/workflows/release.yml`
- Triggers:
  - scheduled check every three hours
  - manual `workflow_dispatch` with `channel=nightly`
- Runs the same desktop quality gates and artifact matrix as the tagged release flow.
- Publishes a GitHub prerelease only:
  - current tag format: `vX.Y.Z-nightly.YYYYMMDD.<run_number>`
  - `nightly-v...` is accepted only as a legacy previous-nightly tag
  - release name includes the short commit SHA
  - `make_latest` is always `false`
- Uses the next stable patch version as the nightly base. For example, `0.0.17` produces nightlies on `0.0.18-nightly.*`.
- Publishes Electron auto-update metadata to the dedicated `nightly` updater channel, so desktop users can opt into that track independently from stable.
- Publishes the CLI package (`apps/server`, npm package `t3`) to the `nightly` npm dist-tag using the same nightly version.
- Does not commit version bumps back to the product branch.

## Server self-update release invariant

Connected servers update to the client's exact version, not to an npm dist-tag. Every released
desktop or hosted client version must therefore have a matching `t3@<version>` package available on
npm before users can receive that client.

**This is the cost of leaving `PUBLISH_CLI_TO_NPM` off.** Desktop builds, installs, and auto-updates
all work without an npm package, because the desktop app bundles its own server. What does not work
is updating a _remote_ environment from the app: the **Update server** action resolves a package
version that was never published, so a user pointing the desktop app at another machine cannot
update that machine from the UI. They must update it themselves. Turn the variable on once this
repository owns a package with a matching version for every release.

When the variable is on, the workflow enforces this ordering:

1. `publish_cli` publishes the exact stable or nightly version to npm.
2. `release` depends on `publish_cli` before exposing desktop artifacts in GitHub Releases.
3. `deploy_web` depends on `release` before moving the hosted channel to the new client.

Preserve these dependencies when changing the release graph. Publishing a client first would leave
the **Update server** action targeting a package version that does not exist yet. The release job
accepts a _skipped_ CLI publish, which is the opt-out above; it still refuses a _failed_ one.

For a release smoke test, confirm `npm view t3@<version> version` returns the expected version, then
connect the new client to a server on the previous version and verify that the update action
reconnects to the matching server. Use releases with identical migration manifests for the
automatic path. When the manifest changed, verify that the remote action stops before restart and
shows the exact local `npx t3@<version> service update` command. Also test the manual or
desktop-managed guidance when those environments are available.

## Desktop auto-update notes

- Updater runtime: `apps/desktop/src/updates/DesktopUpdates.ts`.
- `electron-updater` adapter: `apps/desktop/src/electron/ElectronUpdater.ts`.
- `apps/desktop/src/main.ts` only wires the updater layers into the desktop runtime.
- Update UX:
  - Background checks run on startup delay + interval.
  - No automatic download or install.
  - The desktop UI shows a rocket update button when an update is available; click once to download, click again after download to restart/install.
- Provider: GitHub Releases (`provider: github`) configured at build time.
- Repository slug source:
  - `PYLON_DESKTOP_UPDATE_REPOSITORY` (format `owner/repo`), if set.
  - otherwise `GITHUB_REPOSITORY` from GitHub Actions.

### The public releases repository

Auto-update reads release assets over the public GitHub API. A private
repository's releases are not readable without a credential, and there is no
safe credential to ship inside a distributed app, so auto-update cannot work for
anyone but you while releases live in a private repository — installed apps
simply never see a new version, and nothing fails loudly.

Pylon therefore publishes artifacts to **`pylon-code/pylon-releases`**, a public
repository holding builds and update manifests but no source. Two pieces wire
this together, and they must agree:

- the `PYLON_DESKTOP_UPDATE_REPOSITORY` repository variable, which the build job
  passes into the desktop build so installed apps embed that feed;
- the `RELEASES_REPO_TOKEN` secret, which the release job uses to publish there.

The release job refuses to run when the variable is set and the token is not,
rather than falling back to publishing here: builds already embed the public
feed by then, so publishing anywhere else would strand every installed app.

`RELEASES_REPO_TOKEN` is a fine-grained personal access token scoped to
`pylon-code/pylon-releases` with **Contents: read and write**. Fine-grained
tokens expire, so a release that suddenly fails authentication usually means the
token lapsed rather than anything changing in this workflow.

Cross-repository releases carry a short written body instead of generated notes.
Note generation derives from tags and commit history that live in the source
repository, and running it against a public repository would republish private
commit subjects. If the source repository later becomes public, clearing
`PYLON_DESKTOP_UPDATE_REPOSITORY` returns everything to same-repository
publication with generated notes and no token.

- Required release assets for updater:
  - platform installers (`.exe`, `.dmg`, `.AppImage`, plus macOS `.zip` for Squirrel.Mac update payloads)
  - channel metadata: `latest*.yml` for stable releases, `nightly*.yml` for nightly releases
  - `*.blockmap` files (used for differential downloads)
- macOS metadata note:
  - `electron-updater` reads `latest-mac.yml` on stable and `nightly-mac.yml` on nightly, for both Intel and Apple Silicon.
  - The workflow merges the per-arch mac manifests into one channel-specific mac manifest before publishing the GitHub Release.

### Windows payload topology and update validation

Windows packages the bundled server and only its runtime-external/native
dependency closure in `resources/server.asar`. Native modules and helper
executables declared as unpacked by that archive must be present at the matching
paths below `resources/server.asar.unpacked`. The Windows-native backend reads
the archive in place through Electron. WSL cannot read ASAR files, so enabling
the WSL backend extracts the server tree once into the desktop state directory
under `wsl-server-tree/<version>` and reuses the completed version until the app
is updated.

The artifact builder rejects a Windows package when any of these invariants
break:

- `resources/server.asar` is absent or does not contain the server entry.
- Any file marked unpacked in the ASAR header is absent from
  `resources/server.asar.unpacked`.
- On same-architecture Windows builds, the packaged primary cannot load the fff
  native library from inside `server.asar` through its `.unpacked` sibling.
- The isolated, extracted sidecar cannot load the server entry with plain Node.
- The external Windows resource monitor is absent.
- The unpacked Windows application contains more than 80 files.

Cross-architecture Windows builds retain every structural and extracted-sidecar
check, but skip executing the target Electron binary. A same-architecture build
for each release target must exercise the primary native-load probe.

NSIS differential packaging remains enabled. A sidecar layout transition can
produce a larger one-time download; subsequent small releases retain their
blockmaps, with a 60 MB maximum for a representative sidecar-to-sidecar update.

## 0) npm OIDC trusted publishing setup (CLI)

The workflow invokes `node apps/server/scripts/cli.ts publish` after aligning package versions. That
script temporarily prepares the `t3` package, then runs `vp pm publish --filter t3 ...` from the
repository root so workspace publish configuration is applied correctly.

Checklist:

1. Confirm npm org/user owns package `t3` (or rename package first if needed).
2. In npm package settings, configure Trusted Publisher:
   - Provider: GitHub Actions
   - Repository: this repo
   - Workflow file: `.github/workflows/release.yml`
   - Environment (if used): match your npm trusted publishing config
3. Ensure npm account and org policies allow trusted publishing for the package.
4. Create release tag `vX.Y.Z` and push; workflow will:
   - align the release package versions to `X.Y.Z`
   - build web + server
   - invoke the CLI publish script with npm dist-tag `latest`
5. Nightly runs invoke the same publish script with npm dist-tag `nightly`.

## 1) Release validation and unsigned builds

There is no dry-run tag path. Pushing any accepted non-nightly tag, including
`v0.0.0-test.1`, classifies the run as the stable channel. It publishes `t3` with npm dist-tag
`latest`, creates a real GitHub Release, aliases the hosted app to `latest.app.t3.codes` and
`app.t3.codes`, and can commit a version bump to the `pylon` branch in the finalize job when it is enabled. Do not push a test tag
to validate the workflow.

The workflow has no non-publishing `workflow_dispatch` mode. Use normal CI or local quality gates to
validate checks and builds without shipping. To exercise the complete release graph at lower stable
risk, manually dispatch `channel=nightly`; this still publishes a real nightly npm package, GitHub
prerelease, desktop updater release, and hosted nightly alias, but it does not update stable aliases or
commit a version bump to the product branch. Only run it when a real nightly release is acceptable.

Manual `channel=stable` with a version input is also a real stable-channel release. Omitting signing
secrets only makes platform artifacts unsigned; it does not prevent publication.

## 2) Apple signing + notarization setup (macOS)

Required secrets used by the workflow:

- `CSC_LINK`
- `CSC_KEY_PASSWORD`
- `APPLE_API_KEY`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`
- `MACOS_PROVISIONING_PROFILE` (base64-encoded provisioning profile with Associated Domains)

Required repository variables:

- `APPLE_TEAM_ID`

Optional repository variables:

- `CLERK_PASSKEY_RP_DOMAINS`: comma-separated RP-domain override. By default, the build derives the
  domain from the production Clerk publishable key.

Checklist:

1. Apple Developer account access:
   - Team has rights to create Developer ID certificates.
2. Create an explicit App ID for `com.pylon.code` and enable Associated Domains.
3. Create a `Developer ID Application` certificate and a compatible provisioning profile for that
   App ID with Associated Domains enabled.
4. Export the certificate + private key as `.p12` from Keychain.
5. Base64-encode the `.p12` and store as `CSC_LINK`.
6. Base64-encode the provisioning profile and store it as `MACOS_PROVISIONING_PROFILE`.
7. Store the `.p12` export password as `CSC_KEY_PASSWORD`, and set `APPLE_TEAM_ID` to the
   10-character Apple Developer Team ID.
8. In App Store Connect, create an API key (Team key).
9. Add API key values:
   - `APPLE_API_KEY`: contents of the downloaded `.p8`
   - `APPLE_API_KEY_ID`: Key ID
   - `APPLE_API_ISSUER`: Issuer ID
10. Complete the Clerk Native API and AASA setup in [Pylon Connect Clerk Setup](../internals/t3-connect.md#desktop-passkeys).
11. Re-run a tag release and confirm macOS artifacts are signed/notarized and contain the expected
    `com.apple.developer.associated-domains` entitlement.

Notes:

- `APPLE_API_KEY` is stored as raw key text in secrets.
- The workflow writes it to a temporary `AuthKey_<id>.p8` file at runtime.
- The workflow decodes `MACOS_PROVISIONING_PROFILE`, validates it with `security cms`, and passes it
  to the desktop packager.

## 3) Azure Trusted Signing setup (Windows)

Required secrets used by the workflow:

- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_SECRET`
- `AZURE_TRUSTED_SIGNING_ENDPOINT`
- `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`
- `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`
- `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`

Checklist:

1. Create Azure Trusted Signing account and certificate profile.
2. Record ATS values:
   - Endpoint
   - Account name
   - Certificate profile name
   - Publisher name
3. Create/choose an Entra app registration (service principal).
4. Grant service principal permissions required by Trusted Signing.
5. Create a client secret for the service principal.
6. Add Azure secrets listed above in GitHub Actions secrets.
7. Re-run a tag release and confirm Windows installer is signed.

## 4) Ongoing release checklist

1. Ensure `main` is green in CI.
2. Bump app version as needed.
3. Create release tag: `vX.Y.Z`.
4. Push tag.
5. Verify workflow steps:
   - preflight passes
   - release quality checks pass
   - all matrix builds pass
   - `publish_cli` publishes the exact release version before the release job
   - release job uploads expected files
6. Smoke test downloaded artifacts.

## 5) Troubleshooting

- macOS build unsigned when expected signed:
  - Check all Apple secrets plus `APPLE_TEAM_ID` are populated and non-empty.
  - Confirm the provisioning profile belongs to `APPLE_TEAM_ID.com.pylon.code` and includes
    Associated Domains.
- Windows build unsigned when expected signed:
  - Check all Azure ATS and auth secrets are populated and non-empty.
- Build fails with signing error:
  - Retry with secrets removed to confirm unsigned path still works.
  - Re-check certificate/profile names and tenant/client credentials.
