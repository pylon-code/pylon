import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { dismissContextMenu, showContextMenuFallback } from "./contextMenuFallback";

type FakeListener = (event: FakeDomEvent) => void;

class FakeDomEvent {
  defaultPrevented = false;

  constructor(
    readonly type: string,
    init: Record<string, unknown> = {},
  ) {
    Object.assign(this, init);
  }

  preventDefault() {
    this.defaultPrevented = true;
  }
}

class FakeElement {
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  style: Record<string, string> & { cssText?: string } = {};
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  className = "";
  disabled = false;
  focused = false;
  type = "";
  private textValue = "";
  private readonly listeners = new Map<string, FakeListener[]>();

  constructor(readonly tagName: string) {}

  get isConnected() {
    if (this.tagName === "body") return true;
    let current = this.parent;
    while (current?.parent) {
      current = current.parent;
    }
    return current?.tagName === "body";
  }

  appendChild(child: FakeElement) {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  remove() {
    if (!this.parent) {
      return;
    }
    const index = this.parent.children.indexOf(this);
    if (index >= 0) {
      this.parent.children.splice(index, 1);
    }
    this.parent = null;
  }

  addEventListener(type: string, listener: FakeListener) {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }

  click() {
    this.dispatchEvent(new FakeDomEvent("click", { bubbles: true }));
  }

  dispatchEvent(event: FakeDomEvent) {
    for (const listener of this.listeners.get(event.type) ?? []) {
      listener(event);
    }
    return true;
  }

  focus() {
    const fakeDocument = document as unknown as FakeDocument;
    if (fakeDocument.activeElement === this) {
      return;
    }
    fakeDocument.activeElement?.blur();
    fakeDocument.activeElement = this;
    this.focused = true;
    this.dispatchEvent(new FakeDomEvent("focus"));
  }

  blur() {
    const fakeDocument = document as unknown as FakeDocument;
    if (fakeDocument.activeElement === this) {
      fakeDocument.activeElement = null;
    }
    this.focused = false;
    this.dispatchEvent(new FakeDomEvent("blur"));
  }

  set textContent(value: string) {
    this.textValue = value;
  }

  get textContent() {
    return `${this.textValue}${this.children.map((child) => child.textContent).join("")}`;
  }

  querySelectorAll(tagName: string): FakeElement[] {
    const matches: FakeElement[] = [];
    if (this.tagName === tagName) {
      matches.push(this);
    }
    for (const child of this.children) {
      matches.push(...child.querySelectorAll(tagName));
    }
    return matches;
  }

  getBoundingClientRect() {
    const left = Number.parseInt(this.style.left ?? "0", 10) || 0;
    const top = Number.parseInt(this.style.top ?? "0", 10) || 0;
    const width = this.tagName === "div" ? 180 : 140;
    const height = this.tagName === "div" ? 120 : 28;
    return {
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
    };
  }
}

class FakeBody extends FakeElement {
  private html = "";

  constructor() {
    super("body");
  }

  set innerHTML(value: string) {
    this.html = value;
    this.children = [];
  }

  get innerHTML() {
    return this.html;
  }
}

class FakeDocument {
  body = new FakeBody();
  activeElement: FakeElement | null = null;
  private readonly listeners = new Map<string, FakeListener[]>();

  createElement(tagName: string) {
    return new FakeElement(tagName);
  }

  addEventListener(type: string, listener: FakeListener) {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  dispatchEvent(event: FakeDomEvent) {
    for (const listener of this.listeners.get(event.type) ?? []) {
      listener(event);
    }
  }

  removeEventListener(type: string, listener: FakeListener) {
    const existing = this.listeners.get(type);
    if (!existing) {
      return;
    }
    const index = existing.indexOf(listener);
    if (index >= 0) {
      existing.splice(index, 1);
    }
  }

  querySelectorAll(tagName: string) {
    return this.body.querySelectorAll(tagName);
  }
}

function findButton(label: string): FakeElement | undefined {
  return (document as unknown as FakeDocument)
    .querySelectorAll("button")
    .find((button) => button.textContent.includes(label));
}

beforeEach(() => {
  vi.stubGlobal("document", new FakeDocument());
  vi.stubGlobal("HTMLElement", FakeElement);
  vi.stubGlobal("window", {
    innerWidth: 1280,
    innerHeight: 800,
  });
  vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => {
    callback(0);
    return 0;
  });
  vi.stubGlobal(
    "MouseEvent",
    class extends FakeDomEvent {
      constructor(type: string, init: Record<string, unknown> = {}) {
        super(type, init);
      }
    },
  );
  vi.stubGlobal(
    "KeyboardEvent",
    class extends FakeDomEvent {
      constructor(type: string, init: Record<string, unknown> = {}) {
        super(type, init);
      }
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("showContextMenuFallback", () => {
  it("renders one separator between menu sections", async () => {
    const selectionPromise = showContextMenuFallback([
      { id: "rename", label: "Rename" },
      { id: "archive", label: "Archive", separatorBefore: true },
    ]);
    const separators = (document as unknown as FakeDocument)
      .querySelectorAll("div")
      .filter((element) => element.dataset.contextMenuSeparator === "true");

    expect(separators).toHaveLength(1);
    expect(separators[0]?.attributes.get("role")).toBe("separator");
    dismissContextMenu();
    await expect(selectionPromise).resolves.toBeNull();
  });

  it("uses menu roles and roving keyboard focus", async () => {
    const selectionPromise = showContextMenuFallback([
      { id: "rename", label: "Rename" },
      { id: "archive", label: "Archive" },
      { id: "delete", label: "Delete" },
    ]);
    const fakeDocument = document as unknown as FakeDocument;
    const menu = fakeDocument
      .querySelectorAll("div")
      .find((element) => element.attributes.get("role") === "menu");
    const renameButton = findButton("Rename");
    const archiveButton = findButton("Archive");
    const deleteButton = findButton("Delete");

    expect(menu?.attributes.get("aria-orientation")).toBe("vertical");
    expect(renameButton?.attributes.get("role")).toBe("menuitem");
    expect(renameButton?.focused).toBe(true);

    fakeDocument.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    expect(archiveButton?.focused).toBe(true);
    fakeDocument.dispatchEvent(new KeyboardEvent("keydown", { key: "End" }));
    expect(deleteButton?.focused).toBe(true);
    fakeDocument.dispatchEvent(new KeyboardEvent("keydown", { key: "Home" }));
    expect(renameButton?.focused).toBe(true);
    fakeDocument.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }));
    expect(deleteButton?.focused).toBe(true);

    deleteButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await expect(selectionPromise).resolves.toBe("delete");
  });

  it("dismisses on Tab and restores the invoking element", async () => {
    const fakeDocument = document as unknown as FakeDocument;
    const invoker = fakeDocument.createElement("button");
    fakeDocument.body.appendChild(invoker);
    invoker.focus();
    const selectionPromise = showContextMenuFallback([{ id: "rename", label: "Rename" }]);

    expect(findButton("Rename")?.focused).toBe(true);
    const tabEvent = new KeyboardEvent("keydown", { key: "Tab" });
    fakeDocument.dispatchEvent(tabEvent);

    expect(tabEvent.defaultPrevented).toBe(false);
    expect(findButton("Rename")).toBeUndefined();
    expect(invoker.focused).toBe(true);
    await expect(selectionPromise).resolves.toBeNull();
  });

  it("resolves a clicked flat menu item", async () => {
    const selectionPromise = showContextMenuFallback([
      { id: "rename", label: "Rename" },
      { id: "delete", label: "Delete", destructive: true },
    ]);

    const renameButton = findButton("Rename");
    expect(renameButton).toBeTruthy();
    renameButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await expect(selectionPromise).resolves.toBe("rename");
  });

  it("ignores a click from the gesture that opened the menu", async () => {
    let enablePointerSelection: ((time: number) => void) | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => {
      enablePointerSelection = callback;
      return 0;
    });

    const selectionPromise = showContextMenuFallback([{ id: "rename", label: "Rename" }]);
    const renameButton = findButton("Rename");

    renameButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    enablePointerSelection?.(0);
    renameButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await expect(selectionPromise).resolves.toBe("rename");
  });

  it("opens nested submenus and resolves the clicked leaf id", async () => {
    const selectionPromise = showContextMenuFallback([
      {
        id: "rename:submenu",
        label: "Rename project",
        children: [
          { id: "rename:project-a", label: "/tmp/project-a" },
          { id: "rename:project-b", label: "/tmp/project-b" },
        ],
      },
    ]);

    const parentButton = findButton("Rename project");
    expect(parentButton).toBeTruthy();
    parentButton?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));

    const childButton = findButton("/tmp/project-b");
    expect(childButton).toBeTruthy();
    childButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await expect(selectionPromise).resolves.toBe("rename:project-b");
  });

  it("navigates into and out of submenus with the keyboard", async () => {
    const fakeDocument = document as unknown as FakeDocument;
    const selectionPromise = showContextMenuFallback([
      {
        id: "copy:submenu",
        label: "Copy",
        children: [{ id: "copy:path", label: "Path" }],
      },
    ]);

    const parentButton = findButton("Copy");
    expect(parentButton?.focused).toBe(true);
    fakeDocument.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    expect(findButton("Path")?.focused).toBe(true);
    expect(parentButton?.attributes.get("aria-expanded")).toBe("true");

    fakeDocument.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(findButton("Path")).toBeUndefined();
    expect(parentButton?.focused).toBe(true);
    expect(parentButton?.attributes.get("aria-expanded")).toBe("false");

    fakeDocument.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    expect(findButton("Path")?.focused).toBe(true);
    fakeDocument.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
    expect(findButton("Path")).toBeUndefined();
    expect(parentButton?.focused).toBe(true);

    dismissContextMenu();
    await expect(selectionPromise).resolves.toBeNull();
  });

  it("opens and focuses nested submenus when the parent is activated", async () => {
    const invoker = (document as unknown as FakeDocument).createElement("button");
    (document as unknown as FakeDocument).body.appendChild(invoker);
    invoker.focus();
    const selectionPromise = showContextMenuFallback([
      {
        id: "copy:submenu",
        label: "Copy",
        children: [
          { id: "copy:path", label: "Path" },
          { id: "copy:branch", label: "Branch" },
        ],
      },
    ]);

    const parentButton = findButton("Copy");
    expect(parentButton).toBeTruthy();
    expect(parentButton?.attributes.get("aria-haspopup")).toBe("menu");
    expect(parentButton?.attributes.get("aria-expanded")).toBe("false");
    parentButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(parentButton?.attributes.get("aria-expanded")).toBe("true");

    const childButton = findButton("Path");
    const siblingButton = findButton("Branch");
    expect(childButton).toBeTruthy();
    expect(siblingButton).toBeTruthy();
    expect(childButton?.focused).toBe(true);
    expect(childButton?.style.background).toBe("var(--accent)");
    expect(childButton?.style.color).toBe("var(--contrast-accent-foreground)");
    siblingButton?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    expect(childButton?.focused).toBe(false);
    expect(childButton?.style.background).toBe("transparent");
    expect(siblingButton?.focused).toBe(true);
    expect(siblingButton?.style.background).toBe("var(--accent)");
    siblingButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await expect(selectionPromise).resolves.toBe("copy:branch");
    expect(invoker.focused).toBe(true);
  });
});

describe("dismissContextMenu", () => {
  it("resolves an open menu with null", async () => {
    const selectionPromise = showContextMenuFallback([
      { id: "rename", label: "Rename" },
      { id: "delete", label: "Delete" },
    ]);
    expect(findButton("Rename")).toBeTruthy();

    dismissContextMenu();

    await expect(selectionPromise).resolves.toBeNull();
    expect(findButton("Rename")).toBeUndefined();
  });

  it("is a no-op when no menu is open", async () => {
    dismissContextMenu();
    expect(findButton("Rename")).toBeUndefined();
  });

  it("dismisses the prior menu when a new one opens", async () => {
    const firstPromise = showContextMenuFallback([{ id: "first", label: "First" }]);
    expect(findButton("First")).toBeTruthy();

    const secondPromise = showContextMenuFallback([{ id: "second", label: "Second" }]);

    await expect(firstPromise).resolves.toBeNull();
    expect(findButton("First")).toBeUndefined();
    expect(findButton("Second")).toBeTruthy();

    dismissContextMenu();
    await expect(secondPromise).resolves.toBeNull();
  });
});
