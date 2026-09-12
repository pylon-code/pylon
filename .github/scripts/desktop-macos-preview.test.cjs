const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createHash } = require("node:crypto");
const { prepare, reconcile, read, loadDmg } = require("./desktop-macos-preview.cjs");

const SHA = "a".repeat(40);
const NAME = "Pylon-0.0.32-pr.42.10.1-arm64.dmg";
const PREVIOUS = "Pylon-0.0.32-pr.42.9-arm64.dmg";
const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

async function trustedLoaderFixture(t, job) {
  const workflow = await fs.readFile(
    path.join(__dirname, "../workflows/desktop-macos-preview-publish.yml"),
    "utf8",
  );
  const section = workflow.split(`\n  ${job}:\n`)[1].split(/\n  \w+:\n/)[0];
  const script = section.match(/          script: \|\n((?:            .*\n?)*)/)[1];
  const run = new (Object.getPrototypeOf(async function () {}).constructor)(
    "github",
    "context",
    "core",
    "require",
    "process",
    script.replace(/^            /gm, ""),
  );
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pylon-preview-loader-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = Buffer.from(
    "module.exports = { prepare: async ({ core }) => core.info('prepare'), " +
      "reconcile: async ({ core, prNumber }) => core.info(`reconcile:${prNumber}`) };\n",
  );
  const data = {
    type: "file",
    path: ".github/scripts/desktop-macos-preview.cjs",
    encoding: "base64",
    content:
      source
        .toString("base64")
        .match(/.{1,60}/g)
        .join("\n") + "\n",
    size: source.length,
    sha: createHash("sha1").update(`blob ${source.length}\0`).update(source).digest("hex"),
  };
  const requests = [];
  const messages = [];
  const env = { RUNNER_TEMP: directory, PREVIEW_HELPER_REF: SHA, PREVIEW_PR: "42" };
  const github = {
    rest: {
      repos: {
        getContent: async (request) => {
          requests.push(request);
          return { data };
        },
      },
    },
  };
  return {
    data,
    env,
    requests,
    messages,
    directory,
    github,
    run: () =>
      run(
        github,
        { repo: { owner: "pylon-code", repo: "pylon" }, sha: "b".repeat(40) },
        { info: (message) => messages.push(message) },
        require,
        { env },
      ),
  };
}

for (const job of ["prepare", "publish"]) {
  test(`${job} loads only the verified helper at the trusted workflow commit`, async (t) => {
    const f = await trustedLoaderFixture(t, job);
    await f.run();
    assert.deepEqual(f.requests, [
      {
        owner: "pylon-code",
        repo: "pylon",
        path: ".github/scripts/desktop-macos-preview.cjs",
        ref: SHA,
      },
    ]);
    assert.deepEqual(f.messages, [job === "prepare" ? "prepare" : "reconcile:42"]);
    const [helperDirectory] = await fs.readdir(f.directory);
    const filename = path.join(f.directory, helperDirectory, "desktop-macos-preview.cjs");
    assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
  });

  for (const [name, mutate] of [
    ["wrong path", (d) => (d.path = "another/helper.cjs")],
    ["non-file", (d) => (d.type = "dir")],
    ["wrong encoding", (d) => (d.encoding = "none")],
    ["missing contents", (d) => delete d.content],
    ["oversized content", (d) => (d.size = 1024 * 1024 + 1)],
    ["size mismatch", (d) => d.size++],
    ["invalid base64", (d) => (d.content += "!")],
    ["changed contents", (d) => (d.content = Buffer.from("throw 'untrusted';").toString("base64"))],
    ["wrong Git blob digest", (d) => (d.sha = "0".repeat(40))],
  ]) {
    test(`${job} rejects ${name} before writing or executing helper code`, async (t) => {
      const f = await trustedLoaderFixture(t, job);
      mutate(f.data);
      await assert.rejects(f.run, /preview helper/);
      assert.deepEqual(f.messages, []);
      assert.deepEqual(await fs.readdir(f.directory), []);
    });
  }

  test(`${job} rejects mutable refs and API errors without a fallback`, async (t) => {
    const f = await trustedLoaderFixture(t, job);
    f.env.PREVIEW_HELPER_REF = "pylon";
    await assert.rejects(f.run, /immutable workflow commit/);
    assert.deepEqual(f.requests, []);
    f.env.PREVIEW_HELPER_REF = SHA;
    f.github.rest.repos.getContent = async () => {
      throw httpError(503);
    };
    await assert.rejects(f.run, /HTTP 503/);
    assert.deepEqual(f.messages, []);
    assert.deepEqual(await fs.readdir(f.directory), []);
  });
}

function fixture() {
  const calls = [];
  const outputs = {};
  const context = {
    repo: { owner: "pylon-code", repo: "pylon" },
    sha: "b".repeat(40),
    eventName: "workflow_run",
    payload: { workflow_run: { id: 100, run_attempt: 1 } },
  };
  const state = {
    repo: { private: false, default_branch: "pylon" },
    run: {
      id: 100,
      path: ".github/workflows/desktop-macos-preview.yml",
      event: "pull_request",
      head_repository: { full_name: "pylon-code/pylon" },
      head_sha: SHA,
      status: "completed",
      conclusion: "success",
      run_number: 10,
      run_attempt: 1,
      pull_requests: [{ number: 42 }],
    },
    pr: {
      state: "open",
      head: { sha: SHA, repo: { full_name: "pylon-code/pylon" } },
      base: { ref: "pylon", repo: { full_name: "pylon-code/pylon" } },
      labels: [{ name: "preview:mac" }],
    },
    release: { id: 1, tag_name: "desktop-preview", draft: false, prerelease: true },
    assets: [
      { id: 1, name: PREVIOUS, state: "uploaded" },
      { id: 2, name: "Pylon-0.0.32-pr.420.10.1-arm64.dmg", state: "uploaded" },
      { id: 3, name: "latest-mac.yml", state: "uploaded" },
    ],
    artifacts: [{ id: 4, name: "pylon-macos-preview-42-10-1", size_in_bytes: 123, expired: false }],
    jobs: [{ name: "Build macOS Apple Silicon preview", conclusion: "success" }],
    comments: [],
  };
  const endpoint = (name, fn) => async (params) => {
    calls.push({ name, params });
    if (state.errors?.[name]) throw state.errors[name];
    return { data: await fn(params) };
  };
  const github = {
    rest: {
      repos: {
        get: endpoint("repo", () => state.repo),
        getReleaseByTag: endpoint("release", () => {
          if (!state.release) throw httpError(404);
          return state.release;
        }),
        createRelease: endpoint("create", (params) => {
          state.release = { id: 1, ...params };
          return state.release;
        }),
        listReleaseAssets: endpoint("assets", () => state.assets.slice()),
        uploadReleaseAsset: endpoint("upload", (params) => {
          const asset = { id: 10, ...params, size: params.data.length, state: "uploaded" };
          state.assets.push(asset);
          state.afterUpload?.();
          return asset;
        }),
        deleteReleaseAsset: endpoint("delete", ({ asset_id }) => {
          state.assets = state.assets.filter((asset) => asset.id !== asset_id);
        }),
      },
      pulls: { get: endpoint("pr", () => state.pr) },
      actions: {
        getWorkflowRun: endpoint("run", () => state.run),
        listJobsForWorkflowRun: endpoint("jobs", () => state.jobs),
        listWorkflowRunArtifacts: endpoint("artifacts", () => state.artifacts),
      },
      issues: {
        listComments: endpoint("comments", () => state.comments),
        createComment: endpoint("comment-create", (params) => params),
        updateComment: endpoint("comment-update", (params) => params),
      },
    },
    paginate: async (method, params) => (await method(params)).data,
  };
  const args = {
    github,
    context,
    prNumber: 42,
    core: { setOutput: (key, value) => (outputs[key] = value), info() {} },
    sleep: async () => {},
  };
  return { args, state, calls, outputs };
}

async function withDmg(t, f, name = NAME) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pylon-preview-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, name), "opaque DMG fixture");
  f.args.directory = directory;
}

function cleanupEvent(f, action = "unlabeled") {
  f.args.context.eventName = "pull_request_target";
  f.args.context.payload = { action, label: { name: "preview:mac" }, pull_request: { number: 42 } };
}

test("selects one artifact using GitHub run/PR association, not file-supplied metadata", async () => {
  const f = fixture();
  await prepare(f.args);
  assert.deepEqual(f.outputs, { mode: "publish", pr: 42, artifact_id: 4 });
  assert.equal(f.calls.find((call) => call.name === "artifacts").params.run_id, 100);
});

for (const [name, change] of [
  ["another workflow", (s) => (s.run.path = ".github/workflows/ci.yml")],
  ["fork run", (s) => (s.run.head_repository.full_name = "someone/pylon")],
  ["failed run", (s) => (s.run.conclusion = "failure")],
  ["rerun now in progress", (s) => (s.run.status = "in_progress")],
  ["superseded run attempt", (s) => (s.run.run_attempt = 2)],
  ["non-PR event", (s) => (s.run.event = "push")],
  ["old PR head", (s) => (s.pr.head.sha = "c".repeat(40))],
  ["skipped build on an unrelated label", (s) => (s.jobs[0].conclusion = "skipped")],
]) {
  test(`skips ${name} without downloading or mutating`, async () => {
    const f = fixture();
    change(f.state);
    await prepare(f.args);
    assert.equal(f.outputs.mode, "skip");
    assert(!f.calls.some((call) => call.name === "artifacts"));
    await reconcile(f.args);
    assert(!f.calls.some((call) => ["create", "upload", "delete"].includes(call.name)));
  });
}

for (const association of [[], [{ number: 42 }, { number: 43 }], [{ number: "42" }]]) {
  test(`rejects ambiguous/invalid PR association ${JSON.stringify(association)}`, async () => {
    const f = fixture();
    f.state.run.pull_requests = association;
    await assert.rejects(prepare(f.args), /association/);
    assert(!f.calls.some((call) => call.name === "artifacts"));
  });
}

for (const change of [(s) => (s.repo.private = true), (s) => (s.repo.default_branch = "main")]) {
  test("fails closed when the repository cannot host Pylon's anonymous previews", async () => {
    const f = fixture();
    change(f.state);
    await assert.rejects(prepare(f.args), /public Pylon/);
  });
}

for (const change of [
  (s) => (s.artifacts = []),
  (s) => s.artifacts.push({ ...s.artifacts[0], id: 5 }),
  (s) => (s.artifacts[0].expired = true),
  (s) => (s.artifacts[0].size_in_bytes = 1024 ** 3 + 1),
  (s) => (s.artifacts[0].name = "pylon-macos-preview-43-10-1"),
]) {
  test("rejects missing, ambiguous, expired, oversized or cross-PR artifacts", async () => {
    const f = fixture();
    change(f.state);
    await assert.rejects(prepare(f.args), /one unexpired/);
    assert.equal(f.outputs.artifact_id, undefined);
  });
}

test("uploads first, prunes only this PR, and posts an anonymous checksum link", async (t) => {
  const f = fixture();
  await withDmg(t, f);
  await reconcile(f.args);
  assert(
    f.calls.findIndex((c) => c.name === "upload") < f.calls.findIndex((c) => c.name === "delete"),
  );
  assert.deepEqual(
    f.state.assets.map((a) => a.id),
    [2, 3, 10],
  );
  const comment = f.calls.find((c) => c.name === "comment-create").params.body;
  assert(comment.includes(`/releases/download/desktop-preview/${NAME}`));
  assert(comment.includes(SHA));
  assert.match(comment, /SHA-256: `[a-f0-9]{64}`/);
  assert(!comment.includes("https://example.com"));
});

test("creates only an explicitly non-latest prerelease on a trusted base commit", async (t) => {
  const f = fixture();
  f.state.release = undefined;
  await withDmg(t, f);
  await reconcile(f.args);
  const created = f.calls.find((c) => c.name === "create").params;
  assert.equal(created.prerelease, true);
  assert.equal(created.draft, false);
  assert.equal(created.make_latest, "false");
  assert.equal(created.target_commitish, f.args.context.sha);
  assert.equal(created.tag_name, "desktop-preview");
});

test("does not overwrite a draft or stable release with the preview tag", async (t) => {
  const f = fixture();
  f.state.release.prerelease = false;
  await withDmg(t, f);
  await assert.rejects(reconcile(f.args), /public prerelease/);
  assert(!f.calls.some((c) => c.name === "upload"));
});

test("a concurrent initial release creation accepts only a confirmed matching prerelease", async (t) => {
  const f = fixture();
  f.state.release = undefined;
  await withDmg(t, f);
  f.args.github.rest.repos.createRelease = async () => {
    f.state.release = { id: 1, tag_name: "desktop-preview", draft: false, prerelease: true };
    throw httpError(422);
  };
  await reconcile(f.args);
  assert(f.calls.some((c) => c.name === "upload"));
});

test("a 422 without a confirmed release, or a different create failure, is not swallowed", async (t) => {
  const f = fixture();
  f.state.release = undefined;
  await withDmg(t, f);
  for (const status of [422, 403, 503]) {
    f.state.errors = { create: httpError(status) };
    await assert.rejects(reconcile(f.args), new RegExp(String(status)));
  }
  assert(!f.calls.some((c) => c.name === "upload"));
});

test("an older completed build never replaces an already published newer run", async (t) => {
  const f = fixture();
  f.state.assets.push({ id: 11, name: "Pylon-0.0.32-pr.42.11.1-arm64.dmg", state: "uploaded" });
  await withDmg(t, f);
  await reconcile(f.args);
  assert(!f.calls.some((c) => ["upload", "delete", "comment-create"].includes(c.name)));
});

test("a failed upload leaves the previous working link intact", async (t) => {
  const f = fixture();
  f.state.errors = { upload: httpError(502) };
  await withDmg(t, f);
  await assert.rejects(reconcile(f.args), /502/);
  assert(!f.calls.some((c) => ["delete", "comment-create"].includes(c.name)));
});

test("an API failure after upload preserves both assets and never claims success", async (t) => {
  const f = fixture();
  f.state.afterUpload = () => (f.state.errors = { pr: httpError(503) });
  await withDmg(t, f);
  await assert.rejects(reconcile(f.args), /503/);
  assert(f.state.assets.some((a) => a.name === PREVIOUS));
  assert(f.state.assets.some((a) => a.name === NAME));
  assert(!f.calls.some((c) => c.name === "comment-create"));
});

test("closing or opting out during upload cleans both this PR's versions", async (t) => {
  const f = fixture();
  f.state.afterUpload = () => (f.state.pr.labels = []);
  await withDmg(t, f);
  await reconcile(f.args);
  assert.deepEqual(
    f.state.assets.map((a) => a.id),
    [2, 3],
  );
  assert(!f.calls.some((c) => c.name === "comment-create"));
});

test("head changes during upload remove only the stale new asset", async (t) => {
  const f = fixture();
  f.state.afterUpload = () => (f.state.pr.head.sha = "d".repeat(40));
  await withDmg(t, f);
  await reconcile(f.args);
  assert.deepEqual(
    f.state.assets.map((a) => a.id),
    [1, 2, 3],
  );
  assert(!f.calls.some((c) => c.name === "comment-create"));
});

test("retrying a completed upload reuses identical bytes and provenance", async (t) => {
  const f = fixture();
  await withDmg(t, f);
  await reconcile(f.args);
  await reconcile(f.args);
  assert.equal(f.calls.filter((c) => c.name === "upload").length, 1);
  f.state.assets.find((a) => a.name === NAME).label = "mismatched content";
  await assert.rejects(reconcile(f.args), /different content/);
});

test("updates only the bot's own marker comment, using paginated comments", async (t) => {
  const f = fixture();
  await withDmg(t, f);
  f.state.comments = [
    { id: 1, body: "<!-- desktop-macos-preview -->", user: { login: "human", type: "User" } },
    {
      id: 2,
      body: "<!-- desktop-macos-preview -->",
      user: { login: "github-actions[bot]", type: "Bot" },
    },
  ];
  await reconcile(f.args);
  assert.equal(f.calls.find((c) => c.name === "comment-update").params.comment_id, 2);
  assert(!f.calls.some((c) => c.name === "comment-create"));
});

for (const action of ["closed", "unlabeled"]) {
  test(`${action} cleanup rechecks state, including a later re-opt-in`, async () => {
    const f = fixture();
    cleanupEvent(f, action);
    await reconcile(f.args); // An old cleanup event cannot remove a current opt-in.
    assert(!f.calls.some((c) => c.name === "delete"));
    f.state.pr.labels = [];
    f.state.pr.state = "closed";
    f.state.pr.head.repo = null;
    await reconcile(f.args);
    assert.deepEqual(
      f.state.assets.map((a) => a.id),
      [2, 3],
    );
    assert(!f.calls.some((c) => ["create", "upload", "comment-create"].includes(c.name)));
  });
}

test("cleanup accepts a missing release but fails on API errors or unsuccessful deletes", async () => {
  const f = fixture();
  cleanupEvent(f);
  f.state.pr.labels = [];
  f.state.release = undefined;
  await reconcile(f.args);
  f.state.errors = { release: httpError(503) };
  await assert.rejects(reconcile(f.args), /503/);
  f.state.release = { id: 1, tag_name: "desktop-preview", prerelease: true, draft: false };
  f.state.errors = { delete: httpError(403) };
  await assert.rejects(reconcile(f.args), /403/);
  assert(!f.calls.some((c) => c.name === "comment-update"));
});

test("unknown PR state never triggers cleanup or a removed comment", async () => {
  const f = fixture();
  cleanupEvent(f);
  f.state.pr.labels = [];
  f.state.errors = { pr: httpError(503) };
  await assert.rejects(reconcile(f.args), /503/);
  assert.deepEqual(
    f.state.assets.map((a) => a.id),
    [1, 2, 3],
  );
  assert(!f.calls.some((c) => ["delete", "comments", "create", "upload"].includes(c.name)));
});

test("only transient reads retry, and exhaustion remains an error", async () => {
  let attempts = 0;
  const result = await read(
    async () => {
      if (++attempts < 3) throw httpError(503);
      return "known state";
    },
    async () => {},
  );
  assert.equal(result, "known state");
  assert.equal(attempts, 3);
  attempts = 0;
  await assert.rejects(
    read(
      async () => {
        attempts++;
        throw httpError(403);
      },
      async () => {},
    ),
    /403/,
  );
  assert.equal(attempts, 1);
});

for (const name of [
  "Pylon-0.0.32-pr.420.10.1-arm64.dmg",
  "Pylon-0.0.32-pr.42.9.1-arm64.dmg",
  "Pylon-0.0.32-pr.42.10.2-arm64.dmg",
  "T3-Code-0.0.32-pr.42.10.1-arm64.dmg",
  "Pylon-0.0.32-pr.42.10.1-arm64.dmg\nmalicious",
  "Pylon-0.0.32-pr.42.10.1-arm64.dmg\n",
  "Pylon-0.0.32-pr.42.10.1-$(id).dmg",
  "Pylon-0.0.32-pr.42.10.1-arm64.dmg[link]",
  "latest-mac.yml",
]) {
  test(`rejects an invalid or mismatched filename ${JSON.stringify(name)}`, async (t) => {
    const f = fixture();
    await withDmg(t, f, name);
    await assert.rejects(loadDmg(f.args.directory, { prNumber: 42, run: f.state.run }), /exact PR/);
  });
}

test("rejects extra files and symlink payloads without following them", async (t) => {
  const f = fixture();
  await withDmg(t, f);
  const plan = { prNumber: 42, run: f.state.run };
  await fs.writeFile(path.join(f.args.directory, "extra"), "extra");
  await assert.rejects(loadDmg(f.args.directory, plan), /exact PR/);
  await fs.unlink(path.join(f.args.directory, "extra"));
  await fs.unlink(path.join(f.args.directory, NAME));
  await fs.symlink(__filename, path.join(f.args.directory, NAME));
  await assert.rejects(loadDmg(f.args.directory, plan), /regular DMG/);
});
