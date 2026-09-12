---
name: test-pylon-app
description: Run or test Pylon web in isolated state, including browser pairing and fixture recovery.
---

# Test Pylon App

Use isolated `.t3` or a task-owned temporary base directory. Never run a test server against, seed, or delete the live `~/.pylon-code` or `~/.t3` runtime homes. Browser use follows the authorization in `AGENTS.md`.

- To start or pair a web client, read [launch and pairing](references/launch-and-pairing.md). Reuse a healthy task-owned server/browser before starting another.
- For SQLite discovery or fixture edits, read [SQLite fixtures](references/sqlite-fixtures.md). Stop the test server before direct writes; use application commands for business/projection correctness and the auth CLI for sessions.
- For simulator/emulator testing, use [test-pylon-mobile](../test-pylon-mobile/SKILL.md).

Preserve the same process, base directory, actual ports, browser context and fixtures across an active user iteration loop. An assistant turn ending is not a teardown signal. If the server exits, restart against the same isolated base; mint a fresh pairing token only when needed.

Pairing tokens are secret, short-lived, and single-use. Give a separate fresh full URL for an explicit human handoff and never consume the person's token yourself. Otherwise exclude credentials from reports and screenshots. Startup tokens carry admin scopes; replacement `pair` tokens carry standard client scopes.

Verify the affected flow and report the observed result. Once the overall task is complete with no pending inspection, or the user requests teardown, stop only the owned process. Preserve useful reproduction state; remove only verified task-created paths. If the user is still inspecting, retain the environment and report its non-secret URL.
