import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import migration050 from "../../persistence/Migrations/050_PrimeAgentRecoveryLedger.ts";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import {
  make,
  PRIME_AGENT_RECOVERY_ADOPTION_MAX_ATTEMPTS,
  type PrimeAgentRecoveryAdoptionProof,
  type PrimeAgentRecoveryAuthority,
  type PrimeAgentRecoveryLedgerShape,
} from "./PrimeAgentRecoveryLedger.ts";

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
  adoptionPreviousOwnerToken: null,
  adoptionOwnerToken: null,
  adoptionRequestId: null,
  adoptionMcpOwnerId: null,
  adoptionPhase: null,
  adoptionAttempt: 0,
  adoptionRecoveryHandle: null,
  adoptionProof: null,
  nativeCleanupProven: false,
  terminalProjected: false,
  checkpointQuiesced: false,
  updatedAt: "2026-01-01T00:00:00.000Z",
} satisfies PrimeAgentRecoveryAuthority;

const proof = {
  feature: "recoverable_owned_session_adoption_v1",
  status: "adopted",
  supervisorGeneration: authority.supervisorGeneration,
  ownershipGeneration: 1,
  activeSessionId: authority.activeSessionId,
  sessionId: authority.nativeSessionId,
  correlationId: authority.correlationId,
  lifecycle: { phase: "owned" },
  cursor: { generation: authority.cursor.generation, sequence: 11 },
  mcpOwnerId: "pylon:mcp-2",
} satisfies PrimeAgentRecoveryAdoptionProof;

const resetLedger = Effect.gen(function* () {
  yield* migration050;
  const sql = yield* SqlClient.SqlClient;
  yield* sql.unsafe("DELETE FROM prime_agent_recovery_ledger");
});

const admit = (ledger: PrimeAgentRecoveryLedgerShape) =>
  ledger.markAdmitted({
    threadId: authority.threadId,
    ownerToken: authority.ownerToken,
    turnId: "turn-1",
    updatedAt: "2026-01-01T00:00:01.000Z",
  });

layer("PrimeAgentRecoveryLedger", (it) => {
  it.effect(
    "keeps prior authority while one stable adoption route advances through every phase",
    () =>
      Effect.gen(function* () {
        yield* resetLedger;
        const ledger = yield* make;
        yield* ledger.putPrepared(authority);
        assert.isTrue(yield* admit(ledger));

        const claimed = Option.getOrThrow(
          yield* ledger.claim({
            threadId: authority.threadId,
            expectedOwnerToken: authority.ownerToken,
            nextOwnerToken: "owner-2",
            requestId: "a".repeat(48),
            mcpOwnerId: proof.mcpOwnerId,
            updatedAt: "2026-01-01T00:00:02.000Z",
          }),
        );
        assert.equal(claimed.state, "adopting");
        assert.equal(claimed.ownerToken, authority.ownerToken);
        assert.equal(claimed.recoveryHandle, authority.recoveryHandle);
        assert.equal(claimed.adoptionPreviousOwnerToken, authority.ownerToken);
        assert.equal(claimed.adoptionOwnerToken, "owner-2");
        assert.equal(claimed.adoptionRequestId, "a".repeat(48));
        assert.equal(claimed.adoptionPhase, "claimed");
        assert.equal(claimed.adoptionAttempt, 0);
        assert.isTrue(
          Option.isNone(
            yield* ledger.claim({
              threadId: authority.threadId,
              expectedOwnerToken: authority.ownerToken,
              nextOwnerToken: "owner-3",
              requestId: "b".repeat(48),
              mcpOwnerId: "pylon:mcp-3",
              updatedAt: "2026-01-01T00:00:02.000Z",
            }),
          ),
        );

        const requested = Option.getOrThrow(
          yield* ledger.beginAdoptionAttempt({
            threadId: authority.threadId,
            ownerToken: "owner-2",
            requestId: "a".repeat(48),
            updatedAt: "2026-01-01T00:00:03.000Z",
          }),
        );
        assert.equal(requested.adoptionPhase, "requested");
        assert.equal(requested.adoptionAttempt, 1);
        assert.isTrue(
          yield* ledger.commitAdoption({
            threadId: authority.threadId,
            ownerToken: "owner-2",
            requestId: "a".repeat(48),
            recoveryHandle: "private-handle-2",
            proof,
            updatedAt: "2026-01-01T00:00:04.000Z",
          }),
        );
        const committed = Option.getOrThrow(yield* ledger.get(authority.threadId));
        assert.equal(committed.state, "adopting");
        assert.equal(committed.adoptionPhase, "committed");
        assert.equal(committed.recoveryHandle, authority.recoveryHandle);
        assert.equal(committed.ownerToken, authority.ownerToken);
        assert.equal(committed.adoptionRecoveryHandle, "private-handle-2");
        assert.deepEqual(committed.adoptionProof, proof);

        const retried = Option.getOrThrow(
          yield* ledger.beginAdoptionAttempt({
            threadId: authority.threadId,
            ownerToken: "owner-2",
            requestId: "a".repeat(48),
            updatedAt: "2026-01-01T00:00:05.000Z",
          }),
        );
        assert.equal(retried.adoptionPhase, "committed");
        assert.equal(retried.adoptionAttempt, 2);
        assert.isTrue(
          yield* ledger.commitAdoption({
            threadId: authority.threadId,
            ownerToken: "owner-2",
            requestId: "a".repeat(48),
            recoveryHandle: "private-handle-2",
            proof,
            updatedAt: "2026-01-01T00:00:06.000Z",
          }),
        );
        assert.isFalse(
          yield* ledger.commitAdoption({
            threadId: authority.threadId,
            ownerToken: "owner-2",
            requestId: "a".repeat(48),
            recoveryHandle: "wrong-handle",
            proof,
            updatedAt: "2026-01-01T00:00:06.000Z",
          }),
        );

        const confirming = Option.getOrThrow(
          yield* ledger.beginAdoptionConfirmation({
            threadId: authority.threadId,
            ownerToken: "owner-2",
            requestId: "a".repeat(48),
            updatedAt: "2026-01-01T00:00:07.000Z",
          }),
        );
        assert.equal(confirming.adoptionPhase, "confirming");
        assert.equal(confirming.adoptionAttempt, 3);
        const confirmationRetried = Option.getOrThrow(
          yield* ledger.beginAdoptionConfirmation({
            threadId: authority.threadId,
            ownerToken: "owner-2",
            requestId: "a".repeat(48),
            updatedAt: "2026-01-01T00:00:07.500Z",
          }),
        );
        assert.equal(confirmationRetried.adoptionPhase, "confirming");
        assert.equal(confirmationRetried.adoptionAttempt, 4);
        assert.isTrue(
          yield* ledger.finalizeAdoption({
            threadId: authority.threadId,
            ownerToken: "owner-2",
            requestId: "a".repeat(48),
            recoveryHandle: "private-handle-2",
            proof,
            updatedAt: "2026-01-01T00:00:08.000Z",
          }),
        );
        const adopted = Option.getOrThrow(yield* ledger.get(authority.threadId));
        assert.equal(adopted.state, "active");
        assert.equal(adopted.ownerToken, "owner-2");
        assert.equal(adopted.recoveryHandle, "private-handle-2");
        assert.equal(adopted.ownershipGeneration, proof.ownershipGeneration);
        assert.deepEqual(adopted.cursor, proof.cursor);
        assert.equal(adopted.mcpOwnerId, proof.mcpOwnerId);
        assert.equal(adopted.adoptionRequestId, null);
        assert.equal(adopted.adoptionProof, null);
      }),
  );

  it.effect("releases only a claim whose native attempt provably never started", () =>
    Effect.gen(function* () {
      yield* resetLedger;
      const ledger = yield* make;
      yield* ledger.putPrepared(authority);
      assert.isTrue(yield* admit(ledger));
      yield* ledger.claim({
        threadId: authority.threadId,
        expectedOwnerToken: authority.ownerToken,
        nextOwnerToken: "owner-2",
        requestId: "a".repeat(48),
        mcpOwnerId: proof.mcpOwnerId,
        updatedAt: "2026-01-01T00:00:02.000Z",
      });
      assert.isFalse(
        yield* ledger.releaseClaim({
          threadId: authority.threadId,
          ownerToken: "wrong-owner",
          previousOwnerToken: authority.ownerToken,
          requestId: "a".repeat(48),
          updatedAt: "2026-01-01T00:00:03.000Z",
        }),
      );
      assert.isTrue(
        yield* ledger.releaseClaim({
          threadId: authority.threadId,
          ownerToken: "owner-2",
          previousOwnerToken: authority.ownerToken,
          requestId: "a".repeat(48),
          updatedAt: "2026-01-01T00:00:03.000Z",
        }),
      );
      const released = Option.getOrThrow(yield* ledger.get(authority.threadId));
      assert.equal(released.state, "active");
      assert.equal(released.ownerToken, authority.ownerToken);

      yield* ledger.claim({
        threadId: authority.threadId,
        expectedOwnerToken: authority.ownerToken,
        nextOwnerToken: "owner-2",
        requestId: "a".repeat(48),
        mcpOwnerId: proof.mcpOwnerId,
        updatedAt: "2026-01-01T00:00:04.000Z",
      });
      yield* ledger.beginAdoptionAttempt({
        threadId: authority.threadId,
        ownerToken: "owner-2",
        requestId: "a".repeat(48),
        updatedAt: "2026-01-01T00:00:05.000Z",
      });
      assert.isFalse(
        yield* ledger.releaseClaim({
          threadId: authority.threadId,
          ownerToken: "owner-2",
          previousOwnerToken: authority.ownerToken,
          requestId: "a".repeat(48),
          updatedAt: "2026-01-01T00:00:06.000Z",
        }),
      );
      assert.equal(
        Option.getOrThrow(yield* ledger.get(authority.threadId)).adoptionPhase,
        "requested",
      );
    }),
  );

  it.effect("bounds ambiguous retries, quarantines authority, and rejects wrong routes", () =>
    Effect.gen(function* () {
      yield* resetLedger;
      const ledger = yield* make;
      yield* ledger.putPrepared(authority);
      assert.isTrue(yield* admit(ledger));
      yield* ledger.claim({
        threadId: authority.threadId,
        expectedOwnerToken: authority.ownerToken,
        nextOwnerToken: "owner-2",
        requestId: "a".repeat(48),
        mcpOwnerId: proof.mcpOwnerId,
        updatedAt: "2026-01-01T00:00:02.000Z",
      });
      assert.isTrue(
        Option.isNone(
          yield* ledger.beginAdoptionAttempt({
            threadId: "thread-other",
            ownerToken: "owner-2",
            requestId: "a".repeat(48),
            updatedAt: "2026-01-01T00:00:03.000Z",
          }),
        ),
      );
      assert.isTrue(
        Option.isNone(
          yield* ledger.beginAdoptionAttempt({
            threadId: authority.threadId,
            ownerToken: "owner-2",
            requestId: "wrong-request",
            updatedAt: "2026-01-01T00:00:03.000Z",
          }),
        ),
      );
      for (let attempt = 0; attempt < PRIME_AGENT_RECOVERY_ADOPTION_MAX_ATTEMPTS; attempt += 1) {
        assert.isTrue(
          Option.isSome(
            yield* ledger.beginAdoptionAttempt({
              threadId: authority.threadId,
              ownerToken: "owner-2",
              requestId: "a".repeat(48),
              updatedAt: `2026-01-01T00:00:${String(attempt + 10).padStart(2, "0")}.000Z`,
            }),
          ),
        );
      }
      assert.isTrue(
        Option.isNone(
          yield* ledger.beginAdoptionAttempt({
            threadId: authority.threadId,
            ownerToken: "owner-2",
            requestId: "a".repeat(48),
            updatedAt: "2026-01-01T00:00:30.000Z",
          }),
        ),
      );
      assert.isTrue(
        yield* ledger.quarantineAdoption({
          threadId: authority.threadId,
          ownerToken: "owner-2",
          requestId: "a".repeat(48),
          updatedAt: "2026-01-01T00:00:31.000Z",
        }),
      );
      assert.equal(Option.getOrThrow(yield* ledger.get(authority.threadId)).state, "quarantined");
      assert.deepEqual(yield* ledger.listActive(), []);
    }),
  );

  it.effect("fails closed when a staged exact proof is corrupt", () =>
    Effect.gen(function* () {
      yield* resetLedger;
      const ledger = yield* make;
      const sql = yield* SqlClient.SqlClient;
      yield* ledger.putPrepared(authority);
      assert.isTrue(yield* admit(ledger));
      yield* ledger.claim({
        threadId: authority.threadId,
        expectedOwnerToken: authority.ownerToken,
        nextOwnerToken: "owner-2",
        requestId: "a".repeat(48),
        mcpOwnerId: proof.mcpOwnerId,
        updatedAt: "2026-01-01T00:00:02.000Z",
      });
      yield* sql.unsafe(
        `UPDATE prime_agent_recovery_ledger
         SET adoption_phase='committed', adoption_recovery_handle='private-handle-2',
             adoption_proof_json='{not-json'
         WHERE thread_id=?`,
        [authority.threadId],
      );
      const loaded = yield* Effect.exit(ledger.get(authority.threadId));
      assert.isTrue(Exit.isFailure(loaded));
    }),
  );

  it.effect("deletes only after all three cleanup proofs", () =>
    Effect.gen(function* () {
      yield* resetLedger;
      const ledger = yield* make;
      yield* ledger.putPrepared(authority);
      assert.isTrue(yield* admit(ledger));
      assert.isFalse(yield* ledger.deleteIfSettled(authority.threadId));
      assert.isTrue(
        yield* ledger.markNativeCleanup({
          threadId: authority.threadId,
          ownerToken: authority.ownerToken,
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
});
