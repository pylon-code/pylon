---
name: ship-pylon-mobile
description: Use when getting a current Pylon build onto a real iPhone, or when the installed iOS app broke, crashes on launch, will not connect to a Pylon server, shows stale screens, or is suspected to be behind the repo. Also use for questions about EAS builds, the preview channel, OTA updates, runtime version policy, rolling back a bad bundle, or why a published update never arrived. iOS only.
---

# Ship Pylon Mobile

Deliver a current Pylon build to a physical iPhone, and diagnose an installed one
that stopped working. This is the physical-device delivery path. For Simulator
and Emulator verification, use [`test-pylon-mobile`](../test-pylon-mobile/SKILL.md)
instead — that skill never touches EAS.

## The core problem this skill exists to prevent

The iPhone build comes from the `preview:local` profile, which pins the
**`appVersion`** runtime policy. Its runtime version is the literal string
`1.0.1`.

That disables Expo's native-drift guard. Under the default `fingerprint` policy,
an update whose native inputs do not match the installed binary simply never
reaches it. Under `appVersion`, **every OTA lands on `1.0.1` regardless**, so a
JS bundle calling a native method the binary does not have installs cleanly and
then breaks the app.

**So this skill performs the check Expo is not performing.** Never publish an OTA
without comparing fingerprints first.

## Prerequisites

`eas` must be installed globally:

```bash
npm install -g eas-cli
eas login
```

Do not use `npx eas-cli` in this repo. npm resolves the workspace `overrides`
first and dies with `EOVERRIDE` on `react-native-nitro-markdown` before eas runs.

## Step 1 — always start here

```bash
.agents/skills/ship-pylon-mobile/scripts/phone-status.sh
```

Read-only. Spends no build quota, changes nothing on the device. It reports the
build currently on channel `preview`, how many commits and contract files the
repo has moved since, both fingerprints, and a verdict. Run it before forming any
theory about what is wrong.

## Step 2 — act on the verdict

| Verdict            | Meaning                  | Do                                                     |
| ------------------ | ------------------------ | ------------------------------------------------------ |
| `OTA SAFE`         | Native inputs identical  | JS-only OTA, **or** rebuild if you prefer one artifact |
| `REBUILD REQUIRED` | Native inputs moved      | Rebuild only. **OTA is forbidden.**                    |
| `UNKNOWN`          | Fingerprint uncomparable | Treat as `REBUILD REQUIRED`                            |

Confirm with the developer before running anything below. Diagnosis is
unattended; spending EAS quota or changing what is on the phone is not.

### Rebuild (the safe default)

```bash
cd apps/mobile
eas build --profile preview:local -p ios
```

Then open the build page in **Safari on the phone** and install over the existing
app. The device UDID must already be on the provisioning profile.

Use `preview:local`, not `preview` or `preview:dev`. Those two use the
`fingerprint` policy, and a fingerprint computed on macOS does not match the one
the Linux EAS builder computes, so laptop builds on those profiles error out.
`preview:local` exists specifically to be laptop-buildable.

### OTA — only when the verdict says `OTA SAFE`

```bash
cd apps/mobile
APP_VARIANT=preview MOBILE_VERSION_POLICY=appVersion \
  eas update --branch preview --environment preview --platform ios --message "..."
```

`MOBILE_VERSION_POLICY=appVersion` is mandatory. Omit it and the update is
published under a fingerprint runtime version that no installed binary matches —
EAS reports success and the phone never sees it.

### Roll back a bad bundle

```bash
cd apps/mobile
APP_VARIANT=preview MOBILE_VERSION_POLICY=appVersion \
  eas update:roll-back-to-embedded --branch preview --platform ios --message "..."
```

Reverts the channel to the bundle baked into the binary. Fastest way to restore a
working app, and the fastest way to test whether a published bundle caused a
regression.

## Diagnosing an app that stopped working

Match the symptom before touching anything:

| Symptom                                            | Likely cause                       | Check                                                                            |
| -------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------- |
| Crashes on launch, or right after opening a thread | A bad OTA on `preview`             | `eas update:list --branch preview` — is the newest update newer than the binary? |
| Launches, cannot connect to a server               | Client/server contract drift       | Commit drift + changed contract files from the status script                     |
| Connects, individual screens broken or empty       | Contract drift in one feature area | `git diff <build-commit>..origin/pylon -- packages/contracts`                    |

Contract changes are usually additive and forward-compatible
(`Schema.optionalKey`, `ForwardCompatibleArray`), so drift alone is not proof.
Confirm against the actual symptom.

## Facts that are easy to get wrong

- **There is no nightly channel for mobile.** Nightly is desktop, CLI, and hosted
  web only. Mobile channels are `development`, `preview`, `production`. The
  `preview` variant merely wears the nightly icon (`app.config.ts`,
  `PREVIEW_ASSETS`), which makes it look like a nightly track.
- **Updating the nightly desktop app does not update the phone.** They are
  independent. A newer server can surface phone staleness, but it never causes it.
- **`production` builds must run from CI**, never a laptop —
  `.github/workflows/mobile-eas-production.yml`, `workflow_dispatch`, which
  auto-submits to TestFlight. Same fingerprint-host reason as above.
- **Nothing publishes to `preview` automatically on merge.** The only automated
  mobile build is per-PR, gated on the `🚀 Mobile Continuous Deployment` label.
  A phone stays stale until someone acts.

## Red flags — stop

- About to run `eas update` without having run the status script
- Verdict said `REBUILD REQUIRED` and an OTA looks "worth trying anyway"
- Reaching for `eas update` because a rebuild is slow
- Publishing without `MOBILE_VERSION_POLICY=appVersion`

The first two are how the app gets bricked. A rebuild is slower and always safe;
a wrong OTA is fast and lands on the device with no guard.
