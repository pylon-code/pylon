# Pylon docs

## Using Pylon

- [Install Pylon](./user/install.md)
- [Welcome wizard](./user/welcome-wizard.md)
- [Messages and context](./user/composer.md)
- [Working with threads](./user/thread-sidebar.md)
- [Status indicators](./user/status-indicators.md)
- [Mobile thread status](./user/mobile-thread-status.md)
- [Files in question answers](./user/question-attachments.md)
- [Revert a conversation](./user/conversation-rollback.md)
- [Permission modes](./user/permission-modes.md)
- [Terminal history](./user/terminal.md)
- [Source control](./user/source-control.md)
- [Project settings](./user/project-settings.md)
- [Settings](./user/settings.md)
- [Appearance and themes](./user/appearance.md)
- [Keyboard shortcuts](./user/keybindings.md)
- [Keyboard focus](./user/keyboard-focus.md)
- [SnapShots](./user/snap-shot.md)
- [Browser snapshots for agents](./user/browser-snapshots.md)
- [Import browser sessions](./user/browser-import.md)
- [Choose where links open](./user/opening-links.md)
- [Usage and limits](./user/usage.md)
- [Product usage data](./user/telemetry.md)
- [Remote access](./user/remote-access.md)
- [Mobile notifications](./user/mobile-notifications.md)
- [Running in the background](./user/background-service.md)
- [Updating Pylon](./user/updating.md)
- [Triaging a broken install](./user/triage.md)
- Provider guides: [Codex](./user/providers-codex.md) · [Claude](./user/providers-claude.md) · [OpenCode](./user/providers-opencode.md) · [Antigravity](./user/providers-antigravity.md) · [Prime Agent](./user/providers-prime-agent.md)

---

## Working on Pylon

Start with the [development runbook](./operations/development.md) and
[contribution policy](../CONTRIBUTING.md).

Internal notes preserve architectural decisions, constraints, and implementation traps that the
source alone does not explain. Most code changes do not need an internal documentation update. Follow the
[documentation rules](../AGENTS.md#documentation) before adding one.

- [Architecture overview](./internals/overview.md)
- [Glossary](./internals/glossary.md)
- [Connection runtime](./internals/connection-runtime.md)
- [Live update buffers](./internals/live-updates.md)
- [Providers](./internals/providers.md)
- [Model classification](./internals/model-manifest.md)
- [Exact conversation rollback](./internals/rollback-recovery.md)
- [Remote environments](./internals/remote.md)
- [Server updates](./internals/server-updates.md)
- [Resource telemetry](./internals/resource-telemetry.md)
- [Product analytics](./internals/product-analytics.md)
- [Environment auth](./internals/environment-auth.md)
- [Pylon Connect](./internals/t3-connect.md)
- [Assistant citations](./internals/assistant-citations.md)
- [Mobile navigation](./internals/mobile-navigation.md)
- [Mobile development lifecycle](./internals/mobile-development.md)
- [Terminal runtime](./internals/terminal-runtime.md)
- [Voice input](./internals/voice-input.md)
- [Linux window capture](./internals/linux-snap-shot.md)
- [Dev container](./internals/devcontainer.md)
- [Prime Agent daemon parity](./internals/prime-agent-daemon-parity.md)
- [Prime Agent native parity](./internals/prime-agent-native-parity.md)
- [Prime Agent distribution verification](./internals/prime-agent-distribution-verification.md)
- [Prime Agent managed installation](./internals/prime-agent-managed-install.md)
- [Prime Agent integration investigation](./internals/prime-agent-integration.md)

### Runbooks

- [Development and local builds](./operations/development.md)
- [Pylon Connect setup](./operations/connect-setup.md)
- [Release](./operations/release.md)
- [Model manifest publishing](./operations/model-manifest.md)
- [Observability](./operations/observability.md)
- [Relay observability](./operations/relay-observability.md)
- [Android notifications](./operations/android-notifications.md)
- [Prime Agent managed rollback](./operations/prime-agent-managed-rollback.md)
- [Prime artifact graduation](./operations/prime-artifact-graduation.md)
- [Rollback manual recovery](./operations/rollback-manual-recovery.md)
- [Mobile app store screenshots](./operations/mobile-app-store-screenshots.md)
