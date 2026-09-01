import {
  PrimeAgentSettings,
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderDistribution,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
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
  primeAgentModelsFromSettings,
  primeAgentServerModelsFromDiscoveredModels,
  reconcilePrimeAgentDaemonCatalogSnapshot,
  stampPrimeAgentBackendSnapshot,
} from "../Layers/PrimeAgentProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { readPrimeAgentBackends, readPrimeAgentCapacity } from "../primeAgentBackends.ts";

/** A reading under this age is served from the shared cache even after a turn. */
const PRIME_AGENT_TURN_END_CAPACITY_FRESH_MS = 60_000;
import { makePrimeAgentDaemonAdapter } from "../prime/PrimeAgentDaemonAdapter.ts";
import { negotiatePrimeAgentBackend } from "../prime/PrimeAgentBackendSelection.ts";
import { locatePrimeAgentPublicPackage } from "../prime/PrimeAgentDaemonBridge.ts";
import {
  inspectPrimeAgentDistribution,
  makeLatestPrimePublicationLoader,
  makePrimeDistributionNetworkDependencies,
} from "../prime/PrimeAgentDistributionVerifier.ts";
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
      const hostPlatform = yield* HostProcessPlatform;
      const httpClient = yield* HttpClient.HttpClient;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
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
      const loadLatestVerifiedPublication = makeLatestPrimePublicationLoader(
        makePrimeDistributionNetworkDependencies({
          tufCachePath: path.join(serverConfig.stateDir, "sigstore-tuf"),
        }),
      );
      const inspectDistribution = (
        snapshot: ServerProvider,
        enableUpdateChecks: boolean | undefined,
      ): Effect.Effect<ServerProviderDistribution> => {
        if (!snapshot.enabled || !snapshot.installed) {
          return Effect.succeed({
            classification: "stock-or-custom" as const,
            channel: null,
            buildId: null,
            sequence: null,
            latestBuildId: null,
            latestSequence: null,
            updateAvailable: false,
            checkedAt: snapshot.checkedAt,
            message: "This Prime installation is maintained manually.",
          });
        }
        return Effect.gen(function* () {
          const executablePath = path.resolve(
            yield* resolveCommandPath(effectiveConfig.binaryPath || "prime-agent", {
              env: processEnv,
            }),
          );
          const publicPackage = yield* locatePrimeAgentPublicPackage(executablePath);
          return yield* Effect.promise(() =>
            inspectPrimeAgentDistribution(
              {
                stateDir: serverConfig.stateDir,
                instanceId,
                packageRoot: publicPackage.packageRoot,
                platform: hostPlatform,
                checkedAt: snapshot.checkedAt,
                ...(enableUpdateChecks === undefined ? {} : { enableUpdateChecks }),
              },
              { loadLatestVerifiedPublication },
            ),
          );
        }).pipe(
          Effect.catchCause(() =>
            Effect.succeed({
              classification: "stock-or-custom" as const,
              channel: null,
              buildId: null,
              sequence: null,
              latestBuildId: null,
              latestSequence: null,
              updateAvailable: false,
              checkedAt: snapshot.checkedAt,
              message:
                "Pylon could not inspect the selected Prime distribution; Prime remains ready and manually maintained.",
            }),
          ),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        );
      };
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
                inputQueueModes: ["setSteeringMode", "setFollowUpMode"].every(
                  (method) =>
                    typeof backend.manager.bridge.DaemonAgentConnection.prototype[
                      method as "setSteeringMode" | "setFollowUpMode"
                    ] === "function",
                ),
                inputQueueMutation:
                  typeof backend.manager.bridge.DaemonAgentConnection.prototype
                    .mutateQueuedMessage === "function",
                agentCancel:
                  typeof backend.manager.bridge.DaemonAgentConnection.prototype.cancelRlmChild ===
                  "function",
                agentMessage:
                  typeof backend.manager.bridge.DaemonAgentConnection.prototype.sendAgentMessage ===
                  "function",
                agentLiveActivity:
                  typeof backend.manager.bridge.DaemonAgentConnection.prototype.watchSession ===
                  "function",
                compaction: ["getState", "compact", "abortCompaction"].every(
                  (method) =>
                    typeof backend.manager.bridge.DaemonAgentConnection.prototype[
                      method as "getState" | "compact" | "abortCompaction"
                    ] === "function",
                ),
                refinement:
                  typeof backend.manager.bridge.DaemonAgentConnection.prototype.refine ===
                  "function",
                autoCompaction: ["getState", "setAutoCompactionEnabled"].every(
                  (method) =>
                    typeof backend.manager.bridge.DaemonAgentConnection.prototype[
                      method as "getState" | "setAutoCompactionEnabled"
                    ] === "function",
                ),
                // GoalState is part of the public daemon session snapshot/event baseline
                // accepted by the negotiated daemon protocol.
                goals: true,
                sideQuestions: ["startSideQuestion", "abortSideQuestion"].every(
                  (method) =>
                    typeof backend.manager.bridge.DaemonAgentConnection.prototype[
                      method as "startSideQuestion" | "abortSideQuestion"
                    ] === "function",
                ),
              }
            : {
                runtime: "acp",
                ...(backend.fallbackMessage ? { fallbackMessage: backend.fallbackMessage } : {}),
              },
        );
      const stampSnapshot = (snapshot: ServerProviderDraft) =>
        stampIdentity(stampBackendSnapshot(snapshot));

      // What Prime is signed in to, so the composer can show the capacity of
      // the account Prime actually uses rather than assume it.
      const provideBackendServices = <A, E>(
        effect: Effect.Effect<
          A,
          E,
          | never
          | FileSystem.FileSystem
          | Path.Path
          | HttpClient.HttpClient
          | ChildProcessSpawner.ChildProcessSpawner
        >,
      ) =>
        effect.pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
      const readBackends = provideBackendServices(
        readPrimeAgentBackends(effectiveConfig, { processEnv, platform: hostPlatform }),
      );
      // After a turn the credential Prime just used is fresh and the number
      // just changed: read again unless a reading under a minute old exists.
      const capacity = {
        refresh: provideBackendServices(
          readPrimeAgentCapacity(effectiveConfig, {
            processEnv,
            platform: hostPlatform,
            freshForMs: PRIME_AGENT_TURN_END_CAPACITY_FRESH_MS,
          }),
        ),
      };
      const textGeneration = yield* makePrimeAgentTextGeneration(effectiveConfig, processEnv);
      const checkProvider = checkPrimeAgentProviderStatus(effectiveConfig, processEnv, {
        readBackends,
      }).pipe(
        Effect.map(stampSnapshot),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const checkProviderWithPublishedModels = checkPrimeAgentProviderStatus(
        effectiveConfig,
        processEnv,
        { discoverModels: false, readBackends },
      ).pipe(
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
        checkProviderWithPublishedModels,
        reconcilePublishedModels: reconcilePrimeAgentDaemonCatalogSnapshot,
        enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
          enrichPrimeAgentSnapshot({
            snapshot: currentSnapshot,
            maintenanceCapabilities,
            enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
            distribution: inspectDistribution(currentSnapshot, settings.enableProviderUpdateChecks),
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

      const adapterOptions = {
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        instanceId,
      } as const;
      const adapter =
        backend.runtime === "daemon"
          ? yield* makePrimeAgentDaemonAdapter(effectiveConfig, backend.manager, {
              ...adapterOptions,
              onModelsDiscovered: (models) =>
                snapshot.publishModels(
                  primeAgentModelsFromSettings(
                    effectiveConfig.customModels,
                    primeAgentServerModelsFromDiscoveredModels(models),
                  ),
                ),
            })
          : yield* makePrimeAgentAdapter(effectiveConfig, {
              ...adapterOptions,
              ...(backend.fallbackMessage ? { startupWarning: backend.fallbackMessage } : {}),
            });

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
        capacity,
      } satisfies ProviderInstance;
    }),
};
