#!/usr/bin/env node
// @effect-diagnostics globalFetch:off
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalConsole:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";

import {
  PRIME_DISTRIBUTION_REPOSITORY,
  PRIME_DISTRIBUTION_REPOSITORY_URL,
  PRIME_GRADUATION_ASSETS_DIRECTORY,
  PRIME_GRADUATION_ATTESTATIONS,
  PRIME_GRADUATION_COMMIT_METADATA,
  PRIME_GRADUATION_PREVIEW_WORKFLOW,
  PRIME_GRADUATION_RELEASE_METADATA,
  PRIME_PREVIEW_MANIFEST,
  PRIME_PREVIEW_WORKFLOW,
  PRIME_RELEASE_MANIFEST,
  verifyPrimePublicationArtifactDirectory,
} from "../src/provider/prime/PrimeAgentDistributionVerifier.ts";
import {
  PRIME_STOCK_ARTIFACT,
  verifyPrimeStockArtifactBytes,
  verifyPrimeStockReleaseMetadata,
} from "../src/provider/prime/PrimeAgentStockArtifact.ts";

const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_ASSET_BYTES = 256 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
const PREVIEW_TAG = /^pylon-build-g[0-9a-f]{12}-r[1-9][0-9]*$/u;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SHA256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const GIT_SHA = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u));
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const GitHubRelease = Schema.Struct({
  id: PositiveInt,
  tag_name: Schema.String,
  draft: Schema.Boolean,
  prerelease: Schema.Boolean,
  immutable: Schema.Boolean,
  assets: Schema.Array(
    Schema.Struct({
      id: PositiveInt,
      name: Schema.String,
      size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      browser_download_url: Schema.String,
      digest: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
});
const ReleaseManifest = Schema.Struct({
  source: Schema.Struct({ repository: Schema.String, commit: GIT_SHA, tree: GIT_SHA }),
  build: Schema.Struct({ id: Schema.String }),
  assets: Schema.Array(
    Schema.Struct({
      package: Schema.String,
      file: Schema.String,
      size: Schema.Int.check(Schema.isGreaterThan(0)),
      sha256: SHA256,
      sha512: Schema.String.check(Schema.isPattern(/^[0-9a-f]{128}$/u)),
    }),
  ),
});
const VitestJson = Schema.Struct({
  numTotalTests: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  numPassedTests: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  numFailedTests: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  numPendingTests: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  success: Schema.Boolean,
});
const decodeGitHubRelease = Schema.decodeUnknownSync(GitHubRelease);
const decodeReleaseManifest = Schema.decodeUnknownSync(ReleaseManifest);
const decodeVitestJson = Schema.decodeUnknownSync(VitestJson);

function flag(name: string, required = true): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (required && (!value || value.startsWith("--"))) {
    throw new Error(`Missing --${name}.`);
  }
  return value;
}

function sha256(bytes: NodeJS.ArrayBufferView): string {
  return NodeCrypto.createHash("sha256").update(bytes).digest("hex");
}

async function fetchBounded(url: string, maxBytes: number, accept: string): Promise<Buffer> {
  const allowed = new Set([
    "api.github.com",
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
    "raw.githubusercontent.com",
    "registry.npmjs.org",
  ]);
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || !allowed.has(parsed.hostname)) {
    throw new Error("Artifact graduation rejected an untrusted download origin.");
  }
  const response = await fetch(url, {
    headers: { accept, "user-agent": "pylon-prime-artifact-graduation" },
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const final = new URL(response.url);
  if (final.protocol !== "https:" || !allowed.has(final.hostname)) {
    throw new Error("Artifact graduation followed an untrusted redirect.");
  }
  if (!response.ok || !response.body) {
    throw new Error(`Artifact graduation download failed with HTTP ${response.status}.`);
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error("Artifact graduation download exceeds its bounded size.");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  const reader = response.body.getReader();
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error("Artifact graduation download exceeds its bounded size.");
    }
    chunks.push(Buffer.from(next.value));
  }
  return Buffer.concat(chunks, size);
}

async function writeExclusive(path: string, bytes: Buffer): Promise<void> {
  const handle = await NodeFSP.open(
    path,
    NodeFS.constants.O_WRONLY | NodeFS.constants.O_CREAT | NodeFS.constants.O_EXCL,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function parseJson(bytes: Buffer): unknown {
  return JSON.parse(bytes.toString("utf8")) as unknown;
}

async function makeEmptyDirectory(path: string): Promise<string> {
  const requested = NodePath.resolve(path);
  const parent = await NodeFSP.realpath(NodePath.dirname(requested));
  const absolute = NodePath.join(parent, NodePath.basename(requested));
  await NodeFSP.mkdir(absolute, { recursive: false, mode: 0o700 });
  if ((await NodeFSP.realpath(absolute)) !== absolute) {
    throw new Error("Artifact graduation output directory is not canonical.");
  }
  return absolute;
}

async function downloadPreview(): Promise<void> {
  const tag = flag("tag")!;
  const destination = await makeEmptyDirectory(flag("artifact-directory")!);
  if (!PREVIEW_TAG.test(tag)) throw new Error("Preview tag is not one exact immutable build tag.");
  const releaseBytes = await fetchBounded(
    `https://api.github.com/repos/${PRIME_DISTRIBUTION_REPOSITORY}/releases/tags/${tag}`,
    MAX_JSON_BYTES,
    "application/vnd.github+json",
  );
  const release = decodeGitHubRelease(parseJson(releaseBytes));
  if (release.tag_name !== tag || release.draft || !release.prerelease || !release.immutable) {
    throw new Error("Preview release is not exact, immutable, and public prerelease material.");
  }
  if (release.assets.length < 1 || release.assets.length > 12) {
    throw new Error("Preview release has an unbounded asset set.");
  }
  const names = new Set<string>();
  const assetsDirectory = NodePath.join(destination, PRIME_GRADUATION_ASSETS_DIRECTORY);
  await NodeFSP.mkdir(assetsDirectory, { mode: 0o700 });
  await writeExclusive(NodePath.join(destination, PRIME_GRADUATION_RELEASE_METADATA), releaseBytes);
  for (const asset of release.assets) {
    const expectedUrl = `${PRIME_DISTRIBUTION_REPOSITORY_URL}/releases/download/${tag}/${asset.name}`;
    if (
      !SAFE_NAME.test(asset.name) ||
      names.has(asset.name) ||
      asset.browser_download_url !== expectedUrl ||
      asset.size < 1 ||
      asset.size > MAX_ASSET_BYTES ||
      typeof asset.digest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(asset.digest)
    ) {
      throw new Error("Preview release asset name, URL, or size is not exact.");
    }
    names.add(asset.name);
    const bytes = await fetchBounded(expectedUrl, MAX_ASSET_BYTES, "application/octet-stream");
    if (bytes.byteLength !== asset.size || asset.digest !== `sha256:${sha256(bytes)}`) {
      throw new Error("Preview release asset size or GitHub digest changed.");
    }
    await writeExclusive(NodePath.join(assetsDirectory, asset.name), bytes);
  }
  if (!names.has(PRIME_RELEASE_MANIFEST) || !names.has(PRIME_PREVIEW_MANIFEST)) {
    throw new Error("Preview release omits a required signed manifest.");
  }
  const releaseManifestBytes = await NodeFSP.readFile(
    NodePath.join(assetsDirectory, PRIME_RELEASE_MANIFEST),
  );
  const previewManifestBytes = await NodeFSP.readFile(
    NodePath.join(assetsDirectory, PRIME_PREVIEW_MANIFEST),
  );
  const manifest = decodeReleaseManifest(parseJson(releaseManifestBytes));
  if (
    manifest.source.repository !== PRIME_DISTRIBUTION_REPOSITORY_URL ||
    manifest.build.id !== tag ||
    manifest.assets.length + 2 !== names.size
  ) {
    throw new Error("Preview build manifest does not bind the requested release.");
  }
  const manifestNames = new Set(manifest.assets.map((asset) => asset.file));
  if (
    manifestNames.size !== manifest.assets.length ||
    [...manifestNames].some((name) => !names.has(name))
  ) {
    throw new Error("Preview build manifest asset set is not exact.");
  }
  for (const asset of manifest.assets) {
    const bytes = await NodeFSP.readFile(NodePath.join(assetsDirectory, asset.file));
    if (
      bytes.byteLength !== asset.size ||
      sha256(bytes) !== asset.sha256 ||
      NodeCrypto.createHash("sha512").update(bytes).digest("hex") !== asset.sha512
    ) {
      throw new Error("Preview asset digest does not match its build manifest.");
    }
  }
  const attestationBytes = await fetchBounded(
    `https://api.github.com/repos/${PRIME_DISTRIBUTION_REPOSITORY}/attestations/sha256:${sha256(previewManifestBytes)}?predicate_type=${encodeURIComponent("https://slsa.dev/provenance/v1")}`,
    MAX_JSON_BYTES,
    "application/vnd.github+json",
  );
  const commitBytes = await fetchBounded(
    `https://api.github.com/repos/${PRIME_DISTRIBUTION_REPOSITORY}/git/commits/${manifest.source.commit}`,
    MAX_JSON_BYTES,
    "application/vnd.github+json",
  );
  const workflowBytes = await fetchBounded(
    `https://raw.githubusercontent.com/${PRIME_DISTRIBUTION_REPOSITORY}/${manifest.source.commit}/${PRIME_PREVIEW_WORKFLOW}`,
    MAX_JSON_BYTES,
    "application/octet-stream",
  );
  await writeExclusive(NodePath.join(destination, PRIME_GRADUATION_ATTESTATIONS), attestationBytes);
  await writeExclusive(NodePath.join(destination, PRIME_GRADUATION_COMMIT_METADATA), commitBytes);
  await writeExclusive(
    NodePath.join(destination, PRIME_GRADUATION_PREVIEW_WORKFLOW),
    workflowBytes,
  );
  console.log(`Downloaded immutable Prime preview ${tag}.`);
}

async function downloadStock(): Promise<void> {
  const destination = await makeEmptyDirectory(flag("stock-directory")!);
  const repositoryBytes = await fetchBounded(
    `https://api.github.com/repos/${PRIME_STOCK_ARTIFACT.repository}`,
    MAX_JSON_BYTES,
    "application/vnd.github+json",
  );
  const releaseBytes = await fetchBounded(
    `https://api.github.com/repos/${PRIME_STOCK_ARTIFACT.repository}/releases/${PRIME_STOCK_ARTIFACT.releaseId}`,
    MAX_JSON_BYTES,
    "application/vnd.github+json",
  );
  verifyPrimeStockReleaseMetadata(parseJson(repositoryBytes), parseJson(releaseBytes));
  const tarball = await fetchBounded(
    PRIME_STOCK_ARTIFACT.url,
    PRIME_STOCK_ARTIFACT.size,
    "application/octet-stream",
  );
  verifyPrimeStockArtifactBytes(tarball);
  await writeExclusive(NodePath.join(destination, "github-repository.json"), repositoryBytes);
  await writeExclusive(NodePath.join(destination, "github-release.json"), releaseBytes);
  await writeExclusive(NodePath.join(destination, PRIME_STOCK_ARTIFACT.assetName), tarball);
  console.log(`Downloaded frozen stock Prime ${PRIME_STOCK_ARTIFACT.version}.`);
}

async function verifyPreview(): Promise<void> {
  const tag = flag("tag")!;
  const verified = await verifyPrimePublicationArtifactDirectory({
    tag,
    artifactDirectory: flag("artifact-directory")!,
    tufCachePath: flag("tuf-cache")!,
  });
  const summary = {
    schemaVersion: 1,
    status: "verified",
    repository: PRIME_DISTRIBUTION_REPOSITORY,
    tag: verified.publication.buildId,
    sequence: verified.publication.sequence,
    sourceCommit: verified.publication.sourceCommit,
    sourceTree: verified.publication.sourceTree,
    rootSha256: verified.publication.rootSha256,
    recipeRevision: verified.publication.recipeRevision,
    assets: verified.assetDigests,
  };
  await writeExclusive(
    NodePath.resolve(flag("output")!),
    Buffer.from(`${JSON.stringify(summary, null, 2)}
`),
  );
  console.log(`Verified immutable Prime preview ${tag} with server-owned Sigstore policy.`);
}

async function assertResults(): Promise<void> {
  const testOutput = decodeVitestJson(
    parseJson(await NodeFSP.readFile(NodePath.resolve(flag("test-output")!))),
  );
  if (
    !testOutput.success ||
    testOutput.numTotalTests < 4 ||
    testOutput.numPassedTests !== testOutput.numTotalTests ||
    testOutput.numFailedTests !== 0 ||
    testOutput.numPendingTests !== 0
  ) {
    throw new Error("Prime artifact graduation requires all real proof tests and zero skips.");
  }
  const verification = parseJson(await NodeFSP.readFile(NodePath.resolve(flag("verification")!)));
  const graduation = parseJson(
    await NodeFSP.readFile(NodePath.resolve(flag("graduation-result")!)),
  );
  const summary = {
    schemaVersion: 1,
    status: "passed",
    verification,
    graduation,
    tests: {
      total: testOutput.numTotalTests,
      passed: testOutput.numPassedTests,
      failed: 0,
      skipped: 0,
    },
  };
  await writeExclusive(
    NodePath.resolve(flag("output")!),
    Buffer.from(`${JSON.stringify(summary, null, 2)}
`),
  );
  console.log(
    `Prime artifact graduation passed ${testOutput.numPassedTests} tests with zero skips.`,
  );
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "download-preview") return await downloadPreview();
  if (command === "download-stock") return await downloadStock();
  if (command === "verify-preview") return await verifyPreview();
  if (command === "assert-results") return await assertResults();
  throw new Error("Expected download-preview, download-stock, verify-preview, or assert-results.");
}

await main();
