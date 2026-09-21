import { afterEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

const fileSystemMocks = vi.hoisted(() => {
  let entries: File[] = [];

  class File {
    exists = true;
    delete = vi.fn(() => {
      this.exists = false;
    });

    constructor(
      readonly name: string,
      private readonly contents: string,
    ) {}

    async text(): Promise<string> {
      return this.contents;
    }
  }

  class Directory {
    create(): void {}

    list(): ReadonlyArray<File> {
      return entries;
    }
  }

  return {
    Directory,
    File,
    setEntries(next: File[]) {
      entries = next;
    },
  };
});

vi.mock("expo-file-system", () => ({
  Directory: fileSystemMocks.Directory,
  File: fileSystemMocks.File,
  Paths: { document: "/documents" },
}));

import {
  INCOMING_SHARE_TTL_MS,
  MAX_INCOMING_SHARE_DRAFTS,
  IncomingShareStorageError,
  loadIncomingShareDrafts,
} from "./incoming-share-storage";

const VALID_DRAFT = {
  schemaVersion: 1,
  id: "share-valid",
  createdAt: "2026-08-28T12:00:00.000Z",
  text: "Review this file",
  attachments: [],
  warnings: [],
} as const;

afterEach(() => {
  fileSystemMocks.setEntries([]);
  vi.restoreAllMocks();
});

describe("incoming share storage", () => {
  it("skips and deletes an invalid persisted share by default", async () => {
    const validFile = new fileSystemMocks.File("valid.json", JSON.stringify(VALID_DRAFT));
    const invalidFile = new fileSystemMocks.File("invalid.json", "{");
    fileSystemMocks.setEntries([validFile, invalidFile]);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      loadIncomingShareDrafts({ now: Date.parse("2026-08-28T12:00:00.000Z") }),
    ).resolves.toEqual([VALID_DRAFT]);
    expect(warning).toHaveBeenCalledOnce();
    expect(invalidFile.delete).toHaveBeenCalledOnce();
    expect(validFile.delete).not.toHaveBeenCalled();
  });

  it("rejects an invalid persisted share in strict mode", async () => {
    fileSystemMocks.setEntries([new fileSystemMocks.File("invalid.json", "{")]);

    await expect(loadIncomingShareDrafts({ strict: true })).rejects.toBeInstanceOf(
      IncomingShareStorageError,
    );
  });

  it("prunes and deletes expired drafts older than TTL", async () => {
    const freshDraft = {
      ...VALID_DRAFT,
      id: "share-fresh",
      createdAt: "2026-08-28T12:00:00.000Z",
    };
    const expiredDraft = {
      ...VALID_DRAFT,
      id: "share-expired",
      createdAt: "2026-08-01T12:00:00.000Z",
    };
    const freshFile = new fileSystemMocks.File("share-fresh.json", JSON.stringify(freshDraft));
    const expiredFile = new fileSystemMocks.File(
      "share-expired.json",
      JSON.stringify(expiredDraft),
    );
    fileSystemMocks.setEntries([freshFile, expiredFile]);

    const now = Date.parse("2026-08-28T13:00:00.000Z");
    const loaded = await loadIncomingShareDrafts({ now });

    expect(loaded).toEqual([freshDraft]);
    expect(expiredFile.delete).toHaveBeenCalledOnce();
    expect(freshFile.delete).not.toHaveBeenCalled();
  });

  it("caps retained drafts at MAX_INCOMING_SHARE_DRAFTS and prunes excess older files", async () => {
    const files: any[] = [];
    const drafts: any[] = [];
    for (let i = 0; i < MAX_INCOMING_SHARE_DRAFTS + 5; i++) {
      const pad = String(i).padStart(2, "0");
      const d = {
        ...VALID_DRAFT,
        id: `share-${pad}`,
        createdAt: `2026-08-28T12:${pad}:00.000Z`,
      };
      drafts.push(d);
      files.push(new fileSystemMocks.File(`share-${pad}.json`, JSON.stringify(d)));
    }
    fileSystemMocks.setEntries(files);

    const now = Date.parse("2026-08-28T13:00:00.000Z");
    const loaded = await loadIncomingShareDrafts({ now });

    expect(loaded).toHaveLength(MAX_INCOMING_SHARE_DRAFTS);
    // Drafts sorted newest first: indices 0..4 (the oldest) should be deleted
    for (let i = 0; i < 5; i++) {
      expect(files[i].delete).toHaveBeenCalledOnce();
    }
    // Newest MAX_INCOMING_SHARE_DRAFTS (indices 5..24) should NOT be deleted
    for (let i = 5; i < files.length; i++) {
      expect(files[i].delete).not.toHaveBeenCalled();
    }
  });
});
