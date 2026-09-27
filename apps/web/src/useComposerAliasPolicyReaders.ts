import { useLayoutEffect, useRef, useState } from "react";

import { createComposerAliasPolicyReaders, type ComposerAliasPolicy } from "./composer-logic";

/** Keep long-lived composer handlers bound to the current provider and catalog. */
export function useComposerAliasPolicyReaders(policy: ComposerAliasPolicy) {
  const policyRef = useRef(policy);
  // Commit the policy before event handlers run. An interrupted concurrent
  // render must not expose a provider selection that never became visible.
  useLayoutEffect(() => {
    policyRef.current = policy;
  }, [policy]);
  const [readers] = useState(() => createComposerAliasPolicyReaders(() => policyRef.current));
  return readers;
}
