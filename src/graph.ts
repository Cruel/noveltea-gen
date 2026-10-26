import { randomUUID } from "node:crypto";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { scopeThread, type StoryProject } from "./project.js";

export interface CoordinatorRequest {
  task: string;
  provider: string;
  model: string;
  project: StoryProject;
}

export interface CoordinatorReply {
  response: string;
  /** Pi's own conversation ID, separate from the graph thread ID. */
  piSessionId: string;
}
export type CoordinatorInvoker = (request: CoordinatorRequest) => Promise<CoordinatorReply>;

const CoordinatorState = Annotation.Root({
  task: Annotation<string>(),
  provider: Annotation<string>(),
  model: Annotation<string>(),
  projectRoot: Annotation<string>(),
  projectId: Annotation<string>(),
  response: Annotation<string>(),
  piSessionId: Annotation<string>(),
});

export function createCoordinatorGraph(invokePi: CoordinatorInvoker) {
  return new StateGraph(CoordinatorState)
    .addNode("pi_coordinator", async (state) => {
      const result = await invokePi({
        task: state.task,
        provider: state.provider,
        model: state.model,
        project: { root: state.projectRoot, id: state.projectId },
      });
      if (!result.response.trim()) {
        throw new Error("Pi coordinator returned an empty response; the run was not completed.");
      }
      if (!result.piSessionId.trim()) {
        throw new Error("Pi coordinator did not return a session identity.");
      }
      return result;
    })
    .addEdge(START, "pi_coordinator")
    .addEdge("pi_coordinator", END)
    .compile();
}

export interface CoordinatorOptions extends CoordinatorRequest {
  /** External user-facing name, scoped by the canonical project root before graph use. */
  threadId: string;
  invokePi: CoordinatorInvoker;
}

export async function runCoordinator(options: CoordinatorOptions) {
  const runId = randomUUID();
  const graphThreadId = scopeThread(options.project, options.threadId);
  const graph = createCoordinatorGraph(options.invokePi);
  const output = await graph.invoke(
    {
      task: options.task,
      provider: options.provider,
      model: options.model,
      projectRoot: options.project.root,
      projectId: options.project.id,
      response: "",
      piSessionId: "",
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
    provider: options.provider,
    model: options.model,
    response: output.response,
  };
}
