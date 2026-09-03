// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";

export const PRIME_STOCK_ARTIFACT = Object.freeze({
  repository: "PrimeIntellect-ai/prime-agent",
  repositoryId: 1_232_493_406,
  version: "0.8.1",
  releaseId: 376_894_763,
  tag: "v0.8.1",
  assetId: 530_304_956,
  assetName: "prime-agent-0.8.1.tgz",
  size: 9_616_163,
  url: "https://github.com/PrimeIntellect-ai/prime-agent/releases/download/v0.8.1/prime-agent-0.8.1.tgz",
  sha256: "46c24db1782dd31adc35d5c6cbcc75564faba6ced3bf2ccf03d836ee77134475",
  sha512:
    "28ce7328c386d6d54261ba6a7bebe3cd420bf6f625ed6cb6a9fae6ca4815988c767b8f3f0ff3d3a95037ab566a17e074b181039a3da2ec929f4c6712ba51931d",
});

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const GitHubRepository = Schema.Struct({
  id: PositiveInt,
  full_name: Schema.String,
});
const GitHubReleaseAsset = Schema.Struct({
  id: PositiveInt,
  name: Schema.String,
  size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  browser_download_url: Schema.String,
  digest: Schema.optional(Schema.NullOr(Schema.String)),
});
const GitHubRelease = Schema.Struct({
  id: PositiveInt,
  tag_name: Schema.String,
  draft: Schema.Boolean,
  prerelease: Schema.Boolean,
  immutable: Schema.Boolean,
  assets: Schema.Array(GitHubReleaseAsset),
});
const decodeGitHubRepository = Schema.decodeUnknownSync(GitHubRepository);
const decodeGitHubRelease = Schema.decodeUnknownSync(GitHubRelease);

type GitHubReleaseAssetMetadata = typeof GitHubReleaseAsset.Type;

export function verifyPrimeStockReleaseMetadata(
  repositoryInput: unknown,
  releaseInput: unknown,
): GitHubReleaseAssetMetadata {
  const repository = decodeGitHubRepository(repositoryInput);
  const release = decodeGitHubRelease(releaseInput);
  if (
    repository.id !== PRIME_STOCK_ARTIFACT.repositoryId ||
    repository.full_name !== PRIME_STOCK_ARTIFACT.repository
  ) {
    throw new Error("Stock Prime repository metadata does not match the frozen identity.");
  }
  if (
    release.id !== PRIME_STOCK_ARTIFACT.releaseId ||
    release.tag_name !== PRIME_STOCK_ARTIFACT.tag ||
    release.draft ||
    release.prerelease
  ) {
    throw new Error("Stock Prime release metadata does not match the frozen identity.");
  }
  const matchesById = release.assets.filter((asset) => asset.id === PRIME_STOCK_ARTIFACT.assetId);
  const matchesByName = release.assets.filter(
    (asset) => asset.name === PRIME_STOCK_ARTIFACT.assetName,
  );
  const asset = matchesById[0];
  if (
    matchesById.length !== 1 ||
    matchesByName.length !== 1 ||
    !asset ||
    matchesByName[0] !== asset ||
    asset.name !== PRIME_STOCK_ARTIFACT.assetName ||
    asset.size !== PRIME_STOCK_ARTIFACT.size ||
    asset.browser_download_url !== PRIME_STOCK_ARTIFACT.url ||
    (asset.digest !== undefined &&
      asset.digest !== null &&
      asset.digest !== `sha256:${PRIME_STOCK_ARTIFACT.sha256}`)
  ) {
    throw new Error("Stock Prime asset metadata does not match the frozen identity.");
  }
  return asset;
}

export interface PrimeStockArtifactIdentity {
  readonly size: number;
  readonly sha256: string;
  readonly sha512: string;
}

export function verifyPrimeStockArtifactIdentity(identity: PrimeStockArtifactIdentity): void {
  if (
    identity.size !== PRIME_STOCK_ARTIFACT.size ||
    identity.sha256 !== PRIME_STOCK_ARTIFACT.sha256 ||
    identity.sha512 !== PRIME_STOCK_ARTIFACT.sha512
  ) {
    throw new Error("Stock Prime bytes do not match the frozen size and digests.");
  }
}

export function verifyPrimeStockArtifactBytes(bytes: NodeJS.ArrayBufferView): void {
  verifyPrimeStockArtifactIdentity({
    size: bytes.byteLength,
    sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
    sha512: NodeCrypto.createHash("sha512").update(bytes).digest("hex"),
  });
}
