import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { startStoryJob, type JobStartResult } from "./job.js";
import { withStoryJobLock } from "./job-lock.js";
import { assertPlanContinuity } from "./plan-continuity.js";
import { processAuthorUpdatesAtBoundary, processAuthorUpdatesAfterWork } from "./author-updates.js";
import { verifyJobPiSession } from "./job-session.js";
import { trustedHead } from "./revision.js";
import { loadSkillConfig } from "./skills.js";
import { createSkillSnapshot, openSkillSnapshot, type SkillSnapshot } from "./snapshot.js";
import { validateStoryJob, type ValidationResult } from "./validator.js";
import type { CompletionContract, Plan } from "./architecture.js";
import { authorCharacterWorld, type FoundationAssignment, type FoundationDomain, type SpecialistEvidence } from "./character-world-specialist.js";

type Phase = "pending" | "writing" | "authored" | "committed";
interface Unit {
  id: string;
  domain: FoundationDomain;
  phase: Phase;
  beforeHead?: string;
  paths?: string[];
  digest?: string;
  claimedPaths?: string[];
  piSessionFile?: string;
  piSessionId?: string;
  reviewedRecoveryDigest?: string;
  skillReads?: string[];
  commitSha?: string;
  outstanding?: Obligation[];
  laterObligations?: string[];
  architecturalConflicts?: string[];
  validation?: { status: "passed"; protectionBase: string; validatorSha256: string; records: string[] };
}
interface Receipt {
  version: 1;
  jobId: string;
  baseSha: string;
  branch?: string;
  worktreeRoot?: string;
  threadId?: string;
  architectureHead: string;
  /** Last verified HEAD before World specialist; may include noncanonical captures. */
  startHead?: string;
  planVersion: number;
  contractDigest: string;
  worker: "fixture" | "pi";
  provider: string;
  model: string;
  snapshot?: SkillSnapshot;
  units: [Unit, Unit];
}
interface ArchitectureReceipt {
  jobId: string;
  phase: string;
  expectedHead: string;
  plan?: Plan;
}
interface Obligation { id: string; path: string; field: string; requiredBy: string; code: string; message: string }
interface CatalogRecord { path: string; metadata: { type: string; id: string; status: string; arcs?: string[] } }
interface CatalogReport {
  records: CatalogRecord[];
  diagnostics: unknown[];
  outstanding: Obligation[];
  protection: { status: string; changes: unknown[]; warnings: unknown[] };
  readiness: { design: { stages: Record<string, { minimum: string }> } };
}
export interface CharacterWorldOptions {
  story: string;
  job: string;
  action: "run" | "inspect" | "reconcile";
  recoveryDigest?: string;
  skillsSource?: string;
  validatorSource?: string;
  fixture?: boolean;
  provider?: string;
  model?: string;
}
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function git(job: JobStartResult, ...args: string[]) {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_PREFIX"]) delete env[key];
  return execFileSync("git", args, { cwd: job.worktreeRoot, env, encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim();
}
const repoPath = (job: JobStartResult, p: string) => job.storyRelativePath ? job.storyRelativePath + "/" + p : p;
async function persist(file: string, value: unknown) {
  const temp = file + "." + randomUUID() + ".tmp";
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await rename(temp, file);
}
function assertHead(job: JobStartResult, head: string) {
  if (git(job, "rev-parse", "HEAD") !== head || git(job, "symbolic-ref", "--short", "HEAD") !== job.branch) {
    throw new Error("Character/World worktree HEAD or branch has changed; inspect before continuing.");
  }
}
function dirty(job: JobStartResult) {
  // Porcelain status begins with two meaningful columns, often a leading
  // space. Never use the trimmed git helper or the first column is lost.
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_PREFIX"]) delete env[key];
  return execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { cwd: job.worktreeRoot, env, encoding: "utf8" }).split("\0").filter(Boolean);
}
function reportOf(result: ValidationResult, base: string): CatalogReport {
  const r = result.report as unknown as CatalogReport | undefined;
  if (!r || !Array.isArray(r.records) || !Array.isArray(r.diagnostics) || !Array.isArray(r.outstanding) ||
      !r.protection || !Array.isArray(r.protection.changes) || !Array.isArray(r.protection.warnings) ||
      result.status !== "passed" || r.diagnostics.length || r.protection.status !== "checked" ||
      r.protection.changes.length || r.protection.warnings.length) {
    throw new Error("Canonical structural/protection check failed against verified work-item head " + base + ": " +
      JSON.stringify(result).slice(0, 7000));
  }
  return r;
}
function architectureTargets(plan: Plan, report: CatalogReport) {
  const selected = plan.items.find(item => item.id === "global-architecture");
  if (!selected || selected.status !== "verified" || !selected.verifiedSha ||
      !selected.targetIds.length || !plan.contract || !plan.version) {
    throw new Error("Architecture plan has no verified scoped Arc/Milestone cluster.");
  }
  const records = report.records.filter(r => selected.targetIds.includes(r.metadata.id) &&
    ["arc", "milestone"].includes(r.metadata.type) && r.metadata.status !== "superseded");
  if (records.length !== selected.targetIds.length || !records.some(r => r.metadata.type === "arc") ||
      !records.some(r => r.metadata.type === "milestone")) {
    throw new Error("Planned Arc/Milestone records no longer resolve in canonical catalog.");
  }
  return records;
}
function assignment(domain: FoundationDomain, plan: Plan, report: CatalogReport, authored: string[]): FoundationAssignment {
  const selected = architectureTargets(plan, report);
  const sources = report.records.filter(r => r.metadata.type === "creative-direction" && r.metadata.status !== "superseded");
  if (sources.length !== 1) throw new Error("Expected exactly one current Creative Direction.");
  const sourcePaths = [...new Set([...sources, ...selected].map(r => r.path).concat(authored))].sort();
  return { domain, arcIds: selected.filter(r => r.metadata.type === "arc").map(r => r.metadata.id),
    milestoneIds: selected.filter(r => r.metadata.type === "milestone").map(r => r.metadata.id),
    sourcePaths, scope: plan.contract,
    decisionAuthority: { existingAuthorChoices: "protected-no-retcon",
      newSpecialistChoices: "agent-delegated", editorialApproval: "not-granted" } };
}
/** Compare Arc records with their Character links removed, accepting both canonical
 * YAML array spellings without tolerating a change to any other field or prose. */
function normalizeArcCharacterLinks(text: string): { text: string; ids: string[] } {
  const lines = text.split("\n");
  if (lines[0] !== "---") throw new Error("Arc frontmatter is missing.");
  const end = lines.indexOf("---", 1);
  if (end < 0) throw new Error("Arc frontmatter is not closed.");
  const start = lines.findIndex((line, i) => i > 0 && i < end && /^characters:/.test(line));
  if (start < 0) throw new Error("Arc characters field is missing.");
  const inline = lines[start]!.match(/^characters:[ \t]*\[([^\]\n]*)\][ \t]*$/);
  let next = start + 1;
  let ids: string[];
  if (inline) {
    ids = inline[1]!.split(",").map(value => value.trim()).filter(Boolean);
  } else if (/^characters:[ \t]*$/.test(lines[start]!)) {
    ids = [];
    while (next < end && /^[ \t]+- /.test(lines[next]!)) {
      const match = lines[next]!.match(/^[ \t]+- (character\.[a-z][a-z0-9-]*)[ \t]*$/);
      if (!match) throw new Error("Arc Character list contains an invalid typed reference.");
      ids.push(match[1]!);
      next++;
    }
    if (!ids.length) throw new Error("Arc has an empty or malformed block Character list.");
  } else {
    throw new Error("Arc Character list has an unsupported YAML form.");
  }
  return {
    text: [...lines.slice(0, start), "characters: [audited]", ...lines.slice(next)].join("\n"),
    ids,
  };
}
async function auditPaths(job: JobStartResult, unit: Unit, assign: FoundationAssignment, declared: string[]) {
  const paths: string[] = [];
  for (const entry of dirty(job)) {
    if (!["??", " M"].includes(entry.slice(0, 2))) {
      throw new Error("Specialist staged, deleted or renamed files; refusing acceptance: " + entry);
    }
    const path = entry.slice(3);
    const prefix = job.storyRelativePath ? job.storyRelativePath + "/" : "";
    if (!path.startsWith(prefix)) throw new Error("Specialist modified file outside Story: " + path);
    const local = path.slice(prefix.length);
    const allowed = unit.domain === "world"
      ? /^(facts|world-entities)\/[a-z][a-z0-9-]*\.md$/.test(local)
      : /^(characters|relationships)\/[a-z][a-z0-9-]*\.md$/.test(local) ||
        (local.startsWith("arcs/") && assign.sourcePaths.includes(local));
    if (!allowed) throw new Error("Unauthorized specialist path: " + local);
    const file = join(job.worktreeStoryRoot, local);
    if (await realpath(file) !== file || !(await lstat(file)).isFile()) {
      throw new Error("Specialist output is not a safe regular Story file: " + local);
    }
    if (unit.domain === "character" && local.startsWith("arcs/")) {
      // The Character specialist can add edges to a planned Arc, not revise
      // its creative content. Compare against HEAD, not against its own claim.
      const oldText = git(job, "show", "HEAD:" + repoPath(job, local));
      const newText = await readFile(file, "utf8");
      const previous = normalizeArcCharacterLinks(oldText);
      const current = normalizeArcCharacterLinks(newText);
      if (previous.text.trimEnd() !== current.text.trimEnd()) {
        throw new Error("Arc cross-domain edit changed more than its characters array: " + local);
      }
      if (!previous.ids.every(id => current.ids.includes(id)) ||
          current.ids.some(id => !/^character\.[a-z][a-z0-9-]*$/.test(id)) ||
          new Set(current.ids).size !== current.ids.length) {
        throw new Error("Arc link edit removes or invents invalid Character IDs: " + local);
      }
    }
    paths.push(local);
  }
  paths.sort();
  if (!paths.length || !Array.isArray(declared) || declared.some(p => typeof p !== "string") ||
      JSON.stringify([...new Set(declared)].sort()) !== JSON.stringify(paths)) {
    throw new Error("Specialist claimed modifiedRecords differ from actual Git diff: declared " +
      JSON.stringify(declared) + ", actual " + JSON.stringify(paths));
  }
  if (unit.domain === "world" && (!paths.some(p => p.startsWith("facts/")) ||
      !paths.some(p => p.startsWith("world-entities/")))) {
    throw new Error("Worldbuilding must deliver meaningful objective Facts and World Entities.");
  }
  if (unit.domain === "character" && (!paths.some(p => p.startsWith("characters/")) ||
      !paths.some(p => p.startsWith("relationships/")))) {
    throw new Error("Character specialist must deliver Characters and a consequential Relationship.");
  }
  return paths;
}
function verifyCommit(job: JobStartResult, unit: Unit, before: string, commit: string) {
  if (!unit.digest || !unit.paths || git(job, "rev-parse", commit + "^") !== before) {
    throw new Error("Foundation commit has an unexpected parent or missing audit inventory.");
  }
  const message = git(job, "log", "-1", "--format=%B", commit);
  if (!message.split("\n").includes("NovelTea-Job: " + job.jobId) ||
      !message.split("\n").includes("NovelTea-Work-Item: " + unit.id) ||
      !message.split("\n").includes("NovelTea-Foundations: " + unit.digest) ||
      (unit.reviewedRecoveryDigest && !message.split("\n").includes("NovelTea-Reviewed-Recovery: " + unit.reviewedRecoveryDigest))) {
    throw new Error("Foundation commit provenance does not match the assigned unit.");
  }
  const changed = git(job, "diff-tree", "--no-commit-id", "--name-only", "-r", commit)
    .split("\n").filter(Boolean).sort();
  if (JSON.stringify(changed) !== JSON.stringify(unit.paths.map(p => repoPath(job, p)).sort())) {
    throw new Error("Foundation commit tree does not match its independently audited file inventory.");
  }
}
async function fileDigest(job: JobStartResult, paths: string[]) {
  return digest(JSON.stringify(await Promise.all(paths.map(async p =>
    [p, digest(await readFile(join(job.worktreeStoryRoot, p)))]))));
}
async function checkOutput(job: JobStartResult, report: CatalogReport, unit: Unit, assign: FoundationAssignment) {
  const current = report.records.filter(r => r.metadata.status !== "superseded");
  if (unit.paths?.some(p => !current.some(r => r.path === p))) {
    throw new Error("Specialist wrote files the canonical catalog did not recognize.");
  }
  if (unit.domain === "world") {
    if (!unit.paths?.some(p => current.some(r => r.path === p && r.metadata.type === "fact")) ||
        !unit.paths.some(p => current.some(r => r.path === p && r.metadata.type === "world-entity"))) {
      throw new Error("World specialist did not deliver valid Facts and World Entities.");
    }
  } else {
    const characters = current.filter(r => r.metadata.type === "character");
    const facts = current.filter(r => r.metadata.type === "fact");
    const relationships = current.filter(r => r.metadata.type === "relationship");
    if (characters.length < 2 || !facts.length || !relationships.length ||
        !unit.paths?.some(p => current.some(r => r.path === p && r.metadata.type === "character")) ||
        !unit.paths.some(p => current.some(r => r.path === p && r.metadata.type === "relationship"))) {
      throw new Error("Foundation cluster requires at least two Characters, a Fact and a Relationship.");
    }
    if (unit.paths.some(p => p.startsWith("arcs/") && !assign.sourcePaths.includes(p))) {
      throw new Error("Character links reference an Arc outside the planned cluster.");
    }
    const authoredCharacters = unit.paths.filter(p => current.some(r => r.path === p && r.metadata.type === "character"));
    const knowledge = await Promise.all(authoredCharacters.map(p => readFile(join(job.worktreeStoryRoot, p), "utf8")));
    if (!knowledge.some(text => /initial_knowledge:\s*\n\s*- fact: fact\.[a-z][a-z0-9-]*/.test(text))) {
      throw new Error("Character foundations must set at least one explicit, typed initial Fact-knowledge baseline.");
    }
  }
}
async function publishHead(job: JobStartResult, previous: string, commit: string, workItemId: string) {
  const file = join(dirname(job.worktreeRoot), "revisions", "verified-head.json");
  await mkdir(dirname(file), { recursive: true });
  if (existsSync(file)) {
    const saved = JSON.parse(await readFile(file, "utf8")) as { version?: number; jobId?: string; headSha?: string };
    if (saved.version !== 1 || saved.jobId !== job.jobId ||
        (saved.headSha !== previous && saved.headSha !== commit)) {
      throw new Error("Verified-head marker differs from the committed specialist chain.");
    }
    if (saved.headSha === commit) return;
  }
  await persist(file, { version: 1, jobId: job.jobId, headSha: commit, workItemId });
}
async function fixtureAuthor(job: JobStartResult, unit: Unit, assign: FoundationAssignment): Promise<SpecialistEvidence> {
  const write = async (folder: string, slug: string, type: string, fields: string, body: string) => {
    const file = join(job.worktreeStoryRoot, folder, slug + ".md");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `---\nschema: '0.1'\ntype: ${type}\nid: ${type}.${slug}\ntitle: "${slug}"\nstatus: draft\ndecisions: []\n${fields}\n---\n\n${body}\n`, { flag: "wx" });
    return folder + "/" + slug + ".md";
  };
  let paths: string[];
  if (unit.domain === "world") {
    paths = [
      await write("world-entities", "archive", "world-entity",
        'description: "A public archive whose restricted ledger records all evidence transfers"',
        "The archive is accessible to both witnesses, but the sealed ledger is available only to its custodian. That restriction creates the need for trust rather than a new on-screen Room."),
      await write("facts", "evidence-concealed", "fact", "initial: true",
        "At the start, Neri concealed a ledger entry that would implicate a trusted official. The truth does not depend on whether Ada has learned it."),
    ];
  } else {
    paths = [
      await write("characters", "ada", "character",
        'motivation: "Learn why the witness disappeared without condemning an innocent friend"\ninitial_knowledge:\n  - fact: fact.evidence-concealed\n    value: disbelieves',
        "Ada is an investigator whose practiced skepticism conceals a fear of losing Neri. Her questions are precise, yet she avoids accusing a friend without proof. A later disclosure may change her belief; no initial knowledge is retroactively adjusted."),
      await write("characters", "neri", "character",
        'motivation: "Protect a vulnerable witness while deciding whether to confess the concealment"\ninitial_knowledge:\n  - fact: fact.evidence-concealed\n    value: knows',
        "Neri maintains the archive ledger and knows which entry was hidden. Their restrained candor conflicts with Ada's demand for answers. Whether Neri shares the proof remains a branch-dependent future Event."),
      await write("relationships", "ada-neri", "relationship",
        "characters: [character.ada, character.neri]\ninitial: wary",
        "Ada and Neri were once collaborators, but the missing witness made their mutual trust fragile. Concealment threatens the bond; a confession or confrontation might alter it only through later Events."),
    ];
    const arc = assign.sourcePaths.find(p => p.startsWith("arcs/"));
    if (arc) {
      const file = join(job.worktreeStoryRoot, arc);
      const old = await readFile(file, "utf8");
      const before = old.match(/^characters:\s*\[([^\]\n]*)\]/m);
      if (!before) throw new Error("Fixture Arc has no characters list to link.");
      const prior = before[1]!.split(",").map(v => v.trim()).filter(Boolean);
      const merged = [...new Set([...prior, "character.ada", "character.neri"])];
      const block = ["block-links", "arc-retcon"].includes(process.env.NT_FOUNDATIONS_FIXTURE_CASE ?? "");
      const linked = old.replace(/^characters:\s*\[[^\]\n]*\]/m,
        block ? "characters:\n" + merged.map(id => "  - " + id).join("\n") : "characters: [" + merged.join(", ") + "]");
      await writeFile(file, process.env.NT_FOUNDATIONS_FIXTURE_CASE === "arc-retcon"
        ? linked.replace("The inquiry puts a friendship under pressure.", "The inquiry eliminates the player's loyalty choice.")
        : linked);
      paths.push(arc);
    }
  }
  if (process.env.NT_FOUNDATIONS_FIXTURE_CASE === "mismatch") paths.push("facts/not-authored.md");
  if (process.env.NT_FOUNDATIONS_FIXTURE_CASE === "retcon") {
    const foundation = assign.sourcePaths.find(p => p.startsWith("creative-direction/"))!;
    const target = join(job.worktreeStoryRoot, foundation);
    const original = await readFile(target, "utf8");
    await writeFile(target, original.replace(
      'statement: "Ada must be allowed to defend Neri"',
      'statement: "Ada must never defend Neri"'));
  }
  if (process.env.NT_FOUNDATIONS_FIXTURE_CASE === "dangling" && unit.domain === "character") {
    const target = join(job.worktreeStoryRoot, "characters/ada.md");
    await writeFile(target, (await readFile(target, "utf8")).replace("fact.evidence-concealed", "fact.nonexistent"));
  }
  return { claimedPaths: paths, skillReads: [], architecturalConflicts: [],
    laterObligations: unit.domain === "world"
      ? ["A later Event must establish who learns the concealed evidence; objective truth remains initially true."]
      : ["Bind disclosure and any Relationship trust change to actual Event branches, not the initial state."] };
}
function output(job: JobStartResult, receipt: Receipt) {
  return { status: receipt.units.every(unit => unit.phase === "committed") ? "foundations-committed" : "in-progress",
    jobId: job.jobId, branch: job.branch, worktreeStoryRoot: job.worktreeStoryRoot,
    headSha: receipt.units[1].commitSha ?? receipt.units[0].commitSha ?? receipt.startHead ?? receipt.architectureHead,
    architectureHead: receipt.architectureHead, planVersion: receipt.planVersion,
    items: receipt.units.map(unit => ({ ...unit, dependencies: unit.domain === "world" ? ["global-architecture"] : ["world-foundations"],
      specialist: unit.domain === "world" ? "nt-worldbuilding" : "nt-character-development" })),
    completionEvidence: { canonicalStructure: receipt.units.every(unit => unit.phase === "committed"),
      branchKnowledgeTransitions: "deferred-to-event-design", narrativeReview: "unverified", fullStory: false },
    skillSnapshot: receipt.snapshot?.id };
}

type Recovery = {
  status: "ready" | "recoverable-commit" | "blocked";
  actualHead: string;
  changes: string[];
  reason?: string;
  candidate?: { unit: string; paths: string[]; digest: string };
};

/** Inspect actual Git and the original Pi transcript before any resumed writer. */
async function inspectRecovery(job: JobStartResult, receipt: Receipt): Promise<Recovery> {
  const actualHead = git(job, "rev-parse", "HEAD");
  const changes = dirty(job);
  const blocked = (reason: string): Recovery => ({ status: "blocked", actualHead, changes, reason });
  try {
    if (git(job, "symbolic-ref", "--short", "HEAD") !== job.branch) {
      return blocked("Character/World branch drift; inspect Git before resuming.");
    }
    const index = receipt.units.findIndex(unit => unit.phase !== "committed");
    if (index < 0) {
      const last = receipt.units[1]!.commitSha;
      if (!last || changes.length) return blocked("Committed foundations have unexpected worktree or staged changes.");
      if (actualHead !== last) {
        if (actualHead !== await trustedHead(job)) return blocked("Foundations HEAD is not a verified successor.");
        git(job, "merge-base", "--is-ancestor", last, actualHead);
      }
      return { status: "ready", actualHead, changes };
    }
    const unit = receipt.units[index]!;
    const before = index ? receipt.units[index - 1]!.commitSha : (receipt.startHead ?? receipt.architectureHead);
    if (!before || unit.beforeHead && unit.beforeHead !== before) return blocked("Saved work-item parent differs from the verified chain.");
    if (index && receipt.units[0]!.commitSha) verifyCommit(job, receipt.units[0]!, receipt.startHead ?? receipt.architectureHead, before);
    if (unit.phase === "writing") {
      if (receipt.worker === "pi") await verifyJobPiSession(job, unit.domain, unit.piSessionFile, unit.piSessionId);
      const result = blocked("Interrupted specialist writing (" + unit.id + "): review preserved files and use foundations reconcile with the exact candidate digest; no replay.");
      if (actualHead === before && changes.every(entry => ["??", " M"].includes(entry.slice(0, 2)))) {
        const prefix = job.storyRelativePath ? job.storyRelativePath + "/" : "";
        const paths = changes.map(entry => entry.slice(3));
        if (paths.length && paths.every(p => p.startsWith(prefix))) {
          const local = paths.map(p => p.slice(prefix.length)).sort();
          try { result.candidate = { unit: unit.id, paths: local, digest: await fileDigest(job, local) }; }
          catch { /* Unsafe or missing files have no candidate. */ }
        }
      }
      return result;
    }
    if (unit.phase === "pending") {
      return actualHead === before && !changes.length
        ? { status: "ready", actualHead, changes }
        : blocked("Unexpected Git history, staged data or worktree changes before specialist handoff.");
    }
    if (!unit.paths?.length || !unit.digest) return blocked("Authored foundation inventory is missing or corrupt.");
    if (receipt.worker === "pi") await verifyJobPiSession(job, unit.domain, unit.piSessionFile, unit.piSessionId);
    if (actualHead === before) {
      const observed = changes.map(entry => entry.slice(3));
      const expected = unit.paths.map(p => repoPath(job, p)).sort();
      if (changes.some(entry => !["??", " M"].includes(entry.slice(0, 2))) ||
          JSON.stringify(observed.sort()) !== JSON.stringify(expected) ||
          await fileDigest(job, unit.paths) !== unit.digest) {
        return blocked("Authored foundation files differ from recorded paths or bytes; preserve for review.");
      }
      return { status: "ready", actualHead, changes };
    }
    if (changes.length) return blocked("Staged or uncommitted changes accompany a completed specialist commit.");
    if (git(job, "rev-parse", "HEAD^") !== before) return blocked("Unexpected commit parent after specialist crash.");
    verifyCommit(job, unit, before, actualHead);
    if (await fileDigest(job, unit.paths) !== unit.digest) return blocked("Committed specialist bytes differ from recorded digest.");
    return { status: "recoverable-commit", actualHead, changes };
  } catch (error) {
    return blocked("Character/World recovery cannot be trusted: " + (error instanceof Error ? error.message : String(error)));
  }
}

export async function runCharacterWorldJob(input: CharacterWorldOptions) {
  const job = await startStoryJob({ story: input.story, job: input.job }, false);
  const parent = dirname(job.worktreeRoot);
  const file = join(parent, "character-world.json");
  if (input.action === "inspect" && !existsSync(file)) throw new Error("Start character-world run before inspect.");
  return withStoryJobLock(job, "character-world", async () => {
    if (input.action === "run" && !existsSync(file)) await processAuthorUpdatesAtBoundary(job);
    if (!existsSync(join(parent, "architecture.json"))) {
      throw new Error("Character/World foundations require a verified committed architecture cluster.");
    }
    const arch = JSON.parse(await readFile(join(parent, "architecture.json"), "utf8")) as ArchitectureReceipt;
    if (arch.jobId !== job.jobId || arch.phase !== "committed" || !arch.plan) {
      throw new Error("Character/World foundations require a verified committed architecture cluster.");
    }
    const plan = arch.plan;
    const contractDigest = digest(JSON.stringify(plan.contract));
    let receipt: Receipt;
    if (existsSync(file)) {
      receipt = JSON.parse(await readFile(file, "utf8")) as Receipt;
      if (receipt.version !== 1 || receipt.jobId !== job.jobId || receipt.baseSha !== job.baseSha ||
          (receipt.branch !== undefined && receipt.branch !== job.branch) ||
          (receipt.worktreeRoot !== undefined && receipt.worktreeRoot !== job.worktreeRoot) ||
          (receipt.threadId !== undefined && receipt.threadId !== job.threadId) ||
          receipt.architectureHead !== arch.expectedHead || receipt.units?.length !== 2 ||
          receipt.units[0]?.domain !== "world" || receipt.units[1]?.domain !== "character") {
        throw new Error("Foundation receipt differs from the authorized architecture plan; reconcile explicitly.");
      }
      assertPlanContinuity(job, arch, "foundations", receipt.planVersion, receipt.contractDigest, true);
    } else {
      if (input.action !== "run") throw new Error("No foundations receipt to inspect.");
      const startHead = await trustedHead(job);
      if (dirty(job).length) throw new Error("Foundations require a clean verified Story HEAD.");
      git(job, "merge-base", "--is-ancestor", arch.expectedHead, startHead);
      receipt = { version: 1, jobId: job.jobId, baseSha: job.baseSha, startHead,
        branch: job.branch, worktreeRoot: job.worktreeRoot, threadId: job.threadId,
        architectureHead: arch.expectedHead, planVersion: plan.version, contractDigest,
        worker: input.fixture ? "fixture" : "pi",
        provider: input.provider ?? "openai", model: input.model ?? "gpt-6-luna",
        units: [{ id: "world-foundations", domain: "world", phase: "pending" },
          { id: "character-foundations", domain: "character", phase: "pending" }] };
      await persist(file, receipt);
    }
    const recovery = await inspectRecovery(job, receipt);
    if (input.action === "inspect") {
      const result = output(job, receipt);
      return { ...result, status: recovery.status === "blocked" ? "blocked" : result.status, recovery };
    }
    if (input.action === "run" && recovery.status === "blocked") {
      throw new Error(recovery.reason ?? "Foundations recovery blocked.");
    }
    if (Boolean(input.fixture) !== (receipt.worker === "fixture") ||
        (input.provider && input.provider !== receipt.provider) ||
        (input.model && input.model !== receipt.model)) {
      throw new Error("Foundations specialist worker configuration differs from the saved assignment.");
    }
    if (input.action === "run" && receipt.units.every(unit => unit.phase === "committed")) {
      const [world, character] = receipt.units;
      verifyCommit(job, world, receipt.startHead ?? receipt.architectureHead, world.commitSha!);
      verifyCommit(job, character, world.commitSha!, character.commitSha!);
      // A later independently verified inbox capture is not a reason to replay
      // specialists. Restore a missing final verified-head publication only if
      // the Character commit itself remains the current worktree HEAD.
      if (recovery.actualHead === character.commitSha) {
        await publishHead(job, world.commitSha!, character.commitSha!, character.id);
      }
      return output(job, receipt);
    }
    const config = input.skillsSource
      ? { discovery: "explicit-only" as const, novelteaSkills: input.skillsSource, skillDirs: [], requiredSkills: [] }
      : receipt.snapshot
        ? { discovery: "explicit-only" as const, novelteaSkills: undefined, skillDirs: [], requiredSkills: [] }
        : await loadSkillConfig(undefined, false);
    const validatorSource = input.validatorSource ?? input.skillsSource ?? config.novelteaSkills;
    if (!receipt.snapshot) {
      const snapshot = await createSkillSnapshot({ ...config,
        novelteaSkills: input.skillsSource ?? config.novelteaSkills, discovery: "explicit-only",
        requiredSkills: ["nt-worldbuilding", "nt-character-development", "nt-catalog"] });
      if (!snapshot) throw new Error("Foundations require a pinned NovelTea skills checkout.");
      receipt.snapshot = snapshot;
      await persist(file, receipt);
    }
    await openSkillSnapshot(receipt.snapshot.id);
    const validate = async (head: string) => validateStoryJob(
      await startStoryJob({ story: input.story, job: input.job }, false),
      validatorSource, { ...job, baseSha: head });
    if (input.action === "reconcile") {
      const index = receipt.units.findIndex(unit => unit.phase !== "committed");
      const unit = receipt.units[index];
      if (!unit || unit.phase !== "writing" || !input.recoveryDigest ||
          !/^[a-f0-9]{64}$/.test(input.recoveryDigest) ||
          !recovery.candidate || recovery.candidate.unit !== unit.id ||
          recovery.candidate.digest !== input.recoveryDigest) {
        throw new Error("Foundations reconciliation requires an interrupted writer and exact inspected --digest; Git, Pi or file inventory is unsafe.");
      }
      const before = index ? receipt.units[index - 1]!.commitSha : (receipt.startHead ?? receipt.architectureHead);
      if (!before) throw new Error("Missing parent work-item commit.");
      assertHead(job, before);
      const preReport = reportOf(await validate(before), before);
      const assign = assignment(unit.domain, plan, preReport,
        receipt.units.slice(0, index).flatMap(item => item.paths ?? []).filter(p => !p.startsWith("arcs/")));
      const paths = await auditPaths(job, unit, assign, recovery.candidate.paths);
      const reviewed = await fileDigest(job, paths);
      if (reviewed !== input.recoveryDigest) throw new Error("Foundation review digest no longer matches actual file bytes.");
      unit.claimedPaths = paths;
      unit.paths = paths;
      unit.digest = reviewed;
      unit.reviewedRecoveryDigest = reviewed;
      unit.phase = "authored";
      await persist(file, receipt);
      return { ...output(job, receipt), status: "authored", recovery: await inspectRecovery(job, receipt) };
    }
    const Channels = Annotation.Root({ receipt: Annotation<Receipt>() });
    const graph = new StateGraph(Channels)
      .addNode("world_foundations", async ({ receipt }) => { await executeUnit(receipt.units[0]!, receipt); return { receipt }; })
      .addNode("character_foundations", async ({ receipt }) => { await executeUnit(receipt.units[1]!, receipt); return { receipt }; })
      .addEdge(START, "world_foundations").addEdge("world_foundations", "character_foundations")
      .addEdge("character_foundations", END).compile();
    async function executeUnit(unit: Unit, state: Receipt) {
      const index = state.units.indexOf(unit);
      const prior = index ? state.units[index - 1]!.commitSha : (state.startHead ?? state.architectureHead);
      if (!prior) throw new Error("Character specialist cannot run before the Worldbuilding work-item commit.");
      if (unit.beforeHead && unit.beforeHead !== prior) throw new Error("Work-unit head changed since assignment.");
      const before = prior;
      if (unit.phase === "committed") {
        if (!unit.commitSha || !unit.digest || !unit.paths) {
          throw new Error("Saved foundation commit provenance cannot be verified.");
        }
        verifyCommit(job, unit, before, unit.commitSha);
        const current = git(job, "rev-parse", "HEAD");
        if (index === state.units.length - 1 || state.units[index + 1]!.phase === "pending") {
          assertHead(job, unit.commitSha);
          if (dirty(job).length) throw new Error("Unexpected edits after specialist commit.");
        } else if (current !== unit.commitSha) {
          const next = state.units[index + 1]!;
          if (next.phase === "authored") {
            verifyCommit(job, next, unit.commitSha, current);
            if (dirty(job).length || await fileDigest(job, next.paths!) !== next.digest) {
              throw new Error("Unverified next specialist commit or uncommitted changes.");
            }
          } else if (current !== next.commitSha) {
            throw new Error("Foundation Git chain changed unexpectedly.");
          }
        }
        if (current === unit.commitSha) await publishHead(job, before, unit.commitSha, unit.id);
        return;
      }
      if (unit.phase === "writing") {
        throw new Error("Interrupted specialist writing; inspect preserved files and Pi session, then reconcile exact bytes. Never replay the writer.");
      }
      const currentHead = git(job, "rev-parse", "HEAD");
      const recovering = unit.phase === "authored" && currentHead !== before;
      if (recovering) {
        if (recovery.status !== "recoverable-commit") throw new Error("Unrecognized interrupted foundation commit; reconcile manually.");
        verifyCommit(job, unit, before, currentHead);
      }
      if (!recovering) {
        assertHead(job, before);
        if (unit.phase === "pending" && dirty(job).length) throw new Error("Specialist requires a clean work-item boundary.");
      }
      const preReport = reportOf(await validate(before), before);
      const assign = assignment(unit.domain, plan, preReport,
        state.units.slice(0, index).flatMap(item => item.paths ?? []).filter(p => !p.startsWith("arcs/")));
      if (unit.phase === "pending") {
        unit.beforeHead = before;
        unit.phase = "writing";
        await persist(file, state);
        let evidence: SpecialistEvidence;
        if (state.worker === "fixture") evidence = await fixtureAuthor(job, unit, assign);
        else evidence = await authorCharacterWorld(job, state.snapshot!, assign, state.provider, state.model,
          async (id, session) => { unit.piSessionId = id; unit.piSessionFile = session; await persist(file, state); },
          async proposed => {
            // Inspect the actual working tree BEFORE showing validator diagnostics
            // to Pi. Unexpected paths, staging or forged manifests fail closed.
            const paths = await auditPaths(job, unit, assign, proposed.claimedPaths);
            assertHead(job, before);
            if (proposed.architecturalConflicts?.length) {
              throw new Error("Specialist reported architectural conflicts: " + JSON.stringify(proposed.architecturalConflicts));
            }
            const draft = await validate(before);
            const report = draft.report as unknown as CatalogReport | undefined;
            if (!report?.protection || report.protection.status !== "checked" ||
                report.protection.changes.length || report.protection.warnings.length) {
              throw new Error("Draft contains unverified or protected changes; no automated specialist repair allowed.");
            }
            if (report.diagnostics.length) {
              return report.diagnostics.slice(0, 16).map(d => JSON.stringify(d));
            }
            const candidate: Unit = { ...unit, paths };
            if (draft.status === "passed") {
              await checkOutput(job, report, candidate, assign);
              return [];
            }
            throw new Error("Canonical validator rejected the draft without actionable structural diagnostics.");
          });
        unit.claimedPaths = evidence.claimedPaths;
        unit.architecturalConflicts = evidence.architecturalConflicts;
        unit.laterObligations = evidence.laterObligations;
        unit.skillReads = evidence.skillReads;
        unit.piSessionFile = evidence.piSessionFile ?? unit.piSessionFile;
        unit.piSessionId = evidence.piSessionId ?? unit.piSessionId;
        unit.paths = await auditPaths(job, unit, assign, evidence.claimedPaths);
        unit.digest = await fileDigest(job, unit.paths);
        unit.phase = "authored";
        await persist(file, state);
        if (unit.architecturalConflicts?.length) {
          throw new Error("Specialist reported unresolved architectural conflicts: " + JSON.stringify(unit.architecturalConflicts));
        }
      }
      if (unit.architecturalConflicts?.length) {
        throw new Error("Specialist has unresolved architectural conflicts: " + JSON.stringify(unit.architecturalConflicts));
      }
      if (!unit.paths || !unit.digest ||
          await fileDigest(job, unit.paths) !== unit.digest) {
        throw new Error("Specialist bytes differ from persisted inventory; preserve for inspection.");
      }
      const report = reportOf(await validate(before), before);
      await checkOutput(job, report, unit, assign);
      if (!recovering) {
        const paths = await auditPaths(job, unit, assign, unit.claimedPaths ?? []);
        if (JSON.stringify(paths) !== JSON.stringify(unit.paths)) throw new Error("Specialist Git diff changed after audit.");
        git(job, "add", "--", ...paths.map(p => repoPath(job, p)));
        git(job, "-c", "user.name=NovelTea Generator",
          "-c", "user.email=noveltea-gen@users.noreply.github.com", "commit", "-m",
          `Develop ${unit.domain} foundations [${job.jobId}]\n\nNovelTea-Job: ${job.jobId}\nNovelTea-Work-Item: ${unit.id}\nNovelTea-Plan-Version: ${state.planVersion}\nNovelTea-Foundations: ${unit.digest}` +
          (unit.reviewedRecoveryDigest ? `\nNovelTea-Reviewed-Recovery: ${unit.reviewedRecoveryDigest}` : ""));
      }
      if (dirty(job).length) throw new Error("Specialist commit left uncommitted work.");
      const sha = git(job, "rev-parse", "HEAD");
      verifyCommit(job, unit, before, sha);
      unit.outstanding = report.outstanding.filter(o => report.records.some(r => r.path === o.path &&
        (unit.paths!.includes(r.path) || assign.arcIds.includes(r.metadata.id))));
      unit.validation = { status: "passed", protectionBase: before,
        validatorSha256: (await startStoryJob({ story: input.story, job: input.job }, false)).validatorSha256!,
        records: unit.paths };
      unit.commitSha = sha; unit.phase = "committed";
      await persist(file, state);
      await publishHead(job, before, sha, unit.id);
    }
    const result = await graph.invoke({ receipt });
    const authorUpdates = await processAuthorUpdatesAfterWork(job);
    const { scheduleIdeasAtBoundary } = await import("./idea-placement.js");
    await scheduleIdeasAtBoundary(job, "character-world");
    return { ...output(job, result.receipt), authorUpdates };
  });
}
