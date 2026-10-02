import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { DesktopEnvironmentBootstrapSchema, DesktopPreviewNavigationResultSchema } from "./ipc.ts";

describe("DesktopPreviewNavigationResultSchema", () => {
  const decode = Schema.decodeUnknownSync(DesktopPreviewNavigationResultSchema);
  it("preserves captured download receipts and legacy void navigation results", () => {
    const result = {
      url: "about:blank",
      download: {
        fileName: "report.csv",
        path: "/tmp/artifacts/report.csv",
        sizeBytes: 100,
        state: "started",
      },
    };
    expect(decode(result)).toEqual(result);
    expect(decode(undefined)).toBeUndefined();
    expect(
      decode({
        ...result,
        download: { fileName: "report.csv", path: "/tmp/artifacts/report.csv", state: "started" },
      }),
    ).toMatchObject({ url: "about:blank" });
  });
});

describe("DesktopEnvironmentBootstrapSchema", () => {
  const decode = Schema.decodeUnknownSync(DesktopEnvironmentBootstrapSchema);

  it("preserves the concrete running distro separately from the backend id", () => {
    expect(
      decode({
        id: "wsl:default",
        label: "WSL (Ubuntu)",
        runningDistro: "Ubuntu",
        httpBaseUrl: "http://127.0.0.1:3774/",
        wsBaseUrl: "ws://127.0.0.1:3774/",
      }),
    ).toEqual({
      id: "wsl:default",
      label: "WSL (Ubuntu)",
      runningDistro: "Ubuntu",
      httpBaseUrl: "http://127.0.0.1:3774/",
      wsBaseUrl: "ws://127.0.0.1:3774/",
    });
  });

  it("allows non-running and non-WSL bootstraps to report no running distro", () => {
    expect(
      decode({
        id: "primary",
        label: "Windows",
        runningDistro: null,
        httpBaseUrl: null,
        wsBaseUrl: null,
      }).runningDistro,
    ).toBeNull();
  });
});
