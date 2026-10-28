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
  pnpm dev job architecture propose --story /path/to/story --job draft-1 --contract revised-scope.json
  pnpm dev job architecture approve --story /path/to/story --job draft-1 --proposal <sha256> --signed-evidence /path/to/offline-signed-plan.json
  pnpm dev job revision inspect --story /path/to/story --job draft-1 --work-item revise-foundation --path creative-direction/foundation.md
  pnpm dev job revision authorize --story /path/to/story --job draft-1 --work-item revise-foundation --proposal <sha256> --signed-evidence /path/to/offline-signed-decision.json
  pnpm dev job revision review --story /path/to/story --job draft-1 --work-item revise-foundation --proposal <sha256> --signed-evidence /path/to/offline-signed-editorial.json
  pnpm dev job revision commit --story /path/to/story --job draft-1 --work-item revise-foundation --proposal <sha256>
  pnpm dev run --project /path/to/story --task "Summarize why a story needs a premise."
  pnpm dev run --project ./new-story --create-project --fixture --task "Verify the graph."
  pnpm dev demo-story --project ./fresh-story --create-project --task "A mystery; choose the rest"

Job start:
  --story <path>     Required existing canonical Story directory within a Git worktree
  --job <id>         Required stable logical job ID (reopen by repeating the same ID)
  --noveltea-project <path>  Optional future engine project root (start only; metadata)
  --validator-source <path>  Initial validation: canonical noveltea-skills checkout
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
  --validator-source <path>  Canonical validator checkout for initial pin
  --provider, --model      Pi specialist provider/model (default openai/gpt-6-luna)
  --fixture                Deterministic test adapter, not live Pi evidence

Job foundations (Character and World foundations after architecture):
  run|inspect|reconcile   Serialize and safely recover Worldbuilding and Character specialist work units
  --digest <sha256>        Exact inspected authored-bytes digest for explicit recovery
  --skills-source <path>   Pinned NovelTea skills checkout (first run)
  --validator-source <path>  Canonical Story validator checkout (first run)
  --provider, --model      Real Pi specialist model (default openai/gpt-6-luna)
  --fixture                Deterministic test adapter, not live Pi evidence

Job interactive (Choice Point and Puzzle alternatives after Event design):
  run|inspect             Two serialized pinned specialists with independent validation/commits
  --milestone <id>        Required typed Milestone ID from completed Event work item
  --skills-source <path>  NovelTea skills checkout to pin (first run)
  --validator-source <path>  Canonical validator checkout (first run)
  --provider, --model     Real Pi provider/model (default openai/gpt-6-luna)
  --thinking low|high     Explicit thinking effort for both Pi specialists
  --fixture               Deterministic test adapter, not live Pi evidence

Job composition (branch-aware Authored Content after interactive design):
  run|inspect             Pinned composition specialist, independent branch-prose review, and commit
  --milestone <id>        Required typed Milestone ID from committed interactive work
  --skills-source <path>  NovelTea skills checkout to pin (first run)
  --validator-source <path>  Canonical Story validator source (first run)
  --provider, --model     Real Pi provider/model (default openai/gpt-6-luna)
  --thinking low|high     Explicit thinking effort for writer and reviewer
  --fixture               Structural/lexical test adapter, NOT independent literary proof

Job event (bounded Event-design work item after Character/World foundations):
  run|inspect             Run or inspect a pinned nt-event-design Milestone work item
  --milestone <id>        Required typed Milestone ID from the approved architecture plan
  --skills-source <path>  NovelTea skills checkout to pin (first run)
  --validator-source <path>  Canonical catalog source to pin (first validation)
  --provider, --model     Pi specialist provider/model (default openai/gpt-6-luna)
  --fixture               Deterministic tests only, not real Pi evidence

Job foundation:
  --inspect                Inspect saved writer/crash state without running the specialist
  --reconcile-digest <sha256>  Explicitly accept inspected unfinished bytes for validation (no replay)
  --task <brief>            Required when starting foundation discovery
  --mode <mode>            autonomous (default) or collaborative
  --envelope <text>        Author's narrative/presentation constraints
  --author-input <text>    Respond to the collaborative discovery handoff
  --skills-source <path>   NovelTea skills checkout to pin (or configured checkout)
  --validator-source <path>  Canonical validator source for initial pin
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

async function main(): Promise<void> {
  if (process.argv[2] === "job" && process.argv[3] === "composition") {
    const args = process.argv.slice(4);
    const action = args.shift();
    if (args.includes("--help") || args.includes("-h")) { process.stdout.write(USAGE); return; }
    if (action !== "run" && action !== "inspect") throw new Error("Expected job composition run|inspect.");
    const allowed = new Set(["--story", "--job", "--milestone", "--skills-source",
      "--validator-source", "--provider", "--model", "--thinking", "--fixture"]);
    const values = new Map<string, string>();
    while (args.length) {
      const flag = args.shift()!;
      if (!allowed.has(flag) || values.has(flag)) throw new Error("Invalid or duplicate composition option: " + flag);
      if (flag === "--fixture") { values.set(flag, "true"); continue; }
      const value = args.shift();
      if (!value?.trim() || value.startsWith("--")) throw new Error("Missing composition option value: " + flag);
      values.set(flag, value);
    }
    const story = values.get("--story"), job = values.get("--job"), milestone = values.get("--milestone");
    if (!story || !job || !milestone) throw new Error("job composition requires --story, --job and --milestone.");
    if (values.has("--thinking") && !["low", "high"].includes(values.get("--thinking")!))
      throw new Error("Composition --thinking supports low or high.");
    process.env.LANGSMITH_TRACING = "false";
    process.env.LANGCHAIN_TRACING_V2 = "false";
    process.env.TRACE_TO_LANGSMITH = "false";
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
    const allowed = new Set(["--story", "--job", "--milestone", "--skills-source",
      "--validator-source", "--provider", "--model", "--thinking", "--fixture"]);
    const values = new Map<string, string>();
    while (args.length) {
      const flag = args.shift()!;
      if (!allowed.has(flag) || values.has(flag)) throw new Error("Invalid or duplicate interactive option: " + flag);
      if (flag === "--fixture") { values.set(flag, "true"); continue; }
      const value = args.shift();
      if (!value?.trim() || value.startsWith("--")) throw new Error("Missing interactive option value: " + flag);
      values.set(flag, value);
    }
    const story = values.get("--story"), job = values.get("--job"), milestone = values.get("--milestone");
    if (!story || !job || !milestone) throw new Error("job interactive requires --story, --job and --milestone.");
    if (values.has("--thinking") && !["low", "high"].includes(values.get("--thinking")!)) throw new Error("Interactive --thinking supports low or high.");
    process.env.LANGSMITH_TRACING = "false";
    process.env.LANGCHAIN_TRACING_V2 = "false";
    process.env.TRACE_TO_LANGSMITH = "false";
    const { runInteractiveWorkItem } = await import("./interactive-work.js");
    const result = await runInteractiveWorkItem({
      story, job, milestone, action, skillsSource: values.get("--skills-source"),
      validatorSource: values.get("--validator-source"), provider: values.get("--provider"),
      model: values.get("--model"), thinking: values.get("--thinking") as "low" | "high" | undefined,
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
    const allowed = new Set(["--story", "--job", "--milestone", "--skills-source",
      "--validator-source", "--provider", "--model", "--fixture"]);
    const values = new Map<string, string>();
    while (args.length) {
      const flag = args.shift()!;
      if (!allowed.has(flag) || values.has(flag)) throw new Error("Invalid or duplicate Event option: " + flag);
      if (flag === "--fixture") { values.set(flag, "true"); continue; }
      const value = args.shift();
      if (!value?.trim() || value.startsWith("--")) throw new Error("Missing Event option value: " + flag);
      values.set(flag, value);
    }
    const story = values.get("--story"), job = values.get("--job"), milestone = values.get("--milestone");
    if (!story || !job || !milestone) throw new Error("job event requires --story, --job and --milestone.");
    process.env.LANGSMITH_TRACING = "false";
    process.env.LANGCHAIN_TRACING_V2 = "false";
    process.env.TRACE_TO_LANGSMITH = "false";
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
    const allowed = new Set(["--story", "--job", "--skills-source", "--validator-source", "--provider", "--model", "--fixture", "--digest"]);
    const values = new Map<string, string>();
    while (args.length) {
      const flag = args.shift()!;
      if (!allowed.has(flag) || values.has(flag)) throw new Error("Invalid or duplicate foundations option: " + flag);
      if (flag === "--fixture") { values.set(flag, "true"); continue; }
      const value = args.shift();
      if (!value?.trim() || value.startsWith("--")) throw new Error("Missing foundations option value: " + flag);
      values.set(flag, value);
    }
    const story = values.get("--story"), job = values.get("--job");
    if (!story || !job) throw new Error("job foundations requires --story and --job.");
    if (action === "reconcile" && !values.has("--digest")) throw new Error("Foundations reconcile requires --digest.");
    process.env.LANGSMITH_TRACING = "false";
    process.env.LANGCHAIN_TRACING_V2 = "false";
    process.env.TRACE_TO_LANGSMITH = "false";
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
    const allowed = new Set(["--story", "--job", "--contract", "--mode", "--proposal", "--digest", "--signed-evidence",
      "--skills-source", "--validator-source", "--provider", "--model", "--fixture"]);
    const values = new Map<string, string>();
    while (args.length) {
      const flag = args.shift()!;
      if (!allowed.has(flag) || values.has(flag)) throw new Error("Invalid or duplicate architecture option: " + flag);
      if (flag === "--fixture") { values.set(flag, "true"); continue; }
      const value = args.shift();
      if (!value?.trim() || value.startsWith("--")) throw new Error("Missing value for architecture option " + flag);
      values.set(flag, value);
    }
    const story = values.get("--story"), job = values.get("--job");
    if (!story || !job) throw new Error("job architecture requires --story and --job.");
    const mode = values.get("--mode");
    if (mode && mode !== "autonomous" && mode !== "collaborative") throw new Error("Architecture mode must be autonomous or collaborative.");
    if (action === "propose" && !values.has("--contract")) throw new Error("Architecture propose requires --contract.");
    if (action === "approve" && (!values.has("--proposal") || !values.has("--signed-evidence"))) {
      throw new Error("Architecture approve requires --proposal and --signed-evidence.");
    }
    if (action === "inspect" && values.has("--contract")) throw new Error("Architecture inspect does not accept --contract.");
    if (action === "reconcile" && (!values.has("--digest") || values.has("--contract"))) {
      throw new Error("Architecture reconcile requires --digest and does not accept --contract.");
    }
    let contract: unknown;
    if (values.has("--contract")) {
      const { readFile } = await import("node:fs/promises");
      contract = JSON.parse(await readFile(values.get("--contract")!, "utf8"));
    }
    process.env.LANGSMITH_TRACING = "false";
    process.env.LANGCHAIN_TRACING_V2 = "false";
    process.env.TRACE_TO_LANGSMITH = "false";
    const { runArchitectureJob } = await import("./architecture.js");
    const result = await runArchitectureJob({
      story, job, action: action as "run" | "inspect" | "propose" | "approve" | "reconcile",
      contract, mode: mode as "autonomous" | "collaborative" | undefined,
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
    const allowed = new Set(["--story", "--job", "--work-item", "--path", "--proposal",
      "--signed-evidence", "--validator-source"]);
    const values = new Map<string, string>();
    while (args.length) {
      const flag = args.shift()!;
      if (!allowed.has(flag) || values.has(flag)) throw new Error("Invalid or duplicate revision option: " + flag);
      const value = args.shift();
      if (!value?.trim() || value.startsWith("--")) throw new Error("Missing value for revision option " + flag);
      values.set(flag, value);
    }
    const story = values.get("--story"), job = values.get("--job"), workItem = values.get("--work-item");
    if (!story || !job || !workItem) throw new Error("job revision requires --story, --job and --work-item.");
    process.env.LANGSMITH_TRACING = "false";
    process.env.LANGCHAIN_TRACING_V2 = "false";
    process.env.TRACE_TO_LANGSMITH = "false";
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
