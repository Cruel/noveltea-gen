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
  specialist_dispatch: "returns:24,status:1,blocked:1,operationFailure:9,throws:9",
  dependency_amendment: "returns:5,blocked:1,operationFailure:1,authorBoundary:1,throws:7",
  independent_assignment_review: "returns:8,status:2,operationFailure:1,throws:1",
  verify_committed_work: "returns:6,status:4,blocked:1,operationFailure:2,reconcile:2,throws:3",
  completion_decision:
    "returns:10,status:2,blocked:1,operationFailure:3,authorBoundary:2,reconcile:1,throws:2",
  reconcile: "returns:13,status:6,operationFailure:2,throws:9",
  authorBoundary: "returns:4,status:1,blocked:1,operationFailure:1",
  independentAssignmentBoundary: "returns:8,status:2,operationFailure:2,throws:7",
  operationFailure: "returns:3,status:1,blocked:1",
  blocked: "returns:1,status:1",
  runStoryGeneration: "returns:5,status:10,blocked:6,reconcile:1,throws:19",
  observeNodeOutcome: "returns:3,status:2,blocked:1,operationFailure:1,throws:1",
  recoveryNode: "returns:28,status:21,throws:19",
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
    [file, "reviewProjectionOutcome", "138ca8a19f188c84f23da82df8495b703ce27d724452bfa83397506d9b6129d0"],
    [file, "assertReviewProjection", "e2b2d9f589fe5e8f5cf98d592f6795700d444c2d6a073096f9e67a223113982a"],
    [file, "requireGenerationTurn", "1a85df842b42caff28d214ebf8d516e864751c483a035f87d709bd23447f2d27"],
    [file, "dispatch", "1405fcbbacbf4ce2dc8ee8be2a0fd75aaf3bcbdfca5b67f4d687a19281f326ad"],
    [file, "runFoundationAssignmentChild", "ba6df556faa133610ab6a28b9dbd953786de1a9878049177785ac239e02aa8de"],
    [file, "runArchitectureAssignmentChild", "7b53c67a122144b38135ed4aafcdc1cb5e720e22b47768e0b47b82abff8c00ee"],
    [file, "runCharacterWorldAssignmentChild", "b7f100f0973f37b77c0a1145ad6ded751dcd2ea3c994f008d6e23ff8f70f4e90"],
    [child, "assignmentChildConfig", "0f3ddbb4224e60f73a9b5aa6035ebdc13a9740cbe09e598077467f0b4653e69a"],
    [file, "runNarrativeAssignmentChild", "4897f4ccefdaf3d3c49611c1d165b18c8f2ec796fd74aed4d1a3006bb0053e8e"],
    [file, "runReviewPrerequisiteChild", "a9d78a9b8da7fbe801f1280acfb35e4acb712ae71cff88a6a096e07391fa23ef"],
    [file, "pendingNarrativeForResume", "fd9a869e198615e191c6143a4e8cb75fe4fc3d79c5cce6ccdecd923aafa8131d"],
    [file, "inspectOriginalSpecialistCommitForResume", "9f127bc2631027cef2b60ef0181883dfebe1210e8470afb6a775283ff7d54d1f"],
    [child, "usesSharedAssignmentReview", "7698acfab91148b916f81886f703eea2a19ca44cbe423c718dd4990e1a7ed850"],
    [file, "runFocusedAssignmentChild", "d2cb9d8e56033cfa92b148f2db59f89fdb383d5cbef13cae88a35ebb66785373"],
    [child, "assertAssignmentOutcome", "3c280d3c29240cb9b6b861368ed86b39b33937bf9d47c282412ffd3086c5c073"],
    [file, "reviewPrerequisiteOwner", "9580ea192303d1e3163a016536509f9c1cd000c62081dcbb0c7a225b7c04533b"],
    [child, "createAssignmentLifecycleGraph", "2a87c9cbb00d9e8b0976b5b47e94e727cef545a30058d1694995166b82d7b82c"],
    [child, "authenticateAssignmentReentry", "90158a424c4a0b1df02b8a4cc77652b4e29cbcb2bca4ffae55127b65350e3cb2"],
    [writer, "subunitRoundProof", "e96aea128cea5b5684c76de341552399255a2ed79329e8c161e4552a278a514a"],
    [writer, "subunitWriterResult", "f37d39dce1f50b1cb032b235712bd6e37ef55f1de8b7b3dc36b0b1ea0ab05e56"],
    [file, "subunitReviewTransitions", "b7cb5581c32f64de7237ada735d13ebf659a61c2aea79c45549972238bbf3e66"],
    [file, "subunitReviewStop", "4d72b303bfcc1d4736ff09aada8a1909aa97bb6cc0eecd2f3cc02b2acda3ed02"],
    [file, "runInteractiveAssignmentChildren", "b2d9fda5abcc6ef48142d61b62bb612c67901655eeb945fd90145ba04a1d9609"],
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
    ["cross-domain-closeout-work.ts", "reviewedCloseoutEvent", "a7fb01542ce4fcb50b577bcf70a8f52d12c4d71381bc5a7e62eb45dad9a34c94"],
    ["cross-domain-closeout-work.ts", "advanceCrossDomainCloseout", "d41e954b02d367b23bcb09addb3a14b1b55548c03a0435445e27cde834a9f970"],
    ["selective-revalidation-controller.ts", "authenticateSelectiveImpact", "dfa6c11aad0d737bd3f847cc8195e97cd81ad28aad1f3242e86386df050dcd07"],
    ["recovery-checkpoints.ts", "verifyFinal", "a9f0fe229dd442e305aa20075fdedd9bb3f88d63959819f508df011490e2c9a0"],
    ["generation.ts", "assignmentDiagnosticReentry", "ef255fac3b7e8858f7a9e8aada11d80ae3c302a0fc21a92fe978ae3f580d7977"],
    ["generation-operation-strategy.ts", "diagnosticWriterSupported", "c974032c48909d559d3d3ee1ac4b6508b9fe3ff470b303365456b2183a20df6b"],
    ["assignment-metadata-recovery.ts", "assignmentCommittedEffect", "93b907f948a50712626f425882e99831814a8c415df386b96a6ccd476ecb76d0"],
    ["architecture.ts", "verifyArchitectureReviewOrigin", "25b8c3375ae9dba2a2d41130039c8e76753213a983e60bd9034f4452b9a945a2"],
    ["architecture-record-path.ts", "assertArchitectureProseOnly", "ac479eb4f6b301377ec271ad822088125bc772799f4afdcdf6a3481308a3fa3b"],
    ["architecture-draft-review.ts", "verifyArchitectureDraftReviewPin", "f4cd5b5b184d7b29b61df9b45133646b7f06b9d9e035caee6fe5bb45aff67c8a"],
    ["event-work.ts", "eventFulfillmentDefect", "c0503699c4d20467b9b807a2eaf450dca274873751b163237863af208dc79ba1"],
    ["event-work.ts", "acceptance", "04033f25b080084d0a8c4aed314347990e81f5219723577c41567a165b49c34a"],
    ["milestone-blueprint.ts", "missingMilestoneBlueprintReads", "5b32d2429d59831900720d2a45fb2dea743607f5d54d450937085e96af7d594c"],
    ["milestone-blueprint.ts", "verifyReads", "9b70066d04c530a9146012db8713a8a1db04897c1241432bebf96a9a7cf69a49"],
    ["milestone-blueprint.ts", "milestoneReviewFindingIndex", "86d6270cdb439c5966b492740f14215a47c42a0264e7c3937012d4c97f9ea49d"],
    ["milestone-blueprint.ts", "milestoneReviewContract", "4772a6f5fd7911545a8e8054b7a5bdc7641824327fae7c7eb897b82b2fb7ba69"],
    ["milestone-blueprint.ts", "parseMilestoneBlueprint", "94bceb3bd0af0734c0530bf3ab0c701f9932c080481af1512df0bec739bf96ed"],
    ["milestone-blueprint.ts", "milestoneBlueprintSourceFindings", "7e56a817b16eb0fba0092ab599d41b1fe848e02c1587ac9fc9fba83d45d09386"],
    ["milestone-blueprint.ts", "assertMilestoneSources", "71b74a05bb631b76ccd678c7a44579f6b4e0fb1e9a4d0390d8131682864b3dbd"],
    ["milestone-blueprint.ts", "assertRounds", "e8f0e106a80f3c77afe41cf8d739724887ce30ac299d5cb7463480273d5e9c09"],
    ["milestone-blueprint.ts", "bindCompactReviewEvidence", "3036395c9f067ebb44fa22722dde20d163f7ba1c1fd0c80647fdf7bbd17408fa"],
    ["milestone-blueprint.ts", "milestoneReviewStagnation", "22ff20599cb62cd10eb2189f93a26986f69bde79a1e296358c27066394a19903"],
    ["milestone-blueprint.ts", "milestonePassCorrections", "7a87cca7439bc92a694f30083881bbc355be19b5d3c138d5104f62b54425cca3"],
    ["milestone-blueprint.ts", "independentFindings", "e4a5843c7226a95daff224607ebb63d4333e90225cbd485f76ebb54919509c7a"],
    ["milestone-blueprint.ts", "controllerReviewDisposition", "53b2c83ae651a7b132eab93e6863075fddcc7da1d6c158aea7bf1e9b33f0ab68"],
    ["milestone-blueprint.ts", "readReviewedMilestoneBlueprint", "d680492147fdbf295efb84f1fe6fd74cd8e92879679604084d5ba8222b072e08"],
    ["milestone-blueprint.ts", "parseMilestoneBlueprintReview", "5aeb980849e06698fbe2de6bfc6f439eedbdf6a4b3873f2372ea0077337e3688"],
    ["milestone-blueprint.ts", "runMilestoneDiagnosis", "65e4fb97b069aabdd0b7be06a529f3bcb560d5ee87cc1feb684a8425e32cd61b"],
    ["milestone-blueprint.ts", "correctMilestoneContract", "bdc40bad8d30c61af2a264932568e18bc0ab22c01ebff70ba501021d69d832e5"],
    ["milestone-blueprint.ts", "ensureMilestoneBlueprint", "d383995e5d6f8930acfe54ba3b5d3d15cb71233a94cd349565c10e915a564511"],
    ["recovery-fork.ts", "assertInheritedEventCompletion", "98898fb9673ae7b955d4f2d28a5cd9418c00c6bb493063fdc602112ee1a8f170"],
    ["recovery-fork.ts", "collectRecoveryFork", "0baf75974c2e88a7f11ee796eadd99e639579f651f7ba41294428469194cfd18"],
    ["recovery-fork.ts", "prepareRecoveryFork", "e58dd3b8fa55c8588d372c8eb394ba0d1ff3a407012f790b0440bf40cc1ede48"],
    ["interactive-event-only.ts", "readEventOnlyOmission", "0ac7ca3d392e935c0b77cf5596c3d5f83a3e585f72efd30c77de473cf1a68b54"],
    ["milestone-blueprint.ts", "correctMissingReads", "d08aa56b1d1821f5ff6c38c26e3d6201cc0879ceca0bbd6c0a48281eeabeee91"],
    ["event-work.ts", "inspectEventFailure", "49b7b69ab1e0fd81d788b3afb74a864a4195c148a2cf2d5f08fd85c6bedc0fd6"],
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
    ["generation-review-round.ts", "createReviewRoundTransitions", "823d0bf6a5b8531a457c5460ede94b6c341a045850d8473b3218a9635db47ad9"],
    ["generation-operation-strategy.ts", "selectOperationStrategy", "77702f977904a9fe2c8dee93393c0ac2fb74d7013e67b1fe182eda04e3f12b99"],
    ["generation-operation-strategy.ts", "executeOperationStrategy", "c1efc1af8e7e45fd2af1df44dfb4df669150b7aca9bd8c77a6025a5dbf69e2b8"],
    ["generation-recovery-inspection.ts", "inspectModernGenerationRecovery", "f033d66598913a3a98d91972946f61e1c1f3fe99a7f985961a24ab3813431ff7"],
    ["assignment-metadata-recovery.ts", "materialProgress", "2357f7530030b88d019879e4f74c7b8dcaf5f7f93e70a682059395bc07da3869"],
    ["generation-operation-strategy.ts", "diagnosticEvidence", "c5e45b7e68015b995be3dc0b8f131437ef144d9ead205819a6a490c6b19fb10e"],
    ["generation.ts", "runAssignmentDiagnosticRecovery", "146ba42a4cfe6ea26b6005924fcb54edb8e88dce2c370ba4dbbf52101a492aaa"],
    ["foundation.ts", "inspectFoundationDiagnosticFailure", "8be57baab6b4a0ce1b2821ec78b9f354d4090a1aeccc6f9731df548f236317c8"],
    ["generation-operation-strategy.ts", "assignmentDiagnosticDecision", "3791042364f885f5840ea3ff0d17aca32c497ddb1efc0d01b561ce85b2f7af2e"],
    ["generation-operation-strategy.ts", "assignmentDiagnosticDefects", "a2e950933cb7d3a4b60fbaaf95d524f994c81f3462c544326e560a8ab466e518"],
    ["generation-operation-strategy.ts", "assignmentDiagnosticDecisionForLifecycle", "f4b0c15ad362afd6d0a7cbbb187e75805a3cf065de714d35c3055bab708b2fc5"],
    ["generation-operation-strategy.ts", "authenticateAssignmentDiagnosticDecision", "896a93b29c1ea9a0e17eb79a3239ba55862355c1dd5eff639c6928d0e26a8293"],
    ["generation-operation-strategy.ts", "authenticateAssignmentDiagnosticDischarge", "16e39c551d9fa3078d93f92f493b7b84e2537e2df9247c9f0cb0dd53371fc620"],
    ["generation-operation-strategy.ts", "authenticateSettledReviewVerdict", "a6ff727bdc04330fff6ac2ecfadf8316e401b3f31c8ed61351ce5adae286ee75"],
    ["generation-operation-strategy.ts", "originalNoWriteOwnerProof", "163c6437c19aa1affa48f01f21fbe07392367e4c6f0d73d5f53d179659f5a934"],
    ["generation-operation-strategy.ts", "originalBlueprintAssessment", "c3b30aff57afb910f14ea2fa3db8ea4f4d61b8ba74327a7fc4b0ff81d59a09fc"],
    ["generation-operation-strategy.ts", "originalFailedReviewProof", "80e7225ab1db21a584de1b5fb02167134f80fb7e4b4508eb4ee073bd9972661a"],
    ["generation-recovery-lifecycle.ts", "validDecision", "276ae3c7346b7a2804bf5a579e3151603f0776a3983b5533503c2741e8c80488"],
    ["generation-operation-strategy.ts", "authorizeOperationDiagnosticStrategy", "725c83125749d1f526eb49c71209ab726739e910353d3f8aeb8bc4b875501c84"],
    ["generation-recovery-resolution.ts", "inspectActiveRecoveryResolution", "2ff299db2abfbe2efca960028b4b45f603196df1e89232f62072b764d5954629"],
    ["adaptive-reconciliation.ts", "inspectSettledAdaptiveReconciliation", "9dd191fdf4c3f40172153062906729113097e7ff6943a42531107667a636e6bb"],
    ["adaptive-planner.ts", "inspectCompletedAdaptiveProposal", "fb1991e2c50f7c9cf0d7cb597cde012cf0d1d6eac379a3ca347c77a29a809ac4"],
    ["generation-diagnostic-controller.ts", "authorizeDiagnosticStrategy", "ff2cf049ca089645f6217fd31698d8c5dab32b4e9671b4f5977397fcb3beb458"],
    ["assignment-metadata-recovery.ts", "nativeMetadataDefects", "a0660a5dec21e5c81a2bb8a8a3f39dd5d5d5317fdde3ad896d4e22689434e063"],
    ["assignment-metadata-recovery.ts", "inspectSettledChain", "9ef5b424cc5cecaa981b47b2ee6b1f907a23b787a9b4fb3bdf5a85ac51cf8db7"],
    ["assignment-metadata-recovery.ts", "inspectAssignmentFailure", "67d438fdcf24e535d40514078d0c8e583aa5dee0c0a56b9b653a8c055f687170"],
    ["assignment-metadata-recovery.ts", "executeAssignmentRound", "5bf30230c0b323a25aa4e78454a8d135bbc7c9214c3e7b4ede556701f0a6f870"],
    ["assignment-metadata-recovery.ts", "runAssignmentReceipts", "9b1c994781ab5b1baa6d9b57fd428f6123fcbcb30dbdf5b0bd5fdde4223b03f1"],
    ["cross-domain-prerequisite-controller.ts", "preflightCompositionBoundary", "94902cc6798b2107653b0580fd56b1ce30cc756f9a0b7a9aee8032bcdb5273ea"],
    ["character-world.ts", "runCharacterWorldJob", "8bc5ba62d8035cca6db5bce5feb7149fba09c936c1701f44fa4511a201706e23"],
    ["character-world.ts", "invocationSource", "203ae344e2447dc4efef389cb44649b679f023b641f7fe861ee1ec98908ac04e"],
    ["interactive-work.ts", "runInteractiveWorkItem", "da3b7800619f71f1839abdcc4c8d043f77662c11353cbc14def97dc642ad4bdb"],
    ["interactive-work.ts", "interactiveSourceDigest", "05a9b608bc9b0f6f086aa75dee55eae1949885679b5629576ec8c57fe468ed02"],
    ["character-world.ts", "verifyCharacterWorldReviewOrigin", "142e6331451c4480892b21f7e7b7c150c86a6030a0cfc77c8d24a58b5a78cc37"],
    ["character-world.ts", "inspectRecoverableCharacterWorldCommit", "ff7d64d08ab609775cde44af310b0cfef840862325bfe5f1369f72c3ba52875a"],
    ["foundation.ts", "runFoundationJob", "df542ae13b19b4c967dcbcfd80796d69f3de6a4c7e96c15990e505fd9593ee75"],
    ["foundation.ts", "executeFoundationGraph", "f45f73974f0614a32f36e22bef1750c91ee9eaf74672a51186e301040a1f30ba"],
    ["foundation.ts", "piAuthor", "7ddea4dd9f4f529178cd06f47c4052eb80a24949a1cb46d50419ac0d15ec9875"],
    ["foundation.ts", "foundationSourceDigest", "848e2caae6e2ade76b70ceda6c87703519c2a85fbce7dae80544953564aa68e3"],
    ["foundation.ts", "inspectFoundationFailure", "8ea7e6c1ac238a0bc742e7e344e4de30ca1f07a0d10c7ac7564ad4ff6394bf48"],
    ["generation-operation-recovery.ts", "authenticateNonSpecialistProtocolFailure", "0ee2ca2e7f4478463c8bf413da7b20322be164e032c171f0996a5d5032b715c1"],
    ["architecture.ts", "authenticateArchitectureReviewerFailure", "3e6ee6cc870fb52a9c7e4d33f4b8cf92bd02c7b86cbc9250f86e9adf995564ce"],
    ["architecture-draft-review.ts", "authenticateArchitectureDraftProtocol", "b45806dc648e342a745fcdb934ba8f87919b58d0fbf4e8478fb154ff9c5adf5d"],
    ["composition-work.ts", "authenticateCompositionReviewerFailure", "3ea653a3968b1ba31a348a874caecb7d442949849f142ac154eb9786b945e32a"],
    ["composition-specialist.ts", "authenticateCompositionDraftProtocol", "2cf1804c85e913041b9a60c19ac3d76955ca09b60fbc11696cdd3d3c8f1a7a9e"],
    ["assignment-metadata-recovery.ts", "verifyLatestSettledWriter", "9ef9796b280f6bc3b2b5b079f4fa6039254e3ad3abdd7861d819b2da245cd4cd"],
    ["generation-operation-recovery.ts", "authenticateAssignmentFailure", "bf758b0e9b0580fe744a80a0c1fb9ffc0d32aaa1cb189c5ae8268f40f86d777f"],
    ["generation-operation-strategy.ts", "originalAssignmentFailure", "ed628eeaea110cf32362c325262ba4c1371534e1e5c634706a42b1dbc52dcbb4"],
    ["generation.ts", "authenticateRecoveryOrigin", "a7a5267327561f16994bf024007ae09e5d7a7e56b98e14771bca8314b3817f00"],
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
    ["generation.ts", "reviewPrerequisiteIdentity", "b531060cf6f650da6758c4f2b3371b209688befbe70de995d9b2b5031c6ff8ba"],
    ["focused-work.ts", "inspectFocusedPrerequisite", "87d1343ce5730592beb5f99ee8023e10dcabbc2b711d587ea60ae417ba262b0d"],
    ["focused-work.ts", "focusedInvocationSource", "48438d7bf37a5f941dcb220c325c9961e949226de8b4c7a0c349e1a52d335d74"],
    ["focused-work.ts", "focusedInvocationOptions", "88f96819c1783655ed3b16231750a557c666c4018550423f41c303f3d154d488"],
    ["focused-work.ts", "inspectPendingFocusedInvocation", "a03f63a1f63ef2dfe4993614c5ff5a6a9fa472fb90ea3eeb37b5f90749a6e384"],
    ["focused-work.ts", "inspectFocusedFailure", "ab4657b4c3e436a0ab8965967e0f3a8af13766502d7386abd054da4038b14dff"],
    ["focused-work.ts", "runFocusedWorkItem", "b7a1cb8b20e42112e823a45f4a865d4d82197524a81d3270ee94732e6503b16c"],
    ["event-work.ts", "runEventWorkItem", "8cdfaf95e1807cc79c31e2033488f7b01ef5fc1dae703a2bfdcb052490981cfd"],
    ["event-work.ts", "eventInvocationSource", "bb2d3f242c24494b33da772668c8764d92084256b5822f75b0123bb298ac9b47"],
    ["dependency-work.ts", "supportingBoundary", "fad02bcf68074d368135eb54027b6dc7009185e49fbaccbe98469e26e936ea8e"],
    ["dependency-work.ts", "supportingWriterRounds", "bcc599e80409ec613505db5f65364782e8164a78d6d8f4d2f9ec21f2b6553f1c"],
    ["dependency-work.ts", "advanceFocusedDependency", "63e306db1f757cb123f673fe4f08fa5ddb6a004b9fe3bc80c10647f07f47f38d"],
    ["dependency-work.ts", "advanceReviewDependency", "0f621dc76e371bb5875f814af680c5b32e6c058b1aca239367970f1356087807"],
    ["event-work.ts", "eventInvocationOptions", "44b04492d8c1cbbcde375a03c04d63aa8506c4ef7e630f7f33423df84a173d8d"],
    ["dependency-state.ts", "finalizeReviewEventDependency", "ce044f10dc685c2008819df852d2b1428a463e7e8e852bb789e4423b10f8075c"],
    ["event-work.ts", "inspectPendingEventInvocation", "ac31f4536bcba270673950f061ccb9bdf3016e0fad383345bfca9427b2658548"],
    ["composition-work.ts", "compositionInvocationSource", "f3ea85c4a35a0255c138a52e80e043d1a45fb498628ee6b938cbb87d6b938501"],
    ["composition-work.ts", "compositionInvocationOptions", "45c26cfea1925cdf92852ebb23036f0fcff84aa11a6133048c72b487a948f417"],
    ["composition-work.ts", "inspectCompositionFailure", "b21d19b9b3446aa33494dfa3ae8c71085e9069882c1cd2c4cf1ac2f152fc8e8f"],
    ["composition-work.ts", "verifyCompositionReviewOrigin", "1f4db98392b5b903bb953c4cfc7942c36092fa17b3e63e36e4a258c5b66c4423"],
    ["composition-work.ts", "runCompositionWorkItem", "174aea92e319fc0615b123309d5929894167d23d2c150ce3642418979faf173b"],
    ["composition-specialist.ts", "authorComposition", "24cff1180e70276d9a7bd228e35e09262c42e1265e8b28f6748ed234bd0371d6"],
    ["composition-specialist.ts", "createCompositionReviewCycle", "e8e2262ac7b40d3d788ddf9cbd945dbc545d2b1191c93c37d92fe0ab19edc91f"],
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
    ["onboarding-pi.server.ts", "expectedProposal", "ff60c27e64b95cdde78bd17183dd869b87f8675138157ee152accf4ffc7a54d1"],
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
    ["story-approved-continuation.server.ts", "continueApprovedStoryChat", "74322aebfa339125dc09421e54afff54ac2340a027714e791910854eda147527"],
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
    proof: "Mandatory source-authenticated current Turn before any executable node; historical fixture identity has no authority",
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
    regression: ["test/recovery-diagnostic-proposal.test.ts", "R14H only the independently accepted original adaptive effect can select reconciliation"],
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
    regression: ["test/rejected-review-repair.test.ts", "A claimed passing repair cannot discharge the original Review without an independently verified successor"],
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
    regression: ["test/recovery-diagnostic-proposal.test.ts", "C05 unsupported advice is a typed sealed STOP, never an authorized writer"],
    sites: ["recoveryNode/return#5"],
  },
  "returned-terminal-projection": {
    disposition: "read-only-output",
    proof: "The entrypoint reports a stopped graph checkpoint but cannot create or fulfill a recovery decision",
    regression: ["test/generation.test.ts", "C02 current-format checkpoint tampering cannot grant a new recovery or writer attempt"],
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
      "6f641f43838939359e1082b0a59f4f88ed79596af0f8339f3bade18992e43c59"
    ],
    [
      "web/src/lib/generation-controls.server.ts",
      "verifiedResumeAdmission",
      "a92e9a86e0536bcc193a3d8d0d3b656234fa001d246d7c674b5792c691406381"
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
