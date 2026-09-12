import {
  DEFAULT_SERVER_SETTINGS,
  EventId,
  ProjectId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { ServerActivation } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import * as ProjectSettingsReactor from "./ProjectSettingsReactor.ts";

it.effect("buffers legacy edits across activation and drains only meaningful settings events", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<OrchestrationEvent>();
      const activation = yield* Deferred.make<void>();
      const receipts = yield* Queue.unbounded<void>();
      let updates = 0;
      const dependencies = Layer.mergeAll(
        Layer.mock(OrchestrationEngineService)({
          subscribeDomainEvents: PubSub.subscribe(events).pipe(Effect.map(Stream.fromSubscription)),
        }),
        Layer.mock(ServerSettingsService)({
          updateSettings: () =>
            Effect.sync(() => {
              updates += 1;
            }).pipe(
              Effect.andThen(Queue.offer(receipts, undefined)),
              Effect.as(DEFAULT_SERVER_SETTINGS),
            ),
        }),
        Layer.succeed(ServerActivation, Deferred.await(activation)),
      );
      yield* Effect.gen(function* () {
        const reactor = yield* ProjectSettingsReactor.ProjectSettingsReactor;
        yield* reactor.start();
        const base = {
          eventId: EventId.make("legacy-edit"),
          aggregateKind: "project" as const,
          aggregateId: ProjectId.make("project"),
          occurredAt: "2026-09-12T00:00:00.000Z",
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
        };
        yield* PubSub.publish(events, {
          ...base,
          sequence: 1,
          type: "project.meta-updated",
          payload: { projectId: base.aggregateId, title: "Renamed", updatedAt: base.occurredAt },
        });
        yield* PubSub.publish(events, {
          ...base,
          sequence: 2,
          type: "project.meta-updated",
          payload: { projectId: base.aggregateId, scripts: [], updatedAt: base.occurredAt },
        });
        assert.equal(updates, 0);
        yield* Deferred.succeed(activation, undefined);
        yield* Queue.take(receipts);
        yield* reactor.drain;
        assert.equal(updates, 1);
      }).pipe(Effect.provide(ProjectSettingsReactor.layer.pipe(Layer.provide(dependencies))));
    }),
  ),
);
