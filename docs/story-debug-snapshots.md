# Private Git Story-state snapshots

A **Story debug snapshot** is a private, retained Git commit containing
the actual filesystem contents of the Job's Story worktree at an execution
boundary. It can capture malformed YAML, added files, deleted records,
and edits that have not passed validation. It is not a verified generation
checkpoint, an approval, or an authorized branch update.

Unlike attempting to replay Pi's nondeterministic tool/model calls, these
snapshots reproduce the actual Story bytes that were observed. They do not
attempt to reproduce the order of commands that created those bytes.
Use [deterministic execution replay](deterministic-execution-replay.md)
to replay the corresponding recorded reviewer response, native validation,
or controller decision against those inputs.

## Automatic capture boundaries

The common serialized Story-job lock records `before-work` and `after-work`
snapshots around Foundation, Architecture, Character/World, Event,
Interactive Choice/Puzzle, Composition, Focus, idea placement, and repair
writer phases. Exceptions preserve `work-failed` snapshots without
overriding the original exception.

During these specialist leases, the shared native-validation adapter
records `validation-attempt` before validation and
`validation-failed` when validation does not pass. A rejected independent
review additionally pins the **original reviewed Git commit**, not a newer
HEAD, under `review-failed`.

When the job lock detects a dead owner and archives its stale lock, the
uncommitted Story state is captured as `interrupted` under the previous
work-item identity before subsequent reconciliation. This does **not**
authorize automatic resumption or overwrite ambiguous edits.

Diagnostic snapshot failures emit a warning but do not convert a valid
Story change into a failure or obscure the original error. In particular,
the normal writer reconciliation, native validation, and author-approval
rules are unchanged. Inspect warnings if snapshots were not captured.

## How it works

Snapshots use a disposable `GIT_INDEX_FILE` and Git's `read-tree`,
`add -A`, `write-tree`, `commit-tree`, and `update-ref` plumbing.
The real index, working files, current branch and HEAD are untouched.
The snapshot commit has the original HEAD as its parent and is pinned by
a per-Job ref under `refs/noveltea-gen/debug-snapshots/`. Git data and
refs live in the underlying repository's local object database; a
private receipt lives under `<Job stateDir>/story-debug-snapshots/`.

The snapshot stages **tracked and nonignored untracked files within the
Story root**, including deletions, and never stages unrelated untracked
files outside the Story root. Untracked files ignored by `.gitignore`
are intentionally excluded (including secrets, caches and build outputs).
The private `.story-inbox/` is excluded from newly captured Story
modifications; if already tracked in the baseline Git tree, the baseline
still contains that tracked content. Story snapshots are bounded to 2,048
paths and 32 MiB of working files, so oversized cases warn rather than
silently capture partial files.

Private Git refs are not pushed by normal `git push`, but `git push
--mirror`, repository backups or Git-object exports may include them.
Treat the repository object store and these receipts as private while
snapshots are retained.

## Developer CLI

Use the original Story root and the original Job ID, with the normal
`NT_STATE_DIR` and `NT_GIT_CACHE_DIR` settings for that Job:

```bash
cd ~/dev/noveltea-gen

pnpm story:snapshots -- list <Story-root> <Job-ID>

pnpm story:snapshots -- capture <Story-root> <Job-ID> event-debug before-work

pnpm story:snapshots -- restore <Story-root> <Job-ID> <snapshot-UUID> /tmp/nt-reproduce-event

pnpm story:snapshots -- prune <Story-root> <Job-ID> 16
```

`restore` creates a **new independent local clone** at the requested
destination, checks out the exact private snapshot commit detached,
and returns the corresponding Story directory. The destination must not
already exist and cannot be inside the original repository, active worktree
or durable Job state. Parent symlinks are resolved to avoid redirected
restores. The clone is independent of the parent Git object store, so
subsequent snapshot pruning will not invalidate its restored content.

The restored checkout is for inspection and tests only. It is **not** a
new production Job and does not carry over author approvals, private
session credentials or a trusted verified-head receipt. Running the
native CLI against it is fine; do not publish it as verified Story
output simply because the Git commit exists.

## Retention

Automatic retention keeps the most recent **48 routine** snapshots per
Job (`before-work`, `after-work`, `validation-attempt`), pruning
older routine refs and receipts at work boundaries.

All `work-failed`, `validation-failed`, `review-failed`, and
`interrupted` snapshots remain pinned indefinitely; automated pruning
never removes these potentially unique failure states. The `prune`
CLI applies only to routine snapshots. Git garbage collection may
reclaim the discarded objects after their refs are deleted; restored
independent clones are unaffected.

As with the existing private Pi transcripts, snapshots can contain
sensitive Story material. Do not commit these Git refs or their
receipts to a shared repository, and inspect any proposed regression
fixture before copying content into test sources.
