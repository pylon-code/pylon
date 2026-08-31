import { describe, expect, it } from "vite-plus/test";

import { BUILT_IN_ADAPTER_CONVERSATION_ROLLBACK_MODES } from "./ProviderAdapter.ts";

describe("built-in provider conversation rollback modes", () => {
  it("classifies every production adapter without claiming absolute rollback", () => {
    expect(BUILT_IN_ADAPTER_CONVERSATION_ROLLBACK_MODES).toEqual({
      codex: "relative",
      claude: "relative",
      cursor: "unsupported",
      grok: "unsupported",
      openCode: "relative",
      prime: "unsupported",
      primeDaemon: "unsupported",
    });
    expect(Object.values(BUILT_IN_ADAPTER_CONVERSATION_ROLLBACK_MODES)).not.toContain("absolute");
  });
});
