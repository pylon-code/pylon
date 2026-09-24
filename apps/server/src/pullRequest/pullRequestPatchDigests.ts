import * as NodeCrypto from "node:crypto";
import { unquoteGitPatchPath } from "@t3tools/shared/gitPatchPath";

export interface PatchDigestScope {
  readonly provider: string;
  readonly host: string;
  readonly remote: string;
  readonly number: number;
}

/** A section cut off mid-hunk cannot prove what the reader saw of that file. */
function hasCompleteHunks(section: string): boolean {
  const lines = section.split("\n");
  let inHunk = false;
  let hunks = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const [index, line] of lines.entries()) {
    if (line.startsWith("@@ ")) {
      if (inHunk && (oldLeft !== 0 || newLeft !== 0)) return false;
      const header = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@(?:.*)$/.exec(line);
      if (header === null) return false;
      oldLeft = Number(header[1] ?? 1);
      newLeft = Number(header[2] ?? 1);
      inHunk = true;
      hunks += 1;
      continue;
    }
    if (!inHunk) continue;
    if (line === "" && index === lines.length - 1) continue;
    if (line.startsWith("\\ No newline at end of file")) continue;
    if (line.startsWith(" ")) {
      oldLeft -= 1;
      newLeft -= 1;
    } else if (line.startsWith("-")) {
      oldLeft -= 1;
    } else if (line.startsWith("+")) {
      newLeft -= 1;
    } else {
      return false;
    }
    if (oldLeft < 0 || newLeft < 0) return false;
  }
  return hunks > 0 && oldLeft === 0 && newLeft === 0;
}

/**
 * A mark names the exact file section returned with the diff, not an independently fetched
 * latest-head value. A host response that omits hunks, truncates, or names a file ambiguously
 * grants no digest and therefore no viewed-file control for that file.
 */
export function fileDigestsFromPatch(
  patch: string,
  truncated: boolean,
  scope: PatchDigestScope,
  excludedPaths: ReadonlySet<string> = new Set(),
): ReadonlyArray<{ readonly path: string; readonly digest: string }> {
  if (truncated) return [];
  const headers = [...patch.matchAll(/^diff --git /gm)].map((match) => match.index);
  const found = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (let index = 0; index < headers.length; index += 1) {
    const section = patch.slice(headers[index], headers[index + 1] ?? patch.length);
    if (!hasCompleteHunks(section) || /^(?:Binary files |GIT binary patch)/m.test(section))
      continue;
    const newToken = /^\+\+\+ ([^\r\n]+)/m.exec(section)?.[1]?.split("\t", 1)[0];
    const oldToken = /^--- ([^\r\n]+)/m.exec(section)?.[1]?.split("\t", 1)[0];
    const token = newToken === "/dev/null" ? oldToken : newToken;
    if (token === undefined) continue;
    const unquoted = unquoteGitPatchPath(token);
    if (!/^[ab]\//.test(unquoted)) continue;
    const path = unquoted.slice(2);
    if (path.length === 0 || ambiguous.has(path) || excludedPaths.has(path)) continue;
    if (found.has(path)) {
      found.delete(path);
      ambiguous.add(path);
      continue;
    }
    const digest = NodeCrypto.createHash("sha256")
      .update(
        JSON.stringify([scope.provider, scope.host, scope.remote, scope.number, path, section]),
      )
      .digest("hex");
    found.set(path, digest);
  }
  return [...found].map(([path, digest]) => ({ path, digest }));
}
