import { pairStatusLine, type PairState } from "@t3tools/client-runtime/state/pair";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";

/**
 * The lead's view of its pair on a phone: who it is paired with, what that
 * executor is doing, and one tap to open it. Renders nothing while the pair is
 * off, so the thread screen looks exactly as it did.
 */
export function PairStatusNotice(props: {
  readonly state: PairState;
  /** The executor model's display name. */
  readonly executorLabel: string;
  readonly onOpenExecutor: () => void;
}) {
  if (props.state.kind !== "on") {
    return null;
  }

  const line = pairStatusLine(props.state, props.executorLabel);
  if (line === null) {
    return null;
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${line}. Open executor`}
      onPress={props.onOpenExecutor}
      className="mb-2 gap-1 rounded-2xl border border-border bg-card px-3.5 py-3"
    >
      <View className="gap-1">
        <Text className="text-sm font-t3-bold text-foreground">{line}</Text>
        {props.state.activity !== null ? (
          <Text className="text-sm leading-snug text-foreground-muted">
            {props.state.activity}
          </Text>
        ) : null}
        <Text className="text-sm font-t3-bold text-primary">Open executor</Text>
      </View>
    </Pressable>
  );
}
