import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { createControllerServer, SandboxController, type ControllerConfig } from "../web/src/sandbox-controller.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { removeTestTree } from "./helpers.js";
import { saveFixtureTurn } from "./puzzle-obligation-fixtures.js";
import { startStoryJob } from "../src/job.js";
import { inspectRecoveryCheckpoints } from "../src/recovery-checkpoints.js";
import { collectRecoveryFork, prepareRecoveryFork } from "../src/recovery-fork.js";
import { reviewedMilestoneHandoff } from "../src/milestone-obligation-handoff.js";
import { forkSourceSummary } from "../src/recovery-fork-state.js";
import { sealReviewedOmissionBatch } from "../src/recovery-review-batch.js";
import { reviewBoundedAssignments } from "../src/semantic-assignment-review.js";
import { compositionOptionalDialoguePolicy, parseSpecialistJson } from "../src/composition-specialist.js";
import { readEventOnlyOmission } from "../src/interactive-event-only.js";
import { runInteractiveWorkItem } from "../src/interactive-work.js";
import { withStoryJobLock } from "../src/job-lock.js";
import { reviewedAdaptiveOmissions } from "../src/adaptive-omission.js";
import { admitAdaptiveAssignments, applyAdaptiveAssignments,
  revalidateAdaptiveAmendment } from "../src/adaptive-assignments.js";
import { reconcileInventory, nextExecutionItem, type GenerationInventory } from "../src/generation-plan.js";
import { validateStoryJob } from "../src/validator.js";
import { auditCompositionPaths, optionalDialogueDeferralFeedback, selectAssignment,
  verifyCompositionProse, runCompositionWorkItem } from "../src/composition-work.js";

const root = mkdtempSync(join(tmpdir(), "nt-composition-"));
after(() => {
  if ((process.env.NT_LIVE_COMPOSITION === "1" || process.env.NT_LIVE_EVENT_ONLY === "1") &&
      process.env.NT_KEEP_FAILED_LIVE === "1") {
    process.stderr.write("Live composition fixtures preserved: " + root + "\n");
  } else removeTestTree(root);
});
const source = resolve(process.env.NT_SKILLS_CHECKOUT ?? "../noveltea-skills");
const available = existsSync(join(source, "src/cli.ts"));
function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
test("Event-only Composition defers optional testimony instead of fabricating Mara's response", () => {
  const conflict = "events/mara-brought-out.md describes optional accepted, refused and withdrawn " +
    "recovery conversations but declares no corresponding branches or account-receipt effects. " +
    "Authored the mandatory rescue and quiet recovery offer only; Mara's voucher-pretext and " +
    "reconciliation-demand testimony remains unwritten pending authorized routing.";
  const corrected = optionalDialogueDeferralFeedback({ eventOnly: true }, [conflict]);
  assert.match(corrected ?? "", /EVENT_ONLY_OPTIONAL_DIALOGUE/);
  assert.match(corrected ?? "", /laterObligations/);
  assert.match(corrected ?? "", /Do not impersonate consent/);
  assert.equal(optionalDialogueDeferralFeedback({ eventOnly: false }, [conflict]), null,
    "A required Choice branch may not be silently deferred");
  for (const blocker of [
    "Required testimony cannot be enacted: no corresponding branch or effect.",
    "A protected canon contradiction prevents the optional witness route.",
    "The rescue itself is unreachable, with missing necessary Event effects.",
  ]) {
    assert.equal(optionalDialogueDeferralFeedback({ eventOnly: true }, [blocker]), null, blocker);
  }
  const policy = compositionOptionalDialoguePolicy(true);
  assert.match(policy, /EVENT-ONLY SOURCE CONTRACT/);
  assert.match(policy, /unpressured offer ONLY/);
  assert.match(policy, /laterObligations/);
  assert.equal(compositionOptionalDialoguePolicy(false), "");
});

test("parses a complete nested manifest despite commentary or fenced JSON", () => {
  const manifest = JSON.stringify({ modifiedRecords: ["authored-content/disclosure.md"],
    architecturalConflicts: [], laterObligations: [{ kind: "prose", detail: 'quote "safe"' }] });
  const input = "Completed.\n\n" + "```json\n" + manifest + "\n```";
  assert.deepEqual(parseSpecialistJson(input).modifiedRecords, ["authored-content/disclosure.md"]);
  assert.equal(parseSpecialistJson('review: {"verdict":"pass","sourceEvidence":["event.x"],"concerns":[]}').verdict, "pass");
  assert.throws(() => parseSpecialistJson('No JSON was returned'), /no parseable JSON/);
});

/** Reinspect one real paid reviewer checkpoint without re-running its Pi turn.
 * Only explicit private local opt-in roots are read; never copy historical job state. */
test("preserved live Event-only review survives a process restart without replaying the model", {
  skip: !process.env.NT_PRESERVED_LIVE_EVENT_ONLY_ROOT
    ? "set NT_PRESERVED_LIVE_EVENT_ONLY_ROOT to a saved live fixture root" : false,
}, () => {
  const saved = process.env.NT_PRESERVED_LIVE_EVENT_ONLY_ROOT!;
  const host = join(saved, "live-event-only-host");
  const state = join(host, "state");
  const jobs = readdirSync(join(state, "jobs"));
  assert.equal(jobs.length, 1, "A preserved certification root must select exactly one Job");
  const jobState = join(state, "jobs", jobs[0]!);
  const job = JSON.parse(readFileSync(join(jobState, "job.json"), "utf8"));
  const proof = JSON.parse(readFileSync(join(jobState,
    "interactive-event-only/disclosure.json"), "utf8")).payload;
  assert.equal(proof.reviewMode, "pi");
  git(job.worktreeRoot, "merge-base", "--is-ancestor", proof.reviewHead, "HEAD");
  assert.equal(git(job.worktreeRoot, "status", "--porcelain"), "");
  const messages = readFileSync(proof.reviewerSession, "utf8").trim().split("\n").map(JSON.parse);
  const calls = messages.flatMap((entry: any) => entry.message?.content ?? [])
    .filter((call: any) => call.type === "toolCall");
  assert.ok(calls.some((call: any) => call.name === "read" &&
    String(call.arguments?.path).includes("nt-narrative-review/SKILL.md")));
  assert.ok(!calls.some((call: any) => ["write", "edit", "bash"].includes(call.name)));
  assert.ok(proof.evidence.some((line: string) => line.includes("milestones/disclosure.md:")));
  assert.ok(proof.evidence.some((line: string) => line.includes("events/disclose-ledger.md:")));
  for (const action of ["inspect"]) {
    const result = spawnSync(process.execPath,
      ["--import", "tsx", resolve("src/cli.ts"), "job", "interactive", action,
        "--milestone", "milestone.disclosure", "--story", job.storyRoot, "--job", job.jobId,
        ...(action === "run" ? ["--skills-source", source] : [])], {
        encoding: "utf8", timeout: 120_000,
        env: { ...process.env, NT_STATE_DIR: state,
          NT_GIT_CACHE_DIR: dirname(dirname(job.storyRoot)),
          NT_SKILL_CACHE_DIR: join(saved, "skills"),
          NT_CONFIG_FILE: join(saved, "missing-config.json"),
          NT_SANDBOX_SOCKET: "", NT_SANDBOX_TOKEN_FILE: "" },
      });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "interactive-slice-committed");
    assert.equal(output.headSha, proof.reviewHead);
    assert.equal(output.completionEvidence.eventOnlyReview, "independent-pi");
    assert.deepEqual(output.specialistUnits.map((unit: any) => unit.phase),
      ["not-applicable", "not-applicable"]);
  }
  git(job.worktreeRoot, "merge-base", "--is-ancestor", proof.reviewHead, "HEAD");
});
