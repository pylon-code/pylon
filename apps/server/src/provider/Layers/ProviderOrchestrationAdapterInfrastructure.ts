import * as Layer from "effect/Layer";
import * as LegacyAdapterV2Maintenance from "../legacy/LegacyAdapterV2Maintenance.ts";
import * as ResetCreditCoordinator from "./resetCreditCoordinator.ts";
import * as CodexResetCredit from "./codexResetCredit.ts";

import * as ClaudeAdapterV2 from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as CodexAdapterV2 from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CursorAgentSdk from "../../orchestration-v2/Adapters/CursorAgentSdk.ts";
import * as IdAllocator from "../../orchestration-v2/IdAllocator.ts";
import * as ProviderContinuationRequests from "../../orchestration-v2/ProviderContinuationRequests.ts";

export type ProviderOrchestrationAdapterInfrastructure =
  | ClaudeAdapterV2.ClaudeAgentSdkQueryRunner
  | CodexAdapterV2.CodexAppServerClientFactory
  | CursorAgentSdk.CursorAgentSdkRunner
  | IdAllocator.IdAllocatorV2
  | LegacyAdapterV2Maintenance.LegacyAdapterV2Maintenance
  | ResetCreditCoordinator.ResetCreditCoordinator
  | CodexResetCredit.CodexResetCreditCoordinator;

/**
 * Infrastructure shared by the V2 adapters materialized inside provider
 * instances. `providerContinuationRequestsLayer` must be the same layer
 * reference the orchestration runtime provides to its continuation worker so
 * Effect layer memoization yields one shared queue.
 */
export const ProviderOrchestrationAdapterInfrastructureLive = Layer.mergeAll(
  ClaudeAdapterV2.claudeAgentSdkQueryRunnerLiveLayer,
  CodexAdapterV2.codexAppServerClientFactoryFromSettingsLayer,
  CursorAgentSdk.cursorAgentSdkRunnerLiveLayer,
  IdAllocator.layer,
  ProviderContinuationRequests.layer,
  LegacyAdapterV2Maintenance.layer,
  ResetCreditCoordinator.layer,
  CodexResetCredit.layer,
);
