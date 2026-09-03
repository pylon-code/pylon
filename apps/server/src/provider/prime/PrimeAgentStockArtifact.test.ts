import { describe, expect, it } from "vite-plus/test";

import {
  PRIME_STOCK_ARTIFACT,
  verifyPrimeStockArtifactIdentity,
  verifyPrimeStockReleaseMetadata,
} from "./PrimeAgentStockArtifact.ts";

const repository = {
  id: PRIME_STOCK_ARTIFACT.repositoryId,
  full_name: PRIME_STOCK_ARTIFACT.repository,
};
const asset = {
  id: PRIME_STOCK_ARTIFACT.assetId,
  name: PRIME_STOCK_ARTIFACT.assetName,
  size: PRIME_STOCK_ARTIFACT.size,
  browser_download_url: PRIME_STOCK_ARTIFACT.url,
  digest: `sha256:${PRIME_STOCK_ARTIFACT.sha256}`,
};
const release = {
  id: PRIME_STOCK_ARTIFACT.releaseId,
  tag_name: PRIME_STOCK_ARTIFACT.tag,
  draft: false,
  prerelease: false,
  immutable: false,
  assets: [asset],
};

describe("frozen stock Prime artifact", () => {
  it("accepts only the reviewed repository, release, and asset metadata", () => {
    expect(() => verifyPrimeStockReleaseMetadata(repository, release)).not.toThrow();
    for (const mutation of [
      { repository: { ...repository, id: repository.id + 1 }, release },
      { repository: { ...repository, full_name: "other/prime-agent" }, release },
      { repository, release: { ...release, id: release.id + 1 } },
      { repository, release: { ...release, tag_name: "v0.8.2" } },
      {
        repository,
        release: { ...release, assets: [{ ...asset, id: asset.id + 1 }] },
      },
      {
        repository,
        release: { ...release, assets: [{ ...asset, name: "prime-agent-0.8.2.tgz" }] },
      },
      {
        repository,
        release: { ...release, assets: [{ ...asset, size: asset.size + 1 }] },
      },
      {
        repository,
        release: {
          ...release,
          assets: [{ ...asset, browser_download_url: `${asset.browser_download_url}.mutated` }],
        },
      },
      {
        repository,
        release: { ...release, assets: [{ ...asset, digest: `sha256:${"0".repeat(64)}` }] },
      },
    ]) {
      expect(() =>
        verifyPrimeStockReleaseMetadata(mutation.repository, mutation.release),
      ).toThrow();
    }
  });

  it("uses the frozen byte size, SHA-256, and SHA-512 as the trust root", () => {
    const identity = {
      size: PRIME_STOCK_ARTIFACT.size,
      sha256: PRIME_STOCK_ARTIFACT.sha256,
      sha512: PRIME_STOCK_ARTIFACT.sha512,
    };
    expect(() => verifyPrimeStockArtifactIdentity(identity)).not.toThrow();
    for (const mutation of [
      { ...identity, size: identity.size + 1 },
      { ...identity, sha256: "0".repeat(64) },
      { ...identity, sha512: "0".repeat(128) },
    ]) {
      expect(() => verifyPrimeStockArtifactIdentity(mutation)).toThrow();
    }
  });

  it("does not depend on GitHub supplying a live asset digest", () => {
    expect(() =>
      verifyPrimeStockReleaseMetadata(repository, {
        ...release,
        assets: [{ ...asset, digest: null }],
      }),
    ).not.toThrow();
  });
});
