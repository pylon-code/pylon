// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";

import {
  iterateProtobufFields,
  parseAntigravityGenMetadataBlob,
  readAntigravityDatabase,
  readAntigravityLatestContext,
  readVarint,
  WIRE_FIXED32,
  WIRE_FIXED64,
  WIRE_LENGTH_DELIMITED,
  WIRE_VARINT,
} from "./antigravityUsageReader.ts";
import {
  encodeLengthDelimited,
  encodeSyntheticGenMetadataBlob,
  encodeVarintField,
} from "./antigravityTestFixtures.ts";

describe("antigravityUsageReader", () => {
  describe("readVarint & safe integer conversions", () => {
    it("parses valid single and multi-byte varints correctly", () => {
      expect(readVarint(new Uint8Array([0x00]), 0)).toEqual({ value: 0n, bytesRead: 1 });
      expect(readVarint(new Uint8Array([0x01]), 0)).toEqual({ value: 1n, bytesRead: 1 });
      expect(readVarint(new Uint8Array([0xac, 0x02]), 0)).toEqual({ value: 300n, bytesRead: 2 });
    });

    it("rejects varints exceeding 10 bytes", () => {
      const tenContinuationBytes = new Uint8Array(11).fill(0x80);
      expect(() => readVarint(tenContinuationBytes, 0)).toThrow(/10th byte|maximum 10 bytes/);
    });

    it("rejects 10th byte exceeding 1 for 64-bit uint", () => {
      const tenBytesOverflow = new Uint8Array([
        0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x02,
      ]);
      expect(() => readVarint(tenBytesOverflow, 0)).toThrow(/10th byte of 64-bit varint exceeds 1/);
    });
  });

  describe("iterateProtobufFields & wire type validation", () => {
    it("iterates varint, fixed32, fixed64, and length-delimited fields cleanly", () => {
      const buf = new Uint8Array([
        ...encodeVarintField(1, 42),
        ...encodeLengthDelimited(2, new Uint8Array([1, 2, 3])),
        (3 << 3) | WIRE_FIXED32,
        0x01,
        0x02,
        0x03,
        0x04,
        (4 << 3) | WIRE_FIXED64,
        0x01,
        0x02,
        0x03,
        0x04,
        0x05,
        0x06,
        0x07,
        0x08,
      ]);

      const fields = Array.from(iterateProtobufFields(buf));
      expect(fields).toHaveLength(4);
      expect(fields[0]?.fieldNumber).toBe(1);
      expect(fields[0]?.wireType).toBe(WIRE_VARINT);
      expect(fields[1]?.fieldNumber).toBe(2);
      expect(fields[1]?.wireType).toBe(WIRE_LENGTH_DELIMITED);
      expect(fields[2]?.fieldNumber).toBe(3);
      expect(fields[2]?.wireType).toBe(WIRE_FIXED32);
      expect(fields[3]?.fieldNumber).toBe(4);
      expect(fields[3]?.wireType).toBe(WIRE_FIXED64);
    });

    it("throws when truncated length-delimited field is encountered", () => {
      const tag = (1 << 3) | WIRE_LENGTH_DELIMITED;
      const buf = new Uint8Array([tag, 10, 1, 2, 3]); // Claims 10 bytes, only gives 3
      expect(() => Array.from(iterateProtobufFields(buf))).toThrow(/Truncated length-delimited/);
    });
  });

  describe("parseAntigravityGenMetadataBlob", () => {
    it("correctly extracts usage stats and context window snapshot", () => {
      const blob = encodeSyntheticGenMetadataBlob({
        modelName: "gemini-3.8-flash",
        timestampSeconds: 1785578400n, // approx 2026
        timestampNanos: 500_000_000,
        inputTokens: 1200,
        outputTokens: 450,
        cacheWriteTokens: 100,
        cacheReadTokens: 500,
        thinkingOutputTokens: 150,
        responseOutputTokens: 300,
        estimatedTokensUsed: 5000,
        maxContextTokens: 1048576,
      });

      const outcome = parseAntigravityGenMetadataBlob(blob, {
        sessionId: "test-conv-123",
        rowIdx: 42,
      });

      expect(outcome.success).toBe(true);
      if (!outcome.success) return;

      expect(outcome.record).not.toBeNull();
      expect(outcome.record?.provider).toBe("antigravity");
      expect(outcome.record?.sessionId).toBe("test-conv-123");
      expect(outcome.record?.genIndex).toBe(42);
      expect(outcome.record?.dedupeKey).toBe("antigravity:test-conv-123:42");
      expect(outcome.record?.model).toBe("gemini-3.8-flash");
      expect(outcome.record?.totals).toEqual({
        uncachedInputTokens: 1200,
        cachedInputTokens: 500,
        cacheCreationTokens: 100,
        outputTokens: 450,
        reasoningTokens: 150,
      });
      expect(outcome.record?.reportedCostUsd).toBeNull();

      expect(outcome.contextSnapshot).toEqual({
        timestampMs: 1785578400500,
        estimatedTokensUsed: 5000,
        maxContextTokens: 1048576,
        genIndex: 42,
      });
    });

    it("resolves modelEnum to stable identifier when string modelName is absent", () => {
      const blob = encodeSyntheticGenMetadataBlob({
        modelEnum: 7,
        timestampSeconds: 1785578400n,
        inputTokens: 10,
        outputTokens: 20,
      });

      const outcome = parseAntigravityGenMetadataBlob(blob, {
        sessionId: "test-conv-123",
        rowIdx: 1,
      });

      expect(outcome.success).toBe(true);
      if (!outcome.success) return;
      expect(outcome.record?.model).toBe("antigravity-model-enum-7");
    });

    it("rejects missing model attribution when neither name nor enum is present", () => {
      const blob = encodeSyntheticGenMetadataBlob({
        timestampSeconds: 1785578400n,
        inputTokens: 10,
        outputTokens: 20,
      });

      const outcome = parseAntigravityGenMetadataBlob(blob, {
        sessionId: "test-conv-123",
        rowIdx: 1,
      });

      expect(outcome.success).toBe(false);
      if (!outcome.success) {
        expect(outcome.reason).toContain("Missing model identification");
      }
    });

    it("rejects invariant violation if thinking tokens exceed output tokens", () => {
      const blob = encodeSyntheticGenMetadataBlob({
        modelName: "gemini-3.8-flash",
        timestampSeconds: 1785578400n,
        inputTokens: 100,
        outputTokens: 50,
        thinkingOutputTokens: 60, // 60 > 50 -> invariant violation
      });

      const outcome = parseAntigravityGenMetadataBlob(blob, {
        sessionId: "test-conv-123",
        rowIdx: 1,
      });

      expect(outcome.success).toBe(false);
      if (!outcome.success) {
        expect(outcome.reason).toContain("Invariant violated: thinking_output_tokens");
      }
    });

    it("omits record and flags malformed when timestamp is missing or zero to preserve accurate history", () => {
      const blob = encodeSyntheticGenMetadataBlob({
        modelName: "gemini-3.8-flash",
        inputTokens: 10,
        outputTokens: 20,
        // No timestamp provided
      });

      const outcome = parseAntigravityGenMetadataBlob(blob, {
        sessionId: "test-conv-123",
        rowIdx: 1,
      });

      expect(outcome.success).toBe(false);
      if (!outcome.success) {
        expect(outcome.reason).toContain("Missing or non-positive timestamp");
      }
    });

    it("safely skips unknown wire fields in ModelUsageStats without failing", () => {
      // Create synthetic usage submessage containing an unknown length-delimited field (tag 7 message_id)
      const fakeMessageIdBytes = new TextEncoder().encode("msg-uuid-999");
      const extraField = {
        tag: 7,
        wireType: WIRE_LENGTH_DELIMITED,
        value: fakeMessageIdBytes,
      };

      const blob = encodeSyntheticGenMetadataBlob({
        modelName: "gemini-3.8-flash",
        timestampSeconds: 1785578400n,
        inputTokens: 50,
        outputTokens: 25,
        extraFields: [extraField],
      });

      const outcome = parseAntigravityGenMetadataBlob(blob, {
        sessionId: "test-conv-123",
        rowIdx: 1,
      });

      expect(outcome.success).toBe(true);
      if (!outcome.success) return;
      expect(outcome.record?.totals.uncachedInputTokens).toBe(50);
      expect(outcome.record?.totals.outputTokens).toBe(25);
    });

    it("returns record: null for empty / zero usage turns", () => {
      const blob = encodeSyntheticGenMetadataBlob({
        modelName: "gemini-3.8-flash",
        timestampSeconds: 1785578400n,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        thinkingOutputTokens: 0,
      });

      const outcome = parseAntigravityGenMetadataBlob(blob, {
        sessionId: "test-conv-123",
        rowIdx: 1,
      });

      expect(outcome.success).toBe(true);
      if (!outcome.success) return;
      expect(outcome.record).toBeNull();
    });

    it("rejects token counts exceeding MAX_SAFE_INTEGER", () => {
      const hugeVal = 0x1fffffffffffff00n; // > MAX_SAFE_INTEGER
      const blob = encodeLengthDelimited(
        1,
        new Uint8Array([
          ...encodeVarintField(3, 1),
          ...encodeLengthDelimited(4, encodeVarintField(2, hugeVal)),
        ]),
      );

      const outcome = parseAntigravityGenMetadataBlob(blob, {
        sessionId: "test-conv-123",
        rowIdx: 1,
      });

      expect(outcome.success).toBe(false);
      if (!outcome.success) {
        expect(outcome.reason).toContain("exceeds MAX_SAFE_INTEGER");
      }
    });
  });

  describe("readAntigravityDatabase & Bounded Pagination", () => {
    it("handles synthetic SQLite databases with keyset pagination and limits", async () => {
      const { DatabaseSync } = await import("node:sqlite");
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "antigravity-test-"));
      const tempDbPath = NodePath.join(tempDir, "conv-uuid-456.db");

      const dbInstance = new DatabaseSync(tempDbPath);
      dbInstance.exec(`
        CREATE TABLE gen_metadata (
          idx INTEGER PRIMARY KEY,
          data BLOB,
          size INTEGER
        );
      `);

      // Row 0: valid turn
      const blob0 = encodeSyntheticGenMetadataBlob({
        modelName: "gemini-3.8-flash",
        timestampSeconds: 1789402200n,
        inputTokens: 100,
        outputTokens: 50,
      });

      // Row 1: turn with reasoning tokens
      const blob1 = encodeSyntheticGenMetadataBlob({
        modelName: "gemini-3.8-pro",
        timestampSeconds: 1789402230n,
        inputTokens: 200,
        outputTokens: 80,
        thinkingOutputTokens: 30,
      });

      // Row 2: empty usage
      const blob2 = encodeSyntheticGenMetadataBlob({
        modelName: "gemini-3.8-flash",
        timestampSeconds: 1789402260n,
        inputTokens: 0,
        outputTokens: 0,
      });

      // Row 3: valid turn with context snapshot
      const blob3 = encodeSyntheticGenMetadataBlob({
        modelName: "gemini-3.8-flash",
        timestampSeconds: 1789402280n,
        inputTokens: 300,
        outputTokens: 100,
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

      // Read with default options and pageSize: 2
      const result = await readAntigravityDatabase(tempDbPath, { pageSize: 2 });
      expect(result.rowsRead).toBe(4);
      expect(result.bytesRead).toBeGreaterThan(0);
      expect(result.recordsParsed).toBe(3);
      expect(result.malformedRows).toBe(0);
      expect(result.skippedEmptyUsage).toBe(1);
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

    it("advances pagination safely across malformed rows without looping or duplicate processing", async () => {
      const { DatabaseSync } = await import("node:sqlite");
      const tempDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "antigravity-malformed-loop-"),
      );
      const tempDbPath = NodePath.join(tempDir, "conv-malformed.db");

      const dbInstance = new DatabaseSync(tempDbPath);
      dbInstance.exec(`
        CREATE TABLE gen_metadata (
          idx INTEGER PRIMARY KEY,
          data BLOB
        );
      `);

      // Row 1: valid
      const blob1 = encodeSyntheticGenMetadataBlob({
        modelName: "gemini-3.8-flash",
        timestampSeconds: 1789402200n,
        inputTokens: 10,
        outputTokens: 10,
      });
      // Row 2: malformed corrupt blob
      const blob2 = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
      // Row 3: valid
      const blob3 = encodeSyntheticGenMetadataBlob({
        modelName: "gemini-3.8-flash",
        timestampSeconds: 1789402210n,
        inputTokens: 20,
        outputTokens: 20,
      });

      const stmt = dbInstance.prepare("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)");
      stmt.run(1, blob1);
      stmt.run(2, blob2);
      stmt.run(3, blob3);
      dbInstance.close();

      // Read with pageSize: 1 so every row is fetched in a separate page
      const result = await readAntigravityDatabase(tempDbPath, { pageSize: 1 });
      expect(result.rowsRead).toBe(3);
      expect(result.recordsParsed).toBe(2);
      expect(result.malformedRows).toBe(1);
      expect(result.records).toHaveLength(2);
      expect(result.records[0]?.genIndex).toBe(1);
      expect(result.records[1]?.genIndex).toBe(3);

      try {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    });

    it("readAntigravityLatestContext efficiently scans descending without full history scan", async () => {
      const { DatabaseSync } = await import("node:sqlite");
      const tempDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "antigravity-fast-context-"),
      );
      const tempDbPath = NodePath.join(tempDir, "conv-fast-ctx.db");

      const dbInstance = new DatabaseSync(tempDbPath);
      dbInstance.exec(`
        CREATE TABLE gen_metadata (
          idx INTEGER PRIMARY KEY,
          data BLOB
        );
      `);

      const stmt = dbInstance.prepare("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)");
      // Insert 50 older rows with no context snapshot
      for (let i = 0; i < 50; i++) {
        const b = encodeSyntheticGenMetadataBlob({
          modelName: "gemini-3.8-flash",
          timestampSeconds: BigInt(1789402000 + i),
          inputTokens: 10,
          outputTokens: 10,
        });
        stmt.run(i, b);
      }

      // Row 50 has latest context snapshot
      const latestBlob = encodeSyntheticGenMetadataBlob({
        modelName: "gemini-3.8-flash",
        timestampSeconds: 1789402500n,
        inputTokens: 50,
        outputTokens: 50,
        estimatedTokensUsed: 12345,
        maxContextTokens: 1000000,
      });
      stmt.run(50, latestBlob);
      dbInstance.close();

      // Read newest context with maxRows: 5
      const snapshot = await readAntigravityLatestContext(tempDbPath, { maxRows: 5 });
      expect(snapshot).toBeDefined();
      expect(snapshot?.genIndex).toBe(50);
      expect(snapshot?.estimatedTokensUsed).toBe(12345);
      expect(snapshot?.maxContextTokens).toBe(1000000);

      try {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    });
  });
});
