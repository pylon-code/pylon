import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { fetchLatestRelease } from "./releases";

const stable = {
  tag_name: "v0.0.33",
  html_url: "https://github.com/pylon-code/pylon-releases/releases/tag/v0.0.33",
  assets: [],
};
const nightly = { ...stable, tag_name: "v0.0.33-nightly.20260907.133" };
let cache: Map<string, string>;

beforeEach(() => {
  cache = new Map();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => cache.get(key) ?? null,
    setItem: (key: string, value: string) => cache.set(key, value),
  });
});
afterEach(() => vi.unstubAllGlobals());

function respond(data: unknown, ok = true) {
  return { ok, json: async () => data };
}

describe("Pylon release channels", () => {
  it("keeps stable and nightly requests and caches separate", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(respond(stable))
      .mockResolvedValueOnce(respond([stable, nightly]));
    vi.stubGlobal("fetch", fetcher);
    expect(await fetchLatestRelease()).toEqual(stable);
    expect(await fetchLatestRelease("nightly")).toEqual(nightly);
    expect(await fetchLatestRelease()).toEqual(stable);
    expect(await fetchLatestRelease("nightly")).toEqual(nightly);
    expect(fetcher.mock.calls).toEqual([
      ["https://api.github.com/repos/pylon-code/pylon-releases/releases/latest"],
      ["https://api.github.com/repos/pylon-code/pylon-releases/releases?per_page=10"],
    ]);
  });

  it("selects the newest nightly from a mixed release list", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          respond([stable, nightly, { ...nightly, tag_name: "v0.0.33-nightly.20260907.132" }]),
        ),
    );
    expect(await fetchLatestRelease("nightly")).toEqual(nightly);
  });

  it.each(["not JSON", "{}", '{"tag_name":"v1","html_url":"url","assets":[null]}'])(
    "recovers from unusable cache %s",
    async (cached) => {
      cache.set("pylon-stable-release", cached);
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(stable)));
      expect(await fetchLatestRelease()).toEqual(stable);
    },
  );

  it("loads releases when browser storage is unavailable", async () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(stable)));
    expect(await fetchLatestRelease()).toEqual(stable);
  });

  it("does not cache an HTTP failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond({ message: "Not Found" }, false)));
    await expect(fetchLatestRelease()).rejects.toThrow("Could not load stable releases");
    expect(cache.size).toBe(0);
  });

  it.each([{ data: [] }, { data: [stable] }, { data: { message: "rate limited" } }])(
    "does not substitute stable when nightly is absent: %j",
    async ({ data }) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(data)));
      await expect(fetchLatestRelease("nightly")).rejects.toThrow("No nightly release available");
      expect(cache.size).toBe(0);
    },
  );
});
