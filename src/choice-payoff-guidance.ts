/** #37: One source-to-payoff continuity rule used by the Choice author,
 * independent reviewer and original-writer repair. Only the native validator
 * and separately sealed review can decide acceptance; this guidance is not a
 * new schema or permission to revise source Event prerequisites. */
export const CHOICE_PAYOFF_AUTHOR = [
  "A Choice needs a REACHABLE selecting step BEFORE any outcome has been set. " +
    "At that step, give each player-selectable branch conditions: [] and a distinct " +
    "kind: outcome effect assigning that branch's Choice outcome. Exactly ONE " +
    "eligible branch executes; they are alternatives, not simultaneous effects. " +
    "Only LATER steps or Events may test kind: outcome conditions to consume " +
    "the previously established selection. NEVER test an outcome as a prerequisite " +
    "on the very branch that first assigns it: that creates a circular, impossible " +
    "branch and no player-facing selection. Do not rewrite an existing Event entry " +
    "gate to make this work; create or adjust only authorized selecting branches. ",
  "For EACH selected Choice outcome, trace its verified entry Event/step/branch,",
  "the immediate typed outcome AND consequential state effects, and the later",
  "reachable outcome-conditioned Event/step consuming that choice.",
  "Read the actual Relationship/Knowledge/Fact baseline and every relevant",
  "condition/effect along that route before writing. The downstream typed state",
  "must be causally consistent with the earlier effect AND its player-visible prose.",
  "An escalation from wary to estranged must involve an explicit, credible",
  "rupture on-page (such as ending cooperation), not merely becoming guarded;",
  "a move toward trusting requires an equally visible earned gesture.",
  "Dialogue must not say a Character knew, saw or proved a specific fact",
  "unless that Character had that knowledge on the reachable prior route.",
  "Replace unearned certainty with uncertainty, questions or a new witnessed",
  "discovery rather than inventing backstory or leaking a branch-exclusive Fact.",
  "Example of an UNJUSTIFIED reversal: the confrontation Choice immediately",
  "sets a Relationship to estranged, then its follow-up Event sets it to wary",
  "without a visible reconciliation or other new cause. Either ground the follow-up",
  "change in a playable encounter, correct the unsupported initial severity, or",
  "keep the truthful state unchanged. Do NOT manufacture a reconciliation,",
  "invent a Fact, or coerce Relationship severity to make routes appear different.",
  "When an unchanged source Event only sets up the Choice and offers no new",
  "state change, the Choice owner MAY author a NEW, connected conditional Event",
  "in its existing bounded grant to actually ENACT each selected consequence.",
  "Show a playable action, Character response and evidence in that Event BEFORE",
  "a justified typed effect. The player choosing to protect or confront someone",
  "can itself cause a witnessed reaction and changed trust; it does not require",
  "inventing a new Fact or retroactively adding knowledge to the setup.",
  "Do not stop at outcome-only selection branches or defer BOTH meaningful",
  "payoffs if this Choice unit is authorized to write their conditional Events.",
  "Check the source Event, the selecting branch, each consumer, and the authored",
  "dialogue against the SAME causal timeline. If the appropriate downstream",
  "consumer belongs to a later writer, provide an exact conditional obligation",
  "naming the Choice, outcome, typed effect and consumer needed, not a fake Event.",
].join(" ");

export const CHOICE_PAYOFF_REVIEW = [
  "NovelTea 0.1 Event-step selection semantics: conditions: [] makes a branch",
  "ELIGIBLE, not executed. Exactly ONE enabled branch executes at a step.",
  "Multiple empty-condition branches can be valid player-selectable alternatives,",
  "each writing a DIFFERENT Choice outcome. They do not execute together.",
  "Do NOT require mutually exclusive condition guards on a selection step or",
  "claim that both outcomes are assigned simply because both branches are enabled.",
  "Instead verify the actual Choice Point prompt and player-facing options,",
  "each distinct reachable outcome route, and its causal payoff. A missing",
  "player-visible choice or unsupported outcome still fails.",
  "For interactive Choice review, check EACH reachable outcome's committed",
  "selector Event/step/branch, immediate typed effects, subsequent conditional",
  "consumers, and player-visible source prose as a SINGLE ordered causal chain.",
  "Reachability or distinct effect values alone are NOT proof of narrative payoff.",
  "Compare Relationship/Knowledge/Fact values before and after the choice;",
  "require proportionate on-page acts for either wary-to-estranged or",
  "estranged-to-wary, and reject claims a Character knew evidence not yet seen.",
  "an estranged-to-wary transition without a cited reconciliation or other",
  "in-scene cause is a continuity defect, even if both route branches are reachable.",
  "Cite the EXACT offending changed path and source line/typed slot and name",
  "the read-only predecessor path in the required correction. Do not require",
  "later Puzzle, Composition or Milestone-closeout work at the Choice checkpoint.",
  "Treat truthful alternative routes and expressly deferred later consumers",
  "according to the existing Choice stage contract. Never infer a new effect",
  "or pass a cosmetic prose-only correction that leaves contradictory typed state.",
].join(" ");

export const CHOICE_PAYOFF_REPAIR = [
  "If native validation reports impossible-branch or impossible-prerequisite " +
    "on a newly authored outcome Event, first check for self-conditioned selection: " +
    "the first assignment of an outcome must be an effect of an eligible " +
    "conditions: [] branch, and only subsequent consumers may condition on it. " +
    "Correct the local selecting step and downstream references within the " +
    "original grant; never force reachability by editing a protected Event gate. ",
  "For a rejected Choice assignment, compare the original outcome selector",
  "and typed effect with the offending later conditional Event/step/branch;",
  "repair BOTH the committed causal state and visible explanation within",
  "the original permitted changed files. Do not merely paraphrase prose or",
  "hide the mismatch. If the actual predecessor effect is read-only, propose",
  "the necessary other-owner amendment rather than rewriting that source.",
  "When the setup has no valid state effect, add an in-scope downstream",
  "conditional Event with a playable reaction and correctly timed state change",
  "instead of inventing a Fact or changing protected entry prerequisites.",
  "A genuine estranged-to-wary transition requires an enacted, credible cause;",
  "if none exists, preserve the previous state or reduce an unsupported effect",
  "ONLY where that effect is within the original Choice writer's grant.",
  "Never change protected decisions or Event entry prerequisites.",
].join(" ");
