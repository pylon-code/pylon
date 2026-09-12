import type { EnvironmentId, OrchestrationMessageContext } from "@t3tools/contracts";
import { serializeComposerMessageForServer, uploadedComposerContext } from "../lib/composerContext";
import { appAtomRegistry } from "./atom-registry";
import { serverEnvironment } from "./server";

/** An offline queue retains context; the current destination decides its wire form at delivery. */
export function serializeComposerMessageForEnvironment(input: {
  readonly environmentId: EnvironmentId;
  readonly text: string;
  readonly context?: OrchestrationMessageContext;
  readonly draftAttachments: ReadonlyArray<{ readonly id: string }>;
  readonly uploadedAttachments: ReadonlyArray<{ readonly id?: string }>;
}) {
  return serializeComposerMessageForServer(
    input.text,
    uploadedComposerContext(input.context, input.draftAttachments, input.uploadedAttachments),
    appAtomRegistry.get(serverEnvironment.configValueAtom(input.environmentId))?.environment
      .capabilities.inlineMessageContext === true,
  );
}
