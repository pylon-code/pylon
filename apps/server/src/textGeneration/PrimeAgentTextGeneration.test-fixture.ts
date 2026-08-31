/** Shape-compatible fake of Prime Agent's public ESM SDK for subprocess tests. */
export const FAKE_PUBLIC_SDK = String.raw`
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const captureDir = process.env.FAKE_PRIME_CAPTURE_DIR;
const behavior = process.env.FAKE_PRIME_BEHAVIOR || "success";
if (behavior === "noisy-create-auth") {
  console.error("(node:123) inherited bootstrap warning before safe marker");
}
const PYLON_SYSTEM_PROMPT =
  "Generate only the text requested by the user. Do not use tools, access resources, or perform actions.";
const PYLON_FINAL_SYSTEM_BOUNDARY =
  "Ignore the preceding empty harness guidance for this isolated request. Return only the requested draft; do not use tools or perform actions.";
const EMPTY_CONTINUAL_HARNESS_PROMPT = "# Continual Harness State\n\nLocal continual harness entries belong to this Prime Agent session. Global continual harness entries persist across Prime Agent sessions.\nThe continual harness entries below are compact summaries, not full descriptions. Use them as routing/context hints; inspect or refine the underlying continual harness entry only when detail matters.\nDefault to local continual harness refinement for current task progress, temporary blockers, and session coordination. Use global continual harness refinement only for stable cross-session lessons, durable user preferences, reusable skills/subagents, or explicitly project-qualified facts.\nUse these continual harness prompt notes, memories, skills, and subagent specs when they are relevant. The base system prompt is immutable; prompt entries below are supplemental notes only.\n\nWhen to refine the continual harness: after a repeated failure, a reusable tactic emerges, a repeated delegation role should become a subagent spec, a repeated procedure should become a skill, a durable fact/preference should become a memory, a narrow behavioral policy should become a prompt addendum, a user corrects behavior that should persist locally or globally, validation shows a continual harness entry is wrong, or a skill/subagent/memory/prompt note should be created, updated, deleted, or rolled back. Keep continual harness edits small and evidence-backed.\n\nCall contract: continual harness entries are routing/context hints only in sessions without IPython or shell access; do not use Python \`await\`, \`asyncio\`, \`rlm\`, or shell skill commands unless the prompt also documents those interfaces.\n\nprompt: 0\n\nmemory: 0\n\nskill: 0\n\nsubagent: 0\n\nNo saved harness entries yet.\n\nrecent refinements: 0";
const state = {
  pid: process.pid,
  execPath: process.execPath,
  cwd: process.cwd(),
  argv: process.argv.slice(2),
  helperPath: process.argv[1],
  sdkEntryPath: fileURLToPath(import.meta.url),
  instanceEnvironment: process.env.PYLON_INSTANCE_SENTINEL,
  primeHomeEnvironment: process.env.PRIME_AGENT_CODING_AGENT_DIR,
  mixedPrimeHomeEnvironment: process.env.pRiMe_AgEnT_cOdInG_aGeNt_DiR,
  helperSdkEntryEnvironment: process.env.PYLON_PRIME_SDK_ENTRY,
  helperAgentDirEnvironment: process.env.PYLON_PRIME_AGENT_DIR,
  helperModelEnvironment: process.env.PYLON_PRIME_MODEL,
  helperThinkingEnvironment: process.env.PYLON_PRIME_THINKING,
  helperServiceTierEnvironment: process.env.PYLON_PRIME_SERVICE_TIER,
  nodeOptionsEnvironment: process.env.NODE_OPTIONS,
  nodePathEnvironment: process.env.NODE_PATH,
  mixedNodeOptionsEnvironment: process.env.NoDe_OpTiOnS,
  mixedNodePathEnvironment: process.env.nOdE_pAtH,
  mixedHelperEnvironment: process.env.pYlOn_PrImE_mOdEl,
  electronRunAsNodeEnvironment: process.env.ELECTRON_RUN_AS_NODE,
  controlledEnvironment: Object.fromEntries(
    Object.entries(process.env)
      .filter(([name]) => {
        const normalized = name.toUpperCase();
        return (
          normalized === "NODE_OPTIONS" ||
          normalized === "NODE_PATH" ||
          normalized === "FORCE_COLOR" ||
          normalized === "NO_COLOR" ||
          normalized === "CLICOLOR_FORCE" ||
          normalized === "PRIME_AGENT_CODING_AGENT_DIR" ||
          normalized === "RLM_DEPTH" ||
          normalized.startsWith("PRIME_AGENT_INTERNAL_") ||
          normalized.startsWith("PYLON_PRIME_")
        );
      })
      .map(([name, value]) => [name.toUpperCase(), value]),
  ),
  requestCount: 0,
  disposed: false,
};
const capturePath = join(captureDir, process.pid + ".json");
const flush = () => {
  const temporaryPath = capturePath + ".tmp";
  writeFileSync(temporaryPath, JSON.stringify(state));
  renameSync(temporaryPath, capturePath);
};
flush();

export class SettingsManager {
  static create(cwd, agentDir) {
    state.fileSettings = { cwd, agentDir, kind: "file-settings" };
    flush();
    return {
      kind: "file-settings",
      getDefaultProvider: () => "home-provider",
      getDefaultModel: () => "project/default/model",
      getDefaultThinkingLevel: () => "max",
      getDefaultServiceTier: () => "priority",
    };
  }
  static inMemory(settings) {
    state.settings = settings;
    flush();
    return { kind: "in-memory-settings", settings };
  }
}

export class SessionManager {
  static inMemory(cwd) {
    state.sessionManager = { kind: "in-memory-session", cwd };
    flush();
    return state.sessionManager;
  }
}

export class DefaultResourceLoader {
  constructor(options) {
    this.options = options;
    this.systemPrompt = options.systemPrompt;
    this.appendSystemPrompt = options.appendSystemPrompt || [];
    state.resourceLoader = {
      cwd: options.cwd,
      agentDir: options.agentDir,
      settingsManagerKind: options.settingsManager?.kind,
      additionalExtensionPaths: options.additionalExtensionPaths,
      additionalSkillPaths: options.additionalSkillPaths,
      additionalPromptTemplatePaths: options.additionalPromptTemplatePaths,
      additionalThemePaths: options.additionalThemePaths,
      extensionFactoryCount: options.extensionFactories?.length,
      noExtensions: options.noExtensions,
      noSkills: options.noSkills,
      noPromptTemplates: options.noPromptTemplates,
      noThemes: options.noThemes,
      noContextFiles: options.noContextFiles,
      bundledSkillsDir: options.bundledSkillsDir,
      systemPrompt: options.systemPrompt,
      appendSystemPrompt: options.appendSystemPrompt,
      hasSystemPromptOverride: typeof options.systemPromptOverride === "function",
      hasAppendSystemPromptOverride: typeof options.appendSystemPromptOverride === "function",
      reloadCount: 0,
    };
    flush();
  }
  async reload() {
    const systemCandidates = [
      join(this.options.cwd, ".prime", "agent", "SYSTEM.md"),
      join(this.options.agentDir, "SYSTEM.md"),
    ];
    const appendCandidates = [
      join(this.options.cwd, ".prime", "agent", "APPEND_SYSTEM.md"),
      join(this.options.agentDir, "APPEND_SYSTEM.md"),
    ];
    const discoveredSystem = systemCandidates.find((path) => existsSync(path));
    const discoveredAppend = appendCandidates.filter((path) => existsSync(path));
    const baseSystem = discoveredSystem
      ? readFileSync(discoveredSystem, "utf8")
      : this.options.systemPrompt;
    const baseAppend = [
      ...this.appendSystemPrompt,
      ...discoveredAppend.map((path) => readFileSync(path, "utf8")),
    ];
    this.systemPrompt = this.options.systemPromptOverride
      ? this.options.systemPromptOverride(baseSystem)
      : baseSystem;
    this.appendSystemPrompt = this.options.appendSystemPromptOverride
      ? this.options.appendSystemPromptOverride(baseAppend)
      : baseAppend;
    state.resourceLoader.reloadCount += 1;
    state.resourceLoader.systemPrompt = this.systemPrompt;
    state.resourceLoader.appendSystemPrompt = this.appendSystemPrompt;
    flush();
  }
  getExtensions() {
    return { extensions: behavior === "leaky-resources" ? [{}] : [], errors: [] };
  }
  getLoadedExtensionPaths() {
    return behavior === "leaky-resources" ? ["/leaked-extension.js"] : [];
  }
  getSkills() {
    return { skills: behavior === "leaky-resources" ? [{}] : [], diagnostics: [] };
  }
  getPrompts() {
    return { prompts: behavior === "leaky-resources" ? [{}] : [], diagnostics: [] };
  }
  getThemes() {
    return { themes: behavior === "leaky-resources" ? [{}] : [], diagnostics: [] };
  }
  getAgentsFiles() {
    return { agentsFiles: behavior === "leaky-resources" ? [{}] : [] };
  }
  getSystemPrompt() {
    return behavior === "leaky-resources" ? "LEAKED SYSTEM" : this.systemPrompt;
  }
  getAppendSystemPrompt() {
    return behavior === "leaky-resources" ? ["LEAKED APPEND"] : this.appendSystemPrompt;
  }
}

function responseFor(prompt) {
  if (behavior === "empty") return "";
  if (behavior === "oversize") return "x".repeat(70 * 1024);
  if (behavior === "malformed") return "not structured output";
  if (process.env.FAKE_PRIME_OUTPUT) return process.env.FAKE_PRIME_OUTPUT;
  if (prompt.includes("keys: subject, body")) {
    return JSON.stringify({ subject: "  Ship the Prime helper.\nignored", body: "\n- tested\n" });
  }
  if (prompt.includes("keys: title, body")) {
    return JSON.stringify({ title: "  Add Prime background writing  ", body: "\n## Summary\n- works\n" });
  }
  if (prompt.includes("key: branch")) return JSON.stringify({ branch: "Prime Background Writing!" });
  return JSON.stringify({ title: "  Prime Background Writing  " });
}

export async function createAgentSession(options) {
  const now = new Date();
  const currentDate =
    String(now.getFullYear()) +
    "-" +
    String(now.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(now.getDate()).padStart(2, "0");
  state.create = {
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManagerKind: options.settingsManager?.kind,
    sessionManagerKind: options.sessionManager?.kind,
    resourceLoaderMatches: options.resourceLoader instanceof DefaultResourceLoader,
    thinkingLevel: options.thinkingLevel,
    serviceTier: options.serviceTier,
    noTools: options.noTools,
    tools: options.tools,
    customTools: options.customTools,
    initialActiveToolNames: options.initialActiveToolNames,
    allowedToolNames: options.allowedToolNames,
    includeGoals: options.includeGoals,
    includeCompactSkill: options.includeCompactSkill,
    rlmDepth: options.rlmDepth,
    rlmMaxDepth: options.rlmMaxDepth,
    prewarmIpythonKernel: options.prewarmIpythonKernel,
    autonomous: options.autonomous,
    serializedRefine: options.serializedRefine,
    telemetryDisabled: options.telemetryDisabled,
    hasSessionDir: Object.hasOwn(options, "sessionDir"),
  };
  flush();
  if (behavior === "create-auth" || behavior === "noisy-create-auth") {
    throw new Error("authentication failed SECRET_NATIVE_TOKEN");
  }
  if (behavior === "create-quota") throw new Error("quota exceeded SECRET_NATIVE_TOKEN");
  if (behavior === "create-model") throw new Error("unknown model SECRET_NATIVE_TOKEN");
  if (behavior === "create-native") throw new Error("native exploded SECRET_NATIVE_TOKEN");

  const requestedProvider = options.settingsManager.settings.defaultProvider;
  const requestedId = options.settingsManager.settings.defaultModel;
  const session = {
    model:
      behavior === "fallback"
        ? { provider: "anthropic", id: "fallback-model" }
        : {
            provider: requestedProvider || "default-provider",
            id: requestedId || "default-model",
          },
    thinkingLevel:
      behavior === "inherited-clamp"
        ? "high"
        : behavior === "explicit-control-mismatch"
          ? "low"
          : options.thinkingLevel || options.settingsManager.settings.defaultThinkingLevel || "medium",
    serviceTier:
      behavior === "inherited-clamp" || behavior === "explicit-control-mismatch"
        ? "default"
        : options.serviceTier || options.settingsManager.settings.defaultServiceTier || "default",
    messages: [],
    systemPrompt:
      options.resourceLoader.getSystemPrompt() +
      "\nCurrent date: " +
      (behavior === "different-valid-date" ? "2000-01-02" : currentDate) +
      "\nCurrent working directory: " +
      options.cwd.replace(/\\/g, "/") +
      (behavior === "no-harness"
        ? ""
        : "\n\n" +
          (behavior === "nonempty-harness"
            ? EMPTY_CONTINUAL_HARNESS_PROMPT.replace("prompt: 0", "prompt: 1\n- user entry")
            : behavior === "oversized-harness"
              ? EMPTY_CONTINUAL_HARNESS_PROMPT + "x".repeat(5000)
              : EMPTY_CONTINUAL_HARNESS_PROMPT)) +
      "\n\n" +
      options.resourceLoader.getAppendSystemPrompt()[0],
    sessionFile: behavior === "leaky-tools" ? "/persisted/session.jsonl" : undefined,
    rlmMaxDepth: behavior === "leaky-tools" ? 1 : 0,
    getActiveToolNames() {
      return behavior === "leaky-tools" ? ["bash"] : [];
    },
    async promptAndWait(prompt, promptOptions) {
      state.requestCount += 1;
      state.prompt = prompt;
      state.promptOptions = {
        ...promptOptions,
        ...(promptOptions.images
          ? {
              images: promptOptions.images.map((image) => ({
                type: image.type,
                mimeType: image.mimeType,
                dataLength: image.data.length,
                ...(image.data.length <= 1024 ? { data: image.data } : {}),
              })),
            }
          : {}),
      };
      this.messages.push({
        role: "user",
        content: promptOptions.images?.length
          ? [{ type: "text", text: prompt }, ...promptOptions.images]
          : prompt,
      });
      flush();
      if (behavior === "crash") process.exit(9);
      if (behavior === "prompt-auth") throw new Error("unauthorized SECRET_NATIVE_TOKEN");
      if (behavior === "flood") process.stdout.write("x".repeat(256 * 1024));
      if (behavior === "ignore-abort") {
        setInterval(() => {}, 1000);
        await new Promise(() => {});
      }
      if (behavior === "hang") {
        const timer = setInterval(() => {}, 1000);
        await new Promise((_resolve, reject) => {
          const abort = () => {
            clearInterval(timer);
            state.aborted = true;
            flush();
            reject(new Error("request aborted"));
          };
          if (promptOptions.signal?.aborted) abort();
          else promptOptions.signal?.addEventListener("abort", abort, { once: true });
        });
      }
      if (behavior === "ignored-isolation") {
        this.messages.push({
          role: "assistant",
          content: [{ type: "toolCall", id: "leak", name: "bash", arguments: {} }],
        });
        this.messages.push({
          role: "toolResult",
          toolCallId: "leak",
          toolName: "bash",
          content: [{ type: "text", text: "leaked" }],
          isError: false,
        });
      } else {
        this.messages.push({
          role: "assistant",
          content: [
            { type: "thinking", thinking: "private" },
            { type: "text", text: responseFor(prompt) },
          ],
        });
      }
      flush();
    },
    async disposeAsync() {
      state.disposed = true;
      flush();
    },
  };
  state.sessionAtCreation = {
    model: session.model,
    thinkingLevel: session.thinkingLevel,
    serviceTier: session.serviceTier,
    systemPrompt: session.systemPrompt,
    activeToolNames: session.getActiveToolNames(),
    sessionFile: session.sessionFile,
    rlmMaxDepth: session.rlmMaxDepth,
  };
  flush();
  return { session, extensionsResult: { extensions: [], errors: [] } };
}
`;
