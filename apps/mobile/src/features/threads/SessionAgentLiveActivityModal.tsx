import { useAtomValue } from "@effect/atom-react";
import {
  presentSessionAgentLiveActivity,
  sessionAgentLiveActivityTextRows,
  sessionAgentLiveActivityUnavailableLabel,
} from "@t3tools/client-runtime/state/session-agent-live-activity";
import {
  RuntimeTaskId,
  type EnvironmentId,
  type ProviderSessionAgentActivitySnapshot,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { ActivityIndicator, Modal, Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { orchestrationEnvironment } from "../../state/orchestration";

export function SessionAgentLiveActivityModal({
  environmentId,
  threadId,
  agentId,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly agentId: string;
  readonly onClose: () => void;
}) {
  const result = useAtomValue(
    orchestrationEnvironment.sessionAgentLiveActivity({
      environmentId,
      input: { threadId, agentId: RuntimeTaskId.make(agentId) },
    }),
  );

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View className="flex-1 justify-end">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close live activity"
          className="absolute inset-0 bg-black/50"
          onPress={onClose}
        />
        <View className="max-h-[80%] rounded-t-[28px] border-t border-border bg-sheet px-5 pb-8 pt-5">
          <View className="mb-4 flex-row items-start justify-between gap-4">
            <View className="min-w-0 flex-1">
              <Text className="text-lg font-t3-bold text-foreground">Live activity</Text>
              <Text className="mt-1 text-sm text-foreground-muted">
                Live only. Assistant updates are a bounded replacement snapshot and are unavailable
                after the agent exits.
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close live activity"
              onPress={onClose}
              className="h-11 items-center justify-center px-2"
            >
              <Text className="font-t3-bold text-foreground-muted">Close</Text>
            </Pressable>
          </View>
          {result._tag === "Failure" ? (
            <Text accessibilityRole="alert" className="py-6 text-sm text-foreground-muted">
              {sessionAgentLiveActivityUnavailableLabel(Cause.squash(result.cause))}
            </Text>
          ) : result._tag !== "Success" ? (
            <View className="flex-row items-center gap-2 py-6">
              <ActivityIndicator />
              <Text className="text-sm text-foreground-muted">Loading live activity…</Text>
            </View>
          ) : (
            <SessionAgentLiveActivitySnapshot snapshot={result.value} />
          )}
        </View>
      </View>
    </Modal>
  );
}

export function SessionAgentLiveActivitySnapshot({
  snapshot,
}: {
  readonly snapshot: ProviderSessionAgentActivitySnapshot;
}) {
  const presentation = presentSessionAgentLiveActivity(snapshot);
  if (presentation.entries.length === 0) {
    return (
      <Text accessibilityRole="text" className="py-6 text-sm text-foreground-muted">
        No assistant activity yet.
      </Text>
    );
  }
  return (
    <ScrollView accessibilityLiveRegion="polite" className="shrink">
      <View className="gap-3 py-2">
        {sessionAgentLiveActivityTextRows(presentation.entries).map((entry) => (
          <Text key={entry.key} className="text-sm leading-6 text-foreground">
            {entry.text}
          </Text>
        ))}
      </View>
      <Text className="mt-2 border-t border-border pt-2 text-xs text-foreground-muted">
        Latest bounded snapshot · Live only
      </Text>
    </ScrollView>
  );
}
