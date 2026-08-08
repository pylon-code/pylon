import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import { makePrimeAgentTextGeneration } from "./PrimeAgentTextGeneration.ts";

it.effect("Prime Agent text generation fails with a typed unavailable error", () =>
  Effect.gen(function* () {
    const service = makePrimeAgentTextGeneration();
    const result = yield* service
      .generateThreadTitle({
        cwd: "/tmp/project",
        message: "Implement the feature",
        modelSelection: {
          instanceId: ProviderInstanceId.make("primeAgent"),
          model: "default",
        },
      })
      .pipe(Effect.result);

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure._tag).toBe("TextGenerationError");
      expect(result.failure.operation).toBe("generateThreadTitle");
      expect(result.failure.detail).toContain("does not support background text generation");
    }
  }),
);
