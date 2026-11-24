/** CLI revision certification. The only substituted effects are Pi transport
 * and the sandbox filesystem. No fixture flag or injected Review boundary. */
import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startStoryJob } from "../../src/job.js";
import { parseGenerationContract } from "../../src/generation.js";
import { validateStoryJob } from "../../src/validator.js";
import type { CanonicalScopeRecord } from "../../src/focused-scope.js";
import { readTurnEvidence, type TurnEvidence } from "../../src/turn-plan-evidence.js";
import { planObjective } from "../../web/src/lib/turn-plan.js";
import { saveJobTurnPlan } from "../../web/src/lib/turn-plan-receipt.server.js";
import { requiredOrchestratorSkillReads } from "../../src/story-skill-policy.js";
import { boundedPinnedSources } from "../../src/bounded-specialist-prompt.js";
import { withJobModelRuntime } from "../../src/model-runtime.js";
import { fixtureSandboxClient, scriptedModel, scriptedReadCalls, scriptedStoryRuntime, scriptedText } from "../c03-scripted-story-helpers.js";
import type { ReviewAssignment } from "../../src/narrative-review-specialist.js";
import type { TurnFulfillmentPacket } from "../../src/turn-fulfillment.js";

const args = process.argv.slice(2);
assert.deepEqual(args.slice(0, 2), ["job", "generate"]);
assert.ok(!args.includes("--fixture"));
const arg = (name: string) => {
  const index = args.indexOf(name);
  assert.ok(index >= 0 && args[index + 1], "Missing test CLI argument " + name);
  return args[index + 1]!;
};
const job = await startStoryJob({ story: arg("--story"), job: arg("--job") }, false);
let plan: TurnEvidence;
if (args[2] === "start") {
  const contract = parseGenerationContract(JSON.parse(readFileSync(arg("--contract"), "utf8")));
  const native = await validateStoryJob(job, arg("--skills-source"), { ...job, baseSha: job.baseSha });
  assert.equal(native.status, "passed", JSON.stringify(native));
  const catalog = (native.report as { records: CanonicalScopeRecord[] }).records;
  const targets = contract.scope.targets;
  const paths = [...targets, ...(contract.scope.supportingTargets ?? [])].map(id => {
    const record = catalog.find(r => r.metadata.id === id);
    assert.ok(record, "No canonical revision target: " + id);
    return record.path;
  });
  plan = planObjective({ kind: "revision", request: arg("--task"), contract, base: job.baseSha,
    sourceJobId: "author-baseline", catalog, targetIds: targets, allowedPaths: paths });
  await saveJobTurnPlan(job, plan);
  assert.equal(arg("--provider"), scriptedModel.provider);
  assert.equal(arg("--model"), scriptedModel.id);
} else {
  const hint = JSON.parse(readFileSync(join(job.stateDir, "turn-plan.json"), "utf8")) as TurnEvidence;
  const saved = await readTurnEvidence(job, hint.contract, hint.originalRequest, hint.digest);
  assert.ok(saved);
  plan = saved;
}
const owned = new Set(plan.assignments.flatMap(a => a.authority.existingPaths));
let lastPrompt = "", step = 0;
const { runtime } = await scriptedStoryRuntime((index, context) => {
  const messages = context.messages as Array<{ role: string; content: Array<{ text?: string }> | string }>;
  const prompt = messages.filter(m => m.role === "user").flatMap(m =>
    typeof m.content === "string" ? [m.content] : m.content.map(c => c.text ?? "")).at(-1) ?? "";
  if (prompt !== lastPrompt) { lastPrompt = prompt; step = 0; }
  const phase = step++;
  const read = (paths: string[]) => ({ content: scriptedReadCalls(paths, index), reason: "toolUse" as const });
  const stop = (value: unknown) => ({ content: scriptedText(value), reason: "stop" as const });
  const log = process.env.NT_TEST_SCRIPTED_MODEL_LOG;
  assert.ok(log);
  const note = (kind: string) => appendFileSync(log, JSON.stringify({ kind, command: args[2], index }) + "\n");
  try {
  if (prompt.includes("revision specialist. FIRST")) {
    note("writer");
    const match = prompt.match(/Only edit these PREEXISTING canonical Markdown files:\n([\s\S]+?)\nAll other files/);
    assert.ok(match);
    const paths = match[1]!.split("\n");
    assert.ok(paths.every(path => owned.has(path)));
    const assignment = plan.assignments.find(a => a.authority.existingPaths.some(p => paths.includes(p)));
    assert.ok(assignment);
    const skill = assignment.specialist;
    if (!phase) return read([skill + "/SKILL.md", "nt-catalog/SKILL.md", "nt-catalog/references/records.md",
      ...(assignment.targets.some(t => t.startsWith("event.")) ? ["nt-catalog/references/progression.md"] : [])].map(p => "skill://" + p));
    if (phase === 1) return { reason: "toolUse", content: paths.map((path, i) => {
      const old = readFileSync(join(job.worktreeStoryRoot, path), "utf8");
      return { type: "toolCall" as const, name: "edit", id: "focused-edit-" + index + "-" + i,
        arguments: { path, edits: [{ oldText: old, newText: old + "\nAda seeks the missing ledger to protect the witness from a false accusation.\n" }] } };
    }) };
    return stop({ modifiedRecords: paths, architecturalConflicts: [], laterObligations: [] });
  }
  if (prompt.includes("IMMUTABLE REVIEW PACKET")) {
    note("assignment-review");
    if (!phase) return read(boundedPinnedSources("nt-narrative-review").map(p => "skill://" + p));
    const packet = JSON.parse(prompt.split("\nIMMUTABLE REVIEW PACKET\n")[1]!);
    assert.ok(packet.items.length);
    return stop({ sourceDigest: packet.sourceDigest, verdict: "pass", findings: [],
      evidence: packet.items.flatMap((item: any) => {
        assert.equal(item.assurance.turnDigest, plan.digest);
        return item.assurance.changedPaths.map((path: string) => {
          assert.ok(owned.has(path));
          const lines = readFileSync(join(job.worktreeStoryRoot, path), "utf8").split("\n");
          const line = lines.findIndex(t => t.includes("protect the witness from a false accusation")) + 1;
          assert.ok(line > 0);
          return { commitSha: item.assurance.commitSha, assignmentId: item.assignment.id, path, line,
            explanation: "The added motivation establishes why Ada seeks the missing ledger." };
        });
      }) });
  }
  if (prompt.includes("You are the independent nt-narrative-review editor")) {
    note("narrative-review");
    const assignment = JSON.parse(prompt.split("\nASSIGNMENT:\n")[1]!) as ReviewAssignment;
    if (!phase) return read(prompt.split("PINNED REFERENCES:\n")[1]!.split("\nSTORY PATHS:")[0]!
      .split("\n").filter(p => p.startsWith("skill://")).concat(assignment.paths));
    const evidence: string[] = assignment.paths.map(path => {
      const lines = readFileSync(join(job.worktreeStoryRoot, path), "utf8").split("\n");
      const line = lines.findIndex(t => t.startsWith("id: ")) + 1;
      assert.ok(line > 0);
      return path + ":" + line + ": The declared canonical record remains present.";
    });
    const cite = (path: string, exact: string, label: string) => {
      assert.ok(assignment.paths.includes(path), "Route source not provided to reviewer: " + path);
      const lines = readFileSync(join(job.worktreeStoryRoot, path), "utf8").split("\n");
      const line = lines.findIndex(t => t.trim() === exact) + 1;
      assert.ok(line > 0, "Missing exact route source: " + exact);
      return label + ": " + path + ":" + line + " " + exact;
    };
    for (const route of assignment.routes) {
      assert.equal(route.status, "reachable");
      evidence.push(cite("events/" + route.event.split(".")[1] + ".md",
        "- id: " + route.branch, route.event + "#" + route.step + "/" + route.branch));
    }
    for (const route of assignment.milestoneRoutes) {
      assert.equal(route.status, "reachable");
      assert.equal(route.milestone, "milestone.disclosure");
      evidence.push(cite("milestones/disclosure.md", "fulfillment: {any_of: [[event.disclose-ledger]]}",
        route.milestone + "#" + route.alternative));
    }
    for (const route of assignment.puzzleRoutes) {
      assert.equal(route.puzzle, "puzzle.ledger-proof");
      assert.ok(["event.decode-ledger", "event.request-testimony"].includes(route.event));
      evidence.push(cite("puzzles/ledger-proof.md", "solutions: [event.decode-ledger, event.request-testimony]",
        route.puzzle + "/" + route.event));
    }
    return stop({ verdict: "pass", findings: [], evidence });
  }
  if (prompt.includes("PLAN-LEVEL PACKET")) {
    note("turn-review");
    const packet = JSON.parse(prompt.split("\nPLAN-LEVEL PACKET:\n")[1]!) as TurnFulfillmentPacket;
    if (!phase) return read(prompt.split("PINNED REFERENCES:\n")[1]!.split("\nPLAN-LEVEL PACKET:")[0]!
      .split("\n").filter(p => p.startsWith("skill://")).concat(packet.canonical.map(c => c.path)));
    const edited = packet.canonical.filter(c => owned.has(c.path) && c.content.includes("protect the witness from a false accusation"));
    assert.ok(edited.length);
    const witness = (record: (typeof packet.canonical)[number], text: string, explanation: string) => {
      const line = record.content.split("\n").findIndex(t => t.includes(text)) + 1;
      assert.ok(line > 0, record.path + ": missing " + text);
      return { path: record.path, line, explanation };
    };
    return stop({ digest: packet.digest, verdict: "complete", findings: [],
      checks: packet.objectives.map(o => {
        const evidence = edited.map(c => witness(c, "protect the witness from a false accusation",
          "The bounded motivation revision is present in the authorized canonical record."));
        if (o.id.startsWith("delivery:branch:")) {
          const branch = packet.criteria.branches[Number(o.id.split(":").at(-1))];
          const event = packet.canonical.find(c => c.path === "events/disclose-ledger.md");
          const choice = packet.canonical.find(c => c.path === "choice-points/loyalty.md");
          assert.ok(branch === "protect" || branch === "challenge");
          assert.ok(event || choice, "Branch delivery lacks canonical source in the packet");
          evidence.push(event ? witness(event, "value: " + branch, "The event binds the requested distinct choice outcome.") :
            witness(choice!, "id: " + branch, "The requested choice outcome remains declared."));
        }
        return { objectiveId: o.id, fulfilled: true, evidence };
      }) });
  }
  // Objective planning uses the real pinned plan, not a fixture-only scheduler.
  if (args[2] === "start" && index < 2) {
    note("planner");
    if (!index) return read(requiredOrchestratorSkillReads(plan.creativePolicy?.mode ?? "autonomous").map(p => "skill://" + p));
    return stop({ sourceSha: job.baseSha, turnDigest: plan.digest,
      assignments: plan.assignments.map(a => ({ id: a.id, reason: "Perform the bounded revision in approved order." })) });
  }
  throw Error("Unexpected focused CLI model prompt: " + prompt.slice(0, 800));
  } catch (error) {
    appendFileSync(log, String(error) + "\n");
    throw error;
  }
});
// The CLI starts its async main on import; retain the isolated sandbox for
// the lifetime of this subprocess.
fixtureSandboxClient(job.jobId, job.worktreeStoryRoot);
await withJobModelRuntime(runtime, () => import("../../src/cli.js"));
