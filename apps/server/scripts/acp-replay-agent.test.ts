// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeURL from "node:url";

import { assert, it } from "@effect/vitest";

const scriptPath = NodeURL.fileURLToPath(new URL("./acp-replay-agent.ts", import.meta.url));

const entries = [
  { type: "expect_outbound", frame: { kind: "request", method: "initialize", params: "<any>" } },
  { type: "emit_inbound", frame: { kind: "response", method: "initialize", result: {} } },
  { type: "expect_outbound", frame: { kind: "request", method: "session/new", params: "<any>" } },
  {
    type: "emit_inbound",
    frame: { kind: "response", method: "session/new", result: { sessionId: "s" } },
  },
  { type: "runtime_exit", status: "success" },
];

interface Status {
  readonly cursor: number;
  readonly total: number;
  readonly failure?: unknown;
}

const readStatus = (statusPath: string): Status =>
  JSON.parse(NodeFS.readFileSync(statusPath, "utf8")) as Status;

// Harnesses read the status the moment the client has seen a frame, and may
// stop the agent at that moment, so the status must already count the frame.
it("commits the replay status before the client can observe the frames it counts", async () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-acp-replay-agent-"));
  const statusPath = NodePath.join(dir, "status.json");
  const transcriptPath = NodePath.join(dir, "transcript.json");
  NodeFS.writeFileSync(transcriptPath, JSON.stringify({ scenario: "status-order", entries }));
  const child = NodeChildProcess.spawn(
    process.execPath,
    ["--experimental-strip-types", scriptPath],
    {
      env: {
        ...process.env,
        T3_ACP_REPLAY_TRANSCRIPT_PATH: transcriptPath,
        T3_ACP_REPLAY_STATUS_PATH: statusPath,
      },
      stdio: ["pipe", "pipe", "inherit"],
    },
  );
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const observed: Array<Status> = [];
  const lines = NodeReadline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const { id, error } = JSON.parse(line) as { readonly id: number; readonly error?: unknown };
    observed.push(readStatus(statusPath));
    if (id === 1 && error === undefined) {
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/new", params: {} })}\n`,
      );
    } else {
      // Stop the agent the instant its last answer arrives, as session teardown does.
      child.kill("SIGKILL");
    }
  });
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`,
  );
  await exited;
  try {
    assert.deepEqual(
      observed.map(({ cursor, total, failure }) => ({ cursor, total, failure })),
      [
        { cursor: 2, total: 5, failure: undefined },
        { cursor: 5, total: 5, failure: undefined },
      ],
    );
    assert.deepInclude(readStatus(statusPath), { cursor: 5, total: 5 });
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});
