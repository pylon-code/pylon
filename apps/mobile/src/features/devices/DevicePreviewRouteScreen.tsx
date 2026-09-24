import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { MenuAction } from "@react-native-menu/menu";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { ActivityIndicator, Alert, AppState, Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidHeaderIconButton, AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import {
  deviceEnvironment,
  refreshDeviceHubAccess,
  useDeviceHubAccess,
  useLiveDeviceState,
} from "../../state/device";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { DeviceStreamWebView, type DeviceStreamRef } from "./DeviceStreamWebView";
import {
  selectedThreadDevicePreview,
  threadDevicePreviews,
  type ThreadDevicePreview,
} from "./threadDevicePreviews";

type DevicePreviewRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

export function DevicePreviewRouteScreen({ route }: DevicePreviewRouteScreenProps) {
  const navigation = useNavigation();
  const onClose = useCallback(() => navigation.goBack(), [navigation]);
  return (
    <DevicePreviewScreen
      environmentId={EnvironmentId.make(route.params.environmentId)}
      threadId={ThreadId.make(route.params.threadId)}
      onClose={onClose}
    />
  );
}

function DevicePreviewScreen({
  environmentId,
  threadId,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { themeVariables } = useAppearancePreferences();
  const focused = useIsFocused();
  const [foreground, setForeground] = useState(AppState.currentState !== "background");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [inputConnected, setInputConnected] = useState(false);
  const [streamAttempt, setStreamAttempt] = useState(0);
  const [shuttingDown, setShuttingDown] = useState(false);
  const shutdown = useAtomCommand(deviceEnvironment.shutdown, { reportFailure: false });
  const streamRef = useRef<DeviceStreamRef>(null);
  const state = useLiveDeviceState(environmentId);
  const previews = useMemo(
    () => threadDevicePreviews(state.data, threadId),
    [state.data, threadId],
  );
  const preview = selectedThreadDevicePreview(previews, selectedKey);
  const onInputConnected = useCallback(
    async (connected: boolean) => setInputConnected(connected),
    [],
  );
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) =>
      setForeground(state !== "background"),
    );
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    if (focused && state.data !== null && previews.length === 0) onClose();
  }, [focused, state.data, previews.length, onClose]);

  const shutDownDevice = async () => {
    if (!preview || shuttingDown) return;
    setShuttingDown(true);
    try {
      const result = await shutdown({
        environmentId,
        input: {
          hostId: preview.session.hostId,
          deviceId: preview.session.deviceId,
          platform: preview.session.platform,
        },
      });
      if (result._tag === "Failure") {
        Alert.alert("Could not shut down device", String(Cause.squash(result.cause)));
      }
    } finally {
      setShuttingDown(false);
    }
  };

  const controls = [
    {
      id: "reload",
      title: "Reload stream",
      icon: "arrow.clockwise",
      disabled: !preview || shuttingDown,
      onPress: () => {
        setInputConnected(false);
        setStreamAttempt((attempt) => attempt + 1);
      },
    },
    ...(preview?.session.platform === "android"
      ? [
          {
            id: "back",
            title: "Back",
            icon: "arrow.left",
            disabled: !inputConnected,
            onPress: () => streamRef.current?.back(),
          },
        ]
      : []),
    {
      id: "app-switcher",
      title: "App switcher",
      icon: "square.on.square",
      disabled: !inputConnected,
      onPress: () => streamRef.current?.appSwitcher(),
    },
    ...(preview?.session.platform === "ios"
      ? [
          {
            id: "rotate",
            title: "Rotate device",
            icon: "arrow.clockwise",
            disabled: !inputConnected,
            onPress: () => streamRef.current?.rotate(),
          },
        ]
      : []),
    {
      id: "shutdown",
      title: shuttingDown ? "Shutting down…" : "Shut down device",
      icon: "power",
      disabled: !preview || shuttingDown,
      onPress: () => void shutDownDevice(),
    },
  ] as const;
  const androidActions: MenuAction[] = [
    ...(previews.length > 1
      ? [
          {
            id: "devices",
            title: "Devices",
            subactions: previews.map((device) => ({
              id: `device:${device.key}`,
              title: device.name,
              subtitle: device.description,
              state: device.key === preview?.key ? ("on" as const) : undefined,
            })),
          },
        ]
      : []),
    ...controls.map((control) => ({
      id: control.id,
      title: control.title,
      attributes: control.disabled ? { disabled: true } : undefined,
    })),
  ];
  return (
    <View className="flex-1 bg-sheet" style={{ paddingBottom: insets.bottom }}>
      <NativeStackScreenOptions
        options={{
          headerShown: Platform.OS === "ios",
          title: preview?.name ?? "Devices",
          headerBackVisible: false,
        }}
      />
      {Platform.OS === "android" ? (
        <AndroidScreenHeader
          title={preview?.name ?? "Devices"}
          onBack={onClose}
          trailing={
            <>
              <AndroidHeaderIconButton
                accessibilityLabel="Home"
                icon="house"
                disabled={!inputConnected}
                onPress={() => streamRef.current?.home()}
              />
              <ControlPillMenu
                title="Device options"
                actions={androidActions}
                onPressAction={(event) => {
                  const id = event.nativeEvent.event;
                  if (id.startsWith("device:")) setSelectedKey(id.slice("device:".length));
                  else controls.find((control) => control.id === id)?.onPress();
                }}
              >
                <AndroidHeaderIconButton accessibilityLabel="Device options" icon="ellipsis" />
              </ControlPillMenu>
            </>
          }
        />
      ) : null}
      <NativeHeaderToolbar placement="right">
        <NativeHeaderToolbar.Button
          accessibilityLabel="Home"
          icon="house"
          disabled={!inputConnected}
          onPress={() => streamRef.current?.home()}
          separateBackground
        />
        <NativeHeaderToolbar.Menu accessibilityLabel="Device options" icon="ellipsis">
          {previews.length > 1 ? (
            <NativeHeaderToolbar.Menu icon="square.on.square" title="Devices" inline>
              {previews.map((device) => (
                <NativeHeaderToolbar.MenuAction
                  key={device.key}
                  isOn={device.key === preview?.key}
                  subtitle={device.description}
                  onPress={() => setSelectedKey(device.key)}
                >
                  {device.name}
                </NativeHeaderToolbar.MenuAction>
              ))}
            </NativeHeaderToolbar.Menu>
          ) : null}
          {controls.map((control) => (
            <NativeHeaderToolbar.MenuAction
              key={control.id}
              icon={control.icon}
              disabled={control.disabled}
              onPress={control.onPress}
            >
              {control.title}
            </NativeHeaderToolbar.MenuAction>
          ))}
        </NativeHeaderToolbar.Menu>
      </NativeHeaderToolbar>
      {Platform.OS === "ios" ? (
        <NativeHeaderToolbar placement="left">
          <NativeHeaderToolbar.Button
            icon="xmark"
            accessibilityLabel="Close device preview"
            onPress={onClose}
            separateBackground
          />
        </NativeHeaderToolbar>
      ) : null}
      {preview && focused && foreground ? (
        <OpenDevicePreview
          key={`${preview.key}:${streamAttempt}`}
          environmentId={environmentId}
          preview={preview}
          streamRef={streamRef}
          onInputConnected={onInputConnected}
        />
      ) : (
        <View className="flex-1 items-center justify-center gap-4 px-6">
          {state.error ? (
            <>
              <AppText selectable className="text-center text-sm text-foreground-muted">
                {state.error}
              </AppText>
              <Pressable
                accessibilityRole="button"
                className="rounded-full bg-subtle px-6 py-3"
                onPress={state.refresh}
              >
                <AppText>Retry</AppText>
              </Pressable>
            </>
          ) : focused && foreground ? (
            <ActivityIndicator color={themeVariables["--color-icon"]} />
          ) : null}
        </View>
      )}
    </View>
  );
}

function OpenDevicePreview({
  environmentId,
  preview,
  streamRef,
  onInputConnected,
}: {
  readonly environmentId: EnvironmentId;
  readonly preview: ThreadDevicePreview;
  readonly streamRef: RefObject<DeviceStreamRef | null>;
  readonly onInputConnected: (connected: boolean) => Promise<void>;
}) {
  const { session } = preview;
  const { themeVariables } = useAppearancePreferences();
  const { access, error, refresh } = useDeviceHubAccess(environmentId, session.hostId);
  const onUnauthorized = useCallback(
    async () => refreshDeviceHubAccess(environmentId),
    [environmentId],
  );
  useEffect(() => {
    refreshDeviceHubAccess(environmentId);
    return () => void onInputConnected(false);
  }, [environmentId, onInputConnected]);
  return access ? (
    <DeviceStreamWebView
      ref={streamRef}
      access={access}
      platform={session.platform}
      deviceId={session.deviceId}
      colors={{
        background: themeVariables["--color-sheet-solid"],
        foreground: themeVariables["--color-foreground"],
        muted: themeVariables["--color-foreground-muted"],
        buttonBackground: themeVariables["--color-subtle"],
      }}
      onUnauthorized={onUnauthorized}
      onInputConnected={onInputConnected}
    />
  ) : (
    <View className="flex-1 items-center justify-center gap-4 px-6">
      {error ? (
        <>
          <AppText selectable className="text-center text-sm text-foreground-muted">
            {error}
          </AppText>
          <Pressable
            accessibilityRole="button"
            className="rounded-full bg-subtle px-6 py-3"
            onPress={refresh}
          >
            <AppText>Retry</AppText>
          </Pressable>
        </>
      ) : (
        <>
          <ActivityIndicator color={themeVariables["--color-icon"]} />
          <AppText className="text-sm text-foreground-muted">Connecting to device...</AppText>
        </>
      )}
    </View>
  );
}
