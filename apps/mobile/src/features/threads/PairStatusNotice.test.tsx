import type { PairState } from "@t3tools/client-runtime/state/pair";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { pairExecutorThreadId } from "@t3tools/shared/delegatedThreads";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  View: "div",
  Pressable: ({
    children,
    accessibilityLabel,
  }: {
    children: ReactNode;
    accessibilityLabel?: string;
  }) => <button aria-label={accessibilityLabel}>{children}</button>,
}));
vi.mock("../../components/AppText", () => ({ AppText: "span" }));

import { PairStatusNotice } from "./PairStatusNotice";

const executorId = pairExecutorThreadId(ThreadId.make("lead-1"));
type PairOn = Extract<PairState, { kind: "on" }>;
const on = (phase: PairOn["phase"]): PairOn => ({
  kind: "on",
  executorId,
  phase,
  modelSelection: { instanceId: ProviderInstanceId.make("antigravity"), model: "gemini-3-flash" },
  activity: null,
});
const render = (state: PairState) =>
  renderToStaticMarkup(
    <PairStatusNotice state={state} executorLabel="Gemini 3 Flash" onOpenExecutor={() => {}} />,
  );

describe("PairStatusNotice", () => {
  it("says who the thread is paired with and what the executor is doing", () => {
    const markup = render(on("running"));
    expect(markup).toContain("Paired with Gemini 3 Flash · Working");
    expect(markup).toContain("Open executor");
    expect(markup).toContain('aria-label="Paired with Gemini 3 Flash · Working. Open executor"');
  });

  it("shows the executor's own line of activity when there is one", () => {
    expect(render({ ...on("error"), activity: "Provider rejected the request." })).toContain(
      "Provider rejected the request.",
    );
  });

  it("renders nothing while the pair is off or cannot exist", () => {
    expect(render({ kind: "off", executorId })).toBe("");
    expect(render({ kind: "unsupported-lead", reason: "no" })).toBe("");
  });
});
