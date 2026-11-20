/** Shared source-grounded convergence diagnosis for both corrective owner loops.
 * The independent reviewer judges meaning; this controller validates that
 * cited new evidence actually came from the latest signed Git revision. */
import { execFileSync } from "./git-read-cache.js";
import type { JobStartResult } from "./job.js";

export interface EditorialRepairDiagnosis {
  status: "material" | "stalled" | "uncertain";
  reason: string;
  /** Required only for material progress. An actual added canonical line. */
  evidence: { path: string; quote: string } | null;
}
export interface EditorialRepairProgress {
  previousSha: string;
  currentSha: string;
  priorFindings: Array<{ severity: string; source: string; message: string }>;
  added: Array<{ path: string; line: string }>;
}
const SHA = /^[a-f0-9]{40}$/;
function git(job: JobStartResult, ...args: string[]) {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_PREFIX"])
    delete env[key];
  return execFileSync("git", args, { cwd: job.worktreeRoot, env,
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 4 * 1024 * 1024 });
}
export function repairProgressScope(job: JobStartResult, previousSha: string,
  currentSha: string, paths: string[],
  findings: Array<{ severity: string; source: string; message: string }>): EditorialRepairProgress {
  if (!SHA.test(previousSha) || !SHA.test(currentSha) || previousSha === currentSha ||
      !paths.length || paths.length > 24 || new Set(paths).size !== paths.length ||
      paths.some(path => !/^[a-z][a-z-]*\/[a-z0-9-]+\.md$/.test(path)))
    throw Error("Editorial convergence needs an exact bounded canonical source transition.");
  git(job, "merge-base", "--is-ancestor", previousSha, currentSha);
  const prefix = job.storyRelativePath ? job.storyRelativePath + "/" : "";
  const added: EditorialRepairProgress["added"] = [];
  for (const path of paths) {
    const diff = git(job, "diff", "--no-ext-diff", "--no-renames", "--unified=0",
      previousSha, currentSha, "--", prefix + path);
    for (const line of diff.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++") && line.length > 1) {
        if (line.length > 4_096 || added.length >= 256)
          throw Error("Editorial convergence source diff exceeds bounded review context.");
        added.push({ path, line: line.slice(1) });
      }
    }
  }
  if (!findings.length || findings.length > 32 || findings.some(f =>
    typeof f.message !== "string" || !f.message.trim() || f.message.length > 2_000))
    throw Error("Editorial convergence has no bounded historical negative review.");
  return { previousSha, currentSha,
    priorFindings: findings.map(f => ({ severity: f.severity, source: f.source, message: f.message })),
    added };
}
export function validateEditorialRepairDiagnosis(
  diagnosis: unknown, scope: EditorialRepairProgress): EditorialRepairDiagnosis {
  const d = diagnosis as Partial<EditorialRepairDiagnosis> | null;
  if (!d || !["material", "stalled", "uncertain"].includes(d.status ?? "") ||
      typeof d.reason !== "string" || d.reason.trim().length < 12 || d.reason.length > 2_000 ||
      (d.status === "material" && (!d.evidence ||
        typeof d.evidence.path !== "string" || typeof d.evidence.quote !== "string" ||
        d.evidence.quote.trim().length < 8 || d.evidence.quote.length > 500 ||
        !scope.added.some(line => line.path === d.evidence!.path &&
          line.line.includes(d.evidence!.quote)))) ||
      (d.status !== "material" && d.evidence !== null))
    throw Error("Source-grounded editorial convergence diagnosis lacks a newly added canonical citation.");
  return d as EditorialRepairDiagnosis;
}
export function productiveEditorialRepair(
  diagnosis: EditorialRepairDiagnosis | undefined, block: boolean): boolean {
  if (!block) return true;
  if (!diagnosis) throw Error("A repeated negative editorial review lacks its progress diagnosis.");
  return diagnosis.status === "material";
}
