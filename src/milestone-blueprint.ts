/** Just-in-time, private Milestone planning at the verified Event boundary.
 * These receipts describe obligations, never canonical records or new write grants. */
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "./git-read-cache.js";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import type { JobStartResult } from "./job.js";
import type { Plan } from "./architecture.js";
import type { EventAssignment } from "./event-specialist.js";
import type { SkillSnapshot } from "./snapshot.js";
import { openStoryProject } from "./project.js";
import { createProjectResourceLoader } from "./pi.js";
import { createJobModelRuntime } from "./model-runtime.js";
import { preparePiContext, PiBudgetPause } from "./job-pi-policy.js";
import { selectSandboxPiTools, SANDBOX_READ_ONLY_TOOLS } from "./sandbox-pi-tools.js";
import { promptStorySpecialist } from "./story-interruption.js";
import { completedPinnedSkillReads } from "./pinned-skill-reads.js";
import { assertReviewCycleSession, reviewCycleId } from "./review-cycle.js";

const sha = (value: unknown) => createHash("sha256").update(
  typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const HASH = /^[a-f0-9]{64}$/;
const MILESTONE = /^milestone\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const REQUIRED = ["nt-event-design/SKILL.md", "nt-catalog/SKILL.md"] as const;
type Owner = "event" | "interactive" | "composition";
export interface MilestoneBlueprint {
  schema: "noveltea-milestone-blueprint/v1";
  milestoneId: string;
  events: Array<{
    id: string; purpose: string; dependsOn: string[];
    evidence: Array<{ anchorPath: string; source: string; observation: string;
      access: string; establishes: string; limits: string }>;
    participants: string[]; knowledge: string;
    routes: Array<{ condition: string; consequence: string }>;
  }>;
  downstream: Array<{ owner: Owner; obligation: string }>;
}
type MilestoneEvent = MilestoneBlueprint["events"][number];
type MilestoneField = Exclude<keyof MilestoneEvent, "id">;
const MILESTONE_FIELDS: readonly MilestoneField[] =
  ["purpose", "knowledge", "dependsOn", "participants", "evidence", "routes"];
type MilestoneFinding = {
  eventId: string; anchorPath: string; requirement: string;
  reason: string; correction: string;
  /** v3 findings anchor the actual defect, not merely the Event path. */
  evidence?: { field: MilestoneField; quote: string };
};
type MilestonePriorEvidence =
  | { kind: "revised" | "added"; eventId: string; field: MilestoneField;
      before: string; after: string }
  | { kind: "removed"; eventId: string; field: MilestoneField; before: string }
  | { kind: "current"; eventId: string; field: MilestoneField; quote: string };
export interface MilestoneBlueprintReview {
  /** v1/v2 remain readable under their sealed policy; newly admitted reviews use v3. */
  schema: "noveltea-milestone-blueprint-review/v1" |
    "noveltea-milestone-blueprint-review/v2" | "noveltea-milestone-blueprint-review/v3";
  status: "pass" | "revise";
  findings: MilestoneFinding[];
  prior?: Array<{ round: number; findingIndex: number;
    status: "resolved" | "improved" | "persisting" | "regressed";
    reason: string; evidence: { eventId: string; quote: string } | MilestonePriorEvidence }>;
}

function milestoneFieldText(event: MilestoneEvent, field: MilestoneField): string {
  const value = event[field];
  return typeof value === "string" ? value : JSON.stringify(value);
}
/** A missing array member has no eight-character quote. Only the exact empty
 * array, on an actual empty array field, is permitted as short evidence. */
function milestoneFieldQuote(event: MilestoneEvent, field: MilestoneField, quote: string): boolean {
  const value = event[field];
  if (quote === "[]") return Array.isArray(value) && value.length === 0;
  return quote.length >= 8 && milestoneFieldText(event, field).includes(quote);
}
const milestoneEvent = (draft: MilestoneBlueprint, id: string) =>
  draft.events.find(event => event.id === id);

function milestoneCorrectionEvidence(p: NonNullable<MilestoneBlueprintReview["prior"]>[number],
  finding: MilestoneFinding, original: MilestoneBlueprint, current: MilestoneBlueprint,
): boolean {
  const evidence = p.evidence;
  if (!("kind" in evidence) || evidence.eventId !== finding.eventId ||
      !(MILESTONE_FIELDS as readonly string[]).includes(evidence.field))
    return false;
  const source = milestoneEvent(original, finding.eventId);
  if (!source) return false;
  const before = milestoneFieldText(source, evidence.field);
  // New v3 findings bind the repair to the very field and quote that were
  // independently rejected, so unrelated Event or field edits cannot launder a PASS.
  if (finding.evidence &&
      (finding.evidence.field !== evidence.field ||
       (evidence.kind === "current"
         ? finding.evidence.quote !== evidence.quote
         : finding.evidence.quote !== evidence.before)))
    return false;
  if (evidence.kind === "removed")
    return milestoneFieldQuote(source, evidence.field, evidence.before) &&
      !milestoneEvent(current, finding.eventId);
  const target = milestoneEvent(current, finding.eventId);
  if (!target) return false;
  const after = milestoneFieldText(target, evidence.field);
  if (evidence.kind === "revised" || evidence.kind === "added") {
    if (!milestoneFieldQuote(source, evidence.field, evidence.before) ||
        !milestoneFieldQuote(target, evidence.field, evidence.after) ||
        milestoneFieldQuote(source, evidence.field, evidence.after) || before === after)
      return false;
    // Replacement removes the quoted defect. An omission correction may
    // instead RETAIN valid text, provided new field-specific evidence appears.
    return evidence.kind === "added"
      ? milestoneFieldQuote(target, evidence.field, evidence.before)
      : !milestoneFieldQuote(target, evidence.field, evidence.before);
  }
  return evidence.kind === "current" &&
    milestoneFieldQuote(target, evidence.field, evidence.quote);
}

/** Require changed, source-bound evidence against EACH rejected target before
 * admitting a new independent PASS, not just an unrelated global draft diff. */
export function milestonePassCorrections(draft: MilestoneBlueprint,
  previous: readonly Round[], review: MilestoneBlueprintReview): boolean {
  if (review.status !== "pass" || !previous.length) return true;
  if (review.schema !== "noveltea-milestone-blueprint-review/v3") return true; // sealed legacy
  return previous.every((round, index) => round.review.findings.every((finding, findingIndex) => {
    const proof = review.prior?.find(p => p.round === index && p.findingIndex === findingIndex);
    return proof?.status === "resolved" &&
      milestoneCorrectionEvidence(proof, finding, round.draft, draft) &&
      "kind" in proof.evidence && proof.evidence.kind !== "current";
  }));
}
interface Lineage {
  jobId: string; threadId: string; baseSha: string; executionHead: string;
  milestoneId: string; planVersion: number; planDigest: string;
  contractDigest: string; sourceDigest: string; snapshotId: string;
  provider: string; model: string; taskDigest: string; reviewCycleId: string;
}
type Phase = "admitted" | "planning" | "draft" | "reviewing" | "revision" | "approved";
interface SessionSeal {
  id: string; file: string; bytes: number; digest: string;
}
interface Round { draft: MilestoneBlueprint; review: MilestoneBlueprintReview;
  draftDigest: string; reviewDigest: string }

/** Reconstruct nonprogress entirely from sealed rounds, including after a restart.
 * Cosmetic rewrites, oscillation, and newly discovered issues alone cannot
 * reset the two-correction reassessment threshold. */
export function milestoneReviewStagnation(rounds: readonly Round[]): number {
  let stalled = 0;
  for (let i = 1; i < rounds.length; i++) {
    const prior = rounds[i - 1]!;
    const current = rounds[i]!;
    const oscillating = rounds.slice(0, i).some(r => r.draftDigest === current.draftDigest);
    const improved = !oscillating && (current.review.prior ?? []).some(p => {
      if (p.status !== "resolved" && p.status !== "improved") return false;
      const source = rounds[p.round];
      const finding = source?.review.findings[p.findingIndex];
      if (!finding || p.evidence.eventId !== finding.eventId) return false;
      if (current.review.schema === "noveltea-milestone-blueprint-review/v3") {
        if (!source || !milestoneCorrectionEvidence(p, finding, source.draft, current.draft) ||
            !("kind" in p.evidence)) return false;
        const before = milestoneEvent(prior.draft, finding.eventId);
        const after = milestoneEvent(current.draft, finding.eventId);
        if (p.evidence.kind === "removed") return !!before && !after;
        if (!["revised", "added"].includes(p.evidence.kind) || !before || !after ||
            !("before" in p.evidence) || !("after" in p.evidence)) return false;
        return milestoneFieldQuote(before, p.evidence.field, p.evidence.before) &&
          (p.evidence.kind === "added"
            ? milestoneFieldQuote(after, p.evidence.field, p.evidence.before)
            : !milestoneFieldQuote(after, p.evidence.field, p.evidence.before)) &&
          milestoneFieldQuote(after, p.evidence.field, p.evidence.after) &&
          !milestoneFieldQuote(before, p.evidence.field, p.evidence.after);
      }
      // Older sealed v2 reviews retain their historical convergence policy.
      if ("kind" in p.evidence) return false;
      const before = milestoneEvent(prior.draft, finding.eventId);
      const after = milestoneEvent(current.draft, finding.eventId);
      return !!before && !!after && sha(before) !== sha(after) &&
        JSON.stringify(after).includes(p.evidence.quote) &&
        !JSON.stringify(before).includes(p.evidence.quote);
    });
    stalled = improved ? 0 : stalled + 1;
  }
  return stalled;
}
interface Receipt {
  schema: "noveltea-milestone-plan-receipt/v1";
  lineage: Lineage; phase: Phase; rounds: Round[];
  draft?: MilestoneBlueprint; writer?: SessionSeal; reviewer?: SessionSeal;
  approvedDigest?: string;
}
export interface MilestoneBlueprintPin {
  milestoneId: string; sourceSha: string; digest: string; cycleId: string;
}
function fileFor(job: JobStartResult, id: string) {
  if (!MILESTONE.test(id)) throw Error("Invalid Milestone Blueprint target identifier.");
  return join(job.stateDir, "milestone-blueprints", id.slice("milestone.".length) + ".json");
}

function git(job: JobStartResult, ...args: string[]) {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_PREFIX"])
    delete env[key];
  return execFileSync("git", args, { cwd: job.worktreeRoot, env,
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
}
const canonicalGitPath = (job: JobStartResult, path: string) =>
  job.storyRelativePath ? job.storyRelativePath + "/" + path : path;
async function sourceDigest(job: JobStartResult, paths: string[], head: string) {
  if (!/^[a-f0-9]{40}$/.test(head) || !paths.length ||
      paths.some(p => !/^[a-z][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*\.md$/.test(p)) ||
      new Set(paths).size !== paths.length)
    throw Error("Milestone planning requires bounded canonical source paths and a verified SHA.");
  return sha(paths.slice().sort().map(path => ({
    path, digest: sha(git(job, "show", head + ":" + canonicalGitPath(job, path))),
  })));
}
function string(value: unknown, max = 1200): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= max;
}
function strings(value: unknown, max = 12): value is string[] {
  return Array.isArray(value) && value.length <= max && value.every(x => string(x, 150));
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function exact(value: unknown, fields: string[]): value is Record<string, unknown> {
  return object(value) && Object.keys(value).sort().join("|") === fields.sort().join("|");
}
function parse(text: string): unknown {
  const trimmed = text.trim().replace(/^\`\`\`(?:json)?\s*\n/i, "").replace(/\n\`\`\`\s*$/, "");
  if (Buffer.byteLength(trimmed) > 18000) throw Error("Milestone plan exceeds its private planning budget.");
  return JSON.parse(trimmed) as unknown;
}
export function parseMilestoneBlueprint(text: string, assignment: Pick<EventAssignment,
  "milestoneId" | "milestonePath" | "sourcePaths" | "characterIds">): MilestoneBlueprint {
  let raw: unknown;
  try { raw = parse(text); } catch { throw Error("Milestone planner returned invalid or oversized JSON."); }
  if (!exact(raw, ["schema", "milestoneId", "events", "downstream"]) ||
      raw.schema !== "noveltea-milestone-blueprint/v1" || raw.milestoneId !== assignment.milestoneId ||
      !Array.isArray(raw.events) || raw.events.length < 1 || raw.events.length > 5 ||
      !Array.isArray(raw.downstream) || raw.downstream.length < 1 || raw.downstream.length > 10)
    throw Error("Invalid bounded Milestone Blueprint or target identity.");
  const seen = new Set<string>();
  for (const event of raw.events) {
    if (!exact(event, ["id", "purpose", "dependsOn", "evidence", "participants", "knowledge", "routes"]) ||
        !/^[a-z][a-z0-9-]{0,60}$/.test(String(event.id)) ||
        seen.has(String(event.id)) || !string(event.purpose) || !string(event.knowledge) ||
        !strings(event.dependsOn, 4) || event.dependsOn.some((id: string) => !seen.has(id)) ||
        !strings(event.participants, 12) ||
        event.participants.some((id: string) => !assignment.characterIds.includes(id)) ||
        !Array.isArray(event.evidence) || !event.evidence.length || event.evidence.length > 8 ||
        !Array.isArray(event.routes) || event.routes.length > 5) {
      throw Error("Milestone plan has invalid Event causality, dependencies or Character knowledge.");
    }
    seen.add(String(event.id));
    for (const e of event.evidence) {
      if (!exact(e, ["anchorPath", "source", "observation", "access", "establishes", "limits"]) ||
          !assignment.sourcePaths.includes(String(e.anchorPath)) ||
          ![e.source, e.observation, e.access, e.establishes, e.limits]
            .every(value => string(value)))
        throw Error("Milestone Event evidence lacks a current canonical anchor, inspectable source or access.");
    }
    for (const route of event.routes)
      if (!exact(route, ["condition", "consequence"]) ||
          !string(route.condition) || !string(route.consequence))
        throw Error("Milestone plan has unbounded or missing lasting route consequences.");
  }
  for (const item of raw.downstream)
    if (!exact(item, ["owner", "obligation"]) ||
        !["event", "interactive", "composition"].includes(String(item.owner)) ||
        !string(item.obligation))
      throw Error("Milestone downstream obligation needs an explicit responsible stage.");
  if (!raw.downstream.some(item => item.owner === "composition"))
    throw Error("Milestone plan must identify the downstream Composition owner.");
  return raw as unknown as MilestoneBlueprint;
}
export function parseMilestoneBlueprintReview(text: string, draft: MilestoneBlueprint,
  assignment: Pick<EventAssignment, "milestonePath" | "sourcePaths">,
  previous: readonly Round[] = [],
  policy: "admission" | "sealed-replay" = "admission"): MilestoneBlueprintReview {
  let raw: unknown;
  try { raw = parse(text); } catch { throw Error("Independent Milestone review returned invalid JSON."); }
  const version = object(raw) ? raw.schema : null;
  const modern = version === "noveltea-milestone-blueprint-review/v3";
  const hasPrior = modern || version === "noveltea-milestone-blueprint-review/v2";
  if (!["noveltea-milestone-blueprint-review/v1",
        "noveltea-milestone-blueprint-review/v2",
        "noveltea-milestone-blueprint-review/v3"].includes(String(version)) ||
      !exact(raw, hasPrior ? ["schema", "status", "findings", "prior"] :
        ["schema", "status", "findings"]) ||
      !["pass", "revise"].includes(String(raw.status)) ||
      !Array.isArray(raw.findings) || raw.findings.length > 12 ||
      (raw.status === "pass") !== (raw.findings.length === 0))
    throw Error("Independent Milestone review needs an explicit source-bound verdict.");
  for (const item of raw.findings) {
    const event = draft.events.find(e => e.id === item.eventId);
    if (!exact(item, modern
          ? ["eventId", "anchorPath", "requirement", "reason", "correction", "evidence"]
          : ["eventId", "anchorPath", "requirement", "reason", "correction"]) ||
        !event || !assignment.sourcePaths.includes(String(item.anchorPath)) ||
        ![item.requirement, item.reason, item.correction].every(v => string(v)) ||
        (modern && (!exact(item.evidence, ["field", "quote"]) ||
          !MILESTONE_FIELDS.includes(item.evidence.field as MilestoneField) ||
          typeof item.evidence.quote !== "string" ||
          !milestoneFieldQuote(event, item.evidence.field as MilestoneField,
            item.evidence.quote))))
      throw Error("Independent Milestone review finding has no cited defective Event field.");
  }
  if (!hasPrior && previous.length && policy === "admission")
    throw Error("New Milestone review requires v3 correction evidence after a rejected round.");
  if (hasPrior) {
    const review = raw as unknown as MilestoneBlueprintReview;
    const count = previous.reduce((total, round) => total + round.review.findings.length, 0);
    if (!Array.isArray(review.prior) || review.prior.length !== count)
      throw Error("Milestone review must account for every prior material finding.");
    const seen = new Set<string>();
    for (const p of review.prior) {
      const key = p.round + ":" + p.findingIndex;
      const source = previous[p.round];
      const original = source?.review.findings[p.findingIndex];
      if (!Number.isSafeInteger(p.round) || !Number.isSafeInteger(p.findingIndex) ||
          seen.has(key) || !source || !original ||
          !["resolved", "improved", "persisting", "regressed"].includes(p.status) ||
          !string(p.reason) || !object(p.evidence) ||
          p.evidence.eventId !== original.eventId)
        throw Error("Milestone previous finding assessment lacks source-bound identity.");
      if (modern) {
        const proof = p.evidence as MilestonePriorEvidence;
        const keys = proof.kind === "revised" || proof.kind === "added"
          ? ["kind", "eventId", "field", "before", "after"]
          : proof.kind === "removed"
            ? ["kind", "eventId", "field", "before"]
            : ["kind", "eventId", "field", "quote"];
        if (!exact(proof, keys) ||
            !milestoneCorrectionEvidence(p, original, source.draft, draft) ||
            ((p.status === "resolved" || p.status === "improved")
              ? proof.kind === "current"
              : proof.kind !== "current"))
          throw Error("Milestone finding correction needs a change to its rejected field or verified Event removal.");
      } else {
        const proof = p.evidence as { eventId: string; quote: string };
        const event = milestoneEvent(draft, original.eventId);
        if (!exact(proof, ["eventId", "quote"]) ||
            !string(proof.quote) || proof.quote.length < 8 ||
            !event || !JSON.stringify(event).includes(proof.quote))
          throw Error("Milestone previous finding assessment lacks exact current Event evidence.");
      }
      seen.add(key);
    }
    if (review.status === "pass" && review.prior.some(p => p.status !== "resolved"))
      throw Error("Milestone reviewer cannot pass with unresolved historical blockers.");
    if (review.status === "pass" && previous.length &&
        policy === "admission" && !modern)
      throw Error("New Milestone approval requires v3 correction evidence against rejected Event fields.");
    if (modern && !milestonePassCorrections(draft, previous, review))
      throw Error("Milestone pass has no verified correction of the rejected Event claim.");
  }
  return raw as unknown as MilestoneBlueprintReview;
}
async function persist(path: string, receipt: Receipt) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + "." + randomUUID() + ".tmp";
  await writeFile(temporary, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await rename(temporary, path);
}
async function load(job: JobStartResult, id: string): Promise<Receipt | null> {
  const path = fileFor(job, id);
  if (!existsSync(path)) return null;
  if (await realpath(path) !== path || !(await lstat(path)).isFile())
    throw Error("Milestone planning receipt is not a safe private file.");
  return JSON.parse(await readFile(path, "utf8")) as Receipt;
}
async function seal(session: { sessionId: string; sessionManager: { getSessionFile(): string | undefined } }): Promise<SessionSeal> {
  const file = session.sessionManager.getSessionFile();
  if (!file) throw Error("Milestone planning requires a persistent Pi transcript.");
  const bytes = await readFile(file);
  return { id: session.sessionId, file, bytes: bytes.length, digest: sha(bytes.toString("utf8")) };
}
async function verifySeal(job: JobStartResult, sealValue: SessionSeal, role: "writer" | "reviewer") {
  const dir = join(job.stateDir, "milestone-blueprint-sessions", role);
  if (!sealValue || !string(sealValue.id) ||
      typeof sealValue.file !== "string" || !sealValue.file.startsWith(dir + sep) ||
      !existsSync(sealValue.file) || await realpath(sealValue.file) !== sealValue.file ||
      !(await lstat(sealValue.file)).isFile())
    throw Error("Milestone plan has missing or unsafe " + role + " Pi provenance.");
  const bytes = await readFile(sealValue.file);
  const first = JSON.parse(bytes.toString("utf8").split("\n")[0] ?? "{}") as { type?: string; id?: string };
  if (first.type !== "session" || first.id !== sealValue.id ||
      sealValue.bytes !== bytes.length || sealValue.digest !== sha(bytes.toString("utf8")))
    throw Error("Milestone plan " + role + " transcript changed after sealing.");
}
function validateReceiptShape(value: Receipt, id: string) {
  if (value?.schema !== "noveltea-milestone-plan-receipt/v1" ||
      !MILESTONE.test(id) || value.lineage?.milestoneId !== id ||
      !["admitted", "planning", "draft", "reviewing", "revision", "approved"].includes(value.phase) ||
      !Array.isArray(value.rounds) || value.rounds.length > 60)
    throw Error("Invalid private Milestone Blueprint receipt.");
}
function pinOf(value: Receipt): MilestoneBlueprintPin {
  if (value.phase !== "approved" || !value.draft || !HASH.test(value.approvedDigest ?? "") ||
      value.approvedDigest !== sha(value.draft) ||
      value.rounds.at(-1)?.draftDigest !== value.approvedDigest ||
      value.rounds.at(-1)?.review.status !== "pass")
    throw Error("Milestone Blueprint has no approved independent source-bound review.");
  return { milestoneId: value.lineage.milestoneId, sourceSha: value.lineage.executionHead,
    digest: value.approvedDigest, cycleId: value.lineage.reviewCycleId };
}
function assertRounds(value: Receipt, assignment: Pick<EventAssignment,
  "milestoneId" | "milestonePath" | "sourcePaths" | "characterIds">) {
  for (const [index, round] of value.rounds.entries()) {
    const draft = parseMilestoneBlueprint(JSON.stringify(round.draft), assignment);
    const review = parseMilestoneBlueprintReview(JSON.stringify(round.review), draft,
      assignment, value.rounds.slice(0, index), "sealed-replay");
    if (round.draftDigest !== sha(draft) || round.reviewDigest !== sha(review))
      throw Error("Milestone review evidence changed after its sealed verdict.");
  }
  if (value.draft && sha(parseMilestoneBlueprint(JSON.stringify(value.draft), assignment)) !==
      sha(value.draft)) throw Error("Milestone planning draft changed.");
}
async function lineage(job: JobStartResult, plan: Plan, assignment: EventAssignment,
  snapshot: SkillSnapshot, provider: string, model: string, task: string, head: string): Promise<Lineage> {
  const sources = await sourceDigest(job, assignment.sourcePaths, head);
  const binding = { jobId: job.jobId, threadId: job.threadId, baseSha: job.baseSha,
    executionHead: head, milestoneId: assignment.milestoneId, planVersion: plan.version,
    planDigest: sha(plan), contractDigest: sha(plan.contract), sourceDigest: sources,
    snapshotId: snapshot.id, provider, model, taskDigest: sha(task) };
  return { ...binding, reviewCycleId: cycleFor(binding) };
}
function cycleFor(binding: Omit<Lineage, "reviewCycleId">) {
  return reviewCycleId({ ...binding,
    taskDigest: sha([binding.taskDigest, binding.milestoneId,
      binding.sourceDigest, binding.planDigest]) });
}
function assertLineage(actual: Lineage, expected: Lineage) {
  if (!actual || JSON.stringify(actual) !== JSON.stringify(expected))
    throw Error("Milestone Blueprint is stale or bound to another source, assignment, model or Thread.");
}
function fixtureDraft(assignment: EventAssignment): MilestoneBlueprint {
  return { schema: "noveltea-milestone-blueprint/v1", milestoneId: assignment.milestoneId,
    events: [{ id: "grounded-discovery", purpose: "Realize the selected Milestone through an inspectable discovery",
      dependsOn: [], participants: assignment.characterIds.slice(0, 2),
      evidence: [{ anchorPath: assignment.milestonePath,
        source: "A proposed in-scene observation grounded in the selected canonical Milestone",
        observation: "The player can investigate a visible trace or explicitly attributed witness statement",
        access: "The selected Characters must plausibly reach the scene or witness",
        establishes: "Only the selected Milestone's supported change, not unobserved past facts",
        limits: "Do not treat speculation or a present absence as proof of past conditions" }],
      knowledge: "Give knowledge only to Characters who witness the evidence or are told it",
      routes: [] }],
    downstream: [{ owner: "composition", obligation: "Present the verified Event to the player with reachable authored content" }] };
}
function plannerPrompt(assignment: EventAssignment, task: string, earlier?: Round) {
  return "READ-ONLY LOCAL MILESTONE BLUEPRINT. Read pinned nt-event-design and nt-catalog " +
    "skills and the current selected Milestone, its Arc and relevant Character/World sources. " +
    "Do NOT write Story files, claim new canonical records already exist or change protected decisions. " +
    "Design 1–5 causally ordered provisional Events ONLY for " + assignment.milestoneId + ". " +
    "For each Event state concrete inspectable evidence, source, access/custody, " +
    "what it actually establishes and its uncertainty; Character knowledge/state, local branch " +
    "conditions and lasting consequences. Evidence anchorPath MUST be an existing sourcePaths " +
    "canonical record, not a proposed Event path. Name downstream owners for Choice/interactive " +
    "and Composition obligations. Unknown future Events remain provisional, not verified canon. " +
    "No unrelated Milestone or protected-canon changes. Return ONLY one JSON object " +
    "{schema:'noveltea-milestone-blueprint/v1',milestoneId,events:[{id,purpose,dependsOn," +
    "evidence:[{anchorPath,source,observation,access,establishes,limits}],participants,knowledge," +
    "routes:[{condition,consequence}]}],downstream:[{owner:'event|interactive|composition',obligation}]}. " +
    "An Event id is a provisional slug, not a canonical event.* ID. " +
    "SOURCE PATHS: " + JSON.stringify(assignment.sourcePaths) +
    "\nCHARACTER IDS: " + JSON.stringify(assignment.characterIds) +
    "\nAUTHOR OBJECTIVE: " + task +
    (earlier ? "\nSAME REVIEW CYCLE: Revise the previous provisional plan to resolve material findings, " +
      "without inventing protected authority. PRIOR PLAN: " + JSON.stringify(earlier.draft) +
      "\nINDEPENDENT REVIEW: " + JSON.stringify(earlier.review) : "");
}
function reviewerPrompt(assignment: EventAssignment, draft: MilestoneBlueprint, prior: Round[]) {
  return "INDEPENDENT READ-ONLY MILESTONE PLAN REVIEW. Read pinned nt-event-design and " +
    "nt-catalog skills and the selected canonical Milestone/Arc/Character/World sources. " +
    "Assess ONLY whether this PROVISIONAL local plan can plausibly support future Event " +
    "implementation: causality, concrete inspectable sources and access/custody, earned Character " +
    "knowledge, branching consequences and explicitly named downstream Choice/Composition owners. " +
    "Do not insist on canon or playable prose not yet authored, and do not call a future stage's " +
    "obligation a current-stage blocker. Flag actual unsupported/contradictory plan claims with an " +
    "EXISTING anchorPath and proposed eventId. Preserve your prior findings and reassess the actual " +
    "new draft, distinguishing resolved blockers and regressions. Assess EACH prior " +
    "finding by exact round and findingIndex, including distinct findings on the same " +
    "Event/source path. Every NEW finding MUST cite the defective Event FIELD and " +
    "an exact 8+ character quote from that field; for a missing route, dependency, " +
    "participant or evidence entry, cite exactly '[]' ONLY if that array field " +
    "is empty. Do not cite an Event path as a substitute for a defective field. " +
    "To resolve a prior finding, cite the originally rejected field quote and: " +
    "(revised) its removal plus NEW replacement text in the SAME field; " +
    "(added) NEW text in that same field that supplies a missing limitation, " +
    "context or member while retaining the original quote; or (removed) " +
    "the removal of the entire defective provisional Event. " +
    "For an empty array, '[]' disappears when members are added: use revised. " +
    "A replacement Event may be added, but deleting the rejected ID must be verifiable. " +
    "A pass requires evidence addressing each original defect, not unrelated " +
    "Event or field edits. For unchanged blockers cite current evidence. " +
    "Cosmetic rewrites and newly discovered blockers alone are not progress. " +
    "A pass has no findings and " +
    "every prior finding resolved; revise reports material blockers. Return ONLY JSON " +
    "{schema:'noveltea-milestone-blueprint-review/v3',status:'pass|revise'," +
    "findings:[{eventId,anchorPath,requirement,reason,correction," +
    "evidence:{field:'purpose|knowledge|dependsOn|participants|evidence|routes'," +
    "quote:exact defective field text}}]," +
    "prior:[{round,findingIndex,status:'resolved|improved|persisting|regressed'," +
    "reason,evidence:{kind:'revised|added',eventId,field," +
    "before:exact original rejected quote,after:exact NEW field quote}|" +
    "{kind:'removed',eventId,field," +
    "before:exact original rejected quote}|{kind:'current',eventId,field," +
    "quote:exact unchanged current field text}}]}. " +
    "SOURCE PATHS: " + JSON.stringify(assignment.sourcePaths) +
    "\nPREVIOUS SEALED REVIEWS: " + JSON.stringify(prior.map(r => ({ draftDigest: r.draftDigest,
      review: r.review }))) + "\nCURRENT PLAN: " + JSON.stringify(draft);
}
async function sessionFor(job: JobStartResult, snapshot: SkillSnapshot, assignment: EventAssignment,
  provider: string, model: string, role: "writer" | "reviewer", cycleId: string,
  resume?: SessionSeal) {
  const project = await openStoryProject(job.worktreeStoryRoot);
  const { loader, settingsManager } = createProjectResourceLoader(project, undefined, true, {
    discovery: "explicit-only", novelteaSkills: snapshot.path, skillDirs: [],
    requiredSkills: ["nt-event-design", "nt-catalog"],
  });
  await loader.reload();
  const { skills, diagnostics } = loader.getSkills();
  if (diagnostics.some(d => d.type === "error") ||
      !["nt-event-design", "nt-catalog"].every(name => skills.some(s =>
        s.name === name && s.filePath.startsWith(join(snapshot.path, "skills") + sep))))
    throw Error("Milestone planning requires pinned Event and catalog skills.");
  const runtime = await createJobModelRuntime();
  const context = await preparePiContext(job, project, {
    group: "milestone-blueprint:" + role + ":" + cycleId,
    step: "milestone-blueprint:" + role + ":" + assignment.milestoneId,
    paths: assignment.sourcePaths, snapshot: snapshot.id,
    provider, model, directory: join(job.stateDir, "milestone-blueprint-sessions", role),
    ...(resume ? { resumeSession: { file: resume.file, id: resume.id } } : {}),
  }, runtime);
  await context.beforeTurn(context.manager.getSessionFile() ?? undefined);
  const safeTools = await selectSandboxPiTools(job, snapshot, skills, undefined, "read-only", "specialist");
  const { session } = await createAgentSession({
    cwd: project.root, modelRuntime: runtime, model: context.model,
    thinkingLevel: context.thinking, resourceLoader: loader, settingsManager,
    sessionManager: context.manager, customTools: safeTools ?? [],
    noTools: "all", tools: [...SANDBOX_READ_ONLY_TOOLS],
  });
  if (context.thinking && session.thinkingLevel !== context.thinking) {
    session.dispose();
    throw Error("Milestone Blueprint session changed pinned thinking effort.");
  }
  if (resume && (session.sessionId !== resume.id || session.sessionManager.getSessionFile() !== resume.file)) {
    session.dispose();
    throw Error("Milestone Blueprint original Pi conversation was replaced.");
  }
  return { session, context, project };
}
function lastText(session: { messages: any[]; getLastAssistantText(): string | undefined }) {
  const last = [...session.messages].reverse().find(m => m.role === "assistant");
  if (!last || ["aborted", "error"].includes(last.stopReason))
    throw Error("Milestone Blueprint Pi session interrupted; inspect the original transcript.");
  return session.getLastAssistantText() ?? "";
}
function verifyReads(messages: Parameters<typeof completedPinnedSkillReads>[0],
  project: string, snapshot: SkillSnapshot, assignment: EventAssignment) {
  const reads = completedPinnedSkillReads(messages, project, snapshot.path);
  const required = [...REQUIRED.map(path => join(snapshot.path, "skills", path)),
    join(project, assignment.milestonePath)];
  if (required.some(path => !reads.includes(path)))
    throw Error("Milestone Blueprint agent did not inspect the pinned skills and source Milestone.");
}

/** Safe read-only status for a paused or completed local plan. This is not approval. */
export async function inspectMilestoneBlueprint(job: JobStartResult, milestoneId: string) {
  const receipt = await load(job, milestoneId);
  if (!receipt) return null;
  validateReceiptShape(receipt, milestoneId);
  if (receipt.lineage.jobId !== job.jobId || receipt.lineage.threadId !== job.threadId ||
      receipt.lineage.baseSha !== job.baseSha)
    throw Error("Milestone Blueprint inspection found an unrelated job or Thread.");
  return { phase: receipt.phase, milestoneId, sourceSha: receipt.lineage.executionHead,
    cycleId: receipt.lineage.reviewCycleId, rounds: receipt.rounds.length,
    digest: receipt.phase === "approved" ? pinOf(receipt).digest : undefined,
    lastVerdict: receipt.rounds.at(-1)?.review.status ?? null };
}

/** Inspect a sealed plan (including at a later committed Event head) without
 * treating its private proposal as a canonical Story source. */
export async function readReviewedMilestoneBlueprint(job: JobStartResult,
  pin: MilestoneBlueprintPin, assignment: Pick<EventAssignment,
    "milestoneId" | "milestonePath" | "sourcePaths" | "characterIds">,
): Promise<MilestoneBlueprint> {
  const record = await load(job, pin.milestoneId);
  if (!record) throw Error("Missing reviewed Milestone Blueprint.");
  validateReceiptShape(record, pin.milestoneId);
  if (record.lineage.jobId !== job.jobId || record.lineage.threadId !== job.threadId ||
      record.lineage.baseSha !== job.baseSha || record.lineage.executionHead !== pin.sourceSha ||
      record.lineage.reviewCycleId !== pin.cycleId ||
      cycleFor(record.lineage) !== record.lineage.reviewCycleId)
    throw Error("Milestone Blueprint pin belongs to another job, Thread or source.");
  if (record.lineage.sourceDigest !== await sourceDigest(job, assignment.sourcePaths, pin.sourceSha))
    throw Error("Milestone Blueprint source record digest changed.");
  assertRounds(record, assignment);
  const actual = pinOf(record);
  if (JSON.stringify(actual) !== JSON.stringify(pin))
    throw Error("Event consumed a stale or altered Milestone Blueprint approval.");
  if (!record.writer || !record.reviewer) {
    if (record.lineage.provider !== "fixture" || record.lineage.model !== "fixture")
      throw Error("Real Milestone plan has no independent reviewer sessions.");
  } else {
    assertReviewCycleSession({ id: record.writer.id, file: record.writer.file },
      { id: record.reviewer.id, file: record.reviewer.file });
    await verifySeal(job, record.writer, "writer");
    await verifySeal(job, record.reviewer, "reviewer");
  }
  return record.draft!;
}

/** Must be called at the one Event admission boundary under the existing writer lock.
 * No other Milestone receives a plan until its own Event is reached. */
export async function ensureMilestoneBlueprint(job: JobStartResult, plan: Plan,
  assignment: EventAssignment, snapshot: SkillSnapshot, provider: string, model: string,
  task: string, head: string, fixture: boolean,
): Promise<{ blueprint: MilestoneBlueprint; pin: MilestoneBlueprintPin }> {
  if (!MILESTONE.test(assignment.milestoneId) || !plan.items.some(i =>
      i.id === "global-architecture" && i.status === "verified" &&
      i.targetIds.includes(assignment.milestoneId)))
    throw Error("Milestone Blueprint target lacks verified Architecture authority.");
  if (!/^[a-f0-9]{40}$/.test(head) || git(job, "rev-parse", "HEAD").trim() !== head ||
      git(job, "status", "--porcelain").trim())
    throw Error("Milestone planning requires a clean, current verified canonical source.");
  const binding = await lineage(job, plan, assignment, snapshot,
    fixture ? "fixture" : provider, fixture ? "fixture" : model, task, head);
  const file = fileFor(job, assignment.milestoneId);
  let receipt = await load(job, assignment.milestoneId);
  if (receipt) {
    validateReceiptShape(receipt, assignment.milestoneId);
    assertLineage(receipt.lineage, binding);
    assertRounds(receipt, assignment);
    if (receipt.phase === "approved") {
      const pin = pinOf(receipt);
      return { blueprint: await readReviewedMilestoneBlueprint(job, pin, assignment), pin };
    }
    if (receipt.phase === "planning" || receipt.phase === "reviewing")
      throw Error("Interrupted Milestone Blueprint Pi session; inspect original transcripts before recovery.");
    if (receipt.writer) await verifySeal(job, receipt.writer, "writer");
    if (receipt.reviewer) await verifySeal(job, receipt.reviewer, "reviewer");
  } else {
    receipt = { schema: "noveltea-milestone-plan-receipt/v1",
      lineage: binding, phase: "admitted", rounds: [] };
    await persist(file, receipt);
  }
  if (fixture) {
    const draft = parseMilestoneBlueprint(JSON.stringify(fixtureDraft(assignment)), assignment);
    const review = parseMilestoneBlueprintReview(JSON.stringify({
      schema: "noveltea-milestone-blueprint-review/v1", status: "pass", findings: [],
    }), draft, assignment);
    receipt.draft = draft;
    receipt.rounds = [{ draft, review, draftDigest: sha(draft), reviewDigest: sha(review) }];
    receipt.approvedDigest = sha(draft);
    receipt.phase = "approved";
    await persist(file, receipt);
    return { blueprint: draft, pin: pinOf(receipt) };
  }
  // The writer and reviewer remain independent read-only Pi sessions across
  // substantive corrections. A partial prompt is never automatically replayed.
  for (;;) {
    if (receipt.phase === "revision" && milestoneReviewStagnation(receipt.rounds) >= 2)
      throw Error("Milestone Blueprint has two sealed nonproductive corrections; independent diagnostic reassessment required.");
    if (receipt.phase === "admitted" || receipt.phase === "revision") {
      const previousPhase = receipt.phase;
      // Seal ambiguity BEFORE the SDK may create a Pi transcript. A crash in
      // the creation-to-start gap cannot be mistaken for an unstarted planner.
      receipt.phase = "planning";
      await persist(file, receipt);
      let writer: Awaited<ReturnType<typeof sessionFor>>;
      try {
        writer = await sessionFor(job, snapshot, assignment, provider, model,
          "writer", binding.reviewCycleId, receipt.writer);
      } catch (error) {
        if (error instanceof PiBudgetPause) {
          // sessionFor preflights budget before creating the Pi SDK session.
          receipt.phase = previousPhase;
          await persist(file, receipt);
        }
        throw error;
      }
      try {
        const start = writer.session.messages.length;
        await promptStorySpecialist(writer.session, writer.context.contextNote +
          plannerPrompt(assignment, task, receipt.rounds.at(-1)));
        verifyReads(writer.session.messages.slice(start), writer.project.root, snapshot, assignment);
        const draft = parseMilestoneBlueprint(lastText(writer.session), assignment);
        await writer.context.completed(writer.session.sessionManager.getSessionFile()!, writer.session.sessionId);
        receipt.writer = await seal(writer.session);
        receipt.draft = draft;
        receipt.phase = "draft";
        await persist(file, receipt);
      } finally { writer.session.dispose(); }
    }
    if (receipt.phase !== "draft" || !receipt.draft || !receipt.writer)
      throw Error("Milestone Blueprint is not at a sealed review boundary.");
    // The initial reviewer is also an ambiguous admission if interrupted
    // between Pi session creation and its first durable start receipt.
    receipt.phase = "reviewing";
    await persist(file, receipt);
    let reviewer: Awaited<ReturnType<typeof sessionFor>>;
    try {
      reviewer = await sessionFor(job, snapshot, assignment, provider, model,
        "reviewer", binding.reviewCycleId, receipt.reviewer);
    } catch (error) {
      if (error instanceof PiBudgetPause) {
        receipt.phase = "draft";
        await persist(file, receipt);
      }
      throw error;
    }
    try {
      assertReviewCycleSession({ id: receipt.writer.id, file: receipt.writer.file },
        { id: reviewer.session.sessionId,
          file: reviewer.session.sessionManager.getSessionFile() ?? "" },
        receipt.reviewer ? { id: receipt.reviewer.id, file: receipt.reviewer.file } : undefined);
      const start = reviewer.session.messages.length;
      await promptStorySpecialist(reviewer.session, reviewer.context.contextNote +
        reviewerPrompt(assignment, receipt.draft, receipt.rounds));
      verifyReads(reviewer.session.messages.slice(start), reviewer.project.root, snapshot, assignment);
      const verdict = parseMilestoneBlueprintReview(lastText(reviewer.session), receipt.draft,
        assignment, receipt.rounds);
      if (verdict.schema !== "noveltea-milestone-blueprint-review/v3")
        throw Error("New Milestone reviews require field-bound, source-grounded reassessment.");
      await reviewer.context.completed(reviewer.session.sessionManager.getSessionFile()!, reviewer.session.sessionId);
      receipt.reviewer = await seal(reviewer.session);
      const previousRound = receipt.rounds.at(-1);
      if (verdict.status === "pass" && previousRound?.review.status === "revise" &&
          (previousRound.draftDigest === sha(receipt.draft) ||
            !milestonePassCorrections(receipt.draft, receipt.rounds, verdict)))
        throw Error("Milestone reviewer cannot approve without repairing the exact rejected Event field.");
      receipt.rounds.push({ draft: receipt.draft, review: verdict,
        draftDigest: sha(receipt.draft), reviewDigest: sha(verdict) });
      if (verdict.status === "pass") {
        receipt.approvedDigest = sha(receipt.draft);
        receipt.phase = "approved";
        await persist(file, receipt);
        return { blueprint: receipt.draft, pin: pinOf(receipt) };
      }
      if (milestoneReviewStagnation(receipt.rounds) >= 2) {
        receipt.phase = "revision";
        await persist(file, receipt);
        throw Error("Milestone Blueprint review is not converging; inspect sealed findings for a diagnostic review.");
      }
      receipt.phase = "revision";
      await persist(file, receipt);
    } finally { reviewer.session.dispose(); }
  }
}
