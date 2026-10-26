#!/usr/bin/env node
import { randomUUID } from "node:crypto";

interface CliOptions {
  task: string;
  provider: string;
  model: string;
  project: string;
  createProject: boolean;
  threadId: string;
  fixture: boolean;
  trace: boolean;
}

const USAGE = `NovelTea-gen LangGraph/Pi tracer bullet

Usage:
  pnpm dev run --project /path/to/story --task "Summarize why a story needs a premise."
  pnpm dev run --project ./new-story --create-project --fixture --task "Verify the graph."

Options:
  --project <path>    Required Story root (existing directory, independent of app checkout)
  --create-project    Create the directory if missing; no engine game or skills installed
  --task <text>       Coordinator's task (required)
  --provider <name>   Pi provider (default: openai)
  --model <name>      Pi model (default: gpt-6-luna, if supported)
  --thread <id>       User thread name (namespaced to the project; default: UUID)
  --fixture           Deterministic test adapter; no Pi/model/auth/network calls
  --trace             Opt in to LangSmith cloud graph tracing (needs LANGSMITH_API_KEY)
  --help              Show this help

Output: JSON with the canonical Story root, scoped thread, Pi session ID and response.
`;

function parseArgs(argv: string[]): CliOptions | null {
  if (argv.includes("--help") || argv.includes("-h")) return null;
  if (argv.shift() !== "run") {
    throw new Error("Expected the 'run' command. Use --help for usage.");
  }
  const options: CliOptions = {
    task: "",
    provider: "openai",
    model: "gpt-6-luna",
    project: "",
    createProject: false,
    threadId: randomUUID(),
    fixture: false,
    trace: false,
  };
  while (argv.length > 0) {
    const option = argv.shift()!;
    if (option === "--fixture") {
      options.fixture = true;
    } else if (option === "--trace") {
      options.trace = true;
    } else if (option === "--create-project") {
      options.createProject = true;
    } else if (option === "--task" || option === "--model" ||
               option === "--provider" || option === "--thread" || option === "--project") {
      const value = argv.shift();
      if (!value?.trim() || value.startsWith("--")) {
        throw new Error(`Missing value for ${option}.`);
      }
      if (option === "--task") options.task = value;
      if (option === "--model") options.model = value;
      if (option === "--provider") options.provider = value;
      if (option === "--thread") options.threadId = value;
      if (option === "--project") options.project = value;
    } else {
      throw new Error(`Unknown option: ${option}. Use --help for usage.`);
    }
  }
  if (!options.task.trim()) throw new Error("Missing required --task <text>.");
  if (!options.project.trim()) throw new Error("Missing required --project <path>.");
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!options) {
    process.stdout.write(USAGE);
    return;
  }

  // LangGraph/LangSmith can see preexisting environment flags on import.
  // Override them until this invocation *explicitly* opts into cloud tracing.
  process.env.LANGSMITH_TRACING = options.trace ? "true" : "false";
  process.env.LANGCHAIN_TRACING_V2 = options.trace ? "true" : "false";
  if (options.trace && !process.env.LANGSMITH_API_KEY) {
    throw new Error("--trace requires LANGSMITH_API_KEY. Without --trace, no cloud traces are uploaded.");
  }

  const { openStoryProject } = await import("./project.js");
  const project = await openStoryProject(options.project, options.createProject);
  const { runCoordinator } = await import("./graph.js");
  const invokePi = options.fixture
    ? async ({ task }: { task: string }) => ({
        response: `Fixture coordinator received: ${task}`,
        piSessionId: randomUUID(),
      })
    : (await import("./pi.js")).invokePiCoordinator;

  const result = await runCoordinator({
    task: options.task,
    provider: options.provider,
    model: options.model,
    project,
    threadId: options.threadId,
    invokePi,
  });
  process.stdout.write(JSON.stringify({
    status: "completed",
    mode: options.fixture ? "fixture" : "pi",
    tracing: options.trace,
    ...result,
  }, null, 2) + "\n");
}

function redactCredentials(message: string): string {
  let safe = message;
  for (const [name, value] of Object.entries(process.env)) {
    if (/(API_KEY|TOKEN|PASSWORD|SECRET|AUTHORIZATION|CREDENTIAL)/i.test(name) &&
        value && value.length >= 8) {
      safe = safe.replaceAll(value, "[REDACTED]");
    }
  }
  return safe;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  process.stderr.write(`noveltea-gen: ${redactCredentials(message)}\n`);
  process.exitCode = 1;
});
