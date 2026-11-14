import assert from "node:assert/strict";
import { test } from "node:test";
import { architectureSpecialistPrompt } from "../src/architecture-specialist.js";
import { eventSpecialistPrompt, type EventAssignment } from "../src/event-specialist.js";
import { interactiveSpecialistPrompt, type InteractiveAssignment } from "../src/interactive-specialist.js";
import {
  assignmentFidelityPrompt,
  narrativeRepairPrompt,
  type ReviewAssignment,
} from "../src/narrative-review-specialist.js";
import { boundedPinnedSources, pinnedSourcePaths } from "../src/bounded-specialist-prompt.js";
import type { CompletionContract, Plan } from "../src/architecture.js";
import type { SemanticReviewPacket } from "../src/semantic-assignment-review.js";
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
  assert.match(rendered.Architecture, /fulfillment: \{any_of: \[\]\}/);
  assert.doesNotMatch(rendered.Architecture, /AUTHOR actual Event/);
  assert.match(rendered.Event, /selected milestones\/\*\.md may change ONLY/);
  assert.match(rendered.Event, /make NO edits/);
  assert.match(rendered.Event, /partial Milestone/);
  assert.match(rendered.Event, /may establish evidence without a pre-existing Fact or earlier Event/);
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

test("each actual pinned-read list retains portable method, representation, progression and authority", () => {
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
