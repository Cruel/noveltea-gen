import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobStartResult } from "../src/job.js";
import type { RecoveryCheckpoint } from "../src/recovery-checkpoints.js";
import { planRevision } from "../web/src/lib/turn-plan";
import { saveJobTurnPlan } from "../web/src/lib/turn-plan-receipt.server";
import { selectCheckpointReview, requireAdaptiveReview, blockedByRequiredReview, checkpointAssurance,
  inspectCheckpointReview, readIndependentReview, sealIndependentReview, executionId,
  unresolvedNativePrerequisites } from "../src/checkpoint-assurance.js";
import { forkDigest, readRecoveryFork } from "../src/recovery-fork-state.js";

const routine = {
  workItem: "focus:character.nia",
  paths: ["characters/nia.md"],
  addedLines: 12,
  removedLines: 4,
  dependencyCount: 0,
  previousFailure: false,
};

test("a bounded Character revision is validated without fabricated independent review", () => {
  assert.deepEqual(selectCheckpointReview(routine), { status: "not-required", reasons: [] });
});

test("controller-admitted assignment refinement always needs semantic review", () => {
  const ordinary = selectCheckpointReview(routine);
  const revised = requireAdaptiveReview(ordinary, { item: "event:milestone.discovery",
    sourceSha: "a".repeat(40), sourcePath: "milestones/discovery.md", sourceHash: "b".repeat(64),
    outcome: "Author one extra causal reveal", amendmentDigest: "c".repeat(64) });
  assert.deepEqual(revised, { status: "required-pending", reasons: ["adaptive-controller-outcome"] });
  assert.deepEqual(requireAdaptiveReview(ordinary, null), ordinary);
});

test("architectural, protected-adjacent, cross-record, broad and failed review changes require review", () => {
  assert.deepEqual(selectCheckpointReview({ ...routine, paths: ["arcs/betrayal.md"] }).reasons,
    ["architectural-or-protected-adjacent"]);
  assert.deepEqual(selectCheckpointReview({ ...routine, paths: ["characters/nia.md", "events/ambush.md"] }).reasons,
    ["high-impact-record", "cross-record-types"]);
  assert.deepEqual(selectCheckpointReview({ ...routine, dependencyCount: 3 }).reasons,
    ["broad-dependencies"]);
  assert.deepEqual(selectCheckpointReview({ ...routine, addedLines: 151 }).reasons,
    ["large-diff"]);
  assert.deepEqual(selectCheckpointReview({ ...routine, previousFailure: true }).reasons,
    ["previous-review-failure"]);
});

test("a failed or outstanding required review blocks only dependent assignments", () => {
  const items = [
    { id: "foundation", dependencies: [], status: "verified" as const },
    { id: "architecture", dependencies: ["foundation"], status: "pending" as const },
    { id: "unrelated", dependencies: [], status: "pending" as const },
    { id: "event:milestone.a", dependencies: ["architecture"], status: "pending" as const },
  ];
  const blocked = blockedByRequiredReview(items, [{ assignmentId: "foundation", status: "required-pending" }]);
  assert.deepEqual([...blocked].sort(), ["architecture", "event:milestone.a"]);
  assert.deepEqual([...blockedByRequiredReview(items,
    [{ assignmentId: "foundation", status: "failed" }])].sort(), [...blocked].sort());
  assert.equal(blockedByRequiredReview(items,
    [{ assignmentId: "foundation", status: "passed" }]).size, 0);
  assert.equal(blockedByRequiredReview(items,
    [{ assignmentId: "foundation", status: "not-required" }]).size, 0);
});

test("internal two-specialist handoffs enforce only native prerequisites", () => {
  const dependencies = {
    "world-foundations": ["global-architecture"],
    "character-foundations": ["world-foundations"],
    "interactive-choice-confession": ["event-confession"],
    "interactive-puzzle-confession": ["interactive-choice-confession"],
    "event-unrelated": ["character-foundations"],
  };
  const pending = [{ workItem: "world-foundations", status: "required-pending" as const }];
  assert.deepEqual(unresolvedNativePrerequisites("character-foundations", dependencies, pending),
    ["world-foundations"]);
  assert.deepEqual(unresolvedNativePrerequisites("interactive-puzzle-confession", dependencies,
    [{ workItem: "interactive-choice-confession", status: "failed" }]), ["interactive-choice-confession"]);
  assert.deepEqual(unresolvedNativePrerequisites("interactive-choice-confession", dependencies, pending), []);
  assert.deepEqual(unresolvedNativePrerequisites("character-foundations", dependencies,
    [{ workItem: "world-foundations", status: "passed" }]), []);
});

test("stage review dependencies retain exact executable Milestone identities", () => {
  assert.equal(executionId("event-confession"), "event:milestone.confession");
  assert.equal(executionId("interactive-choice-confession"), "interactive:milestone.confession");
  assert.equal(executionId("composition-confession"), "composition:milestone.confession");
  assert.equal(executionId("focus:character.nia"), "focus:character.nia");
});



test("independent review receipts survive restart and reject stale, forged or contradictory status", async () => {
  const root = mkdtempSync(join(tmpdir(), "nt-assurance-review-"));
  try {
    mkdirSync(join(root, "independent-reviews"));
    const assurance = {
      version: 1 as const, policyVersion: 1 as const, jobId: "author-job",
      baseSha: "a".repeat(40), commitSha: "b".repeat(40), parentSha: "a".repeat(40),
      workItem: "event-disclosure", validationProofDigest: "c".repeat(64),
      validatorVersion: "1.0.0", turnDigest: "d".repeat(64),
      assignmentId: "event", assignmentDigest: "e".repeat(64),
      assignmentDependencies: ["architecture"], changedPaths: ["events/disclosure.md"],
      changedRecordTypes: ["event"], addedLines: 2, removedLines: 1,
      diffDigest: "f".repeat(64),
      reviewSelection: { status: "required-pending" as const, reasons: ["high-impact-record"] },
    };
    const source = { jobId: assurance.jobId, commitSha: assurance.commitSha,
      turnDigest: assurance.turnDigest, assignmentId: assurance.assignmentId,
      assignmentDigest: assurance.assignmentDigest, diffDigest: assurance.diffDigest,
      validationProofDigest: assurance.validationProofDigest };
    const outcome = { version: 1, source, reviewer: "independent-review",
      status: "failed", findings: [{ path: "events/disclosure.md",
        message: "The assigned reveal is absent from the actual Event." }],
      evidence: "Story Event diff lines 2–3" };
    const reviewFile = join(root, "independent-reviews", assurance.commitSha + ".json");
    const write = (value: unknown) => writeFileSync(reviewFile, JSON.stringify(value));
    const job = { stateDir: root } as JobStartResult;
    assert.deepEqual(await readIndependentReview(job, assurance), {
      status: "required-pending", result: null,
    });
    write(outcome);
    assert.equal((await readIndependentReview(job, assurance)).status, "failed");
    assert.equal((await readIndependentReview({ ...job }, assurance)).status, "failed",
      "process restart must not silently clear the failed review");
    const structured = { ...outcome, findings: [{ ...outcome.findings[0],
      kind: "continuity", line: 2,
      requiredCorrection: "Restore the missing on-page cause for this Event revelation.",
      affectedPaths: ["events/disclosure.md", "facts/promise.md"] }] };
    write(structured);
    assert.equal((await readIndependentReview(job, assurance)).result?.findings[0]?.kind,
      "continuity", "structured repair instructions survive review receipt restart");
    write({ ...structured, findings: [{ ...structured.findings[0],
      affectedPaths: ["events/disclosure.md", "../outside.md"] }] });
    await assert.rejects(readIndependentReview(job, assurance), /stale, unauthoritative/);
    write({ ...structured, findings: [{ ...structured.findings[0],
      requiredCorrection: undefined }] });
    await assert.rejects(readIndependentReview(job, assurance), /stale, unauthoritative/);
    write({ ...outcome, source: { ...source, diffDigest: "0".repeat(64) } });
    await assert.rejects(readIndependentReview(job, assurance), /stale, unauthoritative/);
    write({ ...outcome, status: "passed" });
    await assert.rejects(readIndependentReview(job, assurance), /stale, unauthoritative/);
    write({ ...outcome, status: "passed", findings: [] });
    assert.equal((await readIndependentReview(job, assurance)).status, "passed");
    await assert.rejects(readIndependentReview(job, {
      ...assurance, assignmentDigest: "0".repeat(64),
    }), /stale, unauthoritative/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("fork pins all inherited review statuses and rejects omitted or modified assurance", () => {
  const root = mkdtempSync(join(tmpdir(), "nt-review-fork-"));
  try {
    const commitSha = "b".repeat(40);
    const snapshot = {
      version: 2, sourceJobId: "source-job", sourceBaseSha: "a".repeat(40),
      storyRoot: "/story", childId: "child-job",
      toolchain: { graphSchema: "noveltea-generation/v1",
        runtime: { nodeVersion: process.version, continuationSchema: "noveltea-fork/v2" },
        validator: { implementation: "native-cli", version: "1.0.0" },
        skills: { id: "c".repeat(64) } },
      checkpoint: { commitSha, workItem: "foundation",
        completedWorkItems: ["foundation"], assurance: { policyVersion: 1 } },
      reviewCoverage: [{ commitSha, workItem: "foundation", status: "required-pending" }],
      contract: {}, receipts: {}, commits: {}, completedStages: [],
    };
    const save = (bundle: unknown) => writeFileSync(join(root, "recovery-fork.json"),
      JSON.stringify(bundle));
    save(snapshot);
    const hash = forkDigest(snapshot);
    writeFileSync(join(root, "recovery-fork-ready"), hash + "\n");
    const pin = { sourceJobId: snapshot.sourceJobId, sourceBaseSha: snapshot.sourceBaseSha,
      commitSha, bundleSha256: hash };
    const job = { jobId: "child-job", storyRoot: "/story", baseSha: commitSha,
      stateDir: root, recoveryFork: pin } as JobStartResult;
    assert.equal(readRecoveryFork(job)?.reviewCoverage?.[0]?.status, "required-pending");
    const modified = { ...snapshot, reviewCoverage: [{ commitSha, workItem: "foundation", status: "passed" }] };
    save(modified);
    assert.throws(() => readRecoveryFork(job), /immutable job pin/);
    const missing = { ...snapshot, reviewCoverage: undefined };
    save(missing);
    const changedPin = { ...job, recoveryFork: { ...pin, bundleSha256: forkDigest(missing) } };
    writeFileSync(join(root, "recovery-fork-ready"), forkDigest(missing) + "\n");
    assert.throws(() => readRecoveryFork(changedPin), /immutable job pin/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("controller assurance binds real Git diff, original Turn source and immutable review decision across restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "nt-assurance-"));
  const git = (...args: string[]) => execFileSync("git", args,
    { cwd: root, encoding: "utf8" }).trim();
  const write = (text: string) => writeFileSync(join(root, "story/characters/nia.md"), text);
  try {
    mkdirSync(join(root, "story/characters"), { recursive: true });
    mkdirSync(join(root, "story/events"), { recursive: true });
    git("init", "-q"); git("config", "user.name", "Author");
    git("config", "user.email", "author@example.test");
    write("# Nia\\n");
    writeFileSync(join(root, "story/events/ambush.md"), "# Ambush\\n");
    git("add", "."); git("commit", "-qm", "baseline");
    const baseSha = git("rev-parse", "HEAD");
    const stateDir = join(root, "state");
    mkdirSync(stateDir);
    const job = { jobId: "test-job", baseSha, worktreeRoot: root, storyRelativePath: "story",
      validatorVersion: "1.0.0", stateDir } as JobStartResult;
    const contract = { scope: { kind: "partial" as const, depth: "composition" as const,
      targets: ["character.nia"], branches: [] }, constraints: [],
      envelope: { presentation: "Visual novel", hardLimits: [], preferences: [] } };
    const catalog = [{ path: "characters/nia.md", metadata: {
      id: "character.nia", type: "character", status: "draft" } }];
    const plan = planRevision("Make Nia more thoughtful", contract, baseSha, job.jobId,
      catalog, ["character.nia"], ["characters/nia.md"]);
    await saveJobTurnPlan(job, plan);
    write("# Nia\\nA new insight.\\n"); git("add", "story"); git("commit", "-qm", "edit Nia");
    const commitSha = git("rev-parse", "HEAD");
    const point = { jobId: job.jobId, baseSha, parentSha: baseSha, commitSha,
      workItem: "focus:character.nia", proofDigest: "f".repeat(64),
      validation: { status: "passed", validatorVersion: "1.0.0" } } as RecoveryCheckpoint;
    const first = await checkpointAssurance(job, point);
    assert.ok(first);
    assert.equal(first.reviewSelection.status, "not-required");
    assert.deepEqual(first.changedPaths, ["characters/nia.md"]);
    assert.equal(first.assignmentId, "focus:character.nia");
    assert.equal(first.turnDigest, plan.digest);
    assert.equal(first.baseSha, baseSha);
    assert.equal(first.commitSha, commitSha);
    assert.match(first.diffDigest, /^[a-f0-9]{64}$/);
    const reopened = await checkpointAssurance({ ...job }, { ...point, assurance: first });
    assert.deepEqual(reopened, first, "restarting cannot silently change assurance selection");
    assert.deepEqual(await readIndependentReview(job, first), { status: "not-required", result: null });
    await assert.rejects(sealIndependentReview(job, { ...point, assurance: first }, {
      version: 1, source: { jobId: first.jobId, commitSha: first.commitSha,
        turnDigest: first.turnDigest, assignmentId: first.assignmentId,
        assignmentDigest: first.assignmentDigest, diffDigest: first.diffDigest,
        validationProofDigest: first.validationProofDigest }, reviewer: "self",
      status: "passed", findings: [], evidence: "untrusted writer assertion",
    }), /unvalidated or changed/);
    await assert.rejects(inspectCheckpointReview(job, { ...point, assurance: {
      ...first, changedPaths: ["events/ambush.md"], reviewSelection: {
        status: "required-pending", reasons: ["high-impact-record"] } },
    }), /differs/);
    await assert.rejects(checkpointAssurance({ ...job, baseSha: "a".repeat(40) }, point),
      /corrupt\/stale/);
    writeFileSync(join(root, "story/events/ambush.md"), "# Ambush\\nChanged unrequested event.\\n");
    git("add", "story"); git("commit", "-qm", "unrequested Event");
    const unauthorized = { ...point, parentSha: commitSha, commitSha: git("rev-parse", "HEAD") };
    await assert.rejects(checkpointAssurance(job, unauthorized), /exceeds the controller-authorized/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
