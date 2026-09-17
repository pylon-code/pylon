---
name: pylon-delegation
description: Decide between local work, built-in subagents, and Pylon child threads; run and review Pylon delegation without unnecessary context, polling, or duplicate work. Use when choosing a delegation route or managing Pylon delegation tools.
---

# Pylon delegation

## Choose the route

Keep small or tightly coupled work local. For worthwhile independent work, follow the current preferred delegation method supplied by `read_delegation_skill`: **built-in** (default) or **pylon**. When reading this repo file directly, call that tool before choosing the route; the file does not contain the user's current preference. A saved Pylon preference permits Pylon child threads without a separate request every time. Explicit user instructions override the preference, including requests to stay local or use a particular method. Enabling Pylon delegation alone is availability, not a request to use it. With the built-in preference, missing built-in agents are not a reason to fall back to Pylon.

Delegation adds briefing, startup, and review costs. Identify the independent deliverable and useful work the parent can do concurrently; avoid delegating a tiny change just to exercise the feature unless explicitly asked to test it. Do not promise token savings without measured evidence.

## Prepare one bounded task

Specify the objective, relevant files, acceptance checks, exclusions, and a short final report of changes, checks, and unresolved issues. Pass only necessary context, not the full conversation. Avoid overlapping edits or doing the same work as the child.

Omit `providerInstanceId`, `model`, and `runtimeMode` unless the user requested them. Pylon applies the configured defaults and reports the selected provider/model. Never guess provider IDs or model names from caches. Missing or unavailable defaults require the user's choice in **Settings → Integrations → Pylon delegation**; available providers/models appear in **Settings → Providers**. A child cannot have broader permissions than its parent.

A child gets its own worktree; uncommitted parent changes are not a handoff mechanism. With **Start from origin**, even committed but unpushed changes can be absent; check `startedFromOrigin`. Identify the exact target commit or diff and review base in the brief, make them accessible to the child, and require its report to confirm the reviewed revision. Project setup scripts do not run; supply necessary setup instructions. Children cannot delegate further.

## Run, wait, review

1. Call `delegate_thread` with a stable `delegationKey`. Reuse that key on uncertain retries to avoid duplicate children. A reused key does not start new work; use `send_to_delegated_thread` for follow-ups.
2. Do independent work first. When waiting is necessary, call `delegated_thread_status` with `waitSeconds: 45`. Completed or blocked children return immediately. Avoid short polling, repeated inspections of unfinished files, and unchanged progress updates. There is no automatic parent wake-up: if ending the turn before completion, report the child as pending.
3. If approval or user input is pending, surface the blocker and direct the user to the child thread. Do not loop on immediately returning status calls. Inspect errors before retrying; do not blindly spawn replacements.
4. At completion, read `delegated_thread_result`. Expand a truncated result with `maxChars` before accepting it; at the 60,000-character maximum, inspect the child thread or request a concise handoff. Review the actual completed diff and relevant checks. A child's claim of success is not verification. Merge only within the user's authorization; nothing merges automatically.
5. Send one consolidated correction using `send_to_delegated_thread` and a stable `messageKey`. Running children reject feedback; it is not queued. Wait for completion unless an urgent correction justifies `interrupt_delegated_thread`, then wait until idle before sending it. If a message key was consumed by a rejected attempt, use a new key as instructed by the error.

## Availability and controls

The MCP server provides this skill through `read_delegation_skill`; read it when choosing a method for a new task, not before every status call. If delegation tools are unavailable, continue locally or explain how to enable them; do not install another orchestrator automatically.

**Settings → Integrations → Pylon delegation** controls availability, preferred delegation method, default model, and child permissions globally or per project. Availability changes apply at the next session start. While off, the saved Pylon preference is inactive. Turning it off does not stop existing children or disable built-in subagents; stop a child in its thread. Provider usage is charged to each child's account. Pylon does not yet show a combined billed cost or enforce a delegation token budget.
