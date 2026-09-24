import { useRef, useState } from "react";

import { createComposerAliasPolicyReaders, type ComposerAliasPolicy } from "./composer-logic";

/** Keep long-lived composer handlers bound to the current provider and catalog. */
export function useComposerAliasPolicyReaders(policy: ComposerAliasPolicy) {
  const policyRef = useRef(policy);
  // Some consumers read these stable functions while rendering, so update the
  // ref before callbacks or derived render state can observe a provider switch.
  policyRef.current = policy;
  const [readers] = useState(() => createComposerAliasPolicyReaders(() => policyRef.current));
  return readers;
}
