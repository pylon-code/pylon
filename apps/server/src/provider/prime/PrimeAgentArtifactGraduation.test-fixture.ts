// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  verifyPrimePublicationArtifactDirectory,
  type PrimeGraduationVerifiedArtifact,
} from "./PrimeAgentDistributionVerifier.ts";
import {
  PrimeAgentManagedToolStore,
  type PrimeManagedBinding,
  type PrimeManagedCommandInput,
  type PrimeManagedCommandReceipt,
  type PrimeManagedInstanceStatus,
  type PrimeManagedPublicationBundle,
} from "./PrimeAgentManagedToolStore.ts";

const INSTANCE_ID = "prime-artifact-graduation";

export interface PrimeArtifactGraduationHarness {
  readonly artifacts: ReadonlyArray<PrimeGraduationVerifiedArtifact>;
  readonly store: PrimeAgentManagedToolStore;
  readonly instanceId: string;
  readonly stockBinaryPath: string;
  useArtifact(index: number): void;
  binding(): PrimeManagedBinding;
  command(input: Omit<PrimeManagedCommandInput, "instanceId">): Promise<PrimeManagedCommandReceipt>;
  status(): Promise<PrimeManagedInstanceStatus>;
}

export async function makePrimeArtifactGraduationHarness(input: {
  readonly stateDir: string;
  readonly artifactDirectory: string;
  readonly previewTag: string;
  readonly stockBinaryPath: string;
  readonly platform: NodeJS.Platform;
  readonly secondArtifactDirectory?: string;
  readonly secondPreviewTag?: string;
}): Promise<PrimeArtifactGraduationHarness> {
  const stateDir = await NodeFSP.realpath(NodePath.resolve(input.stateDir));
  const stockBinaryPath = NodePath.resolve(input.stockBinaryPath);
  const first = await verifyPrimePublicationArtifactDirectory({
    tag: input.previewTag,
    artifactDirectory: input.artifactDirectory,
    tufCachePath: NodePath.join(stateDir, "sigstore-tuf"),
  });
  const artifacts = [first];
  if (input.secondArtifactDirectory || input.secondPreviewTag) {
    if (!input.secondArtifactDirectory || !input.secondPreviewTag) {
      throw new Error(
        "The optional second Prime graduation build requires both tag and directory.",
      );
    }
    artifacts.push(
      await verifyPrimePublicationArtifactDirectory({
        tag: input.secondPreviewTag,
        artifactDirectory: input.secondArtifactDirectory,
        tufCachePath: NodePath.join(stateDir, "sigstore-tuf"),
      }),
    );
  }

  let artifactIndex = 0;
  let revision = 0;
  let currentBinding: PrimeManagedBinding = {
    binaryPath: stockBinaryPath,
    generation: `graduation-${revision}`,
  };
  let reservation = 0;
  const store = new PrimeAgentManagedToolStore({
    stateDir,
    platform: input.platform,
    dependencies: {
      loadLatestVerifiedPublication: async (): Promise<PrimeManagedPublicationBundle> => {
        const selected = artifacts[artifactIndex];
        if (!selected) throw new Error("The selected Prime graduation artifact is unavailable.");
        return {
          publication: selected.publication,
          rootArtifactBytes: selected.rootArtifactBytes,
        };
      },
      readBinding: async () => currentBinding,
      listBindings: async () => [{ instanceId: INSTANCE_ID, binding: currentBinding }],
      listOwnedRuntimeBuildReferences: async () => [],
      reserveQuiescentBinding: async (_instanceId, expected) => {
        if (
          expected.binaryPath !== currentBinding.binaryPath ||
          expected.generation !== currentBinding.generation
        ) {
          return { status: "busy" as const, reasons: ["binding changed"] };
        }
        reservation += 1;
        return {
          status: "reserved" as const,
          reservation: { token: `reservation-${reservation}` },
        };
      },
      commitBinding: async ({ expected, binaryPath }) => {
        if (
          expected.binaryPath !== currentBinding.binaryPath ||
          expected.generation !== currentBinding.generation
        ) {
          throw new Error("Prime graduation binding changed before commit.");
        }
        revision += 1;
        currentBinding = { binaryPath, generation: `graduation-${revision}` };
        return currentBinding;
      },
      releaseReservation: async () => {},
      now: () => `2026-09-01T00:00:${String(revision).padStart(2, "0")}.000Z`,
    },
  });
  await store.initialize();

  return {
    artifacts,
    store,
    instanceId: INSTANCE_ID,
    stockBinaryPath,
    useArtifact(index) {
      if (!artifacts[index]) throw new Error("The requested Prime graduation artifact is absent.");
      artifactIndex = index;
    },
    binding: () => currentBinding,
    command: (command) => store.command({ ...command, instanceId: INSTANCE_ID }),
    status: () => store.status(INSTANCE_ID),
  };
}
