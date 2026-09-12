/** Reviewed against Cua Driver 0.28.1. Unknown tools/arguments fail closed in background mode. */
const backgroundArguments: Readonly<Record<string, readonly string[]>> = {
  list_apps: [],
  list_windows: ["on_screen_only", "pid"],
  get_window_state: [
    "capture_mode",
    "include_accessibility_tree",
    "include_screenshot",
    "max_depth",
    "max_dimension",
    "max_elements",
    "pid",
    "query",
    "screenshot_out_file",
    "window_id",
  ],
  verify_state: [
    "expect",
    "include_screenshot",
    "pid",
    "stable_samples",
    "timeout_ms",
    "window_id",
  ],
  click: [
    "action",
    "button",
    "count",
    "debug_image_out",
    "delivery_mode",
    "element_index",
    "element_token",
    "from_zoom",
    "modifier",
    "pid",
    "scope",
    "snapshot_id",
    "window_id",
    "x",
    "y",
  ],
  double_click: [
    "delivery_mode",
    "element_index",
    "element_token",
    "pid",
    "snapshot_id",
    "window_id",
    "x",
    "y",
  ],
  right_click: [
    "delivery_mode",
    "element_index",
    "element_token",
    "modifier",
    "pid",
    "snapshot_id",
    "window_id",
    "x",
    "y",
  ],
  drag: [
    "button",
    "delivery_mode",
    "duration_ms",
    "from_x",
    "from_y",
    "from_zoom",
    "modifier",
    "pid",
    "scope",
    "steps",
    "to_x",
    "to_y",
    "window_id",
  ],
  type_text: [
    "delay_ms",
    "delivery_mode",
    "element_index",
    "element_token",
    "pid",
    "scope",
    "snapshot_id",
    "text",
    "window_id",
    "x",
    "y",
  ],
  press_key: [
    "delivery_mode",
    "element_index",
    "element_token",
    "key",
    "modifiers",
    "pid",
    "scope",
    "snapshot_id",
    "window_id",
    "x",
    "y",
  ],
  hotkey: [
    "delivery_mode",
    "element_index",
    "element_token",
    "keys",
    "pid",
    "scope",
    "snapshot_id",
    "window_id",
    "x",
    "y",
  ],
  set_value: ["element_index", "element_token", "pid", "snapshot_id", "value", "window_id"],
  scroll: [
    "amount",
    "by",
    "delivery_mode",
    "direction",
    "element_index",
    "element_token",
    "pid",
    "scope",
    "snapshot_id",
    "window_id",
    "x",
    "y",
  ],
  check_permissions: ["probe_direct_capture", "prompt"],
  zoom: ["pid", "window_id", "x1", "x2", "y1", "y2"],
};

const backgroundInput = new Set([
  "click",
  "double_click",
  "right_click",
  "drag",
  "type_text",
  "press_key",
  "hotkey",
  "scroll",
]);

export const backgroundArgumentNames = (name: string) =>
  Object.hasOwn(backgroundArguments, name) ? backgroundArguments[name] : [];

export const supportsBackground = (name: string) => Object.hasOwn(backgroundArguments, name);

/** This constrains direct input delivery, not app side effects (e.g. a button opening a dialog). */
export function prepareCuaCall(
  name: string,
  args: Record<string, unknown>,
  foreground: boolean,
): Record<string, unknown> {
  if (foreground) return args;
  const keys = backgroundArguments[name];
  if (!keys)
    throw new Error(
      `${name} is unavailable in background mode. Foreground control must be enabled explicitly in this environment's Computer settings.`,
    );
  for (const key of Object.keys(args)) {
    if (!keys.includes(key))
      throw new Error(
        `${name}.${key} is not supported in background mode. Use explicit pid/window_id targeting and the implicit agent session.`,
      );
  }
  if (args.delivery_mode !== undefined && args.delivery_mode !== "background")
    throw new Error("Foreground delivery is disabled in this environment's Computer settings.");
  if (args.scope !== undefined && args.scope !== "window")
    throw new Error("Desktop input is disabled in background mode.");
  if (name === "check_permissions") {
    if (args.prompt === true || args.probe_direct_capture === true)
      throw new Error(
        "Grant Cua permissions using the CuaDriver app before starting background control.",
      );
    return { ...args, prompt: false, probe_direct_capture: false };
  }
  if (backgroundInput.has(name) || name === "set_value") {
    if (
      !Number.isSafeInteger(args.pid) ||
      Number(args.pid) <= 0 ||
      !Number.isSafeInteger(args.window_id) ||
      Number(args.window_id) < 0
    )
      throw new Error(
        "Background actions require explicit pid and window_id from a fresh window inspection.",
      );
  }
  return backgroundInput.has(name) ? { ...args, delivery_mode: "background" } : args;
}

/** Preserve desktop routing without forwarding unrelated server credentials to the driver. */
export function cuaTransportEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const keys = [
    "HOME",
    "LOGNAME",
    "PATH",
    "SHELL",
    "TERM",
    "USER",
    "USERPROFILE",
    "SystemRoot",
    "SYSTEMROOT",
    "APPDATA",
    "LOCALAPPDATA",
    "TEMP",
    "TMP",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
    "XAUTHORITY",
  ];
  return Object.fromEntries(
    keys.flatMap((key) => (source[key] === undefined ? [] : [[key, source[key]]])),
  );
}
