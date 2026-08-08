import { memo } from "react";
import { ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import {
  compactSessionPresentationText,
  type CurrentSessionNotification,
  type CurrentSessionStatus,
  type CurrentSessionWidget,
} from "../../lib/sessionInteractions";

const MAX_VISIBLE_PRESENTATIONS = 12;
const MAX_VISIBLE_WIDGET_LINES = 8;

function widgetLineKey(lines: ReadonlyArray<string>, index: number): string {
  const value = lines[index] ?? "";
  let priorOccurrences = 0;
  for (let candidate = 0; candidate < index; candidate += 1) {
    if (lines[candidate] === value) {
      priorOccurrences += 1;
    }
  }
  return JSON.stringify([value, priorOccurrences]);
}

export interface SessionPresentationSurfaceProps {
  readonly notification?: CurrentSessionNotification | null;
  readonly statuses?: ReadonlyArray<CurrentSessionStatus>;
  readonly widgets?: ReadonlyArray<CurrentSessionWidget>;
}

export const SessionPresentationSurface = memo(function SessionPresentationSurface(
  props: SessionPresentationSurfaceProps,
) {
  const statuses = (props.statuses ?? []).slice(-MAX_VISIBLE_PRESENTATIONS);
  const widgets = (props.widgets ?? []).slice(-MAX_VISIBLE_PRESENTATIONS);
  const hiddenCount =
    Math.max(0, (props.statuses?.length ?? 0) - statuses.length) +
    Math.max(0, (props.widgets?.length ?? 0) - widgets.length);
  if (!props.notification && statuses.length === 0 && widgets.length === 0) {
    return null;
  }

  return (
    <View className="mb-2 max-h-48 overflow-hidden rounded-2xl border border-neutral-200 bg-neutral-100/95 px-3.5 py-3 dark:border-white/6 dark:bg-neutral-900/95">
      <ScrollView
        bounces={false}
        nestedScrollEnabled
        showsVerticalScrollIndicator={false}
        contentContainerClassName="gap-2"
      >
        {props.notification ? (
          <View
            accessibilityRole="alert"
            className={cn(
              "rounded-xl px-3 py-2",
              props.notification.level === "error"
                ? "bg-rose-100 dark:bg-rose-500/18"
                : props.notification.level === "warning"
                  ? "bg-amber-100 dark:bg-amber-500/18"
                  : "bg-sky-100 dark:bg-sky-500/18",
            )}
          >
            <Text
              className={cn(
                "font-sans text-sm leading-normal",
                props.notification.level === "error"
                  ? "text-rose-800 dark:text-rose-200"
                  : props.notification.level === "warning"
                    ? "text-amber-900 dark:text-amber-200"
                    : "text-sky-800 dark:text-sky-200",
              )}
              numberOfLines={4}
            >
              {compactSessionPresentationText(props.notification.message)}
            </Text>
          </View>
        ) : null}

        {statuses.map((status) => (
          <View key={status.key} className="flex-row items-start gap-2">
            <View className="mt-1.5 size-2 rounded-full bg-sky-500" />
            <View className="min-w-0 flex-1">
              <Text className="font-t3-bold text-2xs uppercase tracking-[0.8px] text-neutral-500 dark:text-neutral-400">
                {compactSessionPresentationText(status.key)}
              </Text>
              <Text
                className="font-sans text-sm text-neutral-800 dark:text-neutral-200"
                numberOfLines={3}
              >
                {compactSessionPresentationText(status.text)}
              </Text>
            </View>
          </View>
        ))}

        {widgets.map((widget) => {
          const lines = widget.lines.slice(0, MAX_VISIBLE_WIDGET_LINES);
          return (
            <View key={widget.key} className="rounded-xl bg-white px-3 py-2 dark:bg-neutral-950/70">
              <Text className="font-t3-bold text-2xs uppercase tracking-[0.8px] text-neutral-500 dark:text-neutral-400">
                {compactSessionPresentationText(widget.key)}
              </Text>
              {lines.map((line, index) => (
                <Text
                  key={widgetLineKey(lines, index)}
                  className="font-sans text-sm text-neutral-800 dark:text-neutral-200"
                  numberOfLines={2}
                >
                  {compactSessionPresentationText(line)}
                </Text>
              ))}
              {widget.lines.length > lines.length ? (
                <Text className="font-sans text-xs text-neutral-500">
                  +{widget.lines.length - lines.length} more lines
                </Text>
              ) : null}
            </View>
          );
        })}

        {hiddenCount > 0 ? (
          <Text className="font-sans text-xs text-neutral-500">+{hiddenCount} more updates</Text>
        ) : null}
      </ScrollView>
    </View>
  );
});
