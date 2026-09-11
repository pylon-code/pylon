import type { AndroidAgentNotificationsAvailability } from "../agent-awareness/androidNotifications";

export function resolveAgentAwarenessPlatformPresentation(platform: string): {
  readonly supported: boolean;
  readonly subtitle: string | undefined;
} {
  return platform === "ios" || platform === "android"
    ? { supported: true, subtitle: undefined }
    : { supported: false, subtitle: "Unavailable on this platform" };
}

/** Explains a disabled notification switch instead of leaving it silently off. */
export function resolveAgentAwarenessSubtitle(
  platform: string,
  androidAvailability?: AndroidAgentNotificationsAvailability,
): string | undefined {
  if (platform === "android" && androidAvailability === "native-module-missing") {
    return "Install a newer app build to enable notifications";
  }
  if (platform === "android" && androidAvailability === "push-not-configured") {
    return "This app build can't receive notifications";
  }
  return resolveAgentAwarenessPlatformPresentation(platform).subtitle;
}

/** Tells the user what signing in to Pylon Connect turns on for this device. */
export function resolveAgentAwarenessSignInMessage(platform: string): string {
  return platform === "android"
    ? "Agent notifications and ongoing activity require Pylon Connect so the relay can deliver them to this device."
    : "Notifications and Live Activity updates require Pylon Connect so the relay can deliver them to this device.";
}
