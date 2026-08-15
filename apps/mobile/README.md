# Pylon Mobile

> [!WARNING]
> Pylon Mobile is currently in development and is not distributed yet. If you want to try it out, you can build it from source.

## Quickstart

> [!NOTE]
> Uses native modules so using Expo Go is not supported. You need to use the Expo Dev Client.

This app has three variants:

- `development`: Expo dev client, installable side-by-side as `Pylon Dev`
- `preview`: persistent internal preview build, installable side-by-side as `Pylon Preview`
- `production`: store/release build as `Pylon`

Run commands from `apps/mobile`.

Pylon Connect is optional and disabled in a fresh clone. Public configuration belongs in the
repository-root `.env` or `.env.local`, not an `apps/mobile/.env` file. See
[`../../.env.example`](../../.env.example).

## Development

Start Metro for the dev client:

```bash
vp run dev:client
```

Build and run the local iOS dev client:

```bash
vp run ios:dev
```

If your Xcode account only has a Personal Team, use a bundle identifier you control and opt into the
reduced-capability local build. Personal Team builds omit the widget and share extensions, push
entitlement, and native Sign in with Apple entitlement; builds without this opt-in are unchanged.

```bash
T3CODE_IOS_PERSONAL_TEAM=1 \
T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=com.example.t3code.dev \
vp run ios:dev
```

Build and install a self-contained Release app that does not need Metro:

```bash
vp run ios:release
```

The Personal Team equivalent also needs a unique bundle identifier:

```bash
T3CODE_IOS_PERSONAL_TEAM=1 \
T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=com.example.t3code \
vp run ios:release
```

Build and run the local iOS preview app:

```bash
vp run ios:preview
```

Force the review diff highlighter engine:

```bash
EXPO_PUBLIC_REVIEW_HIGHLIGHTER_ENGINE=javascript vp run ios:dev
```

`javascript` is the default and recommended setting for the review diff screen. Set `EXPO_PUBLIC_REVIEW_HIGHLIGHTER_ENGINE=native` only when you explicitly want to test the native Shiki engine.

Inspect the resolved Expo config for a variant:

```bash
vp run config:dev
vp run config:preview
```

Run static checks for mobile native code:

```bash
node ../../scripts/mobile-native-static-check.ts
```

The native lint task runs SwiftLint for Swift plus ktlint and detekt for Kotlin. Missing native tools are reported as warnings and skipped locally. CI installs the default toolset from `apps/mobile/Brewfile` before running the native checks.

## EAS Builds

CI uses Expo fingerprinting with the `preview:dev` profile to reuse an existing compatible build when possible, or start a new internal EAS build when native runtime inputs change. Production and default local builds continue to use the `appVersion` runtime policy.

### EAS environment variables

EAS build servers read the EAS-hosted environment, **not this checkout**. `eas build`
archives the project with git, so every gitignored file — including the repository-root
`.env` and `.env.local` — is absent on the builder. Anything `app.config.ts` needs must
therefore exist in the EAS environment for `production`, `preview`, and `development`:

| Variable                       | Missing it means                                                 |
| ------------------------------ | ---------------------------------------------------------------- |
| `PYLON_EAS_PROJECT_ID`         | `extra.eas.projectId` is null and **`updates.enabled` is false** |
| `PYLON_EAS_OWNER`              | no `owner` in the manifest                                       |
| `T3CODE_CLERK_PUBLISHABLE_KEY` | Pylon Connect UI is omitted entirely                             |
| `T3CODE_CLERK_JWT_TEMPLATE`    | Pylon Connect UI is omitted entirely                             |
| `T3CODE_RELAY_URL`             | Pylon Connect UI is omitted entirely                             |

List or set them with:

```bash
eas env:list preview
eas env:create --name PYLON_EAS_PROJECT_ID --value <id> \
  --environment production --environment preview --environment development \
  --visibility plaintext --type string --scope project --force
```

All of these are public identifiers — the project ID ships inside every app's update
URL — so they are plaintext variables, not secrets.

**Both failures are silent.** A build missing the Clerk or relay values renders no error
and no empty state; `hasCloudPublicConfig()` simply omits every Connect surface, so the
app reads as though it never had the feature. A build missing `PYLON_EAS_PROJECT_ID`
installs and runs normally but can never receive an over-the-air update, because Expo
disabled the update client at build time. In CI the project ID fails louder: every `eas`
command reports "EAS project not configured".

Verify a finished build rather than assuming, by reading the manifest baked into the
artifact:

```bash
unzip -qo <build>.ipa -d /tmp/ipa
node -e 'const c=require("/tmp/ipa/Payload/PylonPreview.app/EXConstants.bundle/app.config");
  console.log("updates:", JSON.stringify(c.updates), "| projectId:", c.extra?.eas?.projectId);
  console.log("connect:", Boolean(c.extra?.clerk?.publishableKey && c.extra?.relay?.url))'
```

### Installing a build on a device

Internal-distribution builds install straight from the build page in **Safari** on the
device — no Expo Go or Orbit needed — provided the device UDID is on the provisioning
profile. Open the URL that `eas build` prints, or scan its QR code.

### Over-the-air updates

An update only reaches a binary whose `runtimeVersion` matches, so publish with the same
policy the target build used. The `preview:local` profile pins `appVersion`, so:

```bash
APP_VARIANT=preview MOBILE_VERSION_POLICY=appVersion \
  eas update --branch preview --environment preview --platform ios --message "..."
```

Publishing under the default `fingerprint` policy instead produces a runtime version no
`appVersion` build will ever match, and the update silently never lands. `eas
update:roll-back-to-embedded` reverts a channel to the bundle inside the binary, which is
also the quickest way to test whether a published bundle caused a regression.

Create a PR preview dev-client build manually:

```bash
vp run eas:ios:preview:dev
```

Create a cloud dev-client build:

```bash
vp run eas:ios:dev
```

Create a persistent preview build:

```bash
vp run eas:ios:preview
```

Android equivalents:

```bash
vp run eas:android:dev
vp run eas:android:preview:dev
vp run eas:android:preview
```
