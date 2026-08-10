import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import {
  JCODE_TEXT_GENERATION_UNAVAILABLE_DETAIL,
  makeJcodeTextGeneration,
} from "./JcodeTextGeneration.ts";
import type { TextGenerationProvider } from "./TextGeneration.ts";

const modelSelection = {
  instanceId: ProviderInstanceId.make("jcode"),
  model: "claude-opus-5",
};

describe("JcodeTextGeneration", () => {
  it("keeps `jcode` a member of the text-generation provider union", () => {
    // Compile-time boundary: the registry dispatches by provider name, so the
    // union must admit `jcode` even though every operation is unavailable.
    expect("jcode" satisfies TextGenerationProvider).toBe("jcode");
  });

  it("documents why background generation is unavailable", () => {
    expect(JCODE_TEXT_GENERATION_UNAVAILABLE_DETAIL).toBe(
      "Jcode background text generation is unavailable because SDK v1 cannot disable broad host tools for structured runs.",
    );
  });

  it.effect("fails generateCommitMessage with the documented error", () =>
    Effect.gen(function* () {
      const result = yield* makeJcodeTextGeneration()
        .generateCommitMessage({
          cwd: "/tmp/project",
          branch: "main",
          stagedSummary: "one file changed",
          stagedPatch: "diff --git a/a b/a",
          modelSelection,
        })
        .pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("TextGenerationError");
        expect(result.failure.operation).toBe("generateCommitMessage");
        expect(result.failure.detail).toBe(JCODE_TEXT_GENERATION_UNAVAILABLE_DETAIL);
      }
    }),
  );

  it.effect("fails generatePrContent with the documented error", () =>
    Effect.gen(function* () {
      const result = yield* makeJcodeTextGeneration()
        .generatePrContent({
          cwd: "/tmp/project",
          baseBranch: "main",
          headBranch: "feature",
          commitSummary: "one commit",
          diffSummary: "one file changed",
          diffPatch: "diff --git a/a b/a",
          modelSelection,
        })
        .pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("TextGenerationError");
        expect(result.failure.operation).toBe("generatePrContent");
        expect(result.failure.detail).toBe(JCODE_TEXT_GENERATION_UNAVAILABLE_DETAIL);
      }
    }),
  );

  it.effect("fails generateBranchName with the documented error", () =>
    Effect.gen(function* () {
      const result = yield* makeJcodeTextGeneration()
        .generateBranchName({ cwd: "/tmp/project", message: "add a feature", modelSelection })
        .pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("TextGenerationError");
        expect(result.failure.operation).toBe("generateBranchName");
        expect(result.failure.detail).toBe(JCODE_TEXT_GENERATION_UNAVAILABLE_DETAIL);
      }
    }),
  );

  it.effect("fails generateThreadTitle with the documented error", () =>
    Effect.gen(function* () {
      const result = yield* makeJcodeTextGeneration()
        .generateThreadTitle({ cwd: "/tmp/project", message: "add a feature", modelSelection })
        .pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("TextGenerationError");
        expect(result.failure.operation).toBe("generateThreadTitle");
        expect(result.failure.detail).toBe(JCODE_TEXT_GENERATION_UNAVAILABLE_DETAIL);
      }
    }),
  );
});
