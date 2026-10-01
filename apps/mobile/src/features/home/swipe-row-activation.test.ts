import { describe, expect, it, vi } from "vite-plus/test";

import { createSwipeRowActivation } from "./swipe-row-activation";

describe("createSwipeRowActivation", () => {
  it("activates exactly the requested rows and notifies only on change", () => {
    const activation = createSwipeRowActivation();
    const listener = vi.fn();
    activation.subscribe(listener);

    activation.activate(["a", "b"]);
    activation.activate(["b", "a"]);

    expect(activation.isActive("a")).toBe(true);
    expect(activation.isActive("c")).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);

    activation.activate(["c"]);
    expect(activation.isActive("a")).toBe(false);
    expect(activation.isActive("c")).toBe(true);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("defers changes while a finger is on the list so a press is never remounted", () => {
    const activation = createSwipeRowActivation();
    activation.activate(["a"]);

    activation.trackTouches(["1"], ["1"]);
    activation.activate(["b"]);
    activation.activate(["c"]);
    expect(activation.isActive("a")).toBe(true);
    expect(activation.isActive("c")).toBe(false);

    activation.trackTouches([], []);
    expect(activation.isActive("a")).toBe(false);
    expect(activation.isActive("b")).toBe(false);
    expect(activation.isActive("c")).toBe(true);
  });

  it("ignores fingers that did not start on the list", () => {
    const activation = createSwipeRowActivation();
    activation.trackTouches(["1"], ["1", "2"]);
    activation.activate(["a"]);

    // The list finger lifts while finger 2 stays on another control.
    activation.trackTouches([], ["2"]);
    expect(activation.isActive("a")).toBe(true);
  });

  it("holds activation until every list finger lifts", () => {
    const activation = createSwipeRowActivation();
    activation.activate(["pressed"]);
    activation.trackTouches(["1", "2"], ["1", "2"]);
    activation.activate(["new-viewport"]);

    activation.trackTouches([], ["2"]);
    expect(activation.isActive("pressed")).toBe(true);
    activation.trackTouches([], []);
    expect(activation.isActive("pressed")).toBe(false);
    expect(activation.isActive("new-viewport")).toBe(true);
  });

  it("does not remount rows when the viewport returns while a finger is held", () => {
    const activation = createSwipeRowActivation();
    const listener = vi.fn();
    activation.activate(["pressed"]);
    activation.subscribe(listener);
    activation.trackTouches(["1"], ["1"]);
    activation.activate(["away"]);
    activation.activate(["pressed"]);
    activation.trackTouches([], []);

    expect(activation.isActive("pressed")).toBe(true);
    expect(listener).not.toHaveBeenCalled();
  });

  it("drops a list finger whose end event never arrived", () => {
    const activation = createSwipeRowActivation();
    activation.trackTouches(["1"], ["1"]);
    activation.activate(["a"]);

    activation.trackTouches(["2"], ["2"]);
    activation.trackTouches([], []);
    expect(activation.isActive("a")).toBe(true);
  });

  it("stops notifying after unsubscribe", () => {
    const activation = createSwipeRowActivation();
    const listener = vi.fn();
    const unsubscribe = activation.subscribe(listener);
    unsubscribe();
    activation.activate(["a"]);
    expect(listener).not.toHaveBeenCalled();
  });
});
