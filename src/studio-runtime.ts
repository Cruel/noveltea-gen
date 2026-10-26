import { randomUUID } from "node:crypto";
import { getCurrentRunTree } from "langsmith/singletons/traceable";
import { validateHandoff, type DelegationAdapters } from "./graph.js";
import { openStoryProject } from "./project.js";
import type { SkillSnapshot } from "./snapshot.js";
import { provenanceMetadata } from "./tracing.js";

export interface StudioPiAdapters extends DelegationAdapters {
  pinSkillSnapshot(snapshot: SkillSnapshot | undefined): void;
  configureTrace(metadata: Record<string, string | boolean>): void;
}

/**
 * Each Studio invocation owns one adapter and one freshly captured snapshot.
 * The snapshot returned by startPi is also committed into LangGraph state by
 * the coordinator node. We never trust stale/unvalidated Studio input state.
 */
export function createStudioAdapters(
  prepare: () => Promise<{ pi: StudioPiAdapters; snapshot: SkillSnapshot | undefined }>,
): DelegationAdapters {
  let active: StudioPiAdapters | undefined;
  let busy = false;

  async function reset() {
    const previous = active;
    active = undefined;
    try { await previous?.dispose?.(); }
    finally { busy = false; }
  }
  function current(): StudioPiAdapters {
    if (!active || !busy) throw new Error("Studio has no active Pi workflow.");
    return active;
  }
  return {
    async startPi(request) {
      if (busy) throw new Error("Studio PoC supports one in-flight graph execution at a time.");
      // Set before any await, so concurrent Studio graph threads cannot share
      // Pi sessions or change one another's snapshot.
      busy = true;
      try {
        const project = await openStoryProject(request.project.root);
        if (project.root !== request.project.root || project.id !== request.project.id) {
          throw new Error("Studio projectRoot/projectId mismatch; use the canonical Story root and its SHA-256 ID.");
        }
        const selected = await prepare();
        active = selected.pi;
        selected.pi.pinSkillSnapshot(selected.snapshot);
        selected.pi.configureTrace(provenanceMetadata({
          runId: getCurrentRunTree(true)?.trace_id ?? randomUUID(),
          threadId: project.id,
          projectId: project.id,
          snapshot: selected.snapshot,
        }));
        const result = await selected.pi.startPi(request);
        validateHandoff(result.handoff);
        if (!result.piSessionId?.trim()) throw new Error("Pi coordinator did not return a session identity.");
        return { ...result, skillSnapshot: selected.snapshot ?? null };
      } catch (error) {
        await reset();
        throw error;
      }
    },
    async invokeWorker(request) {
      try { return await current().invokeWorker(request); }
      catch (error) { await reset(); throw error; }
    },
    async invokeDirectWorker(request) {
      try { return await current().invokeDirectWorker(request); }
      catch (error) { await reset(); throw error; }
    },
    async resumePi(request) {
      try { return await current().resumePi(request); }
      finally { await reset(); }
    },
  };
}
