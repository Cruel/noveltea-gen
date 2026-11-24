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
  schedule: "returns:10,status:6,blocked:3,operationFailure:1,authorBoundary:1,throws:10",
  assess_recovery: "returns:18,status:7,blocked:1,throws:9",
  author_update_intake: "returns:22,status:4,operationFailure:8,authorBoundary:1,reconcile:2,throws:1",
  idea_integration: "returns:5,status:1,operationFailure:1,throws:5",
  verify_idea_integration: "returns:5,status:1,operationFailure:3,reconcile:1,throws:4",
  specialist_dispatch: "returns:21,status:1,blocked:1,operationFailure:6,throws:7",
  dependency_amendment: "returns:5,blocked:1,operationFailure:1,authorBoundary:1,throws:6",
  independent_assignment_review: "returns:8,status:2,operationFailure:1,throws:1",
  verify_committed_work: "returns:8,status:6,blocked:1,operationFailure:2,reconcile:2,throws:6",
  completion_decision:
    "returns:10,status:2,blocked:1,operationFailure:3,authorBoundary:2,reconcile:1,throws:2",
  reconcile: "returns:13,status:6,operationFailure:2,throws:9",
  authorBoundary: "returns:4,status:1,blocked:1,operationFailure:1",
  independentAssignmentBoundary: "returns:15,status:6,operationFailure:2,throws:8",
  operationFailure: "returns:3,status:1,blocked:1",
  blocked: "returns:1,status:1",
  runStoryGeneration: "returns:5,status:9,blocked:6,reconcile:1,throws:17",
  observeNodeOutcome: "returns:3,status:2,blocked:1,operationFailure:1,throws:1",
  recoveryNode: "returns:24,status:18,throws:14",
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
  assess_recovery: "4527e910bf03ddb96abfd271a608695760d9e6b753be754d11a130707070ea04",
  author_update_intake: "2693bb4f1cc711f6fed86c0d588b3170958dab1866e059be768639e6b27dd56c",
  completion_decision: "75726d85064f0f9b1eb31b89fad2856bbcdfc7f02748f590116cb30fd2148df5",
  dependency_amendment: "ee38e899f58564bdeb73ea2ee9ddadfa324aae152dc4eb9f156dc21122b6862d",
  idea_integration: "2a18b888743ce1be5a7c8e570b8c1e903874e38bec4fd2c9531d7826bb930235",
  independent_assignment_review: "68c22b2b19df752f3d928dea472fe1519d1645b9f621276f0bf92d81851cbf0b",
  schedule: "ee38e899f58564bdeb73ea2ee9ddadfa324aae152dc4eb9f156dc21122b6862d",
  specialist_dispatch: "9f5ffa93f6202d91b0b9eafcf75e35521264ad50c20658d819051cd382488e01",
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
  const writer = ts.createSourceFile("generation-writer-round.ts", readFileSync(resolve(root, "src/generation-writer-round.ts"), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const reviewed = [
    [file, "requireGenerationTurn", "4e2cba38f5a0211fef83a9ed6ef9765cb71e6b8aa2e640f13d67e81b5ea0b7f8"],
    [file, "dispatch", "a6f2c5ec831eeac034b8a2e1c1fb27e006795d7292fa54a6cfcecffc6d3715fe"],
    [file, "runFoundationAssignmentChild", "14f0bcfef6a2e02ff4ffbf35b9dae088bde0573cee138c7151421bc4ebc835d0"],
    [file, "runArchitectureAssignmentChild", "5ebd95013c61fd3b68285cce3ea262e5a3df1e290a8bae15e47b9ff8647a0c77"],
    [file, "runCharacterWorldAssignmentChild", "63e941b5033a0c99fc1186ab145c3559b840b21a96f0563b6bca3b1b8f25d802"],
    [child, "assignmentChildConfig", "0f3ddbb4224e60f73a9b5aa6035ebdc13a9740cbe09e598077467f0b4653e69a"],
    [file, "runNarrativeAssignmentChild", "eff7fce78296617d7f4f1d1d8d5b8f7ee3d5e8f86a57ef4b1a762d1e7fed6f7a"],
    [file, "runReviewPrerequisiteChild", "738607cc1a495fe1cb04495cb7eef5e850aebc94d76d1d2ce05ef442135ea4c7"],
    [file, "pendingNarrativeForResume", "fd9a869e198615e191c6143a4e8cb75fe4fc3d79c5cce6ccdecd923aafa8131d"],
    [file, "inspectOriginalSpecialistCommitForResume", "9f127bc2631027cef2b60ef0181883dfebe1210e8470afb6a775283ff7d54d1f"],
    [child, "usesSharedAssignmentReview", "7698acfab91148b916f81886f703eea2a19ca44cbe423c718dd4990e1a7ed850"],
    [file, "runFocusedAssignmentChild", "e1dc74bee5785bfd58a557f035741fddd1baf596437a8d3fbadb059b472b2ec5"],
    [child, "createAssignmentLifecycleGraph", "5ea8e3f06e6bc4043d45182c853d93e761bae03fed84fd8a998f0ecd717da0bb"],
    [child, "authenticateAssignmentReentry", "90158a424c4a0b1df02b8a4cc77652b4e29cbcb2bca4ffae55127b65350e3cb2"],
    [writer, "subunitRoundProof", "e96aea128cea5b5684c76de341552399255a2ed79329e8c161e4552a278a514a"],
    [writer, "subunitWriterResult", "f37d39dce1f50b1cb032b235712bd6e37ef55f1de8b7b3dc36b0b1ea0ab05e56"],
    [file, "subunitReviewTransitions", "34552a8f637d15a358c73c4b627cadea6460aa1a927d5ecb58c2c3514526b2c4"],
    [file, "subunitReviewStop", "715a0422597a2bd2b70c26baf5db85300ac0e66c7ff422e60da7c7e8b4c5cc1d"],
    [file, "runInteractiveAssignmentChildren", "57ad4e10462ee0c13a3e8ade3d0526a778355c62f98850306fe90c38d969c785"],
  ] as const;
  for (const [source, name, expected] of reviewed) {
    const body = helpers(source).get(name);
    assert.ok(body, name + " must remain source-linked");
    const actual = createHash("sha256")
      .update(printer.printNode(ts.EmitHint.Unspecified, body, source)).digest("hex");
    assert.equal(actual, expected, name + " changed: review R01 proof gates and contract");
  }
});

// R02: settled effect/protocol evidence is a narrow exception to ordinary
// clean-HEAD recovery authentication, never a new writer entitlement.
test("R02 source-bound correction and terminal evidence retain reviewed proof gates", () => {
  const reviewed = [
    ["rejected-review-repair.ts", "runNativeRepairRound", "a2c6c71dc9178134421a03e54a9b8b3cd17c5592ebcf80620bd0850dc856c739"],
    ["rejected-review-repair.ts", "inspectNativeReviewFailure", "f74e6cb607c9b28de3fa4747dffe5bd7088e5ec131efaa62ad612bf8ee66fecc"],
    ["rejected-review-repair.ts", "nativeRepairSource", "8bf5f0b39fd163323756c8c41a6d44e4438ab8e2790bed3f0728a628881f8742"],
    ["rejected-review-repair.ts", "validateRejectedRepairDraft", "571dad77419f569434a4627573d55723adb7159cb65c29d29eb591e3d423e95d"],
    ["rejected-review-repair.ts", "prepareRepairWriter", "be0d661474f79899c426dfa31583cfb89d9db3d50178cf6aa01a4d327f7d4415"],
    ["generation-assignment-lifecycle.ts", "usesCheckpointedReviewRounds", "706e70b0bdfce2bad8be2dd970efe34cf773af9b07e4befffe962c34134fff7c"],
    ["generation-review-round.ts", "createReviewRoundTransitions", "f1896bd8831747b53e5d7a8139b3676b1947ba4cc56dc649393467f241283292"],
    ["generation-operation-strategy.ts", "selectOperationStrategy", "7438418bf72b230fbfc43cf12916579871d14acf31725b55de5aea21c06893ef"],
    ["generation-operation-strategy.ts", "executeOperationStrategy", "4507b2a0c3ff3335dccd4fac945598e1fbe18b9d83569b7db662caaa242fe832"],
    ["generation-recovery-inspection.ts", "inspectModernGenerationRecovery", "9c40354b3557271acdbcb12c10af8ae8d48aec49eaaaa69699feba992c9c1601"],
    ["assignment-metadata-recovery.ts", "materialProgress", "2357f7530030b88d019879e4f74c7b8dcaf5f7f93e70a682059395bc07da3869"],
    ["assignment-metadata-recovery.ts", "nativeMetadataDefects", "a0660a5dec21e5c81a2bb8a8a3f39dd5d5d5317fdde3ad896d4e22689434e063"],
    ["assignment-metadata-recovery.ts", "inspectSettledChain", "69917422bd51372124c219ffb3fb8b5deb37c728920fac75f3d7e1e9cd60cfdf"],
    ["assignment-metadata-recovery.ts", "inspectAssignmentFailure", "d1c2b90f2dfe5e316eea32edae5590f6682391ec3fb5696c85e646cdda402024"],
    ["assignment-metadata-recovery.ts", "executeAssignmentRound", "5bf30230c0b323a25aa4e78454a8d135bbc7c9214c3e7b4ede556701f0a6f870"],
    ["assignment-metadata-recovery.ts", "runAssignmentReceipts", "9da8bfc91567911f984165cd16850debb568c23ae8f4ea984f200e58874b9a45"],
    ["assignment-metadata-recovery.ts", "recoverSubmittedAssignment", "bee3d42257382337c2f3da9ecc6ced3d036c029806cbf37b93c53f48a38774e7"],
    ["cross-domain-prerequisite-controller.ts", "preflightCompositionBoundary", "1485e8f736a11e3b77cc1d17a460880d41ae4f24431c3a984e3ca5ddaa4617ec"],
    ["character-world.ts", "runCharacterWorldJob", "bb7888f1a8f51af39b8df3c8af6c4b63bc77ba0a866c4ba8fc987771c4255f8a"],
    ["character-world.ts", "invocationSource", "203ae344e2447dc4efef389cb44649b679f023b641f7fe861ee1ec98908ac04e"],
    ["interactive-work.ts", "runInteractiveWorkItem", "450d505d4c3c7e96929108fcb4549a79183da83716952e0602e98eee8ff05353"],
    ["interactive-work.ts", "interactiveSourceDigest", "05a9b608bc9b0f6f086aa75dee55eae1949885679b5629576ec8c57fe468ed02"],
    ["character-world.ts", "verifyCharacterWorldReviewOrigin", "142e6331451c4480892b21f7e7b7c150c86a6030a0cfc77c8d24a58b5a78cc37"],
    ["character-world.ts", "inspectRecoverableCharacterWorldCommit", "ff7d64d08ab609775cde44af310b0cfef840862325bfe5f1369f72c3ba52875a"],
    ["foundation.ts", "runFoundationJob", "f81b577c0f5708baa814b3eae4a03acef1088414a169b7aab43816ec7049247c"],
    ["foundation.ts", "executeFoundationGraph", "707e63e9d422b619674aa8aecf4c7bec059ebfd9357db0fcf81e7b1935c88eb4"],
    ["foundation.ts", "piAuthor", "945a4a815db1fbeba0faa4a16ada293c67de9a883a81dd0a7400e35732381993"],
    ["foundation.ts", "foundationSourceDigest", "848e2caae6e2ade76b70ceda6c87703519c2a85fbce7dae80544953564aa68e3"],
    ["foundation.ts", "inspectFoundationFailure", "8ea7e6c1ac238a0bc742e7e344e4de30ca1f07a0d10c7ac7564ad4ff6394bf48"],
    ["generation-operation-recovery.ts", "authenticateAssignmentFailure", "bf758b0e9b0580fe744a80a0c1fb9ffc0d32aaa1cb189c5ae8268f40f86d777f"],
    ["generation-operation-strategy.ts", "originalAssignmentFailure", "9453b0f683a9c5fb398f91931c208a0675f5d31baf8f6cabb397ce14ff96d369"],
    ["generation.ts", "authenticateRecoveryOrigin", "54da6d1399ad76f89e3d85e990df26d4baa27ae5828c051aa55976b3c7906adf"],
    ["generation.ts", "recoverySourceHead", "fd6141d99953e6634ecb99c519817c4b211a563257d57e784d044a16a311d181"],
    ["focused-work.ts", "inspectPendingFocusedCommit", "8559cdf8665172eb9726a604c6fbf42ebb2b4251e32e54c895c807fb7743e6ff"],
    ["rejected-review-repair.ts", "executeReviewRound", "e2de72664aea492971f806c4ff88df5b3cffd97623ce34f6d9c7bcccadccd74c"],
    ["rejected-review-repair.ts", "reviewRoundGrant", "3d2bef4e0a67cec58e809af0190b4a117d8093263dc328e13044a6580d27d8a2"],
    ["rejected-review-repair.ts", "attestNegativeReviewRound", "2708c28d6dda4b162b85c033c6f3e4dbb29930f1dbbfd71dee3675e5f96a6807"],
    ["rejected-review-repair.ts", "rejectedRepairOperations", "ffedcd4099d6c3cd25a52dce761865bc4e8ab5906b207622bbb9de464078ff10"],
    ["rejected-review-repair.ts", "advanceRejectedRepair", "08a52ba586f169855ffc3d270aa1da7948b9dca4fe36eaa61c4baad8f1ab755b"],
    ["rejected-review-repair.ts", "inspectRejectedRepair", "08c3ee74c89d084f0073bb8b4f8a2dfcc30934b719a72fde20b29af6eb10e003"],
    ["rejected-review-repair.ts", "beginRejectedRepair", "5e8f8065cf07ed2c6d2f02b70195679bbb0cd196321e73fe6ffa0fabdecc9b43"],
    ["rejected-review-repair.ts", "readRejectedRepairOrigin", "01e5fc000cacd0ab29c91fbaa18ac5051fe864f26a13007efa7dac00877087c2"],
    ["rejected-review-repair.ts", "readVerifiedFailure", "537aa206aad0dab0dcffda5cb2f717c7feb47b587ea0b3b66888be79c06b3a6a"],
    ["rejected-review-repair.ts", "predecessorOrigin", "90d077dffa0ba77b3a88e78f920af6354e7aafb04d36f56d81c0d06b42627986"],
    ["rejected-review-repair.ts", "foundationReviewBoundary", "6d542b8cb1679dc9b89024c845a35f399c39832b31731cf774dfdc2bc94b9907"],
    ["generation.ts", "reviewPrerequisiteIdentity", "47510b8604aeb746fbda73b6b49ed1d4481c9202dad1d4a9452baa404e9229ea"],
    ["focused-work.ts", "inspectFocusedPrerequisite", "87d1343ce5730592beb5f99ee8023e10dcabbc2b711d587ea60ae417ba262b0d"],
    ["focused-work.ts", "focusedInvocationSource", "48438d7bf37a5f941dcb220c325c9961e949226de8b4c7a0c349e1a52d335d74"],
    ["focused-work.ts", "focusedInvocationOptions", "88f96819c1783655ed3b16231750a557c666c4018550423f41c303f3d154d488"],
    ["focused-work.ts", "inspectPendingFocusedInvocation", "a03f63a1f63ef2dfe4993614c5ff5a6a9fa472fb90ea3eeb37b5f90749a6e384"],
    ["focused-work.ts", "inspectFocusedFailure", "82e7bfdf27dcb67bdba4dc62796c4d04edb2f3d3e76ab4f8479b7493fee17f54"],
    ["focused-work.ts", "runFocusedWorkItem", "735741390228b5631f7e66fb27675d1e139744323cf9bdfbc75ecf1fad3d3957"],
    ["event-work.ts", "runEventWorkItem", "6f6e2a63a01503e82706c11b9c1d6f6b24a323abd51049422d7f976363dcf50c"],
    ["event-work.ts", "eventInvocationSource", "bb2d3f242c24494b33da772668c8764d92084256b5822f75b0123bb298ac9b47"],
    ["dependency-work.ts", "supportingBoundary", "fad02bcf68074d368135eb54027b6dc7009185e49fbaccbe98469e26e936ea8e"],
    ["dependency-work.ts", "supportingWriterRounds", "bcc599e80409ec613505db5f65364782e8164a78d6d8f4d2f9ec21f2b6553f1c"],
    ["dependency-work.ts", "advanceFocusedDependency", "81fa2a835b5ab67d54731e23db186a522d355928ebb9dde82fd5486be4e9ed26"],
    ["dependency-work.ts", "advanceReviewDependency", "b5c73f6e15e019d44eb8fbd105894017044b1fb87e746bd1b2047031958bdf0a"],
    ["event-work.ts", "authorFixtureEventRound", "062748d5f179cf0861f6562f96c3484959259ff4a646a52bdb01d23a044f2bd0"],
    ["event-work.ts", "eventInvocationOptions", "44b04492d8c1cbbcde375a03c04d63aa8506c4ef7e630f7f33423df84a173d8d"],
    ["dependency-state.ts", "finalizeReviewEventDependency", "ce044f10dc685c2008819df852d2b1428a463e7e8e852bb789e4423b10f8075c"],
    ["event-work.ts", "inspectPendingEventInvocation", "ac31f4536bcba270673950f061ccb9bdf3016e0fad383345bfca9427b2658548"],
    ["composition-work.ts", "inspectPendingCompositionInvocation", "4ef9ee4c81a3da6c24a51545aa48daa1e75b2f7cdfcc34c298baa7a7671e17b9"],
    ["interactive-work.ts", "inspectPendingInteractiveInvocation", "b17f6e0277797c386c1bb436081c94a7b77058593530a2187367a042ae021067"],
  ] as const;
  const printer = ts.createPrinter({ removeComments: true });
  for (const [path, name, expected] of reviewed) {
    const source = ts.createSourceFile(path, readFileSync(resolve(root, "src", path), "utf8"),
      ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const body = helpers(source).get(name);
    assert.ok(body, name + " must remain source-linked");
    const actual = createHash("sha256")
      .update(printer.printNode(ts.EmitHint.Unspecified, body, source)).digest("hex");
    assert.equal(actual, expected, name + " changed: review R02 proof gates and contract");
  }
});

// R14 extends the existing source gate to the Studio parent, its original
// invocation/receipt adapter, and the external handoff. See the R14 inventory
// in docs/recovery-exit-inventory.md for the disposition of each boundary.
// Hash the bodies, not line numbers, to detect a new return, changed proof
// predicate, alternate route, or new invocation inside the reviewed boundary.
test("R14 Discovery and handoff retain reviewed source/effect gates", () => {
  const reviewed = [
    ["discovery-graph.server.ts", "discoveryGraph", "29b99596bb982d57721d7197b3975f9f0eb437428a6febf075a499107d4eca3a"],
    ["onboarding-pi.server.ts", "realInference", "27030cd9a5ff2eeee05161bab2c3c1971294f0635a98929c58e29e7a49dda80c"],
    ["onboarding-pi.server.ts", "openDiscoveryGraph", "af14f5a9776487a27f52a6fa457d700d4c51aa8bfdf582a4c2acc496e2100a26"],
    ["onboarding-pi.server.ts", "settleInterruptedApproval", "6332d0af287a08423108d122c20d5da9503136454566a2a4a2a703aaa1f38412"],
    ["onboarding-pi.server.ts", "reconcileDiscoveryGraph", "df459778be6135cdf996624df0019a2901d0230acdab3c051362f612f3d9dd54"],
    ["onboarding-pi.server.ts", "onboardingPiRequest", "86d90a076a3132e384199dc0b00b28eefae6156686d19203faf2fe2b6020d046"],
    ["onboarding-pi.server.ts", "expectedProposal", "223e0a08045e4f01921b624cb73b1c6d3d3a901b6451a67abff9f020efd074aa"],
    ["onboarding-pi.server.ts", "currentGraph", "51f5e1b73a5d42c4a6d7d39f0b43315b929597b5b944777329e7ae2be6c946e6"],
    ["../../../src/discovery-semantic-review.ts", "parseDiscoverySemanticDiagnostic", "2de55a16f6751be8200839b532327ce05a47c5ec295d5d23dc57c26c620e49b1"],
    ["../../../src/planning-interpretation.ts", "parsePlanningInterpretations", "ce3b883e9c3abf410bf8cfb3beb29748184c7bada02a1f523779fa116f1ad4e8"],
    ["../../../src/generation-recovery-lifecycle.ts", "assessBoundedAssignmentFailure", "c5bba208f00fb0f282218273a544bb9cd7a769e08416baa5f0dfa624c2418d1c"],
    ["discovery-evidence.server.ts", "createDiscoveryEvidence", "d65530210581f739b02c85fa4d1363b0b0fc199d24073f79df84b3e9b6d3a91f"],
    ["discovery-evidence.server.ts", "discoveryEvidence", "d957a619d6e7cec6bc5f0717fd7d1fc557e978f6e8339dae1d94f269a0452e7c"],
    ["discovery-evidence.server.ts", "readDiscoveryResponse", "fc3f1111c465c11c35ff4efd664b831a3fa77c868364f2a2abd87298f7dc59ba"],
    ["discovery-evidence.server.ts", "meterDiscoveryAttempts", "e9241e86534b4c7ba043c91d9dab9c5d019fb636f1077619a67d6651adf6dd9b"],
    ["discovery-evidence.server.ts", "reopenDiscoveryPiReference", "34427e1be321ede94d803e8428a3958010e7d12faee592f9ef0717d58301e8dd"],
    ["discovery-handoff-effects.server.ts", "readHandoffEffect", "16d73d0fd5e840f7d86598f21e890038ddf9266089106e9fb3ee14cbe6790dd7"],
    ["discovery-handoff-effects.server.ts", "handoffEffects", "39b839219a60fdb75e1d81acdd574240229a34d50c7c00c885ca5dd595e03c08"],
    ["story-approved-continuation.server.ts", "admitWholeApprovedStory", "0ed28dd4aa02a70f940436159292c0e6c09c7abe739ded84be0de16258beecee"],
    ["story-approved-continuation.server.ts", "continueApprovedStoryChat", "096597e97a72aa19a8c5a9a2c77530f112232e282c0d2900abccb72f4b09851d"],
    ["story-chat-discovery.server.ts", "storyChatDiscoveryRequest", "ba6213d9bb15cff30ead8d79d82321daa92088c83b26ff3abea82d0aa1ffcd3f"],
    ["story-chat-discovery.server.ts", "beginStoryChatDiscovery", "fb515c5e6d2ef1631df02b785f8cd96a2cc7b7d1d20ae83f1be070e7417aacd7"],
  ] as const;
  const printer = ts.createPrinter({ removeComments: true });
  for (const [path, name, expected] of reviewed) {
    const source = ts.createSourceFile(path, readFileSync(resolve(root, "web/src/lib", path), "utf8"),
      ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const body = helpers(source).get(name);
    assert.ok(body, name + " must remain source-linked");
    const actual = createHash("sha256")
      .update(printer.printNode(ts.EmitHint.Unspecified, body, source)).digest("hex");
    assert.equal(actual, expected, name + " changed: review R14 Discovery/handoff proof gates");
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
      "recoveryNode/return#14", "recoveryNode/return#16", "recoveryNode/return#22",
      "recoveryNode/status#2", "recoveryNode/status#3", "recoveryNode/status#4",
      "recoveryNode/status#5", "recoveryNode/status#11",
      "recoveryNode/status#13", "recoveryNode/status#18",
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
      "independentAssignmentBoundary/return#8",
      "independentAssignmentBoundary/status#1", "independentAssignmentBoundary/status#3",
      "independentAssignmentBoundary/status#6",
    ],
  },
  "foundation-review-handoff": {
    disposition: "integrity-fence",
    proof: "Reassessment or pause must authenticate the same original Foundation case and its source-linked Review boundary before continuing",
    regression: ["test/generation.test.ts", "review-session-unavailable"],
    sites: ["recoveryNode/return#21", "recoveryNode/status#17"],
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
      "runStoryGeneration/status#5", "runStoryGeneration/status#7",
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

// R14I: the nested interrupt, receipt and public dispatch gates are reviewed together.
test("R14I author questions retain the reviewed receipt and nested resume gates", () => {
  const gates = [
    [
      "src/generation-author-question.ts",
      "createGenerationQuestionGraph",
      "302856f281f371c16818d1118b4eabc7de709b6079d568e1c310d045538c6f73"
    ],
    [
      "src/generation-author-question.ts",
      "pendingGenerationQuestion",
      "4376bc0c45d0b770789dc5d609ce385da91aed10d90d4d9636e1757751bc131b"
    ],
    [
      "src/generation-author-question.ts",
      "generationQuestionResume",
      "ff8c3e2bb3b500f1586122108b03a53b67f065ec0e262a6822e0c2e1d172736e"
    ],
    [
      "src/specialist-choice.ts",
      "bindSpecialistChoice",
      "55fc68ea45ba4062e7084f1732a5bae18f5966a93d11c69840e1147f972ad887"
    ],
    [
      "src/specialist-choice.ts",
      "answerSpecialistChoice",
      "8f6e0e2fce6de75836a218792d375e51a896cc0e7576dec5f9226891e048f414"
    ],
    [
      "src/specialist-choice.ts",
      "claimSpecialistChoice",
      "c61320116c867b978af9d0242485d9c72c2cce99835495dd1fe3626536c13aad"
    ],
    [
      "web/src/agent-runner.ts",
      "runPersistedGeneration",
      "e0454188ffdcdd9611e6d6c2b3347f02581b504412ddc41ab5aea7d4b2e2b804"
    ],
    [
      "web/src/lib/generation-controls.server.ts",
      "verifiedResumeAdmission",
      "2810d077eaf00869e4990fb1beb831ac936f0b26177f41e8972d81a2dcbac190"
    ],
    [
      "web/src/lib/author-interactions.server.ts",
      "authorInteractionRequest",
      "96162f4721610e0ee8d8fe2a61616cb857ce1540cc451870d96f54a86afd1870"
    ]
  ];
  const printer = ts.createPrinter({ removeComments: true });
  for (const [path, name, expected] of gates) {
    const source = ts.createSourceFile(path!, readFileSync(path!, "utf8"), ts.ScriptTarget.Latest, true);
    const body = helpers(source).get(name!);
    assert.ok(body, name);
    assert.equal(createHash("sha256").update(printer.printNode(ts.EmitHint.Unspecified, body, source)).digest("hex"), expected, name);
  }
});
