// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it } from "@effect/vitest";

import {
  isPathInside,
  loadPrimeAgentDaemonBridge,
  PRIME_AGENT_DAEMON_PROTOCOL_NAME,
  PRIME_AGENT_MIN_DAEMON_PROTOCOL_VERSION,
  PRIME_AGENT_NEGOTIATED_DAEMON_SESSION_CAPABILITIES_FEATURE,
  sanitizePrimeAgentDaemonEnvironment,
} from "./PrimeAgentDaemonBridge.ts";

const temporaryDirectories: Array<string> = [];
const configuredNegotiatedProofArtifactBinary =
  process.env.PYLON_PRIME_AGENT_NEGOTIATED_PROOF_ARTIFACT_BIN?.trim();
const configuredStockArtifactBinary = process.env.PYLON_PRIME_AGENT_STOCK_ARTIFACT_BIN?.trim();

function makeTemporaryDirectory(): string {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pylon-prime-bridge-"));
  temporaryDirectories.push(directory);
  return directory;
}

function daemonModuleSource(options?: {
  readonly protocolName?: string;
  readonly protocolVersion?: number;
  readonly version?: string;
  readonly omitConnection?: boolean;
  readonly omitSessionStats?: boolean;
  readonly omitResourceCatalog?: boolean;
  readonly omitAgentMessaging?: boolean;
  readonly omitModelCatalog?: boolean;
  readonly omitAvailableModels?: boolean;
  readonly omitSideQuestions?: boolean;
  readonly sdkFeatureRegistry?: "frozen" | "mutable";
  readonly extraSdkFeatures?: ReadonlyArray<string>;
  readonly omitNegotiatedCapabilityAccessor?: boolean;
}): string {
  const sdkFeatures = [
    PRIME_AGENT_NEGOTIATED_DAEMON_SESSION_CAPABILITIES_FEATURE,
    ...(options?.extraSdkFeatures ?? []),
  ];
  const sdkFeatureSource =
    options?.sdkFeatureRegistry === undefined
      ? ""
      : `export const PRIME_AGENT_SDK_FEATURES = ${
          options.sdkFeatureRegistry === "frozen" ? "Object.freeze" : ""
        }(${JSON.stringify(sdkFeatures)});`;
  return `
export const VERSION = ${JSON.stringify(options?.version ?? "0.7.1")};
export const DAEMON_PROTOCOL_NAME = ${JSON.stringify(
    options?.protocolName ?? PRIME_AGENT_DAEMON_PROTOCOL_NAME,
  )};
export const DAEMON_PROTOCOL_VERSION = ${options?.protocolVersion ?? PRIME_AGENT_MIN_DAEMON_PROTOCOL_VERSION};
${sdkFeatureSource}
export class DaemonClient {
  constructor(socketPath) { this.socketPath = socketPath; this.isConnected = false; }
  async connect() { this.isConnected = true; }
  async waitForHello() { return {}; }
  async request() { return {}; }
  close() { this.isConnected = false; }
}
${
  options?.omitConnection
    ? ""
    : `export class DaemonAgentConnection {
  constructor(client, activeSessionId) { this.client = client; this.activeSessionId = activeSessionId; }
  static async attach(client, activeSessionId) { return new DaemonAgentConnection(client, activeSessionId); }
  subscribe() { return () => {}; }
  async getInitialSnapshot() { return {}; }
  ${options?.omitResourceCatalog ? "" : "async getCommands() { return []; } async getResourceSnapshot() { return {}; } async reload() {}"}
  ${options?.omitModelCatalog ? "" : "async getModelCatalog() { return { models: [], configuredProviders: [] }; }"}
  ${options?.omitAvailableModels ? "" : "async getAvailableModels() { return []; }"}
  ${options?.omitSessionStats ? "" : "async getSessionStats() { return {}; }"}
  async promptAndWait() {}
  ${options?.omitAgentMessaging ? "" : 'async sendAgentMessage(targetActiveSessionId, message) { return { deliveryStatus: "delivered", targetActiveSessionId, message }; }'}
  ${options?.omitSideQuestions ? "" : "async startSideQuestion(nativeId, question) { return { nativeId, question }; } async abortSideQuestion(nativeId) { return nativeId === 'known'; }"}
  ${options?.omitNegotiatedCapabilityAccessor ? "" : "supportsNegotiatedCapability(capability) { return capability === 'correlated_prompt_lifecycle_v1'; }"}
  async abort() {}
  async dispose() {}
}`
}
export function defaultDaemonSocketPath() { return "/tmp/prime-agent-test.sock"; }
`;
}

function makePackage(options?: { readonly name?: string; readonly moduleSource?: string }): {
  readonly root: string;
  readonly cliPath: string;
  readonly entryPath: string;
} {
  const root = makeTemporaryDirectory();
  const dist = NodePath.join(root, "dist");
  NodeFS.mkdirSync(dist, { recursive: true });
  const cliPath = NodePath.join(dist, "cli.js");
  const entryPath = NodePath.join(dist, "index.js");
  NodeFS.writeFileSync(cliPath, "#!/usr/bin/env node\n");
  NodeFS.writeFileSync(entryPath, options?.moduleSource ?? daemonModuleSource());
  NodeFS.writeFileSync(
    NodePath.join(root, "package.json"),
    JSON.stringify({
      name: options?.name ?? "prime-agent",
      version: "0.7.1",
      type: "module",
      bin: { "prime-agent": "dist/cli.js" },
      exports: { ".": { import: "./dist/index.js" } },
    }),
  );
  return { root, cliPath, entryPath };
}

it("rejects Windows cross-volume paths from package containment", () => {
  expect(isPathInside("C:\\npm\\node_modules\\prime-agent", "D:\\escape.js", NodePath.win32)).toBe(
    false,
  );
  expect(
    isPathInside(
      "C:\\npm\\node_modules\\prime-agent",
      "C:\\npm\\node_modules\\prime-agent\\dist\\index.js",
      NodePath.win32,
    ),
  ).toBe(true);
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("PrimeAgentDaemonBridge", () => {
  it.effect("reports a missing configured executable", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        loadPrimeAgentDaemonBridge(NodePath.join(makeTemporaryDirectory(), "missing")),
      );

      expect(error.reason).toBe("path-not-found");
    }),
  );

  it.effect("rejects an executable belonging to a different package", () =>
    Effect.gen(function* () {
      const pkg = makePackage({ name: "not-prime-agent" });

      const error = yield* Effect.flip(loadPrimeAgentDaemonBridge(pkg.cliPath));

      expect(error.reason).toBe("wrong-package");
      expect(error.message).toContain("not-prime-agent");
    }),
  );

  it.effect("follows an executable symlink into an npm-style package", () =>
    Effect.gen(function* () {
      const pkg = makePackage();
      const binDirectory = NodePath.join(makeTemporaryDirectory(), "bin");
      NodeFS.mkdirSync(binDirectory);
      const linkedBinary = NodePath.join(binDirectory, "prime-agent");
      NodeFS.symlinkSync(pkg.cliPath, linkedBinary, "file");

      const bridge = yield* loadPrimeAgentDaemonBridge(linkedBinary);

      expect(bridge.packageRoot).toBe(NodeFS.realpathSync(pkg.root));
      expect(bridge.moduleEntryPath).toBe(NodeFS.realpathSync(pkg.entryPath));
    }),
  );

  it.effect("loads the public API from a direct dist/cli.js executable", () =>
    Effect.gen(function* () {
      const pkg = makePackage();

      const bridge = yield* loadPrimeAgentDaemonBridge(pkg.cliPath);
      const client = new bridge.DaemonClient("/tmp/test.sock");

      expect(bridge.version).toBe("0.7.1");
      expect(bridge.protocolName).toBe(PRIME_AGENT_DAEMON_PROTOCOL_NAME);
      expect(bridge.protocolVersion).toBe(PRIME_AGENT_MIN_DAEMON_PROTOCOL_VERSION);
      expect(bridge.defaultDaemonSocketPath()).toBe("/tmp/prime-agent-test.sock");
      const connection = yield* Effect.promise(() =>
        bridge.DaemonAgentConnection.attach(client, "active-parent"),
      );
      expect(
        yield* Effect.promise(() => connection.sendAgentMessage!("active-child", "hello")),
      ).toEqual({
        deliveryStatus: "delivered",
        targetActiveSessionId: "active-child",
        message: "hello",
      });
      expect(yield* Effect.promise(() => connection.getModelCatalog!())).toEqual({
        models: [],
        configuredProviders: [],
      });
      expect(yield* Effect.promise(() => connection.getAvailableModels!())).toEqual([]);
      expect(
        yield* Effect.promise(() => connection.startSideQuestion!("native-id", "question")),
      ).toEqual({ nativeId: "native-id", question: "question" });
      expect(yield* Effect.promise(() => connection.abortSideQuestion!("known"))).toBe(true);
      expect(client.isConnected).toBe(false);
    }),
  );

  it.effect("does not infer negotiated daemon proof support from accessor presence", () =>
    Effect.gen(function* () {
      const pkg = makePackage();

      const bridge = yield* loadPrimeAgentDaemonBridge(pkg.cliPath);

      expect(bridge.negotiatedDaemonSessionCapabilitiesAvailable).toBe(false);
    }),
  );

  it.effect("accepts the frozen negotiated daemon capability feature contract", () =>
    Effect.gen(function* () {
      const pkg = makePackage({
        moduleSource: daemonModuleSource({ sdkFeatureRegistry: "frozen" }),
      });

      const bridge = yield* loadPrimeAgentDaemonBridge(pkg.cliPath);

      expect(bridge.negotiatedDaemonSessionCapabilitiesAvailable).toBe(true);
    }),
  );

  it.effect("rejects a frozen registry containing malformed feature values", () =>
    Effect.gen(function* () {
      const moduleSource = daemonModuleSource().replace(
        "export class DaemonClient",
        `export const PRIME_AGENT_SDK_FEATURES = Object.freeze(["${PRIME_AGENT_NEGOTIATED_DAEMON_SESSION_CAPABILITIES_FEATURE}", 7]);
export class DaemonClient`,
      );
      const pkg = makePackage({ moduleSource });

      const bridge = yield* loadPrimeAgentDaemonBridge(pkg.cliPath);

      expect(bridge.negotiatedDaemonSessionCapabilitiesAvailable).toBe(false);
    }),
  );

  it.effect("accepts the exact frozen feature alongside future feature tokens", () =>
    Effect.gen(function* () {
      const pkg = makePackage({
        moduleSource: daemonModuleSource({
          sdkFeatureRegistry: "frozen",
          extraSdkFeatures: ["future_sdk_feature_v1"],
        }),
      });

      const bridge = yield* loadPrimeAgentDaemonBridge(pkg.cliPath);

      expect(bridge.negotiatedDaemonSessionCapabilitiesAvailable).toBe(true);
    }),
  );

  it.effect("rejects a mutable feature claim for the strict negotiated proof path", () =>
    Effect.gen(function* () {
      const pkg = makePackage({
        moduleSource: daemonModuleSource({ sdkFeatureRegistry: "mutable" }),
      });

      const bridge = yield* loadPrimeAgentDaemonBridge(pkg.cliPath);

      expect(bridge.negotiatedDaemonSessionCapabilitiesAvailable).toBe(false);
    }),
  );

  it.effect("rejects a frozen feature contract missing its proof accessor", () =>
    Effect.gen(function* () {
      const pkg = makePackage({
        moduleSource: daemonModuleSource({
          sdkFeatureRegistry: "frozen",
          omitNegotiatedCapabilityAccessor: true,
        }),
      });

      const error = yield* Effect.flip(loadPrimeAgentDaemonBridge(pkg.cliPath));

      expect(error.reason).toBe("incompatible-exports");
    }),
  );

  it.effect("keeps the newer agent messaging method optional for compatible daemons", () =>
    Effect.gen(function* () {
      const pkg = makePackage({
        moduleSource: daemonModuleSource({ omitAgentMessaging: true }),
      });

      const bridge = yield* loadPrimeAgentDaemonBridge(pkg.cliPath);
      const client = new bridge.DaemonClient("/tmp/test.sock");
      const connection = yield* Effect.promise(() =>
        bridge.DaemonAgentConnection.attach(client, "active-parent"),
      );

      expect(connection.sendAgentMessage).toBeUndefined();
    }),
  );

  it.effect("keeps side-question methods optional for compatible daemons", () =>
    Effect.gen(function* () {
      const pkg = makePackage({
        moduleSource: daemonModuleSource({ omitSideQuestions: true }),
      });

      const bridge = yield* loadPrimeAgentDaemonBridge(pkg.cliPath);
      const client = new bridge.DaemonClient("/tmp/test.sock");
      const connection = yield* Effect.promise(() =>
        bridge.DaemonAgentConnection.attach(client, "active-parent"),
      );

      expect(connection.startSideQuestion).toBeUndefined();
      expect(connection.abortSideQuestion).toBeUndefined();
    }),
  );

  it.effect("keeps both model discovery methods optional for compatible daemons", () =>
    Effect.gen(function* () {
      const pkg = makePackage({
        moduleSource: daemonModuleSource({
          omitModelCatalog: true,
          omitAvailableModels: true,
        }),
      });

      const bridge = yield* loadPrimeAgentDaemonBridge(pkg.cliPath);
      const client = new bridge.DaemonClient("/tmp/test.sock");
      const connection = yield* Effect.promise(() =>
        bridge.DaemonAgentConnection.attach(client, "active-parent"),
      );

      expect(connection.getModelCatalog).toBeUndefined();
      expect(connection.getAvailableModels).toBeUndefined();
    }),
  );

  it.effect("rejects public VERSION metadata that disagrees with package.json", () =>
    Effect.gen(function* () {
      const pkg = makePackage({
        moduleSource: daemonModuleSource({ version: "0.8.0" }),
      });

      const error = yield* Effect.flip(loadPrimeAgentDaemonBridge(pkg.cliPath));

      expect(error.reason).toBe("incompatible-version");
    }),
  );

  it.effect("accepts a newer daemon protocol exposed by the installed client", () =>
    Effect.gen(function* () {
      const pkg = makePackage({
        moduleSource: daemonModuleSource({ protocolVersion: 8 }),
      });

      const bridge = yield* loadPrimeAgentDaemonBridge(pkg.cliPath);

      expect(bridge.protocolVersion).toBe(8);
    }),
  );

  it.effect("makes an incompatible daemon protocol explicit", () =>
    Effect.gen(function* () {
      const pkg = makePackage({
        moduleSource: daemonModuleSource({ protocolVersion: 6 }),
      });

      const error = yield* Effect.flip(loadPrimeAgentDaemonBridge(pkg.cliPath));

      expect(error.reason).toBe("incompatible-protocol");
      expect(error.message).toContain("requires prime-agent.daemon v7 or newer");
    }),
  );

  it.effect("rejects a daemon connection missing session usage", () =>
    Effect.gen(function* () {
      const pkg = makePackage({
        moduleSource: daemonModuleSource({ omitSessionStats: true }),
      });

      const error = yield* Effect.flip(loadPrimeAgentDaemonBridge(pkg.cliPath));

      expect(error.reason).toBe("incompatible-exports");
    }),
  );

  it.effect("rejects a daemon connection missing the stable resource catalog API", () =>
    Effect.gen(function* () {
      const pkg = makePackage({
        moduleSource: daemonModuleSource({ omitResourceCatalog: true }),
      });

      const error = yield* Effect.flip(loadPrimeAgentDaemonBridge(pkg.cliPath));

      expect(error.reason).toBe("incompatible-exports");
    }),
  );

  it.effect("rejects a public API missing the connection export", () =>
    Effect.gen(function* () {
      const pkg = makePackage({
        moduleSource: daemonModuleSource({ omitConnection: true }),
      });

      const error = yield* Effect.flip(loadPrimeAgentDaemonBridge(pkg.cliPath));

      expect(error.reason).toBe("incompatible-exports");
    }),
  );

  it.effect.skipIf(!configuredNegotiatedProofArtifactBinary)(
    "loads the pinned negotiated-proof artifact through the public package bridge",
    () =>
      Effect.gen(function* () {
        const bridge = yield* loadPrimeAgentDaemonBridge(configuredNegotiatedProofArtifactBinary!);

        expect(bridge.version).toBe("0.8.1");
        expect(bridge.protocolVersion).toBe(PRIME_AGENT_MIN_DAEMON_PROTOCOL_VERSION);
        expect(bridge.negotiatedDaemonSessionCapabilitiesAvailable).toBe(true);
        expect(typeof bridge.DaemonAgentConnection.prototype.supportsNegotiatedCapability).toBe(
          "function",
        );
      }),
  );

  it.effect.skipIf(!configuredStockArtifactBinary)(
    "keeps the stock artifact on the compatible ordinary capability path",
    () =>
      Effect.gen(function* () {
        const bridge = yield* loadPrimeAgentDaemonBridge(configuredStockArtifactBinary!);

        expect(bridge.version).toBe("0.8.1");
        expect(bridge.protocolVersion).toBe(PRIME_AGENT_MIN_DAEMON_PROTOCOL_VERSION);
        expect(bridge.negotiatedDaemonSessionCapabilitiesAvailable).toBe(false);
      }),
  );

  it("strips every inherited Prime Agent internal daemon variable", () => {
    const input = {
      PATH: "/usr/bin",
      PRIME_AGENT_INTERNAL_DAEMON_WORKER: "1",
      PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN: "secret",
      PRIME_AGENT_INTERNAL_FUTURE_COORDINATION_FIELD: "future",
      RLM_DEPTH: "3",
      RLM_MAX_DEPTH: "5",
    };

    const sanitized = sanitizePrimeAgentDaemonEnvironment(input);

    expect(sanitized).toEqual({ PATH: "/usr/bin", RLM_MAX_DEPTH: "5" });
    expect(input.PRIME_AGENT_INTERNAL_DAEMON_WORKER).toBe("1");
  });
});
