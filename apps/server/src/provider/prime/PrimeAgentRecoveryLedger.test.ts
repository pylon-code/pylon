import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import migration050 from "../../persistence/Migrations/050_PrimeAgentRecoveryLedger.ts";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import { make, type PrimeAgentRecoveryAuthority } from "./PrimeAgentRecoveryLedger.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const authority = {
  threadId: "thread-recovery",
  providerInstanceId: "primeAgent",
  sessionIncarnationId: "incarnation-1",
  admissionRequestId: "admission-1",
  turnId: null,
  packageRoot: "/private/prime-package",
  packageVersion: "0.5.1",
  managedBuildId: "managed-build-1",
  sdkFeatures: [
    "recoverable_owned_session_adoption_v1",
    "caller_owned_session_environment_cleanup_v1",
  ],
  daemonCapabilities: [
    "daemon_recoverable_owned_session_adoption_v1",
    "caller_owned_session_environment_cleanup_v1",
    "authoritative_owned_session_cleanup_v1",
  ],
  protocolName: "prime-agent.daemon",
  protocolVersion: 4,
  schemaRevision: 30,
  activeSessionId: "active-1",
  nativeSessionId: "native-1",
  recoveryHandle: "private-handle-1",
  supervisorGeneration: "supervisor-1",
  ownershipGeneration: 0,
  cursor: { generation: "events-1", sequence: 7 },
  correlationId: "correlation-1",
  mcpOwnerId: "pylon:mcp-1",
  recoveryConfig: { cwd: "/private/worktree", model: "anthropic/claude" },
  launchEnvironment: { HOME: "/private/home", PRIME_TOKEN: "private-token" },
  transcriptMessageCount: 2,
  transcriptFingerprints: ["fingerprint-1", "fingerprint-2"],
  ownerToken: "owner-1",
  state: "prepared",
  nativeCleanupProven: false,
  terminalProjected: false,
  checkpointQuiesced: false,
  updatedAt: "2026-01-01T00:00:00.000Z",
} satisfies PrimeAgentRecoveryAuthority;

layer("PrimeAgentRecoveryLedger", (it) => {
  it.effect("CAS-claims one owner and deletes only after all three cleanup proofs", () =>
    Effect.gen(function* () {
      yield* migration050;
      const ledger = yield* make;
      yield* ledger.putPrepared(authority);
      const replacement = yield* Effect.exit(
        ledger.putPrepared({ ...authority, ownerToken: "owner-replacement" }),
      );
      assert.isTrue(Exit.isFailure(replacement));
      assert.equal(
        Option.getOrThrow(yield* ledger.get(authority.threadId)).ownerToken,
        authority.ownerToken,
      );
      assert.isTrue(
        yield* ledger.markAdmitted({
          threadId: authority.threadId,
          ownerToken: authority.ownerToken,
          turnId: "turn-1",
          updatedAt: "2026-01-01T00:00:01.000Z",
        }),
      );

      const firstClaim = yield* ledger.claim({
        threadId: authority.threadId,
        expectedOwnerToken: authority.ownerToken,
        nextOwnerToken: "owner-2",
        updatedAt: "2026-01-01T00:00:02.000Z",
      });
      const competingClaim = yield* ledger.claim({
        threadId: authority.threadId,
        expectedOwnerToken: authority.ownerToken,
        nextOwnerToken: "owner-3",
        updatedAt: "2026-01-01T00:00:02.000Z",
      });
      assert.isTrue(Option.isSome(firstClaim));
      assert.isTrue(Option.isNone(competingClaim));

      assert.isTrue(
        yield* ledger.commitAdoption({
          threadId: authority.threadId,
          ownerToken: "owner-2",
          recoveryHandle: "private-handle-2",
          ownershipGeneration: 1,
          cursor: { generation: "events-1", sequence: 11 },
          mcpOwnerId: "pylon:mcp-2",
          updatedAt: "2026-01-01T00:00:03.000Z",
        }),
      );
      assert.isTrue(
        yield* ledger.updateTranscriptProgress({
          threadId: authority.threadId,
          ownerToken: "owner-2",
          cursor: { generation: "events-1", sequence: 19 },
          messageCount: 3,
          fingerprints: ["fingerprint-1", "fingerprint-2", "fingerprint-3"],
          updatedAt: "2026-01-01T00:00:04.000Z",
        }),
      );
      const adopted = Option.getOrThrow(yield* ledger.get(authority.threadId));
      assert.equal(adopted.recoveryHandle, "private-handle-2");
      assert.deepEqual(adopted.cursor, { generation: "events-1", sequence: 19 });
      assert.equal(adopted.transcriptMessageCount, 3);

      assert.isFalse(yield* ledger.deleteIfSettled(authority.threadId));
      assert.isTrue(
        yield* ledger.markNativeCleanup({
          threadId: authority.threadId,
          ownerToken: "owner-2",
          updatedAt: "2026-01-01T00:00:05.000Z",
        }),
      );
      yield* ledger.markTerminalProjected({
        threadId: authority.threadId,
        updatedAt: "2026-01-01T00:00:06.000Z",
      });
      assert.isFalse(yield* ledger.deleteIfSettled(authority.threadId));
      yield* ledger.markCheckpointQuiesced({
        threadId: authority.threadId,
        updatedAt: "2026-01-01T00:00:07.000Z",
      });
      assert.isTrue(yield* ledger.deleteIfSettled(authority.threadId));
      assert.isTrue(Option.isNone(yield* ledger.get(authority.threadId)));
    }),
  );

  it.effect("skips mutations after a private commit guard retires", () =>
    Effect.gen(function* () {
      yield* migration050;
      const ledger = yield* make;
      yield* ledger.putPrepared(authority, { commitGuard: Effect.succeed(false) });
      assert.isTrue(Option.isNone(yield* ledger.get(authority.threadId)));

      yield* ledger.putPrepared(authority, { commitGuard: Effect.succeed(true) });
      assert.isFalse(
        yield* ledger.markAdmitted(
          {
            threadId: authority.threadId,
            ownerToken: authority.ownerToken,
            turnId: "turn-retired",
            updatedAt: "2026-01-01T00:00:08.000Z",
          },
          { commitGuard: Effect.succeed(false) },
        ),
      );
      assert.equal(Option.getOrThrow(yield* ledger.get(authority.threadId)).state, "prepared");
    }),
  );
});
