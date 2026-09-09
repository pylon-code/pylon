# Android notifications

The Android app receives Firebase Cloud Messaging (FCM) data messages. The Pylon Connect relay sends
them directly through FCM HTTP v1; an Expo Push account is not required.

Nothing here is provisioned by default. Until a Firebase project, an Android build with its Google
services file, and the relay's `FCM_SERVICE_ACCOUNT` secret all exist, the relay logs that Android
notifications are not configured and skips Android deliveries. iOS delivery is unaffected.

## Android compatibility and automated checks

The app's minimum is Android 7.0 (API 24), declared in `apps/mobile/app.config.ts` and enforced by
the relay's device-registration schema. Compile and target SDK versions follow the locked
Expo/React Native toolchain (currently API 36). Notification channels begin at API 26; the
notification permission prompt begins at API 33. Live Update promotion requires API 36 and remains
subject to system settings and device support. Alerts and ordinary activity cards work below API 36.

API 24–25 use a single inexact system alarm to expire cards after process exit, with no exact-alarm
permission. Android can delay that alarm in power-saving modes. API 26+ use notification timeouts.
Disabling activity, dismissal, account changes and sign-out cancel the legacy alarm. A stale expiry
broadcast cannot remove a newer run's card.

The native notification tests cover API 24, 26, 33 and 36 (plus API 25 for legacy expiry) using
Robolectric. To compile the module, run these tests and run Android lint, use the following command
from a generated `apps/mobile/android` project with JDK 21 available. No Firebase, signing or relay
secrets are required:

```sh
./gradlew :t3-agent-notifications:testDebugUnitTest :t3-agent-notifications:lintRelease -Pandroid.lint.useK2Uast=false
```

Robolectric's API 36 runtime requires JDK 21; module compilation still uses Expo's Java 17
toolchain. The Mobile Native Static Analysis job separately runs ktlint and detekt. The native
module and its Expo config changes alter the runtime fingerprint, so this needs a new binary; an OTA
update cannot deliver it to an older one. Settings disable Android notifications if the installed
native module is missing required methods.

The lint command uses the K1 frontend because AGP's K2 frontend crashes while analyzing Worklets
0.10's Gradle Kotlin scripts. This does not disable lint checks. Live Update eligibility must be
verified on a device: Robolectric's API 36 image implements older promotion rules that require
colorization, while shipped Live Updates require uncolorized notifications.

## Firebase and app build

1. Create a Firebase project owned by the Pylon maintainers and register each Android application
   identifier you intend to build: `com.pylon.code.dev`, `com.pylon.code.preview`, or
   `com.pylon.code`.
2. Download `google-services.json`. Set `T3CODE_ANDROID_GOOGLE_SERVICES_FILE` to its path when
   running Expo prebuild and building the app. The JSON must contain the selected variant's package
   identifier. Never commit it.
3. Create a service-account key with permission to send FCM messages for that Firebase project.
   Keep this private JSON outside the repository and the app bundle.
4. Enable the Firebase Cloud Messaging API in the Google project if it is not already enabled. For
   hosted delivery, set the relay's `FCM_SERVICE_ACCOUNT` secret to the service-account JSON.
5. Build a new Android binary. A JavaScript-only update cannot install the native notification
   handler or Firebase configuration. Hosted delivery also needs the relay database migration and
   an updated relay deployment; local verification can use the watcher below.

For a local development build, from `apps/mobile`:

```sh
APP_VARIANT=development \
T3CODE_ANDROID_GOOGLE_SERVICES_FILE=/absolute/path/google-services.json \
vp run android:dev
```

For an EAS build, provide the same configuration through each selected build environment, using an
EAS file variable named `T3CODE_ANDROID_GOOGLE_SERVICES_FILE` for the Google services file. Make the
file available to fingerprint generation as well as the native build. FCM service-account
credentials belong on the relay, not in EAS's app environment. If deploying a separate relay,
configure the build's Pylon Connect public settings for that relay and Clerk application as
described in [Pylon Connect](../internals/t3-connect.md).

Over-the-air updates are already off unless `PYLON_EAS_PROJECT_ID` is set. When it is set, also set
`T3CODE_MOBILE_UPDATES_ENABLED=0` before prebuild and bundling a private binary to keep it off the
configured update channel. A debug development-client APK requires Metro; a bundled release build is
needed to verify cold-start notification taps without Expo's development launcher.

## Clerk sign-in for private builds

Clerk's native Android sign-in uses `clerk://<applicationId>.callback`. In the Clerk instance
selected by the build's publishable key, its administrator must allow the exact callback under
**Native applications > Allowlist for mobile SSO redirect**. For the development package, add:

```text
clerk://com.pylon.code.dev.callback
```

A "redirect url ... does not match an authorized redirect URI" error requires a Clerk configuration
change; rebuilding the same APK does not fix it. Reopen sign-in after the administrator saves the
entry. See [Android native sign-in redirects](../internals/t3-connect.md#android-native-sign-in-redirects)
for the other variants.

A build that uses the production publishable key selects the production Clerk instance; changing its
allowlist requires that instance's administrator. Android device registration and hosted delivery
separately require the relay deployment below. A successful direct-pairing or FCM smoke test does
not verify hosted sign-in or device registration.

Building with `APP_VARIANT=production` selects `com.pylon.code` and its Clerk callback. Set the same
variant during prebuild and bundling, and supply a Google services file that includes that package.
Keep OTA updates disabled for a private binary. A locally signed build with this package cannot
update an installation signed with the release key or coexist with it; removing that installation
also removes its app-local data. The development package remains a separate app.

## Focused delivery check

`infra/relay/scripts/android-push-smoke.ts` sends a message through the production FCM client
implementation without provisioning the relay's database, Clerk integration, or Cloudflare queues.
It verifies only Firebase-to-device delivery.

Provide a private device JSON file containing the app's native FCM `token`, registered `deviceId`,
signed-in `userId`, and Android `packageName`. An optional `deepLink` can target an existing thread
for tap verification. The app must have registered its local native notification handler and have
notification permission. From `infra/relay`:

```sh
vp run push:android:smoke /path/service-account.json /path/device.json running
vp run push:android:smoke /path/service-account.json /path/device.json approval
vp run push:android:smoke /path/service-account.json /path/device.json completed
```

Supported states are `running`, `approval`, `input`, `completed`, `failed`, and `end`. Firebase
acceptance is not proof that a device displayed the message. Check the actual notification,
background the app, and test a notification tap. Also test dismissal, disabling ongoing activity,
sign-out, token rotation, and delivery after the app process has exited. Android Settings
**Force stop** intentionally prevents delivery until the app is opened again.

Android suppresses ordinary alerts while the app is foregrounded, matching iOS notification
presentation. Activity cards still update in the foreground and retain finished results silently.
Check that completion stays quiet with the app open, that a later completion alerts after
backgrounding, and that retrying a foreground-suppressed alert does not show it later. This uses the
app lifecycle on the receiving phone, not thread visibility on other clients.

With ongoing activity enabled, verify two threads entering approval/input together produce one
`2 agents need attention` alert, and two observed active threads completing/failing together produce
one `2 agents finished` alert. The body lists their titles. The relay shares iOS transition
selection and retains its delivered baseline when work finishes; publishing the same states again
must not produce another alert. Grouped alerts open the aggregate's priority thread; individual
alerts retain their thread link.

Verify an expanded card with five threads, attention/failure priority, project names and statuses.
When all work finishes, the card should show **Agent work completed** or **Agent work failed**, lose
its ongoing/promotion flag, and expire 15 minutes after the newest displayed result. Replays must not
extend that deadline. Quiet running work uses the relay's two-hour state lifetime; approval/input
states use 24 hours. Reopen the same signed-in app and confirm existing alerts and dismissal survive,
with a silent aggregate replay on cold start or a foreground after at least 60 seconds. Also check
empty replays remove an orphaned card and completions older than two minutes never alert, even with
ongoing activity disabled.

After Android prebuild, run the native presentation regression tests from `apps/mobile/android`:

```sh
./gradlew :t3-agent-notifications:testDebugUnitTest --tests expo.modules.t3agentnotifications.AgentNotificationsTest
```

## Relay deployment

### Local verification without a hosted relay

You do not need a hosted relay stage to develop Android push. Keep the normal Clerk login and
environment connections. `infra/relay/scripts/android-push-watch.ts` subscribes to one paired
environment's shell stream, uses the shared agent-awareness projection, and sends updates through
the FCM client. It holds transient state in memory and needs no hosted database or Clerk secret.

Create a private `connection.json` containing `wsUrl` (the environment's `/ws` URL) and
`bearerToken` (a normal paired environment access token). Use a separate pairing credential for this
watcher. Supply the same device file described above, then run from `infra/relay`:

```sh
vp run push:android:watch /path/service-account.json /path/device.json /path/connection.json
```

The Android native handler must already be configured with that device and account, and
notifications must be allowed. A native instrumentation harness can configure a disposable emulator
before testing; a signed-in development app configures the handler during device registration. This
watcher is a development transport: it observes all unarchived threads in its paired environment,
enables all alert types, keeps no durable queue, and must stay running. It does not register Android
devices with a hosted relay.

### Hosted delivery

The Alchemy deployment described in the [relay README](../../infra/relay/README.md) provisions the
Cloudflare Worker, the APNs and FCM delivery queues, Hyperdrive, tunnel and DNS resources, the Neon
database, and Axiom observability. It requires credentials for those services and private Clerk
configuration. Set `APNS_ENABLED=false` in an Android-only development relay to skip Apple delivery
and its credential requirements. APNs remains enabled by default.

Hosted delivery adds `RelayFcmDeliveryQueue` and `RelayFcmDeliveryDeadLetterQueue`, and the
`20260906042516_android_devices` relay migration (an `android_api_level` column, with
`ios_major_version` made nullable). Deploying the relay applies both.

#### Personal stage

Non-production stages reference the Neon project owned by the `prod` stage and fork their own
branch, so a personal stage is not a standalone deployment into an unrelated account.

1. Create a private env file, for example `infra/relay/.env.android-dev`, with the Cloudflare, Neon,
   Axiom, domain, and Clerk configuration described in the relay README. Keep
   `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, and `CLERK_JWT_AUDIENCE` on the same Clerk instance
   used by the test clients.
2. Add the Firebase service-account JSON as `FCM_SERVICE_ACCOUNT` and set `APNS_ENABLED=false` for
   an Android-only stage. Leave `RELAY_DOMAIN` unset so the deployment derives a hostname for the
   personal stage instead of using the production hostname.
3. From the repository root, inspect the deployment plan, then deploy the same stage:

   ```sh
   vp run --filter t3code-relay deploy -- --stage dev_android --env-file .env.android-dev --dry-run
   vp run --filter t3code-relay deploy -- --stage dev_android --env-file .env.android-dev
   ```

4. Give the tester the deployed relay URL and matching public Clerk configuration. The deploy
   wrapper also writes the relay URL and public tracing configuration into that checkout's root
   `.env`. Rebuild the private APK with this `T3CODE_RELAY_URL`, the Firebase Android file, and OTA
   updates disabled. If using the development package, authorize its Clerk callback as described
   above.
5. Configure one isolated Pylon server with the same relay URL and link that test environment through
   the new relay. Existing production relay links do not move to a personal stage. Enable activity
   publishing for the test environment, enable notifications on the phone, and verify a real agent
   turn produces a running update and completion alert while the phone is locked.

Build the host client and mobile app with the same relay URL and Clerk public configuration. A
source server or desktop development build can host the test environment; keep its runtime home
separate from an existing installation. Signing into the phone alone does not link a host
environment. Use the host client's Pylon Connect settings to link it and enable activity publishing.
A private Clerk instance also needs its own CLI OAuth application before using `t3 connect login`.

#### Production

`.github/workflows/deploy-relay.yml` passes `FCM_SERVICE_ACCOUNT` from the `production` environment's
secrets to Alchemy. Add that secret there to turn on Android delivery; without it, the deploy
succeeds and Android deliveries are skipped. The release Android build also needs the production
package's `google-services.json` in its native build environment; changing the relay secret alone
cannot move an installed app to another Firebase project.

Android delivery uses `RelayFcmDeliveryQueue` and its dead-letter queue. Failed requests are
retried; messages expire after five minutes. Before sending, the consumer rechecks the device token,
current preferences, environment links, and current thread state. `UNREGISTERED` responses
invalidate only the matching device token. OAuth tokens are cached within the FCM service and
refreshed after an authorization failure.
