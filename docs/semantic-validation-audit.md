# Semantic validation and lexical-heuristic audit (November 2026)

Discovery's model-authored Creative Decisions and planning interpretations must never be authorized or rejected through keyword overlap. Source identity and delegation are deterministic controller facts; semantic relevance requires a separate independent, read-only Pi review. The reviewer cannot grant permission, alter protected canon or write Story files. Unsupported or uncertain findings must be corrected or clarified.

## Implemented in this change

- src/planning-interpretation.ts: resolveDelegatedDecision now checks only the exact submitted, authorized delegation; lexical topic matching is gone.
- src/planning-interpretation.ts: parsePlanningInterpretations retains source/basis/shape/numeric gates but no longer infers topic scope from display wording or a hardcoded question-ID vocabulary.
- web/src/lib/onboarding-pi.server.ts: every sourced creative decision and planning interpretation now receives a distinct, tool-less Pi semantic-scope assessment before a proposal can reach author approval.
- Reviewer output has one bounded assessment per controller-constructed claim ID, with negative or uncertain verdicts blocking acceptance. Malformed reviewer JSON gets bounded same-session format correction.
- Reviewed proposal, packet and verdict digests are bound privately; raw Pi transcripts, rejected outputs and verdicts remain inspectable. Author approval requires the exact reviewed proposal digest.

## Nearby lexical checks: audit findings

1. src/planning-interpretation.ts assertPlanningConsistency: natural-language regexes for contradictory/qualified branching and Puzzle requirements remain. They are fail-closed contradiction tripwires, never grants, but can misread unfamiliar language. Follow up with independent semantic clarification while retaining exact categorical and numeric checks.
2. web/src/lib/onboarding-pi.server.ts needsOpeningQuestions: presence of familiar words heuristically determines brief completeness. Follow up with source-bound completeness assessment, not keyword counts. It currently errs toward asking additional questions.
3. web/src/lib/onboarding-pi.server.ts explicitFullDelegation: natural-language regex recognizes broad 'decide everything, do not ask' intent. This does not approve protected canon, but typed affirmative user delegation should eventually replace natural-language pattern matching as durable consent. High-priority follow-up.
4. web/src/lib/onboarding-pi.server.ts question authority words: a conservative negative tripwire rejects approval/permission requests inside Question Sets. It does not grant approval; exact author approval remains required.
5. web/src/lib/story-revision-plan.ts: keyword/title overlap proposes revision targets and detects possible protected edits. This is advisory triage; verified catalog, trusted scope, and protected author approval determine write authority. Review false-positive and false-negative pauses, never elevate keyword match to a grant.
6. src/steering-intent.ts: literal canonical IDs and catalog-name recognition provide target hints only; not authorization.
7. src/composition-work.ts: literal clue and Revelation references are conservative negative leakage tripwires; absence of a match is not proof of semantic safety, and independent editorial review remains mandatory.

## Required acceptance evidence

- Replay the actual failed #181 proposal from immutable private transcripts into a disposable Studio database. Do not modify the original failed run.
- Verify that an unrelated artwork decision with a real ending delegation fails independent review, while fabricated or nondelegated source identities fail deterministically.
- Verify uncertainty, missing or duplicate assessment IDs, reviewer format failures, source-bound verdict receipts, and refusal of approval when an exact reviewed-proposal digest is absent.
- Live Pi semantic judgment and the full Story generation graph require a new certification. Fixture verdicts prove controller behavior, not independent creative-review accuracy.
