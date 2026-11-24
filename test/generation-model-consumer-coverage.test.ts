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

function consumerSignatures(file: string, source: string): Record<string, string> {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const names = new Set(modelCalls);
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
  "src/architecture-blueprint.ts:performBlueprintDiagnosis": "2:43d1431d33248b04692ecf1b",
  "src/architecture-blueprint.ts:performBlueprintReplacement": "2:0e07362c5d6679d56f733be4",
  "src/architecture-blueprint.ts:createReviewedBlueprint": "7:cda6dbcd756fcfd79fdffc3f",
  "src/architecture-draft-review.ts:createArchitectureDraftReviewCycle": "7:d647236f1406c9995cc06401",
  "src/architecture-specialist.ts:authorArchitecture": "6:639aa1ec267e574f87acda99",
  "src/assignment-metadata-recovery.ts:runAssignmentReceipts": "2:0c6d1c1fc8dd104ffac316da",
  "src/character-world-specialist.ts:authorCharacterWorld": "3:5ea122f5c2089eab89ad3410",
  "src/composition-specialist.ts:createSession": "1:f18acfc0fd3f82673a9a2626",
  "src/composition-specialist.ts:authorComposition": "2:c17fd7fb9dae5660409d117a",
  "src/composition-specialist.ts:diagnoseComposition": "2:1234e9307daa698374e56ff7",
  "src/composition-specialist.ts:createCompositionReviewCycle": "2:bf0f1b708da1583b564df1a3",
  "src/cross-domain-closeout-specialist.ts:authorMilestoneCloseout": "4:6039a9cb83869c2519f4bc80",
  "src/demo.ts:runFoundationDemo": "2:c174f4dc6ebfeac50e174906",
  "src/dependency-planner.ts:proposeDependency": "4:26f7ea03a852f3093aab3079",
  "src/dependent-correction-specialist.ts:authorDependentCorrection": "2:a4c94c75e79027e58be00491",
  "src/event-specialist.ts:authorEventCluster": "3:eef9b51da4728416e7ca6912",
  "src/event-work.ts:authorFixtureEventRound": "1:33c15044fe7612434ea1459f",
  "src/focused-work.ts:writeWithPi": "3:3c796a38c1559932daaaffeb",
  "src/foundation.ts:piAuthor": "3:a0277b19706e1a754da4b32c",
  "src/foundation.ts:discoverQuestions": "2:682a8e7748244e04ea525e6e",
  "src/idea-placement.ts:piWork": "4:c54673be05cced07b95826e1",
  "src/interactive-specialist.ts:authorInteractive": "3:ead2ac03e9f617577a3f416d",
  "src/milestone-blueprint.ts:runMilestoneDiagnosis": "2:8721be40a6fc38955324cbd2",
  "src/milestone-blueprint.ts:sessionFor": "1:38a7ae9f654dd9891686776c",
  "src/milestone-blueprint.ts:ensureMilestoneBlueprint": "4:46b84c88767dabb9a7ea940f",
  "src/narrative-review-specialist.ts:sessionFor": "1:5766e269693eafad4bf26752",
  "src/narrative-review-specialist.ts:reviewNarrative": "3:7520c967cbb41f7d7155bbd2",
  "src/narrative-review-specialist.ts:reviewPostcommitDiagnosis": "3:ac31c10351cf7fa8109358b5",
  "src/narrative-review-specialist.ts:reviewSpecialistAssignments": "8:df00496b12dc07926f00d296",
  "src/narrative-review-specialist.ts:reviewTurnCompleteness": "1:f2859a2242a6b53785bd2f40",
  "src/narrative-review-specialist.ts:repairNarrativeProse": "2:b53774ab79e680941f0523dc",
  "src/non-specialist-protocol.ts:reconcileReadOnlyProtocol": "3:c56375c5e4872ac55915f7b2",
  "src/orchestrator-planner.ts:runPinnedObjectivePlanner": "4:79fed5aeac43bc983bc607f6",
  "src/pi.ts:createPiDelegationAdapters": "5:d00e9236dc0a8845bbe5cf01",
  "src/pinned-skill-reads.ts:requirePinnedSkillReads": "1:049ca497e7263fdf90c97429",
  "src/rejected-review-repair.ts:prepareRepairWriter": "1:dae6a0d866d97cc9a6a5c926",
  "src/rejected-review-repair.ts:runPiRejectedRepair": "1:df7d8b72fbfc0c8704d43a04",
  "src/rejected-review-repair.ts:runNativeRepairRound": "2:b3ec9253814377867544b7d0",
  "src/response-contract-recovery.ts:recoverResponseContract": "1:6393a4841b024e58ff33f038",
  "src/response-contract-recovery.ts:startAdmittedFresh": "1:75a11ca06ff8cbd70fd71028",
  "src/response-contract-recovery.ts:recoverWithOneFreshSession": "1:ab3c3013d0f8727bd3291ac4",
  "src/specialist-manifest.ts:requireSpecialistManifest": "2:070158f8e794500669be0588",
  "src/story-interruption.ts:promptStorySpecialist": "1:467b2eeea2bda68e76803149",
  "src/unknown-recovery-diagnostic.ts:diagnoseUnknownCompletion": "4:1480fcd299bc59528f25b2d9",
  "web/src/agent-runner.ts:runPersistedGeneration": "1:ef490eb86259ee5321202fce",
  "web/src/lib/onboarding-pi.server.ts:realInference": "4:92dca59908059c408287377c",
  "web/src/lib/onboarding-pi.server.ts:onboardingPiRequest": "4:5b7954ecd2be11a068ba010b",
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
