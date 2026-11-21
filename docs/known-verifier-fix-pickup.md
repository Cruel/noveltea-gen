# Known verifier fix pickup (#223)

Studio **never** wakes a stopped Turn just because a new build deployed. A
maintainer must declare the shipped fix's stable ID, the exact failed check
name, and the **failed** check version. Example agent environment:

```sh
NT_STUDIO_KNOWN_VERIFIER_FIXES='[{"id":"adaptive-parser-2026-11","check":"adaptive-plan.v1","failedVersion":1}]'
```

Use a new fix ID for each distinct software correction; IDs must be unique
within the manifest. An empty/unset manifest disables pickup. A malformed
manifest fails startup instead of silently broadening eligible work.

On agent startup the query uses only the new `generation_verifier_stops`
index. Historical and untyped stops are not backfilled. For each exact match,
Studio reacquires the original Story lock and checks the owner, same saved
Thread/Turn and request, verified Git HEAD and clean worktree, signed Turn
evidence, running job control, blocked graph checkpoint and original response
transcript prefix. Only then does one database transaction mark the original
blocked run paused, record the attempted fix, and queue a resume with its fix
ID. A second agent must reauthenticate this proof before dispatching. An
interrupted queue claim stays interrupted; it is never automatically replayed.

The graph accepts a fix pickup only from the authorized agent dispatch context.
It rechecks the exact sealed **exhausted response** with the current code
without prompting Pi, changing Story files, or granting any new specialist
scope. A pass still traverses normal controller admission, current source
validation, pending steering and the ordinary independent review and writer
permissions. A refusal remains stopped; the same fix cannot be retried against
the same failure signature. A different failure does not inherit the former
fix's eligibility.

Current typed producer: `adaptive-plan.v1` `completed-response` exhaustion
from #218. Other stop categories are deliberately not inferred from legacy
error strings, and require their own typed check/version receipt before this
pickup mechanism can handle them. PostgreSQL and SQLite use the same Kysely
transactional persistence adapter; the migration has a reversible `down`.

This is **not** an operator override of author approval, cancellation, or
integrity failures. Do not use it to replay specialists or to recover an
interrupted writer; those require their existing reconciliation paths.
