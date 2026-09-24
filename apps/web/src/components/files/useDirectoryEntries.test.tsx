import { EnvironmentId, type ProjectListEntriesResult } from "@t3tools/contracts";
import { StrictMode, act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

const { fixture } = vi.hoisted(() => ({
  fixture: {
    answers: new Map<string, ProjectListEntriesResult>(),
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
    const value = fixture.answers.get(key);
    if (value === undefined) throw new Error(`Missing fixture for ${key}`);
    return { _tag: "Success", value };
  },
}));
vi.mock("~/rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("~/state/projects", () => ({
  projectEnvironment: {
    listEntries: ({ input }: { input: { directoryPath: string; directoryCursor?: string } }) => ({
      input,
    }),
  },
}));

import { useDirectoryEntries } from "./useDirectoryEntries";

const environmentId = EnvironmentId.make("web-files-test");
let renderer: ReactTestRenderer | null = null;
function Probe(props: { readonly state: ReturnType<typeof useDirectoryEntries> }) {
  return null;
}
function Surface() {
  return <Probe state={useDirectoryEntries(environmentId, "/workspace")} />;
}
function current() {
  return renderer!.root.findByType(Probe).props.state as ReturnType<typeof useDirectoryEntries>;
}

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
  fixture.answers.clear();
  fixture.requests.length = 0;
});

it("keeps an old server's indexed answer whole and avoids child-folder requests", async () => {
  fixture.answers.set(":", {
    entries: [
      { path: "src", kind: "directory" },
      { path: "src/deep.ts", kind: "file" },
    ],
    truncated: false,
  });
  await act(async () => {
    renderer = create(<Surface />);
  });
  expect(current().entries.map((entry) => entry.path)).toEqual(["src", "src/deep.ts"]);
  await act(async () => current().load("src"));
  expect(fixture.requests).toEqual([":"]);
});

it("loads every page of an expanded folder only when requested", async () => {
  fixture.answers.set(":", {
    entries: [{ path: "src", kind: "directory" }],
    truncated: false,
    directoryPath: "",
  });
  fixture.answers.set("src:", {
    entries: [{ path: "src/a.ts", kind: "file" }],
    truncated: true,
    directoryPath: "src",
    nextDirectoryCursor: "a.ts",
  });
  fixture.answers.set("src:a.ts", {
    entries: [{ path: "src/b.ts", kind: "file" }],
    truncated: false,
    directoryPath: "src",
  });
  await act(async () => {
    renderer = create(<Surface />);
  });
  expect(current().entries.map((entry) => entry.path)).toEqual(["src"]);
  await act(async () => current().load("src"));
  expect(fixture.requests).toEqual([":", "src:", "src:a.ts"]);
  expect(current().entries.map((entry) => entry.path)).toEqual(["src", "src/a.ts", "src/b.ts"]);
});

it("reissues the root request after a StrictMode effect restart", async () => {
  fixture.answers.set(":", {
    entries: [{ path: "src", kind: "directory" }],
    truncated: false,
    directoryPath: "",
  });
  await act(async () => {
    renderer = create(
      <StrictMode>
        <Surface />
      </StrictMode>,
    );
  });
  expect(current().entries.map((entry) => entry.path)).toEqual(["src"]);
  expect(fixture.requests).toEqual([":", ":"]);
  expect(current().isPending).toBe(false);
});
