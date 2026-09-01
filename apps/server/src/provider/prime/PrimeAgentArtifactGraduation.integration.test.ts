// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makePrimeArtifactGraduationHarness } from "./PrimeAgentArtifactGraduation.test-fixture.ts";
import { loadPrimeAgentDaemonBridge } from "./PrimeAgentDaemonBridge.ts";
import { PRIME_MANAGED_TOOL_DIRECTORY } from "./PrimeAgentManagedToolStore.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const required = process.env.PYLON_PRIME_GRADUATION_REQUIRED === "1";
const artifactDirectory = process.env.PYLON_PRIME_ARTIFACT_DIR?.trim();
const previewTag = process.env.PYLON_PRIME_PREVIEW_TAG?.trim();
const secondArtifactDirectory = process.env.PYLON_PRIME_SECOND_ARTIFACT_DIR?.trim();
const secondPreviewTag = process.env.PYLON_PRIME_SECOND_PREVIEW_TAG?.trim();
const stockBinaryPath = process.env.PYLON_PRIME_AGENT_STOCK_ARTIFACT_BIN?.trim();
const stockTarballPath = process.env.PYLON_PRIME_STOCK_TARBALL?.trim();
const resultPath = process.env.PYLON_PRIME_GRADUATION_RESULT?.trim();
const configured = Boolean(
  artifactDirectory && previewTag && stockBinaryPath && stockTarballPath && resultPath,
);

if (required && !configured) {
  throw new Error(
    "Prime artifact graduation requires the exact preview fixture, stock fixture, and result destination.",
  );
}
if (required && Boolean(secondArtifactDirectory) !== Boolean(secondPreviewTag)) {
  throw new Error("Prime artifact graduation requires both inputs for an optional second build.");
}

function digest(bytes: NodeJS.ArrayBufferView | string): string {
  return NodeCrypto.createHash("sha256").update(bytes).digest("hex");
}

async function treeDigest(root: string): Promise<string> {
  const hash = NodeCrypto.createHash("sha256");
  const visit = async (relative: string): Promise<void> => {
    const absolute = relative ? NodePath.join(root, relative) : root;
    const entries = await NodeFSP.readdir(absolute, { withFileTypes: true });
    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      const child = relative ? NodePath.join(relative, entry.name) : entry.name;
      hash.update(child.split(NodePath.sep).join("/"));
      if (entry.isDirectory()) {
        hash.update("directory\0");
        await visit(child);
      } else if (entry.isSymbolicLink()) {
        hash.update("symlink\0");
        hash.update(await NodeFSP.readlink(NodePath.join(root, child)));
      } else if (entry.isFile()) {
        hash.update("file\0");
        hash.update(await NodeFSP.readFile(NodePath.join(root, child)));
      } else {
        throw new Error("Stock Prime fixture contains an unsupported filesystem entry.");
      }
    }
  };
  await visit("");
  return hash.digest("hex");
}

it.skipIf(!configured)(
  "graduates exact signed Prime bytes through install, use, update, rollback, stock, and cleanup",
  async () => {
    const stateDir = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pylon-prime-graduation-")),
    );
    try {
      const stockRoot = NodePath.resolve(stockBinaryPath!, "../../..");
      const stockTarballBefore = await NodeFSP.readFile(stockTarballPath!);
      const stockTreeBefore = await treeDigest(stockRoot);
      const harness = await makePrimeArtifactGraduationHarness({
        stateDir,
        artifactDirectory: artifactDirectory!,
        previewTag: previewTag!,
        stockBinaryPath: stockBinaryPath!,
        // eslint-disable-next-line t3code/no-global-process-runtime -- This opt-in host proof passes its actual POSIX runner platform into the production store.
        platform: process.platform,
        ...(secondArtifactDirectory ? { secondArtifactDirectory } : {}),
        ...(secondPreviewTag ? { secondPreviewTag } : {}),
      });

      // eslint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- This one opt-in proof combines the Promise-owned store lifecycle with the bridge Effect.
      const stockBridge = await Effect.runPromise(loadPrimeAgentDaemonBridge(stockBinaryPath!));
      expect(stockBridge.version).toBe("0.8.1");
      expect(stockBridge.negotiatedDaemonSessionCapabilitiesAvailable).toBe(false);

      const install = await harness.command({
        commandId: "graduation-install-preview",
        action: "install",
        channel: "preview",
        allowPreview: true,
        scheduleIfBusy: false,
      });
      expect(install).toMatchObject({
        status: "succeeded",
        buildId: harness.artifacts[0]!.publication.buildId,
      });
      const installedStatus = await harness.status();
      expect(installedStatus.mode).toBe("managed");
      const installed = installedStatus.availableBuilds.find(
        (build) => build.buildId === harness.artifacts[0]!.publication.buildId,
      );
      expect(installed).toBeDefined();
      // eslint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- The verified store returns its launcher from the same Promise-owned lifecycle.
      const previewBridge = await Effect.runPromise(
        loadPrimeAgentDaemonBridge(installed!.binaryPath),
      );
      expect(previewBridge.negotiatedDaemonSessionCapabilitiesAvailable).toBe(true);
      const version = await execFile(installed!.binaryPath, ["--version"], {
        timeout: 30_000,
        maxBuffer: 256 * 1024,
        windowsHide: true,
      });
      expect(version.stdout).toContain(harness.artifacts[0]!.publication.packageVersion);

      let rollbackBuildId = harness.artifacts[0]!.publication.buildId;
      if (harness.artifacts.length === 2) {
        harness.useArtifact(1);
        const update = await harness.command({
          commandId: "graduation-update-second-preview",
          action: "update",
          channel: "preview",
          allowPreview: true,
          scheduleIfBusy: false,
        });
        expect(update).toMatchObject({
          status: "succeeded",
          buildId: harness.artifacts[1]!.publication.buildId,
        });
      } else {
        const update = await harness.command({
          commandId: "graduation-update-exact-no-op",
          action: "update",
          channel: "preview",
          allowPreview: true,
          scheduleIfBusy: false,
        });
        expect(update).toMatchObject({ status: "succeeded", buildId: rollbackBuildId });
        expect((await harness.status()).availableBuilds).toHaveLength(1);
      }

      const rollback = await harness.command({
        commandId: "graduation-explicit-rollback",
        action: "rollback",
        buildId: rollbackBuildId,
        scheduleIfBusy: false,
      });
      expect(rollback).toMatchObject({ status: "succeeded", buildId: rollbackBuildId });
      expect(harness.binding().binaryPath).toContain(rollbackBuildId);

      const stock = await harness.command({
        commandId: "graduation-use-stock",
        action: "use-stock",
        scheduleIfBusy: false,
      });
      expect(stock).toMatchObject({ status: "succeeded", buildId: null });
      expect(harness.binding().binaryPath).toBe(NodePath.resolve(stockBinaryPath!));

      const managedRoot = NodePath.join(stateDir, ...PRIME_MANAGED_TOOL_DIRECTORY.split("/"));
      const unowned = NodePath.join(managedRoot, "not-receipt-owned");
      await NodeFSP.mkdir(unowned, { mode: 0o700 });
      await NodeFSP.writeFile(NodePath.join(unowned, "sentinel"), "must remain\n", { mode: 0o600 });
      const cleanup = await harness.command({
        commandId: "graduation-cleanup",
        action: "cleanup",
      });
      expect(cleanup.status).toBe("succeeded");
      expect((await harness.status()).availableBuilds).toEqual([]);
      await expect(NodeFSP.readFile(NodePath.join(unowned, "sentinel"), "utf8")).resolves.toBe(
        "must remain\n",
      );

      const stockTarballAfter = await NodeFSP.readFile(stockTarballPath!);
      expect(digest(stockTarballAfter)).toBe(digest(stockTarballBefore));
      expect(await treeDigest(stockRoot)).toBe(stockTreeBefore);
      for (const receipt of [install, rollback, stock, cleanup]) {
        expect(JSON.stringify(receipt)).not.toContain(stateDir);
        expect(JSON.stringify(receipt)).not.toContain(artifactDirectory!);
        expect(JSON.stringify(receipt)).not.toContain(stockRoot);
      }

      const result = {
        schemaVersion: 1,
        status: "passed",
        stockVersion: "0.8.1",
        stockSha256: digest(stockTarballBefore),
        preview: harness.artifacts.map((artifact) => ({
          tag: artifact.publication.buildId,
          sequence: artifact.publication.sequence,
          sourceCommit: artifact.publication.sourceCommit,
          sourceTree: artifact.publication.sourceTree,
          rootSha256: artifact.publication.rootSha256,
          assets: artifact.assetDigests,
        })),
        cases: [
          "stock-bridge",
          "signed-preview-capability",
          "side-by-side-install",
          "preview-start",
          harness.artifacts.length === 2 ? "second-build-update" : "exact-update-no-op",
          "rollback",
          "use-stock",
          "stock-bytes-unchanged",
          "receipt-owned-cleanup",
        ],
      };
      await NodeFSP.mkdir(NodePath.dirname(resultPath!), { recursive: true });
      await NodeFSP.writeFile(
        resultPath!,
        `${JSON.stringify(result, null, 2)}
`,
        {
          mode: 0o600,
        },
      );
    } finally {
      await NodeFSP.rm(stateDir, { recursive: true, force: true });
    }
  },
  300_000,
);
