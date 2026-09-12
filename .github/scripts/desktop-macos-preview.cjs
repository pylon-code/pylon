const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");

const TAG = "desktop-preview";
const LABEL = "preview:mac";
const MARKER = "<!-- desktop-macos-preview -->";
const MAX_BYTES = 1024 * 1024 * 1024;
// Includes #111's filenames, so removing the label also cleans earlier previews.
const DMG = /^Pylon-\d+\.\d+\.\d+-pr\.(\d+)\.(\d+)(?:\.(\d+))?-arm64\.dmg$/;

function parseName(name) {
  const match = DMG.exec(name);
  // JavaScript's $ also matches before a final newline; require the whole name.
  return match?.[0] === name ? match : undefined;
}

// Retry observations, never infer eligibility/absence from an unavailable API.
// Mutations fail visibly; a rerun reconciles partial publication idempotently.
async function read(request, sleep = delay) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await request();
    } catch (error) {
      if (attempt === 2 || (error.status && error.status !== 429 && error.status < 500)) {
        throw error;
      }
      await sleep(1000 * 2 ** attempt);
    }
  }
}

function eligible(pr, repository) {
  return (
    pr.state === "open" &&
    pr.head.repo?.full_name === repository &&
    pr.base.repo.full_name === repository &&
    pr.base.ref === "pylon" &&
    pr.labels.some((label) => label.name === LABEL)
  );
}

function ownedAsset(asset, prNumber) {
  return Number(parseName(asset.name)?.[1]) === prNumber;
}

function apiFor(github, context, sleep) {
  const repository = context.repo;
  const observe = (fn) => read(fn, sleep);
  return {
    observe,
    async pr(prNumber) {
      return (await observe(() => github.rest.pulls.get({ ...repository, pull_number: prNumber })))
        .data;
    },
    async release() {
      try {
        const { data } = await observe(() =>
          github.rest.repos.getReleaseByTag({ ...repository, tag: TAG }),
        );
        if (data.draft || !data.prerelease || data.tag_name !== TAG) {
          throw new Error("desktop-preview must be a public prerelease; refusing to modify it.");
        }
        return data;
      } catch (error) {
        if (error.status === 404) return undefined;
        throw error;
      }
    },
    assets(release) {
      return observe(() =>
        github.paginate(github.rest.repos.listReleaseAssets, {
          ...repository,
          release_id: release.id,
          per_page: 100,
        }),
      );
    },
    async remove(asset) {
      try {
        await github.rest.repos.deleteReleaseAsset({ ...repository, asset_id: asset.id });
      } catch (error) {
        if (error.status !== 404) throw error;
      }
    },
    async comment(prNumber, lines, create = true) {
      const comments = await observe(() =>
        github.paginate(github.rest.issues.listComments, {
          ...repository,
          issue_number: prNumber,
          per_page: 100,
        }),
      );
      const existing = comments.find(
        (comment) =>
          comment.user?.login === "github-actions[bot]" &&
          comment.user.type === "Bot" &&
          comment.body?.startsWith(MARKER),
      );
      const body = [MARKER, "### macOS preview", "", ...lines].join("\n");
      if (existing) {
        await github.rest.issues.updateComment({
          ...repository,
          comment_id: existing.id,
          body,
        });
      } else if (create) {
        await github.rest.issues.createComment({ ...repository, issue_number: prNumber, body });
      }
    },
  };
}

async function inspect({ github, context, sleep }) {
  const api = apiFor(github, context, sleep);
  const repository = `${context.repo.owner}/${context.repo.repo}`;
  const { data: repo } = await api.observe(() => github.rest.repos.get(context.repo));
  if (repository !== "pylon-code/pylon" || repo.private || repo.default_branch !== "pylon") {
    throw new Error(
      "Public previews require the public Pylon source repository and pylon default.",
    );
  }

  let prNumber;
  let run;
  if (context.eventName === "workflow_run") {
    ({ data: run } = await api.observe(() =>
      github.rest.actions.getWorkflowRun({
        ...context.repo,
        run_id: context.payload.workflow_run.id,
      }),
    ));
    // Association and provenance come from GitHub, never a PR-supplied artifact.
    if (
      run.event !== "pull_request" ||
      run.path !== ".github/workflows/desktop-macos-preview.yml" ||
      run.head_repository?.full_name !== repository ||
      run.status !== "completed" ||
      run.conclusion !== "success" ||
      run.run_attempt !== context.payload.workflow_run.run_attempt
    ) {
      return { mode: "skip" };
    }
    if (run.pull_requests.length !== 1) {
      throw new Error("Expected exactly one GitHub PR association for the preview build.");
    }
    prNumber = run.pull_requests[0].number;
  } else if (
    context.eventName === "pull_request_target" &&
    (context.payload.action === "closed" ||
      (context.payload.action === "unlabeled" && context.payload.label.name === LABEL))
  ) {
    prNumber = context.payload.pull_request.number;
  } else {
    throw new Error("Unsupported preview event.");
  }
  if (!Number.isSafeInteger(prNumber) || prNumber < 1) throw new Error("Invalid PR association.");
  const pr = await api.pr(prNumber);
  // Closed PRs may have a deleted head repository; cleanup still owns only the
  // matching Pylon filename namespace and never creates a release or a comment.
  if (!eligible(pr, repository)) return { mode: "cleanup", prNumber };
  if (!run || pr.head.sha !== run.head_sha) return { mode: "skip", prNumber };
  const jobs = await api.observe(() =>
    github.paginate(github.rest.actions.listJobsForWorkflowRun, {
      ...context.repo,
      run_id: run.id,
      filter: "latest",
      per_page: 100,
    }),
  );
  // An unrelated labeled event skips the build but can still complete the
  // workflow successfully. It must not start a missing-artifact publication.
  if (
    !jobs.some(
      (job) => job.name === "Build macOS Apple Silicon preview" && job.conclusion === "success",
    )
  ) {
    return { mode: "skip", prNumber };
  }
  return { mode: "publish", prNumber, run };
}

async function prepare({ github, context, core, sleep }) {
  const plan = await inspect({ github, context, sleep });
  core.setOutput("mode", plan.mode);
  if (plan.prNumber) core.setOutput("pr", plan.prNumber);
  if (plan.mode !== "publish") return;
  const api = apiFor(github, context, sleep);
  const artifacts = await api.observe(() =>
    github.paginate(github.rest.actions.listWorkflowRunArtifacts, {
      ...context.repo,
      run_id: plan.run.id,
      per_page: 100,
    }),
  );
  const expectedName = `pylon-macos-preview-${plan.prNumber}-${plan.run.run_number}-${plan.run.run_attempt}`;
  const matches = artifacts.filter((artifact) => artifact.name === expectedName);
  if (matches.length !== 1 || matches[0].expired || matches[0].size_in_bytes > MAX_BYTES) {
    throw new Error("Expected one unexpired, size-limited artifact from this build attempt.");
  }
  core.setOutput("artifact_id", matches[0].id);
}

async function loadDmg(directory, plan) {
  const entries = await fs.readdir(directory);
  const name = entries[0];
  const match = entries.length === 1 && parseName(name);
  if (
    !match ||
    Number(match[1]) !== plan.prNumber ||
    Number(match[2]) !== plan.run.run_number ||
    Number(match[3]) !== plan.run.run_attempt
  ) {
    throw new Error("Expected one Pylon ARM64 DMG for this exact PR, run and attempt.");
  }
  const file = path.join(directory, name);
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_BYTES) {
    throw new Error("Preview must be a nonempty regular DMG file of at most 1 GiB.");
  }
  const data = await fs.readFile(file);
  const digest = createHash("sha256").update(data).digest("hex");
  return { name, data, digest };
}

async function reconcile({ github, context, core, prNumber, directory, sleep }) {
  const plan = await inspect({ github, context, sleep });
  if (plan.mode === "skip") return;
  if (plan.prNumber !== prNumber)
    throw new Error("PR association changed after acquiring the lock.");
  const api = apiFor(github, context, sleep);
  let release = await api.release();
  const cleanup = async () => {
    if (release) {
      for (const asset of await api.assets(release)) {
        if (ownedAsset(asset, prNumber)) await api.remove(asset);
      }
    }
    await api.comment(
      prNumber,
      ["Preview removed: the PR is closed or no longer opted in."],
      false,
    );
  };
  if (plan.mode === "cleanup") return cleanup();

  const { name, data, digest } = await loadDmg(directory, plan);
  if (!release) {
    try {
      ({ data: release } = await github.rest.repos.createRelease({
        ...context.repo,
        tag_name: TAG,
        target_commitish: context.sha,
        name: "Pylon macOS PR previews (unsigned)",
        body: [
          "Temporary, unsigned Apple Silicon DMGs from maintainer-opted-in Pylon PRs.",
          "Use the PR's bot comment for the exact commit, checksum and installation instructions.",
          "Assets are removed when the PR closes or loses preview:mac, and replaced by newer builds.",
          "The rolling tag is not a build commit or an update feed.",
          "For supported releases: https://github.com/pylon-code/pylon-releases/releases",
        ].join("\n\n"),
        prerelease: true,
        draft: false,
        make_latest: "false",
      }));
    } catch (error) {
      // Different PRs can race to create the first rolling release. Only accept
      // a confirmed, correctly configured release after GitHub reports 422.
      if (error.status !== 422) throw error;
      release = await api.release();
      if (!release) throw error;
    }
  }
  const assets = await api.assets(release);
  if (
    assets.some((asset) => {
      const match = ownedAsset(asset, prNumber) && parseName(asset.name);
      return match && asset.state === "uploaded" && Number(match[2]) > plan.run.run_number;
    })
  ) {
    core.info("A newer preview was already published for this PR.");
    return;
  }
  const assetLabel = `${plan.run.head_sha} sha256:${digest}`;
  let uploaded = assets.find((asset) => asset.name === name);
  if (uploaded?.state === "starter") {
    await api.remove(uploaded);
    uploaded = undefined;
  }
  if (uploaded && (uploaded.label !== assetLabel || uploaded.size !== data.length)) {
    throw new Error("Existing preview filename has different content; refusing to overwrite it.");
  }
  if (!uploaded) {
    ({ data: uploaded } = await github.rest.repos.uploadReleaseAsset({
      ...context.repo,
      release_id: release.id,
      name,
      label: assetLabel,
      data,
      headers: { "content-type": "application/x-apple-diskimage", "content-length": data.length },
    }));
  }
  // Upload before pruning. An API failure leaves the previous working download
  // intact and fails visibly; a later cleanup/retry reconciles both versions.
  const current = await api.pr(prNumber);
  if (!eligible(current, `${context.repo.owner}/${context.repo.repo}`)) return cleanup();
  if (current.head.sha !== plan.run.head_sha) {
    await api.remove(uploaded);
    core.info("PR head changed while uploading; removed only this stale build.");
    return;
  }
  for (const asset of await api.assets(release)) {
    if (ownedAsset(asset, prNumber) && asset.id !== uploaded.id) await api.remove(asset);
  }
  const url = `https://github.com/pylon-code/pylon/releases/download/${TAG}/${name}`;
  await api.comment(prNumber, [
    `[Download Apple Silicon DMG](${url}) — no GitHub sign-in required.`,
    "",
    `Commit: ${plan.run.head_sha}`,
    `Build: https://github.com/pylon-code/pylon/actions/runs/${plan.run.id}`,
    `SHA-256: \`${digest}\``,
    "",
    "Unsigned preview. After verifying the checksum, clear quarantine before opening:",
    "```sh",
    `shasum -a 256 ~/Downloads/${name}`,
    `xattr -d com.apple.quarantine ~/Downloads/${name}`,
    "```",
    "",
    "This uses Pylon (Alpha)'s app identity and data profile. Quit Alpha before installing; " +
      "back up its data before testing. Automatic updates are disabled for previews.",
    "This link is replaced by newer builds and removed when the PR closes or loses preview:mac.",
  ]);
}

module.exports = { prepare, reconcile, read, loadDmg };
