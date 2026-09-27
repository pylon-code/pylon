import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  ProjectReadFileError,
  ProjectListEntriesInput,
  ProjectListEntriesResult,
  ProjectSearchContentsError,
  ProjectSearchContentsInput,
  ProjectSearchEntriesError,
  ProjectSearchEntriesInput,
  ProjectWriteFileError,
} from "./project.ts";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

const decodeSearchEntriesInput = Schema.decodeUnknownSync(ProjectSearchEntriesInput);
const decodeSearchContentsInput = Schema.decodeUnknownSync(ProjectSearchContentsInput);

describe("project search inputs", () => {
  it("allows an empty entries query for bounded frecency browsing", () => {
    const decoded = decodeSearchEntriesInput({
      cwd: "/workspace",
      query: "   ",
      limit: 10,
      kind: "file",
    });
    expect(decoded.query).toBe("");
  });

  it("preserves whitespace in content search queries", () => {
    const decoded = decodeSearchContentsInput({
      cwd: "/workspace",
      query: " foo ",
      limit: 10,
      caseSensitive: false,
      wholeWord: false,
      useRegex: false,
    });
    expect(decoded.query).toBe(" foo ");
  });
});

describe("project directory listing compatibility", () => {
  it("marks opt-in responses while leaving legacy listing shapes intact", () => {
    const decodeInput = Schema.decodeUnknownSync(ProjectListEntriesInput);
    const decodeResult = Schema.decodeUnknownSync(ProjectListEntriesResult);
    expect(decodeInput({ cwd: "/workspace", directoryPath: "" })).toEqual({
      cwd: "/workspace",
      directoryPath: "",
    });
    expect(decodeResult({ entries: [], truncated: false })).toEqual({
      entries: [],
      truncated: false,
    });
    expect(decodeResult({ entries: [], truncated: false, directoryPath: "" }).directoryPath).toBe(
      "",
    );
  });

  it("decodes a new request with the pre-change RPC payload schema", () => {
    // This is the exact projects.listEntries payload schema at the frozen origin/pylon base.
    // Rpc.make uses it to decode a request before the old list handler receives the payload.
    const oldInput = Schema.Struct({ cwd: TrimmedNonEmptyString });
    const oldServerPayload = Schema.decodeUnknownSync(oldInput)({
      cwd: "/workspace",
      directoryPath: "src",
      directoryCursor: "a.ts",
    });
    expect(oldServerPayload).toEqual({ cwd: "/workspace" });
    const oldResponse = Schema.decodeUnknownSync(ProjectListEntriesResult)({
      entries: [{ path: "src/a.ts", kind: "file" }],
      truncated: false,
    });
    expect(oldResponse.directoryPath).toBeUndefined();
  });
});

describe("project RPC errors", () => {
  it("derives stable messages from structured request context while retaining causes", () => {
    const cause = new Error("sensitive platform detail");
    const searchError = new ProjectSearchEntriesError({
      cwd: "/workspace",
      queryLength: "authorization: Bearer secret-token".length,
      limit: 20,
      failure: "search_index_search_failed",
      normalizedCwd: "/workspace",
      detail: "index unavailable",
      cause,
    });
    const readError = new ProjectReadFileError({
      cwd: "/workspace",
      relativePath: "src/index.ts",
      failure: "operation_failed",
      operation: "read",
      operationPath: "/workspace/src/index.ts",
      resolvedPath: "/workspace/src/index.ts",
      cause,
    });

    expect(searchError.message).toBe("Failed to search workspace entries in '/workspace'.");
    expect(searchError.message).not.toContain(cause.message);
    expect(searchError.normalizedCwd).toBe("/workspace");
    expect(searchError.queryLength).toBe("authorization: Bearer secret-token".length);
    expect(searchError).not.toHaveProperty("query");
    expect(searchError.message).not.toMatch(/Bearer|secret-token/);
    expect(searchError.cause).toBe(cause);
    expect(readError.message).toBe("Failed to read workspace file 'src/index.ts' in '/workspace'.");
    expect(readError.message).not.toContain(cause.message);
    expect(readError.cause).toBe(cause);

    const contentSearchError = new ProjectSearchContentsError({
      cwd: "/workspace",
      queryLength: "authorization: Bearer secret-token".length,
      limit: 100,
      failure: "search_index_search_failed",
      cause,
    });
    expect(contentSearchError.message).toBe("Failed to search workspace contents in '/workspace'.");
    expect(contentSearchError.message).not.toContain(cause.message);
    expect(contentSearchError).not.toHaveProperty("query");
    expect(contentSearchError.cause).toBe(cause);
  });

  it("decodes legacy message-only errors during rolling upgrades", () => {
    const decodeSearchError = Schema.decodeUnknownSync(ProjectSearchEntriesError);
    const decodeWriteError = Schema.decodeUnknownSync(ProjectWriteFileError);

    const searchError = decodeSearchError({
      _tag: "ProjectSearchEntriesError",
      message: "Legacy project search failure.",
      query: "legacy sensitive query",
    });
    const writeError = decodeWriteError({
      _tag: "ProjectWriteFileError",
      message: "Legacy project write failure.",
    });

    expect(searchError.message).toBe("Legacy project search failure.");
    expect(searchError.cwd).toBeUndefined();
    expect(searchError.queryLength).toBeUndefined();
    expect(searchError).not.toHaveProperty("query");
    expect(searchError.failure).toBeUndefined();
    expect(writeError.message).toBe("Legacy project write failure.");
    expect(writeError.relativePath).toBeUndefined();
    expect(writeError.failure).toBeUndefined();
  });
});
