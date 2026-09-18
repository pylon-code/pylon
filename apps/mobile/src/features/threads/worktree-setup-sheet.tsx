import { useState, type ReactElement } from "react";
import { Modal, Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { ContextSheetSize } from "../../components/ContextSheetSize";

export interface WorktreeSetupSheetProps {
  children: ReactElement;
  height: number;
  onClose: () => void;
}

export function WorktreeSetupSheet({ children, height, onClose }: WorktreeSetupSheetProps) {
  const [headerHeight, setHeaderHeight] = useState(64);
  return (
    <Modal
      animationType="slide"
      presentationStyle="pageSheet"
      allowSwipeDismissal
      onRequestClose={onClose}
    >
      <View collapsable={false} className="flex-1 bg-sheet-solid">
        <ContextSheetSize height={height + headerHeight} />
        <View
          onLayout={(event) => setHeaderHeight(event.nativeEvent.layout.height)}
          className="flex-row items-center justify-between px-5 pt-3 pb-1"
        >
          <Text accessibilityRole="header" className="font-t3-medium text-lg text-foreground">
            Worktree setup
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close setup details"
            onPress={onClose}
            className="min-h-11 justify-center px-2"
          >
            <Text className="font-t3-medium text-sm text-foreground">Done</Text>
          </Pressable>
        </View>
        {children}
      </View>
    </Modal>
  );
}
