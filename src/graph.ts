import { randomUUID } from "node:crypto";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { scopeThread, type StoryProject } from "./project.js";

/** Deliberately one destination: #4 demonstrates Pi-directed control, not a scheduler. */
export const WORKER_DESTINATION = "story_note_worker" as const;

export interface CoordinatorRequest {
  task: string;
  provider: string;
  model: string;
  project: StoryProject;
}

export interface HandoffIntent {
  destination: typeof WORKER_DESTINATION;
  brief: string;
}

export interface CoordinatorStartReply {
  /** Pi's conversation ID; its session must remain alive until continuation. */
  piSessionId: string;
  /** Untrusted Pi tool payload; checked before LangGraph routes anywhere. */
  handoff: unknown;
}

export interface WorkerRequest {
  project: StoryProject;
  provider: string;
  model: string;
  /** The only graph state fields projected into the worker prompt. */
  work: { brief: string; storyNote: string };
}
export interface WorkerReply {
  piSessionId: string;
  update: { storyNote: string };
}

export interface CoordinatorResumeRequest {
  storyNote: string;
  workerPiSessionId: string;
}
export interface CoordinatorReply {
  response: string;
  piSessionId: string;
}

export interface DelegationAdapters {
  startPi: (request: CoordinatorRequest) => Promise<CoordinatorStartReply>;
  invokeWorker: (request: WorkerRequest) => Promise<unknown>;
  resumePi: (request: CoordinatorResumeRequest) => Promise<CoordinatorReply>;
  /** Always called after the graph settles, including rejected handoffs. */
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
      input.destination !== WORKER_DESTINATION ||
      typeof input.brief !== "string" || !input.brief.trim()) {
    throw new Error("Invalid Pi handoff: unknown destination or malformed brief; no worker was executed.");
  }
  return { destination: WORKER_DESTINATION, brief: input.brief };
}

export function validateWorkerReply(input: unknown, coordinatorPiSessionId: string): WorkerReply {
  if (!record(input) || !exactKeys(input, ["piSessionId", "update"]) ||
      typeof input.piSessionId !== "string" || !input.piSessionId.trim() ||
      input.piSessionId === coordinatorPiSessionId ||
      !record(input.update) || !exactKeys(input.update, ["storyNote"]) ||
      typeof input.update.storyNote !== "string" || !input.update.storyNote.trim()) {
    throw new Error("Invalid worker result: expected a separate Pi session and one nonempty storyNote update.");
  }
  return { piSessionId: input.piSessionId, update: { storyNote: input.update.storyNote } };
}

const CoordinatorState = Annotation.Root({
  task: Annotation<string>(),
  provider: Annotation<string>(),
  model: Annotation<string>(),
  projectRoot: Annotation<string>(),
  projectId: Annotation<string>(),
  storyNote: Annotation<string>(),
  handoff: Annotation<HandoffIntent | undefined>(),
  response: Annotation<string>(),
  piSessionId: Annotation<string>(),
  workerPiSessionId: Annotation<string>(),
});

export function createCoordinatorGraph(adapters: DelegationAdapters) {
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
      return { piSessionId: result.piSessionId, handoff: validateHandoff(result.handoff) };
    })
    .addNode(WORKER_DESTINATION, async (state) => {
      // Explicit projection: no coordinator transcript, user task, thread ID, or
      // unrelated graph fields reach this separate Pi session.
      const handoff = validateHandoff(state.handoff);
      const raw = await adapters.invokeWorker({
        project: { root: state.projectRoot, id: state.projectId },
        provider: state.provider,
        model: state.model,
        work: { brief: handoff.brief, storyNote: state.storyNote },
      });
      const result = validateWorkerReply(raw, state.piSessionId);
      return { storyNote: result.update.storyNote, workerPiSessionId: result.piSessionId };
    })
    .addNode("pi_continuation", async (state) => {
      const result = await adapters.resumePi({
        storyNote: state.storyNote,
        workerPiSessionId: state.workerPiSessionId,
      });
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
      [WORKER_DESTINATION])
    .addEdge(WORKER_DESTINATION, "pi_continuation")
    .addEdge("pi_continuation", END)
    .compile();
}

export interface CoordinatorOptions extends CoordinatorRequest, DelegationAdapters {
  /** User-facing name, scoped to the project before graph use. */
  threadId: string;
}

export async function runCoordinator(options: CoordinatorOptions) {
  const runId = randomUUID();
  const graphThreadId = scopeThread(options.project, options.threadId);
  const graph = createCoordinatorGraph(options);
  try {
    const output = await graph.invoke(
      {
        task: options.task,
        provider: options.provider,
        model: options.model,
        projectRoot: options.project.root,
        projectId: options.project.id,
        storyNote: "",
        response: "",
        piSessionId: "",
        workerPiSessionId: "",
      },
      {
        runId,
        configurable: { thread_id: graphThreadId },
        metadata: {
          "noveltea.thread_id": graphThreadId,
          "noveltea.project_id": options.project.id,
        },
      },
    );
    return {
      runId,
      threadId: options.threadId,
      graphThreadId,
      projectRoot: options.project.root,
      projectId: options.project.id,
      piSessionId: output.piSessionId,
      workerPiSessionId: output.workerPiSessionId,
      handoffDestination: validateHandoff(output.handoff).destination,
      storyNote: output.storyNote,
      provider: options.provider,
      model: options.model,
      response: output.response,
    };
  } finally {
    await options.dispose?.();
  }
}
