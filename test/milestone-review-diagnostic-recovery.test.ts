/** #220: recovery of a sealed diagnostic after controller interruption uses
 * the original negative reviews and never dispatches an extra model call. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensureMilestoneBlueprint, inspectMilestoneBlueprint,
  parseMilestoneBlueprintReview, type MilestoneBlueprint } from "../src/milestone-blueprint.js";
import { milestoneDiagnosticEvidence, milestoneDiagnosticFingerprint } from "../src/milestone-review-diagnostic.js";
import { reviewCycleId } from "../src/review-cycle.js";
import type { JobStartResult } from "../src/job.js";
import type { EventAssignment } from "../src/event-specialist.js";
import type { Plan } from "../src/architecture.js";
import type { SkillSnapshot } from "../src/snapshot.js";
import { removeTestTree } from "./helpers.js";

const sha = (v: unknown) => createHash("sha256").update(typeof v === "string"
  ? v : JSON.stringify(v)).digest("hex");
const path = "milestones/sample.md";
const milestoneId = "milestone.sample";
const task = "Design an inspectable Event that establishes the dated gate-register trail.";
const contract = { objective: "Use only earned Character knowledge from visible evidence." };
const knowledge = "The guard claims secret knowledge about yesterday without testimony";
const draft: MilestoneBlueprint = {
  schema: "noveltea-milestone-blueprint/v1", milestoneId,
  events: [{
    id: "arrival", purpose: "Inspect the dated gate register", dependsOn: [],
    participants: [], knowledge, routes: [], evidence: [{
      anchorPath: path, source: "The visible gate register",
      observation: "An entry appears today", access: "The guard can inspect it",
      establishes: "A register entry exists", limits: "No testimony about yesterday",
    }],
  }],
  downstream: [{ owner: "composition", obligation: "Show the visible register to the player" }],
};
const finding = {
  eventId: "arrival", anchorPath: path,
  requirement: "Character knowledge must be earned through inspectable evidence",
  reason: "Yesterday has not been independently verified",
  correction: "Replace the unsupported secret with the visible register entry",
  evidence: { field: "knowledge" as const, quote: knowledge, repair: "replace" as const },
};
const prior = (round: number) => ({
  round, findingIndex: 0, status: "persisting" as const,
  reason: "The same unsupported secret claim remains",
  evidence: { kind: "current" as const, eventId: "arrival",
    field: "knowledge" as const, quote: knowledge },
});
function git(root: string, ...args: string[]) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}
function session(stateDir: string, role: "writer" | "reviewer" | "diagnostic", id: string) {
  const file = join(stateDir, "milestone-blueprint-sessions", role, id + ".jsonl");
  mkdirSync(join(stateDir, "milestone-blueprint-sessions", role), { recursive: true });
  const body = JSON.stringify({ type: "session", id }) + "\n";
  writeFileSync(file, body);
  return { id, file, bytes: Buffer.byteLength(body), digest: sha(body) };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "nt-220-milestone-"));
  const story = join(root, "story"), stateDir = join(root, ".git", "state");
  mkdirSync(join(story, "milestones"), { recursive: true });
  writeFileSync(join(story, path), "# A gate register\n\nThe guard finds today's entry.\n");
  git(root, "init", "-q");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.test");
  git(root, "add", ".");
  git(root, "commit", "-qm", "Verified Milestone sources");
  const head = git(root, "rev-parse", "HEAD");
  const job = { jobId: "job-220", threadId: "thread-220", baseSha: head,
    worktreeRoot: root, worktreeStoryRoot: story,
    storyRelativePath: "story", stateDir } as JobStartResult;
  const assignment = { milestoneId, milestonePath: path, sourcePaths: [path],
    characterIds: [] } as unknown as EventAssignment;
  const plan = { version: 1, contract, items: [
    { id: "global-architecture", status: "verified", targetIds: [milestoneId] },
  ] } as unknown as Plan;
  const snapshot = { id: "snapshot-220" } as SkillSnapshot;
  const committed = execFileSync("git", ["show", head + ":story/" + path],
    { cwd: root, encoding: "utf8" });
  const exactSourceDigest = sha([{ path, digest: sha(committed) }]);
  const planDigest = sha(plan);
  const taskDigest = sha(task);
  const binding = {
    jobId: job.jobId, threadId: job.threadId, baseSha: job.baseSha,
    executionHead: head, milestoneId, planVersion: plan.version,
    planDigest, contractDigest: sha(contract),
    sourceDigest: exactSourceDigest, snapshotId: snapshot.id,
    provider: "scripted", model: "scripted-220", taskDigest,
  };
  const lineage = { ...binding, reviewCycleId: reviewCycleId({
    ...binding, taskDigest: sha([taskDigest, milestoneId, exactSourceDigest, planDigest]),
  }) };
  const rounds: Array<{ draft: MilestoneBlueprint; review: ReturnType<typeof parseMilestoneBlueprintReview>;
    draftDigest: string; reviewDigest: string }> = [];
  for (let i = 0; i < 3; i++) {
    const review = parseMilestoneBlueprintReview(JSON.stringify({
      schema: "noveltea-milestone-blueprint-review/v4",
      status: "revise", findings: [finding],
      prior: Array.from({ length: i }, (_, index) => prior(index)),
    }), draft, assignment, rounds);
    rounds.push({ draft, review, draftDigest: sha(draft), reviewDigest: sha(review) });
  }
  const sources = { task, contract };
  const diagnosis = {
    schema: "noveltea-milestone-diagnosis/v1", action: "escalate",
    explanation: "The repeated unsupported claim remains a semantic blocker.",
    assessments: [{
      kind: "material", reason: "An unearned assertion needs independent proof",
      requirement: { source: "contract", quote: "earned Character knowledge" },
      evidence: { eventId: "arrival", field: "knowledge", quote: knowledge },
    }],
  };
  const writer = session(stateDir, "writer", "writer-220");
  const reviewer = session(stateDir, "reviewer", "reviewer-220");
  const diagnostician = session(stateDir, "diagnostic", "diagnostic-220");
  const result = { schema: "noveltea-milestone-diagnostic-receipt/v1",
    round: 2, trigger: "stagnation",
    evidenceDigest: milestoneDiagnosticEvidence(lineage.reviewCycleId, rounds, sources),
    caseFingerprint: milestoneDiagnosticFingerprint(lineage.reviewCycleId, draft, [finding], sources),
    sources, diagnosis, session: diagnostician };
  const file = join(stateDir, "milestone-blueprints", "sample.json");
  const sealed = join(stateDir, "milestone-blueprint-diagnostics",
    "sample-" + lineage.reviewCycleId + "-2.json");
  mkdirSync(join(stateDir, "milestone-blueprints"), { recursive: true });
  mkdirSync(join(stateDir, "milestone-blueprint-diagnostics"), { recursive: true });
  const receipt = { schema: "noveltea-milestone-plan-receipt/v1", lineage,
    phase: "diagnosing", rounds, draft, writer, reviewer };
  writeFileSync(file, JSON.stringify(receipt));
  writeFileSync(sealed, JSON.stringify(result));
  return { root, job, plan, assignment, snapshot, head, file, sealed, result };
}

test("#220 interrupted controller reconciles a sealed independent diagnosis, stops safely and inspects without dispatch", async t => {
  const f = fixture();
  t.after(() => removeTestTree(f.root));
  const ensure = () => ensureMilestoneBlueprint(f.job, f.plan, f.assignment,
    f.snapshot, "scripted", "scripted-220", task, f.head, false);
  await assert.rejects(ensure(), /escalation/i);
  const status = await inspectMilestoneBlueprint(f.job, milestoneId);
  assert.equal(status?.phase, "stopped");
  assert.equal(status?.rounds, 3);
  assert.equal(status?.lastVerdict, "revise");
  assert.equal(status?.diagnostic?.action, "escalate");
  assert.match(status?.stopReason ?? "", /escalation/i);
  const saved = readFileSync(f.file, "utf8");
  await assert.rejects(ensure(), /escalation/i);
  assert.equal(readFileSync(f.file, "utf8"), saved,
    "repeated restart must not modify the disposition or invoke a new Pi session");
});

test("#220 inspect rejects tampered independent advice and transcript rather than showing forged approval", async t => {
  const f = fixture();
  t.after(() => removeTestTree(f.root));
  await assert.rejects(ensureMilestoneBlueprint(f.job, f.plan, f.assignment,
    f.snapshot, "scripted", "scripted-220", task, f.head, false), /escalation/i);
  const original = readFileSync(f.sealed, "utf8");
  writeFileSync(f.sealed, JSON.stringify({ ...f.result, diagnosis: {
    ...f.result.diagnosis, action: "continue",
  } }));
  await assert.rejects(inspectMilestoneBlueprint(f.job, milestoneId),
    /sealed|immutable|source|disposition/);
  writeFileSync(f.sealed, original);
  const contents = readFileSync(f.result.session.file, "utf8");
  writeFileSync(f.result.session.file, contents + "tamper\n");
  await assert.rejects(inspectMilestoneBlueprint(f.job, milestoneId),
    /transcript changed|provenance|unsafe/);
  assert.ok(existsSync(f.sealed));
});
