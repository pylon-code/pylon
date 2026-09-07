const isNightlyTag = (tag) => /^v.*-nightly\./.test(tag) || tag.startsWith("nightly-v");

// Newest published nightly by publication time, or undefined when none exists.
async function findLatestNightly({ github, context, releaseRepository = context.repo }) {
  const releases = await github.paginate(github.rest.repos.listReleases, {
    ...releaseRepository,
    per_page: 100,
  });
  return releases
    .filter((release) => !release.draft && release.published_at && isNightlyTag(release.tag_name))
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0];
}

// Runs after the workflow acquires the nightly concurrency lock.
async function shouldReleaseNightly({ github, context, core, releaseRepository = context.repo }) {
  const lastNightly = await findLatestNightly({ github, context, releaseRepository });

  if (!lastNightly) {
    core.info("No published nightly found. Proceeding with release.");
    return true;
  }

  const { data: comparison } = await github.rest.repos.compareCommitsWithBasehead({
    ...context.repo,
    basehead: `${lastNightly.tag_name}...${context.sha}`,
    per_page: 1,
  });
  if (comparison.status !== "ahead") {
    core.info(
      `Candidate commit is ${comparison.status} relative to ${lastNightly.tag_name}. Skipping.`,
    );
    return false;
  }

  core.info(`New commits since ${lastNightly.tag_name}.`);
  return true;
}

// Stable releases build the commit the latest nightly shipped, so the stable
// build is one nightly users already ran. Returns the nightly tag, its commit,
// and the stable version that nightly was a preview of.
async function resolveLatestNightlyCommit({
  github,
  context,
  core,
  releaseRepository = context.repo,
}) {
  const lastNightly = await findLatestNightly({ github, context, releaseRepository });
  if (!lastNightly) {
    throw new Error("No published nightly found. Stable releases build the latest nightly commit.");
  }

  const tag = lastNightly.tag_name;
  // Pylon mirrors release tags into the source repository. The public asset
  // repository may have unrelated commits; resolve only against source history.
  // repos.getCommit also dereferences annotated tags.
  const { data: commit } = await github.rest.repos.getCommit({ ...context.repo, ref: tag });
  const version = /^(?:nightly-)?v(\d+\.\d+\.\d+)-nightly\./.exec(tag)?.[1];
  if (!version) {
    throw new Error(`Cannot derive a stable version from nightly tag ${tag}.`);
  }

  core.info(`Latest nightly ${tag} shipped ${commit.sha} as a preview of ${version}.`);
  return { tag, sha: commit.sha, version };
}

module.exports = { shouldReleaseNightly, resolveLatestNightlyCommit };
