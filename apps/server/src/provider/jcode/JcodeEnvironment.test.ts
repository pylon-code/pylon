// @ts-expect-error -- Vite Plus provides the Vitest runner transitively to server tests.
import { describe, expect, it } from "vitest";

import { sanitizeJcodeLaunchEnvironment } from "./JcodeEnvironment.ts";

describe("sanitizeJcodeLaunchEnvironment", () => {
  it("removes SDK-owned home and socket variables while preserving provider credentials", () => {
    expect(
      sanitizeJcodeLaunchEnvironment({
        JCODE_HOME: "/escape/home",
        JCODE_RUNTIME_DIR: "/escape/run",
        JCODE_API_SOCKET: "/escape/api.sock",
        JCODE_SOCKET: "/escape/daemon.sock",
        ANTHROPIC_API_KEY: "secret",
        PATH: "/usr/bin",
      }),
    ).toEqual({ ANTHROPIC_API_KEY: "secret", PATH: "/usr/bin" });
  });
});
