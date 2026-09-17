import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { PanelLayoutControls } from "./PanelLayoutControls";

function renderControls(liveAgentCount: number, attentionAgentCount = 0) {
  return renderToStaticMarkup(
    <PanelLayoutControls
      terminalAvailable
      terminalOpen={false}
      terminalShortcutLabel={null}
      rightPanelAvailable
      rightPanelOpen={false}
      rightPanelShortcutLabel={null}
      liveAgentCount={liveAgentCount}
      attentionAgentCount={attentionAgentCount}
      onToggleTerminal={() => {}}
      onToggleRightPanel={() => {}}
    />,
  );
}

describe("existing agent activity badge", () => {
  it("reports child attention instead of claiming blocked work is running", () => {
    expect(renderControls(2, 1)).toContain("Toggle right panel, 1 agent needs attention");
  });
  it("keeps active children visible without a parent-running prerequisite", () => {
    expect(renderControls(2)).toContain("Toggle right panel, 2 agents active");
  });
  it("does not retain an attention label when the badge is suppressed", () => {
    expect(renderControls(0, 1)).not.toContain("agent needs attention");
  });
});
