#!/usr/bin/env node
import { randomUUID } from "node:crypto";

interface CliOptions {
  command: "run" | "demo-story";
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
  traceLocal: boolean;
}

const USAGE = `NovelTea-gen LangGraph/Pi tracer bullet

Usage:
  pnpm dev job start --story /path/to/story --job draft-1
  pnpm dev job validate --story /path/to/story --job draft-1
  pnpm dev run --project /path/to/story --task "Summarize why a story needs a premise."
  pnpm dev run --project ./new-story --create-project --fixture --task "Verify the graph."
  pnpm dev demo-story --project ./fresh-story --create-project --task "A mystery; choose the rest"

Job start:
  --story <path>     Required existing canonical Story directory within a Git worktree
  --job <id>         Required stable logical job ID (reopen by repeating the same ID)
  --noveltea-project <path>  Optional future engine project root (start only; metadata)
  --validator-source <path>  Initial validation: canonical noveltea-skills checkout
                           (otherwise uses configured novelteaSkills)

Options:
  --project <path>    Required Story root (existing directory, independent of app checkout)
  --create-project    Create the directory if missing; no engine game or skills installed
  --task <text>       Coordinator's task (required)
  --provider <name>   Pi provider (default: openai)
  --model <name>      Pi model (default: gpt-6-luna, if supported)
  --thread <id>       User thread name (namespaced to the project; default: UUID)
  --fixture           Deterministic test adapter; no Pi/model/auth/network calls
                       (demo-story fixture is NOT a live Pi skills-use proof)
  --fixture-direct    With --fixture, select direct_tagline_worker instead of Pi worker
  --pause-after <at>  Commit and stop after handoff or worker (safe boundaries)
  --resume            Continue --thread from saved SQLite and Pi sessions (no --task)
  --trace             Opt in to LangSmith cloud graph tracing (needs LANGSMITH_API_KEY)
  --trace-local       Save local, private JSONL spans (no cloud API key required)
  --help              Show this help

demo-story: opt-in, only writes one draft Creative Direction into an empty Story root using pinned nt-story-discovery and nt-catalog. No engine or real Story orchestration; catalog readiness unverified unless separately validated.

run output: JSON with project/thread identity, selected worker, validated storyNote or tagline, and the coordinator response.
`;

function parseArgs(argv: string[]): CliOptions | null {
  if (argv.includes("--help") || argv.includes("-h")) return null;
  const command = argv.shift();
  if (command !== "run" && command !== "demo-story") {
    throw new Error("Expected 'run' or 'demo-story'. Use --help for usage.");
  }
  const options: CliOptions = {
    command,
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
    traceLocal: false,
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
    } else if (option === "--trace-local") {
      options.traceLocal = true;
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
  if (command === "demo-story" && (options.resume || options.pauseAfter || options.fixtureDirect ||
      options.trace || options.traceLocal || options.threadProvided)) {
    throw new Error("demo-story does not support graph --resume, --pause-after, --fixture-direct, --trace, --trace-local or --thread.");
  }
  return options;
}

async function main(): Promise<void> {
  if (process.argv[2] === "job") {
    const args = process.argv.slice(3);
    const jobCommand = args.shift();
    if (jobCommand !== "start" && jobCommand !== "validate") {
      throw new Error("Expected 'job start' or 'job validate'.");
    }
    if (args.includes("--help") || args.includes("-h")) {
      process.stdout.write(USAGE);
      return;
    }
    let story = "";
    let job = "";
    let novelteaProject: string | undefined;
    let validatorSource: string | undefined;
    const provided = new Set<string>();
    while (args.length) {
      const flag = args.shift()!;
      if (flag !== "--story" && flag !== "--job" &&
          !(jobCommand === "start" && flag === "--noveltea-project") &&
          !(jobCommand === "validate" && flag === "--validator-source")) {
        throw new Error(`Unknown job option: ${flag}. Use --help for usage.`);
      }
      if (provided.has(flag)) throw new Error(`Duplicate job option: ${flag}.`);
      provided.add(flag);
      const value = args.shift();
      if (!value?.trim() || value.startsWith("--")) throw new Error(`Missing value for ${flag}.`);
      if (flag === "--story") story = value;
      if (flag === "--job") job = value;
      if (flag === "--noveltea-project") novelteaProject = value;
      if (flag === "--validator-source") validatorSource = value;
    }
    if (!story) throw new Error("Missing required --story <path>.");
    if (!job) throw new Error("Missing required --job <id>.");
    const { startStoryJob } = await import("./job.js");
    const target = await startStoryJob({ story, job, novelteaProject }, jobCommand === "start");
    if (jobCommand === "start") {
      process.stdout.write(JSON.stringify(target, null, 2) + "\n");
      return;
    }
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    if (!validatorSource && !target.validatorSha256 &&
        !existsSync(join(target.worktreeRoot, "..", "validator.json"))) {
      const { loadSkillConfig } = await import("./skills.js");
      validatorSource = (await loadSkillConfig(undefined, false)).novelteaSkills;
    }
    const { validateStoryJob } = await import("./validator.js");
    const result = await validateStoryJob(target, validatorSource);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    process.exitCode = result.exitCode;
    return;
  }
  const options = parseArgs(process.argv.slice(2));
  if (!options) {
    process.stdout.write(USAGE);
    return;
  }

  // Credentials in .local/langsmith.env are read only for an explicitly
  // tracing-enabled invocation. Merely storing a key never enables tracing.
  if (options.trace) {
    const { loadLocalLangSmithCredentials } = await import("./langsmith-config.js");
    loadLocalLangSmithCredentials();
  }

  // LangGraph/LangSmith can see preexisting environment flags on import.
  // Override them until this invocation *explicitly* opts into cloud tracing.
  process.env.LANGSMITH_TRACING = options.trace ? "true" : "false";
  process.env.LANGCHAIN_TRACING_V2 = options.trace ? "true" : "false";
  process.env.TRACE_TO_LANGSMITH = options.trace ? "true" : "false";
  if (options.trace && !process.env.LANGSMITH_API_KEY) {
    throw new Error("--trace requires LANGSMITH_API_KEY. Without --trace, no cloud traces are uploaded.");
  }

  const { openStoryProject } = await import("./project.js");
  const project = await openStoryProject(options.project, options.createProject);
  const { loadSkillConfig } = await import("./skills.js");
  const skillConfig = await loadSkillConfig(undefined, !options.resume);
  const { runCoordinator } = await import("./graph.js");
  const { createSkillSnapshot } = await import("./snapshot.js");
  const skillSnapshot = options.resume ? undefined : await createSkillSnapshot(skillConfig);
  if (options.command === "demo-story") {
    const { runFoundationDemo } = await import("./demo.js");
    const result = await runFoundationDemo({
      project, config: skillConfig, snapshot: skillSnapshot,
      provider: options.provider, model: options.model, task: options.task, fixture: options.fixture,
    });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  const fixturePiSdk = options.fixture
    ? await import("@earendil-works/pi-coding-agent") : null;
  const fixtureStorage = options.fixture
    ? await import("./checkpoint.js") : null;
  const localCapture = options.traceLocal
    ? await (await import("./local-trace.js")).startLocalTrace(options.trace)
    : undefined;
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
          pinSkillSnapshot: (_snapshot: unknown) => {},
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
    : (await import("./pi.js")).createPiDelegationAdapters(skillConfig, options.trace, localCapture?.client);
  if (!options.fixture && !options.resume) adapters.pinSkillSnapshot(skillSnapshot);

  const executeGraph = () => runCoordinator({
    task: options.task,
    provider: options.provider,
    model: options.model,
    project,
    threadId: options.threadId,
    skillSnapshot,
    ...(!options.fixture ? { pinSkillSnapshot: adapters.pinSkillSnapshot } : {}),
    persistence: { resume: options.resume, pauseAfter: options.pauseAfter,
      mode: options.fixture ? "fixture" : "pi" },
    ...adapters,
  });
  let result;
  try {
    result = localCapture
      ? await (await import("./local-trace.js")).recordLocalGraph(localCapture, executeGraph, {
          projectId: project.id, threadId: options.threadId,
        })
      : await executeGraph();
  } catch (error) {
    if (localCapture) process.stderr.write(`noveltea-gen: local trace: ${localCapture.file}\n`);
    throw error;
  } finally {
    await localCapture?.close();
  }
  process.stdout.write(JSON.stringify({
    ...(localCapture ? { localTrace: localCapture.file } : {}),
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
  process.exitCode = process.argv[2] === "job" && process.argv[3] === "validate" ? 2 : 1;
});
