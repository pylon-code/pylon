import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";

import { rollbackBusyProviderInstanceIds } from "./providerRollbackMutation";

const environmentId = EnvironmentId.make("environment-active");
const otherEnvironmentId = EnvironmentId.make("environment-other");
const busy = ProviderInstanceId.make("primeAgent-work");
const unrelated = ProviderInstanceId.make("codex");

describe("rollback provider mutation ownership", () => {
  it("returns only exact provider instances owned by active rollback threads", () => {
    const result = rollbackBusyProviderInstanceIds(
      [
        {
          environmentId,
          rollbackStatus: {
            state: "manual-recovery",
            updatedAt: "2026-08-31T12:00:00.000Z",
          },
          modelSelection: { instanceId: unrelated },
          session: { providerInstanceId: busy },
        },
        {
          environmentId,
          rollbackStatus: {
            state: "completed",
            updatedAt: "2026-08-31T12:00:00.000Z",
          },
          modelSelection: { instanceId: unrelated },
        },
        {
          environmentId: otherEnvironmentId,
          rollbackStatus: { state: "recovering", updatedAt: "2026-08-31T12:00:00.000Z" },
          modelSelection: { instanceId: unrelated },
        },
      ],
      environmentId,
    );

    expect([...result]).toEqual([busy]);
    expect(result.has(unrelated)).toBe(false);
  });
});
