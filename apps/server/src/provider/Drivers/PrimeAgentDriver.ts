import { PrimeAgentSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makePrimeAgentTextGeneration } from "../../textGeneration/PrimeAgentTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makePrimeAgentAdapter } from "../Layers/PrimeAgentAdapter.ts";
import {
  buildInitialPrimeAgentProviderSnapshot,
  checkPrimeAgentProviderStatus,
  enrichPrimeAgentSnapshot,
  stampPrimeAgentBackendSnapshot,
} from "../Layers/PrimeAgentProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { makePrimeAgentDaemonAdapter } from "../prime/PrimeAgentDaemonAdapter.ts";
import { negotiatePrimeAgentBackend } from "../prime/PrimeAgentBackendSelection.ts";
import { makePrimeAgentDaemonManager } from "../prime/PrimeAgentDaemonManager.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  makeStaticProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";

const decodePrimeAgentSettings = Schema.decodeSync(PrimeAgentSettings);
const DRIVER_KIND = ProviderDriverKind.make("primeAgent");
const UPDATE = makeStaticProviderMaintenanceResolver(
  makeManualOnlyProviderMaintenanceCapabilities({
    provider: DRIVER_KIND,
    packageName: null,
  }),
);

export type PrimeAgentDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export const PrimeAgentDriver: ProviderDriver<PrimeAgentSettings, PrimeAgentDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Prime Agent",
    supportsMultipleInstances: false,
  },
  configSchema: PrimeAgentSettings,
  defaultConfig: (): PrimeAgentSettings => decodePrimeAgentSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const httpClient = yield* HttpClient.HttpClient;
      const serverSettings = yield* ServerSettingsService;
      const serverConfig = yield* ServerConfig;
      const eventLoggers = yield* ProviderEventLoggers;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies PrimeAgentSettings;
      const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        binaryPath: effectiveConfig.binaryPath,
        env: processEnv,
      });

      const backend = yield* negotiatePrimeAgentBackend(
        {
          enabled: effectiveConfig.enabled,
          binaryPath: effectiveConfig.binaryPath,
          launchArgs: effectiveConfig.launchArgs,
          settings: effectiveConfig,
          environment: processEnv,
          stateDir: serverConfig.stateDir,
          providerInstanceId: instanceId,
        },
        {
          resolveExecutable: (command, resolvedEnvironment) =>
            resolveCommandPath(command, { env: resolvedEnvironment }),
          makeManager: makePrimeAgentDaemonManager,
        },
      );
      const adapterOptions = {
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        instanceId,
      } as const;
      const adapter =
        backend.runtime === "daemon"
          ? yield* makePrimeAgentDaemonAdapter(effectiveConfig, backend.manager, adapterOptions)
          : yield* makePrimeAgentAdapter(effectiveConfig, {
              ...adapterOptions,
              ...(backend.fallbackMessage ? { startupWarning: backend.fallbackMessage } : {}),
            });
      const stampBackendSnapshot = (snapshot: ServerProviderDraft) =>
        stampPrimeAgentBackendSnapshot(
          snapshot,
          backend.runtime === "daemon"
            ? {
                runtime: "daemon",
                inputQueue: ["followUp", "getQueue", "clearQueue"].every(
                  (method) =>
                    typeof backend.manager.bridge.DaemonAgentConnection.prototype[
                      method as "followUp" | "getQueue" | "clearQueue"
                    ] === "function",
                ),
                agentCancel:
                  typeof backend.manager.bridge.DaemonAgentConnection.prototype.cancelRlmChild ===
                  "function",
              }
            : {
                runtime: "acp",
                ...(backend.fallbackMessage ? { fallbackMessage: backend.fallbackMessage } : {}),
              },
        );
      const stampSnapshot = (snapshot: ServerProviderDraft) =>
        stampIdentity(stampBackendSnapshot(snapshot));
      const textGeneration = makePrimeAgentTextGeneration();

      const checkProvider = checkPrimeAgentProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.map(stampSnapshot),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<
        ProviderSnapshotSettings<PrimeAgentSettings>
      >({
        maintenanceCapabilities,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialPrimeAgentProviderSnapshot(settings.provider).pipe(Effect.map(stampSnapshot)),
        checkProvider,
        enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
          enrichPrimeAgentSnapshot({
            snapshot: currentSnapshot,
            maintenanceCapabilities,
            enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
            publishSnapshot,
            httpClient,
          }),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Prime Agent snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
