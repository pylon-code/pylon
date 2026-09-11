import Constants from "expo-constants";
import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

interface AndroidAgentNotifications {
  configure(deviceId: string, userId: string, scheme: string, ongoingEnabled: boolean): void;
  clear(): void;
}

const native =
  Platform.OS === "android"
    ? requireOptionalNativeModule<AndroidAgentNotifications>("T3AgentNotifications")
    : null;

/**
 * Why this Android build can or cannot receive agent notifications. An older
 * binary lacks the native handler; a build without Firebase config can never
 * obtain an FCM token, so the relay would have nothing to deliver to.
 */
export type AndroidAgentNotificationsAvailability =
  | "available"
  | "native-module-missing"
  | "push-not-configured";

export function resolveAndroidAgentNotificationsAvailability(): AndroidAgentNotificationsAvailability {
  if (typeof native?.configure !== "function" || typeof native?.clear !== "function") {
    return "native-module-missing";
  }
  return Constants.expoConfig?.extra?.androidPushConfigured === true
    ? "available"
    : "push-not-configured";
}

export function supportsAndroidAgentNotifications(): boolean {
  return resolveAndroidAgentNotificationsAvailability() === "available";
}

export function configureAndroidAgentNotifications(
  deviceId: string,
  userId: string,
  ongoingEnabled: boolean,
): void {
  const scheme = Constants.expoConfig?.scheme;
  native?.configure?.(
    deviceId,
    userId,
    (Array.isArray(scheme) ? scheme[0] : scheme) ?? "pylon-code",
    ongoingEnabled,
  );
}

export function clearAndroidAgentNotifications(): void {
  native?.clear?.();
}
