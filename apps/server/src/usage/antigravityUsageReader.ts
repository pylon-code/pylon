// @effect-diagnostics nodeBuiltinImport:off
/**
 * Bounded read-only reader for native Antigravity SQLite conversation histories.
 *
 * Antigravity stores session trajectories in SQLite databases under:
 *   - Per-instance roots (e.g. `<appDataDir>/conversations/<session-id>.db`)
 *   - Standalone CLI roots (e.g. `~/.gemini/antigravity-cli/conversations/<session-id>.db`)
 *
 * Each database has a `gen_metadata` table containing raw protobuf payloads
 * for each generation step:
 *   - `idx` (INTEGER): Generation sequence index
 *   - `data` (BLOB): Wire-encoded `CortexStepGeneratorMetadata`
 *   - `size` (INTEGER): Payload size in bytes
 *
 * Protobuf schema provenance (extracted from `localharness_external` binary via
 * FileDescriptorProto inspection):
 *   - `CortexStepGeneratorMetadata`:
 *       field 1: `chat_model` (message `ChatModelMetadata`)
 *       field 2: `step_indices` (packed/repeated uint32)
 *       field 4: `execution_id` (string)
 *   - `ChatModelMetadata`:
 *       field 4: `usage` (message `ModelUsageStats`)
 *       field 9: `chat_start_metadata` (message `ChatStartMetadata`)
 *       field 19: `response_model` (string)
 *       field 21: `model_display_name` (string)
 *       field 22: `response_model_full` (string)
 *       field 3: `model` (enum int32)
 *       field 5: `model_cost` (float32, meaning not proved USD -> not reported as money)
 *   - `ChatStartMetadata`:
 *       field 4: `created_at` (message `google.protobuf.Timestamp`)
 *   - `google.protobuf.Timestamp`:
 *       field 1: `seconds` (int64)
 *       field 2: `nanos` (int32)
 *   - `ModelUsageStats`:
 *       field 2: `input_tokens` (uint64) - uncached input tokens (verified disjoint from cache)
 *       field 3: `output_tokens` (uint64) - total output tokens (includes thinking)
 *       field 4: `cache_write_tokens` (uint64) - cache creation tokens
 *       field 5: `cache_read_tokens` (uint64) - cached prompt input tokens
 *       field 9: `thinking_output_tokens` (uint64) - reasoning tokens subset of output
 *       field 10: `response_output_tokens` (uint64) - visible output tokens subset of output
 *
 * Note on `steps.metadata`: `steps.metadata` repeats `model_usage` (field 9)
 * for each turn step. To avoid double-counting, only `gen_metadata` unique
 * generation rows are read.
 *
 * @module antigravityUsageReader
 */

import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { UsageTokenTotals } from "@t3tools/contracts";

/* -------------------------------------------------------------------------- */
/* Public Types and Interfaces                                                */
/* -------------------------------------------------------------------------- */

export type AntigravityUsageProvider = "antigravity";

/**
 * UsageRecord-compatible representation for Antigravity generations.
 *
 * Matches the existing `UsageRecord` contract so callers and aggregators
 * can consume it interchangeably while preserving Antigravity-specific
 * lineage metadata (`executionId`, `genIndex`).
 */
export interface AntigravityUsageRecord {
  readonly provider: AntigravityUsageProvider;
  readonly timestampMs: number;
  readonly model: string;
  readonly sessionId: string;
  readonly totals: UsageTokenTotals;
  readonly reportedCostUsd: number | null;
  readonly dedupeKey: string | null;
  readonly executionId: string | null;
  readonly genIndex: number;
}

export interface AntigravityReadOptions {
  /** Filter out records before this UNIX timestamp in milliseconds. */
  readonly sinceMs?: number;
  /** Maximum rows to read per database (bounded resource guard). Default: 50,000. */
  readonly maxRowsPerDb?: number;
  /** Maximum allowed size for a single protobuf blob in bytes. Default: 10 MiB. */
  readonly maxBlobSize?: number;
  /** Maximum protobuf message nesting depth. Default: 10. */
  readonly maxNestingDepth?: number;
  /** Whether to include records where all token counts are 0. Default: false. */
  readonly includeEmptyUsage?: boolean;
}

export interface AntigravityDatabaseReadResult {
  readonly dbPath: string;
  readonly sessionId: string;
  readonly records: ReadonlyArray<AntigravityUsageRecord>;
  readonly rowsRead: number;
  readonly recordsParsed: number;
  readonly skippedEmptyUsage: number;
  readonly malformedRows: number;
  readonly errors: ReadonlyArray<{ readonly rowIdx: number; readonly reason: string }>;
}

export interface AntigravityScanResult {
  readonly records: ReadonlyArray<AntigravityUsageRecord>;
  readonly databasesScanned: number;
  readonly totalRowsRead: number;
  readonly totalRecordsParsed: number;
  readonly skippedEmptyUsage: number;
  readonly malformedRows: number;
  readonly databaseResults: ReadonlyArray<AntigravityDatabaseReadResult>;
}

export type ParseBlobOutcome =
  | {
      readonly success: true;
      readonly record: AntigravityUsageRecord | null;
      readonly isEmpty: boolean;
    }
  | {
      readonly success: false;
      readonly reason: string;
    };

/* -------------------------------------------------------------------------- */
/* Constants & Safety Limits                                                  */
/* -------------------------------------------------------------------------- */

export const DEFAULT_MAX_BLOB_SIZE = 10 * 1024 * 1024; // 10 MiB
export const DEFAULT_MAX_NESTING_DEPTH = 10;
export const DEFAULT_MAX_ROWS_PER_DATABASE = 50_000;

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LENGTH_DELIMITED = 2;
const WIRE_FIXED32 = 5;

const TEXT_DECODER = new TextDecoder("utf-8", { fatal: false });

/* -------------------------------------------------------------------------- */
/* Bounded Protobuf Wire Reader                                               */
/* -------------------------------------------------------------------------- */

/**
 * Safely decodes a 64-bit varint from a Uint8Array buffer without 32-bit overflow.
 */
export function readVarint(
  bytes: Uint8Array,
  offset: number,
): { readonly value: bigint; readonly nextOffset: number } {
  let value = 0n;
  let shift = 0n;
  let current = offset;
  while (current < bytes.length) {
    const byte = bytes[current++];
    if (byte === undefined) {
      throw new Error(`Unexpected EOF while reading varint at offset ${offset}`);
    }
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value, nextOffset: current };
    }
    shift += 7n;
    if (shift > 70n) {
      throw new Error(`Varint overflow at offset ${offset}`);
    }
  }
  throw new Error(`Unexpected EOF while reading varint at offset ${offset}`);
}

export interface ProtobufRawField {
  readonly tag: number;
  readonly wireType: number;
  readonly varintValue: bigint | null;
  readonly bytesValue: Uint8Array | null;
  readonly offset: number;
  readonly length: number;
}

/**
 * Low-level generator that iterates over top-level protobuf fields within a byte slice.
 * Unrecognized fields of any valid wire type (0, 1, 2, 5) are safely skipped.
 */
export function* iterateProtobufFields(
  bytes: Uint8Array,
  start = 0,
  end = bytes.length,
): Generator<ProtobufRawField, void, unknown> {
  let offset = start;
  while (offset < end) {
    const { value: key, nextOffset } = readVarint(bytes, offset);
    offset = nextOffset;
    const tag = Number(key >> 3n);
    const wireType = Number(key & 7n);

    if (tag === 0) {
      throw new Error(`Invalid protobuf field tag 0 at offset ${offset}`);
    }

    if (wireType === WIRE_VARINT) {
      const { value, nextOffset: endOffset } = readVarint(bytes, offset);
      yield {
        tag,
        wireType,
        varintValue: value,
        bytesValue: null,
        offset,
        length: endOffset - offset,
      };
      offset = endOffset;
    } else if (wireType === WIRE_FIXED64) {
      if (offset + 8 > end) {
        throw new Error(`Fixed64 field ${tag} truncated at offset ${offset}`);
      }
      yield {
        tag,
        wireType,
        varintValue: null,
        bytesValue: bytes.subarray(offset, offset + 8),
        offset,
        length: 8,
      };
      offset += 8;
    } else if (wireType === WIRE_LENGTH_DELIMITED) {
      const { value: lengthBig, nextOffset: payloadOffset } = readVarint(bytes, offset);
      const length = Number(lengthBig);
      if (length < 0 || payloadOffset + length > end) {
        throw new Error(
          `Length-delimited field ${tag} length ${length} exceeds bounds at offset ${offset}`,
        );
      }
      yield {
        tag,
        wireType,
        varintValue: null,
        bytesValue: bytes.subarray(payloadOffset, payloadOffset + length),
        offset: payloadOffset,
        length,
      };
      offset = payloadOffset + length;
    } else if (wireType === WIRE_FIXED32) {
      if (offset + 4 > end) {
        throw new Error(`Fixed32 field ${tag} truncated at offset ${offset}`);
      }
      yield {
        tag,
        wireType,
        varintValue: null,
        bytesValue: bytes.subarray(offset, offset + 4),
        offset,
        length: 4,
      };
      offset += 4;
    } else {
      throw new Error(`Unsupported wire type ${wireType} for tag ${tag} at offset ${offset}`);
    }
  }
}

function safeNumber(value: bigint | number | null | undefined): number {
  if (value == null) return 0;
  if (typeof value === "bigint") {
    if (value <= 0n) return 0;
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER;
    return Number(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.trunc(value);
  }
  return 0;
}

/* -------------------------------------------------------------------------- */
/* Protobuf Message Decoders                                                  */
/* -------------------------------------------------------------------------- */

interface DecodedTimestamp {
  readonly seconds: bigint;
  readonly nanos: number;
}

function decodeTimestamp(bytes: Uint8Array): DecodedTimestamp {
  let seconds: bigint | null = null;
  let nanos = 0;

  for (const field of iterateProtobufFields(bytes)) {
    if (field.tag === 1 && field.wireType === WIRE_VARINT && field.varintValue != null) {
      seconds = BigInt.asIntN(64, field.varintValue);
    } else if (field.tag === 2 && field.wireType === WIRE_VARINT && field.varintValue != null) {
      nanos = Number(BigInt.asIntN(32, field.varintValue));
    }
  }

  if (seconds === null) {
    throw new Error("Missing required field 'seconds' in google.protobuf.Timestamp");
  }
  if (nanos < 0 || nanos > 999_999_999) {
    throw new Error(`Invalid nanos ${nanos} in google.protobuf.Timestamp`);
  }

  return { seconds, nanos };
}

interface DecodedModelUsageStats {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheWriteTokens: number;
  readonly cacheReadTokens: number;
  readonly thinkingOutputTokens: number;
  readonly responseOutputTokens: number;
}

function decodeModelUsageStats(bytes: Uint8Array): DecodedModelUsageStats {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheWriteTokens = 0;
  let cacheReadTokens = 0;
  let thinkingOutputTokens = 0;
  let responseOutputTokens = 0;

  for (const field of iterateProtobufFields(bytes)) {
    if (field.wireType === WIRE_VARINT && field.varintValue != null) {
      switch (field.tag) {
        case 2:
          inputTokens = safeNumber(field.varintValue);
          break;
        case 3:
          outputTokens = safeNumber(field.varintValue);
          break;
        case 4:
          cacheWriteTokens = safeNumber(field.varintValue);
          break;
        case 5:
          cacheReadTokens = safeNumber(field.varintValue);
          break;
        case 9:
          thinkingOutputTokens = safeNumber(field.varintValue);
          break;
        case 10:
          responseOutputTokens = safeNumber(field.varintValue);
          break;
        default:
          // Unknown or unselected varint field: safe to skip
          break;
      }
    }
    // All other fields (e.g. field 8 response_header) are intentionally skipped
    // without decoding to protect sensitive data and conserve cycles.
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

interface DecodedChatModelMetadata {
  readonly modelName: string;
  readonly usageStats: DecodedModelUsageStats | null;
  readonly createdAt: DecodedTimestamp | null;
}

function decodeChatModelMetadata(
  bytes: Uint8Array,
  depth: number,
  maxDepth: number,
): DecodedChatModelMetadata {
  if (depth > maxDepth) {
    throw new Error(`Max protobuf nesting depth ${maxDepth} exceeded in ChatModelMetadata`);
  }

  let responseModel: string | null = null;
  let responseModelFull: string | null = null;
  let modelDisplayName: string | null = null;
  let modelEnum: number | null = null;
  let usageStats: DecodedModelUsageStats | null = null;
  let createdAt: DecodedTimestamp | null = null;

  for (const field of iterateProtobufFields(bytes)) {
    if (field.wireType === WIRE_LENGTH_DELIMITED && field.bytesValue != null) {
      switch (field.tag) {
        case 4:
          usageStats = decodeModelUsageStats(field.bytesValue);
          break;
        case 9: {
          // chat_start_metadata: contains created_at at field 4
          for (const sub of iterateProtobufFields(field.bytesValue)) {
            if (sub.tag === 4 && sub.wireType === WIRE_LENGTH_DELIMITED && sub.bytesValue != null) {
              createdAt = decodeTimestamp(sub.bytesValue);
            }
          }
          break;
        }
        case 19:
          responseModel = TEXT_DECODER.decode(field.bytesValue).trim();
          break;
        case 21:
          modelDisplayName = TEXT_DECODER.decode(field.bytesValue).trim();
          break;
        case 22:
          responseModelFull = TEXT_DECODER.decode(field.bytesValue).trim();
          break;
        default:
          // Skip prompt texts, messages, tool configs, etc.
          break;
      }
    } else if (field.tag === 3 && field.wireType === WIRE_VARINT && field.varintValue != null) {
      modelEnum = Number(field.varintValue);
    }
  }

  const modelName =
    responseModel && responseModel.length > 0
      ? responseModel
      : responseModelFull && responseModelFull.length > 0
        ? responseModelFull
        : modelDisplayName && modelDisplayName.length > 0
          ? modelDisplayName
          : modelEnum != null && modelEnum > 0
            ? `antigravity-model-${modelEnum}`
            : "gemini-3.8-flash";

  return { modelName, usageStats, createdAt };
}

/* -------------------------------------------------------------------------- */
/* Blob Parser Implementation                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Pure parser for a single `gen_metadata.data` BLOB.
 *
 * Extracts token usage, response model, timestamp, and execution ID without
 * reading any prompt or conversation content. Validates wire constraints,
 * timestamps, and safe integer ranges.
 */
export function parseAntigravityGenMetadataBlob(
  data: Uint8Array,
  context: {
    readonly sessionId?: string;
    readonly rowIdx?: number;
    readonly maxBlobSize?: number;
    readonly maxNestingDepth?: number;
    readonly includeEmptyUsage?: boolean;
  } = {},
): ParseBlobOutcome {
  const maxBlobSize = context.maxBlobSize ?? DEFAULT_MAX_BLOB_SIZE;
  const maxNestingDepth = context.maxNestingDepth ?? DEFAULT_MAX_NESTING_DEPTH;
  const rowIdx = context.rowIdx ?? 0;

  if (data.length > maxBlobSize) {
    return {
      success: false,
      reason: `Payload size ${data.length} bytes exceeds maximum allowed ${maxBlobSize} bytes`,
    };
  }

  try {
    let chatModelMetadata: DecodedChatModelMetadata | null = null;
    let executionId: string | null = null;

    for (const field of iterateProtobufFields(data)) {
      if (field.tag === 1 && field.wireType === WIRE_LENGTH_DELIMITED && field.bytesValue != null) {
        chatModelMetadata = decodeChatModelMetadata(field.bytesValue, 1, maxNestingDepth);
      } else if (
        field.tag === 4 &&
        field.wireType === WIRE_LENGTH_DELIMITED &&
        field.bytesValue != null
      ) {
        executionId = TEXT_DECODER.decode(field.bytesValue).trim();
      }
      // field 2 step_indices and other fields are skipped
    }

    if (!chatModelMetadata) {
      return {
        success: false,
        reason: "Missing required chat_model field (tag 1) in CortexStepGeneratorMetadata",
      };
    }

    // Validate timestamp: must be present, positive, and within safe finite range
    if (!chatModelMetadata.createdAt) {
      return {
        success: false,
        reason: "Missing created_at timestamp in chat_start_metadata",
      };
    }

    const sec = chatModelMetadata.createdAt.seconds;
    if (sec <= 0n || sec > 253402300799n) {
      // 253402300799 is year 9999-12-31
      return {
        success: false,
        reason: `Timestamp seconds ${sec} outside safe range`,
      };
    }

    const timestampMs = Math.trunc(
      Number(sec) * 1000 + chatModelMetadata.createdAt.nanos / 1_000_000,
    );
    if (!Number.isFinite(timestampMs) || timestampMs <= 0) {
      return {
        success: false,
        reason: `Computed timestampMs ${timestampMs} is not a valid positive safe number`,
      };
    }

    const resolvedSessionId = executionId || context.sessionId || "unknown-session";
    const dedupeKey = `${resolvedSessionId}:${rowIdx}`;

    const usage = chatModelMetadata.usageStats;
    const totals: UsageTokenTotals = {
      uncachedInputTokens: usage ? usage.inputTokens : 0,
      cachedInputTokens: usage ? usage.cacheReadTokens : 0,
      cacheCreationTokens: usage ? usage.cacheWriteTokens : 0,
      outputTokens: usage ? usage.outputTokens : 0,
      reasoningTokens: usage ? usage.thinkingOutputTokens : 0,
    };

    const isAllZero =
      totals.uncachedInputTokens === 0 &&
      totals.cachedInputTokens === 0 &&
      totals.cacheCreationTokens === 0 &&
      totals.outputTokens === 0 &&
      totals.reasoningTokens === 0;

    if (isAllZero && !context.includeEmptyUsage) {
      return {
        success: true,
        record: null,
        isEmpty: true,
      };
    }

    const record: AntigravityUsageRecord = {
      provider: "antigravity",
      timestampMs,
      model: chatModelMetadata.modelName,
      sessionId: resolvedSessionId,
      totals,
      reportedCostUsd: null, // field 5 model_cost float meaning not proven USD
      dedupeKey,
      executionId,
      genIndex: rowIdx,
    };

    return {
      success: true,
      record,
      isEmpty: isAllZero,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      reason: `Protobuf decode error: ${message}`,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Read-Only SQLite Abstraction (Node & Bun Compatible)                      */
/* -------------------------------------------------------------------------- */

interface SqliteRow {
  readonly idx: number;
  readonly data: Uint8Array | null;
  readonly size: number | null;
}

interface SqliteReadOnlyDb {
  queryGenMetadata(limit: number): ReadonlyArray<SqliteRow>;
  close(): void;
}

async function openReadOnlyDatabase(dbPath: string): Promise<SqliteReadOnlyDb> {
  const isBun = typeof process !== "undefined" && process.versions?.bun !== undefined;

  if (isBun) {
    const { Database } = await import("bun:sqlite");
    const db = new Database(dbPath, { readonly: true });
    return {
      queryGenMetadata(limit: number) {
        const stmt = db.query("SELECT idx, data, size FROM gen_metadata ORDER BY idx ASC LIMIT ?");
        const rows = stmt.all(limit) as Array<{ idx: number; data: unknown; size: number | null }>;
        return rows.map((r) => ({
          idx: Number(r.idx),
          data:
            r.data == null
              ? null
              : r.data instanceof Uint8Array
                ? r.data
                : new Uint8Array(r.data as ArrayBuffer),
          size: r.size == null ? null : Number(r.size),
        }));
      },
      close() {
        db.close();
      },
    };
  } else {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true, open: true });
    return {
      queryGenMetadata(limit: number) {
        const stmt = db.prepare(
          "SELECT idx, data, size FROM gen_metadata ORDER BY idx ASC LIMIT ?",
        );
        const rows = stmt.all(limit) as Array<{ idx: number; data: unknown; size: number | null }>;
        return rows.map((r) => ({
          idx: Number(r.idx),
          data:
            r.data == null
              ? null
              : r.data instanceof Uint8Array
                ? r.data
                : new Uint8Array(r.data as ArrayBuffer),
          size: r.size == null ? null : Number(r.size),
        }));
      },
      close() {
        db.close();
      },
    };
  }
}

/* -------------------------------------------------------------------------- */
/* High-Level Reader APIs                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Reads an Antigravity SQLite database strictly in read-only mode and parses
 * all generation metadata rows.
 */
export async function readAntigravityDatabase(
  dbPath: string,
  options: AntigravityReadOptions = {},
): Promise<AntigravityDatabaseReadResult> {
  const maxRows = options.maxRowsPerDb ?? DEFAULT_MAX_ROWS_PER_DATABASE;
  const maxBlobSize = options.maxBlobSize ?? DEFAULT_MAX_BLOB_SIZE;
  const maxNestingDepth = options.maxNestingDepth ?? DEFAULT_MAX_NESTING_DEPTH;
  const sinceMs = options.sinceMs;
  const includeEmptyUsage = options.includeEmptyUsage ?? false;

  const fallbackSessionId = NodePath.basename(dbPath).replace(/\.db$/, "");

  let db: SqliteReadOnlyDb | null = null;
  try {
    db = await openReadOnlyDatabase(dbPath);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      dbPath,
      sessionId: fallbackSessionId,
      records: [],
      rowsRead: 0,
      recordsParsed: 0,
      skippedEmptyUsage: 0,
      malformedRows: 1,
      errors: [{ rowIdx: -1, reason: `Failed to open SQLite database read-only: ${reason}` }],
    };
  }

  let rawRows: ReadonlyArray<SqliteRow> = [];
  try {
    rawRows = db.queryGenMetadata(maxRows);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      dbPath,
      sessionId: fallbackSessionId,
      records: [],
      rowsRead: 0,
      recordsParsed: 0,
      skippedEmptyUsage: 0,
      malformedRows: 0,
      errors: [
        {
          rowIdx: -1,
          reason: `Failed to query gen_metadata (table missing or unreadable): ${reason}`,
        },
      ],
    };
  } finally {
    try {
      db.close();
    } catch {
      // ignore close error
    }
  }

  const records: AntigravityUsageRecord[] = [];
  let skippedEmptyUsage = 0;
  let malformedRows = 0;
  const errors: Array<{ readonly rowIdx: number; readonly reason: string }> = [];

  for (const row of rawRows) {
    if (!row.data || row.data.byteLength === 0) {
      skippedEmptyUsage += 1;
      continue;
    }

    const outcome = parseAntigravityGenMetadataBlob(row.data, {
      sessionId: fallbackSessionId,
      rowIdx: row.idx,
      maxBlobSize,
      maxNestingDepth,
      includeEmptyUsage,
    });

    if (outcome.success) {
      if (outcome.record) {
        if (sinceMs == null || outcome.record.timestampMs >= sinceMs) {
          records.push(outcome.record);
        }
      } else if (outcome.isEmpty) {
        skippedEmptyUsage += 1;
      }
    } else {
      malformedRows += 1;
      errors.push({ rowIdx: row.idx, reason: outcome.reason });
    }
  }

  return {
    dbPath,
    sessionId: records[0]?.sessionId ?? fallbackSessionId,
    records,
    rowsRead: rawRows.length,
    recordsParsed: records.length,
    skippedEmptyUsage,
    malformedRows,
    errors,
  };
}

/**
 * Scans an explicit directory for `*.db` files and parses all Antigravity
 * generation histories found.
 */
export async function readAntigravityDirectory(
  dirPath: string,
  options: AntigravityReadOptions = {},
): Promise<AntigravityScanResult> {
  let entries: NodeFS.Dirent[];
  try {
    entries = await NodeFSP.readdir(dirPath, { withFileTypes: true });
  } catch {
    return {
      records: [],
      databasesScanned: 0,
      totalRowsRead: 0,
      totalRecordsParsed: 0,
      skippedEmptyUsage: 0,
      malformedRows: 0,
      databaseResults: [],
    };
  }

  const dbPaths = entries
    .filter((e) => (e.isFile() || e.isSymbolicLink()) && e.name.endsWith(".db"))
    .map((e) => NodePath.join(dirPath, e.name))
    .sort();

  return readAntigravityPaths(dbPaths, options);
}

/**
 * Reads a list of explicit database paths, aggregating records and status counters.
 */
export async function readAntigravityPaths(
  paths: ReadonlyArray<string>,
  options: AntigravityReadOptions = {},
): Promise<AntigravityScanResult> {
  const databaseResults: AntigravityDatabaseReadResult[] = [];
  const allRecords: AntigravityUsageRecord[] = [];
  let totalRowsRead = 0;
  let totalRecordsParsed = 0;
  let skippedEmptyUsage = 0;
  let malformedRows = 0;

  for (const path of paths) {
    const result = await readAntigravityDatabase(path, options);
    databaseResults.push(result);
    totalRowsRead += result.rowsRead;
    totalRecordsParsed += result.recordsParsed;
    skippedEmptyUsage += result.skippedEmptyUsage;
    malformedRows += result.malformedRows;
    for (const record of result.records) {
      allRecords.push(record);
    }
  }

  return {
    records: allRecords,
    databasesScanned: databaseResults.length,
    totalRowsRead,
    totalRecordsParsed,
    skippedEmptyUsage,
    malformedRows,
    databaseResults,
  };
}

/* -------------------------------------------------------------------------- */
/* Synthetic Protobuf Serializer (for Tests & Tooling)                        */
/* -------------------------------------------------------------------------- */

export interface SyntheticGenMetadataInput {
  readonly executionId?: string;
  readonly modelName?: string;
  readonly timestampSeconds: bigint | number;
  readonly timestampNanos?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly cacheReadTokens?: number;
  readonly thinkingOutputTokens?: number;
  readonly responseOutputTokens?: number;
  readonly extraFields?: ReadonlyArray<{
    readonly tag: number;
    readonly wireType: number;
    readonly value: bigint | Uint8Array;
  }>;
}

export function writeVarint(value: bigint | number): Uint8Array {
  let v = typeof value === "bigint" ? value : BigInt(value);
  if (v < 0n) {
    v = BigInt.asUintN(64, v);
  }
  const out: number[] = [];
  while (v >= 0x80n) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v & 0x7fn));
  return new Uint8Array(out);
}

function concatBuffers(bufs: ReadonlyArray<Uint8Array>): Uint8Array {
  const total = bufs.reduce((sum, b) => sum + b.length, 0);
  const res = new Uint8Array(total);
  let offset = 0;
  for (const b of bufs) {
    res.set(b, offset);
    offset += b.length;
  }
  return res;
}

function encodeField(tag: number, wireType: number, payload: Uint8Array): Uint8Array {
  const key = writeVarint(BigInt((tag << 3) | wireType));
  if (wireType === WIRE_LENGTH_DELIMITED) {
    const len = writeVarint(payload.length);
    return concatBuffers([key, len, payload]);
  }
  return concatBuffers([key, payload]);
}

/**
 * Builds a synthetic `CortexStepGeneratorMetadata` protobuf BLOB matching the
 * native schema without relying on external protobuf compilers.
 */
export function encodeSyntheticGenMetadataBlob(input: SyntheticGenMetadataInput): Uint8Array {
  const textEncoder = new TextEncoder();

  // 1. google.protobuf.Timestamp
  const tsParts: Uint8Array[] = [];
  tsParts.push(encodeField(1, WIRE_VARINT, writeVarint(input.timestampSeconds)));
  if (input.timestampNanos != null && input.timestampNanos > 0) {
    tsParts.push(encodeField(2, WIRE_VARINT, writeVarint(input.timestampNanos)));
  }
  const timestampBlob = concatBuffers(tsParts);

  // 2. ChatStartMetadata (field 4 is created_at)
  const chatStartBlob = encodeField(4, WIRE_LENGTH_DELIMITED, timestampBlob);

  // 3. ModelUsageStats
  const usageParts: Uint8Array[] = [];
  if (input.inputTokens != null) {
    usageParts.push(encodeField(2, WIRE_VARINT, writeVarint(input.inputTokens)));
  }
  if (input.outputTokens != null) {
    usageParts.push(encodeField(3, WIRE_VARINT, writeVarint(input.outputTokens)));
  }
  if (input.cacheWriteTokens != null) {
    usageParts.push(encodeField(4, WIRE_VARINT, writeVarint(input.cacheWriteTokens)));
  }
  if (input.cacheReadTokens != null) {
    usageParts.push(encodeField(5, WIRE_VARINT, writeVarint(input.cacheReadTokens)));
  }
  if (input.thinkingOutputTokens != null) {
    usageParts.push(encodeField(9, WIRE_VARINT, writeVarint(input.thinkingOutputTokens)));
  }
  if (input.responseOutputTokens != null) {
    usageParts.push(encodeField(10, WIRE_VARINT, writeVarint(input.responseOutputTokens)));
  }
  const usageBlob = concatBuffers(usageParts);

  // 4. ChatModelMetadata
  const cmParts: Uint8Array[] = [];
  if (input.modelName != null) {
    cmParts.push(encodeField(19, WIRE_LENGTH_DELIMITED, textEncoder.encode(input.modelName)));
  }
  if (usageParts.length > 0) {
    cmParts.push(encodeField(4, WIRE_LENGTH_DELIMITED, usageBlob));
  }
  cmParts.push(encodeField(9, WIRE_LENGTH_DELIMITED, chatStartBlob));

  // Add any extra fields (e.g. unknown tags to test wire skipping)
  if (input.extraFields) {
    for (const ef of input.extraFields) {
      if (ef.wireType === WIRE_VARINT && typeof ef.value === "bigint") {
        cmParts.push(encodeField(ef.tag, WIRE_VARINT, writeVarint(ef.value)));
      } else if (ef.value instanceof Uint8Array) {
        cmParts.push(encodeField(ef.tag, ef.wireType, ef.value));
      }
    }
  }
  const chatModelBlob = concatBuffers(cmParts);

  // 5. CortexStepGeneratorMetadata
  const genParts: Uint8Array[] = [];
  genParts.push(encodeField(1, WIRE_LENGTH_DELIMITED, chatModelBlob));
  if (input.executionId != null) {
    genParts.push(encodeField(4, WIRE_LENGTH_DELIMITED, textEncoder.encode(input.executionId)));
  }

  return concatBuffers(genParts);
}
