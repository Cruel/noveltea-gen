import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  validateHandoff,
  type DelegationAdapters,
  type WorkerReply,
} from "./graph.js";
import { projectInstructions, projectSessionDir, type StoryProject } from "./project.js";

/**
 * Project-limited resources. The worker deliberately receives no AGENTS context:
 * its only task data is the graph's explicitly projected work object.
 */
export function createProjectResourceLoader(
  project: StoryProject,
  agentDir = getAgentDir(),
  includeProjectInstructions = true,
) {
  const settingsManager = SettingsManager.inMemory();
  return {
    settingsManager,
    loader: new DefaultResourceLoader({
      cwd: project.root,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
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

/** This tool only records Pi's intent; it NEVER runs a worker or edits graph state. */
export function createHandoffRecorder(): { tool: ToolDefinition; getIntent: () => unknown } {
  const attempts: unknown[] = [];
  const tool: ToolDefinition = {
    name: "delegate_to_worker",
    label: "Delegate to graph worker",
    description:
      "Yield work to a LangGraph node. Invoke exactly once with destination " +
      "'story_note_worker' and a concise brief for the worker. " +
      "Do not try to perform the work yourself. The worker will run after your turn settles.",
    parameters: {
      type: "object",
      properties: {
        destination: { type: "string", description: "The LangGraph worker node: story_note_worker" },
        brief: { type: "string", description: "Instruction sent to the worker" },
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

/** Worker replies are model output, never trusted as graph updates without validation. */
export function parseWorkerOutput(text: string): WorkerReply["update"] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Invalid worker output: expected an exact JSON object with storyNote.");
  }
  if (typeof parsed !== "object" || !parsed || Array.isArray(parsed) ||
      Object.keys(parsed).length !== 1 || !Object.hasOwn(parsed, "storyNote") ||
      typeof (parsed as { storyNote?: unknown }).storyNote !== "string" ||
      !(parsed as { storyNote: string }).storyNote.trim()) {
    throw new Error("Invalid worker output: expected one nonempty storyNote string.");
  }
  return { storyNote: (parsed as { storyNote: string }).storyNote };
}

/**
 * One graph invocation owns a live coordinator session across start -> worker ->
 * continuation. #6 will introduce checkpointed cross-process recovery; this
 * closure must not be mistaken for durable checkpoint/session restoration.
 */
export function createPiDelegationAdapters(): DelegationAdapters {
  let coordinator: AgentSession | undefined;
  let worker: AgentSession | undefined;
  let runtime: ModelRuntime | undefined;
  let project: StoryProject | undefined;
  let provider: string | undefined;
  let modelName: string | undefined;

  async function startSession(
    root: StoryProject,
    currentProvider: string,
    currentModel: string,
    tools: ToolDefinition[],
    includeProjectInstructions: boolean,
  ): Promise<AgentSession> {
    runtime ??= await ModelRuntime.create();
    const model = runtime.getModel(currentProvider, currentModel);
    if (!model) {
      throw new Error(
        `Pi does not recognize model "${currentProvider}/${currentModel}". ` +
        "Run `pi --list-models` to select a supported pair.",
      );
    }
    let available;
    try {
      available = await runtime.getAvailable(currentProvider);
    } catch {
      throw new Error(`Pi could not verify credentials for provider "${currentProvider}". Use pi /login.`);
    }
    if (!available.some((candidate) => candidate.id === currentModel)) {
      throw new Error(`No usable Pi credential for provider "${currentProvider}" and model "${currentModel}". Use pi /login.`);
    }

    const { loader, settingsManager } = createProjectResourceLoader(root, getAgentDir(), includeProjectInstructions);
    await loader.reload();
    const { session } = await createAgentSession({
      modelRuntime: runtime,
      model,
      cwd: root.root,
      resourceLoader: loader,
      settingsManager,
      sessionManager: SessionManager.create(root.root, projectSessionDir(root, getAgentDir())),
      noTools: "all",
      tools: tools.map(t => t.name),
      customTools: tools,
    });
    return session;
  }

  return {
    async startPi(request) {
      if (coordinator) throw new Error("Coordinator has already been started.");
      project = request.project;
      provider = request.provider;
      modelName = request.model;
      const recorder = createHandoffRecorder();
      coordinator = await startSession(project, provider, modelName, [recorder.tool], true);
      await coordinator.prompt(
        "You are the Story coordinator. Analyze the user's task and choose a delegated graph " +
        "worker by calling delegate_to_worker exactly once with destination story_note_worker " +
        "and a brief asking for a useful Story concept or twist. Do not write the worker result " +
        "yourself and do not call any other tool. The graph will return a worker note to your " +
        "same conversation in a subsequent turn.\n\nUser task:\n" + request.task,
      );
      assertCompleted(coordinator, "coordinator handoff");
      const handoff = recorder.getIntent();
      // Once yielded, the continuation is answer-only: a second delegated tool
      // call would otherwise be recorded but not routed by the finished graph.
      coordinator.setActiveToolsByName([]);
      return { piSessionId: coordinator.sessionId, handoff };
    },
    async invokeWorker(request) {
      if (!coordinator || !project || !provider || !modelName) {
        throw new Error("Cannot invoke worker before Pi handoff.");
      }
      if (worker) throw new Error("Worker was already invoked.");
      worker = await startSession(request.project, request.provider, request.model, [], false);
      await worker.prompt(
        "You are an isolated Story-note worker. Respond ONLY with valid JSON, exactly " +
        '{"storyNote":"a useful, concise narrative note"}, with no Markdown. ' +
        "You must use only the supplied work data.\nWork:\n" + JSON.stringify(request.work),
      );
      const update = parseWorkerOutput(assertText(worker, "worker"));
      return { piSessionId: worker.sessionId, update };
    },
    async resumePi(request) {
      if (!coordinator || !worker) throw new Error("Cannot resume Pi before the worker has completed.");
      const sessionId = coordinator.sessionId;
      await coordinator.prompt(
        "LangGraph completed the handoff. The separate worker Pi session " +
        JSON.stringify(request.workerPiSessionId) +
        " updated the shared storyNote field to " + JSON.stringify(request.storyNote) +
        ". Use this note to answer the original user's task in a concise reply. " +
        "Do not call delegate_to_worker again.",
      );
      return { piSessionId: sessionId, response: assertText(coordinator, "continuation") };
    },
    dispose() {
      worker?.dispose();
      coordinator?.dispose();
    },
  };
}
