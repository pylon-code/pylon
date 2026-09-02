import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  PrimeAgentSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import { primeAgentCredentialFingerprint, readPrimeAgentBackends } from "../primeAgentBackends.ts";
import {
  acquireSharedUsageLock,
  readSharedUsageEntry,
  releaseSharedUsageLock,
  sharedUsageReadKey,
} from "../sharedUsageReadCache.ts";
import {
  applyPrimeAgentDistribution,
  buildInitialPrimeAgentProviderSnapshot,
  checkPrimeAgentProviderStatus,
  parsePrimeAgentModelDiscoveryOutput,
  primeAgentModelsFromSettings,
  primeAgentServerModelsFromDiscoveredModels,
  reconcilePrimeAgentDaemonCatalogSnapshot,
  stampPrimeAgentBackendSnapshot,
} from "./PrimeAgentProvider.ts";

const decodeSettings = Schema.decodeSync(PrimeAgentSettings);

const encoder = new TextEncoder();

function mockProcess(input: {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly onStdin?: (chunk: string) => void;
}) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(input.exitCode ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.forEach((chunk: Uint8Array) =>
      Effect.sync(() => input.onStdin?.(Buffer.from(chunk).toString("utf8"))),
    ),
    stdout: Stream.make(encoder.encode(input.stdout ?? "")),
    stderr: Stream.make(encoder.encode(input.stderr ?? "")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function mockPrimeAgentSpawner(input: {
  readonly rpcOutput: string;
  readonly calls: Array<{
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly cwd?: string;
  }>;
  readonly stdin: string[];
  readonly rpcExitCode?: number;
}) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const childProcess = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
        readonly options: { readonly cwd?: string };
      };
      input.calls.push({
        command: childProcess.command,
        args: childProcess.args,
        ...(childProcess.options.cwd ? { cwd: childProcess.options.cwd } : {}),
      });
      return Effect.succeed(
        childProcess.args.length === 1 && childProcess.args[0] === "--version"
          ? mockProcess({ stdout: "prime-agent 0.7.1\n" })
          : mockProcess({
              stdout: input.rpcOutput,
              ...(input.rpcExitCode !== undefined ? { exitCode: input.rpcExitCode } : {}),
              onStdin: (chunk) => {
                input.stdin.push(chunk);
              },
            }),
      );
    }),
  );
}

describe("PrimeAgentProvider distribution", () => {
  it("keeps runtime readiness independent and maps only signed build identity to advisory", () => {
    const snapshot: ServerProvider = {
      instanceId: ProviderInstanceId.make("primeAgent"),
      driver: ProviderDriverKind.make("primeAgent"),
      enabled: true,
      installed: true,
      version: "0.8.1",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-08-20T12:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    };
    const result = applyPrimeAgentDistribution(snapshot, {
      classification: "pylon-managed",
      channel: "preview",
      buildId: "pylon-build-g0123456789ab-r1",
      sequence: 9,
      latestBuildId: "pylon-build-gabcdef012345-r1",
      latestSequence: 10,
      updateAvailable: true,
      checkedAt: "2026-08-20T12:00:00.000Z",
      message: "A signed preview build is available.",
    });

    expect(result.status).toBe("ready");
    expect(result.version).toBe("0.8.1");
    expect(result.versionAdvisory).toMatchObject({
      status: "behind_latest",
      currentVersion: "pylon-build-g0123456789ab-r1",
      latestVersion: "pylon-build-gabcdef012345-r1",
      canUpdate: false,
      updateCommand: null,
    });
  });
});

describe("PrimeAgentProvider models", () => {
  it("always publishes the synthetic default model before unique custom models", () => {
    expect(
      primeAgentModelsFromSettings(["custom-one", "default", " custom-two "]).map((model) => ({
        slug: model.slug,
        name: model.name,
        isCustom: model.isCustom,
      })),
    ).toEqual([
      { slug: "default", name: "Prime Agent Default", isCustom: false },
      { slug: "custom-one", name: "custom-one", isCustom: true },
      { slug: "custom-two", name: "custom-two", isCustom: true },
    ]);
  });

  it("Schema-decodes the matching RPC success response into canonical provider/model refs", () => {
    const models = parsePrimeAgentModelDiscoveryOutput(
      [
        "not json",
        JSON.stringify({
          id: "unrelated-request",
          type: "response",
          command: "get_available_models",
          success: true,
          data: { models: [] },
        }),
        JSON.stringify({
          id: "pylon-prime-agent-models",
          type: "response",
          command: "get_available_models",
          success: true,
          data: {
            models: [
              {
                provider: "prime-inference",
                id: "anthropic/claude-fable-5",
                name: "Claude Fable 5",
                api: "anthropic-messages",
                reasoning: true,
                thinkingLevelMap: { minimal: null, max: "max" },
                contextWindow: 200_000,
              },
              {
                provider: "anthropic",
                id: "claude-sonnet",
                name: "Claude Sonnet",
              },
              {
                provider: "anthropic",
                id: "claude-sonnet",
                name: "Duplicate",
              },
            ],
          },
        }),
      ].join("\n"),
    );

    expect(
      models?.map((model) => ({
        slug: model.slug,
        name: model.name,
        subProvider: model.subProvider,
        isCustom: model.isCustom,
      })),
    ).toEqual([
      {
        slug: "prime-inference/anthropic/claude-fable-5",
        name: "Claude Fable 5",
        subProvider: "prime-inference",
        isCustom: false,
      },
      {
        slug: "anthropic/claude-sonnet",
        name: "Claude Sonnet",
        subProvider: "anthropic",
        isCustom: false,
      },
    ]);
    expect(
      models?.[0]?.capabilities?.optionDescriptors?.map((descriptor) => descriptor.id),
    ).toEqual(["thinkingLevel"]);
    expect(models?.[1]?.capabilities?.optionDescriptors).toEqual([]);
  });

  it("maps sanitized daemon models through the provider-neutral catalog", () => {
    const nativeModel = {
      provider: "openai-codex",
      id: "gpt-5.4",
      name: "GPT-5.4",
      api: "openai-codex-responses",
      reasoning: true,
      thinkingLevelMap: { xhigh: "xhigh" },
      baseUrl: "https://private.example/token",
      headers: { authorization: "secret" },
    };
    const models = primeAgentServerModelsFromDiscoveredModels([nativeModel, nativeModel]);

    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      slug: "openai-codex/gpt-5.4",
      name: "GPT-5.4",
      subProvider: "openai-codex",
      isCustom: false,
    });
    expect(models[0]?.capabilities?.optionDescriptors?.map((descriptor) => descriptor.id)).toEqual([
      "thinkingLevel",
      "serviceTier",
    ]);
    expect(JSON.stringify(models)).not.toContain("private.example");
    expect(JSON.stringify(models)).not.toContain("secret");
  });

  it("rejects a matching response whose configured model records fail the schema", () => {
    expect(
      parsePrimeAgentModelDiscoveryOutput(
        JSON.stringify({
          id: "pylon-prime-agent-models",
          type: "response",
          command: "get_available_models",
          success: true,
          data: {
            models: [
              {
                provider: "anthropic",
                id: "claude-sonnet",
                name: "Claude Sonnet",
                reasoning: "yes",
              },
            ],
          },
        }),
      ),
    ).toBeUndefined();
  });

  it("merges discovered and custom models behind default without duplicate slugs", () => {
    const discovered = parsePrimeAgentModelDiscoveryOutput(
      JSON.stringify({
        id: "pylon-prime-agent-models",
        type: "response",
        command: "get_available_models",
        success: true,
        data: {
          models: [{ provider: "anthropic", id: "claude-sonnet", name: "Claude Sonnet" }],
        },
      }),
    );

    expect(
      primeAgentModelsFromSettings(
        ["anthropic/claude-sonnet", "custom-model", "custom-model"],
        discovered,
      ).map((model) => ({ slug: model.slug, isCustom: model.isCustom })),
    ).toEqual([
      { slug: "default", isCustom: false },
      { slug: "anthropic/claude-sonnet", isCustom: false },
      { slug: "custom-model", isCustom: true },
    ]);
  });
});

describe("buildInitialPrimeAgentProviderSnapshot", () => {
  it.effect("does not claim installation before the version probe completes", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialPrimeAgentProviderSnapshot(decodeSettings({}));
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.models.map((model) => model.slug)).toEqual(["default"]);
      expect(snapshot.requiresNewThreadForModelChange).toBe(true);
      expect(snapshot.supportedRuntimeModes).toEqual(["full-access"]);
      expect(snapshot.showInteractionModeToggle).toBe(false);
      expect(snapshot.supportsBackgroundTextGeneration).toBe(true);
      expect(snapshot.supportsConversationRollback).toBe(false);
    }),
  );

  it.effect("stamps authoritative daemon capabilities and in-session model changes", () =>
    Effect.gen(function* () {
      const initial = yield* buildInitialPrimeAgentProviderSnapshot(decodeSettings({}));
      const snapshot = stampPrimeAgentBackendSnapshot(initial, {
        runtime: "daemon",
        inputQueue: true,
        inputQueueModes: true,
        inputQueueMutation: true,
        agentCancel: true,
        agentMessage: true,
        agentLiveActivity: true,
        compaction: true,
        refinement: true,
        autoCompaction: true,
        goals: true,
        sideQuestions: true,
      });

      expect(snapshot.featureCapabilities?.version).toBe(1);
      expect(snapshot.featureCapabilities?.agents?.support).toBe("read-write");
      expect(snapshot.featureCapabilities?.goals).toMatchObject({
        support: "read-only",
        operations: ["observe"],
      });
      expect(snapshot.featureCapabilities?.automation).toMatchObject({
        support: "read-write",
        operations: ["background-text-generation", "side-questions"],
      });
      const withoutSideQuestionMethods = stampPrimeAgentBackendSnapshot(initial, {
        runtime: "daemon",
        inputQueue: true,
        inputQueueModes: true,
        inputQueueMutation: true,
        agentCancel: true,
        agentMessage: true,
        agentLiveActivity: true,
        compaction: true,
        refinement: true,
        autoCompaction: true,
        goals: true,
        sideQuestions: false,
      });
      expect(withoutSideQuestionMethods.featureCapabilities?.automation).toMatchObject({
        support: "read-write",
        operations: ["background-text-generation"],
      });
      expect(snapshot.featureCapabilities?.agents?.operations).toContain("message");
      expect(snapshot.featureCapabilities?.reasoning?.support).toBe("read-only");
      expect(snapshot.featureCapabilities?.sessionUi?.support).toBe("read-write");
      expect(snapshot.featureCapabilities?.sessionUi?.operations).toEqual([
        "dialog",
        "notification",
        "status",
        "widget",
      ]);
      expect(snapshot.featureCapabilities?.inputQueue?.operations).toContain("set-modes");
      expect(snapshot.featureCapabilities?.inputQueue?.operations).toContain("remove");
      expect(snapshot.featureCapabilities?.context?.operations).toContain("refine");
      expect(snapshot.requiresNewThreadForModelChange).toBe(false);
      expect(snapshot.supportedRuntimeModes).toEqual(["approval-required", "full-access"]);
      expect(snapshot.message).toBe("Checking Prime Agent CLI availability...");
    }),
  );

  it.effect("stamps ACP capabilities and combines the visible fallback message", () =>
    Effect.gen(function* () {
      const initial = yield* buildInitialPrimeAgentProviderSnapshot(decodeSettings({}));
      const controlledModels = parsePrimeAgentModelDiscoveryOutput(
        [
          '{"id":"pylon-prime-agent-models","type":"response",',
          '"command":"get_available_models","success":true,"data":{"models":[',
          '{"provider":"openai-codex","id":"gpt-5.6-luna","name":"GPT-5.6 Luna",',
          '"api":"openai-codex-responses","reasoning":true,',
          '"thinkingLevelMap":{"xhigh":"xhigh","max":"max"}}]}}',
        ].join(""),
      );
      expect(controlledModels?.[0]?.capabilities?.optionDescriptors).not.toEqual([]);
      const snapshot = stampPrimeAgentBackendSnapshot(
        { ...initial, models: controlledModels ?? [] },
        {
          runtime: "acp",
          fallbackMessage:
            "Prime Agent daemon integration is unavailable; using ACP compatibility mode.",
        },
      );

      expect(snapshot.featureCapabilities?.version).toBe(1);
      expect(snapshot.featureCapabilities?.agents?.support).toBe("unavailable");
      expect(snapshot.featureCapabilities?.automation).toMatchObject({
        support: "read-write",
        operations: ["background-text-generation"],
      });
      expect(snapshot.featureCapabilities?.sessionUi?.support).toBe("unavailable");
      expect(snapshot.models[0]?.capabilities?.optionDescriptors).toEqual([]);
      expect(
        snapshot.models[0]?.backgroundTextGenerationCapabilities?.optionDescriptors?.map(
          (descriptor) => descriptor.id,
        ),
      ).toEqual(["thinkingLevel", "serviceTier"]);
      expect(snapshot.requiresNewThreadForModelChange).toBe(true);
      expect(snapshot.supportedRuntimeModes).toEqual(["full-access"]);
      expect(snapshot.message).toBe(
        "Checking Prime Agent CLI availability... Prime Agent daemon integration is unavailable; using ACP compatibility mode.",
      );
    }),
  );

  it.effect("returns a disabled snapshot when settings are disabled", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialPrimeAgentProviderSnapshot(
        decodeSettings({ enabled: false }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("disabled");
    }),
  );
});

it.layer(NodeServices.layer)("checkPrimeAgentProviderStatus", (it) => {
  it.effect("reports a missing configured binary without claiming availability", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkPrimeAgentProviderStatus(
        decodeSettings({ binaryPath: "/definitely/not/installed/prime-agent" }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.version).toBeNull();
    }),
  );

  it.effect("becomes ready only after a successful, parseable version probe", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "pylon-prime-agent-version-" });
        const binaryPath = path.join(dir, "prime-agent");
        yield* fs.writeFileString(binaryPath, '#!/bin/sh\nprintf "prime-agent 0.7.1\n"\n');
        yield* fs.chmod(binaryPath, 0o755);

        const snapshot = yield* checkPrimeAgentProviderStatus(
          decodeSettings({ binaryPath, customModels: ["custom-model"] }),
        );
        expect(snapshot.installed).toBe(true);
        expect(snapshot.status).toBe("ready");
        expect(snapshot.version).toBe("0.7.1");
        expect(snapshot.models.map((model) => model.slug)).toEqual(["default", "custom-model"]);
      }),
    ),
  );

  it.effect("probes the machine-readable RPC catalog with one NDJSON request", () => {
    const calls: Array<{
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly cwd?: string;
    }> = [];
    const stdin: string[] = [];
    const rpcOutput = JSON.stringify({
      id: "pylon-prime-agent-models",
      type: "response",
      command: "get_available_models",
      success: true,
      data: {
        models: [
          {
            provider: "anthropic",
            id: "claude-sonnet",
            name: "Claude Sonnet",
            reasoning: true,
            contextWindow: 200_000,
          },
          {
            provider: "prime-inference",
            id: "openai/gpt-5",
            name: "GPT 5",
          },
        ],
      },
    });

    return Effect.gen(function* () {
      const snapshot = yield* checkPrimeAgentProviderStatus(
        decodeSettings({
          binaryPath: "/mock/prime-agent",
          customModels: ["anthropic/claude-sonnet", "custom-model"],
        }),
      );

      expect(calls).toEqual([
        { command: "/mock/prime-agent", args: ["--version"] },
        {
          command: "/mock/prime-agent",
          args: ["--mode", "rpc", "--no-session", "--offline", "--cwd", process.cwd()],
          cwd: process.cwd(),
        },
      ]);
      expect(stdin.join("")).toBe(
        '{"id":"pylon-prime-agent-models","type":"get_available_models"}\n',
      );
      expect(snapshot.status).toBe("ready");
      expect(snapshot.auth.status).toBe("authenticated");
      expect(snapshot.message).toBeUndefined();
      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "default",
        "anthropic/claude-sonnet",
        "prime-inference/openai/gpt-5",
        "custom-model",
      ]);
    }).pipe(Effect.provide(mockPrimeAgentSpawner({ rpcOutput, calls, stdin })));
  });

  it.effect("keeps authentication unknown for a valid empty catalog", () => {
    const calls: Array<{
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly cwd?: string;
    }> = [];
    const stdin: string[] = [];
    const rpcOutput = JSON.stringify({
      id: "pylon-prime-agent-models",
      type: "response",
      command: "get_available_models",
      success: true,
      data: { models: [] },
    });

    return Effect.gen(function* () {
      const snapshot = yield* checkPrimeAgentProviderStatus(
        decodeSettings({ binaryPath: "/mock/prime-agent", customModels: ["custom-model"] }),
      );
      expect(snapshot.status).toBe("ready");
      expect(snapshot.auth.status).toBe("unknown");
      expect(snapshot.message).toBeUndefined();
      expect(snapshot.models.map((model) => model.slug)).toEqual(["default", "custom-model"]);
    }).pipe(Effect.provide(mockPrimeAgentSpawner({ rpcOutput, calls, stdin })));
  });

  it.effect("keeps a version-healthy CLI ready when RPC model discovery fails", () => {
    const calls: Array<{
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly cwd?: string;
    }> = [];
    const stdin: string[] = [];

    return Effect.gen(function* () {
      const snapshot = yield* checkPrimeAgentProviderStatus(
        decodeSettings({ binaryPath: "/mock/prime-agent", customModels: ["custom-model"] }),
      );

      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("ready");
      expect(snapshot.version).toBe("0.7.1");
      expect(snapshot.auth.status).toBe("unknown");
      expect(snapshot.message).toContain("model discovery failed");
      expect(snapshot.models.map((model) => model.slug)).toEqual(["default", "custom-model"]);
      expect(stdin.join("")).toContain('"type":"get_available_models"');
    }).pipe(
      Effect.provide(
        mockPrimeAgentSpawner({
          rpcOutput: "Provider          Model\nanthropic       claude-sonnet\n",
          calls,
          stdin,
        }),
      ),
    );
  });

  it.effect("skips RPC model discovery after a daemon catalog is published", () => {
    const calls: Array<{
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly cwd?: string;
    }> = [];
    const stdin: string[] = [];

    return Effect.gen(function* () {
      const snapshot = yield* checkPrimeAgentProviderStatus(
        decodeSettings({ binaryPath: "/mock/prime-agent", customModels: ["custom-model"] }),
        process.env,
        { discoverModels: false },
      );

      expect(calls).toEqual([{ command: "/mock/prime-agent", args: ["--version"] }]);
      expect(stdin).toEqual([]);
      expect(snapshot.status).toBe("ready");
      expect(snapshot.message).toBeUndefined();
      expect(snapshot.models.map((model) => model.slug)).toEqual(["default", "custom-model"]);
    }).pipe(
      Effect.provide(
        mockPrimeAgentSpawner({
          rpcOutput: "not a catalog",
          calls,
          stdin,
        }),
      ),
    );
  });

  it.effect("clears only stale RPC discovery warnings when a daemon catalog publishes", () => {
    const calls: Array<{
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly cwd?: string;
    }> = [];
    const stdin: string[] = [];

    return Effect.gen(function* () {
      const fallbackDraft = yield* checkPrimeAgentProviderStatus(
        decodeSettings({ binaryPath: "/mock/prime-agent" }),
      );
      const fallback = {
        ...fallbackDraft,
        instanceId: ProviderInstanceId.make("prime-agent"),
        driver: ProviderDriverKind.make("primeAgent"),
      };
      expect(fallback.message).toContain("model discovery failed");
      const emptyCatalog = reconcilePrimeAgentDaemonCatalogSnapshot(fallback);
      expect(emptyCatalog.auth.status).toBe("unknown");
      expect(emptyCatalog.message).toBeUndefined();

      const published = reconcilePrimeAgentDaemonCatalogSnapshot({
        ...fallback,
        models: [
          ...fallback.models,
          {
            slug: "anthropic/claude-sonnet",
            name: "Claude Sonnet",
            subProvider: "anthropic",
            isCustom: false,
            capabilities: fallback.models[0]!.capabilities,
          },
        ],
      });
      expect(published.auth.status).toBe("authenticated");
      expect(published.message).toBeUndefined();

      const unrelated = { ...fallback, message: "Provider update available." };
      expect(reconcilePrimeAgentDaemonCatalogSnapshot(unrelated)).toMatchObject({
        auth: { status: "unknown" },
        message: "Provider update available.",
      });

      const nonReadySnapshots = [
        {
          ...published,
          enabled: false,
          auth: { status: "unknown" as const },
          message: "Prime Agent is disabled.",
        },
        {
          ...published,
          installed: false,
          status: "error" as const,
          auth: { status: "unknown" as const },
          message: "Prime Agent CLI was not found.",
        },
        {
          ...published,
          status: "error" as const,
          auth: { status: "unknown" as const },
          message: "Prime Agent CLI is installed but failed to run.",
        },
      ];
      for (const nonReady of nonReadySnapshots) {
        expect(reconcilePrimeAgentDaemonCatalogSnapshot(nonReady)).toEqual(nonReady);
      }
    }).pipe(
      Effect.provide(
        mockPrimeAgentSpawner({
          rpcOutput: "not a catalog",
          calls,
          stdin,
        }),
      ),
    );
  });

  it.effect(
    "finishes dual-backend timeouts, finalization, and backoff inside the outer budget",
    () =>
      Effect.gen(function* () {
        const nowMs = Date.parse("2026-08-06T12:00:00.000Z");
        yield* TestClock.setTime(nowMs);
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "pylon-prime-home-" });
        const cacheDir = yield* fs.makeTempDirectoryScoped({ prefix: "pylon-prime-cache-" });
        yield* fs.writeFileString(
          path.join(home, "auth.json"),
          `{"anthropic":{"type":"oauth","access":"anthropic-secret",` +
            `"expires":${nowMs + 60 * 60_000}},"openai-codex":{"type":"oauth",` +
            `"access":"codex-secret","expires":${nowMs + 60 * 60_000},` +
            `"accountId":"acct_123"}}`,
        );
        const anthropicStarted = yield* Deferred.make<void>();
        const anthropicFinalized = yield* Deferred.make<void>();
        const codexStarted = yield* Deferred.make<void>();
        const codexFinalizing = yield* Deferred.make<void>();
        const codexFinalized = yield* Deferred.make<void>();
        const stalledCodex = ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(2),
          exitCode: Effect.never,
          isRunning: Effect.succeed(true),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.never,
          stderr: Stream.empty,
          all: Stream.never,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
        const spawner = ChildProcessSpawner.make((command) => {
          const childProcess = command as unknown as {
            readonly args: ReadonlyArray<string>;
          };
          if (childProcess.args.length === 1 && childProcess.args[0] === "--version") {
            return Effect.succeed(mockProcess({ stdout: "prime-agent 0.8.1\n" }));
          }
          if (childProcess.args[0] === "app-server") {
            return Effect.acquireRelease(
              Deferred.succeed(codexStarted, undefined).pipe(Effect.as(stalledCodex)),
              () =>
                Deferred.succeed(codexFinalizing, undefined).pipe(
                  Effect.andThen(Effect.sleep("1500 millis")),
                  Effect.andThen(Deferred.succeed(codexFinalized, undefined)),
                  Effect.asVoid,
                ),
            );
          }
          return Effect.die(`Unexpected subprocess args: ${childProcess.args.join(" ")}`);
        });
        const httpClient = HttpClient.make(() =>
          Deferred.succeed(anthropicStarted, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(anthropicFinalized, undefined).pipe(Effect.asVoid)),
          ),
        );
        const readBackends = readPrimeAgentBackends(
          { agentHomePath: home },
          { sharedCacheDir: cacheDir, freshForMs: 0 },
        ).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        const provider = yield* checkPrimeAgentProviderStatus(
          decodeSettings({ binaryPath: "/mock/prime-agent", agentHomePath: home }),
          process.env,
          { discoverModels: false, readBackends },
        ).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.forkScoped,
        );

        // Both independent reads start before either five-second timeout.
        yield* Deferred.await(anthropicStarted);
        yield* Deferred.await(codexStarted);
        yield* TestClock.adjust("5 seconds");
        yield* Deferred.await(anthropicFinalized);
        yield* Deferred.await(codexFinalizing);
        expect(provider.pollUnsafe()).toBeUndefined();

        // Codex cleanup is deliberately non-immediate, but still finishes
        // before the status wrapper's ten-second outer timeout.
        yield* TestClock.adjust("1500 millis");
        const snapshot = yield* Fiber.join(provider);
        yield* Deferred.await(codexFinalized);
        const anthropicEntry = yield* readSharedUsageEntry(
          cacheDir,
          sharedUsageReadKey([
            "prime-anthropic",
            home,
            primeAgentCredentialFingerprint("anthropic-secret"),
          ]),
        );
        const codexEntry = yield* readSharedUsageEntry(
          cacheDir,
          sharedUsageReadKey(["prime-codex", home, "acct_123"]),
        );

        expect(snapshot.status).toBe("ready");
        expect(snapshot.backends).toEqual([
          { backend: "anthropic" },
          { backend: "openai-codex", accountId: "acct_123" },
        ]);
        expect(anthropicEntry?.failedAt).toBe("2026-08-06T12:00:00.000Z");
        expect(codexEntry?.failedAt).toBe("2026-08-06T12:00:00.000Z");
      }).pipe(Effect.scoped),
  );

  it.effect("bounds a stalled OAuth JSON body and keeps completed Codex capacity", () =>
    Effect.gen(function* () {
      const nowMs = Date.parse("2026-08-06T12:00:00.000Z");
      yield* TestClock.setTime(nowMs);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "pylon-prime-home-" });
      const cacheDir = yield* fs.makeTempDirectoryScoped({ prefix: "pylon-prime-cache-" });
      yield* fs.writeFileString(
        path.join(home, "auth.json"),
        `{"anthropic":{"type":"oauth","access":"anthropic-secret",` +
          `"expires":${nowMs + 60 * 60_000}},"openai-codex":{"type":"oauth",` +
          `"access":"codex-secret","expires":${nowMs + 60 * 60_000},` +
          `"accountId":"acct_123"}}`,
      );
      const bodyStarted = Promise.withResolvers<void>();
      const httpClient = HttpClient.make((request) => {
        const response = new Response("{}", { status: 200 });
        Object.defineProperty(response, "text", {
          value: () => {
            bodyStarted.resolve();
            return new Promise<string>(() => undefined);
          },
        });
        return Effect.succeed(HttpClientResponse.fromWeb(request, response));
      });
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(mockProcess({ stdout: "prime-agent 0.8.1\n" })),
      );
      const readBackends = readPrimeAgentBackends(
        { agentHomePath: home },
        {
          sharedCacheDir: cacheDir,
          freshForMs: 0,
          readCodexWindows: () =>
            Effect.succeed({
              rateLimits: {
                primary: { usedPercent: 44, windowDurationMins: 10_080 },
              },
            }),
        },
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const provider = yield* checkPrimeAgentProviderStatus(
        decodeSettings({ binaryPath: "/mock/prime-agent", agentHomePath: home }),
        process.env,
        { discoverModels: false, readBackends },
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.forkScoped,
      );

      yield* Effect.promise(() => bodyStarted.promise);
      expect(provider.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("5 seconds");
      const snapshot = yield* Fiber.join(provider);
      const anthropicEntry = yield* readSharedUsageEntry(
        cacheDir,
        sharedUsageReadKey([
          "prime-anthropic",
          home,
          primeAgentCredentialFingerprint("anthropic-secret"),
        ]),
      );

      expect(snapshot.backends).toEqual([
        { backend: "anthropic" },
        {
          backend: "openai-codex",
          accountId: "acct_123",
          usageLimits: {
            source: "primeAgentCodex",
            checkedAt: "2026-08-06T12:00:00.000Z",
            windows: [
              {
                label: "Weekly",
                usedPercent: 44,
                windowDurationMins: 10_080,
              },
            ],
          },
        },
      ]);
      expect(anthropicEntry?.failedAt).toBe("2026-08-06T12:00:00.000Z");
    }).pipe(Effect.scoped),
  );

  it.effect("propagates managed backend cancellation and releases both read scopes", () =>
    Effect.gen(function* () {
      const nowMs = Date.parse("2026-08-06T12:00:00.000Z");
      yield* TestClock.setTime(nowMs);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "pylon-prime-home-" });
      const cacheDir = yield* fs.makeTempDirectoryScoped({ prefix: "pylon-prime-cache-" });
      yield* fs.writeFileString(
        path.join(home, "auth.json"),
        `{"anthropic":{"type":"oauth","access":"anthropic-secret",` +
          `"expires":${nowMs + 60 * 60_000}},"openai-codex":{"type":"oauth",` +
          `"access":"codex-secret","expires":${nowMs + 60 * 60_000},` +
          `"accountId":"acct_123"}}`,
      );
      const anthropicStarted = yield* Deferred.make<void>();
      const anthropicFinalized = yield* Deferred.make<void>();
      const codexStarted = yield* Deferred.make<void>();
      const codexFinalized = yield* Deferred.make<void>();
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(mockProcess({ stdout: "prime-agent 0.8.1\n" })),
      );
      const httpClient = HttpClient.make(() =>
        Deferred.succeed(anthropicStarted, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(anthropicFinalized, undefined).pipe(Effect.asVoid)),
        ),
      );
      const readBackends = readPrimeAgentBackends(
        { agentHomePath: home },
        {
          sharedCacheDir: cacheDir,
          freshForMs: 0,
          readCodexWindows: () =>
            Deferred.succeed(codexStarted, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(codexFinalized, undefined).pipe(Effect.asVoid)),
            ),
        },
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const provider = yield* checkPrimeAgentProviderStatus(
        decodeSettings({ binaryPath: "/mock/prime-agent", agentHomePath: home }),
        process.env,
        { discoverModels: false, readBackends },
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.forkScoped,
      );

      yield* Deferred.await(anthropicStarted);
      yield* Deferred.await(codexStarted);
      yield* Fiber.interrupt(provider);
      const exit = yield* Fiber.await(provider);
      yield* Deferred.await(anthropicFinalized);
      yield* Deferred.await(codexFinalized);

      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
      const anthropicKey = sharedUsageReadKey([
        "prime-anthropic",
        home,
        primeAgentCredentialFingerprint("anthropic-secret"),
      ]);
      const codexKey = sharedUsageReadKey(["prime-codex", home, "acct_123"]);
      expect(yield* readSharedUsageEntry(cacheDir, anthropicKey)).toBeUndefined();
      expect(yield* readSharedUsageEntry(cacheDir, codexKey)).toBeUndefined();

      // Cancellation does not continue into failure/backoff work, and both
      // scoped lock finalizers have made the account keys available again.
      expect(yield* acquireSharedUsageLock(cacheDir, anthropicKey, nowMs)).toBe(true);
      yield* releaseSharedUsageLock(cacheDir, anthropicKey);
      expect(yield* acquireSharedUsageLock(cacheDir, codexKey, nowMs)).toBe(true);
      yield* releaseSharedUsageLock(cacheDir, codexKey);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps an installed CLI unavailable when the version is not parseable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "pylon-prime-agent-version-" });
        const binaryPath = path.join(dir, "prime-agent");
        yield* fs.writeFileString(binaryPath, '#!/bin/sh\nprintf "development build\n"\n');
        yield* fs.chmod(binaryPath, 0o755);

        const snapshot = yield* checkPrimeAgentProviderStatus(decodeSettings({ binaryPath }));
        expect(snapshot.installed).toBe(true);
        expect(snapshot.status).toBe("error");
        expect(snapshot.version).toBeNull();
        expect(snapshot.message).toContain("determine its version");
      }),
    ),
  );
});
