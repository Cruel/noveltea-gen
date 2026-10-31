/** Local-only Skein qualification host, not a public production entrypoint. */
import { isAbsolute, resolve } from "node:path";
import { embedSqliteGraphs } from "@skein-js/local";
import { createExpressServer } from "@skein-js/express";
import { Annotation, END, START, StateGraph, interrupt } from "@langchain/langgraph";
import { createGenerationGraph } from "./generation.js";

const Approval = Annotation.Root({ proposal: Annotation<string>(), approved: Annotation<boolean>() });
const approvalProbe = new StateGraph(Approval)
  .addNode("request_human_approval", state => ({ approved: interrupt({
    kind: "approval", proposal: state.proposal,
  }) === "approve" }))
  .addEdge(START, "request_human_approval")
  .addEdge("request_human_approval", END)
  .compile();
const Slow = Annotation.Root({ completed: Annotation<boolean>() });
const slowProbe = new StateGraph(Slow)
  .addNode("hold", async () => {
    await new Promise(resolveDelay => setTimeout(resolveDelay, 900));
    return { completed: true };
  })
  .addEdge(START, "hold")
  .addEdge("hold", END)
  .compile();

const sqlitePath = process.env.NT_SKEIN_QUALIFY_DB;
if (!sqlitePath || !isAbsolute(sqlitePath)) throw new Error("NT_SKEIN_QUALIFY_DB must be an absolute path.");
const local = await embedSqliteGraphs({ story_generation: createGenerationGraph(), approval_probe: approvalProbe, slow_probe: slowProbe }, {
  sqlitePath: resolve(sqlitePath),
});
const server = await createExpressServer({ deps: local.deps, requestLog: false });
const listener = await server.listen(Number(process.env.NT_SKEIN_QUALIFY_PORT ?? 0), "127.0.0.1");
const address = listener.address();
if (!address || typeof address === "string") throw new Error("No host address");
process.stdout.write(JSON.stringify({ ready: true, port: address.port }) + "\n");

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  try { await server.close(); }
  finally { await local.dispose(); }
}
process.on("SIGTERM", () => { void shutdown().then(() => process.exit(0), error => {
  console.error(error); process.exit(1);
}); });
process.on("SIGINT", () => { void shutdown().then(() => process.exit(0), error => {
  console.error(error); process.exit(1);
}); });
