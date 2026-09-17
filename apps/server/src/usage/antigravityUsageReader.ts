// @effect-diagnostics nodeBuiltinImport:off
/**
 * Bounded read-only reader for native Antigravity session history.
 *
 * Scans on-disk SQLite conversation databases (`*.db`) located under
 * `<profileDirectory>/antigravity-acp/conversations/` and extracts model token
 * usage and context window snapshots from `gen_metadata.data` protobuf blobs.
 *
 * Pinned release archive: agy_acp_server_1.1.1
 * Archive SHA256: fdfa915652cdb7ba8085cc8fffed072cbe009251aa2c951aabdda07a8c28a189
 *
 * Schema Provenance (from localharness_external protobuf descriptors):
 *   table gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER)
 *   data: CortexStepGeneratorMetadata
 *     chat_model (field 1, message): ChatModelMetadata
 *       model (field 3, enum): Model enum
 *       model_name (field 19, string): e.g. "gemini-3.8-flash"
 *       usage (field 4, message): ModelUsageStats
 *         input_tokens (field 2, uint64)
 *         output_tokens (field 3, uint64)
 *         cache_write_tokens (field 4, uint64)
 *         cache_read_tokens (field 5, uint64)
 *         thinking_output_tokens (field 9, uint64)
 *         response_output_tokens (field 10, uint64)
 *       chat_start_metadata (field 9, message): ChatStartMetadata
 *         timestamp (field 4, message): google.protobuf.Timestamp (seconds: 1, nanos: 2)
 *         context_window_metadata (field 10, message): ContextWindowMetadata
 *           estimated_tokens_used (field 1, int32)
 *           max_context_tokens (field 4, int32)
 *
 * @module antigravityUsageReader
 */

import * as NodePath from "node:path";

/* -------------------------------------------------------------------------- */
/* Constants & Limits                                                         */
/* -------------------------------------------------------------------------- */

export const WIRE_VARINT = 0;
export const WIRE_FIXED64 = 1;
export const WIRE_LENGTH_DELIMITED = 2;
export const WIRE_START_GROUP = 3;
export const WIRE_END_GROUP = 4;
export const WIRE_FIXED32 = 5;

/** Maximum bytes permitted for a single gen_metadata row blob (default 512 KiB). */
export const DEFAULT_MAX_BLOB_SIZE = 512 * 1024;

/** Maximum rows to process per database to guarantee bounded execution. */
export const DEFAULT_MAX_ROWS_PER_DB = 10_000;

/** Maximum cumulative blob bytes processed per database (default 32 MiB). */
export const DEFAULT_MAX_TOTAL_BYTES_PER_DB = 32 * 1024 * 1024;

/** Keyset pagination batch size to prevent materializing large query buffers. */
export const DEFAULT_PAGE_SIZE = 100;

/** Cap recorded error strings to prevent memory inflation. */
export const MAX_RECORDED_ERRORS = 100;

/** Maximum valid length for model identifier strings. */
export const MAX_MODEL_NAME_LENGTH = 256;

/* -------------------------------------------------------------------------- */
/* Types & Interfaces                                                         */
/* -------------------------------------------------------------------------- */

export interface AntigravityTokenTotals {
  readonly uncachedInputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
}

export interface AntigravityContextSnapshot {
  readonly timestampMs: number;
  readonly estimatedTokensUsed: number;
  readonly maxContextTokens: number;
  readonly genIndex: number;
}

export interface AntigravityUsageRecord {
  readonly provider: "antigravity";
  readonly sessionId: string;
  readonly genIndex: number;
  readonly dedupeKey: string;
  readonly timestampMs: number;
  readonly model: string;
  readonly totals: AntigravityTokenTotals;
  readonly reportedCostUsd: null;
  readonly contextSnapshot?: AntigravityContextSnapshot | undefined;
}

export interface AntigravityDatabaseReadResult {
  readonly databasePath: string;
  readonly sessionId: string;
  readonly rowsRead: number;
  readonly bytesRead: number;
  readonly recordsParsed: number;
  readonly skippedEmptyUsage: number;
  readonly malformedRows: number;
  readonly truncated: boolean;
  readonly records: readonly AntigravityUsageRecord[];
  readonly latestContextSnapshot?: AntigravityContextSnapshot | undefined;
  readonly errors: readonly string[];
}

export interface AntigravityReaderOptions {
  readonly maxBlobSize?: number;
  readonly maxRowsPerDb?: number;
  readonly maxTotalBytesPerDb?: number;
  readonly pageSize?: number;
}

export interface AntigravityLatestContextOptions {
  readonly maxRows?: number;
  readonly maxBlobSize?: number;
  readonly maxTotalBytes?: number;
}

export interface AntigravityParserOptions {
  readonly sessionId: string;
  readonly rowIdx: number;
}

export type BlobParseOutcome =
  | {
      readonly success: true;
      readonly record: AntigravityUsageRecord | null;
      readonly contextSnapshot?: AntigravityContextSnapshot | undefined;
    }
  | {
      readonly success: false;
      readonly reason: string;
    };

/* -------------------------------------------------------------------------- */
/* Typed SQLite Abstraction                                                   */
/* -------------------------------------------------------------------------- */

type SqliteBinding = string | number | bigint | Uint8Array | null;
interface SqliteStatement {
  get(...params: SqliteBinding[]): unknown;
  all(...params: SqliteBinding[]): unknown[];
}
interface SqliteDbHandle {
  prepare(sql: string): SqliteStatement;
  close(): void;
}
async function openSqliteDatabase(databasePath: string): Promise<SqliteDbHandle> {
  if (process.versions.bun) {
    const { Database } = await import("bun:sqlite");
    const db = new Database(databasePath, { readonly: true });
    try {
      db.run("PRAGMA busy_timeout = 100;");
    } catch (error) {
      db.close();
      throw error;
    }
    return {
      prepare: (sql) => {
        const stmt = db.prepare(sql);
        return { get: (...params) => stmt.get(...params), all: (...params) => stmt.all(...params) };
      },
      close: () => db.close(),
    };
  }
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 100;");
  } catch (error) {
    db.close();
    throw error;
  }
  return {
    prepare: (sql) => {
      const stmt = db.prepare(sql);
      return { get: (...params) => stmt.get(...params), all: (...params) => stmt.all(...params) };
    },
    close: () => db.close(),
  };
}

/* -------------------------------------------------------------------------- */
/* Sanitization & Predicates                                                  */
/* -------------------------------------------------------------------------- */

export function normalizeBound(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.min(fallback, Math.max(1, Math.floor(value)));
}

export interface GenMetadataIndexRow {
  readonly idx: number;
  readonly byte_len: number;
}

export function parseGenMetadataIndexRow(raw: unknown): GenMetadataIndexRow | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const rawIdx = r.idx;
  const rawByteLen = r.byte_len;
  if (typeof rawIdx !== "number" && typeof rawIdx !== "bigint") return null;
  if (typeof rawByteLen !== "number" && typeof rawByteLen !== "bigint") return null;

  const idx = Number(rawIdx);
  const byteLen = Number(rawByteLen);

  if (!Number.isSafeInteger(idx) || idx < 0) return null;
  if (!Number.isSafeInteger(byteLen) || byteLen < 0) return null;

  return { idx, byte_len: byteLen };
}

export function extractRawIdx(raw: unknown): number | null {
  if (typeof raw === "object" && raw !== null && "idx" in raw) {
    const num = Number((raw as Record<string, unknown>).idx);
    if (Number.isSafeInteger(num) && num >= 0) {
      return num;
    }
  }
  return null;
}

export function extractBlobData(rawRow: unknown): Uint8Array | null {
  if (typeof rawRow !== "object" || rawRow === null) return null;
  const data = (rawRow as Record<string, unknown>).data;
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Protobuf Varint & Wire Reader                                              */
/* -------------------------------------------------------------------------- */

export interface VarintReadResult {
  readonly value: bigint;
  readonly bytesRead: number;
}

export function readVarint(buf: Uint8Array, offset: number): VarintReadResult {
  let result = 0n;
  let shift = 0n;
  let count = 0;

  while (offset + count < buf.length) {
    if (count >= 10) {
      throw new Error(`Varint exceeds maximum 10 bytes at offset ${offset}`);
    }

    const byte = buf[offset + count]!;
    count++;

    if (count === 10) {
      if ((byte & 0x7f) > 1) {
        throw new Error(`10th byte of 64-bit varint exceeds 1 at offset ${offset}`);
      }
      if ((byte & 0x80) !== 0) {
        throw new Error(`10th byte of varint has continuation bit set at offset ${offset}`);
      }
    }

    result |= BigInt(byte & 0x7f) << shift;
    shift += 7n;

    if ((byte & 0x80) === 0) {
      return { value: result, bytesRead: count };
    }
  }

  throw new Error(`Unexpected EOF while reading varint at offset ${offset}`);
}

export function safeBigintToSafeNumber(val: bigint, fieldName: string): number {
  if (val < 0n) {
    throw new Error(`Negative value ${val} rejected for token count ${fieldName}`);
  }
  if (val > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Value ${val} exceeds MAX_SAFE_INTEGER for ${fieldName}`);
  }
  return Number(val);
}

export interface ProtobufField {
  readonly fieldNumber: number;
  readonly wireType: number;
  readonly dataOffset: number;
  readonly dataLength: number;
}

export function* iterateProtobufFields(
  buf: Uint8Array,
  startOffset: number = 0,
  endOffset?: number,
): Generator<ProtobufField, void, undefined> {
  const limit = endOffset !== undefined ? Math.min(endOffset, buf.length) : buf.length;
  let cursor = startOffset;

  while (cursor < limit) {
    const key = readVarint(buf, cursor);
    cursor += key.bytesRead;
    if (cursor > limit) throw new Error("Truncated protobuf key");

    const wireType = Number(key.value & 0x07n);
    const fieldNumber = Number(key.value >> 3n);

    if (fieldNumber <= 0 || fieldNumber > 0x1fffffff) {
      throw new Error(`Invalid field number ${fieldNumber} at offset ${cursor}`);
    }

    switch (wireType) {
      case WIRE_VARINT: {
        const val = readVarint(buf, cursor);
        const dataOffset = cursor;
        cursor += val.bytesRead;
        if (cursor > limit) throw new Error("Truncated protobuf varint");
        yield { fieldNumber, wireType, dataOffset, dataLength: val.bytesRead };
        break;
      }
      case WIRE_FIXED64: {
        if (cursor + 8 > limit) {
          throw new Error(`Truncated FIXED64 field ${fieldNumber} at offset ${cursor}`);
        }
        yield { fieldNumber, wireType, dataOffset: cursor, dataLength: 8 };
        cursor += 8;
        break;
      }
      case WIRE_LENGTH_DELIMITED: {
        const lenVarint = readVarint(buf, cursor);
        cursor += lenVarint.bytesRead;
        const len = safeBigintToSafeNumber(lenVarint.value, `field_${fieldNumber}_len`);
        if (cursor + len > limit) {
          throw new Error(`Truncated length-delimited field ${fieldNumber} at offset ${cursor}`);
        }
        yield { fieldNumber, wireType, dataOffset: cursor, dataLength: len };
        cursor += len;
        break;
      }
      case WIRE_FIXED32: {
        if (cursor + 4 > limit) {
          throw new Error(`Truncated FIXED32 field ${fieldNumber} at offset ${cursor}`);
        }
        yield { fieldNumber, wireType, dataOffset: cursor, dataLength: 4 };
        cursor += 4;
        break;
      }
      default:
        throw new Error(`Unsupported wire type ${wireType} for field ${fieldNumber}`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Submessage Parsers                                                         */
/* -------------------------------------------------------------------------- */

export interface ParsedModelUsageStats {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheWriteTokens: number;
  readonly cacheReadTokens: number;
  readonly thinkingOutputTokens: number;
  readonly responseOutputTokens: number;
}

export function parseModelUsageStats(
  buf: Uint8Array,
  start: number,
  length: number,
): ParsedModelUsageStats {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheWriteTokens = 0;
  let cacheReadTokens = 0;
  let thinkingOutputTokens = 0;
  let responseOutputTokens = 0;

  for (const field of iterateProtobufFields(buf, start, start + length)) {
    switch (field.fieldNumber) {
      case 2: // input_tokens
        if (field.wireType !== WIRE_VARINT) {
          throw new Error(`Invalid wire type ${field.wireType} for input_tokens`);
        }
        inputTokens = safeBigintToSafeNumber(
          readVarint(buf, field.dataOffset).value,
          "input_tokens",
        );
        break;
      case 3: // output_tokens
        if (field.wireType !== WIRE_VARINT) {
          throw new Error(`Invalid wire type ${field.wireType} for output_tokens`);
        }
        outputTokens = safeBigintToSafeNumber(
          readVarint(buf, field.dataOffset).value,
          "output_tokens",
        );
        break;
      case 4: // cache_write_tokens
        if (field.wireType !== WIRE_VARINT) {
          throw new Error(`Invalid wire type ${field.wireType} for cache_write_tokens`);
        }
        cacheWriteTokens = safeBigintToSafeNumber(
          readVarint(buf, field.dataOffset).value,
          "cache_write_tokens",
        );
        break;
      case 5: // cache_read_tokens
        if (field.wireType !== WIRE_VARINT) {
          throw new Error(`Invalid wire type ${field.wireType} for cache_read_tokens`);
        }
        cacheReadTokens = safeBigintToSafeNumber(
          readVarint(buf, field.dataOffset).value,
          "cache_read_tokens",
        );
        break;
      case 9: // thinking_output_tokens
        if (field.wireType !== WIRE_VARINT) {
          throw new Error(`Invalid wire type ${field.wireType} for thinking_output_tokens`);
        }
        thinkingOutputTokens = safeBigintToSafeNumber(
          readVarint(buf, field.dataOffset).value,
          "thinking_output_tokens",
        );
        break;
      case 10: // response_output_tokens
        if (field.wireType !== WIRE_VARINT) {
          throw new Error(`Invalid wire type ${field.wireType} for response_output_tokens`);
        }
        responseOutputTokens = safeBigintToSafeNumber(
          readVarint(buf, field.dataOffset).value,
          "response_output_tokens",
        );
        break;
      default:
        // Skip unknown fields
        break;
    }
  }

  if (thinkingOutputTokens > outputTokens) {
    throw new Error(
      `Invariant violated: thinking_output_tokens (${thinkingOutputTokens}) > output_tokens (${outputTokens})`,
    );
  }

  return {
    inputTokens,
    outputTokens,
    cacheWriteTokens,
    cacheReadTokens,
    thinkingOutputTokens,
    responseOutputTokens,
  };
}

export interface ParsedChatStartMetadata {
  readonly timestamp?: { seconds: number; nanos: number };
  readonly contextSnapshot?: { estimatedTokensUsed: number; maxContextTokens: number };
}

export function parseChatStartMetadata(
  buf: Uint8Array,
  start: number,
  length: number,
): ParsedChatStartMetadata {
  let timestamp: { seconds: number; nanos: number } | undefined;
  let contextSnapshot: { estimatedTokensUsed: number; maxContextTokens: number } | undefined;

  for (const field of iterateProtobufFields(buf, start, start + length)) {
    if (field.fieldNumber === 4 && field.wireType === WIRE_LENGTH_DELIMITED) {
      let seconds = 0;
      let nanos = 0;
      for (const tsField of iterateProtobufFields(
        buf,
        field.dataOffset,
        field.dataOffset + field.dataLength,
      )) {
        if (tsField.fieldNumber === 1 && tsField.wireType === WIRE_VARINT) {
          seconds = safeBigintToSafeNumber(readVarint(buf, tsField.dataOffset).value, "ts_seconds");
        } else if (tsField.fieldNumber === 2 && tsField.wireType === WIRE_VARINT) {
          nanos = safeBigintToSafeNumber(readVarint(buf, tsField.dataOffset).value, "ts_nanos");
        }
      }
      if (nanos >= 1_000_000_000 || seconds > 8_640_000_000_000)
        throw new Error("Invalid timestamp");
      timestamp = { seconds, nanos };
    } else if (field.fieldNumber === 10 && field.wireType === WIRE_LENGTH_DELIMITED) {
      let estimatedTokensUsed = 0;
      let maxContextTokens = 0;
      for (const cwField of iterateProtobufFields(
        buf,
        field.dataOffset,
        field.dataOffset + field.dataLength,
      )) {
        if (cwField.fieldNumber === 1 && cwField.wireType === WIRE_VARINT) {
          estimatedTokensUsed = safeBigintToSafeNumber(
            readVarint(buf, cwField.dataOffset).value,
            "estimated_tokens_used",
          );
        } else if (cwField.fieldNumber === 4 && cwField.wireType === WIRE_VARINT) {
          maxContextTokens = safeBigintToSafeNumber(
            readVarint(buf, cwField.dataOffset).value,
            "max_context_tokens",
          );
        }
      }
      if (maxContextTokens > 0) {
        contextSnapshot = { estimatedTokensUsed, maxContextTokens };
      }
    }
  }

  return {
    ...(timestamp ? { timestamp } : {}),
    ...(contextSnapshot ? { contextSnapshot } : {}),
  };
}

export interface ParsedChatModelMetadata {
  readonly modelEnum?: number;
  readonly modelName?: string;
  readonly usage?: ParsedModelUsageStats;
  readonly chatStartMetadata?: ParsedChatStartMetadata;
}

export function parseChatModelMetadata(
  buf: Uint8Array,
  start: number,
  length: number,
): ParsedChatModelMetadata {
  let modelEnum: number | undefined;
  let modelName: string | undefined;
  let fullModelName: string | undefined;
  let displayName: string | undefined;
  let usage: ParsedModelUsageStats | undefined;
  let chatStartMetadata: ParsedChatStartMetadata | undefined;

  for (const field of iterateProtobufFields(buf, start, start + length)) {
    switch (field.fieldNumber) {
      case 3: // model (enum)
        if (field.wireType !== WIRE_VARINT) {
          throw new Error(`Invalid wire type ${field.wireType} for model enum`);
        }
        modelEnum = safeBigintToSafeNumber(readVarint(buf, field.dataOffset).value, "model_enum");
        break;
      case 4: // usage
        if (field.wireType !== WIRE_LENGTH_DELIMITED) {
          throw new Error(`Invalid wire type ${field.wireType} for usage`);
        }
        usage = parseModelUsageStats(buf, field.dataOffset, field.dataLength);
        break;
      case 9: // chat_start_metadata
        if (field.wireType !== WIRE_LENGTH_DELIMITED) {
          throw new Error(`Invalid wire type ${field.wireType} for chat_start_metadata`);
        }
        chatStartMetadata = parseChatStartMetadata(buf, field.dataOffset, field.dataLength);
        break;
      case 19: // response_model
      case 22: // response_model_full
      case 21: // model_display_name
        if (field.wireType !== WIRE_LENGTH_DELIMITED) {
          throw new Error(`Invalid wire type ${field.wireType} for model_name`);
        }
        if (field.dataLength > MAX_MODEL_NAME_LENGTH) {
          throw new Error(
            `Model name length ${field.dataLength} exceeds maximum ${MAX_MODEL_NAME_LENGTH}`,
          );
        }
        {
          const text = new TextDecoder("utf-8", { fatal: true })
            .decode(buf.subarray(field.dataOffset, field.dataOffset + field.dataLength))
            .trim();
          if (field.fieldNumber === 22) fullModelName = text;
          else if (field.fieldNumber === 19) modelName = text;
          else displayName = text;
        }
        break;
      default:
        break;
    }
  }

  return {
    ...(modelEnum !== undefined ? { modelEnum } : {}),
    ...(fullModelName || modelName || displayName
      ? { modelName: fullModelName || modelName || displayName! }
      : {}),
    ...(usage ? { usage } : {}),
    ...(chatStartMetadata ? { chatStartMetadata } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* Generator Metadata Blob Parser                                             */
/* -------------------------------------------------------------------------- */

export function parseAntigravityGenMetadataBlob(
  blob: Uint8Array,
  options: AntigravityParserOptions,
): BlobParseOutcome {
  try {
    if (blob.byteLength > DEFAULT_MAX_BLOB_SIZE) throw new Error("Blob exceeds maximum size");
    if (!Number.isSafeInteger(options.rowIdx) || options.rowIdx < 0)
      throw new Error("Invalid generation index");
    let chatModel: ParsedChatModelMetadata | undefined;

    for (const field of iterateProtobufFields(blob, 0, blob.length)) {
      if (field.fieldNumber === 1 && field.wireType === WIRE_LENGTH_DELIMITED) {
        chatModel = parseChatModelMetadata(blob, field.dataOffset, field.dataLength);
        break;
      }
    }

    if (!chatModel) {
      return { success: true, record: null };
    }

    const chatStartMetadata = chatModel.chatStartMetadata;
    let contextSnapshot: AntigravityContextSnapshot | undefined;

    if (chatStartMetadata?.contextSnapshot) {
      const tsSeconds = chatStartMetadata.timestamp?.seconds ?? 0;
      const tsNanos = chatStartMetadata.timestamp?.nanos ?? 0;
      const snapTs = tsSeconds > 0 ? tsSeconds * 1000 + Math.floor(tsNanos / 1_000_000) : 0;
      contextSnapshot = {
        timestampMs: snapTs,
        estimatedTokensUsed: chatStartMetadata.contextSnapshot.estimatedTokensUsed,
        maxContextTokens: chatStartMetadata.contextSnapshot.maxContextTokens,
        genIndex: options.rowIdx,
      };
    }

    const usage = chatModel.usage;
    if (!usage) {
      return {
        success: true,
        record: null,
        ...(contextSnapshot ? { contextSnapshot } : {}),
      };
    }

    let resolvedModel: string | null = null;
    if (chatModel.modelName && chatModel.modelName.trim().length > 0) {
      resolvedModel = chatModel.modelName.trim();
    } else if (chatModel.modelEnum !== undefined) {
      resolvedModel = `antigravity-model-enum-${chatModel.modelEnum}`;
    }

    const { inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens, thinkingOutputTokens } =
      usage;

    if (
      inputTokens === 0 &&
      outputTokens === 0 &&
      cacheWriteTokens === 0 &&
      cacheReadTokens === 0 &&
      thinkingOutputTokens === 0 &&
      usage.responseOutputTokens === 0
    ) {
      return {
        success: true,
        record: null,
        ...(contextSnapshot ? { contextSnapshot } : {}),
      };
    }

    if (!resolvedModel) {
      return {
        success: false,
        reason: `Missing model identification: neither model name nor valid enum present for row ${options.rowIdx}`,
      };
    }

    let timestampMs: number | undefined;
    if (chatStartMetadata?.timestamp) {
      const { seconds, nanos } = chatStartMetadata.timestamp;
      if (typeof seconds === "number" && Number.isSafeInteger(seconds) && seconds > 0) {
        timestampMs = seconds * 1000 + Math.floor(nanos / 1_000_000);
      }
    }

    if (!timestampMs || timestampMs <= 0) {
      return {
        success: false,
        reason: `Missing or non-positive timestamp for row ${options.rowIdx}`,
      };
    }

    const record: AntigravityUsageRecord = {
      provider: "antigravity",
      sessionId: options.sessionId,
      genIndex: options.rowIdx,
      dedupeKey: `antigravity:${options.sessionId}:${options.rowIdx}`,
      timestampMs,
      model: resolvedModel,
      totals: {
        uncachedInputTokens: inputTokens,
        cachedInputTokens: cacheReadTokens,
        cacheCreationTokens: cacheWriteTokens,
        outputTokens,
        reasoningTokens: thinkingOutputTokens,
      },
      reportedCostUsd: null,
      ...(contextSnapshot ? { contextSnapshot } : {}),
    };

    return {
      success: true,
      record,
      ...(contextSnapshot ? { contextSnapshot } : {}),
    };
  } catch (err) {
    return {
      success: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Database File Reader (Read-Only & Bounded Keyset Pagination)              */
/* -------------------------------------------------------------------------- */

export async function readAntigravityDatabase(
  databasePath: string,
  options?: AntigravityReaderOptions,
): Promise<AntigravityDatabaseReadResult> {
  const maxBlobSize = normalizeBound(options?.maxBlobSize, DEFAULT_MAX_BLOB_SIZE);
  const maxRowsPerDb = normalizeBound(options?.maxRowsPerDb, DEFAULT_MAX_ROWS_PER_DB);
  const maxTotalBytes = normalizeBound(options?.maxTotalBytesPerDb, DEFAULT_MAX_TOTAL_BYTES_PER_DB);
  const pageSize = normalizeBound(options?.pageSize, DEFAULT_PAGE_SIZE);

  const sessionId = NodePath.basename(databasePath, ".db");
  const records: AntigravityUsageRecord[] = [];
  const errors: string[] = [];

  let rowsRead = 0;
  let recordsParsed = 0;
  let skippedEmptyUsage = 0;
  let malformedRows = 0;
  let cumulativeBytes = 0;
  let truncated = false;
  let latestContextSnapshot: AntigravityContextSnapshot | undefined;

  let db: SqliteDbHandle | null = null;

  try {
    db = await openSqliteDatabase(databasePath);

    const checkStmt = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='gen_metadata' LIMIT 1;",
    );
    if (!checkStmt.get()) {
      return {
        databasePath,
        sessionId,
        rowsRead: 0,
        bytesRead: 0,
        recordsParsed: 0,
        skippedEmptyUsage: 0,
        malformedRows: 0,
        truncated: false,
        records: [],
        errors: [],
      };
    }

    // Two-step bounded keyset pagination:
    // 1. Read metadata index page (idx, byte_len) WITHOUT materializing blobs
    // 2. Fetch single bounded blob only if within maxBlobSize and remaining byte budget
    const pageStmt = db.prepare(`
      SELECT
        idx,
        COALESCE(length(data), 0) AS byte_len
      FROM gen_metadata
      WHERE idx > ?
      ORDER BY idx ASC
      LIMIT ?;
    `);

    const blobStmt = db.prepare(`
      SELECT CASE WHEN length(data) <= ? THEN data ELSE NULL END AS data FROM gen_metadata WHERE idx = ?;
    `);

    let lastIdx = -1;
    let hasMore = true;

    while (hasMore) {
      if (rowsRead >= maxRowsPerDb) {
        truncated = true;
        break;
      }

      const limit = Math.min(pageSize, maxRowsPerDb - rowsRead + 1);
      let rawRows: unknown[] = [];

      try {
        rawRows = pageStmt.all(lastIdx, limit);
      } catch (stepErr) {
        if (errors.length < MAX_RECORDED_ERRORS) {
          errors.push(
            `Database step error at lastIdx ${lastIdx}: ${stepErr instanceof Error ? stepErr.message : String(stepErr)}`,
          );
        }
        truncated = true;
        break;
      }

      if (rawRows.length === 0) {
        hasMore = false;
        break;
      }

      for (const rawRow of rawRows) {
        if (rowsRead >= maxRowsPerDb) {
          truncated = true;
          hasMore = false;
          break;
        }

        const meta = parseGenMetadataIndexRow(rawRow);
        if (!meta) {
          malformedRows++;
          rowsRead++;
          // Guarantee progress: advance lastIdx even for malformed rows to prevent duplicate loops
          const candidateIdx = extractRawIdx(rawRow);
          if (candidateIdx !== null && candidateIdx > lastIdx) {
            lastIdx = candidateIdx;
          } else {
            truncated = true;
            hasMore = false;
            break;
          }
          continue;
        }

        const { idx: rowIdx, byte_len: byteLen } = meta;
        lastIdx = rowIdx;
        rowsRead++;

        if (byteLen > maxBlobSize) {
          malformedRows++;
          if (errors.length < MAX_RECORDED_ERRORS) {
            errors.push(`Row ${rowIdx} exceeds maxBlobSize (${byteLen} > ${maxBlobSize})`);
          }
          continue;
        }

        if (cumulativeBytes + byteLen > maxTotalBytes) {
          truncated = true;
          hasMore = false;
          break;
        }

        let rawBlobRow: unknown;
        try {
          rawBlobRow = blobStmt.get(Math.min(maxBlobSize, maxTotalBytes - cumulativeBytes), rowIdx);
        } catch (blobErr) {
          malformedRows++;
          if (errors.length < MAX_RECORDED_ERRORS) {
            errors.push(
              `Failed fetching blob for row ${rowIdx}: ${blobErr instanceof Error ? blobErr.message : String(blobErr)}`,
            );
          }
          continue;
        }

        const blob = extractBlobData(rawBlobRow);
        if (!blob) {
          malformedRows++;
          if (errors.length < MAX_RECORDED_ERRORS) {
            errors.push(`Row ${rowIdx}: missing or invalid blob payload`);
          }
          continue;
        }

        cumulativeBytes += byteLen;

        const parseResult = parseAntigravityGenMetadataBlob(blob, { sessionId, rowIdx });

        if (!parseResult.success) {
          malformedRows++;
          if (errors.length < MAX_RECORDED_ERRORS) {
            errors.push(`Row ${rowIdx}: ${parseResult.reason}`);
          }
          continue;
        }

        if (parseResult.contextSnapshot) {
          if (
            !latestContextSnapshot ||
            parseResult.contextSnapshot.timestampMs >= latestContextSnapshot.timestampMs
          ) {
            latestContextSnapshot = parseResult.contextSnapshot;
          }
        }

        if (parseResult.record) {
          records.push(parseResult.record);
          recordsParsed++;
        } else {
          skippedEmptyUsage++;
        }
      }

      if (rawRows.length < limit) {
        hasMore = false;
      }
    }
  } catch (dbErr) {
    if (errors.length < MAX_RECORDED_ERRORS) {
      errors.push(
        `SQLite read error for ${databasePath}: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`,
      );
    }
    truncated = true;
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // ignore close errors
      }
    }
  }

  return {
    databasePath,
    sessionId,
    rowsRead,
    bytesRead: cumulativeBytes,
    recordsParsed,
    skippedEmptyUsage,
    malformedRows,
    truncated,
    records,
    latestContextSnapshot,
    errors,
  };
}

/* -------------------------------------------------------------------------- */
/* Fast Context Window Snapshot Reader (Bounded Newest Rows DESC)             */
/* -------------------------------------------------------------------------- */

/**
 * Efficiently reads the latest context window snapshot from an Antigravity database
 * by scanning bounded newest rows in descending order (`ORDER BY idx DESC LIMIT 32`).
 *
 * Does NOT perform a full history scan or deserialize all records.
 */
export async function readAntigravityLatestContext(
  databasePath: string,
  options?: AntigravityLatestContextOptions,
): Promise<AntigravityContextSnapshot | undefined> {
  const maxRows = normalizeBound(options?.maxRows, 32);
  const maxBlobSize = normalizeBound(options?.maxBlobSize, DEFAULT_MAX_BLOB_SIZE);
  const maxTotalBytes = normalizeBound(options?.maxTotalBytes, 8 * 1024 * 1024);

  const sessionId = NodePath.basename(databasePath, ".db");
  let db: SqliteDbHandle | null = null;
  let cumulativeBytes = 0;

  try {
    db = await openSqliteDatabase(databasePath);

    const checkStmt = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='gen_metadata' LIMIT 1;",
    );
    if (!checkStmt.get()) {
      return undefined;
    }

    const descStmt = db.prepare(`
      SELECT idx, COALESCE(length(data), 0) AS byte_len
      FROM gen_metadata
      ORDER BY idx DESC
      LIMIT ?;
    `);

    const blobStmt = db.prepare(`
      SELECT CASE WHEN length(data) <= ? THEN data ELSE NULL END AS data FROM gen_metadata WHERE idx = ?;
    `);

    const rawRows = descStmt.all(maxRows);
    for (const rawRow of rawRows) {
      const meta = parseGenMetadataIndexRow(rawRow);
      if (!meta) continue;

      const { idx: rowIdx, byte_len: byteLen } = meta;
      if (byteLen > maxBlobSize) continue;

      if (cumulativeBytes + byteLen > maxTotalBytes) break;

      let rawBlobRow: unknown;
      try {
        rawBlobRow = blobStmt.get(Math.min(maxBlobSize, maxTotalBytes - cumulativeBytes), rowIdx);
      } catch {
        continue;
      }

      const blob = extractBlobData(rawBlobRow);
      if (!blob) continue;

      cumulativeBytes += blob.byteLength;
      const parseResult = parseAntigravityGenMetadataBlob(blob, { sessionId, rowIdx });
      if (parseResult.success && parseResult.contextSnapshot) {
        return parseResult.contextSnapshot;
      }
    }

    return undefined;
  } catch {
    return undefined;
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // ignore close errors
      }
    }
  }
}
