# Pylon Connect setup

Deployment and client configuration for Pylon Connect. The [architecture note](../internals/t3-connect.md)
explains the trust boundaries; the [relay README](../../infra/relay/README.md#deployment) owns relay
provisioning instructions, and the [release runbook](./release.md#pylon-connect-relay-deployment)
lists the deployment credentials.

## Public application configuration

Pylon Connect is disabled in a fresh clone. [`.env.example`](../../.env.example) documents the
public variables. To enable Connect in a source build, set them in the repository-root `.env` or
`.env.local`:

```dotenv
T3CODE_CLERK_PUBLISHABLE_KEY=<publishable key>
T3CODE_CLERK_JWT_TEMPLATE=<JWT template name>
T3CODE_CLERK_CLI_OAUTH_CLIENT_ID=<public OAuth application client ID>
T3CODE_RELAY_URL=https://relay.example.com
```

Process variables take precedence over `.env.local`, then `.env`. Use these canonical names;
the build loader supplies framework-specific `VITE_*` and `EXPO_PUBLIC_*` aliases. These values are
public identifiers. `CLERK_SECRET_KEY` belongs only in the relay's secrets, never in client
configuration or a build artifact.

Client and bundled-server builds embed the public values, so set them before building. When any
client-facing value is absent, every Connect surface is omitted without an error or empty state.
Bundled servers also accept runtime overrides for operator-managed deployments.

EAS build servers read their own environment store, not the checkout's gitignored `.env`. The
GitHub `production` environment stays the source of truth: `mobile-eas-production.yml` mirrors its
values into the EAS `production`, `preview`, and `development` environments before building. Both
mobile workflows then run `scripts/verify-mobile-connect-config.ts`, which fails the job when the
resolved app manifest lacks the Clerk publishable key, JWT template, or relay URL. Without that
check, a misconfigured build looks like an app that never had Connect.

Copy `infra/relay/.env.example` to `infra/relay/.env` for relay deployment settings.
Deploy `prod` before personal stages because it owns the retained Neon project that their branches
fork from. The deploy wrapper writes the resulting relay URL back to the root `.env`.

## CLI OAuth application

In Clerk's OAuth applications settings:

1. Create a public OAuth application for the Pylon CLI, using authorization-code exchange with PKCE.
2. Allow both redirect URIs: `http://127.0.0.1:34338/callback` and
   `https://app.pylon-code.com/connect/callback`. A custom `T3CODE_HOSTED_APP_URL` needs its own
   `/connect/callback` URL. Headless and SSH authorization depend on the hosted redirect.
3. Enable the `openid`, `profile`, and `email` scopes.
4. Set `T3CODE_CLERK_CLI_OAUTH_CLIENT_ID` to the generated public client ID in local and release
   build environments.

## JWT template

Create a Clerk JWT template named `t3-relay` with claims:

```json
{ "aud": "t3-code-relay" }
```

Set `T3CODE_CLERK_JWT_TEMPLATE=t3-relay` for clients and
`CLERK_JWT_AUDIENCE=t3-code-relay` for the relay. The production relay deployment environment
also defines `CLERK_JWT_TEMPLATE`. The audience stays the same across relay stages; the relay
URL selects the deployment.

## Desktop OAuth redirects

Enable Clerk's Native API and add the desktop redirects to its SSO redirect allowlist:

```text
pylon-code-dev://app/
pylon-code://app/
```

Add the corresponding origin to the Clerk instance's Backend API `allowed_origins` array.
Development uses `pylon-code-dev://app`; production uses `pylon-code://app`. The Dashboard has no
control for this array, so update it through the Backend API, preserving existing entries:

```sh
curl -X PATCH https://api.clerk.com/v1/instance \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $CLERK_SECRET_KEY" \
  -d '{"allowed_origins":["pylon-code://app"]}'
```

The Clerk Electron integration handles token persistence and system-browser callback delivery.

## Desktop passkeys

For the production macOS app with bundle ID `com.pylon.code`:

1. Create an explicit macOS App ID in the Apple Developer portal with **Associated Domains**.
2. Create a provisioning profile for that App ID and the distribution signing certificate.
3. In Clerk's Native API settings, add an iOS app with the same Apple Team ID and bundle ID.
   This setting also configures Electron/macOS passkeys.
4. Check `https://<frontend-api>/.well-known/apple-app-site-association`. Its
   `webcredentials.apps` must include `<TEAM_ID>.com.pylon.code`.
5. Configure signing as described in the [release runbook](./release.md#2-apple-signing--notarization-setup-macos).

Local signed builds additionally use:

```dotenv
T3CODE_APPLE_TEAM_ID=ABC1234567
T3CODE_MACOS_PROVISIONING_PROFILE=/absolute/path/to/pylon.provisionprofile
# Override only when the RP domain differs from the Clerk Frontend API hostname.
T3CODE_CLERK_PASSKEY_RP_DOMAINS=example.clerk.accounts.dev,clerk.example.com
```

Without the override, the build derives the RP domain from the Clerk publishable key. Signed
macOS builds fail early when the Team ID, provisioning profile, or RP domain is missing.
After changing Associated Domains, bump the build version before rebuilding. macOS can otherwise
reuse stale Shared Web Credentials metadata for the same app/version pair.

The ordinary `dev:desktop` launcher is unsigned and cannot exercise macOS passkeys. For renderer
HMR, install a signed build, start `vp run dev:web`, and launch the installed executable with the
actual web and server ports. For example, with the default ports:

```sh
VITE_DEV_SERVER_URL=http://127.0.0.1:5733 \
T3CODE_PORT=13773 \
  "/Applications/Pylon (Alpha).app/Contents/MacOS/Pylon (Alpha)"
```

Rebuild the signed app after native dependency, main-process, preload, entitlement, provisioning,
or signing changes. Renderer edits can reuse it. Verify the installed bundle before testing:

```sh
codesign --verify --deep --strict "/Applications/Pylon (Alpha).app"
codesign -d --entitlements :- "/Applications/Pylon (Alpha).app"
```

## Mobile native redirects

Mobile does not use `allowed_origins`, which covers browser-like stacks such as Electron. Clerk's
native authentication view validates redirects against a separate resource: **Native applications
→ Allowlist for mobile SSO redirect**. Patching `allowed_origins` does not affect it.

On iOS the view derives its redirect from the bundle identifier, not the app's URL scheme, so each
variant needs its own entry in that allowlist:

```text
com.pylon.code://callback
com.pylon.code.preview://callback
com.pylon.code.dev://callback
```

The Backend API is additive, so adding one entry cannot disturb the others:

```sh
curl -X POST https://api.clerk.com/v1/redirect_urls \
  -H "Authorization: Bearer $CLERK_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"com.pylon.code.preview://callback"}'
```

`GET /v1/redirect_urls` lists the current entries and `DELETE /v1/redirect_urls/<id>` removes one.

A missing entry fails at the end of sign-in, not at launch. Clerk's error names the rejected
redirect URI; copy that exact string into the allowlist rather than deriving it. These callbacks are
bundle and package identifiers such as `com.pylon.code.preview`, separate from the `pylon-code`
URL schemes used by desktop and mobile navigation.

### Android native sign-in redirects

Clerk's native Android SDK uses `clerk://<applicationId>.callback`. In the Clerk instance selected
by the app's publishable key, add each Android package you build to the same allowlist:

| Variant     | Callback                                  |
| ----------- | ----------------------------------------- |
| Development | `clerk://com.pylon.code.dev.callback`     |
| Preview     | `clerk://com.pylon.code.preview.callback` |
| Production  | `clerk://com.pylon.code.callback`         |

Preserve existing entries. A private development build that uses the production Clerk key still
needs its development callback allowed by that instance's administrator; rebuilding the same
package does not change the allowlist.

## Desktop sign-in breaks after a Clerk UI release

Desktop loads Clerk's UI from Clerk's CDN at the floating `@clerk/ui@1` range; see the
[architecture note](../internals/t3-connect.md#desktop-clerk-ui-is-not-pinned) for why. If desktop
sign-in breaks and the renderer console shows a Clerk UI load or render failure, suspect a Clerk
release before a Pylon change:

1. Resolve what the range points at now: `npm view '@clerk/ui@1' version`.
2. Compare it against the last version known to work.
3. To pin as a stopgap, pass `__internal_clerkUIVersion` to the Electron `ClerkProvider` in
   [`ElectronManagedAuthShell.tsx`](../../apps/web/src/components/clerk/ElectronManagedAuthShell.tsx).
   A pin existed until 2026-08-27 (`pingdotgg/t3code#8248`, Pylon `#108`), so git history has its
   shape.

An automatic passkey prompt when the sign-in surface opens is the regression the original pin
prevented. Treat its return as a Clerk UI regression.

## Restricting sign-ups

Use Clerk's allowlist for permitted email addresses or domains, or Restricted mode for invitation-only
sign-up. An enabled empty allowlist blocks all new sign-ups.

Sign-up restrictions do not revoke an existing account's access. Ban the account in Clerk when
its active sessions and future sign-ins must be disabled.
