/** Test-only subprocess entry. The actual CLI, planner, Generation graph,
 * writer tools, independent reviewer, Git and native validation run unchanged.
 * Only Pi transport and the isolated sandbox filesystem adapter are scripted.
 * Unknown or extra model calls fail rather than silently passing a fixture. */
import assert from "node:assert/strict";
import { startStoryJob } from "../../src/job.js";
import { readTurnEvidence } from "../../src/turn-plan-evidence.js";
import { renderFoundation } from "../../src/foundation-record.js";
import { requiredOrchestratorSkillReads } from "../../src/story-skill-policy.js";
import { boundedPinnedSources } from "../../src/bounded-specialist-prompt.js";
import { withJobModelRuntime } from "../../src/model-runtime.js";
import { parseGenerationContract } from "../../src/generation.js";
import { fixtureSandboxClient, scriptedModel, scriptedReadCalls, scriptedStoryRuntime,
  scriptedText } from "../c03-scripted-story-helpers.js";
import { appendFileSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
assert.deepEqual(args.slice(0, 2), ["job", "generate"]);
const arg = (name: string) => args[args.indexOf(name) + 1]!;
const job = await startStoryJob({ story: arg("--story"), job: arg("--job") }, false);
const starting = args[2] === "start";
const plan = starting ? await readTurnEvidence(job, parseGenerationContract(
  JSON.parse(readFileSync(arg("--contract"), "utf8"))), arg("--task")) : null;
const target = "creative-direction/foundation.md";
const record = plan ? renderFoundation({
  id: "foundation", title: "The Last Bell", premise: "A midnight bell reveals an archive theft.",
  central_conflict: "An archivist must decide whether to expose a witness.",
  genre: "Mystery", tone: "Suspenseful", player_experience: "Investigate witnesses and uncover the truth.",
  scope: "A small archive and a missing witness.",
  decisions: [
    { id: "author-brief", statement: plan.originalRequest, origin: "user", authority: "user-protected" },
    { id: "archive-bell", statement: "A bell marks the last known sighting", origin: "agent", authority: "delegated" },
  ],
  body: "# The Last Bell\n\nThe archivist hears a bell from a shuttered building. Each interview reveals evidence; the protagonist may protect the witness or share the truth.",
}) : "";
const { runtime } = await scriptedStoryRuntime((index, context) => {
  assert.ok(process.env.NT_TEST_SCRIPTED_MODEL_LOG);
  appendFileSync(process.env.NT_TEST_SCRIPTED_MODEL_LOG, JSON.stringify({ command: args[2], index }) + "\n");
  assert.ok(plan && starting, "A read-only or refused resume must never acquire another model invocation");
  switch (index) {
    case 0:
      return { content: scriptedReadCalls(requiredOrchestratorSkillReads("autonomous")
        .map(path => "skill://" + path), index), reason: "toolUse" };
    case 1:
      return { content: scriptedText({ sourceSha: job.baseSha, turnDigest: plan.digest,
        assignments: plan.assignments.map(a => ({ id: a.id, reason: "Perform the bounded author objective in causal order." })) }), reason: "stop" };
    case 2:
      return { content: scriptedReadCalls([
        "nt-story-discovery/SKILL.md", "nt-catalog/SKILL.md",
        "nt-catalog/references/records.md", "nt-catalog/references/authority-and-validation.md",
        "nt-catalog/references/glossary.md",
      ].map(path => "skill://" + path), index), reason: "toolUse" };
    case 3:
      return { content: [{ type: "toolCall", name: "write", id: "test-foundation-write",
        arguments: { path: target, content: record } }], reason: "toolUse" };
    case 4:
      return { content: [{ type: "toolCall", name: "story_validate", id: "test-foundation-validate",
        arguments: {} }], reason: "toolUse" };
    case 5:
      return { content: scriptedText({ modifiedRecords: [target], architecturalConflicts: [], laterObligations: [] }), reason: "stop" };
    case 6:
      return { content: scriptedReadCalls(boundedPinnedSources("nt-narrative-review")
        .map(path => "skill://" + path), index), reason: "toolUse" };
    case 7: {
      const messages = context.messages as Array<{ content: Array<{ text?: string }> }>;
      const prompt = messages.flatMap(m => Array.isArray(m.content) ? m.content : [])
        .map(c => c.text ?? "").findLast(text => text.includes("\nIMMUTABLE REVIEW PACKET\n"));
      assert.ok(prompt);
      const packet = JSON.parse(prompt.split("\nIMMUTABLE REVIEW PACKET\n")[1]!);
      assert.equal(packet.items.length, 1);
      const item = packet.items[0];
      assert.equal(item.assurance.turnDigest, plan.digest);
      assert.equal(item.assignment.id, "foundation");
      assert.deepEqual(item.assurance.changedPaths, [target]);
      return { content: scriptedText({ sourceDigest: packet.sourceDigest, verdict: "pass", findings: [],
        evidence: [{ commitSha: item.assurance.commitSha, assignmentId: item.assignment.id,
          path: target, line: 1, explanation: "The authored foundation retains the brief and establishes the archive mystery." }] }), reason: "stop" };
    }
    default: throw Error("Unexpected Foundation test model invocation " + index);
  }
});
fixtureSandboxClient(job.jobId, job.worktreeStoryRoot);
if (starting) {
  assert.equal(arg("--provider"), scriptedModel.provider);
  assert.equal(arg("--model"), scriptedModel.id);
}
await withJobModelRuntime(runtime, () => import("../../src/cli.js"));
