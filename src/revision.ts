import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { startStoryJob, type JobStartResult } from "./job.js";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { validateStoryJob, type ValidationResult } from "./validator.js";

/** Author authorization is a separate CLI action: never model output, a
 * validator acknowledgement flag, or the mere presence of a Git commit. */
const AUTHOR = "NovelTea Generator";
const AUTHOR_EMAIL = "noveltea-gen@users.noreply.github.com";
const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const HASH = /^[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40,64}$/;

type ReviewVerdict = "pass" | "block";
interface ProtectedDelta {
  id: string;
  base: string;
  decision: string;
  kind: string;
  path: string;
  previousPath: string;
  before: unknown;
  after?: unknown;
}
interface ApprovalEvidence {
  id: string;
  changeId: string;
  proposalSha256: string;
  decision: string;
  before: unknown;
  after?: unknown;
  action: "approved" | "rejected";
  reason: string;
  source: "explicit-author-cli";
  recordedAt: string;
}
interface EditorialEvidence {
  verdict: ReviewVerdict;
  source: "independent-author-review";
  proposalSha256: string;
  path: string;
  evidence: string;
  notes: string;
  recordedAt: string;
}
interface RevisionReceipt {
  version: 1;
  jobId: string;
  workItemId: string;
  target: string;
  baseSha: string;
  verifiedHead: string;
  proposalSha256: string;
  authoredFileSha256: string;
  validatorSha256: string;
  changes: ProtectedDelta[];
  affected: unknown[];
  approvals: ApprovalEvidence[];
  editorial?: EditorialEvidence;
  status: "proposed" | "committed";
  commitSha?: string;
}
interface VerifiedHead {
  version: 1;
  jobId: string;
  headSha: string;
  workItemId: string;
}
export interface RevisionOptions {
  story: string;
  job: string;
  workItem: string;
  action: "inspect" | "authorize" | "review" | "commit" | "status";
  path?: string;
  proposal?: string;
  change?: string;
  decision?: "approve" | "reject";
  reason?: string;
  verdict?: ReviewVerdict;
  evidence?: string;
  notes?: string;
  validatorSource?: string;
}

function sha(text: string | Buffer) { return createHash("sha256").update(text).digest("hex"); }
function gitRaw(job: JobStartResult, ...args: string[]) {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX"]) delete env[key];
  try {
    return execFileSync("git", args, { cwd: job.worktreeRoot, env, encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch (cause) {
    const err = cause as Error & { stderr?: Buffer | string };
    throw new Error(`Revision Git ${args[0]} failed: ${String(err.stderr || err.message).trim()}`);
  }
}
function git(job: JobStartResult, ...args: string[]) {
  return gitRaw(job, ...args).trim();
}
function inside(root: string, file: string) {
  const rel = relative(root, file);
  return rel !== "" && rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
}
function targetSpec(job: JobStartResult, target: string) {
  return job.storyRelativePath ? job.storyRelativePath + "/" + target : target;
}
function receiptFile(job: JobStartResult, id: string) {
  return join(dirname(job.worktreeRoot), "revisions", id + ".json");
}
function headFile(job: JobStartResult) {
  return join(dirname(job.worktreeRoot), "revisions", "verified-head.json");
}
async function persist(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
async function readReceipt(job: JobStartResult, id: string): Promise<RevisionReceipt | undefined> {
  const path = receiptFile(job, id);
  if (!existsSync(path)) return;
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Revision receipt is not a regular file.");
  const data = JSON.parse(await readFile(path, "utf8")) as RevisionReceipt;
  if (data.version !== 1 || data.jobId !== job.jobId || data.workItemId !== id ||
      data.baseSha !== job.baseSha || !SHA.test(data.verifiedHead) ||
      !HASH.test(data.proposalSha256) || !HASH.test(data.authoredFileSha256) ||
      !HASH.test(data.validatorSha256) || !Array.isArray(data.changes) ||
      !Array.isArray(data.approvals) || !Array.isArray(data.affected) ||
      !["proposed", "committed"].includes(data.status) ||
      (data.status === "committed" && (!data.commitSha || !SHA.test(data.commitSha)))) {
    throw new Error("Stored revision receipt is invalid; restore it before proceeding.");
  }
  return data;
}
async function trustedHead(job: JobStartResult) {
  const head = headFile(job);
  if (existsSync(head)) {
    const record = JSON.parse(await readFile(head, "utf8")) as VerifiedHead;
    if (record.version !== 1 || record.jobId !== job.jobId || !SHA.test(record.headSha)) {
      throw new Error("Verified-head receipt is invalid.");
    }
    if (git(job, "rev-parse", "HEAD") !== record.headSha) {
      throw new Error("Job branch HEAD differs from the latest verified revision; reconcile it before continuing.");
    }
    return record.headSha;
  }
  const initial = join(dirname(job.worktreeRoot), "foundation.json");
  if (existsSync(initial)) {
    const data = JSON.parse(await readFile(initial, "utf8")) as { stage?: string; commitSha?: string };
    if (data.stage !== "committed" || !data.commitSha || !SHA.test(data.commitSha)) {
      throw new Error("Foundation work item is unfinished; finish or reconcile it before revision.");
    }
    if (git(job, "rev-parse", "HEAD") !== data.commitSha) {
      throw new Error("Job branch differs from the last verified foundation commit.");
    }
    return data.commitSha;
  }
  if (git(job, "rev-parse", "HEAD") !== job.baseSha) {
    throw new Error("Job branch advanced without a trusted revision receipt; refusing to use moving HEAD.");
  }
  return job.baseSha;
}
function requirePath(job: JobStartResult, input: string) {
  if (!input || input.startsWith("/") || input.includes("\\") || input.split("/").some(c => c === "." || c === ".." || !c) ||
      !input.endsWith(".md") || input.startsWith(".") || !/^[A-Za-z0-9_./-]+$/.test(input)) {
    throw new Error("Revision --path must be a normal relative canonical Story Markdown path.");
  }
  const file = resolve(job.worktreeStoryRoot, input);
  if (!inside(job.worktreeStoryRoot, file)) throw new Error("Revision path escapes selected Story.");
  return input;
}
async function candidateFile(job: JobStartResult, target: string) {
  const full = join(job.worktreeStoryRoot, target);
  const info = await lstat(full);
  if (!info.isFile() || info.isSymbolicLink() || await realpath(full) !== full ||
      !inside(job.worktreeStoryRoot, full)) throw new Error("Revision target must be a regular Story Markdown file.");
  return full;
}
function statusEntries(job: JobStartResult) {
  const data = gitRaw(job, "status", "--porcelain=v1", "-z", "--untracked-files=all");
  return data.split("\0").filter(Boolean).map(entry => ({
    state: entry.slice(0, 2), path: entry.slice(3),
  }));
}
function changedStatus(job: JobStartResult, target: string) {
  const entries = statusEntries(job);
  if (entries.some(e => e.state !== " M" && e.state !== "??")) {
    throw new Error("Unexpected staged, deleted, conflicted, renamed or copied files; resolve before a revision.");
  }
  const selected = targetSpec(job, target);
  if (!entries.some(e => e.path === selected && e.state === " M")) {
    throw new Error("Revision requires an unstaged modification to the existing target Markdown file.");
  }
  return entries.filter(e => e.path !== selected).map(e => e.path);
}
function proposedDigest(job: JobStartResult, target: string, head: string, content: Buffer) {
  return sha(JSON.stringify([job.jobId, target, job.baseSha, head, sha(content)]));
}
function report(result: ValidationResult, base: string, allowEmptyOriginal: boolean) {
  const data = result.report as {
    diagnostics?: unknown[];
    protection?: { status?: string; base?: string; changes?: Array<{
      decision: string; path: string; previousPath: string; kind: string;
      before: unknown; after?: unknown; acknowledged?: boolean
    }>; impact?: { affected?: unknown[] } };
  } | undefined;
  if (!data || !Array.isArray(data.diagnostics) || data.diagnostics.length ||
      !data.protection || !Array.isArray(data.protection.changes)) {
    throw new Error("Canonical structural validation failed or returned an invalid report: " +
      JSON.stringify({ status: result.status, diagnostics: data?.diagnostics, error: result.error }).slice(0, 4000));
  }
  if (allowEmptyOriginal && result.status === "unverified") {
    if (!data.protection || !["no-baseline", "checked"].includes(data.protection.status || "")) {
      throw new Error("Empty original baseline returned an unexpected protection report.");
    }
    return { changes: [] as ProtectedDelta[], affected: data.protection.impact?.affected ?? [] };
  }
  if (data.protection.status !== "checked" || data.protection.base !== base ||
      !["passed", "rejected"].includes(result.status)) {
    throw new Error("Canonical protection could not verify the exact trusted baseline: " + base);
  }
  return {
    changes: data.protection.changes.map(c => {
      if (!c.decision || !c.kind || !c.path || !c.before) {
        throw new Error("Canonical protected-change metadata is incomplete.");
      }
      return {
        id: sha(JSON.stringify([base, c.decision, c.kind, c.path, c.previousPath, c.before, c.after ?? null])),
        base, decision: c.decision, kind: c.kind, path: c.path,
        previousPath: c.previousPath, before: c.before, ...(c.after === undefined ? {} : { after: c.after }),
      };
    }),
    affected: data.protection.impact?.affected ?? [],
  };
}
/** Canonical reports already validate the schema. Project only the decision
 * identity/authority needed for additions and authority promotions; this is
 * not a second YAML parser or schema. */
function newlyProtected(beforeReport: ValidationResult, afterReport: ValidationResult,
  head: string): ProtectedDelta[] {
  type Item = { metadata: { id: string; decisions: Array<{
    id: string; statement: string; origin: string; authority: string
  }> }; path: string };
  const before = ((beforeReport.report as { records?: Item[] } | undefined)?.records ?? []);
  const after = ((afterReport.report as { records?: Item[] } | undefined)?.records ?? []);
  const prior = new Map(before.flatMap(r => r.metadata.decisions.map(d =>
    [r.metadata.id + "#" + d.id, d] as const)));
  const changes: ProtectedDelta[] = [];
  for (const record of after) for (const decision of record.metadata.decisions) {
    if (decision.authority !== "user-protected") continue;
    const key = record.metadata.id + "#" + decision.id;
    const old = prior.get(key);
    if (old?.authority === "user-protected") continue;
    const kind = old ? "adopted-protection" : "new-protected";
    changes.push({
      id: sha(JSON.stringify([head, key, kind, record.path, old ?? null, decision])),
      base: head, decision: key, kind, path: record.path,
      previousPath: record.path, before: old ?? null, after: decision,
    });
  }
  return changes;
}
function baselineEmpty(job: JobStartResult) {
  const output = git(job, "ls-tree", "-r", "--name-only", job.baseSha, "--",
    job.storyRelativePath || ".");
  return !output.split("\n").some(path => path.endsWith(".md"));
}
async function withCandidate<T>(job: JobStartResult, head: string, target: string,
  content: Buffer, work: (view: { worktreeRoot: string; worktreeStoryRoot: string }) => Promise<T>): Promise<T> {
  const parent = await mkdtemp(join(tmpdir(), "noveltea-revision-"));
  const worktree = join(parent, "candidate");
  let added = false;
  try {
    git(job, "worktree", "add", "--detach", worktree, head);
    added = true;
    const dest = join(worktree, job.storyRelativePath, target);
    await mkdir(dirname(dest), { recursive: true });
    // The candidate is an exact immutable byte snapshot of the reviewed
    // working file, not another live read racing an external editor.
    await writeFile(dest, content);
    return await work({ worktreeRoot: worktree,
      worktreeStoryRoot: join(worktree, job.storyRelativePath) });
  } finally {
    if (added) git(job, "worktree", "remove", "--force", worktree);
    await rm(parent, { recursive: true, force: true });
  }
}
async function inspectProposal(job: JobStartResult, target: string, head: string, source?: string) {
  const content = await readFile(await candidateFile(job, target));
  const proposalSha256 = proposedDigest(job, target, head, content);
  const empty = baselineEmpty(job);
  const out = await withCandidate(job, head, target, content, async view => {
    const original = await validateStoryJob(job, source, { ...view, baseSha: job.baseSha });
    // First validation may have pinned the executable into job.json. Reopen
    // its durable identity before subsequent comparisons in this same call.
    const pinnedJob = await startStoryJob({ story: job.storyRoot, job: job.jobId }, false);
    const last = head === job.baseSha ? original :
      await validateStoryJob(pinnedJob, source, { ...view, baseSha: head });
    const initial = report(original, job.baseSha, empty);
    const latest = head === job.baseSha ? { changes: [] as ProtectedDelta[], affected: [] } :
      report(last, head, false);
    const trustedPath = targetSpec(job, target);
    // Use the same sanitized Git environment as every other operation;
    // inherited GIT_DIR/GIT_INDEX_FILE must not redirect this restore.
    git(job, "-C", view.worktreeRoot, "restore", "--source=HEAD",
      "--worktree", "--", trustedPath);
    const pristine = await validateStoryJob(pinnedJob, source, { ...view, baseSha: head });
    if (pristine.status !== "passed" || !pristine.report ||
        (pristine.report.diagnostics as unknown[]).length) {
      throw new Error("Cannot inspect newly protected decisions against the latest verified Story.");
    }
    const adopted = newlyProtected(pristine, last, head);
    const combined = new Map([...initial.changes, ...latest.changes, ...adopted].map(c => [c.id, c]));
    return {
      changes: [...combined.values()].sort((a,b) => a.decision.localeCompare(b.decision) || a.base.localeCompare(b.base)),
      affected: [...initial.affected, ...latest.affected],
      validatorSha256: original.validator.sha256,
    };
  });
  return { proposalSha256, authoredFileSha256: sha(content), ...out };
}
function validateCurrent(receipt: RevisionReceipt, expected: string, head: string) {
  if (receipt.status !== "proposed" || receipt.proposalSha256 !== expected ||
      receipt.verifiedHead !== head) {
    throw new Error("Revision proposal or verified HEAD changed; create a new work-item proposal.");
  }
}
function publicStatus(receipt: RevisionReceipt, unrelated: string[] = []) {
  const approved = new Set(receipt.approvals.filter(a => a.action === "approved").map(a => a.changeId));
  const denied = new Set(receipt.approvals.filter(a => a.action === "rejected").map(a => a.changeId));
  return {
    status: receipt.status, jobId: receipt.jobId, workItemId: receipt.workItemId,
    target: receipt.target, verifiedHead: receipt.verifiedHead, proposalSha256: receipt.proposalSha256,
    protectedChanges: receipt.changes.map(c => ({
      ...c, authorization: denied.has(c.id) ? "rejected" : approved.has(c.id) ? "approved" : "pending",
    })),
    authorApprovals: receipt.approvals,
    editorialReview: receipt.editorial ?? { verdict: "pending", required: true },
    affectedRecords: receipt.affected, unrelatedUncommittedPaths: unrelated,
    commitSha: receipt.commitSha,
  };
}
function assertAuthorReviewed(revision: RevisionReceipt) {
  if (revision.editorial?.verdict !== "pass" ||
      revision.editorial.proposalSha256 !== revision.proposalSha256 ||
      revision.editorial.source !== "independent-author-review") {
    throw new Error("Independent, source-linked prose/semantic review has not passed; commit blocked.");
  }
  if (revision.changes.some(c => !revision.approvals.some(a =>
      a.changeId === c.id && a.action === "approved" &&
      a.decision === c.decision && a.proposalSha256 === revision.proposalSha256 &&
      a.source === "explicit-author-cli" &&
      JSON.stringify(a.before) === JSON.stringify(c.before) &&
      JSON.stringify(a.after ?? null) === JSON.stringify(c.after ?? null)))) {
    throw new Error("One or more protected decisions lack exact explicit author authorization; commit blocked.");
  }
}
async function recoverCommitted(job: JobStartResult, receipt: RevisionReceipt) {
  const head = git(job, "rev-parse", "HEAD");
  if (receipt.status === "committed") {
    // Old completed receipts are historical facts, not proposals to replay.
    // The job may have advanced through arbitrarily many later verified items.
    assertAuthorReviewed(receipt);
    git(job, "merge-base", "--is-ancestor", receipt.commitSha!, head);
    const blob = gitRaw(job, "show", receipt.commitSha! + ":" + targetSpec(job, receipt.target));
    if (sha(blob) !== receipt.authoredFileSha256) {
      throw new Error("Previously committed revision no longer matches its recorded Story bytes.");
    }
    if (head === receipt.commitSha && !existsSync(headFile(job))) {
      await persist(headFile(job), { version: 1, jobId: job.jobId,
        headSha: head, workItemId: receipt.workItemId } satisfies VerifiedHead);
    }
    return true;
  }
  if (head === receipt.verifiedHead) return false;
  // A matching Git message alone is not human authorization. Check the
  // durable approvals before attempting interrupted-commit recovery.
  assertAuthorReviewed(receipt);
  if (git(job, "rev-parse", "HEAD^") !== receipt.verifiedHead ||
      !git(job, "log", "-1", "--format=%B").includes(
        `NovelTea-Job: ${job.jobId}\nNovelTea-Work-Item: ${receipt.workItemId}\nNovelTea-Proposal: ${receipt.proposalSha256}`)) {
    throw new Error("Unexpected job HEAD; revision cannot be recovered.");
  }
  const changed = git(job, "diff-tree", "--no-commit-id", "--name-only", "-r", head);
  if (changed !== targetSpec(job, receipt.target) ||
      sha(gitRaw(job, "show", head + ":" + changed)) !== receipt.authoredFileSha256 ||
      sha(await readFile(await candidateFile(job, receipt.target))) !== receipt.authoredFileSha256) {
    throw new Error("Recovered revision commit does not match the authorized target content.");
  }
  receipt.status = "committed";
  receipt.commitSha = head;
  await persist(receiptFile(job, receipt.workItemId), receipt);
  await persist(headFile(job), { version: 1, jobId: job.jobId,
    headSha: head, workItemId: receipt.workItemId } satisfies VerifiedHead);
  return true;
}

/** Git publication is a graph node, separate from the approval/review gate
 * and the Pi writer. No CLI flag or model text can short-circuit this node. */
async function commitRevisionGraph(job: JobStartResult, receipt: RevisionReceipt,
  head: string): Promise<RevisionReceipt> {
  const Channels = Annotation.Root({ revision: Annotation<RevisionReceipt>() });
  const graph = new StateGraph(Channels)
    .addNode("check_authorization", async ({ revision }) => {
      assertAuthorReviewed(revision);
      if (git(job, "rev-parse", "HEAD") !== head ||
          sha(await readFile(await candidateFile(job, revision.target))) !== revision.authoredFileSha256) {
        throw new Error("Revision target or Git HEAD changed while validating; no commit made.");
      }
      changedStatus(job, revision.target);
      return {};
    })
    .addNode("commit_verified_revision", async ({ revision }) => {
      // Repeat filesystem, index and branch checks at the actual side-effect
      // boundary, rather than trusting checks before the graph transition.
      changedStatus(job, revision.target);
      if (git(job, "rev-parse", "HEAD") !== head ||
          sha(await readFile(await candidateFile(job, revision.target))) !== revision.authoredFileSha256) {
        throw new Error("Revision target or Git HEAD changed before commit.");
      }
      const changed = targetSpec(job, revision.target);
      git(job, "-c", `user.name=${AUTHOR}`, "-c", `user.email=${AUTHOR_EMAIL}`,
        "commit", "--only", "-m",
        `Revise protected Story [${job.jobId}/${revision.workItemId}]\n\nNovelTea-Job: ${job.jobId}\nNovelTea-Work-Item: ${revision.workItemId}\nNovelTea-Proposal: ${revision.proposalSha256}\nNovelTea-Approvals: ${revision.approvals.map(a => a.id).join(",") || "none"}\nNovelTea-Editorial-Review: source-linked`,
        "--", changed);
      const commitSha = git(job, "rev-parse", "HEAD");
      if (sha(Buffer.from(gitRaw(job, "show", commitSha + ":" + changed))) !== revision.authoredFileSha256) {
        throw new Error("Committed Story bytes differ from the approved proposal; preserve the commit for inspection.");
      }
      if (git(job, "diff-tree", "--no-commit-id", "--name-only", "-r", commitSha) !== changed) {
        throw new Error("Committed revision affected an unexpected path; preserve history for inspection.");
      }
      const updated: RevisionReceipt = { ...revision, status: "committed", commitSha };
      await persist(receiptFile(job, revision.workItemId), updated);
      await persist(headFile(job), { version: 1, jobId: job.jobId,
        headSha: commitSha, workItemId: revision.workItemId } satisfies VerifiedHead);
      return { revision: updated };
    })
    .addEdge(START, "check_authorization")
    .addEdge("check_authorization", "commit_verified_revision")
    .addEdge("commit_verified_revision", END).compile();
  return (await graph.invoke({ revision: receipt })).revision;
}

export async function runRevisionAction(input: RevisionOptions) {
  if (!ID.test(input.workItem) || input.workItem === "verified-head") {
    throw new Error("--work-item must be a lowercase hyphenated identifier.");
  }
  const job = await startStoryJob({ story: input.story, job: input.job }, false);
  const lock = join(dirname(job.worktreeRoot), ".revision-running");
  try { await mkdir(lock); }
  catch { throw new Error("Another revision operation is active or was interrupted; inspect its lock."); }
  try {
    let receipt = await readReceipt(job, input.workItem);
    if (receipt && await recoverCommitted(job, receipt)) return publicStatus(receipt);
    const head = await trustedHead(job);
    if (input.action === "inspect") {
      const target = receipt?.target ?? requirePath(job, input.path || "");
      if (input.path && input.path !== target) throw new Error("Revision target differs from existing work item.");
      const unrelated = changedStatus(job, target);
      const proposal = await inspectProposal(job, target, head, input.validatorSource);
      if (receipt) {
        validateCurrent(receipt, proposal.proposalSha256, head);
        if (receipt.authoredFileSha256 !== proposal.authoredFileSha256 ||
            receipt.validatorSha256 !== proposal.validatorSha256 ||
            JSON.stringify(receipt.changes) !== JSON.stringify(proposal.changes)) {
          throw new Error("Existing proposal evidence changed; new work-item ID required.");
        }
      } else {
        receipt = {
          version: 1, jobId: job.jobId, workItemId: input.workItem,
          target, baseSha: job.baseSha, verifiedHead: head,
          ...proposal, approvals: [], status: "proposed",
        };
        await persist(receiptFile(job, input.workItem), receipt);
      }
      return { ...publicStatus(receipt, unrelated),
        patch: gitRaw(job, "diff", "--no-ext-diff", "--", targetSpec(job, target)),
      };
    }
    if (!receipt) throw new Error("No revision proposal; run 'job revision inspect' first.");
    if (receipt.status === "committed") return publicStatus(receipt);
    if (!input.proposal || input.proposal !== receipt.proposalSha256) {
      throw new Error("Exact --proposal <sha256> is required; the proposed content cannot be approved implicitly.");
    }
    const unrelated = changedStatus(job, receipt.target);
    const current = await inspectProposal(job, receipt.target, head, input.validatorSource);
    validateCurrent(receipt, current.proposalSha256, head);
    if (JSON.stringify(current.changes) !== JSON.stringify(receipt.changes) ||
        current.validatorSha256 !== receipt.validatorSha256) {
      throw new Error("Canonical protected changes or pinned validator differ from the reviewed proposal.");
    }
    if (input.action === "status") return publicStatus(receipt, unrelated);
    if (input.action === "authorize") {
      const change = receipt.changes.find(c => c.id === input.change);
      if (!change || !input.reason?.trim() || input.reason.trim().length < 12 ||
          !["approve", "reject"].includes(input.decision || "")) {
        throw new Error("Author approval requires an exact protected --change, --decision approve|reject, and substantive --reason.");
      }
      if (receipt.approvals.some(a => a.changeId === change.id)) {
        throw new Error("Protected-change decision already recorded; use a new work item for a revised proposal.");
      }
      receipt.approvals.push({
        id: randomUUID(), changeId: change.id, proposalSha256: receipt.proposalSha256,
        decision: change.decision, before: change.before, after: change.after,
        action: input.decision === "approve" ? "approved" : "rejected",
        reason: input.reason.trim(), source: "explicit-author-cli", recordedAt: new Date().toISOString(),
      });
      await persist(receiptFile(job, input.workItem), receipt);
      return publicStatus(receipt, unrelated);
    }
    if (input.action === "review") {
      if (!["pass", "block"].includes(input.verdict || "") ||
          !input.notes?.trim() || input.notes.trim().length < 20 ||
          !input.evidence?.startsWith(receipt.target + ":") ||
          !/^[0-9]+(?:-[0-9]+)?$/.test(input.evidence.slice(receipt.target.length + 1))) {
        throw new Error("Independent prose review requires --verdict pass|block, substantive --notes, and --evidence citing the changed Story file.");
      }
      if (receipt.editorial) throw new Error("Editorial review already recorded; use a new work-item proposal.");
      receipt.editorial = {
        verdict: input.verdict!, source: "independent-author-review", path: receipt.target,
        proposalSha256: receipt.proposalSha256, evidence: input.evidence,
        notes: input.notes.trim(), recordedAt: new Date().toISOString(),
      };
      await persist(receiptFile(job, input.workItem), receipt);
      return publicStatus(receipt, unrelated);
    }
    if (input.action !== "commit") throw new Error("Unknown revision operation.");
    return publicStatus(await commitRevisionGraph(job, receipt, head), unrelated);
  } finally {
    await rmdir(lock).catch(() => {});
  }
}
