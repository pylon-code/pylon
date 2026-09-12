// @effect-diagnostics nodeBuiltinImport:off - Node streams bridge tar/yauzl's bounded extractors.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStreamPromises from "node:stream/promises";
import * as Tar from "tar";
import * as Yauzl from "yauzl";

const MAX_EXPANDED_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ENTRIES = 2_000;
export function safeCuaArchivePath(name: string): boolean {
  return (
    name.length > 0 &&
    name.length < 1024 &&
    !name.startsWith("/") &&
    !name.includes("\\") &&
    !name.includes(":") &&
    ![...name].some((character) => character.charCodeAt(0) < 32) &&
    !name.split("/").some((p) => p === ".." || p === ".")
  );
}

/** Only regular files/directories; no links, devices, duplicate names, or unbounded expansion. */
export async function extractCuaArchive(
  archive: string,
  destination: string,
  zip: boolean,
  signal: AbortSignal,
): Promise<void> {
  let bytes = 0;
  const names = new Set<string>();
  const admit = (name: string, size: number) => {
    const normalized = name.replace(/\/$/u, "");
    bytes += size;
    if (
      !safeCuaArchivePath(normalized) ||
      names.has(normalized) ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      bytes > MAX_EXPANDED_BYTES ||
      names.size >= MAX_ENTRIES
    )
      throw new Error("Unsafe or oversized Cua archive member.");
    names.add(normalized);
  };
  if (!zip) {
    let refused = false;
    const unpack = Tar.x({
      cwd: destination,
      strict: true,
      preservePaths: false,
      noChmod: true,
      filter: (name, entry) => {
        try {
          if (!("type" in entry) || (entry.type !== "File" && entry.type !== "Directory"))
            throw new Error("Links and special files are not allowed.");
          admit(name, entry.size);
          return true;
        } catch {
          refused = true;
          queueMicrotask(() => unpack.abort(new Error("Unsafe Cua archive member")));
          return false;
        }
      },
    });
    await NodeStreamPromises.pipeline(NodeFS.createReadStream(archive), unpack, { signal });
    if (refused || names.size === 0)
      throw new Error("The Cua archive contains unsupported members.");
    return;
  }
  const opened = await new Promise<Yauzl.ZipFile>((resolve, reject) =>
    Yauzl.open(
      archive,
      { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true },
      (error, file) =>
        error || !file ? reject(error ?? new Error("Missing archive")) : resolve(file),
    ),
  );
  let archiveError: Error | undefined;
  const rememberError = (error: Error) => {
    archiveError = error;
  };
  opened.on("error", rememberError);
  try {
    if (opened.entryCount === 0 || opened.entryCount > MAX_ENTRIES)
      throw new Error("Invalid Cua archive member count.");
    for (;;) {
      signal.throwIfAborted();
      if (archiveError) throw archiveError;
      const entry = await new Promise<Yauzl.Entry | null>((resolve, reject) => {
        const cleanup = () => {
          opened.removeListener("entry", onEntry);
          opened.removeListener("end", onEnd);
          opened.removeListener("error", onError);
          signal.removeEventListener("abort", onAbort);
        };
        const onEntry = (entry: Yauzl.Entry) => {
          cleanup();
          resolve(entry);
        };
        const onEnd = () => {
          cleanup();
          resolve(null);
        };
        const onError = (error: Error) => {
          cleanup();
          reject(error);
        };
        const onAbort = () => onError(new Error("Extraction cancelled"));
        opened.once("entry", onEntry);
        opened.once("end", onEnd);
        opened.once("error", onError);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
        else opened.readEntry();
      });
      if (!entry) break;
      const type = (entry.externalFileAttributes >>> 16) & 0o170000;
      const directory = entry.fileName.endsWith("/");
      if (
        (type !== 0 && type !== (directory ? 0o040000 : 0o100000)) ||
        (entry.generalPurposeBitFlag & 1) !== 0
      )
        throw new Error("Unsupported Cua zip member.");
      admit(entry.fileName, entry.uncompressedSize);
      const target = NodePath.join(destination, entry.fileName);
      if (directory) await NodeFSP.mkdir(target, { recursive: true });
      else {
        await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
        const readable = await new Promise<import("node:stream").Readable>((resolve, reject) =>
          opened.openReadStream(entry, (error, value) =>
            error || !value ? reject(error ?? new Error("Missing entry")) : resolve(value),
          ),
        );
        await NodeStreamPromises.pipeline(
          readable,
          NodeFS.createWriteStream(target, { flags: "wx", mode: 0o700 }),
          { signal },
        );
      }
    }
  } finally {
    opened.close();
  }
}
