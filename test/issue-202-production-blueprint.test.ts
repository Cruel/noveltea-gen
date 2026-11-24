/** #202: deterministic model replies through the production Blueprint admission,
 * read-only Pi sessions, source checks, correction and immutable approval. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream, type AssistantMessage, type Model,
  type Provider, type TranscriptContext, type SimpleStreamOptions, type ToolCall,
} from "@earendil-works/pi-ai";
import { createControllerServer, SandboxController, type ControllerConfig } from "../web/src/sandbox-controller.js";
import { createReviewedBlueprint, readApprovedBlueprint, inspectPausedBlueprint, type BlueprintReview } from "../src/architecture-blueprint.js";
import type { ConvergentReview } from "../src/review-convergence.js";
import { blueprintDigest } from "../src/architecture-blueprint-patch.js";
import { evaluateReviewConvergence } from "../src/review-convergence.js";
import { captureBlueprintReplay } from "../src/execution-replay-blueprint.js";
import type { Plan, CompletionContract } from "../src/architecture.js";
import { startStoryJob } from "../src/job.js";
import { runArchitectureJob, verifyArchitectureAssignmentResult } from "../src/architecture.js";
import { withStoryJobLock } from "../src/job-lock.js";
import { configurePiPolicy, inspectPiPolicy, PiBudgetPause } from "../src/job-pi-policy.js";
import { withJobModelRuntime } from "../src/model-runtime.js";
import { createSkillSnapshot } from "../src/snapshot.js";
import { removeTestTree } from "./helpers.js";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { createGenerationGraph } from "../src/generation.js";
import { planWholeStory } from "../web/src/lib/turn-plan.js";
import { requiredOrchestratorSkillReads } from "../src/story-skill-policy.js";
import { boundedPinnedSources } from "../src/bounded-specialist-prompt.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const model: Model = {
  id: "scripted-202", name: "Scripted Blueprint #202", provider: "cert-202",
  api: "cert-202-api", baseUrl: "http://not-used.invalid", input: ["text"],
  reasoning: false, contextWindow: 128_000, maxTokens: 16_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const usage: AssistantMessage["usage"] = {
  input: 20, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 40,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const foundation = "A missing clerk was secretly sheltered. Prove the truth from dated records without exposing the protected witness.\n";
const task = "Plan a source-grounded mystery with independent proof of the missing clerk's refuge";
const answer = {
  question: "Where did the clerk go?",
  answer: "The clerk reached a secure shelter through the service gate.",
  mechanism: "A shelter operator opened a documented service gate to admit the clerk.",
  responsibility: "The shelter operator registered the clerk under a protected alias.",
  motive: "The operator prevented a creditor from discovering the clerk's refuge.",
  misdirection: { signal: "A copied town departure entry",
    falseInference: "The clerk left town by train",
    actualExplanation: "The entry copied the shelter's protective registration" },
  proof: { directTest: "Read the service gate's dated entry log",
    corroboration: "Compare the independent guard shift register",
    refusalFallback: "Both records remain available without witness testimony",
    beatIds: ["archive"] },
};
const header = {
  schema: "noveltea-causal-outline-header/v1", premise: "Protect a missing clerk",
  beatIds: ["arrival", "archive"],
  resolution: { question: "Where did the clerk go?",
    conclusion: "The shelter's two independent records establish the clerk's safe arrival",
    supportedBy: ["archive"], uncertainty: "The source's identity remains protected" },
  causalAnswer: answer,
};
const beats = [
  { id: "arrival", purpose: "Find the first dated trail", dependsOn: [],
    change: "A dated departure entry establishes when the clerk went missing", decisions: [] },
  { id: "archive", purpose: "Check the independent shelter evidence", dependsOn: ["arrival"],
    change: "The dated gate and shift logs confirm entry without witness testimony", decisions: [] },
];
const evidence = [
  { id: "arrival", observations: [{ source: "town register",
    observable: "A departure entry was entered at dusk", supports: "The clerk departed",
    limits: "Does not independently corroborate the departure" }] },
  { id: "archive", observations: [{ source: "shelter gate ledger",
    observable: "An entry records a protected arrival at dusk",
    supports: "The clerk entered the shelter", limits: "Does not independently prove motive" }] },
];
const compact = {
  schema: "noveltea-causal-blueprint/v2",
  premise: header.premise,
  arcs: [{ id: "shelter", goal: "Resolve the clerk's disappearance without harming the witness" }],
  beats: beats.map(beat => ({ ...beat, arcId: "shelter", observations: [] })),
  resolution: header.resolution,
  causalAnswer: {
    question: answer.question,
    answer: answer.answer,
    mechanism: answer.mechanism,
    responsibility: answer.responsibility,
    motive: answer.motive,
    proofApproach: "Compare a dated service-gate log and the independent guard-shift register",
  },
  feasibility: {
    playthrough: "One coherent roughly one-hour narrative-led route",
    interaction: "A dialogue-led mystery where consent and confidentiality matter",
    production: "Reuse the archive and shelter backgrounds and a small witness cast",
    endings: "Both routes identify refuge, while protected disclosure affects trust",
  },
};
const obligation = {
  id: "proof-without-exposure", category: "route", source: "task",
  quote: "independent proof of the missing clerk's refuge",
  question: "Can players resolve the disappearance without exposing the witness?",
  proof: "Match the dated service-gate and shift logs",
  route: "Independent records remain available when testimony is refused",
  beatIds: ["arrival", "archive"],
};
const negative: BlueprintReview = {
  schema: "noveltea-blueprint-review/v2", status: "revise", prior: [],
  findings: [{ beatId: "arrival", origin: "initial",
    requirement: { source: "task", quote: "independent proof of the missing clerk's refuge" },
    evidence: { beatId: "arrival", quote: "A dated departure entry establishes when the clerk went missing" },
    reason: "The arrival timeline relies on an uncorroborated town entry.",
    correction: "Append an independent dated shift record corroborating arrival." }],
};
const progress = (round: number, beatId: "arrival" | "archive", quote: string) => ({
  round, findingIndex: 0, status: "resolved" as const,
  reason: "Independently inspectable new records resolve this exact prior blocker.",
  evidence: { beatId, quote },
});
const progress0 = progress(0, "arrival", "Guard signed a separate dusk service-gate patrol entry");
const progress1 = progress(1, "archive", "Guard ledger separately records a protected arrival");
const progress2 = progress(2, "archive", "Registrar ledger connects the independent shift and gate entries");
const negative1: BlueprintReview = { schema: "noveltea-blueprint-review/v2",
  status: "revise",
  prior: [progress0],
  findings: [{ beatId: "archive", origin: "overlooked",
    requirement: { source: "task", quote: "independent proof of the missing clerk's refuge" },
    evidence: { beatId: "archive", quote: "The dated gate and shift logs confirm entry without witness testimony" },
    reason: "The arrival's gate log is not independently cross-checked.",
    correction: "Add a separate guard ledger entry to the archive beat." }],
};
const negative2: BlueprintReview = { schema: "noveltea-blueprint-review/v2",
  status: "revise", prior: [progress0, progress1],
  findings: [{ beatId: "archive", origin: "introduced",
    requirement: { source: "task", quote: "independent proof of the missing clerk's refuge" },
    evidence: { beatId: "archive", quote: "Guard ledger separately records a protected arrival" },
    reason: "The newly introduced record needs a linking registrar entry.",
    correction: "Add the registrar's independent link between both dated logs." }],
};
const positive: BlueprintReview = { schema: "noveltea-blueprint-review/v2",
  status: "pass", findings: [], prior: [progress0, progress1, progress2] };
const stillBlocked = (round: number) => ({
  round, findingIndex: 0, status: "persisting" as const,
  reason: "The timeline still relies on the same uncorroborated source.",
  evidence: { beatId: "arrival", quote: "A dated departure entry establishes when the clerk went missing" },
});
const stalled1: BlueprintReview = { schema: "noveltea-blueprint-review/v2",
  status: "revise", prior: [stillBlocked(0)], findings: [
    { ...negative.findings[0]!, origin: "continuing" },
  ] };
const stalled2: BlueprintReview = { schema: "noveltea-blueprint-review/v2",
  status: "revise", prior: [stillBlocked(0), stillBlocked(1)], findings: [
    { ...negative.findings[0]!, origin: "continuing" },
  ] };
const oldChange = beats[0]!.change;
const noisyChange = oldChange + " with decorative, irrelevant additional descriptive words";
const stalledPatches = [
  { kind: "replace", findingBeatId: "arrival",
    path: "beats/arrival/change", expected: oldChange, value: noisyChange },
  { kind: "replace", findingBeatId: "arrival",
    path: "beats/arrival/change", expected: noisyChange, value: oldChange },
];
const oldArchiveChange = beats[1]!.change;
const archiveChange1 = oldArchiveChange + "; " + progress1.evidence.quote;
const corrections = [
  { kind: "replace", findingBeatId: "arrival", path: "beats/arrival/change",
    expected: oldChange, value: oldChange + "; " + progress0.evidence.quote },
  { kind: "replace", findingBeatId: "archive", path: "beats/archive/change",
    expected: oldArchiveChange, value: archiveChange1 },
  { kind: "replace", findingBeatId: "archive", path: "beats/archive/change",
    expected: archiveChange1, value: archiveChange1 + "; " + progress2.evidence.quote },
];
const readCalls = (): ToolCall[] => [
  "skill://nt-story-architecture/SKILL.md",
  "skill://nt-catalog/SKILL.md",
  "creative-direction/foundation.md",
].map((path, i) => ({ type: "toolCall", id: "source-read-" + randomUUID() + "-" + i,
  name: "read", arguments: { path } }));
const canonicalArchitecture = [
  {
    "path": "arcs/shelter.md",
    "content": "---\nschema: '0.1'\ntype: arc\nid: arc.shelter\ntitle: \"The Shelter\"\nstatus: draft\ndecisions: []\ndramatic_question: \"Can the clerk's refuge be proven without exposing a witness?\"\ncharacters: []\n---\n\nAn investigator follows contradictory public records to a shelter's private gate. The central conclusion relies on separately maintained records, not testimony from a protected witness. The inquiry can responsibly publish the corroborated finding while withholding the witness's name.\n"
  },
  {
    "path": "milestones/arrival.md",
    "content": "---\nschema: '0.1'\ntype: milestone\nid: milestone.arrival\ntitle: \"The Departure Register\"\nstatus: draft\ndecisions: []\ncompleteness: partial\nchange: \"A dated departure register gives the investigator a contradictory lead\"\narcs: [arc.shelter]\nfulfillment: {any_of: []}\n---\n\nThe investigator inspects the dated town register and compares its departure timestamp against a separately dated archive notice. The conflicting entries are a testable clue that the official departure story is incomplete; neither establishes who altered it or where the clerk went. This contradiction motivates inspecting the shelter service gate and the independent guard roster.\n"
  },
  {
    "path": "milestones/archive.md",
    "content": "---\nschema: '0.1'\ntype: milestone\nid: milestone.archive\ntitle: \"The Service Gate\"\nstatus: draft\ndecisions: []\ncompleteness: partial\nchange: \"Independent gate and guard records establish the clerk's protected arrival\"\narcs: [arc.shelter]\nfulfillment: {any_of: []}\n---\n\nAfter the town-record contradiction, the investigator examines a signed gate-entry ledger. A separately maintained guard shift roster confirms the clerk arrived through the service gate on that date without relying on witness testimony. The records support the bounded conclusion of protected refuge but cannot establish the creditor's private threats. The protagonist can present the independently verified arrival to the inquiry without exposing the witness's identity. A later disclosure choice may damage community trust but cannot erase this corroborated finding. Reuse the archive and shelter backgrounds for this narrative-led playthrough.\n"
  }
];
const writeCalls = (): ToolCall[] => canonicalArchitecture.map(({ path, content }, i) => ({
  type: "toolCall", id: "write-architecture-" + randomUUID() + "-" + i,
  name: "write", arguments: { path, content },
}));
const architectureReadCalls = (): ToolCall[] => [
  ...readCalls(),
  ...["records.md", "progression.md", "authority-and-validation.md"].map((name, i) => ({
    type: "toolCall" as const,
    id: "read-architecture-reference-" + randomUUID() + "-" + i,
    name: "read",
    arguments: { path: "skill://nt-catalog/references/" + name },
  })),
];
const draftReadCalls = (): ToolCall[] => [
  ...readCalls(),
  ...canonicalArchitecture.map(({ path }, i) => ({
    type: "toolCall" as const, id: "read-canonical-" + randomUUID() + "-" + i,
    name: "read", arguments: { path },
  })),
];
const asText = (s: string): AssistantMessage["content"] => [{ type: "text", text: s }];
function promptText(messages: readonly unknown[]): string {
  const users = messages.filter((m): m is { role: "user"; content: unknown } =>
    !!m && typeof m === "object" && "role" in m && m.role === "user");
  return JSON.stringify(users.at(-1)?.content ?? "");
}
type Call = { prompt: string; tools: string[]; messages: readonly unknown[]; lastRole: string };
function scripted(calls: Call[], scenario: "productive" | "stalled" | "replace-pass" | "continue" | "repeat" = "productive",
  crashFirstReviewer = false, format?: { diagnostic?: boolean; replacement?: boolean; architectureRecovery?: boolean; architectureStall?: boolean; parentPlan?: ReturnType<typeof planWholeStory> }): Provider {
  let reviewerRound = 0;
  let reviewerCrashed = false;
  let malformedDiagnosticSent = false;
  let malformedReplacementSent = false;
  let writerRound = 0;
  let protocolRepaired = false;
  let architectureDraftRound = 0;
  const improvements = [
    "The signed gate entry has an independently dated ledger counterfoil.",
    "The guard roster identifies the exact service entrance and time window.",
    "The inquiry accepts a redacted certified copy without exposing the protected witness.",
  ];
  const archPath = "milestones/archive.md";
  const oldQuote = "A separately maintained guard shift roster confirms the clerk arrived";
  const orderReport = "CAUSAL_MILESTONE_ORDER: milestone.arrival,milestone.archive";
  const writeVariant = (kind: string): ToolCall[] => {
    if (kind === "invalid") return writeCalls().map(call => call.arguments.path === archPath ?
      { ...call, arguments: { ...call.arguments, content: String(call.arguments.content).replace("completeness:", "unsupported_field: true\ncompleteness:") } } : call);
    if (kind === "protection") return writeCalls().map(call => call.arguments.path === archPath ?
      { ...call, arguments: { ...call.arguments, content: String(call.arguments.content).replace("decisions: []",
        "decisions:\n  - id: invented-approval\n    statement: Invented protected approval\n    origin: user\n    authority: user-protected") } } : call);
    if (kind === "canonical") return writeCalls();
    if (format?.architectureStall) return [{ type: "toolCall", id: "stalled-architecture-" + randomUUID(), name: "write",
      arguments: { path: archPath, content: canonicalArchitecture[2]!.content + "Cosmetic detail only.\n" } }];
    return [{ type: "toolCall", id: "correct-architecture-" + randomUUID(), name: "write",
      arguments: { path: archPath, content: canonicalArchitecture[2]!.content +
        improvements.slice(0, architectureDraftRound).join("\n") + "\n" } }];
  };
  const verdicts = scenario === "productive"
    ? [negative, negative1, negative2, positive]
    : scenario === "continue" ? [negative, stalled1, stalled2, {
      schema: "noveltea-blueprint-review/v2", status: "pass", findings: [],
      prior: [0, 1, 2].map(round => ({ ...progress(round, "arrival", progress0.evidence.quote) })),
    } satisfies ConvergentReview] : scenario === "repeat"
      ? [negative, stalled1, stalled2, ...[3, 4].map(last => ({
        schema: "noveltea-blueprint-review/v2" as const,
        status: "revise" as const,
        prior: Array.from({ length: last }, (_, round) => stillBlocked(round)),
        findings: [{ ...negative.findings[0]!, origin: "continuing" as const }],
      }))]
      : [negative, stalled1, stalled2];
  const diagnosticAnswer = {
    schema: "noveltea-blueprint-diagnosis/v1",
    action: scenario === "replace-pass" ? "replace" :
      scenario === "continue" || scenario === "repeat" ? "continue" : "escalate",
    explanation: "Two ineffective source changes require independent escalation, not automatic approval.",
    assessments: [{ kind: "material",
      reason: "The source still lacks the independently verified arrival evidence.",
      requirement: { source: "task", quote: "independent proof of the missing clerk's refuge" },
      evidence: { beatId: "arrival", quote: "A dated departure entry establishes when the clerk went missing" },
    }],
  };
  const replacementAnswer = {
    schema: "noveltea-blueprint-review/v2", status: "pass", findings: [],
    prior: [0, 1, 2].map(round => ({ round, findingIndex: 0, status: "resolved",
      reason: "The original reviewer did not account for the independent shelter record.",
      evidence: { beatId: "archive", quote: "The dated gate and shift logs confirm entry without witness testimony" },
    })),
  };
  const writerPatches = scenario === "productive" ? corrections : scenario === "continue"
    ? [...stalledPatches, corrections[0]!] : scenario === "repeat"
      ? [...stalledPatches, ...stalledPatches] : stalledPatches;
  const stream = (_model: Model, ctx: TranscriptContext, _options?: SimpleStreamOptions) => {
    const result = createAssistantMessageEventStream();
    const active = new Set<string>();
    for (const m of ctx.messages) {
      if (m.role !== "system") continue;
      for (const t of m.toolsAdded ?? []) active.add(t.name);
      for (const t of m.toolsRemoved ?? []) active.delete(t.name);
    }
    const prompt = promptText(ctx.messages);
    const lastRole = ctx.messages.at(-1)?.role ?? "";
    const reviewer = prompt.includes("INDEPENDENT READ-ONLY COMPACT STORY BLUEPRINT REVIEW");
    const diagnostic = prompt.includes("INDEPENDENT, READ-ONLY CAUSAL BLUEPRINT DIAGNOSTIC REVIEW");
    const replacement = prompt.includes("YOU ARE A FRESH, INDEPENDENT REPLACEMENT REVIEWER");
    const architect = prompt.includes("AUTHORIZED PLAN AND SCOPE") &&
      prompt.includes("CAUSAL_MILESTONE_ORDER");
    const draftReviewer = prompt.includes("INDEPENDENT READ-ONLY early reviewer") || prompt.includes("CONTINUING YOUR ORIGINAL INDEPENDENT READ-ONLY ARCHITECTURE REVIEW");
    calls.push({ prompt, tools: [...active], messages: structuredClone(ctx.messages), lastRole });
    if (reviewer && crashFirstReviewer && !reviewerCrashed) {
      reviewerCrashed = true;
      throw Error("Simulated crash during initial reviewer prompt before verdict sealing.");
    }
    const needRead = (prompt.includes("READ-ONLY COMPACT STORY BLUEPRINT.") ||
      reviewer || diagnostic) && lastRole !== "toolResult";
    let content: AssistantMessage["content"];
    let reason: "stop" | "toolUse" = "stop";
    if (format?.parentPlan && prompt.includes("read-only NovelTea objective orchestrator")) {
      const plan = format.parentPlan;
      if (lastRole !== "toolResult") {
        content = requiredOrchestratorSkillReads("autonomous").map(path => ({
          type: "toolCall", id: "objective-read-" + randomUUID(), name: "read", arguments: {path: "skill://" + path}
        })); reason = "toolUse";
      } else content = asText(JSON.stringify({sourceSha: plan.source.verifiedSha, turnDigest: plan.digest,
        assignments: plan.assignments.map(a => ({id: a.id, reason: "Perform authorized source-bound work in causal order."}))}));
    } else if (format?.parentPlan && prompt.includes("INDEPENDENT READ-ONLY GENERATION RECOVERY DIAGNOSIS")) {
      const signature = prompt.match(/signature=([a-f0-9]{64})/)?.[1];
      const sourceRef = prompt.match(/sourceRef=([^;]+); category=/)?.[1];
      assert.ok(signature && sourceRef);
      assert.match(prompt, /assignmentDefects/);
      assert.deepEqual([...active], []);
      content = asText(JSON.stringify({schema: "noveltea-recovery-diagnostic-proposal/v1", signature, sourceRef,
        category: "defect", diagnosis: "The original writer repeatedly retained the same material Architecture finding.",
        strategy: "review-adjudication", owner: null, scopeRef: null, prerequisites: [],
        uncertainty: "No authorized successor write can be inferred."}));
    } else if (format?.parentPlan && prompt.includes("IMMUTABLE REVIEW PACKET")) {
      if (lastRole !== "toolResult") {
        content = boundedPinnedSources("nt-narrative-review").map(path => ({
          type: "toolCall", id: "postcommit-read-" + randomUUID(), name: "read", arguments: {path: "skill://" + path}
        })); reason = "toolUse";
      } else {
        const user = ctx.messages.findLast(m => m.role === "user")!;
        const raw = typeof user.content === "string" ? user.content : user.content.filter(c => c.type === "text").map(c => c.text).join("");
        const packet = JSON.parse(raw.split("\nIMMUTABLE REVIEW PACKET\n")[1]!);
        content = asText(JSON.stringify({sourceDigest: packet.sourceDigest, verdict: "pass", findings: [],
          evidence: packet.items.map((item: any) => ({commitSha: item.assurance.commitSha, assignmentId: item.assignment.id,
            path: item.assurance.changedPaths[0], line: 1, explanation: "The verified draft fulfills the bounded Architecture assignment."}))}));
      }
    } else if (needRead) { content = readCalls(); reason = "toolUse"; }
    else if (format?.architectureRecovery && prompt.includes("RESPONSE-CONTRACT CORRECTION ONLY (architecture.milestone-order.v1)")) {
      assert.deepEqual([...active], [], "format repair has no tools");
      content = asText(orderReport);
    } else if (format?.architectureRecovery && prompt.includes("SOURCE-BOUND ARCHITECTURE CORRECTION")) {
      const empty = prompt.includes("architecture-empty-draft");
      const native = prompt.includes("schema");
      const protection = prompt.includes("architecture-new-protection");
      const review = prompt.includes("architecture-precommit-review");
      if (lastRole !== "toolResult" && (empty || native || protection || review)) {
        content = writeVariant(empty ? "invalid" : native ? "protection" : protection ? "canonical" : "review"); reason = "toolUse";
      } else content = asText(protection ? "CAUSAL_MILESTONE_ORDER: milestone.arrival" : orderReport);
    } else if (format?.architectureRecovery && draftReviewer) {
      if (lastRole !== "toolResult") { content = draftReadCalls(); reason = "toolUse"; }
      else {
        const round = architectureDraftRound++;
        const quote = round === 0 || format.architectureStall ? oldQuote : improvements[round - 1]!;
        const findings = round < 3 || format.architectureStall ? [{
          path: archPath, reason: "The arrival evidence requires an independently checkable supporting detail.",
          correction: improvements[format.architectureStall ? 0 : round]!,
          requirement: { source: "task", quote: "independent proof of the missing clerk's refuge" },
          evidence: { path: archPath, quote }, origin: round === 0 ? "initial" : format.architectureStall ? "continuing" : "introduced",
        }] : [];
        const prior = Array.from({ length: round }, (_, i) => ({
          round: i, findingIndex: 0, status: format.architectureStall ? "persisting" : "resolved",
          reason: format.architectureStall ? "The same material gap remains." : "The revised draft supplies new source evidence.",
          evidence: { path: archPath, quote: format.architectureStall ? oldQuote : improvements[i]! },
        }));
        content = asText(JSON.stringify({schema: "noveltea-architecture-draft-review/v2",
          status: findings.length ? "revise" : "pass", findings, prior}));
      }
    } else if (draftReviewer) {
      const toolNames = ctx.messages.flatMap(m => m.role === "assistant"
        ? m.content.filter(c => c.type === "toolCall").map(c => c.name) : []);
      if (!toolNames.includes("read")) { content = draftReadCalls(); reason = "toolUse"; }
      else content = asText(JSON.stringify({ schema: "noveltea-architecture-draft-review/v2", status: "pass", findings: [], prior: [] }));
    } else if (architect) {
      const toolNames = ctx.messages.flatMap(m => m.role === "assistant"
        ? m.content.filter(c => c.type === "toolCall").map(c => c.name) : []);
      if (!toolNames.includes("read")) { content = architectureReadCalls(); reason = "toolUse"; }
      else if (format?.architectureRecovery) content = asText("I read the sources but did not yet author the draft.");
      else if (!toolNames.includes("write")) { content = writeCalls(); reason = "toolUse"; }
      else if (!toolNames.includes("story_validate")) {
        content = [{ type: "toolCall", id: "story-validate-" + randomUUID(),
          name: "story_validate", arguments: {} }];
        reason = "toolUse";
      } else content = asText(
        "Canonical Architecture authored.\nCAUSAL_MILESTONE_ORDER: milestone.arrival,milestone.archive");
    } else if (prompt.includes("READ-ONLY COMPACT STORY BLUEPRINT."))
      content = asText(JSON.stringify(compact));
    else if (prompt.includes("READ-ONLY CAUSAL BEAT DETAIL STAGE"))
      content = asText(beats.map(v => JSON.stringify(v)).join("\n"));
    else if (prompt.includes("READ-ONLY CAUSAL BLUEPRINT EVIDENCE STAGE"))
      content = asText(evidence.map(v => JSON.stringify(v)).join("\n"));
    else if (prompt.includes("READ-ONLY SOURCE-GROUNDED CAUSAL OBLIGATION INVENTORY"))
      content = asText(JSON.stringify(obligation));
    else if (diagnostic) {
      const invalid = format?.diagnostic && !malformedDiagnosticSent;
      if (invalid) malformedDiagnosticSent = true;
      content = asText(invalid ? '{"invalidDiagnosis":true}' : JSON.stringify(diagnosticAnswer));
    } else if (replacement) {
      const invalid = format?.replacement && !malformedReplacementSent;
      if (invalid) malformedReplacementSent = true;
      content = asText(invalid ? '{"invalidReplacement":true}' : JSON.stringify(replacementAnswer));
    } else if (prompt.includes("CONTROLLER REJECTED DIAGNOSTIC RESPONSE"))
      content = asText(JSON.stringify(diagnosticAnswer));
    else if (prompt.includes("CONTROLLER REJECTED REPLACEMENT REVIEW PROTOCOL"))
      content = asText(JSON.stringify(replacementAnswer));
    else if (reviewer) {
      const round = reviewerRound++;
      // Round 2 intentionally violates the response contract once. Its
      // correction must not count as a new semantic revision.
      content = asText(JSON.stringify(scenario === "productive" && round === 2
        ? { schema: "noveltea-blueprint-review/v2", status: "revise", findings: [], prior: [] }
        : verdicts[round]));
    } else if (prompt.includes("CONTROLLER REJECTED YOUR REVIEW PROTOCOL")) {
      assert.equal(protocolRepaired, false);
      protocolRepaired = true;
      content = asText(JSON.stringify(negative2));
    } else if (prompt.includes("ORIGINAL WRITER: correct the INDEPENDENT REVIEW FINDINGS") ||
        prompt.includes("RESUME AT VERIFIED CAUSAL BLUEPRINT WRITER BOUNDARY.")) {
      const match = /BASE DIGEST: ([a-f0-9]{64}) REVIEW DIGEST: ([a-f0-9]{64})/.exec(prompt);
      assert.ok(match, "the controller must give the exact previous source/verdict digests");
      const correction = writerPatches[writerRound++];
      assert.ok(correction, "writer must only perform the authorized corrections");
      content = asText([
        JSON.stringify({ schema: "noveltea-blueprint-patch/v1",
          baseDigest: match[1], reviewDigest: match[2] }),
        JSON.stringify(correction),
      ].join("\n"));
    } else throw Error("Unexpected scripted Blueprint Pi prompt: " + prompt.slice(0, 160));
    const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider,
      model: model.id, content, usage, stopReason: reason, timestamp: Date.now() };
    queueMicrotask(() => {
      result.push({ type: "start", partial: message });
      content.forEach((c, i) => {
        if (c.type === "toolCall") {
          result.push({ type: "toolcall_start", contentIndex: i, partial: message });
          result.push({ type: "toolcall_end", contentIndex: i, toolCall: c, partial: message });
        } else if (c.type === "text") {
          result.push({ type: "text_start", contentIndex: i, partial: message });
          result.push({ type: "text_end", contentIndex: i, content: c.text, partial: message });
        }
      });
      result.push({ type: "done", reason, message });
      result.end(message);
    });
    return result;
  };
  return {
    id: model.provider, name: "Deterministic Blueprint certification",
    auth: { apiKey: { name: "Local scripted auth",
      check: async () => ({ type: "api_key", source: "test" }),
      resolve: async () => ({ auth: { apiKey: "local-script-only" } }) } },
    getModels: () => [model], stream, streamSimple: stream,
  };
}
function available() {
  try {
    const security = JSON.parse(execFileSync("docker", ["info", "--format", "{{json .SecurityOptions}}"],
      { encoding: "utf8", timeout: 8000 })) as string[];
    if (!security.some(v => /(^|=)rootless$/.test(v))) return false;
    execFileSync("docker", ["image", "inspect", "noveltea-sandbox:local"],
      { stdio: "ignore", timeout: 8000 });
    return existsSync(resolve(process.env.NT_SKILLS_CHECKOUT ?? "../noveltea-skills",
      "skills/nt-story-architecture/SKILL.md"));
  } catch { return false; }
}

test("#202/#203: production Blueprint review converges after three revisions, protocol repair and a safe budget resume", {
  skip: !available() && "Requires registered rootless sandbox and local noveltea-skills",
  timeout: 360_000,
}, async () => {
  const tmp = mkdtempSync(join(tmpdir(), "nt-202-production-"));
  const id = randomUUID();
  const keys = ["NT_STATE_DIR", "NT_GIT_CACHE_DIR", "NT_SKILL_CACHE_DIR",
    "NT_CONFIG_FILE", "NT_SANDBOX_SOCKET", "NT_SANDBOX_TOKEN_FILE",
    "NT_REQUIRE_SANDBOX_TOOLS", "NT_REQUIRE_USER_PI_RUNTIME"] as const;
  const old = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  let controller: SandboxController | undefined;
  let stalledJobId: string | undefined;
  let disputedJobId: string | undefined;
  const formatJobIds: string[] = [];
  let resumedJobId: string | undefined;
  let repeatedJobId: string | undefined;
  let graphJobId: string | undefined;
  let crashGraphJobId: string | undefined;
  let activeGraphJobId: string | undefined;
  const parentJobIds: string[] = [];
  let server: ReturnType<typeof createControllerServer> | undefined;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  try {
    const app = join(tmp, "app"), state = join(tmp, "state"), cache = join(tmp, "cache");
    const socketDir = join(tmp, "controller"),
      source = resolve(process.env.NT_SKILLS_CHECKOUT ?? "../noveltea-skills");
    for (const dir of [app, state, cache, socketDir]) mkdirSync(dir, { recursive: true });
    const owner = "protocol-202-owner", repositoryId = "protocol-202-repo";
    const scoped = join(cache, hash(owner), hash("github:" + repositoryId));
    const repo = join(scoped, "base"), story = join(repo, "story");
    mkdirSync(join(story, "creative-direction"), { recursive: true });
    writeFileSync(join(story, "creative-direction/foundation.md"), foundation);
    git(repo, "init", "-q"); git(repo, "config", "user.name", "Author");
    git(repo, "config", "user.email", "author@example.test");
    git(repo, "add", "."); git(repo, "commit", "-qm", "Source Story");
    const baseSha = git(repo, "rev-parse", "HEAD");
    const db = new DatabaseSync(join(app, "studio.sqlite"));
    try {
      db.exec("CREATE TABLE studio_sessions (id TEXT, owner_user_id TEXT, story_id TEXT, source_commit_sha TEXT, generation_config_json TEXT);" +
        "CREATE TABLE stories (id TEXT, owner_user_id TEXT, repository_id TEXT, directory TEXT);" +
        "CREATE TABLE repositories (id TEXT, owner_user_id TEXT, provider TEXT, provider_repository_id TEXT);");
      db.prepare("INSERT INTO repositories VALUES (?,?,?,?)").run("repo", owner, "github", repositoryId);
      db.prepare("INSERT INTO stories VALUES (?,?,?,?)").run("story", owner, "repo", "story");
      db.prepare("INSERT INTO studio_sessions VALUES (?,?,?,?,?)").run(id, owner, "story", baseSha, null);
    } finally { db.close(); }
    writeFileSync(join(tmp, "skills-config.json"), JSON.stringify({
      novelteaSkills: source, skillDiscovery: "explicit-only", requiredSkills: [], skillDirs: [],
    }));
    const token = randomBytes(48).toString("hex");
    const tokenFile = join(socketDir, "controller.token");
    writeFileSync(tokenFile, token + "\n", { mode: 0o600 });
    const config: ControllerConfig = {
      socket: join(socketDir, "controller.sock"), token, appVolume: app,
      stateVolume: state, cacheVolume: cache, containerState: state,
      containerCache: cache, image: "noveltea-sandbox:local",
    };
    controller = new SandboxController(config);
    server = createControllerServer(controller);
    server.listen(config.socket);
    await once(server, "listening");
    Object.assign(process.env, {
      NT_STATE_DIR: state, NT_GIT_CACHE_DIR: scoped, NT_SKILL_CACHE_DIR: join(tmp, "skills"),
      NT_CONFIG_FILE: join(tmp, "skills-config.json"),
      NT_SANDBOX_SOCKET: config.socket, NT_SANDBOX_TOKEN_FILE: tokenFile,
      NT_REQUIRE_SANDBOX_TOOLS: "1", NT_REQUIRE_USER_PI_RUNTIME: "1",
    });
    const job = await startStoryJob({ story, job: id, worktreeCacheRoot: scoped });
    const plan: Plan = {
      version: 1, items: [], contract: {
        scope: { kind: "full-story", depth: "architecture", targets: [], branches: [] },
        constraints: [], envelope: { presentation: "text", hardLimits: [], preferences: [] },
      },
    };
    const snapshot = await createSkillSnapshot({
      discovery: "explicit-only", novelteaSkills: source, skillDirs: [],
      requiredSkills: ["nt-story-architecture", "nt-catalog"],
    });
    assert.ok(snapshot);
    const calls: Call[] = [];
    const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
    runtime.registerNativeProvider(scripted(calls));
    await runtime.refresh({ allowNetwork: false });
    assert.equal(evaluateReviewConvergence(negative, compact, [],
      { foundation, task, contract: plan.contract }).review.status, "revise");
    const create = () => withJobModelRuntime(runtime, () =>
      withStoryJobLock(job, "global-architecture", () =>
        createReviewedBlueprint(job, snapshot, plan, model.provider, model.id, task, baseSha)));
    await configurePiPolicy(job, { version: 1,
      profile: { provider: model.provider, model: model.id }, limits: { modelCalls: 4 } });
    await assert.rejects(create(), (error: unknown) =>
      error instanceof PiBudgetPause && error.reason === "modelCalls",
      "compact planner and first review must pause BEFORE the next writer turn");
    assert.equal((await inspectPiPolicy(job)).budget.pause?.reason, "modelCalls");
    const directory = join(job.stateDir, "architecture-blueprints");
    assert.ok(existsSync(join(directory, "plan-1-pause-1-writer.json")));
    assert.equal(existsSync(join(directory, "plan-1-approved.json")), false);
    await configurePiPolicy(job, { version: 1,
      profile: { provider: model.provider, model: model.id }, limits: { modelCalls: 5 } });
    await assert.rejects(create(), (error: unknown) =>
      error instanceof PiBudgetPause && error.reason === "modelCalls",
      "the completed writer patch should pause before a new reviewer turn");
    assert.ok(existsSync(join(directory, "plan-1-pause-1-review.json")));
    assert.ok(existsSync(join(directory, "plan-1-draft-1.json")),
      "paused review must retain the completed, verified patch");
    assert.equal(existsSync(join(directory, "plan-1-verdict-1.json")), false,
      "no new verdict was started when the budget paused");
    assert.equal((await inspectPiPolicy(job)).budget.modelCalls, 5);
    await configurePiPolicy(job, { version: 1,
      profile: { provider: model.provider, model: model.id }, limits: { modelCalls: 60 } });
    const pausedWriter = JSON.parse(readFileSync(join(directory,
      "plan-1-pause-1-review.json"), "utf8")).pin as { plannerSessionFile: string };
    const pausedTranscript = readFileSync(pausedWriter.plannerSessionFile);
    try {
      writeFileSync(pausedWriter.plannerSessionFile, Buffer.concat([
        pausedTranscript, Buffer.from('{"type":"message","message":{"role":"user","content":"Unsealed replay"}}\\n'),
      ]));
      await assert.rejects(create(), /session changed after its safe budget pause/,
        "a post-pause writer turn must never be replayed as if the writer were idle");
    } finally { writeFileSync(pausedWriter.plannerSessionFile, pausedTranscript); }
    const pin = await create();
    assert.equal(pin.schema, "noveltea-approved-blueprint/v4");
    assert.equal(pin.draftVersion, 3, "three productive corrections must pass without fixed attempt exhaustion");
    assert.equal((await inspectPiPolicy(job)).budget.pause, undefined);
    assert.notEqual(pin.plannerSessionId, pin.reviewerSessionId);
    assert.notEqual(pin.plannerSessionFile, pin.reviewerSessionFile);
    const receipt = (index: number) => JSON.parse(readFileSync(
      join(directory, "plan-1-review-session-" + index + ".json"), "utf8"));
    const first = receipt(0), second = receipt(1);
    for (let i = 1; i <= 3; i++) {
      assert.equal(receipt(i).sessionId, first.sessionId);
      assert.equal(receipt(i).sessionFile, first.sessionFile);
      assert.equal(receipt(i).cycleId, pin.reviewCycleId);
      assert.ok(receipt(i).transcriptBytes > receipt(i - 1).transcriptBytes);
      assert.equal(JSON.parse(readFileSync(join(directory,
        "plan-1-convergence-" + i + ".json"), "utf8")).productive, true);
    }
    assert.equal(hash(readFileSync(pin.reviewerSessionFile).subarray(
      0, first.transcriptBytes).toString("utf8")), first.transcriptDigest);
    for (const [i, verdict] of [negative, negative1, negative2, positive].entries())
      assert.deepEqual(JSON.parse(readFileSync(join(directory,
        "plan-1-verdict-" + i + ".json"), "utf8")), verdict);
    const reviews = calls.filter(c =>
      c.prompt.includes("INDEPENDENT READ-ONLY COMPACT STORY BLUEPRINT REVIEW"));
    assert.equal(reviews.length, 8, "all four semantic rounds must reread source before verdict");
    assert.equal(reviews.filter(c => c.lastRole === "toolResult").length, 4);
    assert.equal(calls.filter(c =>
      c.prompt.includes("CONTROLLER REJECTED YOUR REVIEW PROTOCOL")).length, 1,
      "malformed structured review receives bounded protocol correction, not another semantic round");
    assert.match(reviews[2]!.prompt, /PRIOR SEALED REVIEWS/);
    assert.match(reviews[2]!.prompt, /SOURCE CHANGES/);
    assert.match(reviews[2]!.prompt, /CONTINUING YOUR EXISTING INDEPENDENT REVIEW CYCLE/);
    assert.match(JSON.stringify(reviews[2]!.messages), /uncorroborated town entry/,
      "second review must retain the first verdict and the same session analysis");
    for (const review of reviews) {
      assert.ok(review.tools.includes("read"), "pinned source reads use the real sandbox tool");
      assert.ok(review.tools.every(name => !["write", "edit", "bash", "exec"].includes(name)),
        "the reviewer must never be granted Story mutation tools");
    }
    assert.equal((await readApprovedBlueprint(job, plan, snapshot,
      model.provider, model.id, task, baseSha))?.pin.reviewCycleId, pin.reviewCycleId);
    const replay = captureBlueprintReplay(directory, 1, 3, "blueprint-review-verdict",
      join(tmp, "iteration-3-review-replay.json"));
    assert.ok(replay, "offline replay must accept a third productive correction");
    const count = calls.length;
    assert.deepEqual(await create(), pin, "approved replay never invokes Pi again");
    assert.equal(calls.length, count);
    await assert.rejects(readApprovedBlueprint(
      { ...job, threadId: "different-thread" }, plan, snapshot,
      model.provider, model.id, task, baseSha), /stale|scope|bound/);
    await assert.rejects(readApprovedBlueprint(job, { ...plan,
      contract: { ...plan.contract, constraints: ["Unauthorized scope change"] } },
    snapshot, model.provider, model.id, task, baseSha), /stale|scope|bound/);
    const receiptFile = join(directory, "plan-1-review-session-1.json");
    const receiptBytes = readFileSync(receiptFile);
    try {
      writeFileSync(receiptFile, JSON.stringify({ ...second, sessionId: pin.plannerSessionId }));
      await assert.rejects(readApprovedBlueprint(job, plan, snapshot,
        model.provider, model.id, task, baseSha), /review provenance|session/);
    } finally { writeFileSync(receiptFile, receiptBytes); }
    const foundationFile = join(job.worktreeStoryRoot, "creative-direction/foundation.md");
    try {
      writeFileSync(foundationFile, foundation + "Unexpected change to authorized Story source.\\n");
      await assert.rejects(readApprovedBlueprint(job, plan, snapshot,
        model.provider, model.id, task, baseSha), /do not match approved/);
    } finally { writeFileSync(foundationFile, foundation); }
    const originalTranscript = readFileSync(pin.reviewerSessionFile);
    try {
      const tampered = Buffer.from(originalTranscript);
      tampered[first.transcriptBytes - 5] = tampered[first.transcriptBytes - 5] === 65 ? 66 : 65;
      writeFileSync(pin.reviewerSessionFile, tampered);
      await assert.rejects(readApprovedBlueprint(job, plan, snapshot,
        model.provider, model.id, task, baseSha), /transcript changed/);
    } finally { writeFileSync(pin.reviewerSessionFile, originalTranscript); }
    assert.equal((await readApprovedBlueprint(job, plan, snapshot,
      model.provider, model.id, task, baseSha))?.pin.draftVersion, 3);
    assert.equal(git(job.worktreeRoot, "status", "--porcelain"), "",
      "blueprint review cannot mutate canonical Story");
    assert.equal(git(repo, "rev-parse", "HEAD"), baseSha);

    // A separate real Job/Thread through the same production controller:
    // two valid writer patches first add cosmetic text, then return exactly
    // to the old draft. Both negative reviews remain source-grounded; the
    // controller must request reassessment without creating any approval.
    stalledJobId = randomUUID();
    const db2 = new DatabaseSync(join(app, "studio.sqlite"));
    try {
      db2.prepare("INSERT INTO studio_sessions VALUES (?,?,?,?,?)")
        .run(stalledJobId, owner, "story", baseSha, null);
    } finally { db2.close(); }
    const stuck = await startStoryJob({
      story, job: stalledJobId, worktreeCacheRoot: scoped,
    });
    const stuckCalls: Call[] = [];
    const stuckRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
    stuckRuntime.registerNativeProvider(scripted(stuckCalls, "stalled"));
    await stuckRuntime.refresh({ allowNetwork: false });
    await assert.rejects(() => withJobModelRuntime(stuckRuntime, () =>
      withStoryJobLock(stuck, "global-architecture", () =>
        createReviewedBlueprint(stuck, snapshot, plan, model.provider, model.id, task, baseSha))),
    /Diagnostic review requires author-guided escalation/);
    const stuckDir = join(stuck.stateDir, "architecture-blueprints");
    assert.equal(existsSync(join(stuckDir, "plan-1-approved.json")), false);
    assert.equal(JSON.parse(readFileSync(join(stuckDir, "plan-1-convergence-1.json"),
      "utf8")).stalled, 1);
    const end = JSON.parse(readFileSync(join(stuckDir, "plan-1-convergence-2.json"), "utf8"));
    assert.equal(end.stalled, 2);
    assert.equal(end.oscillating, true);
    assert.ok(existsSync(join(stuckDir, "plan-1-diagnostic-2.json")),
      "stagnation must request one independently sealed diagnostic opinion");
    const diagnosis = JSON.parse(readFileSync(join(stuckDir, "plan-1-diagnostic-2.json"), "utf8"));
    assert.equal(diagnosis.trigger, "stagnation");
    assert.equal(diagnosis.diagnosis.action, "escalate");
    assert.notEqual(diagnosis.sessionId, diagnosis.reviewerSessionId);
    assert.equal(stuckCalls.filter(c =>
      c.prompt.includes("INDEPENDENT READ-ONLY COMPACT STORY BLUEPRINT REVIEW") &&
      c.lastRole === "toolResult").length, 3);
    assert.equal(git(stuck.worktreeRoot, "status", "--porcelain"), "");

    // A second production Thread diagnoses stalled review, safely pauses
    // BEFORE diagnosis admission and BEFORE replacement reviewer admission,
    // then gets an independent current pass without mutating old negatives.
    const stalledModelCalls = (await inspectPiPolicy(stuck)).budget.modelCalls;
    const diagnosticTurns = stuckCalls.filter(call =>
      call.prompt.includes("INDEPENDENT, READ-ONLY CAUSAL BLUEPRINT DIAGNOSTIC REVIEW")).length;
    assert.ok(diagnosticTurns >= 2);
    disputedJobId = randomUUID();
    const db3 = new DatabaseSync(join(app, "studio.sqlite"));
    try { db3.prepare("INSERT INTO studio_sessions VALUES (?,?,?,?,?)")
      .run(disputedJobId, owner, "story", baseSha, null); } finally { db3.close(); }
    const disputed = await startStoryJob({
      story, job: disputedJobId, worktreeCacheRoot: scoped,
    });
    const disputedCalls: Call[] = [];
    const disputedRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
    disputedRuntime.registerNativeProvider(scripted(disputedCalls, "replace-pass"));
    await disputedRuntime.refresh({ allowNetwork: false });
    const createDisputed = () => withJobModelRuntime(disputedRuntime, () =>
      withStoryJobLock(disputed, "global-architecture", () =>
        createReviewedBlueprint(disputed, snapshot, plan, model.provider, model.id, task, baseSha)));
    await configurePiPolicy(disputed, { version: 1,
      profile: { provider: model.provider, model: model.id },
      limits: { modelCalls: stalledModelCalls - diagnosticTurns } });
    await assert.rejects(createDisputed(), (error: unknown) => error instanceof PiBudgetPause);
    const disputedDir = join(disputed.stateDir, "architecture-blueprints");
    assert.ok(existsSync(join(disputedDir, "plan-1-pause-2-diagnostic.json")));
    assert.deepEqual(await inspectPausedBlueprint(disputed, plan, snapshot,
      model.provider, model.id, task, baseSha),
      { boundary: "diagnostic", nextVersion: 2 });
    assert.equal(existsSync(join(disputedDir, "plan-1-diagnostic-2.json")), false);
    await configurePiPolicy(disputed, { version: 1,
      profile: { provider: model.provider, model: model.id },
      limits: { modelCalls: stalledModelCalls } });
    await assert.rejects(createDisputed(), (error: unknown) => error instanceof PiBudgetPause);
    assert.ok(existsSync(join(disputedDir, "plan-1-pause-2-replacement.json")));
    assert.ok(existsSync(join(disputedDir, "plan-1-diagnostic-2.json")));
    assert.equal(existsSync(join(disputedDir, "plan-1-replacement-2.json")), false);
    const countDiagnosticTurns = disputedCalls.filter(call =>
      call.prompt.includes("INDEPENDENT, READ-ONLY CAUSAL BLUEPRINT DIAGNOSTIC REVIEW")).length;
    await configurePiPolicy(disputed, { version: 1,
      profile: { provider: model.provider, model: model.id },
      limits: { modelCalls: 60 } });
    const replacementPin = await createDisputed();
    assert.equal(replacementPin.draftVersion, 2);
    const replacementReceipt = JSON.parse(readFileSync(join(disputedDir,
      "plan-1-replacement-2.json"), "utf8"));
    assert.equal(replacementPin.reviewerSessionId, replacementReceipt.sessionId);
    const independentCalls = disputedCalls.filter(call =>
      call.prompt.includes("INDEPENDENT, READ-ONLY CAUSAL BLUEPRINT DIAGNOSTIC REVIEW") ||
      call.prompt.includes("YOU ARE A FRESH, INDEPENDENT REPLACEMENT REVIEWER"));
    assert.ok(independentCalls.length >= 4, "both independent sessions reread source");
    for (const call of independentCalls) {
      assert.ok(call.tools.includes("read"));
      assert.ok(call.tools.every(name => !["write", "edit", "bash", "exec"].includes(name)),
        "neither diagnostic nor replacement can mutate the Story");
    }
    const originalReviewerId = JSON.parse(readFileSync(join(disputedDir,
      "plan-1-review-session-2.json"), "utf8")).sessionId;
    assert.notEqual(replacementPin.reviewerSessionId, originalReviewerId);
    assert.equal(JSON.parse(readFileSync(join(disputedDir, "plan-1-verdict-2.json"),
      "utf8")).status, "revise", "diagnosis never rewrites the historical negative");
    assert.equal(disputedCalls.filter(call =>
      call.prompt.includes("INDEPENDENT, READ-ONLY CAUSAL BLUEPRINT DIAGNOSTIC REVIEW")).length,
    countDiagnosticTurns, "the sealed diagnosis must not rerun during replacement resume");
    assert.deepEqual((await readApprovedBlueprint(disputed, plan, snapshot,
      model.provider, model.id, task, baseSha))?.pin, replacementPin);
    const diagnosticFile = join(disputedDir, "plan-1-diagnostic-2.json");
    const diagnosticBytes = readFileSync(diagnosticFile);
    try {
      const oldReceipt = JSON.parse(diagnosticBytes.toString("utf8"));
      writeFileSync(diagnosticFile, JSON.stringify({ ...oldReceipt, evidenceDigest: "0".repeat(64) }));
      await assert.rejects(readApprovedBlueprint(disputed, plan, snapshot,
        model.provider, model.id, task, baseSha), /diagnosis changed its source/);
    } finally { writeFileSync(diagnosticFile, diagnosticBytes); }

    // When budget expires AFTER a malformed diagnostic or replacement
    // response, resume corrects it in the SAME independent Pi conversation.
    // Neither assessment may run a second time or gain a new reviewer.
    for (const role of ["diagnostic", "replacement"] as const) {
      const formatId = randomUUID();
      formatJobIds.push(formatId);
      const formatDb = new DatabaseSync(join(app, "studio.sqlite"));
      try {
        formatDb.prepare("INSERT INTO studio_sessions VALUES (?,?,?,?,?)")
          .run(formatId, owner, "story", baseSha, null);
      } finally { formatDb.close(); }
      const formatJob = await startStoryJob({
        story, job: formatId, worktreeCacheRoot: scoped,
      });
      const formatCalls: Call[] = [];
      const formatRuntime = await ModelRuntime.create({
        modelsPath: null, refreshOnCreate: false,
      });
      formatRuntime.registerNativeProvider(scripted(formatCalls, "replace-pass", false,
        role === "diagnostic" ? { diagnostic: true } : { replacement: true }));
      await formatRuntime.refresh({ allowNetwork: false });
      const runFormat = () => withJobModelRuntime(formatRuntime, () =>
        withStoryJobLock(formatJob, "global-architecture", () =>
          createReviewedBlueprint(formatJob, snapshot, plan,
            model.provider, model.id, task, baseSha)));
      // Baseline has two calls for the initial independent diagnostic;
      // replacement adds a read and a verdict call before its correction.
      const exhaustedAt = stalledModelCalls + (role === "replacement" ? 2 : 0);
      await configurePiPolicy(formatJob, { version: 1,
        profile: { provider: model.provider, model: model.id },
        limits: { modelCalls: exhaustedAt } });
      await assert.rejects(runFormat(), (error: unknown) =>
        error instanceof PiBudgetPause && error.reason === "modelCalls");
      const planDir = join(formatJob.stateDir, "architecture-blueprints");
      const marker = join(planDir, "plan-1-" + role + "-format-pending-2.json");
      assert.ok(existsSync(marker), "malformed first " + role + " response is sealed before pause");
      const pending = JSON.parse(readFileSync(marker, "utf8"));
      const savedSessionId = pending.sessionId;
      const startedCalls = formatCalls.filter(c =>
        role === "diagnostic" ?
          c.prompt.includes("INDEPENDENT, READ-ONLY CAUSAL BLUEPRINT DIAGNOSTIC REVIEW") :
          c.prompt.includes("YOU ARE A FRESH, INDEPENDENT REPLACEMENT REVIEWER")).length;
      assert.ok(startedCalls >= 1);
      assert.deepEqual(await inspectPausedBlueprint(formatJob, plan, snapshot,
        model.provider, model.id, task, baseSha),
        { boundary: role, nextVersion: 2 });
      const before = readFileSync(marker);
      try {
        writeFileSync(marker, JSON.stringify({ ...pending, transcriptDigest: "0".repeat(64) }));
        await configurePiPolicy(formatJob, { version: 1,
          profile: { provider: model.provider, model: model.id }, limits: { modelCalls: 60 } });
        await assert.rejects(runFormat(), /malformed-answer transcript|review lineage/);
      } finally { writeFileSync(marker, before); }
      const approved = await runFormat();
      assert.equal(approved.draftVersion, 2);
      const finalReceipt = JSON.parse(readFileSync(join(planDir,
        "plan-1-" + role + "-2.json"), "utf8"));
      assert.equal(finalReceipt.sessionId, savedSessionId,
        "format correction retains exact independent " + role + " session");
      assert.equal(formatCalls.filter(c =>
        role === "diagnostic" ?
          c.prompt.includes("INDEPENDENT, READ-ONLY CAUSAL BLUEPRINT DIAGNOSTIC REVIEW") :
          c.prompt.includes("YOU ARE A FRESH, INDEPENDENT REPLACEMENT REVIEWER")).length,
        startedCalls, "an assessment is not repeated when resuming format-only correction");
      assert.ok(formatCalls.some(c => c.prompt.includes(
        role === "diagnostic" ? "CONTROLLER REJECTED DIAGNOSTIC RESPONSE" :
          "CONTROLLER REJECTED REPLACEMENT REVIEW PROTOCOL")));
    }

    // A diagnosis may instead authorize exactly one more bounded attempt.
    // It must retain the original reviewer session, not auto-approve drift.
    resumedJobId = randomUUID();
    const db4 = new DatabaseSync(join(app, "studio.sqlite"));
    try { db4.prepare("INSERT INTO studio_sessions VALUES (?,?,?,?,?)")
      .run(resumedJobId, owner, "story", baseSha, null); } finally { db4.close(); }
    const resumed = await startStoryJob({
      story, job: resumedJobId, worktreeCacheRoot: scoped,
    });
    const continuedCalls: Call[] = [];
    const continuedRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
    continuedRuntime.registerNativeProvider(scripted(continuedCalls, "continue"));
    await continuedRuntime.refresh({ allowNetwork: false });
    const continuedPin = await withJobModelRuntime(continuedRuntime, () =>
      withStoryJobLock(resumed, "global-architecture", () =>
        createReviewedBlueprint(resumed, snapshot, plan, model.provider, model.id, task, baseSha)));
    assert.equal(continuedPin.draftVersion, 3);
    assert.equal(JSON.parse(readFileSync(join(resumed.stateDir, "architecture-blueprints",
      "plan-1-diagnostic-2.json"), "utf8")).diagnosis.action, "continue");
    assert.equal(continuedPin.reviewerSessionId, JSON.parse(readFileSync(join(resumed.stateDir,
      "architecture-blueprints", "plan-1-review-session-0.json"), "utf8")).sessionId);
    assert.deepEqual((await readApprovedBlueprint(resumed, plan, snapshot,
      model.provider, model.id, task, baseSha))?.pin, continuedPin);

    // Re-entering the same source and material blocker after a prior
    // diagnosis must escalate without spending another diagnostic Pi turn.
    repeatedJobId = randomUUID();
    const db5 = new DatabaseSync(join(app, "studio.sqlite"));
    try { db5.prepare("INSERT INTO studio_sessions VALUES (?,?,?,?,?)")
      .run(repeatedJobId, owner, "story", baseSha, null); } finally { db5.close(); }
    const repeated = await startStoryJob({
      story, job: repeatedJobId, worktreeCacheRoot: scoped,
    });
    const repeatedCalls: Call[] = [];
    const repeatedRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
    repeatedRuntime.registerNativeProvider(scripted(repeatedCalls, "repeat"));
    await repeatedRuntime.refresh({ allowNetwork: false });
    await assert.rejects(() => withJobModelRuntime(repeatedRuntime, () =>
      withStoryJobLock(repeated, "global-architecture", () =>
        createReviewedBlueprint(repeated, snapshot, plan, model.provider, model.id,
          task, baseSha))), /requires author-guided escalation for identical source evidence/);
    const repeatedDir = join(repeated.stateDir, "architecture-blueprints");
    assert.ok(existsSync(join(repeatedDir, "plan-1-diagnostic-2.json")));
    assert.equal(existsSync(join(repeatedDir, "plan-1-diagnostic-4.json")), false);
    assert.equal(repeatedCalls.filter(call =>
      call.prompt.includes("INDEPENDENT, READ-ONLY CAUSAL BLUEPRINT DIAGNOSTIC REVIEW") &&
      call.lastRole === "toolResult").length, 1);
    assert.equal(existsSync(join(repeatedDir, "plan-1-approved.json")), false);
    assert.equal(git(repeated.worktreeRoot, "status", "--porcelain"), "");

    // End-to-end Architecture entry point: a fully staged, source-bound
    // initial Blueprint pauses before reviewer admission, survives inspect,
    // then resumes through the SAME production graph after budget increase.
    const graphStory = story;
    writeFileSync(join(graphStory, "creative-direction/foundation.md"), "---\nschema: '0.1'\ntype: creative-direction\nid: creative-direction.foundation\ntitle: \"The missing clerk\"\nstatus: approved\ndecisions: []\npremise: \"The clerk disappears during the night\"\ncentral_conflict: \"Prove the refuge without naming the source\"\ngenre: \"Mystery\"\ntone: \"Investigative\"\nplayer_experience: \"Independent evidence tests\"\nscope: \"A short dialogue-led mystery\"\n---\n\nA missing clerk was secretly sheltered. Prove the truth from dated records without exposing the protected witness.\n");
    git(repo, "add", "."); git(repo, "commit", "-qm", "Approved graph certification Foundation");
    const graphBase = git(repo, "rev-parse", "HEAD");
    graphJobId = randomUUID();
    const graphDb = new DatabaseSync(join(app, "studio.sqlite"));
    try {
      graphDb.prepare("INSERT INTO studio_sessions VALUES (?,?,?,?,?)")
        .run(graphJobId, owner, "story", graphBase, null);
    } finally { graphDb.close(); }
    const graphJob = await startStoryJob({
      story: graphStory, job: graphJobId, worktreeCacheRoot: scoped,
    });
    const graphCalls: Call[] = [];
    const graphRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
    graphRuntime.registerNativeProvider(scripted(graphCalls, "productive", false, {architectureRecovery: true}));
    await graphRuntime.refresh({ allowNetwork: false });
    const graphContract: CompletionContract = {
      scope: { kind: "full-story", depth: "composition", targets: [], branches: [] },
      constraints: [], envelope: { presentation: "Dialogue mystery", hardLimits: [], preferences: [] },
    };
    const graphRun = (command: import("../src/assignment-metadata-recovery.js").AssignmentRoundCommand = {phase: "invoke"}, assignmentKey = "production-blueprint-architecture") => withJobModelRuntime(graphRuntime, () =>
      runArchitectureJob({ story: graphStory, job: graphJobId!,
        action: "run", round: { assignmentKey, command }, contract: graphContract, task, provider: model.provider,
        model: model.id, skillsSource: source, validatorSource: source }));
    const graphInspect = () => runArchitectureJob({
      story: graphStory, job: graphJobId!, action: "inspect",
    });
    await configurePiPolicy(graphJob, { version: 1,
      profile: { provider: model.provider, model: model.id }, limits: { steps: 1 } });
    await assert.rejects(graphRun(), (error: unknown) =>
      error instanceof PiBudgetPause && error.reason === "steps",
      "one remaining step admits the planner exactly once, then pauses before first reviewer");
    const graphDir = join(graphJob.stateDir, "architecture-blueprints");
    assert.ok(existsSync(join(graphDir, "plan-1-pause-initial-review.json")),
      "initial review boundary must be durable before its budget exception");
    assert.equal(existsSync(join(graphDir, "plan-1-verdict-0.json")), false);
    const inspectedPause = await graphInspect();
    assert.equal(inspectedPause.recovery?.status, "ready",
      "graph reconciliation recognizes the sealed initial-review budget pause");
    assert.match(inspectedPause.recovery.reason ?? "", /initial-review/);
    const initialMarkerPath = join(graphDir, "plan-1-pause-initial-review.json");
    const originalMarker = readFileSync(initialMarkerPath);
    const originalSealed = JSON.parse(originalMarker.toString("utf8"));
    try {
      writeFileSync(initialMarkerPath, JSON.stringify({ ...originalSealed,
        lineage: { ...originalSealed.lineage, threadId: "wrong-thread" },
      }));
      const invalidPause = await graphInspect();
      assert.equal(invalidPause.recovery?.status, "blocked",
        "reconciliation must reject a forged initial-review pause before resuming Pi");
    } finally { writeFileSync(initialMarkerPath, originalMarker); }
    const draftPath = join(graphDir, "plan-1-draft-0.json");
    const draftBytes = readFileSync(draftPath);
    try {
      writeFileSync(draftPath, JSON.stringify({ ...JSON.parse(draftBytes.toString("utf8")),
        premise: "Tampered compact premise",
      }));
      assert.equal((await graphInspect()).recovery?.status, "blocked",
        "compact staged draft tampering is rejected by the shared verifier");
    } finally { writeFileSync(draftPath, draftBytes); }
    const graphWriterBefore = originalSealed.plannerSessionId;
    // Exercise the exact-session recovery contract when legitimate historical
    // Pi session data exceeds the opportunistic 1.5 MB reuse threshold. The
    // fixture extends history before resealing its synthetic safe boundary.
    const oldHistory = readFileSync(originalSealed.plannerSessionFile);
    const lastEntry = JSON.parse(oldHistory.toString("utf8").trim().split("\n").at(-1)!);
    assert.ok(typeof lastEntry.id === "string", "synthetic history must follow a real Pi session leaf");
    const historicalTurn = Buffer.from(JSON.stringify({
      type: "message", id: randomUUID(), parentId: lastEntry.id,
      message: { role: "user", content: [{
        type: "text", text: "Historical analysis context. ".repeat(67000),
      }], timestamp: Date.now() },
    }) + "\n");
    const fullHistory = Buffer.concat([oldHistory, historicalTurn]);
    assert.ok(fullHistory.length > 1_500_000);
    writeFileSync(originalSealed.plannerSessionFile, fullHistory);
    writeFileSync(initialMarkerPath, JSON.stringify({
      ...originalSealed, plannerTranscriptBytes: fullHistory.length,
      plannerTranscriptDigest: createHash("sha256").update(fullHistory).digest("hex"),
    }));
    const largeHistoryInspect = await graphInspect();
    assert.equal(largeHistoryInspect.recovery?.status, "ready",
      "large original session remains verifiable before authenticated continuation");
    const completeBudget = (await inspectPiPolicy(job)).budget.modelCalls;
    await configurePiPolicy(graphJob, { version: 1,
      profile: { provider: model.provider, model: model.id },
      limits: { steps: 3, modelCalls: completeBudget } });
    await assert.rejects(graphRun(), (error: unknown) =>
      error instanceof PiBudgetPause && error.reason === "modelCalls",
      "graph reaches verified Blueprint approval, then pauses before canonical writer");
    const afterResume = await graphInspect();
    assert.equal(afterResume.status, "ready");
    assert.equal(afterResume.recovery?.status, "ready");
    const graphPin = JSON.parse(readFileSync(join(graphDir, "plan-1-approved.json"), "utf8"));
    assert.equal(graphPin.plannerSessionId, graphWriterBefore);
    assert.equal(graphPin.draftVersion, 3);
    assert.equal(graphCalls.filter(c =>
      c.prompt.includes("READ-ONLY COMPACT STORY BLUEPRINT.") && c.lastRole === "toolResult").length,
    1, "graph resume does not regenerate original staged Blueprint");
    assert.equal(git(graphJob.worktreeRoot, "status", "--porcelain"), "");

    // #205: the SAME verified compact Blueprint must pass through the genuine
    // canonical Architecture writer, independent draft review, native
    // validator and Git checkpoint, not merely stop at a private approval.
    await configurePiPolicy(graphJob, { version: 1,
      profile: { provider: model.provider, model: model.id },
      limits: { steps: 24, modelCalls: completeBudget + 80 } });
    let submitted = await graphRun();
    assert.ok("round" in submitted && submitted.round?.status === "settled", "writer effect settles before native and independent review");
    assert.equal(git(graphJob.worktreeRoot, "rev-parse", "HEAD"), graphBase);
    assert.equal(git(graphJob.worktreeRoot, "status", "--porcelain"), "", "initial empty draft is a real no-write submission");
    const originalWriter = submitted.piSessionId;
    assert.ok(originalWriter);
    const initialProof = submitted.round.proof;
    const initialCalls = graphCalls.length;
    const replayedInitial = await graphRun();
    assert.ok("round" in replayedInitial && replayedInitial.round?.status === "settled");
    assert.deepEqual(replayedInitial.round.proof, initialProof);
    assert.equal(replayedInitial.piSessionId, originalWriter);
    assert.equal(graphCalls.length, initialCalls, "loss of initial child checkpoint cannot replay the writer");
    await assert.rejects(graphRun({phase: "invoke"}, "unrelated-assignment"), /assignment|recovery blocked/i);
    const initialDir = join(graphJob.stateDir, "architecture-assignment", initialProof.sourceDigest);
    const submissionPath = join(initialDir, "0.submission.json"), settlementPath = join(initialDir, "0.settled.json");
    const submissionBytes = readFileSync(submissionPath), settlementBytes = readFileSync(settlementPath);
    try {
      unlinkSync(submissionPath); unlinkSync(settlementPath);
      await assert.rejects(graphRun(), /started without a sealed effect|settled effect|recovery blocked/i);
      assert.equal(graphCalls.length, initialCalls, "uncertain started original writer must not replay");
      assert.equal(git(graphJob.worktreeRoot, "rev-parse", "HEAD"), graphBase);
    } finally { writeFileSync(submissionPath, submissionBytes); writeFileSync(settlementPath, settlementBytes); }
    const codes = ["architecture-empty-draft", "schema", "architecture-new-protection", "architecture-milestone-order",
      "architecture-precommit-review", "architecture-precommit-review", "architecture-precommit-review"];
    for (const code of codes) {
      assert.ok("round" in submitted && submitted.round?.status === "settled");
      const proof = submitted.round.proof;
      const verification = await graphRun({phase: "verify", proof});
      assert.ok("round" in verification && verification.round?.status === "correction", code);
      const grantDigest = verification.round.grantDigest;
      const grant = JSON.parse(readFileSync(join(graphJob.stateDir, "architecture-assignment", proof.sourceDigest,
        String(proof.ordinal + 1) + ".grant.json"), "utf8"));
      assert.ok(grant.defects.some((defect: {code: string}) => defect.code === code), JSON.stringify(grant.defects));
      assert.equal(grant.sessionId, originalWriter);
      const callsBefore = graphCalls.length;
      const reopened = await graphRun({phase: "verify", proof});
      assert.ok("round" in reopened && reopened.round?.status === "correction");
      assert.equal(reopened.round.grantDigest, grantDigest);
      assert.equal(graphCalls.length, callsBefore, "settled review and admitted correction reopen without a new model call");
      assert.equal(git(graphJob.worktreeRoot, "rev-parse", "HEAD"), graphBase);
      submitted = await graphRun({phase: "correct", proof, grantDigest});
      assert.equal(submitted.piSessionId, originalWriter);
      assert.ok("round" in submitted && submitted.round?.status === "settled");
      const correctionCalls = graphCalls.length;
      const replayedCorrection = await graphRun({phase: "correct", proof, grantDigest});
      assert.ok("round" in replayedCorrection && replayedCorrection.round?.status === "settled");
      assert.deepEqual(replayedCorrection.round.proof, submitted.round.proof);
      assert.equal(graphCalls.length, correctionCalls, "loss of corrective child checkpoint cannot replay the writer");
      if (code === "architecture-empty-draft") {
        const candidate = join(graphJob.worktreeStoryRoot, "milestones/archive.md");
        const original = readFileSync(candidate);
        try {
          writeFileSync(candidate, Buffer.concat([original, Buffer.from("\nUntrusted external edit.\n")]));
          await assert.rejects(graphRun({phase: "verify", proof: submitted.round.proof}), /effect changed|draft changed/i);
          assert.equal(graphCalls.length, correctionCalls);
          assert.equal(git(graphJob.worktreeRoot, "rev-parse", "HEAD"), graphBase);
        } finally { writeFileSync(candidate, original); }
      }
    }
    assert.ok("round" in submitted && submitted.round?.status === "settled");
    const authored = await graphRun({phase: "verify", proof: submitted.round.proof});
    assert.equal(authored.status, "architecture-committed",
      "global compact planning must hand off to canonical Arc/Milestone authoring");
    assert.notEqual(git(graphJob.worktreeRoot, "rev-parse", "HEAD"), graphBase);
    assert.equal(git(graphJob.worktreeRoot, "status", "--porcelain"), "");
    const committedCalls = graphCalls.length;
    assert.equal(await verifyArchitectureAssignmentResult(graphJob, {skillsSource: source, validatorSource: source},
      1, graphBase, authored.headSha), "commit");
    const reopenedCommit = await graphRun({phase: "verify", proof: submitted.round.proof});
    assert.equal(reopenedCommit.headSha, authored.headSha);
    assert.equal(graphCalls.length, committedCalls, "committed effect reconciles without another writer or reviewer");
    const architectureReceipt = join(graphJob.stateDir, "architecture.json");
    const sealed = readFileSync(architectureReceipt);
    try {
      const forged = JSON.parse(sealed.toString("utf8"));
      forged.invocationProof.settlementDigest = "0".repeat(64);
      writeFileSync(architectureReceipt, JSON.stringify(forged));
      await assert.rejects(graphRun({phase: "verify", proof: submitted.round.proof}), /settled|assignment/i);
      assert.equal(graphCalls.length, committedCalls);
      assert.equal(git(graphJob.worktreeRoot, "rev-parse", "HEAD"), authored.headSha);
    } finally { writeFileSync(architectureReceipt, sealed); }
    for (const { path } of canonicalArchitecture) {
      assert.ok(existsSync(join(graphJob.worktreeStoryRoot, path)),
        "canonical Architecture must create " + path);
    }
    assert.match(readFileSync(join(graphJob.worktreeStoryRoot,
      "milestones/archive.md"), "utf8"), /separately maintained guard shift roster/i);
    assert.match(readFileSync(join(graphJob.worktreeStoryRoot,
      "creative-direction/foundation.md"), "utf8"), /Prove the truth/);
    assert.equal(JSON.parse(readFileSync(join(graphDir,
      "plan-1-approved.json"), "utf8")).blueprintDigest, graphPin.blueprintDigest,
    "canonical writing must not change its private reviewed causal source");
    const rounds = execFileSync("find", [join(graphJob.stateDir, "architecture-draft-reviews"), "-name", "round-?.json"], {encoding: "utf8"}).trim().split("\n")
      .map(path => JSON.parse(readFileSync(path, "utf8")));
    assert.equal(rounds.length, 4);
    assert.equal(new Set(rounds.map(r => r.reviewer.id)).size, 1, "all four independent verdicts use the original reviewer");
    assert.equal(new Set(rounds.map(r => r.writer.id)).size, 1);
    assert.ok(rounds.every(r => r.writer.id === originalWriter));
    assert.ok(graphCalls.some(c => c.prompt.includes(
      "INDEPENDENT READ-ONLY early reviewer")),
    "canonical draft must receive an independent source-reading early review");

    // Actual Generation parent, with current-format Turn and real sandbox.
    for (const scenario of ["productive", "canonical-stall", "blueprint-replacement"] as const) {
      const stalled = scenario === "canonical-stall";
      const replacement = scenario === "blueprint-replacement";
      const parentId = randomUUID();
      parentJobIds.push(parentId);
      const parentDb = new DatabaseSync(join(app, "studio.sqlite"));
      try { parentDb.prepare("INSERT INTO studio_sessions VALUES (?,?,?,?,?)")
        .run(parentId, owner, "story", graphBase, null); } finally { parentDb.close(); }
      const parentJob = await startStoryJob({story: graphStory, job: parentId, worktreeCacheRoot: scoped});
      const turn = planWholeStory(task, graphContract, graphBase);
      writeFileSync(join(parentJob.stateDir, "turn-plan.json"), JSON.stringify(turn));
      const calls: Call[] = [];
      const runtime = await ModelRuntime.create({modelsPath: null, refreshOnCreate: false});
      runtime.registerNativeProvider(scripted(calls, replacement ? "replace-pass" : "productive", false, {
        parentPlan: turn, architectureRecovery: true, architectureStall: stalled,
      }));
      await runtime.refresh({allowNetwork: false});
      await configurePiPolicy(parentJob, {version: 1, profile: {provider: model.provider, model: model.id},
        limits: {steps: 50, modelCalls: 250}});
      const file = join(parentJob.stateDir, "r14f-generation.sqlite");
      let saver = SqliteSaver.fromConnString(file);
      let graph = createGenerationGraph(saver, "server");
      const config = {configurable: {thread_id: parentJob.threadId + ":generation:web"}, recursionLimit: 10000, durability: "sync" as const};
      const input = {request: {story: graphStory, job: parentId, task, contract: graphContract, turnPlanDigest: turn.digest,
        fixture: false, skillsSource: source, validatorSource: source, provider: model.provider, model: model.id,
        orchestrationPolicy: "explicit" as const}};
      let started = false;
      const invoke = (extra = {}) => withJobModelRuntime(runtime, () => graph.invoke(started ? null : input, {...config, ...extra}));
      try {
        if (replacement) {
          const pending = await invoke({interruptAfter: ["assess_recovery"]});
          started = true;
          assert.equal(pending.recoveryLifecycle.decision?.action, "known-correction", JSON.stringify(pending.recoveryLifecycle));
          assert.equal(git(parentJob.worktreeRoot, "rev-parse", "HEAD"), graphBase);
          const finished = await invoke({interruptAfter: ["assess_recovery"]});
          assert.ok(finished.recoveryLifecycle.discharged?.length, JSON.stringify({reason: finished.reason, lifecycle: finished.recoveryLifecycle}));
          assert.equal(git(parentJob.worktreeRoot, "rev-parse", "HEAD"), graphBase);
          const pin = JSON.parse(readFileSync(join(parentJob.stateDir, "architecture-blueprints", "plan-1-approved.json"), "utf8"));
          assert.ok(pin.reviewerSessionId);
          assert.equal(calls.filter(c => c.prompt.includes("INDEPENDENT, READ-ONLY CAUSAL BLUEPRINT DIAGNOSTIC REVIEW.") && c.lastRole === "toolResult").length, 1);
        } else if (!stalled) {
          const cuts = ["blueprint-draft", "blueprint-negative", "blueprint-pin", "initial", "admitted", "corrected", "accepted", "committed"] as const;
          let writer: string | undefined;
          for (const cut of cuts) {
            const abort = new AbortController();
            const originalPut = SqliteSaver.prototype.put;
            const originalWrites = SqliteSaver.prototype.putWrites;
            let crashed = false;
            const failure = Error("R14F injected checkpoint loss: " + cut);
            SqliteSaver.prototype.put = async function (...args) {
              if (crashed) throw failure;
              return originalPut.apply(this, args);
            };
            SqliteSaver.prototype.putWrites = async function (cfg, writes, taskId) {
              if (crashed) throw failure;
              const child = cfg.configurable?.checkpoint_ns?.includes("assignment-");
              const entry = (key: string) => writes.find(([channel]) => channel === key)?.[1] as any;
              const submission = entry("submission"), correction = entry("correction"), receipt = entry("receipt");
              const approvalFile = join(parentJob.stateDir, "architecture-blueprints", "plan-1-approved.json");
              const blueprintPin = cut === "blueprint-pin" && existsSync(approvalFile)
                ? JSON.parse(readFileSync(approvalFile, "utf8")) : null;
              if (cut === "blueprint-draft" && child && submission?.status === "story-blueprint-review" && submission.receiptRef.startsWith("0:") ||
                  cut === "blueprint-negative" && child && correction?.rejectedReceiptRef.startsWith("0:review:") ||
                  cut === "blueprint-pin" && child && blueprintPin && entry("outcome")?.status === "verified" &&
                    entry("outcome").evidenceRef === createHash("sha256").update(JSON.stringify(blueprintPin)).digest("hex") ||
                  cut === "initial" && child && submission?.status === "writer-round" && submission.receiptRef.split(":")[1] === "0" ||
                  cut === "admitted" && child && correction?.rejectedReceiptRef.split(":")[1] === "0" ||
                  cut === "corrected" && child && submission?.status === "writer-round" && submission.receiptRef.split(":")[1] === "1" ||
                  cut === "accepted" && cfg.configurable?.thread_id?.includes(":architecture:") && receipt?.phase === "authored" ||
                  cut === "committed" && child && !cfg.configurable?.thread_id?.includes(":architecture:") && entry("outcome")?.status === "verified") {
                crashed = true; abort.abort(failure); throw failure;
              }
              return originalWrites.call(this, cfg, writes, taskId);
            };
            try {
              await assert.rejects(invoke({signal: abort.signal}), "Expected checkpoint loss at " + cut);
              // Aborting the parent can reject before the specialist's async
              // lease cleanup finishes. Wait for release, never remove its lock.
              const deadline = Date.now() + 5000;
              while (existsSync(join(parentJob.stateDir, ".story-job-running")) && Date.now() < deadline)
                await new Promise(resolve => setTimeout(resolve, 10));
              assert.equal(existsSync(join(parentJob.stateDir, ".story-job-running")), false);
            } finally { SqliteSaver.prototype.put = originalPut; SqliteSaver.prototype.putWrites = originalWrites; }
            started = true;
            assert.ok(crashed, "Must lose the actual checkpoint at " + cut);
            const receipt = JSON.parse(readFileSync(join(parentJob.stateDir, "architecture.json"), "utf8"));
            if (cut.startsWith("blueprint-")) {
              const blueprintDir = join(parentJob.stateDir, "architecture-blueprints");
              assert.ok(existsSync(join(blueprintDir, "plan-1-draft-0.json")));
              if (cut !== "blueprint-draft") assert.equal(JSON.parse(readFileSync(join(blueprintDir, "plan-1-verdict-0.json"), "utf8")).status, "revise");
              if (cut === "blueprint-pin") assert.ok(existsSync(join(blueprintDir, "plan-1-approved.json")));
              assert.equal(receipt.piSessionId, undefined, "No canonical writer before private Blueprint approval");
            } else {
              if (writer) assert.equal(receipt.piSessionId, writer);
              writer = receipt.piSessionId;
              assert.ok(writer);
            }
            if (cut !== "committed") assert.equal(git(parentJob.worktreeRoot, "rev-parse", "HEAD"), graphBase);
            else assert.notEqual(git(parentJob.worktreeRoot, "rev-parse", "HEAD"), graphBase);
            saver.db.close();
            saver = SqliteSaver.fromConnString(file);
            graph = createGenerationGraph(saver, "server");
          }
          assert.equal(calls.filter(c => c.prompt.includes("INDEPENDENT READ-ONLY COMPACT STORY BLUEPRINT REVIEW") &&
            c.lastRole === "toolResult").length, 4, "Lost Blueprint checkpoints must not replay independent reviews");
          const beforeResume = calls.length;
          const finished = await invoke({interruptAfter: ["verify_committed_work"]});
          assert.equal(calls.length, beforeResume, "Committed original child resumes without another model call");
          assert.ok(finished.completedStages.some(e => e.stage === "architecture" && e.headSha === git(parentJob.worktreeRoot, "rev-parse", "HEAD")),
            JSON.stringify({reason: finished.reason, lifecycle: finished.recoveryLifecycle}));
          assert.equal(git(parentJob.worktreeRoot, "status", "--porcelain"), "");
          const next = await invoke({interruptBefore: ["specialist_dispatch"]});
          assert.equal(next.active?.stage, "foundations", JSON.stringify({reason: next.reason, active: next.active}));
        } else {
          const finished = await invoke();
          assert.equal(finished.status, "blocked", JSON.stringify({reason: finished.reason, lifecycle: finished.recoveryLifecycle}));
          assert.equal(finished.recoveryLifecycle.decision?.action, "diagnostic-stop", JSON.stringify(finished.recoveryLifecycle));
          assert.equal(calls.filter(c => c.prompt.includes("INDEPENDENT READ-ONLY GENERATION RECOVERY DIAGNOSIS")).length, 1);
          assert.equal(git(parentJob.worktreeRoot, "rev-parse", "HEAD"), graphBase);
          assert.equal(finished.completedStages.some(e => e.stage === "architecture"), false);
          const receipt = JSON.parse(readFileSync(join(parentJob.stateDir, "architecture.json"), "utf8"));
          const terminal = JSON.parse(readFileSync(join(parentJob.stateDir, "architecture-assignment", receipt.sourceDigest, "terminal.json"), "utf8"));
          assert.equal(terminal.kind, "nonconverging");
          const beforeResume = calls.length;
          started = true;
          await invoke();
          assert.equal(calls.length, beforeResume, "Terminal independent diagnosis does not grant another writer");
        }
      } finally { saver.db.close(); }
    }

    // Crash after the reviewer is admitted on a resumed initial pause but
    // before any independent verdict is sealed. A fresh reviewer must never
    // replay the lost turn, even though the initial budget-pause marker exists.
    crashGraphJobId = randomUUID();
    const crashDb = new DatabaseSync(join(app, "studio.sqlite"));
    try {
      crashDb.prepare("INSERT INTO studio_sessions VALUES (?,?,?,?,?)")
        .run(crashGraphJobId, owner, "story", graphBase, null);
    } finally { crashDb.close(); }
    const crashJob = await startStoryJob({ story: graphStory, job: crashGraphJobId,
      worktreeCacheRoot: scoped });
    const crashCalls: Call[] = [];
    const crashRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
    crashRuntime.registerNativeProvider(scripted(crashCalls, "productive", true));
    await crashRuntime.refresh({ allowNetwork: false });
    const crashRun = () => withJobModelRuntime(crashRuntime, () =>
      runArchitectureJob({ story: graphStory, job: crashGraphJobId!,
        action: "run", contract: graphContract, task, provider: model.provider,
        model: model.id, skillsSource: source, validatorSource: source }));
    const crashInspect = () => runArchitectureJob({
      story: graphStory, job: crashGraphJobId!, action: "inspect",
    });
    await configurePiPolicy(crashJob, { version: 1,
      profile: { provider: model.provider, model: model.id }, limits: { steps: 1 } });
    await assert.rejects(crashRun(), (err: unknown) =>
      err instanceof PiBudgetPause && err.reason === "steps");
    const crashDir = join(crashJob.stateDir, "architecture-blueprints");
    assert.ok(existsSync(join(crashDir, "plan-1-pause-initial-review.json")));
    assert.equal((await crashInspect()).recovery?.status, "ready");
    await configurePiPolicy(crashJob, { version: 1,
      profile: { provider: model.provider, model: model.id }, limits: { steps: 3 } });
    await assert.rejects(crashRun(), /Simulated crash during initial reviewer prompt|did not read Creative Direction/);
    assert.ok(crashCalls.some(call => call.prompt.includes(
      "INDEPENDENT READ-ONLY COMPACT STORY BLUEPRINT REVIEW")),
    "the first reviewer prompt must have been attempted before failure");
    const startReceipt = JSON.parse(readFileSync(join(crashDir,
      "plan-1-initial-review-started.json"), "utf8"));
    assert.equal(startReceipt.schema, "noveltea-blueprint-initial-review-start/v1");
    assert.equal(startReceipt.blueprintDigest.length, 64);
    assert.ok(startReceipt.reviewerSessionId);
    assert.equal(existsSync(join(crashDir, "plan-1-verdict-0.json")), false);
    assert.equal((await crashInspect()).recovery?.status, "blocked",
      "reviewer crash is blocked despite otherwise intact pause marker");
    const callsBefore = crashCalls.length;
    await assert.rejects(crashRun(), /Architecture recovery blocked/);
    assert.equal(crashCalls.length, callsBefore,
      "crashed first review cannot be replayed by any Pi session");

    // Simulate active-time expiring deterministically AFTER the graph's
    // admitted preflight and during model resolution, but BEFORE the
    // planner session is created. The persisted meter is the budget source.
    activeGraphJobId = randomUUID();
    const activeDb = new DatabaseSync(join(app, "studio.sqlite"));
    try {
      activeDb.prepare("INSERT INTO studio_sessions VALUES (?,?,?,?,?)")
        .run(activeGraphJobId, owner, "story", graphBase, null);
    } finally { activeDb.close(); }
    const activeJob = await startStoryJob({ story: graphStory, job: activeGraphJobId,
      worktreeCacheRoot: scoped });
    const activeCalls: Call[] = [];
    const activeRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
    activeRuntime.registerNativeProvider(scripted(activeCalls));
    await activeRuntime.refresh({ allowNetwork: false });
    const originalAvailable = activeRuntime.getAvailable.bind(activeRuntime);
    let elapsedAdvanced = false;
    activeRuntime.getAvailable = async provider => {
      const available = await originalAvailable(provider);
      if (!elapsedAdvanced) {
        elapsedAdvanced = true;
        assert.equal(existsSync(join(activeJob.stateDir, "architecture-blueprints",
          "plan-1-admitted.json")), false,
          "simulated time crosses the budget during graph preflight model resolution");
        writeFileSync(join(activeJob.stateDir, "pi-active-time.json"),
          JSON.stringify({ version: 1, elapsedMs: 2500 }));
      }
      return available;
    };
    const activeRun = () => withJobModelRuntime(activeRuntime, () =>
      runArchitectureJob({ story: graphStory, job: activeGraphJobId!,
        action: "run", contract: graphContract, task, provider: model.provider,
        model: model.id, skillsSource: source, validatorSource: source }));
    const activeInspect = () => runArchitectureJob({
      story: graphStory, job: activeGraphJobId!, action: "inspect",
    });
    await configurePiPolicy(activeJob, { version: 1,
      profile: { provider: model.provider, model: model.id },
      limits: { activeSeconds: 1 } });
    await assert.rejects(activeRun(), (error: unknown) =>
      error instanceof PiBudgetPause && error.reason === "activeSeconds",
      "elapsed time after successful graph preflight pauses before planner starts");
    assert.equal(elapsedAdvanced, true);
    const activeDir = join(activeJob.stateDir, "architecture-blueprints");
    const admissionMarker = join(activeDir, "plan-1-pause-planner-admission.json");
    assert.ok(existsSync(admissionMarker), "safe pre-planner budget pause is sealed");
    assert.equal(existsSync(join(activeDir, "plan-1-started.json")), false);
    assert.equal(activeCalls.length, 0, "budget boundary prevents ALL planner Pi calls");
    const inspectedActive = await activeInspect();
    assert.equal(inspectedActive.recovery?.status, "ready");
    assert.match(inspectedActive.recovery.reason ?? "", /planner-admission/);
    const admissionBytes = readFileSync(admissionMarker);
    try {
      const altered = JSON.parse(admissionBytes.toString("utf8"));
      writeFileSync(admissionMarker, JSON.stringify({ ...altered,
        lineage: { ...altered.lineage, threadId: "other-thread" } }));
      assert.equal((await activeInspect()).recovery?.status, "blocked",
        "forged pre-planner pause cannot authorize a new session");
    } finally { writeFileSync(admissionMarker, admissionBytes); }
    await configurePiPolicy(activeJob, { version: 1,
      profile: { provider: model.provider, model: model.id },
      limits: { activeSeconds: 1000, modelCalls: 2 } });
    await assert.rejects(activeRun(), (error: unknown) =>
      error instanceof PiBudgetPause && error.reason === "modelCalls",
      "after raising active time, graph resumes planner and reaches initial reviewer boundary");
    const started = JSON.parse(readFileSync(join(activeDir, "plan-1-started.json"), "utf8"));
    assert.ok(started.plannerSessionId);
    assert.ok(existsSync(join(activeDir, "plan-1-pause-initial-review.json")));
    assert.equal((await activeInspect()).recovery?.status, "ready");
    assert.equal(activeCalls.filter(call => call.prompt.includes(
      "READ-ONLY COMPACT STORY BLUEPRINT.") && call.lastRole === "toolResult").length, 1,
    "the graph launches the original planning assignment only once");
  } finally {
    for (const key of keys) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key];
    }
    if (controller) for (const parentId of parentJobIds) await controller.dispose(parentId);
    if (controller && activeGraphJobId) await controller.dispose(activeGraphJobId);
    if (controller && crashGraphJobId) await controller.dispose(crashGraphJobId);
    if (controller && graphJobId) await controller.dispose(graphJobId);
    if (controller && repeatedJobId) await controller.dispose(repeatedJobId);
    if (controller && resumedJobId) await controller.dispose(resumedJobId);
    if (controller) for (const formatId of formatJobIds) await controller.dispose(formatId);
    if (controller && disputedJobId) await controller.dispose(disputedJobId);
    if (controller && stalledJobId) await controller.dispose(stalledJobId);
    if (controller) await controller.dispose(id);
    if (server) await new Promise<void>(done => server!.close(() => done()));
    await removeTestTree(tmp);
  }
});
