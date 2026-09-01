import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const NonNegativeInt = Schema.Number.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
);

const RecoveryCursor = Schema.Struct({
  generation: Schema.String,
  sequence: NonNegativeInt,
});

export const PrimeAgentRecoveryAuthority = Schema.Struct({
  threadId: Schema.String,
  providerInstanceId: Schema.String,
  sessionIncarnationId: Schema.String,
  admissionRequestId: Schema.String,
  turnId: Schema.NullOr(Schema.String),
  packageRoot: Schema.String,
  packageVersion: Schema.String,
  managedBuildId: Schema.String,
  sdkFeatures: Schema.Array(Schema.String),
  daemonCapabilities: Schema.Array(Schema.String),
  protocolName: Schema.String,
  protocolVersion: Schema.Int,
  schemaRevision: Schema.Int,
  activeSessionId: Schema.String,
  nativeSessionId: Schema.String,
  recoveryHandle: Schema.String,
  supervisorGeneration: Schema.String,
  ownershipGeneration: NonNegativeInt,
  cursor: RecoveryCursor,
  correlationId: Schema.String,
  mcpOwnerId: Schema.String,
  recoveryConfig: Schema.Record(Schema.String, Schema.Unknown),
  launchEnvironment: Schema.Record(Schema.String, Schema.String),
  transcriptMessageCount: NonNegativeInt,
  transcriptFingerprints: Schema.Array(Schema.String),
  ownerToken: Schema.String,
  state: Schema.Literals(["prepared", "active", "adopting", "terminal"]),
  nativeCleanupProven: Schema.Boolean,
  terminalProjected: Schema.Boolean,
  checkpointQuiesced: Schema.Boolean,
  updatedAt: Schema.String,
});
export type PrimeAgentRecoveryAuthority = typeof PrimeAgentRecoveryAuthority.Type;

export class PrimeAgentRecoveryLedgerError extends Schema.TaggedErrorClass<PrimeAgentRecoveryLedgerError>()(
  "PrimeAgentRecoveryLedgerError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Prime Agent recovery ledger failed during ${this.operation}.`;
  }
}

export interface PrimeAgentRecoveryLedgerShape {
  readonly putPrepared: (
    authority: PrimeAgentRecoveryAuthority,
  ) => Effect.Effect<void, PrimeAgentRecoveryLedgerError>;
  readonly get: (
    threadId: string,
  ) => Effect.Effect<Option.Option<PrimeAgentRecoveryAuthority>, PrimeAgentRecoveryLedgerError>;
  readonly listActive: () => Effect.Effect<
    ReadonlyArray<PrimeAgentRecoveryAuthority>,
    PrimeAgentRecoveryLedgerError
  >;
  readonly markAdmitted: (input: {
    readonly threadId: string;
    readonly ownerToken: string;
    readonly turnId: string;
    readonly updatedAt: string;
  }) => Effect.Effect<boolean, PrimeAgentRecoveryLedgerError>;
  readonly discardPrepared: (input: {
    readonly threadId: string;
    readonly ownerToken: string;
  }) => Effect.Effect<boolean, PrimeAgentRecoveryLedgerError>;
  readonly updateTranscriptProgress: (input: {
    readonly threadId: string;
    readonly ownerToken: string;
    readonly cursor: typeof RecoveryCursor.Type;
    readonly messageCount: number;
    readonly fingerprints: ReadonlyArray<string>;
    readonly updatedAt: string;
  }) => Effect.Effect<boolean, PrimeAgentRecoveryLedgerError>;
  /** Compare-and-swap the last durable owner. Exactly one restarted Pylon process can win. */
  readonly claim: (input: {
    readonly threadId: string;
    readonly expectedOwnerToken: string;
    readonly nextOwnerToken: string;
    readonly updatedAt: string;
  }) => Effect.Effect<Option.Option<PrimeAgentRecoveryAuthority>, PrimeAgentRecoveryLedgerError>;
  readonly releaseClaim: (input: {
    readonly threadId: string;
    readonly ownerToken: string;
    readonly previousOwnerToken: string;
    readonly updatedAt: string;
  }) => Effect.Effect<boolean, PrimeAgentRecoveryLedgerError>;
  /** Persist the rotated bearer authority before the SDK confirmation step. */
  readonly commitAdoption: (input: {
    readonly threadId: string;
    readonly ownerToken: string;
    readonly recoveryHandle: string;
    readonly ownershipGeneration: number;
    readonly cursor: typeof RecoveryCursor.Type;
    readonly mcpOwnerId: string;
    readonly updatedAt: string;
  }) => Effect.Effect<boolean, PrimeAgentRecoveryLedgerError>;
  readonly markNativeCleanup: (input: {
    readonly threadId: string;
    readonly ownerToken: string;
    readonly updatedAt: string;
  }) => Effect.Effect<boolean, PrimeAgentRecoveryLedgerError>;
  readonly markTerminalProjected: (input: {
    readonly threadId: string;
    readonly updatedAt: string;
  }) => Effect.Effect<void, PrimeAgentRecoveryLedgerError>;
  readonly markCheckpointQuiesced: (input: {
    readonly threadId: string;
    readonly updatedAt: string;
  }) => Effect.Effect<void, PrimeAgentRecoveryLedgerError>;
  /** Deletes only after native cleanup, terminal projection, and checkpoint quiescence all hold. */
  readonly deleteIfSettled: (
    threadId: string,
  ) => Effect.Effect<boolean, PrimeAgentRecoveryLedgerError>;
}

export class PrimeAgentRecoveryLedger extends Context.Service<
  PrimeAgentRecoveryLedger,
  PrimeAgentRecoveryLedgerShape
>()("t3/provider/prime/PrimeAgentRecoveryLedger") {}

const RawRow = Schema.Struct({
  threadId: Schema.String,
  providerInstanceId: Schema.String,
  sessionIncarnationId: Schema.String,
  admissionRequestId: Schema.String,
  turnId: Schema.NullOr(Schema.String),
  packageRoot: Schema.String,
  packageVersion: Schema.String,
  managedBuildId: Schema.String,
  sdkFeaturesJson: Schema.String,
  daemonCapabilitiesJson: Schema.String,
  protocolName: Schema.String,
  protocolVersion: Schema.Int,
  schemaRevision: Schema.Int,
  activeSessionId: Schema.String,
  nativeSessionId: Schema.String,
  recoveryHandle: Schema.String,
  supervisorGeneration: Schema.String,
  ownershipGeneration: Schema.Int,
  cursorGeneration: Schema.String,
  cursorSequence: Schema.Int,
  correlationId: Schema.String,
  mcpOwnerId: Schema.String,
  recoveryConfigJson: Schema.String,
  launchEnvironmentJson: Schema.String,
  transcriptMessageCount: Schema.Int,
  transcriptFingerprintsJson: Schema.String,
  ownerToken: Schema.String,
  state: Schema.String,
  nativeCleanupProven: Schema.Int,
  terminalProjected: Schema.Int,
  checkpointQuiesced: Schema.Int,
  updatedAt: Schema.String,
});

const decodeRawRows = Schema.decodeUnknownSync(Schema.Array(RawRow));
const decodeAuthority = Schema.decodeUnknownSync(PrimeAgentRecoveryAuthority);
const selectColumns = `
  thread_id AS threadId,
  provider_instance_id AS providerInstanceId,
  session_incarnation_id AS sessionIncarnationId,
  admission_request_id AS admissionRequestId,
  turn_id AS turnId,
  package_root AS packageRoot,
  package_version AS packageVersion,
  managed_build_id AS managedBuildId,
  sdk_features_json AS sdkFeaturesJson,
  daemon_capabilities_json AS daemonCapabilitiesJson,
  protocol_name AS protocolName,
  protocol_version AS protocolVersion,
  schema_revision AS schemaRevision,
  active_session_id AS activeSessionId,
  native_session_id AS nativeSessionId,
  recovery_handle AS recoveryHandle,
  supervisor_generation AS supervisorGeneration,
  ownership_generation AS ownershipGeneration,
  cursor_generation AS cursorGeneration,
  cursor_sequence AS cursorSequence,
  correlation_id AS correlationId,
  mcp_owner_id AS mcpOwnerId,
  recovery_config_json AS recoveryConfigJson,
  launch_environment_json AS launchEnvironmentJson,
  transcript_message_count AS transcriptMessageCount,
  transcript_fingerprints_json AS transcriptFingerprintsJson,
  owner_token AS ownerToken,
  state,
  native_cleanup_proven AS nativeCleanupProven,
  terminal_projected AS terminalProjected,
  checkpoint_quiesced AS checkpointQuiesced,
  updated_at AS updatedAt
`;

function ledgerError(operation: string, cause?: unknown): PrimeAgentRecoveryLedgerError {
  return new PrimeAgentRecoveryLedgerError({
    operation,
    ...(cause === undefined ? {} : { cause }),
  });
}

function decodeRows(rows: unknown, operation: string): ReadonlyArray<PrimeAgentRecoveryAuthority> {
  try {
    return decodeRawRows(rows).map((row) =>
      decodeAuthority({
        threadId: row.threadId,
        providerInstanceId: row.providerInstanceId,
        sessionIncarnationId: row.sessionIncarnationId,
        admissionRequestId: row.admissionRequestId,
        turnId: row.turnId,
        packageRoot: row.packageRoot,
        packageVersion: row.packageVersion,
        managedBuildId: row.managedBuildId,
        sdkFeatures: JSON.parse(row.sdkFeaturesJson),
        daemonCapabilities: JSON.parse(row.daemonCapabilitiesJson),
        protocolName: row.protocolName,
        protocolVersion: row.protocolVersion,
        schemaRevision: row.schemaRevision,
        activeSessionId: row.activeSessionId,
        nativeSessionId: row.nativeSessionId,
        recoveryHandle: row.recoveryHandle,
        supervisorGeneration: row.supervisorGeneration,
        ownershipGeneration: row.ownershipGeneration,
        cursor: { generation: row.cursorGeneration, sequence: row.cursorSequence },
        correlationId: row.correlationId,
        mcpOwnerId: row.mcpOwnerId,
        recoveryConfig: JSON.parse(row.recoveryConfigJson),
        launchEnvironment: JSON.parse(row.launchEnvironmentJson),
        transcriptMessageCount: row.transcriptMessageCount,
        transcriptFingerprints: JSON.parse(row.transcriptFingerprintsJson),
        ownerToken: row.ownerToken,
        state: row.state,
        nativeCleanupProven: row.nativeCleanupProven === 1,
        terminalProjected: row.terminalProjected === 1,
        checkpointQuiesced: row.checkpointQuiesced === 1,
        updatedAt: row.updatedAt,
      }),
    );
  } catch (cause) {
    throw ledgerError(operation, cause);
  }
}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const mapSqlError = (operation: string) => (cause: unknown) => ledgerError(operation, cause);
  const decodeEffect = (rows: unknown, operation: string) =>
    Effect.try({
      try: () => decodeRows(rows, operation),
      catch: (cause) =>
        Schema.is(PrimeAgentRecoveryLedgerError)(cause) ? cause : ledgerError(operation, cause),
    });

  const queryByThread = (threadId: string) =>
    sql
      .unsafe(`SELECT ${selectColumns} FROM prime_agent_recovery_ledger WHERE thread_id = ?`, [
        threadId,
      ])
      .pipe(
        Effect.mapError(mapSqlError("get")),
        Effect.flatMap((rows) => decodeEffect(rows, "get")),
      );

  const get: PrimeAgentRecoveryLedgerShape["get"] = (threadId) =>
    queryByThread(threadId).pipe(Effect.map((rows) => Option.fromNullishOr(rows[0])));

  const putPrepared: PrimeAgentRecoveryLedgerShape["putPrepared"] = (authority) =>
    sql
      .unsafe(
        `INSERT INTO prime_agent_recovery_ledger (
          thread_id, provider_instance_id, session_incarnation_id, admission_request_id, turn_id,
          package_root, package_version, managed_build_id, sdk_features_json, daemon_capabilities_json,
          protocol_name, protocol_version, schema_revision, active_session_id, native_session_id,
          recovery_handle, supervisor_generation, ownership_generation, cursor_generation, cursor_sequence,
          correlation_id, mcp_owner_id, recovery_config_json, launch_environment_json,
          transcript_message_count, transcript_fingerprints_json, owner_token, state,
          native_cleanup_proven, terminal_projected, checkpoint_quiesced, updated_at
        ) VALUES (${Array.from({ length: 32 }, () => "?").join(",")})
`,
        [
          authority.threadId,
          authority.providerInstanceId,
          authority.sessionIncarnationId,
          authority.admissionRequestId,
          authority.turnId,
          authority.packageRoot,
          authority.packageVersion,
          authority.managedBuildId,
          JSON.stringify(authority.sdkFeatures),
          JSON.stringify(authority.daemonCapabilities),
          authority.protocolName,
          authority.protocolVersion,
          authority.schemaRevision,
          authority.activeSessionId,
          authority.nativeSessionId,
          authority.recoveryHandle,
          authority.supervisorGeneration,
          authority.ownershipGeneration,
          authority.cursor.generation,
          authority.cursor.sequence,
          authority.correlationId,
          authority.mcpOwnerId,
          JSON.stringify(authority.recoveryConfig),
          JSON.stringify(authority.launchEnvironment),
          authority.transcriptMessageCount,
          JSON.stringify(authority.transcriptFingerprints),
          authority.ownerToken,
          authority.state,
          authority.nativeCleanupProven ? 1 : 0,
          authority.terminalProjected ? 1 : 0,
          authority.checkpointQuiesced ? 1 : 0,
          authority.updatedAt,
        ],
      )
      .pipe(Effect.mapError(mapSqlError("putPrepared")), Effect.asVoid);

  const listActive: PrimeAgentRecoveryLedgerShape["listActive"] = () =>
    sql
      .unsafe(
        `SELECT ${selectColumns} FROM prime_agent_recovery_ledger WHERE state IN ('active','adopting') ORDER BY updated_at, thread_id`,
      )
      .pipe(
        Effect.mapError(mapSqlError("listActive")),
        Effect.flatMap((rows) => decodeEffect(rows, "listActive")),
      );

  const conditionalUpdate = (
    operation: string,
    statement: string,
    parameters: ReadonlyArray<unknown>,
  ) =>
    sql.unsafe(statement, parameters).pipe(
      Effect.mapError(mapSqlError(operation)),
      Effect.map((rows) => Array.isArray(rows) && rows.length === 1),
    );

  const markAdmitted: PrimeAgentRecoveryLedgerShape["markAdmitted"] = (input) =>
    conditionalUpdate(
      "markAdmitted",
      `UPDATE prime_agent_recovery_ledger SET turn_id=?, state='active', updated_at=?
       WHERE thread_id=? AND owner_token=? AND state='prepared' RETURNING thread_id`,
      [input.turnId, input.updatedAt, input.threadId, input.ownerToken],
    );

  const discardPrepared: PrimeAgentRecoveryLedgerShape["discardPrepared"] = (input) =>
    conditionalUpdate(
      "discardPrepared",
      `DELETE FROM prime_agent_recovery_ledger
       WHERE thread_id=? AND owner_token=? AND state='prepared' RETURNING thread_id`,
      [input.threadId, input.ownerToken],
    );

  const updateTranscriptProgress: PrimeAgentRecoveryLedgerShape["updateTranscriptProgress"] = (
    input,
  ) =>
    conditionalUpdate(
      "updateTranscriptProgress",
      `UPDATE prime_agent_recovery_ledger
       SET cursor_generation=?, cursor_sequence=?, transcript_message_count=?,
           transcript_fingerprints_json=?, updated_at=?
       WHERE thread_id=? AND owner_token=? AND state IN ('active','adopting') RETURNING thread_id`,
      [
        input.cursor.generation,
        input.cursor.sequence,
        input.messageCount,
        JSON.stringify(input.fingerprints),
        input.updatedAt,
        input.threadId,
        input.ownerToken,
      ],
    );

  const claim: PrimeAgentRecoveryLedgerShape["claim"] = (input) =>
    conditionalUpdate(
      "claim",
      `UPDATE prime_agent_recovery_ledger SET owner_token=?, state='adopting', updated_at=?
       WHERE thread_id=? AND owner_token=? AND state='active' RETURNING thread_id`,
      [input.nextOwnerToken, input.updatedAt, input.threadId, input.expectedOwnerToken],
    ).pipe(
      Effect.flatMap((claimed) => (claimed ? get(input.threadId) : Effect.succeed(Option.none()))),
    );

  const releaseClaim: PrimeAgentRecoveryLedgerShape["releaseClaim"] = (input) =>
    conditionalUpdate(
      "releaseClaim",
      `UPDATE prime_agent_recovery_ledger SET owner_token=?, state='active', updated_at=?
       WHERE thread_id=? AND owner_token=? AND state='adopting' RETURNING thread_id`,
      [input.previousOwnerToken, input.updatedAt, input.threadId, input.ownerToken],
    );

  const commitAdoption: PrimeAgentRecoveryLedgerShape["commitAdoption"] = (input) =>
    conditionalUpdate(
      "commitAdoption",
      `UPDATE prime_agent_recovery_ledger
       SET recovery_handle=?, ownership_generation=?, cursor_generation=?, cursor_sequence=?,
           mcp_owner_id=?, state='active', updated_at=?
       WHERE thread_id=? AND owner_token=? AND state='adopting' RETURNING thread_id`,
      [
        input.recoveryHandle,
        input.ownershipGeneration,
        input.cursor.generation,
        input.cursor.sequence,
        input.mcpOwnerId,
        input.updatedAt,
        input.threadId,
        input.ownerToken,
      ],
    );

  const markNativeCleanup: PrimeAgentRecoveryLedgerShape["markNativeCleanup"] = (input) =>
    conditionalUpdate(
      "markNativeCleanup",
      `UPDATE prime_agent_recovery_ledger
       SET native_cleanup_proven=1, state='terminal', updated_at=?
       WHERE thread_id=? AND owner_token=? RETURNING thread_id`,
      [input.updatedAt, input.threadId, input.ownerToken],
    );

  const markTerminalProjected: PrimeAgentRecoveryLedgerShape["markTerminalProjected"] = (input) =>
    sql
      .unsafe(
        `UPDATE prime_agent_recovery_ledger SET terminal_projected=1, updated_at=? WHERE thread_id=?`,
        [input.updatedAt, input.threadId],
      )
      .pipe(Effect.mapError(mapSqlError("markTerminalProjected")), Effect.asVoid);

  const markCheckpointQuiesced: PrimeAgentRecoveryLedgerShape["markCheckpointQuiesced"] = (input) =>
    sql
      .unsafe(
        `UPDATE prime_agent_recovery_ledger SET checkpoint_quiesced=1, updated_at=? WHERE thread_id=?`,
        [input.updatedAt, input.threadId],
      )
      .pipe(Effect.mapError(mapSqlError("markCheckpointQuiesced")), Effect.asVoid);

  const deleteIfSettled: PrimeAgentRecoveryLedgerShape["deleteIfSettled"] = (threadId) =>
    conditionalUpdate(
      "deleteIfSettled",
      `DELETE FROM prime_agent_recovery_ledger
       WHERE thread_id=? AND native_cleanup_proven=1 AND terminal_projected=1 AND checkpoint_quiesced=1
       RETURNING thread_id`,
      [threadId],
    );

  return {
    putPrepared,
    get,
    listActive,
    markAdmitted,
    discardPrepared,
    updateTranscriptProgress,
    claim,
    releaseClaim,
    commitAdoption,
    markNativeCleanup,
    markTerminalProjected,
    markCheckpointQuiesced,
    deleteIfSettled,
  } satisfies PrimeAgentRecoveryLedgerShape;
});

export const layer = Layer.effect(PrimeAgentRecoveryLedger, make);
