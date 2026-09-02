// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimers from "node:timers";

import { afterEach, describe, expect, it } from "vite-plus/test";

import type {
  PrimeAgentOwnedSessionContractProof,
  PrimeAgentOwnedSessionDisposeResult,
} from "./PrimeAgentDaemonBridge.ts";
import {
  PrimeAgentOwnershipReceiptStore,
  primeAgentOwnershipHomeLockDigest,
  primeAgentOwnershipHomesOverlap,
} from "./PrimeAgentOwnershipReceipt.ts";

const roots: string[] = [];
const inspectTestProcessIdentity = async (pid: number) => `test:${pid}`;

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const createdRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pylon-prime-owner-"));
  const root = await NodeFSP.realpath(createdRoot);
  roots.push(root);
  const home = NodePath.join(root, "prime-home");
  await NodeFSP.mkdir(home, { recursive: true });
  return {
    root,
    home,
    store: new PrimeAgentOwnershipReceiptStore(root, {
      inspectProcessIdentity: inspectTestProcessIdentity,
    }),
  };
}

async function lockPathForAttempt(
  store: PrimeAgentOwnershipReceiptStore,
  attemptId: string,
): Promise<string> {
  const entry = (await NodeFSP.readdir(store.directory)).find(
    (name) => name.startsWith(`${attemptId}.`) && name.endsWith(".json.lock"),
  );
  if (entry === undefined) throw new Error(`missing ownership lock for ${attemptId}`);
  return NodePath.join(store.directory, entry);
}

function controlledBarrier() {
  let enter!: (value: { readonly attemptId: string; readonly effectiveHome: string }) => void;
  let release!: () => void;
  const entered = new Promise<{ readonly attemptId: string; readonly effectiveHome: string }>(
    (resolve) => {
      enter = resolve;
    },
  );
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    entered,
    release,
    wait: async (identity: Awaited<typeof entered>) => {
      enter(identity);
      await blocked;
    },
  };
}

const proof = (supervisorGeneration = "supervisor-a", transportGeneration = 1) =>
  ({
    feature: "caller_owned_session_environment_cleanup_v1",
    status: "attached",
    daemon: {
      protocolName: "prime-agent.daemon",
      protocolVersion: 7,
      schemaRevision: 30,
      appVersion: "1.2.3",
      buildId: "managed-build",
      supervisorGeneration,
      transportGeneration,
    },
  }) satisfies PrimeAgentOwnedSessionContractProof;

const settled = (
  status: "completed" | "already_completed" | "replacement_settled",
  started = proof(),
): PrimeAgentOwnedSessionDisposeResult =>
  status === "replacement_settled"
    ? {
        feature: "caller_owned_session_environment_cleanup_v1",
        status,
        started,
        observed: proof("supervisor-b", 2).daemon,
        daemonReplaced: true,
      }
    : {
        feature: "caller_owned_session_environment_cleanup_v1",
        status,
        started,
        observed: started.daemon,
        daemonReplaced: false,
      };

async function acquired(input: Awaited<ReturnType<typeof fixture>>, suffix = "a") {
  const handle = await input.store.begin({
    instanceId: `prime-${suffix}`,
    configRevision: `generation-${suffix}`,
    effectiveHome: input.home,
  });
  const acquiredHandle = await input.store.markAcquired(handle, {
    activeSessionId: `active-${suffix}`,
    nativeSessionId: `session-${suffix}`,
    attachProof: proof(),
    recovery: {
      threadId: `thread-${suffix}`,
      sessionIncarnationId: `incarnation-${suffix}`,
      admissionRequestId: `admission-${suffix}`,
      recoveryHandle: `opaque-recovery-${suffix}`,
      ownershipGeneration: 1,
    },
  });
  return acquiredHandle;
}

describe("PrimeAgentOwnershipReceiptStore", () => {
  it("persists a private dirty receipt before acquisition and keeps a crash dirty", async () => {
    const test = await fixture();
    const handle = await test.store.begin({
      instanceId: "prime-a",
      configRevision: "generation-a",
      effectiveHome: test.home,
    });

    const scan = await new PrimeAgentOwnershipReceiptStore(test.root, {
      inspectProcessIdentity: inspectTestProcessIdentity,
    }).scan();
    expect(scan).toMatchObject({ corrupt: false, receipts: [{ state: "pending" }] });
    expect(scan.receipts[0]).toMatchObject({ attemptId: handle.attemptId });
    const fileInfo = await NodeFSP.stat(
      NodePath.join(test.store.directory, `${handle.attemptId}.json`),
    );
    if (process.getuid !== undefined) expect(fileInfo.mode & 0o777).toBe(0o600);
  });

  it.each(["completed", "already_completed", "replacement_settled"] as const)(
    "clears only the same exact acquired receipt after %s proof",
    async (status) => {
      const test = await fixture();
      const handle = await acquired(test);
      await expect(
        test.store.clearAfterCleanup(handle, {
          activeSessionId: "active-a",
          nativeSessionId: "session-a",
          result: settled(status),
        }),
      ).resolves.toBe(true);
      await expect(test.store.scan()).resolves.toMatchObject({ corrupt: false, receipts: [] });
    },
  );

  it.each([
    { feature: "caller_owned_session_environment_cleanup_v1", status: "owner_mismatch" },
    {
      feature: "caller_owned_session_environment_cleanup_v1",
      status: "uncertain",
      reason: "active",
    },
    { feature: "caller_owned_session_environment_cleanup_v1", status: "transport_failure" },
    { feature: "caller_owned_session_environment_cleanup_v1", status: "unsupported" },
  ] satisfies ReadonlyArray<PrimeAgentOwnedSessionDisposeResult>)(
    "keeps non-settled cleanup outcome $status dirty",
    async (result) => {
      const test = await fixture();
      const handle = await acquired(test);
      await expect(
        test.store.clearAfterCleanup(handle, {
          activeSessionId: "active-a",
          nativeSessionId: "session-a",
          result,
        }),
      ).resolves.toBe(false);
      expect((await test.store.scan()).receipts).toHaveLength(1);
    },
  );

  it("rejects wrong generation, session, and attach proof without cross-clearing", async () => {
    const test = await fixture();
    const first = await acquired(test, "a");
    const second = await acquired(test, "b");

    await expect(
      test.store.clearAfterCleanup(
        { ...first, currentConfigRevision: second.currentConfigRevision },
        {
          activeSessionId: "active-a",
          nativeSessionId: "session-a",
          result: settled("completed"),
        },
      ),
    ).resolves.toBe(false);
    await expect(
      test.store.clearAfterCleanup(first, {
        activeSessionId: "active-b",
        nativeSessionId: "session-a",
        result: settled("completed"),
      }),
    ).resolves.toBe(false);
    await expect(
      test.store.clearAfterCleanup(first, {
        activeSessionId: "active-a",
        nativeSessionId: "session-a",
        result: settled("completed", proof("wrong-supervisor", 9)),
      }),
    ).resolves.toBe(false);
    expect((await test.store.scan()).receipts).toHaveLength(2);
  });

  it("claims only the matching recoverable receipt and clears after adopted proof", async () => {
    const test = await fixture();
    const handle = await acquired(test);
    const receipt = (await test.store.scan()).receipts[0];
    if (receipt?.state !== "acquired") throw new Error("expected acquired receipt");

    await expect(
      test.store.claimForAdoption({
        receipt,
        nextConfigRevision: "replacement-generation",
        recovery: {
          threadId: "thread-a",
          sessionIncarnationId: "incarnation-a",
          admissionRequestId: "admission-a",
          recoveryHandle: "wrong-handle",
          ownershipGeneration: 1,
        },
      }),
    ).resolves.toBeUndefined();
    const claim = await test.store.claimForAdoption({
      receipt,
      nextConfigRevision: "replacement-generation",
      recovery: receipt.recovery!,
    });
    expect(claim?.handle).toMatchObject({
      attemptId: handle.attemptId,
      creationConfigRevision: "generation-a",
      currentConfigRevision: "replacement-generation",
    });
    await test.store.refreshAttachProof(claim!.handle, proof("supervisor-a", 2));
    await expect(
      test.store.clearAfterCleanup(claim!.handle, {
        activeSessionId: "active-a",
        nativeSessionId: "session-a",
        result: settled("already_completed", proof("supervisor-a", 2)),
      }),
    ).resolves.toBe(true);
  });

  it("rotates adoption recovery with an exact idempotent CAS", async () => {
    const test = await fixture();
    await acquired(test);
    const original = (await test.store.scan()).receipts[0];
    if (original?.state !== "acquired" || original.recovery === undefined) {
      throw new Error("expected acquired recovery receipt");
    }
    const claim = await test.store.claimForAdoption({
      receipt: original,
      nextConfigRevision: "replacement-generation",
      recovery: original.recovery,
    });
    if (claim === undefined) throw new Error("expected adoption claim");
    const rotatedRecovery = {
      ...original.recovery,
      recoveryHandle: "rotated-recovery",
      ownershipGeneration: original.recovery.ownershipGeneration + 1,
    };

    const rotated = await test.store.rotateAdoptionRecovery(claim, rotatedRecovery);
    expect(rotated?.receipt.recovery).toEqual(rotatedRecovery);
    await expect(test.store.rotateAdoptionRecovery(claim, rotatedRecovery)).resolves.toMatchObject({
      receipt: { recovery: rotatedRecovery },
    });
    await expect(
      test.store.rotateAdoptionRecovery(claim, {
        ...rotatedRecovery,
        recoveryHandle: "uncommitted-recovery",
      }),
    ).resolves.toBeUndefined();

    const restartedClaim = await test.store.claimForAdoption({
      receipt: rotated!.receipt,
      nextConfigRevision: "second-restart-generation",
      recovery: rotatedRecovery,
    });
    expect(restartedClaim?.receipt.recovery).toEqual(rotatedRecovery);
    await expect(
      test.store.rotateAdoptionRecovery(restartedClaim!, rotatedRecovery),
    ).resolves.toMatchObject({ receipt: { recovery: rotatedRecovery } });
  });

  it("does not let an older adoption release overwrite newer ownership", async () => {
    const test = await fixture();
    await acquired(test);
    const original = (await test.store.scan()).receipts[0];
    if (original?.state !== "acquired" || original.recovery === undefined) {
      throw new Error("expected acquired recovery receipt");
    }
    const first = await test.store.claimForAdoption({
      receipt: original,
      nextConfigRevision: "replacement-a",
      recovery: original.recovery,
    });
    if (first === undefined) throw new Error("expected first adoption claim");
    const second = await test.store.claimForAdoption({
      receipt: first.receipt,
      nextConfigRevision: "replacement-b",
      recovery: original.recovery,
    });
    if (second === undefined) throw new Error("expected successor adoption claim");

    await expect(test.store.releaseAdoptionClaim(first, original)).resolves.toBe(false);
    const current = (await test.store.scan()).receipts[0];
    expect(current?.currentConfigRevision).toBe("replacement-b");
  });

  it("admits only one atomic claimant for an exact recovery receipt", async () => {
    const test = await fixture();
    await acquired(test);
    const receipt = (await test.store.scan()).receipts[0];
    if (receipt?.state !== "acquired" || receipt.recovery === undefined) {
      throw new Error("expected acquired recovery receipt");
    }

    const attempts = await Promise.allSettled([
      test.store.claimForAdoption({
        receipt,
        nextConfigRevision: "replacement-a",
        recovery: receipt.recovery,
      }),
      test.store.claimForAdoption({
        receipt,
        nextConfigRevision: "replacement-b",
        recovery: receipt.recovery,
      }),
    ]);
    const claims = attempts.flatMap((attempt) =>
      attempt.status === "fulfilled" && attempt.value !== undefined ? [attempt.value] : [],
    );
    expect(claims).toHaveLength(1);
    const scan = await test.store.scan();
    expect(scan).toMatchObject({ corrupt: false, receipts: [{ state: "acquired" }] });
    expect(scan.receipts[0]?.currentConfigRevision).toBe(claims[0]?.handle.currentConfigRevision);
  });

  it("reconciles a SIGKILL lock left at the durable mutation barrier", async () => {
    const test = await fixture();
    const helperPath = NodePath.join(test.root, "crash-lock-helper.ts");
    const sourcePath = NodePath.join(import.meta.dirname, "PrimeAgentOwnershipReceipt.ts");
    await NodeFSP.writeFile(
      helperPath,
      [
        `import { PrimeAgentOwnershipReceiptStore } from ${JSON.stringify(sourcePath)};`,
        `const store = new PrimeAgentOwnershipReceiptStore(${JSON.stringify(test.root)}, {`,
        "  platform: process.platform as NodeJS.Platform,",
        "  afterLockPersisted: async (identity) => {",
        "    console.log(identity.attemptId);",
        "    await new Promise<void>(() => undefined);",
        "  },",
        "});",
        "await store.begin({",
        '  instanceId: "prime-crashed",',
        '  configRevision: "generation-crashed",',
        `  effectiveHome: ${JSON.stringify(test.home)},`,
        "});",
      ].join("\n"),
      { mode: 0o600 },
    );
    const child = NodeChildProcess.spawn("node", ["--experimental-strip-types", helperPath], {
      cwd: NodePath.resolve("."),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const childExit = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    });
    const attemptId = await new Promise<string>((resolve, reject) => {
      // @effect-diagnostics-next-line globalTimers:off
      const timeout = NodeTimers.setTimeout(
        () => reject(new Error("lock helper readiness timed out")),
        5_000,
      );
      let output = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        output += chunk;
        const lineEnd = output.indexOf("\n");
        if (lineEnd < 0) return;
        NodeTimers.clearTimeout(timeout);
        resolve(output.slice(0, lineEnd).trim());
      });
      child.once("error", (cause) => {
        NodeTimers.clearTimeout(timeout);
        reject(cause);
      });
      child.once("exit", () => {
        NodeTimers.clearTimeout(timeout);
        reject(new Error("lock helper exited before the durable barrier"));
      });
    });
    const lockPath = await lockPathForAttempt(test.store, attemptId);
    expect((await NodeFSP.stat(lockPath)).mode & 0o777).toBe(0o600);
    expect(child.kill("SIGKILL")).toBe(true);
    await new Promise<void>((resolve, reject) => {
      // @effect-diagnostics-next-line globalTimers:off
      const timeout = NodeTimers.setTimeout(
        () => reject(new Error("lock helper SIGKILL timed out")),
        5_000,
      );
      void childExit.then(() => {
        NodeTimers.clearTimeout(timeout);
        resolve();
      });
    });

    const replacement = new PrimeAgentOwnershipReceiptStore(test.root, {
      inspectProcessIdentity: async () => undefined,
    });
    await expect(replacement.scan()).resolves.toEqual({
      receipts: [],
      quarantinedHomes: [],
      quarantinedHomeDigests: [],
      corrupt: false,
    });
    await expect(NodeFSP.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("scopes live, unknown, and wrong-mode locks to one home without blocking a sibling", async () => {
    const test = await fixture();
    const homeB = NodePath.join(test.root, "prime-home-b");
    await NodeFSP.mkdir(homeB, { recursive: true });
    const barrier = controlledBarrier();
    const lockedStore = new PrimeAgentOwnershipReceiptStore(test.root, {
      inspectProcessIdentity: async (pid) => `live:${pid}`,
      afterLockPersisted: barrier.wait,
    });
    const pendingA = lockedStore.begin({
      instanceId: "prime-a",
      configRevision: "generation-a",
      effectiveHome: test.home,
    });
    const locked = await barrier.entered;
    const lockPath = await lockPathForAttempt(test.store, locked.attemptId);

    const liveScan = await new PrimeAgentOwnershipReceiptStore(test.root, {
      inspectProcessIdentity: async (pid) => `live:${pid}`,
    }).scan();
    expect(liveScan).toEqual({
      receipts: [],
      quarantinedHomes: [test.home],
      quarantinedHomeDigests: [primeAgentOwnershipHomeLockDigest(test.home)],
      corrupt: false,
    });

    const unknownScan = await new PrimeAgentOwnershipReceiptStore(test.root, {
      inspectProcessIdentity: async () => undefined,
    }).scan();
    expect(unknownScan).toEqual({
      receipts: [],
      quarantinedHomes: [test.home],
      quarantinedHomeDigests: [primeAgentOwnershipHomeLockDigest(test.home)],
      corrupt: false,
    });

    if (process.getuid !== undefined) {
      await NodeFSP.chmod(lockPath, 0o644);
      const wrongMode = await new PrimeAgentOwnershipReceiptStore(test.root, {
        inspectProcessIdentity: inspectTestProcessIdentity,
      }).scan();
      expect(wrongMode).toEqual({
        receipts: [],
        quarantinedHomes: [],
        quarantinedHomeDigests: [primeAgentOwnershipHomeLockDigest(test.home)],
        corrupt: false,
      });
      await NodeFSP.chmod(lockPath, 0o600);
    }

    const sibling = await new PrimeAgentOwnershipReceiptStore(test.root, {
      inspectProcessIdentity: inspectTestProcessIdentity,
    }).begin({
      instanceId: "prime-b",
      configRevision: "generation-b",
      effectiveHome: homeB,
    });
    expect(sibling.effectiveHome).toBe(homeB);
    barrier.release();
    await expect(pendingA).resolves.toMatchObject({ attemptId: locked.attemptId });
  });

  it("never lets one attempt release another live lock and scopes a known symlink lock", async () => {
    const test = await fixture();
    const homeB = NodePath.join(test.root, "prime-home-b");
    await NodeFSP.mkdir(homeB, { recursive: true });
    const releaseByHome = new Map<string, () => void>();
    let enterA!: (value: { readonly attemptId: string; readonly effectiveHome: string }) => void;
    let enterB!: (value: { readonly attemptId: string; readonly effectiveHome: string }) => void;
    const enteredA = new Promise<{ readonly attemptId: string; readonly effectiveHome: string }>(
      (resolve) => {
        enterA = resolve;
      },
    );
    const enteredB = new Promise<{ readonly attemptId: string; readonly effectiveHome: string }>(
      (resolve) => {
        enterB = resolve;
      },
    );
    const store = new PrimeAgentOwnershipReceiptStore(test.root, {
      inspectProcessIdentity: inspectTestProcessIdentity,
      afterLockPersisted: (identity) => {
        (identity.effectiveHome === test.home ? enterA : enterB)(identity);
        return new Promise<void>((resolve) => releaseByHome.set(identity.effectiveHome, resolve));
      },
    });
    const pendingA = store.begin({
      instanceId: "prime-a",
      configRevision: "generation-a",
      effectiveHome: test.home,
    });
    const lockA = await enteredA;
    const pendingB = store.begin({
      instanceId: "prime-b",
      configRevision: "generation-b",
      effectiveHome: homeB,
    });
    const lockB = await enteredB;

    releaseByHome.get(test.home)?.();
    await pendingA;
    const lockBPath = await lockPathForAttempt(test.store, lockB.attemptId);
    await expect(NodeFSP.stat(lockBPath)).resolves.toMatchObject({});
    expect((await test.store.scan()).quarantinedHomes).toContain(homeB);
    releaseByHome.get(homeB)?.();
    const handleB = await pendingB;

    const target = NodePath.join(test.root, "lock-target");
    await NodeFSP.writeFile(target, "not trusted", { mode: 0o600 });
    const symlinkPath = NodePath.join(
      test.store.directory,
      `${handleB.attemptId}.${primeAgentOwnershipHomeLockDigest(homeB)}.json.lock`,
    );
    await NodeFSP.symlink(target, symlinkPath);
    const orphanSymlinkPath = NodePath.join(
      test.store.directory,
      `00000000-0000-4000-8000-000000000000.${primeAgentOwnershipHomeLockDigest(test.home)}.json.lock`,
    );
    await NodeFSP.symlink(target, orphanSymlinkPath);
    const symlinkScan = await test.store.scan();
    expect(symlinkScan.corrupt).toBe(false);
    expect(symlinkScan.quarantinedHomes).toContain(homeB);
    expect(symlinkScan.quarantinedHomes).not.toContain(test.home);
    expect(symlinkScan.quarantinedHomeDigests).toEqual(
      expect.arrayContaining([
        primeAgentOwnershipHomeLockDigest(test.home),
        primeAgentOwnershipHomeLockDigest(homeB),
      ]),
    );
    expect(lockA.effectiveHome).toBe(test.home);
  });

  it("fails closed for corrupt, symlinked, and non-private receipts", async () => {
    const corrupt = await fixture();
    await NodeFSP.mkdir(corrupt.store.directory, { recursive: true, mode: 0o700 });
    await NodeFSP.writeFile(NodePath.join(corrupt.store.directory, "not-a-receipt.json"), "{}", {
      mode: 0o600,
    });
    await expect(corrupt.store.scan()).resolves.toMatchObject({ corrupt: true });

    const linked = await fixture();
    await NodeFSP.mkdir(linked.store.directory, { recursive: true, mode: 0o700 });
    const target = NodePath.join(linked.root, "target");
    await NodeFSP.writeFile(target, "{}", { mode: 0o600 });
    await NodeFSP.symlink(
      target,
      NodePath.join(linked.store.directory, "00000000-0000-4000-8000-000000000000.json"),
    );
    await expect(linked.store.scan()).resolves.toMatchObject({ corrupt: true });

    if (process.getuid !== undefined) {
      const loose = await fixture();
      const looseHandle = await loose.store.begin({
        instanceId: "prime-loose",
        configRevision: "generation-loose",
        effectiveHome: loose.home,
      });
      await NodeFSP.chmod(
        NodePath.join(loose.store.directory, `${looseHandle.attemptId}.json`),
        0o644,
      );
      await expect(loose.store.scan()).resolves.toMatchObject({ corrupt: true });
    }
  });

  it("detects equal, ancestor, and descendant homes without treating siblings as overlap", () => {
    expect(primeAgentOwnershipHomesOverlap("/srv/prime", "/srv/prime", "linux")).toBe(true);
    expect(primeAgentOwnershipHomesOverlap("/srv/prime", "/srv/prime/child", "linux")).toBe(true);
    expect(primeAgentOwnershipHomesOverlap("/srv/prime/child", "/srv/prime", "linux")).toBe(true);
    expect(primeAgentOwnershipHomesOverlap("/srv/prime-a", "/srv/prime-b", "linux")).toBe(false);
  });
});
