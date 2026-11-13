# Source-bound assignment review (#161)

The shared assignment reviewer distinguishes three sets:

- `assurance.changedPaths`: the exact validated changes. Findings and positive
  evidence must cite one of these paths at a real line, with the exact commit
  SHA and assignment ID.
- `canonicalContext`: permitted read-only evidence, loaded from the sealed Git
  tree. An `affectedPath` must belong to this same item's context and each
  finding must include its own changed path. No cross-item context borrowing.
- `repairTargets`: a ceiling for a later corrective amendment, **not** a writer
  grant. `readOnlyPaths` contains context outside that ceiling, including an
  Event's changed protected Milestone metadata. A finding on that Milestone
  still requires escalation rather than being silently dropped.

Context seeds are changed paths, original assignment/direct dependency existing
paths, and verified ancestor checkpoint outputs of direct dependency
assignments in the same Turn. The latter matters for creation-stage assignments
whose `existingPaths` were empty. Every seed is read at the **reviewed** commit,
not at its dependency's earlier commit or the current worktree HEAD.

`loadSealedReviewContext` materializes only canonical record directories into a
private disposable snapshot. The existing native catalog and Context Manifest
resolver supplies typed IDs and related records; there is no second relationship
parser. Every selected record is checked against its original Git blob. The
review packet includes commit/blob provenance and explicit read-only/repair
sets in its deterministic digest. Native version pinning remains mandatory.

Bounds fail closed: at most 1,024 canonical snapshot records / 8 MiB total,
128 KiB per file, then at most 32 selected context records / 128 KiB serialized
context per review item. Truncated native manifests, missing records, unsafe
paths, symlinks, and oversized context are rejected, not silently trimmed.
Private inbox directories are never materialized. Missing changed records no
longer receive a synthetic, citable placeholder line.

The existing verdict validator and pass criteria remain unchanged. Context
membership cannot repair a stale digest, SHA, assignment, or invented line.
The original specialist and validated write scope remain authoritative. Repair
receipts now store the amendment's narrower writable paths, and restart checks
compare their findings with the immutable sealed review as well as comparing
the amendment and authority. Pre-fix receipts containing a broader path list
fail closed; this is not an automatic recovery/migration of interrupted writers.

## Verification

Offline boundary regressions use real Git repositories and a fixture native
executable; they do not certify native relationship selection or narrative
quality. The saved Collaborative replay additionally uses the installed real
native CLI and actual checkpoint/provenance checks:

```sh
pnpm exec tsx --test test/semantic-assignment-review.test.ts \
  test/review-repair-amendment.test.ts test/rejected-review-repair.test.ts \
  test/rejected-repair-controller.test.ts test/checkpoint-assurance.test.ts

NT_TEST_SEMANTIC_REPLAY_STATE=/path/to/private/job-state \
  pnpm exec tsx --test test/semantic-assignment-review.test.ts
```

The opt-in replay lives in the existing test file. It reads original data
without changing it and seals reviews only into disposable copies of job state.
It uses both saved responses at Event commit
`191e9c2a0ad1b60745f57582d625600b912e5626`, verifies the original packet digest
`f1f57b114d1b45c9f615de9d3dccff395be33c387177abb13444cc659ac964e8`, and reproduces
the old source-linked-evidence rejection.

The expanded packet digest is
`b592c9adcbff7a4a26d944bf5fdfcfdb7672c4a3b6c65ea42d4ceac04d3d99e7`.
The test explicitly verifies that replaying the old digest against this packet
is rejected. Only the recorded-model test envelope is rebound to the new input
digest; all original findings, correction text, affected paths and evidence
remain unchanged. Production has **no** stale-digest migration or validation
waiver. Both payloads seal as `failed`, survive repeated inspection/sealing, and
derive an `nt-event-design` amendment restricted to
`events/disappearance-explained.md`. Arc, Characters, Facts, World Entity and
Milestone remain read-only dependencies.

This replay does not invoke a writer or a model. Existing repair-cycle tests
cover correction/validation/separate rereview, bounded retries, author
escalation and interrupted-writer fencing. Full authenticated Studio / real-Pi
playable Story certification remains #158's responsibility; these results must
not be reported as a completed full Story run.

### Implementation verification

On the development host, the full `pnpm check` with
`NT_TEST_SEMANTIC_REPLAY_STATE` pointing to the original private job completed
successfully: root **421 passed / 22 skipped / 0 failed**; Studio **408 passed /
53 skipped / 0 failed**. This includes lint, format checks, both typechecks,
production builds, and Studio persistence boundary/type-generation checks.
The five focused review/repair test files also passed with replay enabled:
**34 passed / 0 skipped / 0 failed**. Gated live tests remain skipped in the
full suites. A pre-existing type-widening error in the unified Studio live-test
runner was fixed with an explicit creative-mode union annotation, without
changing runner behavior or adding certification infrastructure.
