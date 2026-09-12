import { EnvironmentId, type ComputerSetupState } from "@t3tools/contracts";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
const mock = vi.hoisted(() => ({
  state: null as ComputerSetupState | null,
  start: vi.fn(),
  cancel: vi.fn(),
  refresh: vi.fn(),
  subscribe: vi.fn(),
}));
vi.mock("react", async (load) => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...(await load<typeof import("react")>()),
    useState: reactHookHarness.useState,
    useRef: reactHookHarness.useRef,
    useEffect: vi.fn(),
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    computerSetupState: mock.subscribe,
    refreshComputerSetup: mock.refresh,
    startComputerSetup: mock.start,
    cancelComputerSetup: mock.cancel,
  },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: (command: unknown) => command }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: mock.state, error: null }),
}));
import { ComputerSetupSection } from "./ComputerSetupSection";
const environmentId = EnvironmentId.make("remote-mac");
const render = () => {
  hooks.beginRender();
  return ComputerSetupSection({
    environmentId,
    environmentLabel: "Remote Mac",
    binaryPath: "cua-driver",
    connected: true,
  });
};
const button = (view: unknown, label: string) =>
  visitElements(
    view,
    (element) => element.props.children === label && typeof element.props.onClick === "function",
  );
const click = (view: unknown, label: string) => {
  const target = button(view, label);
  if (!target || target.props.disabled) throw new Error(`Unavailable ${label}`);
  (target.props.onClick as () => void)();
};
beforeEach(() => {
  hooks.reset();
  vi.clearAllMocks();
  mock.start.mockResolvedValue({ _tag: "Success", value: undefined });
  mock.cancel.mockResolvedValue({ _tag: "Success", value: undefined });
  mock.state = {
    platform: "darwin",
    architecture: "arm64",
    installation: {
      status: "ready",
      source: "system",
      binaryPath: "/driver",
      version: "0.28.1",
      canManage: true,
      message: null,
    },
    permissions: {
      accessibility: "granted",
      screenRecording: "granted",
      capture: "unknown",
      message: null,
    },
    latestRelease: {
      version: "0.28.1",
      assetName: "driver",
      sha256: "a".repeat(64),
      bytes: 42,
      releaseUrl: "https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.28.1",
    },
    checkedAt: null,
    updateMessage: null,
    operationId: null,
    action: null,
    phase: "idle",
    downloadedBytes: 0,
    totalBytes: null,
    message: null,
  };
});
it("requires a concrete confirmation before repair and targets the selected environment", () => {
  click(render(), "Repair installation");
  expect(mock.start).not.toHaveBeenCalled();
  click(render(), "Continue");
  expect(mock.start).toHaveBeenCalledWith({
    environmentId,
    input: { action: "repair", expectedVersion: "0.28.1" },
  });
});
it("does not offer to downgrade a newer installed release", () => {
  mock.state = { ...mock.state!, installation: { ...mock.state!.installation, version: "0.29.0" } };
  expect(button(render(), "Repair installation")?.props.disabled).toBe(true);
});
it("does not offer managed repair for a custom executable", () => {
  mock.state = {
    ...mock.state!,
    installation: { ...mock.state!.installation, source: "custom", canManage: false },
  };
  expect(button(render(), "Repair installation")).toBeNull();
});
it("uses the current operation id for cancellation and hides cancel during activation", () => {
  mock.state = {
    ...mock.state!,
    operationId: "download-2",
    action: "update",
    phase: "downloading",
  };
  click(render(), "Cancel setup");
  expect(mock.cancel).toHaveBeenCalledWith({ environmentId, input: { operationId: "download-2" } });
  mock.state = { ...mock.state, phase: "activating" };
  expect(button(render(), "Cancel setup")).toBeNull();
});
it("opens permission setup on the selected remote environment", () => {
  click(render(), "Open permission setup");
  expect(mock.start).toHaveBeenCalledWith({ environmentId, input: { action: "permissions" } });
});
