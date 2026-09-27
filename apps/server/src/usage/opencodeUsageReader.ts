// node:sqlite reads live OpenCode databases; Node fs walks legacy JSON history.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeTimersPromises from "node:timers/promises";

import { totalTokens, type UsageRecord } from "./usageTranscripts.ts";

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function tokens(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** OpenCode stores uncached input and reasoning separately from input/output. */
function parseOpenCodeMessage(
  source: string,
  fallback: {
    readonly id?: string;
    readonly sessionId?: string;
    readonly timestampMs?: number;
  } = {},
): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return null;
  }
  const message = object(parsed);
  if (message.role !== undefined && message.role !== "assistant") return null;
  const usage = object(message.tokens);
  const cache = object(usage.cache);
  const modelReference = object(message.model);
  const model = text(modelReference.id) || text(modelReference.modelID) || text(message.modelID);
  const timestampMs = object(message.time).created ?? fallback.timestampMs;
  if (!model || typeof timestampMs !== "number" || !Number.isFinite(timestampMs)) return null;
  const reasoningTokens = tokens(usage.reasoning);
  const totals = {
    uncachedInputTokens: tokens(usage.input),
    cachedInputTokens: tokens(cache.read),
    cacheCreationTokens: tokens(cache.write),
    outputTokens: tokens(usage.output) + reasoningTokens,
    reasoningTokens,
  };
  if (totalTokens(totals) === 0) return null;
  const id = fallback.id || text(message.id);
  const cost = message.cost;
  return {
    provider: "opencode",
    timestampMs,
    model,
    sessionId: fallback.sessionId || text(message.sessionID),
    totals,
    // OpenCode writes zero for models without a known rate, including paid
    // subscription models. Let the shared price table estimate those records.
    reportedCostUsd: typeof cost === "number" && Number.isFinite(cost) && cost > 0 ? cost : null,
    fast: false,
    dedupeKey: id ? `opencode:${id}` : null,
  };
}

export interface OpenCodeUsageReadResult {
  readonly files: readonly { readonly path: string; readonly records: readonly UsageRecord[] }[];
  readonly missing: boolean;
  readonly error: boolean;
  readonly truncated: boolean;
}

const MAX_FILES = 500;
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_RECORDS = 50_000;
const MAX_JSON_BYTES = 2 * 1024 * 1024;

interface FileStamp {
  readonly size: number;
  readonly mtimeMs: number;
}

export interface OpenCodeUsageCache {
  readonly get: (path: string, stamp: FileStamp) => readonly UsageRecord[] | undefined;
  readonly set: (path: string, stamp: FileStamp, records: readonly UsageRecord[]) => void;
}

/** Reads current SQLite and pre-migration JSON stores without modifying either. */
export async function readOpenCodeUsage(
  root: string,
  sinceMs: number,
  cache?: OpenCodeUsageCache,
): Promise<OpenCodeUsageReadResult> {
  const files: { path: string; records: UsageRecord[] }[] = [];
  let found = false;
  let error = false;
  let truncated = false;
  let bytes = 0;
  let recordsRead = 0;
  let rowsVisited = 0;
  const append = (records: UsageRecord[], record: UsageRecord | null) => {
    if (record === null || record.timestampMs < sinceMs) return;
    if (recordsRead >= MAX_RECORDS) {
      truncated = true;
      return;
    }
    records.push(record);
    recordsRead++;
  };

  const stamp = async (path: string, database: boolean): Promise<FileStamp> => {
    const stat = await NodeFSP.stat(path);
    let size = stat.size;
    let mtimeMs = stat.mtimeMs;
    if (database) {
      const wal = await NodeFSP.stat(`${path}-wal`).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code === "ENOENT") return null;
        throw cause;
      });
      if (wal !== null) {
        size += wal.size;
        mtimeMs = Math.max(mtimeMs, wal.mtimeMs);
      }
    }
    return { size, mtimeMs };
  };

  let databases: string[] = [];
  try {
    databases = (await NodeFSP.readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /^opencode(?:-[a-zA-Z0-9_-]+)?\.db$/.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => (a === "opencode.db" ? -1 : b === "opencode.db" ? 1 : a.localeCompare(b)));
  } catch (cause) {
    if (object(cause).code !== "ENOENT") error = true;
  }
  for (const name of databases) {
    found = true;
    if (files.length >= MAX_FILES || recordsRead >= MAX_RECORDS) {
      truncated = true;
      break;
    }
    const file = { path: NodePath.join(root, name), records: [] as UsageRecord[] };
    files.push(file);
    let database: NodeSqlite.DatabaseSync | undefined;
    try {
      const fileStamp = await stamp(file.path, true);
      if (bytes + fileStamp.size > MAX_BYTES) {
        truncated = true;
        continue;
      }
      bytes += fileStamp.size;
      const cached = cache?.get(file.path, fileStamp);
      if (cached !== undefined) {
        for (const record of cached) append(file.records, record);
        continue;
      }
      database = new NodeSqlite.DatabaseSync(NodePath.join(root, name), { readOnly: true });
      // A busy live provider should fail this source promptly rather than
      // stalling the server while SQLite waits for its writer.
      database.exec("PRAGMA busy_timeout = 100");
      const tables = new Set(
        database
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all()
          .map((row) => row.name),
      );
      if (!tables.has("message") && !tables.has("session_message")) error = true;
      for (const table of ["message", "session_message"] as const) {
        if (!tables.has(table)) continue;
        const columns = new Set(
          database
            .prepare(`PRAGMA table_info(${table})`)
            .all()
            .map((row) => row.name),
        );
        const timestamp = columns.has("time_created") ? "time_created" : "NULL";
        const predicates = table === "session_message" ? ["type = 'assistant'"] : [];
        if (timestamp !== "NULL") predicates.push("time_created >= ?");
        const where = predicates.length > 0 ? ` WHERE ${predicates.join(" AND ")}` : "";
        const statement = database.prepare(
          `SELECT id, session_id, data, ${timestamp} AS created FROM ${table}${where}`,
        );
        let count = 0;
        for (const row of statement.iterate(...(timestamp === "NULL" ? [] : [sinceMs]))) {
          if (recordsRead >= MAX_RECORDS || rowsVisited >= MAX_RECORDS) {
            truncated = true;
            break;
          }
          rowsVisited++;
          append(
            file.records,
            parseOpenCodeMessage(text(row.data), {
              id: text(row.id),
              sessionId: text(row.session_id),
              ...(typeof row.created === "number" ? { timestampMs: row.created } : {}),
            }),
          );
          if (++count % 256 === 0) await NodeTimersPromises.setImmediate();
        }
      }
      if (!truncated) cache?.set(file.path, fileStamp, file.records);
    } catch {
      error = true;
    } finally {
      database?.close();
    }
  }

  // Do not follow symlinks, including cycles. The shared aggregator de-duplicates
  // SQLite rows against legacy JSON copies after the per-file cache is loaded.
  const directories = [NodePath.join(root, "storage", "message")];
  let visitedDirectories = 0;
  let visitedEntries = 0;
  while (directories.length > 0) {
    if (
      files.length >= MAX_FILES ||
      recordsRead >= MAX_RECORDS ||
      visitedDirectories >= MAX_FILES ||
      visitedEntries >= MAX_FILES * 20
    ) {
      truncated = true;
      break;
    }
    const directory = directories.pop()!;
    visitedDirectories++;
    try {
      for await (const entry of await NodeFSP.opendir(directory)) {
        visitedEntries++;
        if (
          files.length >= MAX_FILES ||
          recordsRead >= MAX_RECORDS ||
          visitedEntries >= MAX_FILES * 20
        ) {
          truncated = true;
          break;
        }
        const path = NodePath.join(directory, entry.name);
        if (entry.isDirectory()) {
          directories.push(path);
        } else if (entry.isFile() && entry.name.endsWith(".json")) {
          found = true;
          const id = entry.name.slice(0, -5);
          const file = { path, records: [] as UsageRecord[] };
          files.push(file);
          try {
            const fileStamp = await stamp(path, false);
            if (fileStamp.size > MAX_JSON_BYTES || bytes + fileStamp.size > MAX_BYTES) {
              truncated = true;
              continue;
            }
            bytes += fileStamp.size;
            const cached = cache?.get(path, fileStamp);
            if (cached !== undefined) {
              for (const record of cached) append(file.records, record);
              continue;
            }
            append(
              file.records,
              parseOpenCodeMessage(await NodeFSP.readFile(path, "utf8"), { id }),
            );
            cache?.set(path, fileStamp, file.records);
          } catch (cause) {
            if (object(cause).code !== "ENOENT") error = true;
          }
        }
      }
    } catch (cause) {
      if (object(cause).code !== "ENOENT") error = true;
    }
  }
  return { files, missing: !found && !error, error, truncated };
}
