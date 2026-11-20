import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCausalBlueprint, parseCompactStoryBlueprint,
  parseBlueprintReview, compactStoryBlueprintPrompt, readApprovedBlueprint,
  type CausalBlueprint } from "../src/architecture-blueprint.js";
import { compactBlueprintSources, validateCompactBlueprintSources }
  from "../src/architecture-blueprint-obligations.js";
import { applyBlueprintPatch, blueprintDigest } from "../src/architecture-blueprint-patch.js";
import { evaluateReviewConvergence } from "../src/review-convergence.js";
import { reviewCycleId } from "../src/review-cycle.js";
import type { JobStartResult } from "../src/job.js";
import type { SkillSnapshot } from "../src/snapshot.js";
import { compactReviewPrompt, compactCorrectionPrompt }
  from "../src/architecture-compact-prompts.js";
import type { Plan } from "../src/architecture.js";

const sources = {
  foundation: "Protect the shelter witness and keep a mystery grounded in independent records.",
  task: "Plan a short narrative-led disappearance mystery with a protected witness.",
  contract: { scope: { kind: "full-story", depth: "architecture" },
    envelope: { hardLimits: [{ type: "backgrounds", max: 3 }],
      preferences: ["60-minute single-route playthrough", "narrative-led"] } },
};
const blueprint: CausalBlueprint = {
  schema: "noveltea-causal-blueprint/v2",
  premise: "A clerk vanishes after disclosing forged departure records.",
  arcs: [{ id: "disappearance", goal: "Investigate the missing clerk" },
    { id: "resolution", goal: "Expose the forgery without endangering the witness" }],
  beats: [
    { id: "arrival", arcId: "disappearance", purpose: "Establish the missing person's last known movements",
      dependsOn: [], observations: [], change: "Find the contradictory travel record", decisions: [] },
    { id: "gate", arcId: "resolution", purpose: "Test the disappearance account",
      dependsOn: ["arrival"], observations: [],
      change: "A dated service-gate record establishes an independent trail",
      decisions: [{ question: "Disclose the witness?",
        alternatives: [{ action: "Protect", lastingEffect: "Keep the refuge confidential" },
          { action: "Publish", lastingEffect: "Make the witness's identity public" }] }] },
  ],
  resolution: { question: "Where is the clerk?",
    conclusion: "The clerk arrived at the secret shelter through its service gate",
    supportedBy: ["gate"], uncertainty: "The source's identity stays confidential" },
  causalAnswer: {
    question: "Why did the clerk disappear?",
    answer: "The clerk sought protection in the shelter.",
    mechanism: "The caretaker unlocked a service gate for the clerk.",
    responsibility: "The caretaker arranged the protected admission.",
    motive: "A creditor threatened to expose the clerk's testimony.",
    proofApproach: "Find any records that might exist later.",
  },
  feasibility: {
    playthrough: "About an hour along one route, not both branches combined.",
    interaction: "Narrative-led with one significant protective decision.",
    production: "Reuse two backgrounds and two speaking character portraits.",
    endings: "Both endings establish refuge; only disclosure differs.",
  },
};
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const sourceQuote = "narrative-led disappearance mystery with a protected witness";
const finding = {
  beatId: "gate", reason: "The proof approach does not name a plausible test.",
  correction: "Promise a dated service register and an independent guard roster.",
  requirement: { source: "task" as const, quote: sourceQuote },
  evidence: { beatId: "story" as const, field: "causalAnswer" as const,
    quote: "Find any records that might exist later." },
  origin: "initial" as const,
};
const review = { schema: "noveltea-blueprint-review/v2" as const,
  status: "revise" as const, findings: [finding], prior: [] };
const patch = {
  schema: "noveltea-blueprint-patch/v1",
  baseDigest: blueprintDigest(blueprint), reviewDigest: blueprintDigest(review),
  operations: [{ kind: "replace", findingBeatId: "gate",
    path: "causalAnswer/proofApproach",
    expected: blueprint.causalAnswer!.proofApproach,
    value: "The dated service-gate register and independent guard roster are plausible later tests." }],
};

test("#205 compact Blueprint describes global Arcs, Milestones, answers and budgets without local evidence", () => {
  assert.deepEqual(parseCompactStoryBlueprint(JSON.stringify(blueprint)), blueprint);
  assert.equal(blueprint.beats.every(beat => beat.observations.length === 0), true);
  const prompt = compactStoryBlueprintPrompt({
    version: 1, contract: sources.contract,
  } as unknown as Plan, sources.task);
  for (const key of ["noveltea-causal-blueprint/v2", "Playthrough length",
    "Production budget", "observations MUST BE []", "major Milestones"])
    assert.ok(prompt.includes(key), key);
  assert.ok(!prompt.includes("routeConsequences"));
});

test("#205 compact Blueprint rejects a deferred answer, missing Arcs, invalid dependencies and exhaustive evidence", () => {
  const invalid = (mutate: (copy: CausalBlueprint) => void, pattern: RegExp) => {
    const copy = clone(blueprint);
    mutate(copy);
    assert.throws(() => parseCompactStoryBlueprint(JSON.stringify(copy)), pattern);
  };
  invalid(b => { b.causalAnswer!.answer = "To be determined"; }, /concrete causal answer/);
  invalid(b => { b.beats[1]!.arcId = "invented"; }, /relationships/);
  invalid(b => { b.beats[0]!.dependsOn = ["gate"]; }, /relationships/);
  invalid(b => { b.resolution.supportedBy = ["not-written"]; }, /causal chain/);
  invalid(b => { b.arcs!.push({ id: "resolution", goal: "Duplicate" }); }, /concrete causal answer/);
  invalid(b => { b.beats[0]!.observations = [{ source: "ledger", observable: "clue",
    supports: "answer", limits: "unknown" }]; }, /without local evidence inventory/);
  invalid(b => { b.feasibility!.playthrough = ""; }, /route\/budget feasibility/);
  const legacyLike = clone(blueprint);
  delete (legacyLike as Record<string, unknown>).arcs;
  assert.throws(() => parseCausalBlueprint(JSON.stringify(legacyLike)), /structure/);
});

test("#205 source digests bind independent review to the exact approved Foundation, objective and contract", () => {
  const receipt = compactBlueprintSources(sources);
  assert.deepEqual(validateCompactBlueprintSources(receipt, sources), receipt);
  for (const changed of [
    { ...sources, foundation: sources.foundation + " Changed" },
    { ...sources, task: sources.task + " changed" },
    { ...sources, contract: { ...sources.contract, envelope: { hardLimits: [] } } },
  ]) assert.throws(() => validateCompactBlueprintSources(receipt, changed),
    /do not match approved/);
});

test("#205 source-bound independent review permits deferred local evidence, but not an unspecified global causal test", () => {
  const parsed = parseBlueprintReview(JSON.stringify(review), blueprint);
  assert.equal(evaluateReviewConvergence(parsed, blueprint, [], sources).review.status, "revise");
  const reviewed = compactReviewPrompt({ contract: sources.contract } as Plan,
    blueprint, compactBlueprintSources(sources), sources.task, []);
  assert.match(reviewed, /DO NOT require exhaustive clue observations/);
  assert.match(reviewed, /Interaction profile, Playthrough length or Production budget/);
  assert.match(reviewed, /creative-direction\/foundation.md/);
  const bad = clone(review);
  bad.findings[0]!.requirement.quote = "a requirement never stated by the author";
  assert.throws(() => evaluateReviewConvergence(bad, blueprint, [], sources),
    /exact authorized source citation/);
});

test("#205 a source-bound global fix can converge without inventing evidence batches", () => {
  const originalVerdict = parseBlueprintReview(JSON.stringify(review), blueprint);
  const { blueprint: corrected } = applyBlueprintPatch(blueprint, originalVerdict, patch);
  assert.equal(corrected.beats.every(beat => beat.observations.length === 0), true);
  assert.equal(corrected.beats[1]!.decisions[0]!.alternatives[0]!.lastingEffect,
    "Keep the refuge confidential");
  assert.match(compactCorrectionPrompt(blueprint, originalVerdict), /causalAnswer\/answer/);
  const accepted = {
    schema: "noveltea-blueprint-review/v2", status: "pass", findings: [],
    prior: [{ round: 0, findingIndex: 0, status: "resolved",
      reason: "A separately dated guard roster tests the gate register.",
      evidence: { beatId: "story", field: "causalAnswer",
        quote: "independent guard roster" } }],
  };
  const result = evaluateReviewConvergence(accepted, corrected,
    [{ blueprint, verdict: originalVerdict }], sources);
  assert.equal(result.review.status, "pass");
  assert.equal(result.productive, true);
  const unchanged = clone(blueprint);
  assert.throws(() => evaluateReviewConvergence(accepted, unchanged,
    [{ blueprint, verdict: originalVerdict }], sources),
    /source progress|stale/);
  assert.throws(() => applyBlueprintPatch(blueprint, originalVerdict,
    { ...patch, baseDigest: "0".repeat(64) }), /stale/);
  assert.throws(() => applyBlueprintPatch(blueprint, originalVerdict,
    { ...patch, operations: [{ kind: "append-observation", findingBeatId: "gate",
      beatId: "gate", value: { source: "clue", observable: "clue", supports: "why",
        limits: "unknown" } }] }), /cannot add local evidence/);
  assert.throws(() => evaluateReviewConvergence({
    ...accepted, prior: [{ ...accepted.prior[0], status: "regressed" }],
  }, corrected, [{ blueprint, verdict: originalVerdict }], sources),
  /cannot approve/);
});

test("#205 source-bound reviewers reject impossible route totals and protected witness disclosure", () => {
  const route = clone(blueprint);
  route.feasibility!.playthrough = "Both exclusive routes each take 60 minutes and must be added together";
  const routeVerdict = {
    schema: "noveltea-blueprint-review/v2", status: "revise", prior: [],
    findings: [{
      beatId: "gate", origin: "initial",
      reason: "Mutually exclusive route durations were summed as one playthrough.",
      correction: "Estimate a single experienced route within the approved length.",
      requirement: { source: "contract", quote: "60-minute single-route playthrough" },
      evidence: { beatId: "story", field: "feasibility",
        quote: "Both exclusive routes each take 60 minutes" },
    }],
  };
  assert.equal(evaluateReviewConvergence(routeVerdict, route, [], sources).review.status,
    "revise");
  const violated = clone(blueprint);
  violated.feasibility!.endings = "Publish the protected witness identity in every ending";
  const protectedVerdict = {
    schema: "noveltea-blueprint-review/v2", status: "revise", prior: [],
    findings: [{
      beatId: "gate", origin: "initial",
      reason: "Every ending violates the approved protected-witness requirement.",
      correction: "Allow an ending that preserves confidentiality.",
      requirement: { source: "foundation", quote: "Protect the shelter witness" },
      evidence: { beatId: "story", field: "feasibility",
        quote: "Publish the protected witness identity in every ending" },
    }],
  };
  assert.equal(evaluateReviewConvergence(protectedVerdict, violated, [], sources)
    .review.status, "revise");
  assert.throws(() => evaluateReviewConvergence(protectedVerdict, blueprint, [], sources),
    /current beat and exact authorized source citation/);
});

test("#205 compact Blueprint approval verifies v4 stage, sources and continuing-review provenance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nt-205-approved-"));
  try {
    const story = join(dir, "story");
    const store = join(dir, "architecture-blueprints");
    await mkdir(join(story, "creative-direction"), { recursive: true });
    await mkdir(store, { recursive: true });
    await writeFile(join(story, "creative-direction", "foundation.md"), sources.foundation);
    const job = { stateDir: dir, worktreeStoryRoot: story,
      jobId: "205-job", threadId: "205-thread", baseSha: "a".repeat(40) } as JobStartResult;
    const plan = { version: 1, contract: sources.contract } as Plan;
    const snapshot = { id: "205-pinned-skills" } as SkillSnapshot;
    const head = "b".repeat(40);
    const provider = "openai", model = "gpt-6";
    const digest = (value: unknown) =>
      createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const admission = {
      jobId: job.jobId, threadId: job.threadId, baseSha: job.baseSha,
      executionHead: head, planVersion: plan.version,
      contractDigest: digest(plan.contract), snapshotId: snapshot.id, provider, model,
      taskDigest: digest(sources.task),
    };
    const writer = join(dir, "architecture-blueprint-sessions", "writer.jsonl");
    const reviewer = join(dir, "architecture-blueprint-review-sessions", "reviewer.jsonl");
    await mkdir(join(dir, "architecture-blueprint-sessions"));
    await mkdir(join(dir, "architecture-blueprint-review-sessions"));
    await writeFile(writer, JSON.stringify({ type: "session", id: "writer-id" }) + "\n");
    const transcript = Buffer.from(JSON.stringify({ type: "session", id: "reviewer-id" }) + "\n");
    await writeFile(reviewer, transcript);
    const approval = { schema: "noveltea-blueprint-review/v2" as const,
      status: "pass" as const, findings: [], prior: [] };
    const convergence = evaluateReviewConvergence(approval, blueprint, [], sources);
    const stage = { schema: "noveltea-blueprint-stages/v4",
      draftDigest: digest(blueprint) };
    const manifest = compactBlueprintSources(sources);
    const cycleId = reviewCycleId(admission);
    const pin = {
      schema: "noveltea-approved-blueprint/v4",
      reviewCycleId: cycleId, ...admission,
      draftVersion: 0, blueprintDigest: digest(blueprint),
      reviewDigest: digest(approval), obligationsDigest: digest(manifest),
      stagesDigest: digest(stage), plannerSessionId: "writer-id",
      plannerSessionFile: writer, reviewerSessionId: "reviewer-id",
      reviewerSessionFile: reviewer,
    };
    const write = async (name: string, value: unknown) =>
      writeFile(join(store, "plan-1-" + name + ".json"), JSON.stringify(value));
    await write("admitted", admission);
    await write("started", { ...admission, plannerSessionId: "writer-id",
      plannerSessionFile: writer });
    await write("obligations", manifest);
    await write("draft-0", blueprint);
    await write("stages", stage);
    await write("verdict-0", approval);
    await write("convergence-0", {
      schema: "noveltea-blueprint-convergence/v1",
      draftDigest: digest(blueprint), verdictDigest: digest(approval),
      productive: convergence.productive, stalled: convergence.stalled,
      oscillating: convergence.oscillating,
    });
    await write("review-session-0", {
      schema: "noveltea-blueprint-review-turn/v1", cycleId,
      sessionId: "reviewer-id", sessionFile: reviewer,
      blueprintDigest: digest(blueprint), verdictDigest: digest(approval),
      transcriptBytes: transcript.length,
      transcriptDigest: createHash("sha256").update(transcript).digest("hex"),
    });
    await write("approved", pin);
    const read = () => readApprovedBlueprint(job, plan, snapshot,
      provider, model, sources.task, head);
    assert.deepEqual((await read())?.blueprint, blueprint);
    await write("stages", { ...stage, draftDigest: "f".repeat(64) });
    await assert.rejects(read, /stage receipt/);
    await write("stages", stage);
    await writeFile(join(story, "creative-direction", "foundation.md"),
      sources.foundation + " Revised without approval.");
    await assert.rejects(read, /do not match approved/);
    await writeFile(join(story, "creative-direction", "foundation.md"), sources.foundation);
    await write("review-session-0", {
      schema: "noveltea-blueprint-review-turn/v1", cycleId,
      sessionId: "writer-id", sessionFile: writer,
      blueprintDigest: digest(blueprint), verdictDigest: digest(approval),
      transcriptBytes: transcript.length,
      transcriptDigest: createHash("sha256").update(transcript).digest("hex"),
    });
    await assert.rejects(read, /provenance|session/);
    await write("review-session-0", {
      schema: "noveltea-blueprint-review-turn/v1", cycleId,
      sessionId: "reviewer-id", sessionFile: reviewer,
      blueprintDigest: digest(blueprint), verdictDigest: digest(approval),
      transcriptBytes: transcript.length,
      transcriptDigest: createHash("sha256").update(transcript).digest("hex"),
    });
    assert.deepEqual((await read())?.pin, pin);
    assert.equal((await readFile(join(store, "plan-1-draft-0.json"), "utf8"))
      .includes("noveltea-causal-blueprint/v2"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
