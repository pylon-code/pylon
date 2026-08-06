// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { expandHomePath, resolveProviderHomePath } from "./pathExpansion.ts";

describe("expandHomePath", () => {
  it("returns an empty string unchanged", () => {
    expect(expandHomePath("")).toBe("");
  });

  it("returns paths without a leading tilde unchanged", () => {
    expect(expandHomePath("/absolute/path")).toBe("/absolute/path");
    expect(expandHomePath("relative/path")).toBe("relative/path");
    expect(expandHomePath("some~weird~path")).toBe("some~weird~path");
  });

  it("expands a lone tilde to the home directory", () => {
    expect(expandHomePath("~")).toBe(NodeOS.homedir());
  });

  it("expands ~/ to a subpath of the home directory", () => {
    expect(expandHomePath("~/.codex-work")).toBe(NodePath.join(NodeOS.homedir(), ".codex-work"));
  });

  it("expands a Windows-style ~\\ prefix", () => {
    expect(expandHomePath("~\\.codex")).toBe(NodePath.join(NodeOS.homedir(), ".codex"));
  });

  it("does not expand ~user paths", () => {
    expect(expandHomePath("~alice/foo")).toBe("~alice/foo");
  });
});

describe("resolveProviderHomePath", () => {
  // The bug this exists to prevent: a relative provider home resolved against
  // the server's working directory points the same account at a different
  // place in the dev server than in the packaged app, and the provider CLI
  // then creates an empty config directory there instead of failing.
  it("anchors a relative path to the home directory, not the cwd", () => {
    expect(resolveProviderHomePath(".claude-alt")).toBe(
      NodePath.join(NodeOS.homedir(), ".claude-alt"),
    );
    expect(resolveProviderHomePath("nested/dir")).toBe(
      NodePath.join(NodeOS.homedir(), "nested/dir"),
    );
  });

  it("expands a tilde the same way as before", () => {
    expect(resolveProviderHomePath("~/.codex-work")).toBe(
      NodePath.join(NodeOS.homedir(), ".codex-work"),
    );
    expect(resolveProviderHomePath("~")).toBe(NodePath.resolve(NodeOS.homedir()));
  });

  it("leaves an absolute path alone", () => {
    const absolute = NodePath.resolve(NodeOS.tmpdir(), "provider-home");
    expect(resolveProviderHomePath(absolute)).toBe(absolute);
  });

  it("ignores surrounding whitespace", () => {
    expect(resolveProviderHomePath("  .claude-alt  ")).toBe(
      NodePath.join(NodeOS.homedir(), ".claude-alt"),
    );
  });
});
