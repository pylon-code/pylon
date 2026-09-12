import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createQueuedModelCatalogRefresh,
  QUEUED_MODEL_CATALOG_REFRESH_TIMEOUT_MS,
} from "./queued-model-catalog-refresh";

const target = {
  environmentId: EnvironmentId.make("remote"),
  messageId: "queued-request",
  selection: {
    instanceId: ProviderInstanceId.make("antigravity_work"),
    model: "antigravity-default",
  },
};

describe("queued account catalog discovery", () => {
  afterEach(() => vi.useRealTimers());

  it("prunes removed requests while retaining held and in-flight account attempts", async () => {
    const refresh = vi.fn(async () => {});
    const runner = createQueuedModelCatalogRefresh(refresh);
    runner.retainQueuedMessages([target]);
    await runner.discover(target);
    // Retaining the message also retains its failed/held attempt after unrelated queue changes.
    runner.retainQueuedMessages([target, { ...target, messageId: "unrelated" }]);
    expect(await runner.discover(target)).toBe(false);
    runner.retainQueuedMessages([]);
    runner.retainQueuedMessages([target]);
    expect(await runner.discover(target)).toBe(true);

    let finish = () => {};
    refresh.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const pendingTarget = { ...target, messageId: "in-flight" };
    runner.retainQueuedMessages([pendingTarget]);
    const pending = runner.discover(pendingTarget);
    runner.retainQueuedMessages([]);
    expect(await runner.discover(pendingTarget)).toBe(false);
    finish();
    await pending;
    runner.retainQueuedMessages([pendingTarget]);
    expect(await runner.discover(pendingTarget)).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(4);
  });

  it("targets the exact account once per request, including overlapping attempts", async () => {
    let finish = () => {};
    const refresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const { discover } = createQueuedModelCatalogRefresh(refresh);
    const first = discover(target);
    expect(await discover(target)).toBe(false);
    expect(refresh).toHaveBeenCalledExactlyOnceWith({
      environmentId: target.environmentId,
      input: { instanceId: target.selection.instanceId, refreshModels: true },
    });
    finish();
    expect(await first).toBe(true);
    expect(await discover(target)).toBe(false);
  });

  it("isolates different destinations, accounts and newer user requests", async () => {
    const refresh = vi.fn(async () => {});
    const { discover } = createQueuedModelCatalogRefresh(refresh);
    await discover(target);
    expect(await discover({ ...target, messageId: "new-request" })).toBe(true);
    expect(await discover({ ...target, environmentId: EnvironmentId.make("local") })).toBe(true);
    expect(
      await discover({
        ...target,
        selection: {
          ...target.selection,
          instanceId: ProviderInstanceId.make("antigravity_personal"),
        },
      }),
    ).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(4);
  });

  it("bounds a stalled refresh and ignores its late completion without retrying forever", async () => {
    vi.useFakeTimers();
    let finish = () => {};
    const refresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const { discover } = createQueuedModelCatalogRefresh(refresh);
    const pending = discover(target);
    await vi.advanceTimersByTimeAsync(QUEUED_MODEL_CATALOG_REFRESH_TIMEOUT_MS);
    expect(await pending).toBe(true);
    expect(await discover(target)).toBe(false);
    finish();
    await Promise.resolve();
    expect(await discover(target)).toBe(false);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns to live admission after rejection instead of losing the queued request", async () => {
    const { discover } = createQueuedModelCatalogRefresh(async () => {
      throw new Error("source disconnected");
    });
    expect(await discover(target)).toBe(true);
    expect(await discover(target)).toBe(false);
  });
});
