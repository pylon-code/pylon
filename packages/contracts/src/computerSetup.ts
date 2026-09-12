import * as Schema from "effect/Schema";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export class ComputerSetupError extends Schema.TaggedError<ComputerSetupError>()(
  "ComputerSetupError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

export const ComputerInstallation = Schema.Struct({
  status: Schema.Literals(["unknown", "missing", "ready", "broken", "unsupported"]),
  source: Schema.Literals(["system", "managed", "custom"]),
  binaryPath: Schema.NullOr(Schema.String),
  version: Schema.NullOr(Schema.String),
  message: Schema.NullOr(Schema.String),
  canManage: Schema.Boolean,
});
export type ComputerInstallation = typeof ComputerInstallation.Type;
const Grant = Schema.Literals(["granted", "missing", "unknown", "not-required"]);
export const ComputerPermissions = Schema.Struct({
  accessibility: Grant,
  screenRecording: Grant,
  capture: Schema.Literals(["verified", "unknown", "not-required"]),
  message: Schema.NullOr(Schema.String),
});
export type ComputerPermissions = typeof ComputerPermissions.Type;
export const ComputerRelease = Schema.Struct({
  version: TrimmedNonEmptyString,
  releaseUrl: Schema.String,
  assetName: Schema.String,
  sha256: Schema.String,
  bytes: NonNegativeInt,
});
export type ComputerRelease = typeof ComputerRelease.Type;
export const ComputerSetupAction = Schema.Literals([
  "check",
  "install",
  "update",
  "repair",
  "permissions",
]);
export const ComputerSetupPhase = Schema.Literals([
  "idle",
  "checking",
  "downloading",
  "extracting",
  "verifying",
  "waiting",
  "activating",
  "permissions",
  "succeeded",
  "failed",
  "cancelled",
]);
export const ComputerSetupState = Schema.Struct({
  platform: Schema.String,
  architecture: Schema.String,
  installation: ComputerInstallation,
  permissions: ComputerPermissions,
  latestRelease: Schema.NullOr(ComputerRelease),
  checkedAt: Schema.NullOr(Schema.String),
  updateMessage: Schema.NullOr(Schema.String),
  operationId: Schema.NullOr(Schema.String),
  action: Schema.NullOr(ComputerSetupAction),
  phase: ComputerSetupPhase,
  downloadedBytes: NonNegativeInt,
  totalBytes: Schema.NullOr(NonNegativeInt),
  message: Schema.NullOr(Schema.String),
});
export type ComputerSetupState = typeof ComputerSetupState.Type;
export const ComputerSetupStartInput = Schema.Union([
  Schema.Struct({
    action: Schema.Literals(["install", "update", "repair"]),
    expectedVersion: TrimmedNonEmptyString,
  }),
  Schema.Struct({ action: Schema.Literal("permissions") }),
]);
export type ComputerSetupStartInput = typeof ComputerSetupStartInput.Type;
export const ComputerSetupCancelInput = Schema.Struct({ operationId: TrimmedNonEmptyString });
export const ComputerSetupRefreshInput = Schema.Struct({
  checkUpdates: Schema.optionalKey(Schema.Boolean),
});
export function isComputerSetupRunning(phase: typeof ComputerSetupPhase.Type): boolean {
  return phase !== "idle" && phase !== "succeeded" && phase !== "failed" && phase !== "cancelled";
}

export function compareCuaVersions(a: string, b: string): number {
  for (let i = 0; i < 3; i++) {
    const difference = Number(a.split(".")[i]) - Number(b.split(".")[i]);
    if (difference) return difference;
  }
  return 0;
}
