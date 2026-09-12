// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  canonicalPrimeDistributionJson,
  makeLatestPrimePublicationLoader,
  makePrimeDistributionNetworkDependencies,
  PRIME_PREVIEW_WORKFLOW,
  verifyPrimePublicationFixture,
  verifyPrimeSigstoreBundle,
} from "./PrimeAgentDistributionVerifier.ts";
import bundle from "./fixtures/publication-83fe3dfe/preview-attestation.json" with { type: "json" };
import { trustedRoot } from "./fixtures/publication-83fe3dfe/trusted-root.ts";

const source = "83fe3dfe3f109dc767e6be4a4b7509c0ca1f536d";
const tree = "6ecea91dcd8534adca55aa42a4398040ce81d0a9";
const tag = "pylon-build-g83fe3dfe3f10-r1";
const releaseDigest = "67ed1d7afcf9b219dc71a009e4ed6f59f6e16995671c6c75bd564402dad946c0";
const sha256 = (bytes: Buffer) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const readFixture = (name: string) =>
  NodeFSP.readFile(new URL(`./fixtures/publication-83fe3dfe/${name}`, import.meta.url));

async function fixture() {
  return {
    channel: "preview" as const,
    releaseManifestBytes: await readFixture("pylon-prime-agent-release-v1.json"),
    previewManifestBytes: await readFixture("pylon-preview-channel-v1.json"),
    attestationBundlesBySubjectSha256: new Map([[releaseDigest, [bundle]]]),
  };
}

const dependencies = {
  verifyBundle: async (
    candidate: unknown,
    expected: Parameters<typeof verifyPrimeSigstoreBundle>[2],
  ) => verifyPrimeSigstoreBundle(candidate, trustedRoot, expected),
  verifySourcePolicy: async (expected: {
    commit: string;
    tree: string;
    workflow: string;
    publicationPolicyRevision: number;
  }) => {
    expect(expected).toEqual({
      commit: source,
      tree,
      workflow: PRIME_PREVIEW_WORKFLOW,
      publicationPolicyRevision: 3,
    });
    expect(sha256(await readFixture("pylon-preview-release.yml.txt"))).toBe(
      "16f68e46801eccca5e7e99736f346b5ffd96ce7188792d4ac8fbc4580408a736",
    );
  },
};

afterEach(() => vi.unstubAllGlobals());

describe("the immutable Prime preview published by run 34630984964", () => {
  it("verifies the original recipe bytes and real Fulcio/Rekor proof without network or crypto stubs", async () => {
    const input = await fixture();
    expect(sha256(input.releaseManifestBytes)).toBe(releaseDigest);
    await expect(verifyPrimePublicationFixture(input, dependencies)).resolves.toMatchObject({
      buildId: tag,
      sourceCommit: source,
      sourceTree: tree,
      packageVersion: "0.9.4",
      sequence: 13,
      rootSha256: "27aed732587efc16ac209c6b6169b637ea4f7b4a221c9e489648d12da5754b85",
    });
  });

  it("rejects reserialized manifests rather than normalizing signed bytes", async () => {
    const input = await fixture();
    const reordered = Buffer.from(
      canonicalPrimeDistributionJson(JSON.parse(input.releaseManifestBytes.toString("utf8"))),
    );
    expect(sha256(reordered)).not.toBe(releaseDigest);
    await expect(
      verifyPrimePublicationFixture({ ...input, releaseManifestBytes: reordered }, dependencies),
    ).rejects.toThrow(/Preview manifest does not bind/u);
  });

  it.each(["duplicate", "compact", "extra-field"])(
    "rejects malformed recipe serialization: %s",
    async (mutation) => {
      const input = await fixture();
      const text = input.releaseManifestBytes.toString("utf8");
      const changed =
        mutation === "duplicate"
          ? text.replace('"schemaVersion": 1,', '"schemaVersion": 1,\n  "schemaVersion": 1,')
          : mutation === "compact"
            ? JSON.stringify(JSON.parse(text))
            : text.replace('"schemaVersion": 1,', '"schemaVersion": 1,\n  "extra": true,');
      const verifyBundle = vi.fn(dependencies.verifyBundle);
      await expect(
        verifyPrimePublicationFixture(
          { ...input, releaseManifestBytes: Buffer.from(changed) },
          { ...dependencies, verifyBundle },
        ),
      ).rejects.toThrow();
      expect(verifyBundle).not.toHaveBeenCalled();
    },
  );

  it("rejects a corrupted real signature", async () => {
    const input = await fixture();
    const altered = structuredClone(bundle);
    const signature = altered.dsseEnvelope.signatures[0]!;
    const bytes = Buffer.from(signature.sig, "base64");
    bytes[0] = bytes[0]! ^ 1;
    signature.sig = bytes.toString("base64");
    await expect(
      verifyPrimePublicationFixture(
        { ...input, attestationBundlesBySubjectSha256: new Map([[releaseDigest, [altered]]]) },
        dependencies,
      ),
    ).rejects.toThrow(/No valid Pylon Sigstore attestation/u);
  });

  it("bounds workflow downloads separately while preserving exact workflow hashes", async () => {
    const input = await fixture();
    const workflowBytes = await readFixture("pylon-preview-release.yml.txt");
    expect(workflowBytes.length).toBeGreaterThan(64 * 1024);
    const manifest = JSON.parse(input.releaseManifestBytes.toString("utf8")) as {
      assets: Array<{ file: string; size: number }>;
    };
    const assetNames = [
      "pylon-prime-agent-release-v1.json",
      "pylon-preview-channel-v1.json",
      ...manifest.assets.map((asset) => asset.file),
    ];
    const release = {
      id: 387244456,
      tag_name: tag,
      draft: false,
      immutable: true,
      prerelease: true,
      assets: assetNames.map((name, index) => ({
        id: index + 1,
        name,
        size: 1,
        browser_download_url: `https://github.com/pylon-code/prime-agent/releases/download/${tag}/${name}`,
      })),
    };
    let oversized = false;
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const address = String(url);
      let bytes: Buffer;
      if (address.includes("/releases?")) bytes = Buffer.from(JSON.stringify([release]));
      else if (address.includes("/attestations/"))
        bytes = Buffer.from(JSON.stringify({ attestations: [{ bundle }] }));
      else if (address.includes("/git/commits/"))
        bytes = Buffer.from(JSON.stringify({ sha: source, tree: { sha: tree } }));
      else if (address.includes("raw.githubusercontent.com"))
        bytes = oversized ? Buffer.alloc(256 * 1024 + 1) : workflowBytes;
      else if (address.endsWith("pylon-prime-agent-release-v1.json"))
        bytes = input.releaseManifestBytes;
      else if (address.endsWith("pylon-preview-channel-v1.json"))
        bytes = input.previewManifestBytes;
      else throw new Error(`Unexpected fixture URL: ${address}`);
      const response = new Response(bytes, { headers: { "content-length": String(bytes.length) } });
      Object.defineProperty(response, "url", { value: address });
      return response;
    });
    vi.stubGlobal("fetch", fetch);
    const { cache: _cache, ...network } = makePrimeDistributionNetworkDependencies();
    const loader = makeLatestPrimePublicationLoader({
      ...network,
      getTrustedRoot: async () => trustedRoot,
    });
    await expect(loader("preview")).resolves.toMatchObject({ buildId: tag });
    oversized = true;
    await expect(loader("preview")).rejects.toThrow(
      /No exact signed preview publication verified/u,
    );
  });
});
