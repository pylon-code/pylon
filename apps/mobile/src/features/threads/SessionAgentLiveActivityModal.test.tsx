// @ts-ignore -- Vitest is provided by the vite-plus test runner.
import { describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";

vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
  Modal: "Modal",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  View: "View",
}));
vi.mock("../../components/AppText", () => ({ AppText: "Text" }));
vi.mock("../../state/orchestration", () => ({ orchestrationEnvironment: {} }));

import { SessionAgentLiveActivitySnapshot } from "./SessionAgentLiveActivityModal";

function elements(node: ReactNode): ReadonlyArray<ReactElement> {
  if (node === null || node === undefined || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!("props" in node)) return [];
  const element = node as ReactElement<{ readonly children?: ReactNode }>;
  return [element, ...elements(element.props.children)];
}

describe("SessionAgentLiveActivitySnapshot", () => {
  it("renders the shared static tool statuses with accessible labels only", () => {
    const tree = SessionAgentLiveActivitySnapshot({
      snapshot: {
        agentId: "agent" as never,
        revision: 1,
        entries: [{ speaker: "assistant", text: "Safe update" }],
        activity: [
          { speaker: "assistant", text: "Safe update" },
          { kind: "tool", activityId: 1, label: "Code", status: "started" },
          { kind: "tool", activityId: 2, label: "Shell", status: "completed" },
          { kind: "tool", activityId: 3, label: "Edit", status: "failed" },
        ],
        nativeToolId: "private-id",
        args: { path: "/private" },
        result: "private result",
        error: "private error",
      } as never,
      agent: { lastToolName: null, usage: null },
    });
    const nodes = elements(tree);
    expect(
      nodes.map((node) => (node.props as { accessibilityLabel?: string }).accessibilityLabel),
    ).toEqual(expect.arrayContaining(["Code: Started", "Shell: Completed", "Edit: Failed"]));
    const visibleText = nodes
      .flatMap((node) => {
        const children = (node.props as { children?: ReactNode }).children;
        return Array.isArray(children) ? children : [children];
      })
      .filter((child): child is string => typeof child === "string")
      .join(" ");
    expect(visibleText).toContain("Safe update");
    expect(visibleText).toContain("Started");
    expect(visibleText).toContain("Completed");
    expect(visibleText).toContain("Failed");
    expect(visibleText).not.toContain("private");
  });
});
