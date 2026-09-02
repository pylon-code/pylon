import type { ProviderRuntimeEvent } from "@t3tools/contracts";

import type { ProviderRuntimeFence } from "./ProviderDriver.ts";

const runtimeEventFences = new WeakMap<object, ProviderRuntimeFence>();

export function attachProviderRuntimeEventFence(
  event: ProviderRuntimeEvent,
  runtimeFence: ProviderRuntimeFence | undefined,
): ProviderRuntimeEvent {
  if (runtimeFence !== undefined) runtimeEventFences.set(event, runtimeFence);
  return event;
}

export function readProviderRuntimeEventFence(
  event: ProviderRuntimeEvent,
): ProviderRuntimeFence | undefined {
  return runtimeEventFences.get(event);
}
