/** C01 maintainable graph-exit audit. This intentionally inspects the real
 * production source, not a second fixture graph or a hand-written router. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import test from "node:test";
import ts from "typescript";
import { operationChecks } from "../src/generation-operation-recovery.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const text = readFileSync(resolve(root, "src/generation.ts"), "utf8");
const file = ts.createSourceFile("generation.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const siteNames = [
  "schedule",
  "assess_recovery",
  "author_update_intake",
  "idea_integration",
  "verify_idea_integration",
  "specialist_dispatch",
  "dependency_amendment",
  "independent_assignment_review",
  "verify_committed_work",
  "completion_decision",
  "reconcile",
  "authorBoundary",
  "independentAssignmentBoundary",
  "operationFailure",
  "blocked",
  "runStoryGeneration",
] as const;

/** Explicitly reviewed counts. Changes require a source-linked matrix review
 * in docs/generation-recovery-contract.md rather than silent test regeneration. */
const approvedExitShape: Record<(typeof siteNames)[number], string> = {
  schedule: "returns:8,status:6,blocked:3,operationFailure:1,throws:12",
  assess_recovery: "returns:20,status:8,blocked:3,throws:10",
  author_update_intake: "returns:19,status:2,operationFailure:6,authorBoundary:1,reconcile:2,throws:1",
  idea_integration: "returns:5,status:1,operationFailure:1,throws:5",
  verify_idea_integration: "returns:5,status:1,operationFailure:3,reconcile:1,throws:4",
  specialist_dispatch: "returns:17,status:1,blocked:2,operationFailure:4,authorBoundary:1,throws:4",
  dependency_amendment: "returns:4,blocked:1,operationFailure:1,authorBoundary:1,throws:2",
  independent_assignment_review: "returns:3,blocked:1,operationFailure:1",
  verify_committed_work: "returns:6,status:4,blocked:1,operationFailure:2,reconcile:2,throws:3",
  completion_decision:
    "returns:11,status:5,blocked:1,operationFailure:2,authorBoundary:2,reconcile:1,throws:2",
  reconcile: "returns:13,status:6,operationFailure:2,throws:9",
  authorBoundary: "returns:4,status:1,blocked:1,operationFailure:1",
  independentAssignmentBoundary: "returns:18,status:8,operationFailure:1,throws:9",
  operationFailure: "returns:3,status:1,blocked:1",
  blocked: "returns:1,status:1",
  runStoryGeneration: "returns:5,status:5,blocked:5,operationFailure:1,reconcile:1,throws:14",
};
const operations = [
  "adaptive-admission",
  "author-update-intake",
  "commit-verification",
  "completion-verification",
  "dependency-amendment",
  "idea-integration",
  "idea-verification",
  "independent-review",
  "resume-reconciliation",
  "scheduling",
  "specialist-dispatch",
  "specialist-result",
];

function childNodes(node: ts.Node): ts.Node[] {
  const result: ts.Node[] = [];
  ts.forEachChild(node, (child) => {
    result.push(child);
  });
  return result;
}

function graphNodes(): Map<string, ts.Node> {
  const nodes = new Map<string, ts.Node>();
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "addNode" &&
      node.arguments.length === 2 &&
      ts.isStringLiteral(node.arguments[0]!)
    ) {
      nodes.set((node.arguments[0] as ts.StringLiteral).text, node.arguments[1]!);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return nodes;
}
function graphEdges(): string[] {
  const nodes: string[] = [];
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "addConditionalEdges" &&
      ts.isStringLiteral(node.arguments[0]!)
    )
      nodes.push((node.arguments[0] as ts.StringLiteral).text);
    ts.forEachChild(node, visit);
  }
  visit(file);
  return nodes.sort();
}
/** Account for changes to route predicates and target END/assess_recovery
 * destinations, not only newly added nodes or terminal returns. */
function edgeSignatures(): Record<string, string> {
  const signatures: Record<string, string> = {};
  const printer = ts.createPrinter({ removeComments: true });
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "addConditionalEdges" &&
      ts.isStringLiteral(node.arguments[0]!)
    ) {
      const source = (node.arguments[0] as ts.StringLiteral).text;
      const route = node.arguments
        .slice(1)
        .map((arg) => printer.printNode(ts.EmitHint.Unspecified, arg, file))
        .join("|");
      signatures[source] = createHash("sha256").update(route).digest("hex");
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return Object.fromEntries(Object.entries(signatures).sort(([a], [b]) => a.localeCompare(b)));
}

/** Baseline from the current C01 source: any changed route must be audited. */
const approvedEdgeSignatures: Record<string, string> = {
  assess_recovery: "2c998b80011fa55085363af1fd409eb7ac22d011f50f5ff84cf2bcf3c5cebb73",
  author_update_intake: "b99c8153d8510a00b9f7bae3e8ddc4bdb6ddedfedffda0b40cdba3e99a7830d0",
  completion_decision: "0c826ad6ed55f2fb1e19b3e7fe7333a17d8aa04e8aa59005f3f463f00bbdaa88",
  dependency_amendment: "ee38e899f58564bdeb73ea2ee9ddadfa324aae152dc4eb9f156dc21122b6862d",
  idea_integration: "2a18b888743ce1be5a7c8e570b8c1e903874e38bec4fd2c9531d7826bb930235",
  independent_assignment_review: "31df641ec3ac30f6ced3f0a9584607eae707dec055b280620f5e0f500a259262",
  schedule: "ee38e899f58564bdeb73ea2ee9ddadfa324aae152dc4eb9f156dc21122b6862d",
  specialist_dispatch: "fb238e11658e9aec770037118d2a8a2e08bed03d1c5e822d993125e9337a9286",
  verify_committed_work: "9fbefd5978a9b759ffe379eeee824ef6a9c2b22129825bf314a0474164aff134",
  verify_idea_integration: "9fbefd5978a9b759ffe379eeee824ef6a9c2b22129825bf314a0474164aff134",
};

function helpers(): Map<string, ts.Node> {
  const functions = new Map<string, ts.Node>();
  for (const child of childNodes(file)) {
    if (ts.isFunctionDeclaration(child) && child.name) functions.set(child.name.text, child.body!);
  }
  return functions;
}
function exitShape(node: ts.Node): string {
  const counts = {
    returns: 0,
    status: 0,
    blocked: 0,
    operationFailure: 0,
    authorBoundary: 0,
    reconcile: 0,
    throws: 0,
  };
  const observed: string[] = [];
  function visit(item: ts.Node): void {
    if (ts.isThrowStatement(item)) counts.throws++;
    if (ts.isReturnStatement(item)) counts.returns++;
    // Track all explicit status assignments, including computed statuses and
    // newly invented terminal spellings, not only the current four constants.
    if (ts.isPropertyAssignment(item) && item.name.getText(file) === "status") counts.status++;
    if (ts.isCallExpression(item)) {
      const name = item.expression.getText(file);
      if (name === "blocked") counts.blocked++;
      if (name === "operationFailure") counts.operationFailure++;
      if (name === "authorBoundary") counts.authorBoundary++;
      if (name === "reconcile") counts.reconcile++;
    }
    ts.forEachChild(item, visit);
  }
  visit(node);
  for (const [key, value] of Object.entries(counts)) if (value) observed.push(key + ":" + value);
  return observed.join(",");
}
test("production graph nodes and conditional END gates are all in the recovery exit inventory", () => {
  const nodes = [...graphNodes().keys()].sort();
  assert.deepEqual(
    nodes,
    siteNames
      .filter((name) => !helpers().has(name))
      .sort()
      .filter((name) => name !== "runStoryGeneration"),
  );
  assert.deepEqual(graphEdges(), nodes);
});
test("route predicates and END destinations cannot change without C01 inventory review", () => {
  assert.deepEqual(
    edgeSignatures(),
    approvedEdgeSignatures,
    "A production routing predicate/END target changed; review the original graph transition in docs/generation-recovery-contract.md before updating this baseline.",
  );
});
test("every typed failed operation is inventoried (new operations fail this gate)", () => {
  assert.deepEqual(Object.keys(operationChecks).sort(), operations);
});
test("new terminal returns, throws or recovery bypass sites require explicit exit-matrix review", () => {
  const nodes = graphNodes(),
    funcs = helpers();
  const actual = Object.fromEntries(
    siteNames.map((site) => [site, exitShape(nodes.get(site) ?? funcs.get(site)!)]),
  );
  assert.deepEqual(
    actual,
    approvedExitShape,
    "New production graph stop/throw or repair-routing shape; inspect its source and update the C01 matrix AND reviewed baseline: " +
      JSON.stringify(actual, null, 2),
  );
});
