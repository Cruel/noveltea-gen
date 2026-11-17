import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBlueprintReview, parseCausalBlueprint, readApprovedBlueprint,
  type CausalBlueprint, type BlueprintPin } from "../src/architecture-blueprint.js";
import { buildBlueprintObligations } from "../src/architecture-blueprint-obligations.js";
import { applyBlueprintPatch } from "../src/architecture-blueprint-patch.js";
import type { JobStartResult } from "../src/job.js";
import type { Plan } from "../src/architecture.js";
import type { SkillSnapshot } from "../src/snapshot.js";

const example: CausalBlueprint = {
  schema: "noveltea-causal-blueprint/v1",
  premise: "The missing clerk concealed public records to protect a witness.",
  beats: [
    { id: "ledger", purpose: "Find evidence of alteration", dependsOn: [],
      observations: [{ source: "archive inspection photograph", observable: "A page is absent in dated photo",
        supports: "Page inserted after the photo", limits: "Does not identify the writer" }],
      change: "Investigation shifts to alteration",
      decisions: [] },
    { id: "lighthouse", purpose: "Find the clerk", dependsOn: ["ledger"],
      observations: [{ source: "shelter register and dated letter",
        observable: "Both place the clerk there and express the intention to hide",
        supports: "Deliberate shelter", limits: "Does not prove the wider conspiracy" }],
      change: "The player's aim becomes protecting or publishing evidence",
      decisions: [{ question: "Protect or publish the source?",
        alternatives: [{ action: "Protect", lastingEffect: "Witness remains sheltered" },
          { action: "Publish", lastingEffect: "Witness loses privacy, archive becomes accountable" }] }] },
  ],
  resolution: { question: "What happened to the clerk?",
    conclusion: "The clerk deliberately took refuge at the lighthouse.",
    supportedBy: ["ledger", "lighthouse"], uncertainty: "The alteration's author remains unknown." },
};
const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

test("the blueprint is a bounded causal chain, not a bag of unordered plot beats", () => {
  assert.deepEqual(parseCausalBlueprint(JSON.stringify(example)), example);
  const duplicate = clone(example);
  duplicate.beats[1]!.id = "ledger";
  assert.throws(() => parseCausalBlueprint(JSON.stringify(duplicate)), /beat relationships/);
  const forward = clone(example);
  forward.beats[0]!.dependsOn = ["lighthouse"];
  assert.throws(() => parseCausalBlueprint(JSON.stringify(forward)), /beat relationships/);
  const unsupported = clone(example);
  unsupported.resolution.supportedBy = ["unwritten-scene"];
  assert.throws(() => parseCausalBlueprint(JSON.stringify(unsupported)), /evidence chain/);
  const noEvidence = clone(example);
  noEvidence.beats.forEach(b => b.observations = []);
  assert.throws(() => parseCausalBlueprint(JSON.stringify(noEvidence)), /evidence chain/);
});

test("narrative-only beats may omit decisions without weakening evidence or unknown-field checks", () => {
  const sparse = clone(example);
  const beat = sparse.beats[0]! as Partial<CausalBlueprint["beats"][number]>;
  delete beat.decisions;
  const parsed = parseCausalBlueprint(JSON.stringify(sparse));
  assert.deepEqual(parsed, example, "omitted no-decision beat has one canonical reviewed representation");
  const invalid = clone(sparse);
  invalid.beats[0]!.decisions = null as unknown as CausalBlueprint["beats"][number]["decisions"];
  assert.throws(() => parseCausalBlueprint(JSON.stringify(invalid)), /beat relationships/);
  const extraneous = clone(sparse);
  Object.assign(extraneous.beats[0]!, { maybeChoice: "not approved" });
  assert.throws(() => parseCausalBlueprint(JSON.stringify(extraneous)), /beat relationships/);
});

test("a single total-size ceiling avoids arbitrary paragraph-length rejections", () => {
  const extended = clone(example);
  extended.resolution.conclusion = "Evidence supports a finding. ".repeat(100);
  extended.beats[0]!.change = "The verified evidence changes the next objective. ".repeat(34);
  assert.equal(parseCausalBlueprint(JSON.stringify(extended)).resolution.conclusion.length,
    extended.resolution.conclusion.length);
  assert.equal(parseCausalBlueprint(JSON.stringify(extended)).beats[0]!.change,
    extended.beats[0]!.change);
  extended.resolution.conclusion = "Many claims. ".repeat(3000);
  assert.throws(() => parseCausalBlueprint(JSON.stringify(extended)), /bounded size/);
});

test("decisions require alternatives with lasting consequences", () => {
  const broken = clone(example);
  broken.beats[1]!.decisions[0]!.alternatives = [{ action: "Publish", lastingEffect: "Noise" }];
  assert.throws(() => parseCausalBlueprint(JSON.stringify(broken)), /lasting alternatives/);
  const extra = clone(example) as CausalBlueprint & { approved?: boolean };
  extra.approved = true;
  assert.throws(() => parseCausalBlueprint(JSON.stringify(extra)), /structure/);
});

test("independent blueprint review must tie findings to existing beats", () => {
  assert.deepEqual(parseBlueprintReview('{"status":"pass","findings":[]}', example),
    { status: "pass", findings: [] });
  assert.equal(parseBlueprintReview(JSON.stringify({ status: "revise", findings: [{
    beatId: "lighthouse", reason: "The letter is not independently authenticated",
    correction: "Plan how the player verifies the signature",
  }] }), example).status, "revise");
  for (const raw of [
    '{"status":"pass","findings":[{"beatId":"ledger","reason":"x","correction":"y"}]}',
    '{"status":"revise","findings":[]}',
    '{"status":"revise","findings":[{"beatId":"unknown","reason":"x","correction":"y"}]}',
    '{"status":"pass","findings":[],"authorApproved":true}',
  ]) assert.throws(() => parseBlueprintReview(raw, example), /review/);
});

test("checkpointed blueprint only restores exact reviewed version, plan, head, session and source", async () => {
  const base = await mkdtemp(join(tmpdir(), "noveltea-blueprint-"));
  try {
    const foundation = "The approved mystery protects its vulnerable witness.";
    const story = join(base, "story");
    await mkdir(join(story, "creative-direction"), { recursive: true });
    await writeFile(join(story, "creative-direction/foundation.md"), foundation);
    const job = { stateDir: base, worktreeStoryRoot: story,
      jobId: "job-one", threadId: "thread-one",
      baseSha: "a".repeat(40) } as JobStartResult;
    const plan = { version: 2, contract: { scope: { kind: "full-story", depth: "composition",
      targets: [], branches: [] }, constraints: [], envelope: { presentation: "text",
      hardLimits: [], preferences: [] } } } as Plan;
    const snapshot = { id: "snapshot-one" } as SkillSnapshot;
    const parent = join(base, "architecture-blueprints");
    const plannerFile = join(base, "architecture-blueprint-sessions", "session.jsonl");
    const reviewerFile = join(base, "architecture-blueprint-review-sessions", "session.jsonl");
    await mkdir(parent);
    for (const [path, id] of [[plannerFile, "planner-id"], [reviewerFile, "reviewer-id"]] as const) {
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, JSON.stringify({ type: "session", id }) + "\n", { mode: 0o600 });
    }
    const review = { status: "pass" as const, findings: [] };
    const manifest = buildBlueprintObligations([{
      id: "identify-clerk", category: "what", source: "task", quote: "write a mystery",
      question: "What happened to the clerk?", proof: "Inspect shelter and archive records",
      route: "Available even if a source refuses", beatIds: ["ledger", "lighthouse"],
    }], example, { foundation, contract: plan.contract, task: "write a mystery" });
    const pin: BlueprintPin = {
      schema: "noveltea-approved-blueprint/v2", jobId: job.jobId, threadId: job.threadId,
      baseSha: job.baseSha, executionHead: "b".repeat(40), planVersion: plan.version,
      contractDigest: digest(plan.contract), snapshotId: snapshot.id, provider: "openai",
      model: "gpt-6-luna", taskDigest: digest("write a mystery"),
      draftVersion: 0, blueprintDigest: digest(example), reviewDigest: digest(review),
      obligationsDigest: digest(manifest),
      plannerSessionFile: plannerFile, plannerSessionId: "planner-id",
      reviewerSessionFile: reviewerFile, reviewerSessionId: "reviewer-id",
    };
    const draftFile = join(parent, "plan-2-draft-0.json");
    const reviewFile = join(parent, "plan-2-verdict-0.json");
    await writeFile(draftFile, JSON.stringify(example));
    await writeFile(reviewFile, JSON.stringify(review));
    await writeFile(join(parent, "plan-2-obligations.json"), JSON.stringify(manifest));
    await writeFile(join(parent, "plan-2-review-session-0.json"), JSON.stringify({
      sessionId: "reviewer-id", sessionFile: reviewerFile,
      blueprintDigest: digest(example), verdictDigest: digest(review),
    }));
    await writeFile(join(parent, "plan-2-started.json"), JSON.stringify({
      jobId: pin.jobId, threadId: pin.threadId, baseSha: pin.baseSha,
      executionHead: pin.executionHead, planVersion: pin.planVersion,
      contractDigest: pin.contractDigest, snapshotId: pin.snapshotId,
      provider: pin.provider, model: pin.model, taskDigest: pin.taskDigest,
      plannerSessionId: pin.plannerSessionId, plannerSessionFile: pin.plannerSessionFile,
    }));
    await writeFile(join(parent, "plan-2-approved.json"), JSON.stringify(pin));
    const read = () => readApprovedBlueprint(job, plan, snapshot, "openai", "gpt-6-luna",
      "write a mystery", "b".repeat(40));
    assert.deepEqual((await read())?.blueprint, example);
    await assert.rejects(() => readApprovedBlueprint(job, { ...plan, contract: {
      ...plan.contract, constraints: ["new objective"] } }, snapshot, "openai",
    "gpt-6-luna", "write a mystery", "b".repeat(40)), /stale/);
    await assert.rejects(() => readApprovedBlueprint(job, plan, snapshot, "openai",
      "gpt-6-luna", "write a mystery", "c".repeat(40)), /stale/);
    await writeFile(draftFile, JSON.stringify({ ...example, premise: "tampered" }));
    await assert.rejects(read, /changed after review|patch history|provenance changed/);
    await writeFile(draftFile, JSON.stringify(example));
    await writeFile(reviewerFile, JSON.stringify({ type: "session", id: "imposter" }) + "\n");
    await assert.rejects(read, /identity mismatch/);
    assert.equal(JSON.parse(await readFile(join(parent, "plan-2-approved.json"), "utf8")).draftVersion, 0);
    await writeFile(reviewerFile, JSON.stringify({ type: "session", id: "reviewer-id" }) + "\n");
    const tampered = { ...manifest, items: [{ ...manifest.items[0]!, proof: "a different ending" }] };
    await writeFile(join(parent, "plan-2-obligations.json"), JSON.stringify(tampered));
    await assert.rejects(read, /obligations changed/);
    await writeFile(join(parent, "plan-2-obligations.json"), JSON.stringify(manifest));

    const revise = { status: "revise" as const, findings: [{
      beatId: "lighthouse", reason: "Arrival does not establish why the clerk hid",
      correction: "Add an independently dated letter",
    }] };
    const patch = {
      schema: "noveltea-blueprint-patch/v1" as const,
      baseDigest: digest(example), reviewDigest: digest(revise),
      operations: [{ kind: "append-observation", findingBeatId: "lighthouse",
        beatId: "lighthouse", value: { source: "authenticated dated letter",
          observable: "The clerk explicitly requests refuge",
          supports: "Clerk voluntarily entered shelter",
          limits: "The letter does not resolve wider conspiracy" } }],
    };
    const merged = applyBlueprintPatch(example, revise, patch).blueprint;
    await writeFile(reviewFile, JSON.stringify(revise));
    await writeFile(join(parent, "plan-2-review-session-0.json"), JSON.stringify({
      sessionId: "reviewer-id", sessionFile: reviewerFile,
      blueprintDigest: digest(example), verdictDigest: digest(revise),
    }));
    const reviewerFile1 = join(base, "architecture-blueprint-review-sessions", "reviewer1.jsonl");
    await writeFile(reviewerFile1, JSON.stringify({ type: "session", id: "reviewer-id-1" }) + "\n");
    await writeFile(join(parent, "plan-2-patch-1.json"), JSON.stringify(patch));
    await writeFile(join(parent, "plan-2-draft-1.json"), JSON.stringify(merged));
    await writeFile(join(parent, "plan-2-verdict-1.json"), JSON.stringify(review));
    await writeFile(join(parent, "plan-2-review-session-1.json"), JSON.stringify({
      sessionId: "reviewer-id-1", sessionFile: reviewerFile1,
      blueprintDigest: digest(merged), verdictDigest: digest(review),
    }));
    const finalPin = { ...pin, draftVersion: 1, blueprintDigest: digest(merged),
      reviewDigest: digest(review), reviewerSessionId: "reviewer-id-1",
      reviewerSessionFile: reviewerFile1 };
    await writeFile(join(parent, "plan-2-approved.json"), JSON.stringify(finalPin));
    assert.deepEqual((await read())?.blueprint, merged,
      "recovery must apply only the recorded patch against the originally reviewed base");
    await writeFile(join(parent, "plan-2-patch-1.json"), JSON.stringify({
      ...patch, baseDigest: "c".repeat(64),
    }));
    await assert.rejects(read, /stale/);
    await writeFile(join(parent, "plan-2-patch-1.json"), JSON.stringify(patch));
    await writeFile(reviewFile, JSON.stringify({ ...revise, findings: [] }));
    await assert.rejects(read, /review|provenance/);
  } finally { await rm(base, { recursive: true, force: true }); }
});
