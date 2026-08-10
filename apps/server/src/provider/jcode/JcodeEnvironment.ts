/**
 * Environment isolation for launched Jcode instances.
 *
 * The SDK owns the instance's `JCODE_HOME`, runtime directory, and socket paths:
 * it derives them from `LaunchOptions` and passes them to the daemon itself. An
 * inherited value for any of them would silently redirect a launched instance at
 * whatever Jcode the host process was already pointed at, which is exactly the
 * user's live interactive state. Strip them and pass everything else through, so
 * provider credentials and `PATH` still reach the child.
 */
const RESERVED_JCODE_ENV = new Set([
  "JCODE_HOME",
  "JCODE_RUNTIME_DIR",
  "JCODE_API_SOCKET",
  "JCODE_SOCKET",
]);

export function sanitizeJcodeLaunchEnvironment(
  environment: NodeJS.ProcessEnv,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).flatMap(([name, value]) =>
      value === undefined || RESERVED_JCODE_ENV.has(name) ? [] : [[name, value]],
    ),
  );
}
