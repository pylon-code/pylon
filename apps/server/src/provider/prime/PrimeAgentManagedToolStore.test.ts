// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  assertPrimeAttestationBinding,
  canonicalPrimeDistributionJson,
  PRIME_DISTRIBUTION_REF,
  PRIME_DISTRIBUTION_REPOSITORY,
  PRIME_DISTRIBUTION_REPOSITORY_URL,
  PRIME_PREVIEW_MANIFEST,
  PRIME_RELEASE_MANIFEST,
  type ExpectedPrimeAttestation,
  type PrimePublicationFixture,
  type PrimeSlsaStatement,
  verifyPrimePublicationFixture,
} from "./PrimeAgentDistributionVerifier.ts";
import {
  PRIME_MANAGED_TOOL_DIRECTORY,
  PrimeAgentManagedToolStore,
  resolvePrimeManagedBuildReceiptTarget,
  type PrimeManagedBinding,
  type PrimeManagedPublicationBundle,
  type PrimeManagedToolStoreDependencies,
} from "./PrimeAgentManagedToolStore.ts";

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

function tarOctal(value: number, length: number): Buffer {
  return Buffer.from(`${value.toString(8).padStart(length - 1, "0")}\0`, "ascii");
}

function tarHeader(input: {
  readonly path: string;
  readonly type?: "file" | "directory" | "symlink" | "hardlink";
  readonly bytes?: Buffer;
  readonly mode?: number;
  readonly link?: string;
}): Buffer {
  const header = Buffer.alloc(512);
  header.write(input.path, 0, 100, "utf8");
  tarOctal(input.mode ?? (input.type === "directory" ? 0o755 : 0o644), 8).copy(header, 100);
  tarOctal(0, 8).copy(header, 108);
  tarOctal(0, 8).copy(header, 116);
  tarOctal(input.bytes?.byteLength ?? 0, 12).copy(header, 124);
  tarOctal(0, 12).copy(header, 136);
  header.fill(0x20, 148, 156);
  const type = input.type ?? "file";
  header[156] =
    type === "file" ? 0x30 : type === "directory" ? 0x35 : type === "symlink" ? 0x32 : 0x31;
  if (input.link) header.write(input.link, 157, 100, "utf8");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  Buffer.from(`${checksum.toString(8).padStart(6, "0")}\0 `, "ascii").copy(header, 148);
  return header;
}

function makeTarGz(
  entries: ReadonlyArray<{
    readonly path: string;
    readonly type?: "file" | "directory" | "symlink" | "hardlink";
    readonly bytes?: Buffer;
    readonly mode?: number;
    readonly link?: string;
  }>,
): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(tarHeader(entry));
    if (entry.bytes) {
      parts.push(entry.bytes);
      const padding = (512 - (entry.bytes.byteLength % 512)) % 512;
      if (padding) parts.push(Buffer.alloc(padding));
    }
  }
  parts.push(Buffer.alloc(1024));
  return NodeZlib.gzipSync(Buffer.concat(parts), { level: 9 });
}

function distributionMetadata(sourceCommit: string, sourceTree: string) {
  return {
    schemaVersion: 1,
    repository: PRIME_DISTRIBUTION_REPOSITORY_URL,
    sourceCommit,
    sourceTree,
    buildId: `pylon-build-g${sourceCommit.slice(0, 12)}-r1`,
    recipeRevision: 1,
    node: "22.23.2",
    npm: "11.10.1",
    packageLockSha256: "e".repeat(64),
  };
}

function safeRootTarball(sourceCommit: string, sourceTree: string, version = "1.0.0"): Buffer {
  const packageJson = Buffer.from(
    `${JSON.stringify({
      name: "prime-agent",
      version,
      type: "module",
      bin: { "prime-agent": "dist/bundle/cli.js" },
      scripts: { postinstall: "node postinstall.cjs" },
      pylonDistribution: distributionMetadata(sourceCommit, sourceTree),
    })}\n`,
  );
  return makeTarGz([
    { path: "package/", type: "directory", mode: 0o755 },
    { path: "package/package.json", bytes: packageJson, mode: 0o644 },
    { path: "package/postinstall.cjs", bytes: Buffer.from("throw new Error('must-not-run');\n") },
    { path: "package/dist/", type: "directory", mode: 0o755 },
    { path: "package/dist/bundle/", type: "directory", mode: 0o755 },
    {
      path: "package/dist/bundle/cli.js",
      bytes: Buffer.from("#!/usr/bin/env node\nconsole.log('safe fixture');\n"),
      mode: 0o755,
    },
  ]);
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

const acceptedLocalVerifier = {
  verifyBundle: async (_bundle: unknown, expected: ExpectedPrimeAttestation) => {
    const statement = statementFor(expected);
    assertPrimeAttestationBinding(statement, expected);
    return statement;
  },
  verifySourcePolicy: async () => {},
};

async function publicationBundle(
  input: {
    readonly channel?: "stable" | "preview";
    readonly sequence?: number;
    readonly commitDigit?: string;
    readonly rootBytes?: Buffer;
  } = {},
): Promise<PrimeManagedPublicationBundle> {
  const channel = input.channel ?? "stable";
  const sequence = input.sequence ?? 1;
  const commitDigit = input.commitDigit ?? "a";
  const sourceCommit = commitDigit.repeat(40);
  const sourceTree = (commitDigit === "f" ? "e" : "f").repeat(40);
  const policyCommit = "c".repeat(40);
  const buildId = `pylon-build-g${sourceCommit.slice(0, 12)}-r1`;
  const version = "1.0.0";
  const rootBytes = input.rootBytes ?? safeRootTarball(sourceCommit, sourceTree, version);
  const artifactBytes = new Map([
    [`pylon-prime-agent-${version}.tgz`, rootBytes],
    [`pylon-prime-agent-ai-${version}.tgz`, Buffer.from(`ai-${commitDigit}`)],
    [`pylon-prime-agent-core-${version}.tgz`, Buffer.from(`core-${commitDigit}`)],
    [`pylon-prime-agent-tui-${version}.tgz`, Buffer.from(`tui-${commitDigit}`)],
  ]);
  const packages = new Map([
    [`pylon-prime-agent-${version}.tgz`, "prime-agent"],
    [`pylon-prime-agent-ai-${version}.tgz`, "@earendil-works/pi-ai"],
    [`pylon-prime-agent-core-${version}.tgz`, "@earendil-works/pi-agent-core"],
    [`pylon-prime-agent-tui-${version}.tgz`, "@earendil-works/pi-tui"],
  ]);
  const assets = [...artifactBytes]
    .map(([file, bytes]) => ({
      package: packages.get(file)!,
      file,
      size: bytes.byteLength,
      sha256: digest("sha256", bytes),
      sha512: digest("sha512", bytes),
    }))
    .toSorted((left, right) => left.file.localeCompare(right.file));
  const source = {
    repository: PRIME_DISTRIBUTION_REPOSITORY_URL,
    commit: sourceCommit,
    tree: sourceTree,
  };
  const releaseManifest = {
    schemaVersion: 1,
    source,
    build: {
      id: buildId,
      recipeRevision: 1,
      node: "22.23.2",
      npm: "11.10.1",
      lockfile: { file: "package-lock.json", sha256: "e".repeat(64) },
      assetBaseUrl: `${PRIME_DISTRIBUTION_REPOSITORY_URL}/releases/download/${buildId}`,
    },
    package: { name: "prime-agent", command: "prime-agent", version, minimumNode: "22.8.0" },
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
    sequence,
    workflowRunId: String(9000 + sequence),
    build: {
      tag: buildId,
      id: buildId,
      recipeRevision: 1,
      source,
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
    sequence,
    tag: `pylon-stable-${String(sequence).padStart(6, "0")}-g${sourceCommit.slice(0, 12)}-r1`,
    history: {
      highWater: sequence - 1,
      previous:
        sequence === 1
          ? null
          : {
              tag: `pylon-stable-${String(sequence - 1).padStart(6, "0")}-g${"b".repeat(12)}-r1`,
              sha256: "1".repeat(64),
            },
    },
    build: {
      previewSequence: {
        sequenceEpoch: 1,
        sequence,
        workflowRunId: String(9000 + sequence),
      },
      previewTag: buildId,
      id: buildId,
      recipeRevision: 1,
      publicationPolicyRevision: 1,
      source,
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
      policyCommit,
      policyTree: "d".repeat(40),
      publicationPolicyRevision: 1,
    },
    revocations: [],
  };
  const stableManifestBytes = Buffer.from(canonicalPrimeDistributionJson(stableManifest));
  const attestationBundlesBySubjectSha256 = new Map<string, ReadonlyArray<unknown>>();
  for (const subject of [
    ...assets.map((asset) => asset.sha256),
    digest("sha256", releaseManifestBytes),
    digest("sha256", previewManifestBytes),
    digest("sha256", stableManifestBytes),
  ]) {
    attestationBundlesBySubjectSha256.set(subject, [{ acceptedLocalProof: subject }]);
  }
  const fixture: PrimePublicationFixture = {
    channel,
    releaseManifestBytes,
    previewManifestBytes,
    ...(channel === "stable" ? { stableManifestBytes } : {}),
    rootArtifactBytes: rootBytes,
    attestationBundlesBySubjectSha256,
  };
  const publication = await verifyPrimePublicationFixture(fixture, acceptedLocalVerifier);
  return { publication, rootArtifactBytes: rootBytes };
}

async function makeHarness(
  input: {
    readonly bundle?: PrimeManagedPublicationBundle;
    readonly busy?: boolean;
    readonly installMode?: "seam" | "production";
    readonly crashAfterCommitOnce?: boolean;
    readonly installationBarrier?: () => Promise<void>;
  } = {},
) {
  const stateDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pylon-prime-managed-"));
  temporaryDirectories.push(stateDir);
  const stock = NodePath.join(stateDir, "stock-prime-agent");
  await NodeFSP.writeFile(stock, "stock-byte-for-byte\n", { mode: 0o755 });
  let currentBundle = input.bundle ?? (await publicationBundle());
  let loaderError: Error | undefined;
  let binding: PrimeManagedBinding = { binaryPath: stock, generation: "binding-0" };
  let busy = input.busy ?? false;
  let generation = 0;
  let crashAfterCommitOnce = input.crashAfterCommitOnce ?? false;
  const reservations = new Set<string>();
  const dependencies: PrimeManagedToolStoreDependencies = {
    loadLatestVerifiedPublication: async () => {
      if (loaderError) throw loaderError;
      return currentBundle;
    },
    readBinding: async () => binding,
    reserveQuiescentBinding: async (_instanceId, expected) => {
      if (
        expected.generation !== binding.generation ||
        expected.binaryPath !== binding.binaryPath
      ) {
        throw new Error("Provider binding changed before the maintenance fence was acquired.");
      }
      if (busy) return { status: "busy", reasons: ["active provider session"] };
      const token = `reservation-${generation}`;
      reservations.add(token);
      return { status: "reserved", reservation: { token } };
    },
    commitBinding: async ({ expected, binaryPath, reservation }) => {
      if (!reservations.has(reservation.token)) throw new Error("Missing exact maintenance fence.");
      if (
        expected.generation !== binding.generation ||
        expected.binaryPath !== binding.binaryPath
      ) {
        throw new Error("Provider binding changed while maintenance was fenced.");
      }
      generation += 1;
      binding = { binaryPath, generation: `binding-${generation}` };
      if (crashAfterCommitOnce) {
        crashAfterCommitOnce = false;
        throw new Error("simulated crash after binding CAS");
      }
      return binding;
    },
    releaseReservation: async ({ token }) => {
      reservations.delete(token);
    },
    ...(input.installMode === "production"
      ? {}
      : {
          installVerifiedArchive: async ({ extractedPackagePath, prefixPath }) => {
            await input.installationBarrier?.();
            const packageRoot = NodePath.join(prefixPath, "node_modules", "prime-agent");
            const binDirectory = NodePath.join(prefixPath, "node_modules", ".bin");
            await NodeFSP.mkdir(NodePath.dirname(packageRoot), { recursive: true });
            await NodeFSP.cp(extractedPackagePath, packageRoot, { recursive: true });
            await NodeFSP.chmod(NodePath.join(packageRoot, "dist", "bundle", "cli.js"), 0o755);
            await NodeFSP.mkdir(binDirectory, { recursive: true });
            await NodeFSP.symlink(
              "../prime-agent/dist/bundle/cli.js",
              NodePath.join(binDirectory, "prime-agent"),
            );
          },
        }),
    now: () => "2026-09-01T00:00:00.000Z",
  };
  const store = new PrimeAgentManagedToolStore({ stateDir, platform: "linux", dependencies });
  await store.initialize();
  return {
    stateDir,
    stock,
    store,
    get binding() {
      return binding;
    },
    setBundle(bundle: PrimeManagedPublicationBundle) {
      loaderError = undefined;
      currentBundle = bundle;
    },
    setOffline(message = "offline") {
      loaderError = new Error(message);
    },
    setBusy(value: boolean) {
      busy = value;
    },
    setExternalBinding(binaryPath: string) {
      generation += 1;
      binding = { binaryPath, generation: `binding-${generation}` };
    },
  };
}

function commandId(prefix: string): string {
  return `${prefix}-${NodeCrypto.randomBytes(5).toString("hex")}`;
}

describe("Pylon-managed Prime tool store", () => {
  it("installs stable by default, requires explicit preview opt-in, and never changes stock bytes", async () => {
    const harness = await makeHarness();
    const stockBefore = await NodeFSP.readFile(harness.stock);
    const installed = await harness.store.command({
      commandId: commandId("stable-install"),
      instanceId: "primeAgent",
      action: "install",
    });
    expect(installed).toMatchObject({ status: "succeeded", channel: "stable" });
    expect(harness.binding.binaryPath).toMatch(/node_modules\/\.bin\/prime-agent$/u);
    expect(await NodeFSP.readFile(harness.stock)).toEqual(stockBefore);
    expect(await harness.store.status("primeAgent")).toMatchObject({
      mode: "managed",
      selectedBuildId: installed.buildId,
    });

    const preview = await publicationBundle({ channel: "preview", sequence: 2, commitDigit: "b" });
    harness.setBundle(preview);
    await expect(
      harness.store.command({
        commandId: commandId("preview-missing-opt-in"),
        instanceId: "primeAgent",
        action: "update",
        channel: "preview",
      }),
    ).rejects.toThrow(/explicit preview opt-in/u);
    const accepted = await harness.store.command({
      commandId: commandId("preview-opt-in"),
      instanceId: "primeAgent",
      action: "update",
      channel: "preview",
      allowPreview: true,
    });
    expect(accepted).toMatchObject({ status: "succeeded", channel: "preview" });
    expect(await NodeFSP.readFile(harness.stock)).toEqual(stockBefore);
  });

  it("installs the verified bundled CLI offline without executing its lifecycle script", async () => {
    const harness = await makeHarness({ installMode: "production" });
    const receipt = await harness.store.command({
      commandId: "offline-layout",
      instanceId: "primeAgent",
      action: "install",
    });
    expect(receipt.status).toBe("succeeded");
    const launcher = await NodeFSP.readlink(harness.binding.binaryPath);
    expect(launcher).toBe("../prime-agent/dist/bundle/cli.js");
    const receiptTarget = await resolvePrimeManagedBuildReceiptTarget({
      stateDir: harness.stateDir,
      packageRoot: NodePath.join(NodePath.dirname(harness.binding.binaryPath), "..", "prime-agent"),
    });
    expect(receiptTarget).toMatchObject({
      instanceId: `managed-build:${receipt.buildId}`,
    });
    expect(
      await NodeFSP.readFile(
        NodePath.join(NodePath.dirname(harness.binding.binaryPath), launcher),
        "utf8",
      ),
    ).toContain("safe fixture");
  });

  it("publishes durable progress to other clients while installation is still running", async () => {
    let releaseInstallation!: () => void;
    const installationReleased = new Promise<void>((resolve) => {
      releaseInstallation = resolve;
    });
    let reportInstallStart!: () => void;
    const installStarted = new Promise<void>((resolve) => {
      reportInstallStart = resolve;
    });
    const harness = await makeHarness({
      installationBarrier: async () => {
        reportInstallStart();
        await installationReleased;
      },
    });
    const running = harness.store.command({
      commandId: "observable-progress",
      instanceId: "primeAgent",
      action: "install",
    });
    await installStarted;
    await expect(harness.store.status("primeAgent")).resolves.toMatchObject({
      operation: {
        commandId: "observable-progress",
        status: "installing",
      },
    });
    releaseInstallation();
    await expect(running).resolves.toMatchObject({ status: "succeeded" });
  });

  it("reconciles a crash after settings CAS from the durable selection journal", async () => {
    const harness = await makeHarness({ crashAfterCommitOnce: true });
    const interrupted = await harness.store.command({
      commandId: "crash-after-cas",
      instanceId: "primeAgent",
      action: "install",
    });
    expect(interrupted.status).toBe("failed");
    expect(harness.binding.binaryPath).toContain(interrupted.buildId!);

    await harness.store.initialize();
    const recovered = await harness.store.status("primeAgent");
    expect(recovered).toMatchObject({
      mode: "managed",
      selectedBuildId: interrupted.buildId,
      operation: { commandId: "crash-after-cas", status: "succeeded" },
    });
  });

  it("updates side by side, rolls back only to verified receipt-owned bytes, switches back, and prunes exact builds", async () => {
    const first = await publicationBundle({ sequence: 1, commitDigit: "a" });
    const harness = await makeHarness({ bundle: first });
    const stockBefore = await NodeFSP.readFile(harness.stock);
    const install = await harness.store.command({
      commandId: commandId("install"),
      instanceId: "primeAgent",
      action: "install",
    });
    const second = await publicationBundle({ sequence: 2, commitDigit: "b" });
    harness.setBundle(second);
    const update = await harness.store.command({
      commandId: commandId("update"),
      instanceId: "primeAgent",
      action: "update",
    });
    expect(update.buildId).not.toBe(install.buildId);
    expect((await harness.store.status("primeAgent")).availableBuilds).toHaveLength(2);

    const rollback = await harness.store.command({
      commandId: commandId("rollback"),
      instanceId: "primeAgent",
      action: "rollback",
      buildId: install.buildId!,
    });
    expect(rollback).toMatchObject({ status: "succeeded", buildId: install.buildId });
    expect(harness.binding.binaryPath).toContain(install.buildId!);

    const stock = await harness.store.command({
      commandId: commandId("stock"),
      instanceId: "primeAgent",
      action: "use-stock",
    });
    expect(stock.status).toBe("succeeded");
    expect(harness.binding.binaryPath).toBe(harness.stock);
    expect(await NodeFSP.readFile(harness.stock)).toEqual(stockBefore);

    const cleanup = await harness.store.command({
      commandId: commandId("cleanup"),
      instanceId: "primeAgent",
      action: "cleanup",
    });
    expect(cleanup.status).toBe("succeeded");
    expect((await harness.store.status("primeAgent")).availableBuilds).toEqual([]);
    await expect(
      harness.store.command({
        commandId: commandId("rollback-pruned"),
        instanceId: "primeAgent",
        action: "rollback",
        buildId: install.buildId!,
      }),
    ).resolves.toMatchObject({ status: "failed" });
    expect(await NodeFSP.readFile(harness.stock)).toEqual(stockBefore);
  });

  it("treats an external provider-path edit as the new configured stock binding", async () => {
    const harness = await makeHarness();
    const installed = await harness.store.command({
      commandId: "managed-before-external-edit",
      instanceId: "primeAgent",
      action: "install",
    });
    const custom = NodePath.join(harness.stateDir, "custom-prime-agent");
    await NodeFSP.writeFile(custom, "custom-stock-bytes\n", { mode: 0o755 });
    harness.setExternalBinding(custom);

    await expect(
      harness.store.command({
        commandId: "stock-after-external-edit",
        instanceId: "primeAgent",
        action: "use-stock",
      }),
    ).resolves.toMatchObject({ status: "succeeded" });
    expect(harness.binding.binaryPath).toBe(custom);

    await expect(
      harness.store.command({
        commandId: "rollback-after-external-edit",
        instanceId: "primeAgent",
        action: "rollback",
        buildId: installed.buildId!,
      }),
    ).resolves.toMatchObject({ status: "succeeded" });
    await harness.store.command({
      commandId: "restore-new-custom-stock",
      instanceId: "primeAgent",
      action: "use-stock",
    });
    expect(harness.binding.binaryPath).toBe(custom);
  });

  it("schedules an exact binding while busy and commits after the instance drains", async () => {
    const harness = await makeHarness({ busy: true });
    const scheduled = await harness.store.command({
      commandId: "busy-update",
      instanceId: "primeAgent",
      action: "install",
    });
    expect(scheduled.status).toBe("waiting-for-quiescence");
    expect(harness.binding.binaryPath).toBe(harness.stock);
    expect((await harness.store.status("primeAgent")).scheduled).toMatchObject({
      commandId: "busy-update",
    });

    harness.setBusy(false);
    const drained = await harness.store.drain("primeAgent");
    expect(drained).toMatchObject({ commandId: "busy-update", status: "succeeded" });
    expect(harness.binding.binaryPath).toContain(drained!.buildId!);
    expect((await harness.store.status("primeAgent")).scheduled).toBeNull();
  });

  it("supersedes an older scheduled switch with the latest explicit command", async () => {
    const harness = await makeHarness({ busy: true });
    const first = await harness.store.command({
      commandId: "scheduled-first",
      instanceId: "primeAgent",
      action: "install",
    });
    expect(first.status).toBe("waiting-for-quiescence");
    const second = await harness.store.command({
      commandId: "scheduled-latest",
      instanceId: "primeAgent",
      action: "update",
    });
    expect(second.status).toBe("waiting-for-quiescence");
    const status = await harness.store.status("primeAgent");
    expect(status.scheduled?.commandId).toBe("scheduled-latest");
    expect(status.operation).toMatchObject({ commandId: "scheduled-latest" });
    await expect(
      harness.store.command({
        commandId: "scheduled-first",
        instanceId: "primeAgent",
        action: "install",
      }),
    ).resolves.toMatchObject({ status: "failed", message: expect.stringContaining("superseded") });
  });

  it("recovers download/extraction leftovers without selecting partial bytes", async () => {
    const stateDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pylon-prime-crash-"));
    temporaryDirectories.push(stateDir);
    const root = NodePath.join(stateDir, ...PRIME_MANAGED_TOOL_DIRECTORY.split("/"));
    await NodeFSP.mkdir(NodePath.join(root, ".staging-crashed", "partial"), {
      recursive: true,
      mode: 0o700,
    });
    await NodeFSP.mkdir(NodePath.join(root, `pylon-build-g${"a".repeat(12)}-r1`, "partial"), {
      recursive: true,
      mode: 0o700,
    });
    let io = 0;
    const binding = { binaryPath: "/stock", generation: "0" };
    const store = new PrimeAgentManagedToolStore({
      stateDir,
      platform: "linux",
      dependencies: {
        loadLatestVerifiedPublication: async () => {
          io += 1;
          throw new Error("not used");
        },
        readBinding: async () => binding,
        reserveQuiescentBinding: async () => ({ status: "busy", reasons: [] }),
        commitBinding: async () => binding,
        releaseReservation: async () => {},
      },
    });
    await store.initialize();
    expect(await NodeFSP.readdir(root)).not.toContain(".staging-crashed");
    expect(await NodeFSP.readdir(root)).not.toContain(`pylon-build-g${"a".repeat(12)}-r1`);
    expect((await store.status("primeAgent")).selectedBuildId).toBeNull();
    expect(io).toBe(0);
  });

  it.each([
    {
      name: "path traversal",
      archive: () => makeTarGz([{ path: "package/../escape", bytes: Buffer.from("x") }]),
      message: /escapes|violates/u,
    },
    {
      name: "symlink",
      archive: () => makeTarGz([{ path: "package/link", type: "symlink", link: "/tmp/outside" }]),
      message: /symlink|unsupported/u,
    },
    {
      name: "hardlink",
      archive: () => makeTarGz([{ path: "package/link", type: "hardlink", link: "package.json" }]),
      message: /hardlink|unsupported/u,
    },
    {
      name: "case collision",
      archive: () =>
        makeTarGz([
          { path: "package/File", bytes: Buffer.from("a") },
          { path: "package/file", bytes: Buffer.from("b") },
        ]),
      message: /case-colliding/u,
    },
    {
      name: "wrong package",
      archive: () => {
        const commit = "a".repeat(40);
        const tree = "f".repeat(40);
        return makeTarGz([
          { path: "package/", type: "directory" },
          {
            path: "package/package.json",
            bytes: Buffer.from(
              JSON.stringify({
                name: "not-prime-agent",
                version: "1.0.0",
                bin: { "prime-agent": "dist/bundle/cli.js" },
                pylonDistribution: distributionMetadata(commit, tree),
              }),
            ),
          },
          { path: "package/dist/bundle/cli.js", bytes: Buffer.from("safe"), mode: 0o755 },
        ]);
      },
      message: /wrong package/u,
    },
    {
      name: "wrong bin",
      archive: () => {
        const commit = "a".repeat(40);
        const tree = "f".repeat(40);
        return makeTarGz([
          { path: "package/", type: "directory" },
          {
            path: "package/package.json",
            bytes: Buffer.from(
              JSON.stringify({
                name: "prime-agent",
                version: "1.0.0",
                bin: { prime: "attack.js" },
                pylonDistribution: distributionMetadata(commit, tree),
              }),
            ),
          },
          { path: "package/attack.js", bytes: Buffer.from("attack"), mode: 0o755 },
        ]);
      },
      message: /binary identity/u,
    },
    {
      name: "unexpected install script",
      archive: () => {
        const commit = "a".repeat(40);
        const tree = "f".repeat(40);
        return makeTarGz([
          { path: "package/", type: "directory" },
          {
            path: "package/package.json",
            bytes: Buffer.from(
              JSON.stringify({
                name: "prime-agent",
                version: "1.0.0",
                bin: { "prime-agent": "dist/bundle/cli.js" },
                scripts: { preinstall: "node attack.js" },
                pylonDistribution: distributionMetadata(commit, tree),
              }),
            ),
          },
          { path: "package/dist/bundle/cli.js", bytes: Buffer.from("safe") },
        ]);
      },
      message: /unexpected install script/u,
    },
  ])(
    "rejects a cryptographically accepted malicious archive: $name",
    async ({ archive, message }) => {
      const bundle = await publicationBundle({ rootBytes: archive() });
      const harness = await makeHarness({ bundle });
      const result = await harness.store.command({
        commandId: commandId("malicious"),
        instanceId: "primeAgent",
        action: "install",
      });
      expect(result.status).toBe("failed");
      expect(result.message).toMatch(message);
      expect(harness.binding.binaryPath).toBe(harness.stock);
      expect((await harness.store.status("primeAgent")).availableBuilds).toEqual([]);
    },
  );

  it("rejects digest mismatch and signed replay, while offline failure keeps the selected verified build", async () => {
    const current = await publicationBundle({ sequence: 2, commitDigit: "b" });
    const harness = await makeHarness({ bundle: current });
    const installed = await harness.store.command({
      commandId: commandId("install-current"),
      instanceId: "primeAgent",
      action: "install",
    });
    const selectedPath = harness.binding.binaryPath;

    const tampered = {
      ...current,
      rootArtifactBytes: Buffer.from("tampered after verification"),
    };
    harness.setBundle(tampered);
    const digestFailure = await harness.store.command({
      commandId: commandId("tampered"),
      instanceId: "primeAgent",
      action: "update",
    });
    expect(digestFailure).toMatchObject({ status: "failed" });
    expect(digestFailure.message).toMatch(/digest/u);

    harness.setBundle(await publicationBundle({ sequence: 1, commitDigit: "a" }));
    const replay = await harness.store.command({
      commandId: commandId("replay"),
      instanceId: "primeAgent",
      action: "update",
    });
    expect(replay).toMatchObject({ status: "failed" });
    expect(replay.message).toMatch(/replay|downgrade/u);
    expect(harness.binding.binaryPath).toBe(selectedPath);
    expect((await harness.store.status("primeAgent")).selectedBuildId).toBe(installed.buildId);

    harness.setOffline("offline");
    const offline = await harness.store.command({
      commandId: commandId("offline"),
      instanceId: "primeAgent",
      action: "update",
    });
    expect(offline).toMatchObject({ status: "failed" });
    expect(offline.message).toMatch(/offline/u);
    expect(harness.binding.binaryPath).toBe(selectedPath);
    expect((await harness.store.status("primeAgent")).selectedBuildId).toBe(installed.buildId);
  });

  it("keeps a verified newer channel high-water when its archive fails safe installation", async () => {
    const sourceCommit = "d".repeat(40);
    const sourceTree = "f".repeat(40);
    const invalidRoot = makeTarGz([
      { path: "package/", type: "directory", mode: 0o755 },
      {
        path: "package/package.json",
        bytes: Buffer.from(
          JSON.stringify({
            name: "wrong-signed-package",
            version: "1.0.0",
            bin: { "prime-agent": "dist/bundle/cli.js" },
            pylonDistribution: distributionMetadata(sourceCommit, sourceTree),
          }),
        ),
      },
    ]);
    const newer = await publicationBundle({
      sequence: 3,
      commitDigit: "d",
      rootBytes: invalidRoot,
    });
    const harness = await makeHarness({ bundle: newer });
    await expect(
      harness.store.command({
        commandId: "newer-invalid-archive",
        instanceId: "primeAgent",
        action: "install",
      }),
    ).resolves.toMatchObject({ status: "failed" });

    harness.setBundle(await publicationBundle({ sequence: 2, commitDigit: "b" }));
    await expect(
      harness.store.command({
        commandId: "older-after-invalid",
        instanceId: "primeAgent",
        action: "install",
      }),
    ).resolves.toMatchObject({
      status: "failed",
      message: expect.stringMatching(/replay|downgrade/u),
    });
    expect(harness.binding.binaryPath).toBe(harness.stock);
  });

  it("deduplicates the same multi-client command and rejects command-id collisions", async () => {
    const harness = await makeHarness();
    const input = {
      commandId: "shared-command",
      instanceId: "primeAgent",
      action: "install" as const,
    };
    const [left, right] = await Promise.all([
      harness.store.command(input),
      harness.store.command(input),
    ]);
    expect(left).toEqual(right);
    expect((await harness.store.status("primeAgent")).availableBuilds).toHaveLength(1);
    await expect(harness.store.command({ ...input, action: "use-stock" })).rejects.toThrow(
      /reused with different input/u,
    );
  });

  it("does zero download/install/runtime IO on native Windows and gives exact WSL2 guidance", async () => {
    const stateDir = NodePath.join(NodeOS.tmpdir(), `pylon-native-win-${NodeCrypto.randomUUID()}`);
    let io = 0;
    expect(
      () =>
        new PrimeAgentManagedToolStore({
          stateDir,
          platform: "win32",
          dependencies: {
            loadLatestVerifiedPublication: async () => {
              io += 1;
              throw new Error("must not run");
            },
            readBinding: async () => {
              io += 1;
              return { binaryPath: "prime-agent", generation: "0" };
            },
            reserveQuiescentBinding: async () => {
              io += 1;
              return { status: "busy", reasons: [] };
            },
            commitBinding: async () => {
              io += 1;
              return { binaryPath: "prime-agent", generation: "0" };
            },
            releaseReservation: async () => {
              io += 1;
            },
          },
        }),
    ).toThrow(/WSL2.*no download or install/u);
    expect(io).toBe(0);
    await expect(NodeFSP.lstat(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
