import { EnvironmentId, type ProjectListEntriesResult } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

const { fixture } = vi.hoisted(() => ({
  fixture: {
    root: null as ProjectListEntriesResult | null,
    pages: new Map<string, ProjectListEntriesResult>(),
    requests: [] as string[],
  },
}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  executeAtomQuery: async (
    _registry: unknown,
    atom: { input: { directoryPath: string; directoryCursor?: string } },
  ) => {
    const key = `${atom.input.directoryPath}:${atom.input.directoryCursor ?? ""}`;
    fixture.requests.push(key);
    const value = fixture.pages.get(key);
    if (value === undefined) throw new Error(`Missing fixture for ${key}`);
    return { _tag: "Success", value };
  },
}));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: { refresh: () => {} } }));
vi.mock("../../state/projects", () => ({
  projectEnvironment: {
    listEntries: ({ input }: { input: { directoryPath: string; directoryCursor?: string } }) => ({
      kind: "list",
      input,
    }),
    searchEntries: () => ({ kind: "search" }),
  },
}));
vi.mock("../../state/queries", () => ({ useDebouncedValue: (value: string) => value }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: { kind: string } | null) => ({
    data: atom?.kind === "list" ? fixture.root : null,
    error: null,
    isPending: false,
    refresh: () => {},
  }),
}));

import { useFileTreeEntries } from "./useFileTreeEntries";

let renderer: ReactTestRenderer | null = null;
function Probe(_props: { readonly state: ReturnType<typeof useFileTreeEntries> }) {
  return null;
}
function Surface() {
  return (
    <Probe
      state={useFileTreeEntries({
        cwd: "/workspace",
        environmentId: EnvironmentId.make("mobile-files-test"),
        searchQuery: "",
      })}
    />
  );
}
function current() {
  return renderer!.root.findByType(Probe).props.state as ReturnType<typeof useFileTreeEntries>;
}

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
  fixture.root = null;
  fixture.pages.clear();
  fixture.requests.length = 0;
});

it("refreshes a paginated root instead of retaining its old cached entries", async () => {
  fixture.root = {
    entries: [{ path: "old.txt", kind: "file" }],
    truncated: true,
    directoryPath: "",
    nextDirectoryCursor: "old.txt",
  };
  fixture.pages.set(":", fixture.root);
  fixture.pages.set(":old.txt", {
    entries: [{ path: "older.txt", kind: "file" }],
    truncated: false,
    directoryPath: "",
  });
  await act(async () => {
    renderer = create(<Surface />);
  });
  expect(current().entries.map((entry) => entry.path)).toEqual(["old.txt", "older.txt"]);

  fixture.pages.set(":", {
    entries: [{ path: "new.txt", kind: "file" }],
    truncated: true,
    directoryPath: "",
    nextDirectoryCursor: "new.txt",
  });
  fixture.pages.set(":new.txt", {
    entries: [{ path: "newer.txt", kind: "file" }],
    truncated: false,
    directoryPath: "",
  });
  await act(async () => current().refresh());

  expect(fixture.requests).toEqual([":", ":old.txt", ":", ":new.txt"]);
  expect(current().entries.map((entry) => entry.path)).toEqual(["new.txt", "newer.txt"]);
});
