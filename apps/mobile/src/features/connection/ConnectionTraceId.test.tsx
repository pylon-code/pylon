import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../components/AppText", () => ({ AppText: "Text" }));
vi.mock("../../lib/copyTextWithHaptic", () => ({ copyTextWithHaptic: vi.fn() }));

import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { ConnectionTraceId, connectionTraceAccessibilityAction } from "./ConnectionTraceId";

describe("ConnectionTraceId", () => {
  it("keeps row taps for disclosure while exposing a named accessibility copy action", () => {
    const control = ConnectionTraceId({ traceId: "trace-123", activation: "longPress" });
    const stopPropagation = vi.fn();

    expect(control.props.accessibilityLabel).toBe("Copy trace ID trace-123");
    expect(control.props.accessibilityHint).toBe("Long press to copy the trace ID");
    expect(control.props.accessibilityActions).toEqual([
      { name: "activate", label: "Copy trace ID" },
    ]);
    control.props.onPress({ stopPropagation });
    expect(copyTextWithHaptic).not.toHaveBeenCalled();
    control.props.onAccessibilityAction({
      stopPropagation,
      nativeEvent: { actionName: "activate" },
    });
    expect(copyTextWithHaptic).toHaveBeenCalledWith("trace-123", {
      target: "connection-trace-id",
    });
    expect(stopPropagation).toHaveBeenCalledTimes(2);
  });

  it("copies on press in a notice and ignores unsupported accessibility actions", () => {
    vi.mocked(copyTextWithHaptic).mockClear();
    const control = ConnectionTraceId({ traceId: "trace-456" });
    const stopPropagation = vi.fn();
    control.props.onAccessibilityAction({
      stopPropagation,
      nativeEvent: { actionName: "dismiss" },
    });
    expect(copyTextWithHaptic).not.toHaveBeenCalled();
    control.props.onPress({ stopPropagation });
    expect(copyTextWithHaptic).toHaveBeenCalledWith("trace-456", {
      target: "connection-trace-id",
    });
  });

  it("exposes a named copy action on a disclosure parent without taking over activate", () => {
    vi.mocked(copyTextWithHaptic).mockClear();
    const stopPropagation = vi.fn();
    const action = connectionTraceAccessibilityAction("trace-789");
    expect(action.accessibilityActions).toEqual([
      { name: "copy-trace-id", label: "Copy trace ID" },
    ]);
    action.onAccessibilityAction?.({
      stopPropagation,
      nativeEvent: { actionName: "activate" },
    });
    expect(copyTextWithHaptic).not.toHaveBeenCalled();
    action.onAccessibilityAction?.({
      stopPropagation,
      nativeEvent: { actionName: "copy-trace-id" },
    });
    expect(copyTextWithHaptic).toHaveBeenCalledWith("trace-789", {
      target: "connection-trace-id",
    });
    expect(stopPropagation).toHaveBeenCalledOnce();

    const nested = ConnectionTraceId({
      traceId: "trace-789",
      activation: "longPress",
      parentOwnsAccessibility: true,
    });
    expect(nested.props.accessibilityRole).toBeUndefined();
    expect(nested.props.accessibilityActions).toBeUndefined();
  });
});
