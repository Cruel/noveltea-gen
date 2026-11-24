# Native CI test sharding

The root suite is file-sharded across four runners, excluding `test/generation.test.ts`. The latter registers its top-level scenarios and partitions them deterministically across six separate runners using duration estimates from CI run 45322231869. All 118 cases were assigned exactly once (estimated 336–340 serial seconds per shard at the time of the change). These estimates are scheduling hints, not timeout limits or measured post-change CI durations. New scenarios are included automatically; update the weights in `test/generation-shards.ts` when a case becomes an outlier. Each runner executes its cases serially because the tests share environment and scripted Pi state.

Run a single generation shard locally with the usual native CLI/skills configuration:

```sh
NT_GENERATION_TEST_SHARD=1/6 pnpm exec tsx --test test/generation.test.ts
```

Without that variable, the usual local suite still registers every scenario. The native integration gate requires all root, generation and Studio jobs to succeed. The private-skills-independent shard partition test also runs in the offline suite.

## November 23 recovery-test audit

- Removed two artificial pre-#233 schema downgrade checks from the costly Blueprint correction scenarios. Current-format archival interruption, source and review validation, durable incidents and idempotent recovery remain covered.
- Updated #225's settled-writer test to check the commit-verification fence, including an unchanged writer receipt, instead of demanding the obsolete specialist-dispatch fence.
- Retained the separate scripted-Pi Review convergence, stalled-diagnostic stop and stalled-diagnostic continuation scenarios: they exercise distinct outcomes, not repetitions of the same path.
- Retained missing/obsolete/forged authority rejection, native checkpoint fork continuation, required and optional Interactive outcomes, and controller-approved carry-forward coverage.
- Older positive compatibility cases for legacy reviewed closeout transcripts, receipt IDs, Chat approvals and historical request display exercise explicit existing adapters. Retire them together with those adapters if that compatibility surface is removed; deleting only the tests would conceal supported paths. A current-format fork is not legacy graph replay.

## Recovery boundary review

The #258 first-handoff scheduling exit returns the authenticated author boundary's conditional control result (S), before objective planning. Turn admission requires the exact pinned Discovery handoff. Native-verified inherited World and Interactive checkpoints use the immutable fork's original commit/receipt rather than expecting local journal entries; independent Review is still mandatory when required. Budget and provider interruptions in Interactive propagate their original reason to the shared parent boundary rather than sealing a generic job-control pause.
