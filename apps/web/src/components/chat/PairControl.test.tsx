import { PAIR_UNSUPPORTED_LEAD_REASON, type PairState } from "@t3tools/client-runtime/state/pair";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import {
  PairControl,
  PairControlPanel,
  type PairControlProps,
  initialExecutorInstanceId,
} from "./PairControl";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    params,
  }: {
    children: React.ReactNode;
    params: { environmentId: string; threadId: string };
  }) => <a href={`/${params.environmentId}/${params.threadId}`}>{children}</a>,
}));

const ENV = EnvironmentId.make("env-1");
const EXECUTOR = ThreadId.make("delegated:lead:0123456789abcdef");
const ANTIGRAVITY = ProviderInstanceId.make("antigravity");
const SELECTION = { instanceId: ANTIGRAVITY, model: "gemini-3-flash" };

const provider: ServerProvider = {
  instanceId: ANTIGRAVITY,
  driver: ProviderDriverKind.make("antigravity"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-18T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

const props = (overrides: Partial<PairControlProps> = {}): PairControlProps => ({
  state: { kind: "off", executorId: EXECUTOR },
  executorSelection: SELECTION,
  instanceEntries: deriveProviderInstanceEntries([provider]),
  modelOptionsByInstance: new Map([
    [ANTIGRAVITY, [{ slug: "gemini-3-flash", name: "Gemini 3 Flash" }]],
  ]),
  environmentId: ENV,
  onToggle: () => undefined,
  onExecutorChange: () => undefined,
  ...overrides,
});

const on = (
  phase: Extract<PairState, { kind: "on" }>["phase"],
  activity: string | null = null,
): PairState => ({ kind: "on", executorId: EXECUTOR, phase, modelSelection: SELECTION, activity });

describe("PairControl trigger", () => {
  it("offers pairing in one word when the pair is off", () => {
    const html = renderToStaticMarkup(<PairControl {...props()} />);
    expect(html).toContain("data-pair-control");
    expect(html).toContain('data-pair-state="off"');
    expect(html).toContain('aria-label="Pair: off"');
    expect(html).toContain(">Pair<");
    expect(html).not.toContain("data-pair-attention");
  });

  it("names the executor's model and what it is doing when the pair is on", () => {
    const html = renderToStaticMarkup(<PairControl {...props({ state: on("running") })} />);
    expect(html).toContain('data-pair-state="on"');
    expect(html).toContain('aria-label="Pair with Gemini 3 Flash: Working"');
    expect(html).toContain("Gemini 3 Flash");
  });

  it("asks for attention only when the executor is waiting on the user", () => {
    for (const phase of ["needs-approval", "needs-input"] as const) {
      expect(renderToStaticMarkup(<PairControl {...props({ state: on(phase) })} />)).toContain(
        'data-pair-attention="true"',
      );
    }
    for (const phase of ["idle", "running", "completed", "interrupted", "error"] as const) {
      expect(renderToStaticMarkup(<PairControl {...props({ state: on(phase) })} />)).not.toContain(
        "data-pair-attention",
      );
    }
  });

  it("stays visible but marked unavailable for a lead that cannot pair", () => {
    const html = renderToStaticMarkup(
      <PairControl
        {...props({ state: { kind: "unsupported-lead", reason: PAIR_UNSUPPORTED_LEAD_REASON } })}
      />,
    );
    expect(html).toContain('data-pair-state="unsupported"');
    expect(html).toContain('aria-label="Pair unavailable"');
  });
});

describe("PairControlPanel", () => {
  it("explains the pair and offers the switch and the executor picker when off", () => {
    const html = renderToStaticMarkup(<PairControlPanel {...props()} />);
    expect(html).toContain("data-pair-panel");
    expect(html).toContain("plans, briefs, and checks");
    expect(html).toContain('data-pair-switch-disabled="false"');
    expect(html).toContain('aria-label="Executor model"');
    expect(html).not.toContain("data-pair-phase");
    expect(html).not.toContain("data-pair-reason");
  });

  it("will not turn on without an executor model, and says what to do", () => {
    const html = renderToStaticMarkup(<PairControlPanel {...props({ executorSelection: null })} />);
    expect(html).toContain('data-pair-switch-disabled="true"');
    expect(html).toContain("data-pair-reason");
    expect(html).toContain("Choose an executor model first.");
  });

  it("gives the reason, and no way to switch, for a lead that cannot pair", () => {
    const html = renderToStaticMarkup(
      <PairControlPanel
        {...props({ state: { kind: "unsupported-lead", reason: PAIR_UNSUPPORTED_LEAD_REASON } })}
      />,
    );
    expect(html).toContain('data-pair-switch-disabled="true"');
    expect(html).toContain(PAIR_UNSUPPORTED_LEAD_REASON);
  });

  it("shows why a change has to wait, without hiding the current state", () => {
    const html = renderToStaticMarkup(
      <PairControlPanel
        {...props({ state: on("running"), lockedReason: "Changes apply between turns." })}
      />,
    );
    expect(html).toContain('data-pair-switch-disabled="true"');
    expect(html).toContain("Changes apply between turns.");
    expect(html).toContain("Working");
  });

  it("offers to stop the executor only while it holds a turn", () => {
    const stop = { onStopExecutor: () => undefined };
    for (const phase of ["running", "needs-approval", "needs-input"] as const) {
      const html = renderToStaticMarkup(
        <PairControlPanel {...props({ state: on(phase), ...stop })} />,
      );
      expect(html, phase).toContain("data-pair-stop");
      expect(html, phase).toContain("Stop executor");
    }
    for (const phase of ["idle", "completed", "interrupted", "error"] as const) {
      const html = renderToStaticMarkup(
        <PairControlPanel {...props({ state: on(phase), ...stop })} />,
      );
      expect(html, phase).not.toContain("data-pair-stop");
    }
    // Without a handler there is nothing to press.
    expect(
      renderToStaticMarkup(<PairControlPanel {...props({ state: on("running") })} />),
    ).not.toContain("data-pair-stop");
  });

  it("shows what the executor is doing and links to it when the pair is on", () => {
    const html = renderToStaticMarkup(
      <PairControlPanel {...props({ state: on("error", "quota exceeded today") })} />,
    );
    expect(html).toContain('data-pair-phase="error"');
    expect(html).toContain("Failed");
    expect(html).toContain("quota exceeded today");
    expect(html).toContain(`href="/${ENV}/${EXECUTOR}"`);
    expect(html).toContain("Open executor");
    // Changing the executor's model mid-pair needs a reset, which does not exist yet.
    expect(html).toContain("Turn the pair off to change the executor.");
  });
});

describe("initialExecutorInstanceId", () => {
  const empty = { ...provider, instanceId: ProviderInstanceId.make("cursor") };
  const entries = deriveProviderInstanceEntries([empty, provider]);

  it("opens the executor picker on the first provider that offers models", () => {
    expect(
      initialExecutorInstanceId(
        entries,
        new Map([
          [ProviderInstanceId.make("cursor"), []],
          [ANTIGRAVITY, [{ slug: "gemini-3-flash", name: "Gemini 3 Flash" }]],
        ]),
      ),
    ).toBe(ANTIGRAVITY);
  });

  it("falls back to the first provider, and to nothing when there are none", () => {
    expect(initialExecutorInstanceId(entries, new Map())).toBe(entries[0]?.instanceId);
    expect(initialExecutorInstanceId([], new Map())).toBeUndefined();
  });
});
