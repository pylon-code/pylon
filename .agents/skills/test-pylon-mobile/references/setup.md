# Mobile environment and launch

Paths and commands are relative to repository root unless stated otherwise. Read only the selected platform subsection. POSIX examples need PowerShell equivalents on Windows.

## Choose the lightest valid launch path

- For JavaScript, TypeScript, or asset-only changes, reuse a compatible installed development client and start Metro. Do not rebuild native code merely to load a new bundle.
- For native source, native dependencies, entitlements, config plugins, or generated project changes, rebuild the affected platform.
- Use `vp run ios:dev` or `vp run android:dev` only when an Expo clean prebuild is actually required; both commands regenerate the native project.
- If the user requested no native rebuild and no compatible app is installed, reuse an existing compatible `.app` or `.apk` artifact when available. Otherwise report the missing dev client instead of silently rebuilding.

The development identity on both platforms is:

- App: `Pylon Dev`
- Bundle/package identifier: `com.pylon.code.dev`
- URL scheme: `pylon-code-dev`

These are Pylon-owned, not compatibility-named. `app.config.ts` is the source of
truth, and a built `PylonDev.app` registers exactly `pylon-code-dev` and
`com.pylon.code.dev`. `App.tsx`'s linking prefixes and the `dev:client` scripts
match those schemes. iOS never delivers an unregistered scheme, so a
`simctl openurl` naming one fails silently rather than erroring — check the
registered list with `plutil -extract CFBundleURLTypes json -o - <app>/Info.plist`
before assuming a deep link is broken.

Bundle or package presence proves the correct variant, not native compatibility. Reuse it only when the current changes did not alter its Expo SDK, native dependencies, config plugins, entitlements, generated project, or native source.

## Start one disposable Pylon environment

Run backend commands from the repository root. Use the ignored, worktree-local `.t3` directory or create a fresh directory with the host OS's temporary-directory mechanism. An explicit base directory stores state in `<base-dir>/userdata`; never point testing at shared `~/.t3` state.

Seed a small number of meaningful Git projects before starting the backend:

```bash
node apps/server/src/bin.ts project add <git-workspace> \
  --base-dir <base-dir> \
  --title <project-title>
```

Running `project add` before the backend starts gives it exclusive offline database access. If a backend is already running, wait until it is ready so the CLI dispatches through the live server; never run offline mutations concurrently with the server.

Use direct SQLite mutation only for disposable projection fixtures. Read [SQLite fixtures](../../test-pylon-app/references/sqlite-fixtures.md) and stop the backend before writing.

Start a headless backend after seeding:

```bash
node apps/server/src/bin.ts serve \
  --host 127.0.0.1 \
  --port <server-port> \
  --base-dir <base-dir> \
  --no-browser
```

Use these client origins:

- iOS Simulator: `http://127.0.0.1:<server-port>`
- Android Emulator: `http://10.0.2.2:<server-port>`
- Physical device: bind the backend to `0.0.0.0` and use the host's reachable LAN origin

Enter the complete `http://` origin to make the test transport explicit. Bare IP addresses default to HTTP, while bare hostnames default to HTTPS. When testing web and mobile together, run `vp run dev --home-dir <base-dir> --host 127.0.0.1` instead and do not launch a second backend over the same base directory.

## Start or reuse Metro safely

Run Metro from `apps/mobile`.

1. Inspect any process on the intended Metro port and its `/status` response. Reuse it only when it is healthy, belongs to this worktree, and matches `APP_VARIANT=development`, `--dev-client`, and scheme `pylon-code-dev`.
2. Never kill another worktree's Metro. Use a free explicit port when necessary.
3. Run `vp run dev:client` on the standard port. For another port, retain the complete development identity:

   ```bash
   APP_VARIANT=development vp exec expo start \
     --dev-client \
     --scheme pylon-code-dev \
     --clear \
     --lan \
     --port <metro-port>
   ```

   In PowerShell, set `$env:APP_VARIANT = "development"` first and then run the `vp exec expo start ...` command without the leading assignment.

4. Open the exact development-client URL for the selected device and confirm the loaded bundle belongs to this worktree and Metro port.

### iOS launch

Use `ios-debugger-agent` to select one UDID and set these XcodeBuildMCP session defaults:

- Workspace: `<repo>/apps/mobile/ios/PylonDev.xcworkspace`
- Scheme: `PylonDev`
- Configuration: `Debug`
- Simulator ID: the selected UDID
- Bundle ID: `com.pylon.code.dev`

Check the installed client with:

```bash
xcrun simctl get_app_container <simulator-udid> com.pylon.code.dev app
xcrun simctl openurl <simulator-udid> <printed-dev-client-url>
```

Accept the iOS confirmation prompt and dismiss the developer menu when it obscures the app.

### Android launch

Select one running emulator serial from `adb devices` and check the installed client:

```bash
adb -s <emulator-serial> shell pm path com.pylon.code.dev
adb -s <emulator-serial> reverse tcp:<metro-port> tcp:<metro-port>
adb -s <emulator-serial> shell am start -W \
  -a android.intent.action.VIEW \
  -d '<printed-dev-client-url>' \
  com.pylon.code.dev
```

Do not start, stop, erase, or reconfigure an emulator owned by another task. Track and later stop only processes owned by this test.

## Pair each client once

Use the bundled helper from the repository root. It issues a fresh credential against the running backend's exact base directory, opens the existing Add Environment route with the credential in an encoded query parameter, and asks that route to connect once:

```bash
.agents/skills/test-pylon-mobile/scripts/pair-client.sh \
  ios <simulator-udid> <server-port> <base-dir>

.agents/skills/test-pylon-mobile/scripts/pair-client.sh \
  android <emulator-serial> <server-port> <base-dir>
```

Run only the command for the selected platform. The helper uses `http://127.0.0.1:<server-port>` for iOS and `http://10.0.2.2:<server-port>` for Android. Pass a fifth argument only when testing a non-development URL scheme.

The helper opens this registered route:

```text
pylon-code-dev://connections/new?pairingUrl=<encoded-pairing-url>&autoConnect=1
```

The Add Environment route owns the behavior: `pairingUrl` prefills its normal host and token inputs, while `autoConnect=1` submits once in development builds and returns to Home after success. Without `autoConnect`, the same route only prefills the form for manual inspection.

Do not enter pairing hosts or tokens through simulator keyboard automation. Xcode's semantic typer sends HID-style key events through the simulator's active keyboard state, which can corrupt uppercase tokens and punctuation even when the host Mac uses a U.S. input source. The one-shot route is the deterministic pairing path. Use the visible form only as a fallback, and paste credentials rather than typing them character by character.

The fallback form lives in the development client, named `Pylon Dev`: open Add Environment and paste the complete `<mobile-origin>` and newly printed `Token`.

Verify the expected seeded projects appear before exercising the affected flow.

Pairing credentials are secret, short-lived, and single-use. Create a different credential for every simulator, emulator, physical device, or browser. If an attempt fails, issue a new credential rather than retrying the old one. Do not expose tokens in screenshots, commits, or final responses.
