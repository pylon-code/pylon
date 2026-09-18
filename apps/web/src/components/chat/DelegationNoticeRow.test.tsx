import type { DelegationNotice } from "@t3tools/client-runtime/state/delegation-notice";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { DelegationNoticeRow } from "./DelegationNoticeRow";

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
const CHILD = ThreadId.make("delegated:lead:fedcba9876543210");

const finished: DelegationNotice = {
  updates: [
    {
      threadId: EXECUTOR,
      title: "Executor · Fix the parser",
      status: "completed",
      reason: null,
      isExecutor: true,
    },
  ],
  needsUser: false,
};

describe("DelegationNoticeRow", () => {
  it("says who finished and links to that thread, with none of the agent-facing text", () => {
    const html = renderToStaticMarkup(
      <DelegationNoticeRow notice={finished} environmentId={ENV} />,
    );
    expect(html).toContain("data-delegation-notice");
    expect(html).toContain('data-needs-user="false"');
    expect(html).toContain("Executor finished");
    expect(html).toContain("Executor · Fix the parser");
    expect(html).toContain(`href="/${ENV}/${EXECUTOR}"`);
    expect(html).not.toContain("JSON");
    expect(html).not.toContain("threadId");
    expect(html).not.toContain("authorized scope");
  });

  it("marks a notice that is waiting on the user and shows a failure's reason", () => {
    const html = renderToStaticMarkup(
      <DelegationNoticeRow
        environmentId={ENV}
        notice={{
          needsUser: true,
          updates: [
            {
              threadId: CHILD,
              title: "Review auth",
              status: "needs-approval",
              reason: null,
              isExecutor: false,
            },
            {
              threadId: EXECUTOR,
              title: "Executor",
              status: "error",
              reason: "quota exceeded",
              isExecutor: true,
            },
          ],
        }}
      />,
    );
    expect(html).toContain('data-needs-user="true"');
    expect(html).toContain("Delegated thread needs your approval");
    expect(html).toContain("Executor failed");
    expect(html).toContain("quota exceeded");
    expect(html).toContain(`href="/${ENV}/${CHILD}"`);
    expect(html).toContain(`href="/${ENV}/${EXECUTOR}"`);
    // One item per update, so a screen reader hears a list.
    expect(html.match(/data-delegation-notice-item/g)).toHaveLength(2);
  });

  it("is announced as a status, not as something the user said", () => {
    const html = renderToStaticMarkup(
      <DelegationNoticeRow notice={finished} environmentId={ENV} />,
    );
    expect(html).toContain('role="status"');
  });
});
