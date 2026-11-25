import { boundedPinnedSources, renderBoundedPrompt } from "./bounded-specialist-prompt.js";
import { createPiStatusTool } from "./pi-work-status.js";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { parseSpecialistChoice, extractSpecialistChoice, authorChoiceDirection,
  type SpecialistChoiceQuestion, type SpecialistChoiceReceipt } from "./specialist-choice.js";
import { createJobModelRuntime } from "./model-runtime.js";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { promptStorySpecialist } from "./story-interruption.js";
import { completedPinnedSkillReads } from "./pinned-skill-reads.js";
import { selectSandboxPiTools, SANDBOX_TOOLS } from "./sandbox-pi-tools.js";
import { parseEventManifest } from "./event-manifest.js";
import { executeAssignmentRound, AssignmentAuthorPauseError, type AssignmentDefect, type AssignmentInvocationProof, type AssignmentRoundCommand, type AssignmentRoundResult } from "./assignment-metadata-recovery.js";
import { createHash } from "node:crypto";
import { readJobControl } from "./job-control.js";
import { StoryCancelledError } from "./story-interruption.js";
import type { JobStartResult } from "./job.js";
import type { CompletionContract } from "./architecture.js";
import type { CausalDiscovery } from "./causal-amendment.js";
import { specialistAuthorInstruction } from "./specialist-author-instruction.js";
import { createProjectResourceLoader } from "./pi.js";
import { openStoryProject } from "./project.js";
import { createStoryValidateTool } from "./validator.js";
import { preparePiContext, piNarrativeGroup, guardPiBudget, registerPendingPiSession, recordPiSession } from "./job-pi-policy.js";
import type { SkillConfig } from "./skills.js";
import type { SkillSnapshot } from "./snapshot.js";

const REQUIRED = boundedPinnedSources("nt-event-design");

/** Cheap, read-only early diagnosis for half-written model records. Native
 * validation remains authoritative for YAML schema, references and reachability.
 * This never repairs bytes or certifies a record as valid. */
export function canonicalFrontmatterStructureError(content: string): string | null {
  const lines = content.split(/\r?\n/);
  if (lines[0] !== "---") return "The first line must be exactly --- (YAML frontmatter opening).";
  const close = lines.findIndex((line, i) => i > 0 && line === "---");
  if (close < 2) return "The file is missing its closing --- delimiter after YAML frontmatter.";
  if (!lines.slice(close + 1).join("\n").trim())
    return "The file has no narrative Markdown body after the closing --- delimiter.";
  return null;
}

export interface EventAssignment {
  milestoneId: string;
  milestonePath: string;
  arcIds: string[];
  characterIds: string[];
  sourcePaths: string[];
  contract: CompletionContract;
  workItemId: string;
  authorTask?: string;
  /** Reviewed private local plan is a bounded obligation, never canonical authority. */
  milestoneBlueprint?: { digest: string; design: import("./milestone-blueprint.js").MilestoneBlueprint };
  /** Exact independently approved pre-predecessor source, not a new lease. */
  blueprintSource?: { reportDigest: string; sourceSha: string; sourcePaths: string[]; characterIds: string[] };
  authority: { existingProtectedChoices: "no-retcon"; delegatedChoices: "draft"; signingRequiredForProtectedChanges: true };
}
export interface EventEvidence {
  claimedPaths: string[];
  conflicts: string[];
  obligations: string[];
  sessionFile?: string;
  piSessionId?: string;
  authorQuestion?: SpecialistChoiceQuestion;
  invocationProof?: AssignmentInvocationProof;
  /** No-write source-bound claim only; does not authorize an Architecture edit. */
  causalDiscovery?: CausalDiscovery;
  /** Source-backed challenge to the provisional approved plan; no write grant. */
  blueprintChallenge?: import("./blueprint-challenge.js").SpecialistBlueprintChallenge;
  skillReads: string[];
}

export { parseEventManifest } from "./event-manifest.js";

/** The actual selected Milestone must positively describe player-visible
 * investigation/observation rather than executable choice. A model-generated
 * label of "nondecision" cannot confer permission to complete a Milestone. */
export function observedNondecisionMilestone(change: string): boolean {
  return !/\b(?:choice|chooses?|choosing|decision|decides?|deciding|branch|alternate outcomes?|either\b.{0,90}\bor\b)\b/i
    .test(change) &&
    // Non-Choice milestones may deliver a physical rescue, evidence discovery,
    // or verified inference without the protagonist literally "learning".
    /\b(?:knows?|learns?|recogniz(?:e|es|ed|ing)|identif(?:y|ies|ied|ying)|observ(?:e|es|ed|ing)|encounter(?:s|ed|ing)?|becomes aware|locat(?:e|es|ed|ing)|finds?|discover(?:s|ed|ing)?|establish(?:es|ed|ing)?|verif(?:y|ies|ied|ying)|tests?|releases?|rescues?)\b/i
      .test(change) &&
    /\b(?:investigat(?:ion|e|ing)|inquir(?:y|e)|missing|disappearance|absence|subject|evidence|situation|claim|allegation|signal|record|proof|audit|trace|confinement|restraint|rescue|release)\b/i
      .test(change);
}

/** Source-local model confusion: the Milestone's decisions metadata
 * records protected/delegated AUTHOR direction, not executable Choice Point
 * routes. A self-identified nondecision milestone cannot be held partial
 * merely because a later Story Choice remains unbound. The controller
 * still requires an actual reachable authored Event and independent review. */
export function scopedNondecisionChoiceDeferral(
  conflicts: readonly string[], sourceChange: string,
): boolean {
  return observedNondecisionMilestone(sourceChange) &&
    conflicts.length > 0 && conflicts.length <= 3 && conflicts.every(text =>
    /\b(?:milestone|fulfillment|validator)\b/i.test(text) &&
    /\b(?:unbound|pending|awaiting|deferred)\s+(?:formal\s+)?choice\b/i.test(text) &&
    /\b(?:fulfillment|complete(?:d|ness)?|route)\b/i.test(text) &&
    !/\b(?:protected|retcon|approval|consent|unrelated|out.of.scope|outside.scope|upstream|new character|new fact|new milestone|unreachable|impossible)\b/i.test(text));
}

/** A true decision-dependent Milestone still needs a playable Event setup
 * BEFORE its Choice specialist enacts branches. A model must not turn that
 * later, separately owned Choice into an Event-writing conflict. The source
 * change must independently confirm this is actually a decision Milestone. */
export function scopedDecisionSetupConflict(
  assignment: Pick<EventAssignment, "milestoneId">,
  sourceChange: string,
  conflicts: readonly string[],
): boolean {
  return /\b(?:choos(?:e|es|ing)|choice|decid(?:e|es|ing)|decision|enact(?:ed|s)?|outcomes?|consequential response)\b/i.test(sourceChange) &&
    conflicts.length > 0 && conflicts.length <= 3 && conflicts.every(text => {
      const named = text.match(/\bmilestone\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*\b/g) ?? [];
      const current = named.length
        ? named.every(id => id === assignment.milestoneId)
        : /\b(?:the|this|selected|assigned|current)\s+milestone\b/i.test(text);
      return current &&
        /\b(?:choice|decision|enact(?:ed|s)?|outcomes?|consequential response)\b/i.test(text) &&
        /\b(?:setup|partial|unbound|not yet enacted|falsely claim|empty fulfillment)\b/i.test(text) &&
        !/\b(?:protected|retcon|approval|consent|unrelated|out.of.scope|outside.scope|upstream|prior event|previous event|earlier event|(?:another|other|different) milestone|new character|new fact|new milestone|cannot author|cannot create event|missing character|missing fact|unreachable|impossible)\b/i.test(text);
    });
}

export function eventDecisionSetupCorrection(
  assignment: Pick<EventAssignment, "milestoneId" | "milestonePath">,
  sourceChange: string, conflicts: readonly string[],
): string {
  if (!scopedDecisionSetupConflict(assignment, sourceChange, conflicts))
    throw Error("An actual upstream or protected Event conflict cannot be reclassified.");
  return "EVENT_LOCAL_CHOICE_SETUP: The authorized Event unit for " + assignment.milestoneId +
    " must establish a reachable, player-visible PRE-DECISION setup. The source Milestone " +
    "truly REQUIRES an enacted consequential Choice, so DO NOT mark " +
    assignment.milestonePath + " complete or bind invented fulfillment.any_of outcomes here. " +
    "This Milestone MUST remain partial with its unfulfilled routes empty. " +
    "The formal Choice Point and enacted outcomes belong to the LATER interactive owner, " +
    "not this Event assignment; their absence is NOT an architectural blocker to " +
    "a genuinely authored Event setup. In this SAME Pi session, preserve any " +
    "already-authored valid, authorized Event edits and improve their causal setup " +
    "only if needed. Re-read the source change and exact Event, run story_validate, " +
    "then report the FULL cumulative modifiedRecords and transfer formal Choice " +
    "binding/outcome requirements to laterObligations instead of architecturalConflicts. " +
    "Do NOT suppress a genuine other-owner dependency or invent protected edits, " +
    "new Character/World canon, future choices or events that never occurred. " +
    "The independent Event reviewer must still check this committed setup. " +
    "SOURCE REPORT: " + JSON.stringify(conflicts).slice(0, 1400);
}

export function eventNondecisionChoiceCorrection(
  assignment: Pick<EventAssignment, "milestoneId" | "milestonePath">,
  conflicts: readonly string[], sourceChange: string,
  nativeEventIds: readonly string[] = [],
): string {
  if (!scopedNondecisionChoiceDeferral(conflicts, sourceChange))
    throw Error("An actual formal-Choice or other-owner conflict cannot be downgraded.");
  const ids = [...new Set(nativeEventIds)].filter(id =>
    /^event\.[a-z][a-z0-9-]*$/.test(id)).slice(0, 8);
  return "EVENT_LOCAL_EVIDENCE: You reported a nondecision Milestone but " +
    "incorrectly deferred its completion to a formal Choice Point. The " +
    "selected Milestone " + assignment.milestoneId + " uses decisions: as " +
    "AUTHOR authority metadata, NOT executable Choice Point branches. " +
    "A linear player-visible investigative step (identify a missing passenger, " +
    "ask a named witness, acquire a grounded first inquiry) can fulfill its " +
    "nondecision change without any formal player Choice. " +
    "Re-read the Milestone change and your actual reachable Event. If the " +
    "Event supplies the promised change with genuine in-scene evidence, " +
    "edit ONLY completeness: complete and fulfillment.any_of in " +
    assignment.milestonePath + " to bind the real authored Event; do not " +
    "defer the binding to a later owner or independent reviewer. " +
    "In laterObligations, distinguish any genuinely FUTURE Choice Point " +
    "for another Milestone from this nondecision Milestone. Do not call a " +
    "future Story choice an unbound Choice binding of " + assignment.milestoneId +
    " merely because it happens later in the narrative. " +
    (ids.length ? "Actual native Event candidates: " + JSON.stringify(ids) +
      ". For ONE genuinely sufficient and reachable Event, the selected " +
      "Milestone can use YAML shape: completeness: complete\nfulfillment:\n" +
      "  any_of:\n    - - " + ids[0] + "\n" +
      "This is NOT a claim that the source evidence is sufficient; verify it " +
      "first, use only the actual authored Event IDs and validate the route. " : "") +
    "Preserve the Milestone's original narrative body, all protected decisions, " +
    "other metadata and external canon. If the original Milestone in fact " +
    "requires a consequential choice branch, state that exact unmet source " +
    "obligation rather than fabricating a completed route. " +
    "Run story_validate, then return a complete cumulative manifest in this " +
    "SAME Pi session. CONTROLLER FINDINGS: " + JSON.stringify(conflicts).slice(0, 1400);
}

/** An Event owns its own in-scene evidence. A model's claim that its draft
 * lacks source-grounded access/timing/testimony is repair feedback, not a new
 * specialist grant. Only a concrete deficit in the assigned Milestone's
 * existing material evidence may be corrected here; anything demanding new
 * upstream canon, a protected change or a different owner remains blocked.
 * The native path/protection verifier still owns every actual edit. */
export function scopedEventEvidenceConflict(
  assignment: Pick<EventAssignment, "milestoneId">,
  conflicts: readonly string[],
): boolean {
  return conflicts.length > 0 && conflicts.length <= 3 && conflicts.every(text => {
    // The controller already supplies the target Milestone. A specialist may
    // refer to "the Milestone" instead of repeating its ID; requiring the ID
    // blocked a valid in-scope correction in a preserved Luna run.
    // However, ANY explicit reference to a different Milestone still fails
    // closed, even when the text also mentions the selected one.
    const named = text.match(/\bmilestone\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*\b/g) ?? [];
    const current = named.length
      ? named.every(id => id === assignment.milestoneId)
      : /\b(?:the|this|selected|assigned|current)\s+milestone\b/i.test(text);
    return current &&
      /\b(?:validator|milestone|fulfillment|reachable)\b/i.test(text) &&
      /\b(?:does not establish|lacks?|missing|not yet established|insufficient|sources? establish(?:es|ed)? neither|no supported (?:account|observation|evidence))\b/i.test(text) &&
      /\b(?:evidence|observation|testimony|witness|access|time|interval|material clause|support|route|clue|record|alteration|trace|discrepancy)\b/i.test(text) &&
      !/\b(?:protected|retcon|approval|consent|unrelated|out.of.scope|outside.scope|upstream|prior event|previous event|earlier event|(?:another|other|different) milestone|cannot (?:author|create)|need (?:an? )?(?:new|another|second) (?:fact|character|arc|milestone|event)|(?:new|another|second) (?:fact|character|arc|milestone|event) (?:is )?(?:required|needed|must))\b/i.test(text);
  });
}

/** One bounded correction in the original authenticated Pi session. It does
 * not waive Event completion, create a new grant or automatically trust the
 * model's assertion that the requirement has been met. */
export function eventEvidenceRepairFeedback(
  assignment: Pick<EventAssignment, "milestoneId" | "milestonePath">,
  conflicts: readonly string[],
  nativeEventIds: readonly string[] = [],
): string {
  if (!scopedEventEvidenceConflict(assignment, conflicts))
    throw new Error("An out-of-scope Event conflict cannot be routed as local evidence.");
  const eventIds = [...new Set(nativeEventIds)].filter(id =>
    /^event\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id)).slice(0, 8);
  return "EVENT_LOCAL_EVIDENCE: The CURRENT authored Event has not yet delivered " +
    "a verified Milestone binding for the material clause " +
    "of the selected Milestone " + assignment.milestoneId + " in " + assignment.milestonePath + ". " +
    "This is evidence the CURRENT Event specialist can gather within the SAME authorized " +
    "Event and existing-character context; it is not automatically a prerequisite for a new writer. " +
    "Re-read the Milestone's exact change and narrative promise, then revise the existing " +
    "Event (or author another causally connected Event under its already granted events/ scope) " +
    "so the player actually observes the relevant access, timing, space or source limitations, " +
    "or hears a named, existing participant provide firsthand, uncertainty-qualified testimony " +
    "IN this Event. When the Milestone promises a discrepancy, missing ledger entry or " +
    "concealed alteration, show the PLAYER the actual inspectable discrepancy between " +
    "specific source-visible traces, and distinguish a tampering hypothesis from proven " +
    "past alteration. An unsupported assertion that a record was changed is NOT " +
    "an independent observation. Specify which spaces and people the witness observed as accessible, " +
    "and which access facts remain unknown. A reported past sighting is testimony, NOT objective " +
    "truth or proof of continuous enclosure; do not invent an authoritative offscreen investigation, " +
    "time record, new Character, protected change, or unsupported certainty. " +
    "When this in-scene evidence materially supports the nondecision Milestone's " +
    "actual change, YOU are authorized and REQUIRED to edit the selected " +
    assignment.milestonePath + " yourself NOW: change ONLY its YAML " +
    "completeness to complete and fulfillment.any_of to a reachable route through " +
    "your authored Event IDs. The formal binding is part of YOUR Event assignment, " +
    "not a later specialist, Choice owner, or independent reviewer task. " +
    "Independent semantic review happens AFTER this native-validated commit " +
    "and will reject unsupported claims. Do not merely add a laterObligations " +
    "entry asking another owner to bind this nondecision Milestone. " +
    (eventIds.length ? "Native-identified candidate Event IDs from the actual draft: " +
      JSON.stringify(eventIds) + ". Use only genuinely sufficient and reachable Events; " +
      "for ONE sufficient Event, the source's YAML can express fulfillment: " +
      "{any_of: [[" + eventIds[0] + "]]}. " : "") +
    "Never invent fulfillment IDs, steps or effects merely to pass validation. " +
    "If the Milestone actually requires a player decision, keep that Milestone partial " +
    "and hand off only the formally unbound Choice. " +
    "Re-run story_validate and report EXACT cumulative modifiedRecords, " +
    "architecturalConflicts and laterObligations. If source-grounded evidence truly cannot " +
    "be authored within the original grant, report the concrete blocker; the controller " +
    "must remain blocked, not infer proof or waive the review. " +
    "SOURCE DEFICITS: " + JSON.stringify(conflicts).slice(0, 1800);
}

/** The source-authoritative Milestone narrative is immutable to the Event
 * writer. A body-only drift receives exact bytes to restore in the SAME
 * original session; the controller never edits or accepts the changed body.
 * All non-binding frontmatter changes still fail closed without this path. */
export function eventMilestoneBodyRestoreFeedback(
  milestonePath: string, originalBody: string,
): string {
  if (!/^milestones\/[a-z][a-z0-9-]*\.md$/.test(milestonePath) ||
      !originalBody.trim() || originalBody.length > 16_000)
    throw new Error("Cannot safely restore unbounded or noncanonical Milestone body.");
  return "EVENT_MILESTONE_BODY_RESTORE: Your authored Event may update ONLY " +
    "the completeness and fulfillment.any_of YAML slots of " + milestonePath + ". " +
    "Your latest Milestone edit ALSO changed the narrative body, which is NOT " +
    "authorized even if the explanation seems helpful. Restore the Milestone " +
    "body EXACTLY to these original source-bound bytes, preserving its original " +
    "whitespace and punctuation. Keep the supported new completeness/fulfillment " +
    "fields only if the authored Event truly satisfies the Milestone; do not " +
    "add narrative explanation to the Milestone. Evidence and testimony belong " +
    "in the already-authorized Event prose. Do not touch any protected choice, " +
    "other metadata, new Fact, Character or other-owner file. " +
    "Then run story_validate again and return a complete cumulative manifest " +
    "of actual changed Story-relative paths in this SAME Pi session. " +
    "The controller will re-audit the exact original source against the final " +
    "Milestone; NO new permission or review bypass has been granted. " +
    "ORIGINAL NARRATIVE BODY (JSON-encoded exact text): " +
    JSON.stringify(originalBody);
}

/** Pure production prompt for fixture comparison and controller-contract tests. */
export function eventSpecialistPrompt(
  snapshot: SkillSnapshot,
  assignment: EventAssignment,
  sandboxed: boolean,
): string {
  return renderBoundedPrompt(snapshot, {
    goal:
      "Author exactly ONE Event-design cluster for the assigned Milestone and its authored " +
      "Arc and Character context. Author a reachable in-scene setup grounded in those sources; " +
      "do not assert unshown past evidence, unearned typed effects or completed player decisions.",
    sources: REQUIRED,
    sourceUse:
      "Read the selected Milestone/Arc, connected Characters/Facts and reachable earlier " +
      "Events, IF any already exist. An empty events/ directory is a normal first " +
      "Milestone, not a missing dependency or a reason to ask permission: " +
      "YOU own authoring its discovery scene within this exact Event grant. " +
      "Follow only relevant typed links. 'after' orders Events if both occur; actual " +
      "enabling conditions use prerequisites.any_of.",
    writableScope:
      "Only events/*.md and causally connected authorized arcs/*.md, new facts/*.md, " +
      "revelations/*.md or relationships/*.md. The selected milestones/*.md may change ONLY its " +
      "fulfillment/completeness fields. All other Milestones, Creative Direction, Character " +
      "baselines and protected choices are read-only; sourcePaths do not grant writes. " +
      (sandboxed
        ? "The networkless /story sandbox cannot use host Git, paths or credentials."
        : "Do not stage, commit, reset or checkout; Git diff/status inspection is permitted."),
    doneWhen:
      "The canonical schema 0.1 Event files have complete YAML frontmatter and " +
      "substantive Markdown. If this is the first Event or a discovery Milestone, " +
      "author the discovery and Character access NOW with justified in-scene " +
      "knowledge effects, rather than asking who should author the discovery. " +
      "The Story does not require a pre-existing discovery Event to start. " +
      "Every named speaking witness or central actor present in the scene must be an " +
      "existing canonical Character listed in this Event's typed participants. " +
      "Use the existing cast; if a missing Character is genuinely essential, " +
      "report that dependency before any edits rather than creating the Character " +
      "or beginning an incomplete Event. " +
      "A new in-scene observation or explicitly sourced testimony " +
      "may establish evidence without a pre-existing Fact or earlier Event; do not invent " +
      "off-screen history or promote uncertain claims to truth. Show evidence before " +
      "justified inferences/effects. " +
      "A nondecision Event needs no artificial typed effect. A scene may OFFER " +
      "optional witness testimony or voluntary cooperation without requiring either " +
      "for unconditional rescue or observational Milestone fulfillment. However, " +
      "accepted, refused or withdrawn witness responses are NOT enacted unless actual " +
      "typed Event branches and effects support them. If the approved Story needs " +
      "those alternatives later, describe them as separately authorized conditional " +
      "Event work in laterObligations, not as accomplished source facts, required " +
      "current Composition dialogue or an excuse to leave the mandatory rescue unfinished. " +
      "Do not claim testimony, consent, trust or forgiveness from an unbound offer. " +
      "If the authored Milestone requires " +
      "an enacted player decision, produce a reachable setup, preserve partial Milestone " +
      "completeness with empty fulfillment.any_of, and leave formal outcome binding for Choice. " +
      "A setup Event is complete unless its own text claims the decision enacted. " +
      "Before setting a Milestone complete, compare EACH material clause of its " +
      "selected change/outcome and narrative promise with the player's actually " +
      "reachable observations, testimony and access in this Event. An observation " +
      "of an empty or locked place NOW does not prove it was continuously locked " +
      "or inaccessible EARLIER; neither a witness claim nor a possible discrepancy " +
      "alone proves that all the Milestone's evidence has been established. " +
      "For a promised contradiction, test the claims against an independent observation " +
      "the player can inspect: an undated physical trace cannot establish the disputed timing. " +
      "Do not confuse the selected Milestone's YAML decisions: entries, which " +
      "preserve delegated/protected AUTHOR authority, with executable formal " +
      "Choice Points. A linear Event where the player identifies the subject " +
      "and starts investigating does NOT require a future Choice to fulfill " +
      "that initial nondecision turning point. Later choices may remain " +
      "unbound without preventing its source-supported fulfillment. " +
      "For a nondecision Milestone, THIS Event assignment owns BOTH delivering " +
      "each material evidence clause and binding its reachable Event IDs in the " +
      "selected Milestone's fulfillment.any_of and completeness fields. " +
      "An NPC expressing their own wishes, consent or future intentions does not enact a player Choice. " +
      "A later response decision does not keep a completed recovery, testimony or preference-setting Milestone partial. " +
      "These two YAML fields are already writable for you; formal Milestone binding " +
      "is NOT a separate future reviewer/Choice assignment for nondecision work. " +
      "Independent review occurs AFTER the validated Event commit. " +
      "Deliver the material evidence in a reachable in-scene observation or identified, " +
      "uncertainty-qualified testimony, including which relevant spaces or people " +
      "were accessible if the selected Milestone asks for access evidence. " +
      "Do not substitute present absence for past access proof; a genuine limited " +
      "witness account can establish what that witness observed without claiming " +
      "omniscient certainty. If one observation is insufficient, revise this Event " +
      "or author a causally linked second Event within the existing writable scope. " +
      "Do not merely leave a nondecision Milestone partial, or delegate its " +
      "evidence OR formal fulfillment binding to an unspecified later Event, " +
      "interactive owner or reviewer; a complete nondecision Milestone requires " +
      "genuine reachable evidence AND its narrow YAML binding NOW. " +
      "Partial completeness and empty fulfillment.any_of are appropriate for an " +
      "unbound later formal Choice or a genuinely impossible out-of-scope requirement, " +
      "but a reported conflict is NOT a successful Event. Do not fabricate a " +
      "completed route or change protected canon to pass this gate. " +
      "For a completed nondecision Milestone, bind only genuinely fulfilled routes. " +
      "Call story_validate without arguments, repair introduced errors and revalidate; " +
      "independent controller checks remain authoritative." +
      (assignment.milestoneBlueprint ? " REVIEWED LOCAL PLAN: The independent Milestone " +
      "Blueprint is PROVISIONAL, not canonical evidence that any Event exists. Implement " +
      "its current Event obligations through actual reachable observations and earned " +
      "Character knowledge; preserve later interactive/Composition ownership. Its private " +
      "plan and digest grant no new writable paths or protected-canon decisions. " +
      "If upstream requirements cannot be met, report the blocker without out-of-scope edits." : ""),
    laterObligations:
      "Include a concrete laterObligations entry naming formal Choice binding, " +
      "missing outcome effects and later consumers; defer Puzzle and final prose. " +
      "When optional testimony, consent, refusal or withdrawal is mentioned but not " +
      "enacted by this Event, specify the needed later conditional Event routing " +
      "and effects rather than promising playable testimony in the current scene. " +
      "Missing Choice, Puzzle, " +
      "clue, or composed scene records are NOT blockers for this Event setup; write the " +
      "bounded Event now rather than requesting those later units first. Never invent " +
      "a Choice Point ID or unrelated effects to claim completion. For truly impossible out-of-scope or " +
      "protected prerequisites, make NO edits and return concrete conflicts/obligations; " +
      "only the controller may authorize changed scope.",
    requiredOutput:
      "Return one unfenced JSON object with cumulative Story-relative " +
      "modifiedRecords, architecturalConflicts and laterObligations arrays. Include all " +
      "changed records. An optional authorDecisionRequest for consequential ambiguity " +
      "MUST use field kind, never type, with value free-text, yes-no, " +
      "alternatives or multiple-choice. Free-text needs question and optionally " +
      "placeholder; yes-no needs question; alternatives and multiple-choice need " +
      "question and 2–4 options with concise {id,title}, optionally description, " +
      "benefits/tradeoffs and recommendation. Choices include Other. For routine " +
      "creative questions, allowStudioDecision:true requests optional Studio " +
      "delegation; only controller policy can permit it. " +
      "Do not request author permission for a discovery Event already in this " +
      "authorized work item. No choice authorizes protected changes. " +
      "No-write prerequisite reports have modifiedRecords:[] and must precede " +
      "any edit. For a genuinely impossible upstream causal obligation ONLY, " +
      "the no-write manifest MAY include causalDiscovery:{sourcePath,sourceQuote," +
      "violatedObligation,proposedCorrection}. Cite an exact 20+ character quote " +
      "from the current canonical selected Milestone, and a verbatim establishes/" +
      "purpose/downstream obligation in the independently reviewed local plan. " +
      "A contradiction or reviewer request is NOT permission to change Architecture; " +
      "the controller will independently verify and authorize any adjustment. " +
      "When authored Event evidence contradicts an approved LOCAL plan obligation, " +
      "you may add blueprintChallenge:{pinDigest,field,before,proposed,sourceQuote,path,line,violatedObligation} " +
      "to the completed manifest. Cite an exact changed Event line and one existing material " +
      "events/<index>/<field> or downstream/<index>/<field> with full before/proposed values. " +
      "This reports a challenge for later independent/controller checks; NEVER edit the private plan. " +
      "An authored Event with an in-scope evidence gap needs a bounded " +
      "same-session correction, not an invented downstream owner. The graph verifies " +
      "source, manifests, authority and validation.",
    assignmentLabel: "AUTHORIZED ASSIGNMENT",
    assignment,
    authorInstruction: specialistAuthorInstruction(assignment.authorTask),
  });
}

/** A malformed author question is never permission to replay the writer or
 * ask the author to approve work already owned by this Event assignment. */
export function eventQuestionCorrectionFeedback(error: unknown): string {
  return "CONTROLLER-REJECTED AUTHOR QUESTION: " + String(error) + ". " +
    "An empty events/ directory is normal. If this Milestone requires " +
    "the discovery, YOU are the Event writer authorized to create its " +
    "reachable, source-grounded discovery scene under the SAME Event " +
    "record grant. Do not ask for another Event writer or a separate " +
    "approval to author the discovery. Show who discovers what and when, " +
    "with only justified in-scene Character knowledge effects. " +
    "Keep protected and other-owner records unchanged. If a genuine " +
    "consequential question remains outside your grant, use EXACT " +
    "authorDecisionRequest field kind (never type), with value " +
    "free-text, yes-no, alternatives, or multiple-choice and the supported option fields. " +
    "Otherwise author the Event, run story_validate, and return the " +
    "complete cumulative modifiedRecords, architecturalConflicts and " +
    "laterObligations JSON arrays. This is one bounded correction in " +
    "the SAME Pi session, not a writer replay or new authority.";
}

export function eventInvocationDirectory(job: JobStartResult, workItem: string, sessionId: string, sourceDigest: string) {
  if (!/^event-[a-z][a-z0-9-]*$/.test(workItem) || !/^[a-zA-Z0-9-]+$/.test(sessionId) || !/^[a-f0-9]{64}$/.test(sourceDigest))
    throw Error("Invalid Event invocation identity");
  return join(job.stateDir, "event-invocations", workItem, sessionId, sourceDigest);
}

export async function authorEventCluster(
  job: JobStartResult, snapshot: SkillSnapshot, assignment: EventAssignment,
  provider: string, modelId: string, onSession: (file: string, id: string) => Promise<void>,
  verifyDraft: (evidence: EventEvidence) => Promise<(string | AssignmentDefect)[]>,
  original: { sourceDigest: string; sessionFile?: string; sessionId?: string;
    authorize: () => Promise<void>; effect: () => Promise<string | null> },
  resume: SpecialistChoiceReceipt | undefined, reroutedFrom: string | undefined, round: AssignmentRoundCommand,
): Promise<EventEvidence | { round: AssignmentRoundResult }> {
  const project = await openStoryProject(job.worktreeStoryRoot);
  const config: SkillConfig = { discovery: "explicit-only", novelteaSkills: snapshot.path,
    skillDirs: [], requiredSkills: ["nt-event-design", "nt-catalog"] };
  const { loader, settingsManager } = createProjectResourceLoader(project, undefined, true, config);
  await loader.reload();
  const { skills, diagnostics } = loader.getSkills();
  for (const diag of diagnostics) if (diag.type === "error") throw new Error("Event skill discovery: " + diag.message);
  for (const name of ["nt-event-design", "nt-catalog"]) {
    if (!skills.some(s => s.name === name && s.filePath.startsWith(join(snapshot.path, "skills") + sep))) {
      throw new Error("Missing pinned Event skill " + name);
    }
  }
  const runtime = await createJobModelRuntime();
  const sessionDir = join(job.stateDir, "event-sessions", assignment.workItemId,
    ...(reroutedFrom ? ["rerouted-" + reroutedFrom] : []));
  const context = await preparePiContext(job, project, {
    // A fresh bounded reassignment must not fork the no-write author's settled Pi session.
    group: piNarrativeGroup("event", assignment.sourcePaths, assignment.milestoneId) +
      (reroutedFrom ? ":rerouted-" + reroutedFrom : ""),
    step: "event:" + assignment.workItemId + (reroutedFrom ? ":rerouted-" + reroutedFrom : ""),
    paths: assignment.sourcePaths, snapshot: snapshot.id,
    task: { kind: "event", ids: [assignment.milestoneId], scope: "related" },
    provider, model: modelId, directory: sessionDir, insideWriter: true,
  }, runtime);
  const existing = resume?.sessionFile ?? original.sessionFile;
  if (existing && (await realpath(existing) !== existing || !existing.startsWith(sessionDir + sep) || !(await lstat(existing)).isFile()))
    throw Error("Original Event session is outside its assignment");
  const sandboxTools = await selectSandboxPiTools(job, snapshot, skills);
  const { session } = await createAgentSession({
    cwd: project.root, modelRuntime: runtime, model: context.model, thinkingLevel: context.thinking, resourceLoader: loader, settingsManager,
    sessionManager: existing
      ? SessionManager.open(existing, dirname(existing), project.root)
      : context.manager,
    customTools: [...(sandboxTools ?? []), createStoryValidateTool(job), context.contextTool, createPiStatusTool()],
    noTools: "all", tools: [...SANDBOX_TOOLS, "story_context", "story_validate", "report_status"],
  });
  try {
    if (context.thinking && session.thinkingLevel !== context.thinking) {
      throw new Error("Pi Event specialist did not honor pinned thinking effort.");
    }
    const file = session.sessionManager.getSessionFile();
    if (!file || (resume?.sessionId ?? original.sessionId) && (resume?.sessionId ?? original.sessionId) !== session.sessionId)
      throw Error("Event writer lost its original persisted session");
    await onSession(file, session.sessionId);
    const required = REQUIRED.map(name => join(snapshot.path, "skills", name));
    let accepted: EventEvidence | undefined;
    const direction = resume?.answer
      ? "AUTHENTICATED AUTHOR ANSWER: " + authorChoiceDirection(resume.question, resume.answer, resume.delegationAllowed === true) +
        "\nContinue in this exact session without changing protected decisions.\n" : "";
    const settled = await executeAssignmentRound({
      session, directory: eventInvocationDirectory(job, assignment.workItemId, session.sessionId, original.sourceDigest),
      sourceDigest: original.sourceDigest, sessionRoots: [sessionDir], responseKind: "event-manifest-or-choice",
      initialTranscriptSha256: resume?.sessionSha256,
      initialPrompt: context.contextNote + direction + eventSpecialistPrompt(snapshot, assignment, Boolean(sandboxTools)),
      authorize: original.authorize, effect: original.effect,
      beforeTurn: async () => {
        const control = await readJobControl(job);
        if (control === "cancelled") throw new StoryCancelledError(assignment.workItemId);
        if (control !== "running") throw new AssignmentAuthorPauseError();
        await guardPiBudget(job, "event:" + assignment.workItemId, file);
        const after = await readJobControl(job);
        if (after === "cancelled") throw new StoryCancelledError(assignment.workItemId);
        if (after !== "running") throw new AssignmentAuthorPauseError();
      },
      prompt: async prompt => {
        await registerPendingPiSession(job, file);
        await promptStorySpecialist(session, prompt);
        await recordPiSession(job, file);
      },
      verify: async manifest => {
        const skillReads = completedPinnedSkillReads(session.messages, project.root, snapshot.path);
        const missing = required.filter(path => !skillReads.includes(path));
        if (missing.length) return missing.map(path => ({ kind: "requirement" as const,
          path: assignment.milestonePath, code: "missing-pinned-skill-read",
          detail: "Read skill://" + path.slice(path.lastIndexOf("/skills/") + 8) }));
        const common = { skillReads, sessionFile: file, piSessionId: session.sessionId };
        if ("authorDecisionRequest" in manifest) {
          accepted = { ...common, claimedPaths: manifest.modifiedRecords as string[], conflicts: [], obligations: [],
            authorQuestion: parseSpecialistChoice(manifest.authorDecisionRequest) };
          return [];
        }
        const summary = parseEventManifest(JSON.stringify(manifest));
        const completed = new Set(session.messages.filter((m): m is Extract<typeof m, { role: "toolResult" }> =>
          m.role === "toolResult" && !m.isError).map(m => m.toolCallId));
        const calls = session.messages.flatMap(m => m.role === "assistant"
          ? m.content.filter(c => c.type === "toolCall") : []);
        const evidence: EventEvidence = { ...common, claimedPaths: summary.modifiedRecords,
          conflicts: summary.architecturalConflicts, obligations: summary.laterObligations,
          causalDiscovery: summary.causalDiscovery, blueprintChallenge: summary.blueprintChallenge };
        if (!summary.modifiedRecords.length) {
          if (resume || calls.some(c => ["write", "edit"].includes(c.name)) || await original.effect() !== null)
            throw Error("Event no-write prerequisite report follows a writer tool or author-choice resume.");
          accepted = evidence;
          return [];
        }
        if (!calls.some(c => ["write", "edit"].includes(c.name) && completed.has(c.id) &&
            typeof c.arguments?.path === "string" &&
            relative(project.root, resolve(project.root, c.arguments.path as string)).split(sep).join("/").startsWith("events/")))
          throw Error("Event specialist did not author canonical Event Markdown with an editing tool.");
        const diagnostics = await verifyDraft(evidence);
        if (!diagnostics.length) accepted = evidence;
        return diagnostics.map(detail => typeof detail !== "string" ? detail : ({ kind: "semantic" as const, path: assignment.milestoneId,
          code: createHash("sha256").update(detail).digest("hex"), detail }));
      },
    }, round);
    if (settled.status !== "accepted") return { round: settled };
    const invocationProof = settled.proof;
    if (!accepted) throw Error("Original Event invocation has no independently checked result");
    await context.completed(file, session.sessionId);
    return { ...accepted, invocationProof };
  } finally { session.dispose(); }
}
