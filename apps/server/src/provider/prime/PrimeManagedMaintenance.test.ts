import { describe, expect, it } from "vite-plus/test";

import type { PrimeManagedInstanceStatus } from "./PrimeAgentManagedToolStore.ts";
import { toPrimeManagedMaintenance } from "./PrimeManagedMaintenance.ts";

const stockStatus: PrimeManagedInstanceStatus = {
  instanceId: "primeAgent",
  mode: "stock",
  selectedBuildId: null,
  channel: null,
  availableBuilds: [],
  publicationAvailable: false,
  scheduled: null,
  operation: null,
  message: "This environment uses its stock or configured Prime Agent binary.",
};

describe("Prime managed maintenance status", () => {
  it("disables unpublished installation and gives manual-install guidance", () => {
    expect(toPrimeManagedMaintenance(stockStatus)).toMatchObject({
      supported: true,
      controlsAvailable: false,
      guidance:
        "Pylon-managed Prime builds are not published yet. Install the Pylon Prime build manually; see the Prime Agent guide.",
    });
  });

  it("restores controls when a signed publication becomes available", () => {
    expect(toPrimeManagedMaintenance({ ...stockStatus, publicationAvailable: true })).toMatchObject(
      {
        controlsAvailable: true,
        guidance: null,
      },
    );
  });

  it.each(["stock", "managed"] as const)(
    "keeps installed %s build controls available offline",
    (mode) => {
      const buildId = "pylon-build-gaaaaaaaaaaaa-r1";
      expect(
        toPrimeManagedMaintenance({
          ...stockStatus,
          mode,
          selectedBuildId: mode === "managed" ? buildId : null,
          availableBuilds: [
            {
              buildId,
              channel: "stable",
              sequence: 1,
              binaryPath: "/prime",
              packageRoot: "/package",
            },
          ],
        }),
      ).toMatchObject({ controlsAvailable: true, guidance: null });
    },
  );

  it.each(["downloading", "failed"] as const)(
    "preserves the %s receipt and host message",
    (status) => {
      const operation = {
        commandId: "install-1",
        instanceId: "primeAgent",
        action: "install" as const,
        status,
        channel: "stable" as const,
        buildId: null,
        message:
          status === "failed"
            ? "Signed feed verification failed."
            : "Downloading verified publication.",
        startedAt: "2026-09-10T00:00:00.000Z",
        finishedAt: status === "failed" ? "2026-09-10T00:01:00.000Z" : null,
      };
      const result = toPrimeManagedMaintenance({
        ...stockStatus,
        publicationAvailable: status === "failed" ? false : null,
        operation,
      });
      expect(result.operation).toEqual(operation);
      expect(result.message).toBe(stockStatus.message);
      expect(result.guidance).toBe(
        status === "failed"
          ? "Pylon-managed Prime builds are not published yet. Install the Pylon Prime build manually; see the Prime Agent guide."
          : null,
      );
    },
  );
});
