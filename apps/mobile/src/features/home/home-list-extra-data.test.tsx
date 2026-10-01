import type { EnvironmentThreadSearchMatch } from "@t3tools/client-runtime/state/thread-search";
import { EnvironmentId } from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it } from "vite-plus/test";

import { useLegacyHomeListExtraData } from "./home-list-extra-data";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type Input = Parameters<typeof useLegacyHomeListExtraData>[0];

const environmentId = EnvironmentId.make("environment-a");
const baseInput: Input = {
  projectCwdByKey: new Map<string, string>(),
  savedConnectionsById: {},
  searchQuery: "",
  threadSearchMatchByKey: new Map<string, EnvironmentThreadSearchMatch>(),
  autoSettleOptOutEnvironmentIds: new Set<EnvironmentId>(),
  titleRegenerationEnvironmentIds: new Set<EnvironmentId>(),
};

function renderExtraData(initial: Input) {
  const seen: unknown[] = [];
  function Probe(props: { readonly input: Input }) {
    seen.push(useLegacyHomeListExtraData(props.input));
    return null;
  }
  let renderer: ReactTestRenderer | undefined;
  act(() => {
    renderer = create(<Probe input={initial} />);
  });
  return {
    seen,
    rerender(input: Input) {
      act(() => renderer?.update(<Probe input={input} />));
    },
  };
}

describe("useLegacyHomeListExtraData", () => {
  it("keeps its identity across renders with unchanged inputs", () => {
    const probe = renderExtraData(baseInput);
    probe.rerender({ ...baseInput });
    expect(probe.seen).toHaveLength(2);
    expect(probe.seen[1]).toBe(probe.seen[0]);
  });

  // A recycled row only re-renders on an item or extraData change, so a
  // capability that lands (server configs after threads) or disappears
  // (server downgrade) must change the identity or the row menu goes stale.
  it("changes identity when the auto-settle capability set changes", () => {
    const probe = renderExtraData(baseInput);
    probe.rerender({ ...baseInput, autoSettleOptOutEnvironmentIds: new Set([environmentId]) });
    expect(probe.seen[1]).not.toBe(probe.seen[0]);
  });

  it("changes identity when the title regeneration capability set changes", () => {
    const probe = renderExtraData(baseInput);
    probe.rerender({ ...baseInput, titleRegenerationEnvironmentIds: new Set([environmentId]) });
    expect(probe.seen[1]).not.toBe(probe.seen[0]);
  });
});
