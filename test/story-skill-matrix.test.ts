import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getAgentDir, loadSkills } from "@earendil-works/pi-coding-agent";
import { creativePolicy, type CreativeMode } from "../src/creative-policy.js";
import { verifyOrchestratorProposal } from "../src/orchestrator-planner.js";
import { assertPortableOrchestrationSkills, requiredOrchestratorSkillReads } from "../src/story-skill-policy.js";
import { createSkillReadTool, roleVisibleSkills } from "../src/skills.js";
import { createSkillSnapshot, verifiedSkillFiles } from "../src/snapshot.js";
import { planObjective, verifyTurnPlan } from "../web/src/lib/turn-plan.js";
import { removeTestTree } from "./helpers.js";

const cases = [
  { id: "story-orchestrate--new-autonomous", origin: "empty", mode: "autonomous" },
  { id: "story-orchestrate--new-collaborative", origin: "empty", mode: "collaborative" },
  { id: "story-orchestrate--existing-autonomous", origin: "existing", mode: "autonomous" },
  { id: "story-orchestrate--existing-collaborative", origin: "existing", mode: "collaborative" },
] as const;

const sourceSha = "e".repeat(40);
const existingPath = "authored-content/tavi-conversation.md";
const existingId = "authored-content.tavi-conversation";
const envelope = { presentation: "Visual novel", hardLimits: [], preferences: [] };
const full = { scope: { kind: "full-story" as const, depth: "composition" as const,
  targets: [], branches: [] }, constraints: [], envelope };
const partial = { scope: { kind: "partial" as const, depth: "composition" as const,
  targets: [existingId], branches: [] }, constraints: [], envelope };

function plan(origin: "empty" | "existing", mode: CreativeMode) {
  return origin === "empty"
    ? planObjective({ kind: "full-story", request: "Make me a mystery game with playable scenes",
      contract: full, base: sourceSha, policy: creativePolicy(mode) })
    : planObjective({ kind: "revision", request: "Add Tavi's pre-choice conversation",
      contract: partial, base: sourceSha, sourceJobId: "verified-existing-story",
      catalog: [{ path: existingPath, metadata: {
        id: existingId, type: "authored-content", status: "draft",
        events: ["event.speak-with-tavi"] } }],
      targetIds: [existingId], allowedPaths: [existingPath], policy: creativePolicy(mode) });
}

function createCheckout(root: string): string {
  const checkout = join(root, "portable-skills");
  const resources = [
    "nt-story-orchestrate/SKILL.md",
    "nt-story-orchestrate/references/planning.md",
    "nt-story-collaborate/SKILL.md",
    "nt-story-collaborate/references/interaction.md",
    "nt-story-discovery/SKILL.md",
    "nt-catalog/SKILL.md",
    "nt-catalog/references/records.md",
    "nt-catalog/references/progression.md",
    "nt-catalog/references/authority-and-validation.md",
  ];
  for (const resource of resources) {
    const fullPath = join(checkout, "skills", resource);
    mkdirSync(join(fullPath, ".."), { recursive: true });
    const name = resource.split("/")[0]!;
    writeFileSync(fullPath, resource.endsWith("SKILL.md")
      ? `---\nname: ${name}\ndescription: Pinned portable role\n---\n${resource}\n`
      : `Pinned reference ${resource}\n`);
  }
  for (const args of [["init", "-q"], ["config", "user.name", "Test"],
    ["config", "user.email", "test@example.invalid"], ["add", "."],
    ["commit", "-qm", "Skill matrix fixture"]]) {
    const result = spawnSync("git", args, { cwd: checkout, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  return checkout;
}

async function verifyMatrix(checkout: string) {
  const snapshot = await createSkillSnapshot({ discovery: "explicit-only",
    novelteaSkills: checkout, skillDirs: [], requiredSkills: [] });
  assert.ok(snapshot, "Skill checkout must produce a pinned snapshot");
  await assertPortableOrchestrationSkills(snapshot.path);
  const verified = await verifiedSkillFiles(snapshot.id);
  const loaded = loadSkills({ cwd: process.cwd(), agentDir: getAgentDir(),
    skillPaths: [join(snapshot.path, "skills")], includeDefaults: false });
  assert.equal(loaded.diagnostics.filter(d => d.type === "error").length, 0);
  // A historical compatibility package may exist, but must never be selected
  // or exposed as a live orchestration role.

  for (const scenario of cases) {
    const objective = plan(scenario.origin, scenario.mode);
    verifyTurnPlan(objective);
    assert.equal(objective.source.verifiedSha, sourceSha, scenario.id);
    assert.equal(objective.creativePolicy?.mode, scenario.mode, scenario.id);
    assert.equal(objective.objective.deliveryDepth, "composition", scenario.id);
    assert.equal(objective.kind === "full-story", scenario.origin === "empty", scenario.id);
    if (scenario.origin === "empty") {
      assert.ok(objective.assignments.some(a => a.specialist === "nt-story-discovery"));
      assert.ok(objective.objective.obligations.some(s => /player-facing/i.test(s)));
    } else {
      assert.deepEqual(objective.assignments.filter(a => a.id.startsWith("focus:"))
        .flatMap(a => a.authority.existingPaths), [existingPath], scenario.id);
      assert.equal(objective.assignments.some(a => a.authority.mayCreate), false);
    }
    const proposal = { sourceSha, turnDigest: objective.digest, assignments: objective.assignments.map(a =>
      ({ id: a.id, reason: "Verified canonical Story source" })) };
    assert.deepEqual(verifyOrchestratorProposal(proposal, objective), proposal);

    const visible = roleVisibleSkills(loaded.skills, "orchestrator", scenario.mode === "collaborative");
    const names = visible.map(s => s.name);
    assert.ok(names.includes("nt-story-orchestrate") && names.includes("nt-catalog"));
    assert.ok(names.includes("nt-story-discovery"));
    assert.equal(names.includes("nt-story-collaborate"), scenario.mode === "collaborative", scenario.id);
    assert.ok(!names.includes("nt-narrative-review") && !names.includes("nt-story-generate"));
    const read = createSkillReadTool(visible, verified);
    for (const resource of requiredOrchestratorSkillReads(scenario.mode)) {
      const result = await read.execute("matrix", { path: "skill://" + resource },
        undefined as never, undefined as never, undefined as never);
      assert.ok(result.content.some(item => item.type === "text" && item.text.trim()),
        scenario.id + " " + resource);
    }
    if (scenario.mode === "autonomous") {
      await assert.rejects(read.execute("denied",
        { path: "skill://nt-story-collaborate/SKILL.md" },
        undefined as never, undefined as never, undefined as never), /Skill read denied/);
    }
    const specialist = roleVisibleSkills(loaded.skills, "specialist");
    assert.ok(!specialist.some(s => ["nt-story-orchestrate", "nt-story-collaborate"].includes(s.name)));
  }
  return snapshot;
}

test("portable Gen 2x2 objective and pinned method-read matrix is source-bound", async () => {
  const root = mkdtempSync(join(tmpdir(), "nt-joint-skill-matrix-"));
  const original = process.env.NT_SKILL_CACHE_DIR;
  process.env.NT_SKILL_CACHE_DIR = join(root, "cache");
  try {
    const checkout = createCheckout(root);
    const snapshot = await verifyMatrix(checkout);
    assert.equal(snapshot.commit.length, 40);
    assert.equal(snapshot.id, snapshot.digest);
    assert.equal(existsSync(join(snapshot.path, "skills/nt-story-orchestrate/SKILL.md")), true);
    const manifestHash = createHash("sha256").update(readFileSync(
      join(snapshot.path, "skills/nt-story-orchestrate/SKILL.md"))).digest("hex");
    assert.equal(manifestHash.length, 64);
    rmSync(join(checkout, "skills/nt-story-collaborate/references/interaction.md"));
    await assert.rejects(assertPortableOrchestrationSkills(checkout),
      /nt-story-collaborate\/references\/interaction\.md.*new verified Turn/i);
    await assert.doesNotReject(assertPortableOrchestrationSkills(snapshot.path));
  } finally {
    if (original === undefined) delete process.env.NT_SKILL_CACHE_DIR;
    else process.env.NT_SKILL_CACHE_DIR = original;
    removeTestTree(root);
  }
});

test("opt-in actual skills checkout meets the four Gen consumption contracts", {
  skip: !process.env.NT_SKILLS_CHECKOUT && "Set NT_SKILLS_CHECKOUT to run the cross-repo matrix",
}, async () => {
  const checkout = process.env.NT_SKILLS_CHECKOUT!;
  const status = spawnSync("git", ["-C", checkout, "status", "--porcelain"],
    { encoding: "utf8" });
  assert.equal(status.status, 0, status.stderr);
  const before = status.stdout;
  const snap = await verifyMatrix(checkout);
  assert.equal(snap.dirty, !!before, "Git provenance must capture source modifications");
  const after = spawnSync("git", ["-C", checkout, "status", "--porcelain"],
    { encoding: "utf8" });
  assert.equal(after.status, 0, after.stderr);
  assert.equal(after.stdout, before, "Gen must not alter the upstream skills checkout");
});
