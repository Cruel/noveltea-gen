import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDependencyTool } from "../src/dependency-tool.js";
import type { JobStartResult } from "../src/job.js";
import { authorizeDependency, type DependencyReport } from "../src/dependency-amendments.js";
import { bindDependencyProposalIdentity, needsDependencyProposalCorrection } from "../src/dependency-planner.js";
import type { TurnEvidence } from "../src/turn-plan-evidence.js";
import { planRevision } from "../web/src/lib/turn-plan.js";
import { focusedSpecialist, isFocusedRecordType } from "../src/focused-specialist.js";

const head = "a".repeat(40);
const plan = {
  version: 1, kind: "revision", originalRequest: "Write Ada's disclosure", goal: "Write Ada's disclosure",
  source: { jobId: "source", verifiedSha: head }, digest: "b".repeat(64),
  contract: { scope: { kind: "partial", depth: "composition", targets: ["authored-content.disclosure"], branches: [] },
    constraints: [], envelope: { presentation: "Dialogue", hardLimits: [], preferences: [] } },
  objective: { breadth: "focused", requestedTargets: ["authored-content.disclosure"], deliveryDepth: "composition", obligations: ["Ada discloses the truth"] },
  assignments: [{ id: "focus:authored-content.disclosure", specialist: "nt-narrative-composition", outcome: "Ada discloses the truth",
    targets: ["authored-content.disclosure"], dependsOn: [], discovery: "canonical-story-read-only",
    authority: { recordTypes: ["authored-content"], existingPaths: ["authored-content/disclosure.md"], mayCreate: false } }],
  reviewRequired: true,
} satisfies TurnEvidence;
const records = [
  { path: "authored-content/disclosure.md", metadata: { id: "authored-content.disclosure", type: "authored-content", status: "draft", events: ["event.disclosure"] } },
  { path: "events/disclosure.md", metadata: { id: "event.disclosure", type: "event", status: "draft", participants: ["character.ada"], decisions: [] } },
  { path: "characters/ada.md", metadata: { id: "character.ada", type: "character", status: "draft", decisions: [] } },
];
const source = { path: "events/disclosure.md", sha256: "c".repeat(64), quote: "Ada has not learned the truth." };
const report = { sourceSha: head, turnDigest: plan.digest, assignmentId: plan.assignments[0].id,
  obligation: "Ada discloses the truth", missing: "Establish how Ada learns the truth before disclosure",
  affectedIds: ["authored-content.disclosure", "event.disclosure", "character.ada"],
  sources: [source], likelySpecialist: "nt-event-design", authorDecisionRequired: false };
const proposal = { sourceSha: head, reportDigest: "d".repeat(64), target: "event.disclosure",
  specialist: "nt-event-design", outcome: report.missing, reason: "Disclosure requires the speaker to know the truth." };

test("dependency proposals with mistyped source SHA or report digest require one fresh model reply", () => {
  const entry = { report, reportDigest: proposal.reportDigest };
  assert.equal(needsDependencyProposalCorrection(proposal, entry, false), false);
  assert.equal(
    needsDependencyProposalCorrection(
      {
        ...proposal,
        reportDigest: "f".repeat(64),
      },
      entry,
      false,
    ),
    true,
    "a single incorrect digest digit must not enter authorization",
  );
  assert.equal(
    needsDependencyProposalCorrection(
      {
        ...proposal,
        sourceSha: "f".repeat(40),
      },
      entry,
      false,
    ),
    true,
  );
  assert.equal(
    needsDependencyProposalCorrection(
      {
        ...proposal,
        outcome: "Rewrite another Event",
      },
      entry,
      false,
    ),
    true,
  );
  assert.equal(
    needsDependencyProposalCorrection(
      {
        ...proposal,
        target: "events/disclosure.md",
      },
      entry,
      false,
    ),
    true,
  );
  const refusal = { rejected: true as const, reason: "Unapproved scope expansion" };
  assert.equal(
    needsDependencyProposalCorrection(refusal, entry, true),
    false,
    "A model rejection must never be rehabilitated into a write grant",
  );
  assert.deepEqual(bindDependencyProposalIdentity(refusal, entry), refusal);
  const semanticOnly = {
    target: "character.mara",
    specialist: "nt-character-development",
    outcome: report.missing,
    reason: "Mara is needed to testify.",
    title: "Mara",
  };
  assert.equal(needsDependencyProposalCorrection(semanticOnly as typeof proposal, entry, true), false);
  assert.deepEqual(
    bindDependencyProposalIdentity(semanticOnly as typeof proposal, entry),
    {
      ...semanticOnly,
      sourceSha: report.sourceSha,
      reportDigest: entry.reportDigest,
    },
    "The controller stamps its own verified identity rather than asking Luna to copy it",
  );
  assert.throws(
    () =>
      bindDependencyProposalIdentity(
        {
          ...semanticOnly,
          sourceSha: report.sourceSha,
          reportDigest: "f".repeat(64),
        },
        entry,
      ),
    /untrusted/,
    "An explicit, conflicting digest must not be replaced",
  );
  assert.throws(
    () =>
      bindDependencyProposalIdentity(
        {
          ...semanticOnly,
          sourceSha: report.sourceSha,
        } as typeof proposal,
        entry,
      ),
    /incomplete/,
  );
  const characterProposal = {
    ...proposal,
    target: "character.mara",
    specialist: "nt-character-development",
    title: "Mara",
  };
  assert.equal(needsDependencyProposalCorrection(characterProposal, entry, true), false);
  assert.equal(
    needsDependencyProposalCorrection(
      {
        ...characterProposal,
        reportDigest: "f".repeat(64),
      },
      entry,
      true,
    ),
    true,
  );
});

test("focused planning, authorization and dispatch share one record-type specialist resolver", () => {
  const cases = [
    ["character", "nt-character-development"], ["relationship", "nt-character-development"],
    ["world-entity", "nt-worldbuilding"], ["fact", "nt-worldbuilding"],
    ["revelation", "nt-worldbuilding"], ["event", "nt-event-design"],
    ["authored-content", "nt-narrative-composition"],
    ["choice-point", "nt-interactive-narrative"], ["puzzle", "nt-interactive-narrative"],
  ] as const;
  for (const [type, specialist] of cases) {
    assert.equal(isFocusedRecordType(type), true);
    assert.equal(focusedSpecialist(type + ".sample"), specialist);
  }
  assert.equal(isFocusedRecordType("milestone"), false);
  assert.throws(() => focusedSpecialist("milestone.demo"), /No bounded focused specialist/);
  const fromAdmission = planRevision(plan.goal, plan.contract, head, "source", records,
    ["authored-content.disclosure"], ["authored-content/disclosure.md"]);
  assert.equal(fromAdmission.assignments[0]?.specialist,
    focusedSpecialist("authored-content.disclosure"));
});

test("specialist reports a pinned obligation by index; host stamps its exact text", async () => {
  const root = mkdtempSync(join(tmpdir(), "nt-dependency-tool-"));
  try {
    mkdirSync(join(root, "events"));
    writeFileSync(join(root, "events/disclosure.md"), "# Ada sees the signature mismatch\n");
    let observed: DependencyReport | undefined;
    const tool = createDependencyTool({ worktreeStoryRoot: root } as JobStartResult, {
      head, turnDigest: plan.digest, assignmentId: "focus:authored-content.disclosure",
      obligations: plan.objective.obligations,
    }, report => { observed = report; });
    const required = (tool.parameters as { required: string[] }).required;
    assert.ok(required.includes("obligationIndex"));
    assert.ok(!required.includes("obligation"));
    const input = { obligationIndex: 0, missing: report.missing,
      affectedIds: ["authored-content.disclosure", "event.disclosure"],
      sources: [{ path: "events/disclosure.md", quote: "Ada sees the signature mismatch" }],
      likelySpecialist: "nt-event-design", authorDecisionRequired: false };
    await tool.execute("report", input, {} as never);
    assert.equal(observed?.obligation, plan.objective.obligations[0]);
    assert.equal(observed?.sourceSha, head);
    assert.equal(observed?.assignmentId, "focus:authored-content.disclosure");
    await assert.rejects(tool.execute("report", { ...input, obligationIndex: 99 }, {} as never), /index|Validation/i);
    await assert.rejects(tool.execute("report", { ...input,
      affectedIds: ["event.disclosure"] }, {} as never), /originating assignment/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("controller adds only the connected owning specialist while retaining the author objective", () => {
  const result = authorizeDependency({ plan, head, report, reportDigest: proposal.reportDigest,
    proposal, records, sources: [source], version: 1 });
  assert.equal(result.beforeVersion, 1);
  assert.equal(result.afterVersion, 2);
  assert.deepEqual(result.objective, plan.objective);
  assert.equal(result.assignment.specialist, "nt-event-design");
  assert.deepEqual(result.assignment.authority, { recordTypes: ["event"], existingPaths: ["events/disclosure.md"], mayCreate: false });
  assert.equal(result.resumes, "focus:authored-content.disclosure");
});

test("controller rejects stale evidence, invented authority, wrong owners and protected or unrelated work", () => {
  const valid = { plan, head, report, reportDigest: proposal.reportDigest,
    proposal, records, sources: [source], version: 1 };
  const cases = [
    { ...valid, head: "e".repeat(40) },
    { ...valid, proposal: { ...proposal, reportDigest: "e".repeat(64) } },
    { ...valid, proposal: { ...proposal, specialist: "nt-worldbuilding" } },
    { ...valid, proposal: { ...proposal, authority: { mayCreate: true } } },
    { ...valid, proposal: { ...proposal, target: "event.invented" } },
    { ...valid, report: { ...report, authorDecisionRequired: true } },
    { ...valid, report: { ...report, obligation: "Add a new subplot" } },
    { ...valid, sources: [{ ...source, sha256: "e".repeat(64) }] },
    { ...valid, records: records.map(r => r.metadata.type === "event" ? { ...r,
      metadata: { ...r.metadata, decisions: [{ origin: "user", text: "Ada never learns the truth" }] } } : r) },
    { ...valid, records: records.map(r => r.metadata.type === "authored-content" ? { ...r,
      metadata: { ...r.metadata, decisions: [{ origin: "user", text: "The disclosure cannot happen" }] } } : r) },
    { ...valid, records: records.map(r => r.metadata.type === "authored-content" ? { ...r,
      metadata: { ...r.metadata, events: [] } } : r) },
  ];
  for (const candidate of cases) assert.throws(() => authorizeDependency(candidate), /dependency|Dependency|amendment/i);
});

test("controller rejects a dependency path already owned as supportingTargets by the original writer", () => {
  const contract = { ...plan.contract, scope: { ...plan.contract.scope,
    supportingTargets: ["event.disclosure"] } };
  const supported = planRevision(plan.goal, contract, head, "source", records,
    ["authored-content.disclosure"], ["authored-content/disclosure.md", "events/disclosure.md"]);
  const owner = supported.assignments.find(a => a.id === "focus:authored-content.disclosure");
  assert.deepEqual(owner?.targets, ["authored-content.disclosure"]);
  assert.deepEqual(owner?.authority.existingPaths,
    ["authored-content/disclosure.md", "events/disclosure.md"]);
  const evidence = { ...report, turnDigest: supported.digest,
    obligation: supported.objective!.obligations[0]! };
  const input = { plan: supported, head, report: evidence,
    reportDigest: proposal.reportDigest, proposal, records, sources: [source], version: 1 };
  assert.throws(() => authorizeDependency(input), /already assigned|already owned|overlap/i);

  // A distinct writer's non-target authority can overlap too. New-file grants
  // must not create a second owner for an existing canonical path either.
  const otherWriter = { ...plan.assignments[0], id: "focus:character.ada",
    targets: ["character.ada"], authority: {
      ...plan.assignments[0].authority, existingPaths: ["events/disclosure.md"] } };
  assert.throws(() => authorizeDependency({ ...input, plan: { ...plan,
    assignments: [plan.assignments[0], otherWriter] }, report }), /already assigned|already owned|overlap/i);
  assert.throws(() => authorizeDependency({ ...input, plan: { ...plan,
    assignments: [plan.assignments[0], { ...otherWriter, authority: {
      ...otherWriter.authority, existingPaths: [], newPaths: ["events/disclosure.md"] } }] },
    report }), /already assigned|already owned|overlap/i);
  assert.throws(() => authorizeDependency({ ...input, plan,
    priorAmendments: [{ ...otherWriter, authority: {
      ...otherWriter.authority, existingPaths: ["events/disclosure.md"] } }],
    report }), /already assigned|already owned|overlap/i);
  assert.throws(() => authorizeDependency({ ...input, plan,
    priorAmendments: [{ ...otherWriter, authority: {
      ...otherWriter.authority, existingPaths: [], newPaths: ["events/disclosure.md"] } }],
    report }), /already assigned|already owned|overlap/i);
  // A different already-authorized record does not block a valid amendment.
  assert.equal(authorizeDependency({ ...input, plan, report,
    priorAmendments: [{ ...otherWriter, authority: {
      ...otherWriter.authority, existingPaths: ["characters/ada.md"] } }] }).assignment.targets[0],
  "event.disclosure");
});

test("controller recognizes the schema-typed Event relationship effect without broad metadata scanning", () => {
  const eventPlan = { ...plan, assignments: [{ ...plan.assignments[0],
    id: "focus:event.disclosure", specialist: "nt-event-design", targets: ["event.disclosure"] }] };
  const relationship = { path: "relationships/ada-neri.md", metadata: {
    id: "relationship.ada-neri", type: "relationship", status: "draft", decisions: [],
    characters: ["character.ada", "character.neri"] } };
  const eventRecord = { path: "events/disclosure.md", metadata: {
    id: "event.disclosure", type: "event", status: "draft", decisions: [],
    participants: ["character.ada"],
    steps: [{ branches: [{ effects: [{ kind: "relationship", relationship: relationship.metadata.id }] }] }] } };
  const relationshipSource = { path: relationship.path, sha256: source.sha256, quote: "Ada and Neri are estranged." };
  const eventReport = { ...report, assignmentId: "focus:event.disclosure", obligation: report.obligation,
    affectedIds: ["event.disclosure", relationship.metadata.id], sources: [relationshipSource],
    likelySpecialist: "nt-character-development" };
  const eventProposal = { ...proposal, target: relationship.metadata.id,
    specialist: "nt-character-development", outcome: report.missing };
  const input = { plan: eventPlan, head, report: eventReport, proposal: eventProposal,
    reportDigest: eventProposal.reportDigest, records: [eventRecord, relationship],
    sources: [relationshipSource], version: 1 };
  assert.equal(authorizeDependency(input).assignment.authority.existingPaths[0], relationship.path);

  const unrelated = { ...eventRecord, metadata: { ...eventRecord.metadata, steps: [],
    facts: [relationship.metadata.id] } };
  assert.throws(() => authorizeDependency({ ...input, records: [unrelated, relationship] }),
    /unrelated dependency record/);
});

test("a Fact prerequisite follows an actual knowledge predicate, never an invented facts array", () => {
  const eventPlan = { ...plan, assignments: [{ ...plan.assignments[0],
    id: "focus:event.disclosure", specialist: "nt-event-design", targets: ["event.disclosure"] }] };
  const fact = { path: "facts/ledger.md", metadata: {
    id: "fact.ledger", type: "fact", status: "draft", initial: true, decisions: [] } };
  const event = { path: "events/disclosure.md", metadata: {
    id: "event.disclosure", type: "event", status: "draft", decisions: [],
    steps: [{ branches: [{ conditions: [], effects: [{ kind: "knowledge",
      character: "character.ada", fact: fact.metadata.id, value: "knows" }] }] }] } };
  const factSource = { path: fact.path, sha256: source.sha256, quote: "The ledger proves the secret." };
  const factReport = { ...report, assignmentId: "focus:event.disclosure",
    affectedIds: ["event.disclosure", fact.metadata.id], sources: [factSource],
    likelySpecialist: "nt-worldbuilding" };
  const factProposal = { ...proposal, target: fact.metadata.id,
    specialist: "nt-worldbuilding", outcome: report.missing };
  const input = { plan: eventPlan, head, report: factReport, reportDigest: factProposal.reportDigest,
    proposal: factProposal, records: [event, fact], sources: [factSource], version: 1 };
  assert.equal(authorizeDependency(input).assignment.specialist, "nt-worldbuilding");
  assert.throws(() => authorizeDependency({ ...input, records: [{ ...event,
    metadata: { ...event.metadata, steps: [], facts: [fact.metadata.id] } }, fact] }),
    /unrelated dependency record/);
});
