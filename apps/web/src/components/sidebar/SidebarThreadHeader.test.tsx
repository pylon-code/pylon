import { cloneElement, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { SidebarThreadHeader, type SidebarThreadHeaderProps } from "./SidebarThreadHeader";

// Sidebar chrome and popup primitives are owned by the parent; exercise the real header input and callbacks.
vi.mock("../ui/sidebar", () => ({
  SidebarMenuButton: ({ size: _size, ...props }: ComponentProps<"button"> & { size?: string }) => (
    <button {...props} />
  ),
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({
    render,
    children,
  }: {
    render: ReactElement<{ children?: ReactNode }>;
    children: ReactNode;
  }) => cloneElement(render, {}, children),
  TooltipPopup: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

function props(): SidebarThreadHeaderProps {
  return {
    hasProjects: true,
    projectScope: <button aria-label="Project scope">Project</button>,
    onNewProject: vi.fn(),
    onNewThread: vi.fn(),
    newThreadDisabled: false,
    newThreadShortcutLabel: "⌘N",
    newThreadInProjectShortcutLabel: "⇧⌘N",
    showNewThreadInProjectHint: true,
    searchInputRef: { current: null },
    searchQuery: "fix",
    onSearchQueryChange: vi.fn(),
    onSearchKeyDown: vi.fn(),
    isSearching: true,
    searchResultCount: 3,
    activeSearchResultIndex: 1,
    onClearSearch: vi.fn(),
  };
}

async function render(input: SidebarThreadHeaderProps) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const focus = vi.fn();
  await act(() => {
    renderer = create(<SidebarThreadHeader {...input} />, {
      createNodeMock: (element) => (element.type === "input" ? { focus } : null),
    });
  });
  return { root: renderer!.root, focus };
}

describe("sidebar search header", () => {
  it("preserves search navigation, clear focus, and Shift-click new-thread intent", async () => {
    const input = props();
    const { root, focus } = await render(input);
    const search = root.findByType("input");
    expect(search.props["aria-controls"]).toBe("sidebar-thread-search-results");
    expect(search.props["aria-activedescendant"]).toBe("sidebar-thread-search-result-1");
    const keyEvent = { key: "ArrowDown" };
    search.props.onKeyDown(keyEvent);
    expect(input.onSearchKeyDown).toHaveBeenCalledWith(keyEvent);
    search.props.onChange({ currentTarget: { value: "fix tests" } });
    expect(input.onSearchQueryChange).toHaveBeenCalledWith("fix tests");
    root
      .findAllByType("button")
      .find((button) => button.props["aria-label"] === "Clear thread search")!
      .props.onClick();
    expect(input.onClearSearch).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
    const clickEvent = { shiftKey: true };
    root
      .findAllByType("button")
      .find((button) => button.props["aria-label"] === "New thread")!
      .props.onClick(clickEvent);
    expect(input.onNewThread).toHaveBeenCalledWith(clickEvent);
    root
      .findAllByType("button")
      .find((button) => button.props["aria-label"] === "New project")!
      .props.onClick();
    expect(input.onNewProject).toHaveBeenCalledOnce();
  });

  it("drops stale result references and retains the empty-catalog control guards", async () => {
    const input = props();
    const { root } = await render({
      ...input,
      hasProjects: false,
      newThreadDisabled: true,
      searchResultCount: 1,
    });
    expect(root.findByType("input").props["aria-activedescendant"]).toBeUndefined();
    const buttons = root.findAllByType("button");
    expect(buttons.some((button) => button.props["aria-label"] === "Project scope")).toBe(false);
    expect(buttons.some((button) => button.props["aria-label"] === "New project")).toBe(false);
    expect(
      buttons.find((button) => button.props["aria-label"] === "New thread")!.props.disabled,
    ).toBe(true);
    await act(() =>
      renderer!.update(<SidebarThreadHeader {...input} activeSearchResultIndex={-1} />),
    );
    expect(root.findByType("input").props["aria-activedescendant"]).toBeUndefined();
    await act(() => renderer!.update(<SidebarThreadHeader {...input} isSearching={false} />));
    expect(root.findByType("input").props["aria-expanded"]).toBe(false);
    expect(root.findByType("input").props["aria-controls"]).toBeUndefined();
    expect(root.findByType("input").props["aria-activedescendant"]).toBeUndefined();
    expect(
      root
        .findAllByType("button")
        .some((button) => button.props["aria-label"] === "Clear thread search"),
    ).toBe(false);
  });
});
