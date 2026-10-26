/**
 * Local LangGraph Studio entry point. Unlike the CLI, the Studio server owns
 * graph invocation/checkpointing. Pi histories continue in project-scoped files.
 * This is an interactive single-run-at-a-time development adapter, not a
 * production graph worker / multi-user execution service.
 */
import { randomUUID } from "node:crypto";
import { getCurrentRunTree } from "langsmith/singletons/traceable";
import { createCoordinatorGraph, validateHandoff, type DelegationAdapters } from "./graph.js";
import { openStoryProject } from "./project.js";
import { loadSkillConfig } from "./skills.js";
import { createSkillSnapshot } from "./snapshot.js";
import { createPiDelegationAdapters } from "./pi.js";
import { provenanceMetadata, tracingEnabled } from "./tracing.js";
import { loadLocalLangSmithCredentials } from "./langsmith-config.js";

const cloud = process.env.NT_STUDIO_TRACE === "1";
if (cloud) loadLocalLangSmithCredentials();
tracingEnabled(cloud);
process.env.LANGSMITH_TRACING = cloud ? "true" : "false";
process.env.LANGCHAIN_TRACING_V2 = cloud ? "true" : "false";
process.env.TRACE_TO_LANGSMITH = cloud ? "true" : "false";

const config = await loadSkillConfig();
const snapshot = await createSkillSnapshot(config);
const build = () => {
  const pi = createPiDelegationAdapters(config, cloud);
  pi.pinSkillSnapshot(snapshot);
  return pi;
};
let active = build();
let busy = false;
function reset() {
  active.dispose?.();
  active = build();
  busy = false;
}

const adapters: DelegationAdapters = {
  async startPi(request) {
    if (busy) {
      throw new Error("Studio PoC supports one in-flight graph execution at a time.");
    }
    // Reserve the slot BEFORE awaiting disk I/O; overlapping Studio threads
    // must never share the same live Pi adapter and conversation state.
    busy = true;
    try {
      // Preserve canonical root identity for manually supplied Studio state.
      const resolved = await openStoryProject(request.project.root);
      if (resolved.root !== request.project.root || resolved.id !== request.project.id) {
        throw new Error("Studio projectRoot/projectId mismatch; use the canonical Story root and its SHA-256 ID.");
      }
      active.configureTrace(provenanceMetadata({
        runId: getCurrentRunTree(true)?.trace_id ?? randomUUID(),
        threadId: resolved.id,
        projectId: resolved.id,
        snapshot,
      }));
      const result = await active.startPi(request);
      // Graph-level validation can otherwise fail after startPi returns and
      // strand this Studio worker in the busy state.
      validateHandoff(result.handoff);
      if (!result.piSessionId?.trim()) throw new Error("Pi coordinator did not return a session identity.");
      return result;
    } catch (error) {
      reset();
      throw error;
    }
  },
  async invokeWorker(request) {
    try { return await active.invokeWorker(request); }
    catch (error) { reset(); throw error; }
  },
  async invokeDirectWorker(request) {
    try { return await active.invokeDirectWorker(request); }
    catch (error) { reset(); throw error; }
  },
  async resumePi(request) {
    try { return await active.resumePi(request); }
    finally { reset(); }
  },
};

/** Graph nodes/branches are the same as the CLI graph; no extra fake graph. */
export const graph = createCoordinatorGraph(adapters);
