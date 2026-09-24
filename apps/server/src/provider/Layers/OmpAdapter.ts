/**
 * Oh My Pi CLI (`omp acp`) adapter.
 *
 * Oh My Pi speaks the same standard ACP transport as Cursor, so all session,
 * turn, event, attachment, resume, permission, and elicitation behavior lives
 * in the shared ACP adapter factory. This module owns only Oh My Pi-specific spawn,
 * authentication, model configuration, and approval-policy choices.
 */
import { type OmpSettings, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import { applyOmpAcpModelSelection, makeOmpAcpRuntime } from "../acp/OmpAcpSupport.ts";
import type { OmpAdapterShape } from "../Services/OmpAdapter.ts";
import { makeAcpProviderAdapter, type AcpProviderAdapterLiveOptions } from "./AcpAdapter.ts";

const PROVIDER = ProviderDriverKind.make("omp");

export type OmpAdapterLiveOptions = AcpProviderAdapterLiveOptions;

export function makeOmpAdapter(ompSettings: OmpSettings, options?: OmpAdapterLiveOptions) {
  return makeAcpProviderAdapter({
    provider: PROVIDER,
    defaultInstanceId: ProviderInstanceId.make("omp"),
    displayName: "Oh My Pi",
    settings: ompSettings,
    ...(options ? { options } : {}),
    makeRuntime: ({
      settings,
      environment,
      childProcessSpawner,
      cwd,
      runtimeMode,
      resumeSessionId,
      clientInfo,
      mcpServers,
      nativeLoggers,
    }) =>
      makeOmpAcpRuntime({
        ompSettings: settings,
        ...(environment ? { environment } : {}),
        childProcessSpawner,
        cwd,
        runtimeMode,
        ...(resumeSessionId ? { resumeSessionId } : {}),
        clientInfo,
        ...(mcpServers ? { mcpServers } : {}),
        ...nativeLoggers,
      }),
    applyModelSelection: ({ runtime, threadId, model, initialModelId, selections }) =>
      applyOmpAcpModelSelection({
        runtime,
        model,
        initialModelId,
        selections,
        mapError: ({ cause, step }) =>
          mapAcpToAdapterError(
            PROVIDER,
            threadId,
            step === "set-model" ? "session/set_model" : "session/set_config_option",
            cause,
          ),
      }),
    shouldAutoApprovePermission: ({ runtimeMode, permissionKind }) =>
      (runtimeMode === "auto-accept-edits" || runtimeMode === "auto") &&
      (permissionKind === "edit" || permissionKind === "delete" || permissionKind === "move"),
    resolveModelId: (model) => model?.trim() || "default",
  }).pipe(Effect.map((adapter) => adapter satisfies OmpAdapterShape));
}
