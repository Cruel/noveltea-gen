import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { CoordinatorRequest } from "./graph.js";

/**
 * Pi retains responsibility for credential lookup, OAuth refresh and model calls.
 * No credentials are copied into LangGraph state, logs or NovelTea-gen files.
 */
export async function invokePiCoordinator(request: CoordinatorRequest): Promise<string> {
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

  // Pi's supported runtime handles saved OAuth, refresh and environment/API keys.
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

  const { session } = await createAgentSession({
    modelRuntime,
    model,
    sessionManager: SessionManager.inMemory(),
    // #3 adds explicit, isolated Story project roots.
    cwd: process.cwd(),
    noTools: "all",
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
    return response;
  } finally {
    session.dispose();
  }
}
