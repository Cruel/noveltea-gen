/** Test-owned, ordinary Pi responses for one authored mystery baseline.
 * No scheduler, receipt, approval or validation replacement is provided here.
 * Unexpected model prompts and changed source bytes fail closed. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { JobStartResult } from "../../src/job.js";
import type { TurnEvidence } from "../../src/turn-plan-evidence.js";
import type { CausalBlueprint } from "../../src/architecture-blueprint.js";
import { boundedPinnedSources } from "../../src/bounded-specialist-prompt.js";
import { requiredOrchestratorSkillReads } from "../../src/story-skill-policy.js";
import { renderFoundation } from "../../src/foundation-record.js";
import { scriptedReadCalls, scriptedText } from "../c03-scripted-story-helpers.js";

const path = resolve("test/fixtures/archive-witness");
const bytes = (p: string) => readFileSync(join(path, p), "utf8");
const arc = "arcs/truth.md";
const disclosure = "milestones/disclosure.md";
const reckoning = "milestones/reckoning.md";
const worldPaths = ["world-entities/archive.md", "facts/evidence-concealed.md"];
const castPaths = ["characters/ada.md", "characters/neri.md", "relationships/ada-neri.md", arc];
const architecture: Record<string, string> = {
  [arc]: bytes(arc).replace(/^characters: .*$/m, "characters: []") +
    "\nAda compares Neri's ledger with the daily register before asking the inquiry to accept a redacted account. The two records can establish concealment without exposing the witness; the final disclosure changes their relationship.\n",
  [disclosure]: bytes(disclosure).replace(/^fulfillment: .*$/m, "completeness: partial\nfulfillment: {any_of: []}") +
    "\nNeri shows Ada the ledger entry. She compares its date with the independently maintained daily register before deciding whether to protect him or challenge his account. The register can establish concealment, but cannot prove motive.\n",
  [reckoning]: "---\nschema: '0.1'\ntype: milestone\nid: milestone.reckoning\ntitle: The Redacted Account\nstatus: draft\ndecisions: []\ncompleteness: partial\nchange: The inquiry receives an independently corroborated account of concealment\narcs: [arc.truth]\nfulfillment: {any_of: []}\n---\n\nAfter the ledger comparison, Ada offers the inquiry a redacted account supported by both the signed entry and the independent daily register. The inquiry accepts proof of concealment without exposing the witness. Protecting Neri preserves his cooperation; challenging him produces a wary alliance, but neither route erases the corroborated conclusion.\n",
};
const compact: CausalBlueprint = {
  schema: "noveltea-causal-blueprint/v2",
  premise: "Ada investigates a missing archive witness and Neri's concealed ledger.",
  arcs: [{ id: "truth", goal: "Establish concealment while deciding what loyalty requires." }],
  beats: [
    { id: "disclosure", arcId: "truth", purpose: "Compare the disputed ledger to an independent daily register",
      dependsOn: [], observations: [], change: "The two dates establish concealment without proving motive.",
      decisions: [{ question: "How should Ada respond to Neri's concealment?", alternatives: [
        { action: "protect", lastingEffect: "Neri cooperates willingly with the inquiry." },
        { action: "challenge", lastingEffect: "Neri cooperates cautiously after a loss of trust." },
      ] }] },
    { id: "reckoning", arcId: "truth", purpose: "Submit a corroborated redacted account",
      dependsOn: ["disclosure"], observations: [], change: "The inquiry accepts the independently supported finding without exposing the witness.", decisions: [] },
  ],
  resolution: { question: "Can truth survive loyalty?", conclusion: "The inquiry establishes concealment while protecting the witness.",
    supportedBy: ["disclosure", "reckoning"], uncertainty: "The records cannot independently establish Neri's private motive." },
  causalAnswer: { question: "Why was the witness's ledger entry concealed?",
    answer: "Neri concealed the entry to avoid exposing the witness.", mechanism: "A signed ledger entry was withheld.",
    responsibility: "Neri withheld it.", motive: "Protect the witness.",
    proofApproach: "Compare the ledger date against the independently maintained daily register." },
  feasibility: { playthrough: "A compact visual novel with two connected turning points.",
    interaction: "One consequential choice with two relationship outcomes.", production: "Reuse the archive and two core characters.",
    endings: "The corroborated redacted account is accepted on both routes, with distinct trust consequences." },
};

export function archiveStages(job: JobStartResult, plan: TurnEvidence) {
  const foundationPath = "creative-direction/foundation.md";
  const foundation = renderFoundation({
    id: "foundation", title: "The Archive Witness",
    premise: compact.premise, central_conflict: "Ada must prove concealment without exposing a witness.",
    genre: "Mystery", tone: "Intimate and suspenseful", player_experience: "Compare sources and make a consequential decision.",
    scope: "One archive, Ada and Neri, and two causal turning points.",
    decisions: [{ id: "author-brief", statement: plan.originalRequest, origin: "user", authority: "user-protected" }],
    body: "# The Archive Witness\n\n" + compact.premise + "\nAda compares the signed ledger with the independent daily register, then chooses whether to protect or challenge Neri. The redacted account establishes concealment without exposing the witness.",
  });
  let previous = "", step = 0;
  return (index: number, context: { messages: readonly unknown[] }) => {
    const messages = context.messages as Array<{ role: string; content: string | Array<{ text?: string }> }>;
    const prompt = messages.filter(m => m.role === "user").flatMap(m =>
      typeof m.content === "string" ? [m.content] : m.content.map(c => c.text ?? "")).at(-1) ?? "";
    if (previous !== prompt) { previous = prompt; step = 0; }
    const phase = step++;
    const stop = (v: unknown) => ({ content: scriptedText(v), reason: "stop" as const });
    const read = (paths: string[]) => ({ content: scriptedReadCalls(paths, index), reason: "toolUse" as const });
    const skills = (skill: string) => boundedPinnedSources(skill).map(p => "skill://" + p);
    const write = (records: Record<string, string>) => ({ reason: "toolUse" as const,
      content: Object.entries(records).map(([path, content], i) => ({
        type: "toolCall" as const, name: "write", id: "archive-" + index + "-" + i, arguments: { path, content },
      })) });
    const validate = () => ({ reason: "toolUse" as const,
      content: [{ type: "toolCall" as const, name: "story_validate", id: "validate-" + index, arguments: {} }] });
    const manifest = (paths: string[]) => stop({ modifiedRecords: paths, architecturalConflicts: [], laterObligations: [] });
    const onDisk = (p: string) => readFileSync(join(job.worktreeStoryRoot, p), "utf8");
    if (prompt.includes("read-only NovelTea objective orchestrator")) {
      if (!phase) return read(requiredOrchestratorSkillReads(plan.creativePolicy?.mode ?? "autonomous").map(p => "skill://" + p));
      assert.equal(phase, 1);
      return stop({ sourceSha: plan.source.verifiedSha, turnDigest: plan.digest,
        assignments: plan.assignments.map(a => ({ id: a.id, reason: "Carry out the authorized Story objective in causal order." })) });
    }
    if (prompt.includes("IMMUTABLE REVIEW PACKET")) {
      if (!phase) return read(skills("nt-narrative-review"));
      const packet = JSON.parse(prompt.split("\nIMMUTABLE REVIEW PACKET\n")[1]!);
      assert.equal(packet.items.length, 1);
      const item = packet.items[0];
      assert.equal(item.assurance.turnDigest, plan.digest);
      const expected: Record<string, string[]> = {
        foundation: [foundationPath], architecture: Object.keys(architecture),
        "world-foundations": worldPaths, "character-foundations": castPaths,
      };
      const allowed = expected[item.assignment.id] ?? expected[item.reviewedWorkItem];
      assert.ok(allowed, "Unexpected archive Review assignment: " + item.assignment.id + " / " + item.reviewedWorkItem);
      assert.deepEqual([...item.assurance.changedPaths].sort(), [...allowed].sort());
      return stop({ sourceDigest: packet.sourceDigest, verdict: "pass", findings: [],
        evidence: item.assurance.changedPaths.map((p: string) => {
          const canonical = item.canonicalContext.find((r: {path: string}) => r.path === p);
          assert.ok(canonical && canonical.content === onDisk(p));
          const line = canonical.content.split("\n").findIndex((l: string) => l.startsWith("id: ")) + 1;
          assert.ok(line > 0);
          return { commitSha: item.assurance.commitSha, assignmentId: item.assignment.id, path: p, line,
            explanation: "The scripted source contains the expected canonical record for this bounded assignment." };
        }) });
    }
    if (prompt.includes("READ-ONLY COMPACT STORY BLUEPRINT.") ||
        prompt.includes("INDEPENDENT READ-ONLY COMPACT STORY BLUEPRINT REVIEW")) {
      assert.equal(onDisk(foundationPath), foundation);
      if (!phase) return read(["skill://nt-story-architecture/SKILL.md", "skill://nt-catalog/SKILL.md", foundationPath]);
      assert.equal(phase, 1);
      return stop(prompt.includes("COMPACT STORY BLUEPRINT REVIEW")
        ? { schema: "noveltea-blueprint-review/v2", status: "pass", findings: [], prior: [] } : compact);
    }
    if (prompt.includes("INDEPENDENT READ-ONLY early reviewer")) {
      if (!phase) return read(["skill://nt-story-architecture/SKILL.md", "skill://nt-catalog/SKILL.md", foundationPath, ...Object.keys(architecture)]);
      for (const [p, expected] of Object.entries(architecture)) assert.equal(onDisk(p), expected);
      return stop({ schema: "noveltea-architecture-draft-review/v2", status: "pass", findings: [], prior: [] });
    }
    if (prompt.includes("AUTHORIZED PLAN AND SCOPE") && prompt.includes("CAUSAL_MILESTONE_ORDER")) {
      if (!phase) return read([...skills("nt-story-architecture"), foundationPath]);
      if (phase === 1) return write(architecture);
      if (phase === 2) return validate();
      assert.equal(phase, 3);
      return stop("Canonical Architecture authored.\nCAUSAL_MILESTONE_ORDER: milestone.disclosure,milestone.reckoning");
    }
    if (prompt.includes("BOUND ASSIGNMENT:") && prompt.includes("assigned ONE bounded canonical Story work item")) {
      const domain = prompt.includes('"domain": "world"') ? "world" : "character";
      assert.ok(prompt.includes('"domain": "' + domain + '"'));
      const paths = domain === "world" ? worldPaths : castPaths;
      if (!phase) return read([domain === "world" ? "skill://nt-worldbuilding/SKILL.md" : "skill://nt-character-development/SKILL.md",
        ...["SKILL.md", "references/records.md", "references/progression.md", "references/authority-and-validation.md", "references/glossary.md"].map(p => "skill://nt-catalog/" + p)]);
      if (phase === 1) return write(Object.fromEntries(paths.map(p => [p, p === arc
        ? architecture[arc]!.replace(/^characters: \[\]$/m, "characters: [character.ada, character.neri]") : bytes(p)])));
      if (phase === 2) return validate();
      assert.equal(phase, 3);
      return manifest(paths);
    }
    if (prompt.includes("You are the NovelTea foundation writing specialist")) {
      if (!phase) return read(["nt-story-discovery/SKILL.md", "nt-catalog/SKILL.md", "nt-catalog/references/records.md",
        "nt-catalog/references/authority-and-validation.md", "nt-catalog/references/glossary.md"].map(p => "skill://" + p));
      if (phase === 1) return write({ [foundationPath]: foundation });
      if (phase === 2) return validate();
      assert.equal(phase, 3);
      return manifest([foundationPath]);
    }
    throw Error("Unexpected archive baseline model prompt: " + prompt.slice(0, 1000));
  };
}
