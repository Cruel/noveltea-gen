# Narrative validator adapter and native cutover contract

Issue [noveltea-gen#14](https://github.com/Cruel/noveltea-gen/issues/14) establishes a
single public, read-only `job validate` entry point. Its `noveltea-validator/v1`
envelope is stable; graph and Pi callers should consume the envelope and canonical
diagnostic fields rather than importing an experimental schema implementation.
The first validation pins a standalone esbuild bundle of the **current**
`noveltea-skills/src/cli.ts`. This executable is **not** the skill snapshot and
is not loaded from the source checkout on subsequent job runs.

## Replacement ownership and preconditions

Native [Cruel/nt#526](https://github.com/Cruel/nt/issues/526) owns public
read-only Story validation; [Cruel/nt#535](https://github.com/Cruel/nt/issues/535)
owns verified Git-baseline protection and change-impact diagnostics. Neither
is implemented here or presumed usable. Replace
`bundledValidatorAdapter` in `src/validator.ts` with a native-backed
adapter only after both native contracts are certified. Keep previously pinned
experimental bundles usable by their original jobs (or perform an explicit,
auditable migration); never silently reinterpret old pins as new validators.

The adapter must continue accepting the **job's worktree Story root** and
recorded **base SHA**, rather than the author's checkout or current HEAD.
Return source locations and deterministic errors with the same public envelope.
A native backend must be runnable against a standalone Story outside an engine
project, without requiring `pnpm`, schema duplication, or creating engine files.

## Parity cases (must be executable before cutover)

| Scenario | What to compare |
| --- | --- |
| Reference Story, committed baseline | Canonical valid/invalid verdict; no diagnostics; design and approved readiness per stage; explicitly unverified claims |
| Invalid record frontmatter or typed reference | Diagnostic code, relative source path and location, exit class |
| Impossible Event/Puzzle conditions | Logic diagnostics and bounded reachability; do not infer creative completeness from a zero-error result |
| Changed or deleted user-protected decision | Stable decision IDs, change kind and source paths; action required remains separate from verified author approval |
| Related record changed | Changed/moved ID lists, downstream affected IDs and relationship evidence |
| Empty or invalid Git baseline | Explicitly unverified/error status, never a protection pass based on HEAD |
| Canonical paths and monorepo sibling Stories | Same relative paths and only the selected Story; no engine reads |
| Lost executable on an old job | Fail closed, do not replace from current source or native runtime |

Ordinary deterministic tests in `test/validator.test.ts` exercise the public
CLI, bundle pinning, content corruption, isolation and exit statuses using a
small **transport fixture**, not another narrative schema. When the
`noveltea-skills` checkout is available, the same suite also bundles and
tests the *real* canonical reference Story: positive validation,
source-located schema failure, and protected-decision/impact warnings.

The gated native parity test in that file uses the **same** disposable Git
worktree and base SHA for both engines, comparing diagnostics, readiness
stage minima, explicit unverified conditions, protected-decision changes
and impact. Run when native #526/#535 expose their public JSON path:

```sh
NT_SKILLS_CHECKOUT=/absolute/path/to/noveltea-skills \
NT_NATIVE_CLI=/absolute/path/to/noveltea \
  pnpm exec tsx --test test/validator.test.ts
```

The test currently anticipates `noveltea narrative validate
<story-root> --base <sha>` with JSON output. Align the invocation with the
*certified* native CLI flags during cutover; do not guess that a future
unreleased command already meets the contract. Report native parity as
**not run** until both upstream implementations and the opt-in test pass.
Do not keep a long-term independent Node narrative authority afterward.
