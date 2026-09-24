import {
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_UNIFIED_SETTINGS,
  type DeviceServiceState,
} from "@t3tools/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, StrictMode, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { listBrowserImportSources, selectedDeviceEnvironment } = vi.hoisted(() => ({
  listBrowserImportSources: vi.fn().mockResolvedValue([]),
  selectedDeviceEnvironment: {
    id: null as string | null,
    aggregate: false,
    projectScope: false,
    versioned: false,
  },
}));

vi.mock("../preview/previewBridge", () => ({
  previewBridge: { listBrowserImportSources },
}));
vi.mock("../../env", () => ({ isElectron: true }));
vi.mock("../../state/device", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../state/device")>();
  return {
    ...original,
    useDeviceState: (environmentId: Parameters<typeof original.useDeviceState>[0]) =>
      selectedDeviceEnvironment.versioned
        ? {
            loaded: true,
            state: {
              hosts: [
                {
                  id: "local",
                  kind: "local",
                  label: "This machine",
                  hubInstalled: true,
                  agentDeviceInstalled: true,
                  platforms: [],
                  tools: {
                    hub: { requiredVersion: "2", installedVersions: ["1"], runningVersion: "1" },
                    agent: {
                      requiredVersion: "2",
                      installedVersions: ["1"],
                      runningVersion: "1",
                    },
                  },
                },
              ],
              hostStatus: "ready",
              hostStatuses: {},
              devices: [],
              sessions: [],
              onboardingCompleted: true,
              agentAccessEnabled: true,
              hubBasePath: "/api/device-hub",
              revision: 1,
              supportsToolUpdate: true,
              supportsToolInspection: true,
            } satisfies DeviceServiceState,
          }
        : original.useDeviceState(environmentId),
  };
});
vi.mock("../device/DeviceToolVersions", () => ({
  DeviceToolVersions: ({ action, kind }: { action: ReactNode; kind: string }) => (
    <div data-tool-version-kind={kind}>{action}</div>
  ),
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: [], isReady: true }),
  usePrimaryEnvironment: () => null,
}));
vi.mock("../../hooks/useSettings", () => ({
  PRIMARY_SETTINGS_UNAVAILABLE_MESSAGE: "Connect to an environment",
  mergeEnvironmentSettings: (server: object, client: object) => ({ ...server, ...client }),
  useClientSettings: (selector?: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    selector ? selector(DEFAULT_CLIENT_SETTINGS) : DEFAULT_CLIENT_SETTINGS,
  useClientSettingsHydrated: () => true,
  usePrimarySettingsAvailable: () => true,
  usePrimarySettings: () => DEFAULT_UNIFIED_SETTINGS,
  useUpdatePrimarySettings: () => vi.fn(),
}));
vi.mock("./settingsLayout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./settingsLayout")>()),
  SettingsPageContainer: ({ children }: { children: ReactNode }) => children,
}));
// The scoped agent-access rows need the settings layout's scope provider;
// this test covers the device-local browser sections only.
vi.mock("./ProjectDefaultsSettings", () => ({ ProjectDefaultsSettings: () => null }));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    search: {},
    scope: {
      kind: selectedDeviceEnvironment.projectScope ? "project" : "all",
      environmentIds: selectedDeviceEnvironment.aggregate ? ["remote", "other"] : [],
    },
    environment: selectedDeviceEnvironment.id
      ? {
          environmentId: selectedDeviceEnvironment.id,
          label: "Selected remote",
          connection: { phase: "connected" },
          serverConfig: { settings: DEFAULT_UNIFIED_SETTINGS },
        }
      : null,
    connectedEnvironments: selectedDeviceEnvironment.aggregate
      ? [
          {
            environmentId: "remote",
            label: "Selected remote",
            serverConfig: { settings: DEFAULT_UNIFIED_SETTINGS },
          },
          {
            environmentId: "other",
            label: "Other",
            serverConfig: { settings: DEFAULT_UNIFIED_SETTINGS },
          },
        ]
      : [],
    environments: selectedDeviceEnvironment.aggregate
      ? [
          { environmentId: "remote", label: "Selected remote", connection: { phase: "connected" } },
          { environmentId: "other", label: "Other", connection: { phase: "connected" } },
        ]
      : [],
    targets: [],
  }),
  useOptionalSettingsScope: () => null,
}));

import { IntegrationsSettingsPanel } from "./IntegrationsSettings";
import { platformSetupStatus } from "../device/DeviceSetup";

let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  listBrowserImportSources.mockClear();
  selectedDeviceEnvironment.id = null;
  selectedDeviceEnvironment.aggregate = false;
  selectedDeviceEnvironment.projectScope = false;
  selectedDeviceEnvironment.versioned = false;
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

async function openSettings() {
  const router = createRouter({
    routeTree: createRootRoute({ component: IntegrationsSettingsPanel }),
    history: createMemoryHistory(),
  });
  await router.load();
  await act(() => {
    renderer = create(
      <StrictMode>
        <RouterProvider router={router} />
      </StrictMode>,
    );
  });
  expect(renderer!.root.findByType(IntegrationsSettingsPanel)).toBeDefined();
}

describe("Integrations browser discovery", () => {
  it("does not scan browser files when entering or revisiting settings", async () => {
    await openSettings();
    expect(listBrowserImportSources).not.toHaveBeenCalled();

    await act(() => renderer?.unmount());
    await openSettings();
    expect(listBrowserImportSources).not.toHaveBeenCalled();
  });

  it("places device settings directly after browser settings", async () => {
    await openSettings();
    const sections = renderer!.root
      .findAll((node) => node.type === "section")
      .map((node) => node.props.id)
      .filter(Boolean);
    expect(sections.indexOf("devices")).toBeGreaterThan(sections.indexOf("browser"));
  });

  it("shows the selected device settings without a second selector", async () => {
    selectedDeviceEnvironment.id = "selected-remote";
    selectedDeviceEnvironment.aggregate = true;
    await openSettings();
    const section = renderer!.root.findAll(
      (node) => node.type === "section" && node.props.id === "devices",
    )[0]!;
    expect(
      section.findAll((node) => node.type === "h2").map((node) => node.children.join("")),
    ).toContain("Devices");
    expect(
      section.findAll((node) => node.props["aria-label"] === "Device environment"),
    ).toHaveLength(0);
  });

  it("keeps environment device helpers and the project-scoped permission switch", async () => {
    selectedDeviceEnvironment.projectScope = true;
    await openSettings();
    const section = renderer!.root.findAll(
      (node) => node.type === "section" && node.props.id === "devices",
    )[0]!;
    expect(
      section.findAll((node) => node.props["aria-label"] === "Agent device access"),
    ).not.toHaveLength(0);
    expect(
      section.findAll((node) => node.props["aria-label"] === "Device hub").length,
    ).toBeGreaterThan(0);
  });

  it("offers manual tool updates only at environment scope while retaining project inspection", async () => {
    selectedDeviceEnvironment.id = "selected-remote";
    selectedDeviceEnvironment.aggregate = true;
    selectedDeviceEnvironment.versioned = true;
    selectedDeviceEnvironment.projectScope = true;
    await openSettings();
    const project = renderer!.root.findAll(
      (node) => node.type === "section" && node.props.id === "devices",
    )[0]!;
    expect(project.findAll((node) => node.props["aria-label"] === "Agent device access")).not.toHaveLength(0);
    expect(project.findAll((node) => node.children.includes("Check versions"))).not.toHaveLength(0);
    expect(project.findAll((node) => node.children.includes("Update to v2"))).toHaveLength(0);

    await act(() => renderer?.unmount());
    selectedDeviceEnvironment.projectScope = false;
    await openSettings();
    const environment = renderer!.root.findAll(
      (node) => node.type === "section" && node.props.id === "devices",
    )[0]!;
    expect(environment.findAll((node) => node.children.includes("Update to v2"))).not.toHaveLength(0);
  });
});

const deviceState = (overrides: Partial<DeviceServiceState> = {}): DeviceServiceState => ({
  hosts: [
    {
      id: "local",
      kind: "local",
      label: "This machine",
      hubInstalled: false,
      agentDeviceInstalled: false,
      platforms: [
        { platform: "ios", available: true },
        { platform: "android", available: true },
      ],
    },
  ],
  hostStatus: "ready",
  hostStatuses: {},
  devices: [],
  sessions: [],
  onboardingCompleted: false,
  agentAccessEnabled: false,
  hubBasePath: "/api/device-hub",
  revision: 0,
  ...overrides,
});

describe("device setup guidance", () => {
  it("directs users to install an iOS runtime and create an Android virtual device", () => {
    expect(platformSetupStatus(deviceState(), "ios").message).toContain("Xcode Settings");
    expect(platformSetupStatus(deviceState(), "android").message).toContain("Device Manager");
  });

  it("preserves a specific missing-tool explanation from the server", () => {
    const state = deviceState({
      hosts: [
        {
          ...deviceState().hosts[0]!,
          platforms: [
            { platform: "ios", available: true },
            { platform: "android", available: false, reason: "Android Emulator is missing." },
          ],
        },
      ],
    });
    expect(platformSetupStatus(state, "android").message).toBe("Android Emulator is missing.");
  });
});
