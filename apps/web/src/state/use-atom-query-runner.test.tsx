import { RegistryContext } from "@effect/atom-react";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

import { useAtomQueryRunner } from "./use-atom-query-runner";

describe("query runner cancellation", () => {
  it.each(["hook", "call"] as const)(
    "interrupts a pending query with the %s signal",
    async (scope) => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      const registry = AtomRegistry.make();
      const atom = Atom.make<AsyncResult.AsyncResult<string>>(AsyncResult.initial());
      const family = () => atom;
      const controller = new AbortController();
      let run: ReturnType<typeof useAtomQueryRunner<void, string, never>> | undefined;
      let renderer: ReactTestRenderer | undefined;
      function Probe() {
        const query = useAtomQueryRunner(family, {
          reportFailure: false,
          ...(scope === "hook" ? { signal: controller.signal } : {}),
        });
        useLayoutEffect(() => {
          run = query;
        }, [query]);
        return null;
      }
      try {
        await act(() => {
          renderer = create(
            <RegistryContext value={registry}>
              <Probe />
            </RegistryContext>,
          );
        });
        const pending = run!(
          undefined,
          scope === "call" ? { signal: controller.signal } : undefined,
        );
        controller.abort();
        expect(isAtomCommandInterrupted(await pending)).toBe(true);
        // A later independent read still succeeds; cancellation belongs to the caller.
        registry.set(atom, AsyncResult.success("ready"));
        expect(await run!(undefined, { signal: new AbortController().signal })).toMatchObject({
          _tag: "Success",
          value: "ready",
        });
      } finally {
        await act(() => renderer?.unmount());
        registry.dispose();
        vi.unstubAllGlobals();
      }
    },
  );
});
