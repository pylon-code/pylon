import { ProviderInstanceId, type ServerPrimeManagedMaintenance } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({ Alert: {}, Pressable: "Pressable", View: "View" }));
vi.mock("react-native-reanimated", () => ({
  default: { View: "AnimatedView" },
  FadeIn: {},
  FadeOut: {},
  LinearTransition: {},
}));
vi.mock("../../components/AppText", () => ({ AppText: "Text", AppTextInput: "TextInput" }));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: "SymbolView" }));
vi.mock("../../components/EnvironmentMachineSymbol", () => ({
  EnvironmentMachineSymbol: "EnvironmentMachineSymbol",
}));
vi.mock("../../lib/copyTextWithHaptic", () => ({ copyTextWithHaptic: vi.fn() }));
vi.mock("../../state/server", () => ({ serverEnvironment: {} }));
vi.mock("./ConnectionStatusDot", () => ({ ConnectionStatusDot: "ConnectionStatusDot" }));

import { PrimeHostMaintenanceSnapshot } from "./ConnectionEnvironmentRow";

const stock: ServerPrimeManagedMaintenance = {
  supported: true,
  controlsAvailable: false,
  mode: "stock",
  selectedBuildId: null,
  channel: null,
  availableBuilds: [],
  scheduled: null,
  operation: null,
  message: "Stock Prime Agent is configured.",
  guidance: "No verified release is published.",
};
const instance = (
  result: AsyncResult.AsyncResult<ServerPrimeManagedMaintenance, unknown>,
  label = "Prime Agent",
) => ({
  instanceId: ProviderInstanceId.make(label.replaceAll(" ", "-")),
  label,
  distributionMessage: "Stock distribution",
  result,
});
function visibleText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(visibleText).join(" ");
  if (typeof node === "object" && "props" in node) {
    return visibleText((node as ReactElement<{ children?: ReactNode }>).props.children);
  }
  return "";
}
function render(result: AsyncResult.AsyncResult<ServerPrimeManagedMaintenance, unknown>) {
  return PrimeHostMaintenanceSnapshot({ configKnown: true, instances: [instance(result)] });
}

describe("ConnectionEnvironmentRow Prime maintenance group", () => {
  it("removes the whole unpublished empty group, including heading, border, and instructions", () => {
    expect(render(AsyncResult.success(stock))).toBeNull();
  });

  it.each([
    { ...stock, controlsAvailable: true, message: "Preview is available." },
    {
      ...stock,
      availableBuilds: [{ buildId: "preview-1", channel: "preview" as const, sequence: 1 }],
      message: "Installed preview can be selected.",
    },
  ])("shows published or installed maintenance: $message", (data) => {
    const text = visibleText(render(AsyncResult.success(data)));
    expect(text).toContain("Prime host maintenance");
    expect(text).toContain(data.message);
    expect(text).toContain("Open Provider Settings");
  });

  it("retains loading and errors, including refreshes of an unavailable snapshot", () => {
    expect(visibleText(render(AsyncResult.initial(true)))).toContain(
      "Reading host maintenance status.",
    );
    expect(visibleText(render(AsyncResult.waiting(AsyncResult.success(stock))))).toContain(
      "Reading host maintenance status.",
    );
    const cause = Cause.fail(new Error("Connection lost"));
    expect(visibleText(render(AsyncResult.failure(cause)))).toContain("Connection lost");
    expect(
      visibleText(
        render(
          AsyncResult.failureWithPrevious(cause, {
            previous: Option.some(AsyncResult.success(stock)),
          }),
        ),
      ),
    ).toContain("Connection lost");
  });

  it.each(["scheduled", "operation"] as const)(
    "retains %s progress and failed operations when controls are unavailable",
    (key) => {
      for (const status of ["waiting-for-quiescence", "failed"] as const) {
        const data = {
          ...stock,
          [key]: {
            commandId: "maintenance",
            instanceId: ProviderInstanceId.make("primeAgent"),
            action: "install" as const,
            status,
            channel: "preview" as const,
            buildId: null,
            message: "Waiting for active work",
            startedAt: "2026-09-10T12:00:00.000Z",
            finishedAt: null,
          },
        };
        expect(visibleText(render(AsyncResult.success(data)))).toContain("Waiting for active work");
        const failedRefresh = AsyncResult.failureWithPrevious(Cause.fail(new Error("Offline")), {
          previous: Option.some(AsyncResult.success(data)),
        });
        const text = visibleText(render(failedRefresh));
        expect(text).toContain("Offline");
        expect(text).toContain("Waiting for active work");
      }
    },
  );

  it("filters unavailable instances without losing a visible sibling or duplicating group chrome", () => {
    const text = visibleText(
      PrimeHostMaintenanceSnapshot({
        configKnown: true,
        instances: [
          instance(AsyncResult.success(stock), "Hidden account"),
          instance(AsyncResult.success({ ...stock, controlsAvailable: true }), "Visible account"),
        ],
      }),
    );
    expect(text).not.toContain("Hidden account");
    expect(text).toContain("Visible account");
    expect(text.match(/Prime host maintenance/g)).toHaveLength(1);
  });

  it("keeps unknown and unconfigured environments explicit", () => {
    expect(
      visibleText(PrimeHostMaintenanceSnapshot({ configKnown: false, instances: [] })),
    ).toContain("Connect to read");
    expect(
      visibleText(PrimeHostMaintenanceSnapshot({ configKnown: true, instances: [] })),
    ).toContain("no configured Prime Agent instance");
  });
});
