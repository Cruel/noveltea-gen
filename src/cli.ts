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
  pnpm dev job generate start --story /path/to/story --job draft-1 --task "A bounded mystery" --contract scope.json
  pnpm dev job generate resume --story /path/to/story --job draft-1
  pnpm dev job generate inspect --story /path/to/story --job draft-1
  pnpm dev job start --story /path/to/story --job draft-1
  pnpm dev job validate --story /path/to/story --job draft-1
  pnpm dev job pi inspect --story /path/to/story --job draft-1
  pnpm dev job pi configure --story /path/to/story --job draft-1 --max-steps 5 --max-model-calls 100
  pnpm dev job foundation --story /path/to/story --job draft-1 --mode autonomous --task "A mystery premise"
  pnpm dev job foundation --story /path/to/story --job draft-1 --inspect
  pnpm dev job foundation --story /path/to/story --job draft-1 --reconcile-digest <reviewed-sha256>
  pnpm dev job architecture run --story /path/to/story --job draft-1 --contract scope.json --skills-source /path/to/noveltea-skills
  pnpm dev job architecture inspect --story /path/to/story --job draft-1
  pnpm dev job architecture reconcile --story /path/to/story --job draft-1 --digest <reviewed-sha256>
  pnpm dev job foundations run --story /path/to/story --job draft-1 --skills-source /path/to/noveltea-skills
  pnpm dev job foundations inspect --story /path/to/story --job draft-1
  pnpm dev job foundations reconcile --story /path/to/story --job draft-1 --digest <reviewed-sha256>
  pnpm dev job event run --story /path/to/story --job draft-1 --milestone milestone.disclosure --skills-source /path/to/noveltea-skills
  pnpm dev job event inspect --story /path/to/story --job draft-1 --milestone milestone.disclosure
  pnpm dev job interactive run --story /path/to/story --job draft-1 --milestone milestone.disclosure --skills-source /path/to/noveltea-skills
  pnpm dev job interactive inspect --story /path/to/story --job draft-1 --milestone milestone.disclosure
  pnpm dev job composition run --story /path/to/story --job draft-1 --milestone milestone.disclosure --skills-source /path/to/noveltea-skills
  pnpm dev job composition inspect --story /path/to/story --job draft-1 --milestone milestone.disclosure
  pnpm dev job review run --story /path/to/story --job draft-1 --skills-source /path/to/noveltea-skills
  pnpm dev job review inspect --story /path/to/story --job draft-1
  pnpm dev job report --story /path/to/story --job draft-1 [--format markdown] [--output /outside/report.md]
  pnpm dev job report --story /path/to/story --job draft-1 --preview [--fixture]
  pnpm dev job merge preview --story /path/to/story --job draft-1 --fixture
  pnpm dev job merge preview --story /path/to/story --job draft-1 --skills-source /path/to/noveltea-skills
  pnpm dev job ideas capture --story /path/to/story --job draft-1 --file idea.json
  pnpm dev job ideas inspect --story /path/to/story --job draft-1
  pnpm dev job ideas eligibility --story /path/to/story --job draft-1
  pnpm dev job ideas context --story /path/to/story --job draft-1 --target arc.truth
  pnpm dev job ideas placement-context --story /path/to/story --job draft-1 --target event.reveal
  pnpm dev job ideas plan --story /path/to/story --job draft-1
  pnpm dev job ideas place --story /path/to/story --job draft-1 --id idea-abc --target authored-content.reveal --skills-source /path/to/noveltea-skills
  pnpm dev job ideas audit --story /path/to/story --job draft-1
  pnpm dev job ideas reverse --story /path/to/story --job draft-1
  pnpm dev job ideas reassess --story /path/to/story --job draft-1 --id idea-abc
  pnpm dev job ideas reassess --story /path/to/story --job draft-1 --id idea-abc --record --skills-source /path/to/noveltea-skills
  pnpm dev job ideas relocate --story /path/to/story --job draft-1 --id idea-abc --target authored-content.alternative
  pnpm dev job author send --story /path/to/story --job draft-1 --file author-message.json
  pnpm dev job author inspect --story /path/to/story --job draft-1
  pnpm dev job author process --story /path/to/story --job draft-1
  pnpm dev job author plan --story /path/to/story --job draft-1 --id change-1 --file revised-contract.json
  pnpm dev job author resume --story /path/to/story --job draft-1 --file typed-response.json
  pnpm dev job author control --story /path/to/story --job draft-1 --state paused
  pnpm dev job architecture propose --story /path/to/story --job draft-1 --contract revised-scope.json
  pnpm dev job architecture approve --story /path/to/story --job draft-1 --proposal <sha256> --signed-evidence /path/to/offline-signed-plan.json
  pnpm dev job revision inspect --story /path/to/story --job draft-1 --work-item revise-foundation --path creative-direction/foundation.md
  pnpm dev job revision authorize --story /path/to/story --job draft-1 --work-item revise-foundation --proposal <sha256> --signed-evidence /path/to/offline-signed-decision.json
  pnpm dev job revision review --story /path/to/story --job draft-1 --work-item revise-foundation --proposal <sha256> --signed-evidence /path/to/offline-signed-editorial.json
  pnpm dev job revision commit --story /path/to/story --job draft-1 --work-item revise-foundation --proposal <sha256>
  pnpm dev run --project /path/to/story --task "Summarize why a story needs a premise."
  pnpm dev run --project ./new-story --create-project --fixture --task "Verify the graph."
  pnpm dev demo-story --project ./fresh-story --create-project --task "A mystery; choose the rest"

Job Pi profile and budget (#28):
  configure|inspect   Pin a model profile, explicitly optional fallback, and safe-boundary budgets
  --provider, --model          Required profile (default openai/gpt-6-luna)
  --thinking low|medium|high   Optional required reasoning capability
  --fallback-provider, --fallback-model  Explicit optional fallback pair; never implicit
  --max-steps, --max-model-calls, --max-cost-usd  Optional cumulative job limits
  Budgets count observed Pi transcript usage; increase limits and rerun a paused action.
  Pi writing sessions are never interrupted mid-edit. Reconcile incomplete writes before resuming.

Job start:
  --story <path>     Required existing canonical Story directory within a Git worktree
  --job <id>         Required stable logical job ID (reopen by repeating the same ID)
  --noveltea-project <path>  Optional future engine project root (start only; metadata)
  --validator-source <path>  Legacy pinned jobs only (new jobs use native CLI)
                           (otherwise uses configured novelteaSkills)

Job revision:
  inspect            Record the exact proposed Story Markdown change and canonical Git impact
  authorize          Explicit author approval/rejection of one protected change ID
  review             Separate source-linked editorial/prose verdict for the proposal
  commit             Independently revalidate and commit the authorized work item
  status             Show durable proposal/approval/review evidence
  --work-item <id>    Required stable lowercase work-item ID
  --path <file>       Story-relative Markdown target on first inspect
  --proposal <hash>   Exact proposal hash required after inspection
  --signed-evidence <file>  Externally Ed25519-signed decision/review; key pinned in original Git baseline
                         No unsigned author approval/review flags are accepted

Job architecture:
  run|inspect|propose|approve|reconcile  Author, inspect, replan or explicitly reconcile saved edits
  --contract <json-file>    Completion contract: scope {kind,depth,targets,branches}, constraints,
                            envelope {presentation,hardLimits,preferences}
  --mode <mode>            autonomous requires contract; collaborative may await author scope
  --proposal <sha256>      Exact digest from architecture propose (approve only)
  --digest <sha256>        Exact reviewed candidate digest from inspect (reconcile only)
  --signed-evidence <file>  Externally signed Ed25519 plan approval from the author
  --skills-source <path>   NovelTea skills checkout to pin
  --validator-source <path>  Legacy validator source (compatibility only)
  --provider, --model      Pi specialist provider/model (default openai/gpt-6-luna)
  --fixture                Deterministic test adapter, not live Pi evidence

Job foundations (Character and World foundations after architecture):
  run|inspect|reconcile   Serialize and safely recover Worldbuilding and Character specialist work units
  --digest <sha256>        Exact inspected authored-bytes digest for explicit recovery
  --skills-source <path>   Pinned NovelTea skills checkout (first run)
  --validator-source <path>  Legacy validator source (compatibility only)
  --provider, --model      Real Pi specialist model (default openai/gpt-6-luna)
  --fixture                Deterministic test adapter, not live Pi evidence

Job interactive (Choice Point and Puzzle alternatives after Event design):
  run|inspect             Two serialized pinned specialists with independent validation/commits
  --milestone <id>        Required typed Milestone ID from completed Event work item
  --skills-source <path>  NovelTea skills checkout to pin (first run)
  --validator-source <path>  Legacy validator source (compatibility only)
  --provider, --model     Real Pi provider/model (default openai/gpt-6-luna)
  --thinking low|medium|high     Explicit thinking effort for both Pi specialists
  --fixture               Deterministic test adapter, not live Pi evidence

Job composition (branch-aware Authored Content after interactive design):
  run|inspect             Pinned composition specialist, independent branch-prose review, and commit
  --milestone <id>        Required typed Milestone ID from committed interactive work
  --skills-source <path>  NovelTea skills checkout to pin (first run)
  --validator-source <path>  Legacy validator source (compatibility only)
  --provider, --model     Real Pi provider/model (default openai/gpt-6-luna)
  --thinking low|high     Explicit thinking effort for writer and reviewer
  --fixture               Structural/lexical test adapter, NOT independent literary proof

Job report (read-only generation outcome and integration evidence):
  --format json|markdown   JSON by default; markdown for a human-readable report
  --output <path>          Optional exclusive export outside both Story checkout/worktree
  --preview                Optional disposable integration preview (otherwise not assessed)
  --fixture                With --preview: deterministic-only, no literary verification

Job merge preview (non-destructive integration assessment):
  --story, --job        Existing Story job; compares the job branch with the author's committed HEAD
  --validator-source   Legacy validator source (compatibility only)
  --skills-source      NovelTea skills checkout for independent read-only narrative review
  --provider, --model, --thinking low|high  Independent Pi reviewer profile
  --fixture            Deterministic-only preview; literary conflicts explicitly unverified
  No automatic rebase, merge, branch modifications or protected-decision overrides.

Job review (independent end-of-scope completion assessment):
  run|inspect           Validate the versioned scope, review alternate routes and editorial quality
  --skills-source <path> Pinned nt-narrative-review and nt-catalog source (first run)
  --validator-source <path> Legacy validator source (compatibility only)
  --provider, --model   Pi reviewer and bounded composition repair specialist
  --thinking low|high  Explicit thinking effort
  --fixture             Deterministic structural checks ONLY, never an editorial pass

Job event (bounded Event-design work item after Character/World foundations):
  run|inspect             Run or inspect a pinned nt-event-design Milestone work item
  --milestone <id>        Required typed Milestone ID from the approved architecture plan
  --skills-source <path>  NovelTea skills checkout to pin (first run)
  --validator-source <path>  Legacy validator source (compatibility only)
  --provider, --model     Pi specialist provider/model (default openai/gpt-6-luna)
  --fixture               Deterministic tests only, not real Pi evidence

Job author updates (live author messaging, #25):
  send                 Atomically enqueue a stable-ID message while Pi is writing (no job writer lock)
  inspect              Display queued/applied/review-required receipts and pending author questions
  process              Process messages at a safe job boundary via process_author_updates LangGraph node
  plan                 Propose a revised scope for --id <review-required change>, --file <contract.json>
  resume               Resume an exact persisted question or signed approval interrupt, --file typed-response.json
  control              Explicit execution state running|paused|cancelled|completed, never inferred from prose
  --file <json>        Message {id?,kind:idea|change|question|approval,payload:{...}}
  --state <state>      Only valid with control; paused/cancelled jobs do not auto-run on new messages
  --limit <count>      Optional per-pass message limit for process

Job ideas (deferred, noncanonical author material):
  capture             Persist exact author intent to .story-inbox/ideas/<id>.yaml in a verified Git commit
  inspect             Author-only full inbox inspection (never a worker context)
  eligibility         Scheduler-only IDs, counts, prerequisites and reasons (no source/wording)
  context             Ordinary worker: only explicitly authorized constraints for one canonical target
  placement-context   Dedicated future placement worker: eligible in-scope material at required depth
  --file <json>       Capture input preserving source, wording, binding requirements, scope and prerequisites
  --target <id>       Narrow canonical Arc/Milestone/Event ID; required for context operations


Job foundation:
  --inspect                Inspect saved writer/crash state without running the specialist
  --reconcile-digest <sha256>  Explicitly accept inspected unfinished bytes for validation (no replay)
  --task <brief>            Required when starting foundation discovery
  --mode <mode>            autonomous (default) or collaborative
  --envelope <text>        Author's narrative/presentation constraints
  --author-input <text>    Respond to the collaborative discovery handoff
  --skills-source <path>   NovelTea skills checkout to pin (or configured checkout)
  --validator-source <path>  Legacy validator source (compatibility only)
  --provider, --model      Pi specialist provider/model (default openai/gpt-6-luna)
  --fixture                Deterministic test adapter, not live Pi evidence

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

function disableJobCloudTracing() {
  process.env.LANGSMITH_TRACING = "false";
  process.env.LANGCHAIN_TRACING_V2 = "false";
  process.env.TRACE_TO_LANGSMITH = "false";
}

/** Shared strict parser for the individual job subcommands. */
function parseJobOptions(
  args: string[], command: string, options: readonly string[],
  booleans: readonly string[] = [], missingPrefix = "Missing " + command + " option value: ",
) {
  const allowed = new Set(options);
  const flags = new Set(booleans);
  const values = new Map<string, string>();
  while (args.length) {
    const flag = args.shift()!;
    if (!allowed.has(flag) || values.has(flag)) throw new Error("Invalid or duplicate " + command + " option: " + flag);
    if (flags.has(flag)) { values.set(flag, "true"); continue; }
    const value = args.shift();
    if (!value?.trim() || value.startsWith("--")) throw new Error(missingPrefix + flag);
    values.set(flag, value);
  }
  return values;
}

async function main(): Promise<void> {
  if (process.argv[2] === "job" && process.argv[3] === "generate") {
    const args = process.argv.slice(4);
    const action = args.shift();
    if (args.includes("--help") || args.includes("-h")) { process.stdout.write(USAGE); return; }
    if (action !== "start" && action !== "resume" && action !== "inspect")
      throw new Error("Expected job generate start|resume|inspect.");
    const values = parseJobOptions(args, "generate", ["--story", "--job", "--task", "--contract",
      "--skills-source", "--validator-source", "--provider", "--model", "--fixture", "--pause-after"], ["--fixture"]);
    const story = values.get("--story"), job = values.get("--job");
    if (!story || !job) throw new Error("job generate requires --story and --job.");
    disableJobCloudTracing();
    const { runStoryGeneration, generationStages } = await import("./generation.js");
    const pauseAfter = values.get("--pause-after") as typeof generationStages[number] | undefined;
    if (pauseAfter && (!generationStages.includes(pauseAfter) || action === "inspect"))
      throw new Error("--pause-after must name a generation stage and cannot be used with inspect.");
    const { readFile } = await import("node:fs/promises");
    const contract = values.has("--contract") ? JSON.parse(await readFile(values.get("--contract")!, "utf8")) : undefined;
    const result = await runStoryGeneration({ story, job, action, contract, pauseAfter,
      task: values.get("--task"), fixture: values.has("--fixture") ? true : undefined,
      skillsSource: values.get("--skills-source"), validatorSource: values.get("--validator-source"),
      provider: values.get("--provider"), model: values.get("--model") });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  if (process.argv[2] === "job" && process.argv[3] === "pi") {
    const args = process.argv.slice(4);
    const action = args.shift();
    if (args.includes("--help") || args.includes("-h")) { process.stdout.write(USAGE); return; }
    if (action !== "configure" && action !== "inspect") throw new Error("Expected job pi configure|inspect.");
    const values = parseJobOptions(args, "pi", ["--story", "--job", "--provider", "--model",
      "--thinking", "--fallback-provider", "--fallback-model",
      "--max-steps", "--max-model-calls", "--max-cost-usd"]);
    const story = values.get("--story"), jobId = values.get("--job");
    if (!story || !jobId) throw new Error("job pi requires --story and --job.");
    const { startStoryJob } = await import("./job.js");
    const { inspectPiPolicy, configurePiPolicy } = await import("./job-pi-policy.js");
    const job = await startStoryJob({ story, job: jobId }, false);
    if (action === "inspect") {
      if (values.size !== 2) throw new Error("Pi inspect accepts only --story and --job.");
    } else {
      const prev = await inspectPiPolicy(job);
      const provider = values.get("--provider") ?? prev.resolved?.requested.provider ?? prev.policy.profile.provider;
      const model = values.get("--model") ?? prev.resolved?.requested.model ?? prev.policy.profile.model;
      const thinking = values.get("--thinking") ?? prev.policy.profile.thinking;
      if (thinking !== undefined && !["low", "medium", "high"].includes(thinking))
        throw new Error("Pi thinking must be low, medium or high.");
      const fallbackProvider = values.get("--fallback-provider") ?? prev.policy.profile.optionalFallback?.provider;
      const fallbackModel = values.get("--fallback-model") ?? prev.policy.profile.optionalFallback?.model;
      if (Boolean(fallbackProvider) !== Boolean(fallbackModel))
        throw new Error("Optional Pi fallback requires both --fallback-provider and --fallback-model.");
      const number = (name: string) => values.has(name) ? Number(values.get(name)) : undefined;
      await configurePiPolicy(job, {
        version: 1,
        profile: { provider, model, ...(thinking ? { thinking: thinking as "low" | "medium" | "high" } : {}),
          ...(fallbackProvider && fallbackModel ? { optionalFallback: {
            provider: fallbackProvider, model: fallbackModel } } : {}) },
        limits: {
          steps: number("--max-steps") ?? prev.policy.limits.steps,
          modelCalls: number("--max-model-calls") ?? prev.policy.limits.modelCalls,
          costUsd: number("--max-cost-usd") ?? prev.policy.limits.costUsd,
        },
      });
    }
    process.stdout.write(JSON.stringify(await inspectPiPolicy(job), null, 2) + "\n");
    return;
  }
  if (process.argv[2] === "job" && process.argv[3] === "author") {
    const args = process.argv.slice(4);
    const action = args.shift();
    if (args.includes("--help") || args.includes("-h")) { process.stdout.write(USAGE); return; }
    if (!["send", "inspect", "process", "resume", "control", "plan"].includes(action ?? "")) {
      throw new Error("Expected job author send|inspect|process|resume|control|plan.");
    }
    const values = parseJobOptions(args, "author", ["--story", "--job", "--file", "--id", "--state", "--limit", "--carry-forward"]);
    const story = values.get("--story"), job = values.get("--job");
    if (!story || !job) throw new Error("job author requires --story and --job.");
    const state = values.get("--state");
    if (state && !["running", "paused", "cancelled", "completed"].includes(state)) {
      throw new Error("Invalid execution control state.");
    }
    const limit = values.has("--limit") ? Number(values.get("--limit")) : undefined;
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)) {
      throw new Error("--limit must be an integer from 1 to 1000.");
    }
    disableJobCloudTracing();
    const { runAuthorAction } = await import("./author-updates.js");
    let carryForward: string[] | undefined;
    if (values.has("--carry-forward")) {
      const { readFile } = await import("node:fs/promises");
      const { parseCarryForward } = await import("./plan-continuity.js");
      carryForward = parseCarryForward(JSON.parse(await readFile(values.get("--carry-forward")!, "utf8")));
    }
    const result = await runAuthorAction({ story, job, carryForward, action: action as "send" | "inspect" | "process" | "resume" | "control" | "plan",
      file: values.get("--file"), id: values.get("--id"), state: state as "running" | "paused" | "cancelled" | "completed" | undefined,
      limit });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  if (process.argv[2] === "job" && process.argv[3] === "ideas") {
    const args = process.argv.slice(4);
    const action = args.shift();
    if (args.includes("--help") || args.includes("-h")) { process.stdout.write(USAGE); return; }
    if (!["capture", "inspect", "eligibility", "context", "placement-context",
      "plan", "place", "audit", "reassess", "relocate", "reverse"].includes(action ?? "")) {
      throw new Error("Expected job ideas capture|inspect|eligibility|context|placement-context|plan|place|audit|reassess|relocate|reverse.");
    }
    const values = parseJobOptions(args, "ideas", ["--story", "--job", "--file", "--target",
      "--id", "--fixture", "--skills-source", "--validator-source", "--provider", "--model",
      "--thinking", "--signed-evidence", "--record"], ["--fixture", "--record"]);
    const story = values.get("--story"), job = values.get("--job");
    if (!story || !job) throw new Error("job ideas requires --story and --job.");
    disableJobCloudTracing();
    if (values.has("--thinking") && !["low", "high"].includes(values.get("--thinking")!))
      throw new Error("Idea --thinking supports low or high.");
    let result: unknown;
    if (["plan", "place", "audit", "reassess", "relocate", "reverse"].includes(action!)) {
      if (values.has("--file")) throw new Error("Only idea capture uses --file.");
      const { runIdeaPlacement } = await import("./idea-placement.js");
      result = await runIdeaPlacement({ story, job, action: action as
        "plan" | "place" | "audit" | "reassess" | "relocate" | "reverse",
        id: values.get("--id"), target: values.get("--target"), fixture: values.has("--fixture"),
        record: values.has("--record"),
        skillsSource: values.get("--skills-source"), validatorSource: values.get("--validator-source"),
        provider: values.get("--provider"), model: values.get("--model"),
        thinking: values.get("--thinking") as "low" | "high" | undefined,
        signedEvidence: values.get("--signed-evidence") });
    } else {
      const { runIdeas } = await import("./ideas.js");
      result = await runIdeas({ story, job,
        action: action as "capture" | "inspect" | "eligibility" | "context" | "placement-context",
        file: values.get("--file"), target: values.get("--target") });
    }
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  if (process.argv[2] === "job" && process.argv[3] === "report") {
    const args = process.argv.slice(4);
    if (args.includes("--help") || args.includes("-h")) { process.stdout.write(USAGE); return; }
    const values = parseJobOptions(args, "report", ["--story", "--job", "--format", "--output",
      "--preview", "--fixture", "--validator-source", "--skills-source", "--provider", "--model",
      "--thinking"], ["--preview", "--fixture"]);
    const story = values.get("--story"), jobId = values.get("--job");
    if (!story || !jobId) throw new Error("job report requires --story and --job.");
    const format = values.get("--format") ?? "json";
    if (format !== "json" && format !== "markdown") throw new Error("Report format must be json or markdown.");
    if (values.has("--fixture") && !values.has("--preview")) throw new Error("Report --fixture requires --preview.");
    if (values.has("--thinking") && !["low", "high"].includes(values.get("--thinking")!))
      throw new Error("Report --thinking supports low or high.");
    disableJobCloudTracing();
    const { inspectJobReport, formatJobReport, exportJobReport } = await import("./job-report.js");
    const { startStoryJob } = await import("./job.js");
    const report = await inspectJobReport({ story, job: jobId, preview: values.has("--preview"),
      fixture: values.has("--fixture"), validatorSource: values.get("--validator-source"),
      skillsSource: values.get("--skills-source"), provider: values.get("--provider"),
      model: values.get("--model"), thinking: values.get("--thinking") as "low" | "high" | undefined });
    const content = format === "json" ? JSON.stringify(report, null, 2) + "\n" : formatJobReport(report);
    if (values.has("--output")) {
      const current = await startStoryJob({ story, job: jobId }, false);
      const destination = await exportJobReport(current, values.get("--output")!, content);
      process.stdout.write(JSON.stringify({ status: "exported", format, destination,
        generation: report.generation.status, integration: report.integration.status }) + "\n");
    } else process.stdout.write(content);
    return;
  }
  if (process.argv[2] === "job" && process.argv[3] === "merge") {
    const args = process.argv.slice(4);
    const action = args.shift();
    if (args.includes("--help") || args.includes("-h")) { process.stdout.write(USAGE); return; }
    if (action !== "preview") throw new Error("Expected job merge preview.");
    const values = parseJobOptions(args, "merge", ["--story", "--job", "--validator-source",
      "--skills-source", "--provider", "--model", "--thinking", "--fixture"], ["--fixture"]);
    const story = values.get("--story"), job = values.get("--job");
    if (!story || !job) throw new Error("job merge preview requires --story and --job.");
    if (values.has("--thinking") && !["low", "high"].includes(values.get("--thinking")!))
      throw new Error("Merge preview --thinking supports low or high.");
    disableJobCloudTracing();
    const { previewStoryMerge } = await import("./merge-preview.js");
    const result = await previewStoryMerge({ story, job, fixture: values.has("--fixture"),
      validatorSource: values.get("--validator-source"), skillsSource: values.get("--skills-source"),
      provider: values.get("--provider"), model: values.get("--model"),
      thinking: values.get("--thinking") as "low" | "high" | undefined });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  if (process.argv[2] === "job" && process.argv[3] === "review") {
    const args = process.argv.slice(4);
    const action = args.shift();
    if (args.includes("--help") || args.includes("-h")) { process.stdout.write(USAGE); return; }
    if (action !== "run" && action !== "inspect") throw new Error("Expected job review run|inspect.");
    const values = parseJobOptions(args, "review", ["--story", "--job", "--skills-source",
      "--validator-source", "--provider", "--model", "--thinking", "--fixture"], ["--fixture"]);
    const story = values.get("--story"), job = values.get("--job");
    if (!story || !job) throw new Error("job review requires --story and --job.");
    if (values.has("--thinking") && !["low", "high"].includes(values.get("--thinking")!))
      throw new Error("Review --thinking supports low or high.");
    disableJobCloudTracing();
    const { runNarrativeReview } = await import("./narrative-review.js");
    const result = await runNarrativeReview({ story, job, action,
      skillsSource: values.get("--skills-source"), validatorSource: values.get("--validator-source"),
      provider: values.get("--provider"), model: values.get("--model"),
      thinking: values.get("--thinking") as "low" | "high" | undefined,
      fixture: values.has("--fixture") });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  if (process.argv[2] === "job" && process.argv[3] === "composition") {
    const args = process.argv.slice(4);
    const action = args.shift();
    if (args.includes("--help") || args.includes("-h")) { process.stdout.write(USAGE); return; }
    if (action !== "run" && action !== "inspect") throw new Error("Expected job composition run|inspect.");
    const values = parseJobOptions(args, "composition", ["--story", "--job", "--milestone", "--skills-source",
      "--validator-source", "--provider", "--model", "--thinking", "--fixture"], ["--fixture"]);
    const story = values.get("--story"), job = values.get("--job"), milestone = values.get("--milestone");
    if (!story || !job || !milestone) throw new Error("job composition requires --story, --job and --milestone.");
    if (values.has("--thinking") && !["low", "high"].includes(values.get("--thinking")!))
      throw new Error("Composition --thinking supports low or high.");
    disableJobCloudTracing();
    const { runCompositionWorkItem } = await import("./composition-work.js");
    const result = await runCompositionWorkItem({
      story, job, milestone, action, skillsSource: values.get("--skills-source"),
      validatorSource: values.get("--validator-source"), provider: values.get("--provider"),
      model: values.get("--model"), thinking: values.get("--thinking") as "low" | "high" | undefined,
      fixture: values.has("--fixture"),
    });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  if (process.argv[2] === "job" && process.argv[3] === "interactive") {
    const args = process.argv.slice(4);
    const action = args.shift();
    if (args.includes("--help") || args.includes("-h")) { process.stdout.write(USAGE); return; }
    if (action !== "run" && action !== "inspect") throw new Error("Expected job interactive run|inspect.");
    const values = parseJobOptions(args, "interactive", ["--story", "--job", "--milestone", "--skills-source",
      "--validator-source", "--provider", "--model", "--thinking", "--fixture"], ["--fixture"]);
    const story = values.get("--story"), job = values.get("--job"), milestone = values.get("--milestone");
    if (!story || !job || !milestone) throw new Error("job interactive requires --story, --job and --milestone.");
    if (values.has("--thinking") && !["low", "medium", "high"].includes(values.get("--thinking")!)) throw new Error("Interactive --thinking supports low, medium or high.");
    disableJobCloudTracing();
    const { runInteractiveWorkItem } = await import("./interactive-work.js");
    const result = await runInteractiveWorkItem({
      story, job, milestone, action, skillsSource: values.get("--skills-source"),
      validatorSource: values.get("--validator-source"), provider: values.get("--provider"),
      model: values.get("--model"), thinking: values.get("--thinking") as "low" | "medium" | "high" | undefined,
      fixture: values.has("--fixture"),
    });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  if (process.argv[2] === "job" && process.argv[3] === "event") {
    const args = process.argv.slice(4);
    const action = args.shift();
    if (args.includes("--help") || args.includes("-h")) { process.stdout.write(USAGE); return; }
    if (action !== "run" && action !== "inspect") throw new Error("Expected job event run|inspect.");
    const values = parseJobOptions(args, "Event", ["--story", "--job", "--milestone", "--skills-source",
      "--validator-source", "--provider", "--model", "--fixture"], ["--fixture"]);
    const story = values.get("--story"), job = values.get("--job"), milestone = values.get("--milestone");
    if (!story || !job || !milestone) throw new Error("job event requires --story, --job and --milestone.");
    disableJobCloudTracing();
    const { runEventWorkItem } = await import("./event-work.js");
    const result = await runEventWorkItem({ story, job, milestone, action,
      skillsSource: values.get("--skills-source"), validatorSource: values.get("--validator-source"),
      provider: values.get("--provider"), model: values.get("--model"),
      fixture: values.has("--fixture") });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  if (process.argv[2] === "job" && process.argv[3] === "foundations") {
    const args = process.argv.slice(4);
    const action = args.shift();
    if (args.includes("--help") || args.includes("-h")) { process.stdout.write(USAGE); return; }
    if (!["run", "inspect", "reconcile"].includes(action ?? "")) throw new Error("Expected job foundations run|inspect|reconcile.");
    const values = parseJobOptions(args, "foundations", ["--story", "--job", "--skills-source",
      "--validator-source", "--provider", "--model", "--fixture", "--digest"], ["--fixture"]);
    const story = values.get("--story"), job = values.get("--job");
    if (!story || !job) throw new Error("job foundations requires --story and --job.");
    if (action === "reconcile" && !values.has("--digest")) throw new Error("Foundations reconcile requires --digest.");
    disableJobCloudTracing();
    const { runCharacterWorldJob } = await import("./character-world.js");
    const result = await runCharacterWorldJob({ story, job, action: action as "run" | "inspect" | "reconcile",
      recoveryDigest: values.get("--digest"), skillsSource: values.get("--skills-source"),
      validatorSource: values.get("--validator-source"), provider: values.get("--provider"),
      model: values.get("--model"), fixture: values.has("--fixture") });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  if (process.argv[2] === "job" && process.argv[3] === "architecture") {
    const args = process.argv.slice(4);
    const action = args.shift();
    if (args.includes("--help") || args.includes("-h")) {
      process.stdout.write(USAGE);
      return;
    }
    if (!["run", "inspect", "propose", "approve", "reconcile"].includes(action ?? "")) {
      throw new Error("Expected job architecture run|inspect|propose|approve|reconcile.");
    }
    const values = parseJobOptions(args, "architecture", ["--story", "--job", "--contract", "--mode",
      "--proposal", "--digest", "--signed-evidence", "--carry-forward", "--skills-source", "--validator-source",
      "--provider", "--model", "--fixture"], ["--fixture"], "Missing value for architecture option ");
    const story = values.get("--story"), job = values.get("--job");
    if (!story || !job) throw new Error("job architecture requires --story and --job.");
    const mode = values.get("--mode");
    if (mode && mode !== "autonomous" && mode !== "collaborative") throw new Error("Architecture mode must be autonomous or collaborative.");
    if (action === "propose" && !values.has("--contract")) throw new Error("Architecture propose requires --contract.");
    if (action !== "propose" && values.has("--carry-forward")) {
      throw new Error("Only architecture propose accepts --carry-forward.");
    }
    if (action === "approve" && (!values.has("--proposal") || !values.has("--signed-evidence"))) {
      throw new Error("Architecture approve requires --proposal and --signed-evidence.");
    }
    if (action === "inspect" && values.has("--contract")) throw new Error("Architecture inspect does not accept --contract.");
    if (action === "reconcile" && (!values.has("--digest") || values.has("--contract"))) {
      throw new Error("Architecture reconcile requires --digest and does not accept --contract.");
    }
    let carryForward: string[] | undefined;
    if (values.has("--carry-forward")) {
      const { readFile } = await import("node:fs/promises");
      const value: unknown = JSON.parse(await readFile(values.get("--carry-forward")!, "utf8"));
      const { parseCarryForward } = await import("./plan-continuity.js");
      carryForward = parseCarryForward(value);
    }
    let contract: unknown;
    if (values.has("--contract")) {
      const { readFile } = await import("node:fs/promises");
      contract = JSON.parse(await readFile(values.get("--contract")!, "utf8"));
    }
    disableJobCloudTracing();
    const { runArchitectureJob } = await import("./architecture.js");
    const result = await runArchitectureJob({
      story, job, action: action as "run" | "inspect" | "propose" | "approve" | "reconcile",
      contract, carryForward, mode: mode as "autonomous" | "collaborative" | undefined,
      proposal: values.get("--proposal"), signedEvidence: values.get("--signed-evidence"),
      recoveryDigest: values.get("--digest"),
      skillsSource: values.get("--skills-source"), validatorSource: values.get("--validator-source"),
      provider: values.get("--provider"), model: values.get("--model"), fixture: values.has("--fixture"),
    });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  if (process.argv[2] === "job" && process.argv[3] === "revision") {
    const { runRevisionAction } = await import("./revision.js");
    const args = process.argv.slice(4);
    const action = args.shift();
    if (args.includes("--help") || args.includes("-h")) {
      process.stdout.write(USAGE);
      return;
    }
    if (!["inspect", "authorize", "review", "commit", "status"].includes(action ?? "")) {
      throw new Error("Expected job revision inspect|authorize|review|commit|status.");
    }
    const values = parseJobOptions(args, "revision", ["--story", "--job", "--work-item",
      "--path", "--proposal", "--signed-evidence", "--validator-source"], [], "Missing value for revision option ");
    const story = values.get("--story"), job = values.get("--job"), workItem = values.get("--work-item");
    if (!story || !job || !workItem) throw new Error("job revision requires --story, --job and --work-item.");
    disableJobCloudTracing();
    const result = await runRevisionAction({
      story, job, workItem, action: action as "inspect" | "authorize" | "review" | "commit" | "status",
      path: values.get("--path"), proposal: values.get("--proposal"),
      signedEvidence: values.get("--signed-evidence"),
      validatorSource: values.get("--validator-source"),
    });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  if (process.argv[2] === "job") {
    const args = process.argv.slice(3);
    const jobCommand = args.shift();
    if (jobCommand !== "start" && jobCommand !== "validate" && jobCommand !== "foundation") {
      throw new Error("Expected 'job start', 'job validate' or 'job foundation'.");
    }
    if (args.includes("--help") || args.includes("-h")) {
      process.stdout.write(USAGE);
      return;
    }
    let story = "";
    let job = "";
    let novelteaProject: string | undefined;
    let validatorSource: string | undefined;
    let task: string | undefined;
    let envelope: string | undefined;
    let authorInput: string | undefined;
    let mode: "autonomous" | "collaborative" | undefined;
    let skillsSource: string | undefined;
    let provider: string | undefined;
    let model: string | undefined;
    let fixture = false;
    let inspect = false;
    let recoveryDigest: string | undefined;
    const provided = new Set<string>();
    while (args.length) {
      const flag = args.shift()!;
      if (["--fixture", "--inspect"].includes(flag) && jobCommand === "foundation") {
        if (provided.has(flag)) throw new Error(`Duplicate job option: ${flag}.`);
        provided.add(flag);
        if (flag === "--fixture") fixture = true;
        if (flag === "--inspect") inspect = true;
        continue;
      }
      if (flag !== "--story" && flag !== "--job" &&
          !(jobCommand === "start" && flag === "--noveltea-project") &&
          !(["validate", "foundation"].includes(jobCommand!) && flag === "--validator-source") &&
          !(jobCommand === "foundation" && ["--task", "--mode", "--envelope", "--author-input", "--skills-source", "--provider", "--model", "--reconcile-digest"].includes(flag))) {
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
      if (flag === "--task") task = value;
      if (flag === "--envelope") envelope = value;
      if (flag === "--author-input") authorInput = value;
      if (flag === "--skills-source") skillsSource = value;
      if (flag === "--provider") provider = value;
      if (flag === "--model") model = value;
      if (flag === "--reconcile-digest") recoveryDigest = value;
      if (flag === "--mode") {
        if (value !== "autonomous" && value !== "collaborative") throw new Error("--mode must be autonomous or collaborative.");
        mode = value;
      }
    }
    if (!story) throw new Error("Missing required --story <path>.");
    if (!job) throw new Error("Missing required --job <id>.");
    if (jobCommand === "foundation") {
      // Job foundation has no hosted tracing opt-in. Ambient environment
      // settings must not unexpectedly upload prompts or Story content.
      process.env.LANGSMITH_TRACING = "false";
      process.env.LANGCHAIN_TRACING_V2 = "false";
      process.env.TRACE_TO_LANGSMITH = "false";
      const { runFoundationJob } = await import("./foundation.js");
      const result = await runFoundationJob({ story, job, task, mode, envelope,
        authorInput, skillsSource, validatorSource, provider, model, fixture, inspect, recoveryDigest });
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      return;
    }
    const { startStoryJob } = await import("./job.js");
    const target = await startStoryJob({ story, job, novelteaProject }, jobCommand === "start");
    if (jobCommand === "start") {
      process.stdout.write(JSON.stringify(target, null, 2) + "\n");
      return;
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
  if (error instanceof Error && error.name === "PiBudgetPause") {
    const pause = error as Error & { reason: string; usage: unknown };
    process.stdout.write(JSON.stringify({ status: "paused-budget", reason: pause.reason,
      usage: pause.usage, resumable: true }, null, 2) + "\n");
    return;
  }
  const message = error instanceof Error ? error.message : "Unknown error";
  process.stderr.write(`noveltea-gen: ${redactCredentials(message)}\n`);
  process.exitCode = process.argv[2] === "job" && process.argv[3] === "validate" ? 2 : 1;
});
