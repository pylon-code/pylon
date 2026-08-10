import { TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as TextGeneration from "./TextGeneration.ts";

/**
 * Background generation runs a structured prompt and expects only text back.
 * Jcode SDK v1 cannot disable its broad host tool surface for such a run, so a
 * "just write a commit message" request could edit the working tree instead.
 */
export const JCODE_TEXT_GENERATION_UNAVAILABLE_DETAIL =
  "Jcode background text generation is unavailable because SDK v1 cannot disable broad host tools for structured runs.";

type JcodeTextGenerationOperation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

const unavailable = <A>(
  operation: JcodeTextGenerationOperation,
): Effect.Effect<A, TextGenerationError> =>
  Effect.fail(
    new TextGenerationError({
      operation,
      detail: JCODE_TEXT_GENERATION_UNAVAILABLE_DETAIL,
    }),
  );

/**
 * Keep the unsupported boundary typed so selecting a Jcode instance for
 * source-control writing fails predictably instead of falling through to a
 * different provider.
 */
export function makeJcodeTextGeneration(): TextGeneration.TextGeneration["Service"] {
  return TextGeneration.TextGeneration.of({
    generateCommitMessage: () => unavailable("generateCommitMessage"),
    generatePrContent: () => unavailable("generatePrContent"),
    generateBranchName: () => unavailable("generateBranchName"),
    generateThreadTitle: () => unavailable("generateThreadTitle"),
  });
}
