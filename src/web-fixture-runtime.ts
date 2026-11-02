import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { createGenerationGraph } from "./generation.js";

/** Use the production graph, never a browser-specific narrative executor. */
export function openWebGenerationGraph(path: string) {
  const saver = SqliteSaver.fromConnString(path);
  return { saver, graph: createGenerationGraph(saver, "server") };
}

/** Historical name for fixture-mode test imports. */
export const openWebFixtureGraph = openWebGenerationGraph;
