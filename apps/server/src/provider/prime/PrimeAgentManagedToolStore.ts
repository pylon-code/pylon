// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalDate:off
import type { ServerProviderDistributionChannel } from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

import {
  inspectPrimeAgentDistribution,
  persistPrimeManagedReceipt,
  type VerifiedPrimePublication,
} from "./PrimeAgentDistributionVerifier.ts";

export const PRIME_MANAGED_TOOL_DIRECTORY = "provider-tools/prime-agent";
export const PRIME_MANAGED_STATE_FILE = "managed-tool-state-v1.json";
export const PRIME_MANAGED_BUILD_FILE = "pylon-managed-build-v1.json";

const BUILD_ID = /^pylon-build-g[0-9a-f]{12}-r[1-9][0-9]*$/u;
const PACKAGE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const ROOT_ASSET = /^pylon-prime-agent-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.tgz$/u;
const COMMAND_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_ROOT_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 768 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 30_000;
const MAX_ARCHIVE_FILE_BYTES = 128 * 1024 * 1024;
const MAX_ARCHIVE_PATH_BYTES = 512;
const MAX_PACKAGE_JSON_BYTES = 256 * 1024;
const MAX_STORED_OPERATIONS = 512;
const RECEIPT_STATE_DIRECTORY = ".pylon-managed-receipt";
const RECEIPT_INSTANCE_PREFIX = "managed-build:";
const STAGING_PREFIX = ".staging-";

export type PrimeManagedAction = "install" | "update" | "rollback" | "use-stock" | "cleanup";
export type PrimeManagedOperationStatus =
  | "queued"
  | "downloading"
  | "verifying"
  | "installing"
  | "waiting-for-quiescence"
  | "switching"
  | "succeeded"
  | "failed";

export interface PrimeManagedBinding {
  readonly binaryPath: string;
  /** An opaque generation over the complete provider binding, not only binaryPath. */
  readonly generation: string;
}

export interface PrimeManagedReservation {
  readonly token: string;
}

export type PrimeManagedReservationResult =
  | { readonly status: "reserved"; readonly reservation: PrimeManagedReservation }
  | { readonly status: "busy"; readonly reasons: ReadonlyArray<string> };

export interface PrimeManagedPublicationBundle {
  readonly publication: VerifiedPrimePublication;
  readonly rootArtifactBytes: Buffer;
}

export interface PrimeManagedToolStoreDependencies {
  readonly loadLatestVerifiedPublication: (
    channel: ServerProviderDistributionChannel,
  ) => Promise<PrimeManagedPublicationBundle>;
  readonly readBinding: (instanceId: string) => Promise<PrimeManagedBinding>;
  /**
   * The reservation must atomically fence new admissions/session starts for the instance, then
   * prove that it has no active or pending admission, turn, session, owned process, or SDK context.
   */
  readonly reserveQuiescentBinding: (
    instanceId: string,
    expected: PrimeManagedBinding,
  ) => Promise<PrimeManagedReservationResult>;
  /** Compare-and-set the complete expected binding while the quiescence fence is held. */
  readonly commitBinding: (input: {
    readonly instanceId: string;
    readonly expected: PrimeManagedBinding;
    readonly binaryPath: string;
    readonly reservation: PrimeManagedReservation;
  }) => Promise<PrimeManagedBinding>;
  readonly releaseReservation: (reservation: PrimeManagedReservation) => Promise<void>;
  /** Test seam. Production builds an offline layout directly from the verified bundled CLI. */
  readonly installVerifiedArchive?: (input: {
    readonly archivePath: string;
    readonly extractedPackagePath: string;
    readonly prefixPath: string;
    readonly publication: VerifiedPrimePublication;
  }) => Promise<void>;
  readonly now?: () => string;
}

export interface PrimeManagedCommandInput {
  readonly commandId: string;
  readonly instanceId: string;
  readonly action: PrimeManagedAction;
  readonly channel?: ServerProviderDistributionChannel;
  readonly allowPreview?: boolean;
  readonly buildId?: string;
  readonly scheduleIfBusy?: boolean;
}

export interface PrimeManagedCommandReceipt {
  readonly commandId: string;
  readonly instanceId: string;
  readonly action: PrimeManagedAction;
  readonly status: PrimeManagedOperationStatus;
  readonly channel: ServerProviderDistributionChannel | null;
  readonly buildId: string | null;
  readonly message: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

export interface PrimeManagedInstalledBuild {
  readonly buildId: string;
  readonly channel: ServerProviderDistributionChannel;
  readonly sequence: number;
  readonly binaryPath: string;
  readonly packageRoot: string;
}

export interface PrimeManagedInstanceStatus {
  readonly instanceId: string;
  readonly mode: "stock" | "managed";
  readonly selectedBuildId: string | null;
  readonly channel: ServerProviderDistributionChannel | null;
  readonly availableBuilds: ReadonlyArray<PrimeManagedInstalledBuild>;
  readonly scheduled: PrimeManagedCommandReceipt | null;
  readonly operation: PrimeManagedCommandReceipt | null;
  readonly message: string;
}

interface StoredSelection {
  readonly mode: "stock" | "managed";
  readonly selectedBuildId: string | null;
  readonly channel: ServerProviderDistributionChannel | null;
  readonly stockBinaryPath: string;
  readonly binding: PrimeManagedBinding;
}

interface StoredScheduled {
  readonly commandId: string;
  readonly instanceId: string;
  readonly action: PrimeManagedAction;
  readonly expected: PrimeManagedBinding;
  readonly targetBinaryPath: string;
  readonly buildId: string | null;
  readonly channel: ServerProviderDistributionChannel | null;
}

interface StoredHighWater {
  readonly sequenceEpoch: 1;
  readonly sequence: number;
  readonly buildId: string;
}

interface StoredSelectionIntent {
  readonly commandId: string;
  readonly instanceId: string;
  readonly action: PrimeManagedAction;
  readonly expected: PrimeManagedBinding;
  readonly targetBinaryPath: string;
  readonly stockBinaryPath: string;
  readonly buildId: string | null;
  readonly channel: ServerProviderDistributionChannel | null;
}

interface StoredState {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly selections: Record<string, StoredSelection>;
  readonly selectionIntents: Record<string, StoredSelectionIntent>;
  readonly scheduled: Record<string, StoredScheduled>;
  readonly operations: Record<
    string,
    PrimeManagedCommandReceipt & { readonly fingerprint: string }
  >;
  readonly latestOperationIds: Record<string, string>;
  readonly highWater: Partial<Record<ServerProviderDistributionChannel, StoredHighWater>>;
}

interface BuildMarker {
  readonly schemaVersion: 1;
  readonly buildId: string;
  readonly channel: ServerProviderDistributionChannel;
  readonly sequenceEpoch: 1;
  readonly sequence: number;
  readonly rootSha256: string;
  readonly packageRoot: string;
  readonly binaryPath: string;
}

interface TarEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly mode: number;
  readonly bytes?: Buffer;
}

function emptyState(): StoredState {
  return {
    schemaVersion: 1,
    revision: 0,
    selections: {},
    selectionIntents: {},
    scheduled: {},
    operations: {},
    latestOperationIds: {},
    highWater: {},
  };
}

function sha256(value: NodeJS.ArrayBufferView | string): string {
  return NodeCrypto.createHash("sha256").update(value).digest("hex");
}

function isErrno(cause: unknown, code: string): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as { readonly code?: unknown }).code === code
  );
}

function stableJson(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (input === null || typeof input === "string" || typeof input === "boolean") return input;
    if (typeof input === "number" && Number.isFinite(input)) return input;
    if (Array.isArray(input)) return input.map(canonical);
    if (typeof input !== "object") throw new Error("Managed Prime state is not JSON data.");
    return Object.fromEntries(
      Object.entries(input as Readonly<Record<string, unknown>>)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  };
  return `${JSON.stringify(canonical(value), null, 2)}\n`;
}

function validateCommand(input: PrimeManagedCommandInput): void {
  if (!COMMAND_ID.test(input.commandId))
    throw new Error("Prime maintenance command id is invalid.");
  if (!input.instanceId.trim()) throw new Error("Prime provider instance id is required.");
  if (input.channel === "preview" && input.allowPreview !== true) {
    throw new Error("Prime preview builds require explicit preview opt-in.");
  }
  if (input.allowPreview === true && input.channel !== "preview") {
    throw new Error("Preview opt-in is valid only with the preview channel.");
  }
  if (input.action === "rollback" && (!input.buildId || !BUILD_ID.test(input.buildId))) {
    throw new Error("Prime rollback requires an exact verified managed build id.");
  }
  if (input.action !== "rollback" && input.buildId !== undefined) {
    throw new Error("A build id is accepted only for explicit rollback.");
  }
  if (
    (input.action === "use-stock" || input.action === "cleanup" || input.action === "rollback") &&
    input.channel !== undefined
  ) {
    throw new Error(`Prime ${input.action} does not accept a channel.`);
  }
}

function commandFingerprint(input: PrimeManagedCommandInput): string {
  return sha256(stableJson(input));
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await NodeFSP.mkdir(path, { recursive: true, mode: 0o700 });
  const info = await NodeFSP.lstat(path);
  const uid = process.getuid?.();
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (uid !== undefined && info.uid !== uid) ||
    (info.mode & 0o077) !== 0
  ) {
    throw new Error(`Managed Prime directory is not a private real directory: ${path}`);
  }
}

async function readBoundedRegularFile(path: string, maxBytes: number): Promise<Buffer | undefined> {
  let handle: NodeFSP.FileHandle;
  try {
    handle = await NodeFSP.open(
      path,
      NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0),
    );
  } catch (cause) {
    if (isErrno(cause, "ENOENT")) return undefined;
    throw cause;
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(maxBytes)) {
      throw new Error(`Managed Prime file is not one bounded regular file: ${path}`);
    }
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const read = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (read.bytesRead === 0) throw new Error(`Managed Prime file was truncated: ${path}`);
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
      throw new Error(`Managed Prime file changed while it was read: ${path}`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await NodeFSP.open(path, NodeFS.constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeJsonAtomically(directory: string, file: string, value: unknown): Promise<void> {
  const temporary = NodePath.join(
    directory,
    `.${file}.${process.pid}.${NodeCrypto.randomBytes(10).toString("hex")}.tmp`,
  );
  const target = NodePath.join(directory, file);
  const handle = await NodeFSP.open(
    temporary,
    NodeFS.constants.O_WRONLY | NodeFS.constants.O_CREAT | NodeFS.constants.O_EXCL,
    0o600,
  );
  try {
    await handle.writeFile(stableJson(value), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await NodeFSP.rename(temporary, target);
    await syncDirectory(directory);
  } catch (cause) {
    await NodeFSP.rm(temporary, { force: true });
    throw cause;
  }
}

function decodeStoredState(value: unknown): StoredState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Managed Prime state is not an object.");
  }
  const state = value as Partial<StoredState>;
  if (
    state.schemaVersion !== 1 ||
    !Number.isSafeInteger(state.revision) ||
    typeof state.selections !== "object" ||
    state.selections === null ||
    (state.selectionIntents !== undefined &&
      (typeof state.selectionIntents !== "object" || state.selectionIntents === null)) ||
    typeof state.scheduled !== "object" ||
    state.scheduled === null ||
    typeof state.operations !== "object" ||
    state.operations === null ||
    (state.latestOperationIds !== undefined &&
      (typeof state.latestOperationIds !== "object" || state.latestOperationIds === null)) ||
    typeof state.highWater !== "object" ||
    state.highWater === null
  ) {
    throw new Error("Managed Prime state has an unsupported schema.");
  }
  return {
    ...(state as StoredState),
    selectionIntents: state.selectionIntents ?? {},
    latestOperationIds: state.latestOperationIds ?? {},
  };
}

async function gunzipBounded(bytes: Buffer): Promise<Buffer> {
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_ROOT_ARCHIVE_BYTES) {
    throw new Error("Prime root tarball exceeds its bounded compressed size.");
  }
  return await new Promise<Buffer>((resolve, reject) => {
    const gunzip = NodeZlib.createGunzip();
    const chunks: Buffer[] = [];
    let total = 0;
    gunzip.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > MAX_UNCOMPRESSED_BYTES) {
        gunzip.destroy(new Error("Prime root tarball exceeds its bounded expanded size."));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    gunzip.once("error", reject);
    gunzip.once("end", () => resolve(Buffer.concat(chunks, total)));
    gunzip.end(bytes);
  });
}

function tarString(block: Buffer, offset: number, length: number): string {
  const slice = block.subarray(offset, offset + length);
  const zero = slice.indexOf(0);
  return slice.subarray(0, zero < 0 ? slice.length : zero).toString("utf8");
}

function tarNumber(block: Buffer, offset: number, length: number, field: string): number {
  const text = tarString(block, offset, length).trim();
  if (!/^[0-7]+$/u.test(text)) throw new Error(`Prime tarball has an invalid ${field}.`);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Prime tarball has an out-of-range ${field}.`);
  }
  return value;
}

function verifyTarChecksum(block: Buffer): void {
  const recorded = tarNumber(block, 148, 8, "header checksum");
  let sum = 0;
  for (let index = 0; index < block.length; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : block[index]!;
  }
  if (sum !== recorded) throw new Error("Prime tarball header checksum is invalid.");
}

function safeArchivePath(raw: string): string {
  if (!raw || Buffer.byteLength(raw) > MAX_ARCHIVE_PATH_BYTES || raw.includes("\\")) {
    throw new Error("Prime tarball contains an invalid path.");
  }
  if (raw.startsWith("/") || /^[A-Za-z]:/u.test(raw) || raw.includes("\0")) {
    throw new Error("Prime tarball contains an absolute path.");
  }
  const parts = raw.split("/").filter((part) => part.length > 0);
  if (
    parts.length < 1 ||
    parts[0] !== "package" ||
    parts.some((part) => part === "." || part === ".." || part.normalize("NFC") !== part)
  ) {
    throw new Error("Prime tarball path escapes or violates its one package root.");
  }
  return parts.join("/");
}

async function parsePrimeTarball(bytes: Buffer): Promise<ReadonlyArray<TarEntry>> {
  const tar = await gunzipBounded(bytes);
  const entries: TarEntry[] = [];
  const collisionKeys = new Map<string, string>();
  let offset = 0;
  let zeroBlocks = 0;
  let expandedFiles = 0;
  while (offset + 512 <= tar.byteLength) {
    const block = tar.subarray(offset, offset + 512);
    offset += 512;
    if (block.every((byte) => byte === 0)) {
      zeroBlocks += 1;
      if (zeroBlocks >= 2) break;
      continue;
    }
    if (zeroBlocks !== 0) throw new Error("Prime tarball contains data after an end marker.");
    verifyTarChecksum(block);
    const name = tarString(block, 0, 100);
    const prefix = tarString(block, 345, 155);
    const path = safeArchivePath(prefix ? `${prefix}/${name}` : name);
    const type = block[156] ?? 0;
    const kind = type === 0 || type === 0x30 ? "file" : type === 0x35 ? "directory" : undefined;
    if (!kind) {
      throw new Error(
        "Prime tarball contains a symlink, hardlink, device, extension, or other unsupported entry.",
      );
    }
    const mode = tarNumber(block, 100, 8, "mode");
    if ((mode & ~0o777) !== 0) throw new Error("Prime tarball contains privileged mode bits.");
    const size = tarNumber(block, 124, 12, "entry size");
    if (kind === "directory" && size !== 0) {
      throw new Error("Prime tarball directory contains bytes.");
    }
    if (size > MAX_ARCHIVE_FILE_BYTES || offset + size > tar.byteLength) {
      throw new Error("Prime tarball entry exceeds its bounded size.");
    }
    expandedFiles += size;
    if (expandedFiles > MAX_UNCOMPRESSED_BYTES || entries.length >= MAX_ARCHIVE_ENTRIES) {
      throw new Error("Prime tarball exceeds its bounded entry set.");
    }
    const collisionKey = path.normalize("NFC").toLocaleLowerCase("en-US");
    const prior = collisionKeys.get(collisionKey);
    if (prior !== undefined) {
      throw new Error(`Prime tarball contains a duplicate or case-colliding path: ${prior}`);
    }
    collisionKeys.set(collisionKey, path);
    entries.push({
      path,
      kind,
      mode,
      ...(kind === "file" ? { bytes: Buffer.from(tar.subarray(offset, offset + size)) } : {}),
    });
    offset += Math.ceil(size / 512) * 512;
  }
  if (zeroBlocks < 2 || tar.subarray(offset).some((byte) => byte !== 0)) {
    throw new Error("Prime tarball has no exact zero-padded end marker.");
  }
  return entries;
}

function packageManifestFromEntries(entries: ReadonlyArray<TarEntry>): {
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly cliPath: string;
} {
  const packageJson = entries.find(
    (entry) => entry.path === "package/package.json" && entry.kind === "file",
  );
  if (!packageJson?.bytes || packageJson.bytes.byteLength > MAX_PACKAGE_JSON_BYTES) {
    throw new Error("Prime tarball lacks one bounded package.json.");
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(packageJson.bytes.toString("utf8")) as unknown;
  } catch (cause) {
    throw new Error("Prime tarball package.json is invalid JSON.", { cause });
  }
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    throw new Error("Prime tarball package.json is not an object.");
  }
  const record = manifest as Readonly<Record<string, unknown>>;
  const bin = record.bin;
  if (
    record.name !== "prime-agent" ||
    typeof record.version !== "string" ||
    typeof record.pylonDistribution !== "object" ||
    record.pylonDistribution === null ||
    typeof bin !== "object" ||
    bin === null ||
    Array.isArray(bin) ||
    Object.keys(bin).length !== 1 ||
    (bin as Readonly<Record<string, unknown>>)["prime-agent"] !== "dist/bundle/cli.js"
  ) {
    throw new Error("Prime tarball has the wrong package or prime-agent binary identity.");
  }
  const scripts = record.scripts;
  if (scripts !== undefined) {
    if (
      typeof scripts !== "object" ||
      scripts === null ||
      Array.isArray(scripts) ||
      Object.keys(scripts).length !== 1 ||
      (scripts as Readonly<Record<string, unknown>>).postinstall !== "node postinstall.cjs"
    ) {
      throw new Error("Prime tarball contains an unexpected install script.");
    }
    if (
      !entries.some((entry) => entry.path === "package/postinstall.cjs" && entry.kind === "file")
    ) {
      throw new Error("Prime tarball declares its inert postinstall file but omits it.");
    }
  }
  const cliPath = "package/dist/bundle/cli.js";
  const cli = entries.find((entry) => entry.path === cliPath && entry.kind === "file");
  if (!cli?.bytes || cli.bytes.byteLength < 1 || (cli.mode & 0o111) === 0) {
    throw new Error("Prime tarball omits an executable exact public CLI entry.");
  }
  return { manifest: record, cliPath };
}

function assertPackageMatchesPublication(
  manifest: Readonly<Record<string, unknown>>,
  publication: VerifiedPrimePublication,
): void {
  const metadata = manifest.pylonDistribution;
  const record =
    typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)
      ? (metadata as Readonly<Record<string, unknown>>)
      : undefined;
  if (
    manifest.version !== publication.packageVersion ||
    record?.buildId !== publication.buildId ||
    record.sourceCommit !== publication.sourceCommit ||
    record.sourceTree !== publication.sourceTree ||
    record.recipeRevision !== publication.recipeRevision ||
    publication.rootAsset !== `pylon-prime-agent-${publication.packageVersion}.tgz`
  ) {
    throw new Error("Prime tarball package metadata conflicts with the verified publication.");
  }
}

async function makeContainedDirectory(root: string, relative: string): Promise<void> {
  let current = root;
  for (const part of relative.split("/").filter(Boolean)) {
    current = NodePath.join(current, part);
    try {
      await NodeFSP.mkdir(current, { mode: 0o700 });
    } catch (cause) {
      if (!isErrno(cause, "EEXIST")) throw cause;
    }
    const info = await NodeFSP.lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("Prime extraction encountered a non-directory path component.");
    }
  }
}

async function extractPrimeEntries(
  root: string,
  entries: ReadonlyArray<TarEntry>,
): Promise<string> {
  await ensurePrivateDirectory(root);
  for (const entry of entries.toSorted((left, right) => left.path.localeCompare(right.path))) {
    const relative = entry.path;
    const target = NodePath.join(root, ...relative.split("/"));
    const expectedPrefix = `${NodePath.resolve(root)}${NodePath.sep}`;
    if (!NodePath.resolve(target).startsWith(expectedPrefix)) {
      throw new Error("Prime extraction target escapes its staging root.");
    }
    if (entry.kind === "directory") {
      await makeContainedDirectory(root, relative);
      await NodeFSP.chmod(target, entry.mode & 0o777);
      continue;
    }
    await makeContainedDirectory(root, NodePath.posix.dirname(relative));
    const handle = await NodeFSP.open(
      target,
      NodeFS.constants.O_WRONLY |
        NodeFS.constants.O_CREAT |
        NodeFS.constants.O_EXCL |
        (NodeFS.constants.O_NOFOLLOW ?? 0),
      entry.mode & 0o777,
    );
    try {
      await handle.writeFile(entry.bytes!);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  const directories = new Set<string>([root]);
  for (const entry of entries) {
    const parts = entry.path.split("/");
    const directoryParts = entry.kind === "directory" ? parts : parts.slice(0, -1);
    for (let length = 1; length <= directoryParts.length; length += 1) {
      directories.add(NodePath.join(root, ...directoryParts.slice(0, length)));
    }
  }
  for (const directory of [...directories].toSorted((left, right) => right.length - left.length)) {
    await syncDirectory(directory);
  }
  const packageRoot = NodePath.join(root, "package");
  const realPackageRoot = await NodeFSP.realpath(packageRoot);
  if (realPackageRoot !== packageRoot) {
    throw new Error("Prime extracted package root is not canonical.");
  }
  return packageRoot;
}

async function installVerifiedPackageTree(input: {
  readonly extractedPackagePath: string;
  readonly prefixPath: string;
}): Promise<void> {
  // The signed root artifact already contains the bundled CLI. Building the managed layout
  // ourselves keeps installation offline and byte-bounded: no package manager, lifecycle script,
  // registry resolution, or dependency download can run after verification.
  await ensurePrivateDirectory(input.prefixPath);
  const nodeModules = NodePath.join(input.prefixPath, "node_modules");
  const binDirectory = NodePath.join(nodeModules, ".bin");
  await NodeFSP.mkdir(nodeModules, { mode: 0o700 });
  await NodeFSP.mkdir(binDirectory, { mode: 0o700 });
  const packageRoot = NodePath.join(nodeModules, "prime-agent");
  await NodeFSP.rename(input.extractedPackagePath, packageRoot);
  const binaryPath = NodePath.join(binDirectory, "prime-agent");
  await NodeFSP.symlink("../prime-agent/dist/bundle/cli.js", binaryPath);
  await syncDirectory(binDirectory);
  await syncDirectory(nodeModules);
  await syncDirectory(input.prefixPath);
}

async function validateInstalledLauncher(input: {
  readonly prefixPath: string;
  readonly expectedManifest: Readonly<Record<string, unknown>>;
}): Promise<{ readonly binaryPath: string; readonly packageRoot: string }> {
  const packageRoot = NodePath.join(input.prefixPath, "node_modules", "prime-agent");
  const canonicalPackageRoot = await NodeFSP.realpath(packageRoot);
  if (canonicalPackageRoot !== packageRoot)
    throw new Error("Installed Prime package root is not canonical.");
  const installedManifestBytes = await readBoundedRegularFile(
    NodePath.join(packageRoot, "package.json"),
    MAX_PACKAGE_JSON_BYTES,
  );
  if (!installedManifestBytes) throw new Error("Installed Prime package.json is missing.");
  const installedManifest = JSON.parse(installedManifestBytes.toString("utf8")) as unknown;
  if (stableJson(installedManifest) !== stableJson(input.expectedManifest)) {
    throw new Error("Installed Prime package identity differs from the verified root tarball.");
  }
  const binaryPath = NodePath.join(input.prefixPath, "node_modules", ".bin", "prime-agent");
  const launcher = await NodeFSP.lstat(binaryPath);
  const expectedCli = NodePath.join(packageRoot, "dist", "bundle", "cli.js");
  if (launcher.isSymbolicLink()) {
    const link = await NodeFSP.readlink(binaryPath);
    if (NodePath.isAbsolute(link) || (await NodeFSP.realpath(binaryPath)) !== expectedCli) {
      throw new Error("Managed Prime launcher points outside the verified package root.");
    }
  } else if (!launcher.isFile()) {
    throw new Error("Managed Prime launcher is not a POSIX file or contained symlink.");
  }
  await NodeFSP.access(binaryPath, NodeFS.constants.X_OK);
  return { binaryPath, packageRoot };
}

function markerFor(
  publication: VerifiedPrimePublication,
  installed: PrimeManagedInstalledBuild,
): BuildMarker {
  return {
    schemaVersion: 1,
    buildId: publication.buildId,
    channel: publication.channel,
    sequenceEpoch: publication.sequenceEpoch,
    sequence: publication.sequence,
    rootSha256: publication.rootSha256,
    packageRoot: installed.packageRoot,
    binaryPath: installed.binaryPath,
  };
}

function decodeBuildMarker(value: unknown): BuildMarker {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Managed Prime build marker is invalid.");
  }
  const marker = value as Partial<BuildMarker>;
  if (
    marker.schemaVersion !== 1 ||
    typeof marker.buildId !== "string" ||
    !BUILD_ID.test(marker.buildId) ||
    (marker.channel !== "stable" && marker.channel !== "preview") ||
    marker.sequenceEpoch !== 1 ||
    !Number.isSafeInteger(marker.sequence) ||
    typeof marker.rootSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(marker.rootSha256) ||
    typeof marker.packageRoot !== "string" ||
    typeof marker.binaryPath !== "string"
  ) {
    throw new Error("Managed Prime build marker has an unsupported schema.");
  }
  return marker as BuildMarker;
}

export async function resolvePrimeManagedBuildReceiptTarget(input: {
  readonly stateDir: string;
  readonly packageRoot: string;
}): Promise<{ readonly stateDir: string; readonly instanceId: string } | undefined> {
  const canonicalStateDir = await NodeFSP.realpath(NodePath.resolve(input.stateDir));
  const canonicalPackageRoot = await NodeFSP.realpath(NodePath.resolve(input.packageRoot));
  const managedRoot = NodePath.join(canonicalStateDir, ...PRIME_MANAGED_TOOL_DIRECTORY.split("/"));
  const relative = NodePath.relative(managedRoot, canonicalPackageRoot);
  const parts = relative.split(NodePath.sep);
  if (
    parts.length !== 4 ||
    !BUILD_ID.test(parts[0]!) ||
    parts[1] !== "prefix" ||
    parts[2] !== "node_modules" ||
    parts[3] !== "prime-agent"
  ) {
    return undefined;
  }
  const buildId = parts[0]!;
  return {
    stateDir: NodePath.join(managedRoot, buildId, RECEIPT_STATE_DIRECTORY),
    instanceId: `${RECEIPT_INSTANCE_PREFIX}${buildId}`,
  };
}

export class PrimeAgentManagedToolStore {
  readonly #stateDir: string;
  readonly #root: string;
  readonly #statePath: string;
  readonly #platform: NodeJS.Platform;
  readonly #dependencies: PrimeManagedToolStoreDependencies;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(input: {
    readonly stateDir: string;
    readonly platform: NodeJS.Platform;
    readonly dependencies: PrimeManagedToolStoreDependencies;
  }) {
    if (input.platform === "win32") {
      throw new Error(
        "Native Windows Prime managed install/update is unavailable. Run Pylon and Prime Agent inside WSL2; no download or install was started.",
      );
    }
    this.#stateDir = NodeFS.realpathSync.native(NodePath.resolve(input.stateDir));
    this.#root = NodePath.join(this.#stateDir, ...PRIME_MANAGED_TOOL_DIRECTORY.split("/"));
    this.#statePath = NodePath.join(this.#root, PRIME_MANAGED_STATE_FILE);
    this.#platform = input.platform;
    this.#dependencies = input.dependencies;
  }

  async initialize(): Promise<void> {
    await this.#exclusive(async () => {
      await ensurePrivateDirectory(this.#root);
      await this.#recoverTemporaryEntries();
      await this.#reconcileSelectionIntents();
    });
  }

  async command(input: PrimeManagedCommandInput): Promise<PrimeManagedCommandReceipt> {
    validateCommand(input);
    return await this.#exclusive(async () => {
      await this.#reconcileSelectionIntents();
      return await this.#runCommand(input);
    });
  }

  async drain(instanceId: string): Promise<PrimeManagedCommandReceipt | null> {
    return await this.#exclusive(async () => {
      await this.#reconcileSelectionIntents();
      let state = await this.#readState();
      const scheduled = state.scheduled[instanceId];
      if (!scheduled) return null;
      const operation = state.operations[scheduled.commandId];
      if (!operation) throw new Error("Scheduled Prime maintenance lost its command receipt.");
      try {
        await this.#validateSelectionTarget(state, scheduled);
        return await this.#trySelection({
          state,
          receipt: operation,
          expected: scheduled.expected,
          targetBinaryPath: scheduled.targetBinaryPath,
          buildId: scheduled.buildId,
          channel: scheduled.channel,
          scheduleIfBusy: true,
        });
      } catch (cause) {
        state = await this.#readState();
        const { [instanceId]: _scheduled, ...remainingScheduled } = state.scheduled;
        const cleared = {
          ...state,
          revision: state.revision + 1,
          scheduled: remainingScheduled,
        } satisfies StoredState;
        await this.#writeState(cleared);
        return await this.#finishOperation(cleared, operation, {
          status: "failed",
          message: cause instanceof Error ? cause.message : String(cause),
        });
      }
    });
  }

  async status(instanceId: string): Promise<PrimeManagedInstanceStatus> {
    // State files and promoted build directories are atomic. Keep this read outside the command
    // queue so every client can observe durable download/verify/install/wait/switch progress while
    // the environment-owning command continues.
    const state = await this.#readState();
    const selection = state.selections[instanceId];
    const availableBuilds = await this.#listVerifiedBuilds();
    const scheduledState = state.scheduled[instanceId];
    const scheduled = scheduledState ? (state.operations[scheduledState.commandId] ?? null) : null;
    const latestOperationId = state.latestOperationIds[instanceId];
    const operation =
      scheduled ??
      (latestOperationId
        ? (state.operations[latestOperationId] ?? null)
        : (Object.values(state.operations)
            .filter((candidate) => candidate.instanceId === instanceId)
            .toSorted((left, right) => right.startedAt.localeCompare(left.startedAt))[0] ?? null));
    const mode = selection?.mode ?? "stock";
    return {
      instanceId,
      mode,
      selectedBuildId: selection?.selectedBuildId ?? null,
      channel: selection?.channel ?? null,
      availableBuilds,
      scheduled,
      operation,
      message:
        scheduled !== null
          ? "Prime host maintenance is scheduled. It will switch only after the provider instance drains completely."
          : mode === "managed"
            ? `This environment uses verified Pylon-managed Prime build ${selection!.selectedBuildId}.`
            : "This environment uses its stock or configured Prime Agent binary.",
    };
  }

  async #runCommand(input: PrimeManagedCommandInput): Promise<PrimeManagedCommandReceipt> {
    await ensurePrivateDirectory(this.#root);
    let state = await this.#readState();
    const fingerprint = commandFingerprint(input);
    const prior = state.operations[input.commandId];
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        throw new Error("Prime maintenance command id was reused with different input.");
      }
      return prior;
    }
    if (input.action !== "cleanup") {
      state = await this.#supersedeScheduled(state, input.instanceId, input.commandId);
    }
    const now = this.#now();
    let receipt: PrimeManagedCommandReceipt & { readonly fingerprint: string } = {
      commandId: input.commandId,
      instanceId: input.instanceId,
      action: input.action,
      status: "queued",
      channel:
        input.channel ??
        (input.action === "install" || input.action === "update" ? "stable" : null),
      buildId: input.buildId ?? null,
      message: "Prime host maintenance is queued.",
      startedAt: now,
      finishedAt: null,
      fingerprint,
    };
    state = await this.#storeOperation(state, receipt);
    try {
      if (input.action === "cleanup") {
        receipt = await this.#updateOperation(state, receipt, {
          status: "installing",
          message: "Pruning exact unreferenced receipt-owned Prime builds.",
        });
        state = await this.#readState();
        const removed = await this.#cleanup(state);
        return await this.#finishOperation(state, receipt, {
          status: "succeeded",
          message: removed.length
            ? `Removed unreferenced managed builds: ${removed.join(", ")}.`
            : "No unreferenced receipt-owned managed Prime build needed cleanup.",
        });
      }

      const expected = await this.#dependencies.readBinding(input.instanceId);
      state = await this.#reconcileExternalBinding(state, input.instanceId, expected);
      let targetBinaryPath: string;
      let buildId: string | null = null;
      let channel: ServerProviderDistributionChannel | null = null;
      if (input.action === "install" || input.action === "update") {
        channel = input.channel ?? "stable";
        receipt = await this.#updateOperation(state, receipt, {
          status: "downloading",
          channel,
          message: `Downloading the exact signed ${channel} Prime publication.`,
        });
        const bundle = await this.#dependencies.loadLatestVerifiedPublication(channel);
        receipt = await this.#updateOperation(await this.#readState(), receipt, {
          status: "verifying",
          channel,
          buildId: bundle.publication.buildId,
          message:
            "Verifying publication provenance, digest, and the root archive before extraction.",
        });
        this.#assertPublicationCandidate(await this.#readState(), bundle.publication);
        // Observing a newer exact signed publication advances replay protection even when its
        // archive later fails safe extraction or installation. A bad release must not reopen an
        // implicit downgrade path to an older channel head.
        state = await this.#recordHighWater(await this.#readState(), bundle.publication);
        receipt = await this.#updateOperation(state, receipt, {
          status: "installing",
          channel,
          buildId: bundle.publication.buildId,
          message: "Extracting the verified bundled CLI into a new side-by-side build.",
        });
        const installed = await this.#install(bundle);
        targetBinaryPath = installed.binaryPath;
        buildId = installed.buildId;
        receipt = await this.#updateOperation(await this.#readState(), receipt, {
          status: "installing",
          channel,
          buildId,
          message: `Verified managed Prime build ${buildId} is staged side by side.`,
        });
      } else if (input.action === "rollback") {
        const installed = await this.#readVerifiedBuild(input.buildId!);
        targetBinaryPath = installed.binaryPath;
        buildId = installed.buildId;
        channel = installed.channel;
      } else {
        const selection = state.selections[input.instanceId];
        if (!selection || selection.mode === "stock") {
          return await this.#finishOperation(state, receipt, {
            status: "succeeded",
            message: "Prime already uses its stock or configured binary.",
          });
        }
        targetBinaryPath = selection.stockBinaryPath;
      }
      return await this.#trySelection({
        state: await this.#readState(),
        receipt,
        expected,
        targetBinaryPath,
        buildId,
        channel,
        scheduleIfBusy: input.scheduleIfBusy !== false,
      });
    } catch (cause) {
      const current = await this.#readState();
      return await this.#finishOperation(current, receipt, {
        status: "failed",
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  async #trySelection(input: {
    readonly state: StoredState;
    readonly receipt: PrimeManagedCommandReceipt & { readonly fingerprint: string };
    readonly expected: PrimeManagedBinding;
    readonly targetBinaryPath: string;
    readonly buildId: string | null;
    readonly channel: ServerProviderDistributionChannel | null;
    readonly scheduleIfBusy: boolean;
  }): Promise<PrimeManagedCommandReceipt> {
    let state = input.state;
    let receipt = await this.#updateOperation(state, input.receipt, {
      status: "waiting-for-quiescence",
      buildId: input.buildId,
      channel: input.channel,
      message: "Waiting for exact provider-instance quiescence before changing its binary.",
    });
    state = await this.#readState();
    const reservation = await this.#dependencies.reserveQuiescentBinding(
      receipt.instanceId,
      input.expected,
    );
    if (reservation.status === "busy") {
      if (!input.scheduleIfBusy) {
        throw new Error(`Prime maintenance is blocked: ${reservation.reasons.join("; ")}`);
      }
      const scheduled: StoredScheduled = {
        commandId: receipt.commandId,
        instanceId: receipt.instanceId,
        action: receipt.action,
        expected: input.expected,
        targetBinaryPath: input.targetBinaryPath,
        buildId: input.buildId,
        channel: input.channel,
      };
      const next: StoredState = {
        ...state,
        revision: state.revision + 1,
        scheduled: { ...state.scheduled, [receipt.instanceId]: scheduled },
        operations: {
          ...state.operations,
          [receipt.commandId]: {
            ...receipt,
            status: "waiting-for-quiescence",
            message: `Scheduled until the instance drains: ${reservation.reasons.join("; ")}`,
          },
        },
      };
      await this.#writeState(next);
      return next.operations[receipt.commandId]!;
    }
    try {
      receipt = await this.#updateOperation(state, receipt, {
        status: "switching",
        message: "The instance is fenced and quiescent. Switching its exact binary binding.",
      });
      state = await this.#readState();
      const previous = state.selections[receipt.instanceId];
      const intent: StoredSelectionIntent = {
        commandId: receipt.commandId,
        instanceId: receipt.instanceId,
        action: receipt.action,
        expected: input.expected,
        targetBinaryPath: input.targetBinaryPath,
        stockBinaryPath: previous?.stockBinaryPath ?? input.expected.binaryPath,
        buildId: input.buildId,
        channel: input.channel,
      };
      const intentState: StoredState = {
        ...state,
        revision: state.revision + 1,
        selectionIntents: { ...state.selectionIntents, [receipt.instanceId]: intent },
      };
      // This journal is synced before CAS. A crash on either side of the settings write can
      // therefore reconcile the exact observed binding without guessing or selecting partial bytes.
      await this.#writeState(intentState);
      const committed = await this.#dependencies.commitBinding({
        instanceId: receipt.instanceId,
        expected: input.expected,
        binaryPath: input.targetBinaryPath,
        reservation: reservation.reservation,
      });
      const next = await this.#commitSelectionState(await this.#readState(), intent, committed);
      return await this.#finishOperation(next, receipt, {
        status: "succeeded",
        message:
          input.buildId === null
            ? "Prime now uses the stock or configured binary. No global bytes were changed."
            : `${receipt.action === "rollback" ? "Rolled back" : "Selected"} verified managed Prime build ${input.buildId}.`,
      });
    } finally {
      await this.#dependencies.releaseReservation(reservation.reservation);
    }
  }

  async #reconcileExternalBinding(
    state: StoredState,
    instanceId: string,
    current: PrimeManagedBinding,
  ): Promise<StoredState> {
    const selected = state.selections[instanceId];
    if (
      !selected ||
      (selected.binding.generation === current.generation &&
        selected.binding.binaryPath === current.binaryPath)
    ) {
      return state;
    }
    const next: StoredState = {
      ...state,
      revision: state.revision + 1,
      selections: {
        ...state.selections,
        [instanceId]: {
          mode: "stock",
          selectedBuildId: null,
          channel: null,
          stockBinaryPath: current.binaryPath,
          binding: current,
        },
      },
    };
    await this.#writeState(next);
    return next;
  }

  async #validateSelectionTarget(
    state: StoredState,
    target: Pick<
      StoredSelectionIntent,
      "instanceId" | "action" | "targetBinaryPath" | "buildId" | "channel"
    >,
  ): Promise<void> {
    if (target.buildId !== null) {
      const build = await this.#readVerifiedBuild(target.buildId);
      if (
        target.action === "use-stock" ||
        target.targetBinaryPath !== build.binaryPath ||
        target.channel !== build.channel
      ) {
        throw new Error("Persisted Prime maintenance target conflicts with its verified build.");
      }
      return;
    }
    const selection = state.selections[target.instanceId];
    if (
      target.action !== "use-stock" ||
      target.channel !== null ||
      !selection ||
      target.targetBinaryPath !== selection.stockBinaryPath
    ) {
      throw new Error("Persisted Prime stock switch conflicts with its recorded original binding.");
    }
  }

  async #commitSelectionState(
    state: StoredState,
    intent: StoredSelectionIntent,
    binding: PrimeManagedBinding,
  ): Promise<StoredState> {
    const selection: StoredSelection = {
      mode: intent.buildId === null ? "stock" : "managed",
      selectedBuildId: intent.buildId,
      channel: intent.channel,
      stockBinaryPath: intent.stockBinaryPath,
      binding,
    };
    const { [intent.instanceId]: _intent, ...remainingIntents } = state.selectionIntents;
    const { [intent.instanceId]: _scheduled, ...remainingScheduled } = state.scheduled;
    const next: StoredState = {
      ...state,
      revision: state.revision + 1,
      selections: { ...state.selections, [intent.instanceId]: selection },
      selectionIntents: remainingIntents,
      scheduled: remainingScheduled,
    };
    await this.#writeState(next);
    return next;
  }

  async #reconcileSelectionIntents(): Promise<void> {
    let state = await this.#readState();
    for (const intent of Object.values(state.selectionIntents)) {
      await this.#validateSelectionTarget(state, intent);
      const current = await this.#dependencies.readBinding(intent.instanceId);
      const operation = state.operations[intent.commandId];
      if (current.binaryPath === intent.targetBinaryPath) {
        state = await this.#commitSelectionState(state, intent, current);
        if (operation) {
          const recovered = {
            ...operation,
            status: "succeeded" as const,
            message:
              intent.buildId === null
                ? "Recovered the completed switch to the stock or configured Prime binary."
                : `Recovered the completed switch to verified managed Prime build ${intent.buildId}.`,
            finishedAt: this.#now(),
          };
          state = await this.#storeOperation(state, recovered);
        }
        continue;
      }
      const { [intent.instanceId]: _intent, ...remainingIntents } = state.selectionIntents;
      const { [intent.instanceId]: _scheduled, ...remainingScheduled } = state.scheduled;
      const expectedStillSelected =
        current.binaryPath === intent.expected.binaryPath &&
        current.generation === intent.expected.generation;
      const nextOperation = operation
        ? {
            ...operation,
            status: "failed" as const,
            message: expectedStillSelected
              ? "Prime maintenance was interrupted before the atomic binding switch."
              : "Prime maintenance was superseded by a different provider binding before recovery.",
            finishedAt: this.#now(),
          }
        : undefined;
      const next: StoredState = {
        ...state,
        revision: state.revision + 1,
        selectionIntents: remainingIntents,
        scheduled: remainingScheduled,
        operations: nextOperation
          ? { ...state.operations, [intent.commandId]: nextOperation }
          : state.operations,
      };
      await this.#writeState(next);
      state = next;
    }
  }

  async #supersedeScheduled(
    state: StoredState,
    instanceId: string,
    replacementCommandId: string,
  ): Promise<StoredState> {
    const scheduled = state.scheduled[instanceId];
    if (!scheduled || scheduled.commandId === replacementCommandId) return state;
    const prior = state.operations[scheduled.commandId];
    const { [instanceId]: _scheduled, ...remainingScheduled } = state.scheduled;
    const next: StoredState = {
      ...state,
      revision: state.revision + 1,
      scheduled: remainingScheduled,
      operations: prior
        ? {
            ...state.operations,
            [scheduled.commandId]: {
              ...prior,
              status: "failed",
              message: `Prime maintenance was superseded by command ${replacementCommandId}.`,
              finishedAt: this.#now(),
            },
          }
        : state.operations,
    };
    await this.#writeState(next);
    return next;
  }

  async #install(bundle: PrimeManagedPublicationBundle): Promise<PrimeManagedInstalledBuild> {
    const publication = bundle.publication;
    if (
      !BUILD_ID.test(publication.buildId) ||
      !PACKAGE_VERSION.test(publication.packageVersion) ||
      !ROOT_ASSET.test(publication.rootAsset) ||
      (publication.channel !== "stable" && publication.channel !== "preview") ||
      publication.sequenceEpoch !== 1 ||
      !Number.isSafeInteger(publication.sequence) ||
      publication.sequence < 1
    ) {
      throw new Error("Verified publication identity is invalid.");
    }
    if (
      bundle.rootArtifactBytes.byteLength < 1 ||
      bundle.rootArtifactBytes.byteLength > MAX_ROOT_ARCHIVE_BYTES ||
      sha256(bundle.rootArtifactBytes) !== publication.rootSha256
    ) {
      throw new Error("Prime root tarball digest does not match the verified publication.");
    }
    const finalDirectory = NodePath.join(this.#root, publication.buildId);
    try {
      return await this.#readVerifiedBuild(publication.buildId);
    } catch (cause) {
      if (!isErrno(cause, "ENOENT")) {
        const exists = await NodeFSP.lstat(finalDirectory).then(
          () => true,
          (error) => (isErrno(error, "ENOENT") ? false : Promise.reject(error)),
        );
        if (exists) throw cause;
      }
    }

    const entries = await parsePrimeTarball(bundle.rootArtifactBytes);
    const packageIdentity = packageManifestFromEntries(entries);
    assertPackageMatchesPublication(packageIdentity.manifest, publication);
    const staging = NodePath.join(
      this.#root,
      `${STAGING_PREFIX}${publication.buildId}-${NodeCrypto.randomBytes(10).toString("hex")}`,
    );
    await NodeFSP.mkdir(staging, { mode: 0o700 });
    let promoted = false;
    try {
      const archivePath = NodePath.join(staging, publication.rootAsset);
      const archiveHandle = await NodeFSP.open(
        archivePath,
        NodeFS.constants.O_WRONLY | NodeFS.constants.O_CREAT | NodeFS.constants.O_EXCL,
        0o600,
      );
      try {
        await archiveHandle.writeFile(bundle.rootArtifactBytes);
        await archiveHandle.sync();
      } finally {
        await archiveHandle.close();
      }
      const extractedPackagePath = await extractPrimeEntries(
        NodePath.join(staging, "verified-source"),
        entries,
      );
      const prefixPath = NodePath.join(staging, "prefix");
      if (this.#dependencies.installVerifiedArchive) {
        await this.#dependencies.installVerifiedArchive({
          archivePath,
          extractedPackagePath,
          prefixPath,
          publication,
        });
      } else {
        await installVerifiedPackageTree({ extractedPackagePath, prefixPath });
      }
      const installedInStage = await validateInstalledLauncher({
        prefixPath,
        expectedManifest: packageIdentity.manifest,
      });
      await NodeFSP.rm(NodePath.join(staging, "verified-source"), { recursive: true, force: true });
      await NodeFSP.rm(archivePath, { force: true });
      await syncDirectory(staging);
      await NodeFSP.rename(staging, finalDirectory);
      promoted = true;
      await syncDirectory(this.#root);
      const installed = {
        buildId: publication.buildId,
        channel: publication.channel,
        sequence: publication.sequence,
        binaryPath: installedInStage.binaryPath.replace(staging, finalDirectory),
        packageRoot: installedInStage.packageRoot.replace(staging, finalDirectory),
      } satisfies PrimeManagedInstalledBuild;
      await persistPrimeManagedReceipt({
        stateDir: NodePath.join(finalDirectory, RECEIPT_STATE_DIRECTORY),
        instanceId: `${RECEIPT_INSTANCE_PREFIX}${publication.buildId}`,
        packageRoot: installed.packageRoot,
        platform: this.#platform,
        publication,
      });
      await writeJsonAtomically(
        finalDirectory,
        PRIME_MANAGED_BUILD_FILE,
        markerFor(publication, installed),
      );
      await syncDirectory(finalDirectory);
      return await this.#readVerifiedBuild(publication.buildId);
    } catch (cause) {
      if (promoted) {
        // A promoted directory without a verified receipt+marker is never selectable. Recovery
        // removes it on the next command; leave it in place if removal itself is unsafe.
        await this.#removeIncompleteBuild(finalDirectory).catch(() => undefined);
      }
      throw cause;
    } finally {
      if (!promoted) await this.#removeExactTemporary(staging).catch(() => undefined);
    }
  }

  async #readVerifiedBuild(buildId: string): Promise<PrimeManagedInstalledBuild> {
    if (!BUILD_ID.test(buildId)) throw new Error("Managed Prime build id is invalid.");
    const directory = NodePath.join(this.#root, buildId);
    const directoryInfo = await NodeFSP.lstat(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
      throw new Error("Managed Prime build path is not a real directory.");
    }
    if ((await NodeFSP.realpath(directory)) !== directory) {
      throw new Error("Managed Prime build directory is not canonical.");
    }
    const bytes = await readBoundedRegularFile(
      NodePath.join(directory, PRIME_MANAGED_BUILD_FILE),
      64 * 1024,
    );
    if (!bytes) throw new Error("Managed Prime build has no complete marker.");
    const marker = decodeBuildMarker(JSON.parse(bytes.toString("utf8")) as unknown);
    if (
      marker.buildId !== buildId ||
      marker.packageRoot !== NodePath.join(directory, "prefix", "node_modules", "prime-agent") ||
      marker.binaryPath !==
        NodePath.join(directory, "prefix", "node_modules", ".bin", "prime-agent")
    ) {
      throw new Error("Managed Prime build marker escapes or conflicts with its build directory.");
    }
    await NodeFSP.access(marker.binaryPath, NodeFS.constants.X_OK);
    const inspection = await inspectPrimeAgentDistribution(
      {
        stateDir: NodePath.join(directory, RECEIPT_STATE_DIRECTORY),
        instanceId: `${RECEIPT_INSTANCE_PREFIX}${buildId}`,
        packageRoot: marker.packageRoot,
        platform: this.#platform,
        checkedAt: this.#now(),
        enableUpdateChecks: false,
      },
      {
        loadLatestVerifiedPublication: async () => {
          throw new Error("Managed build validation does not use the network.");
        },
      },
    );
    if (
      inspection.classification !== "pylon-managed" ||
      inspection.buildId !== buildId ||
      inspection.channel !== marker.channel ||
      inspection.sequence !== marker.sequence
    ) {
      throw new Error(`Managed Prime build ${buildId} is not owned by its exact #193 receipt.`);
    }
    return {
      buildId,
      channel: marker.channel,
      sequence: marker.sequence,
      binaryPath: marker.binaryPath,
      packageRoot: marker.packageRoot,
    };
  }

  async #listVerifiedBuilds(): Promise<ReadonlyArray<PrimeManagedInstalledBuild>> {
    await ensurePrivateDirectory(this.#root);
    const entries = await NodeFSP.readdir(this.#root, { withFileTypes: true });
    const builds: PrimeManagedInstalledBuild[] = [];
    for (const entry of entries) {
      if (!BUILD_ID.test(entry.name)) continue;
      try {
        builds.push(await this.#readVerifiedBuild(entry.name));
      } catch {
        // Partial or invalid directories are not selectable and never become cleanup authority.
      }
    }
    return builds.toSorted((left, right) => right.sequence - left.sequence);
  }

  #assertPublicationCandidate(state: StoredState, publication: VerifiedPrimePublication): void {
    const prior = state.highWater[publication.channel];
    if (!prior) return;
    if (
      publication.sequenceEpoch !== prior.sequenceEpoch ||
      publication.sequence < prior.sequence ||
      (publication.sequence === prior.sequence && publication.buildId !== prior.buildId)
    ) {
      throw new Error("Signed Prime channel replay or implicit downgrade was rejected.");
    }
  }

  async #recordHighWater(
    state: StoredState,
    publication: VerifiedPrimePublication,
  ): Promise<StoredState> {
    this.#assertPublicationCandidate(state, publication);
    const prior = state.highWater[publication.channel];
    if (prior?.sequence === publication.sequence && prior.buildId === publication.buildId)
      return state;
    const next: StoredState = {
      ...state,
      revision: state.revision + 1,
      highWater: {
        ...state.highWater,
        [publication.channel]: {
          sequenceEpoch: publication.sequenceEpoch,
          sequence: publication.sequence,
          buildId: publication.buildId,
        },
      },
    };
    await this.#writeState(next);
    return next;
  }

  async #cleanup(state: StoredState): Promise<ReadonlyArray<string>> {
    const referenced = new Set<string>();
    for (const selection of Object.values(state.selections)) {
      if (selection.mode === "managed" && selection.selectedBuildId)
        referenced.add(selection.selectedBuildId);
    }
    for (const scheduled of Object.values(state.scheduled)) {
      if (scheduled.buildId) referenced.add(scheduled.buildId);
    }
    const removed: string[] = [];
    const entries = await NodeFSP.readdir(this.#root, { withFileTypes: true });
    for (const entry of entries) {
      if (!BUILD_ID.test(entry.name) || referenced.has(entry.name)) continue;
      const path = NodePath.join(this.#root, entry.name);
      const info = await NodeFSP.lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink() || (await NodeFSP.realpath(path)) !== path) {
        continue;
      }
      try {
        await this.#readVerifiedBuild(entry.name);
      } catch {
        continue;
      }
      await NodeFSP.rm(path, { recursive: true, force: false });
      removed.push(entry.name);
    }
    if (removed.length) await syncDirectory(this.#root);
    return removed.toSorted();
  }

  async #recoverTemporaryEntries(): Promise<void> {
    const entries = await NodeFSP.readdir(this.#root, { withFileTypes: true });
    for (const entry of entries) {
      const path = NodePath.join(this.#root, entry.name);
      if (entry.name.startsWith(STAGING_PREFIX)) {
        await this.#removeExactTemporary(path);
        continue;
      }
      if (!BUILD_ID.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
      try {
        await this.#readVerifiedBuild(entry.name);
      } catch {
        await this.#removeIncompleteBuild(path);
      }
    }
  }

  async #removeExactTemporary(path: string): Promise<void> {
    if (
      NodePath.dirname(path) !== this.#root ||
      !NodePath.basename(path).startsWith(STAGING_PREFIX)
    ) {
      throw new Error("Refusing to remove a non-staging Prime path.");
    }
    const info = await NodeFSP.lstat(path).catch((cause) => {
      if (isErrno(cause, "ENOENT")) return undefined;
      throw cause;
    });
    if (!info) return;
    if (!info.isDirectory() || info.isSymbolicLink() || (await NodeFSP.realpath(path)) !== path) {
      throw new Error("Refusing to follow a Prime staging link during recovery.");
    }
    await NodeFSP.rm(path, { recursive: true, force: false });
  }

  async #removeIncompleteBuild(path: string): Promise<void> {
    if (NodePath.dirname(path) !== this.#root || !BUILD_ID.test(NodePath.basename(path))) {
      throw new Error("Refusing to remove an unexpected Prime build path.");
    }
    const info = await NodeFSP.lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || (await NodeFSP.realpath(path)) !== path) {
      throw new Error("Refusing to follow an incomplete Prime build link.");
    }
    const marker = await readBoundedRegularFile(
      NodePath.join(path, PRIME_MANAGED_BUILD_FILE),
      64 * 1024,
    );
    if (marker) {
      // A complete marker turns deletion into explicit cleanup, which first verifies ownership.
      throw new Error("Refusing recovery cleanup of a marked Prime build.");
    }
    await NodeFSP.rm(path, { recursive: true, force: false });
  }

  async #readState(): Promise<StoredState> {
    await ensurePrivateDirectory(this.#root);
    const bytes = await readBoundedRegularFile(this.#statePath, 2 * 1024 * 1024);
    if (!bytes) return emptyState();
    return decodeStoredState(JSON.parse(bytes.toString("utf8")) as unknown);
  }

  async #writeState(state: StoredState): Promise<void> {
    await writeJsonAtomically(this.#root, PRIME_MANAGED_STATE_FILE, state);
  }

  async #storeOperation(
    state: StoredState,
    receipt: PrimeManagedCommandReceipt & { readonly fingerprint: string },
  ): Promise<StoredState> {
    const latestOperationIds = {
      ...state.latestOperationIds,
      [receipt.instanceId]: receipt.commandId,
    };
    const operations = { ...state.operations, [receipt.commandId]: receipt };
    const protectedIds = new Set([
      receipt.commandId,
      ...Object.values(latestOperationIds),
      ...Object.values(state.scheduled).map((scheduled) => scheduled.commandId),
      ...Object.values(state.selectionIntents).map((intent) => intent.commandId),
    ]);
    const removable = Object.values(operations)
      .filter((operation) => !protectedIds.has(operation.commandId))
      .toSorted(
        (left, right) =>
          left.startedAt.localeCompare(right.startedAt) ||
          left.commandId.localeCompare(right.commandId),
      );
    for (const operation of removable) {
      if (Object.keys(operations).length <= MAX_STORED_OPERATIONS) break;
      delete operations[operation.commandId];
    }
    const next: StoredState = {
      ...state,
      revision: state.revision + 1,
      operations,
      latestOperationIds,
    };
    await this.#writeState(next);
    return next;
  }

  async #updateOperation(
    state: StoredState,
    receipt: PrimeManagedCommandReceipt & { readonly fingerprint: string },
    patch: Partial<PrimeManagedCommandReceipt>,
  ): Promise<PrimeManagedCommandReceipt & { readonly fingerprint: string }> {
    const nextReceipt = { ...receipt, ...patch, fingerprint: receipt.fingerprint };
    await this.#storeOperation(state, nextReceipt);
    return nextReceipt;
  }

  async #finishOperation(
    state: StoredState,
    receipt: PrimeManagedCommandReceipt & { readonly fingerprint: string },
    patch: Pick<PrimeManagedCommandReceipt, "status" | "message">,
  ): Promise<PrimeManagedCommandReceipt> {
    const finished = {
      ...receipt,
      ...patch,
      finishedAt: patch.status === "waiting-for-quiescence" ? null : this.#now(),
    };
    await this.#storeOperation(state, finished);
    return finished;
  }

  #now(): string {
    return this.#dependencies.now?.() ?? new Date().toISOString();
  }

  async #exclusive<A>(work: () => Promise<A>): Promise<A> {
    const previous = this.#queue;
    let release!: () => void;
    this.#queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    try {
      return await work();
    } finally {
      release();
    }
  }
}
