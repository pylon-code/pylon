---
name: test-pylon-mobile
description: Verify Pylon Mobile on an iOS Simulator or Android Emulator with isolated backend state.
---

# Test Pylon Mobile

Verify the affected mobile flow against task-owned disposable Pylon state. Use the affected platform; for cross-platform changes choose one representative device unless the risk warrants both. If no viable SDK/device exists, report the missing prerequisite without claiming a pass. Browser/computer use retains `AGENTS.md` authorization.

Read [setup](references/setup.md) for native compatibility, backend/Metro ownership, platform launch commands and one-use client pairing. Reuse a compatible installed dev client for JS/assets; rebuild for native changes. A matching bundle ID alone does not prove compatibility. Honor an explicit no-rebuild instruction.

Never use live `~/.pylon-code` or `~/.t3` state. Keep one backend per base directory and verify the actual worktree, variant, ports and seeded projects before diagnosing product behavior. Every client needs a separate secret pairing credential; use `scripts/pair-client.sh` rather than typing tokens through simulator keyboards.

- **iOS:** use [ios-debugger-agent](../ios-debugger-agent/SKILL.md) with one explicit UDID and current accessibility element references. For requested live viewing, use [ios-simulator-browser](../ios-simulator-browser/SKILL.md) on the same UDID.
- **Android:** prefer semantic automation; otherwise inspect current `uiautomator` hierarchy and use device-scoped `adb` actions. Capture the final state with `adb exec-out screencap -p`. A new streaming infrastructure is unnecessary for screenshots.
- For launch, pairing, CocoaPods, stale UI or accessibility failures, read the matching entry in [troubleshooting](references/troubleshooting.md).

Prove the app connected to the intended environment and exercise the changed behavior. Capture the relevant final state. At the end of the testing loop, remove the disposable client connection and owned `adb reverse` rule, stop only processes started for this test, and preserve useful reproduction artifacts. Retain the environment while the user is still inspecting it. Physical iPhone delivery/EAS belongs to [ship-pylon-mobile](../ship-pylon-mobile/SKILL.md).
