import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectCompositionPrerequisite, closeoutReviewMayRetry, retryCloseoutProposal } from "../src/cross-domain-prerequisite.js";

const sha = (n: string) => n.repeat(40);
const baseline = {
  headSha: sha("a"), milestoneId: "milestone.choice-enacted", planVersion: 2,
  selectedMilestone: { id: "milestone.choice-enacted", path: "milestones/choice-enacted.md" },
  event: { jobId: "job-1", phase: "committed", milestoneId: "milestone.choice-enacted",
    commitSha: sha("1"), workItemId: "event-choice-enacted",
    validation: { status: "passed", milestoneState: "partial-choice-pending",
      eventIds: ["event.setup"] } },
  interactive: { jobId: "job-1", milestoneId: "milestone.choice-enacted",
    eventHead: sha("1"), units: [
      { phase: "committed", commitSha: sha("2"), validation: { status: "passed",
        choices: [{ id: "choice-point.decide", outcomes: [
          { name: "accept", event: "event.setup", step: "offer", branch: "accept" },
          { name: "refuse", event: "event.setup", step: "offer", branch: "refuse" },
        ] }]} },
      { phase: "not-applicable" },
    ] },
  report: { records: [
    { path: "milestones/choice-enacted.md", metadata: { id: "milestone.choice-enacted",
      type: "milestone", status: "draft", completeness: "partial",
      fulfillment: { any_of: [] } } },
    { path: "events/setup.md", metadata: { id: "event.setup", type: "event",
      status: "draft", completeness: "complete" } },
    { path: "choice-points/decide.md", metadata: { id: "choice-point.decide",
      type: "choice-point", status: "draft", outcomes: ["accept", "refuse"] } },
  ], coverage: { search: { truncated: false }, branchProgress: [
    { event: "event.setup", step: "offer", branch: "accept", status: "reachable" },
    { event: "event.setup", step: "offer", branch: "refuse", status: "reachable" },
  ], milestoneRoutes: [] } },
} as const;

const clone = () => structuredClone(baseline) as any;
test("complete typed Milestone is not repaired", () => {
  const data = clone();
  data.report.records[0].metadata.completeness = "complete";
  data.report.records[0].metadata.fulfillment.any_of = [["event.setup"]];
  data.report.coverage.milestoneRoutes = [{ id: data.milestoneId,
    routes: [{ status: "reachable" }] }];
  assert.deepEqual(inspectCompositionPrerequisite(data), { kind: "ready" });
});
test("post-Choice missing closeout becomes source-bound, narrow, causally ordered repair", () => {
  const result = inspectCompositionPrerequisite(clone());
  assert.equal(result.kind, "repair");
  if (result.kind !== "repair") return;
  assert.equal(result.proposal.owner, "nt-event-design");
  assert.deepEqual(result.proposal.allowedPaths, ["milestones/choice-enacted.md"]);
  assert.deepEqual(result.proposal.fields, ["completeness", "fulfillment"]);
  assert.deepEqual(result.proposal.dependsOn, ["interactive:milestone.choice-enacted"]);
  assert.deepEqual(result.proposal.blocks, ["composition:milestone.choice-enacted"]);
  assert.equal(result.proposal.sourceSha, sha("a"));
  assert.match(result.proposal.digest, /^[a-f0-9]{64}$/);
});
test("Choice may enact a reachable selection in its newly authored downstream Event", () => {
  const input = clone();
  input.interactive.units[0].validation.choices[0].outcomes[1].event = "event.downstream";
  input.report.records.push({ path: "events/downstream.md",
    metadata: { id: "event.downstream", type: "event", status: "draft",
      completeness: "complete" } });
  input.report.coverage.branchProgress[1].event = "event.downstream";
  assert.equal(inspectCompositionPrerequisite(input).kind, "repair");
});
test("stale or corrupt sources and unproven outcomes never authorize repair", () => {
  const changes: Array<(v: any) => void> = [
    v => { v.selectedMilestone.path = "milestones/other.md"; },
    v => { v.event.milestoneId = "milestone.other"; },
    v => { v.event.commitSha = "invalid"; },
    v => { v.interactive.eventHead = sha("f"); },
    v => { v.interactive.units[0].phase = "pending"; },
    v => { v.interactive.units[0].validation.choices[0].outcomes[0].event = "event.other"; },
    v => { v.interactive.units[0].validation.choices[0].outcomes = null; },
    v => { v.report.coverage.branchProgress[0].status = "impossible"; },
    v => { v.report.coverage.search.truncated = true; },
    v => { v.report.records[2].metadata.outcomes = ["accept"]; },
    v => { v.event.validation.milestoneState = "complete"; },
    v => { v.report.records[0].metadata.fulfillment.any_of = [["event.not-real"]]; },
    v => { v.report.records[0].metadata.completeness = "complete"; },
  ];
  for (const mutate of changes) {
    const input = clone(); mutate(input);
    assert.equal(inspectCompositionPrerequisite(input).kind, "refuse",
      JSON.stringify(input).slice(0, 200));
  }
});
test("a negative closeout review permits only same-Milestone Event field correction", () => {
  const finding = inspectCompositionPrerequisite(clone());
  assert.equal(finding.kind, "repair");
  if (finding.kind !== "repair") return;
  const review = { verdict: "block", findings: [{
    severity: "blocking", repair: "event",
    source: "milestones/choice-enacted.md:12",
  }] };
  assert.equal(closeoutReviewMayRetry(review, finding.proposal), true);
  assert.equal(closeoutReviewMayRetry({ ...review, findings: review.findings.map(f =>
    ({ ...f, repair: "interactive" })) }, finding.proposal), false);
  assert.equal(closeoutReviewMayRetry({ ...review, findings: review.findings.map(f =>
    ({ ...f, source: "events/setup.md:12" })) }, finding.proposal), false);
  const advanced = retryCloseoutProposal(finding.proposal, sha("b"));
  assert.equal(advanced.sourceSha, sha("b"));
  assert.deepEqual(advanced.allowedPaths, finding.proposal.allowedPaths);
  assert.notEqual(advanced.digest, finding.proposal.digest);
});
test("a missing author-owned Event or unresolved protected scope is not an automatic closeout", () => {
  const input = clone();
  input.report.records = input.report.records.filter((r: any) => r.metadata.type !== "event");
  assert.equal(inspectCompositionPrerequisite(input).kind, "refuse");
});
