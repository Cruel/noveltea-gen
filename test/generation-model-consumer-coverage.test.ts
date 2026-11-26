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
  "src/architecture-draft-review.ts:createArchitectureDraftReviewCycle": "7:a92c99a1a72b6d99445afb61",
  "src/architecture-specialist.ts:authorArchitecture": "3:21fb89b3847df194b753be47",
  "src/assignment-metadata-recovery.ts:runAssignmentReceipts": "2:95bb5c3385a3f2f1c099d26a",
  "src/character-world-specialist.ts:authorCharacterWorld": "3:fde1c2d4aaa0b4719b1a093c",
  "src/composition-specialist.ts:createSession": "1:157c53ec1f0f5d136ed70ed6",
  "src/composition-specialist.ts:authorComposition": "2:6713ae98ee2cc78db5a96347",
  "src/composition-specialist.ts:createCompositionReviewCycle": "3:4843ab4d06114079f095ee94",
  "src/cross-domain-closeout-specialist.ts:authorMilestoneCloseout": "4:7837b5d229deb6f1e0f9287a",
  "src/dependency-planner.ts:proposeDependency": "4:fc58d8afccefe69dc231b7f3",
  "src/dependent-correction-specialist.ts:authorDependentCorrection": "2:a4c94c75e79027e58be00491",
  "src/event-specialist.ts:authorEventCluster": "3:f68ac1acdbec12eb1d1d4bcc",
  "src/focused-work.ts:writeWithPi": "3:b729a541e6ed6b2bec34c3e1",
  "src/foundation.ts:piAuthor": "3:9e5ed08fab9b974df4cfca50",
  "src/idea-placement.ts:piWork": "4:c54673be05cced07b95826e1",
  "src/interactive-specialist.ts:authorInteractive": "3:09ac0dfa6bd4ed91eb8f1bc0",
  "src/milestone-blueprint.ts:correctMilestoneContract": "2:9a2ed232e185ce8958d8ca0b",
  "src/milestone-blueprint.ts:correctMissingReads": "1:37515b311c7fa3f3394d598f",
  "src/milestone-blueprint.ts:runMilestoneDiagnosis": "1:64e7d47711561d63eaa11daa",
  "src/milestone-blueprint.ts:sessionFor": "1:38a7ae9f654dd9891686776c",
  "src/milestone-blueprint.ts:ensureMilestoneBlueprint": "2:1d35b7224303170c70302ecc",
  "src/narrative-review-specialist.ts:sessionFor": "1:5766e269693eafad4bf26752",
  "src/narrative-review-specialist.ts:reviewNarrative": "3:7520c967cbb41f7d7155bbd2",
  "src/narrative-review-specialist.ts:reviewPostcommitDiagnosis": "3:ac31c10351cf7fa8109358b5",
  "src/narrative-review-specialist.ts:reviewSpecialistAssignments": "8:df00496b12dc07926f00d296",
  "src/narrative-review-specialist.ts:reviewTurnCompleteness": "1:f2859a2242a6b53785bd2f40",
  "src/non-specialist-protocol.ts:reconcileReadOnlyProtocol": "3:c56375c5e4872ac55915f7b2",
  "src/orchestrator-planner.ts:runPinnedObjectivePlanner": "4:79fed5aeac43bc983bc607f6",
  "src/pi.ts:createPiDelegationAdapters": "5:d00e9236dc0a8845bbe5cf01",
  "src/pinned-skill-reads.ts:requirePinnedSkillReads": "1:049ca497e7263fdf90c97429",
  "src/rejected-review-repair.ts:prepareRepairWriter": "1:e9a5ae2ec204525c446bbf75",
  "src/rejected-review-repair.ts:runPiRejectedRepair": "1:9f9f3d313ce50c2af115b14f",
  "src/rejected-review-repair.ts:runNativeRepairRound": "2:c89983ba717426cab9f9b856",
  "src/response-contract-recovery.ts:recoverResponseContract": "1:aff1e9f71a8c8cac3ddc2a8f",
  "src/response-contract-recovery.ts:startAdmittedFresh": "1:75a11ca06ff8cbd70fd71028",
  "src/response-contract-recovery.ts:recoverWithOneFreshSession": "1:ab3c3013d0f8727bd3291ac4",
  "src/specialist-manifest.ts:requireSpecialistManifest": "2:070158f8e794500669be0588",
  "src/story-interruption.ts:promptStorySpecialist": "1:467b2eeea2bda68e76803149",
  "src/unknown-recovery-diagnostic.ts:diagnoseUnknownCompletion": "4:f95e9b74052bbf4f7639ba2b",
  "web/src/agent-runner.ts:runPersistedGeneration": "1:a57375990748cf3a4181c550",
  "web/src/lib/onboarding-pi.server.ts:realInference": "4:d8e7bdacf0d34ddacb7fb378",
  "web/src/lib/onboarding-pi.server.ts:onboardingPiRequest": "4:c03db4f85a977f99124aea8f",
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
  "src/dependency-work.ts:admitDependency": "1:9d7b201fcd438f84a803e898",
  "src/dependency-work.ts:advanceReviewDependency": "1:bda3257d043a0223fc3fbe02",
  "src/dependency-work.ts:continueReviewDependency": "1:763cf4d2e8040ab5985f92bd",
  "src/generation.ts:independentAssignmentBoundary": "1:cd5885456ac1086a2ab87516",
  "src/generation.ts:createGenerationGraph": "3:c4afd495e0cbb332cc4088cf",
  "src/generation-operation-strategy.ts:executeOperationStrategy": "1:2516cd69b4a625038eeafe1c",
  // Validated, read-only verdict consumers and sealed evidence re-readers.
  "src/cross-domain-closeout-specialist.ts:authorMilestoneCloseout": "1:7837b5d229deb6f1e0f9287a",
  "src/cross-domain-closeout-work.ts:recoveredCloseoutReview": "1:d07d3a0f91e221a2cb34c6d1",
  "src/cross-domain-closeout-work.ts:verifyLegacyCloseoutReviewTranscript": "1:5acb0a5e8eacbf5aabd14ecf",
  "src/cross-domain-closeout-work.ts:advanceCrossDomainCloseout": "1:10ae9fb8c540ed107de7fa5c",
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
  "web/src/lib/onboarding-pi.server.ts:onboardingPiRequest": "4:c03db4f85a977f99124aea8f",
  "web/src/lib/story-chat-discovery.server.ts:storyChatDiscoveryRequest": "1:14222f0213a6d39fc9d6254d",
  "src/dependency-work.ts:runSupportingDependency": "1:bb4bc5e943544809688ca76d",
  "src/support-review.ts:reviewSupportRoot": "1:3d6cecfac750e4d860307532",
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

// R14L native/manifest and durable effect boundary. The explicit owners
// correspond to the categorized source/next-authority crosswalk in
// recovery-exit-inventory.md. Each consumer body is independently pinned,
// including read-only and transport-only consumers.
const effectProducers = new Set([
  "validateStoryJob", "lastSpecialistManifest", "inspectSpecialistManifest",
  "parseEventManifest", "requireSpecialistManifest", "runFoundationJob",
  "runEventWorkItem", "runCharacterWorldJob", "runCompositionWorkItem",
  "runFocusedWorkItem", "runInteractiveWorkItem", "pinDiscoveryHandoff",
  "saveJobTurnPlan", "acquireCachedStory", "queueGeneration", "claimNext",
  "finishAttempt", "settleThreadRun", "runPersistedGeneration", "verifyTrustedRevision",
]);

const effectReviewed: Record<string, string> = {
  // Domain validation, sealed submissions and no-write proof.
  "src/adaptive-omission.ts:reviewedAdaptiveOmissions": "1:2b9f6164eb0fb6b8df609eef",
  "src/adaptive-work.ts:resolveAdaptiveNoWriteSupersession": "3:73b489e6308f24eb65e39815",
  "src/architecture.ts:verifyArchitectureAssignmentResult": "1:4c6671ff8c0f9b78e1980562",
  "src/architecture.ts:runArchitectureJob": "1:67d8aa7f36e31226f6c039b6",
  "src/assignment-metadata-recovery.ts:responsePolicy": "4:aae544942ee5e97d276631d8",
  "src/causal-amendment-controller.ts:inspectCausalAmendment": "1:827365b4d9bc8fe3239ca58d",
  "src/character-world-specialist.ts:authorCharacterWorld": "1:fde1c2d4aaa0b4719b1a093c",
  "src/character-world.ts:runCharacterWorldJob": "1:269de02969f4c81d4011891e",
  "src/cli.ts:main": "6:423c2953456a0f938e7eef8d",
  "src/composition-work.ts:runCompositionWorkItem": "2:99840b7ffe6b07fb4829a634",
  "src/cross-domain-closeout-work.ts:validateCloseoutDraft": "1:f5ff4c389acc85dbe86bb3e0",
  "src/cross-domain-closeout-work.ts:reviewerAssignment": "1:880610212e10fddd54a39ce8",
  "src/cross-domain-prerequisite-controller.ts:preflightCompositionBoundary": "1:93cd9ea2199739db5e6988ea",
  "src/dependency-state.ts:registerReviewDependency": "1:5ddcfd4f862723bd975fb444",
  "src/dependency-state.ts:inspectDependencyAdmission": "1:d67f707b674accd802fa7b5d",
  "src/dependency-state.ts:registerBlueprintDependency": "1:cb1ade2913b7acad17b3b7b9",
  "src/dependency-work.ts:supportingWriterRounds": "1:180cbfacbc22d6eb2499f374",
  "src/dependent-correction-work.ts:native": "1:c3469e6a1dcc5740024c502c",
  "src/event-manifest.ts:parseEventManifest": "1:a856242f4130e68799cf5f00",
  "src/event-specialist.ts:authorEventCluster": "1:f68ac1acdbec12eb1d1d4bcc",
  "src/event-work.ts:inspectEventBlueprintPrerequisite": "1:8a40c11de04a80ea1495dd84",
  "src/event-work.ts:authenticateSettledEventNoWrite": "1:d61ad6a2f22f881b25b0a757",
  "src/event-work.ts:runEventWorkItem": "1:b993ae4d54f28fc13501961f",
  "src/focused-work.ts:focusedSourceCatalog": "2:e6a96d7854b897f588b5b2bb",
  "src/focused-work.ts:runFocusedWorkItem": "2:bf070180f25c9b3809b4f909",
  "src/foundation.ts:piAuthor": "1:9e5ed08fab9b974df4cfca50",
  "src/foundation.ts:executeFoundationGraph": "1:c8b2027f7012552fd2c41366",
  "src/generation-operation-strategy.ts:executeOperationStrategy": "1:2516cd69b4a625038eeafe1c",
  "src/generation.ts:reconcile": "3:f1a8db03717bd8d2dcc55b88",
  "src/generation.ts:applyLiveSteeringAtBoundary": "1:d3696b97d784629df921bf9a",
  "src/generation.ts:dispatch": "5:539f8a4e1b8508c9e4c3068a",
  "src/generation.ts:runFoundationAssignmentChild": "1:0a406cd6028d39a72787d6af",
  "src/generation.ts:runNarrativeAssignmentChild": "5:64c3e64a1a1f26f33058763c",
  "src/generation.ts:runInteractiveAssignmentChildren": "4:494938da3ad35c153e6b0d7f",
  "src/idea-placement.ts:verifyDraft": "1:c79724362888c72927074984",
  "src/interactive-specialist.ts:parseInteractiveManifest": "1:80675c862737d958a4a7abb8",
  "src/interactive-work.ts:runInteractiveWorkItem": "3:25629e8a9f6ac5ec47ace1f9",
  "src/merge-preview.ts:previewStoryMerge": "2:840d13f8fe94da7b84e805fe",
  "src/milestone-blueprint-correction.ts:originalSpecialistChallenge": "1:f1d0b65979f7dded6eecfd8c",
  "src/narrative-review.ts:runNarrativeReview": "1:5d2a876ce288384748fd396a",
  "src/original-thread-continuation.ts:inspectBlockedOriginalThreadCorrection": "2:0d4d2fe044219f7d3d1f6cb1",
  "src/recovery-fork.ts:prepareRecoveryFork": "1:3d9ee2859929dfa70bd87c53",
  "src/rejected-review-repair.ts:validateRejectedRepairDraft": "1:ce1d97d751a48d201f1cd9af",
  "src/rejected-review-repair.ts:runNativeRepairRound": "1:c89983ba717426cab9f9b856",
  "src/revision.ts:inspectProposal": "3:f04745505ac6b7eee45d8020",
  "src/selective-revalidation-work.ts:revalidateAfterReviewedCorrection": "1:0404670200e88b575ffc58fe",
  "src/specialist-manifest.ts:inspectSpecialistManifest": "1:63bb47eca9604cc6441872f4",
  "src/specialist-manifest.ts:requireSpecialistManifest": "2:070158f8e794500669be0588",
  "src/turn-fulfillment.ts:reviewedMilestoneObjectives": "1:1dd20a790e0586311dbc0b2a",
  "src/validator.ts:createStoryValidateTool": "1:2ef30afe91758edd5a90cd5a",
  // Studio owner/source admission, actual effect claim/settlement and inspection.
  "web/src/agent-runner.ts:runPersistedGeneration": "2:a57375990748cf3a4181c550",
  "web/src/agent-service.ts:pumpAgentQueue": "5:20892ee86a2f25c4028975ea",
  "web/src/lib/cached-jobs.server.ts:prepareCachedJob": "1:9727bff733515e4083c2e65c",
  "web/src/lib/fixture-jobs.server.ts:inspectRegisteredJob": "3:54216dbaced61f1f23c32476",
  "web/src/lib/fixture-jobs.server.ts:generationJobRequest": "2:602b3d11e4a3f56782c8a49e",
  "web/src/lib/generation-controls.server.ts:verifiedResumeAdmission": "1:8863ebffa4e799b0820abb21",
  "web/src/lib/git-cache.server.ts:initializeStoryBranch": "1:4f34cd8fb95533868780c007",
  "web/src/lib/github-initialize.server.ts:githubInitializationRequest": "1:eca70c5a46cce65ff71c53e9",
  "web/src/lib/natural-story.server.ts:launchNaturalStory": "1:b5f270efbbff33469f462372",
  "web/src/lib/publication-review.server.ts:reviewPublication": "1:04f27a079a585503301ec9e6",
  "web/src/lib/replacement-turn.server.ts:prepareReplacementTurn": "2:07c5edd9a27bd3f7aa3599e9",
  "web/src/lib/story-approved-continuation.server.ts:admitWholeApprovedStory": "1:3d7345b1d5fd63419a5f9159",
  "web/src/lib/story-approved-continuation.server.ts:continueApprovedStoryChat": "3:5f42f8344cfd54990172f8e0",
  "web/src/lib/story-explorer.server.ts:validatedExplorer": "1:804c20a611913d796e173dcb",
  "web/src/lib/story-foundation-reuse.server.ts:verifiedReusableStoryFoundation": "1:2e32c7afe3f2b6d9d1dfbb74",
  "web/src/lib/story-foundation-reuse.server.ts:inspectExistingStoryFoundation": "1:8d7dc5c6ab60e84e775efcb7",
  "web/src/lib/story-revision.server.ts:revisionFromSource": "1:d7d4b715f104acf968592936",
  "web/src/lib/thread-chat.server.ts:advanceThread": "1:47f8904b1df15ccae40fc29a",
  "web/src/lib/thread-chat.server.ts:recoverSettledThreadRuns": "1:0909991919ad3ed350c3596b",
  "web/src/lib/thread-message-edit.server.ts:branchEditedThreadMessage": "1:ef98313f817abe5bf4264bea",
  "web/src/lib/thread-restart.server.ts:verifyNewerStory": "1:610041ddde077421990114a9",
  "web/src/lib/thread-restart.server.ts:verifyPreparedStory": "1:cd4062440147a57b2cfa46d1",
  "web/src/lib/thread-restart.server.ts:prepareThreadRestart": "1:3b37dbd6e8197e3a210d7f0c",
  "web/src/lib/thread-review.server.ts:readThreadReview": "1:5cb6f0a4ac899cee24f17c49",
  "src/event-work.ts:rebindEventAfterBlueprintPredecessors": "1:b0f643f75eea985bbf581948",
};

test("R14L native, manifest and durable effect consumers retain reviewed source gates", () => {
  const actual: Record<string, string> = {};
  for (const base of ["src", "web/src"]) {
    for (const path of readdirSync(resolve(root, base), { recursive: true, encoding: "utf8" })) {
      if (!/\.tsx?$/.test(path)) continue;
      const file = base + "/" + path.replaceAll("\\", "/");
      Object.assign(actual, consumerSignatures(file, readFileSync(resolve(root, file), "utf8"), effectProducers));
    }
  }
  assert.deepEqual(actual, effectReviewed);
});

test("R14L effect gate detects an added aliased queue consumer and changed native-result disposition", () => {
  const original = 'import { validateStoryJob as validate, queueGeneration as enqueue } from "./ports";\n' +
    'async function verify(job: unknown) { return (await validate(job)).status === "passed" ? "verified" : "fenced"; }';
  const baseline = consumerSignatures("example.ts", original, effectProducers);
  assert.equal(Object.keys(baseline).length, 1);
  assert.notDeepEqual(consumerSignatures("example.ts", original.replace('"fenced"', '"verified"'), effectProducers), baseline);
  assert.notDeepEqual(consumerSignatures("example.ts", original + '\nasync function bypass(job: unknown) { await enqueue(job); }', effectProducers), baseline);
});
