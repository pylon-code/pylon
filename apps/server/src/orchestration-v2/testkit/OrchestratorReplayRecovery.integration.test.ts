import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as CodexReplay from "effect-codex-app-server/replay";
import {
  type OrchestrationV2StoredEvent,
  type ProviderReplayEntry,
  type ProviderReplayTranscript,
  ProviderDriverKind,
  type ThreadId,
} from "@t3tools/contracts";

import {
  ClaudeOrchestratorReplayHarness,
  makeClaudeRestartReplayHarness,
} from "../Adapters/ClaudeAdapterV2.testkit.ts";
import {
  CodexOrchestratorReplayHarness,
  makeCodexProviderAdapterRegistryReplayLayer,
} from "../Adapters/CodexAdapterV2.testkit.ts";
import {
  type CursorAgentSdkReplayTranscript,
  CursorOrchestratorReplayHarness,
  makeCursorAgentSdkReplayRunner,
  makeCursorProviderAdapterRegistryReplayLayer,
} from "../Adapters/CursorAdapterV2.testkit.ts";
import * as IdAllocator from "../IdAllocator.ts";
import * as Orchestrator from "../Orchestrator.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import { provideDeterministicTestRuntime } from "./DeterministicRuntime.ts";
import {
  CLAUDE_MODEL_SELECTION,
  CODEX_MODEL_SELECTION,
  CURSOR_MODEL_SELECTION,
  materializeFixtureInput,
  type MaterializedOrchestratorFixtureInput,
  MULTI_TURN_FIRST_PROMPT,
  MULTI_TURN_SECOND_PROMPT,
  PROVIDER_THREAD_RESUME_FIRST_PROMPT,
  PROVIDER_THREAD_RESUME_SECOND_PROMPT,
} from "./fixtures/shared.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertConversationMessageRoles,
  assertRunOrdinals,
  assertSemanticProjectionIntegrity,
  assertTurnItemTypes,
  assertUserMessagesInclude,
  projectionFor,
} from "./fixtures/shared.ts";
import { runOrchestratorV2Scenario } from "./OrchestratorScenario.ts";
import {
  makeOrchestratorV2ProviderReplayLayer,
  runOrchestratorV2ProviderReplayScenario,
} from "./ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./ReplayFixtureWorkspace.ts";
import {
  materializeReplayTranscriptRuntimeInstructions,
  materializeReplayTranscriptWorkspace,
  readProviderReplayTranscript,
} from "./ReplayTranscriptNdjson.ts";

const FIRST_FINAL = "provider thread resume fixture first turn complete";
const SECOND_FINAL = "provider thread resume fixture second turn complete";

const decodeCodexTranscript = Schema.decodeUnknownEffect(
  CodexReplay.CodexAppServerReplayTranscript,
);
const readRawTranscript = Effect.fn("readRecoveryTranscript")(function* (file: URL) {
  return yield* readProviderReplayTranscript(file);
});
const readCodexTranscript = Effect.fn("readCodexRecoveryTranscript")(function* (workspace: string) {
  const transcript = yield* readRawTranscript(
    new URL("./fixtures/provider_thread_resume/codex_transcript.ndjson", import.meta.url),
  );
  return yield* decodeCodexTranscript(materializeReplayTranscriptWorkspace(transcript, workspace));
});
const decodePromptPair = Schema.decodeUnknownEffect(Schema.Tuple([Schema.String, Schema.String]));
const readClaudeSubagentResumeTranscript = Effect.fn("readClaudeSubagentResumeTranscript")(
  function* () {
    return yield* ClaudeOrchestratorReplayHarness.decodeTranscript(
      yield* readRawTranscript(
        new URL(
          "./fixtures/claude_subagent_resume_after_restart/claude_transcript.ndjson",
          import.meta.url,
        ),
      ),
    );
  },
);
const readCursorTranscript = Effect.fn("readCursorRecoveryTranscript")(function* () {
  const transcript = yield* readRawTranscript(
    new URL("./fixtures/provider_thread_resume/cursor_transcript.ndjson", import.meta.url),
  );
  return yield* CursorOrchestratorReplayHarness.decodeTranscript(
    materializeReplayTranscriptRuntimeInstructions(transcript, {
      driver: ProviderDriverKind.make("cursor"),
      model: CURSOR_MODEL_SELECTION.model,
    }),
  );
});

function splitAfterFirstIdle(materialized: MaterializedOrchestratorFixtureInput) {
  const splitIndex = materialized.steps.findIndex((step) => step.type === "await_thread_idle");
  if (splitIndex < 0) {
    throw new Error("Expected fixture to contain await_thread_idle after the first turn.");
  }

  const phase1Steps = materialized.steps.slice(0, splitIndex + 1);
  const phase2Steps = materialized.steps.slice(splitIndex + 1);
  return {
    phase1Steps,
    phase2Steps,
    phase1Commands: phase1Steps.flatMap((step) => (step.type === "dispatch" ? [step.command] : [])),
    phase2Commands: phase2Steps.flatMap((step) => (step.type === "dispatch" ? [step.command] : [])),
  };
}

const runCursorRecovery = Effect.fn("runCursorRecovery")(function* (input: {
  readonly transcript: CursorAgentSdkReplayTranscript;
  readonly runner: ReturnType<typeof makeCursorAgentSdkReplayRunner>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tempDir = yield* Effect.acquireRelease(
    fs.makeTempDirectory({
      prefix: "t3-orchestration-v2-cursor-recovery-",
    }),
    (directory) => fs.remove(directory, { recursive: true, force: true }).pipe(Effect.orDie),
  );
  yield* fs.makeDirectory(tempDir, { recursive: true });
  const dbPath = path.join(tempDir, "state.sqlite");
  const materialized = yield* materializeFixtureInput({
    scenario: "provider_thread_resume",
    fixtureInput: {
      steps: [
        { type: "message", text: PROVIDER_THREAD_RESUME_FIRST_PROMPT },
        { type: "message", text: PROVIDER_THREAD_RESUME_SECOND_PROMPT },
      ],
    },
    driver: ProviderDriverKind.make("cursor"),
    modelSelection: CURSOR_MODEL_SELECTION,
  });
  const { phase1Commands, phase1Steps, phase2Commands, phase2Steps } =
    splitAfterFirstIdle(materialized);
  const options = {
    databaseLayer: makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer)),
  };
  const harness = {
    ...CursorOrchestratorReplayHarness,
    makeProviderAdapterRegistryLayer: () =>
      makeCursorProviderAdapterRegistryReplayLayer(input.transcript, {
        runner: input.runner,
        assertCompleteOnFinalize: false,
      }),
  };

  yield* Effect.scoped(
    runOrchestratorV2ProviderReplayScenario(
      {
        name: "provider_thread_resume/cursor:first-runtime",
        transcript: input.transcript,
        commands: phase1Commands,
        steps: phase1Steps,
        projectionThreadIds: materialized.projectionThreadIds,
        runtimePolicyOverride: { cwd: tempDir },
      },
      harness,
      options,
    ),
  );

  const result = yield* Effect.scoped(
    runOrchestratorV2ProviderReplayScenario(
      {
        name: "provider_thread_resume/cursor:second-runtime",
        transcript: input.transcript,
        commands: phase2Commands,
        steps: phase2Steps,
        projectionThreadIds: materialized.projectionThreadIds,
        runtimePolicyOverride: { cwd: tempDir },
      },
      harness,
      options,
    ),
  );

  assertBaseProjection({
    result,
    transcript: input.transcript,
    runCount: 2,
    runStatuses: ["completed", "completed"],
  });
  const projection = projectionFor(result, input.transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertRunOrdinals(projection, [1, 2]);
  assertConversationMessageRoles(projection, ["user", "assistant", "user", "assistant"]);
  assertTurnItemTypes(projection, ["user_message", "assistant_message"]);
  assertUserMessagesInclude(projection, [
    PROVIDER_THREAD_RESUME_FIRST_PROMPT,
    PROVIDER_THREAD_RESUME_SECOND_PROMPT,
  ]);
  assertAssistantTextIncludes(projection, FIRST_FINAL);
  assertAssistantTextIncludes(projection, SECOND_FINAL);
  assert.lengthOf(projection.providerThreads, 1);
});

// The recorded multi_turn Codex thread, turned into the incident from the
// pre-v2 orchestrator: Codex answers the first turn with a non-retryable
// model-at-capacity error. That orchestrator put the provider session into
// `error` and rejected every later message on the thread.
const MULTI_TURN_NATIVE_THREAD_ID = "01a0d5ed-187d-70c2-b4b6-b6881a68de09";
const MULTI_TURN_FIRST_NATIVE_TURN_ID = "01a0d5ed-1957-7a22-8399-d0172af342fd";
const MULTI_TURN_FIRST_AGENT_MESSAGE_ID = "msg_06900ecb02a780a6016ab5bdbcd76887d0ba52ca8fee9da2e1";
const CODEX_MODEL_AT_CAPACITY_MESSAGE =
  "Selected model is at capacity. Please try a different model.";
const CODEX_MODEL_AT_CAPACITY_ERROR = {
  message: CODEX_MODEL_AT_CAPACITY_MESSAGE,
  codexErrorInfo: "serverOverloaded",
  additionalDetails: null,
};

function failFirstMultiTurnAtModelCapacity(
  transcript: ProviderReplayTranscript,
): ProviderReplayTranscript {
  const entries: Array<ProviderReplayEntry> = [];
  for (const entry of transcript.entries) {
    if (entry.type !== "emit_inbound") {
      entries.push(entry);
      continue;
    }
    const frame = JSON.stringify(entry.frame);
    if (entry.label === "turn/completed" && frame.includes(MULTI_TURN_FIRST_NATIVE_TURN_ID)) {
      entries.push(
        {
          type: "emit_inbound",
          label: "error",
          frame: {
            method: "error",
            params: {
              threadId: MULTI_TURN_NATIVE_THREAD_ID,
              turnId: MULTI_TURN_FIRST_NATIVE_TURN_ID,
              willRetry: false,
              error: CODEX_MODEL_AT_CAPACITY_ERROR,
            },
          },
        },
        {
          type: "emit_inbound",
          label: "turn/completed",
          frame: {
            method: "turn/completed",
            params: {
              threadId: MULTI_TURN_NATIVE_THREAD_ID,
              turn: {
                id: MULTI_TURN_FIRST_NATIVE_TURN_ID,
                items: [],
                itemsView: "summary",
                status: "failed",
                error: CODEX_MODEL_AT_CAPACITY_ERROR,
                startedAt: 1790295480,
                completedAt: 1790295485,
                durationMs: 4550,
              },
            },
          },
        },
      );
      continue;
    }
    // The capacity failure produced no answer for the first turn.
    if (frame.includes(MULTI_TURN_FIRST_AGENT_MESSAGE_ID)) continue;
    entries.push(entry);
  }
  return { ...transcript, scenario: "codex_model_at_capacity", entries };
}

const isProviderSessionError = (stored: OrchestrationV2StoredEvent) =>
  stored.event.type === "provider-session.updated" && stored.event.payload.status === "error";

/**
 * Receipt that the session manager released the provider session as
 * `runtime_error`: the stored-event stream replays from genesis, then tails.
 */
const awaitProviderSessionError = Effect.fn("awaitProviderSessionError")(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const stored = yield* orchestrator.streamStoredEvents.pipe(
    Stream.filter(isProviderSessionError),
    Stream.runHead,
  );
  if (Option.isNone(stored)) {
    return yield* Effect.die(
      new Error("The stored-event stream ended before the provider session failed."),
    );
  }
  return stored.value;
});

const providerSessionStatuses = Effect.fn("providerSessionStatuses")(function* (
  threadId: ThreadId,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projection = yield* orchestrator.getThreadProjection(threadId);
  return projection.providerSessions.map((session) => session.status);
});

/** Session opens and failures, in order; the recording's final app-server exit may add one more. */
function providerSessionLifecycle(result: Parameters<typeof projectionFor>[0]) {
  return result.domainEvents.flatMap((event) =>
    event.type === "provider-session.attached"
      ? ["attached"]
      : event.type === "provider-session.updated" && event.payload.status === "error"
        ? ["error"]
        : [],
  );
}

function assertResumedAfterSessionError(
  result: Parameters<typeof projectionFor>[0],
  transcript: CodexReplay.CodexAppServerReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 2,
    runStatuses: ["completed", "completed"],
  });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertRunOrdinals(projection, [1, 2]);
  assertUserMessagesInclude(projection, [
    PROVIDER_THREAD_RESUME_FIRST_PROMPT,
    PROVIDER_THREAD_RESUME_SECOND_PROMPT,
  ]);
  assertAssistantTextIncludes(projection, FIRST_FINAL);
  assertAssistantTextIncludes(projection, SECOND_FINAL);
  // Both runs ran on the one native Codex thread the reopened session resumed.
  assert.lengthOf(projection.providerThreads, 1);
  const providerThreadIds = new Set(projection.runs.map((run) => run.providerThreadId));
  assert.deepEqual([...providerThreadIds], [projection.providerThreads[0]?.id]);
  // The follow-up opened a second app-server for the session after the first
  // one's failure was recorded.
  assert.deepEqual(providerSessionLifecycle(result).slice(0, 3), ["attached", "error", "attached"]);
}

describe("orchestrator replay recovery", () => {
  it.effect(
    "resumes a provider-native Codex thread after recreating the orchestrator runtime",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          // Checkpoint against a throwaway git workspace: with no override the
          // scope cwd falls back to process.cwd(), and a cold full-repo
          // baseline capture on CI outlives the scenario wait budget.
          const workspace = yield* checkpointWorkspace("provider_thread_resume");
          const transcript = yield* readCodexTranscript(workspace);
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tempDir = yield* Effect.acquireRelease(
            fs.makeTempDirectory({
              prefix: "t3-orchestration-v2-recovery-",
            }),
            (directory) =>
              fs.remove(directory, { recursive: true, force: true }).pipe(Effect.orDie),
          );
          yield* fs.makeDirectory(tempDir, { recursive: true });
          const dbPath = path.join(tempDir, "state.sqlite");
          const driver = yield* CodexReplay.makeReplayDriver(transcript);
          const materialized = yield* materializeFixtureInput({
            scenario: "provider_thread_resume",
            fixtureInput: {
              steps: [
                { type: "message", text: PROVIDER_THREAD_RESUME_FIRST_PROMPT },
                { type: "message", text: PROVIDER_THREAD_RESUME_SECOND_PROMPT },
              ],
            },
            driver: ProviderDriverKind.make("codex"),
            modelSelection: CODEX_MODEL_SELECTION,
          });
          const { phase1Commands, phase1Steps, phase2Commands, phase2Steps } =
            splitAfterFirstIdle(materialized);

          const harness = {
            ...CodexOrchestratorReplayHarness,
            makeProviderAdapterRegistryLayer: () =>
              makeCodexProviderAdapterRegistryReplayLayer({ transcript, driver }),
          };
          const options = {
            databaseLayer: makeSqlitePersistenceLive(dbPath).pipe(
              Layer.provide(NodeServices.layer),
            ),
          };

          yield* runOrchestratorV2ProviderReplayScenario(
            {
              name: "provider_thread_resume/codex:first-runtime",
              transcript,
              commands: phase1Commands,
              steps: phase1Steps,
              projectionThreadIds: materialized.projectionThreadIds,
              runtimePolicyOverride: { cwd: workspace },
            },
            harness,
            options,
          );

          const result = yield* runOrchestratorV2ProviderReplayScenario(
            {
              name: "provider_thread_resume/codex:second-runtime",
              transcript,
              commands: phase2Commands,
              steps: phase2Steps,
              projectionThreadIds: materialized.projectionThreadIds,
              runtimePolicyOverride: { cwd: workspace },
            },
            harness,
            options,
          );

          assertBaseProjection({
            result,
            transcript,
            runCount: 2,
            runStatuses: ["completed", "completed"],
          });
          const projection = projectionFor(result, transcript.scenario);
          assertSemanticProjectionIntegrity(projection);
          assertRunOrdinals(projection, [1, 2]);
          assertConversationMessageRoles(projection, ["user", "assistant", "user", "assistant"]);
          assertTurnItemTypes(projection, ["user_message", "assistant_message"]);
          assertUserMessagesInclude(projection, [
            PROVIDER_THREAD_RESUME_FIRST_PROMPT,
            PROVIDER_THREAD_RESUME_SECOND_PROMPT,
          ]);
          assertAssistantTextIncludes(projection, FIRST_FINAL);
          assertAssistantTextIncludes(projection, SECOND_FINAL);
          assert.lengthOf(projection.providerThreads, 1);
        }).pipe(
          provideDeterministicTestRuntime,
          Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer)),
        ),
      ),
  );

  it.effect(
    "resumes a provider-native Cursor thread after recreating the orchestrator runtime",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const transcript = yield* readCursorTranscript();
          const runner = makeCursorAgentSdkReplayRunner(transcript);
          yield* runCursorRecovery({ transcript, runner });
          yield* runner.assertComplete;
        }).pipe(
          provideDeterministicTestRuntime,
          Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer)),
        ),
      ),
  );
  it.effect("keeps a Claude subagent resumed after a server restart in its own thread", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // The math.ts subagent from thread 42e302f0 (2026-09-25): launched,
        // finished, then resumed by SendMessage after the server restarted.
        const transcript = yield* readClaudeSubagentResumeTranscript();
        const [launchPrompt, resumePrompt] = yield* decodePromptPair(transcript.metadata?.prompts);
        const workspace = yield* checkpointWorkspace(transcript.scenario);
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* Effect.acquireRelease(
          fs.makeTempDirectory({ prefix: "t3-orchestration-v2-claude-recovery-" }),
          (directory) => fs.remove(directory, { recursive: true, force: true }).pipe(Effect.orDie),
        );
        const materialized = yield* materializeFixtureInput({
          scenario: transcript.scenario,
          fixtureInput: {
            steps: [
              { type: "message", text: launchPrompt },
              { type: "message", text: resumePrompt },
            ],
          },
          driver: ProviderDriverKind.make("claudeAgent"),
          modelSelection: CLAUDE_MODEL_SELECTION,
        });
        const { phase1Commands, phase1Steps, phase2Commands, phase2Steps } =
          splitAfterFirstIdle(materialized);
        const { harness, assertComplete } = makeClaudeRestartReplayHarness(transcript);
        const options = {
          databaseLayer: makeSqlitePersistenceLive(path.join(tempDir, "state.sqlite")).pipe(
            Layer.provide(NodeServices.layer),
          ),
        };

        yield* Effect.scoped(
          runOrchestratorV2ProviderReplayScenario(
            {
              name: `${transcript.scenario}:first-runtime`,
              transcript,
              commands: phase1Commands,
              steps: phase1Steps,
              projectionThreadIds: materialized.projectionThreadIds,
              runtimePolicyOverride: { cwd: workspace },
            },
            harness,
            options,
          ),
        );
        const result = yield* Effect.scoped(
          runOrchestratorV2ProviderReplayScenario(
            {
              name: `${transcript.scenario}:second-runtime`,
              transcript,
              commands: phase2Commands,
              steps: phase2Steps,
              projectionThreadIds: materialized.projectionThreadIds,
              runtimePolicyOverride: { cwd: workspace },
            },
            harness,
            options,
          ),
        );
        yield* assertComplete;

        const projection = projectionFor(result, transcript.scenario);
        assertSemanticProjectionIntegrity(projection);
        assert.lengthOf(projection.subagents, 1);
        const subagent = projection.subagents[0];
        assert.equal(subagent?.status, "completed");
        const childThreads = [...result.projections.values()].filter(
          (candidate) => candidate.thread.lineage.parentThreadId === projection.thread.id,
        );
        assert.lengthOf(childThreads, 1);
        const child = childThreads[0];
        assert.equal(child?.thread.id, subagent?.childThreadId);

        const conversation = (child?.turnItems ?? [])
          .toSorted((left, right) => left.ordinal - right.ordinal)
          .flatMap((item) =>
            item.type === "user_message" || item.type === "assistant_message"
              ? [`${item.type === "user_message" ? "user" : "assistant"}:${item.text}`]
              : [],
          );
        const launchTask = conversation[0];
        assert.deepEqual(
          conversation.map((entry) => entry.slice(0, entry.indexOf(":"))),
          ["user", "assistant", "user", "assistant"],
        );
        assert.include(launchTask, "Your job is just the file");
        assert.include(conversation[1], "is 1 line long");
        assert.include(conversation[2], "Look again at");
        assert.include(conversation[3], "Bug/edge case found and fixed");
        // The resumed run's own tool calls land in the child thread too.
        const childCommands = (child?.turnItems ?? []).filter(
          (item) => item.type === "command_execution",
        );
        assert.lengthOf(childCommands, 3);
        assert.isFalse(
          projection.turnItems.some(
            (item) =>
              item.type === "assistant_message" && item.text.includes("Bug/edge case found"),
          ),
          "the resumed subagent's reply leaked into the parent thread",
        );
      }).pipe(
        provideDeterministicTestRuntime,
        Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer)),
      ),
    ),
  );

  it.effect(
    "starts the next Codex turn on the same native thread after a model-at-capacity failure",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const workspace = yield* checkpointWorkspace("codex_model_at_capacity");
          const recorded = yield* readRawTranscript(
            new URL("./fixtures/multi_turn/codex_transcript.ndjson", import.meta.url),
          );
          const transcript = yield* CodexOrchestratorReplayHarness.decodeTranscript(
            materializeReplayTranscriptWorkspace(
              failFirstMultiTurnAtModelCapacity(recorded),
              workspace,
            ),
          );
          const driver = yield* CodexReplay.makeReplayDriver(transcript);
          const materialized = yield* materializeFixtureInput({
            scenario: transcript.scenario,
            fixtureInput: {
              steps: [
                { type: "message", text: MULTI_TURN_FIRST_PROMPT },
                { type: "message", text: MULTI_TURN_SECOND_PROMPT },
              ],
            },
            driver: ProviderDriverKind.make("codex"),
            modelSelection: CODEX_MODEL_SELECTION,
          });

          const result = yield* runOrchestratorV2ProviderReplayScenario(
            {
              name: "codex_model_at_capacity/codex",
              transcript,
              commands: materialized.commands,
              steps: materialized.steps,
              projectionThreadIds: materialized.projectionThreadIds,
              runtimePolicyOverride: { cwd: workspace },
            },
            {
              ...CodexOrchestratorReplayHarness,
              makeProviderAdapterRegistryLayer: () =>
                makeCodexProviderAdapterRegistryReplayLayer({ transcript, driver }),
            },
          );

          // The follow-up was accepted and ran: the transcript expects its
          // turn/start on the original native thread, with no new
          // thread/start or thread/resume in between.
          assert.deepEqual(yield* Ref.get(driver.state), {
            cursor: transcript.entries.length,
            failure: null,
          });
          assertBaseProjection({
            result,
            transcript,
            runCount: 2,
            runStatuses: ["failed", "completed"],
          });
          const projection = projectionFor(result, transcript.scenario);
          assertSemanticProjectionIntegrity(projection);
          assertRunOrdinals(projection, [1, 2]);
          assertUserMessagesInclude(projection, [
            MULTI_TURN_FIRST_PROMPT,
            MULTI_TURN_SECOND_PROMPT,
          ]);
          const [failedRun, recoveredRun] = projection.runs;
          const errorItem = projection.turnItems.find(
            (item) => item.runId === failedRun?.id && item.type === "error",
          );
          if (errorItem?.type !== "error") {
            return yield* Effect.die(new Error("expected an error item on the failed run"));
          }
          assert.equal(errorItem.failure.message, CODEX_MODEL_AT_CAPACITY_MESSAGE);
          assert.equal(errorItem.failure.class, "provider_error");
          assert.deepEqual(
            projection.turnItems.flatMap((item) =>
              item.runId === recoveredRun?.id && item.type === "assistant_message"
                ? [item.text]
                : [],
            ),
            ["second fixture turn complete"],
          );
          assert.lengthOf(projection.providerThreads, 1);
          assert.equal(failedRun?.providerThreadId, projection.providerThreads[0]?.id);
          assert.equal(recoveredRun?.providerThreadId, failedRun?.providerThreadId);
          // A turn failure leaves the provider session usable: the follow-up
          // reused the one app-server instead of reopening the session.
          assert.deepEqual(providerSessionLifecycle(result).slice(0, 1), ["attached"]);
          assert.notInclude(providerSessionLifecycle(result).slice(1), "attached");
        }).pipe(
          provideDeterministicTestRuntime,
          Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer)),
        ),
      ),
  );

  it.effect(
    "reopens an errored Codex session and resumes the native thread for the next message",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const workspace = yield* checkpointWorkspace("provider_thread_resume");
          const transcript = yield* readCodexTranscript(workspace);
          // The recording's first app-server exits after the first turn; its
          // event stream dies under the live session, which the session
          // manager releases as runtime_error.
          const driver = yield* CodexReplay.makeReplayDriver(transcript);
          const materialized = yield* materializeFixtureInput({
            scenario: "provider_thread_resume",
            fixtureInput: {
              steps: [
                { type: "message", text: PROVIDER_THREAD_RESUME_FIRST_PROMPT },
                { type: "message", text: PROVIDER_THREAD_RESUME_SECOND_PROMPT },
              ],
            },
            driver: ProviderDriverKind.make("codex"),
            modelSelection: CODEX_MODEL_SELECTION,
          });
          const threadId = materialized.projectionThreadIds[0];
          assert.isDefined(threadId);
          const { phase1Commands, phase1Steps, phase2Commands, phase2Steps } =
            splitAfterFirstIdle(materialized);
          const scenario = {
            name: "provider_thread_resume/codex:session-error",
            transcript,
            commands: materialized.commands,
            projectionThreadIds: materialized.projectionThreadIds,
            runtimePolicyOverride: { cwd: workspace },
          };
          const layer = makeOrchestratorV2ProviderReplayLayer(scenario, {
            ...CodexOrchestratorReplayHarness,
            makeProviderAdapterRegistryLayer: () =>
              makeCodexProviderAdapterRegistryReplayLayer({ transcript, driver }),
          });

          const result = yield* Effect.gen(function* () {
            yield* runOrchestratorV2Scenario({
              ...scenario,
              commands: phase1Commands,
              steps: phase1Steps,
            });
            yield* awaitProviderSessionError();
            assert.deepEqual(yield* providerSessionStatuses(threadId), ["error"]);
            return yield* runOrchestratorV2Scenario({
              ...scenario,
              commands: phase2Commands,
              steps: phase2Steps,
            });
          }).pipe(Effect.provide(layer));

          // The second app-server consumed initialize, thread/resume and the
          // follow-up turn: the transcript ran to its end without a mismatch.
          assert.deepEqual(yield* Ref.get(driver.state), {
            cursor: transcript.entries.length,
            failure: null,
          });
          assertResumedAfterSessionError(result, transcript);
        }).pipe(
          provideDeterministicTestRuntime,
          Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer)),
        ),
      ),
  );

  it.effect(
    "reopens a Codex session persisted as error across a restart and resumes the native thread",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const workspace = yield* checkpointWorkspace("provider_thread_resume");
          const transcript = yield* readCodexTranscript(workspace);
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tempDir = yield* Effect.acquireRelease(
            fs.makeTempDirectory({ prefix: "t3-orchestration-v2-session-error-recovery-" }),
            (directory) =>
              fs.remove(directory, { recursive: true, force: true }).pipe(Effect.orDie),
          );
          const driver = yield* CodexReplay.makeReplayDriver(transcript);
          const materialized = yield* materializeFixtureInput({
            scenario: "provider_thread_resume",
            fixtureInput: {
              steps: [
                { type: "message", text: PROVIDER_THREAD_RESUME_FIRST_PROMPT },
                { type: "message", text: PROVIDER_THREAD_RESUME_SECOND_PROMPT },
              ],
            },
            driver: ProviderDriverKind.make("codex"),
            modelSelection: CODEX_MODEL_SELECTION,
          });
          const threadId = materialized.projectionThreadIds[0];
          assert.isDefined(threadId);
          const { phase1Commands, phase1Steps, phase2Commands, phase2Steps } =
            splitAfterFirstIdle(materialized);
          const harness = {
            ...CodexOrchestratorReplayHarness,
            makeProviderAdapterRegistryLayer: () =>
              makeCodexProviderAdapterRegistryReplayLayer({ transcript, driver }),
          };
          const databaseLayer = makeSqlitePersistenceLive(path.join(tempDir, "state.sqlite")).pipe(
            Layer.provide(NodeServices.layer),
          );
          const scenario = {
            transcript,
            projectionThreadIds: materialized.projectionThreadIds,
            runtimePolicyOverride: { cwd: workspace },
          };

          const firstRuntime = {
            ...scenario,
            name: "provider_thread_resume/codex:errored-runtime",
            commands: phase1Commands,
            steps: phase1Steps,
          };
          yield* Effect.gen(function* () {
            yield* runOrchestratorV2Scenario(firstRuntime);
            yield* awaitProviderSessionError();
          }).pipe(
            Effect.provide(
              makeOrchestratorV2ProviderReplayLayer(firstRuntime, harness, { databaseLayer }),
            ),
            Effect.scoped,
          );

          const secondRuntime = {
            ...scenario,
            name: "provider_thread_resume/codex:after-restart",
            commands: phase2Commands,
            steps: phase2Steps,
          };
          const result = yield* Effect.gen(function* () {
            // Startup recovery keeps the failed session's persisted status.
            assert.deepEqual(yield* providerSessionStatuses(threadId), ["error"]);
            return yield* runOrchestratorV2Scenario(secondRuntime);
          }).pipe(
            Effect.provide(
              makeOrchestratorV2ProviderReplayLayer(secondRuntime, harness, {
                databaseLayer,
                recoverOnStartup: true,
              }),
            ),
            Effect.scoped,
          );

          assert.deepEqual(yield* Ref.get(driver.state), {
            cursor: transcript.entries.length,
            failure: null,
          });
          assertResumedAfterSessionError(result, transcript);
        }).pipe(
          provideDeterministicTestRuntime,
          Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer)),
        ),
      ),
  );
});
