import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { CoordinatorReply, CoordinatorRequest } from "./graph.js";
import { projectInstructions, projectSessionDir, type StoryProject } from "./project.js";

/**
 * Project-limited Pi resources. Credentials continue to come from Pi's user-level
 * ModelRuntime; loading project resources must not implicitly inherit unrelated
 * global instructions, extensions, skills, prompts or tools.
 */
export function createProjectResourceLoader(project: StoryProject, agentDir = getAgentDir()) {
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
      agentsFilesOverride: () => ({ agentsFiles: projectInstructions(project) }),
      systemPromptOverride: () => undefined,
      appendSystemPromptOverride: () => [],
    }),
  };
}

/**
 * Pi owns provider credentials, OAuth refresh, and session history. Graph
 * orchestration owns the project namespace and the current invocation.
 */
export async function invokePiCoordinator(request: CoordinatorRequest): Promise<CoordinatorReply> {
  const modelRuntime = await ModelRuntime.create();
  const model = modelRuntime.getModel(request.provider, request.model);
  if (!model) {
    throw new Error(
      `Pi does not recognize model "${request.provider}/${request.model}". ` +
      "Run `pi --list-models`, then select a supported pair with " +
      "--provider <provider> --model <model> (or configure a custom Pi model). " +
      "The preferred gpt-6-luna default requires a provider that exposes it.",
    );
  }

  // Availability is not proof of subscription entitlement: live providers can
  // still reject a model, which we report as a failed run.
  let available;
  try {
    available = await modelRuntime.getAvailable(request.provider);
  } catch {
    throw new Error(
      `Pi could not verify credentials for provider "${request.provider}". ` +
      "Run `pi /login` or configure a supported provider API key.",
    );
  }
  if (!available.some((candidate) => candidate.id === request.model)) {
    throw new Error(
      `No usable Pi credential for provider "${request.provider}" and model "${request.model}". ` +
      "Use `pi /login` (including Codex OAuth where supported), or configure " +
      "that provider's API key through Pi or its supported environment variables.",
    );
  }

  const { loader, settingsManager } = createProjectResourceLoader(request.project);
  // Pi's SDK reloads only an implicitly created loader. Explicit loaders must
  // be initialized before session creation or project instructions are absent.
  await loader.reload();
  const { session } = await createAgentSession({
    modelRuntime,
    model,
    cwd: request.project.root,
    resourceLoader: loader,
    settingsManager,
    // Pi persists conversations in its supported project-specific session store.
    // Graph checkpoint and resume semantics are separate work in #6.
    sessionManager: SessionManager.create(
      request.project.root,
      projectSessionDir(request.project, getAgentDir()),
    ),
    noTools: "all",
    tools: [],
  });

  try {
    await session.prompt(request.task);
    const lastAssistant = [...session.messages].reverse().find((message) => message.role === "assistant");
    if (lastAssistant?.role === "assistant" &&
        (lastAssistant.stopReason === "error" || lastAssistant.stopReason === "aborted")) {
      throw new Error(
        `Pi did not complete the coordinator turn (${lastAssistant.stopReason}). ` +
        "Check model access, credentials and Pi's local diagnostics.",
      );
    }
    const response = session.getLastAssistantText();
    if (!response?.trim()) {
      throw new Error(
        "Pi completed without assistant text. Verify the provider/model combination, " +
        "credentials and available token quota.",
      );
    }
    return { response, piSessionId: session.sessionId };
  } finally {
    session.dispose();
  }
}
