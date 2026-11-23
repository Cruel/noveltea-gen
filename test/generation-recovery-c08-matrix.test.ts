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

/** Original-operation assessment and authentic regression anchor for each
 * current graph node. C01 additionally fingerprints every return and throw. */
const nodeChecks = {
  schedule: ["scheduling", "production resume assesses failed scheduling"],
  assess_recovery: [null, "C03 production graph diagnoses a source-authenticated unknown scheduling exception once"],
  author_update_intake: ["author-update-intake", "production start assesses thrown author-update intake"],
  idea_integration: ["idea-integration", "C02 production deferred idea later placement"],
  verify_idea_integration: ["idea-verification", "unknown original idea dispatch is fenced"],
  specialist_dispatch: ["specialist-dispatch", "#225 unaccepted specialist result reaches assessment"],
  dependency_amendment: ["dependency-amendment", "#225 failed dependency amendment is assessed"],
  independent_assignment_review: ["independent-review", "C04 Review strategy demands the original sealed failed Pi cycle"],
  verify_committed_work: ["commit-verification", "parent restart reconciles a specialist commit"],
  completion_decision: ["completion-verification", "#225 untrusted completion preflight is assessed"],
} as const satisfies Record<string, readonly [Operation | null, string]>;

/** Actions are typed from the normative RecoveryDecision union; each must
 * have an original-controller regression, not only a mocked future graph. */
const actionChecks = {
  "known-correction": ["test/generation.test.ts", "C04 Review strategy demands the original sealed failed Pi cycle"],
  "plan-amendment": ["test/generation.test.ts", "C04 real Pi World negative selects source-bound owner strategy"],
  "diagnostic": ["test/generation.test.ts", "C03 production graph diagnoses a source-authenticated unknown scheduling exception once"],
  "diagnostic-stop": ["test/generation.test.ts", "C03 production graph diagnoses a source-authenticated unknown scheduling exception once"],
  "reconcile-effects": ["test/generation.test.ts", "C05 unfamiliar scheduling failure is resolved by source-bound recheck"],
  "continue-independent": ["test/generation-recovery-graph.test.ts", "C02 verified independent no-write progress keeps the failed obligation pending"],
  "pause": ["test/generation.test.ts", "C02 production graph preserves authenticated author controls"],
  "exhausted": ["test/response-contract-recovery.test.ts", "two invalid corrections exhaust with typed protocol result"],
  "integrity-fence": ["test/generation.test.ts", "C02 current-format checkpoint tampering cannot grant a new recovery"],
} as const satisfies Record<RecoveryDecision["action"], readonly [string, string]>;

const phaseChecks = {
  idle: "C02 a settled original failure cannot be re-admitted",
  assessing: "C02 production bridge has only one phase",
  reconciling: "C02 production bridge has only one phase",
  diagnosing: "C02 no model attempt is inferred",
  correcting: "C04 Review strategy demands the original sealed failed Pi cycle",
  verifying: "C02 original source with authenticated reconciliation enters verifying",
  paused: "C02 authenticated author pause and cancellation",
  fenced: "C02 failed re-verification fences",
  resolved: "C07 verified correction persists original identity",
} as const satisfies Record<RecoveryLifecycle["phase"], string>;

function dispatchCases(): Record<string, string> {
  const file = ts.createSourceFile("generation.ts", source("src/generation.ts"),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: Record<string, string> = {};
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
            const handler = /\breturn\s+(run[A-Za-z]+Job|run[A-Za-z]+WorkItem|runNarrativeReview)\s*\(/.exec(body)?.[1];
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
  for (const [node, [operation, name]] of Object.entries(nodeChecks)) {
    assert.deepEqual(node === "assess_recovery" ? null : nodeFailureSource[
      node as keyof typeof nodeFailureSource]?.[0], operation,
      `${node}: original failed-check owner changed`);
    if (operation) assert.ok(operationChecks[operation], `${node}: missing versioned failed check`);
    assert.ok(source("test/generation.test.ts").includes(name),
      `${node}: production-graph regression anchor removed or renamed`);
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
  for (const [action, [file, anchor]] of Object.entries(actionChecks))
    assert.ok(source(file).includes(anchor), `${action}: ${file} lost its regression`);
  for (const [phase, anchor] of Object.entries(phaseChecks)) {
    const path = phase === "correcting" ? "test/generation.test.ts" :
      "test/generation-recovery-lifecycle.test.ts";
    const content = source(path) +
      (path === "test/generation.test.ts" ? "" : source("test/generation-recovery-graph.test.ts"));
    assert.ok(content.includes(anchor), `${phase}: no source-backed transition regression`);
  }
});
