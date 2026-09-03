import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { RollbackStatusBanner } from "./RollbackStatusBanner";

const updatedAt = "2026-04-01T00:00:00.000Z";

describe("RollbackStatusBanner", () => {
  it("announces a manual recovery fence and exposes only authorized actions", () => {
    const markup = renderToStaticMarkup(
      <RollbackStatusBanner
        status={{
          state: "manual-recovery",
          targetTurnCount: 1,
          sourceRevision: 3,
          detail: "The workspace could not be verified.",
          allowedActions: ["resume-compensation"],
          updatedAt,
        }}
        recoveryPending={false}
        onRecover={() => {}}
      />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-live="assertive"');
    expect(markup).toContain('aria-atomic="true"');
    expect(markup).toContain("Manual recovery required");
    expect(markup).toContain('aria-label="Resume rollback compensation"');
    expect(markup).not.toContain("Retry rollback verification");
  });

  it("uses a polite durable status for pending and completed operations", () => {
    const pending = renderToStaticMarkup(
      <RollbackStatusBanner
        status={{ state: "pending", updatedAt }}
        recoveryPending={false}
        onRecover={() => {}}
      />,
    );
    const completed = renderToStaticMarkup(
      <RollbackStatusBanner
        status={{ state: "completed", updatedAt }}
        recoveryPending={false}
        onRecover={() => {}}
      />,
    );

    expect(pending).toContain('role="status"');
    expect(pending).toContain('aria-live="polite"');
    expect(pending).toContain("Rollback pending");
    expect(completed).toContain("Rollback completed");
  });

  it("disables recovery while a client request is in flight", () => {
    const markup = renderToStaticMarkup(
      <RollbackStatusBanner
        status={{
          state: "manual-recovery",
          detail: "Verification is required.",
          allowedActions: ["retry-verification"],
          updatedAt,
        }}
        recoveryPending
        onRecover={() => {}}
      />,
    );

    expect(markup).toContain('aria-label="Retry rollback verification"');
    expect(markup).toContain("disabled");
  });
});
