const assert = require("node:assert/strict");
const test = require("node:test");
const { shouldReleaseNightly } = require("./check-nightly-release.cjs");

const now = Date.parse("2026-09-05T12:00:00Z");
const hour = 60 * 60 * 1000;
const nightly = (hoursAgo, overrides = {}) => ({
  tag_name: "v1.0.1-nightly.20260905.123",
  draft: false,
  published_at: new Date(now - hoursAgo * hour).toISOString(),
  ...overrides,
});

function fixture({ releases = [nightly(7)], comparisonStatus = "ahead" } = {}) {
  const calls = [];
  return {
    calls,
    options: {
      context: { repo: { owner: "example", repo: "app" }, sha: "new" },
      core: { info() {} },
      github: {
        rest: {
          repos: {
            listReleases() {},
            async compareCommitsWithBasehead(params) {
              calls.push(params);
              return { data: { status: comparisonStatus } };
            },
          },
        },
        async paginate(_method, params) {
          calls.push(params);
          return releases;
        },
      },
    },
  };
}

test("releases the first nightly when no nightly is published", async () => {
  const { options } = fixture({
    releases: [nightly(0, { tag_name: "v1.0.0" }), nightly(0, { draft: true })],
  });
  assert.equal(await shouldReleaseNightly(options), true);
});

test("releases newer commits regardless of the last nightly's age", async () => {
  for (const age of [0, 1, 3, 6, 24]) {
    const { options } = fixture({ releases: [nightly(age)] });
    assert.equal(await shouldReleaseNightly(options), true);
  }
});

test("skips unchanged commits", async () => {
  const { options } = fixture({ comparisonStatus: "identical" });
  assert.equal(await shouldReleaseNightly(options), false);
});

test("uses publication time, not release order or the tagged commit date", async () => {
  const newest = "v1.0.1-nightly.20260905.999";
  const { options, calls } = fixture({
    releases: [
      nightly(10),
      nightly(1, { tag_name: newest }),
      nightly(20, { tag_name: "nightly-v0.9.0" }),
    ],
  });
  assert.equal(await shouldReleaseNightly(options), true);
  assert.equal(calls.at(-1).basehead, `${newest}...new`);
});

test("ignores stable releases and drafts when selecting the previous nightly", async () => {
  const { options } = fixture({
    releases: [nightly(0, { tag_name: "v1.0.0" }), nightly(0, { draft: true }), nightly(7)],
  });
  assert.equal(await shouldReleaseNightly(options), true);
});

test("compares against the published tag, including legacy nightly tags", async () => {
  const tag = "nightly-v0.9.0";
  const { options, calls } = fixture({ releases: [nightly(7, { tag_name: tag })] });
  assert.equal(await shouldReleaseNightly(options), true);
  assert.equal(calls.at(-1).basehead, `${tag}...new`);
});

test("fails instead of releasing when GitHub cannot supply release state", async () => {
  const { options } = fixture();
  options.github.paginate = async () => {
    throw new Error("GitHub unavailable");
  };
  await assert.rejects(shouldReleaseNightly(options), /GitHub unavailable/);
});

for (const status of ["behind", "diverged"]) {
  test(`skips a candidate commit that is ${status} relative to the last nightly`, async () => {
    const { options } = fixture({ comparisonStatus: status });
    assert.equal(await shouldReleaseNightly(options), false);
  });
}

const { resolveLatestNightlyCommit } = require("./check-nightly-release.cjs");

function nightlyCommitFixture({ releases, commitSha = "abc123" }) {
  const refs = [];
  const { options } = fixture({ releases });
  options.github.rest.repos.getCommit = async ({ ref }) => {
    refs.push(ref);
    return { data: { sha: commitSha } };
  };
  return { options, refs };
}

test("stable releases resolve the commit of the newest published nightly", async () => {
  const { options, refs } = nightlyCommitFixture({
    releases: [
      nightly(10, { tag_name: "v1.0.1-nightly.20260905.100" }),
      nightly(1, { tag_name: "v1.0.1-nightly.20260905.123" }),
      nightly(0, { tag_name: "v1.0.0" }),
      nightly(0, { draft: true, tag_name: "v1.0.1-nightly.20260905.999" }),
    ],
    commitSha: "deadbeef",
  });
  assert.deepEqual(await resolveLatestNightlyCommit(options), {
    tag: "v1.0.1-nightly.20260905.123",
    sha: "deadbeef",
    version: "1.0.1",
  });
  assert.deepEqual(refs, ["v1.0.1-nightly.20260905.123"]);
});

test("stable releases derive the version from legacy nightly tags", async () => {
  const { options } = nightlyCommitFixture({
    releases: [nightly(1, { tag_name: "nightly-v0.9.0-nightly.20260905.5" })],
  });
  assert.equal((await resolveLatestNightlyCommit(options)).version, "0.9.0");
});

test("stable releases fail without a published nightly", async () => {
  const { options } = nightlyCommitFixture({ releases: [nightly(0, { tag_name: "v1.0.0" })] });
  await assert.rejects(resolveLatestNightlyCommit(options), /No published nightly/);
});

test("reads public release metadata but resolves commits only in the source repository", async () => {
  const { options } = nightlyCommitFixture({ releases: [nightly(1)] });
  const calls = [];
  options.releaseRepository = { owner: "pylon-code", repo: "pylon-releases" };
  options.github.paginate = async (_method, params) => {
    calls.push(params);
    return [nightly(1)];
  };
  options.github.rest.repos.getCommit = async (params) => {
    calls.push(params);
    return { data: { sha: "source-commit" } };
  };
  const resolved = await resolveLatestNightlyCommit(options);
  assert.equal(resolved.sha, "source-commit");
  assert.deepEqual(calls, [
    { ...options.releaseRepository, per_page: 100 },
    { ...options.context.repo, ref: nightly(1).tag_name },
  ]);
});

test("compares a cross-repository nightly using its mirrored source tag", async () => {
  const { options, calls } = fixture();
  options.releaseRepository = { owner: "pylon-code", repo: "pylon-releases" };
  assert.equal(await shouldReleaseNightly(options), true);
  assert.deepEqual(calls, [
    { ...options.releaseRepository, per_page: 100 },
    { ...options.context.repo, basehead: `${nightly(7).tag_name}...new`, per_page: 1 },
  ]);
});

test("does not fall back to an unverified commit when the mirrored source tag is missing", async () => {
  const { options } = nightlyCommitFixture({ releases: [nightly(1)] });
  options.github.rest.repos.getCommit = async () => {
    throw new Error("Missing source tag");
  };
  await assert.rejects(resolveLatestNightlyCommit(options), /Missing source tag/);
});

test("rejects nightly versions that cannot supply a stable version", async () => {
  const { options } = nightlyCommitFixture({
    releases: [nightly(1, { tag_name: "nightly-vinvalid" })],
  });
  await assert.rejects(resolveLatestNightlyCommit(options), /Cannot derive a stable version/);
});
