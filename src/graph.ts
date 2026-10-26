import { randomUUID } from "node:crypto";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { openCheckpointer, openPersistedSession, type ExecutionMode, type PiSessionReference } from "./checkpoint.js";
import { scopeThread, type StoryProject } from "./project.js";
import { openSkillSnapshot, type SkillSnapshot } from "./snapshot.js";
import { provenanceMetadata } from "./tracing.js";

/** Fixed, closed routing table. Pi chooses; LangGraph validates and routes. */
export const WORKER_DESTINATION = "story_note_worker" as const;
export const DIRECT_WORKER_DESTINATION = "direct_tagline_worker" as const;
export type WorkerDestination = typeof WORKER_DESTINATION | typeof DIRECT_WORKER_DESTINATION;

export interface CoordinatorRequest {
  task: string;
  provider: string;
  model: string;
  project: StoryProject;
}

export interface HandoffIntent {
  destination: WorkerDestination;
  brief: string;
}

export interface CoordinatorStartReply {
  piSessionId: string;
  piSessionFile?: string;
  /** Untrusted Pi tool payload. A graph transition requires strict validation. */
  handoff: unknown;
  /** Studio picks a snapshot at actual graph start; persist exactly that one. */
  skillSnapshot?: SkillSnapshot | null;
}

export interface WorkerRequest {
  project: StoryProject;
  provider: string;
  model: string;
  /** Only these explicit fields reach the separate Pi worker. */
  work: { brief: string; storyNote: string };
}
export interface WorkerReply {
  piSessionId: string;
  piSessionFile?: string;
  update: { storyNote: string };
}

export interface DirectWorkerRequest {
  provider: string;
  model: string;
  /** No project directory, user task, transcript, or unrelated state. */
  work: { brief: string };
}
export interface DirectWorkerReply {
  update: { tagline: string };
}

export type CoordinatorResumeRequest =
  | { destination: typeof WORKER_DESTINATION; storyNote: string; workerPiSessionId: string }
  | { destination: typeof DIRECT_WORKER_DESTINATION; tagline: string };

export interface CoordinatorReply {
  response: string;
  piSessionId: string;
}

export interface DelegationAdapters {
  startPi: (request: CoordinatorRequest) => Promise<CoordinatorStartReply>;
  invokeWorker: (request: WorkerRequest) => Promise<unknown>;
  invokeDirectWorker: (request: DirectWorkerRequest) => Promise<unknown>;
  resumePi: (request: CoordinatorResumeRequest) => Promise<CoordinatorReply>;
  /** Rehydrate the original persisted Pi histories without new conversations. */
  restorePi?: (input: {
    request: CoordinatorRequest;
    coordinator: PiSessionReference;
    worker?: PiSessionReference;
    destination: WorkerDestination;
    workerCompleted: boolean;
  }) => Promise<void>;
  dispose?: () => void | Promise<void>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(obj: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(obj).length === expected.length &&
    expected.every((key) => Object.hasOwn(obj, key));
}

export function validateHandoff(input: unknown): HandoffIntent {
  if (!record(input) || !exactKeys(input, ["destination", "brief"]) ||
      (input.destination !== WORKER_DESTINATION && input.destination !== DIRECT_WORKER_DESTINATION) ||
      typeof input.brief !== "string" || !input.brief.trim()) {
    throw new Error("Invalid Pi handoff: unknown destination or malformed brief; no worker was executed.");
  }
  return { destination: input.destination, brief: input.brief };
}

export function validateWorkerReply(input: unknown, coordinatorPiSessionId: string): WorkerReply {
  if (!record(input) ||
      !(exactKeys(input, ["piSessionId", "update"]) || exactKeys(input, ["piSessionId", "piSessionFile", "update"])) ||
      (Object.hasOwn(input, "piSessionFile") &&
       (typeof input.piSessionFile !== "string" || !input.piSessionFile.trim())) ||
      typeof input.piSessionId !== "string" || !input.piSessionId.trim() ||
      input.piSessionId === coordinatorPiSessionId ||
      !record(input.update) || !exactKeys(input.update, ["storyNote"]) ||
      typeof input.update.storyNote !== "string" || !input.update.storyNote.trim()) {
    throw new Error("Invalid worker result: expected a separate Pi session and one nonempty storyNote update.");
  }
  return { piSessionId: input.piSessionId,
    ...(typeof input.piSessionFile === "string" ? { piSessionFile: input.piSessionFile } : {}),
    update: { storyNote: input.update.storyNote } };
}

export function validateDirectWorkerReply(input: unknown): DirectWorkerReply {
  if (!record(input) || !exactKeys(input, ["update"]) ||
      !record(input.update) || !exactKeys(input.update, ["tagline"]) ||
      typeof input.update.tagline !== "string" || !input.update.tagline.trim()) {
    throw new Error("Invalid direct worker result: expected exactly one nonempty tagline update.");
  }
  return { update: { tagline: input.update.tagline } };
}

const CoordinatorState = Annotation.Root({
  task: Annotation<string>(),
  provider: Annotation<string>(),
  model: Annotation<string>(),
  projectRoot: Annotation<string>(),
  projectId: Annotation<string>(),
  executionMode: Annotation<ExecutionMode>(),
  piSessionFile: Annotation<string>(),
  workerPiSessionFile: Annotation<string>(),
  storyNote: Annotation<string>(),
  tagline: Annotation<string>(),
  handoff: Annotation<HandoffIntent | undefined>(),
  response: Annotation<string>(),
  piSessionId: Annotation<string>(),
  workerPiSessionId: Annotation<string>(),
  skillSnapshot: Annotation<SkillSnapshot | null | undefined>(),
});

export function createCoordinatorGraph(
  adapters: DelegationAdapters,
  persistence?: { saver: SqliteSaver; pauseAfter?: "handoff" | "worker" },
) {
  return new StateGraph(CoordinatorState)
    .addNode("pi_coordinator", async (state) => {
      const result = await adapters.startPi({
        task: state.task,
        provider: state.provider,
        model: state.model,
        project: { root: state.projectRoot, id: state.projectId },
      });
      if (typeof result.piSessionId !== "string" || !result.piSessionId.trim()) {
        throw new Error("Pi coordinator did not return a session identity.");
      }
      if (persistence && !result.piSessionFile) {
        throw new Error("Cannot checkpoint handoff: coordinator Pi session was not persisted.");
      }
      return { piSessionId: result.piSessionId, piSessionFile: result.piSessionFile ?? "",
        handoff: validateHandoff(result.handoff),
        ...(Object.hasOwn(result, "skillSnapshot") ? { skillSnapshot: result.skillSnapshot } : {}) };
    })
    .addNode(WORKER_DESTINATION, async (state) => {
      const handoff = validateHandoff(state.handoff);
      if (handoff.destination !== WORKER_DESTINATION) throw new Error("Wrong Pi worker route.");
      const raw = await adapters.invokeWorker({
        project: { root: state.projectRoot, id: state.projectId },
        provider: state.provider,
        model: state.model,
        work: { brief: handoff.brief, storyNote: state.storyNote },
      });
      const result = validateWorkerReply(raw, state.piSessionId);
      if (persistence && !result.piSessionFile) {
        throw new Error("Cannot checkpoint worker: worker Pi session was not persisted.");
      }
      return { storyNote: result.update.storyNote, workerPiSessionId: result.piSessionId,
        workerPiSessionFile: result.piSessionFile ?? "" };
    })
    .addNode(DIRECT_WORKER_DESTINATION, async (state) => {
      const handoff = validateHandoff(state.handoff);
      if (handoff.destination !== DIRECT_WORKER_DESTINATION) throw new Error("Wrong direct worker route.");
      // Single pi-ai model call. No project, Pi session, transcript or other fields.
      const raw = await adapters.invokeDirectWorker({
        provider: state.provider,
        model: state.model,
        work: { brief: handoff.brief },
      });
      const result = validateDirectWorkerReply(raw);
      return { tagline: result.update.tagline };
    })
    .addNode("pi_continuation", async (state) => {
      const handoff = validateHandoff(state.handoff);
      const update: CoordinatorResumeRequest = handoff.destination === WORKER_DESTINATION
        ? { destination: WORKER_DESTINATION, storyNote: state.storyNote, workerPiSessionId: state.workerPiSessionId }
        : { destination: DIRECT_WORKER_DESTINATION, tagline: state.tagline };
      const result = await adapters.resumePi(update);
      if (result.piSessionId !== state.piSessionId) {
        throw new Error("Pi coordinator session changed across the handoff.");
      }
      if (typeof result.response !== "string" || !result.response.trim()) {
        throw new Error("Pi coordinator returned an empty response after delegation.");
      }
      return { response: result.response };
    })
    .addEdge(START, "pi_coordinator")
    .addConditionalEdges("pi_coordinator", (state) => validateHandoff(state.handoff).destination,
      [WORKER_DESTINATION, DIRECT_WORKER_DESTINATION])
    .addEdge(WORKER_DESTINATION, "pi_continuation")
    .addEdge(DIRECT_WORKER_DESTINATION, "pi_continuation")
    .addEdge("pi_continuation", END)
    .compile({
      checkpointer: persistence?.saver,
      interruptAfter: persistence?.pauseAfter === "handoff"
        ? ["pi_coordinator"]
        : persistence?.pauseAfter === "worker"
          ? [WORKER_DESTINATION, DIRECT_WORKER_DESTINATION] : [],
    });
}

export interface CoordinatorOptions extends CoordinatorRequest, DelegationAdapters {
  /** User-facing name, scoped to the project before graph use. */
  threadId: string;
  persistence?: { resume?: boolean; pauseAfter?: "handoff" | "worker"; mode: ExecutionMode };
  skillSnapshot?: SkillSnapshot;
  pinSkillSnapshot?: (snapshot: SkillSnapshot | undefined) => void;
  configureTrace?: (metadata: Record<string, string | boolean>) => void;
}

export async function runCoordinator(options: CoordinatorOptions) {
  const runId = randomUUID();
  const graphThreadId = scopeThread(options.project, options.threadId);
  const saver = options.persistence
    ? await openCheckpointer(options.project, Boolean(options.persistence.resume))
    : undefined;
  const graph = createCoordinatorGraph(options, saver
    ? { saver, pauseAfter: options.persistence?.pauseAfter } : undefined);
  const config = {
    runId,
    configurable: { thread_id: graphThreadId },
    metadata: provenanceMetadata({
      runId, threadId: graphThreadId, projectId: options.project.id,
      snapshot: options.skillSnapshot,
    }),
  };
  try {
    let completedState: typeof CoordinatorState.State | undefined;
    let input: typeof CoordinatorState.State | null = {
      task: options.task,
      provider: options.provider,
      model: options.model,
      projectRoot: options.project.root,
      projectId: options.project.id,
      executionMode: options.persistence?.mode ?? "pi",
      piSessionFile: "",
      workerPiSessionFile: "",
      storyNote: "",
      tagline: "",
      response: "",
      piSessionId: "",
      workerPiSessionId: "",
      skillSnapshot: options.skillSnapshot,
      handoff: undefined,
    };

    if (saver) {
      let existing;
      try {
        existing = await saver.getTuple(config);
      } catch {
        throw new Error("Cannot read SQLite checkpoint: database or checkpoint data is corrupt.");
      }
      if (options.persistence?.resume) {
        if (!existing) {
          throw new Error(
            "Cannot resume: no checkpoint for this thread and Story root. " +
            "Check --thread and --project; no new conversation was started.",
          );
        }
        const snapshot = await graph.getState(config);
        const state = snapshot.values as typeof CoordinatorState.State;
        if (state.projectRoot !== options.project.root ||
            state.projectId !== options.project.id ||
            state.executionMode !== options.persistence.mode) {
          throw new Error(
            "Cannot resume: checkpoint belongs to a different Story project or execution mode.",
          );
        }
        if (state.skillSnapshot) {
          const pinned = state.skillSnapshot;
          Object.assign(config.metadata, provenanceMetadata({
            runId, threadId: graphThreadId, projectId: options.project.id, snapshot: pinned,
          }));
          if (pinned.digest !== pinned.id) throw new Error("Checkpoint skill snapshot identity mismatch.");
          options.pinSkillSnapshot?.({ ...pinned, path: await openSkillSnapshot(pinned.id) });
        } else options.pinSkillSnapshot?.(undefined);
        // Pi sessions are reconstructed below. Configure the extension BEFORE
        // restoration so resumed agent turns retain pinned provenance too.
        options.configureTrace?.(config.metadata);
        const handoff = validateHandoff(state.handoff);
        if (!state.piSessionId?.trim() || !state.piSessionFile?.trim()) {
          throw new Error("Cannot resume: checkpoint lacks a persisted coordinator Pi session.");
        }
        const coordinator: PiSessionReference = {
          id: state.piSessionId, file: state.piSessionFile,
        };
        await openPersistedSession(options.project, options.persistence.mode, coordinator);
        const next = snapshot.next.map(String);
        if (next.some((node) => node !== WORKER_DESTINATION &&
          node !== DIRECT_WORKER_DESTINATION && node !== "pi_continuation")) {
          throw new Error("Cannot resume: checkpoint contains an unsupported pending graph node.");
        }
        const workerCompleted = next.includes("pi_continuation") || next.length === 0;
        const worker: PiSessionReference | undefined =
          handoff.destination === WORKER_DESTINATION && workerCompleted
            ? { id: state.workerPiSessionId, file: state.workerPiSessionFile }
            : undefined;
        if (worker) {
          await openPersistedSession(options.project, options.persistence.mode, worker);
        }
        if (next.length === 0) completedState = state;
        if (next.length > 0) {
          if (!options.restorePi) {
            throw new Error("Cannot resume: the selected Pi adapter does not support session restoration.");
          }
          await options.restorePi({
            request: {
              task: state.task,
              provider: state.provider,
              model: state.model,
              project: options.project,
            },
            coordinator,
            worker,
            destination: handoff.destination,
            workerCompleted,
          });
        }
        // Null input advances from the committed superstep; it does not rerun
        // the original coordinator or replay a previously checkpointed worker.
        input = null;
      } else if (existing) {
        throw new Error(
          "This Story thread already has a checkpoint. Use --resume to continue it " +
          "or choose a new --thread; existing state was not overwritten.",
        );
      }
    } else if (options.persistence?.resume) {
      throw new Error("Cannot resume without SQLite checkpoint storage.");
    }

    options.configureTrace?.(config.metadata);
    const output = completedState ?? await graph.invoke(input, config);
    const handoff = validateHandoff(output.handoff);
    const snapshot = saver ? await graph.getState(config) : undefined;
    const next = snapshot?.next.map(String) ?? [];
    const paused = next.length > 0;
    return {
      ...(saver ? { status: paused ? "paused" : "completed", next } : {}),
      runId,
      threadId: options.threadId,
      graphThreadId,
      projectRoot: options.project.root,
      projectId: options.project.id,
      piSessionId: output.piSessionId,
      handoffDestination: handoff.destination,
      provider: output.provider,
      model: output.model,
      ...(output.skillSnapshot ? { skillSnapshot: output.skillSnapshot } : {}),
      response: paused ? undefined : output.response,
      ...(handoff.destination === WORKER_DESTINATION
        ? {
            ...(!paused || Boolean(output.storyNote)
              ? { storyNote: output.storyNote } : {}),
            ...(output.workerPiSessionId
              ? { workerPiSessionId: output.workerPiSessionId } : {}),
          }
        : {
            ...(!paused || Boolean(output.tagline)
              ? { tagline: output.tagline } : {}),
          }),
    };
  } finally {
    try {
      await options.dispose?.();
    } finally {
      saver?.db.close();
    }
  }
}
