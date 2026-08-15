import { useAtomValue } from "@effect/atom-react";
import {
  presentSessionAgentLiveActivity,
  presentSessionAgentLiveActivityAgentSummary,
  sessionAgentLiveActivityRows,
  sessionAgentLiveActivityUnavailableLabel,
} from "@t3tools/client-runtime/state/session-agent-live-activity";
import {
  RuntimeTaskId,
  type EnvironmentId,
  type ProviderSessionAgentActivitySnapshot,
  type ThreadId,
} from "@t3tools/contracts";
import type { RuntimeSubagent } from "@t3tools/client-runtime/state/subagentRuntime";
import * as Cause from "effect/Cause";
import { ActivityIndicator, Modal, Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { orchestrationEnvironment } from "../../state/orchestration";

export function SessionAgentLiveActivityModal({
  environmentId,
  threadId,
  agentId,
  agent,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly agentId: string;
  readonly agent: Pick<RuntimeSubagent, "lastToolName" | "usage">;
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
            <SessionAgentLiveActivitySnapshot snapshot={result.value} agent={agent} />
          )}
        </View>
      </View>
    </Modal>
  );
}

export function SessionAgentLiveActivitySnapshot({
  snapshot,
  agent,
}: {
  readonly snapshot: ProviderSessionAgentActivitySnapshot;
  readonly agent: Pick<RuntimeSubagent, "lastToolName" | "usage">;
}) {
  const presentation = presentSessionAgentLiveActivity(snapshot);
  const summary = presentSessionAgentLiveActivityAgentSummary(agent);
  return (
    <View className="shrink">
      <View
        accessibilityLiveRegion="polite"
        className="mb-3 rounded-xl border border-border bg-secondary px-3 py-2"
      >
        <Text className="text-sm font-t3-bold text-foreground">{summary.statusLabel}</Text>
        {summary.activityLabel === null ? null : (
          <Text className="mt-0.5 text-xs text-foreground-muted">{summary.activityLabel}</Text>
        )}
        {summary.usageLabel === null ? null : (
          <Text className="mt-0.5 font-mono text-xs text-foreground-muted">
            {summary.usageLabel}
          </Text>
        )}
      </View>
      {presentation.entries.length === 0 ? (
        <View className="py-4">
          <Text accessibilityRole="text" className="text-sm text-foreground-muted">
            No activity yet.
          </Text>
          <Text className="mt-1 text-xs text-foreground-muted">
            Tool arguments, results, and reasoning are not shown.
          </Text>
        </View>
      ) : (
        <ScrollView accessibilityLiveRegion="polite" className="shrink">
          <View className="gap-3 py-2">
            {sessionAgentLiveActivityRows(presentation.entries).map((entry) =>
              entry.kind === "assistant" ? (
                <Text key={entry.key} className="text-sm leading-6 text-foreground">
                  {entry.text}
                </Text>
              ) : (
                <View
                  key={entry.key}
                  accessible
                  accessibilityRole="text"
                  accessibilityLabel={`${entry.label}: ${entry.statusLabel}`}
                  className="flex-row items-center gap-2 rounded-xl border border-border bg-secondary px-3 py-2"
                >
                  <Text
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                    className={
                      entry.status === "failed"
                        ? "text-danger-foreground"
                        : entry.status === "completed"
                          ? "text-emerald-600"
                          : "text-foreground-muted"
                    }
                  >
                    {entry.status === "completed" ? "✓" : entry.status === "failed" ? "!" : "•"}
                  </Text>
                  <Text className="min-w-0 flex-1 text-sm font-t3-bold text-foreground">
                    {entry.label}
                  </Text>
                  <Text className="text-xs text-foreground-muted">{entry.statusLabel}</Text>
                </View>
              ),
            )}
          </View>
          <Text className="mt-2 border-t border-border pt-2 text-xs text-foreground-muted">
            Latest bounded snapshot · Live only
          </Text>
        </ScrollView>
      )}
    </View>
  );
}
