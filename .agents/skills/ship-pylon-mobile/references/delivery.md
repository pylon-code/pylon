# Physical iPhone delivery

Commands run from repository root unless they explicitly change directory.

## Prerequisites

`eas` must be installed globally:

```bash
npm install -g eas-cli
eas login
```

Do not use `npx eas-cli` in this repo. npm resolves the workspace `overrides`
first and dies with `EOVERRIDE` on `react-native-nitro-markdown` before eas runs.

## Step 2 — act on the verdict

| Verdict            | Meaning                  | Do                                                     |
| ------------------ | ------------------------ | ------------------------------------------------------ |
| `OTA SAFE`         | Native inputs identical  | JS-only OTA, **or** rebuild if you prefer one artifact |
| `REBUILD REQUIRED` | Native inputs moved      | Rebuild only. **OTA is forbidden.**                    |
| `UNKNOWN`          | Fingerprint uncomparable | Treat as `REBUILD REQUIRED`                            |

Confirm developer authorization covers the selected build, OTA or rollback before running it; do not ask again when that action is already authorized. Diagnosis is read-only.

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

### The cherry-pick escape hatch

Cherry-picking the fix onto the phone's build commit and publishing from there
can make an OTA safe while native inputs have drifted. It is a last resort, not
the fast path — **when a rebuild fits in the time available, rebuild.** Reach for
this only when it genuinely does not.

If you do use it:

- Base the branch on the **git commit**, which is the `commit` field of the
  status script's output. It is not the build id — those are different
  identifiers and confusing them silently bases the branch on the wrong tree, or
  on nothing.
- Run the status script again against that branch and publish only on an
  `OTA SAFE` verdict. Being "identical by construction" is a prediction; the
  verdict is a measurement.
- A cherry-pick that conflicts means the trees have diverged more than assumed.
  Stop and rebuild.
