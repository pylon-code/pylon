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

import * as NodeFS from "node:fs";
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

/** Maximum number of SQLite database files scanned per directory. */
export const DEFAULT_MAX_FILES_PER_DIRECTORY = 500;

/** Maximum global files scanned in a single multi-path request. */
export const DEFAULT_MAX_TOTAL_FILES = 1_000;

/** Maximum cumulative bytes read across an entire directory (default 256 MiB). */
export const DEFAULT_MAX_DIRECTORY_TOTAL_BYTES = 256 * 1024 * 1024;

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
  readonly recordsParsed: number;
  readonly skippedEmptyUsage: number;
  readonly malformedRows: number;
  readonly truncated: boolean;
  readonly records: readonly AntigravityUsageRecord[];
  readonly latestContextSnapshot?: AntigravityContextSnapshot | undefined;
  readonly errors: readonly string[];
}

export interface AntigravityScanResult {
  readonly directoryPath: string;
  readonly directoryExists: boolean;
  readonly databasesScanned: number;
  readonly totalRowsRead: number;
  readonly totalRecordsParsed: number;
  readonly totalMalformedRows: number;
  readonly truncated: boolean;
  readonly records: readonly AntigravityUsageRecord[];
  readonly latestContextSnapshot?: AntigravityContextSnapshot | undefined;
  readonly errors: readonly string[];
  readonly error?: string | undefined;
}

export interface AntigravityReaderOptions {
  readonly maxBlobSize?: number;
  readonly maxRowsPerDb?: number;
  readonly maxTotalBytesPerDb?: number;
  readonly pageSize?: number;
  readonly maxFilesPerDirectory?: number;
  readonly maxTotalFiles?: number;
  readonly maxDirectoryTotalBytes?: number;
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
/* Sanitization & Predicates                                                  */
/* -------------------------------------------------------------------------- */

function normalizeBound(value: number | undefined, fallback: number): number {
  if (value === undefined || Number.isNaN(value) || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.min(Math.trunc(value), Number.MAX_SAFE_INTEGER);
}

function strictSafeNonNegativeInteger(n: bigint | number, label: string): number {
  const bi = typeof n === "bigint" ? n : BigInt(n);
  if (bi < 0n) {
    throw new Error(`${label} cannot be negative (got ${bi.toString()})`);
  }
  if (bi > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} exceeds MAX_SAFE_INTEGER (got ${bi.toString()})`);
  }
  return Number(bi);
}

interface GenMetadataRow {
  readonly idx: number;
  readonly byte_len: number;
  readonly data: Uint8Array | null;
}

function isGenMetadataRow(raw: unknown): raw is GenMetadataRow {
  if (typeof raw !== "object" || raw === null) return false;
  const r = raw as Record<string, unknown>;
  const idx = r.idx;
  const byteLen = r.byte_len;
  if (typeof idx !== "number" && typeof idx !== "bigint") return false;
  if (typeof byteLen !== "number" && typeof byteLen !== "bigint") return false;

  const numIdx = Number(idx);
  const numByteLen = Number(byteLen);
  if (!Number.isSafeInteger(numIdx) || numIdx < 0) return false;
  if (!Number.isSafeInteger(numByteLen) || numByteLen < 0) return false;

  const data = r.data;
  if (data === null || data === undefined) return true;
  if (data instanceof Uint8Array) return true;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) return true;
  return false;
}

function normalizeRowData(data: unknown): Uint8Array | null {
  if (data === null || data === undefined) return null;
  if (data instanceof Uint8Array) return data;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Low-Level Protobuf Decoding Helpers                                        */
/* -------------------------------------------------------------------------- */

export function readVarint(
  bytes: Uint8Array,
  offset: number,
): { readonly value: bigint; readonly nextOffset: number } {
  let result = 0n;
  let shift = 0n;
  let current = offset;
  let bytesRead = 0;

  while (current < bytes.length) {
    if (bytesRead >= 10) {
      throw new Error(`Varint overflow: exceeds 10 bytes at byte offset ${offset}`);
    }
    const byte = bytes[current++];
    if (byte === undefined) {
      throw new Error(`Unexpected EOF reading varint at byte offset ${current - 1}`);
    }
    bytesRead++;

    if (bytesRead === 10) {
      if ((byte & 0xfe) !== 0) {
        throw new Error(
          `Varint overflow: 10th byte has invalid high bits 0x${byte.toString(16)} at offset ${current - 1}`,
        );
      }
      result |= BigInt(byte & 0x01) << shift;
      return { value: result, nextOffset: current };
    }

    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value: result, nextOffset: current };
    }
    shift += 7n;
  }

  throw new Error(`Unexpected EOF reading varint at byte offset ${current}`);
}

export function* iterateProtobufFields(bytes: Uint8Array): Generator<{
  readonly tag: number;
  readonly wireType: number;
  readonly varintValue?: bigint;
  readonly bytesValue?: Uint8Array;
}> {
  let offset = 0;
  const len = bytes.length;

  while (offset < len) {
    const keyResult = readVarint(bytes, offset);
    offset = keyResult.nextOffset;
    const tag = Number(keyResult.value >> 3n);
    const wireType = Number(keyResult.value & 0x07n);

    if (tag <= 0) {
      throw new Error(`Invalid protobuf field tag 0 at offset ${offset}`);
    }

    switch (wireType) {
      case WIRE_VARINT: {
        const varintRes = readVarint(bytes, offset);
        offset = varintRes.nextOffset;
        yield { tag, wireType, varintValue: varintRes.value };
        break;
      }
      case WIRE_FIXED64: {
        if (offset + 8 > len) throw new Error("Unexpected EOF reading fixed64");
        offset += 8;
        yield { tag, wireType };
        break;
      }
      case WIRE_LENGTH_DELIMITED: {
        const lengthRes = readVarint(bytes, offset);
        offset = lengthRes.nextOffset;
        const fieldLength = strictSafeNonNegativeInteger(
          lengthRes.value,
          `Field length for tag ${tag}`,
        );
        if (offset + fieldLength > len) {
          throw new Error(
            `Unexpected EOF: length-delimited field tag ${tag} requires ${fieldLength} bytes, but only ${len - offset} remain`,
          );
        }
        const slice = bytes.subarray(offset, offset + fieldLength);
        offset += fieldLength;
        yield { tag, wireType, bytesValue: slice };
        break;
      }
      case WIRE_FIXED32: {
        if (offset + 4 > len) throw new Error("Unexpected EOF reading fixed32");
        offset += 4;
        yield { tag, wireType };
        break;
      }
      case WIRE_START_GROUP:
      case WIRE_END_GROUP:
      default:
        throw new Error(
          `Unsupported wire type ${wireType} for tag ${tag} at byte offset ${offset}`,
        );
    }
  }
}

/* -------------------------------------------------------------------------- */
/* High-Level Protobuf Blob Parser                                            */
/* -------------------------------------------------------------------------- */

export function parseAntigravityGenMetadataBlob(
  blob: Uint8Array,
  options: AntigravityParserOptions,
): BlobParseOutcome {
  try {
    let chatModelBytes: Uint8Array | null = null;

    // 1. CortexStepGeneratorMetadata
    for (const field of iterateProtobufFields(blob)) {
      if (field.tag === 1) {
        if (field.wireType !== WIRE_LENGTH_DELIMITED || !field.bytesValue) {
          return {
            success: false,
            reason: `Invalid wire type ${field.wireType} for CortexStepGeneratorMetadata.chat_model (tag 1)`,
          };
        }
        chatModelBytes = field.bytesValue;
      }
    }

    if (!chatModelBytes) {
      return { success: true, record: null };
    }

    // 2. ChatModelMetadata
    let modelName: string | null = null;
    let modelEnum: number | null = null;
    let usageBytes: Uint8Array | null = null;
    let chatStartBytes: Uint8Array | null = null;

    const textDecoder = new TextDecoder("utf-8", { fatal: true });

    for (const field of iterateProtobufFields(chatModelBytes)) {
      if (field.tag === 3) {
        if (field.wireType !== WIRE_VARINT || field.varintValue === undefined) {
          return {
            success: false,
            reason: `Invalid wire type ${field.wireType} for ChatModelMetadata.model (tag 3)`,
          };
        }
        modelEnum = strictSafeNonNegativeInteger(field.varintValue, "ChatModelMetadata.model");
      } else if (field.tag === 4) {
        if (field.wireType !== WIRE_LENGTH_DELIMITED || !field.bytesValue) {
          return {
            success: false,
            reason: `Invalid wire type ${field.wireType} for ChatModelMetadata.usage (tag 4)`,
          };
        }
        usageBytes = field.bytesValue;
      } else if (field.tag === 9) {
        if (field.wireType !== WIRE_LENGTH_DELIMITED || !field.bytesValue) {
          return {
            success: false,
            reason: `Invalid wire type ${field.wireType} for ChatModelMetadata.chat_start_metadata (tag 9)`,
          };
        }
        chatStartBytes = field.bytesValue;
      } else if (field.tag === 19) {
        if (field.wireType !== WIRE_LENGTH_DELIMITED || !field.bytesValue) {
          return {
            success: false,
            reason: `Invalid wire type ${field.wireType} for ChatModelMetadata.model_name (tag 19)`,
          };
        }
        const decoded = textDecoder.decode(field.bytesValue).trim();
        if (decoded.length > 0 && decoded.length <= MAX_MODEL_NAME_LENGTH) {
          modelName = decoded;
        }
      }
    }

    // Determine model string
    let resolvedModel: string | null = null;
    if (modelName && modelName.length > 0) {
      resolvedModel = modelName;
    } else if (modelEnum !== null && modelEnum > 0) {
      resolvedModel = `antigravity-enum-${modelEnum}`;
    }

    // 3. ChatStartMetadata -> google.protobuf.Timestamp & ContextWindowMetadata
    let timestampMs: number | null = null;
    let estimatedTokensUsed: number | null = null;
    let maxContextTokens: number | null = null;

    if (chatStartBytes) {
      for (const field of iterateProtobufFields(chatStartBytes)) {
        if (field.tag === 4 && field.bytesValue) {
          let seconds = 0n;
          let nanos = 0;
          for (const tsField of iterateProtobufFields(field.bytesValue)) {
            if (tsField.tag === 1 && tsField.varintValue !== undefined) {
              seconds = tsField.varintValue;
            } else if (tsField.tag === 2 && tsField.varintValue !== undefined) {
              nanos = strictSafeNonNegativeInteger(tsField.varintValue, "Timestamp.nanos");
            }
          }
          if (seconds > 0n) {
            const secNum = strictSafeNonNegativeInteger(seconds, "Timestamp.seconds");
            timestampMs = secNum * 1000 + Math.floor(nanos / 1_000_000);
          }
        } else if (field.tag === 10 && field.bytesValue) {
          for (const cwField of iterateProtobufFields(field.bytesValue)) {
            if (cwField.tag === 1 && cwField.varintValue !== undefined) {
              estimatedTokensUsed = strictSafeNonNegativeInteger(
                cwField.varintValue,
                "ContextWindowMetadata.estimated_tokens_used",
              );
            } else if (cwField.tag === 4 && cwField.varintValue !== undefined) {
              maxContextTokens = strictSafeNonNegativeInteger(
                cwField.varintValue,
                "ContextWindowMetadata.max_context_tokens",
              );
            }
          }
        }
      }
    }

    // Construct context snapshot if valid capacity (> 0) is reported
    let contextSnapshot: AntigravityContextSnapshot | undefined;
    if (
      timestampMs !== null &&
      maxContextTokens !== null &&
      maxContextTokens > 0 &&
      estimatedTokensUsed !== null &&
      estimatedTokensUsed >= 0
    ) {
      contextSnapshot = {
        timestampMs,
        estimatedTokensUsed,
        maxContextTokens,
        genIndex: options.rowIdx,
      };
    }

    if (!usageBytes) {
      return { success: true, record: null, contextSnapshot };
    }

    // 4. ModelUsageStats
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheWriteTokens = 0;
    let cacheReadTokens = 0;
    let thinkingOutputTokens = 0;
    let responseOutputTokens = 0;

    for (const field of iterateProtobufFields(usageBytes)) {
      switch (field.tag) {
        case 2:
        case 3:
        case 4:
        case 5:
        case 9:
        case 10: {
          if (field.wireType !== WIRE_VARINT || field.varintValue === undefined) {
            return {
              success: false,
              reason: `Invalid wire type ${field.wireType} for ModelUsageStats tag ${field.tag}`,
            };
          }
          const val = strictSafeNonNegativeInteger(
            field.varintValue,
            `ModelUsageStats tag ${field.tag}`,
          );
          if (field.tag === 2) inputTokens = val;
          else if (field.tag === 3) outputTokens = val;
          else if (field.tag === 4) cacheWriteTokens = val;
          else if (field.tag === 5) cacheReadTokens = val;
          else if (field.tag === 9) thinkingOutputTokens = val;
          else if (field.tag === 10) responseOutputTokens = val;
          break;
        }
        default:
          // Unknown or non-token fields (e.g. tag 7 message_id string) safely skipped
          break;
      }
    }

    // Invariant checks
    if (thinkingOutputTokens > outputTokens) {
      return {
        success: false,
        reason: `Invariant violation: reasoningTokens (${thinkingOutputTokens}) > outputTokens (${outputTokens})`,
      };
    }

    if (
      inputTokens === 0 &&
      outputTokens === 0 &&
      cacheWriteTokens === 0 &&
      cacheReadTokens === 0 &&
      thinkingOutputTokens === 0 &&
      responseOutputTokens === 0
    ) {
      return { success: true, record: null, contextSnapshot };
    }

    if (!resolvedModel) {
      return {
        success: false,
        reason: `Missing model identification: neither model name nor valid enum present for row ${options.rowIdx}`,
      };
    }

    const record: AntigravityUsageRecord = {
      provider: "antigravity",
      sessionId: options.sessionId,
      genIndex: options.rowIdx,
      dedupeKey: `antigravity:${options.sessionId}:${options.rowIdx}`,
      timestampMs: timestampMs ?? 0,
      model: resolvedModel,
      totals: {
        uncachedInputTokens: inputTokens,
        cachedInputTokens: cacheReadTokens,
        cacheCreationTokens: cacheWriteTokens,
        outputTokens,
        reasoningTokens: thinkingOutputTokens,
      },
      reportedCostUsd: null,
      contextSnapshot,
    };

    return { success: true, record, contextSnapshot };
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

  let db: any = null;
  const isBun = typeof process !== "undefined" && process.versions?.bun !== undefined;

  try {
    if (isBun) {
      const { Database } = await import("bun:sqlite");
      db = new Database(databasePath, { readonly: true });
      db.run("PRAGMA busy_timeout = 3000;");
    } else {
      const { DatabaseSync } = await import("node:sqlite");
      db = new DatabaseSync(databasePath, { readOnly: true });
      db.exec("PRAGMA busy_timeout = 3000;");
    }

    // Check if table exists
    const checkStmt = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='gen_metadata' LIMIT 1;",
    );
    const tableExists = isBun ? checkStmt.get() : checkStmt.get();
    if (!tableExists) {
      return {
        databasePath,
        sessionId,
        rowsRead: 0,
        recordsParsed: 0,
        skippedEmptyUsage: 0,
        malformedRows: 0,
        truncated: false,
        records: [],
        errors: [],
      };
    }

    // Keyset pagination avoids materializing unbounded rows in memory
    const pageStmt = db.prepare(`
      SELECT
        idx,
        COALESCE(length(data), 0) AS byte_len,
        CASE WHEN length(data) <= ? THEN data ELSE NULL END AS data
      FROM gen_metadata
      WHERE idx > ?
      ORDER BY idx ASC
      LIMIT ?;
    `);

    let lastIdx = -1;
    let hasMore = true;

    while (hasMore) {
      if (rowsRead >= maxRowsPerDb) {
        truncated = true;
        break;
      }

      const limit = Math.min(pageSize, maxRowsPerDb - rowsRead + 1);
      let rows: unknown[] = [];

      try {
        if (isBun) {
          rows = pageStmt.all(maxBlobSize, lastIdx, limit);
        } else {
          rows = pageStmt.all(maxBlobSize, lastIdx, limit);
        }
      } catch (stepErr) {
        if (errors.length < MAX_RECORDED_ERRORS) {
          errors.push(
            `Database step error at lastIdx ${lastIdx}: ${stepErr instanceof Error ? stepErr.message : String(stepErr)}`,
          );
        }
        truncated = true;
        break;
      }

      if (rows.length === 0) {
        hasMore = false;
        break;
      }

      for (const rawRow of rows) {
        if (rowsRead >= maxRowsPerDb) {
          truncated = true;
          hasMore = false;
          break;
        }

        if (!isGenMetadataRow(rawRow)) {
          malformedRows++;
          rowsRead++;
          continue;
        }

        const rowIdx = Number(rawRow.idx);
        lastIdx = rowIdx;
        rowsRead++;

        const byteLen = Number(rawRow.byte_len);
        cumulativeBytes += byteLen;
        if (cumulativeBytes > maxTotalBytes) {
          truncated = true;
          hasMore = false;
          break;
        }

        const blob = normalizeRowData(rawRow.data);
        if (byteLen > maxBlobSize || blob === null) {
          malformedRows++;
          if (errors.length < MAX_RECORDED_ERRORS) {
            errors.push(`Row ${rowIdx} exceeds maxBlobSize (${byteLen} > ${maxBlobSize})`);
          }
          continue;
        }

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

      if (rows.length < limit) {
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
/* Multi-Database Directory & Path Aggregator                                 */
/* -------------------------------------------------------------------------- */

export async function readAntigravityPaths(
  databasePaths: readonly string[],
  options?: AntigravityReaderOptions,
): Promise<AntigravityScanResult> {
  const maxFiles = normalizeBound(options?.maxTotalFiles, DEFAULT_MAX_TOTAL_FILES);
  const maxDirBytes = normalizeBound(
    options?.maxDirectoryTotalBytes,
    DEFAULT_MAX_DIRECTORY_TOTAL_BYTES,
  );

  const records: AntigravityUsageRecord[] = [];
  const errors: string[] = [];
  let totalRowsRead = 0;
  let totalRecordsParsed = 0;
  let totalMalformedRows = 0;
  let databasesScanned = 0;
  let cumulativeBytesAcrossFiles = 0;
  let truncated = false;
  let latestContextSnapshot: AntigravityContextSnapshot | undefined;

  const seenPaths = new Set<string>();

  for (const dbPath of databasePaths) {
    if (seenPaths.has(dbPath)) continue;
    seenPaths.add(dbPath);

    if (databasesScanned >= maxFiles) {
      truncated = true;
      break;
    }

    try {
      const stat = NodeFS.statSync(dbPath);
      cumulativeBytesAcrossFiles += stat.size;
      if (cumulativeBytesAcrossFiles > maxDirBytes) {
        truncated = true;
        break;
      }
    } catch {
      // File stat error, let readAntigravityDatabase handle it
    }

    const res = await readAntigravityDatabase(dbPath, options);
    databasesScanned++;
    totalRowsRead += res.rowsRead;
    totalRecordsParsed += res.recordsParsed;
    totalMalformedRows += res.malformedRows;
    if (res.truncated) truncated = true;

    for (const r of res.records) {
      records.push(r);
    }
    for (const e of res.errors) {
      if (errors.length < MAX_RECORDED_ERRORS) errors.push(e);
    }

    if (res.latestContextSnapshot) {
      if (
        !latestContextSnapshot ||
        res.latestContextSnapshot.timestampMs >= latestContextSnapshot.timestampMs
      ) {
        latestContextSnapshot = res.latestContextSnapshot;
      }
    }
  }

  return {
    directoryPath: "",
    directoryExists: true,
    databasesScanned,
    totalRowsRead,
    totalRecordsParsed,
    totalMalformedRows,
    truncated,
    records,
    latestContextSnapshot,
    errors,
  };
}

export async function readAntigravityDirectory(
  directoryPath: string,
  options?: AntigravityReaderOptions,
): Promise<AntigravityScanResult> {
  try {
    if (!NodeFS.existsSync(directoryPath)) {
      return {
        directoryPath,
        directoryExists: false,
        databasesScanned: 0,
        totalRowsRead: 0,
        totalRecordsParsed: 0,
        totalMalformedRows: 0,
        truncated: false,
        records: [],
        errors: [],
        error: `Directory does not exist: ${directoryPath}`,
      };
    }

    const stat = NodeFS.statSync(directoryPath);
    if (!stat.isDirectory()) {
      return {
        directoryPath,
        directoryExists: false,
        databasesScanned: 0,
        totalRowsRead: 0,
        totalRecordsParsed: 0,
        totalMalformedRows: 0,
        truncated: false,
        records: [],
        errors: [],
        error: `Path is not a directory: ${directoryPath}`,
      };
    }

    const maxFiles = normalizeBound(options?.maxFilesPerDirectory, DEFAULT_MAX_FILES_PER_DIRECTORY);
    const dirents = NodeFS.readdirSync(directoryPath, { withFileTypes: true });
    const dbPaths: string[] = [];

    for (const ent of dirents) {
      if ((ent.isFile() || ent.isSymbolicLink()) && ent.name.endsWith(".db")) {
        dbPaths.push(NodePath.join(directoryPath, ent.name));
        if (dbPaths.length >= maxFiles) break;
      }
    }

    dbPaths.sort();
    const scanRes = await readAntigravityPaths(dbPaths, options);

    return {
      ...scanRes,
      directoryPath,
      directoryExists: true,
      truncated: scanRes.truncated || dirents.length > maxFiles,
    };
  } catch (dirErr) {
    return {
      directoryPath,
      directoryExists: false,
      databasesScanned: 0,
      totalRowsRead: 0,
      totalRecordsParsed: 0,
      totalMalformedRows: 0,
      truncated: false,
      records: [],
      errors: [dirErr instanceof Error ? dirErr.message : String(dirErr)],
      error: `Failed to read directory: ${dirErr instanceof Error ? dirErr.message : String(dirErr)}`,
    };
  }
}
