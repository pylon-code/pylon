import { EventId, SessionInteractionRequestId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { PendingSessionInteraction } from "../../sessionInteraction";
import {
  ComposerSessionInteractionPanel,
  SessionNotificationRow,
  SessionPresentationArea,
} from "./ComposerSessionInteractionPanel";

function pending(request: PendingSessionInteraction["request"]): PendingSessionInteraction {
  return {
    activityId: EventId.make(`activity-${request.kind}`),
    requestId: SessionInteractionRequestId.make(`request-${request.kind}`),
    request,
    createdAt: "2026-03-01T00:00:00.000Z",
  };
}

function renderInteraction(interaction: PendingSessionInteraction) {
  return renderToStaticMarkup(
    <ComposerSessionInteractionPanel
      interaction={interaction}
      pendingCount={1}
      submission={null}
      activityError={null}
      otherSubmissionInFlight={false}
      onRespond={() => {}}
    />,
  );
}

describe("ComposerSessionInteractionPanel", () => {
  it("renders bounded select options and explicit cancellation", () => {
    const markup = renderInteraction(
      pending({ kind: "select", title: "Choose one", options: ["Alpha", "Beta"] }),
    );
    expect(markup).toContain('data-session-interaction-kind="select"');
    expect(markup).toContain('aria-label="Select Alpha"');
    expect(markup).toContain('aria-label="Cancel Choose one"');
    expect(markup).toContain("max-h-48");
    expect(markup).not.toContain("payload");
  });

  it("renders confirm yes, no, message, and cancel controls", () => {
    const markup = renderInteraction(
      pending({ kind: "confirm", title: "Continue?", message: "Check this first." }),
    );
    expect(markup).toContain('aria-label="Yes"');
    expect(markup).toContain('aria-label="No"');
    expect(markup).toContain('aria-label="Cancel Continue?"');
    expect(markup).toContain("Check this first.");
  });

  it("renders a labeled single-line input and cancel", () => {
    const markup = renderInteraction(
      pending({ kind: "input", title: "Branch name", placeholder: "feature/name" }),
    );
    expect(markup).toContain('type="text"');
    expect(markup).toContain('aria-label="Branch name"');
    expect(markup).toContain('placeholder="feature/name"');
    expect(markup).toContain('maxLength="100000"');
    expect(markup).toContain('aria-label="Cancel Branch name"');
  });

  it("renders a labeled multiline editor with its prefill and cancel", () => {
    const markup = renderInteraction(
      pending({ kind: "editor", title: "Edit description", prefill: "Starting copy" }),
    );
    expect(markup).toContain("<textarea");
    expect(markup).toContain('aria-label="Edit description"');
    expect(markup).toContain("Starting copy");
    expect(markup).toContain('maxLength="100000"');
    expect(markup).toContain('aria-label="Cancel Edit description"');
  });

  it("shows a bounded generic committed provider failure and re-enables fresh responses", () => {
    const interaction = pending({ kind: "select", title: "Choose", options: ["Alpha"] });
    const markup = renderToStaticMarkup(
      <ComposerSessionInteractionPanel
        interaction={interaction}
        pendingCount={1}
        submission={null}
        activityError="The session could not accept that response. Try again."
        otherSubmissionInFlight={false}
        onRespond={() => {}}
      />,
    );
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("The session could not accept that response. Try again.");
    expect(markup).not.toContain("Native provider failure");
    expect(markup).not.toContain('aria-label="Select Alpha" disabled');
  });

  it("disables controls while submitting and exposes command errors with retry", () => {
    const interaction = pending({ kind: "select", title: "Choose", options: ["Alpha"] });
    const submitting = renderToStaticMarkup(
      <ComposerSessionInteractionPanel
        interaction={interaction}
        pendingCount={1}
        submission={{
          requestId: interaction.requestId,
          response: { kind: "selected", value: "Alpha" },
          status: "submitting",
        }}
        activityError={null}
        otherSubmissionInFlight={false}
        onRespond={() => {}}
      />,
    );
    expect(submitting).toContain("disabled");

    const failed = renderToStaticMarkup(
      <ComposerSessionInteractionPanel
        interaction={interaction}
        pendingCount={1}
        submission={{
          requestId: interaction.requestId,
          response: { kind: "selected", value: "Alpha" },
          status: "error",
          error: "Connection lost",
        }}
        activityError={null}
        otherSubmissionInFlight={false}
        onRespond={() => {}}
      />,
    );
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("Connection lost");
    expect(failed).toContain(">Retry<");
  });
});

describe("session presentation leaves", () => {
  it("respects widget placement and renders compact status without native details", () => {
    const above = renderToStaticMarkup(
      <SessionPresentationArea
        statuses={[{ key: "mode", text: "Review" }]}
        widgets={[
          { key: "top", lines: ["One"], placement: "aboveEditor" },
          { key: "bottom", lines: ["Two"], placement: "belowEditor" },
        ]}
        placement="aboveEditor"
      />,
    );
    expect(above).toContain('data-session-presentation-placement="aboveEditor"');
    expect(above).toContain("mode:");
    expect(above).toContain("One");
    expect(above).not.toContain("Two");
  });

  it.each(["info", "warning", "error"] as const)(
    "styles %s notifications as timeline-safe activities",
    (level) => {
      const markup = renderToStaticMarkup(
        <SessionNotificationRow
          notification={{
            activityId: EventId.make(`notice-${level}`),
            createdAt: "2026-03-01T00:00:00.000Z",
            turnId: null,
            message: `${level} message`,
            level,
          }}
        />,
      );
      expect(markup).toContain(`data-session-notification-level="${level}"`);
      expect(markup).toContain(`${level} message`);
      expect(markup).not.toContain("payload");
    },
  );
});
