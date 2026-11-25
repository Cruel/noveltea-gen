# Persistent Review cycles and incremental causal Story planning

Status: accepted; supersedes specific review-continuity, semantic retry and semantic-finding identity rules in [ADR 0005](0005-bounded-correction-and-recovery.md). See [spec #201](https://github.com/Cruel/noveltea-gen/issues/201).

## Context

The existing full-Story causal Architecture Blueprint asks specialists to design and independently review detailed evidence, branching and route causality before canonical Arc/Milestone implementation. Correction is limited to two revisions. Each substantive reviewer iteration starts a fresh Pi conversation while the original writer retains its conversation, so the reviewer loses its continuing analysis. The earlier recovery policy also tracks semantic findings and fixed per-finding/Turn correction ceilings. These choices can cause a productive iteration to fail prematurely, or force separate issue identities onto creative concerns best judged in context.

## Decision

**Independence does not require reviewer amnesia.** One Review cycle binds an authorized writer and a different independent, read-only reviewer to one coherent assignment/scope and source lineage. Both keep their own Pi conversation across corrections, with the reviewer's current verdict explicitly accounting for earlier concerns, actual source changes, new material blockers and regressions. A materially changed assignment starts a new cycle with relevant prior evidence. When safe, interrupted sessions resume from their original persisted history; unrecoverable conversations may be replaced from verified evidence. Conversations are contextual evidence, never write grants or approval authority.

**Convergence replaces fixed semantic correction counts.** Continue while actual blockers are being resolved or materially improved and resource budgets permit. A changed draft, more words or discovery of another issue alone is not progress. Two consecutive nonproductive corrections cause reassessment. Repeated new blockers or a soft review-depth check around four or five rounds can trigger a fresh independent Diagnostic review for drift, genuine overlooked defects or overly broad scope. Diagnostics may recommend continuation, valid new review/reviewer replacement, plan change or escalation, but do not waive current-stage acceptance requirements, overwrite historical verdicts or authorize writes. Ordinary semantic loops do not fail merely because two or three revisions have occurred. Existing protocol/infrastructure retry rules and job resource ceilings remain independently enforced.

**Keep semantic analysis separate from execution authority.** Reviewers interpret evolving findings. The trusted controller preserves verified source/review lineage, authorization, native checks, Git checkpoints, revalidation of affected dependents, budgets and idempotent recovery. Do not add a semantic issue ledger. Simplify the existing Repair ledger to the minimum controller execution and recovery records genuinely needed; routine review progress must not depend on matching creative concerns by category/affected path or allocating fixed per-finding semantic correction counts.

**Plan causality at the appropriate depth.** A compact provisional Story Blueprint establishes the premise, viable causal solution, major Arcs/Milestones, consequential decisions and endings, and Story-wide production/pacing obligations. It does not require exhaustive evidence observations or individual scenes. Reviewed canonical Arc/Milestone records then own the Story structure. Just-in-time provisional Milestone Blueprints derive detailed Event evidence/access, knowledge/state, local Choices and downstream responsibilities from verified prerequisites. An obligation may be deferred only to its explicit downstream owner; a later-stage implementation obligation is not itself a current-stage defect. A discovered global impossibility may cause a controller-authorized upstream amendment and selective revalidation, preserving unaffected verified content and protected author decisions. Private Blueprints never supersede canonical Story records.

**Implement incrementally in the single production graph.** Introduce one reusable Review cycle policy and source-bound recovery contract, migrate the causal Blueprint gate first, then existing specialist and postcommit review boundaries. Reuse the existing production start/resume/inspect, validation, Git and model-budget facilities. Verify deterministic recovery/convergence cases before expensive real-Pi and full-Story certification.

## Relationship to earlier decisions

[ADR 0002](0002-goal-driven-story-orchestration.md) remains authoritative on the single goal-driven orchestrator and trusted authorization. [ADR 0003](0003-story-interaction-budget-and-estimation.md) remains authoritative for Playthrough length, Interaction profile and Production budget. [ADR 0005](0005-bounded-correction-and-recovery.md) continues to govern immutable source evidence, safe corrective authority, protocol failures, job budgets and cross-domain revalidation, **except** where it prescribes fresh reviewer sessions after every substantive correction, hard per-finding/Turn semantic correction exhaustion, or persistent semantic finding identity matching as the basis of ordinary review progression. Those rules are replaced by this decision and spec #201.

### R14L qualification evidence (#272)

The [existing recovery contract](../generation-recovery-contract.md) and
[source-linked exit inventory](../recovery-exit-inventory.md#r14l-incremental-qualification-272)
record the typed parent/child disposition checks, authenticated Review
successor consumption, and integrated deterministic Studio Turn regression
on SQLite and PostgreSQL. This implements the existing ADR boundaries;
it does not establish a new recovery controller or change this decision.
Paid/live certification remains #260 under #246 and its R14A–L migrations.
