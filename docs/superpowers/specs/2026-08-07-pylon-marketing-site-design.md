# Pylon Marketing Site — Design

Date: 2026-08-07
Branch: `marketing-site`
Target: `pylon-code.com`

## Problem

Pylon has no marketing site. `apps/marketing` holds the site inherited from T3
Code — an Astro build of `t3.codes` — but it cannot ship as-is. Its legal pages
are T3 Tools Inc.'s real terms, privacy policy, and security policy, so
publishing them under Pylon would present another company's obligations as if
they governed this product. `apps/marketing/vercel.ts` therefore sets
`git.deploymentEnabled: false`, and `docs/operations/marketing-and-legal.md`
documents why.

The inherited site is also positioned entirely around being open source, while
`pylon-code/pylon` is private.

## Approach

Rebrand `apps/marketing` in place rather than creating a separate repository.
The site keeps shipping in the same pull request as the features it describes,
and it keeps the `@t3tools/shared` workspace dependency that renders
`/schema/t3.json`. Extracting the site would force that schema to be vendored
or published as a package for no gain.

The repository stays private. The deployed site is public regardless.

## Decisions

| Question               | Decision                                                |
| ---------------------- | ------------------------------------------------------- |
| Where the site lives   | `apps/marketing`, in this repository                    |
| Legal pages            | Deleted, not rewritten                                  |
| Section under the hero | Pylon's own "Runs where you do"; no T3 credit           |
| Download source        | `pylon-code/pylon-releases`, stable channel             |
| Open-source section    | Deleted, along with the nav stars badge                 |
| Hero screenshot        | Placeholder now, real capture before production         |
| Mobile                 | Kept, styled "Coming soon"                              |
| Vercel                 | Code and config here; the developer creates the project |

## Positioning

The inherited headline — "The open-source control plane for coding agents." —
cannot stand with a private repository, and neither can the hero's "Steal our
code (legally)" link or the nav stars badge.

Replacement headline:

> **The control plane for coding agents.**
>
> Orchestrate Claude Code, Codex, Cursor, Grok, and OpenCode from one surface.
> Bring your own subscription. Drive it from anywhere.

This trades the open-source claim for two claims that are true today and
differentiate Pylon from Claude Desktop, Codex App, and Conductor:
bring-your-own-subscription, and remote access.

No section credits T3 Code, and no section cites a user count or star count.
Pylon's origin story is deliberately deferred; the site makes only first-person
claims it can support. `MARKETING_STATS` is deleted entirely.

## Page structure

Hero → Runs where you do → Bring your own sub → Git → Download CTA.

### Hero

Headline and subhead above. Keeps the existing OS-detecting download button,
which points at the newest stable release. Removes the "Steal our code
(legally)" GitHub link. The mobile line becomes non-linked "Coming soon" text.
The screenshot frame stays, holding a placeholder image until a real Pylon
capture is supplied.

### Runs where you do (replaces the endorsements section)

Reuses the existing wide-section shell. Three tiles:

- **Reach it from anywhere.** Local network, Tailscale, or the built-in tunnel.
- **Web, desktop, and phone.** Three surfaces against one environment.
- **Fast enough to live in.** Speed as a stated product commitment.

`src/lib/tweets.ts`, `tweets.md`, and all of `public/pfps/` are deleted.

### Bring your own sub

Survives nearly unchanged. The provider marks — Claude, Codex, OpenCode,
Cursor, Grok — are accurate for Pylon. Copy edits only.

### Git

Survives with copy edits.

### Open source

Deleted, along with the nav stars badge and the fork/browse-source actions.

### Download CTA

Repointed at the releases page for `pylon-code/pylon-releases`.

## Downloads

`src/lib/releases.ts` changes `REPO` to `pylon-code/pylon-releases` and the
session cache key to `pylon-latest-release`. Nothing else changes: the release
assets are already named `Pylon-<version>-arm64.dmg`, `-x64.dmg`, `-x64.exe`,
and `-x86_64.AppImage`, which match the `data-asset` suffixes the download page
already looks for.

Per `docs/operations/release.md`, only plain stable `X.Y.Z` tags are marked as
the repository's latest release, so `/releases/latest` returns 404 until a
stable tag is published. The existing `catch` in `download.astro` already falls
back to the releases page, so the site degrades to a working link rather than
breaking. A stable release is expected the same day this ships.

The download page keeps its Mobile section with the iOS and Android cards
styled as disabled "Coming soon" rather than linking to T3's store listings.

## Legal

Deleted: `terms-of-service.astro`, `privacy-policy.astro`,
`security-policy.astro`, `legal.astro`, and `components/LegalPage.astro`.

The footer's Terms, Privacy, and Security links are removed. So is the Discord
link, which points at T3's community server rather than one Pylon runs; it
returns as a one-line change once Pylon has its own. The footer keeps Download
and adds a GitHub link to the public `pylon-code/pylon-releases`, so the
download path is inspectable without exposing the product repository.

`LICENSE` is untouched. It is MIT and carries T3 Tools Inc.'s copyright notice,
which the licence requires be retained; Pylon's notice sits alongside it.

A privacy policy becomes mandatory before any App Store or Play Store
submission, with no exemption for apps that collect nothing. That is tracked as
separate work, not part of this site launch.

`docs/operations/marketing-and-legal.md` is rewritten to describe the shipped
state. Leaving it asserting "must not be deployed" after deployment would make
the guard documentation actively misleading.

## Branding and metadata

Favicons and touch icons regenerate from `assets/prod/logo.svg` via the
`pylon-branding` skill, replacing the inherited T3 icons in `public/`.

`astro.config.mjs` gains `site: "https://pylon-code.com"`. `Layout.astro` gains
canonical and Open Graph tags, which the inherited layout lacks entirely.

Compatibility identifiers are not renamed, per `CLAUDE.md`. The
`/schema/t3.json` route, the `@t3tools/marketing` package name, and the
`@t3tools/shared` import all stay exactly as they are.

## Deployment

The developer creates the Vercel project; this work supplies code and config
only, to avoid colliding with concurrent Vercel provisioning.

`apps/marketing/vercel.ts` flips `git.deploymentEnabled` to `true`, and the
comment above it is rewritten to record what changed and why it is now safe.

Vercel project settings to apply:

- Root directory: `apps/marketing`
- Install and build commands: inherited from `vercel.ts` (already filtered to
  `@t3tools/marketing`)
- Output directory: `dist`
- Domain: `pylon-code.com`, with `www.pylon-code.com` redirecting to the apex

## Assets still required

Neither blocks the branch, but both block production:

1. **Hero screenshot** — roughly 2508×1682, Pylon with real threads open.
2. **Open Graph image** — 1200×630.

## Verification

- `vp run --filter @t3tools/marketing build`
- `astro check` for the package
- A grep sweep of `apps/marketing/src` for `t3.codes`, `pingdotgg`, `T3 Code`,
  and `MARKETING_STATS`, confirming every remaining hit is a deliberate
  compatibility identifier

No browser verification unless requested.

## Out of scope

- Making `pylon-code/pylon` public
- Writing a privacy policy or any other legal document
- Repointing the mobile app's `EXPO_PUBLIC_MARKETING_SITE_URL`; that Settings
  screen stays hidden until Pylon publishes legal documents
- Creating the Vercel project or configuring DNS
- Cutting the stable release the download page will read
