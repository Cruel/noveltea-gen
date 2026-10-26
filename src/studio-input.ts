#!/usr/bin/env node
import { openStoryProject } from "./project.js";

/** Generate fully scoped, deterministic Studio input state for one Story. */
async function main(args: string[]) {
  let project: string | undefined;
  let task: string | undefined;
  let provider = "openai";
  let model = "gpt-6-luna";
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i];
    const value = args[i + 1];
    if (!value || !["--project", "--task", "--provider", "--model"].includes(name ?? "")) {
      throw new Error("Usage: pnpm studio:input --project <existing-story-root> --task <task> [--provider <name>] [--model <name>]");
    }
    if (name === "--project") project = value;
    if (name === "--task") task = value;
    if (name === "--provider") provider = value;
    if (name === "--model") model = value;
  }
  if (!project?.trim() || !task?.trim()) {
    throw new Error("Studio input requires --project and --task.");
  }
  const selected = await openStoryProject(project);
  process.stdout.write(JSON.stringify({
    task, provider, model,
    projectRoot: selected.root, projectId: selected.id,
    executionMode: "pi", storyNote: "", tagline: "", handoff: null,
    response: "", piSessionId: "", piSessionFile: "",
    workerPiSessionId: "", workerPiSessionFile: "",
    // Studio captures and persists the active skill snapshot when the graph starts.
    skillSnapshot: null,
  }, null, 2) + "\n");
}
main(process.argv.slice(2)).catch(error => {
  process.stderr.write(`noveltea-gen studio input: ${error instanceof Error ? error.message : "error"}\n`);
  process.exitCode = 1;
});
