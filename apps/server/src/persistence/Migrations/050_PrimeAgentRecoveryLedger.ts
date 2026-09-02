import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS prime_agent_recovery_ledger (
      thread_id TEXT PRIMARY KEY,
      provider_instance_id TEXT NOT NULL,
      session_incarnation_id TEXT NOT NULL,
      admission_request_id TEXT NOT NULL,
      turn_id TEXT,
      package_root TEXT NOT NULL,
      package_version TEXT NOT NULL,
      managed_build_id TEXT NOT NULL,
      sdk_features_json TEXT NOT NULL,
      daemon_capabilities_json TEXT NOT NULL,
      protocol_name TEXT NOT NULL,
      protocol_version INTEGER NOT NULL,
      schema_revision INTEGER NOT NULL,
      active_session_id TEXT NOT NULL,
      native_session_id TEXT NOT NULL,
      recovery_handle TEXT NOT NULL,
      supervisor_generation TEXT NOT NULL,
      ownership_generation INTEGER NOT NULL,
      cursor_generation TEXT NOT NULL,
      cursor_sequence INTEGER NOT NULL,
      correlation_id TEXT NOT NULL,
      mcp_owner_id TEXT NOT NULL,
      recovery_config_json TEXT NOT NULL,
      launch_environment_json TEXT NOT NULL,
      transcript_message_count INTEGER NOT NULL DEFAULT 0,
      transcript_fingerprints_json TEXT NOT NULL DEFAULT '[]',
      owner_token TEXT NOT NULL,
      state TEXT NOT NULL,
      adoption_previous_owner_token TEXT,
      adoption_owner_token TEXT,
      adoption_request_id TEXT,
      adoption_mcp_owner_id TEXT,
      adoption_phase TEXT,
      adoption_attempt INTEGER NOT NULL DEFAULT 0,
      adoption_recovery_handle TEXT,
      adoption_proof_json TEXT,
      native_cleanup_proven INTEGER NOT NULL DEFAULT 0,
      terminal_projected INTEGER NOT NULL DEFAULT 0,
      checkpoint_quiesced INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_prime_agent_recovery_ledger_active
    ON prime_agent_recovery_ledger(state, provider_instance_id, updated_at)
  `;
});
