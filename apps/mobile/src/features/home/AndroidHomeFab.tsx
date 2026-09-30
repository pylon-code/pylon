import type { ReactNode } from "react";
import { Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { useAndroidControlSizing } from "../../components/useAndroidControlSizing";

/**
 * Android-only wrapper that overlays a bottom-right new-task FAB on a thread
 * list. Other platforms render children unchanged.
 */
export function AndroidHomeFabLayout(props: {
  readonly onStartNewTask: () => void;
  readonly children: ReactNode;
}) {
  if (Platform.OS !== "android") {
    return <>{props.children}</>;
  }

  return <AndroidHomeFab {...props} />;
}

function AndroidHomeFab(props: {
  readonly onStartNewTask: () => void;
  readonly children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const { scale, fabSize } = useAndroidControlSizing();
  return (
    <View className="flex-1">
      {props.children}
      <Pressable
        accessibilityLabel="New task"
        accessibilityRole="button"
        onPress={props.onStartNewTask}
        className="absolute right-5 items-center justify-center rounded-full bg-primary shadow-lg"
        style={{
          bottom: Math.max(insets.bottom, 16) + 16,
          width: fabSize,
          height: fabSize,
        }}
      >
        <SymbolView
          name="square.and.pencil"
          size={Math.round(22 * scale)}
          tintColorClassName={"accent-primary-foreground"}
          type="monochrome"
        />
      </Pressable>
    </View>
  );
}
