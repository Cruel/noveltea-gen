# Native Story validation and historical job compatibility

Issue [noveltea-gen#14](https://github.com/Cruel/noveltea-gen/issues/14) defined
the stable `noveltea-validator/v1` job envelope. Issue
[noveltea-gen#22](https://github.com/Cruel/noveltea-gen/issues/22) adopts the
native CLI for Story context, structural validation, readiness and Git protection.

## New jobs

The canonical implementation is the **native** `noveltea` executable.
Specify `NT_NATIVE_CLI=/absolute/path/to/noveltea` or install it on `PATH`.
The first validation pins the real executable path and SHA-256 in
`validator.json` and the job manifest. Its bytes are checked on each use;
the generator never rebuilds a validator from `noveltea-skills`.
Missing or changed executables fail closed rather than silently upgrading
a job to a different Story authority.

The generator invokes `noveltea --json narrative validate <story> --base
<verified-commit>` and `noveltea --json narrative readiness <story> --stage
review --view design` (the native response includes approved readiness).
The native `catalog.records`, `coverage`, and source-located diagnostics
are forwarded; readiness and outstanding obligations are taken directly
from the native readiness response. Native protection `findings` are
mapped to the existing job-facing `protection.changes` and `warnings`
fields without altering canonical decisions or author authorization.
The generator does not implement Story parsing, reachability, or
relationship traversal.

A valid commit with no historical Story Markdown is a **checked empty
baseline**, not an invalid commit. New records appear in `impact.changed`;
author authorization remains unverified. Missing/unreadable commits,
malformed historical records, a mismatched Git base, missing native
fields and invalid CLI output must never pass validation.

Pi writing specialists use a `story_validate` tool bound to the job's
worktree Story root and trusted baseline; regular Bash tools are not
rewired and there is no job-local `noveltea` shim. The generator
independently validates before acceptance, and no tool grants author
approval. Context selection uses the native `story_context` manifest.

## Existing pinned jobs

Jobs with a saved `canonical-typescript-bundle` receipt continue to
validate with their **original** content-addressed executable, provided
the receipt and artifact remain intact. No automatic repinning, migrating
or fallback to the live skills checkout is allowed. The esbuild-based
historical adapter remains solely for compatibility and deterministic
transport fixtures (the latter use `NT_VALIDATOR_TEST_LEGACY=1`).
New production jobs always use native validation, irrespective of
`--validator-source`.

## Acceptance

The parity suite `test/validator.test.ts` compares both validators on
the canonical reference Story, including unchanged content, protected
decision edits, malformed metadata, readiness design/approved minima,
and downstream impacted IDs. It tests native empty and invalid baselines,
new-job pinning and legacy continuity. Run:

```sh
NT_SKILLS_CHECKOUT=/absolute/path/to/noveltea-skills \
NT_NATIVE_CLI=/absolute/path/to/noveltea \
  pnpm exec tsx --test test/validator.test.ts test/story-context.test.ts
```

The native upstream suites `tests/native_cli/narrative.py` and
`tests/native_cli/narrative_git.py` independently certify
structural/parsing, readiness, protection, impact, and empty-history
behavior. The native parser labels a decision in an invalid record
`record-deleted` whereas the TypeScript catalog can label it
`removed`. Both mark authorization indeterminate: normalize neither
into a clean pass. Separate semantic/editorial and human-approval
processes remain mandatory.
