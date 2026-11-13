import { execFileSync } from "./git-read-cache.js";
import type { JobStartResult } from "./job.js";
import type { RepairReceipt } from "./rejected-review-repair.js";

const canonicalPath = /^(?:creative-direction|arcs|milestones|characters|relationships|world-entities|facts|revelations|events|authored-content|choice-points|puzzles|narrative-positions)\/[a-z0-9][a-z0-9._-]*\.md$/;

/** Read exact rejected blobs, never dirty worktree bytes or author-only inbox
 * material. Context membership conveys no additional write authority. */
export function rejectedRepairContext(job: JobStartResult, state: RepairReceipt, sourcePaths: string[] = []) {
  if (!/^[a-f0-9]{40}$/.test(state.sourceCommitSha)) throw Error("Unsafe repair source SHA.");
  const paths = [...new Set([
    ...sourcePaths, ...(state.planAmendment?.readOnlyDependencies ?? []),
    ...state.findings.flatMap(f => [f.path, ...f.affectedPaths ?? []]),
  ])].sort();
  if (!paths.length || paths.length > 32 || paths.some(p => !canonicalPath.test(p)))
    throw Error("Unsafe or unbounded canonical repair context.");
  const prefix = job.storyRelativePath;
  if (prefix && !prefix.split("/").every(p => /^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(p)))
    throw Error("Unsafe repair Story root.");
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_PREFIX"])
    delete env[key];
  const git = (...args: string[]) => execFileSync("git", args, {
    cwd: job.worktreeRoot, env, encoding: "utf8", maxBuffer: 128 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const allowed = state.planAmendment?.assignment.authority.existingPaths ?? state.allowedPaths;
  let bytes = 0;
  const context = paths.map(path => {
    const full = prefix ? prefix + "/" + path : path;
    const entry = git("ls-tree", "-z", state.sourceCommitSha, "--", full);
    const match = entry.match(/^100(?:644|755) blob ([a-f0-9]{40})\t[^\0]+\0$/);
    if (!match) throw Error("Missing or unsafe canonical repair source: " + path);
    const content = git("cat-file", "blob", match[1]!);
    bytes += Buffer.byteLength(content);
    if (bytes > 128 * 1024) throw Error("Repair context exceeds bounded size.");
    return { path, content, commitSha: state.sourceCommitSha, blobSha: match[1]!,
      writable: allowed.includes(path) };
  });
  const offendingSources = state.findings.map(f => {
    const record = context.find(c => c.path === f.path)!;
    // Legacy sealed findings may have no structured line. Preserve them rather
    // than guessing a line from reviewer prose; provide the full pinned record.
    const lines = record.content.split(/\r?\n/);
    if (f.line !== undefined && (!Number.isSafeInteger(f.line) || f.line < 1 || f.line > lines.length))
      throw Error("Review finding has an invalid source line.");
    return { path: f.path, line: f.line, text: f.line === undefined ? record.content : lines[f.line - 1]!,
      commitSha: record.commitSha, blobSha: record.blobSha,
      requiredCorrection: f.requiredCorrection ?? f.message };
  });
  return { context, offendingSources };
}
