import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  delegatedParentThreadId,
  flattenNestedThreads,
  nestDelegatedThreads,
  nestedRowContainsThread,
} from "./delegatedThreads.ts";

const HASH = "0123456789abcdef";
const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const thread = (environmentId: EnvironmentId, id: string) => ({
  environmentId,
  id: ThreadId.make(id),
});
const ids = (threads: readonly { readonly id: string }[] | undefined) =>
  threads?.map((entry) => entry.id);

describe("delegatedParentThreadId", () => {
  it("returns the parent of a delegated child", () => {
    expect(delegatedParentThreadId(ThreadId.make(`delegated:parent-1:${HASH}`))).toBe("parent-1");
  });

  it("keeps colons inside the parent id", () => {
    expect(delegatedParentThreadId(ThreadId.make(`delegated:import:a:b:${HASH}`))).toBe(
      "import:a:b",
    );
  });

  it("ignores ordinary and malformed ids", () => {
    for (const id of [
      "parent-1",
      `delegated:${HASH}`,
      `delegated::${HASH}`,
      "delegated:parent-1:0123",
      "delegated:parent-1:0123456789ABCDEF",
      `delegated:parent-1:${HASH}0`,
    ]) {
      expect(delegatedParentThreadId(ThreadId.make(id))).toBeNull();
    }
  });
});

describe("nestDelegatedThreads", () => {
  it("nests children under a parent in the same list, keeping input order", () => {
    const parent = thread(local, "parent");
    const first = thread(local, `delegated:parent:${HASH}`);
    const other = thread(local, "other");
    const second = thread(local, "delegated:parent:fedcba9876543210");
    const nested = nestDelegatedThreads([first, parent, other, second]);
    expect(ids(nested.topLevel)).toEqual(["parent", "other"]);
    expect(ids(nested.childrenByParentKey.get("local:parent"))).toEqual([
      `delegated:parent:${HASH}`,
      "delegated:parent:fedcba9876543210",
    ]);
  });

  it("keeps a child top-level when its parent is not in the list", () => {
    const orphan = thread(local, `delegated:elsewhere:${HASH}`);
    const nested = nestDelegatedThreads([thread(local, "parent"), orphan]);
    expect(ids(nested.topLevel)).toEqual(["parent", `delegated:elsewhere:${HASH}`]);
    expect(nested.childrenByParentKey.size).toBe(0);
  });

  it("matches the parent within the child's own environment", () => {
    const nested = nestDelegatedThreads([
      thread(remote, "parent"),
      thread(local, `delegated:parent:${HASH}`),
    ]);
    expect(nested.topLevel).toHaveLength(2);
    expect(nested.childrenByParentKey.size).toBe(0);
  });
});

describe("rendered nested rows", () => {
  const parent = thread(local, "parent");
  const child = thread(local, `delegated:parent:${HASH}`);
  const other = thread(local, "other");
  const nested = nestDelegatedThreads([parent, other, child]);

  it("flattens each row followed by its children", () => {
    expect(ids(flattenNestedThreads(nested.topLevel, nested))).toEqual([
      "parent",
      `delegated:parent:${HASH}`,
      "other",
    ]);
    expect(ids(flattenNestedThreads([other], nested))).toEqual(["other"]);
  });

  it("treats a parent row as containing its nested children", () => {
    expect(nestedRowContainsThread(parent, nested, `local:delegated:parent:${HASH}`)).toBe(true);
    expect(nestedRowContainsThread(parent, nested, "local:parent")).toBe(true);
    expect(nestedRowContainsThread(other, nested, `local:delegated:parent:${HASH}`)).toBe(false);
  });
});
