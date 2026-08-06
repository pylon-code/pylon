# Marketing Site and Legal Documents

> For maintainers. Nothing here is legal advice.

**Status: the marketing site is not deployed and must not be deployed as-is.**

`apps/marketing` was inherited from T3 Code and still carries their product
copy and, more importantly, their legal pages. Publishing it under Pylon would
present another company's terms, privacy policy, and security policy as if they
governed this product — asserting obligations on behalf of an entity that has
not agreed to them, and telling Pylon's users their data is handled under an
agreement that does not cover them.

This was left deliberately unrenamed. A find-and-replace would be worse than
doing nothing: it would produce documents that look like Pylon's own policies
while describing someone else's practices.

## What is already guarded

- `apps/marketing/vercel.ts` sets `git.deploymentEnabled: false`, so linking a
  Vercel project to this repository will not auto-publish the site.
- No workflow deploys `apps/marketing`. The release workflow's `deploy_web` job
  deploys `apps/web` only, and is itself opt-in behind `DEPLOY_HOSTED_WEB`.

Removing either guard without rewriting the content republishes the problem.

## What needs rewriting before the site ships

| Page                                                                     | Problem                                               |
| ------------------------------------------------------------------------ | ----------------------------------------------------- |
| `src/pages/terms-of-service.astro`                                       | T3's terms, naming their legal entity                 |
| `src/pages/privacy-policy.astro`                                         | T3's privacy practices and data processors            |
| `src/pages/security-policy.astro`                                        | T3's disclosure process and contacts                  |
| `src/pages/legal.astro`                                                  | Index linking the above                               |
| `src/pages/index.astro`, `src/layouts/Layout.astro`, `src/lib/tweets.ts` | Product copy, testimonials, and links belonging to T3 |

The mobile app has the same dependency: `apps/mobile/src/features/settings/lib/legal-document-url.ts`
defaults its marketing site to `https://t3.codes`, so in-app **Settings → Legal**
opens T3's documents. It reads `EXPO_PUBLIC_MARKETING_SITE_URL`, so pointing it
at a Pylon site is configuration, not code — but until such a site exists, that
screen should be hidden rather than repointed.

## Do you need legal documents at all?

It depends entirely on what Pylon publishes, and the answer changes as surfaces
come online.

**Desktop app distributed from GitHub Releases, no accounts, no telemetry.**
The `LICENSE` file is the only document strictly needed. Pylon collects nothing
in this configuration: agent credentials stay on the user's machine, and T3
Connect — the only component that would process personal data — is off unless
deliberately configured.

**iOS or Android app.** A privacy policy URL is **mandatory**. Apple requires
one for every App Store submission and Google Play requires one for every
listing, with no exemption for apps that collect nothing; the policy simply says
so. This is a hard gate on shipping mobile, not a judgement call — it is worth
starting before the rest of the App Store work rather than discovering it at
submission.

**Hosted web app, or T3 Connect enabled.** Sign-in means processing personal
data — at minimum email addresses and IP addresses — which brings real
obligations under GDPR and CCPA depending on where users are. Both a privacy
policy and terms of service belong here, and they need to describe Pylon's
actual processors rather than being adapted from someone else's.

**Telemetry.** The relay ships client tracing to Axiom when configured. Anything
collected has to be disclosed in whatever privacy policy exists.

### Suggested order

1. **Now** — nothing beyond `LICENSE`. Desktop releases are unaffected.
2. **Before any store submission** — a privacy policy, published at a stable
   URL. This is the first hard requirement Pylon will hit.
3. **Before enabling Connect or a hosted web app** — a privacy policy and terms
   of service reflecting real data handling.

## The LICENSE file

`LICENSE` is MIT and carries **T3 Tools Inc.'s copyright notice, which must be
retained**. The MIT license requires that the notice survive in copies and
derivative works, so rebranding it would breach the licence Pylon depends on to
exist at all.

Pylon's own copyright line sits alongside it, covering work done in this fork.
That is the standard arrangement: both notices, neither replaced.
