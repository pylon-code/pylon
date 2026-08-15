import type {
  SessionResourceInventory,
  SessionResourcesSnapshot,
} from "@t3tools/client-runtime/state/session-resources";
import { useMemo } from "react";
import { ActivityIndicator, Modal, Pressable, SectionList, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { buildSessionResourceSections } from "./SessionResourcesModal.logic";

export function SessionResourcesModal({
  inventory,
  snapshot,
  showReload,
  reloadDisabled,
  isReloading,
  onReload,
  onClose,
}: {
  readonly inventory: SessionResourceInventory;
  readonly snapshot: SessionResourcesSnapshot;
  readonly showReload: boolean;
  readonly reloadDisabled: boolean;
  readonly isReloading: boolean;
  readonly onReload: () => Promise<void>;
  readonly onClose: () => void;
}) {
  const sections = useMemo(() => buildSessionResourceSections(inventory), [inventory]);

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View className="flex-1 justify-end">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close session resources"
          className="absolute inset-0 bg-black/50"
          onPress={onClose}
        />
        <View className="max-h-[85%] rounded-t-[28px] border-t border-border bg-sheet px-5 pb-8 pt-5">
          <View className="mb-4 flex-row items-start justify-between gap-4">
            <View className="min-w-0 flex-1">
              <Text className="text-lg font-t3-bold text-foreground">Session resources</Text>
              <Text className="mt-1 text-sm text-foreground-muted">
                Saved skill and prompt metadata. Resource contents and paths are not shown.
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close session resources"
              onPress={onClose}
              className="h-11 items-center justify-center px-2"
            >
              <Text className="font-t3-bold text-foreground-muted">Close</Text>
            </Pressable>
          </View>
          <SectionList
            className="shrink"
            sections={sections}
            keyExtractor={(item) => item.key}
            stickySectionHeadersEnabled={false}
            initialNumToRender={16}
            maxToRenderPerBatch={16}
            windowSize={7}
            renderSectionHeader={({ section }) => (
              <Text className="mb-2 mt-3 text-sm font-t3-bold text-foreground">
                {section.title}
              </Text>
            )}
            renderSectionFooter={({ section }) =>
              section.data.length === 0 ? (
                <Text className="mb-2 text-sm text-foreground-muted">{section.emptyLabel}</Text>
              ) : null
            }
            renderItem={({ item }) => (
              <View className="mb-2 rounded-xl border border-border bg-secondary px-3 py-2">
                <View className="flex-row flex-wrap items-center gap-2">
                  <Text className="shrink font-t3-bold text-sm text-foreground">{item.name}</Text>
                  {item.argumentHint === undefined ? null : (
                    <Text className="shrink font-mono text-xs text-foreground-muted">
                      {item.argumentHint}
                    </Text>
                  )}
                  {item.scope === undefined ? null : (
                    <Text className="rounded-full bg-background px-2 py-0.5 text-xs text-foreground-muted">
                      {item.scope}
                    </Text>
                  )}
                </View>
                {item.description === undefined ? null : (
                  <Text className="mt-1 text-xs leading-5 text-foreground-muted">
                    {item.description}
                  </Text>
                )}
              </View>
            )}
            ListFooterComponent={
              <View className="gap-3 border-t border-border pb-2 pt-3">
                <Text className="text-xs text-foreground-muted">
                  Saved {new Date(snapshot.updatedAt).toLocaleString()}
                </Text>
                {showReload ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Reload session resources"
                    disabled={reloadDisabled || isReloading}
                    onPress={() => void onReload()}
                    className={`min-h-11 flex-row items-center justify-center gap-2 rounded-xl px-4 ${reloadDisabled || isReloading ? "bg-secondary" : "bg-primary"}`}
                  >
                    {isReloading ? <ActivityIndicator size="small" /> : null}
                    <Text
                      className={`font-t3-bold ${reloadDisabled || isReloading ? "text-foreground-muted" : "text-primary-foreground"}`}
                    >
                      {isReloading ? "Reloading…" : "Reload resources"}
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            }
          />
        </View>
      </View>
    </Modal>
  );
}
