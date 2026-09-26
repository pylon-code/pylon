// @effect-diagnostics nodeBuiltinImport:off - Native fixture tests probe the host toolchain.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/** The macOS host may compile TSan binaries yet crash before main; probe it independently. */
export function supportsNativeThreadSanitizer(compiler: "clang" | "swiftc"): boolean {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pylon-tsan-probe-"));
  try {
    const source = NodePath.join(directory, compiler === "clang" ? "probe.m" : "probe.swift");
    const executable = NodePath.join(directory, "probe");
    NodeFS.writeFileSync(
      source,
      compiler === "clang" ? "int main(void) { return 0; }\n" : 'print("passed")\n',
    );
    const args =
      compiler === "clang"
        ? ["-fsanitize=thread", source, "-o", executable]
        : ["-sanitize=thread", source, "-o", executable];
    const compile = NodeChildProcess.spawnSync(compiler, args, { timeout: 30_000 });
    if (compile.status !== 0) {
      console.info(`Native ${compiler} ThreadSanitizer unavailable; running behavioral fixture`);
      return false;
    }
    const run = NodeChildProcess.spawnSync(executable, { timeout: 15_000 });
    const supported = run.status === 0;
    console.info(
      `Native ${compiler} ThreadSanitizer ${supported ? "enabled" : "unavailable; running behavioral fixture"}`,
    );
    return supported;
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
}
