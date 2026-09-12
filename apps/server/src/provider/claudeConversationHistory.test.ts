import { describe, expect, it } from "vite-plus/test";
import {
  proveClaudeHistory,
  proveClaudeNativeHistory,
  isVerifiedClaudeFork,
} from "./claudeConversationHistory.ts";

const session = "550e8400-e29b-41d4-a716-446655440010";
const forkSession = "550e8400-e29b-41d4-a716-446655440020";
const cwd = "/workspace";
const uuids = [
  "550e8400-e29b-41d4-a716-446655440001",
  "550e8400-e29b-41d4-a716-446655440002",
  "550e8400-e29b-41d4-a716-446655440003",
];
const forkUuids = [
  "650e8400-e29b-41d4-a716-446655440001",
  "650e8400-e29b-41d4-a716-446655440002",
  "650e8400-e29b-41d4-a716-446655440003",
];
const rows = [
  {
    type: "user",
    uuid: uuids[0],
    parentUuid: null,
    sessionId: session,
    cwd,
    timestamp: "2026-09-01T00:00:00.000Z",
    message: { role: "user", content: "prompt" },
  },
  {
    type: "attachment",
    uuid: uuids[1],
    parentUuid: uuids[0],
    sessionId: session,
    cwd,
    timestamp: "2026-09-01T00:00:00.000Z",
    attachment: { type: "context", content: "hidden context" },
  },
  {
    type: "assistant",
    uuid: uuids[2],
    parentUuid: uuids[1],
    logicalParentUuid: uuids[0],
    sessionId: session,
    cwd,
    timestamp: "2026-09-01T00:00:00.000Z",
    parent_tool_use_id: "tool-parent",
    parent_agent_id: "agent-parent",
    message: {
      id: "message-semantic",
      role: "assistant",
      content: [{ type: "tool_use", id: "tool-semantic", name: "Read", input: { path: "file" } }],
    },
  },
];
const proof = (value: unknown, id = session) =>
  proveClaudeNativeHistory(
    typeof value === "string"
      ? value
      : (value as ReadonlyArray<unknown>).map((row) => JSON.stringify(row)).join("\n"),
    id,
    new Set([cwd]),
  );
const remap = (id: string | null | undefined) => (id == null ? id : forkUuids[uuids.indexOf(id)]);
const forkRows = rows.map((row, index) => ({
  ...row,
  uuid: forkUuids[index],
  sessionId: forkSession,
  parentUuid: remap(row.parentUuid),
  ...(row.logicalParentUuid ? { logicalParentUuid: remap(row.logicalParentUuid) } : {}),
  forkedFrom: { sessionId: session, messageUuid: row.uuid },
  ...(index === rows.length - 1 ? { timestamp: "2026-09-12T00:00:00.000Z" } : {}),
}));

describe("Claude full native history proof", () => {
  it("normalizes proven fork IDs/provenance and only the final timestamp", () => {
    expect(proof(forkRows, forkSession)?.digest).toBe(proof(rows)?.digest);
    expect(
      isVerifiedClaudeFork(session, proof(rows)!.rows, proof(forkRows, forkSession)!.rows),
    ).toBe(true);
    expect(
      proof(
        forkRows.map((row, index) =>
          index === 0 ? { ...row, timestamp: "2026-09-12T00:00:00.000Z" } : row,
        ),
        forkSession,
      )?.digest,
    ).not.toBe(proof(rows)?.digest);
    expect(
      isVerifiedClaudeFork(forkSession, proof(rows)!.rows, proof(forkRows, forkSession)!.rows),
    ).toBe(false);
  });
  it("preserves attachments, tool identities, parent relationships and unknown semantic data", () => {
    const original = proof(rows)!.digest;
    for (const [from, to] of [
      ["hidden context", "changed context"],
      ["tool-parent", "different-parent"],
      ["agent-parent", "other-agent"],
      ["tool-semantic", "other-tool"],
    ]) {
      expect(
        proof(rows.map((row) => JSON.parse(JSON.stringify(row).replace(from!, to!))))?.digest,
      ).not.toBe(original);
    }
    expect(
      proof(rows.map((row, index) => (index === 2 ? { ...row, logicalParentUuid: uuids[1] } : row)))
        ?.digest,
    ).not.toBe(original);
    expect(
      proof(rows.map((row, index) => (index === 2 ? { ...row, neutralizedByFork: true } : row)))
        ?.digest,
    ).not.toBe(original);
  });
  it("rejects missing, malformed, ambiguous and foreign native content", () => {
    expect(proof("")).toBeUndefined();
    expect(proof([{ type: "custom-title", customTitle: "empty" }])).toBeUndefined();
    expect(proof(`${JSON.stringify(rows[0])}\nmalformed`)).toBeUndefined();
    expect(proof([...rows, rows[0]])).toBeUndefined();
    expect(proof(rows, forkSession)).toBeUndefined();
    expect(proof(rows.map((row) => ({ ...row, cwd: "/another-workspace" })))).toBeUndefined();
    expect(
      proof(rows.map((row, index) => (index === 0 ? { ...row, parentUuid: uuids[2] } : row))),
    ).toBeUndefined();
    expect(
      proof(rows.map((row, index) => (index === 1 ? { ...row, isSidechain: true } : row))),
    ).toBeUndefined();
  });
  it("uses only explicit projected semantic fields and rejects mismatched record identity", () => {
    const message = {
      type: "assistant",
      uuid: uuids[2],
      session_id: session,
      parent_tool_use_id: "parent",
      parent_agent_id: "agent",
      message: { content: "answer" },
      timestamp: "earlier",
    };
    expect(proveClaudeHistory([message], session)?.digest).toBe(
      proveClaudeHistory(
        [{ ...message, timestamp: "later", uuid: forkUuids[2], session_id: forkSession }],
        forkSession,
      )?.digest,
    );
    expect(proveClaudeHistory([message], forkSession)).toBeUndefined();
  });
});
