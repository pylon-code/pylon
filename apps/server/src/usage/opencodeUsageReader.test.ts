// @effect-diagnostics nodeBuiltinImport:off -- Real SQLite and JSON fixtures exercise local usage reads.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { describe, expect, it } from "vite-plus/test";

import { readOpenCodeUsage, type OpenCodeUsageCache } from "./opencodeUsageReader.ts";

const SINCE = Date.parse("2026-07-31T00:00:00Z");
const CREATED = Date.parse("2026-08-01T10:00:00Z");
const message = (id: string, output = 8) =>
  JSON.stringify({
    id,
    role: "assistant",
    sessionID: "session-1",
    modelID: "openai/gpt-6",
    time: { created: CREATED },
    tokens: { input: 2, output, reasoning: 3, cache: { read: 4, write: 1 } },
  });

async function withRoot(run: (root: string) => Promise<void>) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pylon-opencode-usage-"));
  try {
    await run(root);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
}

describe("local OpenCode usage reader", () => {
  it("reads SQLite and legacy JSON with the same token accounting", async () =>
    withRoot(async (root) => {
      const database = new NodeSqlite.DatabaseSync(NodePath.join(root, "opencode.db"));
      database.exec(
        "CREATE TABLE message (id TEXT, session_id TEXT, data TEXT, time_created INTEGER)",
      );
      database
        .prepare("INSERT INTO message VALUES (?, ?, ?, ?)")
        .run("db-1", "session-1", message("db-1"), CREATED);
      database.close();
      const legacy = NodePath.join(root, "storage", "message", "session-1");
      await NodeFSP.mkdir(legacy, { recursive: true });
      await NodeFSP.writeFile(NodePath.join(legacy, "json-1.json"), message("json-1"));
      const read = await readOpenCodeUsage(root, SINCE);
      expect(read.error).toBe(false);
      expect(read.truncated).toBe(false);
      const records = read.files.flatMap((file) => file.records);
      expect(records).toHaveLength(2);
      expect(records.map((record) => record.dedupeKey).sort()).toEqual([
        "opencode:db-1",
        "opencode:json-1",
      ]);
      for (const record of records) {
        expect(record.totals).toEqual({
          uncachedInputTokens: 2,
          cachedInputTokens: 4,
          cacheCreationTokens: 1,
          outputTokens: 11,
          reasoningTokens: 3,
        });
      }
    }));

  it("invalidates cached SQLite records when only its WAL changes", async () =>
    withRoot(async (root) => {
      const dbPath = NodePath.join(root, "opencode.db");
      const database = new NodeSqlite.DatabaseSync(dbPath);
      database.exec(
        "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE message (id TEXT, session_id TEXT, data TEXT, time_created INTEGER)",
      );
      database
        .prepare("INSERT INTO message VALUES (?, ?, ?, ?)")
        .run("one", "session-1", message("one"), CREATED);
      const entries = new Map<
        string,
        {
          stamp: { size: number; mtimeMs: number };
          records: readonly import("./usageTranscripts.ts").UsageRecord[];
        }
      >();
      let stores = 0;
      const cache: OpenCodeUsageCache = {
        get: (path, stamp) => {
          const entry = entries.get(path);
          return entry?.stamp.size === stamp.size && entry.stamp.mtimeMs === stamp.mtimeMs
            ? entry.records
            : undefined;
        },
        set: (path, stamp, records) => {
          entries.set(path, { stamp, records });
          stores++;
        },
      };
      try {
        expect(
          (await readOpenCodeUsage(root, SINCE, cache)).files.flatMap((file) => file.records),
        ).toHaveLength(1);
        expect(
          (await readOpenCodeUsage(root, SINCE, cache)).files.flatMap((file) => file.records),
        ).toHaveLength(1);
        expect(stores).toBe(1);
        database
          .prepare("INSERT INTO message VALUES (?, ?, ?, ?)")
          .run("two", "session-1", message("two"), CREATED);
        expect(
          (await readOpenCodeUsage(root, SINCE, cache)).files.flatMap((file) => file.records),
        ).toHaveLength(2);
        expect(stores).toBe(2);
      } finally {
        database.close();
      }
    }));

  it("marks oversized legacy files and excessive malformed rows as partial", async () =>
    withRoot(async (root) => {
      const legacy = NodePath.join(root, "storage", "message", "session-1");
      await NodeFSP.mkdir(legacy, { recursive: true });
      await NodeFSP.writeFile(
        NodePath.join(legacy, "oversize.json"),
        "x".repeat(2 * 1024 * 1024 + 1),
      );
      const database = new NodeSqlite.DatabaseSync(NodePath.join(root, "opencode.db"));
      database.exec(
        "CREATE TABLE message (id TEXT, session_id TEXT, data TEXT, time_created INTEGER)",
      );
      const insert = database.prepare("INSERT INTO message VALUES (?, ?, ?, ?)");
      database.exec("BEGIN");
      for (let index = 0; index <= 50_000; index++) {
        insert.run(`bad-${index}`, "session-1", "{invalid", CREATED);
      }
      database.exec("COMMIT");
      database.close();
      const read = await readOpenCodeUsage(root, SINCE);
      expect(read.truncated).toBe(true);
      expect(read.files.flatMap((file) => file.records)).toHaveLength(0);
    }));
});
