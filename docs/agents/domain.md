# Domain docs

## Layout

This is a single-context repo:

- `CONTEXT.md` at the repo root: domain vocabulary and model.
- `docs/adr/`: architectural decision records.

## Before exploring

Read root `CONTEXT.md` and ADRs relevant to the area being explored.

If these files do not exist, proceed silently. Domain-modeling work
creates them lazily when terms or decisions are resolved.

## Use the glossary's vocabulary

Use terms defined in `CONTEXT.md` in issue titles, proposals,
hypotheses, and test names. Follow any explicit guidance about synonyms.

If a needed concept is missing, reconsider whether it belongs to the
domain or note the gap for domain-modeling work.

## Flag ADR conflicts

Explicitly surface proposals that contradict an existing ADR,
identifying the ADR and why the decision may be worth reopening.
