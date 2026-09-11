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
  it("matches the reviewed Prime Agent 0.9.4 release and archive", () => {
    expect(PRIME_STOCK_ARTIFACT).toEqual({
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
  });

  it("accepts only the reviewed repository, release, and asset metadata", () => {
    expect(() => verifyPrimeStockReleaseMetadata(repository, release)).not.toThrow();
    for (const mutation of [
      { repository: { ...repository, id: repository.id + 1 }, release },
      { repository: { ...repository, full_name: "other/prime-agent" }, release },
      { repository, release: { ...release, id: release.id + 1 } },
      { repository, release: { ...release, tag_name: "v0.9.5" } },
      {
        repository,
        release: { ...release, assets: [{ ...asset, id: asset.id + 1 }] },
      },
      {
        repository,
        release: { ...release, assets: [{ ...asset, name: "prime-agent-0.9.5.tgz" }] },
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
