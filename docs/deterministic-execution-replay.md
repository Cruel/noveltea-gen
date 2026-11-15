# Deterministic execution replay

This is a **debugging and regression mechanism**, not an alternative to running
Pi. `replay` never sends model requests, opens a Studio writer, authenticates an
Author, resumes a previous agent session, or changes a saved Thread verdict.
A new model generation is a **retry**, not a replay.

## Recorded boundaries

All cases share the write-once `noveltea-step-replay/v1` format:
`manifest.json`, `input.json`, `expected.json`, SHA-256 checksums, exact
source Job and checkpoint SHA, and an explicit executor type. A successful
replay recomputes the outcome using the current production code and compares it
to the **recorded original result**. It returns a nonzero process status when
outcomes change, source integrity fails, or the required native version is
unavailable. Sources and expected outcomes are not rewritten to make tests pass.

Available executors:

- **`reviewer-model-turn`** replays a specific original Pi response through
  production `parseSpecialistJson`, failed-finding kind normalization, verdict
  schema/provenance validation and controller review-receipt projection.
  This covers malformed first responses and later corrections independently.
- **`review-verdict`** replays the final saved reviewer response and produces
  the same independent per-checkpoint result as the production controller.
  It can be captured only after matching that output to a verified, sealed
  review receipt.
- **`review-repair-plan`** re-executes the pure, authorization-bounded
  review-to-repair amendment decision using a recorded negative verdict,
  original assignment, and assurance proof. It never issues a repair grant.
- **`review-dependency-gate`** reproduces the graph's blocked-assignment and
  native work-item prerequisite decisions from recorded inputs.
- **`native-validation`** stores a private Git bundle of actual source objects
  and reruns the production native validator on the **exact original commit and
  baseline SHA** in a disposable local clone. The replay normalizes only the
  temporary checkout prefix in the report, then compares report digest, status,
  exit code, and key validation metadata. No specialist or reviewer is regenerated.

These are **specific recorded boundaries**, not arbitrary full agent/tool-call
reexecution. Deterministic reprocessing of an interrupted writer's uncommitted
tool calls, or every multi-step LangGraph controller transition, is not yet
available. Such state is preserved for manual reconciliation, never blindly
re-executed. Semantic disagreement with a reviewer can be reproduced and
inspected, but deterministic replay cannot prove how a different LLM prompt
would respond.

## Capture from a preserved Job

Start with an existing, verified Story Job and a finalized specialist checkpoint
SHA. Set the ordinary `NT_STATE_DIR`, `NT_GIT_CACHE_DIR`,
`NT_SKILL_CACHE_DIR`, `NT_NATIVE_CLI`, and `NT_CONFIG_FILE` variables as
needed to open the preserved run. For the private Story root and Job ID, use
values from its existing `certification-source.json`, not a newly created Job.

```sh
pnpm replay:step -- list-review-turns <Story-root> <Job-ID> <checkpoint-SHA>
pnpm replay:step -- capture-review-turn <Story-root> <Job-ID> <checkpoint-SHA> 0 .local/replays/event-review-first-turn
pnpm replay:step -- capture-review <Story-root> <Job-ID> <checkpoint-SHA> .local/replays/event-sealed-review
pnpm replay:step -- capture-native <Story-root> <Job-ID> <checkpoint-SHA> .local/replays/event-native
pnpm replay:step -- replay .local/replays/event-review-first-turn
```

Use a **new** output directory for each recording. The capture operation
refuses to overwrite existing cases. It authenticates exact checkpoint and
review source evidence, extracts the immutable reviewer packet and the
corresponding saved JSONL message, and verifies the original sealed verdict.
`list-review-turns` reports indices without printing prompts or model content.
`capture-native` requires a finalized checkpoint with passing native validation.

No cloud service or credentials are needed. The **current native CLI version
must equal the original** for native replay; intentionally upgrading validator
code at a new version requires a separately reviewed expected outcome.

## Reproducing a regression

1. Capture the failing model turn, final review and/or native specialist output.
2. Run them offline once to verify the recorded failure reproduces.
3. Make a code change, replay the **same case directory** and check the mismatch
   (nonzero exit status). The runner prints the actual and original results.
4. Only after accepting the changed behavior, create a separate reviewed case
   with the new intended expected output. Never silently rewrite historical
   evidence.

To promote a reproducible case into a permanent regression fixture, **review
the recording for private Story text, personal content, model traces or secrets
first**, then copy only approved sanitized data to
`test/fixtures/execution-replay/<case-name>/`. The offline test suite
automatically discovers these directories. Original private captures belong
under ignored `.local/replays/` and must not be committed without review.

## Security and limitations

Replay uses only recorded inputs and deterministic production functions. Native
replay invokes local `git` and the installed NovelTea validator against a
temporary checkout, which is deleted after use; it does not execute Git hooks or
model tools. All recordings are private by default (directories 0700, files
0600). SHA-256 manifests detect modified bytes, **not** forged data from a
person able to rewrite the manifest. Replay outcomes are diagnostic evidence,
never authorization to replace sealed reviews, approve protected decisions,
or publish Story changes.

Because a model's intrinsic judgment is nondeterministic, recording its output
allows replay of our parsing, validation and controller response, **not** proof
that prompt changes would make another invocation agree with a human.
