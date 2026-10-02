// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Isolated native filesystem fixtures and fake-clock retention tests.
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { DownloadItem } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  AGENT_DOWNLOAD_RETENTION_MS,
  MAX_AGENT_DOWNLOAD_BYTES,
  MAX_AGENT_DOWNLOAD_FILES,
  createCapturedDownloads,
} from "./CapturedDownloads.ts";

function download(totalBytes = 0) {
  let savePath: string | undefined;
  const item = Object.assign(new NodeEvents.EventEmitter(), {
    getTotalBytes: vi.fn(() => totalBytes),
    getReceivedBytes: vi.fn(() => 0),
    setSavePath: vi.fn((value: string) => {
      savePath = value;
      NodeFS.writeFileSync(value, "partial");
    }),
    cancel: vi.fn(() => item.emit("done", {}, "cancelled")),
  });
  return { item, native: item as unknown as DownloadItem, savePath: () => savePath };
}

describe("captured preview download limits", () => {
  let root: string;
  let captures: ReturnType<typeof createCapturedDownloads>;
  beforeEach(() => {
    root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pylon-downloads-"));
    captures = createCapturedDownloads(root);
  });
  afterEach(() => {
    captures.dispose();
    NodeFS.rmSync(root, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it("rejects an oversized declared download before assigning a path", () => {
    const transfer = download(MAX_AGENT_DOWNLOAD_BYTES + 1);
    const cancelled = vi.fn();
    captures.capture(transfer.native, "browser-download-large", cancelled);
    expect(transfer.item.cancel).toHaveBeenCalledOnce();
    expect(transfer.item.setSavePath).not.toHaveBeenCalled();
    expect(cancelled).toHaveBeenCalledWith(expect.stringContaining("byte limit"));
  });

  it.each(["received", "total"])(
    "cancels when %s bytes grow past the limit and removes partial data",
    (kind) => {
      const transfer = download();
      const cancelled = vi.fn();
      captures.capture(transfer.native, "browser-download-growing", cancelled);
      const bytes =
        kind === "received" ? transfer.item.getReceivedBytes : transfer.item.getTotalBytes;
      bytes.mockReturnValue(MAX_AGENT_DOWNLOAD_BYTES);
      transfer.item.emit("updated", {}, "progressing");
      expect(transfer.item.cancel).not.toHaveBeenCalled();
      bytes.mockReturnValue(MAX_AGENT_DOWNLOAD_BYTES + 1);
      transfer.item.emit("updated", {}, "progressing");
      expect(transfer.item.cancel).toHaveBeenCalledOnce();
      expect(cancelled).toHaveBeenCalledOnce();
      expect(NodeFS.existsSync(transfer.savePath()!)).toBe(false);
      expect(transfer.item.listenerCount("updated")).toBe(0);
    },
  );

  it("checks already received bytes on admission even when total size is unknown", () => {
    const transfer = download();
    transfer.item.getReceivedBytes.mockReturnValue(MAX_AGENT_DOWNLOAD_BYTES + 1);
    captures.capture(transfer.native, "browser-download-resumed", vi.fn());
    expect(transfer.item.cancel).toHaveBeenCalledOnce();
    expect(transfer.item.setSavePath).not.toHaveBeenCalled();
  });

  it("reserves active slots and evicts only the oldest completed capture", () => {
    const recording = NodePath.join(root, "browser-recording-keep.webm");
    const screenshot = NodePath.join(root, "browser-screenshot-keep.png");
    NodeFS.writeFileSync(recording, "recording");
    NodeFS.writeFileSync(screenshot, "screenshot");
    const transfers = Array.from({ length: MAX_AGENT_DOWNLOAD_FILES }, (_, index) => {
      const transfer = download();
      captures.capture(transfer.native, `browser-download-${index}`, vi.fn());
      return transfer;
    });
    const rejected = download();
    captures.capture(rejected.native, "browser-download-overflow", vi.fn());
    expect(rejected.item.cancel).toHaveBeenCalledOnce();
    expect(rejected.item.setSavePath).not.toHaveBeenCalled();
    transfers[0]!.item.emit("done", {}, "completed");
    const next = download();
    captures.capture(next.native, "browser-download-next", vi.fn());
    expect(next.item.cancel).not.toHaveBeenCalled();
    expect(NodeFS.existsSync(transfers[0]!.savePath()!)).toBe(false);
    for (const transfer of transfers.slice(1))
      expect(NodeFS.existsSync(transfer.savePath()!)).toBe(true);
    expect(NodeFS.readdirSync(NodePath.join(root, "agent-downloads"))).toHaveLength(
      MAX_AGENT_DOWNLOAD_FILES,
    );
    expect(NodeFS.readFileSync(recording, "utf8")).toBe("recording");
    expect(NodeFS.readFileSync(screenshot, "utf8")).toBe("screenshot");
  });

  it("bounds persisted captures on restart and prunes expired and oversized files", () => {
    captures.dispose();
    const directory = NodePath.join(root, "agent-downloads");
    NodeFS.mkdirSync(directory);
    for (let index = 0; index < MAX_AGENT_DOWNLOAD_FILES + 2; index++) {
      const file = NodePath.join(directory, `browser-download-${index}`);
      NodeFS.writeFileSync(file, "data");
      const time = new Date(Date.now() - 10000 + index * 1000);
      NodeFS.utimesSync(file, time, time);
    }
    const expired = NodePath.join(directory, "browser-download-expired");
    NodeFS.writeFileSync(expired, "expired");
    const old = new Date(Date.now() - AGENT_DOWNLOAD_RETENTION_MS - 1000);
    NodeFS.utimesSync(expired, old, old);
    const oversized = NodePath.join(directory, "browser-download-oversized");
    NodeFS.writeFileSync(oversized, "");
    NodeFS.truncateSync(oversized, MAX_AGENT_DOWNLOAD_BYTES + 1);
    const untouched = NodePath.join(directory, "browser-recording-keep.webm");
    NodeFS.writeFileSync(untouched, "recording");
    captures = createCapturedDownloads(root);
    expect(NodeFS.readdirSync(directory).sort()).toEqual([
      "browser-download-2",
      "browser-download-3",
      "browser-download-4",
      "browser-download-5",
      "browser-download-6",
      "browser-recording-keep.webm",
    ]);
  });

  it("expires completed captures without another download", () => {
    captures.dispose();
    vi.useFakeTimers();
    captures = createCapturedDownloads(root);
    const transfer = download();
    captures.capture(transfer.native, "browser-download-expire", vi.fn());
    transfer.item.emit("done", {}, "completed");
    vi.advanceTimersByTime(AGENT_DOWNLOAD_RETENTION_MS + 60_000);
    expect(NodeFS.existsSync(transfer.savePath()!)).toBe(false);
  });

  it("times out endless transfers and cancels active downloads on disposal", () => {
    captures.dispose();
    vi.useFakeTimers();
    captures = createCapturedDownloads(root);
    const endless = download();
    const cancelled = vi.fn();
    captures.capture(endless.native, "browser-download-endless", cancelled);
    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(endless.item.cancel).toHaveBeenCalledOnce();
    expect(cancelled).toHaveBeenCalledWith(expect.stringContaining("timeout"));
    expect(NodeFS.existsSync(endless.savePath()!)).toBe(false);
    const active = download();
    captures.capture(active.native, "browser-download-active", vi.fn());
    captures.dispose();
    expect(active.item.cancel).toHaveBeenCalledOnce();
    expect(NodeFS.existsSync(active.savePath()!)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails closed when storage cannot be reserved", () => {
    NodeFS.writeFileSync(NodePath.join(root, "agent-downloads"), "blocked");
    const transfer = download();
    const cancelled = vi.fn();
    captures.capture(transfer.native, "browser-download-blocked", cancelled);
    expect(transfer.item.cancel).toHaveBeenCalledOnce();
    expect(transfer.item.setSavePath).not.toHaveBeenCalled();
    expect(cancelled).toHaveBeenCalledWith(expect.stringContaining("unable to reserve"));
  });
});
