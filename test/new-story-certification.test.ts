import assert from "node:assert/strict";
import { test } from "node:test";
import { auditNewStory, auditNewStoryMatrix, type NewStoryEvidence } from "../src/new-story-certification.js";

const sha = (char: string) => char.repeat(40);
const digest = (char: string) => char.repeat(64);
const dimensions = [
  "playable-opening",
  "clue-trail",
  "branch-consequences",
  "knowledge-continuity",
  "mystery-payoff",
  "meaningful-endings",
  "player-facing-prose",
] as const;
const paths = [
  "creative-direction/foundation.md",
  "arcs/investigation.md",
  "milestones/discovery.md",
  "characters/witness.md",
  "events/find-ledger.md",
  "choice-points/confront.md",
  "authored-content/opening.md",
];
const lines = Object.fromEntries(
  paths.map((path) => [path, "A substantial Story record\nVisible narrative evidence\n"]),
);

function evidence(mode: "autonomous" | "collaborative", marker: string): NewStoryEvidence {
  const baseSha = sha(marker),
    headSha = sha(marker === "a" ? "d" : "e"),
    id = "job-" + mode;
  const readPaths = [
    "nt-story-orchestrate/SKILL.md",
    "nt-story-orchestrate/references/planning.md",
    "nt-catalog/SKILL.md",
    "nt-catalog/references/records.md",
    "nt-catalog/references/progression.md",
    "nt-catalog/references/authority-and-validation.md",
  ];
  if (mode === "collaborative")
    readPaths.push("nt-story-collaborate/SKILL.md", "nt-story-collaborate/references/interaction.md");
  return {
    mode,
    approval: {
      scope: "whole-story",
      jobId: id,
      firstTurnId: id,
      sourceSha: baseSha,
      originalObjective: "Make me a mystery game.",
      creativeMode: mode,
      skillId: digest("1"),
      proposalDigest: digest("2"),
      provider: "openai",
      model: "gpt-6-luna",
    },
    turn: {
      kind: "full-story",
      originalRequest: "Make me a mystery game.",
      source: { verifiedSha: baseSha },
      digest: digest("3"),
      objective: {
        breadth: "whole-story",
        deliveryDepth: "composition",
        obligations: ["Substantive playable mystery and branch payoffs"],
      },
      creativePolicy: { mode },
      contract: { scope: { kind: "full-story", depth: "composition" } },
    },
    selection: {
      skillName: "nt-story-orchestrate",
      storySourceSha: baseSha,
      turnPlanDigest: digest("3"),
      writeAuthority: "controller-only",
      role: "orchestrator",
      reviewRole: "reviewer",
      skillSnapshot: { id: digest("4"), digest: digest("4"), commit: sha("5") },
    },
    planning: {
      phase: "planned",
      sourceSha: baseSha,
      turnDigest: digest("3"),
      snapshotId: digest("4"),
      provider: "openai",
      model: "gpt-6-luna",
      skillReads: readPaths,
      sessionFile: "/private/pi-session.jsonl",
    },
    plannerSessionVerified: true,
    report: {
      identity: { jobId: id, baseSha, headSha, clean: true },
      plan: { scope: { kind: "full-story", depth: "composition" } },
      generation: {
        status: "completed",
        scopeFulfillment: "complete-in-scope",
        planFulfillment: { status: "passed", headSha },
        review: { worker: "pi", current: true },
        blockers: [],
      },
      evidence: {
        scope: {
          current: true,
          deterministic: "passed",
          headSha,
          scopedPaths: paths,
          routeCoverage: { representative: true, truncated: false },
          globalCatalog: { status: "passed", readiness: { ready: true }, diagnostics: 0, outstanding: 0 },
        },
        protection: { status: "checked", verifiedHead: headSha },
        editorial: { verdict: "pass", findings: [] },
        logicalUnverified: [],
      },
    },
    canonical: lines,
    quality: {
      schema: "noveltea-external-story-quality/v1",
      mode,
      headSha,
      reviewer: "Independent narrative reader",
      relationship: "external",
      findings: dimensions.map((dimension) => ({
        dimension,
        verdict: "pass" as const,
        evidence: ["authored-content/opening.md:2"],
        analysis: "The actual authored scene supports the named outcome and its consequences.",
      })),
    },
    studio: {
      threadId: "root:" + id,
      firstTurnId: id,
      sourceSha: baseSha,
      approvedDigest: digest("2"),
      baselineQuestions: 2,
      recommendationsPresented: true,
      exactApproval: true,
      continuedOriginalTurn: true,
      authorInteractionsReviewed: true,
      recoveryAndIsolationReviewed: true,
      evidenceReference: "Private Studio transcript and restart audit",
    },
  };
}

test("a source-bound completed real-Pi mystery with distinct external review can pass the evidence gate", () => {
  const result = auditNewStory(evidence("autonomous", "a"));
  assert.equal(result.status, "eligible", JSON.stringify(result.blockers));
  assert.deepEqual(result.blockers, []);
});

test("both creative modes require independent runs and distinct Story sources", () => {
  const autonomous = evidence("autonomous", "a");
  const collaborative = evidence("collaborative", "b");
  assert.equal(auditNewStoryMatrix([autonomous, collaborative]).status, "eligible");
  assert.equal(auditNewStoryMatrix([autonomous, autonomous]).status, "blocked");
  assert.equal(
    auditNewStoryMatrix([
      autonomous,
      {
        ...collaborative,
        report: {
          ...collaborative.report,
          identity: { ...collaborative.report.identity, headSha: autonomous.report.identity.headSha },
        },
      },
    ]).status,
    "blocked",
  );
});

test("a partial skills-only mystery, fixture-only editorial verdict or outline cannot pass", () => {
  const source = evidence("autonomous", "a");
  const partial = {
    ...source,
    report: {
      ...source.report,
      generation: {
        ...source.report.generation,
        status: "paused",
        scopeFulfillment: "unverified",
        planFulfillment: { status: "required" },
        review: { worker: "fixture", current: false },
      },
    },
  };
  assert.equal(auditNewStory(partial).status, "blocked");
  assert.match(auditNewStory(partial).blockers.join(" "), /complete|Pi|review/i);
  const outline = { ...source, canonical: { ...source.canonical, "authored-content/opening.md": "" } };
  assert.equal(auditNewStory(outline).status, "blocked");
});

test("global native readiness and non-truncated progression are required independently", () => {
  const source = evidence("autonomous", "a");
  const original = source.report.evidence.scope!;
  assert.equal(
    auditNewStory({
      ...source,
      report: {
        ...source.report,
        evidence: {
          ...source.report.evidence,
          scope: { ...original, globalCatalog: { ...original.globalCatalog, status: "rejected" } },
        },
      },
    }).status,
    "blocked",
  );
  assert.equal(
    auditNewStory({
      ...source,
      report: {
        ...source.report,
        evidence: {
          ...source.report.evidence,
          scope: { ...original, routeCoverage: { representative: true, truncated: true } },
        },
      },
    }).status,
    "blocked",
  );
});

test("pinned method, original objective, provenance and distinct collaborative references are mandatory", () => {
  const autonomous = evidence("autonomous", "a");
  const changed = {
    ...autonomous,
    turn: { ...autonomous.turn, originalRequest: "Rewrite a different game" },
  };
  assert.equal(auditNewStory(changed).status, "blocked");
  assert.equal(
    auditNewStory({ ...autonomous, planning: { ...autonomous.planning, snapshotId: digest("f") } }).status,
    "blocked",
  );
  assert.equal(
    auditNewStory({ ...autonomous, selection: { ...autonomous.selection, writeAuthority: "specialist" } })
      .status,
    "blocked",
  );
  assert.equal(
    auditNewStory({
      ...autonomous,
      planning: {
        ...autonomous.planning,
        skillReads: [...autonomous.planning.skillReads, "nt-story-collaborate/SKILL.md"],
      },
    }).status,
    "blocked",
  );
  const collaborative = evidence("collaborative", "b");
  assert.equal(
    auditNewStory({
      ...collaborative,
      planning: {
        ...collaborative.planning,
        skillReads: collaborative.planning.skillReads.filter((p) => !p.includes("nt-story-collaborate")),
      },
    }).status,
    "blocked",
  );
});

test("a final checkpoint continuation retains original author approval and the complete Story quality gate", () => {
  const original = evidence("autonomous", "a");
  const finalJobId = "job-recovery-2";
  const next: NewStoryEvidence = {
    ...original,
    lineage: {
      originalJobId: original.report.identity.jobId,
      originalSourceSha: original.report.identity.baseSha,
      terminalJobId: finalJobId,
      hops: [
        { sourceJobId: original.report.identity.jobId, childJobId: "job-recovery-1",
          sourceBaseSha: original.report.identity.baseSha, checkpointSha: sha("c"),
          proofDigest: digest("1"), verified: true },
        { sourceJobId: "job-recovery-1", childJobId: finalJobId,
          sourceBaseSha: sha("c"), checkpointSha: sha("f"),
          proofDigest: digest("2"), verified: true },
      ],
    },
    report: { ...original.report, identity: {
      ...original.report.identity, jobId: finalJobId, baseSha: sha("f"),
    } },
  };
  assert.deepEqual(auditNewStory(next).blockers, []);
  assert.equal(auditNewStory({ ...next, lineage: undefined }).status, "blocked",
    "A terminal child must not masquerade as the original approved first Turn");
  assert.match(auditNewStory({ ...next, lineage: {
    ...next.lineage!, hops: next.lineage!.hops.map((hop, i) =>
      i === 1 ? { ...hop, sourceBaseSha: sha("b") } : hop),
  } }).blockers.join(" "), /lineage/i);
  assert.equal(auditNewStory({ ...next, lineage: {
    ...next.lineage!, terminalJobId: "other-job",
  } }).status, "blocked");
  assert.equal(auditNewStory({ ...next, lineage: {
    ...next.lineage!, hops: next.lineage!.hops.map((hop, i) =>
      i === 0 ? { ...hop, verified: false as true } : hop),
  } }).status, "blocked");
  assert.equal(auditNewStory({ ...next, quality: { ...original.quality!, headSha: sha("b") } }).status,
    "blocked", "External quality must still evaluate the terminal HEAD");
});

test("independence is checked against original sources, not only continuation baselines", () => {
  const a = evidence("autonomous", "a");
  const b = evidence("collaborative", "b");
  // Even distinct terminal SHA and Job IDs cannot certify the same original Story twice.
  const duplicate = {
    ...b, lineage: { originalJobId: a.report.identity.jobId,
      originalSourceSha: a.report.identity.baseSha,
      terminalJobId: b.report.identity.jobId,
      hops: [{ sourceJobId: a.report.identity.jobId, childJobId: b.report.identity.jobId,
        sourceBaseSha: a.report.identity.baseSha, checkpointSha: b.report.identity.baseSha,
        proofDigest: digest("3") as string, verified: true as const }],
    },
  };
  assert.equal(auditNewStoryMatrix([a, duplicate]).status, "blocked");
  assert.match(auditNewStoryMatrix([a, duplicate]).blockers.join(" "), /reuse/i);
});

test("false, stale or unsupported external quality and Chat assertions block release acceptance", () => {
  const source = evidence("autonomous", "a");
  assert.equal(auditNewStory({ ...source, quality: null }).status, "blocked");
  assert.equal(
    auditNewStory({ ...source, quality: { ...source.quality!, headSha: sha("f") } }).status,
    "blocked",
  );
  assert.equal(
    auditNewStory({
      ...source,
      quality: {
        ...source.quality!,
        findings: source.quality!.findings.map((finding, index) =>
          index === 0 ? { ...finding, verdict: "fail" as const } : finding,
        ),
      },
    }).status,
    "blocked",
  );
  assert.equal(
    auditNewStory({
      ...source,
      quality: {
        ...source.quality!,
        findings: source.quality!.findings.map((finding) => ({
          ...finding,
          evidence: ["authored-content/missing.md:70"],
        })),
      },
    }).status,
    "blocked",
  );
  assert.equal(
    auditNewStory({ ...source, studio: { ...source.studio, exactApproval: false } }).status,
    "blocked",
  );
  assert.equal(auditNewStory({ ...source, studio: null }).status, "blocked");
});
