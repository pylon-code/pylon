import {
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "@t3tools/client-runtime/connection";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId, type AssetCreateUrlResult, type AssetResource } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useAssetUrlRefresh } from "./assetUrls";

const state = vi.hoisted(() => ({
  prepared: null as PreparedConnection | null,
  authorize:
    vi.fn<
      (
        target: unknown,
        options?: { signal?: AbortSignal },
      ) => Promise<AtomCommandResult<AssetCreateUrlResult, never>>
    >(),
}));
vi.mock("~/state/assets", () => ({ assetEnvironment: { createUrl: () => {} } }));
vi.mock("~/state/session", () => ({
  usePreparedConnection: () => Option.fromNullishOr(state.prepared),
  readPreparedConnection: () => state.prepared,
}));
vi.mock("~/state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => state.authorize }));

const environmentId = EnvironmentId.make("asset-refresh");
const resource: AssetResource = { _tag: "attachment", attachmentId: "file" };
function connection(base: string): PreparedConnection {
  return {
    environmentId,
    label: "Source",
    httpBaseUrl: base,
    socketUrl: "wss://source.test",
    httpAuthorization: null,
    target: new PrimaryConnectionTarget({
      environmentId,
      label: "Source",
      httpBaseUrl: base,
      wsBaseUrl: "wss://source.test",
    }),
  };
}
function success(token: string): AtomCommandResult<AssetCreateUrlResult, never> {
  return AsyncResult.success({ relativeUrl: `/api/assets/${token}`, expiresAt: 3600 });
}
let renderer: ReactTestRenderer | undefined;
let refresh: ReturnType<typeof useAssetUrlRefresh>;
function Probe() {
  const current = useAssetUrlRefresh(environmentId, resource);
  useLayoutEffect(() => {
    refresh = current;
  }, [current]);
  return null;
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.prepared = connection("https://old.test/");
  state.authorize.mockReset();
  await act(() => {
    renderer = create(<Probe />);
  });
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

describe("asset authorization ownership", () => {
  it("reauthorizes after reconnect instead of rebasing an old capability onto a new host", async () => {
    state.authorize
      .mockImplementationOnce(async () => {
        state.prepared = connection("https://new.test/");
        return success("old-token");
      })
      .mockResolvedValueOnce(success("new-token"));
    expect(await refresh()).toBe("https://new.test/api/assets/new-token");
    expect(state.authorize).toHaveBeenCalledTimes(2);
  });

  it("treats new credentials on the same host as a different authorization identity", async () => {
    state.authorize
      .mockImplementationOnce(async () => {
        state.prepared = connection("https://old.test/");
        return success("previous-session");
      })
      .mockResolvedValueOnce(success("current-session"));
    expect(await refresh()).toBe("https://old.test/api/assets/current-session");
    expect(state.authorize).toHaveBeenCalledTimes(2);
  });

  it("does not resolve a capability after its environment disappears", async () => {
    state.authorize.mockImplementationOnce(async () => {
      state.prepared = null;
      return success("abandoned");
    });
    expect(await refresh()).toBeNull();
  });

  it("passes caller cancellation through the pending authorization wait", async () => {
    state.authorize.mockImplementation(
      (_target, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
            once: true,
          });
        }),
    );
    const controller = new AbortController();
    const pending = refresh(controller.signal);
    const rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejection;
  });
});
