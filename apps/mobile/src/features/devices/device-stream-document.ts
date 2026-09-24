import type { DeviceHubAccess } from "@t3tools/client-runtime/device/hub-access";
import type { DevicePlatform } from "@t3tools/contracts";

export interface DeviceStreamConfiguration {
  readonly access: DeviceHubAccess;
  readonly platform: DevicePlatform;
  readonly deviceId: string;
  readonly colors: {
    readonly background: string;
    readonly foreground: string;
    readonly muted: string;
    readonly buttonBackground: string;
  };
}

/** Keep the inline viewer on the authenticated environment's origin. */
export function deviceStreamDocumentBaseUrl(access: DeviceHubAccess): string {
  const endpoint = new URL(access.httpBase);
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new Error("Device viewer requires an HTTP environment endpoint");
  }
  return `${endpoint.origin}/api/device-hub/`;
}

export function isDeviceStreamDocumentNavigation(url: string, baseUrl: string): boolean {
  return url === "about:blank" || url === baseUrl;
}

/** Never surface transport exceptions that may contain a ticketed URL. */
export function deviceStreamFailureDetail(detail: string | undefined): string {
  if (
    detail === "This viewer cannot decode the Android stream (WebCodecs unavailable)." ||
    detail === "No video received from the device. Reconnect to try again." ||
    detail === "Could not receive the device stream. Reconnect to try again."
  ) {
    return detail;
  }
  return "Device stream failed. Reconnect to try again.";
}

export function deviceStreamDocument(configuration: string, script: string) {
  // Tickets and device names are data, including any HTML delimiter characters.
  const safeConfiguration = configuration.replace(/</g, "\\u003c");
  const safeScript = script.replace(/<\/script/gi, "<\\/script");
  const failure = `window.ReactNativeWebView.postMessage(JSON.stringify({type:"status",status:"error",detail:"Device viewer stopped unexpectedly."}));`;
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"></head><body><script>window.addEventListener("error",function(){${failure}});window.addEventListener("unhandledrejection",function(){${failure}});\n${safeScript}\ntry{PylonDeviceStream.start(${safeConfiguration});}catch{${failure}}</script></body></html>`;
}

export function deviceStreamMessage(data: string) {
  try {
    const message: unknown = JSON.parse(data);
    if (typeof message !== "object" || message === null || !("type" in message)) return null;
    if (message.type === "unauthorized" || message.type === "retry") {
      return { type: message.type } as const;
    }
    if (
      message.type === "input" &&
      "connected" in message &&
      typeof message.connected === "boolean"
    ) {
      return { type: message.type, connected: message.connected } as const;
    }
    if (
      message.type === "status" &&
      "status" in message &&
      (message.status === "connecting" ||
        message.status === "streaming" ||
        message.status === "error") &&
      (!("detail" in message) || typeof message.detail === "string")
    ) {
      return {
        type: message.type,
        status: message.status,
        detail:
          "detail" in message && typeof message.detail === "string" ? message.detail : undefined,
      } as const;
    }
  } catch {
    // Ignore messages that are not part of the stream bridge.
  }
  return null;
}
