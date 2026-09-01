// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  assertPrimeAttestationBinding,
  assertPrimeCertificateClaims,
  authenticatePrimeManagedState,
  canonicalPrimeDistributionJson,
  inspectPrimeAgentDistribution,
  PRIME_DISTRIBUTION_REF,
  PRIME_DISTRIBUTION_REPOSITORY,
  PRIME_DISTRIBUTION_REPOSITORY_URL,
  PRIME_HIGH_WATER_FILE,
  PRIME_PREVIEW_MANIFEST,
  PRIME_PREVIEW_WORKFLOW,
  PRIME_PUBLICATION_POLICY,
  PRIME_PUBLICATION_SCHEMA_SOURCE,
  PRIME_RECEIPT_FILE,
  PRIME_RECEIPT_KEY_FILE,
  PRIME_RELEASE_MANIFEST,
  PRIME_STABLE_WORKFLOW,
  persistPrimeManagedReceipt,
  primeDistributionStateDirectory,
  requireRealPrimePublicationFixture,
  type ExpectedPrimeAttestation,
  type PrimeManagedStatePayload,
  type PrimePublicationFixture,
  type PrimeSlsaStatement,
  type VerifiedPrimePublication,
  verifyPrimePublicationFixture,
} from "./PrimeAgentDistributionVerifier.ts";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
});

const digest = (algorithm: "sha256" | "sha512", value: Buffer): string =>
  NodeCrypto.createHash(algorithm).update(value).digest("hex");

const SOURCE_COMMIT = "a".repeat(40);
const SOURCE_TREE = "b".repeat(40);
const POLICY_COMMIT = "c".repeat(40);
const POLICY_TREE = "d".repeat(40);
const BUILD_ID = `pylon-build-g${SOURCE_COMMIT.slice(0, 12)}-r1`;
const VERSION = "1.0.0";

function syntheticPublication(
  channel: "preview" | "stable" = "preview",
): PrimePublicationFixture & { readonly verified: VerifiedPrimePublication } {
  const artifactBytes = new Map([
    [`pylon-prime-agent-${VERSION}.tgz`, Buffer.from("synthetic-root-tarball-v1")],
    [`pylon-prime-agent-ai-${VERSION}.tgz`, Buffer.from("synthetic-ai-tarball-v1")],
    [`pylon-prime-agent-core-${VERSION}.tgz`, Buffer.from("synthetic-core-tarball-v1")],
    [`pylon-prime-agent-tui-${VERSION}.tgz`, Buffer.from("synthetic-tui-tarball-v1")],
  ]);
  const packages = new Map([
    [`pylon-prime-agent-${VERSION}.tgz`, "prime-agent"],
    [`pylon-prime-agent-ai-${VERSION}.tgz`, "@earendil-works/pi-ai"],
    [`pylon-prime-agent-core-${VERSION}.tgz`, "@earendil-works/pi-agent-core"],
    [`pylon-prime-agent-tui-${VERSION}.tgz`, "@earendil-works/pi-tui"],
  ]);
  const assets = [...artifactBytes]
    .map(([file, bytes]) => ({
      package: packages.get(file)!,
      file,
      size: bytes.byteLength,
      sha256: digest("sha256", bytes),
      sha512: digest("sha512", bytes),
    }))
    .toSorted((left, right) => (left.file < right.file ? -1 : left.file > right.file ? 1 : 0));
  const releaseManifest = {
    schemaVersion: 1,
    source: {
      repository: PRIME_DISTRIBUTION_REPOSITORY_URL,
      commit: SOURCE_COMMIT,
      tree: SOURCE_TREE,
    },
    build: {
      id: BUILD_ID,
      recipeRevision: 1,
      node: "22.23.2",
      npm: "11.10.1",
      lockfile: { file: "package-lock.json", sha256: "e".repeat(64) },
      assetBaseUrl: `${PRIME_DISTRIBUTION_REPOSITORY_URL}/releases/download/${BUILD_ID}`,
    },
    package: {
      name: "prime-agent",
      command: "prime-agent",
      version: VERSION,
      minimumNode: "22.8.0",
    },
    assets,
    attestationSubjects: assets.map((asset) => ({
      name: asset.file,
      digest: { sha256: asset.sha256, sha512: asset.sha512 },
    })),
  };
  const releaseManifestBytes = Buffer.from(canonicalPrimeDistributionJson(releaseManifest));
  const previewManifest = {
    schemaVersion: 1,
    channel: "preview",
    repository: PRIME_DISTRIBUTION_REPOSITORY_URL,
    publicationPolicyRevision: 1,
    sequenceEpoch: 1,
    sequence: 7,
    workflowRunId: "9001",
    build: {
      tag: BUILD_ID,
      id: BUILD_ID,
      recipeRevision: 1,
      source: releaseManifest.source,
      releaseManifest: {
        file: PRIME_RELEASE_MANIFEST,
        sha256: digest("sha256", releaseManifestBytes),
      },
    },
    assets: assets.map(({ file, size, sha256, sha512 }) => ({ file, size, sha256, sha512 })),
  };
  const previewManifestBytes = Buffer.from(canonicalPrimeDistributionJson(previewManifest));
  const stableManifest = {
    schemaVersion: 1,
    channel: "stable",
    repository: PRIME_DISTRIBUTION_REPOSITORY_URL,
    sequence: 3,
    tag: `pylon-stable-000003-g${SOURCE_COMMIT.slice(0, 12)}-r1`,
    history: {
      highWater: 2,
      previous: {
        tag: `pylon-stable-000002-g${"f".repeat(12)}-r1`,
        sha256: "1".repeat(64),
      },
    },
    build: {
      previewSequence: {
        sequenceEpoch: 1,
        sequence: 7,
        workflowRunId: "9001",
      },
      previewTag: BUILD_ID,
      id: BUILD_ID,
      recipeRevision: 1,
      publicationPolicyRevision: 1,
      source: releaseManifest.source,
      releaseManifest: {
        file: PRIME_RELEASE_MANIFEST,
        sha256: digest("sha256", releaseManifestBytes),
      },
      previewManifest: {
        file: PRIME_PREVIEW_MANIFEST,
        sha256: digest("sha256", previewManifestBytes),
      },
      assets: previewManifest.assets,
    },
    promotion: {
      kind: "promote",
      policyCommit: POLICY_COMMIT,
      policyTree: POLICY_TREE,
      publicationPolicyRevision: 1,
    },
    revocations: [],
  };
  const stableManifestBytes = Buffer.from(canonicalPrimeDistributionJson(stableManifest));
  const attestationBundlesBySubjectSha256 = new Map<string, ReadonlyArray<unknown>>();
  for (const sha256 of [
    ...assets.map((asset) => asset.sha256),
    digest("sha256", releaseManifestBytes),
    digest("sha256", previewManifestBytes),
    digest("sha256", stableManifestBytes),
  ]) {
    attestationBundlesBySubjectSha256.set(sha256, [{ synthetic: sha256 }]);
  }
  const rootAsset = assets.find((asset) => asset.package === "prime-agent")!;
  return {
    channel,
    releaseManifestBytes,
    previewManifestBytes,
    ...(channel === "stable" ? { stableManifestBytes } : {}),
    rootArtifactBytes: artifactBytes.get(rootAsset.file)!,
    attestationBundlesBySubjectSha256,
    verified: {
      channel,
      sequenceEpoch: 1,
      sequence: channel === "preview" ? 7 : 3,
      buildId: BUILD_ID,
      sourceCommit: SOURCE_COMMIT,
      sourceTree: SOURCE_TREE,
      recipeRevision: 1,
      rootAsset: rootAsset.file,
      rootSha256: rootAsset.sha256,
      packageVersion: VERSION,
    },
  };
}

function statementFor(expected: ExpectedPrimeAttestation): PrimeSlsaStatement {
  return {
    _type: "https://in-toto.io/Statement/v1",
    subject: expected.subjects.map((subject) => ({
      name: subject.name,
      digest: { sha256: subject.sha256 },
    })),
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        buildType: "https://actions.github.io/buildtypes/workflow/v1",
        externalParameters: {
          workflow: {
            repository: PRIME_DISTRIBUTION_REPOSITORY_URL,
            path: expected.workflow,
            ref: PRIME_DISTRIBUTION_REF,
          },
        },
        internalParameters: {
          github: {
            event_name: expected.event,
            repository_id: "1349002285",
            repository_owner_id: "11325514",
            runner_environment: "github-hosted",
          },
        },
        resolvedDependencies: [
          {
            uri: `git+${PRIME_DISTRIBUTION_REPOSITORY_URL}@${PRIME_DISTRIBUTION_REF}`,
            digest: { gitCommit: expected.sourceCommit },
          },
        ],
      },
      runDetails: {
        builder: {
          id: `${PRIME_DISTRIBUTION_REPOSITORY_URL}/${expected.workflow}@${PRIME_DISTRIBUTION_REF}`,
        },
        metadata: {
          invocationId: `https://github.com/${PRIME_DISTRIBUTION_REPOSITORY}/actions/runs/${expected.workflowRunId ?? "9100"}/attempts/1`,
        },
      },
    },
  };
}

const validVerification = {
  verifyBundle: async (_bundle: unknown, expected: ExpectedPrimeAttestation) => {
    const statement = statementFor(expected);
    assertPrimeAttestationBinding(statement, expected);
    return statement;
  },
  verifySourcePolicy: async () => {},
};

async function makePackage(input?: {
  readonly version?: string;
  readonly metadata?: unknown;
}): Promise<{ readonly root: string; readonly stateDir: string }> {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pylon-prime-dist-"));
  temporaryDirectories.push(directory);
  const root = NodePath.join(directory, "prime-agent");
  const stateDir = NodePath.join(directory, "state");
  await NodeFSP.mkdir(root, { recursive: true });
  await NodeFSP.mkdir(stateDir, { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(root, "package.json"),
    JSON.stringify({
      name: "prime-agent",
      version: input?.version ?? "0.8.1",
      ...(input && "metadata" in input ? { pylonDistribution: input.metadata } : {}),
    }),
  );
  return { root: await NodeFSP.realpath(root), stateDir };
}

function distributionMetadata(sourceCommit = SOURCE_COMMIT) {
  return {
    schemaVersion: 1,
    repository: PRIME_DISTRIBUTION_REPOSITORY_URL,
    sourceCommit,
    sourceTree: SOURCE_TREE,
    buildId: `pylon-build-g${sourceCommit.slice(0, 12)}-r1`,
    recipeRevision: 1,
    node: "22.23.2",
    npm: "11.10.1",
    packageLockSha256: "e".repeat(64),
  };
}

async function writeManagedReceipt(input: {
  readonly stateDir: string;
  readonly instanceId?: string;
  readonly packageRoot: string;
  readonly publication?: VerifiedPrimePublication;
  readonly corruptHmac?: boolean;
  readonly receiptPackageRoot?: string;
}): Promise<void> {
  const publication = input.publication ?? syntheticPublication().verified;
  const directory = primeDistributionStateDirectory(
    input.stateDir,
    input.instanceId ?? "primeAgent",
  );
  await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
  await NodeFSP.chmod(directory, 0o700);
  const key = Buffer.alloc(32, 0x5a);
  const payload: PrimeManagedStatePayload = {
    schemaVersion: 1,
    kind: "managed-receipt",
    buildId: publication.buildId,
    channel: publication.channel,
    sequenceEpoch: 1,
    sequence: publication.sequence,
    sourceCommit: publication.sourceCommit,
    sourceTree: publication.sourceTree,
    recipeRevision: publication.recipeRevision,
    rootAsset: publication.rootAsset,
    rootSha256: publication.rootSha256,
    packageRoot: input.receiptPackageRoot ?? input.packageRoot,
  };
  const receipt = authenticatePrimeManagedState(payload, key);
  const source = canonicalPrimeDistributionJson(
    input.corruptHmac ? { ...receipt, hmacSha256: "0".repeat(64) } : receipt,
  );
  await NodeFSP.writeFile(NodePath.join(directory, PRIME_RECEIPT_KEY_FILE), key, { mode: 0o600 });
  await NodeFSP.writeFile(NodePath.join(directory, PRIME_RECEIPT_FILE), source, { mode: 0o600 });
  await Promise.all([
    NodeFSP.chmod(NodePath.join(directory, PRIME_RECEIPT_KEY_FILE), 0o600),
    NodeFSP.chmod(NodePath.join(directory, PRIME_RECEIPT_FILE), 0o600),
  ]);
}

function inspectionInput(root: string, stateDir: string, platform: NodeJS.Platform = "linux") {
  return {
    stateDir,
    instanceId: "primeAgent",
    packageRoot: root,
    platform,
    checkedAt: "2026-08-20T12:00:00.000Z",
  } as const;
}

describe("Pylon Prime publication verification", () => {
  it("verifies preview and stable PR #42 manifests through an injected cryptographic verifier", async () => {
    expect(PRIME_PUBLICATION_SCHEMA_SOURCE).toEqual({
      commit: "f4d9ef03b529faf2e07031c8b7cd703363316ae5",
      tree: "b9a14b389aa64f54527008fb4d6119a7c57c2b58",
    });
    expect(PRIME_PUBLICATION_POLICY).toMatchObject({
      publicationPolicyRevision: 1,
      previewWorkflowSha256: "e790a5da7063bd40fbd886e84945c3200291194fdbd5b002079349e45356a41d",
      stableWorkflowSha256: "dfcecdf6b58f143f9b7a543eadd124c190350ae29ac9eadccb907f1398b0958a",
    });
    const preview = syntheticPublication("preview");
    const stable = syntheticPublication("stable");
    await expect(verifyPrimePublicationFixture(preview, validVerification)).resolves.toEqual(
      preview.verified,
    );
    await expect(verifyPrimePublicationFixture(stable, validVerification)).resolves.toEqual(
      stable.verified,
    );
  });

  it("fails closed for tarball, manifest, attestation, source, recipe, and stable history tampering", async () => {
    const fixture = syntheticPublication();
    await expect(
      verifyPrimePublicationFixture(
        { ...fixture, rootArtifactBytes: Buffer.from("synthetic-root-tarball-v2") },
        validVerification,
      ),
    ).rejects.toThrow(/root tarball digest/u);

    const release = JSON.parse(fixture.releaseManifestBytes.toString("utf8")) as Record<
      string,
      unknown
    >;
    const source = release.source as Record<string, unknown>;
    source.tree = "f".repeat(40);
    await expect(
      verifyPrimePublicationFixture(
        {
          ...fixture,
          releaseManifestBytes: Buffer.from(canonicalPrimeDistributionJson(release)),
        },
        validVerification,
      ),
    ).rejects.toThrow(/preview manifest|release manifest/iu);

    const recipe = JSON.parse(fixture.releaseManifestBytes.toString("utf8")) as {
      build: { recipeRevision: number };
    };
    recipe.build.recipeRevision = 2;
    await expect(
      verifyPrimePublicationFixture(
        {
          ...fixture,
          releaseManifestBytes: Buffer.from(canonicalPrimeDistributionJson(recipe)),
        },
        validVerification,
      ),
    ).rejects.toThrow(/recipe/u);

    await expect(
      verifyPrimePublicationFixture(fixture, {
        verifyBundle: async () => {
          throw new Error("synthetic signature failure");
        },
        verifySourcePolicy: async () => {},
      }),
    ).rejects.toThrow(/No valid Pylon Sigstore attestation/u);

    await expect(
      verifyPrimePublicationFixture(fixture, {
        ...validVerification,
        verifySourcePolicy: async () => {
          throw new Error("workflow digest or source tree mismatch");
        },
      }),
    ).rejects.toThrow(/workflow digest|source tree/u);

    const stable = syntheticPublication("stable");
    const stableManifest = JSON.parse(stable.stableManifestBytes!.toString("utf8")) as {
      history: { highWater: number };
    };
    stableManifest.history.highWater = 0;
    await expect(
      verifyPrimePublicationFixture(
        {
          ...stable,
          stableManifestBytes: Buffer.from(canonicalPrimeDistributionJson(stableManifest)),
        },
        validVerification,
      ),
    ).rejects.toThrow(/stable manifest/iu);
  });

  it("binds exact GitHub issuer, signer digest, source, workflow/ref, invocation, and subject digest", () => {
    const expected: ExpectedPrimeAttestation = {
      workflow: PRIME_PREVIEW_WORKFLOW,
      event: "push",
      signerDigest: SOURCE_COMMIT,
      sourceCommit: SOURCE_COMMIT,
      workflowRunId: "9001",
      subjects: [{ name: PRIME_PREVIEW_MANIFEST, sha256: "1".repeat(64) }],
    };
    const statement = statementFor(expected);
    expect(() => assertPrimeAttestationBinding(statement, expected)).not.toThrow();
    expect(() =>
      assertPrimeCertificateClaims(
        {
          issuer: "https://token.actions.githubusercontent.com",
          event: "push",
          signerDigest: SOURCE_COMMIT,
          repository: PRIME_DISTRIBUTION_REPOSITORY,
          ref: PRIME_DISTRIBUTION_REF,
        },
        expected,
      ),
    ).not.toThrow();

    for (const claims of [
      { issuer: "https://issuer.invalid" },
      { signerDigest: "f".repeat(40) },
      { repository: "attacker/prime-agent" },
      { ref: "refs/heads/main" },
      { event: "workflow_dispatch" },
    ]) {
      expect(() =>
        assertPrimeCertificateClaims(
          {
            issuer: "https://token.actions.githubusercontent.com",
            event: "push",
            signerDigest: SOURCE_COMMIT,
            repository: PRIME_DISTRIBUTION_REPOSITORY,
            ref: PRIME_DISTRIBUTION_REF,
            ...claims,
          },
          expected,
        ),
      ).toThrow(/certificate/u);
    }

    const mutations: PrimeSlsaStatement[] = [
      {
        ...statement,
        subject: [{ name: PRIME_PREVIEW_MANIFEST, digest: { sha256: "2".repeat(64) } }],
      },
      {
        ...statement,
        predicate: {
          ...statement.predicate,
          buildDefinition: {
            ...statement.predicate.buildDefinition,
            externalParameters: {
              workflow: {
                ...statement.predicate.buildDefinition.externalParameters.workflow,
                path: PRIME_STABLE_WORKFLOW,
              },
            },
          },
        },
      },
      {
        ...statement,
        predicate: {
          ...statement.predicate,
          buildDefinition: {
            ...statement.predicate.buildDefinition,
            resolvedDependencies: [
              {
                uri: `git+${PRIME_DISTRIBUTION_REPOSITORY_URL}@${PRIME_DISTRIBUTION_REF}`,
                digest: { gitCommit: "f".repeat(40) },
              },
            ],
          },
        },
      },
      {
        ...statement,
        predicate: {
          ...statement.predicate,
          runDetails: {
            ...statement.predicate.runDetails,
            metadata: {
              invocationId: `https://github.com/${PRIME_DISTRIBUTION_REPOSITORY}/actions/runs/9002/attempts/1`,
            },
          },
        },
      },
    ];
    for (const mutation of mutations) {
      expect(() => assertPrimeAttestationBinding(mutation, expected)).toThrow(/SLSA provenance/u);
    }
  });

  it("keeps the real immutable fixture gate fail-closed until all exact inputs exist", () => {
    expect(() => requireRealPrimePublicationFixture({})).toThrow(/immutable preview\/stable/u);
    expect(() =>
      requireRealPrimePublicationFixture({ tag: BUILD_ID, artifactDirectory: "relative" }),
    ).toThrow(/absolute fixture/u);
    expect(
      requireRealPrimePublicationFixture({ tag: BUILD_ID, artifactDirectory: "/tmp/prime-proof" }),
    ).toEqual({ tag: BUILD_ID, artifactDirectory: "/tmp/prime-proof" });
  });
});

describe("Pylon Prime distribution classification and advisory", () => {
  it("keeps stock 0.8.1 ready for manual maintenance without a fork update warning", async () => {
    const { root, stateDir } = await makePackage({ version: "0.8.1" });
    const loadLatestVerifiedPublication = vi.fn();
    const result = await inspectPrimeAgentDistribution(inspectionInput(root, stateDir), {
      loadLatestVerifiedPublication,
    });
    expect(result).toMatchObject({
      classification: "stock-or-custom",
      buildId: null,
      updateAvailable: false,
    });
    expect(result.message).toMatch(/maintained manually/u);
    expect(loadLatestVerifiedPublication).not.toHaveBeenCalled();
  });

  it("classifies a manual fork and forged distribution metadata as unmanaged", async () => {
    const manual = await makePackage({ version: VERSION, metadata: distributionMetadata() });
    const manualResult = await inspectPrimeAgentDistribution(
      inspectionInput(manual.root, manual.stateDir),
      { loadLatestVerifiedPublication: vi.fn() },
    );
    expect(manualResult.classification).toBe("pylon-unmanaged");
    expect(manualResult.updateAvailable).toBe(false);

    const forged = await makePackage({
      version: VERSION,
      metadata: { ...distributionMetadata(), repository: "https://attacker.invalid/prime-agent" },
    });
    const forgedResult = await inspectPrimeAgentDistribution(
      inspectionInput(forged.root, forged.stateDir),
      { loadLatestVerifiedPublication: vi.fn() },
    );
    expect(forgedResult.classification).toBe("pylon-unmanaged");
  });

  it("requires the exact authenticated receipt and package root for pylon-managed", async () => {
    const selected = await makePackage({ version: VERSION, metadata: distributionMetadata() });
    const verifiedPublication = await verifyPrimePublicationFixture(
      syntheticPublication(),
      validVerification,
    );
    await persistPrimeManagedReceipt({
      stateDir: selected.stateDir,
      instanceId: "primeAgent",
      packageRoot: selected.root,
      platform: "linux",
      publication: verifiedPublication,
    });
    await expect(
      persistPrimeManagedReceipt({
        stateDir: selected.stateDir,
        instanceId: "primeAgent",
        packageRoot: selected.root,
        platform: "linux",
        publication: verifiedPublication,
      }),
    ).rejects.toThrow(/will not be replaced/u);
    const managed = await inspectPrimeAgentDistribution(
      { ...inspectionInput(selected.root, selected.stateDir), enableUpdateChecks: false },
      { loadLatestVerifiedPublication: vi.fn() },
    );
    expect(managed).toMatchObject({
      classification: "pylon-managed",
      channel: "preview",
      buildId: BUILD_ID,
      sequence: 7,
      latestBuildId: BUILD_ID,
      latestSequence: 7,
      updateAvailable: false,
    });

    const mismatch = await makePackage({ version: VERSION, metadata: distributionMetadata() });
    await writeManagedReceipt({
      stateDir: mismatch.stateDir,
      packageRoot: mismatch.root,
      receiptPackageRoot: selected.root,
    });
    const invalid = await inspectPrimeAgentDistribution(
      inspectionInput(mismatch.root, mismatch.stateDir),
      { loadLatestVerifiedPublication: vi.fn() },
    );
    expect(invalid.classification).toBe("invalid-receipt");
    expect(invalid.message).toMatch(/package root/u);
  });

  it("treats malformed, forged, or symlinked receipt state as invalid without disabling Prime", async () => {
    const corrupt = await makePackage({ version: VERSION, metadata: distributionMetadata() });
    await writeManagedReceipt({
      stateDir: corrupt.stateDir,
      packageRoot: corrupt.root,
      corruptHmac: true,
    });
    const corruptResult = await inspectPrimeAgentDistribution(
      inspectionInput(corrupt.root, corrupt.stateDir),
      { loadLatestVerifiedPublication: vi.fn() },
    );
    expect(corruptResult.classification).toBe("invalid-receipt");
    expect(corruptResult.message).toMatch(/Prime remains usable/u);

    const symlinked = await makePackage({ version: VERSION, metadata: distributionMetadata() });
    const directory = primeDistributionStateDirectory(symlinked.stateDir, "primeAgent");
    await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
    await NodeFSP.chmod(directory, 0o700);
    const external = NodePath.join(symlinked.stateDir, "external-receipt");
    await NodeFSP.writeFile(external, "{}", { mode: 0o600 });
    await NodeFSP.symlink(external, NodePath.join(directory, PRIME_RECEIPT_FILE));
    await NodeFSP.writeFile(NodePath.join(directory, PRIME_RECEIPT_KEY_FILE), Buffer.alloc(32), {
      mode: 0o600,
    });
    const symlinkResult = await inspectPrimeAgentDistribution(
      inspectionInput(symlinked.root, symlinked.stateDir),
      { loadLatestVerifiedPublication: vi.fn() },
    );
    expect(symlinkResult.classification).toBe("invalid-receipt");
  });

  it("orders updates only by signed sequence/build id, persists high-water, and rejects replay", async () => {
    const selected = await makePackage({ version: VERSION, metadata: distributionMetadata() });
    await writeManagedReceipt({ stateDir: selected.stateDir, packageRoot: selected.root });
    const nextCommit = "9".repeat(40);
    const next: VerifiedPrimePublication = {
      ...syntheticPublication().verified,
      sequence: 8,
      buildId: `pylon-build-g${nextCommit.slice(0, 12)}-r1`,
      sourceCommit: nextCommit,
      sourceTree: "8".repeat(40),
      // Deliberately the same package version: SemVer must not order builds.
      packageVersion: VERSION,
      rootSha256: "7".repeat(64),
    };
    const first = await inspectPrimeAgentDistribution(
      inspectionInput(selected.root, selected.stateDir),
      { loadLatestVerifiedPublication: async () => next },
    );
    expect(first).toMatchObject({
      classification: "pylon-managed",
      sequence: 7,
      latestSequence: 8,
      latestBuildId: next.buildId,
      updateAvailable: true,
    });
    const highWaterPath = NodePath.join(
      primeDistributionStateDirectory(selected.stateDir, "primeAgent"),
      PRIME_HIGH_WATER_FILE,
    );
    expect((await NodeFSP.lstat(highWaterPath)).isFile()).toBe(true);

    const replay = await inspectPrimeAgentDistribution(
      inspectionInput(selected.root, selected.stateDir),
      { loadLatestVerifiedPublication: async () => syntheticPublication().verified },
    );
    expect(replay).toMatchObject({
      classification: "pylon-managed",
      latestSequence: 8,
      latestBuildId: next.buildId,
      updateAvailable: true,
    });
    expect(replay.message).toMatch(/replay|unavailable or invalid/u);
  });

  it("fails soft offline and retains the authenticated installed build and prior advisory", async () => {
    const selected = await makePackage({ version: VERSION, metadata: distributionMetadata() });
    await writeManagedReceipt({ stateDir: selected.stateDir, packageRoot: selected.root });
    const offline = await inspectPrimeAgentDistribution(
      inspectionInput(selected.root, selected.stateDir),
      {
        loadLatestVerifiedPublication: async () => {
          throw new Error("rate limited");
        },
      },
    );
    expect(offline).toMatchObject({
      classification: "pylon-managed",
      buildId: BUILD_ID,
      latestBuildId: BUILD_ID,
      updateAvailable: false,
    });
    expect(offline.message).toMatch(/installed build remains ready/u);
  });

  it("supports Linux, macOS, and WSL2 receipts but explicitly leaves native Windows unmanaged", async () => {
    for (const platform of ["linux", "darwin"] as const) {
      const selected = await makePackage({ version: VERSION, metadata: distributionMetadata() });
      await writeManagedReceipt({ stateDir: selected.stateDir, packageRoot: selected.root });
      const result = await inspectPrimeAgentDistribution(
        {
          ...inspectionInput(selected.root, selected.stateDir, platform),
          enableUpdateChecks: false,
        },
        { loadLatestVerifiedPublication: vi.fn() },
      );
      expect(result.classification).toBe("pylon-managed");
    }

    const windows = await makePackage({ version: VERSION, metadata: distributionMetadata() });
    const windowsResult = await inspectPrimeAgentDistribution(
      inspectionInput(windows.root, windows.stateDir, "win32"),
      { loadLatestVerifiedPublication: vi.fn() },
    );
    expect(windowsResult.classification).toBe("pylon-unmanaged");
    expect(windowsResult.message).toMatch(/WSL2/u);
  });
});
