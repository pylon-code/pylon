import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  ConnectionStatusDot,
  connectionPhaseDotClassName,
  connectionPhasePingClassName,
} from "./ConnectionStatusDot";

describe("ConnectionStatusDot", () => {
  it("maps connection lifecycle facts to upstream dot colors", () => {
    expect(connectionPhaseDotClassName("connected")).toBe("bg-success");
    expect(connectionPhaseDotClassName("connecting")).toBe("bg-warning");
    expect(connectionPhaseDotClassName("reconnecting")).toBe("bg-warning");
    expect(connectionPhaseDotClassName("error")).toBe("bg-destructive");
    expect(connectionPhaseDotClassName("offline")).toBe("bg-muted-foreground/40");
  });

  it("reserves the ping halo for transitional phases", () => {
    expect(connectionPhasePingClassName("connecting")).toBe("bg-warning/60 duration-2000");
    expect(connectionPhasePingClassName("reconnecting")).toBe("bg-warning/60 duration-2000");
    expect(connectionPhasePingClassName("connected")).toBeNull();
    expect(connectionPhasePingClassName("error")).toBeNull();
  });

  it("renders a static connected outcome", () => {
    const markup = renderToStaticMarkup(
      <ConnectionStatusDot dotClassName="bg-success" tooltipText="Connected" />,
    );
    expect(markup).toContain("bg-success");
    expect(markup).not.toContain("animate-status-ping");
  });

  it("renders a reduced-motion-safe transition halo", () => {
    const markup = renderToStaticMarkup(
      <ConnectionStatusDot dotClassName="bg-warning" pingClassName="bg-warning/60 duration-2000" />,
    );
    expect(markup).toContain("animate-status-ping");
    expect(markup).toContain("motion-reduce:hidden");
    expect(markup).toContain("bg-warning/60");
  });

  it("keeps a persisted pairing link static while it waits to be used", () => {
    const markup = renderToStaticMarkup(<ConnectionStatusDot dotClassName="bg-amber-400" />);
    expect(markup).toContain("bg-amber-400");
    expect(markup).not.toContain("animate-status-ping");
  });
});
