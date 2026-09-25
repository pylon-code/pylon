import type { EnvironmentId } from "@t3tools/contracts";

/** Device setup is a command on each selected environment, not on the display representative. */
export async function configureSelectedDeviceEnvironments(
  environments: ReadonlyArray<{
    environmentId: EnvironmentId;
    label: string;
    connected: boolean;
    loaded: boolean;
  }>,
  input: { enabled?: boolean; agentAccessEnabled?: boolean },
  configure: (
    environmentId: EnvironmentId,
    input: { enabled?: boolean; agentAccessEnabled?: boolean; onboardingCompleted?: boolean },
  ) => Promise<boolean>,
): Promise<ReadonlyArray<string>> {
  const results = await Promise.allSettled(
    environments.map(async (environment) => {
      if (!environment.connected || !environment.loaded) return false;
      return configure(environment.environmentId, {
        ...input,
        ...(input.enabled ? { onboardingCompleted: true } : {}),
      });
    }),
  );
  return environments.flatMap((environment, index) => {
    const result = results[index];
    return result?.status !== "fulfilled" || result.value !== true ? [environment.label] : [];
  });
}
