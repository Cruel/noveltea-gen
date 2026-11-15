import assert from "node:assert/strict";
import { test } from "node:test";
import {
  architectureSpecialistPrompt,
  emptyArchitectureCorrectionPrompt,
  canCorrectEmptyArchitecture,
} from "../src/architecture-specialist.js";
import {
  eventSpecialistPrompt,
  eventQuestionCorrectionFeedback,
  type EventAssignment,
} from "../src/event-specialist.js";
import { parseSpecialistChoice } from "../src/specialist-choice.js";
import { CRITICAL_CAST_GUIDANCE } from "../src/character-world-specialist.js";
import { interactiveSpecialistPrompt, type InteractiveAssignment } from "../src/interactive-specialist.js";
import {
  assignmentFidelityPrompt,
  narrativeRepairPrompt,
  type ReviewAssignment,
} from "../src/narrative-review-specialist.js";
import { boundedPinnedSources, pinnedSourcePaths } from "../src/bounded-specialist-prompt.js";
import { reviewerPinnedSkillPath } from "../src/skills.js";
import type { CompletionContract, Plan } from "../src/architecture.js";
import { semanticUnitOutcome, type SemanticReviewPacket } from "../src/semantic-assignment-review.js";
import type { SkillSnapshot } from "../src/snapshot.js";

const snapshot: SkillSnapshot = {
  id: "b".repeat(64),
  digest: "b".repeat(64),
  path: "/immutable/skills-snapshot",
  commit: "a".repeat(40),
  branch: "main",
  dirty: false,
  detached: false,
};
const contract: CompletionContract = {
  scope: {
    kind: "partial",
    depth: "interactive",
    targets: ["milestone.disclosure"],
    branches: ["protect", "challenge"],
  },
  constraints: ["Do not disclose an unobserved witness statement"],
  envelope: { presentation: "Dialogue-led mystery", hardLimits: [], preferences: [] },
};
const paths = [
  "creative-direction/foundation.md",
  "arcs/ledger.md",
  "milestones/disclosure.md",
  "events/disclose-ledger.md",
];
const plan: Plan = {
  version: 1,
  contract,
  items: [
    {
      id: "global-architecture",
      kind: "architecture",
      targetIds: ["milestone.disclosure"],
      dependencies: [],
      skills: ["nt-story-architecture"],
      checks: [],
      status: "pending",
      authorization: { source: "trusted-controller", planVersion: 1, paths: paths.slice(0, 3) },
      planVersion: 1,
    },
  ],
};
const event: EventAssignment = {
  milestoneId: "milestone.disclosure",
  milestonePath: "milestones/disclosure.md",
  arcIds: ["arc.ledger"],
  characterIds: ["character.ada"],
  sourcePaths: paths,
  contract,
  workItemId: "event-disclosure",
  authority: {
    existingProtectedChoices: "no-retcon",
    delegatedChoices: "draft",
    signingRequiredForProtectedChanges: true,
  },
};
const interactive: InteractiveAssignment = {
  workItemId: "interactive-choice-disclosure",
  milestoneId: "milestone.disclosure",
  arcIds: ["arc.ledger"],
  characterIds: ["character.ada"],
  factIds: ["fact.ledger"],
  eventIds: ["event.disclose-ledger"],
  eventSource: {
    headSha: "a".repeat(40),
    snapshotId: snapshot.id,
    eventIds: ["event.disclose-ledger"],
    milestoneState: "partial-choice-pending",
    missingObligations: ["Bind protect/challenge outcomes"],
  },
  sourcePaths: paths,
  authorContract: contract,
  protectedRouteGates: "immutable-existing-event-prerequisites",
  authorizedPaths: ["events/", "choice-points/", "authored-content/"],
  downstreamRequirements: ["Puzzle follows Choice"],
};
const review: ReviewAssignment = {
  contract,
  planVersion: 1,
  scopeIds: ["milestone.disclosure"],
  paths,
  routes: [],
  milestoneRoutes: [],
  puzzleRoutes: [],
  outstanding: [],
  uncertainties: [],
};
const packet = {
  policy: "assignment-fidelity/v1",
  sourceDigest: "f".repeat(64),
  items: [
    {
      reviewedWorkItem: "event-disclosure",
      unitOutcome: "Event setup committed; decision-dependent Milestone remains partial pending Choice.",
      assignment: {
        id: "a1",
        outcome: "Author source-bound Event setup",
        authority: { recordTypes: ["event"], existingPaths: ["milestones/disclosure.md"] },
      },
      assurance: { changedPaths: ["events/disclose-ledger.md"], commitSha: "d".repeat(40) },
      diff: "diff --git a/events/disclose-ledger.md b/events/disclose-ledger.md",
      canonicalContext: [
        {
          path: "events/disclose-ledger.md",
          content: "The player observes an unexplained ledger entry.",
          blobSha: "e".repeat(40),
        },
      ],
      readOnlyPaths: ["milestones/disclosure.md"],
      repairTargets: ["events/disclose-ledger.md"],
    },
  ],
} as unknown as SemanticReviewPacket;

const rendered = {
  Architecture: architectureSpecialistPrompt(snapshot, plan, true),
  Event: eventSpecialistPrompt(snapshot, event, true),
  Choice: interactiveSpecialistPrompt(snapshot, "choice", interactive, true),
  Puzzle: interactiveSpecialistPrompt(snapshot, "puzzle", interactive, true),
  "Targeted repair": narrativeRepairPrompt(
    snapshot,
    review,
    [
      {
        severity: "blocking",
        dimension: "conditional-knowledge",
        source: "authored-content/disclosure.md:12",
        message: "Unseen fact in common prose",
        repair: "composition",
      },
    ],
    ["authored-content/disclosure.md"],
  ),
  "Assignment reviewer": assignmentFidelityPrompt(snapshot, packet),
};
const headings = [
  "CURRENT GOAL",
  "PINNED SOURCES",
  "WRITABLE SCOPE",
  "DONE WHEN",
  "LATER OBLIGATIONS",
  "REQUIRED OUTPUT",
];

test("optional Puzzle has a single no-write manifest example and mandatory Puzzle stays binding", () => {
  const optional = interactiveSpecialistPrompt(
    snapshot,
    "puzzle",
    {
      ...interactive,
      puzzleObligation: { required: false, reasons: [] },
    },
    true,
  );
  const required = interactiveSpecialistPrompt(
    snapshot,
    "puzzle",
    {
      ...interactive,
      puzzleObligation: { required: true, reasons: ["Explicit source-bound Puzzle objective"] },
    },
    true,
  );
  assert.match(optional, /An empty architecturalConflicts array is INVALID/);
  assert.match(optional, /"modifiedRecords":\[\],"architecturalConflicts":\["No justified Puzzle objective/);
  assert.doesNotMatch(optional, /"modifiedRecords":\["events\/example.md"\]/);
  assert.match(required, /approved Story requires a formal Puzzle/);
  assert.match(required, /two separately reachable solving Events/);
  assert.doesNotMatch(required, /An empty architecturalConflicts array is INVALID/);
});

test("actual production prompt builders give a single current work item before references", () => {
  for (const [role, prompt] of Object.entries(rendered)) {
    let last = -1;
    for (const heading of headings) {
      const positions = [...prompt.matchAll(new RegExp("^" + heading + "$", "gm"))];
      assert.equal(positions.length, 1, role + " must include one " + heading);
      assert.ok(positions[0]!.index! > last, role + " task-first section order");
      last = positions[0]!.index!;
    }
    assert.ok(prompt.startsWith("CURRENT GOAL\n"), role);
    assert.match(prompt, /skill:\/\//, role);
    assert.doesNotMatch(
      prompt,
      /skill:\/\/nt-catalog\/references\/glossary\.md\n/,
      role + " should not force optional terminology reference",
    );
    assert.doesNotMatch(
      prompt,
      /\/immutable\/skills-snapshot\/skills\//,
      role + " must never show snapshot hash directories",
    );
    assert.ok(prompt.indexOf("CURRENT GOAL") < prompt.indexOf("PINNED SOURCES"), role);
  }
});

test("same scoped fixture has no conflicting write grants or future-owner obligations", () => {
  assert.match(rendered.Architecture, /Only authorized arcs\/\*\.md and milestones\/\*\.md/);
  assert.match(rendered.Architecture, /Arcs and Milestones do NOT yet exist/);
  assert.match(rendered.Architecture, /CREATE the first Arc and Milestones/);
  assert.match(rendered.Architecture, /story_validate TOOL is provided directly/);
  assert.match(rendered.Architecture, /fulfillment: \{any_of: \[\]\}/);
  assert.doesNotMatch(rendered.Architecture, /AUTHOR actual Event/);
  assert.match(rendered.Event, /selected milestones\/\*\.md may change ONLY/);
  assert.match(rendered.Event, /make NO edits/);
  assert.match(rendered.Event, /partial Milestone/);
  assert.match(rendered.Event, /may establish evidence without a pre-existing Fact or earlier Event/);
  assert.match(rendered.Event, /An empty events\/ directory is a normal first/);
  assert.match(rendered.Event, /YOU own authoring its discovery scene/);
  assert.match(rendered.Event, /author the discovery and Character access NOW/);
  assert.match(rendered.Event, /MUST use field kind, never type/);
  assert.match(rendered.Event, /compare EACH material clause/);
  assert.match(rendered.Event, /completeness and empty fulfillment\.any_of/);
  assert.match(CRITICAL_CAST_GUIDANCE, /absent victim, missing witness, or inspector/);
  assert.match(CRITICAL_CAST_GUIDANCE, /without inventing a culprit/);
  assert.match(CRITICAL_CAST_GUIDANCE, /two other leads cover it/);
  assert.match(rendered.Event, /Do not request author permission for a discovery Event already/);
  assert.match(rendered.Event, /Missing Choice, Puzzle,.*$/m);
  assert.match(rendered.Event, /NOT blockers for this Event setup/);
  assert.match(rendered.Choice, /Never edit milestones\//);
  assert.match(rendered.Choice, /Preserve the original Event entry gate verbatim/);
  assert.match(rendered.Choice, /Do not create a Puzzle in this unit/);
  assert.match(rendered.Puzzle, /pre-solution Authored Content/);
  assert.match(rendered.Puzzle, /Do not modify original Choice outcomes/);
  assert.match(rendered["Targeted repair"], /Edit ONLY the existing Authored Content paths/);
  assert.match(rendered["Targeted repair"], /no new files/);
  assert.match(rendered["Assignment reviewer"], /NONE\. This is a read-only reviewer/);
  assert.match(rendered["Assignment reviewer"], /final playable Story obligations remain/);
  assert.match(rendered["Assignment reviewer"], /sourceDigest \(copy EXACTLY/);
  assert.ok(rendered.Event.includes(paths[3]!));
  assert.ok(rendered.Choice.includes(interactive.eventSource!.headSha));
  assert.ok(rendered["Assignment reviewer"].includes(packet.sourceDigest));
});

test("investigation architecture specifies a testable independent evidence comparison without inventing Events", () => {
  assert.match(rendered.Architecture, /independent observation/);
  assert.match(rendered.Architecture, /what that observation can and cannot establish/);
  assert.match(rendered.Architecture, /without inventing Event IDs/);
});

test("Event author keeps central speakers in typed Character participants and tests actual evidence", () => {
  assert.match(rendered.Event, /named speaking witness or central actor/);
  assert.match(rendered.Event, /existing canonical Character/);
  assert.match(rendered.Event, /typed participants/);
  assert.match(rendered.Event, /before any edits/);
  assert.match(rendered.Event, /independent observation/);
  assert.match(rendered.Event, /cannot establish the disputed timing/);
});

test("empty-Story Architecture correction never replays a writer with attempted edits or dirty sources", () => {
  assert.equal(canCorrectEmptyArchitecture(false, false), true);
  assert.equal(canCorrectEmptyArchitecture(true, false), false);
  assert.equal(canCorrectEmptyArchitecture(false, true), false);
  assert.equal(canCorrectEmptyArchitecture(true, true), false);
  const correction = emptyArchitectureCorrectionPrompt();
  assert.match(correction, /No Arcs or Milestones exist/);
  assert.match(correction, /SAME original Pi session/);
  assert.match(correction, /story_validate tool is directly available/);
  assert.match(correction, /no new write grant/i);
  assert.match(correction, /CAUSAL_MILESTONE_ORDER/);
  assert.doesNotMatch(correction, /edit protected choices/);
});

test("malformed first-Event author request receives one non-granting correction in the same session", () => {
  const recorded = {
    type: "free-text",
    question: "Should another worker create the missing death-discovery Event first?",
  };
  assert.throws(() => parseSpecialistChoice(recorded), /Invalid bounded author question/);
  const corrected = eventQuestionCorrectionFeedback(new Error("Invalid bounded author question."));
  assert.match(corrected, /An empty events\/ directory is normal/);
  assert.match(corrected, /YOU are the Event writer authorized to create/);
  assert.match(corrected, /Character knowledge effects/);
  assert.match(corrected, /kind \(never type\)/);
  assert.match(corrected, /SAME Pi session, not a writer replay or new authority/);
  assert.doesNotMatch(corrected, /permission to edit protected records/);
  assert.equal(
    parseSpecialistChoice({ kind: "free-text", question: recorded.question }).kind,
    "free-text",
    "A genuinely needed author question remains available after syntax correction",
  );
});

test("Choice writer and independent review trace source-linked typed payoff continuity", () => {
  assert.match(rendered.Choice, /the immediate typed outcome AND consequential state effects/);
  assert.match(rendered.Choice, /estranged/);
  assert.match(rendered.Choice, /without a visible reconciliation/);
  assert.doesNotMatch(rendered.Puzzle, /UNJUSTIFIED reversal/);
  assert.doesNotMatch(rendered["Assignment reviewer"], /an estranged-to-wary transition/);
  const choicePacket = {
    ...packet,
    items: [
      {
        ...packet.items[0]!,
        reviewedWorkItem: "interactive-choice-disclosure",
        unitOutcome: semanticUnitOutcome("interactive-choice-disclosure"),
      },
    ],
  };
  const reviewer = assignmentFidelityPrompt(snapshot, choicePacket);
  assert.match(reviewer, /an estranged-to-wary transition/);
  assert.match(reviewer, /Exactly ONE enabled branch executes/);
  assert.match(reviewer, /Do NOT require mutually exclusive condition guards/);
  assert.match(reviewer, /skill:\/\/nt-catalog\/references\/progression\.md/);
  assert.match(reviewer, /EXACT offending changed path and source line/);
  assert.match(reviewer, /read-only predecessor path/);
  assert.match(reviewer, /NONE\. This is a read-only reviewer/);
});

test("Puzzle writer and reviewer require equivalent objective evidence for every listed solution", () => {
  assert.match(rendered.Puzzle, /Each listed solution must independently answer that SAME objective/);
  assert.match(rendered.Puzzle, /confirming a seal or chain of custody alone does NOT establish/);
  assert.match(rendered.Puzzle, /without breaking|required alternatives|author-approved objective/);
  assert.doesNotMatch(rendered.Choice, /confirming a seal or chain of custody alone/);
  const puzzlePacket = {
    ...packet,
    items: [
      {
        ...packet.items[0]!,
        reviewedWorkItem: "interactive-puzzle-disclosure",
        unitOutcome: semanticUnitOutcome("interactive-puzzle-disclosure"),
      },
    ],
  };
  const reviewer = assignmentFidelityPrompt(snapshot, puzzlePacket);
  assert.match(reviewer, /EVERY listed solution Event/);
  assert.match(reviewer, /weaker or different fact/);
  assert.match(reviewer, /NONE\. This is a read-only reviewer/);
  assert.doesNotMatch(rendered["Assignment reviewer"], /weaker or different fact/);
});

test("retrospective reviewers may read any canonical snapshot documentation, even after repair", () => {
  const variants = [
    packet,
    ...["global-architecture", "world-foundations", "character-foundations",
      "event-disclosure", "interactive-choice-disclosure", "interactive-puzzle-disclosure",
      "composition-disclosure", "repair-604e6190"].map(reviewedWorkItem =>
      ({ ...packet, items: packet.items.map(item => ({ ...item, reviewedWorkItem })) })),
  ];
  for (const item of variants) {
    const reviewer = assignmentFidelityPrompt(snapshot, item);
    assert.match(reviewer, /mandatory pinned review\/catalog references/);
    assert.match(reviewer, /other canonical craft, schema or review references/);
    assert.match(reviewer, /same verified skill:\/\/ snapshot/);
    assert.match(reviewer, /or while evaluating a repair/);
    assert.match(reviewer, /Do not read orchestrator instructions/);
    assert.match(reviewer, /COMPLETE sealed Git diff/);
    assert.match(reviewer, /NONE\. This is a read-only reviewer/);
    assert.doesNotMatch(reviewer, /you MAY also read these immutable pinned craft methods/);
  }

  const pinned = (name: string) => snapshot.path + "/skills/" + name;
  for (const path of [
    "nt-story-architecture/SKILL.md",
    "nt-worldbuilding/SKILL.md",
    "nt-character-development/references/craft.md",
    "nt-event-design/SKILL.md",
    "nt-interactive-narrative/SKILL.md",
    "nt-puzzle-design/SKILL.md",
    "nt-narrative-composition/SKILL.md",
    "nt-story-discovery/SKILL.md",
    "nt-narrative-review/SKILL.md",
    "nt-catalog/references/progression.md",
  ]) assert.equal(reviewerPinnedSkillPath(snapshot.path, pinned(path)), true, path);
  for (const path of [
    pinned("nt-story-orchestrate/SKILL.md"),
    pinned("nt-story-collaborate/SKILL.md"),
    pinned("nt-story-import/SKILL.md"),
    pinned("nt-catalog/../nt-story-orchestrate/SKILL.md"),
    snapshot.path + "/story/characters/person.md",
    "/story/characters/person.md",
    "/tmp/private.md",
    snapshot.path + "/skills",
  ]) assert.equal(reviewerPinnedSkillPath(snapshot.path, path), false, path);
});

test("each actual pinned-read list retains portable method, representation and authority", () => {
  for (const method of [
    "nt-story-architecture",
    "nt-event-design",
    "nt-interactive-narrative",
    "nt-puzzle-design",
    "nt-narrative-composition",
    "nt-narrative-review",
  ]) {
    const paths = boundedPinnedSources(method);
    assert.deepEqual(paths, [
      method + "/SKILL.md",
      "nt-catalog/SKILL.md",
      "nt-catalog/references/records.md",
      "nt-catalog/references/progression.md",
      "nt-catalog/references/authority-and-validation.md",
    ]);
    assert.equal(pinnedSourcePaths(snapshot, paths).length, 5);
  }
});

test("rendered instruction volume is measurable separately from immutable required skill text", (t) => {
  for (const [role, prompt] of Object.entries(rendered)) {
    const words = prompt.trim().split(/\s+/).length;
    assert.ok(words > 100);
    t.diagnostic(
      role +
        " actual prompt: " +
        words +
        " words, " +
        prompt.length +
        " characters, approx " +
        Math.ceil(prompt.length / 4) +
        " tokens at 4 characters/token (NOT model tokenizer)",
    );
  }
});
