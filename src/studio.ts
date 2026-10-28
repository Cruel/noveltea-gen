/** Production Story generation topology; Studio supplies its own checkpointer.
 * CLI durable execution is runStoryGeneration, not the note/tagline demo.
 */
import { createGenerationGraph } from "./generation.js";
import { tracingEnabled } from "./tracing.js";
import { loadLocalLangSmithCredentials } from "./langsmith-config.js";

const cloud = process.env.NT_STUDIO_TRACE === "1";
if (cloud) loadLocalLangSmithCredentials();
tracingEnabled(cloud);
process.env.LANGSMITH_TRACING = cloud ? "true" : "false";
process.env.LANGCHAIN_TRACING_V2 = cloud ? "true" : "false";
process.env.TRACE_TO_LANGSMITH = cloud ? "true" : "false";

export const graph = createGenerationGraph();
