import type { EnvironmentId, ProjectEntry } from "@t3tools/contracts";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { projectEnvironment } from "~/state/projects";

const MAX_DIRECTORY_PAGES = 50;

/** Loads only requested directories; collapsing a folder keeps its children cached. */
export function useDirectoryEntries(environmentId: EnvironmentId, cwd: string) {
  const [directories, setDirectories] = useState(new Map<string, readonly ProjectEntry[]>());
  const [legacyEntries, setLegacyEntries] = useState<readonly ProjectEntry[] | null>(null);
  const legacyEntriesRef = useRef<readonly ProjectEntry[] | null>(null);
  const [errors, setErrors] = useState(new Map<string, string>());
  const [pending, setPending] = useState(0);
  const requests = useRef(new Map<string, Promise<void>>());
  const controllers = useRef(new Set<AbortController>());
  const loaded = useRef(new Set<string>());
  const requested = useRef(new Set<string>());
  const active = useRef(true);
  const generation = useRef(0);
  const running = useRef(0);
  const waiting = useRef<Array<() => void>>([]);

  const load = useCallback(
    function loadDirectory(directoryPath: string, refresh = false): Promise<void> {
      const existing = requests.current.get(directoryPath);
      if (existing)
        return refresh ? existing.then(() => loadDirectory(directoryPath, true)) : existing;
      if (legacyEntriesRef.current !== null && directoryPath !== "") return Promise.resolve();
      if (!refresh && loaded.current.has(directoryPath)) return Promise.resolve();
      loaded.current.add(directoryPath);
      requested.current.add(directoryPath);
      const controller = new AbortController();
      controllers.current.add(controller);
      const requestedGeneration = generation.current;
      setPending((count) => count + 1);
      const request = (async () => {
        if (running.current >= 4)
          await new Promise<void>((resolve) => waiting.current.push(resolve));
        else running.current++;
        try {
          if (
            !active.current ||
            controller.signal.aborted ||
            requestedGeneration !== generation.current
          )
            return undefined;
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
            const result = await executeAtomQuery(appAtomRegistry, atom, {
              refresh: true,
              signal: controller.signal,
              reportFailure: false,
              reportDefect: false,
            });
            if (
              !active.current ||
              controller.signal.aborted ||
              requestedGeneration !== generation.current
            )
              return undefined;
            if (result._tag !== "Success") {
              const cause = Cause.squash(result.cause);
              throw cause instanceof Error ? cause : new Error("Unable to load folder.");
            }
            if (result.value.directoryPath === undefined) {
              return { legacy: result.value.entries };
            }
            if (result.value.directoryPath !== directoryPath) {
              throw new Error("The server returned a different folder. Refresh to retry.");
            }
            collected.push(
              ...result.value.entries.filter(
                (entry) =>
                  entry.path.slice(0, Math.max(0, entry.path.lastIndexOf("/"))) === directoryPath,
              ),
            );
            if (!result.value.truncated) return { entries: collected };
            if (
              result.value.nextDirectoryCursor === undefined ||
              result.value.nextDirectoryCursor === cursor
            ) {
              throw new Error(
                "Folder listing stopped before all entries arrived. Refresh to retry.",
              );
            }
            cursor = result.value.nextDirectoryCursor;
          }
          throw new Error("This folder has too many items to show. Search for a narrower path.");
        } finally {
          const next = waiting.current.shift();
          if (next) next();
          else running.current--;
        }
      })()
        .then((result) => {
          if (!active.current || requestedGeneration !== generation.current || !result) return;
          if ("legacy" in result) {
            if (directoryPath === "") {
              legacyEntriesRef.current = result.legacy;
              setLegacyEntries(result.legacy);
            }
            return;
          }
          if (directoryPath === "") {
            legacyEntriesRef.current = null;
            setLegacyEntries(null);
          }
          setDirectories((previous) => new Map(previous).set(directoryPath, result.entries));
          setErrors((previous) => {
            const next = new Map(previous);
            next.delete(directoryPath);
            return next;
          });
        })
        .catch((error: unknown) => {
          if (!active.current || requestedGeneration !== generation.current) return;
          loaded.current.delete(directoryPath);
          setErrors((previous) =>
            new Map(previous).set(
              directoryPath,
              error instanceof Error ? error.message : "Unable to load folder.",
            ),
          );
        })
        .finally(() => {
          controllers.current.delete(controller);
          if (requests.current.get(directoryPath) === request)
            requests.current.delete(directoryPath);
          if (active.current && requestedGeneration === generation.current)
            setPending((count) => count - 1);
        });
      requests.current.set(directoryPath, request);
      return request;
    },
    [cwd, environmentId],
  );

  useEffect(() => {
    active.current = true;
    setPending(0);
    void load("");
    return () => {
      active.current = false;
      generation.current++;
      for (const controller of controllers.current) controller.abort();
      controllers.current.clear();
      requests.current.clear();
      loaded.current.clear();
    };
  }, [load]);

  const entries = useMemo(() => {
    if (legacyEntries !== null) return legacyEntries;
    const result: ProjectEntry[] = [];
    const visit = (path: string) => {
      for (const entry of directories.get(path) ?? []) {
        result.push(entry);
        if (entry.kind === "directory") visit(entry.path);
      }
    };
    visit("");
    return result;
  }, [directories, legacyEntries]);

  const reachableDirectories = useMemo(
    () =>
      new Set([
        "",
        ...entries.filter((entry) => entry.kind === "directory").map((entry) => entry.path),
      ]),
    [entries],
  );

  const refresh = useCallback(() => {
    // Refresh folders already visited, preserving the current expansion state.
    const paths = [...requested.current].filter((path) => reachableDirectories.has(path));
    for (const controller of controllers.current) controller.abort();
    controllers.current.clear();
    requests.current.clear();
    generation.current++;
    setPending(0);
    let next = 0;
    const worker = async () => {
      while (next < paths.length && active.current) {
        const path = paths[next++];
        if (path !== undefined) await load(path, true);
      }
    };
    for (let index = 0; index < Math.min(4, paths.length); index++) void worker();
  }, [load, reachableDirectories]);

  return {
    entries,
    load,
    refresh,
    isPending: pending > 0,
    ready: legacyEntries !== null || directories.has(""),
    error: [...errors].find(([path]) => reachableDirectories.has(path))?.[1] ?? null,
  };
}
