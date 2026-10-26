import { randomUUID } from "node:crypto";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";

export interface CoordinatorRequest {
  task: string;
  provider: string;
  model: string;
}

export type CoordinatorInvoker = (request: CoordinatorRequest) => Promise<string>;

const CoordinatorState = Annotation.Root({
  task: Annotation<string>(),
  provider: Annotation<string>(),
  model: Annotation<string>(),
  response: Annotation<string>(),
});

export function createCoordinatorGraph(invokePi: CoordinatorInvoker) {
  return new StateGraph(CoordinatorState)
    .addNode("pi_coordinator", async (state) => {
      const response = await invokePi({
        task: state.task,
        provider: state.provider,
        model: state.model,
      });
      if (!response.trim()) {
        throw new Error("Pi coordinator returned an empty response; the run was not completed.");
      }
      return { response };
    })
    .addEdge(START, "pi_coordinator")
    .addEdge("pi_coordinator", END)
    .compile();
}

export interface CoordinatorOptions extends CoordinatorRequest {
  threadId: string;
  invokePi: CoordinatorInvoker;
}

export async function runCoordinator(options: CoordinatorOptions) {
  const runId = randomUUID();
  const graph = createCoordinatorGraph(options.invokePi);
  const output = await graph.invoke(
    {
      task: options.task,
      provider: options.provider,
      model: options.model,
      response: "",
    },
    {
      runId,
      configurable: { thread_id: options.threadId },
      metadata: { "noveltea.thread_id": options.threadId },
    },
  );
  return {
    runId,
    threadId: options.threadId,
    provider: options.provider,
    model: options.model,
    response: output.response,
  };
}
