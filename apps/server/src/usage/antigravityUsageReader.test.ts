// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";

import {
  encodeSyntheticGenMetadataBlob,
  iterateProtobufFields,
  parseAntigravityGenMetadataBlob,
  readAntigravityDatabase,
  readAntigravityDirectory,
  readAntigravityPaths,
  readVarint,
  writeVarint,
} from "./antigravityUsageReader.ts";

describe("antigravityUsageReader", () => {
  describe("Bounded Protobuf Wire Reader", () => {
    it("safely decodes varints without 32-bit integer truncation", () => {
      // 300 = 0xAC 0x02
      const buf1 = new Uint8Array([0xac, 0x02]);
      const res1 = readVarint(buf1, 0);
      expect(res1.value).toBe(300n);
      expect(res1.nextOffset).toBe(2);

      // Large 64-bit varint: 10,000,000,000
      const buf2 = writeVarint(10_000_000_000n);
      expect(buf2).toEqual(new Uint8Array([0x80, 0xc8, 0xaf, 0xa0, 0x25]));
      const res2 = readVarint(buf2, 0);
      expect(res2.value).toBe(10_000_000_000n);
    });

    it("throws on truncated varint or varint overflow", () => {
      // Truncated: has MSB set but EOF
      const truncated = new Uint8Array([0x80, 0x80]);
      expect(() => readVarint(truncated, 0)).toThrow("Unexpected EOF");

      // Overflow: 11 bytes of 0x80
      const overflow = new Uint8Array(12).fill(0x80);
      expect(() => readVarint(overflow, 0)).toThrow("Varint overflow");
    });

    it("skips unknown protobuf wire types safely", () => {
      // Create a buffer with known and unknown fields:
      // tag 10 (wire 0 varint: 42) -> key: 80 01, val: 2a
      // tag 11 (wire 1 fixed64: 8 bytes) -> key: 89 01, val: 8 bytes
      // tag 12 (wire 2 length-delimited: 4 bytes) -> key: 92 01, len: 04, val: 4 bytes
      // tag 13 (wire 5 fixed32: 4 bytes) -> key: ad 01, val: 4 bytes
      const testBytes = new Uint8Array([
        // Tag 10, wire 0, val 42
        (10 << 3) | 0,
        42,
        // Tag 11, wire 1, fixed64 (8 bytes of 0x01)
        (11 << 3) | 1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        // Tag 12, wire 2, length 4 ("test")
        (12 << 3) | 2,
        4,
        116,
        101,
        115,
        116,
        // Tag 13, wire 5, fixed32 (4 bytes of 0x02)
        (13 << 3) | 5,
        2,
        2,
        2,
        2,
      ]);

      const fields = Array.from(iterateProtobufFields(testBytes));
      expect(fields.length).toBe(4);
      expect(fields[0]?.tag).toBe(10);
      expect(fields[0]?.varintValue).toBe(42n);
      expect(fields[1]?.tag).toBe(11);
      expect(fields[1]?.bytesValue?.length).toBe(8);
      expect(fields[2]?.tag).toBe(12);
      expect(fields[2]?.bytesValue?.length).toBe(4);
      expect(fields[3]?.tag).toBe(13);
      expect(fields[3]?.bytesValue?.length).toBe(4);
    });

    it("throws on unsupported wire types", () => {
      // Wire type 3 (start group) is deprecated and disallowed
      const invalidWire = new Uint8Array([(1 << 3) | 3]);
      expect(() => Array.from(iterateProtobufFields(invalidWire))).toThrow("Unsupported wire type");
    });
  });

  describe("Pure Blob Parser (Synthetic Fixtures)", () => {
    it("parses valid synthetic CortexStepGeneratorMetadata with full token breakdown", () => {
      const blob = encodeSyntheticGenMetadataBlob({
        executionId: "sess-abc-123",
        modelName: "gemini-3.8-flash",
        timestampSeconds: 1789402266n,
        timestampNanos: 182_365_000,
        inputTokens: 11822,
        outputTokens: 287,
        cacheWriteTokens: 50,
        cacheReadTokens: 12000,
        thinkingOutputTokens: 204,
        responseOutputTokens: 83,
      });

      const outcome = parseAntigravityGenMetadataBlob(blob, {
        sessionId: "sess-abc-123",
        rowIdx: 0,
      });

      expect(outcome.success).toBe(true);
      if (!outcome.success) return;

      expect(outcome.isEmpty).toBe(false);
      expect(outcome.record).not.toBeNull();
      const rec = outcome.record!;
      expect(rec.provider).toBe("antigravity");
      expect(rec.sessionId).toBe("sess-abc-123");
      expect(rec.executionId).toBe("sess-abc-123");
      expect(rec.model).toBe("gemini-3.8-flash");
      expect(rec.genIndex).toBe(0);
      expect(rec.dedupeKey).toBe("sess-abc-123:0");
      expect(rec.reportedCostUsd).toBeNull();

      // Timestamp calculation
      expect(rec.timestampMs).toBe(1789402266182);

      // Token separation (uncached vs cached input disjoint)
      expect(rec.totals.uncachedInputTokens).toBe(11822);
      expect(rec.totals.cachedInputTokens).toBe(12000);
      expect(rec.totals.cacheCreationTokens).toBe(50);
      expect(rec.totals.outputTokens).toBe(287);
      expect(rec.totals.reasoningTokens).toBe(204);
    });

    it("skips unknown fields at all message levels without corruption", () => {
      const blob = encodeSyntheticGenMetadataBlob({
        executionId: "sess-unknown-fields",
        modelName: "gemini-3.8-pro",
        timestampSeconds: 1789402266n,
        inputTokens: 500,
        outputTokens: 100,
        extraFields: [
          // Add unknown field tag 99 (varint)
          { tag: 99, wireType: 0, value: 12345n },
          // Add unknown field tag 100 (length-delimited bytes)
          { tag: 100, wireType: 2, value: new Uint8Array([1, 2, 3, 4, 5]) },
        ],
      });

      const outcome = parseAntigravityGenMetadataBlob(blob, { rowIdx: 1 });
      expect(outcome.success).toBe(true);
      if (!outcome.success) return;
      expect(outcome.record?.model).toBe("gemini-3.8-pro");
      expect(outcome.record?.totals.uncachedInputTokens).toBe(500);
    });

    it("flags empty usage rows as empty without failing", () => {
      const blob = encodeSyntheticGenMetadataBlob({
        executionId: "sess-empty",
        modelName: "gemini-3.8-flash",
        timestampSeconds: 1789402266n,
        // No tokens set: defaults to 0
      });

      // Default: includeEmptyUsage is false
      const outcome = parseAntigravityGenMetadataBlob(blob, { rowIdx: 5 });
      expect(outcome.success).toBe(true);
      if (!outcome.success) return;
      expect(outcome.isEmpty).toBe(true);
      expect(outcome.record).toBeNull();

      // When includeEmptyUsage is true
      const outcomeIncluded = parseAntigravityGenMetadataBlob(blob, {
        rowIdx: 5,
        includeEmptyUsage: true,
      });
      expect(outcomeIncluded.success).toBe(true);
      if (!outcomeIncluded.success) return;
      expect(outcomeIncluded.record).not.toBeNull();
      expect(outcomeIncluded.record?.totals.outputTokens).toBe(0);
    });

    it("strictly rejects missing, negative, or invalid timestamps as malformed (not zero-success)", () => {
      // 1. Negative timestamp
      const badBlob1 = encodeSyntheticGenMetadataBlob({
        modelName: "gemini-3.8-flash",
        timestampSeconds: -100n,
        inputTokens: 100,
      });
      const res1 = parseAntigravityGenMetadataBlob(badBlob1);
      expect(res1.success).toBe(false);
      if (!res1.success) {
        expect(res1.reason).toContain("outside safe range");
      }

      // 2. Corrupted timestamp bytes (invalid wire type or truncated)
      const corruptedBytes = new Uint8Array([
        (1 << 3) | 2,
        4, // field 1 (chat_model), length 4
        (9 << 3) | 2,
        2, // field 9 (chat_start_metadata), length 2
        (4 << 3) | 2,
        0, // field 4 (created_at), length 0 (empty timestamp)
      ]);
      const res2 = parseAntigravityGenMetadataBlob(corruptedBytes);
      expect(res2.success).toBe(false);
      if (!res2.success) {
        expect(res2.reason).toContain("Missing required field 'seconds'");
      }
    });

    it("strictly enforces max blob size and nesting limits", () => {
      const blob = encodeSyntheticGenMetadataBlob({
        timestampSeconds: 1789402266n,
        inputTokens: 50,
      });

      // Blob size bound
      const resSize = parseAntigravityGenMetadataBlob(blob, { maxBlobSize: 10 });
      expect(resSize.success).toBe(false);
      if (!resSize.success) {
        expect(resSize.reason).toContain("exceeds maximum allowed");
      }

      // Nesting depth bound
      const resDepth = parseAntigravityGenMetadataBlob(blob, { maxNestingDepth: 0 });
      expect(resDepth.success).toBe(false);
      if (!resDepth.success) {
        expect(resDepth.reason).toContain("Max protobuf nesting depth");
      }
    });

    it("never retains private prompt content or headers", () => {
      // Inject dummy prompt bytes at tag 16 (where prompt sections reside in cortex.proto)
      const sensitiveBytes = new TextEncoder().encode("SUPER_SECRET_USER_PROMPT_DATA");
      const blob = encodeSyntheticGenMetadataBlob({
        timestampSeconds: 1789402266n,
        modelName: "gemini-3.8-flash",
        inputTokens: 100,
        extraFields: [{ tag: 16, wireType: 2, value: sensitiveBytes }],
      });

      const outcome = parseAntigravityGenMetadataBlob(blob);
      expect(outcome.success).toBe(true);
      if (!outcome.success) return;

      const recordJson = JSON.stringify(outcome.record);
      expect(recordJson).not.toContain("SUPER_SECRET_USER_PROMPT_DATA");
    });
  });

  describe("Temp SQLite Database Reader", () => {
    let tempDir: string;
    let tempDbPath: string;

    it("reads and parses synthetic SQLite database strictly read-only with status counters", async () => {
      tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "antigravity-usage-test-"));
      tempDbPath = NodePath.join(tempDir, "test-session-uuid.db");

      // Populate temp SQLite DB using Node's native sqlite module
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

      // Row 0: Valid row with tokens
      const blob0 = encodeSyntheticGenMetadataBlob({
        executionId: "exec-001",
        modelName: "gemini-3.8-flash",
        timestampSeconds: 1789402266n,
        timestampNanos: 500_000_000,
        inputTokens: 5000,
        outputTokens: 200,
        cacheReadTokens: 1000,
      });

      // Row 1: Empty row (0 tokens)
      const blob1 = encodeSyntheticGenMetadataBlob({
        executionId: "exec-001",
        modelName: "gemini-3.8-flash",
        timestampSeconds: 1789402270n,
      });

      // Row 2: Corrupted row
      const blob2 = new Uint8Array([0xff, 0xff, 0xff]);

      // Row 3: Valid row with later timestamp
      const blob3 = encodeSyntheticGenMetadataBlob({
        executionId: "exec-001",
        modelName: "gemini-3.8-pro",
        timestampSeconds: 1789402280n,
        inputTokens: 3000,
        outputTokens: 400,
      });

      if (isBun) {
        const stmt = dbInstance.prepare(
          "INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)",
        );
        stmt.run(0, blob0, blob0.length);
        stmt.run(1, blob1, blob1.length);
        stmt.run(2, blob2, blob2.length);
        stmt.run(3, blob3, blob3.length);
        dbInstance.close();
      } else {
        const stmt = dbInstance.prepare(
          "INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)",
        );
        stmt.run(0, blob0, blob0.length);
        stmt.run(1, blob1, blob1.length);
        stmt.run(2, blob2, blob2.length);
        stmt.run(3, blob3, blob3.length);
        dbInstance.close();
      }

      // Read database using reader
      const result = await readAntigravityDatabase(tempDbPath);

      expect(result.rowsRead).toBe(4);
      expect(result.recordsParsed).toBe(2);
      expect(result.skippedEmptyUsage).toBe(1);
      expect(result.malformedRows).toBe(1);
      expect(result.records.length).toBe(2);

      expect(result.records[0]?.model).toBe("gemini-3.8-flash");
      expect(result.records[0]?.totals.uncachedInputTokens).toBe(5000);
      expect(result.records[0]?.totals.cachedInputTokens).toBe(1000);
      expect(result.records[0]?.totals.outputTokens).toBe(200);
      expect(result.records[0]?.dedupeKey).toBe("exec-001:0");

      expect(result.records[1]?.model).toBe("gemini-3.8-pro");
      expect(result.records[1]?.totals.uncachedInputTokens).toBe(3000);
      expect(result.records[1]?.dedupeKey).toBe("exec-001:3");

      // Verify errors array recorded corrupted row 2
      expect(result.errors.length).toBe(1);
      expect(result.errors[0]?.rowIdx).toBe(2);

      // Verify directory scan
      const dirScan = await readAntigravityDirectory(tempDir);
      expect(dirScan.databasesScanned).toBe(1);
      expect(dirScan.totalRowsRead).toBe(4);
      expect(dirScan.totalRecordsParsed).toBe(2);
      expect(dirScan.skippedEmptyUsage).toBe(1);
      expect(dirScan.malformedRows).toBe(1);

      // Verify readAntigravityPaths explicit path list
      const pathScan = await readAntigravityPaths([tempDbPath]);
      expect(pathScan.databasesScanned).toBe(1);
      expect(pathScan.totalRecordsParsed).toBe(2);

      // Verify sinceMs filter
      const filtered = await readAntigravityDatabase(tempDbPath, {
        sinceMs: 1789402275000,
      });
      expect(filtered.records.length).toBe(1);
      expect(filtered.records[0]?.model).toBe("gemini-3.8-pro");

      // Cleanup
      try {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    });

    it("handles missing gen_metadata table gracefully", async () => {
      const emptyDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "antigravity-empty-"));
      const emptyDb = NodePath.join(emptyDir, "no-table.db");

      const isBun = typeof process !== "undefined" && process.versions?.bun !== undefined;
      if (isBun) {
        const { Database } = await import("bun:sqlite");
        const db = new Database(emptyDb);
        db.run("CREATE TABLE other_table (id INTEGER)");
        db.close();
      } else {
        const { DatabaseSync } = await import("node:sqlite");
        const db = new DatabaseSync(emptyDb);
        db.exec("CREATE TABLE other_table (id INTEGER)");
        db.close();
      }

      const res = await readAntigravityDatabase(emptyDb);
      expect(res.rowsRead).toBe(0);
      expect(res.recordsParsed).toBe(0);
      expect(res.records.length).toBe(0);
      expect(res.errors[0]?.reason).toContain("Failed to query gen_metadata");

      try {
        NodeFS.rmSync(emptyDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    });
  });

  describe("Sample Live Database Verification (Read-Only)", () => {
    const liveSamplePath =
      "/Users/rynfar/.pylon-code-nightly/userdata/providers/antigravity/ac0a3dfd6dddb20962cecff6ee5fe65e19d3923be20e52c5ab52ff877f7e4c32/antigravity-acp/conversations/e4960d8c-0867-4b69-b442-5409bcda5e58.db";

    it("reads known sample database and matches exact tokens without corrupting or modifying file", async () => {
      if (!NodeFS.existsSync(liveSamplePath)) {
        // Skip if running on a host where the specific sample database is absent
        return;
      }

      const result = await readAntigravityDatabase(liveSamplePath);

      // Confirmed metrics: 30 rows, 29 records with usage, 1 empty (row 29 capacity error), 0 malformed
      expect(result.rowsRead).toBe(30);
      expect(result.recordsParsed).toBe(29);
      expect(result.skippedEmptyUsage).toBe(1);
      expect(result.malformedRows).toBe(0);
      expect(result.errors.length).toBe(0);

      // Row 0 first generation: model gemini-3.8-flash, input 11822, output 287, reasoning 204
      const row0 = result.records[0]!;
      expect(row0.genIndex).toBe(0);
      expect(row0.model).toBe("gemini-3.8-flash");
      expect(row0.totals.uncachedInputTokens).toBe(11822);
      expect(row0.totals.outputTokens).toBe(287);
      expect(row0.totals.reasoningTokens).toBe(204);
      expect(row0.reportedCostUsd).toBeNull();

      // Aggregate token totals across all 29 records
      let sumUncached = 0;
      let sumCached = 0;
      let sumOutput = 0;
      let sumReasoning = 0;

      for (const rec of result.records) {
        sumUncached += rec.totals.uncachedInputTokens;
        sumCached += rec.totals.cachedInputTokens;
        sumOutput += rec.totals.outputTokens;
        sumReasoning += rec.totals.reasoningTokens;
        expect(rec.reportedCostUsd).toBeNull();
      }

      expect(sumUncached).toBe(238_381);
      expect(sumCached).toBe(522_627);
      expect(sumOutput).toBe(7_252);
      expect(sumReasoning).toBe(4_658);
    });
  });
});
