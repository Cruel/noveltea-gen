/** Independent read-only review of an uncommitted Arc/Milestone assignment.
 * This cycle is early feedback, not the mandatory postcommit semantic seal. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import type { JobStartResult } from "./job.js";
import type { SkillSnapshot } from "./snapshot.js";
import type { Plan } from "./architecture.js";
import type { CausalBlueprint } from "./architecture-blueprint.js";
import { createProjectResourceLoader } from "./pi.js";
import { openStoryProject } from "./project.js";
import { createJobModelRuntime } from "./model-runtime.js";
import { guardPiBudget, preparePiContext } from "./job-pi-policy.js";
import { selectSandboxPiTools, SANDBOX_READ_ONLY_TOOLS } from "./sandbox-pi-tools.js";
import { promptStorySpecialist } from "./story-interruption.js";
import { completedPinnedSkillReads } from "./pinned-skill-reads.js";
import { authorizedArchitectureRecordPath } from "./architecture-record-path.js";
import { openSkillSnapshot } from "./snapshot.js";
import { reviewCycleId, assertReviewCycleSession } from "./review-cycle.js";

const sha = (input: unknown) =>
  createHash("sha256")
    .update(typeof input === "string" ? input : JSON.stringify(input))
    .digest("hex");
const HASH = /^[a-f0-9]{64}$/;
const filled = (text: unknown, min = 1, max = 750): text is string =>
  typeof text === "string" && text.trim().length >= min && text.length <= max;
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const progressStates = ["resolved", "improved", "persisting", "regressed"] as const;
export type ArchitectureReviewStatus = (typeof progressStates)[number];
export interface ArchitectureDraftFinding {
  path: string;
  reason: string;
  correction: string;
  requirement: { source: "foundation" | "contract" | "task" | "blueprint"; quote: string };
  evidence: { path: string; quote: string };
  origin: "initial" | "continuing" | "introduced" | "overlooked";
}
export interface ArchitectureDraftReview {
  schema: "noveltea-architecture-draft-review/v2";
  status: "pass" | "revise";
  findings: ArchitectureDraftFinding[];
  prior: Array<{
    round: number;
    findingIndex: number;
    status: ArchitectureReviewStatus;
    reason: string;
    evidence: { path: string; quote: string };
  }>;
}
export interface ArchitectureDraftRound {
  sources: Record<string, string>;
  verdict: ArchitectureDraftReview;
}
export interface ArchitectureDraftReviewPin {
  cycleId: string;
  round: number;
  receiptDigest: string;
}
type ReviewSources = { foundation: string; contract: string; task: string; blueprint: string };
type Writer = { id: string; file: string };
type RoundReceipt = {
  schema: "noveltea-architecture-draft-turn/v1";
  cycleId: string;
  round: number;
  previousDigest: string | null;
  writer: Writer;
  reviewer: Writer;
  sources: Record<string, string>;
  verdict: ArchitectureDraftReview;
  transcriptBytes: number;
  transcriptDigest: string;
};

export function architectureDraftFormatCorrection(paths: readonly string[]): string {
  if (!paths.length || paths.length > 32 || paths.some((path) => !authorizedArchitectureRecordPath(path)))
    throw Error("Architecture draft format correction lacks authorized record paths.");
  return (
    "INDEPENDENT DRAFT VERDICT PROTOCOL CORRECTION (same read-only session): " +
    "Your verdict or source reads failed the controller's exact contract. Do not edit files, " +
    "change standards or assert approval. Re-read the pinned skills, Creative Direction and " +
    "ALL changed files and return COMPLETE strict JSON with exactly schema,status,findings,prior. " +
    "Schema is noveltea-architecture-draft-review/v2. Each finding has EXACT keys " +
    "path,reason,correction,requirement,evidence,origin. Requirement is {source,quote} from " +
    "foundation,contract,task,blueprint; evidence is {path,quote} with an EXACT 8+ character " +
    "quote in the currently read file. Origin is initial,continuing,introduced,overlooked. " +
    "Prior entries must account for EVERY earlier finding in the given history with EXACT " +
    "keys round,findingIndex,status,reason,evidence, where status is resolved,improved," +
    "persisting,regressed and evidence is {path,quote} from the CURRENT file. " +
    "Status pass requires [] findings and all earlier findings resolved; revise requires " +
    "1-8 material findings. Text fields max 750 characters. Use forward slashes, not periods, " +
    "for path separators. Only these authorized record paths are allowed: " +
    JSON.stringify(paths) +
    ". Do not include code fences or extra keys. " +
    "This correction grants no write scope, approval or source change."
  );
}

/** Validate the reviewer verdict against actual Story bytes, authorized
 * requirements and the complete earlier finding history, not reviewer prose. */
export function parseArchitectureDraftReview(
  raw: string,
  paths: readonly string[],
  sources?: Record<string, string>,
  requirements?: ReviewSources,
  previous: readonly ArchitectureDraftRound[] = [],
): ArchitectureDraftReview {
  const text = raw
    .trim()
    .replace(/^```(?:json)?\s*\n/i, "")
    .replace(/\n```\s*$/, "");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw Error("Independent draft reviewer returned invalid JSON; preserve draft.");
  }
  if (
    !exact(value, ["schema", "status", "findings", "prior"]) ||
    value.schema !== "noveltea-architecture-draft-review/v2" ||
    !["pass", "revise"].includes(String(value.status)) ||
    !Array.isArray(value.findings) ||
    !Array.isArray(value.prior) ||
    value.findings.length > 8 ||
    (value.status === "pass" ? value.findings.length !== 0 : value.findings.length === 0)
  )
    throw Error("Independent Architecture draft review has invalid schema or verdict.");
  const review = value as unknown as ArchitectureDraftReview;
  const citation = (p: unknown, current: Record<string, string> | undefined, expected?: string) =>
    exact(p, ["path", "quote"]) &&
    typeof p.path === "string" &&
    paths.includes(p.path) &&
    (!expected || expected === p.path) &&
    filled(p.quote, 8) &&
    (!current || (current[p.path]?.includes(p.quote) ?? false));
  for (const finding of review.findings) {
    if (
      !exact(finding, ["path", "reason", "correction", "requirement", "evidence", "origin"]) ||
      !authorizedArchitectureRecordPath(finding.path) ||
      !paths.includes(finding.path) ||
      !filled(finding.reason) ||
      !filled(finding.correction) ||
      !["initial", "continuing", "introduced", "overlooked"].includes(finding.origin) ||
      (previous.length ? finding.origin === "initial" : finding.origin !== "initial") ||
      !exact(finding.requirement, ["source", "quote"]) ||
      !["foundation", "contract", "task", "blueprint"].includes(finding.requirement.source) ||
      !filled(finding.requirement.quote, 8) ||
      (requirements && !requirements[finding.requirement.source]?.includes(finding.requirement.quote)) ||
      !citation(finding.evidence, sources, finding.path)
    )
      throw Error(
        "Independent Architecture draft review contains missing, unbounded or unauthorized findings/evidence.",
      );
    if (
      previous.length &&
      finding.origin === "continuing" &&
      !previous.some((round) => round.verdict.findings.some((old) => old.path === finding.path))
    )
      throw Error("Architecture continuing finding has no prior reviewed target.");
  }
  const count = previous.reduce((n, round) => n + round.verdict.findings.length, 0);
  if (review.prior.length !== count)
    throw Error("Independent Architecture draft review failed to account for earlier findings.");
  const seen = new Set<string>();
  for (const p of review.prior) {
    if (
      !exact(p, ["round", "findingIndex", "status", "reason", "evidence"]) ||
      !Number.isSafeInteger(p.round) ||
      !Number.isSafeInteger(p.findingIndex) ||
      !progressStates.includes(p.status) ||
      !filled(p.reason)
    )
      throw Error("Independent Architecture draft previous-finding accounting is malformed.");
    const old = previous[p.round]?.verdict.findings[p.findingIndex];
    const key = p.round + ":" + p.findingIndex;
    if (!old || seen.has(key) || !citation(p.evidence, sources, old.path))
      throw Error("Independent Architecture draft previous finding refers to wrong source or index.");
    seen.add(key);
  }
  if (review.status === "pass" && review.prior.some((p) => p.status !== "resolved"))
    throw Error("Independent Architecture draft review cannot pass with unresolved findings.");
  return review;
}

/** Conservative source-based convergence: new words alone and repeated drafts
 * cannot establish progress; a reviewer must cite new material on the affected
 * path while retaining every earlier finding in its source-grounded history. */
export function architectureDraftConvergence(
  review: ArchitectureDraftReview,
  sources: Record<string, string>,
  previous: readonly ArchitectureDraftRound[],
  stalledBefore = 0,
) {
  const now = sha(sources);
  const oscillating = previous.some((round) => sha(round.sources) === now);
  const last = previous.at(-1);
  const regressed = review.prior.some((p) => p.status === "regressed");
  const productive =
    !!last &&
    !oscillating &&
    !regressed &&
    review.prior.some((p) => {
      if (p.status !== "resolved" && p.status !== "improved") return false;
      const old = previous[p.round]!.verdict.findings[p.findingIndex]!;
      return (
        sources[old.path] !== last.sources[old.path] &&
        sources[old.path]?.includes(p.evidence.quote) &&
        !last.sources[old.path]?.includes(p.evidence.quote)
      );
    });
  if (last && review.status === "pass" && !productive)
    throw Error("Architecture draft pass lacks source-grounded progress or repeats an old draft.");
  const stalled = !last || productive ? 0 : stalledBefore + 1;
  return { productive, oscillating, stalled, reassess: review.status === "revise" && stalled >= 2 };
}

function cycleScope(
  job: JobStartResult,
  snapshot: SkillSnapshot,
  plan: Plan,
  provider: string,
  model: string,
  paths: string[],
  task: string,
  blueprint?: CausalBlueprint,
) {
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: job.worktreeRoot,
    encoding: "utf8",
  }).trim();
  return {
    jobId: job.jobId,
    threadId: job.threadId,
    baseSha: job.baseSha,
    executionHead: head,
    planVersion: plan.version,
    contractDigest: sha(plan.contract),
    snapshotId: snapshot.id,
    provider,
    model,
    taskDigest: sha({ task, paths: [...paths].sort(), blueprint: blueprint ?? null }),
  };
}
const cycleDirectory = (job: JobStartResult, cycleId: string) =>
  join(job.stateDir, "architecture-draft-reviews", cycleId);
const admissionPath = (job: JobStartResult, cycleId: string) =>
  join(cycleDirectory(job, cycleId), "admitted.json");
const roundPath = (job: JobStartResult, cycleId: string, round: number) =>
  join(cycleDirectory(job, cycleId), "round-" + round + ".json");
type AdmissionReceipt = {
  schema: "noveltea-architecture-draft-admission/v1";
  cycleId: string;
  writer: Writer;
  reviewer: Writer;
};

async function transcriptEvidence(job: JobStartResult, reviewer: Writer) {
  const folder = join(job.stateDir, "architecture-draft-review-sessions");
  if (
    !reviewer.id ||
    !reviewer.file.startsWith(folder + sep) ||
    (await realpath(reviewer.file)) !== reviewer.file ||
    !(await lstat(reviewer.file)).isFile()
  )
    throw Error("Architecture reviewer transcript path is missing or unsafe.");
  const bytes = await readFile(reviewer.file);
  let header: { type?: string; id?: string };
  try {
    header = JSON.parse(bytes.toString("utf8").split("\n")[0] ?? "");
  } catch {
    throw Error("Architecture reviewer transcript header is malformed.");
  }
  if (header.type !== "session" || header.id !== reviewer.id)
    throw Error("Architecture reviewer transcript identity differs from its sealed session.");
  return bytes;
}

async function sourceDraft(job: JobStartResult, paths: readonly string[]) {
  const changes = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: job.worktreeRoot,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
  for (const entry of changes) {
    if (!["??", " M"].includes(entry.slice(0, 2)))
      throw Error("Architecture review rejects staged, deleted or renamed draft bytes.");
    const raw = entry.slice(3);
    const local = job.storyRelativePath ? raw.slice(job.storyRelativePath.length + 1) : raw;
    if (
      (job.storyRelativePath ? job.storyRelativePath + "/" + local : local) !== raw ||
      !authorizedArchitectureRecordPath(local) ||
      !paths.includes(local)
    )
      throw Error("Architecture review rejects unauthorized or newly introduced record: " + raw);
  }
  if (!changes.length) throw Error("Architecture review cannot approve an unchanged worktree.");
  const result: Record<string, string> = {};
  for (const path of paths) {
    if (!authorizedArchitectureRecordPath(path)) throw Error("Unauthorized Architecture review path.");
    const absolute = join(job.worktreeStoryRoot, path);
    if ((await realpath(absolute)) !== absolute || !(await lstat(absolute)).isFile())
      throw Error("Architecture draft source path is unsafe.");
    result[path] = await readFile(absolute, "utf8");
  }
  return result;
}

export async function verifyArchitectureDraftReviewPin(
  job: JobStartResult,
  snapshot: SkillSnapshot,
  plan: Plan,
  provider: string,
  model: string,
  paths: string[],
  writer: Writer,
  pin: ArchitectureDraftReviewPin,
  task = "",
  blueprint?: CausalBlueprint,
): Promise<void> {
  const cycleId = reviewCycleId(cycleScope(job, snapshot, plan, provider, model, paths, task, blueprint));
  if (
    pin.cycleId !== cycleId ||
    !Number.isSafeInteger(pin.round) ||
    pin.round < 0 ||
    !HASH.test(pin.receiptDigest)
  )
    throw Error("Architecture precommit review pin has wrong assignment or source lineage.");
  const admitted = JSON.parse(await readFile(admissionPath(job, cycleId), "utf8")) as AdmissionReceipt;
  if (
    !exact(admitted, ["schema", "cycleId", "writer", "reviewer"]) ||
    admitted.schema !== "noveltea-architecture-draft-admission/v1" ||
    admitted.cycleId !== cycleId ||
    !exact(admitted.writer, ["id", "file"]) ||
    admitted.writer.id !== writer.id ||
    admitted.writer.file !== writer.file ||
    !exact(admitted.reviewer, ["id", "file"])
  )
    throw Error("Architecture precommit review admission has wrong session or authorization.");
  assertReviewCycleSession(writer, admitted.reviewer);
  const current = await sourceDraft(job, paths);
  let prior = "";
  let reviewer: Writer | undefined;
  for (let i = 0; i <= pin.round; i++) {
    const receipt = JSON.parse(await readFile(roundPath(job, cycleId, i), "utf8")) as RoundReceipt;
    if (
      !exact(receipt, [
        "schema",
        "cycleId",
        "round",
        "previousDigest",
        "writer",
        "reviewer",
        "sources",
        "verdict",
        "transcriptBytes",
        "transcriptDigest",
      ]) ||
      receipt.schema !== "noveltea-architecture-draft-turn/v1" ||
      receipt.cycleId !== cycleId ||
      receipt.round !== i ||
      receipt.previousDigest !== (i ? prior : null) ||
      !exact(receipt.writer, ["id", "file"]) ||
      receipt.writer.id !== writer.id ||
      receipt.writer.file !== writer.file ||
      !exact(receipt.reviewer, ["id", "file"]) ||
      !Number.isSafeInteger(receipt.transcriptBytes) ||
      receipt.transcriptBytes <= 0 ||
      !HASH.test(receipt.transcriptDigest) ||
      Object.keys(receipt.sources).sort().join(",") !== [...paths].sort().join(",") ||
      Object.values(receipt.sources).some((v) => !HASH.test(v))
    )
      throw Error("Architecture precommit review receipt has invalid identity or source evidence.");
    assertReviewCycleSession(writer, receipt.reviewer, reviewer ?? admitted.reviewer);
    reviewer = receipt.reviewer;
    const bytes = await transcriptEvidence(job, receipt.reviewer);
    if (
      bytes.length < receipt.transcriptBytes ||
      sha(bytes.subarray(0, receipt.transcriptBytes).toString("utf8")) !== receipt.transcriptDigest
    )
      throw Error("Architecture reviewer transcript changed since the sealed verdict.");
    prior = sha(receipt);
    if (
      i === pin.round &&
      (receipt.verdict.status !== "pass" ||
        Object.keys(current).some((path) => sha(current[path]) !== receipt.sources[path]) ||
        prior !== pin.receiptDigest)
    )
      throw Error("Architecture draft approval differs from exact reviewed Story bytes.");
  }
}

/** One independent Pi reviewer per authorized precommit assignment. The caller
 * retains the ORIGINAL writer and this reviewer across corrections; an
 * interrupted run is reconciled by the existing job's writing-phase guard, not
 * by replaying this factory on a dirty worktree. */
export async function createArchitectureDraftReviewCycle(
  job: JobStartResult,
  snapshot: SkillSnapshot,
  plan: Plan,
  provider: string,
  model: string,
  paths: string[],
  writer: Writer,
  task = "",
  blueprint?: CausalBlueprint,
) {
  if (
    !paths.length ||
    paths.length > 32 ||
    new Set(paths).size !== paths.length ||
    paths.some((p) => !authorizedArchitectureRecordPath(p))
  )
    throw Error("Architecture draft reviewer lacks bounded authorized Arc/Milestone paths.");
  const scope = cycleScope(job, snapshot, plan, provider, model, paths, task, blueprint);
  const cycleId = reviewCycleId(scope);
  if (existsSync(admissionPath(job, cycleId)))
    throw Error(
      "An admitted Architecture precommit review cycle already exists; reconcile the original reviewer and draft, never start a fresh session.",
    );
  const project = await openStoryProject(job.worktreeStoryRoot);
  const { loader, settingsManager } = createProjectResourceLoader(project, undefined, true, {
    discovery: "explicit-only",
    novelteaSkills: snapshot.path,
    skillDirs: [],
    requiredSkills: ["nt-story-architecture", "nt-catalog"],
  });
  await loader.reload();
  const { skills, diagnostics } = loader.getSkills();
  if (
    diagnostics.some((d) => d.type === "error") ||
    !["nt-story-architecture", "nt-catalog"].every((name) =>
      skills.some((s) => s.name === name && s.filePath.startsWith(join(snapshot.path, "skills") + sep)),
    )
  )
    throw Error("Independent Architecture draft feedback lacks pinned method resources.");
  const runtime = await createJobModelRuntime();
  const step = "architecture:precommit-review:" + cycleId;
  const context = await preparePiContext(
    job,
    project,
    {
      group: step,
      step,
      paths: [],
      snapshot: snapshot.id,
      provider,
      model,
      directory: join(job.stateDir, "architecture-draft-review-sessions"),
      insideWriter: true,
    },
    runtime,
  );
  const safeTools = await selectSandboxPiTools(job, snapshot, skills, undefined, "read-only", "specialist");
  const { session } = await createAgentSession({
    cwd: project.root,
    modelRuntime: runtime,
    model: context.model,
    thinkingLevel: context.thinking,
    resourceLoader: loader,
    settingsManager,
    sessionManager: context.manager,
    customTools: safeTools ?? [],
    noTools: "all",
    tools: [...SANDBOX_READ_ONLY_TOOLS],
  });
  try {
    if (context.thinking && session.thinkingLevel !== context.thinking)
      throw Error("Independent Architecture draft reviewer changed its pinned thinking policy.");
    const reviewer = { id: session.sessionId, file: session.sessionManager.getSessionFile() ?? "" };
    assertReviewCycleSession(writer, reviewer);
    const admission: AdmissionReceipt = {
      schema: "noveltea-architecture-draft-admission/v1",
      cycleId,
      writer,
      reviewer,
    };
    await mkdir(cycleDirectory(job, cycleId), { recursive: true });
    await writeFile(admissionPath(job, cycleId), JSON.stringify(admission, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    const originalFoundation = await readFile(join(project.root, "creative-direction/foundation.md"), "utf8");
    const requirements = {
      foundation: originalFoundation,
      contract: JSON.stringify(plan.contract),
      task,
      blueprint: JSON.stringify(blueprint ?? null),
    };
    const history: ArchitectureDraftRound[] = [];
    let stalled = 0;
    let lastDigest: string | null = null;
    let lastPin: ArchitectureDraftReviewPin | undefined;

    const required = [
      ...paths.map((p) => join(project.root, p)),
      join(project.root, "creative-direction/foundation.md"),
      join(snapshot.path, "skills", "nt-story-architecture/SKILL.md"),
      join(snapshot.path, "skills", "nt-catalog/SKILL.md"),
    ];
    const complete = () => {
      const last = [...session.messages].reverse().find((m) => m.role === "assistant");
      return last?.role === "assistant" && !["aborted", "error"].includes(last.stopReason);
    };
    return {
      async review() {
        const round = history.length;
        if ((await openSkillSnapshot(snapshot.id)) !== snapshot.path)
          throw Error("Architecture review pinned skill methodology changed.");
        if (round) {
          const previousReceipt = JSON.parse(
            await readFile(roundPath(job, cycleId, round - 1), "utf8"),
          ) as RoundReceipt;
          const transcript = await transcriptEvidence(job, reviewer);
          if (
            sha(previousReceipt) !== lastDigest ||
            transcript.length < previousReceipt.transcriptBytes ||
            sha(transcript.subarray(0, previousReceipt.transcriptBytes).toString("utf8")) !==
              previousReceipt.transcriptDigest
          )
            throw Error("Architecture review session or saved verdict changed between correction rounds.");
        }
        const sources = await sourceDraft(job, paths);
        if (
          (await readFile(join(project.root, "creative-direction/foundation.md"), "utf8")) !==
            originalFoundation ||
          reviewCycleId(cycleScope(job, snapshot, plan, provider, model, paths, task, blueprint)) !== cycleId
        )
          throw Error("Architecture review source, scope or methodology changed mid-cycle.");
        const changes = Object.fromEntries(
          paths
            .filter((p) => history.length && history.at(-1)!.sources[p] !== sources[p])
            .map((p) => [
              p,
              {
                previousSha: sha(history.at(-1)!.sources[p]),
                currentSha: sha(sources[p]),
              },
            ]),
        );
        // Each round is a distinct budgeted model step. No budget overrun can
        // silently authorize a dirty draft or consume additional writer turns.
        await guardPiBudget(job, step + ":" + round, reviewer.file);
        const messageStart = session.messages.length;
        await promptStorySpecialist(
          session,
          (round
            ? "CONTINUING YOUR ORIGINAL INDEPENDENT READ-ONLY ARCHITECTURE REVIEW. " +
              "Your prior analysis remains available but is not source authority. Re-read all " +
              "current files and methodology; account for EACH earlier finding and check for " +
              "regressions/new material issues within THIS Architecture assignment.\n"
            : context.contextNote +
              "You are an INDEPENDENT READ-ONLY early reviewer of the uncommitted Arc/Milestone " +
              "draft, NOT the writer, controller or final postcommit reviewer.\n") +
            "Use read to inspect skill://nt-story-architecture/SKILL.md, skill://nt-catalog/SKILL.md, " +
            "creative-direction/foundation.md and EVERY changed authorized record. Never write, " +
            "edit, run shell, approve, read private inbox or broaden scope. Review source-grounded " +
            "causal links, independently inspectable planned evidence, meaningful lasting Choice " +
            "consequences, branching route duration and Production limits. Do not require Events, " +
            "Facts, Scenes, dialogue or implementation-level evidence already to exist. A " +
            "narrative-led Story need not invent Puzzles. A planned clue must name a plausible " +
            "source and establish how a player may test its contribution. Report ALL current " +
            "material Architecture issues (at most eight), no cosmetic preferences or " +
            "downstream Event/Composition demands. No finding grants additional writer scope. " +
            "This review is early ONLY; subsequent postcommit semantic review is mandatory.\n" +
            "Current contract: " +
            requirements.contract +
            "\n" +
            "Original task: " +
            task +
            "\n" +
            "Provisional reviewed Blueprint: " +
            requirements.blueprint +
            "\n" +
            (blueprint?.schema === "noveltea-causal-blueprint/v2"
              ? "This is a COMPACT, private, provisional Story Blueprint, not protected canon. " +
                "Check canonical Arc/Milestone prose against its major causal answer, dependencies, " +
                "decisions, compatible endings, Interaction profile, first-playthrough duration " +
                "and Production budget. A plausible future independent evidence source can " +
                "be specified here without having authored Events or complete local proof. " +
                "Do not demand scene, clue-custody or Puzzle inventories from the Blueprint; " +
                "do require Architecture to commit to inspectable planned evidence when needed.\n"
              : "") +
            "Authorized paths: " +
            JSON.stringify(paths) +
            "\n" +
            "Earlier exact verdicts and their source digests: " +
            JSON.stringify(
              history.map((h, i) => ({
                round: i,
                verdict: h.verdict,
                sourceDigests: Object.fromEntries(Object.entries(h.sources).map(([p, v]) => [p, sha(v)])),
              })),
            ) +
            "\n" +
            "Actual changed file SHA-256 since prior review: " +
            JSON.stringify(changes) +
            "\n" +
            "Return STRICT JSON with schema noveltea-architecture-draft-review/v2 and EXACT " +
            "keys schema,status,findings,prior. For revise include 1-8 findings with keys " +
            "path,reason,correction,requirement:{source,quote},evidence:{path,quote},origin. " +
            "Source must be foundation,contract,task or blueprint; quote must be an EXACT " +
            "8+ character substring of that source. Evidence quote must be EXACT text in " +
            "the current finding path. Origin initial (first round), continuing, introduced " +
            "or overlooked. For EVERY prior finding provide {round,findingIndex,status,reason," +
            "evidence:{path,quote}} with resolved/improved/persisting/regressed and a quote " +
            "from that finding's CURRENT path. If pass use findings:[] and mark ALL prior " +
            "findings resolved. Be clear about material source improvements, not text volume.\n",
        );
        const missing = () => {
          const reads = completedPinnedSkillReads(
            session.messages.slice(messageStart),
            project.root,
            snapshot.path,
          );
          return required.filter((p) => !reads.includes(p));
        };
        if (!complete())
          throw Error("Architecture draft reviewer interrupted; preserve writer and reviewer transcripts.");
        if (missing().length) {
          await promptStorySpecialist(
            session,
            "READ-ONLY SOURCE/METHOD CORRECTION: Your verdict " +
              "cannot count. Read EVERY missing required source with the read tool and return the " +
              "complete current JSON verdict again:\n" +
              missing()
                .map((p) =>
                  p.startsWith(join(snapshot.path, "skills") + sep)
                    ? "skill://" + p.slice((join(snapshot.path, "skills") + sep).length)
                    : p.slice(project.root.length + 1),
                )
                .join("\n"),
          );
        }
        const parse = () => {
          if (!complete() || missing().length)
            throw Error("Architecture reviewer omitted required current-round read results.");
          return parseArchitectureDraftReview(
            session.getLastAssistantText() ?? "",
            paths,
            sources,
            requirements,
            history,
          );
        };
        let verdict: ArchitectureDraftReview;
        try {
          verdict = parse();
        } catch (error) {
          await promptStorySpecialist(
            session,
            architectureDraftFormatCorrection(paths) +
              "\nController rejection: " +
              (error instanceof Error ? error.message : String(error)) +
              "\nHistory: " +
              JSON.stringify(history.map((h) => h.verdict)),
          );
          verdict = parse();
        }
        // A reviewer must not certify source bytes that changed while it read them.
        if (
          sha(await sourceDraft(job, paths)) !== sha(sources) ||
          (await readFile(join(project.root, "creative-direction/foundation.md"), "utf8")) !==
            originalFoundation ||
          reviewCycleId(cycleScope(job, snapshot, plan, provider, model, paths, task, blueprint)) !==
            cycleId ||
          (await openSkillSnapshot(snapshot.id)) !== snapshot.path
        )
          throw Error("Architecture source or methodology changed during its independent draft review.");
        const convergence = architectureDraftConvergence(verdict, sources, history, stalled);
        stalled = convergence.stalled;
        await context.completed(reviewer.file, reviewer.id);
        const transcript = await transcriptEvidence(job, reviewer);
        const receipt: RoundReceipt = {
          schema: "noveltea-architecture-draft-turn/v1",
          cycleId,
          round,
          previousDigest: lastDigest,
          writer,
          reviewer,
          sources: Object.fromEntries(Object.entries(sources).map(([p, v]) => [p, sha(v)])),
          verdict,
          transcriptBytes: transcript.length,
          transcriptDigest: sha(transcript.toString("utf8")),
        };
        const file = roundPath(job, cycleId, round);
        await mkdir(join(file, ".."), { recursive: true });
        await writeFile(file, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
        lastDigest = sha(receipt);
        history.push({ sources, verdict });
        lastPin = verdict.status === "pass" ? { cycleId, round, receiptDigest: lastDigest } : undefined;
        return { verdict, convergence, pin: lastPin };
      },
      dispose() {
        session.dispose();
      },
      get identity() {
        return { cycleId, writer, reviewer };
      },
    };
  } catch (error) {
    session.dispose();
    throw error;
  }
}
