import { describe, expect, it, vi } from "vite-plus/test";

import {
  disconnectEnvironmentAndNavigate,
  disconnectIfStillEligible,
} from "./environmentDisconnectNavigation";

describe("disconnectEnvironmentAndNavigate", () => {
  it("drops a stale button click when live eligibility changed before mutation", async () => {
    let eligible = true;
    const disconnect = vi.fn(async () => "disabled");
    const readLiveEligibility = () => eligible;
    eligible = false; // Connection recovered after the last render, before the click.
    expect(
      await disconnectIfStillEligible({ isEligibleNow: readLiveEligibility, disconnect }),
    ).toBeNull();
    expect(disconnect).not.toHaveBeenCalled();
    eligible = true;
    expect(
      await disconnectIfStillEligible({ isEligibleNow: readLiveEligibility, disconnect }),
    ).toBe("disabled");
    expect(disconnect).toHaveBeenCalledOnce();
  });
  it("navigates home after a successful disconnect only while the same route is current", async () => {
    let complete!: (result: { _tag: "Success" }) => void;
    let location = { href: "/remote/thread", key: "first" };
    const navigateHome = vi.fn();
    const pending = disconnectEnvironmentAndNavigate({
      disconnect: () => new Promise<{ _tag: "Success" }>((resolve) => (complete = resolve)),
      readLocation: () => location,
      navigateHome,
    });
    complete({ _tag: "Success" });
    await pending;
    expect(navigateHome).toHaveBeenCalledOnce();

    const delayed = disconnectEnvironmentAndNavigate({
      disconnect: () => new Promise<{ _tag: "Success" }>((resolve) => (complete = resolve)),
      readLocation: () => location,
      navigateHome,
    });
    location = { href: "/remote/thread?panel=files", key: "first" };
    complete({ _tag: "Success" });
    await delayed;
    expect(navigateHome).toHaveBeenCalledOnce();

    const returned = disconnectEnvironmentAndNavigate({
      disconnect: () => new Promise<{ _tag: "Success" }>((resolve) => (complete = resolve)),
      readLocation: () => location,
      navigateHome,
    });
    location = { href: "/remote/thread?panel=files", key: "second" };
    complete({ _tag: "Success" });
    await returned;
    expect(navigateHome).toHaveBeenCalledOnce();
  });

  it("keeps the current route after a failed disconnect", async () => {
    const navigateHome = vi.fn();
    const result = await disconnectEnvironmentAndNavigate({
      disconnect: async () => ({ _tag: "Failure" as const }),
      readLocation: () => ({ href: "/remote/thread", key: "first" }),
      navigateHome,
    });
    expect(result._tag).toBe("Failure");
    expect(navigateHome).not.toHaveBeenCalled();
  });
});
