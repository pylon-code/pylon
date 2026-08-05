import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  FollowUpPrimaryAction,
  FollowUpResolutionDetails,
  FollowUpValidationDetails,
} from "./FollowUpPresentation";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    params,
  }: {
    readonly children: ReactNode;
    readonly params: { readonly environmentId: string; readonly threadId: string };
  }) => <a href={`/${params.environmentId}/${params.threadId}`}>{children}</a>,
}));

describe("FollowUpPrimaryAction", () => {
  it("presents Start thread for open follow-ups", () => {
    const markup = renderToStaticMarkup(
      <FollowUpPrimaryAction
        busy={false}
        onReopen={() => {}}
        onStartThread={() => {}}
        status="open"
      />,
    );

    expect(markup).toContain("Start thread");
    expect(markup).not.toContain("Reopen");
  });

  it("presents Reopen and its busy state for closed follow-ups", () => {
    const idleMarkup = renderToStaticMarkup(
      <FollowUpPrimaryAction
        busy={false}
        onReopen={() => {}}
        onStartThread={() => {}}
        status="waived"
      />,
    );
    const busyMarkup = renderToStaticMarkup(
      <FollowUpPrimaryAction busy onReopen={() => {}} onStartThread={() => {}} status="resolved" />,
    );

    expect(idleMarkup).toContain("Reopen");
    expect(busyMarkup).toContain("Reopening…");
    expect(busyMarkup).toContain('aria-busy="true"');
    expect(busyMarkup).toContain("disabled");
  });

  it("wires the closed-item primary action to Reopen", () => {
    const onReopen = vi.fn();
    const onStartThread = vi.fn();
    const action = FollowUpPrimaryAction({
      busy: false,
      onReopen,
      onStartThread,
      status: "moot",
    }) as ReactElement<{ readonly onClick: () => void }>;

    action.props.onClick();

    expect(onReopen).toHaveBeenCalledOnce();
    expect(onStartThread).not.toHaveBeenCalled();
  });
});

describe("FollowUpResolutionDetails", () => {
  it("presents the resolution note, linked thread, and commit", () => {
    const markup = renderToStaticMarkup(
      <FollowUpResolutionDetails
        environmentId={EnvironmentId.make("environment-1")}
        resolution={{
          note: "Verified the release guard and added focused coverage.",
          threadId: ThreadId.make("thread-1"),
          commitSha: "abcdef1234567890",
        }}
      />,
    );

    expect(markup).toContain("Verified the release guard and added focused coverage.");
    expect(markup).toContain('href="/environment-1/thread-1"');
    expect(markup).toContain("Open resolution thread");
    expect(markup).toContain('title="abcdef1234567890"');
    expect(markup).toContain('aria-label="Resolution commit abcdef1234567890"');
    expect(markup).toContain("abcdef1234");
  });
});

describe("FollowUpValidationDetails", () => {
  it("presents an evidence-backed moot result so it remains challengeable", () => {
    const markup = renderToStaticMarkup(
      <FollowUpValidationDetails
        environmentId={EnvironmentId.make("environment-1")}
        validation={{
          outcome: "moot",
          verifyCheck: "Run the focused check.",
          note: "The obsolete path was removed.",
          evidence: [{ path: "src/check.ts", line: 12, commitSha: "abcdef" }],
          threadId: ThreadId.make("thread-validation"),
          checkedCommitSha: "abcdef123456",
          validatedAt: "2026-08-04T12:00:00.000Z",
        }}
      />,
    );

    expect(markup).toContain("Last validation · Moot");
    expect(markup).toContain("The obsolete path was removed.");
    expect(markup).toContain('href="/environment-1/thread-validation"');
    expect(markup).toContain("1 evidence entry");
    expect(markup).toContain("src/check.ts:12");
    expect(markup).toContain('aria-label="Evidence commit abcdef"');
    expect(markup).toContain('title="abcdef"');
    expect(markup).toContain('aria-label="Checked commit abcdef123456"');
    expect(markup).toContain('title="abcdef123456"');
    expect(markup).toContain(">abcdef123456<");
    expect(markup).toContain('dateTime="2026-08-04T12:00:00.000Z"');
    expect(markup).toContain("2026-08-04T12:00:00.000Z");
  });
});
