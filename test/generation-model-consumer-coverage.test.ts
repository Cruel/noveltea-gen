/** R14 inventory of direct model calls and correction helpers. A fingerprint
 * change requires review of the corresponding source/effect disposition in
 * docs/recovery-exit-inventory.md, not automatic baseline regeneration. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const modelCalls = new Set([
  "createAgentSession", "promptStorySpecialist", "prompt", "completeSimple",
  "streamSimple", "stream", "recoverSubmittedAssignment", "executeAssignmentRound", "recoverResponseContract",
  "recoverWithOneFreshSession", "resumeExhaustedFreshProtocol", "realInference", "infer",
]);
const printer = ts.createPrinter({ removeComments: true });

function consumerSignatures(file: string, source: string, producers = modelCalls): Record<string, string> {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const names = new Set(producers);
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const bindings = stmt.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings))
      for (const item of bindings.elements)
        if (names.has(item.propertyName?.text ?? item.name.text)) names.add(item.name.text);
  }
  const signatures: Record<string, string> = {};
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt)) continue;
    let calls = 0;
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node)) {
        const expr = node.expression;
        const name = ts.isIdentifier(expr) ? expr.text : ts.isPropertyAccessExpression(expr)
          ? expr.name.text : ts.isElementAccessExpression(expr) && ts.isStringLiteral(expr.argumentExpression)
            ? expr.argumentExpression.text : "";
        if (names.has(name)) calls++;
      }
      ts.forEachChild(node, visit);
    }
    visit(stmt);
    if (!calls) continue;
    const owner = (stmt as ts.NamedDeclaration).name?.getText(sf) ??
      (ts.isVariableStatement(stmt)
        ? stmt.declarationList.declarations.map(d => d.name.getText(sf)).join(",")
        : ts.SyntaxKind[stmt.kind]);
    const key = file + ":" + owner;
    assert.ok(!(key in signatures), "Ambiguous model consumer owner: " + key);
    signatures[key] = calls + ":" + createHash("sha256")
      .update(printer.printNode(ts.EmitHint.Unspecified, stmt, sf)).digest("hex").slice(0, 24);
  }
  return signatures;
}

// Explicitly inventoried current implementation, including unresolved gaps
// and isolated demo/transport code. This is not proof of runtime convergence.
const reviewed: Record<string, string> = {
  "src/adaptive-planner.ts:proposeAdaptiveWork": "4:20f9b1ac2a89563ab02664f1",
  "src/adaptive-protocol.ts:correctAdaptiveResponse": "1:7321174e8371d6b0c22ce780",
  "src/architecture-blueprint.ts:sessionFor": "1:7a9010170f22d747c9ee5d2a",
  "src/architecture-blueprint.ts:performBlueprintDiagnosis": "2:080931aa92d98b80b97a4e75",
  "src/architecture-blueprint.ts:performBlueprintReplacement": "2:3cfe65456fb89c21558e9967",
  "src/architecture-blueprint.ts:advanceStoryBlueprint": "6:40939c7106eafbd279f290ba",
  "src/architecture-draft-review.ts:createArchitectureDraftReviewCycle": "7:7bf05b940b266ae818f72336",
  "src/architecture-specialist.ts:authorArchitecture": "3:21fb89b3847df194b753be47",
  "src/assignment-metadata-recovery.ts:runAssignmentReceipts": "2:849805a8287ea86bb72c18e7",
  "src/character-world-specialist.ts:authorCharacterWorld": "3:5ea122f5c2089eab89ad3410",
  "src/composition-specialist.ts:createSession": "1:157c53ec1f0f5d136ed70ed6",
  "src/composition-specialist.ts:authorComposition": "2:0d33b87c3cea1f65d2a45cd2",
  "src/composition-specialist.ts:createCompositionReviewCycle": "3:ee9476073aeffee2d4d56768",
  "src/cross-domain-closeout-specialist.ts:authorMilestoneCloseout": "4:6039a9cb83869c2519f4bc80",
  "src/dependency-planner.ts:proposeDependency": "4:26f7ea03a852f3093aab3079",
  "src/dependent-correction-specialist.ts:authorDependentCorrection": "2:a4c94c75e79027e58be00491",
  "src/event-specialist.ts:authorEventCluster": "3:701d1c814dec11399c9b5d87",
  "src/focused-work.ts:writeWithPi": "3:3c796a38c1559932daaaffeb",
  "src/foundation.ts:piAuthor": "3:9e5ed08fab9b974df4cfca50",
  "src/idea-placement.ts:piWork": "4:c54673be05cced07b95826e1",
  "src/interactive-specialist.ts:authorInteractive": "3:2b1a97828469bbe007a5a73e",
  "src/milestone-blueprint.ts:runMilestoneDiagnosis": "2:8721be40a6fc38955324cbd2",
  "src/milestone-blueprint.ts:sessionFor": "1:38a7ae9f654dd9891686776c",
  "src/milestone-blueprint.ts:ensureMilestoneBlueprint": "4:1c75f0b9ac35054097b3a129",
  "src/narrative-review-specialist.ts:sessionFor": "1:5766e269693eafad4bf26752",
  "src/narrative-review-specialist.ts:reviewNarrative": "3:7520c967cbb41f7d7155bbd2",
  "src/narrative-review-specialist.ts:reviewPostcommitDiagnosis": "3:ac31c10351cf7fa8109358b5",
  "src/narrative-review-specialist.ts:reviewSpecialistAssignments": "8:df00496b12dc07926f00d296",
  "src/narrative-review-specialist.ts:reviewTurnCompleteness": "1:f2859a2242a6b53785bd2f40",
  "src/non-specialist-protocol.ts:reconcileReadOnlyProtocol": "3:c56375c5e4872ac55915f7b2",
  "src/orchestrator-planner.ts:runPinnedObjectivePlanner": "4:79fed5aeac43bc983bc607f6",
  "src/pi.ts:createPiDelegationAdapters": "5:d00e9236dc0a8845bbe5cf01",
  "src/pinned-skill-reads.ts:requirePinnedSkillReads": "1:049ca497e7263fdf90c97429",
  "src/rejected-review-repair.ts:prepareRepairWriter": "1:52f1f643330c2a372e4ddc25",
  "src/rejected-review-repair.ts:runPiRejectedRepair": "1:9f9f3d313ce50c2af115b14f",
  "src/rejected-review-repair.ts:runNativeRepairRound": "2:b3ec9253814377867544b7d0",
  "src/response-contract-recovery.ts:recoverResponseContract": "1:6393a4841b024e58ff33f038",
  "src/response-contract-recovery.ts:startAdmittedFresh": "1:75a11ca06ff8cbd70fd71028",
  "src/response-contract-recovery.ts:recoverWithOneFreshSession": "1:ab3c3013d0f8727bd3291ac4",
  "src/specialist-manifest.ts:requireSpecialistManifest": "2:070158f8e794500669be0588",
  "src/story-interruption.ts:promptStorySpecialist": "1:467b2eeea2bda68e76803149",
  "src/unknown-recovery-diagnostic.ts:diagnoseUnknownCompletion": "4:1480fcd299bc59528f25b2d9",
  "web/src/agent-runner.ts:runPersistedGeneration": "1:7a8e23dec868c576e124f402",
  "web/src/lib/onboarding-pi.server.ts:realInference": "4:d8e7bdacf0d34ddacb7fb378",
  "web/src/lib/onboarding-pi.server.ts:onboardingPiRequest": "4:2f6882d530fd1360e5530e17",
  "web/src/lib/pi-credentials.server.ts:buildUserPiRuntime": "2:80bee0d946aa4633f94ea00e",
};

test("R14 direct model consumers cannot change or multiply without source/effect review", () => {
  const actual: Record<string, string> = {};
  for (const base of ["src", "web/src"]) {
    for (const path of readdirSync(resolve(root, base), { recursive: true, encoding: "utf8" })) {
      if (!/\.tsx?$/.test(path)) continue;
      const file = base + "/" + path.replaceAll("\\", "/");
      Object.assign(actual, consumerSignatures(file, readFileSync(resolve(root, file), "utf8")));
    }
  }
  assert.deepEqual(actual, reviewed);
});

test("R14 new aliased invocation and changed outcome with the same call count change the inventory", () => {
  const original = 'async function work() { await pi.prompt("a"); return "blocked"; }';
  const baseline = consumerSignatures("example.ts", original);
  assert.notDeepEqual(consumerSignatures("example.ts", original.replace("blocked", "verified")), baseline);
  assert.notDeepEqual(consumerSignatures("example.ts",
    'import { createAgentSession as open } from "sdk";\n' + original + '\nasync function newWriter() { await open(); }',
  ), baseline);
});

// R14L: audited downstream reply consumers. Unlike the direct transport
// inventory, this follows named semantic-review, planning and Discovery
// output boundaries, including transcript readers that never call Pi.
// See recovery-exit-inventory.md for the behavioral crosswalk and remaining
// native, domain-manifest, queue and provider-effect coverage obligations.
const downstreamProducers = new Set([
  "parseSpecialistJson", "validateSemanticVerdict", "independentReviewResults",
  "readDiscoveryResponse", "reviewNarrative", "runPiAssignmentReview",
  "reviewTurnCompleteness", "validateTurnFulfillment", "assessTurnFulfillment",
  "runPinnedObjectivePlanner", "proposeAdaptiveWork", "proposeDependency",
  "diagnoseUnknownCompletion", "onboardingPiRequest", "reviewSpecialistAssignments",
  "reviewPostcommitDiagnosis",
]);

// Each owner below is independently identified by its actual downstream
// consumer, not added to the existing direct Pi-call baseline. A fingerprint
// change requires review of that owner's verifier and next authority.
const downstreamReviewed: Record<string, string> = {
  // Parent admission and source-linked proposal / Review gates.
  "src/adaptive-work.ts:reconcileAdaptiveWork": "1:4b7540ae585f448c5ea0ac64",
  "src/dependency-work.ts:advanceFocusedDependency": "2:f40c2fe0d59059a3efd4a964",
  "src/dependency-work.ts:advanceReviewDependency": "2:fd8f307545297c9e888fc4be",
  "src/dependency-work.ts:continueReviewDependency": "1:763cf4d2e8040ab5985f92bd",
  "src/generation.ts:independentAssignmentBoundary": "1:cd5885456ac1086a2ab87516",
  "src/generation.ts:createGenerationGraph": "3:36546aa62956ff41bf1ea5f2",
  "src/generation-operation-strategy.ts:executeOperationStrategy": "1:ce61e961ebde642e41f90ed6",
  // Validated, read-only verdict consumers and sealed evidence re-readers.
  "src/cross-domain-closeout-specialist.ts:authorMilestoneCloseout": "1:6039a9cb83869c2519f4bc80",
  "src/cross-domain-closeout-work.ts:recoveredCloseoutReview": "1:d07d3a0f91e221a2cb34c6d1",
  "src/cross-domain-closeout-work.ts:verifyLegacyCloseoutReviewTranscript": "1:5acb0a5e8eacbf5aabd14ecf",
  "src/cross-domain-closeout-work.ts:advanceCrossDomainCloseout": "1:dd63274008530f26908842dc",
  "src/dependent-correction-work.ts:advanceDependentCorrection": "1:f6d5cb09a011d425dbad5a3f",
  "src/execution-replay-capture.ts:captureSealedReview": "2:6b7747a538feb49ecc6465ae",
  "src/execution-replay.ts:executeReplay": "3:5300f4a97d25a99b2f72c042",
  "src/generation-operation-strategy.ts:authenticateSettledReviewVerdict": "1:e3400de56b5517c7964df318",
  "src/interactive-event-only.ts:decideEventOnlyOmission": "1:c8a51efb97ad675bd98e1a57",
  "src/merge-preview.ts:previewStoryMerge": "1:840d13f8fe94da7b84e805fe",
  "src/narrative-review-specialist.ts:reviewNarrative": "2:7520c967cbb41f7d7155bbd2",
  "src/narrative-review-specialist.ts:assignmentVerdictResponseContract": "3:3648c888decefabfb1e9862d",
  "src/narrative-review-specialist.ts:diagnoseAcceptedPostcommitRound": "1:18d1cc524efcf878cd06d02f",
  "src/narrative-review-specialist.ts:reviewSpecialistAssignments": "2:df00496b12dc07926f00d296",
  "src/narrative-review-specialist.ts:reviewTurnCompleteness": "2:f2859a2242a6b53785bd2f40",
  "src/narrative-review.ts:runNarrativeReview": "1:5d2a876ce288384748fd396a",
  "src/pending-work.ts:candidateReview": "1:4964af351a5a8e1287181c37",
  "src/postcommit-repair-diagnostic.ts:readSealedPostcommitVerdict": "1:d20d8d0f71300bd38b131024",
  "src/rejected-review-repair.ts:adjudicateRejectedRepair": "1:a652f3d6ec971557d3ded6f9",
  "src/rejected-review-repair.ts:foundationDiagnosticSource": "2:dcbf910433f0f92378993626",
  "src/rejected-review-repair.ts:executeFoundationReviewAssessment": "1:b9a79bd66c71024b594fb64f",
  "src/rejected-review-repair.ts:rejectedRepairOperations": "1:68568bfd3112e0735646e8d0",
  "src/selective-revalidation-work.ts:revalidateAfterReviewedCorrection": "1:0404670200e88b575ffc58fe",
  "src/semantic-assignment-review.ts:reviewBoundedAssignments": "2:d8afc63cbd24fab347ef2f5c",
  "src/semantic-assignment-review.ts:runPiAssignmentReview": "1:b9165fbdbe8c220c4796c9a6",
  // Final objective evidence and authenticated Studio response/handoff.
  "src/turn-fulfillment.ts:readTurnFulfillment": "1:6444ae47e2033a25e5c7dfd4",
  "src/turn-fulfillment.ts:assessTurnFulfillment": "1:ef5b7f354e0afb3dc0ca024a",
  "web/src/lib/discovery-evidence.server.ts:meterDiscoveryAttempts": "1:e815c68da3ec4e1c0762231d",
  "web/src/lib/onboarding-pi.server.ts:onboardingPiRequest": "4:2f6882d530fd1360e5530e17",
  "web/src/lib/story-chat-discovery.server.ts:storyChatDiscoveryRequest": "1:14222f0213a6d39fc9d6254d",
};

test("R14L downstream reply consumers cannot multiply or change their disposition silently", () => {
  const actual: Record<string, string> = {};
  for (const base of ["src", "web/src"]) {
    for (const path of readdirSync(resolve(root, base), { recursive: true, encoding: "utf8" })) {
      if (!/\.tsx?$/.test(path)) continue;
      const file = base + "/" + path.replaceAll("\\", "/");
      Object.assign(actual, consumerSignatures(file, readFileSync(resolve(root, file), "utf8"), downstreamProducers));
    }
  }
  assert.deepEqual(actual, downstreamReviewed);
});

test("R14L downstream reply audit catches a new consumer and a same-count disposition change", () => {
  const original = 'import { validateSemanticVerdict as validate } from "./review";\n' +
    'function review(packet: unknown) { const verdict = validate(packet); return verdict.status === "pass" ? "verified" : "unresolved"; }';
  const baseline = consumerSignatures("example.ts", original, downstreamProducers);
  assert.equal(Object.keys(baseline).length, 1);
  assert.notDeepEqual(consumerSignatures("example.ts", original.replace('"unresolved"', '"verified"'), downstreamProducers), baseline);
  assert.notDeepEqual(consumerSignatures("example.ts", original +
    '\nfunction bypass(packet: unknown) { validate(packet); return "verified"; }', downstreamProducers), baseline);
  assert.deepEqual(consumerSignatures("example.ts", original), {}, "Direct Pi inventory alone misses these consumers");
});
