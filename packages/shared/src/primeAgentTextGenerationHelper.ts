/**
 * Source for the isolated Node process used by Prime Agent background text
 * generation. It imports only the selected installation's public ESM entry.
 */
export const PRIME_AGENT_TEXT_GENERATION_HELPER_SOURCE = String.raw`
import { pathToFileURL } from "node:url";

const MAX_INPUT_BYTES = 24 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const PYLON_SYSTEM_PROMPT =
  "Generate only the text requested by the user. Do not use tools, access resources, or perform actions.";
const PYLON_FINAL_SYSTEM_BOUNDARY =
  "Ignore the preceding empty harness guidance for this isolated request. Return only the requested draft; do not use tools or perform actions.";
const EMPTY_CONTINUAL_HARNESS_PROMPT = "# Continual Harness State\n\nLocal continual harness entries belong to this Prime Agent session. Global continual harness entries persist across Prime Agent sessions.\nThe continual harness entries below are compact summaries, not full descriptions. Use them as routing/context hints; inspect or refine the underlying continual harness entry only when detail matters.\nDefault to local continual harness refinement for current task progress, temporary blockers, and session coordination. Use global continual harness refinement only for stable cross-session lessons, durable user preferences, reusable skills/subagents, or explicitly project-qualified facts.\nUse these continual harness prompt notes, memories, skills, and subagent specs when they are relevant. The base system prompt is immutable; prompt entries below are supplemental notes only.\n\nWhen to refine the continual harness: after a repeated failure, a reusable tactic emerges, a repeated delegation role should become a subagent spec, a repeated procedure should become a skill, a durable fact/preference should become a memory, a narrow behavioral policy should become a prompt addendum, a user corrects behavior that should persist locally or globally, validation shows a continual harness entry is wrong, or a skill/subagent/memory/prompt note should be created, updated, deleted, or rolled back. Keep continual harness edits small and evidence-backed.\n\nCall contract: continual harness entries are routing/context hints only in sessions without IPython or shell access; do not use Python \`await\`, \`asyncio\`, \`rlm\`, or shell skill commands unless the prompt also documents those interfaces.\n\nprompt: 0\n\nmemory: 0\n\nskill: 0\n\nsubagent: 0\n\nNo saved harness entries yet.\n\nrecent refinements: 0";
const MAX_ISOLATED_SYSTEM_PROMPT_BYTES = 4096;

function taggedError(code) {
  const error = new Error(code);
  error.pylonPrimeCode = code;
  return error;
}

function classifyError(error) {
  if (error && typeof error === "object" && typeof error.pylonPrimeCode === "string") {
    return error.pylonPrimeCode;
  }
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (/quota|rate.?limit|billing|credit|capacity/.test(message)) return "quota";
  if (/auth|api.?key|credential|unauthorized|forbidden|sign.?in|log.?in/.test(message)) {
    return "auth";
  }
  if (/model|provider/.test(message)) return "model";
  return "request";
}

async function readInput() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.byteLength;
    if (bytes > MAX_INPUT_BYTES) throw taggedError("request");
    chunks.push(chunk);
  }
  const decoded = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
  if (!decoded || typeof decoded.prompt !== "string" || !Array.isArray(decoded.images)) {
    throw taggedError("request");
  }
  return decoded;
}

function selectedModel(modelSelector) {
  if (modelSelector === "default") return undefined;
  const separator = modelSelector.indexOf("/");
  if (separator <= 0 || separator === modelSelector.length - 1) {
    throw taggedError("model");
  }
  return {
    provider: modelSelector.slice(0, separator),
    id: modelSelector.slice(separator + 1),
  };
}

function requirePublicSdk(module) {
  const resourceLoaderPrototype = module?.DefaultResourceLoader?.prototype;
  if (
    typeof module?.createAgentSession !== "function" ||
    typeof module?.DefaultResourceLoader !== "function" ||
    typeof module?.SessionManager?.inMemory !== "function" ||
    typeof module?.SettingsManager?.create !== "function" ||
    typeof module?.SettingsManager?.inMemory !== "function" ||
    typeof resourceLoaderPrototype?.getExtensions !== "function" ||
    typeof resourceLoaderPrototype?.getLoadedExtensionPaths !== "function" ||
    typeof resourceLoaderPrototype?.getSkills !== "function" ||
    typeof resourceLoaderPrototype?.getPrompts !== "function" ||
    typeof resourceLoaderPrototype?.getThemes !== "function" ||
    typeof resourceLoaderPrototype?.getAgentsFiles !== "function" ||
    typeof resourceLoaderPrototype?.getSystemPrompt !== "function" ||
    typeof resourceLoaderPrototype?.getAppendSystemPrompt !== "function"
  ) {
    throw taggedError("sdk");
  }
  return module;
}

function requireEmptyResources(resourceLoader) {
  const extensions = resourceLoader.getExtensions();
  const loadedExtensionPaths = resourceLoader.getLoadedExtensionPaths();
  const skills = resourceLoader.getSkills();
  const prompts = resourceLoader.getPrompts();
  const themes = resourceLoader.getThemes();
  const agentsFiles = resourceLoader.getAgentsFiles();
  const systemPrompt = resourceLoader.getSystemPrompt();
  const appendSystemPrompt = resourceLoader.getAppendSystemPrompt();
  if (
    !Array.isArray(extensions?.extensions) ||
    extensions.extensions.length !== 0 ||
    !Array.isArray(loadedExtensionPaths) ||
    loadedExtensionPaths.length !== 0 ||
    !Array.isArray(skills?.skills) ||
    skills.skills.length !== 0 ||
    !Array.isArray(prompts?.prompts) ||
    prompts.prompts.length !== 0 ||
    !Array.isArray(themes?.themes) ||
    themes.themes.length !== 0 ||
    !Array.isArray(agentsFiles?.agentsFiles) ||
    agentsFiles.agentsFiles.length !== 0 ||
    systemPrompt !== PYLON_SYSTEM_PROMPT ||
    !Array.isArray(appendSystemPrompt) ||
    appendSystemPrompt.length !== 1 ||
    appendSystemPrompt[0] !== PYLON_FINAL_SYSTEM_BOUNDARY
  ) {
    throw taggedError("sdk");
  }
}

function isolatedAssistantText(session, input) {
  if (!Array.isArray(session.messages) || session.messages.length !== 2) return undefined;
  const [user, assistant] = session.messages;
  if (!user || user.role !== "user") return undefined;
  if (typeof user.content === "string") {
    if (input.images.length !== 0 || user.content !== input.prompt) return undefined;
  } else {
    if (!Array.isArray(user.content) || user.content.length !== input.images.length + 1) {
      return undefined;
    }
    const [text, ...images] = user.content;
    if (!text || text.type !== "text" || text.text !== input.prompt) return undefined;
    for (let index = 0; index < images.length; index += 1) {
      const actual = images[index];
      const expected = input.images[index];
      if (
        !actual ||
        actual.type !== "image" ||
        actual.data !== expected.data ||
        actual.mimeType !== expected.mimeType
      ) {
        return undefined;
      }
    }
  }
  if (!assistant || assistant.role !== "assistant" || !Array.isArray(assistant.content)) {
    return undefined;
  }
  const text = [];
  for (const part of assistant.content) {
    if (part?.type === "thinking" && typeof part.thinking === "string") continue;
    if (part?.type === "text" && typeof part.text === "string") {
      text.push(part.text);
      continue;
    }
    return undefined;
  }
  return { text: text.join("") };
}

const abortController = new AbortController();
const abortRequest = () => abortController.abort();
process.once("SIGTERM", abortRequest);
process.once("SIGINT", abortRequest);

let session;
let answer;
let failureCode;
try {
  const input = await readInput();
  const entryPath = process.env.PYLON_PRIME_SDK_ENTRY;
  const agentDir = process.env.PYLON_PRIME_AGENT_DIR;
  const modelSelector = process.env.PYLON_PRIME_MODEL;
  if (!entryPath || !agentDir || !modelSelector) throw taggedError("sdk");

  const sdk = requirePublicSdk(await import(pathToFileURL(entryPath).href));
  const requestedModel = selectedModel(modelSelector);
  const thinking = process.env.PYLON_PRIME_THINKING || undefined;
  const serviceTier = process.env.PYLON_PRIME_SERVICE_TIER || undefined;
  const installedSettings = sdk.SettingsManager.create(process.cwd(), agentDir);
  if (
    typeof installedSettings?.getDefaultProvider !== "function" ||
    typeof installedSettings?.getDefaultModel !== "function" ||
    typeof installedSettings?.getDefaultThinkingLevel !== "function" ||
    typeof installedSettings?.getDefaultServiceTier !== "function"
  ) {
    throw taggedError("sdk");
  }
  const inheritedProvider = installedSettings.getDefaultProvider();
  const inheritedModel = installedSettings.getDefaultModel();
  const inheritedThinking = installedSettings.getDefaultThinkingLevel();
  const inheritedServiceTier = installedSettings.getDefaultServiceTier();
  const inheritedModelPair =
    typeof inheritedProvider === "string" &&
    inheritedProvider &&
    typeof inheritedModel === "string" &&
    inheritedModel
      ? { provider: inheritedProvider, id: inheritedModel }
      : undefined;
  const inheritedThinkingLevel =
    typeof inheritedThinking === "string" && inheritedThinking ? inheritedThinking : undefined;
  const inheritedTier =
    typeof inheritedServiceTier === "string" && inheritedServiceTier
      ? inheritedServiceTier
      : undefined;
  const expectedModel = requestedModel || inheritedModelPair;
  const expectedThinking = thinking;
  const expectedServiceTier = serviceTier;
  const settingsManager = sdk.SettingsManager.inMemory({
    ...(inheritedModelPair
      ? { defaultProvider: inheritedModelPair.provider, defaultModel: inheritedModelPair.id }
      : {}),
    ...(inheritedThinkingLevel ? { defaultThinkingLevel: inheritedThinkingLevel } : {}),
    ...(inheritedTier ? { defaultServiceTier: inheritedTier } : {}),
    ...(requestedModel
      ? { defaultProvider: requestedModel.provider, defaultModel: requestedModel.id }
      : {}),
    ...(thinking ? { defaultThinkingLevel: thinking } : {}),
    ...(serviceTier ? { defaultServiceTier: serviceTier } : {}),
    rlmMaxDepth: 0,
    compaction: { enabled: false, agentCallable: false },
    autoRefine: { enabled: false, turnInterval: 0, compact: false, cooldownMs: 0 },
    retry: {
      enabled: false,
      maxRetries: 0,
      baseDelayMs: 0,
      provider: { timeoutMs: 170000, maxRetries: 0, maxRetryDelayMs: 0 },
    },
    branchSummary: { skipPrompt: true },
    telemetry: { enabled: false, noticeShown: true },
    agentTraces: { enabled: false },
    packages: [],
    extensions: [],
    skills: [],
    prompts: [],
    themes: [],
    mcpServers: {},
    enableSkillCommands: false,
    enableBuiltinSkills: false,
    bundledSkills: { websearch: false },
  });
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir,
    settingsManager,
    additionalExtensionPaths: [],
    additionalSkillPaths: [],
    additionalPromptTemplatePaths: [],
    additionalThemePaths: [],
    extensionFactories: [],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    bundledSkillsDir: null,
    systemPrompt: PYLON_SYSTEM_PROMPT,
    appendSystemPrompt: [PYLON_FINAL_SYSTEM_BOUNDARY],
    systemPromptOverride: () => PYLON_SYSTEM_PROMPT,
    appendSystemPromptOverride: () => [PYLON_FINAL_SYSTEM_BOUNDARY],
  });
  await resourceLoader.reload();
  requireEmptyResources(resourceLoader);

  const created = await sdk.createAgentSession({
    cwd: process.cwd(),
    agentDir,
    settingsManager,
    resourceLoader,
    sessionManager: sdk.SessionManager.inMemory(process.cwd()),
    ...(thinking ? { thinkingLevel: thinking } : {}),
    ...(serviceTier ? { serviceTier } : {}),
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
    autonomous: {
      enabled: false,
      maxContinuations: 0,
      maxTurns: 1,
      maxTokens: 0,
      timeoutMs: 170000,
      gates: { commands: [], maxRetries: 0, timeoutMs: 0 },
    },
    serializedRefine: false,
    telemetryDisabled: true,
  });
  session = created?.session;
  if (
    !session ||
    typeof session.promptAndWait !== "function" ||
    typeof session.getActiveToolNames !== "function" ||
    !("sessionFile" in session) ||
    typeof session.systemPrompt !== "string"
  ) {
    throw taggedError("sdk");
  }
  const activeToolNames = session.getActiveToolNames();
  const systemPromptHeader = PYLON_SYSTEM_PROMPT + "\nCurrent date: ";
  const systemPromptDate = session.systemPrompt.slice(
    systemPromptHeader.length,
    systemPromptHeader.length + 10,
  );
  const expectedSystemPromptPrefix =
    systemPromptHeader +
    systemPromptDate +
    "\nCurrent working directory: " +
    process.cwd().replace(/\\/gu, "/");
  const validSystemPromptDate = /^\d{4}-\d{2}-\d{2}$/u.test(systemPromptDate);
  const remainingSystemPrompt =
    validSystemPromptDate && session.systemPrompt.startsWith(expectedSystemPromptPrefix)
      ? session.systemPrompt.slice(expectedSystemPromptPrefix.length)
      : undefined;
  const finalBoundary = "\n\n" + PYLON_FINAL_SYSTEM_BOUNDARY;
  const emptyHarnessAndBoundary =
    "\n\n" + EMPTY_CONTINUAL_HARNESS_PROMPT + finalBoundary;
  if (
    !Array.isArray(activeToolNames) ||
    activeToolNames.length !== 0 ||
    session.sessionFile !== undefined ||
    Buffer.byteLength(session.systemPrompt, "utf8") > MAX_ISOLATED_SYSTEM_PROMPT_BYTES ||
    (remainingSystemPrompt !== finalBoundary &&
      remainingSystemPrompt !== emptyHarnessAndBoundary) ||
    ("rlmMaxDepth" in session && session.rlmMaxDepth !== 0)
  ) {
    throw taggedError("sdk");
  }

  if (
    expectedModel &&
    (session.model?.provider !== expectedModel.provider || session.model?.id !== expectedModel.id)
  ) {
    throw taggedError("model");
  }
  if (expectedThinking && session.thinkingLevel !== expectedThinking) throw taggedError("model");
  if (expectedServiceTier && session.serviceTier !== expectedServiceTier) {
    throw taggedError("model");
  }

  const images = input.images.map((image) => ({
    type: "image",
    data: image.data,
    mimeType: image.mimeType,
  }));
  await session.promptAndWait(input.prompt, {
    expandPromptTemplates: false,
    skipInputHandlers: true,
    suppressAutonomousContinuation: true,
    signal: abortController.signal,
    ...(images.length > 0 ? { images } : {}),
  });

  const isolatedResponse = isolatedAssistantText(session, input);
  if (!isolatedResponse) throw taggedError("sdk");
  answer = isolatedResponse.text.trim();
  if (!answer) throw taggedError("empty");
  if (Buffer.byteLength(answer, "utf8") > MAX_OUTPUT_BYTES) throw taggedError("oversize");
} catch (error) {
  failureCode = classifyError(error);
} finally {
  if (session) {
    try {
      if (typeof session.disposeAsync === "function") await session.disposeAsync();
      else if (typeof session.dispose === "function") session.dispose();
    } catch {
      failureCode ||= "request";
    }
  }
}

if (failureCode) {
  process.stderr.write("PYLON_PRIME_ERROR:" + failureCode + "\n");
  process.exitCode = 1;
} else {
  process.stdout.write(answer);
}
`;
