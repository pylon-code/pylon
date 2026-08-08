import { TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as TextGeneration from "./TextGeneration.ts";

type PrimeAgentTextGenerationOperation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

const unavailable = <A>(
  operation: PrimeAgentTextGenerationOperation,
): Effect.Effect<A, TextGenerationError> =>
  Effect.fail(
    new TextGenerationError({
      operation,
      detail: "Prime Agent does not support background text generation in Early Access.",
    }),
  );

/**
 * Prime Agent sessions are currently exposed only through the interactive ACP
 * adapter. Keep the unsupported boundary typed so selecting this instance for
 * source-control writing fails predictably instead of falling through to a
 * different provider.
 */
export function makePrimeAgentTextGeneration(): TextGeneration.TextGeneration["Service"] {
  return TextGeneration.TextGeneration.of({
    generateCommitMessage: () => unavailable("generateCommitMessage"),
    generatePrContent: () => unavailable("generatePrContent"),
    generateBranchName: () => unavailable("generateBranchName"),
    generateThreadTitle: () => unavailable("generateThreadTitle"),
  });
}
