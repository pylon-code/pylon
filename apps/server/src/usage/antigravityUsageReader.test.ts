// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";

import {
  iterateProtobufFields,
  parseAntigravityGenMetadataBlob,
  readAntigravityDatabase,
  readAntigravityDirectory,
  readAntigravityPaths,
  readVarint,
  WIRE_FIXED32,
  WIRE_FIXED64,
  WIRE_LENGTH_DELIMITED,
  WIRE_VARINT,
} from "./antigravityUsageReader.ts";

/* -------------------------------------------------------------------------- */
/* Test-Only Synthetic Protobuf Serializer                                    */
/* -------------------------------------------------------------------------- */

export interface SyntheticGenMetadataInput {
  readonly executionId?: string;
  readonly modelName?: string;
  readonly modelEnum?: number;
  readonly timestampSeconds: bigint | number;
  readonly timestampNanos?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly cacheReadTokens?: number;
  readonly thinkingOutputTokens?: number;
  readonly responseOutputTokens?: number;
  readonly estimatedTokensUsed?: number;
  readonly maxContextTokens?: number;
  readonly extraFields?: ReadonlyArray<{
    readonly tag: number;
    readonly wireType: number;
    readonly value: bigint | Uint8Array;
  }>;
}

function writeVarint(value: bigint | number): Uint8Array {
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

export function encodeSyntheticGenMetadataBlob(input: SyntheticGenMetadataInput): Uint8Array {
  const textEncoder = new TextEncoder();

  // 1. google.protobuf.Timestamp
  const tsParts: Uint8Array[] = [];
  tsParts.push(encodeField(1, WIRE_VARINT, writeVarint(input.timestampSeconds)));
  if (input.timestampNanos != null && input.timestampNanos > 0) {
    tsParts.push(encodeField(2, WIRE_VARINT, writeVarint(input.timestampNanos)));
  }
  const timestampBlob = concatBuffers(tsParts);

  // 2. ChatStartMetadata
  const chatStartParts: Uint8Array[] = [];
  chatStartParts.push(encodeField(4, WIRE_LENGTH_DELIMITED, timestampBlob));

  // ContextWindowMetadata (field 10)
  if (input.estimatedTokensUsed != null || input.maxContextTokens != null) {
    const cwParts: Uint8Array[] = [];
    if (input.estimatedTokensUsed != null) {
      cwParts.push(encodeField(1, WIRE_VARINT, writeVarint(input.estimatedTokensUsed)));
    }
    if (input.maxContextTokens != null) {
      cwParts.push(encodeField(4, WIRE_VARINT, writeVarint(input.maxContextTokens)));
    }
    chatStartParts.push(encodeField(10, WIRE_LENGTH_DELIMITED, concatBuffers(cwParts)));
  }
  const chatStartBlob = concatBuffers(chatStartParts);

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
  if (input.modelEnum != null) {
    cmParts.push(encodeField(3, WIRE_VARINT, writeVarint(input.modelEnum)));
  }
  if (usageParts.length > 0) {
    cmParts.push(encodeField(4, WIRE_LENGTH_DELIMITED, usageBlob));
  }
  cmParts.push(encodeField(9, WIRE_LENGTH_DELIMITED, chatStartBlob));

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

/* -------------------------------------------------------------------------- */
/* Test Suite                                                                 */
/* -------------------------------------------------------------------------- */

describe("antigravityUsageReader", () => {
  describe("Strict Protobuf Wire Reader", () => {
    it("safely decodes varints within 64 bits and detects 10th-byte overflow", () => {
      // Valid 64-bit varint
      const buf1 = writeVarint(10_000_000_000n);
      const res1 = readVarint(buf1, 0);
      expect(res1.value).toBe(10_000_000_000n);

      // Max safe 64-bit uint (0xFFFFFFFFFFFFFFFF -> 10 bytes: nine 0xFF, tenth 0x01)
      const maxUint64 = new Uint8Array([
        0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01,
      ]);
      const resMax = readVarint(maxUint64, 0);
      expect(resMax.value).toBe(18446744073709551615n);

      // 10th byte overflow: tenth byte has bit 1 set (0x02) -> exceeds 64 bits!
      const overflowTenth = new Uint8Array([
        0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x02,
      ]);
      expect(() => readVarint(overflowTenth, 0)).toThrow("Varint overflow");

      // 10th byte has MSB set -> invalid (>10 bytes)
      const msbTenth = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x80]);
      expect(() => readVarint(msbTenth, 0)).toThrow("Varint overflow");
    });

    it("throws on truncated varint", () => {
      const truncated = new Uint8Array([0x80, 0x80]);
      expect(() => readVarint(truncated, 0)).toThrow("Unexpected EOF");
    });

    it("skips unknown fields safely and rejects invalid wire types", () => {
      const testBytes = new Uint8Array([
        (10 << 3) | WIRE_VARINT,
        42,
        (11 << 3) | WIRE_FIXED64,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        (12 << 3) | WIRE_LENGTH_DELIMITED,
        4,
        116,
        101,
        115,
        116,
        (13 << 3) | WIRE_FIXED32,
        2,
        2,
        2,
        2,
      ]);

      const fields = Array.from(iterateProtobufFields(testBytes));
      expect(fields.length).toBe(4);
      expect(fields[0]?.tag).toBe(10);
      expect(fields[0]?.varintValue).toBe(42n);

      // Disallowed wire type 3 (start group)
      const invalidWire = new Uint8Array([(1 << 3) | 3]);
      expect(() => Array.from(iterateProtobufFields(invalidWire))).toThrow("Unsupported wire type");

      // Disallowed tag 0
      const invalidTag = new Uint8Array([0]);
      expect(() => Array.from(iterateProtobufFields(invalidTag))).toThrow(
        "Invalid protobuf field tag 0",
      );
    });
  });

  describe("Pure Blob Parser (Synthetic Fixtures)", () => {
    it("parses valid synthetic generation with token breakdown and context window snapshot", () => {
      const blob = encodeSyntheticGenMetadataBlob({
        executionId: "exec-transient-123",
        modelName: "gemini-3.8-pro",
        timestampSeconds: 1789402266n,
        timestampNanos: 500_000_000,
        inputTokens: 5399,
        cacheReadTokens: 12124,
        cacheWriteTokens: 60,
        outputTokens: 235,
        thinkingOutputTokens: 144,
        responseOutputTokens: 91,
        estimatedTokensUsed: 22010,
        maxContextTokens: 128000,
      });

      const outcome = parseAntigravityGenMetadataBlob(blob, {
        sessionId: "conv-session-fixed",
        rowIdx: 9,
      });

      expect(outcome.success).toBe(true);
      if (!outcome.success) return;

      expect(outcome.record).not.toBeNull();
      const rec = outcome.record!;

      // Session ID must be the supplied conversation ID
      expect(rec.sessionId).toBe("conv-session-fixed");
      expect(rec.genIndex).toBe(9);
      expect(rec.dedupeKey).toBe("antigravity:conv-session-fixed:9");
      expect(rec.reportedCostUsd).toBeNull();
      expect(rec.model).toBe("gemini-3.8-pro");

      // Token separation
      expect(rec.totals.uncachedInputTokens).toBe(5399);
      expect(rec.totals.cachedInputTokens).toBe(12124);
      expect(rec.totals.cacheCreationTokens).toBe(60);
      expect(rec.totals.outputTokens).toBe(235);
      expect(rec.totals.reasoningTokens).toBe(144);

      // Context window snapshot
      expect(outcome.contextSnapshot).toEqual({
        timestampMs: 1789402266500,
        estimatedTokensUsed: 22010,
        maxContextTokens: 128000,
        genIndex: 9,
      });
      expect(rec.contextSnapshot).toEqual(outcome.contextSnapshot);
    });

    it("requires maxContextTokens > 0 to produce a snapshot; permits estimatedTokensUsed 0", () => {
      // 0 maxContextTokens -> missing capacity -> no snapshot
      const noCapBlob = encodeSyntheticGenMetadataBlob({
        modelName: "gemini-3.8-flash",
        timestampSeconds: 1789402266n,
        inputTokens: 100,
        outputTokens: 50,
        estimatedTokensUsed: 0,
        maxContextTokens: 0,
      });
      const outcomeNoCap = parseAntigravityGenMetadataBlob(noCapBlob, {
        sessionId: "sess-1",
        rowIdx: 0,
      });
      expect(outcomeNoCap.success).toBe(true);
      if (outcomeNoCap.success) {
        expect(outcomeNoCap.contextSnapshot).toBeUndefined();
      }

      // Valid capacity with estimatedTokensUsed = 0 -> valid snapshot
      const validZeroUsedBlob = encodeSyntheticGenMetadataBlob({
        modelName: "gemini-3.8-flash",
        timestampSeconds: 1789402266n,
        inputTokens: 100,
        outputTokens: 50,
        estimatedTokensUsed: 0,
        maxContextTokens: 128000,
      });
      const outcomeZeroUsed = parseAntigravityGenMetadataBlob(validZeroUsedBlob, {
        sessionId: "sess-1",
        rowIdx: 0,
      });
      expect(outcomeZeroUsed.success).toBe(true);
      if (outcomeZeroUsed.success) {
        expect(outcomeZeroUsed.contextSnapshot).toEqual({
          timestampMs: 1789402266000,
          estimatedTokensUsed: 0,
          maxContextTokens: 128000,
          genIndex: 0,
        });
      }
    });

    it("NEVER defaults unknown model to gemini-3.8-flash; rejects missing model as malformed", () => {
      // Missing all model names and enum
      const noModelBlob = encodeSyntheticGenMetadataBlob({
        timestampSeconds: 1789402266n,
        inputTokens: 100,
        outputTokens: 50,
      });

      const outcome = parseAntigravityGenMetadataBlob(noModelBlob, {
        sessionId: "sess-1",
        rowIdx: 0,
      });

      expect(outcome.success).toBe(false);
      if (!outcome.success) {
        expect(outcome.reason).toContain("Missing model identification");
      }
    });

    it("maps numeric modelEnum to stable antigravity-enum-N identifier without guessing", () => {
      const enumBlob = encodeSyntheticGenMetadataBlob({
        modelEnum: 7,
        timestampSeconds: 1789402266n,
        inputTokens: 200,
        outputTokens: 50,
      });

      const outcome = parseAntigravityGenMetadataBlob(enumBlob, {
        sessionId: "sess-1",
        rowIdx: 0,
      });

      expect(outcome.success).toBe(true);
      if (!outcome.success) return;
      expect(outcome.record?.model).toBe("antigravity-enum-7");
    });

    it("strictly enforces reasoningTokens <= outputTokens invariant", () => {
      const invalidTokensBlob = encodeSyntheticGenMetadataBlob({
        modelName: "gemini-3.8-flash",
        timestampSeconds: 1789402266n,
        outputTokens: 100,
        thinkingOutputTokens: 150, // Invariant violation: 150 > 100
      });

      const outcome = parseAntigravityGenMetadataBlob(invalidTokensBlob, {
        sessionId: "sess-1",
        rowIdx: 0,
      });

      expect(outcome.success).toBe(false);
      if (!outcome.success) {
        expect(outcome.reason).toContain(
          "Invariant violation: reasoningTokens (150) > outputTokens (100)",
        );
      }
    });

    it("fails on known fields encoded with incorrect wire type", () => {
      // CortexStepGeneratorMetadata.chat_model (tag 1) encoded as varint instead of length-delimited
      const wrongWireBlob = new Uint8Array([(1 << 3) | WIRE_VARINT, 42]);
      const outcome = parseAntigravityGenMetadataBlob(wrongWireBlob, {
        sessionId: "sess-1",
        rowIdx: 0,
      });
      expect(outcome.success).toBe(false);
      if (!outcome.success) {
        expect(outcome.reason).toContain(
          "Invalid wire type 0 for CortexStepGeneratorMetadata.chat_model",
        );
      }
    });

    it("rejects tokens exceeding MAX_SAFE_INTEGER rather than clamping", () => {
      // 2^55 > Number.MAX_SAFE_INTEGER
      const hugeTokensBlob = encodeSyntheticGenMetadataBlob({
        modelName: "gemini-3.8-flash",
        timestampSeconds: 1789402266n,
        extraFields: [
          {
            tag: 4,
            wireType: WIRE_LENGTH_DELIMITED,
            value: new Uint8Array([
              (2 << 3) | WIRE_VARINT,
              0xff,
              0xff,
              0xff,
              0xff,
              0xff,
              0xff,
              0xff,
              0xff,
              0x01,
            ]),
          },
        ],
      });

      const outcome = parseAntigravityGenMetadataBlob(hugeTokensBlob, {
        sessionId: "sess-1",
        rowIdx: 0,
      });
      expect(outcome.success).toBe(false);
      if (!outcome.success) {
        expect(outcome.reason).toContain("exceeds MAX_SAFE_INTEGER");
      }
    });
  });

  describe("Bounded SQLite Database Reader", () => {
    let tempDir: string;
    let tempDbPath: string;

    it("reads SQLite database read-only, detects truncation, and extracts latestContextSnapshot", async () => {
      tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "antigravity-usage-test-"));
      tempDbPath = NodePath.join(tempDir, "conv-uuid-456.db");

      const isBun = typeof process !== "undefined" && process.versions?.bun !== undefined;
      let dbInstance: any;
      if (isBun) {
        const { Database } = await import("bun:sqlite");
        dbInstance = new Database(tempDbPath);
        dbInstance.run(
          "CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER)",
        );
      } else {
        const { DatabaseSync } = await import("node:sqlite");
        dbInstance = new DatabaseSync(tempDbPath);
        dbInstance.exec(
          "CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER)",
        );
      }

      // Row 0: Valid row with context snapshot
      const blob0 = encodeSyntheticGenMetadataBlob({
        modelName: "gemini-3.8-flash",
        timestampSeconds: 1789402266n,
        inputTokens: 1000,
        outputTokens: 100,
        estimatedTokensUsed: 1500,
        maxContextTokens: 128000,
      });

      // Row 1: Valid row with updated context snapshot
      const blob1 = encodeSyntheticGenMetadataBlob({
        modelName: "gemini-3.8-pro",
        timestampSeconds: 1789402270n,
        inputTokens: 2000,
        outputTokens: 200,
        estimatedTokensUsed: 3500,
        maxContextTokens: 128000,
      });

      // Row 2: Corrupted row
      const blob2 = new Uint8Array([0xff, 0xff]);

      // Row 3: Valid row
      const blob3 = encodeSyntheticGenMetadataBlob({
        modelName: "gemini-3.8-pro",
        timestampSeconds: 1789402280n,
        inputTokens: 3000,
        outputTokens: 300,
        estimatedTokensUsed: 6500,
        maxContextTokens: 128000,
      });

      const stmt = dbInstance.prepare(
        "INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)",
      );
      stmt.run(0, blob0, blob0.length);
      stmt.run(1, blob1, blob1.length);
      stmt.run(2, blob2, blob2.length);
      stmt.run(3, blob3, blob3.length);
      dbInstance.close();

      // Read with default options
      const result = await readAntigravityDatabase(tempDbPath, { pageSize: 2 });
      expect(result.rowsRead).toBe(4);
      expect(result.recordsParsed).toBe(3);
      expect(result.malformedRows).toBe(1);
      expect(result.truncated).toBe(false);
      expect(result.sessionId).toBe("conv-uuid-456");

      // Context snapshot from row 3 (latest)
      expect(result.latestContextSnapshot).toEqual({
        timestampMs: 1789402280000,
        estimatedTokensUsed: 6500,
        maxContextTokens: 128000,
        genIndex: 3,
      });

      // Dedupe keys must all use conv-uuid-456
      expect(result.records[0]?.dedupeKey).toBe("antigravity:conv-uuid-456:0");
      expect(result.records[1]?.dedupeKey).toBe("antigravity:conv-uuid-456:1");
      expect(result.records[2]?.dedupeKey).toBe("antigravity:conv-uuid-456:3");

      // Verify readAntigravityPaths aggregates multiple paths and deduplicates
      const pathsResult = await readAntigravityPaths([tempDbPath, tempDbPath]);
      expect(pathsResult.databasesScanned).toBe(1);
      expect(pathsResult.totalRecordsParsed).toBe(3);
      expect(pathsResult.latestContextSnapshot?.estimatedTokensUsed).toBe(6500);

      // Verify row budget truncation: set maxRowsPerDb = 2
      const truncatedRes = await readAntigravityDatabase(tempDbPath, {
        maxRowsPerDb: 2,
      });
      expect(truncatedRes.truncated).toBe(true);
      expect(truncatedRes.rowsRead).toBe(2);
      expect(truncatedRes.recordsParsed).toBe(2);

      // Verify option normalization does not allow negative/NaN values to disable bounds
      const safeBoundedRes = await readAntigravityDatabase(tempDbPath, {
        maxRowsPerDb: -5,
        maxBlobSize: NaN,
      });
      expect(safeBoundedRes.rowsRead).toBe(4);

      // Cleanup
      try {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    });

    it("explicitly flags unreadable or non-existent directories as errors", async () => {
      const nonExistentDir = NodePath.join(NodeOS.tmpdir(), "non-existent-antigravity-dir-xyz");
      const scanRes = await readAntigravityDirectory(nonExistentDir);

      expect(scanRes.directoryExists).toBe(false);
      expect(scanRes.error).toBeDefined();
      expect(scanRes.error).toContain("Directory does not exist");
      expect(scanRes.databasesScanned).toBe(0);
    });
  });

  describe("Sample Live Database Verification (Read-Only)", () => {
    const liveSamplePath =
      "/Users/rynfar/.pylon-code-nightly/userdata/providers/antigravity/ac0a3dfd6dddb20962cecff6ee5fe65e19d3923be20e52c5ab52ff877f7e4c32/antigravity-acp/conversations/e4960d8c-0867-4b69-b442-5409bcda5e58.db";

    it("reads sample DB strictly read-only, verifies cache disjointness and real context snapshot", async () => {
      if (!NodeFS.existsSync(liveSamplePath)) return;

      const result = await readAntigravityDatabase(liveSamplePath);

      expect(result.rowsRead).toBe(30);
      expect(result.recordsParsed).toBe(29);
      expect(result.skippedEmptyUsage).toBe(1); // row 29 capacity error
      expect(result.malformedRows).toBe(0);
      expect(result.truncated).toBe(false);
      expect(result.sessionId).toBe("e4960d8c-0867-4b69-b442-5409bcda5e58");

      // Row 9 cache disjointness confirmed: input 5399, cache_read 12124, output 235, reasoning 144
      const row9 = result.records.find((r) => r.genIndex === 9)!;
      expect(row9).toBeDefined();
      expect(row9.totals.uncachedInputTokens).toBe(5399);
      expect(row9.totals.cachedInputTokens).toBe(12124);
      expect(row9.totals.outputTokens).toBe(235);
      expect(row9.totals.reasoningTokens).toBe(144);
      expect(row9.contextSnapshot?.estimatedTokensUsed).toBe(22010);
      expect(row9.contextSnapshot?.maxContextTokens).toBe(128000);

      // Latest context snapshot (row 29 has 48,752 used / 128,000 max)
      expect(result.latestContextSnapshot?.estimatedTokensUsed).toBe(48752);
      expect(result.latestContextSnapshot?.maxContextTokens).toBe(128000);
      expect(result.latestContextSnapshot?.genIndex).toBe(29);
    });
  });
});
