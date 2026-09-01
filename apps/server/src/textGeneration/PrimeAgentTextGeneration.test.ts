import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { PrimeAgentSettings, ProviderInstanceId, type ChatAttachment } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner";
import { expect } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as TextGeneration from "./TextGeneration.ts";
import { FAKE_PUBLIC_SDK } from "./PrimeAgentTextGeneration.test-fixture.ts";
import {
  hasStablePrimeAgentImageFileIdentity,
  makePrimeAgentTextGeneration,
  resolvePrimeAgentTextGenerationHomePath,
} from "./PrimeAgentTextGeneration.ts";

const decodeSettings = Schema.decodeSync(PrimeAgentSettings);
const instanceId = ProviderInstanceId.make("primeAgent");
const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]);

const TestLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "pylon-prime-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

interface FakePrimeInput {
  readonly behavior?: string | undefined;
  readonly output?: string | undefined;
  readonly settings?: Partial<PrimeAgentSettings> | undefined;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly incompatibleSdk?: boolean | undefined;
  readonly timeoutMs?: number | undefined;
}

function makeFakePrimePackage(root: string, incompatibleSdk = false) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const packageRoot = path.join(root, "Prime Agent With Spaces");
    const binaryPath = path.join(packageRoot, "bin", "prime-agent");
    const publicEntry = path.join(packageRoot, "index.js");
    yield* fileSystem.makeDirectory(path.dirname(binaryPath), { recursive: true });
    yield* fileSystem.writeFileString(
      path.join(packageRoot, "package.json"),
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      JSON.stringify({
        name: "prime-agent",
        version: "9.9.9-test",
        type: "module",
        exports: { ".": { import: "./index.js" } },
      }),
    );
    yield* fileSystem.writeFileString(binaryPath, "#!/usr/bin/env node\n");
    yield* fileSystem.chmod(binaryPath, 0o755);
    yield* fileSystem.writeFileString(
      publicEntry,
      incompatibleSdk ? "export const VERSION = '9.9.9-test';\n" : FAKE_PUBLIC_SDK,
    );
    return binaryPath;
  });
}

function latestCapture(captureDir: string) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const entries = yield* fileSystem.readDirectory(captureDir);
    const captures = entries.filter((entry) => entry.endsWith(".json"));
    expect(captures).toHaveLength(1);
    return yield* fileSystem
      .readFileString(path.join(captureDir, captures[0]!))
      .pipe(Effect.map((raw) => JSON.parse(raw) as Record<string, unknown>));
  });
}

function waitForCapture(
  captureDir: string,
  predicate: (capture: Record<string, unknown>) => boolean,
) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const ready = yield* fileSystem.watch(captureDir).pipe(
      Stream.mapEffect(() =>
        Effect.gen(function* () {
          const entries = yield* fileSystem
            .readDirectory(captureDir)
            .pipe(Effect.orElseSucceed(() => []));
          for (const entry of entries) {
            if (!entry.endsWith(".json")) continue;
            const raw = yield* fileSystem
              .readFileString(path.join(captureDir, entry))
              .pipe(Effect.option);
            if (Option.isNone(raw)) continue;
            const decoded = yield* Effect.try(
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              () => JSON.parse(raw.value) as Record<string, unknown>,
            ).pipe(Effect.option);
            if (Option.isSome(decoded) && predicate(decoded.value)) return decoded.value;
          }
          return null;
        }),
      ),
      Stream.filter((capture) => capture !== null),
      Stream.runHead,
    );
    if (Option.isNone(ready) || ready.value === null) {
      return yield* Effect.die("capture watch ended before the helper became ready");
    }
    return ready.value;
  });
}

function withFakePrime<A, E, R>(
  input: FakePrimeInput,
  effectFn: (context: {
    readonly textGeneration: TextGeneration.TextGeneration["Service"];
    readonly captureDir: string;
    readonly root: string;
    readonly settings: PrimeAgentSettings;
    readonly environment: NodeJS.ProcessEnv;
  }) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pylon-prime-public-sdk-" });
    const captureDir = path.join(root, "captures");
    yield* fileSystem.makeDirectory(captureDir, { recursive: true });
    const binaryPath = yield* makeFakePrimePackage(root, input.incompatibleSdk);
    const agentHomePath = path.join(root, "Agent Home With Spaces");
    const settings = decodeSettings({
      binaryPath,
      agentHomePath,
      ...input.settings,
    });
    const environment = {
      ...process.env,
      PYLON_INSTANCE_SENTINEL: "instance-environment",
      FAKE_PRIME_CAPTURE_DIR: captureDir,
      ...(input.behavior ? { FAKE_PRIME_BEHAVIOR: input.behavior } : {}),
      ...(input.output ? { FAKE_PRIME_OUTPUT: input.output } : {}),
      ...input.environment,
    };
    const textGeneration = yield* makePrimeAgentTextGeneration(
      settings,
      environment,
      input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs },
    );
    return yield* effectFn({ textGeneration, captureDir, root, settings, environment });
  }).pipe(Effect.scoped);
}

const defaultSelection = createModelSelection(instanceId, "default", [
  { id: "thinkingLevel", value: "prime-default" },
  { id: "serviceTier", value: "prime-default" },
]);

it.layer(TestLayer)("PrimeAgentTextGeneration", (it) => {
  it.effect("resolves final POSIX Prime agent-dir values against the merged environment", () =>
    Effect.sync(() => {
      expect(
        resolvePrimeAgentTextGenerationHomePath({
          environment: {
            HOME: "/srv/instance-home",
            PRIME_AGENT_CODING_AGENT_DIR: "/explicit/prime-home",
          },
          cwd: "/srv/project",
        }),
      ).toBe("/explicit/prime-home");
      expect(
        resolvePrimeAgentTextGenerationHomePath({
          environment: {
            HOME: "/srv/instance-home",
            PRIME_AGENT_CODING_AGENT_DIR: "~/.prime-instance",
          },
          cwd: "/srv/project",
        }),
      ).toBe("/srv/instance-home/.prime-instance");
      expect(
        resolvePrimeAgentTextGenerationHomePath({
          environment: {
            HOME: "/srv/instance-home",
            PRIME_AGENT_CODING_AGENT_DIR: "relative-prime-home",
          },
          cwd: "/srv/project",
        }),
      ).toBe("/srv/project/relative-prime-home");
      expect(
        resolvePrimeAgentTextGenerationHomePath({
          environment: { HOME: "/srv/instance-home" },
          cwd: "/srv/project",
        }),
      ).toBe("/srv/instance-home/.prime/agent");
    }),
  );

  it.effect("supports all four structured operations and shared sanitizers", () =>
    withFakePrime({}, ({ textGeneration }) =>
      Effect.gen(function* () {
        const commit = yield* textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/prime",
          stagedSummary: "M helper.ts",
          stagedPatch: "diff --git a/helper.ts b/helper.ts",
          modelSelection: defaultSelection,
        });
        const pr = yield* textGeneration.generatePrContent({
          cwd: process.cwd(),
          baseBranch: "pylon",
          headBranch: "feature/prime",
          commitSummary: "Ship helper",
          diffSummary: "1 file changed",
          diffPatch: "diff --git a/helper.ts b/helper.ts",
          modelSelection: defaultSelection,
        });
        const branch = yield* textGeneration.generateBranchName({
          cwd: process.cwd(),
          message: "Add Prime background writing",
          modelSelection: defaultSelection,
        });
        const title = yield* textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "Add Prime background writing",
          modelSelection: defaultSelection,
        });

        expect(commit).toEqual({ subject: "Ship the Prime helper", body: "- tested" });
        expect(pr).toEqual({
          title: "Add Prime background writing",
          body: "## Summary\n- works",
        });
        expect(branch).toEqual({ branch: "prime-background-writing" });
        expect(title).toEqual({ title: "Prime Background Writing" });
      }),
    ),
  );

  it.effect("binds cwd, public package, home, environment, model, thinking, and service tier", () =>
    withFakePrime({}, ({ textGeneration, captureDir, root }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = path.join(root, "Worktree With Spaces");
        yield* fileSystem.makeDirectory(cwd, { recursive: true });
        const realCwd = yield* fileSystem.realPath(cwd);
        const modelSelection = createModelSelection(instanceId, "openai-codex/org/models/gpt-5.6", [
          { id: "thinkingLevel", value: "xhigh" },
          { id: "serviceTier", value: "priority" },
        ]);
        const generated = yield* textGeneration.generateThreadTitle({
          cwd,
          message: "Bind the selected model",
          modelSelection,
        });
        expect(generated.title).toBe("Prime Background Writing");

        const capture = yield* latestCapture(captureDir);
        expect(capture.argv).toEqual([]);
        expect(capture.sdkEntryPath).toBe(
          yield* fileSystem.realPath(path.join(root, "Prime Agent With Spaces", "index.js")),
        );
        expect(yield* fileSystem.exists(capture.helperPath as string)).toBe(false);
        expect(capture.instanceEnvironment).toBe("instance-environment");
        expect(typeof capture.primeHomeEnvironment).toBe("string");
        expect(capture.primeHomeEnvironment).not.toBe(path.join(root, "Agent Home With Spaces"));
        expect(yield* fileSystem.exists(capture.primeHomeEnvironment as string)).toBe(false);
        expect(capture.helperAgentDirEnvironment).toBe(path.join(root, "Agent Home With Spaces"));
        expect(capture.fileSettings).toMatchObject({
          cwd: realCwd,
          agentDir: path.join(root, "Agent Home With Spaces"),
          kind: "file-settings",
        });
        expect(capture.settings).toMatchObject({
          defaultProvider: "openai-codex",
          defaultModel: "org/models/gpt-5.6",
          defaultThinkingLevel: "xhigh",
          defaultServiceTier: "priority",
          rlmMaxDepth: 0,
          compaction: { enabled: false, agentCallable: false },
          autoRefine: { enabled: false },
          retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
          telemetry: { enabled: false },
          packages: [],
          extensions: [],
          skills: [],
          prompts: [],
          themes: [],
          mcpServers: {},
          enableBuiltinSkills: false,
        });
        expect(capture.resourceLoader).toMatchObject({
          cwd: realCwd,
          agentDir: path.join(root, "Agent Home With Spaces"),
          settingsManagerKind: "in-memory-settings",
          additionalExtensionPaths: [],
          additionalSkillPaths: [],
          additionalPromptTemplatePaths: [],
          additionalThemePaths: [],
          extensionFactoryCount: 0,
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          bundledSkillsDir: null,
          reloadCount: 1,
        });
        expect(capture.create).toMatchObject({
          cwd: realCwd,
          sessionManagerKind: "in-memory-session",
          resourceLoaderMatches: true,
          thinkingLevel: "xhigh",
          serviceTier: "priority",
          noTools: "all",
          tools: [],
          customTools: [],
          initialActiveToolNames: [],
          allowedToolNames: [],
          includeGoals: false,
          includeCompactSkill: false,
          rlmDepth: 0,
          rlmMaxDepth: 0,
          prewarmIpythonKernel: false,
          autonomous: { enabled: false, maxContinuations: 0, maxTurns: 1 },
          serializedRefine: false,
          telemetryDisabled: true,
          hasSessionDir: false,
        });
        expect(capture.requestCount).toBe(1);
        expect(capture.disposed).toBe(true);
        expect(capture.prompt).toContain("Bind the selected model");
        expect(capture.promptOptions).toMatchObject({
          expandPromptTemplates: false,
          skipInputHandlers: true,
          suppressAutonomousContinuation: true,
          signal: {},
        });
      }),
    ),
  );

  it.effect("excludes discovered project and agent-home system prompt files", () =>
    withFakePrime({}, ({ textGeneration, captureDir, root }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = path.join(root, "Prompt Project");
        const projectPromptDir = path.join(cwd, ".prime", "agent");
        const agentDir = path.join(root, "Agent Home With Spaces");
        yield* fileSystem.makeDirectory(projectPromptDir, { recursive: true });
        yield* fileSystem.makeDirectory(agentDir, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(projectPromptDir, "SYSTEM.md"),
          "PROJECT_SYSTEM_CANARY",
        );
        yield* fileSystem.writeFileString(
          path.join(projectPromptDir, "APPEND_SYSTEM.md"),
          "PROJECT_APPEND_CANARY",
        );
        yield* fileSystem.writeFileString(path.join(agentDir, "SYSTEM.md"), "HOME_SYSTEM_CANARY");
        yield* fileSystem.writeFileString(
          path.join(agentDir, "APPEND_SYSTEM.md"),
          "HOME_APPEND_CANARY",
        );

        yield* textGeneration.generateThreadTitle({
          cwd,
          message: "Keep custom prompts isolated",
          modelSelection: defaultSelection,
        });
        const capture = yield* latestCapture(captureDir);
        expect(capture.resourceLoader).toMatchObject({
          systemPrompt:
            "Generate only the text requested by the user. Do not use tools, access resources, or perform actions.",
          appendSystemPrompt: [
            "Ignore the preceding empty harness guidance for this isolated request. Return only the requested draft; do not use tools or perform actions.",
          ],
          hasSystemPromptOverride: true,
          hasAppendSystemPromptOverride: true,
        });
        expect(capture.prompt).not.toContain("PROJECT_SYSTEM_CANARY");
        expect(capture.prompt).not.toContain("PROJECT_APPEND_CANARY");
        expect(capture.prompt).not.toContain("HOME_SYSTEM_CANARY");
        expect(capture.prompt).not.toContain("HOME_APPEND_CANARY");
        const systemPrompt = (capture.sessionAtCreation as { systemPrompt: string }).systemPrompt;
        expect(systemPrompt).toContain("# Continual Harness State");
        expect(systemPrompt).toContain("prompt: 0\n\nmemory: 0\n\nskill: 0\n\nsubagent: 0");
        expect(systemPrompt).toContain("No saved harness entries yet.");
        expect(systemPrompt).toContain("recent refinements: 0");
        expect(
          systemPrompt.endsWith(
            "Ignore the preceding empty harness guidance for this isolated request. Return only the requested draft; do not use tools or perform actions.",
          ),
        ).toBe(true);
        expect(Buffer.byteLength(systemPrompt, "utf8")).toBeLessThanOrEqual(4096);
      }),
    ),
  );

  it.effect("inherits Prime defaults without trusting helper bootstrap environment keys", () =>
    withFakePrime(
      {
        environment: {
          PYLON_PRIME_SDK_ENTRY: "/poison/sdk-entry.js",
          PYLON_PRIME_AGENT_DIR: "/poison/agent-dir",
          PYLON_PRIME_MODEL: "poison/model",
          PYLON_PRIME_THINKING: "max",
          PYLON_PRIME_SERVICE_TIER: "default",
          NODE_OPTIONS: "--definitely-not-a-node-option",
          NODE_PATH: "/definitely/not/a/node/path",
          FORCE_COLOR: "3",
          No_CoLoR: "poison-no-color",
          cLiCoLoR_fOrCe: "1",
          NoDe_OpTiOnS: "--require=mixed-case-poison.cjs",
          nOdE_pAtH: "/mixed/case/node/path",
          pYlOn_PrImE_mOdEl: "mixed/poison",
          PRIME_AGENT_CODING_AGENT_DIR: "/base/prime/home",
          pRiMe_AgEnT_cOdInG_aGeNt_DiR: "/mixed/prime/home",
          pRiMe_AgEnT_iNtErNaL_sEsSiOn: "poison-internal",
          rLm_DePtH: "9",
          ELECTRON_RUN_AS_NODE: "1",
        },
      },
      ({ textGeneration, captureDir, root }) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Use Prime defaults",
            modelSelection: defaultSelection,
          });
          const capture = yield* latestCapture(captureDir);
          expect(capture.fileSettings).toMatchObject({
            cwd: process.cwd(),
            agentDir: path.join(root, "Agent Home With Spaces"),
            kind: "file-settings",
          });
          expect(capture.settings).toMatchObject({
            defaultProvider: "home-provider",
            defaultModel: "project/default/model",
            defaultThinkingLevel: "max",
            defaultServiceTier: "priority",
          });
          expect(capture.create).not.toHaveProperty("thinkingLevel");
          expect(capture.create).not.toHaveProperty("serviceTier");
          expect(capture.helperSdkEntryEnvironment).toBe(
            yield* fileSystem.realPath(path.join(root, "Prime Agent With Spaces", "index.js")),
          );
          expect(capture.helperAgentDirEnvironment).toBe(path.join(root, "Agent Home With Spaces"));
          expect(capture.helperModelEnvironment).toBe("default");
          expect(capture.helperThinkingEnvironment).toBe("");
          expect(capture.helperServiceTierEnvironment).toBe("");
          expect(capture).not.toHaveProperty("nodeOptionsEnvironment");
          expect(capture).not.toHaveProperty("nodePathEnvironment");
          expect(capture).not.toHaveProperty("mixedNodeOptionsEnvironment");
          expect(capture).not.toHaveProperty("mixedNodePathEnvironment");
          expect(capture.controlledEnvironment).toMatchObject({
            PRIME_AGENT_CODING_AGENT_DIR: capture.primeHomeEnvironment,
            PYLON_PRIME_SDK_ENTRY: capture.helperSdkEntryEnvironment,
            PYLON_PRIME_AGENT_DIR: path.join(root, "Agent Home With Spaces"),
            PYLON_PRIME_MODEL: "default",
            PYLON_PRIME_THINKING: "",
            PYLON_PRIME_SERVICE_TIER: "",
          });
          expect(capture.controlledEnvironment).not.toHaveProperty("NODE_OPTIONS");
          expect(capture.controlledEnvironment).not.toHaveProperty("NODE_PATH");
          expect(capture.controlledEnvironment).not.toHaveProperty("FORCE_COLOR");
          expect(capture.controlledEnvironment).not.toHaveProperty("CLICOLOR_FORCE");
          expect(capture.controlledEnvironment).toHaveProperty("NO_COLOR", "1");
          expect(capture.controlledEnvironment).not.toHaveProperty("PRIME_AGENT_INTERNAL_SESSION");
          expect(capture.controlledEnvironment).not.toHaveProperty("RLM_DEPTH");
          expect(
            Object.values(capture.controlledEnvironment as Record<string, unknown>),
          ).not.toContain("mixed/poison");
          expect(
            Object.values(capture.controlledEnvironment as Record<string, unknown>),
          ).not.toContain("/mixed/prime/home");
          expect(capture.electronRunAsNodeEnvironment).toBe("1");
        }),
    ),
  );

  it.effect("accepts Prime's supported clamp of inherited thinking and service tier", () =>
    withFakePrime({ behavior: "inherited-clamp" }, ({ textGeneration, captureDir }) =>
      Effect.gen(function* () {
        yield* textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "Clamp inherited controls",
          modelSelection: defaultSelection,
        });
        const capture = yield* latestCapture(captureDir);
        expect(capture.settings).toMatchObject({
          defaultThinkingLevel: "max",
          defaultServiceTier: "priority",
        });
        expect(capture.sessionAtCreation).toMatchObject({
          thinkingLevel: "high",
          serviceTier: "default",
        });
      }),
    ),
  );

  it.effect("rejects clamping of explicit Pylon thinking or service-tier controls", () =>
    withFakePrime({ behavior: "explicit-control-mismatch" }, ({ textGeneration }) =>
      Effect.gen(function* () {
        const result = yield* textGeneration
          .generateThreadTitle({
            cwd: process.cwd(),
            message: "Keep explicit controls",
            modelSelection: createModelSelection(instanceId, "openai-codex/gpt-5.6", [
              { id: "thinkingLevel", value: "xhigh" },
              { id: "serviceTier", value: "priority" },
            ]),
          })
          .pipe(Effect.result);
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure.detail).toContain("selected model");
        }
      }),
    ),
  );

  it.effect("keeps an explicit standard service tier distinct from Prime inheritance", () =>
    withFakePrime({}, ({ textGeneration, captureDir }) =>
      Effect.gen(function* () {
        const selection = createModelSelection(instanceId, "openai-codex/gpt-5.6", [
          { id: "serviceTier", value: "default" },
        ]);
        yield* textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "Use the standard tier",
          modelSelection: selection,
        });
        const capture = yield* latestCapture(captureDir);
        expect(capture.settings).toMatchObject({ defaultServiceTier: "default" });
        expect(capture.create).toMatchObject({ serviceTier: "default" });
      }),
    ),
  );

  it("fails image identity closed when either inode is unavailable", () => {
    const withoutInode = { type: "File" as const, dev: 7, ino: Option.none<number>() };
    const withInode = { type: "File" as const, dev: 7, ino: Option.some(42) };
    expect(hasStablePrimeAgentImageFileIdentity(withoutInode, withoutInode)).toBe(false);
    expect(hasStablePrimeAgentImageFileIdentity(withoutInode, withInode)).toBe(false);
    expect(hasStablePrimeAgentImageFileIdentity(withInode, withInode)).toBe(true);
    expect(
      hasStablePrimeAgentImageFileIdentity(withInode, {
        ...withInode,
        ino: Option.some(43),
      }),
    ).toBe(false);
  });

  it.effect("passes only validated attachment-store images to the helper", () =>
    withFakePrime({}, ({ textGeneration, captureDir, root }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const serverConfig = yield* ServerConfig.ServerConfig;
        const attachment: ChatAttachment = {
          type: "image",
          id: "thread-00000000-0000-4000-8000-000000000001-png",
          name: "screen.png",
          mimeType: "image/png",
          sizeBytes: PNG_BYTES.byteLength,
        };
        yield* fileSystem.makeDirectory(serverConfig.attachmentsDir, { recursive: true });
        yield* fileSystem.writeFile(
          path.join(serverConfig.attachmentsDir, `${attachment.id}.png`),
          PNG_BYTES,
        );
        const arbitraryPath = path.join(root, "secret.png");
        yield* fileSystem.writeFile(arbitraryPath, Uint8Array.from([9, 9, 9]));
        const invalidAttachment = {
          ...attachment,
          id: "../../secret",
          name: "secret.png",
          sizeBytes: 3,
        } as ChatAttachment;
        const symlinkAttachment: ChatAttachment = {
          ...attachment,
          id: "thread-00000000-0000-4000-8000-000000000003-png",
          name: "linked.png",
          sizeBytes: 3,
        };
        yield* fileSystem.symlink(
          arbitraryPath,
          path.join(serverConfig.attachmentsDir, `${symlinkAttachment.id}.png`),
        );
        const unsupportedImage = {
          ...attachment,
          id: "thread-00000000-0000-4000-8000-000000000004-svg",
          name: "vector.svg",
          mimeType: "image/svg+xml",
        } as ChatAttachment;
        const wrongMimeAttachment: ChatAttachment = {
          ...attachment,
          id: "thread-00000000-0000-4000-8000-000000000005-png",
          name: "wrong-mime.png",
          sizeBytes: JPEG_BYTES.byteLength,
        };
        yield* fileSystem.writeFile(
          path.join(serverConfig.attachmentsDir, `${wrongMimeAttachment.id}.png`),
          JPEG_BYTES,
        );
        const ordinaryFile: ChatAttachment = {
          type: "file",
          id: "thread-00000000-0000-4000-8000-000000000002-txt",
          name: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 3,
        };

        yield* textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "Name this image issue",
          attachments: [
            attachment,
            invalidAttachment,
            symlinkAttachment,
            unsupportedImage,
            wrongMimeAttachment,
            ordinaryFile,
          ],
          modelSelection: defaultSelection,
        });
        const capture = yield* latestCapture(captureDir);
        expect(capture.promptOptions).toMatchObject({
          images: [
            {
              type: "image",
              data: Buffer.from(PNG_BYTES).toString("base64"),
              mimeType: "image/png",
            },
          ],
        });
      }),
    ),
  );

  it.effect("skips an attachment whose file identity changes between validation and open", () =>
    withFakePrime({}, ({ captureDir, settings, environment }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const serverConfig = yield* ServerConfig.ServerConfig;
        const attachment: ChatAttachment = {
          type: "image",
          id: "thread-00000000-0000-4000-8000-000000000006-png",
          name: "swapped.png",
          mimeType: "image/png",
          sizeBytes: PNG_BYTES.byteLength,
        };
        yield* fileSystem.makeDirectory(serverConfig.attachmentsDir, { recursive: true });
        const attachmentPath = path.join(serverConfig.attachmentsDir, `${attachment.id}.png`);
        yield* fileSystem.writeFile(attachmentPath, PNG_BYTES);
        let swapped = false;
        const swappedGeneration = yield* makePrimeAgentTextGeneration(settings, environment, {
          beforeImageOpen: (candidatePath) =>
            swapped
              ? Effect.void
              : Effect.gen(function* () {
                  swapped = true;
                  yield* fileSystem.rename(candidatePath, `${candidatePath}.original`);
                  yield* fileSystem.writeFile(candidatePath, PNG_BYTES);
                }).pipe(Effect.orDie),
        });

        yield* swappedGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "Reject a swapped image",
          attachments: [attachment],
          modelSelection: defaultSelection,
        });
        expect(swapped).toBe(true);
        const capture = yield* latestCapture(captureDir);
        expect(capture.promptOptions).not.toHaveProperty("images");
      }),
    ),
  );

  it.effect("caps eight maximum-size images before base64 and stdin amplification", () =>
    withFakePrime({}, ({ textGeneration, captureDir }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const serverConfig = yield* ServerConfig.ServerConfig;
        const imageBytes = 10 * 1024 * 1024;
        const attachments = Array.from(
          { length: 8 },
          (_, index): ChatAttachment => ({
            type: "image",
            id: `thread-00000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}-png`,
            name: `maximum-${index}.png`,
            mimeType: "image/png",
            sizeBytes: imageBytes,
          }),
        );
        yield* fileSystem.makeDirectory(serverConfig.attachmentsDir, { recursive: true });
        for (const attachment of attachments) {
          const filePath = path.join(serverConfig.attachmentsDir, `${attachment.id}.png`);
          yield* fileSystem.writeFile(filePath, PNG_BYTES);
          yield* fileSystem.truncate(filePath, imageBytes);
        }

        yield* textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "Bound maximum images",
          attachments,
          modelSelection: defaultSelection,
        });
        const capture = yield* latestCapture(captureDir);
        expect(capture.promptOptions).toMatchObject({
          images: [
            {
              type: "image",
              mimeType: "image/png",
              dataLength: 4 * Math.ceil(imageBytes / 3),
            },
          ],
        });
      }),
    ),
  );

  it.effect("accepts image bytes up to the raw aggregate cap", () =>
    withFakePrime({}, ({ textGeneration, captureDir }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const serverConfig = yield* ServerConfig.ServerConfig;
        const imageBytes = 2 * 1024 * 1024;
        const attachments = Array.from(
          { length: 8 },
          (_, index): ChatAttachment => ({
            type: "image",
            id: `thread-00000000-0000-4000-8000-${String(index + 30).padStart(12, "0")}-png`,
            name: `near-cap-${index}.png`,
            mimeType: "image/png",
            sizeBytes: imageBytes,
          }),
        );
        yield* fileSystem.makeDirectory(serverConfig.attachmentsDir, { recursive: true });
        for (const attachment of attachments) {
          const filePath = path.join(serverConfig.attachmentsDir, `${attachment.id}.png`);
          yield* fileSystem.writeFile(filePath, PNG_BYTES);
          yield* fileSystem.truncate(filePath, imageBytes);
        }

        yield* textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "Use the aggregate image allowance",
          attachments,
          modelSelection: defaultSelection,
        });
        const capture = yield* latestCapture(captureDir);
        const images = (capture.promptOptions as { images: ReadonlyArray<{ dataLength: number }> })
          .images;
        expect(images).toHaveLength(8);
        expect(images.reduce((total, image) => total + image.dataLength, 0)).toBe(
          8 * 4 * Math.ceil(imageBytes / 3),
        );
      }),
    ),
  );

  it.effect("accepts Prime's syntactically valid date without a second-clock equality check", () =>
    withFakePrime({ behavior: "different-valid-date" }, ({ textGeneration }) =>
      Effect.gen(function* () {
        const result = yield* textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "Date can cross midnight",
          modelSelection: defaultSelection,
        });
        expect(result).toEqual({ title: "Prime Background Writing" });
      }),
    ),
  );

  it.effect("accepts a future compatible SDK that omits the empty harness block", () =>
    withFakePrime({ behavior: "no-harness" }, ({ textGeneration }) =>
      Effect.gen(function* () {
        const result = yield* textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "No stock harness",
          modelSelection: defaultSelection,
        });
        expect(result).toEqual({ title: "Prime Background Writing" });
      }),
    ),
  );

  it.effect("fails closed when a shape-compatible SDK loads resources or active tools", () =>
    Effect.gen(function* () {
      for (const behavior of [
        "leaky-resources",
        "leaky-tools",
        "nonempty-harness",
        "oversized-harness",
      ] as const) {
        yield* withFakePrime({ behavior }, ({ textGeneration, captureDir }) =>
          Effect.gen(function* () {
            const result = yield* textGeneration
              .generateThreadTitle({
                cwd: process.cwd(),
                message: "Reject leaked runtime state",
                modelSelection: defaultSelection,
              })
              .pipe(Effect.result);
            expect(Result.isFailure(result)).toBe(true);
            if (Result.isFailure(result)) {
              expect(result.failure.detail).toContain("compatible public SDK");
            }
            const capture = yield* latestCapture(captureDir);
            expect(capture.requestCount).toBe(0);
            if (behavior === "leaky-tools") expect(capture.disposed).toBe(true);
          }),
        );
      }
    }),
  );

  it.effect("rejects ignored isolation controls, tool output, or autonomous extra messages", () =>
    withFakePrime({ behavior: "ignored-isolation" }, ({ textGeneration, captureDir }) =>
      Effect.gen(function* () {
        const result = yield* textGeneration
          .generateThreadTitle({
            cwd: process.cwd(),
            message: "Reject ignored isolation",
            modelSelection: defaultSelection,
          })
          .pipe(Effect.result);
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure.detail).toContain("compatible public SDK");
        }
        const capture = yield* latestCapture(captureDir);
        expect(capture.requestCount).toBe(1);
        expect(capture.disposed).toBe(true);
      }),
    ),
  );

  it.effect("fails closed for missing and incompatible public SDK installations", () =>
    Effect.gen(function* () {
      const missing = yield* makePrimeAgentTextGeneration(
        decodeSettings({ binaryPath: "/definitely/missing/prime-agent" }),
        process.env,
      );
      const missingResult = yield* missing
        .generateThreadTitle({
          cwd: process.cwd(),
          message: "Missing",
          modelSelection: defaultSelection,
        })
        .pipe(Effect.result);
      expect(Result.isFailure(missingResult)).toBe(true);
      if (Result.isFailure(missingResult)) {
        expect(missingResult.failure.detail).toContain("installation is unavailable");
      }

      yield* withFakePrime({ incompatibleSdk: true }, ({ textGeneration }) =>
        Effect.gen(function* () {
          const result = yield* textGeneration
            .generateThreadTitle({
              cwd: process.cwd(),
              message: "Incompatible",
              modelSelection: defaultSelection,
            })
            .pipe(Effect.result);
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure.detail).toContain("compatible public SDK");
          }
        }),
      );
    }),
  );

  it.effect("rejects fallback away from the inherited Prime default model", () =>
    withFakePrime({ behavior: "fallback" }, ({ textGeneration }) =>
      Effect.gen(function* () {
        const result = yield* textGeneration
          .generateThreadTitle({
            cwd: process.cwd(),
            message: "Keep inherited affinity",
            modelSelection: defaultSelection,
          })
          .pipe(Effect.result);
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure.detail).toContain("selected model");
        }
      }),
    ),
  );

  it.effect("maps model, authentication, and quota failures without native detail", () =>
    Effect.gen(function* () {
      for (const [behavior, detail] of [
        ["create-model", "selected model"],
        ["fallback", "selected model"],
        ["create-auth", "authentication failed"],
        ["noisy-create-auth", "authentication failed"],
        ["prompt-auth", "authentication failed"],
        ["create-quota", "no available capacity"],
      ] as const) {
        yield* withFakePrime({ behavior }, ({ textGeneration }) =>
          Effect.gen(function* () {
            const result = yield* textGeneration
              .generateThreadTitle({
                cwd: process.cwd(),
                message: "Safe error",
                modelSelection: createModelSelection(instanceId, "openai-codex/gpt-5.6"),
              })
              .pipe(Effect.result);
            expect(Result.isFailure(result)).toBe(true);
            if (Result.isFailure(result)) {
              expect(result.failure.detail.toLowerCase()).toContain(detail);
              expect(result.failure.detail).not.toContain("SECRET_NATIVE_TOKEN");
              expect(result.failure.cause).toBeUndefined();
            }
          }),
        );
      }
    }),
  );

  it.effect("maps crashes and unknown native errors to a redacted failure", () =>
    Effect.gen(function* () {
      for (const behavior of ["crash", "create-native"] as const) {
        yield* withFakePrime({ behavior }, ({ textGeneration }) =>
          Effect.gen(function* () {
            const result = yield* textGeneration
              .generateThreadTitle({
                cwd: process.cwd(),
                message: "Crash safely",
                modelSelection: defaultSelection,
              })
              .pipe(Effect.result);
            expect(Result.isFailure(result)).toBe(true);
            if (Result.isFailure(result)) {
              expect(result.failure.detail).toBe("Prime Agent background text generation failed.");
              expect(result.failure.detail).not.toContain("SECRET_NATIVE_TOKEN");
              expect(result.failure.cause).toBeUndefined();
            }
          }),
        );
      }
    }),
  );

  it.effect("rejects empty, malformed, and oversized assistant output", () =>
    Effect.gen(function* () {
      for (const [behavior, detail] of [
        ["empty", "empty response"],
        ["malformed", "invalid structured output"],
        ["oversize", "too much background text"],
        ["flood", "too much background text"],
      ] as const) {
        yield* withFakePrime({ behavior }, ({ textGeneration }) =>
          Effect.gen(function* () {
            const result = yield* textGeneration
              .generateThreadTitle({
                cwd: process.cwd(),
                message: "Validate output",
                modelSelection: defaultSelection,
              })
              .pipe(Effect.result);
            expect(Result.isFailure(result)).toBe(true);
            if (Result.isFailure(result)) {
              expect(result.failure.detail).toContain(detail);
            }
          }),
        );
      }
    }),
  );

  it.effect("times out a hung helper and closes its exact process", () =>
    withFakePrime({ behavior: "hang" }, ({ settings, environment, captureDir }) =>
      Effect.gen(function* () {
        const realSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const spawned = yield* Deferred.make<ChildProcessHandle>();
        const trackingSpawner = ChildProcessSpawner.ChildProcessSpawner.of({
          ...realSpawner,
          spawn: (command) =>
            realSpawner
              .spawn(command)
              .pipe(Effect.tap((handle) => Deferred.succeed(spawned, handle))),
        });
        const readyFiber = yield* waitForCapture(
          captureDir,
          (capture) => capture.requestCount === 1,
        ).pipe(Effect.forkChild);
        const trackedGeneration = yield* makePrimeAgentTextGeneration(settings, environment, {
          timeoutMs: 50,
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, trackingSpawner));
        const fiber = yield* trackedGeneration
          .generateThreadTitle({
            cwd: process.cwd(),
            message: "Timeout",
            modelSelection: defaultSelection,
          })
          .pipe(Effect.result, Effect.forkChild);
        const handle = yield* Deferred.await(spawned);
        yield* Fiber.join(readyFiber);
        yield* TestClock.adjust("50 millis");
        const result = yield* Fiber.join(fiber);
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure.detail).toContain("timed out");
        }
        expect(yield* handle.isRunning).toBe(false);
        const capture = yield* latestCapture(captureDir);
        expect(capture.aborted).toBe(true);
        expect(capture.disposed).toBe(true);
      }),
    ),
  );

  it.effect("force-kills a helper that ignores abort and SIGTERM", () =>
    withFakePrime({ behavior: "ignore-abort" }, ({ settings, environment, captureDir }) =>
      Effect.gen(function* () {
        const realSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const spawned = yield* Deferred.make<ChildProcessHandle>();
        const trackingSpawner = ChildProcessSpawner.ChildProcessSpawner.of({
          ...realSpawner,
          spawn: (command) =>
            realSpawner
              .spawn(command)
              .pipe(Effect.tap((handle) => Deferred.succeed(spawned, handle))),
        });
        const readyFiber = yield* waitForCapture(
          captureDir,
          (capture) => capture.requestCount === 1,
        ).pipe(Effect.forkChild);
        const trackedGeneration = yield* makePrimeAgentTextGeneration(settings, environment, {
          timeoutMs: 50,
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, trackingSpawner));
        const fiber = yield* trackedGeneration
          .generateThreadTitle({
            cwd: process.cwd(),
            message: "Force kill",
            modelSelection: defaultSelection,
          })
          .pipe(Effect.result, Effect.forkChild);
        const handle = yield* Deferred.await(spawned);
        yield* Fiber.join(readyFiber);
        yield* TestClock.adjust("50 millis");
        yield* TestClock.adjust("2 seconds");
        const result = yield* Fiber.join(fiber);
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure.detail).toContain("timed out");
        }
        expect(yield* handle.isRunning).toBe(false);
        const capture = yield* latestCapture(captureDir);
        expect(capture.aborted).not.toBe(true);
        expect(capture.disposed).toBe(false);
      }),
    ),
  );

  it.effect("interrupting generation closes the scoped helper process", () =>
    withFakePrime(
      { behavior: "hang", timeoutMs: 30_000 },
      ({ settings, environment, captureDir }) =>
        Effect.gen(function* () {
          const realSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const spawned = yield* Deferred.make<ChildProcessHandle>();
          const trackingSpawner = ChildProcessSpawner.ChildProcessSpawner.of({
            ...realSpawner,
            spawn: (command) =>
              realSpawner
                .spawn(command)
                .pipe(Effect.tap((handle) => Deferred.succeed(spawned, handle))),
          });
          const readyFiber = yield* waitForCapture(
            captureDir,
            (capture) => capture.requestCount === 1,
          ).pipe(Effect.forkChild);
          const trackedGeneration = yield* makePrimeAgentTextGeneration(settings, environment, {
            timeoutMs: 30_000,
          }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, trackingSpawner));
          const fiber = yield* trackedGeneration
            .generateThreadTitle({
              cwd: process.cwd(),
              message: "Interrupt",
              modelSelection: defaultSelection,
            })
            .pipe(Effect.forkChild);
          const handle = yield* Deferred.await(spawned);
          yield* Fiber.join(readyFiber);
          yield* Fiber.interrupt(fiber);
          expect(yield* handle.isRunning).toBe(false);
          const capture = yield* latestCapture(captureDir);
          expect(capture.aborted).toBe(true);
          expect(capture.disposed).toBe(true);
        }),
    ),
  );
});
