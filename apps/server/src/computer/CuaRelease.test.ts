import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { describe, expect, it } from "@effect/vitest";
import { compareCuaVersions } from "@t3tools/contracts";
import { cuaReleaseTarget, selectCuaRelease, fetchCuaRelease } from "./CuaRelease.ts";
const release = (version: string, changes = {}) => ({
  tag_name: `cua-driver-rs-v${version}`,
  draft: false,
  prerelease: true,
  assets: [
    {
      name: `cua-driver-rs-${version}-darwin-universal.tar.gz`,
      size: 100,
      digest: `sha256:${"a".repeat(64)}`,
    },
  ],
  ...changes,
});
describe("official Cua release selection", () => {
  it("uses plain SemVer despite monorepo prerelease flags and sorts numerically", () => {
    expect(
      selectCuaRelease(
        [
          release("0.9.0"),
          release("0.28.1"),
          release("0.29.0-beta.1"),
          release("0.30.0", { draft: true }),
        ],
        "darwin",
        "arm64",
      )?.version,
    ).toBe("0.28.1");
    expect(compareCuaVersions("0.28.10", "0.28.9")).toBeGreaterThan(0);
  });
  it("fails closed if the latest release has no verified matching asset", () => {
    expect(
      selectCuaRelease([release("0.28.0"), release("0.28.1", { assets: [] })], "darwin", "arm64"),
    ).toBeNull();
    expect(
      selectCuaRelease(
        [
          release("0.28.1", {
            assets: [
              { name: "cua-driver-rs-0.28.1-darwin-universal.tar.gz", size: 100, digest: null },
            ],
          }),
        ],
        "darwin",
        "x64",
      ),
    ).toBeNull();
  });
  it("maps supported architectures without assuming the client platform", () => {
    expect(cuaReleaseTarget("linux", "x64")).toBe("linux-x86_64");
    expect(cuaReleaseTarget("win32", "arm64")).toBe("windows-arm64");
    expect(cuaReleaseTarget("linux", "ia32")).toBeNull();
  });
});

it.effect("skips a tag whose release has not been published yet", () => {
  const requests: string[] = [];
  return fetchCuaRelease("darwin", "arm64").pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push(request.url);
          return HttpClientResponse.fromWeb(
            request,
            request.url.includes("matching-refs")
              ? Response.json([
                  { ref: "refs/tags/cua-driver-rs-v0.29.0" },
                  { ref: "refs/tags/cua-driver-rs-v0.28.1" },
                ])
              : request.url.endsWith("v0.29.0")
                ? new Response(null, { status: 404 })
                : Response.json(release("0.28.1")),
          );
        }),
      ),
    ),
    Effect.tap((selected) =>
      Effect.sync(() => {
        expect(selected.version).toBe("0.28.1");
        expect(requests).toHaveLength(3);
      }),
    ),
  );
});
