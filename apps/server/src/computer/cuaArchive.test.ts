// @effect-diagnostics nodeBuiltinImport:off - Exercise the native Promise archive boundary and hardlink fixtures.
import { expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as Tar from "tar";
import { extractCuaArchive, safeCuaArchivePath } from "./cuaArchive.ts";

it.each(["../escape", "/absolute", "a/../escape", "a/./b", "C:/driver", "a\\b", "a\u0000b", ""])(
  "refuses unsafe archive path %s",
  (path) => {
    expect(safeCuaArchivePath(path)).toBe(false);
  },
);
it("accepts ordinary nested bundle paths", () => {
  expect(safeCuaArchivePath("driver/CuaDriver.app/Contents/MacOS/cua-driver")).toBe(true);
});
it("refuses linked archive members without writing their target", async () => {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pylon-cua-archive-"));
  try {
    const source = NodePath.join(dir, "source");
    const output = NodePath.join(dir, "output");
    await NodeFSP.mkdir(source);
    await NodeFSP.mkdir(output);
    await NodeFSP.writeFile(NodePath.join(source, "driver"), "driver");
    // TAR hardlinks work without symlink privileges on Windows.
    await NodeFSP.link(NodePath.join(source, "driver"), NodePath.join(source, "alias"));
    const archive = NodePath.join(dir, "input.tar.gz");
    await Tar.c({ cwd: source, file: archive, gzip: true }, ["driver", "alias"]);
    await expect(
      extractCuaArchive(archive, output, false, new AbortController().signal),
    ).rejects.toThrow();
    await expect(NodeFSP.stat(NodePath.join(output, "alias"))).rejects.toThrow();
  } finally {
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
});
it("honors cancellation before extraction", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(extractCuaArchive("missing", "missing", false, controller.signal)).rejects.toThrow();
});
