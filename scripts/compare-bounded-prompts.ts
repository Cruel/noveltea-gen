/** Compare the actual pre-#165 prompt expressions with the production builders.
 * Both sides use the SAME synthetic source-bound assignment and snapshot.
 * Historic expressions are read from the immutable starting commit; this
 * script never invokes a model or modifies the working tree.
 *
 * pnpm exec tsx scripts/compare-bounded-prompts.ts [baseline-ref]
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { EVENT_CAUSAL_GROUNDING } from "../src/event-causal-grounding.js";
import { architectureSpecialistPrompt } from "../src/architecture-specialist.js";
import { eventSpecialistPrompt } from "../src/event-specialist.js";
import { interactiveSpecialistPrompt } from "../src/interactive-specialist.js";
import { assignmentFidelityPrompt, narrativeRepairPrompt } from "../src/narrative-review-specialist.js";
import { boundedPinnedSources } from "../src/bounded-specialist-prompt.js";
import { pinnedSkillReferences, type SkillSnapshot } from "../src/snapshot.js";
import type { Plan, CompletionContract } from "../src/architecture.js";
import type { InteractiveAssignment } from "../src/interactive-specialist.js";
import type { EventAssignment } from "../src/event-specialist.js";
import type { ReviewAssignment } from "../src/narrative-review-specialist.js";
import type { SemanticReviewPacket } from "../src/semantic-assignment-review.js";

const baseline = process.argv[2] ?? "0adf3ba";
const snapshot: SkillSnapshot = {
  id: "b".repeat(64),
  digest: "b".repeat(64),
  path: "/fixture/pinned",
  commit: "a".repeat(40),
  branch: "main",
  detached: false,
  dirty: false,
};
const contract: CompletionContract = {
  scope: {
    kind: "partial",
    depth: "interactive",
    targets: ["milestone.disclosure"],
    branches: ["protect", "challenge"],
  },
  constraints: ["Preserve the protected choice"],
  envelope: {
    presentation: "Dialogue-led mystery",
    hardLimits: [],
    preferences: [],
  },
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
      authorization: { source: "trusted-controller", planVersion: 1, paths: paths.slice(0, 3) },
      planVersion: 1,
      status: "pending",
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
const choice: InteractiveAssignment = {
  milestoneId: event.milestoneId,
  workItemId: "interactive-choice-disclosure",
  arcIds: event.arcIds,
  characterIds: event.characterIds,
  factIds: ["fact.ledger"],
  eventIds: ["event.disclose-ledger"],
  eventSource: {
    headSha: "a".repeat(40),
    snapshotId: snapshot.id,
    eventIds: ["event.disclose-ledger"],
    milestoneState: "partial-choice-pending",
    missingObligations: ["Bind both outcomes"],
  },
  sourcePaths: paths,
  authorContract: contract,
  protectedRouteGates: "immutable-existing-event-prerequisites",
  authorizedPaths: ["events/", "choice-points/", "authored-content/"],
  downstreamRequirements: ["Puzzle and composition"],
};
const assignment: ReviewAssignment = {
  contract,
  planVersion: 1,
  scopeIds: contract.scope.targets,
  paths,
  routes: [],
  milestoneRoutes: [],
  puzzleRoutes: [],
  outstanding: [],
  uncertainties: [],
};
const findings = [
  {
    severity: "blocking" as const,
    dimension: "conditional-knowledge" as const,
    source: "authored-content/disclosure.md:12",
    message: "Common prose uses unseen fact",
    repair: "composition" as const,
  },
];
const allowed = ["authored-content/disclosure.md"];
const packet = {
  policy: "assignment-fidelity/v1",
  sourceDigest: "f".repeat(64),
  items: [
    {
      reviewedWorkItem: "event-disclosure",
      unitOutcome: "Event setup committed; decision milestone awaits formal Choice binding.",
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
const oldSources = new Map<string, ts.SourceFile>();
function source(file: string) {
  if (!oldSources.has(file)) {
    const body = execFileSync("git", ["show", baseline + ":src/" + file + ".ts"], {
      encoding: "utf8",
    });
    oldSources.set(file, ts.createSourceFile(file + ".ts", body, ts.ScriptTarget.Latest, true));
  }
  return oldSources.get(file)!;
}
function findExpression(file: string, kind: "prompt" | "architecture" | "review" | "repair" | "specialists") {
  const sf = source(file);
  const matches: ts.Expression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const label = node.name.getText(sf);
      if (
        ((kind === "prompt" || kind === "repair") && label === "prompt") ||
        (kind === "specialists" && label === "SPECIALISTS")
      )
        matches.push(node.initializer);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "promptStorySpecialist" &&
      node.arguments.length === 2
    ) {
      const expr = node.arguments[1]!;
      if (
        (kind === "architecture" &&
          expr.getText(sf).includes("You are the NovelTea Story architecture specialist")) ||
        (kind === "review" &&
          expr.getText(sf).includes("independent, read-only assignment-fidelity reviewer"))
      )
        matches.push(expr);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (kind === "prompt" && matches.length > 1) matches.length = 1;
  if (kind === "repair" && matches.length > 1) matches.splice(0, matches.length - 1);
  if (matches.length !== 1)
    throw Error("Cannot find unique historic " + file + "/" + kind + ": found " + matches.length);
  return matches[0]!.getText(sf);
}
function evaluate(expr: string, ctx: Record<string, unknown>): string {
  const code = ts.transpileModule("var __rendered = (" + expr + ");", {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None,
    },
  }).outputText;
  return vm.runInNewContext(code + "\n__rendered;", ctx) as string;
}
const oldInteractive = evaluate(findExpression("interactive-specialist", "specialists"), {});
const asPinned = (names: string[]) => names.map((n) => join(snapshot.path, "skills", n));
const mandatory = (method: string) => [...boundedPinnedSources(method), "nt-catalog/references/glossary.md"];
const pinnedOld = (method: string) => asPinned(mandatory(method));
const vars = {
  snapshot,
  required: pinnedOld("nt-event-design"),
  sandboxTools: true,
  pinnedSkillReferences,
  specialistAuthorInstruction: () => "",
  EVENT_CAUSAL_GROUNDING,
  context: { contextNote: "" },
  plan,
  authorTask: undefined,
  assignment: event,
  findings,
  paths: allowed,
  packet,
  REQUIRED: mandatory("nt-story-architecture"),
};
const compare = [
  {
    label: "Architecture",
    file: "architecture-specialist",
    kind: "architecture" as const,
    ctx: vars,
    after: architectureSpecialistPrompt(snapshot, plan, true),
  },
  {
    label: "Event",
    file: "event-specialist",
    kind: "prompt" as const,
    ctx: vars,
    after: eventSpecialistPrompt(snapshot, event, true),
  },
  {
    label: "Choice",
    file: "interactive-specialist",
    kind: "prompt" as const,
    ctx: {
      ...vars,
      assignment: choice,
      selected: oldInteractive.choice,
      domain: "choice",
      pinned: pinnedOld("nt-interactive-narrative"),
    },
    after: interactiveSpecialistPrompt(snapshot, "choice", choice, true),
  },
  {
    label: "Targeted repair",
    file: "narrative-review-specialist",
    kind: "repair" as const,
    ctx: { ...vars, assignment, pinned: pinnedOld("nt-narrative-composition") },
    after: narrativeRepairPrompt(snapshot, assignment, findings, allowed),
  },
  {
    label: "Assignment reviewer",
    file: "narrative-review-specialist",
    kind: "review" as const,
    ctx: { ...vars, pinned: pinnedOld("nt-narrative-review") },
    after: assignmentFidelityPrompt(snapshot, packet),
  },
];
const words = (s: string) => s.trim().split(/\s+/).length;
console.log(
  "Same synthetic source fixture; baseline " +
    baseline +
    ". Token column estimates characters/4; not tokenizer measurements.",
);
for (const c of compare) {
  const before = evaluate(findExpression(c.file, c.kind), c.ctx);
  console.log(
    c.label +
      ": before " +
      words(before) +
      " words/" +
      before.length +
      " chars/~" +
      Math.ceil(before.length / 4) +
      " tokens; after " +
      words(c.after) +
      " words/" +
      c.after.length +
      " chars/~" +
      Math.ceil(c.after.length / 4) +
      " tokens",
  );
}
const checkout = process.env.NT_SKILLS_CHECKOUT ?? join(process.env.HOME!, "dev/noveltea-skills");
for (const method of [
  "nt-story-architecture",
  "nt-event-design",
  "nt-interactive-narrative",
  "nt-narrative-composition",
  "nt-narrative-review",
]) {
  const size = (refs: string[]) =>
    refs.reduce(
      (acc, p) => {
        const content = readFileSync(join(checkout, "skills", p), "utf8");
        return { words: acc.words + words(content), chars: acc.chars + content.length };
      },
      { words: 0, chars: 0 },
    );
  console.log(
    method +
      " pinned reads old " +
      JSON.stringify(size(mandatory(method))) +
      " new " +
      JSON.stringify(size(boundedPinnedSources(method))) +
      " (full installed skill source, not selected passages)",
  );
}
