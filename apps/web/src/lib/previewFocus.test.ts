import { afterEach, describe, expect, it } from "vite-plus/test";

import { isPreviewFocused } from "./previewFocus";

class MockHTMLElement {
  isConnected = false;
  tagName = "DIV";
  closestSelector: string | null = null;

  closest(selector: string): MockHTMLElement | null {
    if (!this.isConnected) return null;
    if (this.closestSelector && selector.includes(this.closestSelector)) {
      return this;
    }
    return null;
  }
}

const originalDocument = globalThis.document;
const originalHTMLElement = globalThis.HTMLElement;

afterEach(() => {
  if (originalDocument === undefined) {
    delete (globalThis as { document?: Document }).document;
  } else {
    globalThis.document = originalDocument;
  }

  if (originalHTMLElement === undefined) {
    delete (globalThis as { HTMLElement?: typeof HTMLElement }).HTMLElement;
  } else {
    globalThis.HTMLElement = originalHTMLElement;
  }
});

describe("isPreviewFocused", () => {
  it("returns false when document is undefined or activeElement is null", () => {
    globalThis.document = undefined as unknown as Document;
    expect(isPreviewFocused()).toBe(false);

    globalThis.document = { activeElement: null } as unknown as Document;
    expect(isPreviewFocused()).toBe(false);
  });

  it("returns false for detached elements", () => {
    const detached = new MockHTMLElement();
    detached.isConnected = false;
    detached.tagName = "WEBVIEW";

    globalThis.HTMLElement = MockHTMLElement as unknown as typeof HTMLElement;
    globalThis.document = { activeElement: detached } as unknown as Document;

    expect(isPreviewFocused()).toBe(false);
  });

  it("returns true for attached webview", () => {
    const webview = new MockHTMLElement();
    webview.isConnected = true;
    webview.tagName = "WEBVIEW";

    globalThis.HTMLElement = MockHTMLElement as unknown as typeof HTMLElement;
    globalThis.document = { activeElement: webview } as unknown as Document;

    expect(isPreviewFocused()).toBe(true);
  });

  it("returns true for focus inside preview panel", () => {
    const input = new MockHTMLElement();
    input.isConnected = true;
    input.tagName = "INPUT";
    input.closestSelector = "data-preview-panel-mode";

    globalThis.HTMLElement = MockHTMLElement as unknown as typeof HTMLElement;
    globalThis.document = { activeElement: input } as unknown as Document;

    expect(isPreviewFocused()).toBe(true);
  });

  it("returns true for focus inside preview viewport", () => {
    const toolbarButton = new MockHTMLElement();
    toolbarButton.isConnected = true;
    toolbarButton.tagName = "BUTTON";
    toolbarButton.closestSelector = "data-preview-viewport";

    globalThis.HTMLElement = MockHTMLElement as unknown as typeof HTMLElement;
    globalThis.document = { activeElement: toolbarButton } as unknown as Document;

    expect(isPreviewFocused()).toBe(true);
  });

  it("returns true for focus inside preview mini player", () => {
    const playerControl = new MockHTMLElement();
    playerControl.isConnected = true;
    playerControl.tagName = "BUTTON";
    playerControl.closestSelector = "data-preview-mini-player";

    globalThis.HTMLElement = MockHTMLElement as unknown as typeof HTMLElement;
    globalThis.document = { activeElement: playerControl } as unknown as Document;

    expect(isPreviewFocused()).toBe(true);
  });

  it("returns false for elements outside preview", () => {
    const composer = new MockHTMLElement();
    composer.isConnected = true;
    composer.tagName = "TEXTAREA";

    globalThis.HTMLElement = MockHTMLElement as unknown as typeof HTMLElement;
    globalThis.document = { activeElement: composer } as unknown as Document;

    expect(isPreviewFocused()).toBe(false);
  });
});
