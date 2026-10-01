// @effect-diagnostics nodeBuiltinImport:off - inspect the server test inventory.
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";
import type { TestSpecification, Vitest } from "vite-plus/test/node";

import shardWeights from "./shardWeights.json" with { type: "json" };
import { WeightedShardSequencer } from "./weightedShardSequencer.ts";

const root = NodeURL.fileURLToPath(new URL("../../", import.meta.url));
const recordedSeconds: Readonly<Record<string, number>> = shardWeights;
const recorded = Object.keys(recordedSeconds);
const serverFiles = NodeFS.globSync("**/*.{test,spec}.?(c|m)[jt]s?(x)", {
  cwd: root,
  exclude: ["node_modules/**", "dist/**", "dist-electron/**"],
});
const files = [...serverFiles, ...Array.from({ length: 300 }, (_, i) => `src/fast${i}.test.ts`)];
const specs = files.map((file) => ({ moduleId: `${root}/${file}` }) as TestSpecification);

const shardModuleIds = (count: number, input = specs) =>
  Promise.all(
    Array.from({ length: count }, async (_, i) => {
      const ctx = { config: { root, shard: { index: i + 1, count } } } as unknown as Vitest;
      const shard = await new WeightedShardSequencer(ctx).shard(input);
      return shard.map((spec) => spec.moduleId);
    }),
  );

describe("WeightedShardSequencer", () => {
  it.each([1, 3, 6, files.length + 1])(
    "runs every file in exactly one of %i shards",
    async (count) => {
      expect(serverFiles).toContain("src/server.test.ts");
      const shards = await shardModuleIds(count);
      expect(shards.flat().toSorted()).toEqual(specs.map((spec) => spec.moduleId).toSorted());
    },
  );

  it("assigns files independently of discovery order", async () => {
    expect(await shardModuleIds(3, specs.toReversed())).toEqual(await shardModuleIds(3));
  });

  it("assigns unknown files even without configured sharding", async () => {
    const ctx = { config: { root } } as unknown as Vitest;
    expect(await new WeightedShardSequencer(ctx).shard(specs)).toHaveLength(specs.length);
  });

  it("puts each of the slowest files in a different shard", async () => {
    const slowest = new Set(
      recorded
        .toSorted((a, b) => (recordedSeconds[b] ?? 0) - (recordedSeconds[a] ?? 0))
        .slice(0, 6)
        .map((file) => `${root}/${file}`),
    );
    const shards = await shardModuleIds(6);

    for (const shard of shards) {
      expect(shard.filter((moduleId) => slowest.has(moduleId))).toHaveLength(1);
    }
  });
});
