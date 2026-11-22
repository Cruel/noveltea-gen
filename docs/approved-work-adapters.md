# Approved-work correction adapters (#232)

The trusted generation controller has one post-approval policy (ADR 0005): a
challenge is **evidence**, not a write grant or a revocation of an earlier
review. The controller authenticates the exact old approved version, its
source and the current Turn/scope; author-protected changes still need exact
author approval. A material correction gets new validation and an independent
review. The prior Git commit and review are never rewritten. Affected
dependents are revalidated while unaffected, independently reviewed work can
be carried forward. Origin classification and warning severity use
`classifyApprovalRevisionCause` and `approvalRevisionSeverity`.

## Existing boundaries

- **Milestone Blueprint** (`src/milestone-blueprint-correction.ts`):
  deterministic Event-only contradictions and authenticated specialist or
  independent Event-review challenges can contest an original reviewed pin.
  The controller verifies Turn ownership, unchanged source lines, historical
  review and original Pi provenance, then authorizes a bounded material patch.
  `ensureMilestoneBlueprint` independently reviews the successor. The existing
  Repair ledger records the incident and pending/settled supersession.
- **Architecture causal amendment** (`src/causal-amendment-controller.ts`,
  `src/architecture.ts`): a source-bound no-write Event discovery can contest
  a previously independently reviewed canonical Architecture Milestone.
  Admission verifies the exact Event Pi/no-write receipt, its reviewed
  Milestone Blueprint, native-validated canonical source, current plan and
  unaffected reviewed checkpoints. The discovery cannot authorize a write.
  The existing author-signed `architecture propose/approve` plan revision
  grants one narrowly scoped correction, preserving the old Architecture
  checkpoint and review. The production graph validates the new commit,
  independently reviews the replacement and selectively carries/revalidates
  downstream work. `src/architecture-approval-revisions.ts` projects **that
  signed history and those independent checkpoints** into the same operator
  incident inspection and private activity as Milestone Blueprint repairs,
  without another mutable approval ledger. Pending correction and
  independently reviewed settlement have distinct dispositions. Until
  historical independent review is available, the adapter does not claim
  that it has evidence of an approved *reviewed* Architecture artifact.
- **Reviewed specialist commits** (`src/semantic-assignment-review.ts`,
  `src/rejected-review-repair.ts`, `src/review-repair-amendment.ts`):
  negative reviews already use source-bound correction assignments and
  independently re-reviewed successor commits; other-owner repair uses
  controller-admitted dependency amendments and revalidation. These are
  correction mechanisms, not additional provisional Blueprint approvals.
  Their ordinary review progression remains in the existing review/Repair
  receipts, rather than manufactured Blueprint-version incidents.

## Operator evidence and limitations

`job approval-revisions inspect`, `job report`, and private generation
activity expose the same issue identity and origin policy for Milestone
Blueprint and Architecture causal amendments. The Architecture incident ID
comes from the signed plan proposal and sealed Event report. Its original
independent review digest and successor review digest come from the original
Git checkpoint receipts; absence of the successor verdict remains
`awaiting-review`. A later revision does not rewrite the incident. A later
source-backed specialist discovery **alone cannot prove** that a defect was
already visible when the original approval was issued, so the origin is
`unclassified` (operator warning), not falsely `approval-escape`.

The **remaining distinct adapter** is a free-standing, post-approval semantic
challenge directly to a reviewed **Story Blueprint** when there is no
authenticated canonical Milestone contradiction/Event causal amendment.
That would need its own source-specific challenge binding and authorization
to the existing Architecture versioned-plan review lifecycle; a model claim
must not be permitted to repoint the original Story Blueprint pin or bypass
the existing author-signed plan gate. No blanket migration of specialist
reviews or new scheduler is required by #232.

The high-level regression in `test/generation.test.ts` (the certified
predecessor / signed causal continuation scenario) tests original approval,
material correction, pending and settled independent evidence, restart,
forged Event and signed-history mutations, and unchanged Foundations across
a later plan revision.
