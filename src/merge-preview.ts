import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { startStoryJob, type JobStartResult } from "./job.js";
import { loadSkillConfig } from "./skills.js";
import { createSkillSnapshot } from "./snapshot.js";
import { preflightPiAssignment } from "./job-pi-policy.js";
import { reviewNarrative, type EditorialVerdict, type ReviewAssignment } from "./narrative-review-specialist.js";
import { validateStoryJob, type ValidationResult } from "./validator.js";

export interface MergePreviewOptions {
  story: string;
  job: string;
  fixture?: boolean;
  validatorSource?: string;
  skillsSource?: string;
  provider?: string;
  model?: string;
  thinking?: "low" | "high";
}
interface RecordConflict {
  path: string;
  ids: string[];
  summary: string;
  evidence: string[];
  uncertainty: string;
  options: string[];
}
interface ValidationPreview {
  status: "passed" | "rejected" | "unverified" | "error" | "not-run";
  diagnostics: unknown[];
  protectedDecisions: unknown[];
  results?: Array<{ baseline: "target" | "generation"; status: ValidationResult["status"]; report?: unknown; error?: string }>;
  reason?: string;
}
const reconciliationOptions = [
  "Retain the target's established canon; propose bounded edits to the generation branch for separate author review.",
  "Retain the generated direction only after explicit author review of affected records and protected decisions.",
  "Defer integration and request an author-approved reconciliation task; never override either branch automatically.",
];
function execGit(cwd: string, args: string[], allowFailure = false) {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX"]) delete env[key];
  const p = spawnSync("git", args, { cwd, env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (p.error || p.signal || (p.status !== 0 && !allowFailure)) {
    throw new Error("Git " + args[0] + " failed: " + (p.error?.message ?? p.stderr?.trim() ?? "unknown error"));
  }
  return { code: p.status, stdout: p.stdout.trim(), stderr: p.stderr.trim() };
}
function git(cwd: string, ...args: string[]) {
  return execGit(cwd, args).stdout;
}
function lines(output: string) {
  return output ? output.split("\n").filter(Boolean) : [];
}
function unique(xs: string[]) { return [...new Set(xs)].sort(); }
function storyPath(job: JobStartResult, path: string) {
  const prefix = job.storyRelativePath ? job.storyRelativePath + "/" : "";
  return prefix ? (path.startsWith(prefix) ? path.slice(prefix.length) : null) : path;
}
function recordsAt(job: JobStartResult, path: string, refs: string[]) {
  const ids = new Set<string>();
  const evidence: string[] = [];
  for (const [i, ref] of refs.entries()) {
    const file = execGit(job.gitRoot, ["show", ref + ":" + path], true);
    if (file.code !== 0) continue;
    const body = file.stdout;
    const first = body.startsWith("---\n") ? (body.slice(4).split("\n---", 1)[0] ?? "") : "";
    const id = first.match(/^id:\s*["']?([a-z][a-z0-9-]*\.[a-z0-9._-]+)/m)?.[1];
    if (id) ids.add(id);
    const edited = body.split("\n").find((line, index) => index > 3 && /motivation|revelation|ending|assum|decision/i.test(line));
    if (edited) evidence.push(["generation base", "target", "generation"][i] + ": " + edited.slice(0, 180));
  }
  return { ids: [...ids].sort(), evidence };
}
function conflict(job: JobStartResult, file: string, refs: string[], text: boolean): RecordConflict {
  const path = storyPath(job, file) ?? file;
  const { ids, evidence } = recordsAt(job, file, refs);
  return {
    path, ids,
    summary: text
      ? "Git cannot combine competing edits to " + (ids.join(", ") || path) + " automatically."
      : "Both target and generation changed " + (ids.join(", ") || path) + "; the text combines, but narrative meaning may not.",
    evidence: [file + " (source from generation base, target and generated revisions)", ...evidence],
    uncertainty: text
      ? "No complete merged Story exists; structural and narrative validation have not been performed."
      : "A clean line-level merge does not establish compatible motivations, Revelations, ending assumptions or decision authority.",
    options: reconciliationOptions,
  };
}
function changes(cwd: string, a: string, b: string, job: JobStartResult) {
  return unique(lines(git(cwd, "diff", "--name-only", a, b, "--", job.storyRelativePath || ".")));
}
function parseValidation(results: Array<{ baseline: "target" | "generation"; result: ValidationResult }>): ValidationPreview {
  const reports = results.map(({ baseline, result }) => ({
    baseline, status: result.status, report: result.report, error: result.error,
  }));
  const diagnostics = results.flatMap(({ baseline, result }) =>
    (Array.isArray(result.report?.diagnostics) ? result.report.diagnostics : [])
      .map(d => ({ baseline, ...(typeof d === "object" && d !== null ? d : { detail: d }) })));
  const protectedDecisions = results.flatMap(({ baseline, result }) => {
    const p = result.report?.protection as { changes?: unknown[]; warnings?: unknown[] } | undefined;
    return [...(p?.changes ?? []), ...(p?.warnings ?? [])].map(evidence => ({ baseline, evidence }));
  });
  const status = results.some(r => r.result.status === "error") ? "error"
    : results.some(r => r.result.status === "rejected") ? "rejected"
      : results.some(r => r.result.status === "unverified") ? "unverified" : "passed";
  return { status, diagnostics, protectedDecisions, results: reports };
}
/** Use the canonical validator's bounded progression witnesses as context;
 * do not synthesize route evidence or treat missing/truncated search as proof. */
function progressionWitnesses(validation: ValidationPreview) {
  const report = validation.results?.find(result => result.baseline === "target")?.report as {
    coverage?: {
      search?: { truncated?: boolean };
      branchProgress?: Array<{ event: string; step: string; branch: string; status: string; witness?: string[] }>;
      milestoneRoutes?: Array<{ id: string; routes: Array<{ alternative: number; status: string; witness?: string[] }> }>;
      puzzleSolutions?: Array<{ id: string; solutions: Array<{ event: string; status: string; clueAccess?: { status?: string } }> }>;
    };
  } | undefined;
  const coverage = report?.coverage;
  return {
    routes: (coverage?.branchProgress ?? []).map(x => ({
      event: x.event, step: x.step, branch: x.branch, status: x.status, witness: x.witness ?? [],
    })),
    milestoneRoutes: (coverage?.milestoneRoutes ?? []).flatMap(x => x.routes.map(route => ({
      milestone: x.id, alternative: route.alternative, status: route.status, witness: route.witness ?? [],
    }))),
    puzzleRoutes: (coverage?.puzzleSolutions ?? []).flatMap(x => x.solutions.map(solution => ({
      puzzle: x.id, event: solution.event, status: solution.status,
      clueAccess: solution.clueAccess?.status ?? "unverified",
    }))),
    uncertainties: [
      ...(!coverage ? ["Canonical progression report is unavailable."] : []),
      ...(coverage?.search?.truncated ? ["Canonical route search was truncated; absence of conflicts is not exhaustive proof."] : []),
    ],
  };
}
function summarizeFindings(job: JobStartResult, refs: string[], validation: ValidationPreview,
  editorial: EditorialVerdict["findings"]): RecordConflict[] {
  const found: RecordConflict[] = [];
  const seen = new Set<string>();
  const add = (path: string, ids: string[], summary: string, evidence: string[], uncertainty: string) => {
    const key = [path, summary].join("|");
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ path, ids: unique(ids), summary, evidence, uncertainty, options: reconciliationOptions });
  };
  for (const item of validation.diagnostics) {
    if (!item || typeof item !== "object") continue;
    const d = item as { path?: string; line?: number; code?: string; message?: string; baseline?: string };
    const path = d.path ?? "(Story catalog)";
    const fullPath = job.storyRelativePath ? job.storyRelativePath + "/" + path : path;
    const record = recordsAt(job, fullPath, refs);
    add(path, record.ids,
      "Combined Story has a " + (d.code ?? "structural") + " problem: " + (d.message ?? "unresolved record dependency"),
      [path + ":" + (d.line ?? 1) + " (" + (d.baseline ?? "catalog") + " comparison)", ...record.evidence],
      "The pinned validator detected this defect; narrative consequences and the correct repair require author review.");
  }
  for (const item of validation.protectedDecisions) {
    if (!item || typeof item !== "object") continue;
    const { baseline, evidence } = item as { baseline: string; evidence: unknown };
    const detail = evidence && typeof evidence === "object" ? evidence as Record<string, unknown> : {};
    const decision = String(detail.decision ?? detail.id ?? detail.code ?? "unidentified decision");
    const id = decision.split("#")[0] ?? decision;
    add("(protected decision)", [id],
      "A protected author decision differs in the " + baseline + " comparison: " + decision,
      [JSON.stringify(evidence).slice(0, 450)],
      "Git and catalog checks cannot grant author consent or determine which protected intent governs.");
  }
  for (const finding of editorial) {
    const path = finding.source.replace(/:[0-9]+$/, "");
    const fullPath = job.storyRelativePath ? job.storyRelativePath + "/" + path : path;
    const record = recordsAt(job, fullPath, refs);
    add(path, record.ids, finding.message,
      [finding.source, ...record.evidence],
      finding.severity + " independent narrative assessment (" + finding.dimension +
        "); not exhaustive proof of every branch or reader interpretation.");
  }
  return found;
}
function reportStatus(validation: ValidationPreview, narrative: { status: string }, reviewedScope: boolean) {
  if (validation.status === "rejected" || narrative.status === "block") return "conflicts-found";
  if (validation.status !== "passed" || narrative.status !== "pass" || !reviewedScope) return "needs-author-review";
  return "compatible-for-author-review"; // A preview is never authorization to merge.
}

/** Read-only preview. Disposable Git worktree is never registered as a branch
 * and is removed even after conflicts, validator errors or reviewer failures. */
export async function previewStoryMerge(input: MergePreviewOptions) {
  const job = await startStoryJob({ story: input.story, job: input.job }, false);
  const generationHead = git(job.worktreeRoot, "rev-parse", "HEAD");
  if (generationHead !== job.headSha ||
      git(job.worktreeRoot, "status", "--porcelain=v1", "--untracked-files=all")) {
    throw new Error("Merge preview requires a clean, committed generation branch; preserve unfinished writer changes.");
  }
  const targetHead = git(job.gitRoot, "rev-parse", "HEAD");
  const targetBranch = execGit(job.gitRoot,
    ["symbolic-ref", "--quiet", "--short", "HEAD"], true).stdout || "(detached HEAD)";
  const common = git(job.gitRoot, "merge-base", generationHead, targetHead);
  const drift = changes(job.gitRoot, job.baseSha, targetHead, job);
  const generated = changes(job.gitRoot, job.baseSha, generationHead, job);
  const targetChanges = new Set(drift);
  const overlaps = generated.filter(file => targetChanges.has(file));
  const dirtyTarget = lines(git(job.gitRoot, "status", "--porcelain=v1", "--untracked-files=all", "--", job.storyRelativePath || "."));
  // A clean commit alone does not establish completion of the requested scope.
  const reviewBytes = await readFile(join(dirname(job.worktreeRoot), "narrative-review.json"), "utf8")
    .catch(() => undefined);
  let reviewedScope = false;
  if (reviewBytes) {
    try {
      const review = JSON.parse(reviewBytes) as Record<string, unknown>;
      reviewedScope = review.version === 1 && review.jobId === job.jobId &&
        review.branch === job.branch && review.headSha === generationHead && review.phase === "completed";
    } catch { /* Unreadable review evidence never implies completion. */ }
  }
  const base = {
    contract: "noveltea-merge-preview/v1",
    generation: { branch: job.branch, base: job.baseSha, head: generationHead,
      scopedCompletionReview: reviewedScope ? "verified-current-head" : "absent-or-stale",
      changes: generated.map(path => storyPath(job, path) ?? path) },
    target: { branch: targetBranch, head: targetHead, mergeBase: common,
      divergedFromGenerationBase: targetHead !== job.baseSha,
      drift: drift.map(path => storyPath(job, path) ?? path),
      uncommittedStoryChangesIgnored: dirtyTarget },
  };
  const scratch = await mkdtemp(join(tmpdir(), "nt-merge-preview-"));
  const candidateRoot = join(scratch, "candidate");
  let added = false;
  try {
    git(job.gitRoot, "-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", candidateRoot, targetHead);
    added = true;
    const merge = execGit(candidateRoot,
      ["-c", "core.hooksPath=/dev/null", "merge", "--no-commit", "--no-ff", generationHead], true);
    const unresolved = lines(git(candidateRoot, "diff", "--name-only", "--diff-filter=U"));
    if (merge.code !== 0 || unresolved.length) {
      const conflicts = unresolved.map(path => conflict(job, path,
        [job.baseSha, targetHead, generationHead], true));
      if (!conflicts.length) {
        conflicts.push({ path: "(Git merge)", ids: [], summary: "Git could not construct the candidate merge.",
          evidence: [merge.stderr], uncertainty: "Merged Story does not exist.",
          options: reconciliationOptions });
      }
      return { ...base, status: "conflicts-found",
        candidate: { status: unresolved.length ? "text-conflicts" as const : "merge-unavailable" as const, conflicts },
        validation: { status: "not-run" as const, diagnostics: [], protectedDecisions: [],
          reason: unresolved.length ? "Textual conflicts prevented a complete candidate Story."
            : "Git could not construct a candidate Story." },
        narrative: { status: "not-run" as const, risks: [], findings: [],
          reason: "No complete candidate exists; narrative consistency cannot be certified." } };
    }
    const affected = unique(lines(git(candidateRoot, "diff", "--cached", "--name-only", "--", job.storyRelativePath || ".")));
    const risks = overlaps.map(path => conflict(job, path, [job.baseSha, targetHead, generationHead], false));
    const candidate = { status: "constructed" as const, affected: affected.map(path => ({
      path: storyPath(job, path) ?? path,
      ids: recordsAt(job, path, [job.baseSha, targetHead, generationHead]).ids,
    })), conflicts: [] };
    let validation: ValidationPreview;
    try {
      const config = await loadSkillConfig(undefined, false);
      const source = input.validatorSource ?? input.skillsSource ?? config.novelteaSkills;
      const view = { worktreeRoot: candidateRoot, worktreeStoryRoot: join(candidateRoot, job.storyRelativePath) };
      // First call may publish the immutable validator pin. Serialize it to
      // avoid racing a second first-use pin against the same job manifest.
      const fromTarget = await validateStoryJob(job, source, { ...view, baseSha: targetHead });
      // Reload the manifest after first-use pinning; the original job object
      // intentionally cannot observe the newly published immutable pin.
      const refreshed = await startStoryJob({ story: input.story, job: input.job }, false);
      const fromGeneration = await validateStoryJob(refreshed, source, { ...view, baseSha: generationHead });
      validation = parseValidation([{ baseline: "target", result: fromTarget },
        { baseline: "generation", result: fromGeneration }]);
    } catch (error) {
      validation = { status: "error", diagnostics: [], protectedDecisions: [],
        reason: error instanceof Error ? error.message : String(error) };
    }
    const narrative: { status: "unverified" | "pass" | "block" | "error";
      risks: RecordConflict[]; findings: EditorialVerdict["findings"];
      evidence?: string[]; sessionFile?: string; reason?: string } =
      { status: "unverified", risks, findings: [],
        reason: "Deterministic checks cannot certify Character motivations, Revelation validity or ending assumptions." };
    if (!input.fixture) {
      try {
        const config = input.skillsSource
          ? { discovery: "explicit-only" as const, novelteaSkills: input.skillsSource, skillDirs: [], requiredSkills: [] }
          : await loadSkillConfig(undefined, false);
        const snapshot = await createSkillSnapshot({ ...config,
          requiredSkills: ["nt-narrative-review", "nt-catalog"] });
        if (!snapshot) throw new Error("Independent integration review requires a NovelTea skills checkout.");
        const candidateId = createHash("sha256").update(targetHead + generationHead).digest("hex");
        const paths = unique(lines(git(candidateRoot, "ls-files", "--", job.storyRelativePath || "."))
          .map(path => storyPath(job, path)).filter((path): path is string =>
            path !== null && path.endsWith(".md") && !path.startsWith(".story-inbox/") &&
            !path.split("/").some(segment => segment.startsWith("."))));
        const progression = progressionWitnesses(validation);
        const assignment: ReviewAssignment = {
          contract: { kind: "merge-preview", base: job.baseSha, targetHead, generationHead,
            overlapRisks: risks, affected: candidate.affected },
          planVersion: 0, scopeIds: candidate.affected.flatMap(x => x.ids), paths,
          routes: progression.routes, milestoneRoutes: progression.milestoneRoutes,
          puzzleRoutes: progression.puzzleRoutes, outstanding: [],
          uncertainties: ["No inference about branch compatibility from Git merge alone.",
            ...progression.uncertainties],
          integration: { base: job.baseSha, targetHead, generationHead, risks },
        };
        const viewedJob = { ...job, headSha: candidateId,
          worktreeStoryRoot: join(candidateRoot, job.storyRelativePath) };
        await preflightPiAssignment(job, "narrative-review:0:" + candidateId,
          { provider: input.provider ?? "openai", model: input.model ?? "gpt-6-luna", thinking: input.thinking });
        const editorial = await reviewNarrative(viewedJob, snapshot, assignment,
          input.provider ?? "openai", input.model ?? "gpt-6-luna", input.thinking, async () => {});
        narrative.status = editorial.verdict;
        narrative.findings = editorial.findings;
        narrative.evidence = editorial.evidence;
        narrative.sessionFile = editorial.sessionFile;
        narrative.reason = editorial.verdict === "pass"
          ? "Read-only independent reviewer found no narrative contradiction in the supplied evidence; this is not automatic merge approval."
          : "Read-only independent reviewer found source-linked narrative conflicts requiring author reconciliation.";
      } catch (error) {
        narrative.status = "error";
        narrative.reason = "Independent narrative review could not complete: " +
          (error instanceof Error ? error.message : String(error));
      }
    }
    const issues = summarizeFindings(job, [job.baseSha, targetHead, generationHead], validation,
      narrative.findings);
    return { ...base, status: reportStatus(validation, narrative, reviewedScope), candidate, validation, narrative,
      issues: [...risks, ...issues],
      reconciliation: { automaticMerge: false, required: "Explicit author-approved reconciliation task for any generation branch modifications.",
        options: reconciliationOptions } };
  } finally {
    if (added) {
      const removed = execGit(job.gitRoot, ["worktree", "remove", "--force", candidateRoot], true);
      if (removed.code !== 0) throw new Error("Could not remove disposable merge candidate: " + removed.stderr);
    }
    await rm(scratch, { recursive: true, force: true });
  }
}
