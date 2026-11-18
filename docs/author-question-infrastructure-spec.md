# Shared Author Question infrastructure — specification

## Problem Statement

NovelTea Studio already pauses collaborative generation for a structured specialist **Author choice**, but its new-Story **Baseline discovery** still presents model-written questions as a raw text block with one unstructured answer field. The same problem will recur when other Studio workflows need bounded clarification. Authors must interpret numbered prompts, write out option selections, and explicitly request Studio to decide every unresolved item; the interaction does not reliably distinguish an author selection, a custom answer, delegation, and a missing answer. There is duplicated validation and presentation logic, unnecessarily verbose alternatives, and confusing internal-provider terminology.

The underlying specialist mechanism already verifies that an answer belongs to the exact waiting Job, session, and worktree. Replacing that machinery or building another onboarding questionnaire would increase complexity and risk. Authors also express creative preferences imprecisely (e.g. “somewhat linear, but not too much”); the application needs useful structured planning interpretations without misquoting the author, inventing numeric precision, or silently granting protected-canon approval.

## Solution

Introduce a reusable, bounded **Author Question / Question Set** system across inline Baseline discovery, collaborative Story generation, and future clarification flows. A Question Set is one or more related Author Questions; a single specialist interruption is a set of one. Reuse and extract the existing specialist question parser/formatter and Author choice controls. Share question schema, response validation, answer semantics, accessibility, draft/save/submit lifecycle, and presentation. Keep each workflow's authority and continuation behind a trusted adapter: new-Story discovery owns its conversation and proposed Creative Direction; specialist generation retains source-bound receipts, Job locks, validated checkpoints, and protected-decision gates.

Support single choice, multiple choice, Yes/No and free text; concise labels, optional descriptions/benefits/trade-offs, optional recommendation with explanation, optional bounded Story context, and optional agent-supplied placeholder for free-text inputs. No numeric question control: authors can express quantities naturally; established `StoryPlanning` categorical and unitful numeric metadata remain the validated planning targets.

When the trusted workflow permits delegation, show **“Let NovelTea Studio decide”** preselected. This is provisional until the author submits the set, at which time a dedicated delegation answer records exact authorization for that bounded question. Display recommendations without treating them as selected author answers. Questions without authorized delegation require explicit responses. Preserve mixed explicit/delegated selections in a single atomic, authenticated, revision-bound submission; save drafts unobtrusively to the server and automatically continue the waiting workflow when safe. No model call or Story mutation occurs as a result of merely displaying or editing a draft.

Preserve exact author wording, structured selections, Studio's later delegated decisions, and provenance of planning interpretations. Translate imprecise author preferences into the existing qualitative planning categories where reasonable; ask again only when competing interpretations materially affect the Story or conflict with established constraints. Exact Creative Direction approval remains a separate operation, and the canonical Story retains sufficient rationale to stand alone without Studio's database.

This focuses on the shared author-interaction layer. It complements the established [goal-driven orchestration spec #144](https://github.com/Cruel/noveltea-gen/issues/144) and [Story-first spec #102](https://github.com/Cruel/noveltea-gen/issues/102); it does not add another discovery wizard or execution graph.

## User Stories

1. As a new Story author, I want discovery questions displayed as interactive controls, so that I do not need to compose an answer to a numbered text questionnaire.
2. As an author, I want multiple related questions presented together, so that I can make efficient decisions in one round.
3. As an author, I want a paused specialist to present the same question controls, so that Story discovery and collaborative generation feel consistent.
4. As an author, I want questions to offer clear single-choice alternatives, so that I can select a preferred creative direction quickly.
5. As an author, I want to select multiple compatible options, so that I can combine themes or requirements.
6. As an author, I want to add my own response to a multiple-choice selection, so that predefined options do not restrict my intent.
7. As an author, I want Yes/No questions to be concise, so that simple decisions do not require verbose alternatives.
8. As an author, I want free-text questions, so that nuanced creative direction is not forced into categories.
9. As an author, I want free-text placeholders that illustrate useful answers, so that I understand the requested level of detail.
10. As an author, I want placeholders to remain suggestions rather than answers, so that guidance is not mistaken for consent.
11. As an author, I want concise option labels with optional explanations, so that simple questions do not become lengthy questionnaires.
12. As an author, I want detailed benefits, trade-offs, and recommendation rationale available when relevant, so that consequential decisions are informed.
13. As an author, I want recommended options highlighted without being preselected, so that Studio does not attribute its preference to me.
14. As an author, I want relevant canonical Story context accessible with a question, so that I can understand its implications.
15. As an author, I want to see “Let NovelTea Studio decide” rather than references to the underlying model/provider, so that the workflow uses the application's terminology.
16. As an author, I want delegation preselected where allowed, so that I can submit without manually delegating every ordinary creative question.
17. As an author, I want delegation to take effect only when I submit, so that opening a form never grants authority by itself.
18. As an author, I want delegation to be unavailable for mandatory author-controlled decisions, so that protected canon stays under my control.
19. As an author, I want multiple choice and delegation to be mutually exclusive, so that my decision is unambiguous.
20. As an author, I want an incomplete mandatory question to prevent submission, so that Studio does not proceed without necessary authority.
21. As an author, I want unfinished responses saved as drafts, so that I can leave the page and return without losing progress.
22. As an author, I want draft fields to update immediately while saving quietly, so that typing never waits for persistence.
23. As an author, I want a summary of explicit answers versus delegated decisions before submission, so that I know what I am authorizing.
24. As an author, I want a submitted question set to be all-or-nothing, so that some answers cannot be accepted while others fail validation.
25. As an author using two tabs, I want newer drafts and submitted answers protected against stale writes, so that an older tab does not silently overwrite my work.
26. As an author, I want exact submitted answers to survive reloads and worker failures, so that I do not have to answer the same questions again.
27. As an author, I want Studio to continue generation after a successful submission when safe, so that I do not need to press a second Resume button.
28. As an author, I want an explicit recovery/Continue action if automatic continuation fails, so that Studio does not secretly repeat uncertain agent work.
29. As an author, I want subsequent questions to depend on settled earlier answers, so that I am not asked about irrelevant details.
30. As an author, I want my current set to remain stable while I answer it, so that fields do not disappear or flicker mid-edit.
31. As an author, I want to revise a previously submitted answer through an explicit new decision, so that the history is understandable.
32. As an author, I want Studio to interpret “somewhat linear” into a coherent branching plan, so that I need not understand internal planning categories.
33. As an author, I want my original words preserved alongside Studio's interpretation, so that my intent cannot be silently rewritten.
34. As an author, I want Studio to ask a follow-up only for material ambiguity or contradiction, so that routine decisions do not generate repeated interviews.
35. As an author, I want explicit choices, inferred planning values, and choices delegated to Studio distinguishable, so that their provenance remains clear.
36. As an author reviewing Creative Direction, I want to see the proposed normalized requirements, so that I can approve or request correction before Story generation.
37. As an author opening a Story from Git alone, I want its approved Creative Direction to explain important decisions, so that I do not need access to the Studio database.
38. As an author, I want questions and responses to remain private to my Story and session, so that another account cannot read or submit them.
39. As an author, I want malformed agent questions to fail safely, so that broken output cannot become a misleading choice or implicit approval.
40. As an author, I want the current creative objective and Story scope preserved, so that answering a clarification cannot silently broaden the assigned work.
41. As an author, I want existing unsupported pre-v1 question sessions to be explicitly restartable, so that obsolete formats do not require hidden migrations.
42. As a specialist developer, I want a shared question and answer contract, so that new contexts can use it without duplicating question UI and validation.
43. As a workflow developer, I want delegation policy and continuation owned by the trusted controller, so that an agent-proposed question cannot bypass author approval.
44. As a maintainer, I want the specialist source-bound receipt and recovery guarantees preserved, so that UI consolidation does not weaken execution safety.
45. As a maintainer, I want no additional full-purpose questionnaire framework or alternate execution scheduler, so that the implementation remains maintainable.

## Implementation Decisions

1. Define a reusable **Author Question**, **Question Set**, option, and structured answer model. A single author choice is a one-question set. Use canonical domain terminology from the project's glossary. Preserve stable question/set identities and owner/workflow/session-revision bindings.
2. Extract generalized question parsing, validation, answer formatting, and answer-type definitions from the existing specialist author-choice code. Retain specialist-specific receipt and checkpoint logic unchanged in responsibility; do not convert onboarding into a fake Job to reuse receipts.
3. Define the initial response kinds as **single choice**, **multiple choice**, **Yes/No**, and **free text**. Yes/No is a convenience specialization of single choice. All predefined-choice kinds support a custom Other response. Multi-choice may combine selections and custom text. No numeric/range UI type.
4. Agents may propose bounded question wording, IDs, response kinds, alternatives, concise descriptions, optional benefits/trade-offs, an optional recommendation and rationale, optional canonical context, and optional free-text placeholder. Option labels are required; verbose option essays are not. Use progressive disclosure for longer details. Reject arbitrary HTML/UI definitions.
5. Agents may request `allowStudioDecision`, but this is **not** the effective policy. The trusted controller independently determines whether delegation is permissible at that specific workflow and question boundary. Mandatory author approvals and protected-canon changes may not be delegated through this contract.
6. Where the controller permits Studio delegation, display **“Let NovelTea Studio decide”** selected by default. This initial UI selection is not a stored authorization until the author submits. Where delegation is prohibited, require a meaningful explicit answer and do not show the delegate option.
7. Preserve a distinct structured `delegate` answer kind (and distinct unanswered draft state). Do not encode delegation as a normal choice ID, silent omission, model-recommended answer, or boolean approval. Multi-choice selections and custom text cannot coexist with delegation on the same question.
8. Preserve exact selected option IDs, custom author text, optional guidance, authenticated submitter, time, question identity, and submission revision as structured evidence. The agent-facing prose projection must be deterministic and retain explicit/derived/delegated distinctions; never replace the authoritative structured answer with only prose.
9. Reuse and generalize existing Author choice UI, including accessible radio inputs, textareas, contextual references, and recommendations. Add checkbox-based multi-selection and a common Question Set view. Keep specialist lifecycle/status UI in a thin workflow wrapper. The shared UI receives validated questions and state, not Job receipts.
10. Keep **one common Question Set lifecycle**: accepted validated set → autosaved draft(s) → authenticated atomic submission → durable accepted answer(s) → workflow-specific continuation/recovery. One or multiple questions obey the same rules.
11. Keep a Question Set immutable while displayed. Ask dependent questions in later rounds after prerequisite answers are submitted, rather than implementing a general conditional-form language. Avoid arbitrary limits that force unnecessary agent calls; allow a coherent batch of independently answerable questions.
12. Save drafts server-side, scoped to user, set identity and revision. Use locally responsive controlled inputs with debounced/deduplicated persistence. The draft mechanism must not trigger generation, write Story canon, create an approval receipt, display an editor-wide dirty indicator, or treat an unsubmitted preselected delegation as authorization.
13. Submit the complete set atomically against exact identity/revision and authenticated owner. All questions require either an explicit valid answer or an allowed delegation; no optional/skippable questions initially. Validate stale/conflicting sessions, replay, malformed values, fake option IDs, and unauthorized delegation without accepting a partial batch. Stale writes must not silently overwrite drafts; preserve user-entered answers for recovery.
14. Accepted answers are immutable evidence. Later changed author direction creates an explicit subsequent decision/revision, and dependent plans are reconsidered as needed. Displayed recommendation highlighting never creates an answer.
15. After persisting accepted answers, automatically continue when all existing trusted workflow prerequisites are satisfied. If the worker crashes, fails, or leaves an ambiguous write, keep the accepted answer and expose existing Continue/reconciliation controls; do not automatically replay uncertain model writes or ask the author to resubmit.
16. Baseline discovery uses structured question rounds within normal Story Chat, preserving original first-Turn objective, established scope, and pinned discovery guidance. The model's question output contract changes from prose string to validated Question Sets; answer transcripts retain exact author wording and structured choice/delegation semantics. Do not revive a parallel onboarding wizard or second production scheduler.
17. Generation uses the same question controls and answer definitions but retains original Job/work item, immutable question proposal digest, agent session binding, Git HEAD/worktree digest, writer lock, LangGraph checkpoint/recovery semantics, and protected-decision authorization.
18. Maintain existing `StoryPlanning` qualitative categories (Choice frequency/impact, branching depth, route exclusivity, pacing, Puzzle emphasis) rather than inventing a vague 0–1 creative-preference score. Quantitative planning values with meaningful units (e.g. minutes and production limits) remain valid behind the free-text question UI.
19. Normalize reasonably interpretable author language into structured planning values, but preserve original author statement and the resulting **Planning interpretation** as distinct records. Evidence distinguishes explicitly chosen, inferred from author text, and Studio-decided under delegation. Do not invent user numeric limits, turn inferred choices into purported verbatim author instructions, or attribute agent choices as user-origin protected statements.
20. A new question is needed only when two or more credible interpretations have materially different implications, constraints conflict, or the trusted authority boundary requires explicit input. Exact Creative Direction proposal validation and approval remain mandatory before canonical generation.
21. Keep sufficient source-backed Creative Direction decisions/rationale in canonical Git Story records to stand without Studio's conversation database, using the existing decision/provenance approach with concise source references where necessary. Do not add a duplicate Git-tracked questionnaire transcript.
22. The controller rejects malformed question proposals (unsupported kinds, excessive length/count, invalid/duplicate IDs, nonexistent recommendation targets, invalid references, inconsistent answer kinds). At most one bounded corrective model attempt before accepting any set is permitted when safe; on failure, preserve state and report a recoverable error. No invented fallback questions or hidden approval.
23. Remove internal-provider references from **user-facing** discovery/question labels, status text, errors and controls. Implementation-facing identifiers and diagnostics may still use their technical terminology.
24. Pre-v1 legacy textual-question sessions need no conversion, migration, alias reader, or compatibility mode. Provide explicit restart/reset behavior for incompatible sessions rather than silently discarding or replaying them.
25. Respect the existing goal-driven orchestration and Story-first ADRs: baseline discovery is inline in the first Turn and Creative mode determines participation, never a separate authorization system. A submitted question does not grant write authority to the orchestrator or any specialist.

## Testing Decisions

**Primary test seam:** authenticated author-facing workflow endpoints and their persisted effects, exercised with deterministic injected model proposals. Drive both (a) normal first-Turn Story Chat discovery → structured question rounds → proposed Creative Direction → exact approval/continuation, and (b) paused specialist question → submitted answer/delegation → original checkpoint continuation/recovery. These are the highest existing behavioral seams that jointly exercise server validation, identity, persistence, authorization and orchestration without requiring a new test harness for every helper.

Existing precedent: Story Chat discovery and onboarding request tests, author-decision API and review-resume tests, and specialist-choice receipt/recovery tests. Retain focused shared-question contract and accessible UI tests as supporting seams only where endpoint tests cannot observe option rendering, keyboard/checkbox semantics, placeholders, or malformed-model parsing. Prefer user-visible outcomes and durable state over internal functions or snapshots.

1. Cover single/multiple/Yes-No/free-text input, optional custom additions, notes, agent placeholders, short options, recommendation rationale, and canonical context in both the one-question and batch presentation.
2. Verify recommended alternatives are not silently selected. Verify the permitted default delegation is visually selected but does not exist as an accepted answer or approval until submission.
3. Verify delegation only succeeds with trusted policy; attempt to forge the delegate answer, approval, an option ID, a question ID, and a cross-owner/cross-session request.
4. Verify every mandatory question is resolved before batch submission, mixed explicit/delegated sets are accepted atomically, and invalid/stale/replayed submissions leave no partial accepted answers.
5. Verify drafts survive reload, server restart and ordinary typing; a stale second tab cannot overwrite a newer draft; the UI remains responsive and has no unrelated Save/dirty workflow.
6. Verify question sets stay stable while answering, and new dependent questions arise in a later round without redundant prompts or forced multiple model calls.
7. Verify accepted answers survive worker failure, a resumed attempt uses only the original source-bound session/checkpoint and does not repeat author submissions or unsafe model calls.
8. Verify existing Job/worktree/session fences, writer-lock ownership, protected-canon approvals and original author objective remain effective after shared-component extraction.
9. Verify a model proposal with invalid/duplicate options, unknown response kind, invalid recommendation, oversized fields or forged authority is rejected; bounded corrective handling does not silently invent choices.
10. Verify “somewhat linear, but not too much” is preserved verbatim and can yield shallow/limited planning categories without manufacturing unrelated Choice frequency or arbitrary scalar precision. Contradictory requirements elicit clarification instead.
11. Verify user statements, explicit option selections, inferred planning values and agent-selected delegated decisions retain correct authority/provenance; canonical Creative Direction remains understandable with no Studio DB available.
12. Verify foundation proposal is not approval, no question/draft write mutates Story canon, and approval resumes the original first-Turn objective exactly once.
13. Verify existing unsupported textual-question sessions get an explicit restart path without compatibility parsing or extra provider calls.
14. Verify all author-visible labels use NovelTea Studio rather than underlying implementation/provider terminology.
15. Run the existing focused specialist-choice, Web discovery, generation-resume and Studio check suites; include a complete deterministic end-to-end certification path for initial Story discovery and one paused collaborative specialist. Reserve live agent/model certification for model-output quality and real-world question behavior, not routine request-contract checks.

## Out of Scope

- A parallel standalone collaborative scheduler, alternate generation graph, or separate new-Story onboarding wizard.
- A new Creative Direction schema version unrelated to minimal provenance needs; wholesale rewriting of canon or the native CLI.
- General-purpose custom forms, arbitrary agent HTML/components, nested conditional forms, drag-and-drop ranking, date inputs, and numeric or numeric-range question controls.
- A universal 0–1 narrative linearity or other undefined preference scoring system.
- Optional/skippable questions, partially committed Question Sets, silently accepted missing answers, or automatic approval under delegated decisions.
- Automatic replanning or wholesale Story orchestration changes already owned by #144 beyond required question handoff/continuation integration.
- Historic text-format session migration, compatibility readers, or preserving obsolete pre-v1 wizard flows.
- New model credential, provider, Git writer, checkpoint, or protected-canon approval mechanisms.
- An additional Git record containing the full Studio interview transcript.

## Further Notes

- The completed Q1–Q28 design interview is captured in the worktree's author-question infrastructure design document, proposed ADR 0004 on the shared question/authority boundary, and the root domain glossary. These are currently local/uncommitted source documents; the GitHub spec is self-contained.
- Implementation should be factored around shared question/answer schema, shared controls and set lifecycle, then thin discovery/specialist adapters, with tests at the authenticated workflow seams. A follow-up `to-tickets` step may split work by dependency if desired; this specification itself is one issue, not another set of speculative tickets.
- Existing specialist-choice option validation is deliberately stricter and more verbose than needed for simple discovery questions; extraction must preserve meaningful specialist behavior while allowing compact common alternatives. Existing recommendation preselection in the specialist panel must be removed.
- Resolve the existing overlap with #144 by treating #144 as owner of when/how baseline discovery is invoked and this issue as owner of reusable question presentation, answers, and submission. This spec does not alter the trusted original-objective or exact-approval gates.
