import type { ComposerEditorSelection } from "./T3ComposerEditor.types";

/** The installed native editor may predate versioned paste-context events. */
export function hasVersionedComposerPasteContext<
  T extends {
    readonly text?: unknown;
    readonly fragment?: unknown;
    readonly html?: unknown;
    readonly eventCount?: unknown;
    readonly value?: unknown;
    readonly selection?: unknown;
  },
>(
  event: T,
): event is T & {
  readonly eventCount: number;
  readonly value: string;
  readonly selection: ComposerEditorSelection;
} {
  if (
    typeof event.eventCount !== "number" ||
    !Number.isFinite(event.eventCount) ||
    typeof event.value !== "string" ||
    typeof event.selection !== "object" ||
    event.selection === null
  )
    return false;
  const selection = event.selection;
  return (
    "start" in selection &&
    typeof selection.start === "number" &&
    Number.isFinite(selection.start) &&
    "end" in selection &&
    typeof selection.end === "number" &&
    Number.isFinite(selection.end)
  );
}
