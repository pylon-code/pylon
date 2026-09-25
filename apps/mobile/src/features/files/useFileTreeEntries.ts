import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectEntry } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";

import { appAtomRegistry } from "../../state/atom-registry";
import { projectEnvironment } from "../../state/projects";
import { useDebouncedValue } from "../../state/queries";
import { useEnvironmentQuery } from "../../state/query";

const MAX_DIRECTORY_PAGES = 50;

export function useFileTreeEntries(input: {
  readonly cwd: string | null;
  readonly environmentId: EnvironmentId | null;
  readonly searchQuery: string;
}) {
  const { cwd, environmentId } = input;
  const searching = input.searchQuery.trim().length > 0;
  const query = input.searchQuery.trim().slice(0, 256);
  const debouncedQuery = useDebouncedValue(query, 200);
  const root = useEnvironmentQuery(
    cwd !== null && environmentId !== null
      ? projectEnvironment.listEntries({ environmentId, input: { cwd, directoryPath: "" } })
      : null,
  );
  const search = useEnvironmentQuery(
    searching && debouncedQuery.length > 0 && cwd !== null && environmentId !== null
      ? projectEnvironment.searchEntries({
          environmentId,
          input: { cwd, query: debouncedQuery, limit: 200 },
        })
      : null,
  );
  // Older servers ignore directoryPath and return the complete indexed tree. Keep rendering that
  // answer as a legacy tree instead of treating it as one folder's immediate children.
  const legacyEntries =
    root.data !== null && root.data.directoryPath === undefined ? root.data.entries : null;
  const [revision, render] = useReducer((value: number) => value + 1, 0);
  const refreshVersion = useRef(0);
  const directories = useMemo(
    () => ({
      cwd,
      environmentId,
      entries: new Map<string, ReadonlyArray<ProjectEntry>>(),
      requested: new Set<string>(),
      pending: new Map<string, AbortController>(),
      errors: new Map<string, string>(),
    }),
    [cwd, environmentId],
  );
  useEffect(
    () => () => {
      refreshVersion.current++;
      for (const controller of directories.pending.values()) controller.abort();
      directories.pending.clear();
    },
    [directories],
  );
  const loadDirectory = useCallback(
    (directoryPath: string, refresh = false) => {
      if (
        cwd === null ||
        environmentId === null ||
        legacyEntries !== null ||
        (!refresh && directories.entries.has(directoryPath)) ||
        directories.pending.has(directoryPath)
      ) {
        return;
      }
      const controller = new AbortController();
      directories.requested.add(directoryPath);
      directories.pending.set(directoryPath, controller);
      directories.errors.delete(directoryPath);
      render();
      return (async () => {
        const collected: ProjectEntry[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < MAX_DIRECTORY_PAGES; page++) {
          const atom = projectEnvironment.listEntries({
            environmentId,
            input: {
              cwd,
              directoryPath,
              ...(cursor === undefined ? {} : { directoryCursor: cursor }),
            },
          });
          appAtomRegistry.refresh(atom);
          const result = await executeAtomQuery(appAtomRegistry, atom, {
            signal: controller.signal,
            reportFailure: false,
            reportDefect: false,
          });
          if (controller.signal.aborted) return;
          if (result._tag !== "Success") {
            const cause = Cause.squash(result.cause);
            throw cause instanceof Error ? cause : new Error("Files unavailable");
          }
          // A legacy server returns its indexed full tree without the marker. The root query
          // renders that answer; never misinterpret a nested copy as one folder's children.
          if (result.value.directoryPath !== directoryPath) return;
          collected.push(
            ...result.value.entries.filter(
              (entry) =>
                entry.path.slice(0, Math.max(0, entry.path.lastIndexOf("/"))) === directoryPath,
            ),
          );
          if (!result.value.truncated) {
            directories.entries.set(directoryPath, collected);
            return;
          }
          if (
            result.value.nextDirectoryCursor === undefined ||
            result.value.nextDirectoryCursor === cursor
          ) {
            throw new Error("Folder listing stopped before all entries arrived. Refresh to retry.");
          }
          cursor = result.value.nextDirectoryCursor;
        }
        throw new Error("This folder has too many items to show. Search for a narrower path.");
      })()
        .catch((error: unknown) => {
          if (!controller.signal.aborted)
            directories.errors.set(
              directoryPath,
              error instanceof Error ? error.message : "Files unavailable",
            );
        })
        .finally(() => {
          if (controller.signal.aborted) return;
          directories.pending.delete(directoryPath);
          render();
        });
    },
    [cwd, directories, environmentId, legacyEntries],
  );
  const { refresh: refreshRoot, data: rootData } = root;
  useEffect(() => {
    if (
      rootData?.directoryPath === "" &&
      rootData.nextDirectoryCursor !== undefined &&
      !directories.entries.has("")
    ) {
      void loadDirectory("");
    }
  }, [directories, loadDirectory, rootData]);
  const { refresh: refreshSearch, data: searchData } = search;
  const snapshot = useMemo(() => {
    const merged = new Map<string, ProjectEntry>();
    if (searching) {
      for (const entry of searchData?.entries ?? []) merged.set(entry.path, entry);
    }
    const reachableDirectories = new Set<string>();
    const visit = (items: ReadonlyArray<ProjectEntry>) => {
      for (const entry of items) {
        merged.set(entry.path, entry);
        if (entry.kind === "directory") {
          reachableDirectories.add(entry.path);
          visit(directories.entries.get(entry.path) ?? []);
        }
      }
    };
    if (legacyEntries !== null) {
      for (const entry of legacyEntries) merged.set(entry.path, entry);
      for (const entry of legacyEntries)
        if (entry.kind === "directory") reachableDirectories.add(entry.path);
    } else {
      visit(
        (directories.entries.get("") ?? rootData?.entries ?? []).filter(
          (entry) => !entry.path.includes("/"),
        ),
      );
    }
    return { revision, entries: [...merged.values()], reachableDirectories };
  }, [directories, legacyEntries, revision, rootData, searchData, searching]);

  const refresh = useCallback(() => {
    refreshRoot();
    if (searching) refreshSearch();
    const paths = new Set(
      [...directories.requested].filter((path) => snapshot.reachableDirectories.has(path)),
    );
    if (legacyEntries !== null) {
      render();
      return;
    }
    for (const controller of directories.pending.values()) controller.abort();
    directories.pending.clear();
    directories.errors.clear();
    const version = ++refreshVersion.current;
    const remaining = paths.values();
    const worker = async () => {
      while (version === refreshVersion.current) {
        const next = remaining.next();
        if (next.done) return;
        await loadDirectory(next.value, true);
      }
    };
    for (let index = 0; index < Math.min(4, paths.size); index++) void worker();
    render();
  }, [
    directories,
    legacyEntries,
    loadDirectory,
    refreshRoot,
    refreshSearch,
    searching,
    snapshot.reachableDirectories,
  ]);

  return {
    entries: snapshot.entries,
    error:
      root.error ??
      (searching ? search.error : null) ??
      [...directories.errors].find(([path]) => snapshot.reachableDirectories.has(path))?.[1] ??
      null,
    isPending:
      root.isPending ||
      directories.pending.size > 0 ||
      (searching && (query !== debouncedQuery || search.isPending)),
    searchTruncated: searching && (search.data?.truncated ?? false),
    loadedDirectories:
      legacyEntries === null
        ? new Set(directories.entries.keys())
        : new Set(
            [...legacyEntries]
              .filter((entry) => entry.kind === "directory")
              .map((entry) => entry.path),
          ),
    loadDirectory,
    refresh,
  };
}
