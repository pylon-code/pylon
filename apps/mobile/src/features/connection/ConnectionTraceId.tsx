import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";

export function connectionTraceAccessibilityAction(traceId: string | null) {
  return traceId
    ? {
        accessibilityActions: [{ name: "copy-trace-id", label: "Copy trace ID" }],
        onAccessibilityAction: (event: {
          readonly nativeEvent: { readonly actionName: string };
          stopPropagation(): void;
        }) => {
          if (event.nativeEvent.actionName !== "copy-trace-id") return;
          event.stopPropagation();
          copyTextWithHaptic(traceId, { target: "connection-trace-id" });
        },
      }
    : {};
}

/** Inline trace control; disclosure rows reserve ordinary taps for their own navigation. */
export function ConnectionTraceId({
  traceId,
  tone = "muted",
  activation = "press",
  parentOwnsAccessibility = false,
}: {
  readonly traceId: string;
  readonly tone?: "muted" | "danger";
  readonly activation?: "press" | "longPress";
  readonly parentOwnsAccessibility?: boolean;
}) {
  const copy = () => copyTextWithHaptic(traceId, { target: "connection-trace-id" });
  return (
    <Text
      accessibilityHint={
        parentOwnsAccessibility
          ? undefined
          : activation === "longPress"
            ? "Long press to copy the trace ID"
            : "Copies the trace ID"
      }
      accessibilityLabel={parentOwnsAccessibility ? undefined : `Copy trace ID ${traceId}`}
      accessibilityRole={parentOwnsAccessibility ? undefined : "button"}
      accessibilityActions={
        parentOwnsAccessibility ? undefined : [{ name: "activate", label: "Copy trace ID" }]
      }
      onAccessibilityAction={
        parentOwnsAccessibility
          ? undefined
          : (event) => {
              event.stopPropagation();
              if (event.nativeEvent.actionName === "activate") copy();
            }
      }
      className={cn(
        "underline decoration-dotted",
        tone === "danger" ? "text-danger-foreground" : "text-foreground-muted",
      )}
      onLongPress={
        activation === "longPress"
          ? (event) => {
              event.stopPropagation();
              copy();
            }
          : undefined
      }
      onPress={(event) => {
        event.stopPropagation();
        if (activation === "press") copy();
      }}
    >
      {` Trace ID: ${traceId}`}
    </Text>
  );
}
