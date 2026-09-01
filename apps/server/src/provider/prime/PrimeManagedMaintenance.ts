import {
  ProviderInstanceId,
  ServerPrimeManagedMaintenanceError,
  type ServerPrimeManagedCommandInput,
  type ServerPrimeManagedCommandReceipt,
  type ServerPrimeManagedMaintenance,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderRegistry } from "../Services/ProviderRegistry.ts";
import { ProviderService } from "../Services/ProviderService.ts";
import {
  PrimeAgentManagedToolStore,
  type PrimeManagedCommandReceipt,
} from "./PrimeAgentManagedToolStore.ts";
import {
  makeLatestPrimePublicationBundleLoader,
  makePrimeDistributionNetworkDependencies,
} from "./PrimeAgentDistributionVerifier.ts";

export interface PrimeManagedMaintenanceShape {
  readonly status: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ServerPrimeManagedMaintenance, ServerPrimeManagedMaintenanceError>;
  readonly run: (
    input: ServerPrimeManagedCommandInput,
  ) => Effect.Effect<ServerPrimeManagedCommandReceipt, ServerPrimeManagedMaintenanceError>;
}

export class PrimeManagedMaintenance extends Context.Service<
  PrimeManagedMaintenance,
  PrimeManagedMaintenanceShape
>()("t3/provider/prime/PrimeManagedMaintenance") {}

function maintenanceError(instanceId: ProviderInstanceId, cause: unknown) {
  return new ServerPrimeManagedMaintenanceError({
    instanceId,
    reason: cause instanceof Error ? cause.message : String(cause),
  });
}

function contractReceipt(receipt: PrimeManagedCommandReceipt): ServerPrimeManagedCommandReceipt {
  return {
    commandId: receipt.commandId,
    instanceId: ProviderInstanceId.make(receipt.instanceId),
    action: receipt.action,
    status: receipt.status,
    channel: receipt.channel,
    buildId: receipt.buildId,
    message: receipt.message,
    startedAt: receipt.startedAt,
    finishedAt: receipt.finishedAt,
  };
}

export const make = Effect.fn("PrimeManagedMaintenance.make")(function* () {
  const config = yield* ServerConfig;
  const platform = yield* HostProcessPlatform;
  const settings = yield* ServerSettingsService;
  const providerService = yield* ProviderService;
  const providerRegistry = yield* ProviderRegistry;
  const runtimeContext = yield* Effect.context<never>();
  const runPromise = Effect.runPromiseWith(runtimeContext);

  if (platform !== "win32") {
    if (
      !settings.readPrimeAgentBinaryBinding ||
      !settings.compareAndSetPrimeAgentBinaryPath ||
      !providerService.reserveProviderMaintenance ||
      !providerService.releaseProviderMaintenance
    ) {
      return yield* Effect.die(
        new Error("Prime managed maintenance requires exact settings CAS and provider fences."),
      );
    }
  }

  if (platform === "win32") {
    const guidance =
      "Native Windows Prime managed install/update is unavailable. Install and run Pylon with Prime Agent inside WSL2; the Linux environment owns all downloads and runtime files.";
    return PrimeManagedMaintenance.of({
      status: (_instanceId) =>
        Effect.succeed({
          supported: false,
          controlsAvailable: false,
          mode: "stock",
          selectedBuildId: null,
          channel: null,
          availableBuilds: [],
          scheduled: null,
          operation: null,
          message: guidance,
          guidance,
        }),
      run: (input) => Effect.fail(maintenanceError(input.instanceId, new Error(guidance))),
    });
  }

  const readPrimeAgentBinaryBinding = settings.readPrimeAgentBinaryBinding!;
  const compareAndSetPrimeAgentBinaryPath = settings.compareAndSetPrimeAgentBinaryPath!;
  const reserveProviderMaintenance = providerService.reserveProviderMaintenance!;
  const releaseProviderMaintenance = providerService.releaseProviderMaintenance!;

  const loadLatestVerifiedPublication = makeLatestPrimePublicationBundleLoader(
    makePrimeDistributionNetworkDependencies({
      tufCachePath: `${config.stateDir}/sigstore-tuf`,
    }),
  );
  const store = new PrimeAgentManagedToolStore({
    stateDir: config.stateDir,
    platform,
    dependencies: {
      loadLatestVerifiedPublication,
      readBinding: async (instanceId) => {
        const binding = await runPromise(
          readPrimeAgentBinaryBinding(instanceId).pipe(Effect.orDie),
        );
        if (!binding) throw new Error("The target is not a configured Prime Agent instance.");
        return binding;
      },
      reserveQuiescentBinding: async (instanceId, expected) => {
        const current = await runPromise(
          readPrimeAgentBinaryBinding(instanceId).pipe(Effect.orDie),
        );
        if (
          !current ||
          current.generation !== expected.generation ||
          current.binaryPath !== expected.binaryPath
        ) {
          throw new Error(
            "The exact Prime provider binding changed before maintenance could fence it.",
          );
        }
        return await runPromise(
          reserveProviderMaintenance(ProviderInstanceId.make(instanceId)).pipe(Effect.orDie),
        );
      },
      commitBinding: async ({ instanceId, expected, binaryPath, reservation: _reservation }) => {
        const committed = await runPromise(
          compareAndSetPrimeAgentBinaryPath({ instanceId, expected, binaryPath }).pipe(
            Effect.orDie,
          ),
        );
        if (!committed) {
          throw new Error(
            "The exact Prime provider binding changed; the staged build was not selected.",
          );
        }
        return committed;
      },
      releaseReservation: (reservation) => runPromise(releaseProviderMaintenance(reservation)),
    },
  });
  yield* Effect.tryPromise({
    try: () => store.initialize(),
    catch: (cause) => maintenanceError(ProviderInstanceId.make("primeAgent"), cause),
  });

  const refreshAfterDrain = (instanceId: ProviderInstanceId) =>
    Effect.tryPromise({
      try: () => store.drain(instanceId),
      catch: (cause) => maintenanceError(instanceId, cause),
    }).pipe(
      Effect.flatMap((receipt) =>
        receipt?.status === "succeeded"
          ? providerRegistry.refreshInstance(instanceId).pipe(Effect.ignore)
          : Effect.void,
      ),
      Effect.catch((cause) =>
        Effect.logWarning("Scheduled Prime host maintenance did not drain.", {
          instanceId,
          cause,
        }),
      ),
    );
  yield* providerService.streamEvents.pipe(
    Stream.filter(
      (event) =>
        event.type === "session.exited" &&
        event.provider === "primeAgent" &&
        event.providerInstanceId !== undefined,
    ),
    Stream.runForEach((event) => refreshAfterDrain(event.providerInstanceId!)),
    Effect.forkScoped,
  );

  const status: PrimeManagedMaintenanceShape["status"] = (instanceId) =>
    Effect.tryPromise({
      try: async () => {
        const result = await store.status(instanceId);
        return {
          supported: true,
          controlsAvailable: true,
          mode: result.mode,
          selectedBuildId: result.selectedBuildId,
          channel: result.channel,
          availableBuilds: result.availableBuilds.map((build) => ({
            buildId: build.buildId,
            channel: build.channel,
            sequence: build.sequence,
            binaryPath: build.binaryPath,
          })),
          scheduled: result.scheduled ? contractReceipt(result.scheduled) : null,
          operation: result.operation ? contractReceipt(result.operation) : null,
          message: result.message,
          guidance: null,
        } satisfies ServerPrimeManagedMaintenance;
      },
      catch: (cause) => maintenanceError(instanceId, cause),
    });

  const run: PrimeManagedMaintenanceShape["run"] = (input) =>
    Effect.tryPromise({
      try: async () =>
        contractReceipt(
          await store.command({
            commandId: input.commandId,
            instanceId: input.instanceId,
            action: input.action,
            ...(input.channel === undefined ? {} : { channel: input.channel }),
            ...(input.allowPreview === undefined ? {} : { allowPreview: input.allowPreview }),
            ...(input.buildId === undefined ? {} : { buildId: input.buildId }),
            ...(input.scheduleIfBusy === undefined ? {} : { scheduleIfBusy: input.scheduleIfBusy }),
          }),
        ),
      catch: (cause) => maintenanceError(input.instanceId, cause),
    }).pipe(
      Effect.tap((receipt) =>
        receipt.status === "succeeded"
          ? providerRegistry.refreshInstance(input.instanceId).pipe(Effect.ignore)
          : Effect.void,
      ),
    );

  return PrimeManagedMaintenance.of({ status, run });
});

export const layer = Layer.effect(PrimeManagedMaintenance, make());
