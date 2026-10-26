import { getCurrentRunTree } from "langsmith/singletons/traceable";
import { traceable } from "langsmith/traceable";
import langsmithExtension from "@langchain/langsmith-pi-extension";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { Client } from "langsmith";
import type { SkillSnapshot } from "./snapshot.js";

/**
 * Only stable, non-secret identifiers are admitted to graph/Pi trace metadata.
 * Never put skill contents, paths, Pi credentials, source diffs, or provider
 * request objects into this metadata. Prompt/tool content can be visible in
 * explicitly opted-in model traces; that's separate from provenance metadata.
 */
export function provenanceMetadata(input: {
  runId: string; threadId: string; projectId: string; snapshot?: SkillSnapshot;
}): Record<string, string | boolean> {
  const metadata: Record<string, string | boolean> = {
    "noveltea.run_id": input.runId,
    "noveltea.thread_id": input.threadId,
    "noveltea.project_id": input.projectId,
  };
  const snap = input.snapshot;
  if (snap) {
    metadata["noveltea.skill_snapshot_id"] = snap.id;
    metadata["noveltea.skill_digest"] = snap.digest;
    metadata["noveltea.skill_commit"] = snap.commit;
    metadata["noveltea.skill_branch"] = snap.branch ?? "DETACHED";
    metadata["noveltea.skill_dirty"] = snap.dirty;
  }
  return metadata;
}

export function tracingEnabled(traceRequested: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!traceRequested) return false;
  if (!env.LANGSMITH_API_KEY?.trim()) {
    throw new Error("--trace requires LANGSMITH_API_KEY. Without --trace, no cloud traces are uploaded.");
  }
  return true;
}

/** Inline-only: global and project Pi extensions stay disabled. */
export function piTraceExtensions(enabled: boolean, metadata: Record<string, string | boolean>, client?: Client): InlineExtension[] {
  if (!enabled) return [];
  return [
    (pi) => langsmithExtension(pi, {
      ...(client ? { client } : {}),
      config: {
        enabled: true,
        // Explicit credentials/project. Never read ~/.pi/langsmith.json or
        // .pi/langsmith.json, even if those files enable tracing or replicas.
        api_key: process.env.LANGSMITH_API_KEY,
        project: process.env.LANGSMITH_PROJECT || "noveltea-gen",
        metadata,
      },
      // Link to the currently executing LangGraph node's LangSmith run.
      // The explicit callback avoids the extension's nested SDK version
      // resolving an independent AsyncLocalStorage context.
      getCurrentRunTree: () => getCurrentRunTree(true),
    }),
  ];
}

export interface DirectTraceRequest {
  provider: string;
  model: string;
  brief: string;
}

export interface DirectTraceResult {
  text: string;
  stopReason: string;
  usage?: {
    input?: number;
    output?: number;
    totalTokens?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}

export function directTraceOutput(value: DirectTraceResult): Record<string, unknown> {
  return {
    response: value.text,
    stop_reason: value.stopReason,
    ...(value.usage ? { usage_metadata: {
      input_tokens: (value.usage.input ?? 0) + (value.usage.cacheRead ?? 0) + (value.usage.cacheWrite ?? 0),
      output_tokens: value.usage.output ?? 0,
      total_tokens: value.usage.totalTokens ??
        ((value.usage.input ?? 0) + (value.usage.output ?? 0) +
         (value.usage.cacheRead ?? 0) + (value.usage.cacheWrite ?? 0)),
      input_token_details: {
        cache_read: value.usage.cacheRead ?? 0,
        cache_creation: value.usage.cacheWrite ?? 0,
      },
    } } : {}),
  };
}

export class DirectModelStopError extends Error {
  constructor(readonly stopReason: string) {
    super(`Direct model returned stopReason: ${stopReason}.`);
  }
}

function safeStopReason(value: string): string {
  return ["error", "aborted", "length", "toolUse"].includes(value) ? value : "unexpected";
}

/** Bare pi-ai calls have no Pi events, so trace exactly one model span. */
export async function traceDirectModel(
  enabled: boolean,
  request: DirectTraceRequest,
  invoke: () => Promise<DirectTraceResult>,
): Promise<DirectTraceResult> {
  if (!enabled) return invoke();
  // No arbitrary SDK/provider objects enter the trace: just the model request
  // brief, completion text, token usage and sanitized errors from the caller.
  return traceable(async (_input: DirectTraceRequest) => {
    try {
      const result = await invoke();
      if (result.stopReason !== "stop") {
        // A provider can report failure, abort or truncation without throwing.
        // The adapter rejects every non-stop completion; the LLM span must
        // record the same outcome without retaining an untrusted reason string.
        const reason = safeStopReason(result.stopReason);
        const span = getCurrentRunTree(true);
        if (span) span.outputs = directTraceOutput({ ...result, stopReason: reason });
        throw new DirectModelStopError(reason);
      }
      return result;
    } catch (error) {
      if (error instanceof DirectModelStopError) throw error;
      // SDK errors may contain credentials, headers or raw provider payloads.
      throw new Error("Direct model provider request failed (provider details redacted).");
    }
  }, {
    name: "pi-ai direct model request",
    run_type: "llm",
    metadata: { ls_provider: request.provider, ls_model_name: request.model },
    processInputs: (input) => ({ provider: input.provider, model: input.model, brief: input.brief }),
    processOutputs: (result) => directTraceOutput(result as DirectTraceResult),
  })(request);
}
