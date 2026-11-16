/** Bind independently reviewed specialist outcomes to the exact controller
 * amendment that was admitted before the reviewed Git commit. This is NOT an
 * author approval or a transferable write grant. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { JobStartResult } from "./job.js";
import { readAdaptiveState } from "./adaptive-state.js";
import { dependencyGit } from "./dependency-state.js";
import { milestoneFulfillmentProjection } from "./milestone-field-scope.js";

export interface AdaptiveReviewBinding {
  kind: "narrow" | "add";
  item: string; amendmentDigest: string; sourceSha: string;
  sourcePath?: string; sourceHash?: string; outcome: string;
}
const SHA = /^[a-f0-9]{40}$/, HASH = /^[a-f0-9]{64}$/;
const MILESTONE_PATH = /^milestones\/[a-z][a-z0-9-]*\.md$/;

/** The existing specialist owner/Stage remains unchanged. Interactive is one
 * Turn assignment with separately reviewed Choice and Puzzle checkpoints. */
function workTargets(workItem: string): string[] {
  const event = /^event-([a-z][a-z0-9-]*)$/.exec(workItem);
  if (event) return ["event:milestone." + event[1]];
  const interactive = /^interactive-(choice|puzzle)-([a-z][a-z0-9-]*)$/.exec(workItem);
  if (interactive) return [interactive[1] + ":milestone." + interactive[2],
    "interactive:milestone." + interactive[2]];
  const composition = /^composition-([a-z][a-z0-9-]*)$/.exec(workItem);
  return composition ? ["composition:milestone." + composition[1]] : [];
}

function sourceBytes(job: JobStartResult, sha: string, path: string): Buffer {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_PREFIX"])
    delete env[key];
  const prefix = job.storyRelativePath ? job.storyRelativePath + "/" : "";
  return execFileSync("git", ["show", sha + ":" + prefix + path], {
    cwd: job.worktreeRoot, env, maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Only the original, source-ancestral, still-sealed controller history may
 * add a finer semantic obligation to the reviewer. Never infer it from Pi
 * rationale, current Story text, or post-commit plan changes. */
export async function adaptiveReviewBinding(
  job: JobStartResult, turnDigest: string, planVersion: number | null,
  beforeCommit: string, workItem: string,
): Promise<AdaptiveReviewBinding | null> {
  const targets = workTargets(workItem);
  if (!targets.length || !planVersion || !SHA.test(beforeCommit)) return null;
  const state = await readAdaptiveState(job, turnDigest, planVersion);
  if (!state) return null;
  let selected: AdaptiveReviewBinding | null = null;
  for (const entry of state.entries) {
    try { dependencyGit(job, "merge-base", "--is-ancestor", entry.sourceSha, beforeCommit); }
    catch { continue; } // A later plan is not retrospective review authority.
    for (const action of entry.actions) {
      if (action.kind === "add") {
        const id = action.stage + ":" + action.milestone;
        if (targets.includes(id) && selected?.kind !== "narrow") {
          if (selected)
            throw Error("Duplicate controller-added assignment review authority.");
          selected = { kind: "add", item: id, amendmentDigest: entry.digest,
            sourceSha: entry.sourceSha,
            outcome: "Independently realize the added " + action.stage +
              " assignment within verified Architecture " + action.milestone +
              "; authenticated causal dependencies: " + action.dependsOn.join(", ") + "." };
        }
        continue;
      }
      if (action.kind !== "narrow" || !targets.includes(action.item)) continue;
      if (selected?.kind === "narrow" || !MILESTONE_PATH.test(action.sourcePath) ||
          !SHA.test(entry.sourceSha) || !HASH.test(action.sourceHash) ||
          [entry.sourceSha, beforeCommit].some(sha => createHash("sha256")
            .update(milestoneFulfillmentProjection(
              sourceBytes(job, sha, action.sourcePath).toString("utf8")))
            .digest("hex") !== action.sourceHash))
        throw Error("Adaptive reviewer lost an exact, unique, controller-admitted source-bound outcome.");
      selected = { kind: "narrow", item: action.item, amendmentDigest: entry.digest,
        sourceSha: entry.sourceSha, sourcePath: action.sourcePath,
        sourceHash: action.sourceHash, outcome: action.outcome };
    }
  }
  return selected;
}
