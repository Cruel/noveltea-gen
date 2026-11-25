/** C08 certification crosswalk: keep the actual production graph, its ten
 * specialist dispatch stages, all typed recovery decisions, and source-backed
 * regression anchors aligned. This complements (never replaces) the C01
 * source-exit fingerprint and conditional-edge inventory. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { generationStages, type GenerationStage } from "../src/generation-plan.js";
import { nodeFailureSource, operationChecks, type Operation } from
  "../src/generation-operation-recovery.js";
import type { RecoveryDecision, RecoveryLifecycle } from "../src/generation-recovery-contract.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = (relative: string) => readFileSync(resolve(root, relative), "utf8");

/** The source owner of every stage must remain the original specialist
 * adapter. An unknown new stage is a missing certification, not a default. */
const stageAdapters = {
  foundation: "runFoundationJob",
  architecture: "runArchitectureJob",
  foundations: "runCharacterWorldJob",
  event: "runEventWorkItem",
  interactive: "runInteractiveWorkItem",
  choice: "runInteractiveWorkItem",
  puzzle: "runInteractiveWorkItem",
  composition: "runCompositionWorkItem",
  focus: "runFocusedWorkItem",
  review: "runNarrativeReview",
} as const satisfies Record<GenerationStage, string>;

const dedicatedChildren = {
  foundation: "runFoundationAssignmentChild",
  architecture: "runArchitectureAssignmentChild",
} as const;

/** Original-operation assessment and authentic regression anchor for each
 * current graph node. C01 additionally fingerprints every return and throw. */
// A parameterized production regression is anchored both to its test name
// and to the exact registered scenario. A generic passing test in the same
// file is not a replacement for a removed recovery boundary.
type Regression = readonly [file: string, name: string, variant?: string];
const generation = (name: string, variant?: string): Regression =>
  ["test/generation.test.ts", name, variant];
const foundationRound = (variant: string) => generation(
  "R01 production Foundation enters checkpointed child before scripted Pi; native Git and independent Review remain authoritative", variant);
const eventRound = (variant: string) => generation(
  "R14D Event native correction and negative Review recover in the original SQLite assignment", variant);
const ideaRound = (variant: string) => generation(
  "C08 parent Idea dispatch and verification authenticate the original task", variant);
function assertRegression([file, name, variant]: Regression, boundary: string) {
  const content = source(file);
  assert.ok(content.includes(name), boundary + ": " + file + " lost its regression: " + name);
  if (variant) assert.ok(content.includes(JSON.stringify(variant)),
    boundary + ": " + file + " lost its registered scenario: " + variant);
}

const nodeChecks = {
  schedule: ["scheduling", generation("C05 unfamiliar scheduling failure is resolved by source-bound recheck")],
  assess_recovery: [null, eventRound("diagnosis")],
  author_update_intake: ["author-update-intake", generation("production start assesses thrown author-update intake")],
  idea_integration: ["idea-integration", ideaRound("foreign-dispatch")],
  verify_idea_integration: ["idea-verification", ideaRound("unverified-result")],
  specialist_dispatch: ["specialist-dispatch", foundationRound("protocol-exhausted")],
  dependency_amendment: ["dependency-amendment", generation("#225 failed dependency amendment is assessed")],
  independent_assignment_review: ["independent-review", foundationRound("review-native")],
  verify_committed_work: ["commit-verification", ["test/focused-generation.test.ts", "R07 focused commit before checkpoint finalization resumes without replay"]],
  completion_decision: ["completion-verification", generation("#225 untrusted completion preflight is assessed")],
} as const satisfies Record<string, readonly [Operation | null, Regression]>;

/** Decisions and lifecycle states must remain tied to their actual
 * production boundary, even when the legacy structural fixture is removed. */
const actionChecks = {
  "known-correction": foundationRound("review-native"),
  "plan-amendment": generation("C04 real Pi World negative selects source-bound owner strategy"),
  "diagnostic": eventRound("diagnosis"),
  "diagnostic-stop": foundationRound("review-native-stall"),
  "reconcile-effects": generation("C05 unfamiliar scheduling failure is resolved by source-bound recheck"),
  "continue-independent": ideaRound("deferred"),
  "pause": foundationRound("author-pause"),
  "exhausted": foundationRound("review-native-protocol"),
  "integrity-fence": generation("C02 current-format checkpoint tampering cannot grant a new recovery"),
} as const satisfies Record<RecoveryDecision["action"], Regression>;

const phaseChecks = {
  idle: ["test/generation-recovery-graph.test.ts", "C02 a settled original failure cannot be re-admitted"],
  assessing: ["test/generation-recovery-graph.test.ts", "C02 production bridge has only one phase"],
  reconciling: generation("C05 unfamiliar scheduling failure is resolved by source-bound recheck"),
  diagnosing: ["test/generation-recovery-lifecycle.test.ts", "C02 no model attempt is inferred"],
  correcting: foundationRound("review-native"),
  verifying: ["test/generation-recovery-graph.test.ts", "C02 original source with authenticated reconciliation enters verifying"],
  paused: foundationRound("author-pause"),
  fenced: ["test/generation-recovery-graph.test.ts", "C02 failed re-verification fences"],
  resolved: ["test/generation-recovery-lifecycle.test.ts", "C07 verified correction persists original identity"],
} as const satisfies Record<RecoveryLifecycle["phase"], Regression>;

function dispatchCases(): Record<string, string> {
  const file = ts.createSourceFile("generation.ts", source("src/generation.ts"),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: Record<string, string> = {};
  const functions = new Map<string, ts.FunctionDeclaration>();
  let dispatchNode: ts.Node | undefined;
  function collect(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "addNode" &&
        ts.isStringLiteral(node.arguments[0]!) && node.arguments[0].text === "specialist_dispatch")
      dispatchNode = node.arguments[1];
    ts.forEachChild(node, collect);
  }
  collect(file);
  assert.ok(dispatchNode, "Missing parent specialist dispatch node");
  const parentDispatch = dispatchNode.getText(file);
  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "dispatch") {
      const findSwitch = (child: ts.Node): void => {
        if (ts.isSwitchStatement(child) && child.expression.getText(file) === "s.active?.stage") {
          let pending: string[] = [];
          for (const clause of child.caseBlock.clauses) {
            if (ts.isDefaultClause(clause)) {
              assert.match(clause.getText(file), /throw new Error\("Invalid generation stage\."\)/,
                "Unknown stage must always fail closed");
              continue;
            }
            if (!ts.isCaseClause(clause) || !ts.isStringLiteral(clause.expression))
              throw Error("Dispatch gained an uncertified conditional case");
            pending.push(clause.expression.text);
            if (!clause.statements.length) continue;
            const body = clause.statements.map(statement => statement.getText(file)).join(" ");
            let handler = /\breturn\s+(run[A-Za-z]+Job|run[A-Za-z]+WorkItem|runNarrativeReview)\s*\(/.exec(body)?.[1];
            if (pending.length === 1 && Object.hasOwn(dedicatedChildren, pending[0]!)) {
              const stage = pending[0] as keyof typeof dedicatedChildren;
              const child = dedicatedChildren[stage];
              assert.match(body, /throw Error\(.*checkpointed assignment child.*\)/,
                stage + " must refuse the retired direct dispatcher");
              assert.match(parentDispatch, new RegExp('if \\(s\\.active\\?\\.stage === "' +
                stage + '".*\\)[\\s\\S]*?return await ' + child + '\\(s, config, reviewBoundary\\)'),
                stage + " must enter its checkpointed child from the parent");
              const declaration = functions.get(child);
              assert.ok(declaration, "Missing original child " + child);
              const childSource = declaration.getText(file);
              const original = stageAdapters[stage];
              assert.match(childSource, new RegExp('\\bawait ' + original + '\\('),
                child + " must invoke the original specialist");
              assert.match(childSource, /createAssignmentLifecycleGraph\(/);
              assert.match(childSource, /round: \{ assignmentKey:/);
              handler = original;
            }
            assert.ok(handler, `Stage group ${pending.join(",")} no longer invokes its certified adapter`);
            for (const stage of pending) {
              assert.equal(found[stage], undefined, "Duplicate dispatch stage");
              found[stage] = handler;
            }
            pending = [];
          }
          assert.equal(pending.length, 0, "Unimplemented dispatch stage");
        }
        ts.forEachChild(child, findSwitch);
      };
      if (node.body) ts.forEachChild(node.body, findSwitch);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return found;
}

test("C08 every actual stage dispatch remains on its original source-bound specialist", () => {
  assert.deepEqual(Object.keys(stageAdapters).sort(), [...generationStages].sort());
  assert.deepEqual(dispatchCases(), stageAdapters);
});

test("C08 each real graph node retains a source-linked failure/Review check and production regression", () => {
  const graph = source("src/generation.ts");
  const declared = [...graph.matchAll(/\.addNode\("([^"]+)",\s*recoveryNode\("\1"/g)]
    .map(match => match[1]!);
  assert.deepEqual(declared.sort(), Object.keys(nodeChecks).sort(),
    "New graph nodes need typed C08 evidence, proof and regression before release");
  for (const [node, [operation, regression]] of Object.entries(nodeChecks)) {
    assert.deepEqual(node === "assess_recovery" ? null : nodeFailureSource[
      node as keyof typeof nodeFailureSource]?.[0], operation,
      `${node}: original failed-check owner changed`);
    if (operation) assert.ok(operationChecks[operation], `${node}: missing versioned failed check`);
    assertRegression(regression, node);
  }
});

test("C08 retired diagnostic prose cannot regain recovery or causal-invalidation authority", () => {
  assert.doesNotMatch(source("src/generation.ts"),
    /(?:error\.message|reason)\.(?:includes|startsWith|endsWith|match)\s*\(/,
    "Graph recovery must use typed source and decision evidence, never exception wording");
  assert.doesNotMatch(source("src/generation-plan.ts"),
    /blockingReason\??\.(?:includes|startsWith|endsWith|match)\s*\(/,
    "Dependency revalidation must use typed invalidation, not display text");
});

test("C08 every decision and lifecycle phase has a maintained certification anchor", () => {
  const actionNames = Object.keys(actionChecks).sort();
  assert.deepEqual(actionNames, [
    "known-correction", "plan-amendment", "diagnostic", "diagnostic-stop",
    "reconcile-effects", "continue-independent", "pause", "exhausted", "integrity-fence",
  ].sort());
  for (const [action, regression] of Object.entries(actionChecks))
    assertRegression(regression, action);
  for (const [phase, regression] of Object.entries(phaseChecks))
    assertRegression(regression, phase);
});
