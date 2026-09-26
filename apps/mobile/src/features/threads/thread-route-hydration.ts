import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { EnvironmentShellStatus } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentThreadStatus } from "@t3tools/client-runtime/state/threads";

/**
 * Reports whether the route-local projections can still yield the requested
 * thread. Explicit terminal outcomes win over unrelated synchronization.
 */
export function threadRouteIsHydrating(input: {
  readonly isLoadingConnections: boolean;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly shellStatus: EnvironmentShellStatus;
  readonly shellHasError: boolean;
  readonly detailStatus: EnvironmentThreadStatus;
  readonly detailHasError: boolean;
}): boolean {
  if (input.detailStatus === "deleted" || input.shellHasError || input.detailHasError) {
    return false;
  }
  if (input.isLoadingConnections) {
    return true;
  }
  if (
    input.connectionState === "available" ||
    input.connectionState === "offline" ||
    input.connectionState === "error"
  ) {
    return false;
  }
  return (
    input.connectionState === "connecting" ||
    input.connectionState === "reconnecting" ||
    input.shellStatus === "synchronizing" ||
    (input.connectionState === "connected" && input.shellStatus === "empty") ||
    input.detailStatus === "synchronizing" ||
    (input.connectionState === "connected" && input.detailStatus === "empty")
  );
}

/** Picks recovery for a missing route using its authoritative outcome. */
export function threadRouteRecovery(input: {
  readonly hasEnvironmentRuntime: boolean;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly shellStatus: EnvironmentShellStatus;
  readonly detailStatus: EnvironmentThreadStatus;
  readonly detailHasError: boolean;
}): "manage-environments" | "view-threads" | "reconnect-environment" {
  if (!input.hasEnvironmentRuntime) return "manage-environments";
  if (
    input.detailStatus === "deleted" ||
    (input.connectionState === "connected" && input.shellStatus === "live" && input.detailHasError)
  ) {
    return "view-threads";
  }
  return "reconnect-environment";
}
