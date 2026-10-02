// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off -- Electron will-download requires synchronous admission/save-path assignment; this native adapter owns its timers and is disposed by the manager scope.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { DownloadItem } from "electron";

export const MAX_AGENT_DOWNLOAD_BYTES = 200 * 1024 * 1024;
// Includes active transfers, so parallel exports cannot bypass the disk bound.
export const MAX_AGENT_DOWNLOAD_FILES = 5;
export const AGENT_DOWNLOAD_RETENTION_MS = 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

/** Separate from thread artifacts: only this directory's captured downloads are evicted. */
export function createCapturedDownloads(artifactDirectory: string) {
  const directory = NodePath.join(artifactDirectory, "agent-downloads");
  const active = new Map<string, () => void>();
  let disposed = false;

  const validateDirectory = (create: boolean) => {
    if (create) NodeFS.mkdirSync(artifactDirectory, { recursive: true });
    let stat = NodeFS.lstatSync(directory, { throwIfNoEntry: false });
    if (!stat) {
      if (!create) return false;
      NodeFS.mkdirSync(directory);
      stat = NodeFS.lstatSync(directory);
    }
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      NodeFS.realpathSync(directory) !==
        NodePath.join(NodeFS.realpathSync(artifactDirectory), "agent-downloads")
    )
      throw new Error(
        "Captured download storage must be a real directory inside the artifact root",
      );
    return true;
  };

  const prune = (maximumFiles: number) => {
    if (!validateDirectory(false)) return;
    const files = NodeFS.readdirSync(directory)
      .filter((name) => name.startsWith("browser-download-"))
      .map((name) => {
        const filePath = NodePath.join(directory, name);
        return { filePath, stat: NodeFS.lstatSync(filePath) };
      })
      .filter(({ filePath, stat }) => stat.isFile() && !active.has(filePath))
      .sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);
    for (const file of files) {
      if (
        file.stat.size > MAX_AGENT_DOWNLOAD_BYTES ||
        file.stat.mtimeMs < Date.now() - AGENT_DOWNLOAD_RETENTION_MS
      ) {
        NodeFS.unlinkSync(file.filePath);
      }
    }
    const retained = files.filter(({ filePath }) => NodeFS.existsSync(filePath));
    for (const file of retained.slice(0, Math.max(0, retained.length - maximumFiles))) {
      NodeFS.unlinkSync(file.filePath);
    }
  };

  // Cleanup failure is fail-closed at admission: no new transfer is allowed
  // unless its slot can be reserved. Retry expiry even when no exports arrive.
  const sweep = () => {
    try {
      prune(MAX_AGENT_DOWNLOAD_FILES - active.size);
    } catch {
      // The next capture reports the failure through its cancellation callback.
    }
  };
  sweep();
  const timer = setInterval(sweep, PRUNE_INTERVAL_MS);
  timer.unref();

  const capture = (item: DownloadItem, fileName: string, onCancelled: (reason: string) => void) => {
    const reject = (reason: string) => {
      item.cancel();
      onCancelled(reason);
    };
    const tooLarge = () =>
      item.getReceivedBytes() > MAX_AGENT_DOWNLOAD_BYTES ||
      item.getTotalBytes() > MAX_AGENT_DOWNLOAD_BYTES;
    if (tooLarge()) {
      reject(`Preview download exceeds the ${MAX_AGENT_DOWNLOAD_BYTES}-byte limit`);
      return;
    }
    if (disposed || active.size >= MAX_AGENT_DOWNLOAD_FILES) {
      reject("Preview download cancelled: captured download slots are full or closed");
      return;
    }
    const filePath = NodePath.join(directory, NodePath.basename(fileName));
    try {
      validateDirectory(true);
      prune(MAX_AGENT_DOWNLOAD_FILES - active.size - 1);
      if (active.has(filePath) || NodeFS.existsSync(filePath)) {
        reject("Preview download cancelled: artifact name already exists");
        return;
      }
    } catch {
      reject("Preview download cancelled: unable to reserve artifact storage");
      return;
    }

    let cancelled = false;
    const cancel = (reason: string) => {
      if (cancelled) return;
      cancelled = true;
      reject(reason);
    };
    const updated = () => {
      if (tooLarge()) cancel(`Preview download exceeds the ${MAX_AGENT_DOWNLOAD_BYTES}-byte limit`);
    };
    const timeout = setTimeout(
      () => cancel("Preview download exceeded the five-minute timeout"),
      DOWNLOAD_TIMEOUT_MS,
    );
    timeout.unref();
    const done = (_event: Electron.Event, state: string) => {
      clearTimeout(timeout);
      item.off("updated", updated);
      active.delete(filePath);
      if (state !== "completed" || cancelled || tooLarge()) {
        try {
          if (validateDirectory(false)) NodeFS.rmSync(filePath, { force: true });
        } catch {
          // Admission retries pruning oversized/expired files before accepting more.
        }
        if (!cancelled) onCancelled("Preview download did not complete within capture limits");
      }
      sweep();
    };
    active.set(filePath, () => cancel("Preview download cancelled: browser capture closed"));
    item.on("updated", updated);
    item.once("done", done);
    try {
      item.setSavePath(filePath);
    } catch {
      cancel("Preview download cancelled: unable to set artifact save path");
    }
  };

  const dispose = () => {
    disposed = true;
    clearInterval(timer);
    for (const cancel of active.values()) cancel();
  };
  return { capture, dispose };
}
