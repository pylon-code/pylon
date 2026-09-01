import {
  PrimeAgentSettings,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderDistribution,
} from "@t3tools/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
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
import { fencePrimeAgentAdapter } from "../prime/PrimeAgentGenerationFence.ts";
import {
  PrimeAgentOwnershipReceiptStore,
  primeAgentOwnershipHomesOverlap,
  primeAgentOwnershipReceiptIsSafeLive,
  type PrimeAgentAcquiredOwnershipReceipt,
} from "../prime/PrimeAgentOwnershipReceipt.ts";
import { PrimeAgentRecoveryLedger } from "../prime/PrimeAgentRecoveryLedger.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderDriverPreflightResult,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import {
  bindPrimeAgentRuntimeContext,
  materializePrimeAgentIdentities,
  PRIME_AGENT_AUTHORITATIVE_CLEANUP_CAPABILITY,
  PRIME_AGENT_CALLER_OWNED_SESSION_FEATURE,
  type PrimeAgentMaterializedIdentity,
} from "../prime/PrimeAgentRuntimeContext.ts";
import {
  PRIME_AGENT_MULTIPLE_INSTANCES_UNAVAILABLE_REASON,
  PRIME_AGENT_SUPPORTED_INSTANCE_LIMIT,
} from "../providerInstanceSettingsValidation.ts";
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
const PRIME_AGENT_NATIVE_QUARANTINE_MESSAGE =
  "Prime Agent native execution is quarantined until server-owned cleanup proves the prior owned session settled.";

const sameStringRecord = (
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean => {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(([name, value]) => right[name] === value)
  );
};

const receiptMatchesRecoveryAuthority = (
  receipt: PrimeAgentAcquiredOwnershipReceipt,
  identity: PrimeAgentMaterializedIdentity,
  authority: import("../prime/PrimeAgentRecoveryLedger.ts").PrimeAgentRecoveryAuthority,
): boolean =>
  receipt.instanceId === identity.instanceId &&
  receipt.effectiveHome === identity.effectiveHome &&
  receipt.activeSessionId === authority.activeSessionId &&
  receipt.nativeSessionId === authority.nativeSessionId &&
  receipt.attachProof.daemon.protocolName === authority.protocolName &&
  receipt.attachProof.daemon.protocolVersion === authority.protocolVersion &&
  receipt.attachProof.daemon.schemaRevision === authority.schemaRevision &&
  receipt.attachProof.daemon.supervisorGeneration === authority.supervisorGeneration &&
  receipt.recovery?.threadId === authority.threadId &&
  receipt.recovery.sessionIncarnationId === authority.sessionIncarnationId &&
  receipt.recovery.admissionRequestId === authority.admissionRequestId &&
  receipt.recovery.recoveryHandle === authority.recoveryHandle &&
  receipt.recovery.ownershipGeneration === authority.ownershipGeneration &&
  authority.providerInstanceId === identity.instanceId &&
  authority.state === "active" &&
  sameStringRecord(authority.launchEnvironment, identity.launchEnv);

const sameOwnershipReceipt = (
  left: PrimeAgentAcquiredOwnershipReceipt,
  right: PrimeAgentAcquiredOwnershipReceipt,
): boolean =>
  left.attemptId === right.attemptId &&
  left.instanceId === right.instanceId &&
  left.creationConfigRevision === right.creationConfigRevision &&
  left.currentConfigRevision === right.currentConfigRevision &&
  left.effectiveHome === right.effectiveHome &&
  left.activeSessionId === right.activeSessionId &&
  left.nativeSessionId === right.nativeSessionId;

export const PRIME_AGENT_NATIVE_WINDOWS_UNAVAILABLE_MESSAGE =
  "Prime Agent is unavailable because this Pylon server is running on native Windows. Run the Pylon server and Prime Agent in WSL2, or connect this client to a Pylon server running in WSL2 or another remote environment.";

export function isPrimeAgentProviderPlatformSupported(platform: NodeJS.Platform): boolean {
  return platform === "darwin" || platform === "linux";
}

function unsupportedPlatformMessage(platform: NodeJS.Platform): string {
  return platform === "win32"
    ? PRIME_AGENT_NATIVE_WINDOWS_UNAVAILABLE_MESSAGE
    : `Prime Agent is unavailable on '${platform}'. Run the Pylon server and Prime Agent on macOS, Linux, or WSL2.`;
}

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

export const PrimeAgentDriver: ProviderDriver<
  PrimeAgentSettings,
  PrimeAgentDriverEnv,
  PrimeAgentMaterializedIdentity
> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Prime Agent",
    supportsMultipleInstances: false,
    multipleInstancesUnavailableReason: PRIME_AGENT_MULTIPLE_INSTANCES_UNAVAILABLE_REASON,
  },
  configSchema: PrimeAgentSettings,
  defaultConfig: (): PrimeAgentSettings => decodePrimeAgentSettings({}),
  preflight: (inputs) =>
    Effect.gen(function* () {
      // Native quarantine is resolved before provider identities are materialized.
      // A dirty receipt must prevent all provider/session construction for its home.
      const platform = yield* HostProcessPlatform;
      if (!isPrimeAgentProviderPlatformSupported(platform)) {
        return new Map(
          inputs.map((input) => [
            input.instanceId,
            {
              kind: "unavailable" as const,
              error: new ProviderDriverError({
                driver: DRIVER_KIND,
                instanceId: input.instanceId,
                detail: unsupportedPlatformMessage(platform),
              }),
            },
          ]),
        );
      }
      if (inputs.filter((input) => input.enabled).length > PRIME_AGENT_SUPPORTED_INSTANCE_LIMIT) {
        const detail = `Prime Agent supports at most ${PRIME_AGENT_SUPPORTED_INSTANCE_LIMIT} enabled instances on one Pylon server.`;
        return new Map(
          inputs.map((input) => [
            input.instanceId,
            {
              kind: "unavailable" as const,
              error: new ProviderDriverError({
                driver: DRIVER_KIND,
                instanceId: input.instanceId,
                detail,
              }),
            },
          ]),
        );
      }
      const serverConfig = yield* ServerConfig;
      const store = new PrimeAgentOwnershipReceiptStore(serverConfig.stateDir);
      const scan = yield* Effect.tryPromise(() => store.scan()).pipe(
        Effect.orElseSucceed(() => ({ receipts: [], corrupt: true }) as const),
      );
      const ledger = Option.getOrUndefined(yield* Effect.serviceOption(PrimeAgentRecoveryLedger));
      const authorities =
        ledger === undefined ? [] : yield* ledger.listActive().pipe(Effect.orElseSucceed(() => []));
      const materialized = yield* materializePrimeAgentIdentities(inputs);
      const results = new Map<
        ProviderInstanceId,
        ProviderDriverPreflightResult<PrimeAgentMaterializedIdentity>
      >();

      for (const [instanceId, result] of materialized) {
        if (result.kind === "unavailable") {
          results.set(instanceId, { kind: "unavailable", error: result.error });
          continue;
        }
        const input = inputs.find((candidate) => candidate.instanceId === instanceId);
        const overlapping = scan.receipts.filter((receipt) =>
          primeAgentOwnershipHomesOverlap(
            receipt.effectiveHome,
            result.identity.effectiveHome,
            platform,
          ),
        );
        const adoptableReceipts = overlapping.filter(
          (receipt): receipt is PrimeAgentAcquiredOwnershipReceipt =>
            receipt.state === "acquired" &&
            authorities.some((authority) =>
              receiptMatchesRecoveryAuthority(receipt, result.identity, authority),
            ),
        );
        const dirtyBlockingReceipt = overlapping.some(
          (receipt) =>
            !primeAgentOwnershipReceiptIsSafeLive(receipt) &&
            !(
              receipt.state === "acquired" &&
              adoptableReceipts.some((adoptable) => sameOwnershipReceipt(receipt, adoptable))
            ),
        );
        const quarantined = input?.enabled === true && (scan.corrupt || dirtyBlockingReceipt);
        if (quarantined) {
          results.set(instanceId, {
            kind: "unavailable",
            error: new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: PRIME_AGENT_NATIVE_QUARANTINE_MESSAGE,
            }),
          });
          continue;
        }
        const identity: PrimeAgentMaterializedIdentity = Object.freeze({
          ...result.identity,
          nativeOwnership: Object.freeze({
            store,
            adoptableReceipts: Object.freeze([...adoptableReceipts]),
          }),
        });
        results.set(instanceId, {
          kind: "ready",
          preparation: identity,
          generation: identity.generation,
          configRevision: identity.configRevision,
        });
      }
      return results;
    }),
  create: ({ instanceId, displayName, accentColor, enabled, runtimeFence }, identity) =>
    Effect.gen(function* () {
      const hostPlatform = yield* HostProcessPlatform;
      if (!isPrimeAgentProviderPlatformSupported(hostPlatform)) {
        return yield* new ProviderDriverError({
          driver: DRIVER_KIND,
          instanceId,
          detail: unsupportedPlatformMessage(hostPlatform),
        });
      }
      if (
        identity === undefined ||
        identity.instanceId !== instanceId ||
        identity.nativeOwnership === undefined ||
        runtimeFence === undefined ||
        runtimeFence.generation !== identity.generation ||
        runtimeFence.configRevision !== identity.configRevision
      ) {
        return yield* new ProviderDriverError({
          driver: DRIVER_KIND,
          instanceId,
          detail: "Prime Agent runtime identity preflight was not preserved.",
        });
      }
      const hostArchitecture = yield* HostProcessArchitecture;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const httpClient = yield* HttpClient.HttpClient;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const serverSettings = yield* ServerSettingsService;
      const serverConfig = yield* ServerConfig;
      if (identity.nativeOwnership.store.stateDir !== serverConfig.stateDir) {
        return yield* new ProviderDriverError({
          driver: DRIVER_KIND,
          instanceId,
          detail: "Prime Agent native ownership preflight was not preserved.",
        });
      }
      const ownershipScan = yield* Effect.tryPromise(() =>
        identity.nativeOwnership!.store.scan(),
      ).pipe(Effect.orElseSucceed(() => ({ receipts: [], corrupt: true }) as const));
      const blockingOwnershipReceipt = ownershipScan.receipts.some((receipt) => {
        if (
          !primeAgentOwnershipHomesOverlap(
            receipt.effectiveHome,
            identity.effectiveHome,
            hostPlatform,
          )
        ) {
          return false;
        }
        if (
          receipt.state === "acquired" &&
          identity.nativeOwnership!.adoptableReceipts.some((adoptable) =>
            sameOwnershipReceipt(receipt, adoptable),
          )
        ) {
          return false;
        }
        return true;
      });
      if (enabled && (ownershipScan.corrupt || blockingOwnershipReceipt)) {
        return yield* new ProviderDriverError({
          driver: DRIVER_KIND,
          instanceId,
          detail: PRIME_AGENT_NATIVE_QUARANTINE_MESSAGE,
        });
      }
      const eventLoggers = yield* ProviderEventLoggers;
      const processEnv = identity.launchEnv;
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
      const effectiveConfig = identity.settings;
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

      const recoveryDistribution = yield* Effect.result(
        Effect.gen(function* () {
          const executablePath = path.resolve(
            yield* resolveCommandPath(effectiveConfig.binaryPath || "prime-agent", {
              env: processEnv,
            }),
          );
          const publicPackage = yield* locatePrimeAgentPublicPackage(executablePath);
          const distribution = yield* Effect.promise(() =>
            inspectPrimeAgentDistribution(
              {
                stateDir: serverConfig.stateDir,
                instanceId,
                packageRoot: publicPackage.packageRoot,
                platform: hostPlatform,
                checkedAt: "1970-01-01T00:00:00.000Z",
                enableUpdateChecks: false,
              },
              { loadLatestVerifiedPublication },
            ),
          );
          return { publicPackage, distribution };
        }),
      );
      const recoveryManagedBuildId =
        Result.isSuccess(recoveryDistribution) &&
        recoveryDistribution.success.distribution.classification === "pylon-managed" &&
        recoveryDistribution.success.distribution.buildId !== null
          ? recoveryDistribution.success.distribution.buildId
          : undefined;

      const backend = yield* negotiatePrimeAgentBackend(
        {
          identity,
          runtimeFence,
          stateDir: serverConfig.stateDir,
          platform: hostPlatform,
          recoveryEnabled: recoveryManagedBuildId !== undefined,
          architecture: hostArchitecture,
        },
        {
          resolveExecutable: (command, resolvedEnvironment) =>
            resolveCommandPath(command, { env: resolvedEnvironment }),
          makeManager: makePrimeAgentDaemonManager,
        },
      );
      const runtimeContext = bindPrimeAgentRuntimeContext(
        identity,
        backend.runtime === "daemon"
          ? {
              kind: "daemon",
              proof: {
                sdkFeatures: Object.freeze([...(backend.manager.bridge.sdkFeatures ?? [])]),
                requiredServerCapabilities: [
                  PRIME_AGENT_CALLER_OWNED_SESSION_FEATURE,
                  PRIME_AGENT_AUTHORITATIVE_CLEANUP_CAPABILITY,
                ],
              },
            }
          : {
              kind: "acp",
              ...(backend.fallbackCategory === undefined
                ? {}
                : { fallbackCategory: backend.fallbackCategory }),
            },
        runtimeFence,
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
        readPrimeAgentBackends(effectiveConfig, {
          processEnv,
          instanceId,
          configRevision: runtimeContext.configRevision,
          commitGuard: runtimeFence.isCurrent,
        }),
      );
      // After a turn the credential Prime just used is fresh and the number
      // just changed: read again unless a reading under a minute old exists.
      const capacity = {
        refresh: provideBackendServices(
          readPrimeAgentCapacity(effectiveConfig, {
            processEnv,
            instanceId,
            configRevision: runtimeContext.configRevision,
            commitGuard: runtimeFence.isCurrent,
            freshForMs: PRIME_AGENT_TURN_END_CAPACITY_FRESH_MS,
          }),
        ),
      };
      const textGeneration = yield* makePrimeAgentTextGeneration(
        effectiveConfig,
        runtimeContext.launchEnv,
        { runtimeContext },
      );
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
        commitGuard: runtimeFence.isCurrent,
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
        environment: runtimeContext.launchEnv,
        runtimeContext,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        instanceId,
        ...(recoveryManagedBuildId === undefined ? {} : { recoveryManagedBuildId }),
      } as const;
      const rawAdapter =
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
      const adapter = fencePrimeAgentAdapter(rawAdapter, runtimeFence);

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
        runtimeFence,
      } satisfies ProviderInstance;
    }),
};
