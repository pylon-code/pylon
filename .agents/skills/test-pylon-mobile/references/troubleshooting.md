# Mobile troubleshooting

## Troubleshoot predictable failures

- **Old UI or an old error appears:** verify Metro's worktree, variant, URL, and port before diagnosing the app.
- **The environment remains empty:** verify the platform-specific HTTP origin, use a fresh token, and confirm project seeding used the identical base directory.
- **A second client cannot pair:** pairing tokens are single-use; issue another token.
- **The pairing form opens but does not connect:** confirm the deep link uses the existing `connections/new` route, includes `autoConnect=1`, and carries a freshly minted encoded `pairingUrl`.
- **Pairing text changes case or punctuation:** do not retry semantic typing. Use `scripts/pair-client.sh`; the simulator keyboard layout and HID input path are not reliable for credentials.
- **iOS semantic actions fail:** set explicit XcodeBuildMCP defaults and refresh with `snapshot_ui`.
- **A thread, project, or environment row is absent from standard targets:** inspect the full structured `capture.elements` when the MCP client exposes it; otherwise run `npx --yes xcodebuildmcp@2.6.2 ui-automation snapshot-ui --simulator-id <UDID> --output json --verbose`. If the intended row has a current `elementRef` that advertises `touch`, use `touch` with both down and up events, then refresh the snapshot. A successful touch is only an automation fallback, not proof of correct accessibility semantics. When neither a current advertised action nor a registered route exists, report an accessibility blocker; do not guess coordinates.
- **`wait_for_ui` never satisfies `settled`:** an environment the simulator cannot reach retries on a loop, and the resulting spinner means the screen never stops changing. `snapshot_ui` and `screenshot` both still work; use them instead of waiting.
- **A pairing deep link appears to do nothing:** a link delivered while the bundle is still downloading is swallowed. Wait for the app to finish loading and settle on its first screen, then run the helper.
- **`expo prebuild` reports success but `ios/` has no `.xcworkspace`:** the CocoaPods step failed and `prebuild` still exited 0. Read its output rather than its exit code, then run `pod install` from `apps/mobile/ios` yourself.
- **`pod install` dies on `Unicode Normalization not appropriate for ASCII-8BIT`:** CocoaPods 1.17.0 under Ruby 4.0.6 needs a UTF-8 locale, and `prebuild` leaves `LANG`/`LC_ALL` unset. Run it as `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 pod install`.
- **Android cannot reach Metro:** verify `adb reverse` for the exact Metro port and relaunch the development-client URL.
- **Android cannot reach the backend:** use `10.0.2.2`, not `127.0.0.1`, for the Android Emulator.
