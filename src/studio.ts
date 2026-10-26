/**
 * Local LangGraph Studio entry point. The server owns graph checkpointing;
 * Pi session histories remain project-scoped. One invocation at a time.
 */
import { createCoordinatorGraph } from "./graph.js";
import { loadSkillConfig } from "./skills.js";
import { createSkillSnapshot } from "./snapshot.js";
import { createPiDelegationAdapters } from "./pi.js";
import { createStudioAdapters } from "./studio-runtime.js";
import { tracingEnabled } from "./tracing.js";
import { loadLocalLangSmithCredentials } from "./langsmith-config.js";

const cloud = process.env.NT_STUDIO_TRACE === "1";
if (cloud) loadLocalLangSmithCredentials();
tracingEnabled(cloud);
process.env.LANGSMITH_TRACING = cloud ? "true" : "false";
process.env.LANGCHAIN_TRACING_V2 = cloud ? "true" : "false";
process.env.TRACE_TO_LANGSMITH = cloud ? "true" : "false";

const adapters = createStudioAdapters(async () => {
  // Resolve both config and source at the start of this graph invocation,
  // not when the Studio server imported this module.
  const config = await loadSkillConfig();
  const snapshot = await createSkillSnapshot(config);
  return { pi: createPiDelegationAdapters(config, cloud), snapshot };
});

/** The same coordinator graph and allowed branches as the CLI. */
export const graph = createCoordinatorGraph(adapters);
