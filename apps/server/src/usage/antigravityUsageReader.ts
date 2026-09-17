// @effect-diagnostics nodeBuiltinImport:off
/**
 * Bounded read-only reader for native Antigravity SQLite conversation histories.
 *
 * Source provenance:
 *   - Pinned release: agy_acp_server_1.1.1
 *   - Installed binary: localharness_external
 *   - SHA256: fdfa915652cdb7ba8085cc8fffed072cbe009251aa2c951aabdda07a8c28a189
 *
 * Schema extracted via embedded FileDescriptorProto in localharness_external:
 *   - CortexStepGeneratorMetadata:
 *       field 1: chat_model (ChatModelMetadata)
 *       field 4: execution_id (string)
 *   - ChatModelMetadata:
 *       field 3: model (enum int32)
 *       field 4: usage (ModelUsageStats)
 *       field 5: model_cost (float32, unproven USD -> never reported as money)
 *       field 9: chat_start_metadata (ChatStartMetadata)
 *       field 19: response_model (string)
 *       field 21: model_display_name (string)
 *       field 22: response_model_full (string)
 *   - ChatStartMetadata:
 *       field 4: created_at (google.protobuf.Timestamp)
 *       field 10: context_window_metadata (ContextWindowMetadata)
 *   - ContextWindowMetadata:
 *       field 1: estimated_tokens_used (int32)
 *       field 4: max_context_tokens (int32)
 *   - ModelUsageStats:
 *       field 2: input_tokens (uint64, uncached prompt tokens, disjoint from cache)
 *       field 3: output_tokens (uint64, total output including reasoning)
 *       field 4: cache_write_tokens (uint64, cache creation)
 *       field 5: cache_read_tokens (uint64, cached input)
 *       field 9: thinking_output_tokens (uint64, reasoning subset of output)
 *       field 10: response_output_tokens (uint64, visible text subset of output)
 *
 * Note on double-counting: only `gen_metadata` unique rows are read; `steps.metadata`
 * repeats `model_usage` field 9 and is intentionally not queried.
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

export interface AntigravityContextSnapshot {
  readonly timestampMs: number;
  readonly estimatedTokensUsed: number;
  readonly maxContextTokens: number;
  readonly genIndex: number;
}

export interface AntigravityUsageRecord {
  readonly provider: AntigravityUsageProvider;
  readonly timestampMs: number;
  readonly model: string;
  readonly sessionId: string;
  readonly totals: UsageTokenTotals;
  readonly reportedCostUsd: null;
  readonly dedupeKey: string;
  readonly executionId: string | null;
  readonly genIndex: number;
  readonly contextSnapshot: AntigravityContextSnapshot | null;
}

export interface AntigravityReadOptions {
  /** Filter out records before this UNIX timestamp in milliseconds. */
  readonly sinceMs?: number;
  /** Explicit conversation session ID (defaults to database basename without extension). */
  readonly sessionId?: string;
  /** Maximum rows to read per database (bounded resource guard). Default: 50,000. */
  readonly maxRowsPerDb?: number;
  /** Cumulative byte budget per database. Default: 100 MiB. */
  readonly maxTotalBytesPerDb?: number;
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
  readonly latestContextSnapshot: AntigravityContextSnapshot | null;
  readonly rowsRead: number;
  readonly recordsParsed: number;
  readonly skippedEmptyUsage: number;
  readonly malformedRows: number;
  readonly truncated: boolean;
  readonly errors: ReadonlyArray<{ readonly rowIdx: number; readonly reason: string }>;
}

export interface AntigravityScanResult {
  readonly records: ReadonlyArray<AntigravityUsageRecord>;
  readonly databasesScanned: number;
  readonly totalRowsRead: number;
  readonly totalRecordsParsed: number;
  readonly skippedEmptyUsage: number;
  readonly malformedRows: number;
  readonly truncated: boolean;
  readonly directoryExists: boolean;
  readonly error?: string;
  readonly latestContextSnapshot: AntigravityContextSnapshot | null;
  readonly databaseResults: ReadonlyArray<AntigravityDatabaseReadResult>;
}

export type ParseBlobOutcome =
  | {
      readonly success: true;
      readonly record: AntigravityUsageRecord | null;
      readonly contextSnapshot: AntigravityContextSnapshot | null;
      readonly isEmpty: boolean;
    }
  | {
      readonly success: false;
      readonly reason: string;
    };

/* -------------------------------------------------------------------------- */
/* Constants & Safety Guards                                                  */
/* -------------------------------------------------------------------------- */

export const DEFAULT_MAX_BLOB_SIZE = 10 * 1024 * 1024; // 10 MiB
export const DEFAULT_MAX_TOTAL_BYTES_PER_DB = 100 * 1024 * 1024; // 100 MiB
export const DEFAULT_MAX_NESTING_DEPTH = 10;
export const DEFAULT_MAX_ROWS_PER_DATABASE = 50_000;
const MAX_ALLOWED_ROWS_PER_DB = 200_000;
const MAX_ALLOWED_BLOB_SIZE = 50 * 1024 * 1024; // 50 MiB
const MAX_RECORDED_ERRORS = 100;

export const WIRE_VARINT = 0;
export const WIRE_FIXED64 = 1;
export const WIRE_LENGTH_DELIMITED = 2;
export const WIRE_FIXED32 = 5;

const TEXT_DECODER = new TextDecoder("utf-8", { fatal: false });

function normalizeBoundedInt(
  value: number | undefined,
  defaultValue: number,
  minValue: number,
  maxValue: number,
): number {
  if (value === undefined) return defaultValue;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    Number.isNaN(value) ||
    value < minValue
  ) {
    return defaultValue;
  }
  return Math.min(Math.trunc(value), maxValue);
}

/* -------------------------------------------------------------------------- */
/* Strict Bounded Protobuf Wire Reader                                        */
/* -------------------------------------------------------------------------- */

/**
 * Decodes a 64-bit varint from a byte buffer with strict byte-length and
 * 10th-byte overflow validation. Rejects negative or >64-bit encodings.
 */
export function readVarint(
  bytes: Uint8Array,
  offset: number,
): { readonly value: bigint; readonly nextOffset: number } {
  let value = 0n;
  let shift = 0n;
  let current = offset;
  let byteCount = 0;

  while (current < bytes.length) {
    const byte = bytes[current++];
    if (byte === undefined) {
      throw new Error(`Unexpected EOF while reading varint at offset ${offset}`);
    }
    byteCount++;

    if (byteCount === 10) {
      // For a 64-bit unsigned integer (9*7 = 63 bits previously read),
      // the 10th byte can only hold bit 64. Thus, (byte & 0xfe) must be 0
      // (MSB cannot be set, bits 1..6 cannot be set).
      if ((byte & 0xfe) !== 0) {
        throw new Error(
          `Varint overflow at offset ${offset}: 10th byte 0x${byte.toString(16)} exceeds 64-bit limit`,
        );
      }
      value |= BigInt(byte & 0x01) << shift;
      return { value, nextOffset: current };
    }

    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value, nextOffset: current };
    }
    shift += 7n;
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
 * Iterates top-level fields within a protobuf byte slice. Skips unknown tags of
 * valid wire types (0, 1, 2, 5) safely. Rejects tag 0 and invalid wire types.
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

    if (tag <= 0) {
      throw new Error(`Invalid protobuf field tag ${tag} at offset ${offset}`);
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
      if (lengthBig < 0n || lengthBig > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error(`Invalid length ${lengthBig} for field ${tag} at offset ${offset}`);
      }
      const length = Number(lengthBig);
      if (payloadOffset + length > end) {
        throw new Error(
          `Length-delimited field ${tag} (length ${length}) exceeds boundary at offset ${offset}`,
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

/**
 * Validates non-negative safe integers without clamping. Rejects negatives,
 * NaNs, non-finites, and values > Number.MAX_SAFE_INTEGER.
 */
function strictSafeNonNegativeInteger(
  value: bigint | number | null | undefined,
  fieldName: string,
): number {
  if (value == null) return 0;
  if (typeof value === "bigint") {
    if (value < 0n) {
      throw new Error(`Field '${fieldName}' cannot be negative: ${value}`);
    }
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`Field '${fieldName}' exceeds MAX_SAFE_INTEGER (${value})`);
    }
    return Number(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Number.isNaN(value) || value < 0) {
      throw new Error(`Field '${fieldName}' is not a valid non-negative finite integer: ${value}`);
    }
    if (value > Number.MAX_SAFE_INTEGER) {
      throw new Error(`Field '${fieldName}' exceeds MAX_SAFE_INTEGER (${value})`);
    }
    return Math.trunc(value);
  }
  throw new Error(`Field '${fieldName}' has invalid type ${typeof value}`);
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
    if (field.tag === 1) {
      if (field.wireType !== WIRE_VARINT || field.varintValue == null) {
        throw new Error(
          `Invalid wire type ${field.wireType} for Timestamp.seconds (expected varint)`,
        );
      }
      seconds = BigInt.asIntN(64, field.varintValue);
    } else if (field.tag === 2) {
      if (field.wireType !== WIRE_VARINT || field.varintValue == null) {
        throw new Error(
          `Invalid wire type ${field.wireType} for Timestamp.nanos (expected varint)`,
        );
      }
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

interface DecodedContextWindowMetadata {
  readonly estimatedTokensUsed: number;
  readonly maxContextTokens: number;
}

function decodeContextWindowMetadata(bytes: Uint8Array): DecodedContextWindowMetadata {
  let estimatedTokensUsed = 0;
  let maxContextTokens = 0;

  for (const field of iterateProtobufFields(bytes)) {
    if (field.tag === 1) {
      if (field.wireType !== WIRE_VARINT || field.varintValue == null) {
        throw new Error(
          `Invalid wire type ${field.wireType} for ContextWindowMetadata.estimated_tokens_used`,
        );
      }
      estimatedTokensUsed = strictSafeNonNegativeInteger(
        field.varintValue,
        "ContextWindowMetadata.estimated_tokens_used",
      );
    } else if (field.tag === 4) {
      if (field.wireType !== WIRE_VARINT || field.varintValue == null) {
        throw new Error(
          `Invalid wire type ${field.wireType} for ContextWindowMetadata.max_context_tokens`,
        );
      }
      maxContextTokens = strictSafeNonNegativeInteger(
        field.varintValue,
        "ContextWindowMetadata.max_context_tokens",
      );
    }
  }

  return { estimatedTokensUsed, maxContextTokens };
}

interface DecodedChatStartMetadata {
  readonly createdAt: DecodedTimestamp | null;
  readonly contextWindow: DecodedContextWindowMetadata | null;
}

function decodeChatStartMetadata(bytes: Uint8Array): DecodedChatStartMetadata {
  let createdAt: DecodedTimestamp | null = null;
  let contextWindow: DecodedContextWindowMetadata | null = null;

  for (const field of iterateProtobufFields(bytes)) {
    if (field.tag === 4) {
      if (field.wireType !== WIRE_LENGTH_DELIMITED || !field.bytesValue) {
        throw new Error(
          `Invalid wire type ${field.wireType} for ChatStartMetadata.created_at (expected length-delimited)`,
        );
      }
      createdAt = decodeTimestamp(field.bytesValue);
    } else if (field.tag === 10) {
      if (field.wireType !== WIRE_LENGTH_DELIMITED || !field.bytesValue) {
        throw new Error(
          `Invalid wire type ${field.wireType} for ChatStartMetadata.context_window_metadata (expected length-delimited)`,
        );
      }
      contextWindow = decodeContextWindowMetadata(field.bytesValue);
    }
  }

  return { createdAt, contextWindow };
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
    switch (field.tag) {
      case 2:
        if (field.wireType !== WIRE_VARINT || field.varintValue == null) {
          throw new Error(`Invalid wire type ${field.wireType} for ModelUsageStats.input_tokens`);
        }
        inputTokens = strictSafeNonNegativeInteger(field.varintValue, "input_tokens");
        break;
      case 3:
        if (field.wireType !== WIRE_VARINT || field.varintValue == null) {
          throw new Error(`Invalid wire type ${field.wireType} for ModelUsageStats.output_tokens`);
        }
        outputTokens = strictSafeNonNegativeInteger(field.varintValue, "output_tokens");
        break;
      case 4:
        if (field.wireType !== WIRE_VARINT || field.varintValue == null) {
          throw new Error(
            `Invalid wire type ${field.wireType} for ModelUsageStats.cache_write_tokens`,
          );
        }
        cacheWriteTokens = strictSafeNonNegativeInteger(field.varintValue, "cache_write_tokens");
        break;
      case 5:
        if (field.wireType !== WIRE_VARINT || field.varintValue == null) {
          throw new Error(
            `Invalid wire type ${field.wireType} for ModelUsageStats.cache_read_tokens`,
          );
        }
        cacheReadTokens = strictSafeNonNegativeInteger(field.varintValue, "cache_read_tokens");
        break;
      case 9:
        if (field.wireType !== WIRE_VARINT || field.varintValue == null) {
          throw new Error(
            `Invalid wire type ${field.wireType} for ModelUsageStats.thinking_output_tokens`,
          );
        }
        thinkingOutputTokens = strictSafeNonNegativeInteger(
          field.varintValue,
          "thinking_output_tokens",
        );
        break;
      case 10:
        if (field.wireType !== WIRE_VARINT || field.varintValue == null) {
          throw new Error(
            `Invalid wire type ${field.wireType} for ModelUsageStats.response_output_tokens`,
          );
        }
        responseOutputTokens = strictSafeNonNegativeInteger(
          field.varintValue,
          "response_output_tokens",
        );
        break;
      default:
        // Unknown or sensitive fields (e.g. tag 8 response_header) safely skipped
        break;
    }
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
  readonly modelName: string | null;
  readonly usageStats: DecodedModelUsageStats | null;
  readonly chatStart: DecodedChatStartMetadata | null;
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
  let chatStart: DecodedChatStartMetadata | null = null;

  for (const field of iterateProtobufFields(bytes)) {
    switch (field.tag) {
      case 3:
        if (field.wireType !== WIRE_VARINT || field.varintValue == null) {
          throw new Error(`Invalid wire type ${field.wireType} for ChatModelMetadata.model`);
        }
        modelEnum = Number(BigInt.asIntN(32, field.varintValue));
        break;
      case 4:
        if (field.wireType !== WIRE_LENGTH_DELIMITED || !field.bytesValue) {
          throw new Error(`Invalid wire type ${field.wireType} for ChatModelMetadata.usage`);
        }
        usageStats = decodeModelUsageStats(field.bytesValue);
        break;
      case 5:
        // model_cost: fixed32 float. Provenance: not confirmed USD, intentionally unparsed.
        if (field.wireType !== WIRE_FIXED32) {
          throw new Error(`Invalid wire type ${field.wireType} for ChatModelMetadata.model_cost`);
        }
        break;
      case 9:
        if (field.wireType !== WIRE_LENGTH_DELIMITED || !field.bytesValue) {
          throw new Error(
            `Invalid wire type ${field.wireType} for ChatModelMetadata.chat_start_metadata`,
          );
        }
        chatStart = decodeChatStartMetadata(field.bytesValue);
        break;
      case 19:
        if (field.wireType !== WIRE_LENGTH_DELIMITED || !field.bytesValue) {
          throw new Error(
            `Invalid wire type ${field.wireType} for ChatModelMetadata.response_model`,
          );
        }
        responseModel = TEXT_DECODER.decode(field.bytesValue).trim();
        break;
      case 21:
        if (field.wireType !== WIRE_LENGTH_DELIMITED || !field.bytesValue) {
          throw new Error(
            `Invalid wire type ${field.wireType} for ChatModelMetadata.model_display_name`,
          );
        }
        modelDisplayName = TEXT_DECODER.decode(field.bytesValue).trim();
        break;
      case 22:
        if (field.wireType !== WIRE_LENGTH_DELIMITED || !field.bytesValue) {
          throw new Error(
            `Invalid wire type ${field.wireType} for ChatModelMetadata.response_model_full`,
          );
        }
        responseModelFull = TEXT_DECODER.decode(field.bytesValue).trim();
        break;
      default:
        // Skip prompts, messages, tool configs, etc.
        break;
    }
  }

  // Strictly identify model: NEVER guess or default to gemini-3.8-flash.
  let modelName: string | null = null;
  if (responseModel && responseModel.length > 0) {
    modelName = responseModel;
  } else if (responseModelFull && responseModelFull.length > 0) {
    modelName = responseModelFull;
  } else if (modelDisplayName && modelDisplayName.length > 0) {
    modelName = modelDisplayName;
  } else if (modelEnum != null && modelEnum >= 0) {
    modelName = `antigravity-enum-${modelEnum}`;
  }

  return { modelName, usageStats, chatStart };
}

/* -------------------------------------------------------------------------- */
/* Blob Parser Implementation                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Pure parser for a single `gen_metadata.data` protobuf BLOB.
 *
 * Enforces strict limits, wire validation, non-negative bounds, and the
 * invariant: `reasoningTokens <= outputTokens`.
 */
export function parseAntigravityGenMetadataBlob(
  data: Uint8Array,
  context: {
    readonly sessionId: string;
    readonly rowIdx: number;
    readonly maxBlobSize?: number;
    readonly maxNestingDepth?: number;
    readonly includeEmptyUsage?: boolean;
  },
): ParseBlobOutcome {
  const maxBlobSize = normalizeBoundedInt(
    context.maxBlobSize,
    DEFAULT_MAX_BLOB_SIZE,
    1024,
    MAX_ALLOWED_BLOB_SIZE,
  );
  const maxNestingDepth = normalizeBoundedInt(
    context.maxNestingDepth,
    DEFAULT_MAX_NESTING_DEPTH,
    1,
    50,
  );
  const rowIdx = context.rowIdx;

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
      if (field.tag === 1) {
        if (field.wireType !== WIRE_LENGTH_DELIMITED || !field.bytesValue) {
          throw new Error(
            `Invalid wire type ${field.wireType} for CortexStepGeneratorMetadata.chat_model`,
          );
        }
        chatModelMetadata = decodeChatModelMetadata(field.bytesValue, 1, maxNestingDepth);
      } else if (field.tag === 4) {
        if (field.wireType !== WIRE_LENGTH_DELIMITED || !field.bytesValue) {
          throw new Error(
            `Invalid wire type ${field.wireType} for CortexStepGeneratorMetadata.execution_id`,
          );
        }
        executionId = TEXT_DECODER.decode(field.bytesValue).trim();
      }
    }

    if (!chatModelMetadata) {
      return {
        success: false,
        reason: "Missing required chat_model field (tag 1) in CortexStepGeneratorMetadata",
      };
    }

    if (!chatModelMetadata.modelName) {
      return {
        success: false,
        reason: "Missing model identification in ChatModelMetadata (cannot attribute usage)",
      };
    }

    const chatStart = chatModelMetadata.chatStart;
    if (!chatStart?.createdAt) {
      return {
        success: false,
        reason: "Missing created_at timestamp in chat_start_metadata",
      };
    }

    const sec = chatStart.createdAt.seconds;
    if (sec <= 0n || sec > 253402300799n) {
      return {
        success: false,
        reason: `Timestamp seconds ${sec} outside safe positive range`,
      };
    }

    const timestampMs = Math.trunc(Number(sec) * 1000 + chatStart.createdAt.nanos / 1_000_000);
    if (!Number.isFinite(timestampMs) || timestampMs <= 0) {
      return {
        success: false,
        reason: `Computed timestampMs ${timestampMs} is not a valid positive safe integer`,
      };
    }

    // Context window snapshot (real native provider estimate)
    let contextSnapshot: AntigravityContextSnapshot | null = null;
    if (chatStart.contextWindow) {
      const { estimatedTokensUsed, maxContextTokens } = chatStart.contextWindow;
      if (estimatedTokensUsed > 0 || maxContextTokens > 0) {
        contextSnapshot = {
          timestampMs,
          estimatedTokensUsed,
          maxContextTokens,
          genIndex: rowIdx,
        };
      }
    }

    const usage = chatModelMetadata.usageStats;
    const totals: UsageTokenTotals = {
      uncachedInputTokens: usage ? usage.inputTokens : 0,
      cachedInputTokens: usage ? usage.cacheReadTokens : 0,
      cacheCreationTokens: usage ? usage.cacheWriteTokens : 0,
      outputTokens: usage ? usage.outputTokens : 0,
      reasoningTokens: usage ? usage.thinkingOutputTokens : 0,
    };

    // Invariant: reasoning tokens are a subset of output tokens
    if (totals.reasoningTokens > totals.outputTokens) {
      return {
        success: false,
        reason: `Invariant violation: reasoningTokens (${totals.reasoningTokens}) > outputTokens (${totals.outputTokens})`,
      };
    }

    const isAllZero =
      totals.uncachedInputTokens === 0 &&
      totals.cachedInputTokens === 0 &&
      totals.cacheCreationTokens === 0 &&
      totals.outputTokens === 0 &&
      totals.reasoningTokens === 0;

    // Use supplied database/conversation session ID, NOT per-generation execution ID
    const conversationSessionId = context.sessionId;
    const dedupeKey = `antigravity:${conversationSessionId}:${rowIdx}`;

    if (isAllZero && !context.includeEmptyUsage) {
      return {
        success: true,
        record: null,
        contextSnapshot,
        isEmpty: true,
      };
    }

    const record: AntigravityUsageRecord = {
      provider: "antigravity",
      timestampMs,
      model: chatModelMetadata.modelName,
      sessionId: conversationSessionId,
      totals,
      reportedCostUsd: null,
      dedupeKey,
      executionId: executionId && executionId.length > 0 ? executionId : null,
      genIndex: rowIdx,
      contextSnapshot,
    };

    return {
      success: true,
      record,
      contextSnapshot,
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
/* Read-Only SQLite Abstraction (Bounded Memory & Safe Streaming)             */
/* -------------------------------------------------------------------------- */

interface SqliteRowStreamItem {
  readonly idx: number;
  readonly byteLen: number;
  readonly data: Uint8Array | null;
}

interface SqliteReadOnlyDb {
  iterateGenMetadata(maxBlobSize: number, queryLimit: number): Iterable<SqliteRowStreamItem>;
  close(): void;
}

async function openReadOnlyDatabase(dbPath: string): Promise<SqliteReadOnlyDb> {
  const isBun = typeof process !== "undefined" && process.versions?.bun !== undefined;

  const sql = `
    SELECT
      idx,
      COALESCE(length(data), 0) AS byte_len,
      CASE WHEN length(data) <= ? THEN data ELSE NULL END AS data
    FROM gen_metadata
    ORDER BY idx ASC
    LIMIT ?
  `;

  if (isBun) {
    const { Database } = await import("bun:sqlite");
    const db = new Database(dbPath, { readonly: true });
    try {
      db.run("PRAGMA busy_timeout = 3000;");
    } catch {
      // ignore pragma error
    }
    return {
      iterateGenMetadata(maxBlobSize: number, queryLimit: number) {
        const stmt = db.query(sql);
        const rows = stmt.all(maxBlobSize, queryLimit) as Array<{
          idx: number;
          byte_len: number;
          data: unknown;
        }>;
        return rows.map((r) => ({
          idx: Number(r.idx),
          byteLen: Number(r.byte_len),
          data:
            r.data == null
              ? null
              : r.data instanceof Uint8Array
                ? r.data
                : new Uint8Array(r.data as ArrayBuffer),
        }));
      },
      close() {
        db.close();
      },
    };
  } else {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true, open: true });
    try {
      db.exec("PRAGMA busy_timeout = 3000;");
    } catch {
      // ignore pragma error
    }
    return {
      iterateGenMetadata(maxBlobSize: number, queryLimit: number) {
        const stmt = db.prepare(sql);
        if (typeof stmt.iterate === "function") {
          const rawIter = stmt.iterate(maxBlobSize, queryLimit) as Iterable<{
            idx: number;
            byte_len: number;
            data: unknown;
          }>;
          return {
            *[Symbol.iterator]() {
              for (const r of rawIter) {
                yield {
                  idx: Number(r.idx),
                  byteLen: Number(r.byte_len),
                  data:
                    r.data == null
                      ? null
                      : r.data instanceof Uint8Array
                        ? r.data
                        : new Uint8Array(r.data as ArrayBuffer),
                };
              }
            },
          };
        } else {
          const rows = stmt.all(maxBlobSize, queryLimit) as Array<{
            idx: number;
            byte_len: number;
            data: unknown;
          }>;
          return rows.map((r) => ({
            idx: Number(r.idx),
            byteLen: Number(r.byte_len),
            data:
              r.data == null
                ? null
                : r.data instanceof Uint8Array
                  ? r.data
                  : new Uint8Array(r.data as ArrayBuffer),
          }));
        }
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
 * Reads an Antigravity SQLite database strictly in read-only mode with bounded
 * memory, streaming row iteration, and SQL-level blob size guards.
 */
export async function readAntigravityDatabase(
  dbPath: string,
  options: AntigravityReadOptions = {},
): Promise<AntigravityDatabaseReadResult> {
  const maxRows = normalizeBoundedInt(
    options.maxRowsPerDb,
    DEFAULT_MAX_ROWS_PER_DATABASE,
    1,
    MAX_ALLOWED_ROWS_PER_DB,
  );
  const maxTotalBytes = normalizeBoundedInt(
    options.maxTotalBytesPerDb,
    DEFAULT_MAX_TOTAL_BYTES_PER_DB,
    1024,
    500 * 1024 * 1024,
  );
  const maxBlobSize = normalizeBoundedInt(
    options.maxBlobSize,
    DEFAULT_MAX_BLOB_SIZE,
    1024,
    MAX_ALLOWED_BLOB_SIZE,
  );
  const maxNestingDepth = normalizeBoundedInt(
    options.maxNestingDepth,
    DEFAULT_MAX_NESTING_DEPTH,
    1,
    50,
  );
  const sinceMs = options.sinceMs;
  const includeEmptyUsage = options.includeEmptyUsage ?? false;

  const resolvedSessionId =
    options.sessionId?.trim() || NodePath.basename(dbPath).replace(/\.db$/, "");

  let db: SqliteReadOnlyDb | null = null;
  try {
    db = await openReadOnlyDatabase(dbPath);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      dbPath,
      sessionId: resolvedSessionId,
      records: [],
      latestContextSnapshot: null,
      rowsRead: 0,
      recordsParsed: 0,
      skippedEmptyUsage: 0,
      malformedRows: 1,
      truncated: false,
      errors: [{ rowIdx: -1, reason: `Failed to open SQLite database read-only: ${reason}` }],
    };
  }

  // Query maxRows + 1 to detect row budget truncation
  const queryLimit = maxRows + 1;
  let rowIterable: Iterable<SqliteRowStreamItem>;
  try {
    rowIterable = db.iterateGenMetadata(maxBlobSize, queryLimit);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    try {
      db.close();
    } catch {
      // ignore close error
    }
    return {
      dbPath,
      sessionId: resolvedSessionId,
      records: [],
      latestContextSnapshot: null,
      rowsRead: 0,
      recordsParsed: 0,
      skippedEmptyUsage: 0,
      malformedRows: 0,
      truncated: false,
      errors: [
        {
          rowIdx: -1,
          reason: `Failed to query gen_metadata (table missing or unreadable): ${reason}`,
        },
      ],
    };
  }

  const records: AntigravityUsageRecord[] = [];
  let latestContextSnapshot: AntigravityContextSnapshot | null = null;
  let rowsRead = 0;
  let skippedEmptyUsage = 0;
  let malformedRows = 0;
  let truncated = false;
  let cumulativeBytes = 0;
  const errors: Array<{ readonly rowIdx: number; readonly reason: string }> = [];

  function recordError(rowIdx: number, reason: string) {
    malformedRows += 1;
    if (errors.length < MAX_RECORDED_ERRORS) {
      errors.push({ rowIdx, reason });
    }
  }

  try {
    for (const row of rowIterable) {
      rowsRead += 1;

      // Detect truncation if row count exceeds maxRows
      if (rowsRead > maxRows) {
        truncated = true;
        break;
      }

      cumulativeBytes += row.byteLen;
      if (cumulativeBytes > maxTotalBytes) {
        truncated = true;
        recordError(
          row.idx,
          `Cumulative byte budget ${maxTotalBytes} bytes exceeded at row ${row.idx}`,
        );
        break;
      }

      if (row.byteLen === 0) {
        skippedEmptyUsage += 1;
        continue;
      }

      // Check if blob exceeded maxBlobSize in SQL (returned NULL by CASE expression)
      if (row.data === null && row.byteLen > maxBlobSize) {
        recordError(
          row.idx,
          `Row blob size ${row.byteLen} bytes exceeds maxBlobSize ${maxBlobSize} bytes`,
        );
        continue;
      }

      if (!row.data) {
        skippedEmptyUsage += 1;
        continue;
      }

      const outcome = parseAntigravityGenMetadataBlob(row.data, {
        sessionId: resolvedSessionId,
        rowIdx: row.idx,
        maxBlobSize,
        maxNestingDepth,
        includeEmptyUsage,
      });

      if (outcome.success) {
        if (outcome.contextSnapshot) {
          latestContextSnapshot = outcome.contextSnapshot;
        }

        if (outcome.record) {
          if (sinceMs == null || outcome.record.timestampMs >= sinceMs) {
            records.push(outcome.record);
          }
        } else if (outcome.isEmpty) {
          skippedEmptyUsage += 1;
        }
      } else {
        recordError(row.idx, outcome.reason);
      }
    }
  } finally {
    try {
      db.close();
    } catch {
      // ignore close error
    }
  }

  return {
    dbPath,
    sessionId: resolvedSessionId,
    records,
    latestContextSnapshot,
    rowsRead: truncated && rowsRead > maxRows ? maxRows : rowsRead,
    recordsParsed: records.length,
    skippedEmptyUsage,
    malformedRows,
    truncated,
    errors,
  };
}

/**
 * Scans an explicit directory for `*.db` files. Explicitly returns `directoryExists: false`
 * and error details if the directory is unreadable or missing.
 */
export async function readAntigravityDirectory(
  dirPath: string,
  options: AntigravityReadOptions = {},
): Promise<AntigravityScanResult> {
  let entries: NodeFS.Dirent[];
  try {
    entries = await NodeFSP.readdir(dirPath, { withFileTypes: true });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      records: [],
      databasesScanned: 0,
      totalRowsRead: 0,
      totalRecordsParsed: 0,
      skippedEmptyUsage: 0,
      malformedRows: 0,
      truncated: false,
      directoryExists: false,
      error: `Failed to read directory '${dirPath}': ${reason}`,
      latestContextSnapshot: null,
      databaseResults: [],
    };
  }

  const dbPaths = entries
    .filter((e) => (e.isFile() || e.isSymbolicLink()) && e.name.endsWith(".db"))
    .map((e) => NodePath.join(dirPath, e.name))
    .sort();

  const scanResult = await readAntigravityPaths(dbPaths, options);
  return {
    ...scanResult,
    directoryExists: true,
  };
}

/**
 * Reads a list of explicit database paths, aggregating records, status counters,
 * and the latest valid context snapshot across databases.
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
  let anyTruncated = false;
  let latestContextSnapshot: AntigravityContextSnapshot | null = null;

  for (const path of paths) {
    const result = await readAntigravityDatabase(path, options);
    databaseResults.push(result);
    totalRowsRead += result.rowsRead;
    totalRecordsParsed += result.recordsParsed;
    skippedEmptyUsage += result.skippedEmptyUsage;
    malformedRows += result.malformedRows;
    if (result.truncated) {
      anyTruncated = true;
    }
    if (
      result.latestContextSnapshot &&
      (!latestContextSnapshot ||
        result.latestContextSnapshot.timestampMs >= latestContextSnapshot.timestampMs)
    ) {
      latestContextSnapshot = result.latestContextSnapshot;
    }
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
    truncated: anyTruncated,
    directoryExists: true,
    latestContextSnapshot,
    databaseResults,
  };
}
