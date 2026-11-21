/** #217: synthetic nonprivate incident, real Git blobs, original adaptive
 * admission and restart. Nothing in this fixture calls Pi or a Story writer. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Skill } from "@earendil-works/pi-coding-agent";
import type { JobStartResult } from "../src/job.js";
import { createSkillSnapshot } from "../src/snapshot.js";
import { createSandboxPiTools } from "../src/sandbox-pi-tools.js";
import { adaptiveStoryReadKind, assertAdaptiveTrackedRead } from "../src/adaptive-source-reads.js";
import { beginAdaptiveAttempt, emptyAdaptiveState, readAdaptiveState,
  settleAdaptiveAttempt } from "../src/adaptive-state.js";
import { admitAdaptiveAssignments, revalidateAdaptiveAmendment,
  applyAdaptiveAssignments, type AdaptiveAdmission } from "../src/adaptive-assignments.js";
import { canonicalPreviousAdaptiveInventory } from "../src/adaptive-work.js";
import type { Plan } from "../src/architecture.js";
import { pendingDigest } from "../src/pending-work-amendments.js";
import { nextExecutionItem, type GenerationInventory,
  type ExecutionItem } from "../src/generation-plan.js";

const hash = (body: string | Buffer) => createHash("sha256").update(body).digest("hex");
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "nt-issue-217-"));
  const repo = join(dir, "repo"), story = join(repo, "story"), stateDir = join(dir, "state");
  mkdirSync(join(story, "milestones"), { recursive: true });
  mkdirSync(join(repo, "skills", "nt-catalog"), { recursive: true });
  mkdirSync(join(repo, "skills", "nt-story-orchestrate"), { recursive: true });
  mkdirSync(stateDir);
  writeFileSync(join(story, "README.txt"), "Nonprivate synthetic Story notes.\n");
  writeFileSync(join(story, "milestones", "arrival.md"), "Canonical evidence at the archive.\n");
  for (const name of ["nt-catalog", "nt-story-orchestrate"])
    writeFileSync(join(repo, "skills", name, "SKILL.md"),
      "---\nname: " + name + "\n---\nSynthetic methodology.\n");
  const git = (...args: string[]) => execFileSync("git", args, {
    cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q"); git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("add", "."); git("commit", "-qm", "Synthetic native Story source");
  const sha = git("rev-parse", "HEAD");
  const job = { stateDir, worktreeRoot: repo, worktreeStoryRoot: story,
    storyRelativePath: "story", jobId: "job", threadId: "thread",
    baseSha: sha, headSha: sha, branch: git("branch", "--show-current"),
    status: "ready" } as JobStartResult;
  const turn = "a".repeat(64);
  return { dir, repo, story, stateDir, git, sha, job, turn };
}
function originalAdmission(f: ReturnType<typeof fixture>): AdaptiveAdmission {
  const work = (id: string, stage: ExecutionItem["stage"], dependencies: string[],
    status: ExecutionItem["status"] = "pending"): ExecutionItem => ({
    id, stage, ...(id.includes(":") ? { milestone: id.split(":")[1] } : {}),
    kind: stage === "composition" ? "composition" : "realization",
    targetIds: id.includes(":") ? ["milestone.arrival"] : [],
    dependencies, plannedItems: [], skills: [], checks: [],
    authorization: { source: "trusted-controller", planVersion: 1, paths: [] },
    planVersion: 1, status, ...(status === "verified" ? { verifiedSha: f.sha } : {}),
  });
  const contract: Plan["contract"] = {
    scope: { kind: "full-story", depth: "composition", targets: [], branches: [] },
    constraints: [], envelope: { presentation: "Visual novel", hardLimits: [], preferences: [] },
  };
  const plan: Plan = { version: 1, contract, items: [{
    ...work("global-architecture", "architecture", [], "verified"),
    kind: "architecture", targetIds: ["milestone.arrival"],
  }] };
  const inventory: GenerationInventory = { version: 1, planVersion: 1, headSha: f.sha,
    rationale: "Verified Foundation and Architecture; World awaits execution",
    items: [work("foundation", "foundation", [], "verified"),
      work("architecture", "architecture", ["foundation"], "verified"),
      work("foundations", "foundations", ["architecture"]),
      work("event:milestone.arrival", "event", ["foundations"]),
      work("interactive:milestone.arrival", "interactive", ["event:milestone.arrival"]),
      work("composition:milestone.arrival", "composition", ["interactive:milestone.arrival"]),
      work("review", "review", ["composition:milestone.arrival"])],
  };
  const path = "milestones/arrival.md";
  const sourceHashes = { [path]: hash(readFileSync(join(f.story, path))) };
  const actions = [{ kind: "split" as const, item: "interactive:milestone.arrival",
    domains: ["choice", "puzzle"] as Array<"choice" | "puzzle"> }];
  const order = ["foundations", "event:milestone.arrival", "choice:milestone.arrival",
    "puzzle:milestone.arrival", "composition:milestone.arrival", "review"];
  return {
    proposal: { sourceSha: f.sha, turnDigest: f.turn, beforeVersion: 1,
      reason: "Source-grounded split with preserved World dependency", actions, order },
    inventory, plan, turnDigest: f.turn, version: 1, verifiedSource: true,
    records: [{ path, metadata: { type: "milestone", id: "milestone.arrival",
      status: "approved", decisions: [] } }],
    sourceHashes, milestoneSourceHashes: sourceHashes, protectedPaths: [],
    authorTargets: [], typedEdges: [], omissionProofs: [],
    planning: { choice_frequency: "frequent", puzzle_emphasis: "none",
      choice_points: { min: 2, max: 10 } },
    carried: [{ id: "foundation", sha: f.sha }, { id: "architecture", sha: f.sha }],
  };
}

async function setup(f: ReturnType<typeof fixture>) {
  const snapshot = (await createSkillSnapshot({ discovery: "explicit-only",
    novelteaSkills: f.repo, skillDirs: [], requiredSkills: [] }))!;
  assert.ok(snapshot);
  const state = emptyAdaptiveState(f.job, f.turn, 1);
  const signature = pendingDigest({ source: f.sha, stage: "world-foundations" });
  await beginAdaptiveAttempt(f.job, state, f.sha, signature);
  const admission = originalAdmission(f);
  const entry = admitAdaptiveAssignments(admission);
  const { reason, actions, order } = admission.proposal;
  const sessionDir = join(f.stateDir, "adaptive-planning-sessions");
  mkdirSync(sessionDir);
  const sessionFile = join(sessionDir, "original.jsonl");
  writeFileSync(sessionFile, '{"type":"session","id":"original-planner"}\n' +
    '{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Synthetic approved plan"}]}}\n');
  const evidence = { sessionFile, sessionSha256: hash(readFileSync(sessionFile)),
    snapshotId: snapshot.id, provider: "openai", model: "synthetic-fixture",
    skillReads: [join(snapshot.path, "skills/nt-catalog/SKILL.md"),
      join(snapshot.path, "skills/nt-story-orchestrate/SKILL.md"),
      join(f.story, "milestones/arrival.md"), join(f.story, "README.txt")],
    proposalDigest: pendingDigest({ sourceSha: f.sha, turnDigest: f.turn,
      beforeVersion: 1, reason, actions: entry.actions, order }),
  };
  return { snapshot, state, signature, entry, sessionFile, evidence, admission };
}

test("the original admitted proposal restores after a tracked ancillary README read and World is schedulable", async () => {
  const f = fixture();
  try {
    const { state, signature, entry, evidence, admission } = await setup(f);
    await settleAdaptiveAttempt(f.job, state, signature, "admitted", entry, evidence);
    assert.equal(adaptiveStoryReadKind("README.txt"), "ancillary");
    assert.equal(adaptiveStoryReadKind("milestones/arrival.md"), "canonical");
    assert.equal(adaptiveStoryReadKind("milestones/README.txt"), null);
    assert.equal(assertAdaptiveTrackedRead(f.job, f.sha, join(f.story, "README.txt")).relativePath,
      "README.txt");
    // Restart after a distinct reviewed descendant. The original admission
    // remains pinned; no planner, Foundation or Architecture invocation occurs.
    writeFileSync(join(f.story, "milestones", "later.md"), "Separate verified descendant.\n");
    f.git("add", "."); f.git("commit", "-qm", "Independent later Story work");
    const restored = await readAdaptiveState(f.job, f.turn, 1);
    assert.deepEqual(restored?.entries, [entry]);
    assert.deepEqual(restored?.attempts[0]?.session, evidence);
    assert.equal(restored?.attempts[0]?.phase, "admitted");
    // Exercise the production re-admission and overlay restoration helpers,
    // not a synthetic scheduler array. No Pi or upstream writer is invoked.
    const nextSha = f.git("rev-parse", "HEAD");
    const certified = revalidateAdaptiveAmendment(entry, {
      ...admission, inventory: { ...admission.inventory, headSha: nextSha },
    });
    assert.equal(certified.inventory.items.some(item => item.id === "interactive:milestone.arrival"),
      false, "original approved split remains authoritative");
    assert.ok(certified.inventory.items.some(item => item.id === "choice:milestone.arrival"));
    assert.equal(nextExecutionItem(certified.inventory, certified.order)?.id, "foundations",
      "the verified Architecture permits World foundations immediately");
    const firstAdmitted = applyAdaptiveAssignments(admission.inventory, entry);
    const original = await canonicalPreviousAdaptiveInventory(f.job, f.turn, 1,
      firstAdmitted, 2);
    assert.deepEqual(original?.items, admission.inventory.items,
      "production graph's canonical reconciliation recovers the original base inventory");
    assert.equal(restored?.attempts.length, 1, "no replacement planner call or receipt");
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("admission and restoration fail closed on unsafe, untracked, symlink and foreign ancillary reads", async () => {
  const f = fixture();
  try {
    const { state, signature, entry, evidence, sessionFile } = await setup(f);
    await assert.rejects(settleAdaptiveAttempt(f.job, state, signature,
      "admitted", entry, { ...evidence, skillReads: [join(f.story, "README.txt")] }),
    /lacks pinned methodology reads/,
    "ancillary README cannot stand in for a genuine pinned skill read");
    for (const path of [
      f.story + "/milestones/../README.txt",
      f.story + "/other/../README.txt",
      join(f.story, "milestones/README.txt"),
      join(f.story, "untracked.md"),
      join(f.repo, "README.txt"),
      "/tmp/foreign-story/README.txt",
    ]) {
      await assert.rejects(settleAdaptiveAttempt(f.job, state, signature, "admitted", entry,
        { ...evidence, skillReads: [...evidence.skillReads.slice(0, -1), path] }),
      /unsafe|canonical|roots|tracked|travers/i);
      assert.equal(state.attempts[0]?.phase, "planning",
        "rejected admission cannot mutate a planning receipt");
    }
    await settleAdaptiveAttempt(f.job, state, signature, "admitted", entry, evidence);
    const receipt = join(f.stateDir, "adaptive-plan.json");
    const saved = JSON.parse(readFileSync(receipt, "utf8"));
    async function corrupt(path: string, pattern: RegExp) {
      saved.attempts[0].session.skillReads = [...evidence.skillReads.slice(0, -1), path];
      const { digest: _digest, ...body } = saved;
      saved.digest = pendingDigest(body);
      writeFileSync(receipt, JSON.stringify(saved));
      await assert.rejects(readAdaptiveState(f.job, f.turn, 1), pattern);
    }
    await corrupt(join(f.story, "another.txt"), /canonical|tracked/);
    await corrupt(join(f.repo, "README.txt"), /roots/);
    await corrupt(f.story + "/milestones/../README.txt", /unsafe|travers/);
    saved.attempts[0].session.skillReads = evidence.skillReads;
    const { digest: _digest, ...body } = saved;
    saved.digest = pendingDigest(body);
    writeFileSync(receipt, JSON.stringify(saved));
    assert.equal((await readAdaptiveState(f.job, f.turn, 1))?.version, 2);
    writeFileSync(sessionFile, "corrupted original planner transcript");
    await assert.rejects(readAdaptiveState(f.job, f.turn, 1), /transcript changed/);
    assert.deepEqual(state.entries, [entry], "evidence remains available for diagnosis");
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("adaptive sandbox exposes only pinned regular reads and filters search/discovery", async () => {
  const f = fixture();
  try {
    const { snapshot } = await setup(f);
    const calls: string[][] = [];
    const client = {
      async acquire(id: string) { return { jobId: id, status: "running" }; },
      async execute(_id: string, args: string[], report: (stream: "stdout" | "stderr", value: string) => void) {
        calls.push(args);
        report("stdout", "Synthetic Story text\n");
        return 0;
      },
    };
    const skills: Skill[] = ["nt-catalog", "nt-story-orchestrate"].map(name => ({
      name, baseDir: join(snapshot.path, "skills", name),
      filePath: join(snapshot.path, "skills", name, "SKILL.md"),
    } as Skill));
    const tools = await createSandboxPiTools(f.job, snapshot, skills, client,
      "read-only", "orchestrator", { kind: "adaptive", sourceSha: f.sha });
    const tool = (name: string) => tools.find(item => item.name === name)!;
    const call = (name: string, input: Record<string, unknown>) =>
      tool(name).execute("synthetic", input, undefined as never, undefined as never, undefined as never);
    await call("read", { path: "README.txt" });
    await call("read", { path: "milestones/arrival.md" });
    await call("grep", { pattern: "archive" });
    assert.ok(calls.at(-1)?.includes("/story/README.txt"));
    assert.ok(calls.at(-1)?.includes("/story/milestones/arrival.md"));
    const found = JSON.stringify((await call("find", { pattern: "*.txt" })).content);
    assert.match(found, /README\.txt/);
    assert.doesNotMatch(found, /\/story\/README\.txt/,
      "discovery returns a relative path accepted by the sandbox read tool");
    assert.doesNotMatch(found, /untracked\.txt/);
    writeFileSync(join(f.story, "untracked.txt"), "Untracked cannot enter search\n");
    assert.deepEqual((await call("ls", { path: "." })).content?.[0]?.type, "text");
    await assert.rejects(call("read", { path: "untracked.txt" }), /authorized|canonical/);
    await assert.rejects(call("read", { path: "milestones/../README.txt" }), /unsafe|travers/);
    await assert.rejects(call("read", { path: join(f.repo, "README.txt") }), /authorized|canonical/);
    writeFileSync(join(f.story, "README.txt"), "Modified after pinned source\n");
    await assert.rejects(call("read", { path: "README.txt" }), /differs from the pinned/);
    assert.ok(!calls.some(args => args.includes("/story/untracked.txt")),
      "untracked sources never reach the sandbox worker");
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("a Git symlink README and missing tracked root README never become adaptive sources", async () => {
  const f = fixture();
  try {
    unlinkSync(join(f.story, "README.txt"));
    symlinkSync("milestones/arrival.md", join(f.story, "README.txt"));
    f.git("add", "-A"); f.git("commit", "-qm", "Symlink instead of text");
    const symlinkSha = f.git("rev-parse", "HEAD");
    assert.throws(() => assertAdaptiveTrackedRead(f.job, symlinkSha, "README.txt"),
      /regular|tracked/);
    unlinkSync(join(f.story, "README.txt"));
    f.git("add", "-A"); f.git("commit", "-qm", "Remove README");
    assert.throws(() => assertAdaptiveTrackedRead(f.job, f.git("rev-parse", "HEAD"), "README.txt"),
      /regular|tracked/);
    // The original regular blob remains valid evidence at its original SHA.
    assert.equal(assertAdaptiveTrackedRead(f.job, f.sha, "README.txt").relativePath, "README.txt");
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
