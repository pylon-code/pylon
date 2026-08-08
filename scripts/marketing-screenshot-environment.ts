// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - This host-side fixture creates an isolated local Pylon environment.
//
// Seeds the fake environment behind the marketing hero image
// (apps/marketing/public/app-preview.webp). Everything here is invented: no
// real project, thread, or customer data may appear in a public screenshot.
//
// Usage:
//   BASE=$(mktemp -d /tmp/pylon-marketing.XXXXXX)
//   vp run dev --home-dir "$BASE"          # leave running
//   node scripts/marketing-screenshot-environment.ts "$BASE"
//
// Direct projection writes are appropriate here: this is a disposable visual
// fixture, not a behavioural test. See .claude/skills/test-pylon-app.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeUtil from "node:util";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

export const HERO_PROJECT_ID = "pylon";
export const HERO_THREAD_ID = "stream-provider-output";

const PROJECTOR_NAMES = [
  "projection.projects",
  "projection.threads",
  "projection.thread-messages",
  "projection.thread-proposed-plans",
  "projection.thread-activities",
  "projection.thread-sessions",
  "projection.thread-turns",
  "projection.checkpoints",
  "projection.pending-approvals",
] as const;

const SEEDED_PROJECTION_TABLES = [
  "projection_pending_approvals",
  "projection_thread_proposed_plans",
  "projection_thread_activities",
  "projection_thread_messages",
  "projection_thread_sessions",
  "projection_turns",
  "projection_threads",
  "projection_projects",
  "projection_state",
] as const;

// instanceId must match a real provider instance ("claudeAgent", not "claude")
// and model must be a slug the Claude provider actually publishes. Get either
// wrong and the composer renders "No provider available" instead of a picker.
const MODEL_SELECTION = JSON.stringify({ instanceId: "claudeAgent", model: "claude-opus-4-5" });

const PROJECT_SCRIPTS = JSON.stringify([
  { id: "dev", name: "Dev", command: "pnpm dev", icon: "play", runOnWorktreeCreate: false },
  { id: "test", name: "Tests", command: "pnpm test", icon: "test", runOnWorktreeCreate: false },
]);

const FAVICONS = {
  pylon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs><mask id="m"><path d="M558 158.6 L795.1 295.4 A92 92 0 0 1 841.1 375.1 L841.1 648.9 A92 92 0 0 1 795.1 728.6 L558 865.4 A92 92 0 0 1 466 865.4 L228.9 728.6 A92 92 0 0 1 182.9 648.9 L182.9 375.1 A92 92 0 0 1 228.9 295.4 L466 158.6 A92 92 0 0 1 558 158.6 Z" fill="#fff"/>
  <path d="M321.5 395 L512 285 L702.5 395 M321.5 395 L512 505 L702.5 395 M702.5 395 L702.5 615 L512 725 M321.5 395 L321.5 892 M512 505 L512 892" fill="none" stroke="#000" stroke-width="41" stroke-linecap="round" stroke-linejoin="round"/></mask></defs>
  <rect width="1024" height="1024" rx="184" fill="#0a0a0a"/>
  <path d="M558 158.6 L795.1 295.4 A92 92 0 0 1 841.1 375.1 L841.1 648.9 A92 92 0 0 1 795.1 728.6 L558 865.4 A92 92 0 0 1 466 865.4 L228.9 728.6 A92 92 0 0 1 182.9 648.9 L182.9 375.1 A92 92 0 0 1 228.9 295.4 L466 158.6 A92 92 0 0 1 558 158.6 Z" fill="#f2f2f0" mask="url(#m)"/>
</svg>`,
  react: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="15" fill="#20232a"/>
  <g fill="none" stroke="#61dafb" stroke-width="2.8"><ellipse cx="32" cy="32" rx="25" ry="9"/><ellipse cx="32" cy="32" rx="25" ry="9" transform="rotate(60 32 32)"/><ellipse cx="32" cy="32" rx="25" ry="9" transform="rotate(120 32 32)"/></g>
  <circle cx="32" cy="32" r="4.8" fill="#61dafb"/>
</svg>`,
  astro: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="15" fill="#17191e"/>
  <path d="M32 10 L44 46 L32 40 L20 46 Z" fill="#ff5d01"/>
  <ellipse cx="32" cy="46" rx="11" ry="5" fill="none" stroke="#ff5d01" stroke-width="2.6"/>
</svg>`,
  linux: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="15" fill="#f7c948"/>
  <ellipse cx="32" cy="35" rx="17" ry="22" fill="#202124"/>
  <ellipse cx="32" cy="40" rx="12" ry="14" fill="#f5f5f2"/>
  <circle cx="27" cy="24" r="5" fill="#fff"/><circle cx="37" cy="24" r="5" fill="#fff"/>
  <circle cx="28" cy="25" r="2"/><circle cx="36" cy="25" r="2"/>
  <path d="M27 31l5-4 5 4-5 4z" fill="#f28c28"/><path d="M16 55h14l-7-5zM34 55h14l-7-5z" fill="#f28c28"/>
</svg>`,
  ripgrep: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="15" fill="#1d2430"/>
  <circle cx="28" cy="28" r="13" fill="none" stroke="#8ac6f2" stroke-width="4"/>
  <path d="M38 38 L50 50" stroke="#8ac6f2" stroke-width="5" stroke-linecap="round"/>
</svg>`,
  zed: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="15" fill="#101014"/>
  <path d="M18 18 H46 L18 46 H46" fill="none" stroke="#d4a24c" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`,
} as const;

export const HERO_PROJECTS = [
  {
    id: HERO_PROJECT_ID,
    title: "pylon",
    directory: "pylon",
    repositoryUrl: "https://github.com/pylon-code/pylon.git",
    favicon: FAVICONS.pylon,
  },
  {
    id: "react",
    title: "react",
    directory: "react",
    repositoryUrl: "https://github.com/facebook/react.git",
    favicon: FAVICONS.react,
  },
  {
    id: "astro",
    title: "astro",
    directory: "astro",
    repositoryUrl: "https://github.com/withastro/astro.git",
    favicon: FAVICONS.astro,
  },
  {
    id: "ripgrep",
    title: "ripgrep",
    directory: "ripgrep",
    repositoryUrl: "https://github.com/BurntSushi/ripgrep.git",
    favicon: FAVICONS.ripgrep,
  },
  {
    id: "zed",
    title: "zed",
    directory: "zed",
    repositoryUrl: "https://github.com/zed-industries/zed.git",
    favicon: FAVICONS.zed,
  },
  {
    id: "linux",
    title: "linux",
    directory: "linux",
    repositoryUrl: "https://github.com/torvalds/linux.git",
    favicon: FAVICONS.linux,
  },
] as const;

const HERO_RESPONSE = `Found it. The stutter was not the stream itself — it was every token
triggering a full re-render of the transcript.

Three changes, none of which touch the wire format:

| Change | Where | Effect |
| --- | --- | --- |
| Batch tokens per frame | \`useStreamingText\` | 1 render per frame, not per token |
| Memoize settled messages | \`MessageList\` | Older turns stop re-rendering |
| Drop the pulse animation | \`StreamingCaret\` | No continuous repaint on 120Hz |

The transcript now holds a steady **120fps** while Claude streams, measured
against the 4,000-token reply that used to drop to 38fps. Settled messages no
longer re-render at all once their turn completes.

I kept the caret visible but static — a continuously animating element pegs
the GPU on high-refresh displays, which is what made this obvious in the
first place.`;

export const HERO_THREADS = [
  {
    id: HERO_THREAD_ID,
    projectId: HERO_PROJECT_ID,
    title: "Stream provider output without dropping frames",
    branch: "perf/stream-provider-output",
    minutesAgo: 2,
    request:
      "The thread view stutters when Claude streams a long reply on my 120Hz display. Find what is dropping frames and fix it without changing the wire format.",
    response: HERO_RESPONSE,
  },
  {
    id: "resume-after-sleep",
    projectId: HERO_PROJECT_ID,
    title: "Reconnect cleanly after the laptop sleeps",
    branch: "fix/resume-after-sleep",
    minutesAgo: 9,
    state: "working" as const,
    request: "When my laptop wakes, the session reconnects but the composer stays disabled.",
    response: null,
  },
  {
    id: "tunnel-share-links",
    projectId: HERO_PROJECT_ID,
    title: "Expire tunnel share links after 24h",
    branch: "feat/tunnel-share-links",
    minutesAgo: 31,
    state: "approval" as const,
    request: "Share links should stop working after a day unless they are explicitly renewed.",
    response:
      "Links now carry an expiry claim and the relay rejects them past it. Ready for review.",
  },
  {
    id: "suspense-transitions",
    projectId: "react",
    title: "Trace dropped frames in nested Suspense",
    branch: "perf/suspense-transitions",
    minutesAgo: 18,
    state: "working" as const,
    request: "Profile nested Suspense transitions and find where the frames go.",
    response: null,
  },
  {
    id: "island-hydration",
    projectId: "astro",
    title: "Defer island hydration below the fold",
    branch: "perf/island-hydration",
    minutesAgo: 47,
    state: "plan" as const,
    request: "Islands below the fold should not hydrate until they are close to the viewport.",
    response: "The plan adds an intersection-based strategy without changing island authoring.",
  },
  {
    id: "glob-parity",
    projectId: "ripgrep",
    title: "Match git's glob precedence exactly",
    branch: "fix/glob-parity",
    minutesAgo: 3 * 60,
    settled: true,
    request:
      "Negated globs in nested ignore files disagree with git. Make the precedence identical.",
    response: "Precedence now walks ignore files in git's order, with a table test per rule.",
  },
  {
    id: "multibuffer-scroll",
    projectId: "zed",
    title: "Keep multibuffer scroll anchored on edit",
    branch: "fix/multibuffer-scroll",
    minutesAgo: 9 * 60,
    settled: true,
    request: "Editing one excerpt jumps the whole multibuffer.",
    response: "The scroll anchor now survives excerpt reflow, so the cursor stays put.",
  },
  {
    id: "quieter-oom",
    projectId: "linux",
    title: "Make the OOM killer explain itself",
    branch: "feat/quieter-oom",
    minutesAgo: 2 * 24 * 60,
    settled: true,
    request: "Make out-of-memory kills legible without adding an allocation to the hot path.",
    response: "Kills now report the winning heuristic and the runner-up alongside the usual dump.",
  },
] as const;

function minutesBefore(now: number, minutes: number): string {
  return new Date(now - minutes * 60_000).toISOString();
}

async function runGit(cwd: string, args: ReadonlyArray<string>): Promise<void> {
  await execFile("git", [...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Sam Ellis",
      GIT_AUTHOR_EMAIL: "sam@example.test",
      GIT_COMMITTER_NAME: "Sam Ellis",
      GIT_COMMITTER_EMAIL: "sam@example.test",
    },
  });
}

async function seedWorkspace(input: {
  readonly workspaceRoot: string;
  readonly title: string;
  readonly repositoryUrl: string;
  readonly favicon: string;
  readonly branch?: string;
}): Promise<void> {
  // Idempotent: iterating on the screenshot means reseeding against a base dir
  // whose workspaces already exist, and `git init` twice is an error.
  const alreadyInitialized = await NodeFSP.access(NodePath.join(input.workspaceRoot, ".git")).then(
    () => true,
    () => false,
  );
  if (alreadyInitialized) return;
  await NodeFSP.mkdir(input.workspaceRoot, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(input.workspaceRoot, "favicon.svg"), input.favicon);
  await NodeFSP.writeFile(
    NodePath.join(input.workspaceRoot, "README.md"),
    `# ${input.title}\n\nFixture workspace for the Pylon marketing screenshot.\n`,
  );
  await runGit(input.workspaceRoot, ["init", "-b", "main"]);
  await runGit(input.workspaceRoot, ["remote", "add", "origin", input.repositoryUrl]);
  await runGit(input.workspaceRoot, ["add", "."]);
  await runGit(input.workspaceRoot, ["commit", "-m", `Seed ${input.title} workspace`]);
  if (input.branch) await runGit(input.workspaceRoot, ["checkout", "-b", input.branch]);
}

function hasSeedableSchema(dbPath: string): boolean {
  let database: NodeSqlite.DatabaseSync;
  try {
    database = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return false;
  }
  try {
    const row = database
      .prepare(
        `SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN (${SEEDED_PROJECTION_TABLES.map(() => "?").join(", ")})`,
      )
      .get(...SEEDED_PROJECTION_TABLES) as { count: number };
    return row.count === SEEDED_PROJECTION_TABLES.length;
  } catch {
    return false;
  } finally {
    database.close();
  }
}

async function waitForSeedableSchema(dbPath: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hasSeedableSchema(dbPath)) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Timed out waiting for a seedable schema at ${dbPath}.`);
}

function insertThread(
  database: NodeSqlite.DatabaseSync,
  now: number,
  input: {
    readonly id: string;
    readonly projectId: string;
    readonly title: string;
    readonly branch: string;
    readonly minutesAgo: number;
    readonly state?: "working" | "approval" | "plan";
    readonly settled?: boolean;
    readonly workspaceRoot: string;
  },
): void {
  const turnId = `${input.id}-turn`;
  const updatedAt = minutesBefore(now, input.minutesAgo);
  const isWorking = input.state === "working";
  database
    .prepare(
      `INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
        branch, worktree_path, latest_turn_id, latest_user_message_at, pending_approval_count,
        pending_user_input_count, has_actionable_proposed_plan, created_at, updated_at,
        archived_at, deleted_at, settled_override, settled_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, NULL, NULL, ?, ?)`,
    )
    .run(
      input.id,
      input.projectId,
      input.title,
      MODEL_SELECTION,
      "full-access",
      input.state === "plan" ? "plan" : "default",
      input.branch,
      input.workspaceRoot,
      turnId,
      minutesBefore(now, input.minutesAgo + 1),
      input.state === "approval" ? 1 : 0,
      input.state === "plan" ? 1 : 0,
      minutesBefore(now, input.minutesAgo + 120),
      updatedAt,
      input.settled ? "settled" : null,
      input.settled ? updatedAt : null,
    );
  database
    .prepare(
      `INSERT INTO projection_turns (
        thread_id, turn_id, pending_message_id, assistant_message_id, state, requested_at,
        started_at, completed_at, checkpoint_turn_count, checkpoint_ref, checkpoint_status,
        checkpoint_files_json, source_proposed_plan_thread_id, source_proposed_plan_id
      ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, NULL, NULL, NULL, '[]', NULL, NULL)`,
    )
    .run(
      input.id,
      turnId,
      isWorking ? null : `${input.id}-answer`,
      isWorking ? "running" : "completed",
      minutesBefore(now, input.minutesAgo + 2),
      minutesBefore(now, input.minutesAgo + 2),
      isWorking ? null : updatedAt,
    );
  database
    .prepare(
      `INSERT INTO projection_thread_sessions (
        thread_id, status, provider_name, provider_instance_id, provider_session_id,
        provider_thread_id, runtime_mode, active_turn_id, last_error, updated_at
      ) VALUES (?, ?, 'claudeAgent', 'claudeAgent', NULL, NULL, 'full-access', ?, NULL, ?)`,
    )
    .run(input.id, isWorking ? "running" : "ready", isWorking ? turnId : null, updatedAt);
}

function seedDatabase(
  dbPath: string,
  workspaceRoots: ReadonlyMap<string, string>,
  now: number,
): void {
  // The dev server keeps writing to this file while we seed, so the write lock
  // is genuinely contended; without a busy timeout BEGIN IMMEDIATE fails
  // instantly with SQLITE_BUSY.
  const database = new NodeSqlite.DatabaseSync(dbPath, { timeout: 30_000 });
  try {
    database.exec("BEGIN IMMEDIATE");
    for (const table of SEEDED_PROJECTION_TABLES) database.exec(`DELETE FROM ${table}`);

    const insertProject = database.prepare(
      `INSERT INTO projection_projects (
        project_id, title, workspace_root, default_model_selection_json, scripts_json,
        created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    );
    for (const [index, project] of HERO_PROJECTS.entries()) {
      const workspaceRoot = workspaceRoots.get(project.id);
      if (!workspaceRoot) throw new Error(`Missing workspace root for ${project.id}.`);
      const latest = Math.min(
        ...HERO_THREADS.filter((thread) => thread.projectId === project.id).map(
          (thread) => thread.minutesAgo,
        ),
      );
      insertProject.run(
        project.id,
        project.title,
        workspaceRoot,
        MODEL_SELECTION,
        PROJECT_SCRIPTS,
        minutesBefore(now, 60 * 24 * (120 - index * 14)),
        minutesBefore(now, latest),
      );
    }

    for (const thread of HERO_THREADS) {
      const workspaceRoot = workspaceRoots.get(thread.projectId);
      if (!workspaceRoot) throw new Error(`Missing workspace root for ${thread.projectId}.`);
      insertThread(database, now, {
        ...thread,
        ...("state" in thread ? { state: thread.state } : {}),
        workspaceRoot,
      });
    }

    const insertMessage = database.prepare(
      `INSERT INTO projection_thread_messages (
        message_id, thread_id, turn_id, role, text, is_streaming, attachments_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?)`,
    );
    for (const thread of HERO_THREADS) {
      const turnId = `${thread.id}-turn`;
      const requestAt = minutesBefore(now, thread.minutesAgo + 5);
      insertMessage.run(
        `${thread.id}-request`,
        thread.id,
        turnId,
        "user",
        thread.request,
        requestAt,
        requestAt,
      );
      if (thread.response !== null) {
        const responseAt = minutesBefore(now, thread.minutesAgo);
        insertMessage.run(
          `${thread.id}-answer`,
          thread.id,
          turnId,
          "assistant",
          thread.response,
          responseAt,
          responseAt,
        );
      }
    }

    const heroTurnId = `${HERO_THREAD_ID}-turn`;
    const insertActivity = database.prepare(
      `INSERT INTO projection_thread_activities (
        activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
      ) VALUES (?, ?, ?, 'tool', 'tool.completed', ?, ?, ?, ?)`,
    );
    const activities = [
      {
        id: "profile-transcript",
        summary: "Profiled the transcript while streaming",
        itemType: "command_execution",
        detail: "4,000-token reply · 38fps before · 120fps after",
        minutes: 7,
      },
      {
        id: "batch-tokens",
        summary: "Batched streamed tokens per frame",
        itemType: "file_change",
        detail: "3 files changed · +31 −17",
        minutes: 5,
      },
      {
        id: "run-suite",
        summary: "Ran the changed workspace",
        itemType: "command_execution",
        detail: "218 tests passed · 0 failed",
        minutes: 3,
      },
    ] as const;
    for (const [index, activity] of activities.entries()) {
      insertActivity.run(
        activity.id,
        HERO_THREAD_ID,
        heroTurnId,
        activity.summary,
        JSON.stringify({
          itemType: activity.itemType,
          title: activity.summary,
          detail: activity.detail,
          status: "completed",
        }),
        index + 1,
        minutesBefore(now, activity.minutes),
      );
    }

    for (const [index, projector] of PROJECTOR_NAMES.entries()) {
      database
        .prepare(
          "INSERT INTO projection_state (projector, last_applied_sequence, updated_at) VALUES (?, ?, ?)",
        )
        .run(projector, index + 1, minutesBefore(now, 1));
    }
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Nothing to roll back.
    }
    throw error;
  } finally {
    database.close();
  }
}

export async function seedMarketingEnvironment(baseDir: string): Promise<string> {
  const now = Date.now();
  const workspaceBase = NodePath.join(baseDir, "workspace");
  const workspaceRoots = new Map(
    HERO_PROJECTS.map((p) => [p.id, NodePath.join(workspaceBase, p.directory)] as const),
  );
  for (const project of HERO_PROJECTS) {
    const workspaceRoot = workspaceRoots.get(project.id);
    if (!workspaceRoot) throw new Error(`Missing workspace root for ${project.id}.`);
    await seedWorkspace({
      workspaceRoot,
      title: project.title,
      repositoryUrl: project.repositoryUrl,
      favicon: project.favicon,
      // Spread rather than pass `undefined`: `branch` is an optional property,
      // and exactOptionalPropertyTypes rejects an explicit undefined for it.
      ...(project.id === HERO_PROJECT_ID ? { branch: "perf/stream-provider-output" } : {}),
    });
  }
  const dbPath = NodePath.join(baseDir, "userdata", "state.sqlite");
  await waitForSeedableSchema(dbPath);
  seedDatabase(dbPath, workspaceRoots, now);
  return dbPath;
}

const invokedDirectly = process.argv[1]?.endsWith("marketing-screenshot-environment.ts") ?? false;
if (invokedDirectly) {
  const baseDir = process.argv[2];
  if (!baseDir) {
    process.stderr.write("Usage: node scripts/marketing-screenshot-environment.ts <base-dir>\n");
    process.exit(1);
  }
  const dbPath = await seedMarketingEnvironment(NodePath.resolve(baseDir));
  process.stdout.write(`Seeded marketing fixture into ${dbPath}\n`);
}
