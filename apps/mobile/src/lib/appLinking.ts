/** Ignore lifecycle and wake-only URLs before they reach React Navigation. */
export function shouldHandleAppLink(url: string): boolean {
  if (url.includes("expo-development-client") || url.includes("://expo-sharing")) {
    return false;
  }

  // iOS dictation keyboards can return to the app with only its scheme. Those
  // URLs wake the app but have no route, so navigation must keep its stack.
  return !/^pylon-code(?:-dev|-preview)?:\/*$/i.test(url);
}
