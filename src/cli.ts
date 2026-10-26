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
  fixtureDirect: boolean;
  resume: boolean;
  pauseAfter?: "handoff" | "worker";
  threadProvided: boolean;
  providerProvided: boolean;
  modelProvided: boolean;
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
  --fixture-direct    With --fixture, select direct_tagline_worker instead of Pi worker
  --pause-after <at>  Commit and stop after handoff or worker (safe boundaries)
  --resume            Continue --thread from saved SQLite and Pi sessions (no --task)
  --trace             Opt in to LangSmith cloud graph tracing (needs LANGSMITH_API_KEY)
  --help              Show this help

Output: JSON with project/thread identity, selected worker, validated storyNote or tagline, and the coordinator response.
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
    fixtureDirect: false,
    resume: false,
    threadProvided: false,
    providerProvided: false,
    modelProvided: false,
    trace: false,
  };
  while (argv.length > 0) {
    const option = argv.shift()!;
    if (option === "--fixture") {
      options.fixture = true;
    } else if (option === "--fixture-direct") {
      options.fixtureDirect = true;
    } else if (option === "--resume") {
      options.resume = true;
    } else if (option === "--trace") {
      options.trace = true;
    } else if (option === "--create-project") {
      options.createProject = true;
    } else if (option === "--pause-after") {
      const stage = argv.shift();
      if (stage !== "handoff" && stage !== "worker") {
        throw new Error("--pause-after must be handoff or worker.");
      }
      options.pauseAfter = stage;
    } else if (option === "--task" || option === "--model" ||
               option === "--provider" || option === "--thread" || option === "--project") {
      const value = argv.shift();
      if (!value?.trim() || value.startsWith("--")) {
        throw new Error(`Missing value for ${option}.`);
      }
      if (option === "--task") options.task = value;
      if (option === "--model") { options.model = value; options.modelProvided = true; }
      if (option === "--provider") { options.provider = value; options.providerProvided = true; }
      if (option === "--thread") {
        options.threadId = value;
        options.threadProvided = true;
      }
      if (option === "--project") options.project = value;
    } else {
      throw new Error(`Unknown option: ${option}. Use --help for usage.`);
    }
  }
  if (options.resume) {
    if (!options.threadProvided) throw new Error("--resume requires an explicit --thread <id>.");
    if (options.task.trim()) throw new Error("--resume does not accept --task; task comes from the checkpoint.");
    if (options.providerProvided || options.modelProvided) {
      throw new Error("--resume does not accept --provider or --model; selection comes from the checkpoint.");
    }
    if (options.createProject) throw new Error("--resume does not accept --create-project.");
  } else if (!options.task.trim()) {
    throw new Error("Missing required --task <text>.");
  }
  if (!options.project.trim()) throw new Error("Missing required --project <path>.");
  if (options.fixtureDirect && !options.fixture) throw new Error("--fixture-direct requires --fixture.");
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
  const { loadSkillConfig } = await import("./skills.js");
  const skillConfig = await loadSkillConfig();
  const { runCoordinator } = await import("./graph.js");
  const fixturePiSdk = options.fixture
    ? await import("@earendil-works/pi-coding-agent") : null;
  const fixtureStorage = options.fixture
    ? await import("./checkpoint.js") : null;
  const adapters = options.fixture
    ? (() => {
        let piSessionId: string = randomUUID();
        let fixtureTask = options.task;
        const { SessionManager } = fixturePiSdk!;
        const { sessionDirectory } = fixtureStorage!;
        const saveFixtureSession = (text: string) => {
          const manager = SessionManager.create(project.root, sessionDirectory(project, "fixture"));
          manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
          const file = manager.getSessionFile();
          if (!file) throw new Error("Fixture Pi session did not persist.");
          return { piSessionId: manager.getSessionId(), piSessionFile: file };
        };
        return {
          startPi: async () => {
            const saved = saveFixtureSession(`Fixture coordinator: ${options.task}`);
            piSessionId = saved.piSessionId;
            return {
              ...saved,
              handoff: options.fixtureDirect
                ? { destination: "direct_tagline_worker", brief: "Write a one-line story tagline" }
                : { destination: "story_note_worker", brief: "Propose a Story twist" },
            };
          },
          invokeWorker: async () => {
            const saved = saveFixtureSession("Fixture worker: story note");
            return { ...saved, update: { storyNote: "A secret in the opening scene changes everything." } };
          },
          invokeDirectWorker: async () => ({
            update: { tagline: "Every secret has a final chapter." },
          }),
          restorePi: async ({ request, coordinator }: {
            request: { task: string };
            coordinator: { id: string };
          }) => {
            fixtureTask = request.task;
            piSessionId = coordinator.id;
          },
          resumePi: async (update: { storyNote?: string; tagline?: string }) => ({
            piSessionId,
            response: update.tagline !== undefined
              ? `Fixture coordinator received: ${fixtureTask}; direct tagline: ${update.tagline}`
              : `Fixture coordinator received: ${fixtureTask}; worker note: ${update.storyNote}`,
          }),
        };
      })()
    : (await import("./pi.js")).createPiDelegationAdapters(skillConfig);

  const result = await runCoordinator({
    task: options.task,
    provider: options.provider,
    model: options.model,
    project,
    threadId: options.threadId,
    persistence: { resume: options.resume, pauseAfter: options.pauseAfter,
      mode: options.fixture ? "fixture" : "pi" },
    ...adapters,
  });
  process.stdout.write(JSON.stringify({
    status: result.status,
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
