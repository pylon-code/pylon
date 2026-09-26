interface LocationIdentity {
  readonly href: string;
  readonly key: string | undefined;
}

/** The menu can remain visible for a render after a connection changes. */
export async function disconnectIfStillEligible<T>(input: {
  readonly isEligibleNow: () => boolean;
  readonly disconnect: () => Promise<T>;
}): Promise<T | null> {
  if (!input.isEligibleNow()) return null;
  return input.disconnect();
}

/** Keep a delayed disconnect from replacing a newer route or search state. */
export async function disconnectEnvironmentAndNavigate<T extends { readonly _tag: string }>(input: {
  readonly disconnect: () => Promise<T>;
  readonly readLocation: () => LocationIdentity;
  readonly navigateHome: () => void;
}): Promise<T> {
  const clickedLocation = input.readLocation();
  const result = await input.disconnect();
  const currentLocation = input.readLocation();
  if (
    result._tag === "Success" &&
    currentLocation.href === clickedLocation.href &&
    currentLocation.key === clickedLocation.key
  ) {
    input.navigateHome();
  }
  return result;
}
