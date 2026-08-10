import { describe, expect, it } from "vite-plus/test";

import { providerIconKind } from "./providerIconKind";

describe("mobile provider icon selection", () => {
  it("selects the Prime Agent mark explicitly", () => {
    expect(providerIconKind("primeAgent")).toBe("primeAgent");
  });

  it.each([undefined, null, "forkAgent"])(
    "uses a generic icon for an unknown driver: %s",
    (provider) => {
      expect(providerIconKind(provider)).toBe("unknown");
    },
  );

  it("reserves the Codex mark for Codex", () => {
    expect(providerIconKind("codex")).toBe("codex");
  });

  it("selects the Jcode terminal mark explicitly", () => {
    expect(providerIconKind("jcode")).toBe("jcode");
  });
});
