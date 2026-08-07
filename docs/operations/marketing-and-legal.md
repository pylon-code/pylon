# Marketing Site and Legal Documents

> For maintainers. Nothing here is legal advice.

**Status: the marketing site ships from `apps/marketing` to `pylon-code.com`.**

The site was inherited from T3 Code and carried their product copy and, more
importantly, their legal pages. It has been rewritten as Pylon's own, and the
T3 legal pages were deleted rather than adapted. Publishing them under Pylon
would have presented another company's terms, privacy policy, and security
policy as if they governed this product.

They were deliberately not find-and-replaced. That would have produced
documents that look like Pylon's own policies while describing someone else's
practices.

## What the site publishes today

- Product copy that makes only first-person Pylon claims. No user counts, no
  star counts, no testimonials, and no attribution to T3 Code.
- A download page reading the latest **stable** release from
  `pylon-code/pylon-releases`.
- No terms of service, privacy policy, or security policy. Those pages do not
  exist, and the footer does not link to them.

`apps/marketing/vercel.ts` now sets `git.deploymentEnabled: true`. The release
workflow still deploys `apps/web` only; nothing in CI deploys the marketing
site.

## Before adding a legal page back

The site currently publishes no legal documents because it does not need to.
That changes as surfaces come online.

**Desktop app distributed from GitHub Releases, no accounts, no telemetry.**
The `LICENSE` file is the only document strictly needed. Pylon collects nothing
in this configuration: agent credentials stay on the user's machine, and T3
Connect — the only component that would process personal data — is off unless
deliberately configured. This is the configuration the site describes today.

**iOS or Android app.** A privacy policy URL is **mandatory**. Apple requires
one for every App Store submission and Google Play requires one for every
listing, with no exemption for apps that collect nothing; the policy simply says
so. This is a hard gate on shipping mobile, not a judgement call — it is worth
starting before the rest of the App Store work rather than discovering it at
submission. The site's mobile links are placeholders until then.

**Hosted web app, or Pylon Connect enabled.** Sign-in means processing personal
data — at minimum email addresses and IP addresses — which brings real
obligations under GDPR and CCPA depending on where users are. Both a privacy
policy and terms of service belong here, and they need to describe Pylon's
actual processors rather than being adapted from someone else's.

**Telemetry.** The relay ships client tracing to Axiom when configured. Anything
collected has to be disclosed in whatever privacy policy exists.

Any new legal page is Pylon's own document describing Pylon's actual practices.
Do not reintroduce the deleted files from git history.

## The mobile app's legal screen

`apps/mobile/src/features/settings/lib/legal-document-url.ts` defaults its
marketing site to `https://t3.codes`, so in-app **Settings → Legal** opens T3's
documents. It reads `EXPO_PUBLIC_MARKETING_SITE_URL`, so pointing it at Pylon is
configuration rather than code — but `pylon-code.com` publishes no legal
documents yet, so that screen should stay hidden until it does.

## The LICENSE file

`LICENSE` is MIT and carries **T3 Tools Inc.'s copyright notice, which must be
retained**. The MIT license requires that the notice survive in copies and
derivative works, so rebranding it would breach the licence Pylon depends on to
exist at all.

Pylon's own copyright line sits alongside it, covering work done in this fork.
That is the standard arrangement: both notices, neither replaced.
