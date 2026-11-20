/** Stage-specific instructions. A compact Story Blueprint is a causal feasibility
 * gate; it is not an Event/scene evidence inventory or canonical Story record. */
import type { CausalBlueprint, BlueprintReview } from "./architecture-blueprint.js";
import type { Plan } from "./architecture.js";
import type { BlueprintObligations, CompactBlueprintSources } from "./architecture-blueprint-obligations.js";
import type { ReviewRound } from "./review-convergence.js";
import { allowedBlueprintPatchTargets, blueprintDigest } from "./architecture-blueprint-patch.js";

export function compactReviewPrompt(
  plan: Plan, blueprint: CausalBlueprint,
  sources: BlueprintObligations | CompactBlueprintSources, task: string,
  history: readonly (ReviewRound & { patch?: unknown })[], changes?: unknown,
) {
  return "INDEPENDENT READ-ONLY COMPACT STORY BLUEPRINT REVIEW. Read the pinned " +
    "nt-story-architecture and nt-catalog skills and approved " +
    "creative-direction/foundation.md IN THIS TURN. No writing, shell, approval, " +
    "or expanded scope. Compare the actual approved Foundation, author task " +
    "and full contract, not just the private source-digest receipt. " +
    "Refuse an incoherent or deferred causal answer, implausible mechanism " +
    "or motive, impossible major dependency, inaccessible resolution on " +
    "a consequential Choice/refusal route, contradictory endings, or violated " +
    "Interaction profile, Playthrough length or Production budget. Consider " +
    "one complete playthrough, excluding mutually exclusive route lengths. " +
    "Allow plausible local evidence/source PROMISES for later Milestone work: " +
    "DO NOT require exhaustive clue observations, custody, scene choreography, " +
    "dialogue, local Choice-state tables, or uniform Puzzle quotas now. " +
    "A Story-led narrative may legitimately have few or no explicit Choices. " +
    "Canonical Arc/Milestone writing, native validation and independent " +
    "semantic review are the next authority; private proposed details are " +
    "not protected canon. Report only actual material, source-grounded " +
    "global violations, each anchored to an existing major beat ID. " +
    "SOURCES: " + JSON.stringify(sources) +
    "\nCONTRACT: " + JSON.stringify(plan.contract) +
    "\nAUTHOR TASK: " + JSON.stringify(task) +
    "\nCURRENT PROVISIONAL STORY BLUEPRINT: " + JSON.stringify(blueprint) +
    (history.length ? "\nCONTINUE YOUR OWN PRIOR REVIEW. Re-read the current " +
      "sources and account for EVERY earlier finding as resolved, materially " +
      "improved, persisting or regressed, with exact CURRENT Blueprint evidence. " +
      "Identify previously overlooked vs introduced defects. Text growth, " +
      "verbal assurances or fresh findings alone are not proof of progress. " +
      "PRIOR SEALED REVIEWS: " +
      JSON.stringify(history.map((item, round) => ({
        round, digest: blueprintDigest(item.blueprint),
        verdict: item.verdict, patch: item.patch ?? null,
      }))) + "\nSOURCE CHANGES: " + JSON.stringify(changes) : "") +
    "\nReturn ONE strict JSON object with EXACT keys schema,status,findings,prior. " +
    "schema=noveltea-blueprint-review/v2. status=pass requires findings:[]; " +
    "status=revise requires 1–8 findings. Each finding has EXACT " +
    "beatId,reason,correction,requirement,evidence,origin. " +
    "requirement={source:foundation|task|contract,quote:8+ exact contiguous " +
    "characters from that authorized source}. evidence={beatId:the finding " +
    "beat,quote:8+ exact CURRENT beat substring}, or " +
    "{beatId:resolution,field:conclusion|uncertainty|supportedBy,quote:" +
    "8+ exact current field substring}, or {beatId:story,field:causalAnswer|" +
    "feasibility|arcs,quote:8+ exact substring in that current field}. " +
    "origin=initial in round zero, otherwise continuing|introduced|overlooked. " +
    "prior is [] in round zero, otherwise one {round,findingIndex,status," +
    "reason,evidence} per historical finding; cite the CURRENT relevant " +
    "beat or supported global field. Final pass requires all prior blockers " +
    "resolved and the whole Story gate independently checked.";
}

export function compactCorrectionPrompt(blueprint: CausalBlueprint, verdict: BlueprintReview) {
  return "ORIGINAL WRITER: correct the INDEPENDENT REVIEW FINDINGS in the compact " +
    "Story Blueprint only. Preserve the author-approved Foundation, objective, " +
    "original premise and unrelated milestones. Do NOT fill in exhaustive " +
    "clues, scene inventories or local interaction state. " +
    "Return ONLY JSONL: one header {schema,baseDigest,reviewDigest} where " +
    "schema=noveltea-blueprint-patch/v1, then 1–48 standalone operation rows " +
    "with kind and findingBeatId. Allowed ops: replace " +
    "{findingBeatId,path,expected,value} at beats/ID/purpose|change, " +
    "resolution/conclusion|uncertainty, causalAnswer/answer|mechanism|" +
    "responsibility|motive|proofApproach, feasibility/playthrough|" +
    "interaction|production|endings or arcs/ID/goal; append-decision " +
    "{findingBeatId,beatId,value:{question,alternatives}}; add-dependency " +
    "{findingBeatId,beatId,dependsOn}; insert-beat " +
    "{findingBeatId,afterBeatId,beat:complete beat with an existing arcId " +
    "and observations:[]}; support-resolution {findingBeatId,beatId}. " +
    "Global replacements must address a cited source-bound finding. " +
    "Beat changes must target the finding beat or a causal descendant. " +
    "Never erase prior Choice alternatives or lasting effects, add " +
    "observation batches, change the premise, silently change protected " +
    "decisions or grant new writing scope. Allowed finding-to-target map: " +
    JSON.stringify(allowedBlueprintPatchTargets(blueprint, verdict)) +
    "\nHEADER: " + JSON.stringify({
      schema: "noveltea-blueprint-patch/v1",
      baseDigest: blueprintDigest(blueprint),
      reviewDigest: blueprintDigest(verdict),
    }) +
    "\nBASE DIGEST: " + blueprintDigest(blueprint) +
    " REVIEW DIGEST: " + blueprintDigest(verdict) +
    "\nFINDINGS: " + JSON.stringify(verdict.findings) +
    "\nCURRENT BLUEPRINT: " + JSON.stringify(blueprint) +
    "\nNo array, wrapper, markdown, blank lines or commentary.";
}
