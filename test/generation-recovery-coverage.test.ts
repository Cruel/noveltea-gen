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
import {
  reviewedReturnExits,
  reviewedThrowExits,
  reviewedStatusExits,
  reviewedSharedRouteHelper,
} from "./generation-recovery-exit-baseline.js";

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
  "observeNodeOutcome",
  "recoveryNode",
] as const;

/** Explicitly reviewed counts. Changes require a source-linked matrix review
 * in docs/generation-recovery-contract.md rather than silent test regeneration. */
const approvedExitShape: Record<(typeof siteNames)[number], string> = {
  schedule: "returns:9,status:6,blocked:3,operationFailure:1,throws:10",
  assess_recovery: "returns:18,status:7,blocked:1,throws:9",
  author_update_intake: "returns:22,status:4,operationFailure:8,authorBoundary:1,reconcile:2,throws:1",
  idea_integration: "returns:5,status:1,operationFailure:1,throws:5",
  verify_idea_integration: "returns:5,status:1,operationFailure:3,reconcile:1,throws:4",
  specialist_dispatch: "returns:16,status:1,blocked:1,operationFailure:6,throws:7",
  dependency_amendment: "returns:4,blocked:1,operationFailure:1,authorBoundary:1,throws:2",
  independent_assignment_review: "returns:6,status:3,operationFailure:1,throws:1",
  verify_committed_work: "returns:8,status:6,blocked:1,operationFailure:2,reconcile:2,throws:5",
  completion_decision:
    "returns:10,status:2,blocked:1,operationFailure:3,authorBoundary:2,reconcile:1,throws:2",
  reconcile: "returns:13,status:6,operationFailure:2,throws:9",
  authorBoundary: "returns:4,status:1,blocked:1,operationFailure:1",
  independentAssignmentBoundary: "returns:19,status:8,operationFailure:2,throws:9",
  operationFailure: "returns:3,status:1,blocked:1",
  blocked: "returns:1,status:1",
  runStoryGeneration: "returns:5,status:7,blocked:6,reconcile:1,throws:15",
  observeNodeOutcome: "returns:3,status:2,blocked:1,operationFailure:1,throws:1",
  recoveryNode: "returns:21,status:15,throws:11",
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

function graphNodes(source: ts.SourceFile = file): Map<string, ts.Node> {
  const nodes = new Map<string, ts.Node>();
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "addNode" &&
      node.arguments.length === 2 &&
      ts.isStringLiteral(node.arguments[0]!)
    ) {
      const callback = node.arguments[1]!;
      assert.ok(
        ts.isCallExpression(callback) &&
          ts.isIdentifier(callback.expression) &&
          callback.expression.text === "recoveryNode" &&
          callback.arguments.length === 2 &&
          ts.isStringLiteral(callback.arguments[0]!) &&
          (callback.arguments[0] as ts.StringLiteral).text === (node.arguments[0] as ts.StringLiteral).text,
        "Every production node must use the shared single-authority recovery boundary.",
      );
      nodes.set((node.arguments[0] as ts.StringLiteral).text, callback.arguments[1]!);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
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
/** Direct graph edges must not bypass assessment or change destinations silently. */
function directEdgeSignatures(source: ts.SourceFile = file): string[] {
  const edges: string[] = [];
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "addEdge"
    ) {
      assert.equal(node.arguments.length, 2, "Unexpected direct graph edge shape");
      edges.push(node.arguments.map((arg) => arg.getText(source)).join(" => "));
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return edges.sort();
}
const approvedDirectEdges = ['START => "schedule"'];

/** Account for changes to route predicates and target END/assess_recovery
 * destinations, not only newly added nodes or terminal returns. */
function edgeSignatures(source: ts.SourceFile = file): Record<string, string> {
  const signatures: Record<string, string> = {};
  const printer = ts.createPrinter({ removeComments: true });
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "addConditionalEdges" &&
      ts.isStringLiteral(node.arguments[0]!)
    ) {
      const edgeSource = (node.arguments[0] as ts.StringLiteral).text;
      const route = node.arguments
        .slice(1)
        .map((arg) => printer.printNode(ts.EmitHint.Unspecified, arg, source))
        .join("|");
      signatures[edgeSource] = createHash("sha256").update(route).digest("hex");
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return Object.fromEntries(Object.entries(signatures).sort(([a], [b]) => a.localeCompare(b)));
}

/** Baseline from the current C01 source: any changed route must be audited. */
const approvedEdgeSignatures: Record<string, string> = {
  assess_recovery: "68e31ce4e43b0258f559658405c3e616af916e4aba65c0d4d54aee575e12558c",
  author_update_intake: "0ca4965adcd4a316dad45ac3981b23e8a21b25b2bdab2ffa7c636a31be15a12a",
  completion_decision: "75726d85064f0f9b1eb31b89fad2856bbcdfc7f02748f590116cb30fd2148df5",
  dependency_amendment: "ee38e899f58564bdeb73ea2ee9ddadfa324aae152dc4eb9f156dc21122b6862d",
  idea_integration: "2a18b888743ce1be5a7c8e570b8c1e903874e38bec4fd2c9531d7826bb930235",
  independent_assignment_review: "f87aeaf6ff6b7d83e855614fce024415bc395e9b7de258c5a4f6e25dde3d87a5",
  schedule: "ee38e899f58564bdeb73ea2ee9ddadfa324aae152dc4eb9f156dc21122b6862d",
  specialist_dispatch: "fb238e11658e9aec770037118d2a8a2e08bed03d1c5e822d993125e9337a9286",
  verify_committed_work: "ee38e899f58564bdeb73ea2ee9ddadfa324aae152dc4eb9f156dc21122b6862d",
  verify_idea_integration: "ee38e899f58564bdeb73ea2ee9ddadfa324aae152dc4eb9f156dc21122b6862d",
};

function helpers(source: ts.SourceFile = file): Map<string, ts.Node> {
  const functions = new Map<string, ts.Node>();
  for (const child of childNodes(source)) {
    if (ts.isFunctionDeclaration(child) && child.name) functions.set(child.name.text, child.body!);
  }
  return functions;
}
// R01: the parent's dispatch return is inventoried above; the child is a
// real nested graph, so its routes and receipt gates also require explicit
// review. Fingerprint the complete admission/adapter/child bodies rather than
// merely counting exits (which would miss changed predicates).
test("R01 admission and nested assignment lifecycle retain reviewed proof gates", () => {
  const child = ts.createSourceFile("generation-assignment-lifecycle.ts",
    readFileSync(resolve(root, "src/generation-assignment-lifecycle.ts"), "utf8"),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const printer = ts.createPrinter({ removeComments: true });
  const reviewed = [
    [file, "requireGenerationTurn", "8baffb20a762139ae0f91b3a6eb1fd3da4e5200076139160f74a6db26661de67"],
    [file, "runFoundationAssignmentChild", "570895ae2e57fb71092bca9ccefa41beeef633f2ccac6d5024027290f993ce9a"],
    [child, "createAssignmentLifecycleGraph", "9fa13f1f13a3729ec1fd9253f553483222c06492c7d1b490c59ccf5f225d7701"],
    [child, "authenticateAssignmentReentry", "5b24030609f9d19c2cd5c001a29dbcb865388377cfd865ee6c176b4996a2e135"],
  ] as const;
  for (const [source, name, expected] of reviewed) {
    const body = helpers(source).get(name);
    assert.ok(body, name + " must remain source-linked");
    const actual = createHash("sha256")
      .update(printer.printNode(ts.EmitHint.Unspecified, body, source)).digest("hex");
    assert.equal(actual, expected, name + " changed: review R01 proof gates and contract");
  }
});

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
/** An exit's stable ID is its owning graph callback/helper and ordinal within
 * returns or throws of that owner. Unlike counts, its statement fingerprint
 * detects edited returns, including swapped status and reused exit slots. */
function exitSites(
  source: ts.SourceFile = file,
): Record<string, { id: string; fingerprint: string; source: string }[]> {
  const printer = ts.createPrinter({ removeComments: true });
  const nodes = graphNodes(source);
  const funcs = helpers(source);
  const sites: Record<string, { id: string; fingerprint: string; source: string }[]> = {};
  for (const site of siteNames) {
    const root = nodes.get(site) ?? funcs.get(site);
    assert.ok(root, `Missing production exit owner ${site}`);
    let returns = 0;
    let throws = 0;
    let statuses = 0;
    const records: { id: string; fingerprint: string; source: string }[] = [];
    function visit(node: ts.Node): void {
      if (
        ts.isReturnStatement(node) ||
        ts.isThrowStatement(node) ||
        (ts.isPropertyAssignment(node) && node.name.getText(source) === "status")
      ) {
        const kind = ts.isReturnStatement(node) ? "return" : ts.isThrowStatement(node) ? "throw" : "status";
        const ordinal = kind === "return" ? ++returns : kind === "throw" ? ++throws : ++statuses;
        const expression = printer
          .printNode(ts.EmitHint.Unspecified, node, source)
          .replace(/\s+/g, " ")
          .trim();
        records.push({
          id: `${site}/${kind}#${ordinal}`,
          fingerprint: createHash("sha256").update(expression).digest("hex").slice(0, 16),
          source: expression,
        });
      }
      ts.forEachChild(node, visit);
    }
    visit(root);
    sites[site] = records;
  }
  return sites;
}

/** The *body* of every shared routing helper is a reviewed dispatch gate.
 * Hashing only call expressions does not detect a changed helper definition. */
function routeHelperSignature(source: ts.SourceFile = file): string {
  const helper = helpers(source).get("routeAfterOperationAssessment");
  assert.ok(helper, "Shared operation assessment route helper removed or renamed");
  const printed = ts
    .createPrinter({ removeComments: true })
    .printNode(ts.EmitHint.Unspecified, helper, source);
  return createHash("sha256").update(printed).digest("hex");
}

test("every individual return and throw has a stable source ID, reviewed disposition and fingerprint", () => {
  const exits = exitSites();
  assert.deepEqual(Object.keys(exits), [...siteNames]);
  for (const site of siteNames) {
    const observed = exits[site]!;
    const expectedReturns = reviewedReturnExits[site].split(" ").filter(Boolean);
    const expectedThrows = reviewedThrowExits[site].split(" ").filter(Boolean);
    const expectedStatuses = reviewedStatusExits[site].split(" ").filter(Boolean);
    const returned = observed.filter((r) => r.id.includes("/return#"));
    const thrown = observed.filter((r) => r.id.includes("/throw#"));
    const statuses = observed.filter((r) => r.id.includes("/status#"));
    assert.equal(returned.length, expectedReturns.length, `${site}: return site count changed`);
    assert.equal(thrown.length, expectedThrows.length, `${site}: throw site count changed`);
    assert.equal(statuses.length, expectedStatuses.length, `${site}: status site count changed`);
    expectedReturns.forEach((entry, i) => {
      const [fingerprint, disposition] = entry.split(":");
      assert.match(
        disposition ?? "",
        /^(G|R|O|F|U|B|S|V)$/,
        `${site}/return#${i + 1}: missing reviewed disposition`,
      );
      assert.equal(returned[i]!.id, `${site}/return#${i + 1}`);
      assert.equal(
        returned[i]!.fingerprint,
        fingerprint,
        `${site}/return#${i + 1} [${disposition}] changed: ${returned[i]!.source}`,
      );
    });
    expectedThrows.forEach((fingerprint, i) => {
      assert.equal(thrown[i]!.id, `${site}/throw#${i + 1}`);
      assert.equal(
        thrown[i]!.fingerprint,
        fingerprint,
        `${site}/throw#${i + 1} [X] changed: ${thrown[i]!.source}`,
      );
    });
    expectedStatuses.forEach((entry, i) => {
      const [fingerprint, disposition] = entry.split(":");
      assert.match(disposition ?? "", /^(G|F|U|B|S|V)$/, `${site}/status#${i + 1}: missing disposition`);
      assert.equal(statuses[i]!.id, `${site}/status#${i + 1}`);
      assert.equal(
        statuses[i]!.fingerprint,
        fingerprint,
        `${site}/status#${i + 1} [${disposition}] changed: ${statuses[i]!.source}`,
      );
    });
  }
  assert.equal(
    routeHelperSignature(),
    reviewedSharedRouteHelper,
    "Original assessment routing helper changed",
  );
});
test("C02 production graph has exactly one authoritative recovery annotation", () => {
  const declarations = file.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations]);
  const channels = declarations.find(
    (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === "Channels",
  );
  assert.ok(
    channels && ts.isCallExpression(channels.initializer!),
    "Production graph annotations must be statically auditable",
  );
  const root = channels.initializer.arguments[0];
  assert.ok(root && ts.isObjectLiteralExpression(root));
  const names = root.properties
    .filter(ts.isPropertyAssignment)
    .map((property) => property.name.getText(file).replace(/^["']|["']$/g, ""));
  assert.equal(names.filter((name) => name === "recoveryLifecycle").length, 1);
  assert.equal(names.filter((name) => name === "recoverySources").length, 1);
  for (const legacy of ["recovery", "operationRecovery", "unknownRecovery"])
    assert.equal(
      names.includes(legacy),
      false,
      legacy + " must never become another active graph-level phase channel",
    );
});

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
  assert.deepEqual(directEdgeSignatures(), approvedDirectEdges);
});
test("route predicates and END destinations cannot change without C01 inventory review", () => {
  assert.deepEqual(
    edgeSignatures(),
    approvedEdgeSignatures,
    "A production routing predicate/END target changed; review the original graph transition in docs/generation-recovery-contract.md before updating this baseline.",
  );
});
test("shared routing helper cannot bypass assessments even when call sites are unchanged", () => {
  const bypass = ts.createSourceFile(
    "generation.ts",
    text.replace(
      'return (s.recoveryLifecycle.phase === "assessing" || s.recoveryLifecycle.assessorPending) && !!s.recoveryLifecycle.active\n    ? "assess_recovery" : normal;',
      "return normal;",
    ),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  assert.notEqual(bypass.text, text, "Mutation fixture must change the real helper");
  assert.deepEqual(edgeSignatures(bypass), edgeSignatures(), "Call sites were deliberately left untouched");
  assert.notEqual(
    routeHelperSignature(bypass),
    routeHelperSignature(),
    "Bypass must invalidate helper signature",
  );
});
test("an existing blocked exit cannot change to running without changing its source-specific proof", () => {
  const oldExit = 'return blocked(Error("Unrecognized or unbound adaptive recovery decision"));';
  assert.ok(text.includes(oldExit), "Mutation must target actual current production code");
  const bypass = ts.createSourceFile(
    "generation.ts",
    text.replace(oldExit, 'return { status: "running" as const };'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const original = exitSites().assess_recovery!.filter((r) => r.id.includes("/return#"));
  const altered = exitSites(bypass).assess_recovery!.filter((r) => r.id.includes("/return#"));
  assert.equal(altered.length, original.length, "Return count deliberately unchanged");
  assert.notEqual(
    altered[16]!.fingerprint,
    original[16]!.fingerprint,
    "Source-specific fingerprint catches bypass even with the same return count",
  );
});
test("a concise-arrow fence cannot change to running while return sites and counts stay fixed", () => {
  const oldStatus = 'status: "blocked", operationRecovery: { ...op, phase: "fenced" }';
  assert.ok(text.includes(oldStatus), "Mutation must target the actual assessor fence helper");
  const bypass = ts.createSourceFile(
    "generation.ts",
    text.replace(oldStatus, 'status: "running", operationRecovery: { ...op, phase: "fenced" }'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const before = exitSites().assess_recovery!;
  const after = exitSites(bypass).assess_recovery!;
  assert.deepEqual(
    before.filter((r) => r.id.includes("/return#")).map((r) => r.fingerprint),
    after.filter((r) => r.id.includes("/return#")).map((r) => r.fingerprint),
    "No explicit return site changed",
  );
  assert.notDeepEqual(
    before.filter((r) => r.id.includes("/status#")).map((r) => r.fingerprint),
    after.filter((r) => r.id.includes("/status#")).map((r) => r.fingerprint),
    "Status site fingerprint must detect the concealed bypass",
  );
});
test("direct graph edges cannot silently skip controller dispatch", () => {
  const bypass = ts.createSourceFile(
    "generation.ts",
    text.replace('.addEdge(START, "schedule")', '.addEdge(START, "completion_decision")'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  assert.notDeepEqual(directEdgeSignatures(bypass), directEdgeSignatures());
});
test("every typed failed operation is inventoried (new operations fail this gate)", () => {
  assert.deepEqual(Object.keys(operationChecks).sort(), operations);
});
/** C08 direct-block/END audit. The existing AST baseline checks each exact
 * return/status fingerprint; this table adds source-linked terminal disposition
 * and safety evidence for every reviewed F marker. A new F cannot inherit an
 * unexamined generic "blocked" classification. No category grants a retry.
 * Nonterminal arrow-factory returns are G, not stopped graph executions. */
const reviewedDirectStopFamilies = {
  "legacy-read-only": {
    disposition: "inspection-only",
    proof: "Old completion-only advisory has no C02 admission capability",
    regression: ["test/generation-recovery-graph.test.ts", "C05 legacy completion-only channel cannot mint a second active recovery case"],
    sites: ["assess_recovery/return#1", "assess_recovery/status#1"],
  },
  "original-proof-missing": {
    disposition: "integrity-fence",
    proof: "Original graph task, HEAD, author control, Review/commit or deferred receipt cannot be authenticated",
    regression: ["test/generation.test.ts", "C02 current-format checkpoint tampering cannot grant a new recovery or writer attempt"],
    sites: [
      "schedule/status#4",
      "assess_recovery/return#2", "assess_recovery/return#4",
      "assess_recovery/return#9", "assess_recovery/return#11",
      "assess_recovery/return#12", "assess_recovery/return#16",
      "assess_recovery/status#2",
      "completion_decision/return#6", "completion_decision/status#1",
      "observeNodeOutcome/return#3",
      "recoveryNode/return#3", "recoveryNode/return#4", "recoveryNode/return#6",
      "recoveryNode/return#14", "recoveryNode/return#16", "recoveryNode/return#19",
      "recoveryNode/status#2", "recoveryNode/status#3", "recoveryNode/status#4",
      "recoveryNode/status#5", "recoveryNode/status#11",
      "recoveryNode/status#13", "recoveryNode/status#15",
    ],
  },
  "current-turn-admission": {
    disposition: "integrity-fence",
    proof: "Mandatory source-authenticated current Turn or isolated fixture identity before any executable node; no legacy fallback",
    regression: ["test/generation.test.ts", "R01 obsolete Generation entry is fenced before any model or Git effect"],
    sites: ["recoveryNode/return#2", "recoveryNode/status#1"],
  },
  "original-check-unresolved": {
    disposition: "reconciliation-required",
    proof: "Same original read-only check remains negative or unchanged-source repeated check has already been assessed",
    regression: ["test/generation.test.ts", "C05 unfamiliar scheduling failure is resolved by source-bound recheck and resumes generation"],
    sites: [
      "assess_recovery/return#7", "assess_recovery/return#13",
      "operationFailure/return#2", "operationFailure/status#1",
    ],
  },
  "protocol-verifier-exhausted": {
    disposition: "bounded-protocol-stop",
    proof: "Original response exhausted its format allowance or independently failed the deployed verifier; no new writer",
    regression: ["test/response-contract-recovery.test.ts", "two invalid corrections exhaust with typed protocol result"],
    sites: [
      "reconcile/return#7", "reconcile/return#9", "reconcile/return#10",
      "reconcile/status#4", "reconcile/status#5", "reconcile/status#6",
    ],
  },
  "pending-owner-approval": {
    disposition: "owner-or-author-resolution",
    proof: "Independent Review/prerequisite refused cross-owner action without approved owner or author source",
    regression: ["test/generation.test.ts", "C04 Review strategy demands the original sealed failed Pi cycle before any correction attempt"],
    sites: [
      "independentAssignmentBoundary/return#9", "independentAssignmentBoundary/return#17",
      "independentAssignmentBoundary/status#1", "independentAssignmentBoundary/status#3",
      "independentAssignmentBoundary/status#7", "independentAssignmentBoundary/status#8",
    ],
  },
  "sealed-diagnostic-stop": {
    disposition: "operator-advisory",
    proof: "Started-and-settled original Pi transcript is authenticated, but no corrective adapter is authorized",
    regression: ["test/generation.test.ts", "C03 production graph diagnoses a source-authenticated unknown scheduling exception once"],
    sites: ["recoveryNode/return#5"],
  },
  "returned-terminal-projection": {
    disposition: "read-only-output",
    proof: "The entrypoint reports a stopped graph checkpoint but cannot create or fulfill a recovery decision",
    regression: ["test/generation.test.ts", "generation start and read-only inspect preserve invalid corrective evidence without replay"],
    sites: [
      "runStoryGeneration/status#3", "runStoryGeneration/status#4",
      "runStoryGeneration/status#5", "runStoryGeneration/status#6",
    ],
  },
} as const;

test("C08 every direct blocked/status source has an audited disposition and independent regression", () => {
  const observed: string[] = [];
  const exits = exitSites();
  for (const site of siteNames) {
    for (const [kind, baseline] of [
      ["return", reviewedReturnExits[site]],
      ["status", reviewedStatusExits[site]],
    ] as const) {
      const annotated = baseline.split(" ").filter(Boolean);
      const records = exits[site]!.filter(item => item.id.includes("/" + kind + "#"));
      annotated.forEach((entry, i) => {
        if (entry.endsWith(":F")) {
          assert.equal(records[i]!.fingerprint, entry.slice(0, 16),
            "Reviewed direct-block fingerprint must remain bound to source");
          observed.push(records[i]!.id);
        }
      });
    }
  }
  const classified: string[] = [];
  for (const [family, spec] of Object.entries(reviewedDirectStopFamilies)) {
    assert.ok(spec.proof.length > 20, family + " has no evidence condition");
    const [file, anchor] = spec.regression;
    assert.ok(readFileSync(resolve(root, file!), "utf8").includes(anchor!),
      family + " lost its independent regression");
    classified.push(...spec.sites);
  }
  assert.equal(new Set(classified).size, classified.length, "Direct stop is classified twice");
  assert.deepEqual(classified.sort(), observed.sort(),
    "A direct blocked graph source has no reviewed C08 evidence-backed disposition");
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
