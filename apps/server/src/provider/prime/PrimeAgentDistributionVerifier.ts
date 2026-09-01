// @effect-diagnostics globalFetch:off
// @effect-diagnostics nodeBuiltinImport:off
import { bundleFromJSON, assertBundleLatest, isBundleWithDsseEnvelope } from "@sigstore/bundle";
import { X509Certificate } from "@sigstore/core";
import { getTrustedRoot } from "@sigstore/tuf";
import { toSignedEntity, toTrustMaterial, Verifier } from "@sigstore/verify";
import type {
  ServerProviderDistribution,
  ServerProviderDistributionChannel,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";

export const PRIME_DISTRIBUTION_REPOSITORY = "pylon-code/prime-agent";
export const PRIME_DISTRIBUTION_REPOSITORY_URL = "https://github.com/pylon-code/prime-agent";
export const PRIME_DISTRIBUTION_REF = "refs/heads/pylon";
export const PRIME_PREVIEW_WORKFLOW = ".github/workflows/pylon-preview-release.yml";
export const PRIME_STABLE_WORKFLOW = ".github/workflows/pylon-stable-release.yml";
export const PRIME_RELEASE_MANIFEST = "pylon-prime-agent-release-v1.json";
export const PRIME_PREVIEW_MANIFEST = "pylon-preview-channel-v1.json";
export const PRIME_STABLE_MANIFEST = "pylon-stable-channel-v1.json";
export const PRIME_RECEIPT_FILE = "managed-receipt-v1.json";
export const PRIME_HIGH_WATER_FILE = "channel-high-water-v1.json";
export const PRIME_RECEIPT_KEY_FILE = "receipt-auth-v1.key";

const GITHUB_REPOSITORY_ID = "1349002285";
const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const SLSA_PROVENANCE_V1 = "https://slsa.dev/provenance/v1";
const WORKFLOW_BUILD_TYPE = "https://actions.github.io/buildtypes/workflow/v1";
const IN_TOTO_PAYLOAD_TYPE = "application/vnd.in-toto+json";
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_PACKAGE_MANIFEST_BYTES = 256 * 1024;
const MAX_RECEIPT_BYTES = 64 * 1024;
const MAX_ATTESTATION_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_RELEASE_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_ROOT_ARTIFACT_BYTES = 256 * 1024 * 1024;
const MAX_FEED_CANDIDATES = 12;
const FETCH_TIMEOUT_MS = 12_000;

const SHA256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const SHA512 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{128}$/));
const GIT_SHA = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/));
const POSITIVE_DECIMAL = Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/));
const POSITIVE_INT = Schema.Int.check(Schema.isGreaterThan(0));
const PACKAGE_VERSION = Schema.String.check(
  Schema.isPattern(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
);
const PREVIEW_TAG = Schema.String.check(
  Schema.isPattern(/^pylon-build-g[0-9a-f]{12}-r[1-9][0-9]*$/),
);
const STABLE_TAG = Schema.String.check(
  Schema.isPattern(/^pylon-stable-[0-9]{6}-g[0-9a-f]{12}-r[1-9][0-9]*$/),
);
const SAFE_ASSET = Schema.String.check(
  Schema.isPattern(
    /^pylon-prime-agent(?:-(?:ai|core|tui))?-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.tgz$/,
  ),
);

const strict = <S extends Schema.Top>(schema: S) =>
  schema.annotate({ parseOptions: { onExcessProperty: "error" } });

const SourceSchema = strict(
  Schema.Struct({
    repository: Schema.Literal(PRIME_DISTRIBUTION_REPOSITORY_URL),
    commit: GIT_SHA,
    tree: GIT_SHA,
  }),
);

const ReleaseAssetSchema = strict(
  Schema.Struct({
    package: Schema.String,
    file: SAFE_ASSET,
    size: POSITIVE_INT,
    sha256: SHA256,
    sha512: SHA512,
  }),
);

const AttestationSubjectSchema = strict(
  Schema.Struct({
    name: Schema.String,
    digest: strict(Schema.Struct({ sha256: SHA256, sha512: SHA512 })),
  }),
);

const ReleaseManifestSchema = strict(
  Schema.Struct({
    schemaVersion: Schema.Literal(1),
    source: SourceSchema,
    build: strict(
      Schema.Struct({
        id: PREVIEW_TAG,
        recipeRevision: POSITIVE_INT,
        node: Schema.String,
        npm: Schema.String,
        lockfile: strict(
          Schema.Struct({ file: Schema.Literal("package-lock.json"), sha256: SHA256 }),
        ),
        assetBaseUrl: Schema.String,
      }),
    ),
    package: strict(
      Schema.Struct({
        name: Schema.Literal("prime-agent"),
        command: Schema.Literal("prime-agent"),
        version: PACKAGE_VERSION,
        minimumNode: Schema.String,
      }),
    ),
    assets: Schema.Array(ReleaseAssetSchema),
    attestationSubjects: Schema.Array(AttestationSubjectSchema),
  }),
);

const PublicationAssetSchema = strict(
  Schema.Struct({ file: SAFE_ASSET, size: POSITIVE_INT, sha256: SHA256, sha512: SHA512 }),
);

const PreviewSequenceSchema = strict(
  Schema.Struct({
    sequenceEpoch: Schema.Literal(1),
    sequence: POSITIVE_INT,
    workflowRunId: POSITIVE_DECIMAL,
  }),
);

const PreviewManifestSchema = strict(
  Schema.Struct({
    schemaVersion: Schema.Literal(1),
    channel: Schema.Literal("preview"),
    repository: Schema.Literal(PRIME_DISTRIBUTION_REPOSITORY_URL),
    publicationPolicyRevision: POSITIVE_INT,
    sequenceEpoch: Schema.Literal(1),
    sequence: POSITIVE_INT,
    workflowRunId: POSITIVE_DECIMAL,
    build: strict(
      Schema.Struct({
        tag: PREVIEW_TAG,
        id: PREVIEW_TAG,
        recipeRevision: POSITIVE_INT,
        source: SourceSchema,
        releaseManifest: strict(
          Schema.Struct({ file: Schema.Literal(PRIME_RELEASE_MANIFEST), sha256: SHA256 }),
        ),
      }),
    ),
    assets: Schema.Array(PublicationAssetSchema),
  }),
);

const StablePreviousSchema = strict(Schema.Struct({ tag: STABLE_TAG, sha256: SHA256 }));
const RevocationSchema = strict(
  Schema.Struct({
    stableTag: STABLE_TAG,
    buildTag: PREVIEW_TAG,
    reason: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{2,63}$/)),
    revokedBySequence: POSITIVE_INT,
  }),
);
const PromotionSchema = Schema.Union([
  strict(
    Schema.Struct({
      kind: Schema.Literal("promote"),
      policyCommit: GIT_SHA,
      policyTree: GIT_SHA,
      publicationPolicyRevision: POSITIVE_INT,
    }),
  ),
  strict(
    Schema.Struct({
      kind: Schema.Literal("withdraw"),
      policyCommit: GIT_SHA,
      policyTree: GIT_SHA,
      publicationPolicyRevision: POSITIVE_INT,
      revocation: RevocationSchema,
    }),
  ),
]);

const StableManifestSchema = strict(
  Schema.Struct({
    schemaVersion: Schema.Literal(1),
    channel: Schema.Literal("stable"),
    repository: Schema.Literal(PRIME_DISTRIBUTION_REPOSITORY_URL),
    sequence: POSITIVE_INT,
    tag: STABLE_TAG,
    history: strict(
      Schema.Struct({
        highWater: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
        previous: Schema.NullOr(StablePreviousSchema),
      }),
    ),
    build: strict(
      Schema.Struct({
        previewSequence: PreviewSequenceSchema,
        previewTag: PREVIEW_TAG,
        id: PREVIEW_TAG,
        recipeRevision: POSITIVE_INT,
        publicationPolicyRevision: POSITIVE_INT,
        source: SourceSchema,
        releaseManifest: strict(
          Schema.Struct({ file: Schema.Literal(PRIME_RELEASE_MANIFEST), sha256: SHA256 }),
        ),
        previewManifest: strict(
          Schema.Struct({ file: Schema.Literal(PRIME_PREVIEW_MANIFEST), sha256: SHA256 }),
        ),
        assets: Schema.Array(PublicationAssetSchema),
      }),
    ),
    promotion: PromotionSchema,
    revocations: Schema.Array(RevocationSchema),
  }),
);

const DistributionMetadataSchema = strict(
  Schema.Struct({
    schemaVersion: Schema.Literal(1),
    repository: Schema.Literal(PRIME_DISTRIBUTION_REPOSITORY_URL),
    sourceCommit: GIT_SHA,
    sourceTree: GIT_SHA,
    buildId: PREVIEW_TAG,
    recipeRevision: POSITIVE_INT,
    node: Schema.String,
    npm: Schema.String,
    packageLockSha256: SHA256,
  }),
);

const PackageManifestSchema = Schema.Struct({
  name: Schema.Literal("prime-agent"),
  version: PACKAGE_VERSION,
  pylonDistribution: Schema.optional(Schema.Unknown),
});

const ManagedStatePayloadSchema = strict(
  Schema.Struct({
    schemaVersion: Schema.Literal(1),
    kind: Schema.Literals(["managed-receipt", "channel-high-water"]),
    buildId: PREVIEW_TAG,
    channel: Schema.Literals(["preview", "stable"]),
    sequenceEpoch: Schema.Literal(1),
    sequence: POSITIVE_INT,
    sourceCommit: GIT_SHA,
    sourceTree: GIT_SHA,
    recipeRevision: POSITIVE_INT,
    rootAsset: SAFE_ASSET,
    rootSha256: SHA256,
    packageRoot: Schema.String,
  }),
);
const ManagedStateSchema = strict(
  Schema.Struct({
    schemaVersion: Schema.Literal(1),
    kind: Schema.Literals(["managed-receipt", "channel-high-water"]),
    buildId: PREVIEW_TAG,
    channel: Schema.Literals(["preview", "stable"]),
    sequenceEpoch: Schema.Literal(1),
    sequence: POSITIVE_INT,
    sourceCommit: GIT_SHA,
    sourceTree: GIT_SHA,
    recipeRevision: POSITIVE_INT,
    rootAsset: SAFE_ASSET,
    rootSha256: SHA256,
    packageRoot: Schema.String,
    hmacSha256: SHA256,
  }),
);

const StatementSubjectSchema = strict(
  Schema.Struct({ name: Schema.String, digest: strict(Schema.Struct({ sha256: SHA256 })) }),
);
const SlsaStatementSchema = Schema.Struct({
  _type: Schema.String,
  subject: Schema.Array(StatementSubjectSchema),
  predicateType: Schema.Literal(SLSA_PROVENANCE_V1),
  predicate: Schema.Struct({
    buildDefinition: Schema.Struct({
      buildType: Schema.Literal(WORKFLOW_BUILD_TYPE),
      externalParameters: Schema.Struct({
        workflow: Schema.Struct({
          repository: Schema.String,
          path: Schema.String,
          ref: Schema.String,
        }),
      }),
      internalParameters: Schema.Struct({
        github: Schema.Struct({
          event_name: Schema.String,
          repository_id: Schema.Union([Schema.String, Schema.Number]),
          repository_owner_id: Schema.Union([Schema.String, Schema.Number]),
          runner_environment: Schema.String,
        }),
      }),
      resolvedDependencies: Schema.Array(
        Schema.Struct({ uri: Schema.String, digest: Schema.Struct({ gitCommit: GIT_SHA }) }),
      ),
    }),
    runDetails: Schema.Struct({
      builder: Schema.Struct({ id: Schema.String }),
      metadata: Schema.Struct({ invocationId: Schema.String }),
    }),
  }),
});

const GitHubReleaseAssetSchema = Schema.Struct({
  id: POSITIVE_INT,
  name: Schema.String,
  size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  browser_download_url: Schema.String,
});
const GitHubReleaseSchema = Schema.Struct({
  id: POSITIVE_INT,
  tag_name: Schema.String,
  draft: Schema.Boolean,
  prerelease: Schema.Boolean,
  immutable: Schema.Boolean,
  assets: Schema.Array(GitHubReleaseAssetSchema),
});
const GitHubAttestationsSchema = Schema.Struct({
  attestations: Schema.Array(Schema.Struct({ bundle: Schema.Unknown })),
});
const GitHubCommitSchema = Schema.Struct({
  sha: GIT_SHA,
  tree: Schema.Struct({ sha: GIT_SHA }),
});

const decodeReleaseManifest = Schema.decodeUnknownSync(ReleaseManifestSchema);
const decodePreviewManifest = Schema.decodeUnknownSync(PreviewManifestSchema);
const decodeStableManifest = Schema.decodeUnknownSync(StableManifestSchema);
const decodePackageManifest = Schema.decodeUnknownSync(PackageManifestSchema);
const decodeDistributionMetadata = Schema.decodeUnknownSync(DistributionMetadataSchema);
const decodeManagedStatePayload = Schema.decodeUnknownSync(ManagedStatePayloadSchema);
const decodeManagedState = Schema.decodeUnknownSync(ManagedStateSchema);
const decodeSlsaStatement = Schema.decodeUnknownSync(SlsaStatementSchema);
const decodeGitHubRelease = Schema.decodeUnknownSync(GitHubReleaseSchema);
const decodeGitHubReleases = Schema.decodeUnknownSync(Schema.Array(GitHubReleaseSchema));
const decodeGitHubAttestations = Schema.decodeUnknownSync(GitHubAttestationsSchema);
const decodeGitHubCommit = Schema.decodeUnknownSync(GitHubCommitSchema);

type ReleaseManifest = typeof ReleaseManifestSchema.Type;
type PreviewManifest = typeof PreviewManifestSchema.Type;
type StableManifest = typeof StableManifestSchema.Type;
type DistributionMetadata = typeof DistributionMetadataSchema.Type;
export type PrimeManagedStatePayload = typeof ManagedStatePayloadSchema.Type;
type PrimeManagedState = typeof ManagedStateSchema.Type;
export type PrimeSlsaStatement = typeof SlsaStatementSchema.Type;
type GitHubRelease = typeof GitHubReleaseSchema.Type;

type TrustedRoot = Awaited<ReturnType<typeof getTrustedRoot>>;

export const PRIME_RELEASE_RECIPE = Object.freeze({
  recipeRevision: 1,
  manifestSchemaVersion: 1,
  nodeVersion: "22.23.2",
  npmVersion: "11.10.1",
  minimumNodeVersion: "22.8.0",
});
export const PRIME_PUBLICATION_SCHEMA_SOURCE = Object.freeze({
  commit: "f4d9ef03b529faf2e07031c8b7cd703363316ae5",
  tree: "b9a14b389aa64f54527008fb4d6119a7c57c2b58",
});
export const PRIME_PUBLICATION_POLICY = Object.freeze({
  publicationPolicyRevision: 1,
  previewWorkflowPath: PRIME_PREVIEW_WORKFLOW,
  previewWorkflowSha256: "e790a5da7063bd40fbd886e84945c3200291194fdbd5b002079349e45356a41d",
  stableWorkflowPath: PRIME_STABLE_WORKFLOW,
  stableWorkflowSha256: "dfcecdf6b58f143f9b7a543eadd124c190350ae29ac9eadccb907f1398b0958a",
});

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== "object") throw new Error("Publication JSON contains an unsupported value.");
  const record = value as Readonly<Record<string, unknown>>;
  return Object.fromEntries(
    Object.keys(record)
      .sort(compareText)
      .map((key) => [key, canonicalValue(record[key])]),
  );
}

export function canonicalPrimeDistributionJson(value: unknown): string {
  return `${JSON.stringify(canonicalValue(value), null, 2)}\n`;
}

function sha256(value: NodeJS.ArrayBufferView | string): string {
  return NodeCrypto.createHash("sha256").update(value).digest("hex");
}

function sha512(value: NodeJS.ArrayBufferView | string): string {
  return NodeCrypto.createHash("sha512").update(value).digest("hex");
}

function parseCanonicalJson<T>(
  bytes: Buffer,
  name: string,
  maxBytes: number,
  decode: (input: unknown) => T,
): T {
  if (bytes.byteLength < 1 || bytes.byteLength > maxBytes) {
    throw new Error(`${name} exceeds its bounded size.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (cause) {
    throw new Error(`${name} is not JSON.`, { cause });
  }
  const decoded = decode(parsed);
  if (canonicalPrimeDistributionJson(decoded) !== bytes.toString("utf8")) {
    throw new Error(`${name} is not canonical publication JSON.`);
  }
  return decoded;
}

function parseReleaseManifest(bytes: Buffer): ReleaseManifest {
  const manifest = parseCanonicalJson(
    bytes,
    "Pylon Prime release manifest",
    MAX_MANIFEST_BYTES,
    decodeReleaseManifest,
  );
  if (
    manifest.build.recipeRevision !== PRIME_RELEASE_RECIPE.recipeRevision ||
    manifest.build.node !== PRIME_RELEASE_RECIPE.nodeVersion ||
    manifest.build.npm !== PRIME_RELEASE_RECIPE.npmVersion ||
    manifest.package.minimumNode !== PRIME_RELEASE_RECIPE.minimumNodeVersion ||
    manifest.build.id !==
      `pylon-build-g${manifest.source.commit.slice(0, 12)}-r${manifest.build.recipeRevision}` ||
    manifest.build.assetBaseUrl !==
      `${PRIME_DISTRIBUTION_REPOSITORY_URL}/releases/download/${manifest.build.id}`
  ) {
    throw new Error("Release manifest does not match the frozen recipe and source identity.");
  }
  const version = manifest.package.version;
  const expectedPackages = new Map([
    [`pylon-prime-agent-ai-${version}.tgz`, "@earendil-works/pi-ai"],
    [`pylon-prime-agent-core-${version}.tgz`, "@earendil-works/pi-agent-core"],
    [`pylon-prime-agent-${version}.tgz`, "prime-agent"],
    [`pylon-prime-agent-tui-${version}.tgz`, "@earendil-works/pi-tui"],
  ]);
  const files = manifest.assets.map((asset) => asset.file);
  if (
    manifest.assets.length !== 4 ||
    manifest.attestationSubjects.length !== 4 ||
    files.join("\n") !== files.toSorted(compareText).join("\n") ||
    new Set(files).size !== files.length
  ) {
    throw new Error("Release manifest asset set is not exact, unique, and sorted.");
  }
  for (let index = 0; index < manifest.assets.length; index += 1) {
    const asset = manifest.assets[index]!;
    const subject = manifest.attestationSubjects[index]!;
    if (
      expectedPackages.get(asset.file) !== asset.package ||
      subject.name !== asset.file ||
      subject.digest.sha256 !== asset.sha256 ||
      subject.digest.sha512 !== asset.sha512
    ) {
      throw new Error(`Release subject does not bind its exact artifact: ${asset.file}`);
    }
    expectedPackages.delete(asset.file);
  }
  if (expectedPackages.size !== 0) throw new Error("Release manifest omits a required package.");
  return manifest;
}

function parsePreviewManifest(
  bytes: Buffer,
  release: ReleaseManifest,
  releaseBytes: Buffer,
): PreviewManifest {
  const manifest = parseCanonicalJson(
    bytes,
    "Pylon Prime preview manifest",
    MAX_MANIFEST_BYTES,
    decodePreviewManifest,
  );
  if (
    manifest.publicationPolicyRevision !== PRIME_PUBLICATION_POLICY.publicationPolicyRevision ||
    manifest.build.tag !== release.build.id ||
    manifest.build.id !== release.build.id ||
    manifest.build.recipeRevision !== release.build.recipeRevision ||
    canonicalPrimeDistributionJson(manifest.build.source) !==
      canonicalPrimeDistributionJson(release.source) ||
    manifest.build.releaseManifest.sha256 !== sha256(releaseBytes) ||
    canonicalPrimeDistributionJson(manifest.assets) !==
      canonicalPrimeDistributionJson(
        release.assets.map(({ file, size, sha256: sha256Digest, sha512: sha512Digest }) => ({
          file,
          size,
          sha256: sha256Digest,
          sha512: sha512Digest,
        })),
      )
  ) {
    throw new Error("Preview manifest does not bind the exact deterministic build manifest.");
  }
  return manifest;
}

function parseStableManifest(bytes: Buffer): StableManifest {
  const manifest = parseCanonicalJson(
    bytes,
    "Pylon Prime stable manifest",
    MAX_MANIFEST_BYTES,
    decodeStableManifest,
  );
  const stableMatch = /^pylon-stable-([0-9]{6})-g([0-9a-f]{12})-r([1-9][0-9]*)$/.exec(manifest.tag);
  if (
    !stableMatch ||
    Number(stableMatch[1]) !== manifest.sequence ||
    stableMatch[2] !== manifest.build.source.commit.slice(0, 12) ||
    Number(stableMatch[3]) !== manifest.build.recipeRevision ||
    manifest.history.highWater !== manifest.sequence - 1 ||
    (manifest.sequence === 1
      ? manifest.history.previous !== null
      : manifest.history.previous === null ||
        Number(/^pylon-stable-([0-9]{6})-/.exec(manifest.history.previous.tag)?.[1]) !==
          manifest.sequence - 1) ||
    manifest.build.previewTag !== manifest.build.id ||
    manifest.build.recipeRevision !== PRIME_RELEASE_RECIPE.recipeRevision ||
    manifest.build.publicationPolicyRevision !==
      PRIME_PUBLICATION_POLICY.publicationPolicyRevision ||
    manifest.promotion.publicationPolicyRevision !==
      PRIME_PUBLICATION_POLICY.publicationPolicyRevision
  ) {
    throw new Error("Stable manifest is not an exact closed Pylon build receipt.");
  }
  const promotion = manifest.promotion;
  const sortedRevocations = manifest.revocations.toSorted((left, right) =>
    compareText(left.stableTag, right.stableTag),
  );
  if (
    canonicalPrimeDistributionJson(sortedRevocations) !==
      canonicalPrimeDistributionJson(manifest.revocations) ||
    new Set(manifest.revocations.map((entry) => entry.stableTag)).size !==
      manifest.revocations.length ||
    manifest.revocations.some((entry) => {
      const revokedSequence = Number(/^pylon-stable-([0-9]{6})-/u.exec(entry.stableTag)?.[1]);
      return (
        revokedSequence >= entry.revokedBySequence || entry.revokedBySequence > manifest.sequence
      );
    }) ||
    (promotion.kind === "withdraw" &&
      (promotion.revocation.revokedBySequence !== manifest.sequence ||
        !manifest.revocations.some(
          (entry) =>
            canonicalPrimeDistributionJson(entry) ===
            canonicalPrimeDistributionJson(promotion.revocation),
        )))
  ) {
    throw new Error("Stable revocation history is not an exact sorted append-only receipt.");
  }
  return manifest;
}

export interface ExpectedPrimeAttestation {
  readonly workflow: typeof PRIME_PREVIEW_WORKFLOW | typeof PRIME_STABLE_WORKFLOW;
  readonly event: "push" | "workflow_dispatch";
  readonly signerDigest: string;
  readonly sourceCommit: string;
  readonly workflowRunId?: string;
  readonly subjects: ReadonlyArray<{ readonly name: string; readonly sha256: string }>;
}

function exactRegex(value: string): string {
  return `^${value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`;
}

function certificateExtension(cert: X509Certificate, oid: string): string | undefined {
  const extension = cert.extension(oid);
  const value = extension?.valueObj.subs[0]?.value;
  return value?.toString("utf8");
}

function certificateFromBundle(bundle: ReturnType<typeof bundleFromJSON>): X509Certificate {
  const material = bundle.verificationMaterial.content;
  if (material.$case === "certificate") {
    return X509Certificate.parse(
      `-----BEGIN CERTIFICATE-----\n${Buffer.from(material.certificate.rawBytes).toString("base64")}\n-----END CERTIFICATE-----`,
    );
  }
  if (material.$case === "x509CertificateChain") {
    const leaf = material.x509CertificateChain.certificates[0];
    if (!leaf) throw new Error("Sigstore bundle certificate chain is empty.");
    return X509Certificate.parse(
      `-----BEGIN CERTIFICATE-----\n${Buffer.from(leaf.rawBytes).toString("base64")}\n-----END CERTIFICATE-----`,
    );
  }
  throw new Error("Pylon publication requires a Fulcio certificate bundle.");
}

export interface PrimeCertificateClaims {
  readonly issuer: string | undefined;
  readonly event: string | undefined;
  readonly signerDigest: string | undefined;
  readonly repository: string | undefined;
  readonly ref: string | undefined;
}

export function assertPrimeCertificateClaims(
  claims: PrimeCertificateClaims,
  expected: ExpectedPrimeAttestation,
): void {
  if (
    claims.issuer !== GITHUB_OIDC_ISSUER ||
    claims.event !== expected.event ||
    claims.signerDigest !== expected.signerDigest ||
    claims.repository !== PRIME_DISTRIBUTION_REPOSITORY ||
    claims.ref !== PRIME_DISTRIBUTION_REF
  ) {
    throw new Error(
      "Sigstore GitHub certificate does not match the exact issuer, signer, repository, and ref.",
    );
  }
}

function assertGitHubCertificatePolicy(
  certificate: X509Certificate,
  expected: ExpectedPrimeAttestation,
): void {
  assertPrimeCertificateClaims(
    {
      issuer: certificateExtension(certificate, "1.3.6.1.4.1.57264.1.1"),
      event: certificateExtension(certificate, "1.3.6.1.4.1.57264.1.2"),
      signerDigest: certificateExtension(certificate, "1.3.6.1.4.1.57264.1.3"),
      repository: certificateExtension(certificate, "1.3.6.1.4.1.57264.1.5"),
      ref: certificateExtension(certificate, "1.3.6.1.4.1.57264.1.6"),
    },
    expected,
  );
}

function parseBundleStatement(bundle: ReturnType<typeof bundleFromJSON>): PrimeSlsaStatement {
  if (!isBundleWithDsseEnvelope(bundle)) {
    throw new Error("Pylon publication attestation is not a DSSE envelope.");
  }
  const envelope = bundle.content.dsseEnvelope;
  if (envelope.payloadType !== IN_TOTO_PAYLOAD_TYPE || envelope.signatures.length !== 1) {
    throw new Error("Pylon publication attestation has an unsupported DSSE envelope.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(envelope.payload.toString("utf8")) as unknown;
  } catch (cause) {
    throw new Error("Sigstore DSSE payload is not JSON.", { cause });
  }
  return decodeSlsaStatement(parsed);
}

export function assertPrimeAttestationBinding(
  statement: PrimeSlsaStatement,
  expected: ExpectedPrimeAttestation,
): void {
  const expectedSubjects = expected.subjects
    .map((subject) => ({ name: subject.name, digest: { sha256: subject.sha256 } }))
    .toSorted((left, right) => compareText(left.name, right.name));
  const actualSubjects = statement.subject.toSorted((left, right) =>
    compareText(left.name, right.name),
  );
  const definition = statement.predicate.buildDefinition;
  const workflow = definition.externalParameters.workflow;
  const github = definition.internalParameters.github;
  const dependencies = definition.resolvedDependencies;
  const invocation = new RegExp(
    `^https://github\\.com/${PRIME_DISTRIBUTION_REPOSITORY}/actions/runs/([1-9][0-9]*)/attempts/([1-9][0-9]*)$`,
    "u",
  ).exec(statement.predicate.runDetails.metadata.invocationId);
  if (
    statement._type !== "https://in-toto.io/Statement/v1" ||
    canonicalPrimeDistributionJson(actualSubjects) !==
      canonicalPrimeDistributionJson(expectedSubjects) ||
    new Set(actualSubjects.map((subject) => subject.name)).size !== actualSubjects.length ||
    workflow.repository !== PRIME_DISTRIBUTION_REPOSITORY_URL ||
    workflow.path !== expected.workflow ||
    workflow.ref !== PRIME_DISTRIBUTION_REF ||
    github.event_name !== expected.event ||
    String(github.repository_id) !== GITHUB_REPOSITORY_ID ||
    github.runner_environment !== "github-hosted" ||
    !/^[1-9][0-9]*$/u.test(String(github.repository_owner_id)) ||
    dependencies.length !== 1 ||
    dependencies[0]?.uri !== `git+${PRIME_DISTRIBUTION_REPOSITORY_URL}@${PRIME_DISTRIBUTION_REF}` ||
    dependencies[0]?.digest.gitCommit !== expected.sourceCommit ||
    statement.predicate.runDetails.builder.id !==
      `${PRIME_DISTRIBUTION_REPOSITORY_URL}/${expected.workflow}@${PRIME_DISTRIBUTION_REF}` ||
    !invocation ||
    (expected.workflowRunId !== undefined && invocation[1] !== expected.workflowRunId)
  ) {
    throw new Error(
      "SLSA provenance does not bind the exact source, workflow/ref, run, and subjects.",
    );
  }
}

export function verifyPrimeSigstoreBundle(
  bundleJson: unknown,
  trustedRoot: TrustedRoot,
  expected: ExpectedPrimeAttestation,
): PrimeSlsaStatement {
  const bundle = bundleFromJSON(bundleJson);
  assertBundleLatest(bundle);
  const verifier = new Verifier(toTrustMaterial(trustedRoot), {
    tlogThreshold: 1,
    ctlogThreshold: 1,
    tsaThreshold: 0,
  });
  verifier.verify(toSignedEntity(bundle), {
    subjectAlternativeName: exactRegex(
      `${PRIME_DISTRIBUTION_REPOSITORY_URL}/${expected.workflow}@${PRIME_DISTRIBUTION_REF}`,
    ),
    extensions: { issuer: GITHUB_OIDC_ISSUER },
  });
  assertGitHubCertificatePolicy(certificateFromBundle(bundle), expected);
  const statement = parseBundleStatement(bundle);
  assertPrimeAttestationBinding(statement, expected);
  return statement;
}

export interface PrimeSourcePolicyExpectation {
  readonly commit: string;
  readonly tree: string;
  readonly workflow: typeof PRIME_PREVIEW_WORKFLOW | typeof PRIME_STABLE_WORKFLOW;
  readonly publicationPolicyRevision: number;
}

export interface PrimePublicationVerificationDependencies {
  readonly verifyBundle: (
    bundle: unknown,
    expected: ExpectedPrimeAttestation,
  ) => Promise<PrimeSlsaStatement>;
  readonly verifySourcePolicy: (expected: PrimeSourcePolicyExpectation) => Promise<void>;
}

export interface PrimePublicationFixture {
  readonly channel: ServerProviderDistributionChannel;
  readonly releaseManifestBytes: Buffer;
  readonly previewManifestBytes: Buffer;
  readonly stableManifestBytes?: Buffer;
  readonly rootArtifactBytes?: Buffer;
  readonly attestationBundlesBySubjectSha256: ReadonlyMap<string, ReadonlyArray<unknown>>;
}

export interface VerifiedPrimePublication {
  readonly channel: ServerProviderDistributionChannel;
  readonly sequenceEpoch: 1;
  readonly sequence: number;
  readonly buildId: string;
  readonly sourceCommit: string;
  readonly sourceTree: string;
  readonly recipeRevision: number;
  readonly rootAsset: string;
  readonly rootSha256: string;
  readonly packageVersion: string;
}

async function verifyExpectedSubjectBundles(
  expected: ExpectedPrimeAttestation,
  bundlesByDigest: PrimePublicationFixture["attestationBundlesBySubjectSha256"],
  dependencies: PrimePublicationVerificationDependencies,
): Promise<void> {
  for (const subject of expected.subjects) {
    const bundles = bundlesByDigest.get(subject.sha256);
    if (!bundles || bundles.length < 1 || bundles.length > 20) {
      throw new Error(`No bounded Sigstore bundle set exists for ${subject.name}.`);
    }
    let verified = false;
    for (const bundle of bundles) {
      try {
        await dependencies.verifyBundle(bundle, expected);
        verified = true;
      } catch {
        // Public repositories can accumulate unrelated attestations. Only one exact, fully verified
        // Pylon signer/source/subject binding is required for this digest.
      }
    }
    if (!verified)
      throw new Error(`No valid Pylon Sigstore attestation exists for ${subject.name}.`);
  }
}

export async function verifyPrimePublicationFixture(
  fixture: PrimePublicationFixture,
  dependencies: PrimePublicationVerificationDependencies,
): Promise<VerifiedPrimePublication> {
  const release = parseReleaseManifest(fixture.releaseManifestBytes);
  const preview = parsePreviewManifest(
    fixture.previewManifestBytes,
    release,
    fixture.releaseManifestBytes,
  );
  await dependencies.verifySourcePolicy({
    commit: preview.build.source.commit,
    tree: preview.build.source.tree,
    workflow: PRIME_PREVIEW_WORKFLOW,
    publicationPolicyRevision: preview.publicationPolicyRevision,
  });
  let channelSequence: number;
  if (fixture.channel === "stable") {
    if (!fixture.stableManifestBytes) throw new Error("Stable verification requires its manifest.");
    const stable = parseStableManifest(fixture.stableManifestBytes);
    if (
      stable.build.previewManifest.sha256 !== sha256(fixture.previewManifestBytes) ||
      stable.build.releaseManifest.sha256 !== sha256(fixture.releaseManifestBytes) ||
      stable.build.previewTag !== preview.build.tag ||
      stable.build.id !== preview.build.id ||
      stable.build.recipeRevision !== preview.build.recipeRevision ||
      canonicalPrimeDistributionJson(stable.build.source) !==
        canonicalPrimeDistributionJson(preview.build.source) ||
      canonicalPrimeDistributionJson(stable.build.assets) !==
        canonicalPrimeDistributionJson(preview.assets)
    ) {
      throw new Error("Stable manifest does not bind the exact verified preview and recipe.");
    }
    await dependencies.verifySourcePolicy({
      commit: stable.promotion.policyCommit,
      tree: stable.promotion.policyTree,
      workflow: PRIME_STABLE_WORKFLOW,
      publicationPolicyRevision: stable.promotion.publicationPolicyRevision,
    });
    const stableExpected: ExpectedPrimeAttestation = {
      workflow: PRIME_STABLE_WORKFLOW,
      event: "workflow_dispatch",
      signerDigest: stable.promotion.policyCommit,
      sourceCommit: stable.promotion.policyCommit,
      subjects: [{ name: PRIME_STABLE_MANIFEST, sha256: sha256(fixture.stableManifestBytes) }],
    };
    await verifyExpectedSubjectBundles(
      stableExpected,
      fixture.attestationBundlesBySubjectSha256,
      dependencies,
    );
    channelSequence = stable.sequence;
  } else {
    if (fixture.stableManifestBytes !== undefined) {
      throw new Error("Preview verification cannot accept a stable manifest.");
    }
    channelSequence = preview.sequence;
  }

  const previewSubjects = [
    ...release.assets.map((asset) => ({ name: asset.file, sha256: asset.sha256 })),
    { name: PRIME_RELEASE_MANIFEST, sha256: sha256(fixture.releaseManifestBytes) },
    { name: PRIME_PREVIEW_MANIFEST, sha256: sha256(fixture.previewManifestBytes) },
  ].toSorted((left, right) => compareText(left.name, right.name));
  await verifyExpectedSubjectBundles(
    {
      workflow: PRIME_PREVIEW_WORKFLOW,
      event: "push",
      signerDigest: preview.build.source.commit,
      sourceCommit: preview.build.source.commit,
      workflowRunId: preview.workflowRunId,
      subjects: previewSubjects,
    },
    fixture.attestationBundlesBySubjectSha256,
    dependencies,
  );

  const root = release.assets.find((asset) => asset.package === "prime-agent");
  if (!root) throw new Error("Release manifest has no Prime root artifact.");
  if (
    fixture.rootArtifactBytes &&
    (fixture.rootArtifactBytes.byteLength !== root.size ||
      fixture.rootArtifactBytes.byteLength > MAX_ROOT_ARTIFACT_BYTES ||
      sha256(fixture.rootArtifactBytes) !== root.sha256 ||
      sha512(fixture.rootArtifactBytes) !== root.sha512)
  ) {
    throw new Error("Selected Prime root tarball digest does not match its signed subject.");
  }
  return {
    channel: fixture.channel,
    sequenceEpoch: 1,
    sequence: channelSequence,
    buildId: preview.build.id,
    sourceCommit: preview.build.source.commit,
    sourceTree: preview.build.source.tree,
    recipeRevision: preview.build.recipeRevision,
    rootAsset: root.file,
    rootSha256: root.sha256,
    packageVersion: release.package.version,
  };
}

export function primeDistributionStateDirectory(stateDir: string, instanceId: string): string {
  const identity = sha256(instanceId).slice(0, 32);
  return NodePath.join(stateDir, "provider-state", "prime-agent-distribution", identity);
}

export function authenticatePrimeManagedState(
  payload: PrimeManagedStatePayload,
  key: Buffer,
): PrimeManagedState {
  if (key.byteLength !== 32)
    throw new Error("Managed receipt authentication key must be 32 bytes.");
  const decodedPayload = decodeManagedStatePayload(payload);
  return {
    ...decodedPayload,
    hmacSha256: NodeCrypto.createHmac("sha256", key)
      .update(canonicalPrimeDistributionJson(decodedPayload))
      .digest("hex"),
  };
}

function verifyStateHmac(state: PrimeManagedState, key: Buffer): void {
  const { hmacSha256, ...payload } = state;
  const actual = Buffer.from(hmacSha256, "hex");
  const expected = Buffer.from(
    NodeCrypto.createHmac("sha256", key)
      .update(canonicalPrimeDistributionJson(payload))
      .digest("hex"),
    "hex",
  );
  if (actual.byteLength !== expected.byteLength || !NodeCrypto.timingSafeEqual(actual, expected)) {
    throw new Error("Managed receipt authentication failed.");
  }
}

interface OpenedPrivateFile {
  readonly bytes: Buffer;
  readonly dev: bigint;
  readonly ino: bigint;
}

async function readPrivateFile(
  path: string,
  maxBytes: number,
  uid: number,
): Promise<OpenedPrivateFile> {
  const handle = await NodeFSP.open(
    path,
    NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || Number(before.uid) !== uid || (Number(before.mode) & 0o777) !== 0o600) {
      throw new Error(`Private distribution state is not an owner-only regular file: ${path}`);
    }
    if (before.size < 1n || before.size > BigInt(maxBytes)) {
      throw new Error(`Private distribution state exceeds its bounded size: ${path}`);
    }
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const read = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (read.bytesRead === 0)
        throw new Error(`Private distribution state was truncated: ${path}`);
      offset += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const pathAfter = await NodeFSP.lstat(path, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      after.dev !== pathAfter.dev ||
      after.ino !== pathAfter.ino ||
      !pathAfter.isFile()
    ) {
      throw new Error(`Private distribution state changed while it was read: ${path}`);
    }
    return { bytes, dev: before.dev, ino: before.ino };
  } finally {
    await handle.close();
  }
}

async function pathKind(path: string): Promise<"missing" | "file" | "other"> {
  try {
    const info = await NodeFSP.lstat(path);
    return info.isFile() ? "file" : "other";
  } catch (cause) {
    if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") {
      return "missing";
    }
    throw cause;
  }
}

interface ManagedStateRead {
  readonly receipt: PrimeManagedState;
  readonly highWater: PrimeManagedState;
  readonly key: Buffer;
  readonly directory: string;
}

async function readManagedState(
  stateDir: string,
  instanceId: string,
  packageRoot: string,
): Promise<ManagedStateRead | undefined> {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Managed Prime receipts require a numeric current uid.");
  const directory = primeDistributionStateDirectory(stateDir, instanceId);
  const receiptPath = NodePath.join(directory, PRIME_RECEIPT_FILE);
  const keyPath = NodePath.join(directory, PRIME_RECEIPT_KEY_FILE);
  const highWaterPath = NodePath.join(directory, PRIME_HIGH_WATER_FILE);
  const kinds = await Promise.all([
    pathKind(receiptPath),
    pathKind(keyPath),
    pathKind(highWaterPath),
  ]);
  if (kinds.every((kind) => kind === "missing")) return undefined;
  if (kinds[0] !== "file" || kinds[1] !== "file" || kinds[2] === "other") {
    throw new Error("Managed Prime receipt state is partial or not regular-file state.");
  }
  const directoryInfo = await NodeFSP.lstat(directory);
  if (
    !directoryInfo.isDirectory() ||
    directoryInfo.isSymbolicLink() ||
    directoryInfo.uid !== uid ||
    (directoryInfo.mode & 0o777) !== 0o700
  ) {
    throw new Error("Managed Prime receipt directory is not private owner-only state.");
  }
  const [keyRead, receiptRead] = await Promise.all([
    readPrivateFile(keyPath, 32, uid),
    readPrivateFile(receiptPath, MAX_RECEIPT_BYTES, uid),
  ]);
  if (keyRead.bytes.byteLength !== 32) throw new Error("Managed Prime receipt key is malformed.");
  const receipt = parseCanonicalJson(
    receiptRead.bytes,
    "Managed Prime receipt",
    MAX_RECEIPT_BYTES,
    decodeManagedState,
  );
  verifyStateHmac(receipt, keyRead.bytes);
  if (receipt.kind !== "managed-receipt" || receipt.packageRoot !== packageRoot) {
    throw new Error("Managed Prime receipt does not bind the exact selected package root.");
  }
  let highWater = receipt;
  if (kinds[2] === "file") {
    const highWaterRead = await readPrivateFile(highWaterPath, MAX_RECEIPT_BYTES, uid);
    highWater = parseCanonicalJson(
      highWaterRead.bytes,
      "Managed Prime channel high-water",
      MAX_RECEIPT_BYTES,
      decodeManagedState,
    );
    verifyStateHmac(highWater, keyRead.bytes);
    if (
      highWater.kind !== "channel-high-water" ||
      highWater.channel !== receipt.channel ||
      highWater.sequenceEpoch !== receipt.sequenceEpoch ||
      highWater.packageRoot !== receipt.packageRoot ||
      highWater.sequence < receipt.sequence ||
      (highWater.sequence === receipt.sequence && highWater.buildId !== receipt.buildId)
    ) {
      throw new Error("Managed Prime channel high-water conflicts with its install receipt.");
    }
  }
  return { receipt, highWater, key: keyRead.bytes, directory };
}

async function writeHighWater(
  state: ManagedStateRead,
  candidate: VerifiedPrimePublication,
): Promise<PrimeManagedState> {
  const next = authenticatePrimeManagedState(
    {
      schemaVersion: 1,
      kind: "channel-high-water",
      buildId: candidate.buildId,
      channel: candidate.channel,
      sequenceEpoch: candidate.sequenceEpoch,
      sequence: candidate.sequence,
      sourceCommit: candidate.sourceCommit,
      sourceTree: candidate.sourceTree,
      recipeRevision: candidate.recipeRevision,
      rootAsset: candidate.rootAsset,
      rootSha256: candidate.rootSha256,
      packageRoot: state.receipt.packageRoot,
    },
    state.key,
  );
  const target = NodePath.join(state.directory, PRIME_HIGH_WATER_FILE);
  const temporary = NodePath.join(
    state.directory,
    `.channel-high-water-${process.pid}-${NodeCrypto.randomBytes(12).toString("hex")}.tmp`,
  );
  const handle = await NodeFSP.open(
    temporary,
    NodeFS.constants.O_WRONLY | NodeFS.constants.O_CREAT | NodeFS.constants.O_EXCL,
    0o600,
  );
  try {
    await handle.writeFile(canonicalPrimeDistributionJson(next), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await NodeFSP.rename(temporary, target);
    const directoryHandle = await NodeFSP.open(state.directory, NodeFS.constants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (cause) {
    await NodeFSP.rm(temporary, { force: true });
    throw cause;
  }
  return next;
}

async function readPackageDistribution(packageRoot: string): Promise<{
  readonly packageRoot: string;
  readonly version: string;
  readonly claimed: boolean;
  readonly metadata?: DistributionMetadata;
}> {
  const canonicalRoot = await NodeFSP.realpath(packageRoot);
  if (canonicalRoot !== packageRoot) {
    throw new Error("Selected Prime package root is not its canonical path.");
  }
  const manifestPath = NodePath.join(packageRoot, "package.json");
  const handle = await NodeFSP.open(
    manifestPath,
    NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0),
  );
  let bytes: Buffer;
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(MAX_PACKAGE_MANIFEST_BYTES)) {
      throw new Error("Selected Prime package manifest is not one bounded regular file.");
    }
    bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const read = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (read.bytesRead === 0) throw new Error("Selected Prime package manifest was truncated.");
      offset += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const pathAfter = await NodeFSP.lstat(manifestPath, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      after.dev !== pathAfter.dev ||
      after.ino !== pathAfter.ino ||
      !pathAfter.isFile()
    ) {
      throw new Error("Selected Prime package manifest changed while it was read.");
    }
  } finally {
    await handle.close();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (cause) {
    throw new Error("Selected Prime package manifest is not JSON.", { cause });
  }
  const manifest = decodePackageManifest(raw);
  const claimed = manifest.pylonDistribution !== undefined;
  if (!claimed) return { packageRoot, version: manifest.version, claimed: false };
  try {
    return {
      packageRoot,
      version: manifest.version,
      claimed: true,
      metadata: decodeDistributionMetadata(manifest.pylonDistribution),
    };
  } catch {
    return { packageRoot, version: manifest.version, claimed: true };
  }
}

function assertReceiptMatchesPackage(
  receipt: PrimeManagedState,
  metadata: DistributionMetadata,
  version: string,
): void {
  if (
    receipt.buildId !== metadata.buildId ||
    receipt.sourceCommit !== metadata.sourceCommit ||
    receipt.sourceTree !== metadata.sourceTree ||
    receipt.recipeRevision !== metadata.recipeRevision ||
    receipt.rootAsset !== `pylon-prime-agent-${version}.tgz`
  ) {
    throw new Error(
      "Managed receipt does not bind the selected package metadata and root artifact.",
    );
  }
}

export interface PersistPrimeManagedReceiptInput {
  readonly stateDir: string;
  readonly instanceId: string;
  readonly packageRoot: string;
  readonly platform: NodeJS.Platform;
  readonly publication: VerifiedPrimePublication;
}

async function writeExclusivePrivateFile(path: string, bytes: Buffer | string): Promise<void> {
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

async function assertPrivateDirectory(path: string, uid: number): Promise<void> {
  const info = await NodeFSP.lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== uid ||
    (info.mode & 0o777) !== 0o700
  ) {
    throw new Error(`Prime distribution state directory is not private owner-only state: ${path}`);
  }
}

/**
 * Persists one immutable managed-install receipt after real publication verification succeeds.
 * It never mutates the package and never replaces existing receipt state.
 */
export async function persistPrimeManagedReceipt(
  input: PersistPrimeManagedReceiptInput,
): Promise<void> {
  if (input.platform === "win32") {
    throw new Error("Native Windows Prime managed receipts are unavailable; use WSL2.");
  }
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Managed Prime receipts require a numeric current uid.");
  const selected = await readPackageDistribution(input.packageRoot);
  if (!selected.metadata) {
    throw new Error("A managed receipt requires exact Pylon distribution metadata.");
  }
  const publication = input.publication;
  if (
    publication.buildId !== selected.metadata.buildId ||
    publication.sourceCommit !== selected.metadata.sourceCommit ||
    publication.sourceTree !== selected.metadata.sourceTree ||
    publication.recipeRevision !== selected.metadata.recipeRevision ||
    publication.rootAsset !== `pylon-prime-agent-${selected.version}.tgz`
  ) {
    throw new Error("Verified publication does not match the selected Prime package.");
  }

  const finalDirectory = primeDistributionStateDirectory(input.stateDir, input.instanceId);
  const parent = NodePath.dirname(finalDirectory);
  await NodeFSP.mkdir(parent, { recursive: true, mode: 0o700 });
  await assertPrivateDirectory(parent, uid);
  if ((await pathKind(finalDirectory)) !== "missing") {
    throw new Error("Managed Prime receipt state already exists and will not be replaced.");
  }
  await NodeFSP.mkdir(finalDirectory, { mode: 0o700 });
  await assertPrivateDirectory(finalDirectory, uid);
  const key = NodeCrypto.randomBytes(32);
  const receipt = authenticatePrimeManagedState(
    {
      schemaVersion: 1,
      kind: "managed-receipt",
      buildId: publication.buildId,
      channel: publication.channel,
      sequenceEpoch: publication.sequenceEpoch,
      sequence: publication.sequence,
      sourceCommit: publication.sourceCommit,
      sourceTree: publication.sourceTree,
      recipeRevision: publication.recipeRevision,
      rootAsset: publication.rootAsset,
      rootSha256: publication.rootSha256,
      packageRoot: selected.packageRoot,
    },
    key,
  );
  await writeExclusivePrivateFile(NodePath.join(finalDirectory, PRIME_RECEIPT_KEY_FILE), key);
  await writeExclusivePrivateFile(
    NodePath.join(finalDirectory, PRIME_RECEIPT_FILE),
    canonicalPrimeDistributionJson(receipt),
  );
  const directoryHandle = await NodeFSP.open(finalDirectory, NodeFS.constants.O_RDONLY);
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
  const parentHandle = await NodeFSP.open(parent, NodeFS.constants.O_RDONLY);
  try {
    await parentHandle.sync();
  } finally {
    await parentHandle.close();
  }
}

export interface PrimeDistributionInspectionInput {
  readonly stateDir: string;
  readonly instanceId: string;
  readonly packageRoot: string;
  readonly platform: NodeJS.Platform;
  readonly checkedAt: string;
  readonly enableUpdateChecks?: boolean;
}

export interface PrimeDistributionInspectionDependencies {
  readonly loadLatestVerifiedPublication: (
    channel: ServerProviderDistributionChannel,
  ) => Promise<VerifiedPrimePublication>;
}

function distributionStatus(
  input: Partial<ServerProviderDistribution> & Pick<ServerProviderDistribution, "classification">,
): ServerProviderDistribution {
  return {
    classification: input.classification,
    channel: input.channel ?? null,
    buildId: input.buildId ?? null,
    sequence: input.sequence ?? null,
    latestBuildId: input.latestBuildId ?? null,
    latestSequence: input.latestSequence ?? null,
    updateAvailable: input.updateAvailable ?? false,
    checkedAt: input.checkedAt ?? null,
    message: input.message ?? null,
  };
}

export async function inspectPrimeAgentDistribution(
  input: PrimeDistributionInspectionInput,
  dependencies: PrimeDistributionInspectionDependencies,
): Promise<ServerProviderDistribution> {
  let selected;
  try {
    selected = await readPackageDistribution(input.packageRoot);
  } catch (cause) {
    return distributionStatus({
      classification: "stock-or-custom",
      checkedAt: input.checkedAt,
      message: `Pylon could not inspect the selected Prime package root: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  }
  if (!selected.claimed) {
    return distributionStatus({
      classification: "stock-or-custom",
      checkedAt: input.checkedAt,
      message: "This Prime installation is maintained manually.",
    });
  }
  if (!selected.metadata) {
    return distributionStatus({
      classification: "pylon-unmanaged",
      checkedAt: input.checkedAt,
      message: "This installation claims Pylon metadata, but it has no valid managed receipt.",
    });
  }
  if (input.platform === "win32") {
    return distributionStatus({
      classification: "pylon-unmanaged",
      buildId: selected.metadata.buildId,
      checkedAt: input.checkedAt,
      message:
        "Native Windows Prime distributions are unavailable. Use Prime Agent through WSL2, which follows the Linux receipt path.",
    });
  }

  let state: ManagedStateRead | undefined;
  try {
    state = await readManagedState(input.stateDir, input.instanceId, selected.packageRoot);
  } catch (cause) {
    return distributionStatus({
      classification: "invalid-receipt",
      buildId: selected.metadata.buildId,
      checkedAt: input.checkedAt,
      message: `The managed receipt is invalid; Prime remains usable but managed updates are disabled. ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  }
  if (!state) {
    return distributionStatus({
      classification: "pylon-unmanaged",
      buildId: selected.metadata.buildId,
      checkedAt: input.checkedAt,
      message: "This Pylon Prime build was installed manually and is maintained manually.",
    });
  }
  try {
    assertReceiptMatchesPackage(state.receipt, selected.metadata, selected.version);
  } catch (cause) {
    return distributionStatus({
      classification: "invalid-receipt",
      buildId: selected.metadata.buildId,
      checkedAt: input.checkedAt,
      message: `The managed receipt does not match the selected Prime package; managed updates are disabled. ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  }

  let highWater = state.highWater;
  let advisoryMessage: string | null = null;
  if (input.enableUpdateChecks !== false) {
    try {
      const candidate = await dependencies.loadLatestVerifiedPublication(state.receipt.channel);
      if (
        candidate.channel !== state.receipt.channel ||
        candidate.sequenceEpoch !== state.receipt.sequenceEpoch ||
        candidate.sequence < highWater.sequence ||
        (candidate.sequence === highWater.sequence && candidate.buildId !== highWater.buildId)
      ) {
        throw new Error("Signed channel replay conflicts with the authenticated local high-water.");
      }
      if (candidate.sequence > highWater.sequence) {
        highWater = await writeHighWater(state, candidate);
      }
    } catch (cause) {
      advisoryMessage = `The signed ${state.receipt.channel} feed is unavailable or invalid. The verified installed build remains ready. ${cause instanceof Error ? cause.message : String(cause)}`;
    }
  }

  const updateAvailable =
    highWater.sequence > state.receipt.sequence || highWater.buildId !== state.receipt.buildId;
  return distributionStatus({
    classification: "pylon-managed",
    channel: state.receipt.channel,
    buildId: state.receipt.buildId,
    sequence: state.receipt.sequence,
    latestBuildId: highWater.buildId,
    latestSequence: highWater.sequence,
    updateAvailable,
    checkedAt: input.checkedAt,
    message:
      advisoryMessage ??
      (updateAvailable
        ? `Verified ${state.receipt.channel} build ${highWater.buildId} (sequence ${highWater.sequence}) is available. Pylon will not download or install it automatically.`
        : `Verified Pylon-managed ${state.receipt.channel} build ${state.receipt.buildId}.`),
  });
}

export interface PrimeDistributionNetworkDependencies {
  readonly fetchJson: (url: string, maxBytes: number) => Promise<unknown>;
  readonly fetchBytes: (url: string, maxBytes: number) => Promise<Buffer>;
  readonly getTrustedRoot: () => Promise<TrustedRoot>;
}

async function boundedFetch(url: string, maxBytes: number, accept: string): Promise<Buffer> {
  const parsed = new URL(url);
  const allowedHosts = new Set([
    "api.github.com",
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
    "raw.githubusercontent.com",
  ]);
  if (parsed.protocol !== "https:" || !allowedHosts.has(parsed.hostname)) {
    throw new Error(`Pylon distribution fetch rejected an untrusted URL: ${url}`);
  }
  const response = await fetch(url, {
    headers: { accept, "user-agent": "pylon-prime-distribution-verifier" },
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const finalUrl = new URL(response.url);
  if (finalUrl.protocol !== "https:" || !allowedHosts.has(finalUrl.hostname)) {
    throw new Error("Pylon distribution fetch followed an untrusted redirect.");
  }
  if (!response.ok || !response.body) {
    throw new Error(`Pylon distribution fetch failed with HTTP ${response.status}.`);
  }
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) {
    throw new Error("Pylon distribution response exceeds its bounded size.");
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("Pylon distribution response exceeds its bounded size.");
    }
    chunks.push(Buffer.from(chunk.value));
  }
  return Buffer.concat(chunks, total);
}

export function makePrimeDistributionNetworkDependencies(
  options: { readonly tufCachePath?: string } = {},
): PrimeDistributionNetworkDependencies {
  return {
    fetchJson: async (url, maxBytes) => {
      const bytes = await boundedFetch(url, maxBytes, "application/vnd.github+json");
      return JSON.parse(bytes.toString("utf8")) as unknown;
    },
    fetchBytes: (url, maxBytes) => boundedFetch(url, maxBytes, "application/octet-stream"),
    getTrustedRoot: () =>
      getTrustedRoot({
        ...(options.tufCachePath ? { cachePath: options.tufCachePath } : {}),
        timeout: FETCH_TIMEOUT_MS,
        retry: { retries: 1 },
      }),
  };
}

function releaseAsset(release: GitHubRelease, name: string): GitHubRelease["assets"][number] {
  const matches = release.assets.filter((asset) => asset.name === name);
  if (matches.length !== 1) throw new Error(`Immutable release lacks one exact ${name} asset.`);
  return matches[0]!;
}

async function fetchReleaseByTag(
  tag: string,
  dependencies: PrimeDistributionNetworkDependencies,
): Promise<GitHubRelease> {
  const raw = await dependencies.fetchJson(
    `https://api.github.com/repos/${PRIME_DISTRIBUTION_REPOSITORY}/releases/tags/${encodeURIComponent(tag)}`,
    MAX_RELEASE_RESPONSE_BYTES,
  );
  const release = decodeGitHubRelease(raw);
  if (release.tag_name !== tag || release.draft || !release.immutable) {
    throw new Error("Pylon publication release is not the exact immutable tag.");
  }
  return release;
}

async function fetchAttestationBundles(
  digest: string,
  dependencies: PrimeDistributionNetworkDependencies,
): Promise<ReadonlyArray<unknown>> {
  const raw = await dependencies.fetchJson(
    `https://api.github.com/repos/${PRIME_DISTRIBUTION_REPOSITORY}/attestations/sha256:${digest}?predicate_type=${encodeURIComponent(SLSA_PROVENANCE_V1)}`,
    MAX_ATTESTATION_RESPONSE_BYTES,
  );
  return decodeGitHubAttestations(raw).attestations.map((entry) => entry.bundle);
}

async function loadPublicationFixtureForRelease(
  channel: ServerProviderDistributionChannel,
  release: GitHubRelease,
  dependencies: PrimeDistributionNetworkDependencies,
): Promise<PrimePublicationFixture> {
  let previewRelease = release;
  let stableManifestBytes: Buffer | undefined;
  if (channel === "stable") {
    stableManifestBytes = await dependencies.fetchBytes(
      releaseAsset(release, PRIME_STABLE_MANIFEST).browser_download_url,
      MAX_MANIFEST_BYTES,
    );
    const stable = parseStableManifest(stableManifestBytes);
    if (stable.tag !== release.tag_name) throw new Error("Stable release tag and manifest differ.");
    previewRelease = await fetchReleaseByTag(stable.build.previewTag, dependencies);
  }
  const releaseManifestBytes = await dependencies.fetchBytes(
    releaseAsset(previewRelease, PRIME_RELEASE_MANIFEST).browser_download_url,
    MAX_MANIFEST_BYTES,
  );
  const previewManifestBytes = await dependencies.fetchBytes(
    releaseAsset(previewRelease, PRIME_PREVIEW_MANIFEST).browser_download_url,
    MAX_MANIFEST_BYTES,
  );
  const parsedRelease = parseReleaseManifest(releaseManifestBytes);
  const expectedPreviewAssets = new Set([
    PRIME_RELEASE_MANIFEST,
    PRIME_PREVIEW_MANIFEST,
    ...parsedRelease.assets.map((asset) => asset.file),
  ]);
  if (
    previewRelease.assets.length !== expectedPreviewAssets.size ||
    previewRelease.assets.some((asset) => !expectedPreviewAssets.delete(asset.name)) ||
    expectedPreviewAssets.size !== 0
  ) {
    throw new Error("Preview release asset set is not exact.");
  }
  if (
    channel === "stable" &&
    (release.assets.length !== 1 || release.assets[0]?.name !== PRIME_STABLE_MANIFEST)
  ) {
    throw new Error("Stable release must contain only its signed singleton manifest.");
  }
  const subjectDigests = new Set([
    ...parsedRelease.assets.map((asset) => asset.sha256),
    sha256(releaseManifestBytes),
    sha256(previewManifestBytes),
    ...(stableManifestBytes ? [sha256(stableManifestBytes)] : []),
  ]);
  const attestationBundlesBySubjectSha256 = new Map<string, ReadonlyArray<unknown>>();
  await Promise.all(
    [...subjectDigests].map(async (digest) => {
      attestationBundlesBySubjectSha256.set(
        digest,
        await fetchAttestationBundles(digest, dependencies),
      );
    }),
  );
  return {
    channel,
    releaseManifestBytes,
    previewManifestBytes,
    ...(stableManifestBytes ? { stableManifestBytes } : {}),
    attestationBundlesBySubjectSha256,
  };
}

async function verifyRemoteSourcePolicy(
  expected: PrimeSourcePolicyExpectation,
  dependencies: PrimeDistributionNetworkDependencies,
): Promise<void> {
  if (expected.publicationPolicyRevision !== PRIME_PUBLICATION_POLICY.publicationPolicyRevision) {
    throw new Error("Unsupported Pylon publication policy revision.");
  }
  const commit = decodeGitHubCommit(
    await dependencies.fetchJson(
      `https://api.github.com/repos/${PRIME_DISTRIBUTION_REPOSITORY}/git/commits/${expected.commit}`,
      MAX_RELEASE_RESPONSE_BYTES,
    ),
  );
  if (commit.sha !== expected.commit || commit.tree.sha !== expected.tree) {
    throw new Error("Pylon publication source commit does not bind the signed full tree.");
  }
  const workflowBytes = await dependencies.fetchBytes(
    `https://raw.githubusercontent.com/${PRIME_DISTRIBUTION_REPOSITORY}/${expected.commit}/${expected.workflow}`,
    MAX_MANIFEST_BYTES,
  );
  const expectedDigest =
    expected.workflow === PRIME_PREVIEW_WORKFLOW
      ? PRIME_PUBLICATION_POLICY.previewWorkflowSha256
      : PRIME_PUBLICATION_POLICY.stableWorkflowSha256;
  if (sha256(workflowBytes) !== expectedDigest) {
    throw new Error("Signer workflow bytes do not match the frozen publication policy revision.");
  }
}

export function makeLatestPrimePublicationLoader(
  dependencies: PrimeDistributionNetworkDependencies = makePrimeDistributionNetworkDependencies(),
): PrimeDistributionInspectionDependencies["loadLatestVerifiedPublication"] {
  return async (channel) => {
    const raw = await dependencies.fetchJson(
      `https://api.github.com/repos/${PRIME_DISTRIBUTION_REPOSITORY}/releases?per_page=100`,
      MAX_RELEASE_RESPONSE_BYTES,
    );
    const releases = decodeGitHubReleases(raw)
      .filter(
        (release) =>
          !release.draft &&
          release.immutable &&
          (channel === "preview"
            ? /^pylon-build-g[0-9a-f]{12}-r[1-9][0-9]*$/u.test(release.tag_name)
            : /^pylon-stable-[0-9]{6}-g[0-9a-f]{12}-r[1-9][0-9]*$/u.test(release.tag_name)),
      )
      .slice(0, MAX_FEED_CANDIDATES);
    if (releases.length === 0) throw new Error(`No immutable ${channel} publication exists.`);
    const trustedRoot = await dependencies.getTrustedRoot();
    const verified: VerifiedPrimePublication[] = [];
    for (const release of releases) {
      try {
        const fixture = await loadPublicationFixtureForRelease(channel, release, dependencies);
        verified.push(
          await verifyPrimePublicationFixture(fixture, {
            verifyBundle: async (bundle, expected) =>
              verifyPrimeSigstoreBundle(bundle, trustedRoot, expected),
            verifySourcePolicy: (expected) => verifyRemoteSourcePolicy(expected, dependencies),
          }),
        );
      } catch {
        // One malformed, draft-like, or unrelated release must not hide a later exact candidate.
      }
    }
    const latest = verified.toSorted((left, right) => right.sequence - left.sequence)[0];
    if (!latest) throw new Error(`No exact signed ${channel} publication verified.`);
    return latest;
  };
}

/**
 * A real immutable fixture gate for bridge CI. It is deliberately fail-closed: callers must supply
 * every byte and bundle through {@link verifyPrimePublicationFixture}; no marker or package metadata
 * can stand in for Sigstore verification.
 */
export function requireRealPrimePublicationFixture(input: {
  readonly tag?: string;
  readonly artifactDirectory?: string;
}): { readonly tag: string; readonly artifactDirectory: string } {
  if (
    !input.tag ||
    !/^pylon-(?:build-g[0-9a-f]{12}-r[1-9][0-9]*|stable-[0-9]{6}-g[0-9a-f]{12}-r[1-9][0-9]*)$/u.test(
      input.tag,
    ) ||
    !input.artifactDirectory ||
    !NodePath.isAbsolute(input.artifactDirectory)
  ) {
    throw new Error(
      "Real Pylon Prime proof requires an immutable preview/stable tag and an absolute fixture directory.",
    );
  }
  return { tag: input.tag, artifactDirectory: input.artifactDirectory };
}
