import { isValidElement, type Dispatch, type ReactElement, type SetStateAction } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  type EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  SERVER_PROVIDER_UPDATE_ALREADY_RUNNING_REASON,
  ServerProviderUpdateError,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";

import type { ProviderUpdateRowStatus } from "../ProviderUpdateLaunchNotification.logic";
import type { ProviderOperateAccess } from "./ProviderSettingsPanel.logic";

interface TestEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly entry: { readonly target: { readonly _tag: string } };
  readonly connection: { readonly phase: string };
  readonly serverConfig: { readonly providers: ReadonlyArray<ServerProvider> } | null;
}

const testState = vi.hoisted(() => ({
  environments: [] as unknown[],
  access: new Map<string, ProviderOperateAccess>(),
  updateProvider: vi.fn(),
  addToast: vi.fn(),
  closeToast: vi.fn(),
}));

const hooks = vi.hoisted(() => {
  let cursor = 0;
  let slots: unknown[] = [];
  const nextIndex = () => cursor++;
  return {
    beginRender() {
      cursor = 0;
    },
    reset() {
      cursor = 0;
      slots = [];
    },
    useCallback<T>(callback: T): T {
      nextIndex();
      return callback;
    },
    useMemo<T>(factory: () => T): T {
      nextIndex();
      return factory();
    },
    useMemoCache(size: number): unknown[] {
      const index = nextIndex();
      if (!slots[index]) {
        slots[index] = Array.from({ length: size }, () => Symbol.for("react.memo_cache_sentinel"));
      }
      return slots[index] as unknown[];
    },
    useRef<T>(initialValue: T): { current: T } {
      const index = nextIndex();
      if (!slots[index]) {
        slots[index] = { current: initialValue };
      }
      return slots[index] as { current: T };
    },
    useState<T>(initialValue: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
      const index = nextIndex();
      if (index >= slots.length) {
        slots[index] =
          typeof initialValue === "function" ? (initialValue as () => T)() : initialValue;
      }
      const setValue: Dispatch<SetStateAction<T>> = (nextValue) => {
        const previous = slots[index] as T;
        slots[index] =
          typeof nextValue === "function" ? (nextValue as (value: T) => T)(previous) : nextValue;
      };
      return [slots[index] as T, setValue];
    },
  };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useCallback: hooks.useCallback,
    useMemo: hooks.useMemo,
    useRef: hooks.useRef,
    useState: hooks.useState,
  };
});

vi.mock("react/compiler-runtime", () => ({
  c: hooks.useMemoCache,
}));

vi.mock("~/state/server", () => ({
  serverEnvironment: { updateProvider: Symbol("updateProvider") },
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => testState.updateProvider,
}));

vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({ environments: testState.environments }),
  usePrimaryEnvironmentId: () => "local",
}));

vi.mock("./providerOperateAccess", () => ({
  useProviderOperateAccessByEnvironment: () => testState.access,
}));

vi.mock("../ui/toast", () => ({
  stackedThreadToast: <T,>(toast: T) => toast,
  toastManager: { add: testState.addToast, close: testState.closeToast },
}));

import { EnvironmentUpdateRow } from "../ProviderUpdateEnvironmentRows";
import { ProviderUpdateAllEnvironmentsAction } from "./ProviderUpdateAllEnvironments";

const checkedAt = "2026-10-03T10:00:00.000Z";

function provider(input: {
  readonly driver: string;
  readonly instanceId: string;
  readonly canUpdate?: boolean;
  readonly updateState?: ServerProvider["updateState"];
}): ServerProvider {
  const updated = input.updateState?.status === "succeeded";
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: ProviderDriverKind.make(input.driver),
    enabled: true,
    installed: true,
    version: updated ? "1.1.0" : "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    versionAdvisory: {
      status: updated ? "current" : "behind_latest",
      currentVersion: updated ? "1.1.0" : "1.0.0",
      latestVersion: "1.1.0",
      updateCommand: input.canUpdate === false ? null : `npm install -g ${input.driver}`,
      canUpdate: input.canUpdate ?? true,
      checkedAt,
      message: "Update available.",
    },
    ...(input.updateState ? { updateState: input.updateState } : {}),
  };
}

function finished(
  status: "succeeded" | "failed",
  message: string,
): NonNullable<ServerProvider["updateState"]> {
  return {
    status,
    startedAt: checkedAt,
    finishedAt: new Date(Date.now() + 60_000).toISOString(),
    message,
    output: null,
  };
}

function environment(
  id: string,
  input: {
    readonly label?: string;
    readonly primary?: boolean;
    readonly phase?: string;
    readonly providers: ReadonlyArray<ServerProvider>;
  },
): TestEnvironment {
  return {
    environmentId: id as EnvironmentId,
    label: input.label ?? id,
    entry: { target: { _tag: input.primary ? "PrimaryConnectionTarget" : "SshConnectionTarget" } },
    connection: { phase: input.phase ?? "connected" },
    serverConfig: { providers: input.providers },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function render(): ReactElement | null {
  hooks.beginRender();
  return ProviderUpdateAllEnvironmentsAction() as ReactElement | null;
}

function collectElements(node: unknown, found: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) collectElements(child, found);
    return found;
  }
  if (!isValidElement(node)) return found;
  found.push(node);
  const props = node.props as Record<string, unknown>;
  for (const value of Object.values(props)) {
    if (Array.isArray(value) || isValidElement(value)) collectElements(value, found);
  }
  return found;
}

function findButton(tree: ReactElement | null, label: string): { onClick: () => void } {
  const button = collectElements(tree).find(
    (element) => (element.props as { children?: unknown }).children === label,
  );
  if (!button) throw new Error(`No button labelled "${label}"`);
  return button.props as { onClick: () => void };
}

function rows(tree: ReactElement | null) {
  return collectElements(tree)
    .filter((element) => element.type === EnvironmentUpdateRow)
    .map(
      (element) =>
        element.props as {
          readonly group: { readonly environmentId: EnvironmentId };
          readonly status: ProviderUpdateRowStatus;
          readonly onUpdate: () => void;
        },
    );
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
  }
}

type UpdateResult = ReturnType<typeof AsyncResult.success<{ providers: ServerProvider[] }>>;

describe("ProviderUpdateAllEnvironmentsAction", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    hooks.reset();
    testState.updateProvider.mockReset();
    testState.addToast.mockReset();
    testState.addToast.mockReturnValue("summary-toast");
    testState.closeToast.mockReset();
    testState.access = new Map([
      ["local", "granted"],
      ["remote", "granted"],
      ["viewer", "denied"],
    ]);
    testState.environments = [
      environment("local", {
        label: "Mac Studio",
        primary: true,
        providers: [
          provider({ driver: "codex", instanceId: "codex" }),
          provider({ driver: "cursor", instanceId: "cursor", canUpdate: false }),
        ],
      }),
      environment("remote", {
        label: "Laptop",
        providers: [provider({ driver: "codex", instanceId: "codex_laptop" })],
      }),
      environment("viewer", {
        label: "Shared box",
        providers: [provider({ driver: "codex", instanceId: "codex_shared" })],
      }),
      environment("offline", {
        label: "Old server",
        phase: "offline",
        providers: [provider({ driver: "codex", instanceId: "codex_old" })],
      }),
    ];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders nothing when no connected environment has a one-click update", () => {
    testState.environments = [
      environment("local", {
        primary: true,
        providers: [provider({ driver: "cursor", instanceId: "cursor", canUpdate: false })],
      }),
    ];
    expect(render()).toBeNull();
  });

  it("dispatches reviewed targets concurrently and reports partial failure per machine", async () => {
    const local = deferred<UpdateResult>();
    const remote = deferred<UpdateResult>();
    testState.updateProvider.mockImplementation(
      ({ environmentId }: { readonly environmentId: string }) =>
        environmentId === "local" ? local.promise : remote.promise,
    );

    findButton(render(), "Update all connected environments").onClick();
    findButton(render(), "Update 2 providers").onClick();

    // Both environments are sent before either answers, each with its own instance.
    expect(testState.updateProvider.mock.calls.map(([call]) => call)).toEqual([
      {
        environmentId: "local",
        input: {
          provider: ProviderDriverKind.make("codex"),
          instanceId: ProviderInstanceId.make("codex"),
        },
      },
      {
        environmentId: "remote",
        input: {
          provider: ProviderDriverKind.make("codex"),
          instanceId: ProviderInstanceId.make("codex_laptop"),
        },
      },
    ]);

    local.resolve(
      AsyncResult.success({
        providers: [
          provider({
            driver: "codex",
            instanceId: "codex",
            updateState: finished("succeeded", "Provider updated."),
          }),
        ],
      }),
    );
    remote.resolve(
      AsyncResult.success({
        providers: [
          provider({
            driver: "codex",
            instanceId: "codex_laptop",
            updateState: finished("failed", "npm exited with code 1."),
          }),
        ],
      }),
    );
    await flushPromises();

    expect(testState.addToast).toHaveBeenCalledTimes(1);
    const toast = testState.addToast.mock.calls[0]![0] as {
      readonly type: string;
      readonly title: string;
      readonly description: ReactElement<{ readonly children: string }>;
    };
    expect(toast.type).toBe("error");
    expect(toast.title).toBe("1 of 2 provider updates failed");
    expect(toast.description.props.children).toBe("Laptop · Codex: npm exited with code 1.");

    const statuses = rows(render());
    expect(statuses.map((row) => [String(row.group.environmentId), row.status.kind])).toEqual([
      ["local", "success"],
      ["remote", "failed"],
    ]);

    // Retry re-sends only the failed environment.
    testState.updateProvider.mockReset();
    testState.updateProvider.mockReturnValue(new Promise(() => {}));
    statuses[1]!.onUpdate();
    // The summary described the first attempt; the retry supersedes it.
    expect(testState.closeToast).toHaveBeenCalledWith("summary-toast");
    expect(testState.updateProvider).toHaveBeenCalledTimes(1);
    expect(testState.updateProvider.mock.calls[0]![0]).toMatchObject({ environmentId: "remote" });
  });

  it("ignores a repeated click while the run is in flight", () => {
    testState.updateProvider.mockReturnValue(new Promise(() => {}));
    const confirm = findButton(render(), "Update 2 providers");

    confirm.onClick();
    confirm.onClick();

    expect(testState.updateProvider).toHaveBeenCalledTimes(2);
  });

  it("reports interrupted requests and disconnects instead of dropping them", async () => {
    testState.updateProvider.mockImplementation(
      async ({ environmentId }: { readonly environmentId: string }) =>
        environmentId === "local"
          ? AsyncResult.failure(Cause.interrupt())
          : AsyncResult.failure(
              Cause.fail(new Error("The connection changed before this action could be sent.")),
            ),
    );

    findButton(render(), "Update 2 providers").onClick();
    await flushPromises();

    const toast = testState.addToast.mock.calls[0]![0] as {
      readonly type: string;
      readonly title: string;
      readonly description: ReactElement<{ readonly children: string }>;
    };
    expect(toast.type).toBe("error");
    expect(toast.title).toBe("Provider updates did not finish");
    expect(toast.description.props.children).toBe(
      [
        "Mac Studio · Codex: The request was interrupted. Check the provider's status or retry.",
        "Laptop · Codex: The connection changed before this action could be sent.",
      ].join("\n"),
    );
  });

  it("does not dispatch to read-only, disconnected, or Prime-managed providers", () => {
    testState.environments = [
      ...testState.environments,
      environment("prime", {
        label: "Prime box",
        providers: [provider({ driver: "primeAgent", instanceId: "prime" })],
      }),
    ];
    testState.access.set("prime", "granted");
    testState.updateProvider.mockReturnValue(new Promise(() => {}));

    findButton(render(), "Update 2 providers").onClick();

    expect(testState.updateProvider.mock.calls.map(([call]) => String(call.environmentId))).toEqual(
      ["local", "remote"],
    );
  });
  it("finishes the run at the request timeout and returns to review", async () => {
    testState.updateProvider.mockReturnValue(new Promise(() => {}));

    findButton(render(), "Update 2 providers").onClick();
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    await flushPromises();

    expect(testState.addToast).toHaveBeenCalledTimes(1);
    const toast = testState.addToast.mock.calls[0]![0] as {
      readonly type: string;
      readonly title: string;
      readonly description: ReactElement<{ readonly children: string }>;
    };
    expect(toast.type).toBe("warning");
    expect(toast.title).toBe("Provider updates did not finish");
    expect(toast.description.props.children).toBe(
      [
        "Mac Studio · Codex: No response from the environment. Check the provider's status or retry.",
        "Laptop · Codex: No response from the environment. Check the provider's status or retry.",
      ].join("\n"),
    );
    // The dialog was closed when the run ended, so it reopens on review with
    // a working confirm button instead of a stale progress view.
    expect(() => findButton(render(), "Update 2 providers")).not.toThrow();
  });

  it("reports an update already running elsewhere as unfinished, not failed", async () => {
    testState.updateProvider.mockImplementation(
      async ({ environmentId }: { readonly environmentId: string }) =>
        environmentId === "local"
          ? AsyncResult.failure(
              Cause.fail(
                new ServerProviderUpdateError({
                  provider: ProviderDriverKind.make("unknown"),
                  reason: SERVER_PROVIDER_UPDATE_ALREADY_RUNNING_REASON,
                }),
              ),
            )
          : AsyncResult.success({
              providers: [
                provider({
                  driver: "codex",
                  instanceId: "codex_laptop",
                  updateState: finished("succeeded", "Provider updated."),
                }),
              ],
            }),
    );

    findButton(render(), "Update 2 providers").onClick();
    await flushPromises();

    const toast = testState.addToast.mock.calls[0]![0] as {
      readonly type: string;
      readonly title: string;
      readonly description: ReactElement<{ readonly children: string }>;
    };
    expect(toast.type).toBe("warning");
    expect(toast.title).toBe("1 of 2 provider updates did not finish");
    expect(toast.description.props.children).toBe(
      "Mac Studio · Codex: Another update for this provider is already running. Check its status.",
    );
    const local = rows(render()).find((row) => String(row.group.environmentId) === "local");
    expect(local?.status.kind).not.toBe("failed");
  });
});
