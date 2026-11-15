import { execFileSync } from "./git-read-cache.js";
import { commitOrigin, readRecoveryFork } from "./recovery-fork-state.js";
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
import { recordSpecialistChoice, inspectSpecialistChoice, verifySpecialistChoice, claimSpecialistChoice,
  completeSpecialistChoice, SpecialistChoiceRequiredError } from "./specialist-choice.js";
import { preflightPiAssignment } from "./job-pi-policy.js";
import { readTurnEvidence } from "./turn-plan-evidence.js";
import { steeringForAssignment } from "./steering-amendments.js";
import { assertNativeReviewDependencies, readRepairCommitProof } from "./checkpoint-assurance.js";
import { DEFAULT_CREATIVE_POLICY } from "./creative-policy.js";
import { trustedHead } from "./revision.js";
import { finalizeRecoveryCheckpoint, inspectRecoveryCheckpoints } from "./recovery-checkpoints.js";
import { loadSkillConfig } from "./skills.js";
import { createSkillSnapshot, openSkillSnapshot, type SkillSnapshot } from "./snapshot.js";
import { validateStoryJob, type ValidationResult } from "./validator.js";
import type { CompletionContract, Plan } from "./architecture.js";
import { authorCharacterWorld, characterInitialKnowledgeCorrection,
  type FoundationAssignment, type FoundationDomain, type SpecialistEvidence,
  type SpecialistChoiceProposal } from "./character-world-specialist.js";

type Phase = "pending" | "writing" | "awaiting-author" | "authored" | "committed";
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
  authorChoiceId?: string;
  assignment?: FoundationAssignment;
  reviewedRecoveryDigest?: string;
  skillReads?: string[];
  commitSha?: string;
  outstanding?: Obligation[];
  laterObligations?: string[];
  architecturalConflicts?: string[];
  validation?: { status: "passed"; protectionBase: string; validatorVersion: string; records: string[] };
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
  steeringDigest?: string;
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
interface CatalogRecord { path: string; metadata: { type: string; id: string; status: string; arcs?: string[];
  characters?: string[]; initial?: boolean; initial_knowledge?: Array<{ fact: string }> } }
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
  task?: string;
  provider?: string;
  model?: string;
  turnPlanDigest?: string;
  /** Controller-reviewed source-bound direction for pending work only. */
  steering?: string;
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
export function deriveFoundationAssignment(domain: FoundationDomain, plan: Plan, report: CatalogReport, authored: string[]): FoundationAssignment {
  const selected = architectureTargets(plan, report);
  const sources = report.records.filter(r => r.metadata.type === "creative-direction" && r.metadata.status !== "superseded");
  if (sources.length !== 1) throw new Error("Expected exactly one current Creative Direction.");
  // Source context must contain canonical Character records already attached
  // to the planned Arc or targeted by the plan. Otherwise the specialist can
  // accidentally create the same typed ID under a second filename.
  const existingIds = new Set([
    ...selected.flatMap(r => r.metadata.type === "arc" ? r.metadata.characters ?? [] : []),
    ...plan.items.flatMap(item => item.targetIds.filter(id => id.startsWith("character."))),
  ]);
  const existingCharacters = domain === "character"
    ? report.records.filter(r => r.metadata.type === "character" &&
      r.metadata.status !== "superseded" && existingIds.has(r.metadata.id)) : [];
  if (existingCharacters.length > 64)
    throw new Error("Character context exceeds the bounded existing-record inventory.");
  // Existing foundations are context, not records that must be regenerated.
  // Include the relevant typed records so Pi can revise one part of an
  // established cluster without inventing duplicates in the other part.
  const existingFoundations = domain === "world"
    ? report.records.filter(r => r.metadata.status !== "superseded" &&
        ["fact", "world-entity"].includes(r.metadata.type))
    : report.records.filter(r => r.metadata.status !== "superseded" &&
        (r.metadata.type === "relationship" &&
          r.metadata.characters?.every(id => existingIds.has(id)) ||
         r.metadata.type === "fact" && existingCharacters.some(c =>
           c.metadata.initial_knowledge?.some(k => k.fact === r.metadata.id))));
  if (existingFoundations.length > 128)
    throw new Error("Existing foundation context exceeds the bounded record inventory.");
  const sourcePaths = [...new Set([...sources, ...selected, ...existingCharacters, ...existingFoundations]
    .map(r => r.path).concat(authored))].sort();
  return { domain, arcIds: selected.filter(r => r.metadata.type === "arc").map(r => r.metadata.id),
    milestoneIds: selected.filter(r => r.metadata.type === "milestone").map(r => r.metadata.id),
    sourcePaths, scope: plan.contract,
    decisionAuthority: { existingAuthorChoices: "protected-no-retcon",
      newSpecialistChoices: "agent-delegated", editorialApproval: "not-granted" } };
}
/** Compare Arc records with their Character links removed, accepting both canonical
 * YAML array spellings without tolerating a change to any other field or prose. */
export function normalizeArcCharacterLinks(text: string): { text: string; ids: string[] } {
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
export async function auditPaths(job: JobStartResult, unit: Unit, assign: FoundationAssignment, declared: string[], partial = false) {
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
  if ((!partial && !paths.length) || !Array.isArray(declared) || declared.some(p => typeof p !== "string") ||
      JSON.stringify([...new Set(declared)].sort()) !== JSON.stringify(paths)) {
    throw new Error("Specialist claimed modifiedRecords differ from actual Git diff: declared " +
      JSON.stringify(declared) + ", actual " + JSON.stringify(paths));
  }
  // The opposite record type may already be correct and must not be
  // rewritten just to satisfy a two-category diff requirement. checkOutput
  // independently verifies the complete, scoped canonical foundation state.
  return paths;
}
function verifyCommit(job: JobStartResult, unit: Unit, before: string, commit: string) {
  if (!unit.digest || !unit.paths || git(job, "rev-parse", commit + "^") !== before) {
    throw new Error("Foundation commit has an unexpected parent or missing audit inventory.");
  }
  const message = git(job, "log", "-1", "--format=%B", commit);
  if (!message.split("\n").includes("NovelTea-Job: " + commitOrigin(job, unit.id, commit).jobId) ||
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
export async function checkOutput(job: JobStartResult, report: CatalogReport, unit: Unit, assign: FoundationAssignment) {
  const current = report.records.filter(r => r.metadata.status !== "superseded");
  if (unit.paths?.some(p => !current.some(r => r.path === p))) {
    throw new Error("Specialist wrote files the canonical catalog did not recognize.");
  }
  // Final-state evidence includes the existing, explicitly supplied records
  // as well as the changed files. A pre-existing Fact or Relationship does not
  // need a cosmetic rewrite to qualify a genuine revision of its counterpart.
  const scoped = current.filter(r => assign.sourcePaths.includes(r.path) || unit.paths?.includes(r.path));
  if (unit.domain === "world") {
    if (!scoped.some(r => r.metadata.type === "fact") ||
        !scoped.some(r => r.metadata.type === "world-entity")) {
      throw new Error("World foundations require a canonical Fact and World Entity in the assigned scope.");
    }
  } else {
    const characters = scoped.filter(r => r.metadata.type === "character");
    const facts = scoped.filter(r => r.metadata.type === "fact");
    const relationships = scoped.filter(r => r.metadata.type === "relationship");
    if (characters.length < 2 || !facts.length || !relationships.length) {
      throw new Error("Foundation cluster requires at least two Characters, a Fact and a Relationship.");
    }
    if (unit.paths?.some(p => p.startsWith("arcs/") && !assign.sourcePaths.includes(p))) {
      throw new Error("Character links reference an Arc outside the planned cluster.");
    }
    const knowledge = await Promise.all(characters.map(r =>
      readFile(join(job.worktreeStoryRoot, r.path), "utf8")));
    if (!knowledge.some(text => /initial_knowledge:\s*\n\s*- fact: fact\.[a-z][a-z0-9-]*/.test(text))) {
      throw new Error("Character foundations require at least one explicit, typed initial Fact-knowledge baseline.");
    }
  }
}
async function publishHead(job: JobStartResult, previous: string, commit: string, workItemId: string) {
  if (commitOrigin(job, workItemId, commit).jobId !== job.jobId) return;
  const file = join(job.stateDir, "revisions", "verified-head.json");
  await mkdir(dirname(file), { recursive: true });
  if (existsSync(file)) {
    const saved = JSON.parse(await readFile(file, "utf8")) as { version?: number; jobId?: string; headSha?: string };
    if (saved.version !== 1 || saved.jobId !== job.jobId ||
        (saved.headSha !== previous && saved.headSha !== commit)) {
      throw new Error("Verified-head marker differs from the committed specialist chain.");
    }
    if (saved.headSha === commit) {
      await finalizeRecoveryCheckpoint(job, workItemId, previous, commit);
      return;
    }
  }
  await persist(file, { version: 1, jobId: job.jobId, headSha: commit, workItemId });
  await finalizeRecoveryCheckpoint(job, workItemId, previous, commit);
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
    const arcs = assign.sourcePaths.filter(p => p.startsWith("arcs/"));
    for (const arc of process.env.NT_FOUNDATIONS_FIXTURE_CASE === "one-arc-only" ? arcs.slice(0, 1) : arcs) {
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
  if (process.env.NT_FOUNDATIONS_FIXTURE_CASE === "duplicate-id" && unit.domain === "character") {
    const original = await readFile(join(job.worktreeStoryRoot, "characters/ada.md"), "utf8");
    await writeFile(join(job.worktreeStoryRoot, "characters/ada-copy.md"), original, { flag: "wx" });
    paths.push("characters/ada-copy.md");
  }
  return { claimedPaths: paths, skillReads: [], architecturalConflicts: [],
    laterObligations: unit.domain === "world"
      ? ["A later Event must establish who learns the concealed evidence; objective truth remains initially true."]
      : ["Bind disclosure and any Relationship trust change to actual Event branches, not the initial state."] };
}
function output(job: JobStartResult, receipt: Receipt) {
  return { status: receipt.units.every(unit => unit.phase === "committed") ? "foundations-committed" : "in-progress",
    jobId: job.jobId, branch: job.branch, worktreeStoryRoot: job.worktreeStoryRoot,
    headSha: receipt.units[1].commitSha ?? receipt.units[1].beforeHead ??
      receipt.units[0].commitSha ?? receipt.startHead ?? receipt.architectureHead,
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
  /** Verified successor to the immutable original World author commit. */
  characterBeforeHead?: string;
  changes: string[];
  reason?: string;
  candidate?: { unit: string; paths: string[]; digest: string };
};

/** Only an independently passing, immutable World correction chain can become
 * Character's parent. A valid descendant or a passing model claim alone is
 * NOT sufficient. Original World authorship and failed review remain intact.
 *
 * A maximum of two exact, contiguous repair commits is supported. Every
 * checkpoint is verified against the original controller plan, Git diff,
 * protected baseline and independent review by the recovery inspector;
 * every repair proof is separately bound to the original rejected owner.
 */
export async function verifiedWorldReviewHandoff(
  job: JobStartResult, originalWorldSha: string, requestedHead: string,
): Promise<string> {
  if (!/^[a-f0-9]{40}$/.test(originalWorldSha) ||
      !/^[a-f0-9]{40}$/.test(requestedHead))
    throw new Error("World correction handoff lacks exact Git commit identities.");
  if (originalWorldSha === requestedHead) return originalWorldSha;
  if (git(job, "symbolic-ref", "--short", "HEAD") !== job.branch ||
      git(job, "rev-parse", requestedHead + "^{commit}") !== requestedHead)
    throw new Error("World correction handoff differs from the original branch.");
  const verified = await trustedHead(job);
  try {
    git(job, "merge-base", "--is-ancestor", requestedHead, verified);
    git(job, "merge-base", "--is-ancestor", requestedHead, "HEAD");
  } catch {
    throw new Error("World correction is not on the current verified Job branch.");
  }
  const points = await inspectRecoveryCheckpoints(job);
  const original = points.find(point => point.eligible && point.commitSha === originalWorldSha &&
    point.workItem === "world-foundations");
  if (!original?.assurance || original.semanticReview !== "failed")
    throw new Error("World correction lacks its original independently failed World checkpoint.");
  let source = originalWorldSha;
  for (let attempt = 0; attempt < 2; attempt++) {
    const successors = points.filter(point => point.eligible &&
      point.workItem === "repair-" + source);
    if (successors.length !== 1)
      throw new Error("World correction has missing/ambiguous verified repair lineage.");
    const next = successors[0]!;
    const proof = await readRepairCommitProof(job, next.workItem);
    if (!next.assurance || proof.sourceCommitSha !== source ||
        proof.rootFailureSha !== originalWorldSha ||
        proof.commitSha !== next.commitSha ||
        proof.beforeHead !== source || next.parentSha !== source ||
        proof.assignmentId !== original.assurance.assignmentId ||
        next.assurance.assignmentId !== original.assurance.assignmentId ||
        next.planVersion !== original.planVersion ||
        proof.paths.some(path => !original.assurance!.changedPaths.includes(path)) ||
        !["failed", "passed"].includes(next.semanticReview))
      throw new Error("World correction lacks source-scoped original-owner provenance.");
    if (next.commitSha === requestedHead) {
      if (next.semanticReview !== "passed")
        throw new Error("World correction has no passing independent successor review.");
      return requestedHead;
    }
    if (next.semanticReview !== "failed")
      throw new Error("World correction has unexpected commits after its passing review.");
    source = next.commitSha;
  }
  throw new Error("World correction exceeds the two-attempt independent repair limit.");
}

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
      const [world, character] = receipt.units;
      const last = character.commitSha;
      if (!last || !world.commitSha || changes.length)
        return blocked("Committed foundations have unexpected worktree or staged changes.");
      verifyCommit(job, world, receipt.startHead ?? receipt.architectureHead, world.commitSha);
      const characterParent = character.beforeHead ?? world.commitSha;
      if (characterParent !== world.commitSha)
        await verifiedWorldReviewHandoff(job, world.commitSha, characterParent);
      verifyCommit(job, character, characterParent, last);
      if (actualHead !== last) {
        if (actualHead !== await trustedHead(job)) return blocked("Foundations HEAD is not a verified successor.");
        git(job, "merge-base", "--is-ancestor", last, actualHead);
      }
      return { status: "ready", actualHead, changes };
    }
    const unit = receipt.units[index]!;
    const worldSha = index ? receipt.units[0]!.commitSha : undefined;
    let before = index ? worldSha : (receipt.startHead ?? receipt.architectureHead);
    if (!before) return blocked("Saved work-item parent differs from the verified chain.");
    if (index && worldSha) {
      verifyCommit(job, receipt.units[0]!, receipt.startHead ?? receipt.architectureHead, worldSha);
      if (unit.beforeHead && unit.beforeHead !== worldSha ||
          unit.phase === "pending" && actualHead !== worldSha) {
        const requested = unit.beforeHead ?? actualHead;
        before = await verifiedWorldReviewHandoff(job, worldSha, requested);
      }
    }
    if (unit.beforeHead && unit.beforeHead !== before)
      return blocked("Saved work-item parent differs from the verified correction chain.");
    if (unit.phase === "awaiting-author") {
      if (!unit.authorChoiceId) return blocked("Author question receipt missing from the saved work item.");
      try {
        const choice = await inspectSpecialistChoice(job, unit.authorChoiceId);
        if (choice.phase !== "answered")
          return blocked("Character/World is waiting for an author choice; answer in Author questions and approvals.");
        await verifySpecialistChoice(job, unit.authorChoiceId, "answered");
        if (choice.headSha !== before) return blocked("Author-choice Git HEAD no longer matches the work item.");
        return { status: "ready", actualHead, changes, ...(index ? { characterBeforeHead: before } : {}) };
      } catch (error) { return blocked("Author choice cannot safely resume: " + String(error)); }
    }
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
        ? { status: "ready", actualHead, changes,
            ...(index ? { characterBeforeHead: before } : {}) }
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
      return { status: "ready", actualHead, changes,
        ...(index ? { characterBeforeHead: before } : {}) };
    }
    if (changes.length) return blocked("Staged or uncommitted changes accompany a completed specialist commit.");
    if (git(job, "rev-parse", "HEAD^") !== before) return blocked("Unexpected commit parent after specialist crash.");
    verifyCommit(job, unit, before, actualHead);
    if (await fileDigest(job, unit.paths) !== unit.digest) return blocked("Committed specialist bytes differ from recorded digest.");
    return { status: "recoverable-commit", actualHead, changes,
      ...(index ? { characterBeforeHead: before } : {}) };
  } catch (error) {
    return blocked("Character/World recovery cannot be trusted: " + (error instanceof Error ? error.message : String(error)));
  }
}

export async function runCharacterWorldJob(input: CharacterWorldOptions) {
  const job = await startStoryJob({ story: input.story, job: input.job }, false);
  const parent = job.stateDir;
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
    const turnEvidence = input.action === "run"
      ? await readTurnEvidence(job, plan.contract, input.task, input.turnPlanDigest) : null;
    const policy = turnEvidence?.creativePolicy ?? DEFAULT_CREATIVE_POLICY;
    const contractDigest = digest(JSON.stringify(plan.contract));
    const trustedSteering = await steeringForAssignment(job, input.turnPlanDigest, "foundations",
      await trustedHead(job));
    if ((input.steering ?? "") !== trustedSteering)
      throw Error("Foundation author steering differs from the controller-amended plan.");
    // The saved original Turn request remains immutable. Steering is appended
    // only to pending specialist instructions, never substituted for authority.
    const steeredTask = input.task && input.steering
      ? input.task + "\n\nSAFE-BOUNDARY AUTHOR PLAN AMENDMENT:\n" + input.steering
      : input.task;
    let receipt: Receipt;
    if (existsSync(file)) {
      receipt = JSON.parse(await readFile(file, "utf8")) as Receipt;
      if (receipt.version !== 1 || receipt.jobId !== job.jobId || receipt.baseSha !== job.baseSha ||
          (receipt.branch !== undefined && receipt.branch !== job.branch) ||
          (receipt.worktreeRoot !== undefined && receipt.worktreeRoot !== job.worktreeRoot) ||
          (receipt.threadId !== undefined && receipt.threadId !== job.threadId) ||
          receipt.architectureHead !== arch.expectedHead ||
          receipt.steeringDigest !== (input.steering ? digest(input.steering) : undefined) ||
          receipt.units?.length !== 2 ||
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
        ...(input.steering ? { steeringDigest: digest(input.steering) } : {}),
        worker: input.fixture ? "fixture" : "pi",
        provider: input.provider ?? "openai", model: input.model ?? "gpt-6-luna",
        units: [{ id: "world-foundations", domain: "world", phase: "pending" },
          { id: "character-foundations", domain: "character", phase: "pending" }] };
      await persist(file, receipt);
    }
    const recovery = await inspectRecovery(job, receipt);
    if (input.action === "inspect") {
      const result = output(job, receipt);
      return { ...result, headSha: recovery.characterBeforeHead ?? result.headSha,
        status: recovery.status === "blocked" ? "blocked" : result.status, recovery };
    }
    if (input.action === "run" && recovery.status === "blocked") {
      throw new Error(recovery.reason ?? "Foundations recovery blocked.");
    }
    if (readRecoveryFork(job) && receipt.units.some(unit => unit.phase === "pending") &&
        receipt.units.every(unit => unit.phase === "pending" && !unit.beforeHead ||
          unit.phase === "committed" && commitOrigin(job, unit.id, unit.commitSha!).jobId !== job.jobId)) {
      receipt.worker = input.fixture ? "fixture" : "pi";
      receipt.provider = input.provider ?? "openai";
      receipt.model = input.model ?? "gpt-6-luna";
      await persist(file, receipt);
    }
    if (Boolean(input.fixture) !== (receipt.worker === "fixture") ||
        (input.provider && input.provider !== receipt.provider) ||
        (input.model && input.model !== receipt.model)) {
      throw new Error("Foundations specialist worker configuration differs from the saved assignment.");
    }
    if (input.action === "run" && receipt.units.every(unit => unit.phase === "committed")) {
      const [world, character] = receipt.units;
      verifyCommit(job, world, receipt.startHead ?? receipt.architectureHead, world.commitSha!);
      const characterParent = character.beforeHead ?? world.commitSha!;
      if (characterParent !== world.commitSha!)
        await verifiedWorldReviewHandoff(job, world.commitSha!, characterParent);
      verifyCommit(job, character, characterParent, character.commitSha!);
      // A later independently verified inbox capture is not a reason to replay
      // specialists. Restore a missing final verified-head publication only if
      // the Character commit itself remains the current worktree HEAD.
      if (recovery.actualHead === character.commitSha) {
        await publishHead(job, characterParent, character.commitSha!, character.id);
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
      const before = index ? (unit.beforeHead ?? recovery.characterBeforeHead ??
        receipt.units[index - 1]!.commitSha) : (receipt.startHead ?? receipt.architectureHead);
      if (!before) throw new Error("Missing parent work-item commit.");
      assertHead(job, before);
      const preReport = reportOf(await validate(before), before);
      const assign = deriveFoundationAssignment(unit.domain, plan, preReport,
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
      const before = index ? (unit.beforeHead ?? recovery.characterBeforeHead ?? prior) : prior;
      if (unit.beforeHead && unit.beforeHead !== before)
        throw new Error("Work-unit head changed since reviewed correction assignment.");
      if (index && before !== prior)
        await verifiedWorldReviewHandoff(job, prior, before);
      if (unit.phase === "committed") {
        if (!unit.commitSha || !unit.digest || !unit.paths) {
          throw new Error("Saved foundation commit provenance cannot be verified.");
        }
        verifyCommit(job, unit, before, unit.commitSha);
        const current = git(job, "rev-parse", "HEAD");
        if (index === state.units.length - 1 || state.units[index + 1]!.phase === "pending") {
          const pendingParent = index === 0 ? (recovery.characterBeforeHead ?? unit.commitSha) : unit.commitSha;
          assertHead(job, pendingParent);
          if (dirty(job).length) throw new Error("Unexpected edits after specialist commit.");
        } else if (current !== unit.commitSha) {
          const next = state.units[index + 1]!;
          if (next.phase === "authored") {
            if (current !== next.beforeHead) {
              verifyCommit(job, next, next.beforeHead ?? unit.commitSha, current);
              if (dirty(job).length || await fileDigest(job, next.paths!) !== next.digest)
                throw new Error("Unverified next specialist commit or uncommitted changes.");
            }
          } else if (next.phase === "awaiting-author" && current === next.beforeHead &&
              !dirty(job).length) {
            // No new author turn or write grant is inferred; the answered,
            // original source-bound choice remains checked by its own gate.
          } else if (current !== next.commitSha) {
            throw new Error("Foundation Git chain changed unexpectedly.");
          }
        }
        if (current === unit.commitSha && commitOrigin(job, unit.id, unit.commitSha).jobId === job.jobId)
          await publishHead(job, before, unit.commitSha, unit.id);
        if (unit.authorChoiceId) {
          const record = await inspectSpecialistChoice(job, unit.authorChoiceId);
          if (record.phase === "resuming")
            await completeSpecialistChoice(job, unit.authorChoiceId);
        }
        return;
      }
      if (index > 0) await assertNativeReviewDependencies(job, unit.id);
      if (unit.phase === "writing") {
        throw new Error("Interrupted specialist writing; inspect preserved files and Pi session, then reconcile exact bytes. Never replay the writer.");
      }
      const resumingChoice = unit.phase === "awaiting-author";
      const choice = resumingChoice && unit.authorChoiceId
        ? await verifySpecialistChoice(job, unit.authorChoiceId, "answered") : null;
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
      const assign = resumingChoice
        ? unit.assignment
        : { ...deriveFoundationAssignment(unit.domain, plan,
          reportOf(await validate(before), before),
          state.units.slice(0, index).flatMap(item => item.paths ?? []).filter(p => !p.startsWith("arcs/"))),
          ...(steeredTask ? { authorTask: steeredTask } : {}),
          creativePolicy: policy };
      if (JSON.stringify(assign?.creativePolicy ?? DEFAULT_CREATIVE_POLICY) !== JSON.stringify(policy))
        throw new Error("Foundation assignment creative policy differs from the original Turn receipt.");
      if (!assign || assign.domain !== unit.domain) throw Error("Saved specialist assignment missing or mismatched.");
      if (unit.phase === "pending" || resumingChoice) {
        if (!resumingChoice) {
          await preflightPiAssignment(job, "foundations:" + unit.domain, state.worker === "pi"
            ? { provider: state.provider, model: state.model } : undefined);
          unit.beforeHead = before;
          unit.assignment = assign;
        } else {
          // Model availability and budget checks happen BEFORE consuming the
          // one-time continuation. A missing provider is not a failed writer.
          await preflightPiAssignment(job, "foundations:" + unit.domain,
            { provider: state.provider, model: state.model });
          // Fence the exact answered turn BEFORE another external writer begins.
          await claimSpecialistChoice(job, unit.authorChoiceId!);
        }
        unit.phase = "writing";
        await persist(file, state);
        let evidence: SpecialistEvidence | SpecialistChoiceProposal;
        if (state.worker === "fixture") evidence = await fixtureAuthor(job, unit, assign);
        else evidence = await authorCharacterWorld(job, state.snapshot!, assign, state.provider, state.model,
          async (id, session) => { unit.piSessionId = id; unit.piSessionFile = session; await persist(file, state); },
          async proposed => {
            // Inspect the actual working tree BEFORE showing validator diagnostics
            // to Pi. Unexpected paths, staging or forged manifests fail closed.
            let paths: string[] | undefined;
            let manifestFeedback: string | undefined;
            try {
              paths = await auditPaths(job, unit, assign, proposed.claimedPaths);
            } catch (error) {
              const message = String(error);
              // Only an incomplete self-report or empty work item is repairable.
              // Out-of-scope/staged/unsafe paths must still fail closed.
              if (!message.includes("claimed modifiedRecords differ from actual Git diff")) throw error;
              manifestFeedback = message;
            }
            assertHead(job, before);
            if (proposed.architecturalConflicts?.length) {
              // A self-reported conflict is bounded repair feedback to the
              // SAME Pi session, not permission to commit or begin a new
              // writer. Unresolved conflicts still stop after the final pass.
              return proposed.architecturalConflicts.slice(0, 8).map(message =>
                "Unresolved architectural conflict; repair the existing files and references: " +
                message.slice(0, 800));
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
            if (manifestFeedback) return [manifestFeedback +
              ". Report only the exact changed files; do not touch existing canonical records just to fill a required category."];
            const candidate: Unit = { ...unit, paths };
            if (draft.status === "passed") {
              try { await checkOutput(job, report, candidate, assign); return []; }
              catch (error) {
                if (!/^Error: (World foundations require|Foundation cluster requires|Character foundations require)/.test(String(error))) throw error;
                if (unit.domain === "character" &&
                    String(error).includes("Character foundations require at least one explicit, typed initial Fact-knowledge baseline.")) {
                  const factIds = report.records.filter(record =>
                    record.metadata.type === "fact" &&
                    record.metadata.status !== "superseded" &&
                    record.metadata.initial !== false).map(record => record.metadata.id);
                  // Source-constrained, same-session repair. No new Fact,
                  // author decision or scope is granted by this diagnostic.
                  if (factIds.length) return [characterInitialKnowledgeCorrection(factIds)];
                }
                return [String(error)];
              }
            }
            throw new Error("Canonical validator rejected the draft without actionable structural diagnostics.");
          }, choice ?? undefined);
        if ("authorQuestion" in evidence) {
          // Only an independently audited safe draft can be suspended.
          await auditPaths(job, unit, assign, evidence.claimedPaths, true);
          assertHead(job, before);
          const draft = await validate(before);
          const protection = (draft.report as CatalogReport | undefined)?.protection;
          if (!protection || protection.status !== "checked" ||
              protection.changes?.length || protection.warnings?.length)
            throw Error("Specialist question includes unverified/protected changes; no author-choice shortcut.");
          if (resumingChoice) await completeSpecialistChoice(job, unit.authorChoiceId!);
          const pending = await recordSpecialistChoice(job, unit.id, evidence.authorQuestion,
            evidence.piSessionId, evidence.piSessionFile);
          unit.authorChoiceId = pending.id;
          unit.piSessionId = evidence.piSessionId;
          unit.piSessionFile = evidence.piSessionFile;
          unit.phase = "awaiting-author";
          await persist(file, state);
          throw new SpecialistChoiceRequiredError();
        }
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
        validatorVersion: (await startStoryJob({ story: input.story, job: input.job }, false)).validatorVersion!,
        records: unit.paths };
      unit.commitSha = sha; unit.phase = "committed";
      await persist(file, state);
      await publishHead(job, before, sha, unit.id);
      if (resumingChoice && unit.authorChoiceId)
        await completeSpecialistChoice(job, unit.authorChoiceId);
    }
    const result = await graph.invoke({ receipt });
    const authorUpdates = await processAuthorUpdatesAfterWork(job);
    const { scheduleIdeasAtBoundary } = await import("./idea-placement.js");
    await scheduleIdeasAtBoundary(job, "character-world");
    return { ...output(job, result.receipt), authorUpdates };
  });
}
