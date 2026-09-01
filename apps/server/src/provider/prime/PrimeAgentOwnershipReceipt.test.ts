// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import type {
  PrimeAgentOwnedSessionContractProof,
  PrimeAgentOwnedSessionDisposeResult,
} from "./PrimeAgentDaemonBridge.ts";
import {
  PrimeAgentOwnershipReceiptStore,
  primeAgentOwnershipHomesOverlap,
} from "./PrimeAgentOwnershipReceipt.ts";

const roots: string[] = [];

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
  return { root, home, store: new PrimeAgentOwnershipReceiptStore(root) };
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

    const scan = await new PrimeAgentOwnershipReceiptStore(test.root).scan();
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
