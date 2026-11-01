# Trusted author approvals (#58)

Offline Ed25519 signing is retired. No signing key, committed public key, or
`.noveltea/approval-author.pub` is required or consulted. Native `.noveltea`
metadata is disposable and cannot grant consent. Old signature envelopes and
`--signed-evidence` flags are rejected, not silently converted into approvals.

## Trust boundary

The author controller and durable job state must be outside every model-directed
file, search and shell tool. Git-backed Pi specialists now require the isolated
sandbox adapter in **both CLI and hosted execution**. Missing sandbox socket/token
configuration fails closed; there is no same-user host-tool fallback. A terminal
or a file mode alone cannot protect consent from an unrestricted same-user agent.
Deploy the controller with the existing private sandbox configuration; never mount
job state, checkpoints, app data, credentials or controller endpoints in a sandbox.
Fixtures do not run Pi and need no sandbox.

The trusted CLI identifies the OS user and requires an interactive terminal. The
website identifies the Better Auth session and checks **job ownership**, not merely
repository membership or provider write access. The controller records the decision
through a typed LangGraph `Command(resume)` bound to the exact nonce. There is no
model-callable approval tool, JSON-supplied principal, or unattended approval flag.

## Inspect, request, decide, apply

1. Run `job revision inspect` or `job architecture propose` and review the actual
   patch, scope, affected records, protected before/after values and carry-forward
   list. For relocation run `job ideas relocate` without approval first.
2. Save the exact proposal payload to `payload.json`. The existing compatibility
   output fields `authorSigningRequest` (plan) and `authorSigningRequests` (revision)
   now contain **unsigned request templates**, not signing instructions. Relocation
   returns `approvalRequest`. Fill in a substantive rationale; editorial requests
   require a separate source-line reference and independent prose-review notes.
3. Stage and inspect the request; staging never authorizes a change:

   ```sh
   pnpm dev job approval request --story /repo/story --job draft-1 \
     --id review-culprit --file payload.json
   pnpm dev job approval inspect --story /repo/story --job draft-1 --id review-culprit
   pnpm dev job approval decide --story /repo/story --job draft-1 --id review-culprit
   ```

   On the trusted terminal, type `APPROVE <full-proposal-sha256>` or
   `REJECT <full-proposal-sha256>`. Unattended execution leaves the interrupt
   pending and reports the interactive-terminal requirement. The displayed receipt
   includes the exact binding, payload, and proposal review context. Always inspect
   the actual Story prose independently; a digest is not a literary review.
4. Save only the returned `id` and `nonce` as a reference:

   ```json
   { "receiptId": "review-culprit", "nonce": "<recorded nonce>" }
   ```

5. Apply that reference through the existing gate:

   ```sh
   pnpm dev job revision authorize --story /repo/story --job draft-1 \
     --work-item fix-culprit --proposal <exact-sha256> --approval decision-reference.json
   pnpm dev job revision review --story /repo/story --job draft-1 \
     --work-item fix-culprit --proposal <exact-sha256> --approval editorial-reference.json
   pnpm dev job revision commit --story /repo/story --job draft-1 \
     --work-item fix-culprit --proposal <exact-sha256>
   ```

   Each protected delta needs its own decision. Editorial review is always separate,
   even when metadata is unchanged. Rejection/block remains durable and prevents
   commit. Plan application uses `job architecture approve --proposal <digest>
   --approval plan-reference.json`; relocation uses `job ideas relocate --id <idea>
   --target <record-id> --approval relocation-reference.json`.

## Typed author-update and web contracts

A pending author-update approval resumes with a reference, never an inline decision:

```json
{
  "type": "decision",
  "messageId": "approve-the-witness",
  "approval": { "receiptId": "review-culprit", "nonce": "<recorded nonce>" }
}
```

Use `job author resume --file response.json`. Questions retain the existing
`{type:"answer",messageId,answer}` contract. Paused/cancelled execution controls,
writer locks, source bindings and interrupted-writer recovery remain independent.

`POST /api/approvals` is an authenticated, same-origin author-controller endpoint:

- Request: `{action:"request",jobId,id,payload}` (or `kind`, `workItemId`, `changeId`).
- Inspect: `{action:"inspect",jobId,id}`.
- Decide: `{action:"decide",jobId,id,nonce,proposalSha256,decision:"approved"|"rejected"}`.

Paths and principals are resolved server-side from the owned job/catalog and the
session. The web and CLI controllers share the same ledger and typed graph resume.
Recording consent does not invoke a writer, commit Story bytes, change execution
ownership, or implicitly answer another graph's pending question. The resulting
reference is consumed by the same protected gates and author-update contract.

## Durability, replay and migration

Receipts and SQLite checkpoints live in `<job-state>/trusted-approvals/`, outside
Story canon, disposable metadata and evictable Git cache. They bind job/thread,
original baseline, verified HEAD, exact proposal digest, protected change or plan
version, nonce, principal, source and decision. Every historical authorization is
rechecked against this ledger. Copied fields in revision/history JSON are not
independent authority (the historical field name `signed` now holds ledger evidence).

The same recorded controller decision is idempotent. A conflicting principal,
nonce, digest or decision fails. Reusing a receipt for a different current proposal,
work item, plan version or verified HEAD fails at the application gate. Historical
accepted evidence remains readable after later verified commits. Pending requests
cannot be rebound to a changed proposal; use a fresh request ID after inspecting it.
The existing graph-side Git/validator gates still check exact candidate bytes,
canonical protection, scope, independent review and commit provenance.

Old signing-only histories and transitional #57 receipts without reviewed payloads
are **not automatically trusted or upgraded**. They fail closed. Preserve original
receipts, worktrees, Git history and transcripts. Inspect retained work and establish
a fresh trusted job/proposal for explicit controller review; never rewrite baseline
SHAs or receipt hashes to bypass migration. This release does not provide an
in-place importer for historical signature-only jobs.

Back up durable job state and checkpoints together. A missing/corrupt ledger is a
block requiring restoration, never permission to reconstruct consent from Story
metadata, a Git trailer, or a model response.
