import type { ComponentProps } from "react";
import { View, Pressable } from "react-native";

import { SymbolView } from "../../../components/AppSymbol";
import { AppText as Text } from "../../../components/AppText";
import { ThemedSwitch } from "../../../components/ThemedSwitch";

type SymbolName = ComponentProps<typeof SymbolView>["name"];

export function SettingsSwitchRow(props: {
  readonly disabled?: boolean;
  readonly icon: SymbolName;
  readonly label: string;
  readonly subtitle?: string;
  readonly value: boolean | null;
  readonly onValueChange: (value: boolean) => void;
}) {
  return (
    <View
      className={
        props.disabled
          ? "flex-row items-center gap-4 p-4 opacity-[0.45]"
          : "flex-row items-center gap-4 p-4"
      }
    >
      <SymbolView
        name={props.icon}
        size={22}
        tintColorClassName={"accent-icon"}
        type="monochrome"
        weight="regular"
      />
      <View className="min-w-0 flex-1">
        <Text className="text-lg text-foreground">{props.label}</Text>
        {props.subtitle ? (
          <Text className="text-sm text-foreground-muted">{props.subtitle}</Text>
        ) : null}
      </View>
      {props.value === null ? (
        <Pressable
          accessibilityLabel={`Set ${props.label} on for selected environments`}
          accessibilityRole="button"
          disabled={props.disabled}
          className="rounded-full bg-subtle px-3 py-2 active:opacity-70"
          onPress={() => props.onValueChange(true)}
        >
          <Text className="text-sm font-t3-medium text-foreground">Mixed · Set on</Text>
        </Pressable>
      ) : (
        <ThemedSwitch
          accessibilityLabel={props.label}
          disabled={props.disabled}
          onValueChange={props.onValueChange}
          value={props.value}
        />
      )}
    </View>
  );
}
