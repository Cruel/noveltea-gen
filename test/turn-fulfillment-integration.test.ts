import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { JobStartResult } from "../src/job.js";
import type { JobReport } from "../src/job-report.js";
import { planRevision } from "../web/src/lib/turn-plan.js";
import { assessTurnFulfillment, prepareTurnFulfillment } from "../src/turn-fulfillment.js";

function git(dir: string, ...args: string[]) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

test("real Git source, pinned Turn and approved plan yield a restart-safe targeted follow-up without replay", async () => {
  const temp = mkdtempSync(join(tmpdir(), "nt-turn-controller-"));
  try {
    const repo = join(temp, "repo"), story = join(repo, "story"),
      stateDir = join(temp, "state");
    mkdirSync(join(story, "characters"), { recursive: true });
    mkdirSync(stateDir);
    git(repo, "init", "-q");
    git(repo, "config", "user.name", "Test");
    git(repo, "config", "user.email", "test@example.invalid");
    writeFileSync(join(story, "characters", "nia.md"), "Nia has a motive.\n");
    git(repo, "add", "."); git(repo, "commit", "-qm", "Initial canonical Nia");
    const base = git(repo, "rev-parse", "HEAD");
    writeFileSync(join(story, "characters", "nia.md"), "Nia has a motive.\nNia confesses.\n");
    git(repo, "add", "."); git(repo, "commit", "-qm", "One narrow specialist revision");
    const head = git(repo, "rev-parse", "HEAD");
    const contract = { scope: { kind: "partial" as const, depth: "composition" as const,
      targets: ["character.nia"], branches: [] as string[] },
    constraints: ["Nia must still have agency"], envelope: {
      presentation: "Dialogue-led mystery", hardLimits: [] as string[], preferences: [] as string[] } };
    const original = "Nia must confess AND be able to refuse";
    const plan = planRevision(original, contract, base, "parent-job", [{
      path: "characters/nia.md",
      metadata: { id: "character.nia", type: "character", status: "active" },
    }], ["character.nia"], ["characters/nia.md"]);
    writeFileSync(join(stateDir, "turn-plan.json"), JSON.stringify(plan));
    const approved = { version: 1, contract, items: [{
      id: "focus-character-nia", kind: "realization", targetIds: ["character.nia"], status: "verified",
    }] };
    writeFileSync(join(stateDir, "architecture.json"), JSON.stringify({ plan: approved, history: [] }));
    // Historical receipt inventory is not a quota on unrelated local plans.
    mkdirSync(join(stateDir, "event-items"));
    for (let i = 0; i < 35; i++) {
      writeFileSync(join(stateDir, "event-items", `historical-${i}.json`),
        JSON.stringify({ jobId: "old-job", milestoneId: `milestone.historical-${i}`,
          phase: "pending" }));
    }
    writeFileSync(join(stateDir, "narrative-review.json"), JSON.stringify({
      planVersion: 1, headSha: head, phase: "completed", worker: "pi", editorial: { verdict: "pass" },
    }));
    const job = { jobId: "child-job", stateDir, worktreeRoot: repo,
      storyRelativePath: "story", headSha: head, baseSha: base } as JobStartResult;
    const report = { identity: { headSha: head, baseSha: base }, plan: approved,
      generation: { scopeFulfillment: "complete-in-scope" }, evidence: {
        scope: { current: true, scopedPaths: ["characters/nia.md"] },
        editorial: { verdict: "pass" },
      } } as unknown as JobReport;
    const packet = await prepareTurnFulfillment(job, {
      headSha: head, baseSha: base, planVersion: 1, contract,
      scopeCurrent: true, scopeComplete: true, editorialPass: true,
      scopedPaths: ["characters/nia.md"],
    });
    assert.equal(packet?.source.baseSha, base);
    assert.equal(packet?.source.headSha, head);
    assert.equal(packet?.source.turnDigest, plan.digest);
    assert.equal(packet?.source.planVersion, 1);
    let calls = 0;
    const evaluator = async (p: NonNullable<typeof packet>) => {
      calls++;
      return { digest: p.digest, verdict: "incomplete",
        checks: p.objectives.map(o => ({ objectiveId: o.id, fulfilled: o.id !== "goal",
          evidence: o.id === "goal" ? [] : [{ path: "characters/nia.md",
            line: 2, explanation: "Nia confesses, but refusal was never represented." }] })),
        findings: [{ objectiveId: "goal",
          message: "Nia has no refusal option in the final Story.",
          followUp: { assignmentId: "focus:character.nia",
            outcome: "Give Nia a genuine refusal choice within the approved Character edit",
            targets: ["character.nia"] } }] };
    };
    const saved = await assessTurnFulfillment(job, report, "independent-plan-review", evaluator);
    assert.equal(saved?.verdict?.verdict, "incomplete");
    assert.equal(saved?.verdict?.findings[0]?.followUp?.targets[0], "character.nia");
    const restarted = await assessTurnFulfillment({ ...job }, report, "independent-plan-review", evaluator);
    assert.deepEqual(restarted, saved);
    assert.equal(calls, 1, "restart returns immutable decision; successful specialist is not repeated");
    const archived = JSON.parse(readFileSync(join(stateDir, "turn-fulfillment", packet!.digest + ".json"), "utf8"));
    assert.equal(archived.source.baseSha, base);
    assert.equal(archived.source.headSha, head);
    writeFileSync(join(stateDir, "architecture.json"), JSON.stringify({
      plan: { ...approved, version: 2 }, history: [],
    }));
    await assert.rejects(prepareTurnFulfillment(job, {
      headSha: head, baseSha: base, planVersion: 1, contract,
      scopeCurrent: true, scopeComplete: true, editorialPass: true,
      scopedPaths: ["characters/nia.md"],
    }), /Approved generation plan differs/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
