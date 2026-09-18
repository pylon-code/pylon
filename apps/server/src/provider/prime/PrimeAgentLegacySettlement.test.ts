// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { recoverPrimeAgentLegacySettlement } from "./PrimeAgentLegacySettlement.ts";
import { PrimeAgentOwnershipReceiptStore } from "./PrimeAgentOwnershipReceipt.ts";
import type { PrimeAgentDaemonBridge } from "./PrimeAgentDaemonBridge.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "prime-legacy-")),
  );
  roots.push(root);
  const store = new PrimeAgentOwnershipReceiptStore(root, {
    inspectProcessIdentity: async (pid) => `test:${pid}`,
  });
  const handle = await store.begin({
    instanceId: "primeAgent",
    configRevision: "revision",
    effectiveHome: root,
  });
  await store.markAcquired(handle, {
    activeSessionId: "previous-active",
    nativeSessionId: "previous-native",
    attachProof: {
      feature: "caller_owned_session_environment_cleanup_v1",
      status: "attached",
      daemon: {
        protocolName: "prime-agent.daemon",
        protocolVersion: 7,
        schemaRevision: 31,
        supervisorGeneration: "previous-daemon",
        transportGeneration: 1,
      },
    },
  });
  const path = NodePath.join(store.directory, `${handle.attemptId}.json`);
  const scanned = (await store.scan()).receipts[0];
  if (scanned?.state !== "acquired") throw new Error("Missing acquired fixture");
  const saved = { ...scanned, ownerProcessId: "previous-process" };
  await NodeFSP.writeFile(path, JSON.stringify(saved));
  const observe = vi.fn(async () => ({
    feature: "owned_session_settlement_observation_v1",
    status: "settled",
  }));
  // Recovery only consumes the frozen feature list and the observer, not an adapter/session.
  const bridge = {
    sdkFeatures: Object.freeze(["owned_session_settlement_observation_v1"]),
    observeOwnedSessionSettlement: observe,
  } satisfies Pick<PrimeAgentDaemonBridge, "sdkFeatures" | "observeOwnedSessionSettlement">;
  const loadBridge = vi.fn(async () => bridge);
  const run = () =>
    recoverPrimeAgentLegacySettlement({ instanceId: "primeAgent", store, loadBridge });
  return { root, store, path, saved, observe, bridge, loadBridge, run };
}
describe("legacy Prime settlement recovery", () => {
  it("clears only the exact legacy receipt after public SDK settlement", async () => {
    const f = await fixture();
    expect(await f.run()).toBe(true);
    expect(f.observe).toHaveBeenCalledWith({
      agentDir: f.root,
      activeSessionId: "previous-active",
      contractProof: f.saved.attachProof,
    });
    expect((await f.store.scan()).receipts).toEqual([]);
  });
  it.each(["registered", "unavailable", "completed", "unknown"])(
    "retains the receipt for %s",
    async (status) => {
      const f = await fixture();
      f.observe.mockResolvedValue({ feature: "owned_session_settlement_observation_v1", status });
      await expect(f.run()).rejects.toThrow("settlement could not be proved");
      expect((await f.store.scan()).receipts).toHaveLength(1);
    },
  );
  it("does not treat another cleanup feature as settlement", async () => {
    const f = await fixture();
    f.observe.mockResolvedValue({ feature: "other", status: "settled" });
    await expect(f.run()).rejects.toThrow("settlement could not be proved");
  });
  it("keeps records when the observer throws", async () => {
    const f = await fixture();
    f.observe.mockRejectedValue(new Error("offline"));
    await expect(f.run()).rejects.toThrow("offline");
    expect((await f.store.scan()).receipts).toHaveLength(1);
  });
  it("never substitutes settlement observation for recoverable adoption", async () => {
    const f = await fixture();
    f.saved.recovery = {
      threadId: "thread",
      sessionIncarnationId: "incarnation",
      admissionRequestId: "request",
      recoveryHandle: "private",
      ownershipGeneration: 1,
    };
    await NodeFSP.writeFile(f.path, JSON.stringify(f.saved));
    await expect(f.run()).rejects.toThrow("recovery authority");
    expect(f.observe).not.toHaveBeenCalled();
  });
  it("requires the SDK feature, not method presence", async () => {
    const f = await fixture();
    const loadBridge = async () => ({ ...f.bridge, sdkFeatures: [] });
    await expect(
      recoverPrimeAgentLegacySettlement({ instanceId: "primeAgent", store: f.store, loadBridge }),
    ).rejects.toThrow("settlement observation support");
    expect(f.observe).not.toHaveBeenCalled();
  });
  it("cannot cross-clear another instance", async () => {
    const f = await fixture();
    expect(
      await recoverPrimeAgentLegacySettlement({
        instanceId: "other",
        store: f.store,
        loadBridge: f.loadBridge,
      }),
    ).toBe(false);
    expect(f.observe).not.toHaveBeenCalled();
    expect((await f.store.scan()).receipts).toHaveLength(1);
  });
  it("does not clear a receipt replaced while observation was pending", async () => {
    const f = await fixture();
    f.observe.mockImplementation(async () => {
      await NodeFSP.writeFile(
        f.path,
        JSON.stringify({ ...f.saved, nativeSessionId: "replacement" }),
      );
      return { feature: "owned_session_settlement_observation_v1", status: "settled" };
    });
    await expect(f.run()).rejects.toThrow("settlement could not be proved");
    expect((await f.store.scan()).receipts).toHaveLength(1);
  });
});
