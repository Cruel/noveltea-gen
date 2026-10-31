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
owns verified Git-baseline protection and change-impact diagnostics. Both
native contracts are implemented in the `nt` checkout as of commit `0f296921d`
(2026-10-30), and the native acceptance and generator parity suites passed.
The generator itself is **not yet cut over**. Replace
`bundledValidatorAdapter` in `src/validator.ts` with a native-backed
adapter as part of the explicit cutover, retaining the stable job envelope. Keep previously pinned
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

The current native command is `noveltea --json narrative validate <story-root>
--base <sha>` and returns `catalog` inside the standard `success`/`exitCode`
JSON envelope. Readiness is a separate `noveltea --json narrative readiness`
command. The opt-in parity test now checks both readiness views, diagnostics,
protected decisions, impacted IDs, invalid source, and empty/invalid baselines.

**Verified 2026-10-30:** `nt` native `narrative.py` and `narrative_git.py`
acceptance passed, and all 11 generator validator tests passed with
`NT_NATIVE_CLI` pointing at the refreshed `build/cli/linux/noveltea`. The
native parser classifies a protected decision in a structurally invalid record
as `record-deleted`, whereas the TypeScript catalog uses `removed`; both block
and mark authorization indeterminate. The generator must not erase this
uncertainty when adapting the report.

**Remaining cutover work:** Pi currently gets a job-local `noveltea` symlink
that supplies the trusted base implicitly. Simply deleting the shim is unsafe:
the Pi prompts use `noveltea narrative validate . --json` (native requires
the global `--json` option before `narrative`) and omit `--base`. Update agent
Bash wiring and instructions so the real native executable is selected and
validation is bound to the correct worktree and trusted job baseline. Update
the job validation adapter to normalize native diagnostics, readiness, impact,
and protection into `noveltea-validator/v1`, without silently replacing
historical pinned TypeScript bundles. For a trusted commit containing no Story
Markdown, native `--base` currently returns `baseline-invalid` / protection
`unavailable`; preserve the existing structural-only **unverified** first-run
handling, without converting invalid or missing baselines into a pass. Remove
the shim only with end-to-end agent/job certification of that replacement.
Do not keep a long-term independent Node narrative authority afterward.
