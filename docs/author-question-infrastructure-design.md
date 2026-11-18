# Shared Author Questions — design

Status: accepted design; the implementation specification is GitHub issue #182 and the local author-question infrastructure spec.

## Goal and existing foundations

Provide one reusable author-question infrastructure for NovelTea Studio's inline new-Story baseline discovery, collaborative generation, and future bounded clarification workflows. Reuse the existing `SpecialistChoiceQuestion` parser and `AuthorChoicePanel` interaction machinery instead of building a separate questionnaire engine. A question is not an approval, and its presence does not confer authority to change protected Creative Decisions.

`src/specialist-choice.ts` currently mixes question definitions/validation with Job, session, and immutable specialist receipt handling. `web/src/components/author-choice-panel.tsx` similarly mixes reusable controls with specialist-specific status and continuation text. Extract the general parts; retain workflow-specific evidence and orchestration responsibilities. In keeping with [goal-driven orchestration](adr/0002-goal-driven-story-orchestration.md), new-Story baseline discovery is part of the normal Story Chat flow, not a second production scheduler or onboarding wizard.

## Question and response contract

An **Author Question** has a stable identity, prompt, response kind, optional recommendations and explanation, and optional bounded relevant context. Supported input kinds initially:

- **Single choice**: select one of the proposed alternatives or provide a custom answer.
- **Multiple choice**: select multiple nonexclusive alternatives and optionally add a custom answer.
- **Yes/No**: a convenience specialization of single choice with fixed options and an available custom answer.
- **Free text**: open-ended author direction; may include an optional model-supplied placeholder for guidance.

Each option needs a concise title; optional description, benefits, trade-offs, and recommendation rationale can be exposed progressively. The old specialist parser's mandatory approach/benefits/trade-offs for every alternative is not imposed on brief onboarding choices. No numeric or numeric-range input kind initially: authors can express numbers and ranges naturally in free text. Input types do not constrain the separate structured planning representation. No arbitrary UI markup, agent-supplied components, nested arbitrary forms, ranking input, or general-purpose conditional-form language.

Every question may request a **Let NovelTea Studio decide** answer, but only trusted workflow policy can permit it. `allowStudioDecision?: boolean` is a suggested request flag, not an authority grant. Where permitted, delegation is visually **selected by default** for both discovery and collaborative generation; it is provisional until the author submits the Question Set. Where prohibited, no delegation option is shown and an explicit answer is mandatory. A visible recommendation does **not** select that recommendation or imply author agreement. A delegated answer is a distinct structured response, not a fabricated choice ID.

Structured answers retain exact selected option IDs, optional custom text, optional additional notes, and whether the response is an explicit answer or delegation. For multiple choice, delegation is exclusive of selected choices/custom input. Preserve exact free-text wording. The agent may receive a readable projection of the answer, but the persisted author response remains structured. Explicitly unanswered is distinct from delegated and from answered; drafts have no author-decision authority.

## Question Sets and lifecycle

A **Question Set** contains one or more Author Questions, a stable identity, a session revision, a trusted workflow binding, and answer drafts. Both a single specialist question and a multi-question baseline discovery use this abstraction.

1. The controller accepts and validates an entire proposed Question Set before showing it. A set stays fixed while the author answers it; dependent questions belong to a later round after prerequisites are answered.
2. The UI renders a question or compact themed batch with reusable controls; Studio does not arbitrarily limit the count to cause additional model calls. Model prompts should avoid questions that depend on unsettled answers.
3. Draft answers are saved server-side per author and Question Set, debounced and deduplicated. Typing feels immediate, with no Save button or editor-wide dirty indicator. Reloads restore drafts. Concurrent tabs must not silently overwrite a newer draft.
4. Every question in a submitted set must have an explicit answer or permitted delegation. There are no optional/skippable questions in the initial schema; incomplete required responses block submission, but all draft work stays saved. The submission affordance summarizes explicit answers and delegated decisions (for example, "Submit 3 answers and delegate 5 decisions").
5. Submit all answers **atomically** against the matching Question Set identity and revision, authenticating the author. A stale/replayed submission is rejected without destroying drafts. Submitted answers form immutable decision evidence; changing them afterward is an explicit new version/new direction, not an in-place rewrite of history.
6. After acceptance, continue the waiting workflow automatically when all other prerequisites permit it. Record acceptance before attempting continuation. If the worker fails, preserve the answers and show the appropriate Continue/recovery action; never repeat the author interview or automatically replay an uncertain model write.

A structured question is not automatically an approval. Protected-canon changes, goal/scope expansion, and Foundation approval remain separate trusted authorization operations. A delegated question never bypasses these gates.

## Agent/controller boundary and ambiguity

Agents propose question content, response kinds, options, optional placeholders, recommendations, and requests to permit delegation. The trusted controller validates bounded field lengths, unique/valid IDs, allowed answer kinds, references, recommendation targets, workflow ownership, delegation policy, and exact session revision. Malformed proposals are rejected. A single bounded corrective generation attempt is permitted only when safe and before any question set has been accepted; if it fails, surface a recoverable error. Do not silently drop material alternatives, fabricate questions, or infer authorization.

Qualitative author intent may be normalized internally when unambiguous enough to proceed. Use existing `StoryPlanning` categories: `branching.depth` (`linear/shallow/deep`), `branching.route_exclusivity` (`none/limited/substantial`), `choice_frequency`, `choice_impact`, and `pacing`. Do not invent a 0.0–1.0 scale with undefined semantics. For example, "somewhat linear, but not too much" can become shallow branching with limited route exclusivity; it does not determine choice frequency. Quantitative planning metadata remains appropriate where the quantities have defined units (such as playthrough minutes).

Preserve the author's original response and the normalized **Planning interpretation** as distinguishable evidence. Identify whether the value was explicitly selected, inferred from the author's words, or chosen by Studio after authorized delegation. Ask another Author Question only when credible competing interpretations materially change the Story, contradict existing constraints, or require protected author authority. The proposed Creative Direction must present the resulting interpretation for exact author approval; approving it confirms the proposal, not a fictional literal quote from the author.

The Studio session may keep full question-and-answer history, but canonical Creative Direction in the Git repository must retain sufficient source-backed decisions and rationale to understand approved requirements without Studio's database. Reuse Creative Decision records and concise provenance references where possible rather than duplicating the full transcript or introducing a separate Git-tracked questionnaire record. Do not confuse agent-origin delegated details with user-origin protected statements.

## Reuse and ownership

- **Shared domain module:** question/set/answer types; strict parsers; answer and recommendation validation; stable structured answer rendering. Extract from `src/specialist-choice.ts` while retaining existing specialist-specific receipt fences.
- **Shared presentation:** question controls and Question Set renderer, with controlled state and accessible labels. Extract from `AuthorChoicePanel`; adapt its existing radio/textarea patterns and add checkbox-based multiple selection. Remove implicit recommendation preselection and workflow-specific status text from common controls. Only user-facing "NovelTea Studio" terminology; no references to Pi in labels, messages, or question copy.
- **Shared lifecycle:** draft persistence semantics, set revision/submit validation, and answer-state model. Workflow-specific adapters own where state lives and which continuation to trigger.
- **Discovery adapter:** inline first-Story baseline question rounds, structured answer histories and interpreted Foundation proposal; existing textual question format is unsupported and may be reset (pre-v1, no migration/dual reader).
- **Generation adapter:** retain specialist work-item identity, immutable source-bound receipt, session/worktree digest, Job lock, checkpoint recovery, and controller authority. Answering should normally resume the paused specialist automatically through existing safeguards; the generic Question Set must not replace those receipts.

## Acceptance scenarios

- Single collaborative question and multi-question discovery both use the same question controls, validation, and submission contract.
- For an allowed delegation, the default is visibly selected but no authority exists before submission; explicit selections override it. Delegation disallowed means author input is required.
- Recommended options are visibly recommended, never auto-selected as the author's choice. Multi-select may combine preset options and custom text.
- Free text accepts a bounded, agent-supplied placeholder without treating it as an answer.
- Incomplete mandatory answers block submission and survive reload; a complete mixed answer/delegation set submits atomically. Parallel tabs cannot submit conflicting revisions silently.
- Related questions may appear in a batch; dependent questions are asked only after prerequisite answers are submitted.
- Invalid options, stale question identity, duplicate submission, forged delegation, and approval bypass are rejected by the controller.
- Accepted answers survive failed continuation and resume safely without duplicate model calls or lost author evidence.
- User's ambiguous branching preference maps to existing qualitative planning categories while preserving the original words and distinction between explicit author choices, inferences, and delegated Studio choices.
- Git-only Story readers can understand the approved Creative Direction without the Studio question session; no user-facing implementation-provider terminology.
- Old textual discovery sessions can be reset rather than migrated. Existing unrelated implementation changes remain untouched.

This document describes the **design**, not an implemented feature. Implementation details, sequencing, and test certification belong in later work.
