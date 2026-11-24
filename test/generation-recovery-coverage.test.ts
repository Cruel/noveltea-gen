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
  assess_recovery: "returns:22,status:8,blocked:1,reconcile:1,throws:14",
  author_update_intake: "returns:22,status:4,operationFailure:8,authorBoundary:1,reconcile:2,throws:1",
  idea_integration: "returns:5,status:1,operationFailure:1,throws:5",
  verify_idea_integration: "returns:5,status:1,operationFailure:3,reconcile:1,throws:4",
  specialist_dispatch: "returns:22,status:1,blocked:1,operationFailure:7,throws:7",
  dependency_amendment: "returns:5,blocked:1,operationFailure:1,authorBoundary:1,throws:7",
  independent_assignment_review: "returns:8,status:2,operationFailure:1,throws:1",
  verify_committed_work: "returns:8,status:6,blocked:1,operationFailure:2,reconcile:2,throws:6",
  completion_decision:
    "returns:10,status:2,blocked:1,operationFailure:3,authorBoundary:2,reconcile:1,throws:2",
  reconcile: "returns:13,status:6,operationFailure:2,throws:9",
  authorBoundary: "returns:4,status:1,blocked:1,operationFailure:1",
  independentAssignmentBoundary: "returns:8,status:2,operationFailure:2,throws:7",
  operationFailure: "returns:3,status:1,blocked:1",
  blocked: "returns:1,status:1",
  runStoryGeneration: "returns:5,status:10,blocked:6,reconcile:1,throws:19",
  observeNodeOutcome: "returns:3,status:2,blocked:1,operationFailure:1,throws:1",
  recoveryNode: "returns:28,status:21,throws:16",
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
          callback.arguments.length === 3 &&
          callback.arguments[2]!.getText(source) === "executionOwner" &&
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
    [file, "requireGenerationTurn", "6659df361f454e0df2946268bcb5b14eae21c85711ed16b0859195aced5c8a65"],
    [file, "dispatch", "1405fcbbacbf4ce2dc8ee8be2a0fd75aaf3bcbdfca5b67f4d687a19281f326ad"],
    [file, "runFoundationAssignmentChild", "09eceae0c76ac0f082fc2eb896625a6c89bb4d9f0e741e0bbdfdc0f44d153bfa"],
    [file, "runArchitectureAssignmentChild", "3a202a428fc66d7eebec3b36525a0abb4c6829efeeda4fabbeb26d626b8270ec"],
    [file, "runCharacterWorldAssignmentChild", "c1418e1291033e04dfccb75524e2dc68a149012a8dd04dbf541639af7797cccf"],
    [child, "assignmentChildConfig", "0f3ddbb4224e60f73a9b5aa6035ebdc13a9740cbe09e598077467f0b4653e69a"],
    [file, "runNarrativeAssignmentChild", "da92777ef036d52db7c074bc7382a54cbcfb46ae4e4192e0faf0ca8d11cd44bd"],
    [file, "runReviewPrerequisiteChild", "738607cc1a495fe1cb04495cb7eef5e850aebc94d76d1d2ce05ef442135ea4c7"],
    [file, "pendingNarrativeForResume", "fd9a869e198615e191c6143a4e8cb75fe4fc3d79c5cce6ccdecd923aafa8131d"],
    [file, "inspectOriginalSpecialistCommitForResume", "9f127bc2631027cef2b60ef0181883dfebe1210e8470afb6a775283ff7d54d1f"],
    [child, "usesSharedAssignmentReview", "7698acfab91148b916f81886f703eea2a19ca44cbe423c718dd4990e1a7ed850"],
    [file, "runFocusedAssignmentChild", "d043dfddc8ca519905d15f238fc01a78b0b195423f6b6834d416c0f99f97e0eb"],
    [child, "createAssignmentLifecycleGraph", "2a87c9cbb00d9e8b0976b5b47e94e727cef545a30058d1694995166b82d7b82c"],
    [child, "authenticateAssignmentReentry", "90158a424c4a0b1df02b8a4cc77652b4e29cbcb2bca4ffae55127b65350e3cb2"],
    [writer, "subunitRoundProof", "e96aea128cea5b5684c76de341552399255a2ed79329e8c161e4552a278a514a"],
    [writer, "subunitWriterResult", "f37d39dce1f50b1cb032b235712bd6e37ef55f1de8b7b3dc36b0b1ea0ab05e56"],
    [file, "subunitReviewTransitions", "85e722272a5d9a7ef49fc61b4c8ab586d589dd5291dd47fe7ba31c90527d2d89"],
    [file, "subunitReviewStop", "5b7e96dad34ab860a37d5db77dfeb55a86ae88889fc43262a5ee6d727650460a"],
    [file, "runInteractiveAssignmentChildren", "f5dc7b1cdb3b79fc0d1eb02a3a8f467cdc676a809e491e9d2478625c5b186d09"],
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
    ["generation.ts", "assignmentDiagnosticReentry", "ef255fac3b7e8858f7a9e8aada11d80ae3c302a0fc21a92fe978ae3f580d7977"],
    ["generation-operation-strategy.ts", "diagnosticWriterSupported", "c974032c48909d559d3d3ee1ac4b6508b9fe3ff470b303365456b2183a20df6b"],
    ["assignment-metadata-recovery.ts", "assignmentCommittedEffect", "93b907f948a50712626f425882e99831814a8c415df386b96a6ccd476ecb76d0"],
    ["architecture.ts", "verifyArchitectureReviewOrigin", "25b8c3375ae9dba2a2d41130039c8e76753213a983e60bd9034f4452b9a945a2"],
    ["architecture-record-path.ts", "assertArchitectureProseOnly", "ac479eb4f6b301377ec271ad822088125bc772799f4afdcdf6a3481308a3fa3b"],
    ["architecture-draft-review.ts", "verifyArchitectureDraftReviewPin", "f4cd5b5b184d7b29b61df9b45133646b7f06b9d9e035caee6fe5bb45aff67c8a"],
    ["event-work.ts", "inspectEventFailure", "7e70b02b5c1f5239c66338efc0ff5e6f5d85ec6c6bf4444e9caeecf50571509d"],
    ["interactive-work.ts", "inspectInteractiveFailure", "265994bf883e4ad5d39f772c0dbd5cd1d4a7c1b0de19864ce6ca9f026e0ea5b0"],
    ["character-world.ts", "inspectCharacterWorldFailure", "5e357bd9e7cc39a609641af9dcd8ba08aa5ecf19ee25a5f53d5e67f85ef13740"],
    ["architecture.ts", "inspectArchitectureFailure", "b5da997ec0c293d43597715fe08d39e1b210987edafd6f7eaefa04fd49da98c9"],
    ["specialist-choice.ts", "focusedChoiceStates", "ad665f521e69d0aa11077b57d0fd848b1b145dfbbe1b012e87c4178bb85bb402"],
    ["review-repair-amendment.ts", "deriveReviewRepairAmendment", "6e9b3bb9ccd1e964df02fdd6ea64d95b4d025759b6542f99c88c37938d421bf1"],
    ["rejected-review-repair.ts", "runNativeRepairRound", "a2c6c71dc9178134421a03e54a9b8b3cd17c5592ebcf80620bd0850dc856c739"],
    ["rejected-review-repair.ts", "inspectNativeReviewFailure", "f74e6cb607c9b28de3fa4747dffe5bd7088e5ec131efaa62ad612bf8ee66fecc"],
    ["rejected-review-repair.ts", "nativeRepairSource", "8bf5f0b39fd163323756c8c41a6d44e4438ab8e2790bed3f0728a628881f8742"],
    ["rejected-review-repair.ts", "validateRejectedRepairDraft", "571dad77419f569434a4627573d55723adb7159cb65c29d29eb591e3d423e95d"],
    ["rejected-review-repair.ts", "prepareRepairWriter", "df9dca808f9799ebe386cc26f539f0a1c8c48f1e363c5016234a3342d243397d"],
    ["generation-assignment-lifecycle.ts", "usesCheckpointedReviewRounds", "1908bdf08a97c846c028c5003e3d44a28efe2dd875114b6eb5c1d6a75ba74862"],
    ["generation-review-round.ts", "createReviewRoundTransitions", "f1896bd8831747b53e5d7a8139b3676b1947ba4cc56dc649393467f241283292"],
    ["generation-operation-strategy.ts", "selectOperationStrategy", "90e03bc1520b7c790e6cfc9dc1354b035ab7130d4c582fa9763f882f9c2d1940"],
    ["generation-operation-strategy.ts", "executeOperationStrategy", "6bc435c2f722491aaac2dddc48a90da67f943f97d7d85f832f689b77dae7d9d6"],
    ["generation-recovery-inspection.ts", "inspectModernGenerationRecovery", "d44b7a9c5f7446c8948b8ed690fd2aba854aa57851890bb0cbf594534cc23e45"],
    ["assignment-metadata-recovery.ts", "materialProgress", "2357f7530030b88d019879e4f74c7b8dcaf5f7f93e70a682059395bc07da3869"],
    ["generation-operation-strategy.ts", "diagnosticEvidence", "aa55bf6d8502100f35ba770fd6e5c931608fc28e19134b047c10be875694f541"],
    ["generation.ts", "runAssignmentDiagnosticRecovery", "02c3e849a83a3a6fc014d6ed8b2ccd60f057b5f5fe4ea32b101da49ee5567d97"],
    ["foundation.ts", "inspectFoundationDiagnosticFailure", "8be57baab6b4a0ce1b2821ec78b9f354d4090a1aeccc6f9731df548f236317c8"],
    ["generation-operation-strategy.ts", "assignmentDiagnosticDecision", "3791042364f885f5840ea3ff0d17aca32c497ddb1efc0d01b561ce85b2f7af2e"],
    ["generation-operation-strategy.ts", "assignmentDiagnosticDefects", "28eb9a8c06533c07cd50e3024cb6e9ac5f3b97682a9ad73d2b141fa6d2b04336"],
    ["generation-operation-strategy.ts", "assignmentDiagnosticDecisionForLifecycle", "f4b0c15ad362afd6d0a7cbbb187e75805a3cf065de714d35c3055bab708b2fc5"],
    ["generation-operation-strategy.ts", "authenticateAssignmentDiagnosticDecision", "ef780aeddd5c537e7d7027d9e49b822d77e584e218332d5747ef7a34207ac7f0"],
    ["generation-operation-strategy.ts", "authenticateAssignmentDiagnosticDischarge", "16e39c551d9fa3078d93f92f493b7b84e2537e2df9247c9f0cb0dd53371fc620"],
    ["generation-operation-strategy.ts", "authenticateSettledReviewVerdict", "a6ff727bdc04330fff6ac2ecfadf8316e401b3f31c8ed61351ce5adae286ee75"],
    ["generation-operation-strategy.ts", "originalNoWriteOwnerProof", "b005fe9268531e26262fbe1c304cb070d0b002775d189d4604053e2f9fc500cd"],
    ["generation-operation-strategy.ts", "originalBlueprintAssessment", "c3b30aff57afb910f14ea2fa3db8ea4f4d61b8ba74327a7fc4b0ff81d59a09fc"],
    ["generation-operation-strategy.ts", "originalFailedReviewProof", "80e7225ab1db21a584de1b5fb02167134f80fb7e4b4508eb4ee073bd9972661a"],
    ["generation-recovery-lifecycle.ts", "validDecision", "276ae3c7346b7a2804bf5a579e3151603f0776a3983b5533503c2741e8c80488"],
    ["generation-operation-strategy.ts", "authorizeOperationDiagnosticStrategy", "7341b4448e8a5212ef3b12c7cd88e68889d5bf01b5c3f611bbe34e28f1b8caa6"],
    ["generation-recovery-resolution.ts", "inspectActiveRecoveryResolution", "3f89fec545268c63475bc518b2115ee8696c37c4a0aeb394ffda9f7cd54d097c"],
    ["adaptive-reconciliation.ts", "inspectSettledAdaptiveReconciliation", "9dd191fdf4c3f40172153062906729113097e7ff6943a42531107667a636e6bb"],
    ["adaptive-planner.ts", "inspectCompletedAdaptiveProposal", "fb1991e2c50f7c9cf0d7cb597cde012cf0d1d6eac379a3ca347c77a29a809ac4"],
    ["generation-diagnostic-controller.ts", "authorizeDiagnosticStrategy", "ff2cf049ca089645f6217fd31698d8c5dab32b4e9671b4f5977397fcb3beb458"],
    ["assignment-metadata-recovery.ts", "nativeMetadataDefects", "a0660a5dec21e5c81a2bb8a8a3f39dd5d5d5317fdde3ad896d4e22689434e063"],
    ["assignment-metadata-recovery.ts", "inspectSettledChain", "9ef5b424cc5cecaa981b47b2ee6b1f907a23b787a9b4fb3bdf5a85ac51cf8db7"],
    ["assignment-metadata-recovery.ts", "inspectAssignmentFailure", "67d438fdcf24e535d40514078d0c8e583aa5dee0c0a56b9b653a8c055f687170"],
    ["assignment-metadata-recovery.ts", "executeAssignmentRound", "5bf30230c0b323a25aa4e78454a8d135bbc7c9214c3e7b4ede556701f0a6f870"],
    ["assignment-metadata-recovery.ts", "runAssignmentReceipts", "b3493443325fd730d0d5cb2cea95ee8960f60f8a6c838876d0c675555a67d8cb"],
    ["cross-domain-prerequisite-controller.ts", "preflightCompositionBoundary", "1485e8f736a11e3b77cc1d17a460880d41ae4f24431c3a984e3ca5ddaa4617ec"],
    ["character-world.ts", "runCharacterWorldJob", "b857af3cafdc601a04c520be7d368d2889eef88e786fa4be1a27a1d45345dc2f"],
    ["character-world.ts", "invocationSource", "203ae344e2447dc4efef389cb44649b679f023b641f7fe861ee1ec98908ac04e"],
    ["interactive-work.ts", "runInteractiveWorkItem", "f6b4b51ade30977df703fec8611106546cce46d82ee5e44418be8e8b1a8908e4"],
    ["interactive-work.ts", "interactiveSourceDigest", "05a9b608bc9b0f6f086aa75dee55eae1949885679b5629576ec8c57fe468ed02"],
    ["character-world.ts", "verifyCharacterWorldReviewOrigin", "142e6331451c4480892b21f7e7b7c150c86a6030a0cfc77c8d24a58b5a78cc37"],
    ["character-world.ts", "inspectRecoverableCharacterWorldCommit", "ff7d64d08ab609775cde44af310b0cfef840862325bfe5f1369f72c3ba52875a"],
    ["foundation.ts", "runFoundationJob", "a389a6cbb6c0c9ba5c88d8438596033c9c534df0902f93d7bcbfdde3bb2be464"],
    ["foundation.ts", "executeFoundationGraph", "707e63e9d422b619674aa8aecf4c7bec059ebfd9357db0fcf81e7b1935c88eb4"],
    ["foundation.ts", "piAuthor", "7ddea4dd9f4f529178cd06f47c4052eb80a24949a1cb46d50419ac0d15ec9875"],
    ["foundation.ts", "foundationSourceDigest", "848e2caae6e2ade76b70ceda6c87703519c2a85fbce7dae80544953564aa68e3"],
    ["foundation.ts", "inspectFoundationFailure", "8ea7e6c1ac238a0bc742e7e344e4de30ca1f07a0d10c7ac7564ad4ff6394bf48"],
    ["generation-operation-recovery.ts", "authenticateAssignmentFailure", "bf758b0e9b0580fe744a80a0c1fb9ffc0d32aaa1cb189c5ae8268f40f86d777f"],
    ["generation-operation-strategy.ts", "originalAssignmentFailure", "ed628eeaea110cf32362c325262ba4c1371534e1e5c634706a42b1dbc52dcbb4"],
    ["generation.ts", "authenticateRecoveryOrigin", "54da6d1399ad76f89e3d85e990df26d4baa27ae5828c051aa55976b3c7906adf"],
    ["generation.ts", "recoverySourceHead", "fd6141d99953e6634ecb99c519817c4b211a563257d57e784d044a16a311d181"],
    ["focused-work.ts", "inspectPendingFocusedCommit", "8559cdf8665172eb9726a604c6fbf42ebb2b4251e32e54c895c807fb7743e6ff"],
    ["rejected-review-repair.ts", "executeReviewRound", "e7ee3d797f6b0cb750d0d62d353555b0524dc23261ea4048acc2aa8173c842fb"],
    ["rejected-review-repair.ts", "reviewRoundGrant", "3d2bef4e0a67cec58e809af0190b4a117d8093263dc328e13044a6580d27d8a2"],
    ["rejected-review-repair.ts", "attestNegativeReviewRound", "2708c28d6dda4b162b85c033c6f3e4dbb29930f1dbbfd71dee3675e5f96a6807"],
    ["rejected-review-repair.ts", "rejectedRepairOperations", "dd6fd634b1838fceb3b0de320b545a884b6bc1d4fc10e8b6eeb5c340a7f4f5a5"],
    ["rejected-review-repair.ts", "inspectRejectedRepair", "561faf7be08c333cfe7ffffa8eb49d9ef628c9ccfaf7aac74624b5eca5af382c"],
    ["rejected-review-repair.ts", "beginRejectedRepair", "5e8f8065cf07ed2c6d2f02b70195679bbb0cd196321e73fe6ffa0fabdecc9b43"],
    ["rejected-review-repair.ts", "readRejectedRepairOrigin", "a909fde6faea1380b31400cb0698d9d000e653b51511fc0e18cba3bf463df47b"],
    ["rejected-review-repair.ts", "readVerifiedFailure", "537aa206aad0dab0dcffda5cb2f717c7feb47b587ea0b3b66888be79c06b3a6a"],
    ["rejected-review-repair.ts", "predecessorOrigin", "90d077dffa0ba77b3a88e78f920af6354e7aafb04d36f56d81c0d06b42627986"],
    ["rejected-review-repair.ts", "foundationReviewBoundary", "6d542b8cb1679dc9b89024c845a35f399c39832b31731cf774dfdc2bc94b9907"],
    ["generation.ts", "reviewPrerequisiteIdentity", "0da7c4c792f32db17fc53fd86f1999d6716f8dd6033f4d64115e03e147a950e1"],
    ["focused-work.ts", "inspectFocusedPrerequisite", "87d1343ce5730592beb5f99ee8023e10dcabbc2b711d587ea60ae417ba262b0d"],
    ["focused-work.ts", "focusedInvocationSource", "48438d7bf37a5f941dcb220c325c9961e949226de8b4c7a0c349e1a52d335d74"],
    ["focused-work.ts", "focusedInvocationOptions", "88f96819c1783655ed3b16231750a557c666c4018550423f41c303f3d154d488"],
    ["focused-work.ts", "inspectPendingFocusedInvocation", "a03f63a1f63ef2dfe4993614c5ff5a6a9fa472fb90ea3eeb37b5f90749a6e384"],
    ["focused-work.ts", "inspectFocusedFailure", "ab4657b4c3e436a0ab8965967e0f3a8af13766502d7386abd054da4038b14dff"],
    ["focused-work.ts", "runFocusedWorkItem", "9035c7ad3ed262f07bfb29f7c595df59ce30a4d12c22deed176ef8fbde943ca3"],
    ["event-work.ts", "runEventWorkItem", "cddbcaca162b861b45a7c6a7e3c23ec54b29e5b1c58d93b5a65c576de4c5448f"],
    ["event-work.ts", "eventInvocationSource", "bb2d3f242c24494b33da772668c8764d92084256b5822f75b0123bb298ac9b47"],
    ["dependency-work.ts", "supportingBoundary", "fad02bcf68074d368135eb54027b6dc7009185e49fbaccbe98469e26e936ea8e"],
    ["dependency-work.ts", "supportingWriterRounds", "bcc599e80409ec613505db5f65364782e8164a78d6d8f4d2f9ec21f2b6553f1c"],
    ["dependency-work.ts", "advanceFocusedDependency", "c5922f268d0322c8a1d3dd2fbad2e0f7441c945426f81fb2cba14a678fdc980d"],
    ["dependency-work.ts", "advanceReviewDependency", "7fda85b8e6096430a76e31df224a22eb88ae5bbd1ca2e8837d89b259cfd1d024"],
    ["event-work.ts", "authorFixtureEventRound", "5ff4f944cabb6c1edcb32e1d0f6058ab71e1b3411cea1f09bdcb34bf23803a13"],
    ["event-work.ts", "eventInvocationOptions", "44b04492d8c1cbbcde375a03c04d63aa8506c4ef7e630f7f33423df84a173d8d"],
    ["dependency-state.ts", "finalizeReviewEventDependency", "ce044f10dc685c2008819df852d2b1428a463e7e8e852bb789e4423b10f8075c"],
    ["event-work.ts", "inspectPendingEventInvocation", "ac31f4536bcba270673950f061ccb9bdf3016e0fad383345bfca9427b2658548"],
    ["composition-work.ts", "compositionInvocationSource", "f3ea85c4a35a0255c138a52e80e043d1a45fb498628ee6b938cbb87d6b938501"],
    ["composition-work.ts", "compositionInvocationOptions", "45c26cfea1925cdf92852ebb23036f0fcff84aa11a6133048c72b487a948f417"],
    ["composition-work.ts", "inspectCompositionFailure", "b21d19b9b3446aa33494dfa3ae8c71085e9069882c1cd2c4cf1ac2f152fc8e8f"],
    ["composition-work.ts", "verifyCompositionReviewOrigin", "1f4db98392b5b903bb953c4cfc7942c36092fa17b3e63e36e4a258c5b66c4423"],
    ["composition-work.ts", "runCompositionWorkItem", "7290141e7b9e1483a5dab1e39a1d7105df8b40eaf731e2819e1b51d275e4b0b9"],
    ["composition-specialist.ts", "authorComposition", "24cff1180e70276d9a7bd228e35e09262c42e1265e8b28f6748ed234bd0371d6"],
    ["composition-specialist.ts", "createCompositionReviewCycle", "8fcb737e4b394b94f9a1336a413d26be4ef2f582a479f61b807c8423496cf903"],
    ["composition-specialist.ts", "verifyCompositionRoundAuthority", "c08f29c90eec919aa5cdee7eac1c33e61fc6b37bfb040bc9fc315e0edf7ba5b2"],
    ["composition-specialist.ts", "verifyCompositionReviewPin", "79e6da2606964bba251bc358f886c6c92e7527a8dc46b2a89e7b73adb05b5ea2"],
    ["turn-fulfillment.ts", "prepareTurnFulfillment", "5152b5e8f22cfa479e391b9d038b7058579f0caef4a17387a3e6a4a5e4b5156e"],
    ["turn-fulfillment.ts", "assertMilestoneStageClosure", "0ff93e9f876f5223ab9b9a298b2f5f0106d2e0e3c3325cd6b40ff87659cef67e"],
    ["composition-work.ts", "inspectPendingCompositionInvocation", "b5a6a35ffbfebe02e3c432a047aa616cd50a0af8f093d9e0e3b16a49ab181162"],
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
    altered[20]!.fingerprint,
    original[20]!.fingerprint,
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
    sites: ["assess_recovery/return#2", "assess_recovery/status#1"],
  },
  "original-proof-missing": {
    disposition: "integrity-fence",
    proof: "Original graph task, HEAD, author control, Review/commit or deferred receipt cannot be authenticated",
    regression: ["test/generation.test.ts", "C02 current-format checkpoint tampering cannot grant a new recovery or writer attempt"],
    sites: [
      "schedule/status#4",
      "assess_recovery/return#3", "assess_recovery/return#5",
      "assess_recovery/return#13", "assess_recovery/return#15",
      "assess_recovery/return#16", "assess_recovery/return#20",
      "assess_recovery/status#2",
      "completion_decision/return#6", "completion_decision/status#1",
      "observeNodeOutcome/return#3",
      "recoveryNode/return#3", "recoveryNode/return#4", "recoveryNode/return#6",
      "recoveryNode/return#17", "recoveryNode/return#19", "recoveryNode/return#26",
      "recoveryNode/status#2", "recoveryNode/status#3", "recoveryNode/status#4",
      "recoveryNode/status#5", "recoveryNode/status#14",
      "recoveryNode/status#16", "recoveryNode/status#21",
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
      "assess_recovery/return#8", "assess_recovery/return#17",
      "operationFailure/return#2", "operationFailure/status#1",
    ],
  },
  "adaptive-original-effect-unverified": {
    disposition: "integrity-fence",
    proof: "Only the accepted original adaptive response, exact diagnostic receipt and restored native inventory can discharge the failed parent check",
    regression: ["test/generation.test.ts", "R14H original parent adaptive planner"],
    sites: ["assess_recovery/return#11"],
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
      "independentAssignmentBoundary/status#2",
    ],
  },
  "foundation-diagnostic-resume-proof": {
    disposition: "integrity-fence",
    proof: "Paused successor requires the original settled diagnosis, failure source, current author control and exact writer admission",
    regression: ["test/generation.test.ts", "nonconverging-continue-budget"],
    sites: ["recoveryNode/return#11", "recoveryNode/status#10"],
  },
  "foundation-review-handoff": {
    disposition: "integrity-fence",
    proof: "Reassessment or pause must authenticate the same original Foundation case and its source-linked Review boundary before continuing",
    regression: ["test/generation.test.ts", "review-session-unavailable"],
    sites: ["recoveryNode/return#25", "recoveryNode/status#20"],
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
      "runStoryGeneration/status#6", "runStoryGeneration/status#8",
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
    ["src/generation-author-question.ts", "pendingQuestionBudgetPause", "e738a52e917ec0b8c6ab7100b57d6e1e7691f364205eb76c67aa86246e2aaba0"],
    [
      "src/generation-author-question.ts",
      "createGenerationQuestionGraph",
      "4f1485c01456dbc72cdb86f3104de473fe40217aa940c683505631d72c166027"
    ],
    [
      "src/generation-author-question.ts",
      "pendingGenerationQuestion",
      "86bfd1f9dab19bd8ee628afbd492fbbee6ea7bf530032ca7457093df56fb578f"
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
      "46da81b37712a60655f72f2a1a8ff5bf7548b2eb223763b7cc44b6dc25f3b30c"
    ],
    [
      "web/src/lib/generation-controls.server.ts",
      "verifiedResumeAdmission",
      "d8c9ec622485190e7035f9077136f6bed40a447bdb8760adffe23f0e7710669c"
    ],
    [
      "web/src/lib/author-interactions.server.ts",
      "authorInteractionRequest",
      "f9b7ac826ccdc67ca0b62bc7eb0f43d5a769fbe7feeb801a843a367ae3b59241"
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
