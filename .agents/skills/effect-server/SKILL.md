---
name: effect-server
description: Implement and review Pylon server changes with the repository's Effect and event-sourced architecture. Use when changing `apps/server`, Effect services or layers, orchestration commands and events, deciders, projectors, reactors, receipts, provider adapters, server-side contracts, persistence, or focused backend tests.
---

# Effect Server Work

Keep orchestration pure, put provider-specific complexity at adapter boundaries, and use typed Effect services and errors consistently with the vendored version of Effect.

## Load the local conventions first

Before writing Effect code, read `.repos/effect-smol/LLMS.md` completely. It documents the repository's vendored Effect APIs and takes precedence over recalled upstream patterns.

For orchestration work, also read the relevant sections of `docs/internals/glossary.md` and inspect the neighboring implementation and tests. Never edit or import from `.repos/`; it is a read-only reference.

## Locate the correct boundary

- Put wire schemas and small derived helpers in `packages/contracts`.
- Put pure command-to-event decisions in the decider and enforce command preconditions at the invariant boundary.
- Put event-to-read-model behavior in projectors and projection pipelines.
- Put asynchronous side effects in queue-backed reactors that emit typed receipts.
- Put provider protocol translation and provider-only edge cases in the matching adapter.
- Keep web and mobile clients driven by projected contracts rather than server internals.

Trace an existing analogous feature end to end before introducing a new abstraction. Prefer the smallest model that makes valid state transitions unsurprising.

## Implement with Effect

- Follow the service, layer, schema, error, resource, and testing forms in `.repos/effect-smol/LLMS.md`.
- Preserve inferred types. Do not introduce `any` or redundant annotations to silence inference problems.
- Model expected failures as typed errors. Do not collapse domain failures into generic exceptions at inner layers.
- Acquire and release resources through Effect scopes. Do not hide long-lived processes or listeners outside the owning layer.
- Keep runtime execution at application boundaries; compose Effects inside services rather than calling runners throughout domain code.
- Preserve observability and cancellation behavior when wrapping subprocesses, streams, queues, or network operations.

## Cover the complete change

For a contract or provider-shaped change, explicitly check:

- command and event schemas;
- invariants and reverse transitions;
- decider and projector behavior;
- persistence or migration impact;
- relevant reactors and receipts;
- Codex, Claude, Cursor, Grok, and OpenCode adapter support;
- web, desktop, mobile, local, remote/relay, and tunnel consumers;
- user, internals, operations, and glossary documentation where applicable.

Record an explicit "not supported" decision when a provider or surface cannot implement the behavior. Do not silently omit it.

## Verify backend behavior

- Add or update focused tests for behavior changes.
- Wait for typed receipts and worker drains. Never make an async test pass by adding sleeps, polling, or arbitrary timeouts.
- Run the smallest relevant test files with `vp test run <files>` and targeted lint/typecheck for touched packages.
- Do not run repository-wide checks unless the developer asks.
- If a wire contract changed, typecheck every directly affected consumer package.
