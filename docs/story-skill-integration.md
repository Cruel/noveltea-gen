# Studio ↔ portable skills integration contract (#157)

This is the **Gen consumer** handoff for ADR 0002 and
`Cruel/noveltea-skills#35`. The portable skills are methodological input; Studio's
existing LangGraph/controller is the only production scheduler and the only
source of Story write authority. Do not call the removed skills-repository
`pnpm collaborate` runner or resurrect its staged host.

## Current cross-repository source evidence (2026-11-12/13)

The local `~/dev/noveltea-skills` checkout was clean at the final #35 revision:

- Git commit: `3d798d5aada9f38e48a694f3f39ee73a86a02e25` (#35 closed)
  (the original Gen-side certification used `b51f012`; no `skills/` bytes changed between these revisions)
- Studio whole-`skills/`-tree snapshot SHA-256:
  `f0aa51fa1b1e0a74c1e6cc5f8647691f8f3f18c631061b51754cb1981660e872`
  (`createSkillSnapshot`, `dirty: false`)
- `nt-story-orchestrate/SKILL.md` SHA-256:
  `cc699324c6a08bbba31cd793826e2cc42991f4b2df8285692327e74db81655a7`
- `nt-story-collaborate/SKILL.md` SHA-256:
  `9282185f277fc82569e3d540abf0a2dccb50057bc6d06fda7e2808ab213a1c47`
- `nt-story-discovery/SKILL.md` SHA-256:
  `c48d2c0cf4d59a35fa8cec1d8a5cd323f555feae7c76a2e1dce3156ac39c2da7`
- `nt-catalog/SKILL.md` SHA-256:
  `de23abb4777d3cb324b7f78da4c3101f832e437d741011ddcee6012b41eb096d`

The per-method hashes identify source-file contents; the whole-tree Studio
snapshot ID above separately covers every file in `skills/`. `createSkillSnapshot`
records the source Git commit and preserves the original bytes.
New workflows may select a newer verified snapshot; an already selected
workflow must use its original snapshot/receipt, never the current checkout.

## One matrix, two responsibilities

The skills repository owns portable method evaluation and matched guided/control
Pi authoring comparisons. Gen owns controller gating, verified Story source,
pinned method reads, authorization and recovery. The aligned scenario IDs are:

| Canonical Story | Mode | Skills-side scenario | Gen-side assertion |
| --- | --- | --- | --- |
| Empty | Autonomous | `story-orchestrate--new-autonomous` | Full-Story objective, baseline discovery and complete composition obligations, **no** Collaborative skill visibility |
| Empty | Collaborative | `story-orchestrate--new-collaborative` | Same full-Story depth and discovery, plus required pinned Collaborative method and interaction reference |
| Existing | Autonomous | `story-orchestrate--existing-autonomous` | Scoped, original-source-bound revision; only verified paths writable; **no** Collaborative skill visibility |
| Existing | Collaborative | `story-orchestrate--existing-collaborative` | Same limited revision, with Collaboration method reads; no implied permission or extra writes |

`test/story-skill-matrix.test.ts` asserts those four planning contracts and
read boundaries with a temporary Git skill checkout on every offline run.
With `NT_SKILLS_CHECKOUT` set it also inspects the **actual upstream**
checkout, verifies all pinned method and catalog references, checks source
provenance and preserves its Git status. The tests intentionally make **no**
model calls and **no** claims about generated Story quality.

`src/story-skill-policy.ts` is the single method-read contract consumed by
the objective planner, recovery admission and matrix tests. The orchestrator's
resource loader and sandbox read tool both obey the Turn's Creative mode:
Collaborative guidance is visible only to Collaborative orchestration. Normal
specialists cannot read the orchestrator, Collaborative method or reviewer
method; reviewers are separately read-only. Adjacent craft and `nt-catalog`
are readable guidance, never delegated writing authority. New-Story discovery
always uses `nt-story-discovery` and catalog under their own verified author
approval boundary; the objective planner does not replace that boundary.

## Expand–contract upgrade and actionable failures

- **Expand**: ship `nt-story-orchestrate`, `nt-story-collaborate`,
  `nt-story-discovery` and `nt-catalog` in a verified skill checkout before
  opening new Turn work. Historical `nt-story-generate` may remain in source
  packages for archival consumers, but no Studio runtime selects or exposes it.
- **Contract**: migrate `nt-story-generate` out of machine-local
  `.local/config.json` `requiredSkills` for new workflows. Gen continues to
  load an explicitly configured legacy package when it exists, so older
  configurations do not break during the overlap; it never exposes that skill
  as a live orchestrator or silently aliases it. If the legacy package is gone,
  the configuration fails with an actionable rename/restore diagnostic. Use
  `nt-story-orchestrate` if explicitly listing methods for new work.
- **Pinned sessions**: existing `orchestrator-selection.json`,
  `objective-planning.json`, prior generation checkpoint and model/skill
  receipts remain bound to their original snapshot. On interrupted work
  recover from the verified original pinned state. Never mutate the snapshot,
  replay an in-flight Pi writer, or substitute a newly renamed method.
  Historical untagged, already checkpointed generations retain their old
  path; new untagged real-Pi work is refused.
- **Mismatch**: a missing required method/reference, changed snapshot bytes,
  incompatible old method, stale objective, changed assignment or missing
  read receipt blocks work. Verify the source checkout, installed skills,
  native CLI version, exact cache identity and owner/source HEAD; only then
  create an explicitly reviewed new continuation from the verified source.
  Recovery diagnoses absent method/reference names without exposing local
  checkout paths. Author approvals cannot be copied into a new session.

The existing Git worktree and writer lock, native CLI, protected-canon
approval ledger, assignment-owner isolation, independent review, bounded
creation/dependency amendments, and crash-recovery receipts remain unchanged.
A portable skill is **not** a second scheduler, approval token or bypass.

## Reproduce Gen and skills-side checks

From `~/dev/noveltea-gen`:

```sh
pnpm exec tsx --test test/story-skill-matrix.test.ts \
  test/skills.test.ts test/orchestrator-selection.test.ts \
  test/orchestrator-planner.test.ts test/recovery-compatibility.test.ts
NT_SKILLS_CHECKOUT="$HOME/dev/noveltea-skills" \
  pnpm exec tsx --test test/story-skill-matrix.test.ts
pnpm check
git -C "$HOME/dev/noveltea-skills" status --short
git -C "$HOME/dev/noveltea-skills" rev-parse HEAD
sha256sum "$HOME/dev/noveltea-skills"/skills/{nt-story-orchestrate,nt-story-collaborate,nt-story-discovery,nt-catalog}/SKILL.md
```

From `~/dev/noveltea-skills` (upstream ownership):

```sh
pnpm test
pnpm typecheck
pnpm eval:global joint-skills evals/.runs/issue35-plan --installed --plan
# Credentialed model calls only when explicitly chosen:
pnpm eval:global joint-skills evals/.runs/issue35-with --installed --jobs 2
pnpm eval:global joint-skills evals/.runs/issue35-control --installed --jobs 2 --variant baseline
pnpm eval:certify joint-skills evals/.runs/issue35-with evals/.runs/issue35-control
```

See upstream `evals/joint-skills/README.md` and `review.md`. With #35
closed, its skills-side evaluation prerequisite is satisfied. The upstream
guided/live results at the recorded revision include partial new-Story outputs;
neither a fully playable completed Story nor independent editorial acceptance
has been demonstrated. These runs **must not** be reported as a Gen live-Pi
Story certificate. Production cutover, four-scenario completed live-Pi runs,
and downstream certification remain separate `noveltea-gen#158–#160` gates.
