import {
  JcodeSettings,
  ProviderDriverKind,
  type ProviderInstanceEnvironment,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeJcodeTextGeneration } from "../../textGeneration/JcodeTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import {
  makeJcodeInstanceManager,
  type JcodeInstanceManager,
  type JcodeInstanceManagerInput,
  type JcodeInstanceProbe,
} from "../jcode/JcodeInstanceManager.ts";
import { defaultJcodeSdkModule, makeJcodeSdkBridge } from "../jcode/JcodeSdkBridge.ts";
import { makeJcodeAdapter } from "../Layers/JcodeAdapter.ts";
import { checkJcodeProviderStatus } from "../Layers/JcodeProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  makeStaticProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";

const decodeJcodeSettings = Schema.decodeSync(JcodeSettings);
const DRIVER_KIND = ProviderDriverKind.make("jcode");
const UPDATE = makeStaticProviderMaintenanceResolver(
  makeManualOnlyProviderMaintenanceCapabilities({
    provider: DRIVER_KIND,
    packageName: null,
  }),
);

export type JcodeDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ServerConfig
  | ServerSettingsService;

/**
 * The literal credential strings this instance's bridge must redact.
 *
 * Redaction is literal, so the set has to be complete: an omitted entry stays
 * readable in every later bridge error. It also has to be exact — passing every
 * environment value would shred ordinary words out of messages, and guessing
 * from a name or from entropy would silently miss a short credential. The
 * `sensitive` flag the user set on each provider-environment entry is the only
 * authoritative marker, so that is what this reads.
 */
export function jcodeCredentialValuesFromEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
): ReadonlyArray<string> {
  const values = new Set<string>();
  for (const variable of environment ?? []) {
    if (!variable.sensitive) continue;
    const value = variable.value.trim();
    if (value.length === 0) continue;
    values.add(variable.value);
  }
  return Array.from(values);
}

/**
 * Builds the manager input for exactly one provider instance.
 *
 * The bridge is constructed here, per call, and never taken from the module
 * singleton: `makeJcodeSdkBridge` closes over the launch credential literals it
 * is handed for the bridge's whole life, so one shared bridge would
 * cross-contaminate secrets between provider instances.
 */
export function buildJcodeInstanceManagerInput(input: {
  readonly instanceId: ProviderInstanceId;
  readonly stateDir: string;
  readonly settings: Pick<JcodeSettings, "binaryPath" | "inheritLogins">;
  readonly environment: ProviderInstanceEnvironment | undefined;
  readonly processEnv: NodeJS.ProcessEnv;
}): JcodeInstanceManagerInput {
  return {
    bridge: makeJcodeSdkBridge(defaultJcodeSdkModule),
    instanceId: input.instanceId,
    stateDir: input.stateDir,
    settings: {
      binaryPath: input.settings.binaryPath,
      inheritLogins: input.settings.inheritLogins,
    },
    environment: input.processEnv,
    credentialValues: jcodeCredentialValuesFromEnvironment(input.environment),
  };
}

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

export const JcodeDriver: ProviderDriver<JcodeSettings, JcodeDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Jcode",
    supportsMultipleInstances: true,
  },
  configSchema: JcodeSettings,
  defaultConfig: (): JcodeSettings => decodeJcodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const serverSettings = yield* ServerSettingsService;
      const serverConfig = yield* ServerConfig;
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
      const effectiveConfig = { ...config, enabled } satisfies JcodeSettings;
      const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        binaryPath: effectiveConfig.binaryPath,
        env: processEnv,
      });

      const managerInput = buildJcodeInstanceManagerInput({
        instanceId,
        stateDir: serverConfig.stateDir,
        settings: effectiveConfig,
        environment,
        processEnv,
      });

      // A disabled instance must not launch a private daemon, and a launch
      // failure must not erase the provider: it stays visible with whatever
      // status the executable probe reports.
      const manager: JcodeInstanceManager | undefined = enabled
        ? yield* makeJcodeInstanceManager(managerInput).pipe(
            Effect.tapError((cause) =>
              Effect.logWarning("Could not start the private Jcode instance.", {
                operation: cause.operation,
              }),
            ),
            Effect.result,
            Effect.map((result) => (Result.isSuccess(result) ? result.success : undefined)),
          )
        : undefined;

      // The model catalog is server-reported, so it is only available once a
      // private instance is actually running.
      const instanceProbe: JcodeInstanceProbe | undefined =
        manager === undefined
          ? undefined
          : yield* manager.probe.pipe(
              Effect.tapError((cause) =>
                Effect.logWarning("Could not read the private Jcode instance runtime.", {
                  operation: cause.operation,
                }),
              ),
              Effect.result,
              Effect.map((result) => (Result.isSuccess(result) ? result.success : undefined)),
            );

      const adapter = yield* makeJcodeAdapter({
        providerInstanceId: instanceId,
        instanceKey: instanceId,
        bridge: managerInput.bridge,
        manager,
      });
      const textGeneration = makeJcodeTextGeneration();

      const checkProvider = checkJcodeProviderStatus({
        settings: effectiveConfig,
        environment: processEnv,
        ...(instanceProbe === undefined ? {} : { instance: instanceProbe }),
      }).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      // Probed once here and reused as the initial snapshot, so startup spends
      // exactly one bounded `--version` call rather than one per code path.
      const firstSnapshot = yield* checkProvider;
      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<JcodeSettings>>({
        maintenanceCapabilities,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: () => Effect.succeed(firstSnapshot),
        checkProvider,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Jcode snapshot: ${cause.message ?? String(cause)}`,
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
