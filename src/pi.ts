import { join, sep } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
  type AgentSession,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import {
  DIRECT_WORKER_DESTINATION,
  WORKER_DESTINATION,
  validateHandoff,
  type DelegationAdapters,
  type WorkerDestination,
  type WorkerReply,
  type DirectWorkerReply,
} from "./graph.js";
import { openPersistedSession } from "./checkpoint.js";
import { projectInstructions, projectSessionDir, type StoryProject } from "./project.js";
import { createSkillReadTool, resolveConfiguredSkills, roleVisibleSkills, type SkillConfig, type SkillReadRole } from "./skills.js";
import { verifiedSkillFiles, type SkillSnapshot } from "./snapshot.js";
import { DirectModelStopError, piTraceExtensions, traceDirectModel } from "./tracing.js";
import type { Client } from "langsmith";

/**
 * Project-limited resources. The Pi worker deliberately receives no AGENTS
 * context: its only task data is the graph's explicitly projected work object.
 * The direct-model worker never constructs this loader or a Pi agent session.
 */
export function createProjectResourceLoader(
  project: StoryProject,
  agentDir = getAgentDir(),
  includeProjectInstructions = true,
  config: SkillConfig = { discovery: "explicit-only", skillDirs: [], requiredSkills: [] },
  traceExtensions: InlineExtension[] = [],
  role: SkillReadRole = "specialist",
  // Opt in only for a controller-authenticated Collaborative Turn.
  allowCollaborativeMethod = false,
) {
  const settingsManager = SettingsManager.inMemory();
  return {
    settingsManager,
    loader: new DefaultResourceLoader({
      cwd: project.root,
      agentDir,
      settingsManager,
      noExtensions: true,
      extensionFactories: traceExtensions,
      noSkills: !includeProjectInstructions || config.discovery === "explicit-only",
      skillsOverride: (base) => {
        if (!includeProjectInstructions) return { skills: [], diagnostics: [] };
        const found = resolveConfiguredSkills(base, config, project.root, agentDir);
        if (!config.novelteaSkills) return found;
        const pinnedRoot = join(config.novelteaSkills, "skills") + sep;
        const pinned = found.skills.filter(skill => skill.filePath.startsWith(pinnedRoot));
        const visible = new Set(roleVisibleSkills(pinned, role, allowCollaborativeMethod));
        return { ...found, skills: found.skills.filter(skill =>
          visible.has(skill) || (!skill.filePath.startsWith(pinnedRoot) && !skill.name.startsWith("nt-"))) };
      },
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      agentsFilesOverride: () => ({
        agentsFiles: includeProjectInstructions ? projectInstructions(project) : [],
      }),
      systemPromptOverride: () => undefined,
      appendSystemPromptOverride: () => [],
    }),
  };
}

/** Tool records Pi's selected destination; it never executes either worker. */
export function createHandoffRecorder(): { tool: ToolDefinition; getIntent: () => unknown } {
  const attempts: unknown[] = [];
  const tool: ToolDefinition = {
    name: "delegate_to_worker",
    label: "Delegate to graph worker",
    description:
      "Yield work to a LangGraph node. Choose story_note_worker for plot development, twists, or " +
      "story concepts, or direct_tagline_worker for concise promotional taglines, slogans and hooks. " +
      "Supply exactly one destination and an actionable brief. The tool only records intent; " +
      "the chosen graph worker executes after your turn settles.",
    parameters: {
      type: "object",
      properties: {
        destination: {
          type: "string",
          enum: [WORKER_DESTINATION, DIRECT_WORKER_DESTINATION],
          description: "Which mutually exclusive LangGraph worker should execute",
        },
        brief: { type: "string", description: "Specific task for the selected worker" },
      },
      required: ["destination", "brief"],
      additionalProperties: false,
    } as ToolDefinition["parameters"],
    executionMode: "sequential",
    async execute(_id, params) {
      attempts.push(params);
      return {
        content: [{ type: "text", text: "Handoff recorded for LangGraph. End this turn; the graph will invoke the worker." }],
        details: undefined,
      };
    },
  };
  return {
    tool,
    getIntent(): unknown {
      if (attempts.length !== 1) {
        throw new Error(`Invalid Pi handoff: expected exactly one delegate_to_worker call, got ${attempts.length}.`);
      }
      return validateHandoff(attempts[0]);
    },
  };
}

function assertCompleted(session: AgentSession, role: string): void {
  const lastAssistant = [...session.messages].reverse().find((message) => message.role === "assistant");
  if (lastAssistant?.role === "assistant" &&
      (lastAssistant.stopReason === "error" || lastAssistant.stopReason === "aborted")) {
    throw new Error(`Pi ${role} did not complete (${lastAssistant.stopReason}). Check credentials and model access.`);
  }
}

function assertText(session: AgentSession, role: string): string {
  assertCompleted(session, role);
  const response = session.getLastAssistantText();
  if (!response?.trim()) {
    throw new Error(`Pi ${role} completed without assistant text.`);
  }
  return response;
}

/** Parse a single worker-owned field; never merge arbitrary JSON into graph state. */
function parseStringUpdate(text: string, field: "storyNote" | "tagline", label: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Invalid ${label} output: expected an exact JSON object with ${field}.`);
  }
  if (typeof parsed !== "object" || !parsed || Array.isArray(parsed) ||
      Object.keys(parsed).length !== 1 || !Object.hasOwn(parsed, field) ||
      typeof (parsed as Record<string, unknown>)[field] !== "string" ||
      !(parsed as Record<string, string>)[field]?.trim()) {
    throw new Error(`Invalid ${label} output: expected one nonempty ${field} string.`);
  }
  return (parsed as Record<string, string>)[field]!;
}

export function parseWorkerOutput(text: string): WorkerReply["update"] {
  return { storyNote: parseStringUpdate(text, "storyNote", "worker") };
}

export function parseDirectWorkerOutput(text: string): DirectWorkerReply["update"] {
  return { tagline: parseStringUpdate(text, "tagline", "direct worker") };
}

/**
 * A graph invocation owns its original Pi session until the chosen worker
 * returns. Only story_note_worker creates a second Pi agent session.
 * Direct calls use Pi's ModelRuntime.completeSimple() with the same credential
 * runtime used by the coordinator (OAuth refresh and API keys supported).
 */
export function createPiDelegationAdapters(
  config: SkillConfig = { discovery: "explicit-only", skillDirs: [], requiredSkills: [] },
  trace = false,
  traceClient?: Client,
): DelegationAdapters & {
  pinSkillSnapshot: (snapshot: SkillSnapshot | undefined) => void;
  configureTrace: (metadata: Record<string, string | boolean>) => void;
} {
  let activeConfig = config;
  let pinned: SkillSnapshot | undefined;
  let coordinator: AgentSession | undefined;
  let worker: AgentSession | undefined;
  let runtime: ModelRuntime | undefined;
  let selected: WorkerDestination | undefined;
  let directCompleted = false;
  let coordinatorReadEnabled = false;
  let traceMetadata: Record<string, string | boolean> = {};

  async function getUsableModel(currentProvider: string, currentModel: string) {
    runtime ??= await ModelRuntime.create();
    const model = runtime.getModel(currentProvider, currentModel);
    if (!model) {
      throw new Error(
        `Pi does not recognize model "${currentProvider}/${currentModel}". ` +
        "Run pi --list-models to select a supported pair.",
      );
    }
    let available;
    try {
      available = await runtime.getAvailable(currentProvider);
    } catch {
      throw new Error(`Pi could not verify credentials for provider "${currentProvider}". Use pi /login or a supported API key.`);
    }
    if (!available.some((candidate) => candidate.id === currentModel)) {
      throw new Error(
        `No usable Pi credential for provider "${currentProvider}" and model "${currentModel}". ` +
        "Use pi /login or configure a supported API key.",
      );
    }
    return model;
  }

  async function startSession(
    root: StoryProject,
    currentProvider: string,
    currentModel: string,
    tools: ToolDefinition[],
    includeProjectInstructions: boolean,
    existingSession?: SessionManager,
  ): Promise<AgentSession> {
    const model = await getUsableModel(currentProvider, currentModel);
    const { loader, settingsManager } = createProjectResourceLoader(
      root, getAgentDir(), includeProjectInstructions, activeConfig,
      piTraceExtensions(trace || Boolean(traceClient), traceMetadata, traceClient),
    );
    await loader.reload();
    const skillResult = loader.getSkills();
    for (const diagnostic of skillResult.diagnostics) {
      if (diagnostic.type === "error") throw new Error(`Skill discovery error at ${diagnostic.path}: ${diagnostic.message}`);
      if (diagnostic.type === "collision") process.stderr.write(`noveltea-gen: ${diagnostic.message}\n`);
    }
    const skillTools = includeProjectInstructions && skillResult.skills.length
      ? [createSkillReadTool(skillResult.skills, pinned ? await verifiedSkillFiles(pinned.id) : undefined)] : [];
    if (includeProjectInstructions) coordinatorReadEnabled = skillTools.length > 0;
    const activeTools = [...tools, ...skillTools];
    const { session } = await createAgentSession({
      modelRuntime: runtime!,
      model,
      cwd: root.root,
      resourceLoader: loader,
      settingsManager,
      sessionManager: existingSession ?? SessionManager.create(root.root, projectSessionDir(root, getAgentDir())),
      noTools: "all",
      tools: activeTools.map(t => t.name),
      customTools: activeTools,
    });
    return session;
  }

  return {
    configureTrace(metadata) { traceMetadata = metadata; },
    pinSkillSnapshot(snapshot) {
      pinned = snapshot;
      activeConfig = snapshot ? { ...config, novelteaSkills: snapshot.path } : { ...config, novelteaSkills: undefined, requiredSkills: [] };
    },
    async restorePi(input) {
      if (coordinator || worker) {
        throw new Error("Cannot restore Pi: adapter already holds a live session.");
      }
      selected = input.destination;
      const request = input.request;
      const coordinatorManager = await openPersistedSession(
        request.project, "pi", input.coordinator,
      );
      coordinator = await startSession(
        request.project, request.provider, request.model,
        [], true, coordinatorManager,
      );
      if (coordinator.sessionId !== input.coordinator.id) {
        throw new Error("Cannot recover Pi coordinator: session identity changed.");
      }
      coordinator.setActiveToolsByName(coordinatorReadEnabled ? ["read"] : []);
      if (input.worker) {
        const workerManager = await openPersistedSession(
          request.project, "pi", input.worker,
        );
        worker = await startSession(
          request.project, request.provider, request.model,
          [], false, workerManager,
        );
        if (worker.sessionId !== input.worker.id) {
          throw new Error("Cannot recover Pi worker: session identity changed.");
        }
      }
      directCompleted = input.destination === DIRECT_WORKER_DESTINATION &&
        input.workerCompleted;
    },
    async startPi(request) {
      if (coordinator) throw new Error("Coordinator has already been started.");
      const recorder = createHandoffRecorder();
      coordinator = await startSession(request.project, request.provider, request.model, [recorder.tool], true);
      await coordinator.prompt(
        "You are the Story coordinator. If the user requests an available skill, " +
        "use the read tool to load its SKILL.md and any relevant bundled references first. " +
        "The read tool only accesses advertised skill resources; do not try to read Story files. " +
        "Then choose exactly ONE LangGraph worker and call " +
        "delegate_to_worker exactly once. For concise promotional taglines, slogans, or hooks, " +
        "choose direct_tagline_worker and brief it to write a punchy one-line tagline. " +
        "For story concepts, premises, plot development, or twists, choose story_note_worker " +
        "and brief it to propose a useful narrative note. Choose based on the user's requested " +
        "work, not an external router. Do not complete the worker task yourself. The graph will " +
        "return the selected worker's result to this same conversation after your turn settles.\n\n" +
        "User task:\n" + request.task,
      );
      assertCompleted(coordinator, "coordinator handoff");
      const handoff = validateHandoff(recorder.getIntent());
      selected = handoff.destination;
      // The resumed coordinator must answer, not initiate a second untracked handoff.
      coordinator.setActiveToolsByName(coordinatorReadEnabled ? ["read"] : []);
      const piSessionFile = coordinator.sessionManager.getSessionFile();
      return { piSessionId: coordinator.sessionId, piSessionFile, handoff };
    },
    async invokeWorker(request) {
      if (!coordinator || selected !== WORKER_DESTINATION) {
        throw new Error("Pi worker invoked without its selected handoff.");
      }
      if (worker || directCompleted) throw new Error("A worker has already been invoked.");
      worker = await startSession(request.project, request.provider, request.model, [], false);
      await worker.prompt(
        "You are an isolated Story-note worker. Respond ONLY with valid JSON, exactly " +
        '{"storyNote":"a useful, concise narrative note"}, with no Markdown. ' +
        "You must use only the supplied work data.\nWork:\n" + JSON.stringify(request.work),
      );
      const update = parseWorkerOutput(assertText(worker, "worker"));
      return { piSessionId: worker.sessionId,
        piSessionFile: worker.sessionManager.getSessionFile(), update };
    },
    async invokeDirectWorker(request) {
      if (!coordinator || selected !== DIRECT_WORKER_DESTINATION) {
        throw new Error("Direct worker invoked without its selected handoff.");
      }
      if (worker || directCompleted) throw new Error("A worker has already been invoked.");
      const model = await getUsableModel(request.provider, request.model);
      // This is a direct pi-ai model call, with no agent loop, Pi session,
      // project context, skills, tools, or transcript from the coordinator.
      let completion;
      try {
        const invoke = async () => runtime!.completeSimple(model, {
          systemPrompt: "You are a concise Story-marketing copywriter. Return ONLY a JSON object " +
            'with exactly one string property: {"tagline":"a compelling one-line story hook"}. ' +
            "No Markdown or explanations. Use only the supplied brief.",
          messages: [{ role: "user", content: JSON.stringify(request.work), timestamp: Date.now() }],
        }, { maxTokens: 512 });
        completion = await traceDirectModel(trace || Boolean(traceClient), {
          provider: request.provider, model: request.model, brief: request.work.brief,
        }, async () => {
          const result = await invoke();
          return {
            text: result.content.filter(item => item.type === "text").map(item => item.text).join(""),
            stopReason: result.stopReason,
            usage: result.usage,
          };
        });
      } catch (error) {
        if (error instanceof DirectModelStopError) {
          throw new Error(`Direct model did not finish (stopReason: ${error.stopReason}). Check model access, quota and output limits.`);
        }
        // Provider SDK messages are not necessarily secret-safe. Do not leak
        // tokens, request headers, or raw provider payloads into graph/CLI logs.
        throw new Error(
          `Direct model request failed for "${request.provider}/${request.model}". ` +
          "Check Pi login/API key, provider availability, model access and token quota.",
        );
      }
      if (completion.stopReason !== "stop") {
        throw new Error(
          `Direct model did not finish (stopReason: ${completion.stopReason}). ` +
          "Check model access, quota and output limits.",
        );
      }
      const update = parseDirectWorkerOutput(completion.text);
      directCompleted = true;
      return { update };
    },
    async resumePi(request) {
      if (!coordinator || selected !== request.destination) {
        throw new Error("Cannot resume Pi without the chosen worker's result.");
      }
      let updateSummary: string;
      if (request.destination === WORKER_DESTINATION) {
        if (!worker || worker.sessionId !== request.workerPiSessionId) {
          throw new Error("Cannot resume Pi without the validated worker session.");
        }
        updateSummary = "The separate Pi worker session " + JSON.stringify(request.workerPiSessionId) +
          " updated the shared storyNote field to " + JSON.stringify(request.storyNote) + ".";
      } else {
        if (!directCompleted || worker) throw new Error("Cannot resume Pi before direct model completion.");
        updateSummary = "The direct-model worker updated the shared tagline field to " +
          JSON.stringify(request.tagline) + ". It did not create a Pi session.";
      }
      const sessionId = coordinator.sessionId;
      await coordinator.prompt(
        "LangGraph completed the handoff. " + updateSummary +
        " Use this validated result to answer the original user's request in a concise reply.",
      );
      return { piSessionId: sessionId, response: assertText(coordinator, "continuation") };
    },
    dispose() {
      worker?.dispose();
      coordinator?.dispose();
    },
  };
}
