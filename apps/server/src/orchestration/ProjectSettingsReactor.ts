import type { OrchestrationEvent } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { forkParked } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";

export class ProjectSettingsReactor extends Context.Service<
  ProjectSettingsReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/ProjectSettingsReactor") {}

/** Old clients write the project aggregate; the settings service replays its durable journal. */
export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const settings = yield* ServerSettingsService;
  const worker = yield* makeDrainableWorker((_event: OrchestrationEvent) =>
    settings.updateSettings({}).pipe(
      Effect.asVoid,
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("legacy project settings synchronization failed", {
              cause: Cause.pretty(cause),
            }),
      ),
    ),
  );
  const start = Effect.fn("ProjectSettingsReactor.start")(function* () {
    const events = yield* engine.subscribeDomainEvents;
    yield* forkParked(
      Stream.runForEach(events, (event) => {
        if (
          event.type === "project.created" ||
          (event.type === "project.meta-updated" &&
            (event.payload.defaultModelSelection !== undefined ||
              event.payload.defaultThreadEnvMode !== undefined ||
              event.payload.autoPull !== undefined ||
              event.payload.scripts !== undefined))
        ) {
          return worker.enqueue(event);
        }
        return Effect.void;
      }),
    );
  });
  return { start, drain: worker.drain } satisfies ProjectSettingsReactor["Service"];
});

export const layer = Layer.effect(ProjectSettingsReactor, make);
