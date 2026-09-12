import { describe, expect, it } from "@effect/vitest";
import { cuaTransportEnvironment, prepareCuaCall } from "./cuaPolicy.ts";

describe("background admission", () => {
  it("forces background window delivery and avoids permission prompts", () => {
    expect(prepareCuaCall("click", { pid: 4, window_id: 8, x: 10, y: 20 }, false)).toMatchObject({
      delivery_mode: "background",
    });
    expect(prepareCuaCall("check_permissions", {}, false)).toEqual({
      prompt: false,
      probe_direct_capture: false,
    });
  });
  it.each([
    ["bring_to_front", {}],
    ["replay_trajectory", {}],
    ["set_config", {}],
    ["future_tool", {}],
    ["click", { pid: 4, window_id: 8, delivery_mode: "foreground" }],
    ["click", { pid: 4, window_id: 8, scope: "desktop" }],
    ["click", { target: { kind: "desktop", display_id: "primary" } }],
    ["click", { pid: 4, window_id: 8, new_delivery_option: true }],
    ["click", { x: 1, y: 2 }],
    ["click", { pid: 4, window_id: 8, session: "another-agent" }],
    ["check_permissions", { prompt: true }],
  ] satisfies [string, Record<string, unknown>][])("rejects %s bypass %j", (name, args) => {
    expect(() => prepareCuaCall(name, args, false)).toThrow();
  });
  it("allows foreground operations only with explicit environment opt-in", () => {
    expect(prepareCuaCall("bring_to_front", { pid: 4 }, true)).toEqual({ pid: 4 });
  });
});
it("forwards desktop routing without server credentials or unreviewed Cua overrides", () => {
  const routing = {
    HOME: "/home/test",
    PATH: "/bin",
    DISPLAY: ":1",
    WAYLAND_DISPLAY: "wayland-0",
    XDG_RUNTIME_DIR: "/run/user/1",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/bus",
    XAUTHORITY: "/tmp/auth",
  };
  expect(
    cuaTransportEnvironment({
      ...routing,
      OPENAI_API_KEY: "secret",
      CUA_DRIVER_MODE: "unreviewed",
    }),
  ).toEqual(routing);
});
