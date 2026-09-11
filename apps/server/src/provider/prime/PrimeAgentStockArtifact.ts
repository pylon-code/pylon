// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";

export const PRIME_STOCK_ARTIFACT = Object.freeze({
  repository: "PrimeIntellect-ai/prime-agent",
  repositoryId: 1_232_493_406,
  version: "0.9.4",
  releaseId: 385_120_922,
  tag: "v0.9.4",
  assetId: 551_511_768,
  assetName: "prime-agent-0.9.4.tgz",
  size: 10_028_862,
  url: "https://github.com/PrimeIntellect-ai/prime-agent/releases/download/v0.9.4/prime-agent-0.9.4.tgz",
  sha256: "b8d752a53d11a8c9a7580e1fb5fc24f7ce74ccad979c7e6e6aa8880fc3ad90b0",
  sha512:
    "e85582bd3892dfea36c97dcd5935504a53cd3f444785ab6ea0ab25dd97ac0a7f12bda812b8343568288fee89b32a1d790175cf6b4dc1164ac02fe3a8e54b8f13",
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
