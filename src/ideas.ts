import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { startStoryJob, type JobStartResult } from "./job.js";
import { withStoryJobLock } from "./job-lock.js";
import { trustedHead } from "./revision.js";

/**
 * Reserved, Git-tracked but NONCANONICAL inbox. Files are serialized in the
 * JSON subset of YAML 1.2 so author text is never reparsed/reformatted and a
 * strict parser rejects aliases, executable tags, duplicate YAML keys, etc.
 * Never enumerate this directory in an ordinary Pi/Story worker context.
 */
const INBOX = ".story-inbox/ideas";
const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SHA = /^[a-f0-9]{40,64}$/;
const HASH = /^[a-f0-9]{64}$/;
const KINDS = ["event-concept", "conversation", "exact-dialogue", "narrative-anchor"] as const;
type Kind = typeof KINDS[number];
type Depth = "architecture" | "milestone" | "event";
export interface Requirement { text: string; binding: boolean }
interface UpstreamConstraint { text: string; targets: string[]; authorized: true }
export interface IdeaInput {
  id?: string;
  kind: Kind;
  source: { kind: "author-onboarding" | "author-continuation"; reference: string };
  original: string;
  requirements: { meaning: Requirement[]; wording: Requirement[]; participants: Requirement[] };
  identities: { known: string[]; unresolved: string[] };
  prerequisites: string[];
  /** Author prerequisites without canonical record identity are retained but never presumed satisfied. */
  unresolvedPrerequisites?: string[];
  placement: { scopeIds: string[]; flexible: boolean; earliest: Depth;
    minRelevantEvents?: number; minRelevantMilestones?: number };
  upstreamConstraints: UpstreamConstraint[];
}
export interface IdeaPlacementHistory {
  revision: number;
  action: "integrated" | "reassessed" | "relocation-proposed" | "relocated";
  priorHead: string;
  recordIds: string[];
  rationale: string;
  alternatives: Array<{ recordId: string; rationale: string }>;
  verified: "fixture-unverified" | "pi" | "pending-approval";
  evidence: string[];
  realizationDigest: string;
  sessionFiles?: string[];
}
export type PersistedIdea = Omit<IdeaInput, "id"> & {
  schema: "0.1"; id: string;
  lifecycle: { status: "dormant" | "integrated"; capturedAt: string;
    activatedAt: string | null; placedAt: string | null;
    placements: IdeaPlacementHistory[] };
};
interface Receipt {
  version: 1; jobId: string; threadId: string; branch: string; worktreeRoot: string;
  id: string; inputDigest: string; priorHead: string; path: string;
  blobDigest: string; content?: string; phase: "prepared" | "committed"; commitSha?: string;
}
export interface RecordInfo { id: string; type: string; arcs: string[]; events: string[]; path: string; completeness?: string; status?: string }
interface Assessment { id: string; eligible: boolean; status: "dormant" | "integrated"; reasons: string[];
  breadth: { events: number; milestones: number }; depth: Depth }
export interface IdeaAction {
  story: string; job: string; action: "capture" | "inspect" | "eligibility" | "context" | "placement-context";
  file?: string; target?: string;
}
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
function stable(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return "{" + Object.keys(object).sort().map(key => JSON.stringify(key) + ":" + stable(object[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}
export function gitRaw(job: JobStartResult, ...args: string[]) {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_PREFIX"]) delete env[key];
  return execFileSync("git", args, { cwd: job.worktreeRoot, env, encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}
export function git(job: JobStartResult, ...args: string[]) { return gitRaw(job, ...args).trim(); }
export function repoPath(job: JobStartResult, path: string) {
  return job.storyRelativePath ? job.storyRelativePath + "/" + path : path;
}
export function pathFor(id: string) { return INBOX + "/" + id + ".yaml"; }
function receiptFile(job: JobStartResult, id: string) {
  return join(job.stateDir, "ideas", id + ".json");
}
function headFile(job: JobStartResult) {
  return join(job.stateDir, "revisions", "verified-head.json");
}
export async function persist(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temp = path + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await rename(temp, path);
  } catch (err) {
    throw err;
  }
}
export function assertClean(job: JobStartResult) {
  if (git(job, "symbolic-ref", "--short", "HEAD") !== job.branch) throw new Error("Idea capture branch drift; inspect Git.");
  if (gitRaw(job, "status", "--porcelain=v1", "-z", "--untracked-files=all").length) {
    throw new Error("Idea capture requires a clean job worktree; unexpected staged/uncommitted content must be reviewed.");
  }
}
function nonempty(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Idea " + name + " must be nonempty text.");
}
function strings(value: unknown, name: string): asserts value is string[] {
  if (!Array.isArray(value) || !value.every(v => typeof v === "string" && v.trim())) {
    throw new Error("Idea " + name + " must be an array of nonempty strings.");
  }
}
function requirements(value: unknown, name: string): asserts value is Requirement[] {
  if (!Array.isArray(value) || !value.every(v => v && typeof v === "object" &&
      typeof v.text === "string" && v.text.trim() && typeof v.binding === "boolean" &&
      Object.keys(v).sort().join(",") === "binding,text")) {
    throw new Error("Idea " + name + " requires individual {text,binding} entries.");
  }
}
function onlyKeys(value: object, keys: string[], name: string) {
  const unknown = Object.keys(value).filter(k => !keys.includes(k));
  if (unknown.length) throw new Error("Unsupported " + name + " fields: " + unknown.join(", "));
}
function validate(value: unknown): IdeaInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Idea capture must be a JSON object.");
  const v = value as Partial<IdeaInput>;
  onlyKeys(v, ["id", "kind", "source", "original", "requirements", "identities", "prerequisites", "unresolvedPrerequisites", "placement", "upstreamConstraints"], "idea");
  if (v.id !== undefined && (!ID.test(v.id) || v.id.length > 64)) throw new Error("Invalid stable idea ID.");
  if (!v.kind || !KINDS.includes(v.kind)) throw new Error("Invalid idea kind.");
  if (!v.source || !["author-onboarding", "author-continuation"].includes(v.source.kind)) throw new Error("Idea source kind is required.");
  onlyKeys(v.source, ["kind", "reference"], "source");
  nonempty(v.source.reference, "source reference");
  nonempty(v.original, "original wording");
  if (!v.requirements) throw new Error("Idea requirements are required.");
  onlyKeys(v.requirements, ["meaning", "wording", "participants"], "requirements");
  requirements(v.requirements.meaning, "meaning");
  requirements(v.requirements.wording, "wording");
  requirements(v.requirements.participants, "participants");
  if (v.kind === "exact-dialogue" && !v.requirements.wording.some(r => r.binding)) {
    throw new Error("Exact dialogue needs at least one individually binding wording requirement.");
  }
  if (!v.identities) throw new Error("Known/unresolved identities are required.");
  onlyKeys(v.identities, ["known", "unresolved"], "identities");
  strings(v.identities.known, "known identities");
  strings(v.identities.unresolved, "unresolved identities");
  strings(v.prerequisites, "prerequisites");
  if (v.unresolvedPrerequisites !== undefined) strings(v.unresolvedPrerequisites, "unresolved prerequisites");
  if (!v.placement || !["architecture", "milestone", "event"].includes(v.placement.earliest) ||
      typeof v.placement.flexible !== "boolean") throw new Error("Placement needs earliest depth and flexibility.");
  onlyKeys(v.placement, ["scopeIds", "flexible", "earliest", "minRelevantEvents", "minRelevantMilestones"], "placement");
  strings(v.placement.scopeIds, "placement scope");
  if (!v.placement.scopeIds.every(x => /^(arc|milestone)\.[a-z][a-z0-9-]*$/.test(x))) {
    throw new Error("Placement scope must refer to Arc/Milestone IDs.");
  }
  if (!v.prerequisites.every(x => /^(creative-direction|character|arc|milestone|event|world-entity|fact|relationship|revelation|choice-point|puzzle|authored-content|narrative-position)\.[a-z][a-z0-9-]*$/.test(x))) {
    throw new Error("Prerequisites must be canonical record IDs.");
  }
  for (const key of ["minRelevantEvents", "minRelevantMilestones"] as const) {
    const n = v.placement[key];
    if (n !== undefined && (!Number.isSafeInteger(n) || n < 0 || n > 10000)) {
      throw new Error("Invalid placement " + key);
    }
  }
  if (!Array.isArray(v.upstreamConstraints)) throw new Error("Explicit upstream constraints array required.");
  for (const constraint of v.upstreamConstraints) {
    if (!constraint || constraint.authorized !== true) throw new Error("Upstream constraint requires explicit author authorization.");
    onlyKeys(constraint, ["text", "targets", "authorized"], "upstream constraint");
    nonempty(constraint.text, "upstream constraint");
    strings(constraint.targets, "upstream targets");
    if (!constraint.targets.length || !constraint.targets.every(t => v.placement!.scopeIds.includes(t))) {
      throw new Error("Upstream constraints must have narrow targets inside the declared placement scope.");
    }
  }
  return v as IdeaInput;
}
function captureIdentity(input: IdeaInput) {
  const { id: _id, ...data } = input;
  const digest = sha(stable(data));
  return { id: input.id ?? "idea-" + digest.slice(0, 24), digest, data };
}
function checkReceipt(job: JobStartResult, receipt: Receipt, id: string, digest: string) {
  if (receipt.version !== 1 || receipt.jobId !== job.jobId || receipt.threadId !== job.threadId ||
      receipt.branch !== job.branch || receipt.worktreeRoot !== job.worktreeRoot ||
      receipt.id !== id || receipt.path !== pathFor(id) || !HASH.test(receipt.blobDigest) ||
      !SHA.test(receipt.priorHead) || !HASH.test(receipt.inputDigest) ||
      (receipt.content !== undefined && (typeof receipt.content !== "string" || sha(receipt.content) !== receipt.blobDigest)) ||
      !["prepared", "committed"].includes(receipt.phase)) {
    throw new Error("Idea receipt identity/provenance is corrupt; preserve it for review.");
  }
  if (receipt.inputDigest !== digest) throw new Error("Idea ID conflict: original material or requirements differ from existing capture.");
}
export async function publishHead(job: JobStartResult, prior: string, commit: string, id: string,
  workItem = "idea-capture:" + id) {
  const file = headFile(job);
  if (existsSync(file)) {
    const saved = JSON.parse(await readFile(file, "utf8")) as { version: number; jobId: string; headSha: string };
    if (saved.version !== 1 || saved.jobId !== job.jobId ||
        (saved.headSha !== prior && saved.headSha !== commit)) {
      throw new Error("Verified-head marker changed during deferred idea work; preserve the commit.");
    }
    if (saved.headSha === commit) return;
  } else if (prior !== job.baseSha) {
    // Legacy foundation receipts may precede creation of the shared verified-head marker.
    const foundation = join(job.stateDir, "foundation.json");
    if (!existsSync(foundation) ||
        (JSON.parse(await readFile(foundation, "utf8")) as { stage?: string; commitSha?: string }).commitSha !== prior) {
      throw new Error("Cannot establish a trusted predecessor for idea capture.");
    }
  }
  await persist(file, { version: 1, jobId: job.jobId, headSha: commit, workItemId: workItem });
}
function verifyHistoricalCapture(job: JobStartResult, receipt: Receipt) {
  const commit = receipt.commitSha;
  if (!commit || !SHA.test(commit) || git(job, "rev-parse", commit + "^") !== receipt.priorHead) {
    throw new Error("Unexpected Git ancestry for committed idea capture.");
  }
  const paths = git(job, "diff-tree", "--no-commit-id", "--name-only", "-r", commit).split("\n").filter(Boolean);
  if (paths.length !== 1 || paths[0] !== repoPath(job, receipt.path)) {
    throw new Error("Unexpected Git paths in idea capture commit.");
  }
  const message = git(job, "log", "-1", "--format=%B", commit).split("\n");
  if (![
    "NovelTea-Job: " + job.jobId, "NovelTea-Work-Item: idea-capture",
    "NovelTea-Idea: " + receipt.id, "NovelTea-Idea-Blob: " + receipt.blobDigest,
    "NovelTea-Idea-Input: " + receipt.inputDigest,
  ].every(line => message.includes(line))) throw new Error("Unexpected idea capture commit provenance.");
  if (sha(gitRaw(job, "show", commit + ":" + repoPath(job, receipt.path))) !== receipt.blobDigest) {
    throw new Error("Idea commit blob differs from captured author input.");
  }
}
function verifyCommit(job: JobStartResult, receipt: Receipt) {
  assertClean(job);
  const head = git(job, "rev-parse", "HEAD");
  if (head === receipt.priorHead) return false;
  verifyHistoricalCapture(job, { ...receipt, commitSha: head });
  return true;
}
async function capture(job: JobStartResult, input: IdeaInput) {
  const { id, digest, data } = captureIdentity(input);
  const file = receiptFile(job, id);
  let receipt: Receipt;
  if (existsSync(file)) {
    const raw = JSON.parse(await readFile(file, "utf8")) as Receipt;
    checkReceipt(job, raw, id, digest);
    receipt = raw;
    if (receipt.phase === "committed") {
      if (!receipt.commitSha || !SHA.test(receipt.commitSha)) throw new Error("Invalid committed idea receipt.");
      const actual = git(job, "rev-parse", "HEAD");
      // Later verified work is fine; never treat an unverified descendant as success.
      if (actual !== receipt.commitSha) {
        const trusted = await trustedHead(job);
        git(job, "merge-base", "--is-ancestor", receipt.commitSha, trusted);
      } else {
        if (!verifyCommit(job, receipt)) throw new Error("Captured idea commit disappeared.");
        await publishHead(job, receipt.priorHead, actual, id);
      }
      assertClean(job);
      verifyHistoricalCapture(job, receipt);
      if (sha(gitRaw(job, "show", receipt.commitSha + ":" + repoPath(job, receipt.path))) !== receipt.blobDigest) {
        throw new Error("Captured idea's committed material differs from its receipt.");
      }
      return { status: "captured", id, path: receipt.path, commitSha: receipt.commitSha, reused: true };
    }
  } else {
    const priorHead = await trustedHead(job);
    assertClean(job);
    // Never capture across a partly authored work item, even if its tree happens to be clean.
    const parent = job.stateDir;
    for (const [name, field, allowed] of [
      ["foundation.json", "stage", ["committed"]],
      ["architecture.json", "phase", ["committed"]],
    ] as const) {
      const path = join(parent, name);
      if (existsSync(path) && !allowed.includes((JSON.parse(await readFile(path, "utf8")) as Record<string, string>)[field] as never)) {
        throw new Error("Cannot capture an idea while a Story writer/plan is unfinished: " + name);
      }
    }
    const cw = join(parent, "character-world.json");
    if (existsSync(cw)) {
      const items = (JSON.parse(await readFile(cw, "utf8")) as { units?: Array<{ phase: string }> }).units;
      if (!items || items.some(item => item.phase !== "committed")) throw new Error("Finish or reconcile the active Character/World work item first.");
    }
    const path = pathFor(id);
    if (existsSync(join(job.worktreeStoryRoot, path))) {
      throw new Error("Existing inbox file has no matching capture receipt; preserve it for review.");
    }
    const doc: PersistedIdea = { schema: "0.1", id, ...data, lifecycle: {
      status: "dormant", capturedAt: new Date().toISOString(), activatedAt: null, placedAt: null, placements: [],
    } };
    const bytes = JSON.stringify(doc, null, 2) + "\n";
    receipt = { version: 1, jobId: job.jobId, threadId: job.threadId,
      branch: job.branch, worktreeRoot: job.worktreeRoot,
      id, inputDigest: digest, priorHead, path, blobDigest: sha(bytes), content: bytes, phase: "prepared" };
    await persist(file, receipt);
    // Receipt precedes the Git write. A crash here can never erase an authored file.
    await mkdir(dirname(join(job.worktreeStoryRoot, path)), { recursive: true });
    await writeFile(join(job.worktreeStoryRoot, path), bytes, { flag: "wx" });
  }
  const actual = git(job, "rev-parse", "HEAD");
  if (actual === receipt.priorHead) {
    const target = join(job.worktreeStoryRoot, receipt.path);
    if (!existsSync(target)) {
      assertClean(job);
      if (!receipt.content || sha(receipt.content) !== receipt.blobDigest) {
        throw new Error("Interrupted prewrite capture lacks exact saved author bytes; restore its receipt.");
      }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, receipt.content, { flag: "wx" });
    }
    if (!(await lstat(target)).isFile() ||
        await realpath(target) !== target || sha(await readFile(target)) !== receipt.blobDigest) {
      throw new Error("Interrupted idea capture has missing or modified bytes; inspect before recovery.");
    }
    const changes = gitRaw(job, "status", "--porcelain=v1", "-z", "--untracked-files=all").split("\0").filter(Boolean);
    if (changes.length !== 1 || changes[0] !== "?? " + repoPath(job, receipt.path)) {
      throw new Error("Interrupted capture has unexpected staged or uncommitted changes.");
    }
    git(job, "add", "--", repoPath(job, receipt.path));
    git(job, "-c", "user.name=NovelTea Generator", "-c", "user.email=noveltea-gen@users.noreply.github.com",
      "commit", "--only", "-m", "Capture deferred author idea [" + id + "]\n\n" +
      ["NovelTea-Job: " + job.jobId, "NovelTea-Work-Item: idea-capture",
        "NovelTea-Idea: " + id, "NovelTea-Idea-Blob: " + receipt.blobDigest,
        "NovelTea-Idea-Input: " + receipt.inputDigest].join("\n"), "--", repoPath(job, receipt.path));
  }
  if (!verifyCommit(job, receipt)) throw new Error("Idea capture did not produce its exact verified commit.");
  const commitSha = git(job, "rev-parse", "HEAD");
  receipt.phase = "committed";
  receipt.commitSha = commitSha;
  await persist(file, receipt);
  await publishHead(job, receipt.priorHead, commitSha, id);
  return { status: "captured", id, path: receipt.path, commitSha, reused: actual !== receipt.priorHead };
}
function frontmatter(value: string): RecordInfo | undefined {
  const section = value.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!section) return;
  const scalar = (key: string) => section.match(new RegExp("^" + key + ":\\s*['\"]?([^'\"\\r\\n]+)", "m"))?.[1]?.trim();
  const list = (key: string) => {
    const body = section.match(new RegExp("^" + key + ":\\s*\\[([^\\]]*)\\]", "m"))?.[1];
    if (body !== undefined) return body.split(",").map(x => x.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
    const block = section.match(new RegExp("^" + key + ":\\s*\\r?\\n((?:\\s+- [^\\r\\n]+\\r?\\n?)+)", "m"))?.[1];
    return block ? [...block.matchAll(/^\s+-\s+(.+)$/gm)].map(m => m[1]!.trim().replace(/^['"]|['"]$/g, "")) : [];
  };
  const id = scalar("id"), type = scalar("type");
  if (!id || !type) return;
  return { id, type, arcs: list("arcs"), events: list("events"), path: "", completeness: scalar("completeness"), status: scalar("status") };
}
export function records(job: JobStartResult) {
  const root = job.storyRelativePath ? job.storyRelativePath + "/" : "";
  const paths = git(job, "ls-tree", "-r", "--name-only", "HEAD", "--",
    ...["creative-direction", "arcs", "milestones", "events", "characters",
      "world-entities", "facts", "relationships", "revelations", "choice-points",
      "puzzles", "authored-content", "narrative-positions"].map(p => root + p))
    .split("\n").filter(Boolean);
  const items = new Map<string, RecordInfo>();
  for (const p of paths) {
    if (!p.endsWith(".md")) continue;
    const record = frontmatter(gitRaw(job, "show", "HEAD:" + p));
    if (record && /^(creative-direction|arc|milestone|event|character|world-entity|fact|relationship|revelation|choice-point|puzzle|authored-content|narrative-position)$/.test(record.type) &&
        record.id.startsWith(record.type + ".") && record.status !== "superseded")
      items.set(record.id, { ...record, path: p.slice(root.length) });
  }
  return items;
}
function scopeArcs(idea: PersistedIdea, catalog: Map<string, RecordInfo>) {
  const arcs = new Set<string>();
  for (const target of idea.placement.scopeIds) {
    const record = catalog.get(target);
    if (!record) continue;
    if (record.type === "arc") arcs.add(target);
    else for (const arc of record.arcs) arcs.add(arc);
  }
  return arcs;
}
function matching(record: RecordInfo, idea: PersistedIdea, arcs: Set<string>) {
  return idea.placement.scopeIds.includes(record.id) || record.arcs.some(a => arcs.has(a));
}
export function assess(idea: PersistedIdea, catalog: Map<string, RecordInfo>): Assessment {
  const arcs = scopeArcs(idea, catalog);
  const milestones = [...catalog.values()].filter(x => x.type === "milestone" &&
    x.completeness !== "partial" && matching(x, idea, arcs));
  const events = [...catalog.values()].filter(x => x.type === "event" &&
    x.completeness !== "partial" && matching(x, idea, arcs));
  const reasons: string[] = [];
  if (!arcs.size) reasons.push("relevant-scoped-architecture-not-yet-present");
  if (idea.unresolvedPrerequisites?.length) reasons.push("unresolved-author-prerequisites");
  for (const target of idea.prerequisites) {
    const record = catalog.get(target);
    if (!record || record.completeness === "partial") reasons.push("unmet-prerequisite:" + target);
  }
  const dialogue = idea.kind === "conversation" || idea.kind === "exact-dialogue";
  const minMilestones = Math.max(idea.placement.minRelevantMilestones ?? 0,
    dialogue ? 2 : idea.placement.earliest === "architecture" ? 0 : 1);
  const minEvents = Math.max(idea.placement.minRelevantEvents ?? 0, dialogue ? 3 :
    idea.placement.earliest === "event" ? 1 : 0);
  if (milestones.length < minMilestones) reasons.push("insufficient-relevant-milestones");
  if (events.length < minEvents) reasons.push("insufficient-relevant-events");
  if (idea.placement.earliest === "event" && !events.length) reasons.push("event-depth-not-reached");
  if (idea.placement.earliest === "milestone" && !milestones.length) reasons.push("milestone-depth-not-reached");
  return { id: idea.id, eligible: reasons.length === 0, status: idea.lifecycle.status, reasons,
    breadth: { events: events.length, milestones: milestones.length }, depth: idea.placement.earliest };
}
function contextMatch(idea: PersistedIdea, target: RecordInfo, catalog: Map<string, RecordInfo>) {
  const arcs = scopeArcs(idea, catalog);
  return target.type === "event" && target.arcs.some(a => arcs.has(a)) ||
    target.type === "milestone" && matching(target, idea, arcs) ||
    target.type === "arc" && idea.placement.scopeIds.includes(target.id);
}
export async function load(job: JobStartResult) {
  // Inspect only committed, trusted Git data. Never read dirty working-tree
  // inbox bytes, and never expose them to ordinary worker context.
  await trustedHead(job);
  assertClean(job);
  const prefix = repoPath(job, INBOX) + "/";
  const paths = git(job, "ls-tree", "-r", "--name-only", "HEAD", "--", repoPath(job, INBOX))
    .split("\n").filter(Boolean);
  const ideas: PersistedIdea[] = [];
  for (const path of paths) {
    if (!path.startsWith(prefix) || !/^([a-z][a-z0-9-]*)\.yaml$/.test(path.slice(prefix.length))) {
      throw new Error("Unsupported file in reserved Story inbox: " + path);
    }
    const idea = JSON.parse(gitRaw(job, "show", "HEAD:" + path)) as PersistedIdea;
    if (idea.id !== path.slice(prefix.length, -5) ||
        idea.schema !== "0.1" || !["dormant", "integrated"].includes(idea.lifecycle?.status) ||
        !Array.isArray(idea.lifecycle?.placements) ||
        !existsSync(receiptFile(job, idea.id))) throw new Error("Inbox record lacks verified capture provenance.");
    const receipt = JSON.parse(await readFile(receiptFile(job, idea.id), "utf8")) as Receipt;
    const { id, schema, lifecycle, ...original } = idea;
    void schema; void lifecycle;
    checkReceipt(job, receipt, idea.id, captureIdentity({ id, ...original }).digest);
    if (receipt.phase !== "committed" || !receipt.commitSha ||
        sha(gitRaw(job, "show", receipt.commitSha + ":" + repoPath(job, receipt.path))) !== receipt.blobDigest) {
      throw new Error("Inbox original capture differs from verified author input.");
    }
    // Mutations are limited to the lifecycle and each transition is checked
    // against its own committed placement receipt; original author inputs are immutable.
    const { verifyPlacementHistory } = await import("./idea-placement.js");
    await verifyPlacementHistory(job, idea, receipt.commitSha);
    ideas.push(idea);
  }
  return ideas.sort((a, b) => a.id.localeCompare(b.id));
}
/** Review-only completion metadata. Never place a dormant idea's original text
 * or wording in an ordinary Story writer/reviewer assignment. The caller must
 * hold the shared job lock and use the verified immutable inbox. */
export async function deferredCompletionObligations(job: JobStartResult) {
  const ideas = await load(job);
  const catalog = records(job);
  const { candidatesFor } = await import("./idea-placement.js");
  return ideas.filter(idea => {
    if (![...idea.requirements.meaning, ...idea.requirements.wording,
      ...idea.requirements.participants].some(requirement => requirement.binding)) return false;
    const last = idea.lifecycle.placements.filter(p =>
      p.action === "integrated" || p.action === "relocated" || p.action === "reassessed").at(-1);
    if (idea.lifecycle.status !== "integrated" || last?.verified !== "pi") return true;
    const paths = last.recordIds.map(id => catalog.get(id)?.path);
    if (paths.some(p => !p)) return true;
    const exact = sha(paths.map(p => sha(gitRaw(job, "show", "HEAD:" + repoPath(job, p!)))).join("|"));
    if (exact !== last.realizationDigest) return true;
    // New plausible locations require renewed placement/semantic assessment:
    // a prior editorial approval does not attest later structural alternatives.
    return candidatesFor(idea, catalog).some(c =>
      !last.alternatives.some(a => a.recordId === c.id));
  }).map(idea => ({
    id: idea.id, scopeIds: idea.placement.scopeIds,
    message: "Binding author idea is deferred or requires fresh semantic/placement reassessment: " + idea.id,
  }));
}
/**
 * Reconcile only a pre-existing capture whose immutable input and predecessor
 * match the interrupted author-update node. Never start a new capture here.
 * Caller MUST hold the shared job lock.
 */
export async function reconcileCapturedIdeaUnderJobLock(job: JobStartResult, payload: unknown, priorHead: string) {
  const input = validate(payload);
  const { id, digest } = captureIdentity(input);
  const file = receiptFile(job, id);
  if (!existsSync(file)) return null;
  const receipt = JSON.parse(await readFile(file, "utf8")) as Receipt;
  checkReceipt(job, receipt, id, digest);
  if (receipt.priorHead !== priorHead) throw new Error("Interrupted idea capture is bound to another Git predecessor.");
  const result = await capture(job, input);
  if (result.commitSha === priorHead) throw new Error("Interrupted idea capture did not advance the verified HEAD.");
  return result;
}
/** Caller MUST own the shared Story job lock. Used by the author-update graph
 * at a safe boundary; never invoke this directly from message submission. */
export async function captureIdeaUnderJobLock(job: JobStartResult, payload: unknown) {
  return capture(job, validate(payload));
}
export async function runIdeas(input: IdeaAction) {
  const job = await startStoryJob({ story: input.story, job: input.job }, false);
  return withStoryJobLock(job, "deferred-ideas", async () => {
    if (input.action === "capture") {
      if (!input.file || input.target) throw new Error("Capture requires --file and no --target.");
      const value: unknown = JSON.parse(await readFile(input.file, "utf8"));
      return capture(job, validate(value));
    }
    if (input.file) throw new Error("Only idea capture accepts --file.");
    if ((input.action === "context" || input.action === "placement-context") !== Boolean(input.target)) {
      throw new Error("Context lookup requires exactly one --target canonical record ID.");
    }
    if (input.target && !/^(arc|milestone|event)\.[a-z][a-z0-9-]*$/.test(input.target)) {
      throw new Error("Invalid narrowly scoped Story target ID.");
    }
    const ideas = await load(job);
    const catalog = records(job);
    if (input.action === "inspect") {
      return { status: "ready", audience: "author-only", ideas: ideas.map(idea => ({
        ...idea, assessment: assess(idea, catalog),
      })) };
    }
    if (input.action === "eligibility") {
      return { status: "ready", audience: "scheduler-only", ideas: ideas.map(idea => assess(idea, catalog)) };
    }
    if (input.action === "context" || input.action === "placement-context") {
      const target = catalog.get(input.target!);
      const upstreamConstraints = target ? ideas.flatMap(idea =>
        idea.upstreamConstraints.filter(c => c.authorized && c.targets.includes(target.id))
          .map(c => ({ ideaId: idea.id, text: c.text, target: target.id }))) : [];
      // Ordinary writer context never receives dormant/eligible idea originals.
      // Only a distinct, explicit placement interface can see eligible content,
      // and only for a matching in-scope Event/Milestone/Arc at its permitted depth.
      const selected = input.action === "placement-context" && target
        ? ideas.filter(idea => assess(idea, catalog).eligible && contextMatch(idea, target, catalog) &&
            (idea.placement.earliest === "architecture" ||
             idea.placement.earliest === "milestone" && target.type !== "arc" ||
             idea.placement.earliest === "event" && target.type === "event"))
        : [];
      return { status: "ready", audience: input.action === "context" ? "ordinary-worker" : "placement-specialist",
        target: input.target, ideas: selected, upstreamConstraints };
    }
    throw new Error("Unknown idea action.");
  });
}
