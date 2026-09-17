/** Retain a clicked route in main until a ready renderer finishes navigation. */
export function subscribeNotificationNavigation(input: {
  read: () => Promise<unknown>;
  complete: (id: number) => Promise<unknown>;
  listen: (signal: () => void) => () => void;
  navigate: (target: { environmentId: string; threadId: string }) => void | Promise<void>;
}) {
  let active = true;
  let draining = false;
  let requested = false;
  const drain = async () => {
    requested = true;
    if (draining) return;
    draining = true;
    try {
      while (requested) {
        if (!active) break;
        requested = false;
        const target = await input.read();
        if (
          !active ||
          typeof target !== "object" ||
          target === null ||
          !("id" in target) ||
          typeof target.id !== "number" ||
          !("environmentId" in target) ||
          typeof target.environmentId !== "string" ||
          !("threadId" in target) ||
          typeof target.threadId !== "string"
        )
          continue;
        await input.navigate({ environmentId: target.environmentId, threadId: target.threadId });
        if (active) await input.complete(target.id);
      }
    } catch {
      /* Main retains the route for the next ready renderer. */
    } finally {
      draining = false;
    }
  };
  const signal = () => {
    void drain();
  };
  const stop = input.listen(signal);
  signal(); // The click may have arrived before this renderer existed.
  return () => {
    active = false;
    stop();
  };
}
