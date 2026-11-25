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
  author_update_intake: "returns:23,status:5,operationFailure:8,authorBoundary:1,reconcile:2,throws:2",
  idea_integration: "returns:5,status:1,operationFailure:1,throws:5",
  verify_idea_integration: "returns:5,status:1,operationFailure:3,reconcile:1,throws:4",
  specialist_dispatch: "returns:23,status:1,blocked:1,operationFailure:9,throws:10",
  dependency_amendment: "returns:6,blocked:1,operationFailure:1,authorBoundary:1,throws:7",
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
  recoveryNode: "returns:34,status:27,throws:21",
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
    [file, "runFoundationAssignmentChild", "f231c27ff58e01c57a1e5f9d6ccca415c6e1d55c54b52b2dc9ad35b010a65236"],
    [file, "runArchitectureAssignmentChild", "f84bcb0e8bc4c3dd9f62498ec03fc94e325c70f3fca25ddf3c0860c1a3ccb0aa"],
    [file, "runCharacterWorldAssignmentChild", "26a287ab0dfe3602bb565a32437e5e83c91714f09145ecf78738f939d0725e58"],
    [child, "assignmentChildConfig", "55dd32a48901e6d3ffea2d9703f143c636bb54ac9d7bef9549c980000921f9b4"],
    [file, "runNarrativeAssignmentChild", "bfc69c9df6fcd131420544f5bc9f8f028ad9f13fc62bbabd51a6424f0a86144c"],
    [file, "runReviewPrerequisiteChild", "c6a53b49698b64634f54128c33d3f176101129e6d4c330b84a1bac525b0ef000"],
    [file, "pendingNarrativeForResume", "fd9a869e198615e191c6143a4e8cb75fe4fc3d79c5cce6ccdecd923aafa8131d"],
    [file, "inspectOriginalSpecialistCommitForResume", "9f127bc2631027cef2b60ef0181883dfebe1210e8470afb6a775283ff7d54d1f"],
    [child, "usesSharedAssignmentReview", "94a1b767d9793f9adf285af0e945d041c4c524bbee1590b885c757f97d39e14e"],
    [file, "runFocusedAssignmentChild", "d2cb9d8e56033cfa92b148f2db59f89fdb383d5cbef13cae88a35ebb66785373"],
    [child, "assertAssignmentOutcome", "3c280d3c29240cb9b6b861368ed86b39b33937bf9d47c282412ffd3086c5c073"],
    [file, "reviewPrerequisiteOwner", "f385354092cbfb2bf5d1395667ecc6e4154409fc2b0c5627fdf5e5f07d77c918"],
    [child, "createAssignmentLifecycleGraph", "2a87c9cbb00d9e8b0976b5b47e94e727cef545a30058d1694995166b82d7b82c"],
    [child, "authenticateAssignmentReentry", "90158a424c4a0b1df02b8a4cc77652b4e29cbcb2bca4ffae55127b65350e3cb2"],
    [writer, "subunitRoundProof", "e96aea128cea5b5684c76de341552399255a2ed79329e8c161e4552a278a514a"],
    [writer, "subunitWriterResult", "f37d39dce1f50b1cb032b235712bd6e37ef55f1de8b7b3dc36b0b1ea0ab05e56"],
    [file, "subunitReviewTransitions", "c3d4bd2edf878e8a03deaac15a8f392c89297840b058dd2a3ba84bbd3b47c3e3"],
    [file, "subunitReviewStop", "4d72b303bfcc1d4736ff09aada8a1909aa97bb6cc0eecd2f3cc02b2acda3ed02"],
    [file, "runInteractiveAssignmentChildren", "d6a4016b126502719f7c890f62ae158fa2cc6df159a1d5ff3fcdfd6fe24814b1"],
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


    ["interactive-event-only.ts", "verifyEventOnlyOmission", "31e5ab2ea986ef43ab84e2ccc42b07dc70d7a9842ff5ee13b0c5b1aab39f7e65"],
    ["selective-revalidation-work.ts", "assertRevalidatedEventOnlySource", "d02def5caa23b0757518bf4f0a328d47cf3eade487e9171283765ec2839568f4"],
    ["recovery-checkpoints.ts", "inspectRecoveryCheckpoints", "caa65253b810d7a8ca83a1a9db13088e906f8b5e3b7cb5684009b3fdabd3d8d6"],
    ["recovery-checkpoints.ts", "finalizeRecoveryCheckpoint", "dd22053ec7bef9b6fba47cb0b8d1c63eb9698c1731815ef14ce975d36627fc73"],
    ["checkpoint-assurance.ts", "sealIndependentReview", "5fa98a6e99cd9cba42e4955483cf46c4b6606c8b8610f6546e3a3f23e0e41430"],
    ["semantic-assignment-review.ts", "prepareSemanticReview", "dc328770c95fb72b437196ee8aca87404ea52782e979a4ba98ca1ba2cb800000"],
    ["support-review.ts", "inspectSharedSupportReview", "9057ff0426bab2264e1f6872260cf6ba4d3b397f522ee704ed5eb966a9a7d3e6"],
    ["dependency-state.ts", "inspectDependencyLedger", "b9368d22ee26df2832df2a3ce6b324ce29c48c3c6e618357bc1aab8fe4872fa7"],
    ["postcommit-review-cycle.ts", "inspectPostcommitReviewCycle", "3e8e9ae3411aad8ee4a1d3fdcb0dec8e41ad7fe57f6b70c396e3cf1fca4a18fb"],
    ["recovery-review-batch.ts", "collectReviewedOmissionBatch", "b4e292911a0872cecfdc9f3f86413cb9873c0253bc8fb4d9ff661ff6fdb7a8cd"],
    ["recovery-review-batch.ts", "sealReviewedOmissionBatch", "bece0ddad17be3496256c121988e8dcdc4519518fa53d292248fc1060b1167f6"],
    ["job-successor.ts", "verifiedNarrativeChain", "c0514accd9a5fd06c5e3dc8db2e71ed649dd6e2161d935b4c41e86533ed25581"],


    ["generation.ts", "advanceSuspendedWriter", "d74004482d7de73b46c21368ce363bdcf684469938646bb12d9bfca07722be08"],
    ["generation.ts", "runRetainedInteractiveChoice", "8b3b6d022cbc046c9550a625d7ae383dabda914afdab3612e971b2866a4981a1"],
    ["writer-dependency.ts", "writerPredecessor", "eccbcda9ed655ed972857dfafbc3c709df759b6c77f5ed10763925bc25b8a700"],
    ["writer-dependency.ts", "assertWriterAssignmentRoot", "ebb96da03ac9231f30b7e7f317bb3327f11bac0224492619f447d307faa104dd"],
    ["interactive-work.ts", "retainedChoiceEvidence", "53c138cda98b93b68ebc2f9ced861fd028ad4fa4accbc7facf6a4306c158f7f7"],
    ["interactive-work.ts", "inspectRetainedChoiceContinuation", "9eccb1ab74d1eb92ebbff7093387d93d653e6f4b8de477d97e24db6893fd7af6"],
    ["interactive-work.ts", "prepareRetainedChoiceContinuation", "6f1a88288b712cb3fd75e233e62af4ce1b681a541c0e17b47a4d0195db45077a"],
    ["interactive-work.ts", "inspectRetainedChoiceCompletion", "0a8dac1a331698782d82c2849e949989b32dcf38661f68c1db38cacaef4b998e"],
    ["interactive-event-only.ts", "inspectDeclinedEventOnlyReview", "00e0f7ff6c2acd16af2c602633dac4a77a6868d49187db6e4d93077d6e72fd4b"],
    ["generation-operation-strategy.ts", "executeRetainedChoice", "a527cf49ea2890c2941a9625a0430af1a76ba2dce62db7642a7e9e891f3186bf"],
    ["selective-revalidation-work.ts", "assertCompletedOtherOwnerRevalidation", "c66bb53fcc8bfe5b66f24d442c7123d1d0970db8513fecb3f0c46ed6f679c899"],
    ["event-work.ts", "readEventSourceBlueprint", "751106980d2098c6110e0659186676c230c59559aeb3a46e9d2e7e165b7a3c38"],
    ["writer-dependency.ts", "reconstructWriterDependency", "75ea0ec1ed6a574fb404802e77c6da4ea610b073b3760ac31f683e053b9f16a1"],
    ["writer-dependency.ts", "inspectWriterDependency", "2252737ff9eb06df6b2154edf18d99bed50a6ada4105f613bc3461cc793ed4c0"],
    ["writer-dependency.ts", "verifiedWriterSupport", "d3ed8b2ac9bebb19a83d21ea907eab375ad1e8fffa23edeeb82f402ffa7d2533"],
    ["writer-dependency.ts", "authenticateWriterContinuation", "4c76d6dee30921908daa5a7ed50334f8fab1b35373e512c1460a949dfd266c4f"],
    ["dependency-work.ts", "advanceWriterDependency", "5fa047742acf3d1fd6ba0583fcd82518fa553f27c3b7d80676f0162512c71aed"],
    ["dependency-amendments.ts", "authorizeWriterDependency", "3003b2e11d7dc4adb2504324589b20bf1ba1a4e8c3306d1c686b43b42be0193f"],
    ["dependency-amendments.ts", "parseWriterDependencyFinding", "22f4e8d0b376b88e908446dc1ad867588c40bd0a2751eafb894400785412a1b3"],
    ["event-work.ts", "inspectEventWriterDependency", "5e7484bc560e9897d128a3c3faf2532ae1df309b891b271ea0e49ec066eae793"],
    ["event-work.ts", "archiveEventWriterDependency", "3a41cab28f560d243fe86e9f44dbb6ddaa46d31fd639b6d8bb0b3a632dc60e9b"],
    ["event-work.ts", "rebindEventAfterWriterDependency", "35a6224df569d9d98506e8236dd5f824bd5f36b951c4062b3af6cec5bce7deda"],
    ["event-work.ts", "blueprintOwnerSeal", "18eee1f25019c4654154778e314d2369877be3fbb51721eb6df9068dcab37612"],
    ["composition-work.ts", "inspectCompositionWriterDependency", "11669fa6b1e265110a0447de98ba24e6a6e2d5d41efc5fe22b246a0361ee0cbf"],
    ["composition-work.ts", "archiveCompositionWriterDependency", "b1fdea3a73118cef0b011608b6554e97ac730455af21bb5b1c48670389031c10"],
    ["composition-work.ts", "rebindCompositionAfterWriterDependency", "619906d5962769ade96867fa9e75834f4359553eeeb2347401dd1d5ea21e36ea"],
    ["interactive-work.ts", "inspectInteractiveWriterDependency", "b074870a775cc5fdbc376e0eff71e6ac1fc35e8bfd6474005783fc84cb211e56"],
    ["interactive-work.ts", "archiveInteractiveWriterDependency", "e3b9b93a50968ad192ff91d27d72fd9b711320c1e3679c79e1853fd94409c7de"],
    ["interactive-work.ts", "rebindInteractiveAfterWriterDependency", "c37cf58d380df2ca0c077484d67de30c164b7422fe4aca97708a1764da33f672"],
    ["cross-domain-closeout-work.ts", "reviewedCloseoutEvent", "a7fb01542ce4fcb50b577bcf70a8f52d12c4d71381bc5a7e62eb45dad9a34c94"],
    ["cross-domain-closeout-work.ts", "advanceCrossDomainCloseout", "7982047771bc760b282a61e63566e58101a6f64dbbdb6d64edefbda227f92924"],
    ["selective-revalidation-controller.ts", "authenticateSelectiveImpact", "e299cc0569a954f4d33bde14f2c55c0e1107fc511c6a4790c553c9d6e5632fc6"],
    ["recovery-checkpoints.ts", "verifyFinal", "49829bf48fc8af6d93b88a78cb989c21cff783f3e7af03829988ab7d3319759d"],
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
    ["milestone-blueprint.ts", "parseMilestoneBlueprint", "f3d11f0209a42849e3008974979b2ce3430b71b5a7a4d6dda8ad387b0551ef02"],
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
    ["milestone-blueprint.ts", "runMilestoneDiagnosis", "2b56462abcac62d8f326685888346c62f4533196c004e2c2f5843f96c1f97a2e"],
    ["milestone-blueprint.ts", "readAssessmentMilestoneStop", "a485595a3c5fe2b73d719d3b78a3e55668e8c11bf3b85d4f97c346e83813a1f0"],
    ["milestone-blueprint.ts", "correctMilestoneContract", "bdc40bad8d30c61af2a264932568e18bc0ab22c01ebff70ba501021d69d832e5"],
    ["milestone-blueprint.ts", "ensureMilestoneBlueprint", "e6d287f5c25a95b1ba7cc65a5921a9d1b28df72dc6267d02b369975b75e2f00b"],
    ["recovery-fork.ts", "assertInheritedEventCompletion", "98898fb9673ae7b955d4f2d28a5cd9418c00c6bb493063fdc602112ee1a8f170"],
    ["recovery-fork.ts", "collectRecoveryFork", "0baf75974c2e88a7f11ee796eadd99e639579f651f7ba41294428469194cfd18"],
    ["recovery-fork.ts", "prepareRecoveryFork", "e58dd3b8fa55c8588d372c8eb394ba0d1ff3a407012f790b0440bf40cc1ede48"],
    ["interactive-event-only.ts", "readEventOnlyOmission", "0ac7ca3d392e935c0b77cf5596c3d5f83a3e585f72efd30c77de473cf1a68b54"],
    ["milestone-blueprint.ts", "correctMissingReads", "d08aa56b1d1821f5ff6c38c26e3d6201cc0879ceca0bbd6c0a48281eeabeee91"],
    ["event-work.ts", "inspectEventFailure", "49b7b69ab1e0fd81d788b3afb74a864a4195c148a2cf2d5f08fd85c6bedc0fd6"],
    ["interactive-work.ts", "inspectInteractiveFailure", "773a6e58b50f7b5067ada48de0101d9bd06738e35568bc7aa41ca443e6926512"],
    ["character-world.ts", "inspectCharacterWorldFailure", "5e357bd9e7cc39a609641af9dcd8ba08aa5ecf19ee25a5f53d5e67f85ef13740"],
    ["architecture.ts", "inspectArchitectureFailure", "b5da997ec0c293d43597715fe08d39e1b210987edafd6f7eaefa04fd49da98c9"],
    ["specialist-choice.ts", "focusedChoiceStates", "ad665f521e69d0aa11077b57d0fd848b1b145dfbbe1b012e87c4178bb85bb402"],
    ["review-repair-amendment.ts", "deriveReviewRepairAmendment", "6e9b3bb9ccd1e964df02fdd6ea64d95b4d025759b6542f99c88c37938d421bf1"],
    ["rejected-review-repair.ts", "runNativeRepairRound", "7c2c4f7b09d278c0fe6c537f46ca1e71ba738cbad8e92e452d83e9ec9d37cfe0"],
    ["rejected-review-repair.ts", "inspectNativeReviewFailure", "c405cf63987e1af50a54b9a6c4ea32e36f017c6abd240e3f95175851764cb512"],
    ["rejected-review-repair.ts", "nativeRepairSource", "8bf5f0b39fd163323756c8c41a6d44e4438ab8e2790bed3f0728a628881f8742"],
    ["rejected-review-repair.ts", "validateRejectedRepairDraft", "5b2068cdbfc57d18377ec66fe475ab64c6edd18c26f4d916cab9a99815d14379"],
    ["rejected-review-repair.ts", "prepareRepairWriter", "8582aad26bcf2a89e70e1b3e340ccbf203c2423557c45fbfc8e99d4596cf7980"],
    ["generation-assignment-lifecycle.ts", "usesCheckpointedReviewRounds", "5e682931077703464285e3de6c13e8f3e1fd2fb6a91b9e79437313fffcc83c3f"],
    ["generation-review-round.ts", "createReviewRoundTransitions", "823d0bf6a5b8531a457c5460ede94b6c341a045850d8473b3218a9635db47ad9"],
    ["generation-operation-strategy.ts", "selectOperationStrategy", "de3d18c2d4fa6713b1ea9acafd52fb12c4def41d9375d3834f0695d447348565"],
    ["generation-operation-strategy.ts", "executeOperationStrategy", "a60b8d007f23064f75eb705a0876512e38a16a46759783981824bbd77dffcc45"],
    ["generation-operation-strategy.ts", "blueprintAssessmentStop", "d18de3c4d3096c9e251cd011887d35b29499b503b29e2849965e0b014aab3269"],
    ["generation-operation-strategy.ts", "pausedBlueprintDependencyDecision", "7701b72cd746f2c4b558e9ff24d8243a4152c30c03639e3c7e958bcb34c2982f"],
    ["dependency-work.ts", "inspectBlueprintSupportProgress", "3e69a34c4504fcf9c8c92447455ce81545bec4c1163d18eeb60fb3b799fa2615"],
    ["dependency-work.ts", "inspectInterruptedBlueprintSupport", "192b8e7b2351904d29884d64b3d3926387afa6636a4321ea20be74c3fdfcff21"],
    ["generation-recovery-inspection.ts", "inspectModernGenerationRecovery", "5e570242c5b10022ce0bf51a2f0a424e7eea942229578c062a63e86a25b286f0"],
    ["assignment-metadata-recovery.ts", "materialProgress", "2357f7530030b88d019879e4f74c7b8dcaf5f7f93e70a682059395bc07da3869"],
    ["generation-operation-strategy.ts", "diagnosticEvidence", "cc6d2c83b075f9e8e25e7ee5cc57fbf444f18ae17b335d69f127418a6b65129c"],
    ["generation.ts", "runAssignmentDiagnosticRecovery", "d11bc78dea972ebebfb7fbae2b1d5fd32405cfa72527cdbc41992ac048937635"],
    ["foundation.ts", "inspectFoundationDiagnosticFailure", "8be57baab6b4a0ce1b2821ec78b9f354d4090a1aeccc6f9731df548f236317c8"],
    ["generation-operation-strategy.ts", "assignmentDiagnosticDecision", "3791042364f885f5840ea3ff0d17aca32c497ddb1efc0d01b561ce85b2f7af2e"],
    ["generation-operation-strategy.ts", "assignmentDiagnosticDefects", "a2e950933cb7d3a4b60fbaaf95d524f994c81f3462c544326e560a8ab466e518"],
    ["generation-operation-strategy.ts", "assignmentDiagnosticDecisionForLifecycle", "d015d2421dddb90853dd08efd2f2c4cf675d713a7dfb8dcd8672041d2a2c3b07"],
    ["generation-operation-strategy.ts", "authenticateAssignmentDiagnosticDecision", "896a93b29c1ea9a0e17eb79a3239ba55862355c1dd5eff639c6928d0e26a8293"],
    ["generation-operation-strategy.ts", "authenticateAssignmentDiagnosticDischarge", "16e39c551d9fa3078d93f92f493b7b84e2537e2df9247c9f0cb0dd53371fc620"],
    ["generation-operation-strategy.ts", "authenticateSettledReviewVerdict", "a6ff727bdc04330fff6ac2ecfadf8316e401b3f31c8ed61351ce5adae286ee75"],
    ["generation-operation-strategy.ts", "originalNoWriteOwnerProof", "163c6437c19aa1affa48f01f21fbe07392367e4c6f0d73d5f53d179659f5a934"],
    ["generation-operation-strategy.ts", "originalBlueprintAssessment", "c3b30aff57afb910f14ea2fa3db8ea4f4d61b8ba74327a7fc4b0ff81d59a09fc"],
    ["generation-operation-strategy.ts", "originalFailedReviewProof", "80e7225ab1db21a584de1b5fb02167134f80fb7e4b4508eb4ee073bd9972661a"],
    ["generation-recovery-lifecycle.ts", "validDecision", "7414e9b2e37ec0dbbb30c275049eff581cc16ba11e933bb4a1bf75f24997d12e"],
    ["generation-operation-strategy.ts", "authorizeOperationDiagnosticStrategy", "678b03cfa5c166bb3d958b107e771e1a93a78c8074d4671c4e412da23b6cfad4"],
    ["generation-recovery-resolution.ts", "inspectDeferredCorrection", "997c10ec224db61292c1877302f2f33efa8b5e0819512e1b8e73c544b0c3853e"],
    ["generation-operation-strategy.ts", "nativeReviewDiagnosticDecision", "a1dc2fdcc06dd9d453098c530d570e122829d607771411d843150491338b8305"],
    ["generation-operation-strategy.ts", "authenticateNativeReviewDiagnostic", "b1ba1da34112b91fbd624d1bd35fb9a2acc1f007f31f569aad0246a9a18f0f02"],
    ["generation-operation-strategy.ts", "pausedNativeReviewDiagnostic", "b8dc9cacf671eeb6365a58b55086631b3b0623116ce84952b7f9798f275f91b5"],
    ["generation-operation-strategy.ts", "authenticatePublishedNativeDiagnostic", "0f460d66988784025093297062ea6e92f25cfea2868eb47b36fcc7ed50fd434f"],
    ["dependency-work.ts", "inspectSupportingNativeFailure", "fc8c3ba5a6a79d0cc06edb013879750422a74e1cd28f6a18220ca2dfa0bb9136"],
    ["assignment-metadata-recovery.ts", "readPublishedDiagnosticGrant", "f20ad5a8959e97eafdcf4eb47025f140136a73f3d8f5638b4bc66fbeb4d11d99"],
    ["focused-work.ts", "inspectPublishedFocusedDiagnostic", "0b115042843a1656061d671ad32c64f76dc4c1bd6dcc357a1aed5a7df935b4f0"],
    ["rejected-review-repair.ts", "inspectPublishedReviewDiagnostics", "b9b439c7f9c54277352542eb171e78b6c94fd9375bd704afcd7f830cee386063"],
    ["rejected-review-repair.ts", "authenticateFoundationReviewHead", "6480bcb3a0afc9e1c25e77dcc00067f63b5f04b556f5252026bbf7f9574e46a7"],
    ["generation-recovery-resolution.ts", "verifyPublishedSupportDiagnostics", "7aeb4ccf7dcb6c57668fb1f9127f92592185d4717aeb8b21cafbc71ea96ff8ea"],
    ["generation-recovery-resolution.ts", "verifyPublishedRepairDiagnostics", "fa38f3d5be22470b64b00f45a628f24798bcc4e9ef69ea0eaca1f23b7af070b4"],
    ["generation.ts", "nativeReviewContinuation", "6453a4f30e22d59d6124a9c9e41acda70a93036d08b18ac61688e0c9d1a9abe0"],
    ["generation-recovery-resolution.ts", "inspectActiveRecoveryResolution", "f01a8a216b22e1ac9282f4e47c02b4e66ef84333c1c9817aa17ba85cd33af77f"],
    ["adaptive-reconciliation.ts", "inspectSettledAdaptiveReconciliation", "9dd191fdf4c3f40172153062906729113097e7ff6943a42531107667a636e6bb"],
    ["adaptive-planner.ts", "inspectCompletedAdaptiveProposal", "fb1991e2c50f7c9cf0d7cb597cde012cf0d1d6eac379a3ca347c77a29a809ac4"],
    ["generation-diagnostic-controller.ts", "authorizeDiagnosticStrategy", "ff2cf049ca089645f6217fd31698d8c5dab32b4e9671b4f5977397fcb3beb458"],
    ["assignment-metadata-recovery.ts", "nativeMetadataDefects", "b021080786566556b6a8dff860de185dfc7f33442b7d7a8e6bd6ac4535d5f0a8"],
    ["assignment-metadata-recovery.ts", "inspectSettledChain", "3f3f08143418775d1da98eb9a3f79ec55a36567185e217cf0c5d6d226ffa31fe"],
    ["assignment-metadata-recovery.ts", "inspectAssignmentFailure", "2bee8f64a1a07f1f2e45ddb537715de9d4a570e1e5db5c96de1d599d8e76fd88"],
    ["assignment-metadata-recovery.ts", "executeAssignmentRound", "5bf30230c0b323a25aa4e78454a8d135bbc7c9214c3e7b4ede556701f0a6f870"],
    ["assignment-metadata-recovery.ts", "runAssignmentReceipts", "9b1c994781ab5b1baa6d9b57fd428f6123fcbcb30dbdf5b0bd5fdde4223b03f1"],
    ["cross-domain-prerequisite-controller.ts", "preflightCompositionBoundary", "94902cc6798b2107653b0580fd56b1ce30cc756f9a0b7a9aee8032bcdb5273ea"],
    ["character-world.ts", "runCharacterWorldJob", "fe7761f390412c8819bd1444b3191be32b1a42417d2a81f418f905ebd7e77f82"],
    ["generation.ts", "writerSourceMatches", "1de1a0ac55ee97ffc9880a8e9dd01d2ac175e7b6772217f422c719b4192e765a"],
    ["character-world.ts", "verifyUnitInvocation", "bfdf4c5c73e67d7e98e67fcc02e831c1b5a72f60043d080a262fc1d2b898fdc8"],
    ["character-world.ts", "inspectFoundationConflict", "c0725ed9d8df3ea0ef97eadb0b8934adabd7cd9afec4df04b136753568500b46"],
    ["character-world.ts", "inspectCharacterWriterDependency", "b5a667d9df1c5c34cd77be62aa4ee18cea51c09584b6be678197786b49442c9b"],
    ["character-world.ts", "archiveCharacterWriterDependency", "3d3dc0ad648557410f5b93ed1d9cad463907fb4e26f13926de6cf7a2c61c4071"],
    ["character-world.ts", "rebindCharacterAfterWriterDependency", "9a4425814b79b200e53034b458ded4f2d0f0d9173ba6c48b73cc8cb53894de36"],
    ["character-world.ts", "verifiedCharacterSource", "5b3bb9d8d04d142b4ec01436ee45b84afb3cb8b8c66ba735576408c1e950d76e"],
    ["character-world.ts", "invocationSource", "56c4050e51818069564a78fe397729a4358e5e2cb60c011be2dc7c40486d5ef4"],
    ["interactive-work.ts", "runInteractiveWorkItem", "7e4d86288371198f19ba2a300ba964f6eebf9ce1c284254f91ad3c87ccd534a8"],
    ["interactive-work.ts", "inspectInteractiveConflict", "6767683261f7a1d915bd74b073ee479499eaf96883aaf08d074f212375dfb845"],
    ["interactive-work.ts", "interactiveSourceDigest", "ffa09edfe0c3e4ec894c56f8c2f9abd861ffbf0f3d52561acab86dfcc5973423"],
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
    ["generation-operation-strategy.ts", "originalAssignmentFailure", "4ba5a5638a7ab6c78126da02420327f718825efad2c9119d6e3015c2be0802fa"],
    ["generation.ts", "authenticateRecoveryOrigin", "a7a5267327561f16994bf024007ae09e5d7a7e56b98e14771bca8314b3817f00"],
    ["generation.ts", "recoverySourceHead", "f0c34d2cdae2d2422973a500c67306f9b0849a5186d4e77bf83309ff2cdc0f40"],
    ["focused-work.ts", "inspectPendingFocusedCommit", "8559cdf8665172eb9726a604c6fbf42ebb2b4251e32e54c895c807fb7743e6ff"],
    ["rejected-review-repair.ts", "executeReviewRound", "4629198e8d7ffe17f09c2383e5e7178a3eb7f70b901859291e053ea57a9e6336"],
    ["rejected-review-repair.ts", "reviewRoundGrant", "3d2bef4e0a67cec58e809af0190b4a117d8093263dc328e13044a6580d27d8a2"],
    ["rejected-review-repair.ts", "attestNegativeReviewRound", "2708c28d6dda4b162b85c033c6f3e4dbb29930f1dbbfd71dee3675e5f96a6807"],
    ["rejected-review-repair.ts", "rejectedRepairOperations", "dd6fd634b1838fceb3b0de320b545a884b6bc1d4fc10e8b6eeb5c340a7f4f5a5"],
    ["rejected-review-repair.ts", "inspectRejectedRepair", "561faf7be08c333cfe7ffffa8eb49d9ef628c9ccfaf7aac74624b5eca5af382c"],
    ["rejected-review-repair.ts", "beginRejectedRepair", "3f167b9a2651878cc5832c6dae6d83c8a01b589e231b25fd00fc818fb48838b5"],
    ["rejected-review-repair.ts", "readRejectedRepairOrigin", "efcf885b4be84b976b67aef91dced7695fa30514e5805bddeebb012330ec0111"],
    ["rejected-review-repair.ts", "readVerifiedFailure", "537aa206aad0dab0dcffda5cb2f717c7feb47b587ea0b3b66888be79c06b3a6a"],
    ["rejected-review-repair.ts", "predecessorOrigin", "90d077dffa0ba77b3a88e78f920af6354e7aafb04d36f56d81c0d06b42627986"],
    ["rejected-review-repair.ts", "foundationReviewBoundary", "ffc08679e9e09e0409fb1a8926962ae2a74227671786db461f9e06b99a0769a6"],
    ["generation.ts", "reviewPrerequisiteIdentity", "b531060cf6f650da6758c4f2b3371b209688befbe70de995d9b2b5031c6ff8ba"],
    ["focused-work.ts", "inspectFocusedPrerequisite", "3d153f3740d502f02a10f3d8d294b2713d080fdf881a20b02e2e80dc74c3783f"],
    ["focused-work.ts", "focusedInvocationSource", "48438d7bf37a5f941dcb220c325c9961e949226de8b4c7a0c349e1a52d335d74"],
    ["focused-work.ts", "focusedInvocationOptions", "88f96819c1783655ed3b16231750a557c666c4018550423f41c303f3d154d488"],
    ["focused-work.ts", "inspectPendingFocusedInvocation", "a03f63a1f63ef2dfe4993614c5ff5a6a9fa472fb90ea3eeb37b5f90749a6e384"],
    ["focused-work.ts", "inspectFocusedFailure", "61ecacb3806edc685caa0f44e4299554da8dda7aab435e90f9e36c75655dab13"],
    ["focused-work.ts", "runFocusedWorkItem", "c5f915330066612dfe5a86eaede13ec3b29b3590151a15516aa7fba5c0bbd779"],
    ["event-work.ts", "authenticateSettledEventNoWrite", "5330381dc30d34375da675395af9e2fbd48816632527e4934973d9d9e31334df"],
    ["event-work.ts", "inspectEventNoWrite", "bf55c173fcaa02f440b98051141950ed77972086228016b315a5267b734b1626"],
    ["causal-amendment-controller.ts", "inspectCausalAmendment", "27757bc63b0627227779b299eebef0d49900365ec26d3de6b3ac2e494d046187"],
    ["architecture-approval-revisions.ts", "originalEvent", "dc6117a2fa57e9662d087e220310712f2297e155244118de288edcfaa669b15c"],
    ["dependency-state.ts", "reviewOtherOwnerCheckpoint", "59a78a9b38cd9a2f4564eb3c8b12578ae5cac60f60e52e9e8cf478180b3eb10e"],
    ["review-other-owner-revalidation.ts", "revalidateOtherOwnerPrerequisite", "8dd19ea5dd3e46f9cd52dab6cf6bfb28f7792a056ddf6ee1178f1ac93e847c12"],
    ["event-work.ts", "runEventWorkItem", "f64e73d8f84a0b1c16e42c515251e17254125de73cc89395e20ac3ca7178654c"],
    ["event-work.ts", "eventInvocationSource", "b102eea641621ec9062e0b2fabe7279372a2845311229233d1087762e723c654"],
    ["dependency-work.ts", "supportingBoundary", "5da59830a82f9f2dcce30c46005aba1dfa67024cd1df6e7fafa81b27c9db7279"],
    ["dependency-work.ts", "supportingWriterRounds", "b10014dba9b70035de7f17a7cf70864fc919b10f7c1a74245c357ab9859627fb"],
    ["dependency-work.ts", "runSupportingChild", "1fd002a38983ab1c1cdf02214a550cd80f2b8af7b6609d3743266410f4634684"],
    ["dependency-work.ts", "supportingSuspension", "e86a1fd3b378162b839a5dbcbf804e7520b8b3c8b259a4aa0b09f0983fe2dadc"],
    ["dependency-state.ts", "dependencyWriterBase", "2fb297d20ae780f12979b08a1b331187e8d0d59c7eb937679307eb89a71e5b75"],
    ["dependency-state.ts", "dependencyAncestors", "8e60f688f2f457c28e9b868daddd7acd00cbd8ee09a1d9266aa6a4a512652d1b"],
    ["dependency-work.ts", "advanceFocusedDependency", "b94122c8ea3e6ecf2b146a5ac079e5eea340f183c57153f051d267f221aa8476"],
    ["dependency-work.ts", "advanceReviewDependency", "814b3657c555c53058f79a1e656e76f832557c3256369460a4697d34b134e741"],
    ["event-work.ts", "eventInvocationOptions", "44b04492d8c1cbbcde375a03c04d63aa8506c4ef7e630f7f33423df84a173d8d"],
    ["dependency-state.ts", "finalizeReviewEventDependency", "5d2988750dc05d50afff99bd40395fd62c1240fc019ab5264d4b39f80edab66f"],
    ["event-work.ts", "inspectPendingEventInvocation", "ac31f4536bcba270673950f061ccb9bdf3016e0fad383345bfca9427b2658548"],
    ["composition-work.ts", "compositionInvocationSource", "73c410e1f242c123c8e7c62cbe33409aef08a331a32470e019867169c867581a"],
    ["composition-work.ts", "compositionInvocationOptions", "45c26cfea1925cdf92852ebb23036f0fcff84aa11a6133048c72b487a948f417"],
    ["composition-work.ts", "inspectCompositionFailure", "b21d19b9b3446aa33494dfa3ae8c71085e9069882c1cd2c4cf1ac2f152fc8e8f"],
    ["composition-work.ts", "verifyCompositionReviewOrigin", "1f4db98392b5b903bb953c4cfc7942c36092fa17b3e63e36e4a258c5b66c4423"],
    ["composition-work.ts", "runCompositionWorkItem", "9edaa20b591fc282cbc247276ebc49d17eb35a3b4dffc889384776d383613668"],
    ["composition-specialist.ts", "authorComposition", "eaea8ed286c24d3cd7438fdf3422d52212814b483f7fea55b9be7518292b70b5"],
    ["composition-specialist.ts", "createCompositionReviewCycle", "e8e2262ac7b40d3d788ddf9cbd945dbc545d2b1191c93c37d92fe0ab19edc91f"],
    ["composition-specialist.ts", "verifyCompositionRoundAuthority", "c08f29c90eec919aa5cdee7eac1c33e61fc6b37bfb040bc9fc315e0edf7ba5b2"],
    ["composition-specialist.ts", "verifyCompositionReviewPin", "79e6da2606964bba251bc358f886c6c92e7527a8dc46b2a89e7b73adb05b5ea2"],
    ["turn-fulfillment.ts", "prepareTurnFulfillment", "5152b5e8f22cfa479e391b9d038b7058579f0caef4a17387a3e6a4a5e4b5156e"],
    ["turn-fulfillment.ts", "assertMilestoneStageClosure", "0ff93e9f876f5223ab9b9a298b2f5f0106d2e0e3c3325cd6b40ff87659cef67e"],
    ["composition-work.ts", "inspectPendingCompositionInvocation", "b5a6a35ffbfebe02e3c432a047aa616cd50a0af8f093d9e0e3b16a49ab181162"],
    ["interactive-work.ts", "inspectPendingInteractiveInvocation", "50b5f9374e6c99bac5bb124656630d5c2690ad7f63a666414b61ceabb4a639ed"],
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
      "recoveryNode/return#23", "recoveryNode/return#25", "recoveryNode/return#32",
      "recoveryNode/status#2", "recoveryNode/status#3", "recoveryNode/status#4",
      "recoveryNode/status#5", "recoveryNode/status#20",
      "recoveryNode/status#22", "recoveryNode/status#27",
    ],
  },
  "paused-prerequisite-original-proof": {
    disposition: "integrity-fence",
    proof: "A paused dependency strategy retains original admission and only its verified prerequisite lineage can resume",
    regression: ["test/generation.test.ts", "prospective-paused"],
    sites: ["recoveryNode/return#17", "recoveryNode/status#16"],
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
  "native-diagnostic-resume-proof": {
    disposition: "integrity-fence",
    proof: "A paused native support or Review repair must authenticate its original settled read-only diagnosis and exact successor grant.",
    regression: ["test/generation.test.ts", "prospective-review-native-diagnosis"],
    sites: ["recoveryNode/return#11", "recoveryNode/status#10"],
  },
  "foundation-diagnostic-resume-proof": {
    disposition: "integrity-fence",
    proof: "Paused successor requires the original settled diagnosis, failure source, current author control and exact writer admission",
    regression: ["test/generation.test.ts", "nonconverging-continue-budget"],
    sites: ["recoveryNode/return#14", "recoveryNode/status#13"],
  },
  "foundation-review-handoff": {
    disposition: "integrity-fence",
    proof: "Reassessment or pause must authenticate the same original Foundation case and its source-linked Review boundary before continuing",
    regression: ["test/generation.test.ts", "review-session-unavailable"],
    sites: ["recoveryNode/return#31", "recoveryNode/status#26"],
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
      "5a72880af2daf1d9e357730468c68a912f937d9852651d9962dc3f1782850af2"
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
