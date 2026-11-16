import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { JobStartResult } from "../src/job.js";
import { saveFixtureTurn } from "./puzzle-obligation-fixtures.js";
import { createSkillSnapshot } from "../src/snapshot.js";
import { beginAdaptiveAttempt, emptyAdaptiveState, settleAdaptiveAttempt } from "../src/adaptive-state.js";
import { pendingDigest } from "../src/pending-work-amendments.js";
import { prepareTurnFulfillment, assessTurnFulfillment, validateTurnFulfillment,
  type TurnFulfillmentContext } from "../src/turn-fulfillment.js";
import { assertAdaptiveForkBoundary } from "../src/recovery-fork.js";
import type { JobReport } from "../src/job-report.js";
import type { AdaptiveAmendment } from "../src/adaptive-assignments.js";

const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "nt-adaptive-final-"));
  const repo = join(dir, "repo"), story = join(repo, "story"), stateDir = join(dir, "state");
  const g = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  mkdirSync(join(story, "creative-direction"), { recursive: true });
  mkdirSync(join(story, "milestones"), { recursive: true });
  mkdirSync(join(story, "events"), { recursive: true });
  mkdirSync(join(story, "authored-content"), { recursive: true });
  mkdirSync(join(repo, "skills", "test"), { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  g("init", "-q"); g("config", "user.name", "Fixture");
  g("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(repo, "skills/test/SKILL.md"), "---\nname: test\n---\nA pinned test method.\n");
  writeFileSync(join(story, "creative-direction/foundation.md"),
    "Approved interaction profile: Choice frequency is occasional; no formal Puzzle required.\n" +
    "Payoffs should remain visible after routes reconverge.\n");
  writeFileSync(join(story, "milestones/discovery.md"),
    "Discovery: the player investigates the archive ledger.\n");
  g("add", "."); g("commit", "-qm", "Approved Story foundation");
  const baseSha = g("rev-parse", "HEAD");
  writeFileSync(join(story, "events/discovery.md"),
    "An observational Event shows the ledger's missing page.\n");
  writeFileSync(join(story, "authored-content/discovery.md"),
    "A witness talks through the discrepancy, in full dialogue.\n");
  g("add", "."); g("commit", "-qm", "Reviewed Event and authored narrative");
  const headSha = g("rev-parse", "HEAD");
  const contract = { scope: { kind: "full-story" as const, depth: "composition" as const,
      targets: [] as string[], branches: [] as string[] },
    constraints: ["Preserve the meaning of any original Choices"],
    envelope: { presentation: "Dialogue-led mystery", hardLimits: [] as string[], preferences: [] as string[] } };
  const task = "Deliver a narrative-led mystery; a formal Puzzle is unnecessary.";
  const job = { jobId: "job", stateDir, worktreeRoot: repo, storyRelativePath: "story",
    worktreeStoryRoot: story, headSha, baseSha, threadId: "thread", branch: g("branch", "--show-current") } as JobStartResult;
  saveFixtureTurn(job, contract, task, ["Maintain the approved Story-wide interaction profile."]);
  const turn = JSON.parse(readFileSync(join(stateDir, "turn-plan.json"), "utf8"));
  const plan = { version: 1, contract, items: [
    { id: "global-architecture", kind: "architecture", targetIds: ["milestone.discovery"], status: "verified" },
    { id: "interactive:milestone.discovery", kind: "realization", targetIds: ["milestone.discovery"], status: "verified" },
    { id: "review", kind: "review", targetIds: ["milestone.discovery"], status: "verified" },
  ] };
  writeFileSync(join(stateDir, "architecture.json"), JSON.stringify({ plan, history: [] }));
  writeFileSync(join(stateDir, "narrative-review.json"), JSON.stringify({
    planVersion: 1, headSha, phase: "completed", worker: "pi", editorial: { verdict: "pass" },
  }));
  const context: TurnFulfillmentContext = { headSha, baseSha, planVersion: 1, contract,
    scopeCurrent: true, scopeComplete: true, editorialPass: true,
    scopedPaths: ["milestones/discovery.md", "events/discovery.md", "authored-content/discovery.md"] };
  const report = { identity: { headSha, baseSha }, plan,
    generation: { scopeFulfillment: "complete-in-scope" },
    evidence: { scope: { current: true, scopedPaths: context.scopedPaths },
      editorial: { verdict: "pass" } } } as unknown as JobReport;
  return { dir, repo, stateDir, job, context, report, g, task, turn, headSha, baseSha };
}
async function admit(f: ReturnType<typeof fixture>,
  actions: AdaptiveAmendment["actions"], omissions: AdaptiveAmendment["omissions"] = []) {
  const snapshot = await createSkillSnapshot({ discovery: "explicit-only",
    novelteaSkills: f.repo, skillDirs: [], requiredSkills: [] });
  assert.ok(snapshot, "The original skill files must be pinned for review.");
  const state = emptyAdaptiveState(f.job, f.turn.digest, 1);
  const signature = pendingDigest({ story: f.headSha, version: 1 });
  await beginAdaptiveAttempt(f.job, state, f.headSha, signature);
  const reason = "Native source-backed differentiated gameplay obligations";
  const order = ["composition:milestone.discovery", "review"];
  const body = { schema: "noveltea-adaptive-assignments/v1" as const,
    sourceSha: f.headSha, turnDigest: f.turn.digest,
    beforeVersion: 1, afterVersion: 2, planVersion: 1, reason,
    inventoryDigest: hash("original inventory"), actions, order, carried: [], omissions };
  const entry = { ...body, digest: pendingDigest(body) };
  const sessionDir = join(f.stateDir, "adaptive-planning-sessions");
  mkdirSync(sessionDir, { recursive: true });
  const sessionFile = join(sessionDir, "planner.jsonl");
  writeFileSync(sessionFile, "{\"role\":\"assistant\",\"text\":\"read-only proposal\"}\n");
  await settleAdaptiveAttempt(f.job, state, signature, "admitted", entry, {
    sessionFile, sessionSha256: hash(readFileSync(sessionFile, "utf8")), snapshotId: snapshot.id,
    provider: "openai", model: "deterministic-test", skillReads: [join(snapshot.path, "skills/test/SKILL.md")],
    proposalDigest: pendingDigest({ sourceSha: f.headSha, turnDigest: f.turn.digest,
      beforeVersion: 1, reason, actions, order }),
  });
  return { entry, sessionFile };
}

test("amended narrative-led final review includes untouched approved Interaction profile and reviewed Event-only omission", async () => {
  const f = fixture();
  try {
    const proof = { assignmentId: "interactive:milestone.discovery", sourceSha: f.headSha,
      path: "milestones/discovery.md", sourceHash: hash("native milestone"),
      evidence: "milestones/discovery.md:1 Event-only judgment based on observational gameplay",
      reviewerSession: "/private/review.jsonl", reviewerSnapshot: hash("review-skill") };
    const { entry, sessionFile } = await admit(f, [
      { kind: "omit", item: proof.assignmentId },
    ], [proof]);
    const packet = await prepareTurnFulfillment(f.job, f.context);
    assert.ok(packet);
    assert.equal(packet.originalRequest, f.task);
    assert.deepEqual(packet.interactionSources, ["creative-direction/foundation.md"]);
    writeFileSync(join(f.repo, "unpublished.md"), "another writer left an uncommitted edit");
    await assert.rejects(prepareTurnFulfillment(f.job, f.context), /dirty|unpublished/i);
    rmSync(join(f.repo, "unpublished.md"));
    assert.ok(packet.canonical.some(c => c.path === "creative-direction/foundation.md" &&
      c.content.includes("Choice frequency is occasional")));
    assert.equal(packet.source.adaptive?.version, 2);
    assert.deepEqual(packet.source.adaptive?.amendments, [entry.digest]);
    assert.equal(packet.plannedWork.find(w => w.id === proof.assignmentId)?.status, "reviewed-omission");
    assert.ok(packet.objectives.some(o => o.id.startsWith("adaptive:") &&
      /whole-Story interaction/.test(o.text)));
    let count = 0;
    const evaluate = async (p: typeof packet) => {
      count++;
      return { digest: p.digest, verdict: "incomplete",
        checks: p.objectives.map(o => ({ objectiveId: o.id, fulfilled: o.id !== "goal",
          evidence: o.id === "goal" ? [] : [{ path: o.id === "delivery:architecture"
              ? "milestones/discovery.md" : ["delivery:composition", "delivery:complete-story",
                  "delivery:payoff"].includes(o.id) ? "authored-content/discovery.md" : "events/discovery.md",
            line: 1, explanation: "The fixture has grounded source lines, not independent real-Pi semantic judgment." }] })),
        findings: [{ objectiveId: "goal", message: "Whole-Story payoff is not proven", followUp: null }] };
    };
    const saved = await assessTurnFulfillment(f.job, f.report, "fixture-independent-review", evaluate);
    assert.equal(saved?.verdict?.verdict, "incomplete");
    assert.deepEqual(await assessTurnFulfillment(f.job, f.report, "fixture-independent-review", evaluate), saved);
    assert.equal(count, 1, "Restart must reuse the independent final review, not replay it");
    writeFileSync(sessionFile, "interrupted or tampered transcript");
    await assert.rejects(prepareTurnFulfillment(f.job, f.context), /transcript changed/i);
    await assert.rejects(prepareTurnFulfillment({ ...f.job, threadId: "other" }, f.context),
      /identity|source/i);
    // The previously sealed final review cannot authorize a different source or skill history.
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("a new Thread cannot silently inherit amended writer grants after a verified checkpoint", async () => {
  const f = fixture();
  try {
    await admit(f, [{ kind: "narrow", item: "event:milestone.discovery",
      sourcePath: "milestones/discovery.md", sourceHash: hash("native projection"),
      outcome: "Support a second causally necessary Event" }]);
    await assertAdaptiveForkBoundary(f.job, f.baseSha);
    await assert.rejects(assertAdaptiveForkBoundary(f.job, f.headSha),
      /amended Story checkpoint cannot be forked/i);
    await assert.rejects(assertAdaptiveForkBoundary(f.job, "f".repeat(40)),
      /ancestry|missing|invalid/i,
      "a missing Git commit must not be mistaken for a safe pre-amendment checkpoint");
    const drift = { ...f.job, threadId: "unrelated-thread" };
    await assert.rejects(assertAdaptiveForkBoundary(drift, f.headSha), /identity|source/i);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("choice-heavy later Milestone obligations are assessed against original goal after a verified descendant", async () => {
  const f = fixture();
  try {
    const actions: AdaptiveAmendment["actions"] = [
      { kind: "add", stage: "event", milestone: "milestone.discovery",
        dependsOn: ["foundations"] },
      { kind: "split", item: "interactive:milestone.discovery", domains: ["choice", "puzzle"] },
      { kind: "narrow", item: "choice:milestone.discovery",
        sourcePath: "milestones/discovery.md", sourceHash: hash("source projection"),
        outcome: "Two meaningful Choices with post-convergence witnesses" },
    ];
    const { entry } = await admit(f, actions);
    const packet = await prepareTurnFulfillment(f.job, f.context);
    assert.ok(packet);
    assert.equal(packet.source.adaptive?.digest.length, 64);
    assert.equal(packet.source.adaptive?.amendments[0], entry.digest);
    assert.ok(packet.objectives.some(o => /post-convergence witnesses/.test(o.text)));
    assert.ok(packet.plannedWork.some(item => item.id === "puzzle:milestone.discovery"));
    assert.ok(!packet.plannedWork.some(item => item.id === "interactive:milestone.discovery"),
      "the original aggregate is retired when Choice and optional Puzzle become independent assignments");
    assert.equal(packet.goal, f.task, "Amendment must not replace the Author objective");
    const unsatisfied = packet.objectives.find(item => item.id.startsWith("adaptive:"))!;
    const verdict = {
      digest: packet.digest, verdict: "incomplete",
      checks: packet.objectives.map(item => ({ objectiveId: item.id,
        fulfilled: item.id !== unsatisfied.id,
        evidence: item.id === unsatisfied.id ? [] : [{
          path: item.id === "delivery:architecture" ? "milestones/discovery.md"
            : ["delivery:composition", "delivery:complete-story", "delivery:payoff"]
                .includes(item.id) ? "authored-content/discovery.md" : "events/discovery.md",
          line: 1, explanation: "Synthetic canonical evidence used only for controller contract validation.",
        }],
      })),
      findings: [{ objectiveId: unsatisfied.id, message: "Causal Event goal remains unproven",
        followUp: { assignmentId: "event:milestone.discovery",
          outcome: "Demonstrate independently supported causal Event", targets: ["milestone.discovery"] } }],
    };
    assert.equal(validateTurnFulfillment(packet, verdict).verdict, "incomplete",
      "a missing adaptive obligation may propose a bounded follow-up for its admitted assignment");
    assert.throws(() => validateTurnFulfillment(packet, {
      ...verdict, findings: [{ ...verdict.findings[0],
        followUp: { ...verdict.findings[0]!.followUp, targets: ["milestone.unapproved"] } }],
    }), /unsupported|stale/i);
    const baselineDigest = packet.digest;
    const stored = JSON.parse(readFileSync(join(f.stateDir, "adaptive-plan.json"), "utf8"));
    stored.entries[0].actions[2].outcome = "Changed without controller approval";
    writeFileSync(join(f.stateDir, "adaptive-plan.json"), JSON.stringify(stored));
    await assert.rejects(prepareTurnFulfillment(f.job, f.context), /digest|altered/i);
    assert.notEqual(baselineDigest.length, 0);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
