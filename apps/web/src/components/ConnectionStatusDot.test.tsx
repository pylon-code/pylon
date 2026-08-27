import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ConnectionStatusDot, connectionPhaseDotMatrixState } from "./ConnectionStatusDot";

describe("ConnectionStatusDot", () => {
  it("maps connection lifecycle facts to semantic states", () => {
    expect(connectionPhaseDotMatrixState("connected")).toBe("success");
    expect(connectionPhaseDotMatrixState("connecting")).toBe("connecting");
    expect(connectionPhaseDotMatrixState("reconnecting")).toBe("connecting");
    expect(connectionPhaseDotMatrixState("error")).toBe("error");
    expect(connectionPhaseDotMatrixState("offline")).toBe("offline");
    expect(connectionPhaseDotMatrixState("available")).toBe("offline");
  });

  it("renders the connected outcome as a static success glyph", () => {
    const markup = renderToStaticMarkup(
      <ConnectionStatusDot state="success" tooltipText="Connected" />,
    );
    expect(markup).toContain('data-state="success"');
    expect(markup).toContain("text-success");
    expect(markup).not.toContain("data-animated");
  });

  it("keeps a persisted pairing link static while it waits to be used", () => {
    const markup = renderToStaticMarkup(
      <ConnectionStatusDot state="queued" colorClassName="text-warning" />,
    );
    expect(markup).toContain('data-state="queued"');
    expect(markup).toContain("text-warning");
    expect(markup).not.toContain("data-animated");
  });
});
