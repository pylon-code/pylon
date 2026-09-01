// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeFS from "node:fs";

import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import type {
  PrimeAgentOwnedSessionContractProof,
  PrimeAgentOwnedSessionDisposeResult,
} from "./PrimeAgentDaemonBridge.ts";

const RECEIPT_VERSION = 1 as const;
const RECEIPT_DIRECTORY = "native-ownership";
const RECEIPT_FILE_SUFFIX = ".json";
const RECEIPT_MAX_BYTES = 64 * 1024;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const PROCESS_OWNER_ID = NodeCrypto.randomUUID();

const NonNegativeInt = Schema.Number.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
);
const DaemonIdentity = Schema.Struct({
  protocolName: Schema.String,
  protocolVersion: Schema.Int,
  schemaRevision: Schema.Int,
  appVersion: Schema.optional(Schema.String),
  buildId: Schema.optional(Schema.String),
  supervisorGeneration: Schema.String,
  transportGeneration: NonNegativeInt,
});
const AttachProof = Schema.Struct({
  feature: Schema.Literal("caller_owned_session_environment_cleanup_v1"),
  status: Schema.Literal("attached"),
  daemon: DaemonIdentity,
});
const RecoveryIdentity = Schema.Struct({
  threadId: Schema.String,
  sessionIncarnationId: Schema.String,
  admissionRequestId: Schema.String,
  recoveryHandle: Schema.String,
  ownershipGeneration: NonNegativeInt,
});
const PendingReceipt = Schema.Struct({
  version: Schema.Literal(RECEIPT_VERSION),
  state: Schema.Literal("pending"),
  attemptId: Schema.String,
  instanceId: Schema.String,
  creationConfigRevision: Schema.String,
  currentConfigRevision: Schema.String,
  effectiveHome: Schema.String,
  ownerProcessId: Schema.String,
});
const AcquiredReceipt = Schema.Struct({
  version: Schema.Literal(RECEIPT_VERSION),
  state: Schema.Literal("acquired"),
  attemptId: Schema.String,
  instanceId: Schema.String,
  creationConfigRevision: Schema.String,
  currentConfigRevision: Schema.String,
  effectiveHome: Schema.String,
  ownerProcessId: Schema.String,
  activeSessionId: Schema.String,
  nativeSessionId: Schema.String,
  attachProof: AttachProof,
  recovery: Schema.optional(RecoveryIdentity),
});
const OwnershipReceipt = Schema.Union([PendingReceipt, AcquiredReceipt]);
export type PrimeAgentOwnershipReceipt = typeof OwnershipReceipt.Type;
export type PrimeAgentAcquiredOwnershipReceipt = typeof AcquiredReceipt.Type;
const decodeOwnershipReceipt = Schema.decodeUnknownSync(OwnershipReceipt);

export interface PrimeAgentOwnershipRecoveryIdentity {
  readonly threadId: string;
  readonly sessionIncarnationId: string;
  readonly admissionRequestId: string;
  readonly recoveryHandle: string;
  readonly ownershipGeneration: number;
}

export interface PrimeAgentOwnershipReceiptScan {
  readonly receipts: ReadonlyArray<PrimeAgentOwnershipReceipt>;
  /** Unknown filenames, links, ownership, mode, size, or contents fail closed. */
  readonly corrupt: boolean;
}

export interface PrimeAgentOwnershipReceiptHandle {
  readonly attemptId: string;
  readonly instanceId: string;
  readonly creationConfigRevision: string;
  readonly currentConfigRevision: string;
  readonly effectiveHome: string;
}

export interface PrimeAgentOwnershipAdoptionClaim {
  readonly receipt: PrimeAgentAcquiredOwnershipReceipt;
  readonly handle: PrimeAgentOwnershipReceiptHandle;
}

const liveSafeAttempts = new Set<string>();

function sameDaemonIdentity(
  left: PrimeAgentOwnedSessionContractProof["daemon"],
  right: typeof DaemonIdentity.Type,
): boolean {
  return (
    left.protocolName === right.protocolName &&
    left.protocolVersion === right.protocolVersion &&
    left.schemaRevision === right.schemaRevision &&
    left.appVersion === right.appVersion &&
    left.buildId === right.buildId &&
    left.supervisorGeneration === right.supervisorGeneration &&
    left.transportGeneration === right.transportGeneration
  );
}

function sameAttachProof(
  left: PrimeAgentOwnedSessionContractProof,
  right: typeof AttachProof.Type,
): boolean {
  return (
    left.feature === right.feature &&
    left.status === right.status &&
    sameDaemonIdentity(left.daemon, right.daemon)
  );
}

function validCleanupOutcome(
  result: PrimeAgentOwnedSessionDisposeResult,
  attachProof: typeof AttachProof.Type,
): boolean {
  if (
    result.feature !== "caller_owned_session_environment_cleanup_v1" ||
    (result.status !== "completed" &&
      result.status !== "already_completed" &&
      result.status !== "replacement_settled")
  ) {
    return false;
  }
  if (!sameAttachProof(result.started, attachProof)) return false;
  if (result.status === "replacement_settled") {
    return (
      result.daemonReplaced === true &&
      result.observed.supervisorGeneration !== result.started.daemon.supervisorGeneration
    );
  }
  return (
    result.daemonReplaced ===
    (result.observed.supervisorGeneration !== result.started.daemon.supervisorGeneration)
  );
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await NodeFSP.mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const info = await NodeFSP.lstat(directory);
  const uid = process.getuid?.();
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (uid !== undefined && info.uid !== uid) ||
    (uid !== undefined && (info.mode & 0o077) !== 0)
  ) {
    throw new Error("Prime Agent ownership receipt directory is not private");
  }
  if (uid !== undefined) {
    await NodeFSP.chmod(directory, PRIVATE_DIRECTORY_MODE);
    const restricted = await NodeFSP.lstat(directory);
    if (
      !restricted.isDirectory() ||
      restricted.isSymbolicLink() ||
      restricted.dev !== info.dev ||
      restricted.ino !== info.ino ||
      restricted.uid !== uid ||
      (restricted.mode & 0o077) !== 0
    ) {
      throw new Error("Prime Agent ownership receipt directory changed during validation");
    }
  }
}

async function readReceiptFile(filePath: string): Promise<PrimeAgentOwnershipReceipt> {
  const handle = await NodeFSP.open(
    filePath,
    NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const info = await handle.stat();
    const uid = process.getuid?.();
    if (
      !info.isFile() ||
      (uid !== undefined && info.uid !== uid) ||
      (uid !== undefined && (info.mode & 0o177) !== 0) ||
      info.size <= 0 ||
      info.size > RECEIPT_MAX_BYTES
    ) {
      throw new Error("Prime Agent ownership receipt metadata is invalid");
    }
    const contents = await handle.readFile({ encoding: "utf8" });
    return decodeOwnershipReceipt(JSON.parse(contents));
  } finally {
    await handle.close();
  }
}

async function canonicalizeStoredHome(candidate: string): Promise<string> {
  if (!NodePath.isAbsolute(candidate))
    throw new Error("Prime Agent ownership home is not absolute");
  let ancestor = NodePath.normalize(candidate);
  const suffix: string[] = [];
  while (true) {
    try {
      const resolved = await NodeFSP.realpath(ancestor);
      const info = await NodeFSP.stat(resolved);
      if (!info.isDirectory())
        throw new Error("Prime Agent ownership home ancestor is not a directory");
      return suffix.length === 0 ? resolved : NodePath.join(resolved, ...suffix);
    } catch (cause) {
      if (!Predicate.isObject(cause) || cause.code !== "ENOENT") throw cause;
      const parent = NodePath.dirname(ancestor);
      if (parent === ancestor) throw cause;
      suffix.unshift(NodePath.basename(ancestor));
      ancestor = parent;
    }
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await NodeFSP.open(directory, NodeFS.constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeAtomicallyUnlocked(input: {
  readonly directory: string;
  readonly filePath: string;
  readonly receipt: PrimeAgentOwnershipReceipt;
  readonly replace: boolean;
  readonly expected?: PrimeAgentOwnershipReceipt;
}): Promise<void> {
  await ensurePrivateDirectory(input.directory);
  if (input.replace) {
    const previous = await readReceiptFile(input.filePath);
    if (
      previous.attemptId !== input.receipt.attemptId ||
      previous.instanceId !== input.receipt.instanceId ||
      previous.creationConfigRevision !== input.receipt.creationConfigRevision ||
      (input.expected !== undefined && JSON.stringify(previous) !== JSON.stringify(input.expected))
    ) {
      throw new Error("Prime Agent ownership receipt owner changed");
    }
  }
  const tempPath = NodePath.join(
    input.directory,
    `.${input.receipt.attemptId}.${NodeCrypto.randomUUID()}.tmp`,
  );
  const handle = await NodeFSP.open(
    tempPath,
    NodeFS.constants.O_WRONLY |
      NodeFS.constants.O_CREAT |
      NodeFS.constants.O_EXCL |
      (NodeFS.constants.O_NOFOLLOW ?? 0),
    PRIVATE_FILE_MODE,
  );
  try {
    await handle.writeFile(`${JSON.stringify(input.receipt)}\n`, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if (!input.replace) {
      try {
        await NodeFSP.lstat(input.filePath);
        throw new Error("Prime Agent ownership receipt already exists");
      } catch (cause) {
        if (!Predicate.isObject(cause) || cause.code !== "ENOENT") throw cause;
      }
    }
    await NodeFSP.rename(tempPath, input.filePath);
    await syncDirectory(input.directory);
  } catch (cause) {
    await NodeFSP.rm(tempPath, { force: true }).catch(() => undefined);
    throw cause;
  }
}

async function withReceiptLock<A>(
  directory: string,
  filePath: string,
  work: () => Promise<A>,
): Promise<A> {
  await ensurePrivateDirectory(directory);
  const lockPath = `${filePath}.lock`;
  const lock = await NodeFSP.open(
    lockPath,
    NodeFS.constants.O_WRONLY |
      NodeFS.constants.O_CREAT |
      NodeFS.constants.O_EXCL |
      (NodeFS.constants.O_NOFOLLOW ?? 0),
    PRIVATE_FILE_MODE,
  );
  try {
    await lock.sync();
    await syncDirectory(directory);
    return await work();
  } finally {
    await lock.close().catch(() => undefined);
    await NodeFSP.unlink(lockPath).catch(() => undefined);
    await syncDirectory(directory).catch(() => undefined);
  }
}

async function writeAtomically(input: {
  readonly directory: string;
  readonly filePath: string;
  readonly receipt: PrimeAgentOwnershipReceipt;
  readonly replace: boolean;
  readonly expected?: PrimeAgentOwnershipReceipt;
}): Promise<void> {
  return await withReceiptLock(input.directory, input.filePath, () =>
    writeAtomicallyUnlocked(input),
  );
}

function receiptHandle(receipt: PrimeAgentOwnershipReceipt): PrimeAgentOwnershipReceiptHandle {
  return Object.freeze({
    attemptId: receipt.attemptId,
    instanceId: receipt.instanceId,
    creationConfigRevision: receipt.creationConfigRevision,
    currentConfigRevision: receipt.currentConfigRevision,
    effectiveHome: receipt.effectiveHome,
  });
}

export function primeAgentOwnershipHomesOverlap(
  left: string,
  right: string,
  platform: NodeJS.Platform,
): boolean {
  const normalize = (value: string) =>
    platform === "darwin" || platform === "win32" ? value.toLowerCase() : value;
  const normalizedLeft = normalize(NodePath.normalize(left));
  const normalizedRight = normalize(NodePath.normalize(right));
  const relative = NodePath.relative(normalizedLeft, normalizedRight);
  if (relative === "") return true;
  if (
    !NodePath.isAbsolute(relative) &&
    relative !== ".." &&
    !relative.startsWith(`..${NodePath.sep}`)
  ) {
    return true;
  }
  const inverse = NodePath.relative(normalizedRight, normalizedLeft);
  return (
    !NodePath.isAbsolute(inverse) && inverse !== ".." && !inverse.startsWith(`..${NodePath.sep}`)
  );
}

export class PrimeAgentOwnershipReceiptStore {
  readonly stateDir: string;
  readonly directory: string;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    this.directory = NodePath.join(stateDir, "provider-sessions", "prime-agent", RECEIPT_DIRECTORY);
  }

  private filePath(attemptId: string): string {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(attemptId)
    ) {
      throw new Error("Prime Agent ownership attempt identity is invalid");
    }
    return NodePath.join(this.directory, `${attemptId}${RECEIPT_FILE_SUFFIX}`);
  }

  async scan(): Promise<PrimeAgentOwnershipReceiptScan> {
    try {
      await ensurePrivateDirectory(this.directory);
      const entries = await NodeFSP.readdir(this.directory, { withFileTypes: true });
      const receipts: PrimeAgentOwnershipReceipt[] = [];
      let corrupt = false;
      for (const entry of entries) {
        if (
          !entry.isFile() ||
          entry.isSymbolicLink() ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/iu.test(
            entry.name,
          )
        ) {
          corrupt = true;
          continue;
        }
        try {
          const receipt = await readReceiptFile(NodePath.join(this.directory, entry.name));
          const canonicalHome = await canonicalizeStoredHome(receipt.effectiveHome);
          if (
            `${receipt.attemptId}${RECEIPT_FILE_SUFFIX}` !== entry.name ||
            canonicalHome !== receipt.effectiveHome
          ) {
            corrupt = true;
          } else {
            receipts.push(receipt);
          }
        } catch {
          corrupt = true;
        }
      }
      return { receipts, corrupt };
    } catch {
      return { receipts: [], corrupt: true };
    }
  }

  async begin(input: {
    readonly instanceId: string;
    readonly configRevision: string;
    readonly effectiveHome: string;
  }): Promise<PrimeAgentOwnershipReceiptHandle> {
    const receipt: PrimeAgentOwnershipReceipt = {
      version: RECEIPT_VERSION,
      state: "pending",
      attemptId: NodeCrypto.randomUUID(),
      instanceId: input.instanceId,
      creationConfigRevision: input.configRevision,
      currentConfigRevision: input.configRevision,
      effectiveHome: input.effectiveHome,
      ownerProcessId: PROCESS_OWNER_ID,
    };
    await writeAtomically({
      directory: this.directory,
      filePath: this.filePath(receipt.attemptId),
      receipt,
      replace: false,
    });
    return receiptHandle(receipt);
  }

  async markAcquired(
    handle: PrimeAgentOwnershipReceiptHandle,
    input: {
      readonly activeSessionId: string;
      readonly nativeSessionId: string;
      readonly attachProof: PrimeAgentOwnedSessionContractProof;
      readonly recovery?: PrimeAgentOwnershipRecoveryIdentity;
    },
  ): Promise<PrimeAgentOwnershipReceiptHandle> {
    const filePath = this.filePath(handle.attemptId);
    const previous = await readReceiptFile(filePath);
    if (
      previous.state !== "pending" ||
      previous.instanceId !== handle.instanceId ||
      previous.creationConfigRevision !== handle.creationConfigRevision ||
      previous.currentConfigRevision !== handle.currentConfigRevision ||
      previous.effectiveHome !== handle.effectiveHome ||
      previous.ownerProcessId !== PROCESS_OWNER_ID
    ) {
      throw new Error("Prime Agent ownership receipt is not owned by this attempt");
    }
    const receipt: PrimeAgentAcquiredOwnershipReceipt = {
      ...previous,
      state: "acquired",
      activeSessionId: input.activeSessionId,
      nativeSessionId: input.nativeSessionId,
      attachProof: input.attachProof,
      ...(input.recovery === undefined ? {} : { recovery: input.recovery }),
    };
    await writeAtomically({
      directory: this.directory,
      filePath,
      receipt,
      replace: true,
      expected: previous,
    });
    liveSafeAttempts.add(receipt.attemptId);
    return receiptHandle(receipt);
  }

  async refreshAttachProof(
    handle: PrimeAgentOwnershipReceiptHandle,
    attachProof: PrimeAgentOwnedSessionContractProof,
  ): Promise<void> {
    const filePath = this.filePath(handle.attemptId);
    const previous = await readReceiptFile(filePath);
    if (
      previous.state !== "acquired" ||
      previous.currentConfigRevision !== handle.currentConfigRevision ||
      previous.ownerProcessId !== PROCESS_OWNER_ID
    ) {
      throw new Error("Prime Agent ownership receipt is not owned by this generation");
    }
    await writeAtomically({
      directory: this.directory,
      filePath,
      receipt: { ...previous, attachProof },
      replace: true,
      expected: previous,
    });
  }

  markUnsafe(handle: PrimeAgentOwnershipReceiptHandle): void {
    liveSafeAttempts.delete(handle.attemptId);
  }

  async proveNeverAcquired(handle: PrimeAgentOwnershipReceiptHandle): Promise<boolean> {
    const filePath = this.filePath(handle.attemptId);
    return await withReceiptLock(this.directory, filePath, async () => {
      const previous = await readReceiptFile(filePath);
      if (
        previous.state !== "pending" ||
        previous.instanceId !== handle.instanceId ||
        previous.creationConfigRevision !== handle.creationConfigRevision ||
        previous.currentConfigRevision !== handle.currentConfigRevision ||
        previous.effectiveHome !== handle.effectiveHome ||
        previous.ownerProcessId !== PROCESS_OWNER_ID
      ) {
        return false;
      }
      await NodeFSP.unlink(filePath);
      await syncDirectory(this.directory);
      liveSafeAttempts.delete(handle.attemptId);
      return true;
    });
  }

  async clearAfterCleanup(
    handle: PrimeAgentOwnershipReceiptHandle,
    input: {
      readonly activeSessionId: string;
      readonly nativeSessionId: string;
      readonly result: PrimeAgentOwnedSessionDisposeResult;
    },
  ): Promise<boolean> {
    const filePath = this.filePath(handle.attemptId);
    return await withReceiptLock(this.directory, filePath, async () => {
      const previous = await readReceiptFile(filePath);
      if (
        previous.state !== "acquired" ||
        previous.instanceId !== handle.instanceId ||
        previous.creationConfigRevision !== handle.creationConfigRevision ||
        previous.currentConfigRevision !== handle.currentConfigRevision ||
        previous.effectiveHome !== handle.effectiveHome ||
        previous.ownerProcessId !== PROCESS_OWNER_ID ||
        previous.activeSessionId !== input.activeSessionId ||
        previous.nativeSessionId !== input.nativeSessionId ||
        !validCleanupOutcome(input.result, previous.attachProof)
      ) {
        liveSafeAttempts.delete(handle.attemptId);
        return false;
      }
      await NodeFSP.unlink(filePath);
      await syncDirectory(this.directory);
      liveSafeAttempts.delete(handle.attemptId);
      return true;
    });
  }

  async claimForAdoption(input: {
    readonly receipt: PrimeAgentAcquiredOwnershipReceipt;
    readonly nextConfigRevision: string;
    readonly recovery: PrimeAgentOwnershipRecoveryIdentity;
  }): Promise<PrimeAgentOwnershipAdoptionClaim | undefined> {
    const filePath = this.filePath(input.receipt.attemptId);
    const previous = await readReceiptFile(filePath);
    if (
      previous.state !== "acquired" ||
      previous.attemptId !== input.receipt.attemptId ||
      previous.instanceId !== input.receipt.instanceId ||
      previous.creationConfigRevision !== input.receipt.creationConfigRevision ||
      previous.currentConfigRevision !== input.receipt.currentConfigRevision ||
      previous.effectiveHome !== input.receipt.effectiveHome ||
      previous.activeSessionId !== input.receipt.activeSessionId ||
      previous.nativeSessionId !== input.receipt.nativeSessionId ||
      previous.recovery === undefined ||
      previous.recovery.threadId !== input.recovery.threadId ||
      previous.recovery.sessionIncarnationId !== input.recovery.sessionIncarnationId ||
      previous.recovery.admissionRequestId !== input.recovery.admissionRequestId ||
      previous.recovery.recoveryHandle !== input.recovery.recoveryHandle ||
      previous.recovery.ownershipGeneration !== input.recovery.ownershipGeneration
    ) {
      return undefined;
    }
    const claimed: PrimeAgentAcquiredOwnershipReceipt = {
      ...previous,
      currentConfigRevision: input.nextConfigRevision,
      ownerProcessId: PROCESS_OWNER_ID,
    };
    await writeAtomically({
      directory: this.directory,
      filePath,
      receipt: claimed,
      replace: true,
      expected: previous,
    });
    liveSafeAttempts.add(claimed.attemptId);
    return { receipt: claimed, handle: receiptHandle(claimed) };
  }

  async releaseAdoptionClaim(
    claim: PrimeAgentOwnershipAdoptionClaim,
    previous: PrimeAgentAcquiredOwnershipReceipt,
  ): Promise<boolean> {
    const filePath = this.filePath(claim.handle.attemptId);
    const current = await readReceiptFile(filePath);
    if (
      current.state !== "acquired" ||
      current.currentConfigRevision !== claim.handle.currentConfigRevision ||
      current.ownerProcessId !== PROCESS_OWNER_ID
    ) {
      return false;
    }
    await writeAtomically({
      directory: this.directory,
      filePath,
      receipt: previous,
      replace: true,
      expected: current,
    });
    liveSafeAttempts.delete(current.attemptId);
    return true;
  }
}

export function primeAgentOwnershipReceiptIsSafeLive(receipt: PrimeAgentOwnershipReceipt): boolean {
  return receipt.ownerProcessId === PROCESS_OWNER_ID && liveSafeAttempts.has(receipt.attemptId);
}
