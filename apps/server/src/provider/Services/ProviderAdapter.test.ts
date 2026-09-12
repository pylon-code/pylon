import { describe, expect, it } from "vite-plus/test";

import { BUILT_IN_ADAPTER_CONVERSATION_ROLLBACK_MODES } from "./ProviderAdapter.ts";

describe("built-in provider conversation rollback modes", () => {
  it("classifies production adapters by their verified rollback support", () => {
    expect(BUILT_IN_ADAPTER_CONVERSATION_ROLLBACK_MODES).toEqual({
      antigravity: "unsupported",
      codex: "absolute",
      claude: "relative",
      cursor: "unsupported",
      grok: "unsupported",
      openCode: "absolute",
      prime: "unsupported",
      primeDaemon: "unsupported",
    });
  });
});
