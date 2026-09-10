// @effect-diagnostics nodeBuiltinImport:off - Regression coverage compares the gated CSS with its observer wiring.
import * as NodeFS from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { observeVisibleAnimation } from "./visibleAnimation";

let focused = true;
let page = Object.assign(new EventTarget(), {
  visibilityState: "visible",
  hasFocus: () => focused,
});
let motion = Object.assign(new EventTarget(), { matches: false });
let host = Object.assign(new EventTarget(), { matchMedia: () => motion });
let observers: TestIntersectionObserver[] = [];
let cleanups: Array<() => void> = [];

class TestIntersectionObserver {
  constructor(private readonly callback: IntersectionObserverCallback) {
    observers.push(this);
  }

  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();

  report(target: Element, isIntersecting: boolean) {
    this.callback(
      [{ target, isIntersecting } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

function animationElement() {
  const properties = new Map<string, string>();
  const element = {
    style: { setProperty: (name: string, value: string) => properties.set(name, value) },
  } as unknown as HTMLElement;
  return {
    element,
    state: () => properties.get("--visible-animation-state"),
    willChange: () => properties.get("--visible-animation-will-change"),
  };
}

function attach(element: HTMLElement) {
  const cleanup = observeVisibleAnimation(element);
  if (cleanup) cleanups.push(cleanup);
  return cleanup;
}

beforeEach(() => {
  focused = true;
  page = Object.assign(new EventTarget(), {
    visibilityState: "visible",
    hasFocus: () => focused,
  });
  motion = Object.assign(new EventTarget(), { matches: false });
  host = Object.assign(new EventTarget(), { matchMedia: () => motion });
  observers = [];
  cleanups = [];
  vi.stubGlobal("document", page);
  vi.stubGlobal("window", host);
  vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
});

afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("observeVisibleAnimation", () => {
  it("runs only intersecting animations in a visible document with motion enabled", () => {
    const first = animationElement();
    const second = animationElement();
    attach(first.element);
    attach(second.element);
    expect(first.state()).toBe("paused");

    const observer = observers[0]!;
    observer.report(first.element, true);
    expect(first.state()).toBe("running");
    expect(second.state()).toBe("paused");

    page.visibilityState = "hidden";
    page.dispatchEvent(new Event("visibilitychange"));
    observer.report(second.element, true);
    expect(first.state()).toBe("paused");
    expect(first.willChange()).toBe("auto");
    expect(second.state()).toBe("paused");

    page.visibilityState = "visible";
    page.dispatchEvent(new Event("visibilitychange"));
    expect(first.state()).toBe("running");
    expect(second.state()).toBe("running");

    observer.report(first.element, false);
    motion.matches = true;
    motion.dispatchEvent(new Event("change"));
    expect(first.state()).toBe("paused");
    expect(second.state()).toBe("paused");

    motion.matches = false;
    motion.dispatchEvent(new Event("change"));
    expect(first.state()).toBe("paused");
    expect(second.state()).toBe("running");
  });

  it("pauses an intersecting animation while the window is unfocused", () => {
    const animation = animationElement();
    attach(animation.element);
    observers[0]!.report(animation.element, true);
    expect(animation.state()).toBe("running");

    focused = false;
    host.dispatchEvent(new Event("blur"));
    expect(animation.state()).toBe("paused");
    expect(animation.willChange()).toBe("auto");

    focused = true;
    host.dispatchEvent(new Event("focus"));
    expect(animation.state()).toBe("running");
  });

  it.each(["hidden", "unfocused", "reduced motion"])(
    "starts paused with %s already active",
    (condition) => {
      page.visibilityState = condition === "hidden" ? "hidden" : "visible";
      focused = condition !== "unfocused";
      motion.matches = condition === "reduced motion";
      const animation = animationElement();
      attach(animation.element);
      observers[0]!.report(animation.element, true);
      expect(animation.state()).toBe("paused");

      page.visibilityState = "visible";
      focused = true;
      motion.matches = false;
      page.dispatchEvent(new Event("visibilitychange"));
      expect(animation.state()).toBe("running");
    },
  );

  it("shares observers, releases the final ref, and ignores late callbacks after remount", () => {
    const addVisibility = vi.spyOn(page, "addEventListener");
    const removeVisibility = vi.spyOn(page, "removeEventListener");
    const addMotion = vi.spyOn(motion, "addEventListener");
    const removeMotion = vi.spyOn(motion, "removeEventListener");
    const addFocus = vi.spyOn(host, "addEventListener");
    const removeFocus = vi.spyOn(host, "removeEventListener");
    const first = animationElement();
    const second = animationElement();
    const detachFirst = attach(first.element);
    const detachSecond = attach(second.element);
    expect(observers).toHaveLength(1);
    expect(addVisibility).toHaveBeenCalledTimes(1);
    expect(addMotion).toHaveBeenCalledTimes(1);
    expect(addFocus).toHaveBeenCalledTimes(2);

    const previousObserver = observers[0]!;
    detachFirst?.();
    previousObserver.report(first.element, true);
    expect(first.state()).toBe("paused");
    expect(previousObserver.unobserve).toHaveBeenCalledWith(first.element);
    expect(previousObserver.disconnect).not.toHaveBeenCalled();

    detachSecond?.();
    expect(previousObserver.disconnect).toHaveBeenCalledTimes(1);
    expect(removeVisibility).toHaveBeenCalledTimes(1);
    expect(removeMotion).toHaveBeenCalledTimes(1);
    expect(removeFocus).toHaveBeenCalledTimes(2);

    attach(second.element);
    expect(observers).toHaveLength(2);
    detachSecond?.();
    previousObserver.report(second.element, true);
    expect(second.state()).toBe("paused");
    observers[1]!.report(second.element, true);
    expect(second.state()).toBe("running");
  });

  it("keeps unknown visibility static when IntersectionObserver is unavailable", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const animation = animationElement();
    attach(animation.element);
    expect(animation.state()).toBe("paused");
    expect(animation.willChange()).toBe("auto");
    expect(observers).toHaveLength(0);
  });
});

const webSourceRoot = new URL("../", import.meta.url);

/** Utilities whose motion only runs once `observeVisibleAnimation` sets the state variable. */
function gatedUtilities(css: string) {
  const gated: string[] = [];
  let utility: string | undefined;
  let body = "";
  for (const line of css.split("\n")) {
    const opening = /^@utility ([\w-]+) \{$/.exec(line);
    if (opening) {
      utility = opening[1];
      body = "";
    } else if (utility === undefined) {
      continue;
    } else if (line === "}") {
      if (body.includes("var(--visible-animation-state")) gated.push(utility);
      utility = undefined;
    } else {
      body += line;
    }
  }
  return gated;
}

function sourceFiles(directory: URL): URL[] {
  return NodeFS.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return sourceFiles(new URL(`${entry.name}/`, directory));
    if (!/\.tsx?$/.test(entry.name) || entry.name.includes(".test.")) return [];
    return [new URL(entry.name, directory)];
  });
}

describe("gated animation utilities", () => {
  it("are applied only by components that attach the observer", () => {
    const css = NodeFS.readFileSync(new URL("index.css", webSourceRoot), "utf8");
    const gated = gatedUtilities(css);
    expect(gated.length).toBeGreaterThan(0);

    const sources = sourceFiles(webSourceRoot).map((url) => ({
      path: url.pathname.slice(webSourceRoot.pathname.length),
      text: NodeFS.readFileSync(url, "utf8"),
    }));

    // A gated utility nobody observes paints a still frame: the animation stays
    // parked on the `paused` fallback, which is how #426 silently stopped the shine.
    const unobserved = gated.flatMap((utility) => {
      const applied = new RegExp(`(?<![\\w-])${utility}(?![\\w-])`);
      const users = sources.filter(({ text }) => applied.test(text));
      if (users.length === 0) return [`${utility} is never applied`];
      return users
        .filter(({ text }) => !text.includes("observeVisibleAnimation"))
        .map(({ path }) => `${utility} in ${path} never attaches observeVisibleAnimation`);
    });

    expect(unobserved).toEqual([]);
  });
});
