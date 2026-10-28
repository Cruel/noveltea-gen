# Offline author signatures for Story revision (#16)

The generator cannot authenticate a human from an ordinary `--approve` CLI
flag. Pi specialists have shell access. Therefore both **protected-decision
approval/rejection** and the mandatory **source-linked editorial verdict** must
be Ed25519-signed outside the agent's execution environment.

## 1. Establish author authority before starting a job

On a **separate, trusted signing device/service**, generate a private signing
key. Do not store the key in the Story checkout, a NovelTea job/worktree, a
machine where Pi has shell access, a Pi transcript, or a config/env variable
visible to Pi:

```sh
openssl genpkey -algorithm Ed25519 -out /secure/offline/noveltea-author.key
openssl pkey -in /secure/offline/noveltea-author.key -pubout -out approval-author.pub
```

Transfer **only the public key** to the author's original Git repository.
In that repository, **before** running `job start`:

```sh
mkdir -p .noveltea
cp /path/to/transferred/approval-author.pub .noveltea/approval-author.pub
git add .noveltea/approval-author.pub
git commit -m "Pin offline NovelTea author approval key"
```

The key is a standalone *non-Story* file; the canonical Story validator still
only owns Markdown. At every authorization check the verifier runs
`git show <job.baseSha>:.noveltea/approval-author.pub`: not the moving HEAD,
not the worktree copy, not a key from approval JSON. A job created **before**
the key was committed cannot retrospectively adopt it. Start a new job from
the updated author baseline (never rewrite an existing job's `baseSha`).

## 2. Inspect the proposed revision

Edit one tracked Story Markdown record in the job worktree. From the normal
CLI, inspect the proposed change:

```sh
pnpm dev job revision inspect --story /repo/story --job draft-1 \
  --work-item fix-culprit --path creative-direction/foundation.md > proposal.json
```

Review the displayed `patch`, protected `before`/`after` values and
`affectedRecords`. The `authorSigningRequests.decisions[]` array contains
one **unsigned template per protected change**, each with the exact
`decision` ID and `changeId`. The `authorSigningRequests.editorial`
template is separate. **Do not sign an unreviewed template.**

Prepare the desired payload as JSON on the trusted signing device, preserving
all field names and exact proposal/job/thread/base/change values. The signed
`threadId` prevents replay across distinct jobs sharing a Git baseline. For a protected
change, choose `action: "approved"` or `"rejected"` and replace the
placeholder `reason` with a substantive author rationale (12+ characters).
For the editorial payload, set `verdict: "pass"` or `"block"`,
`evidence` to an actual `story-relative/path.md:line` or `:first-last`
reference, and `notes` to a meaningful independent semantic/prose review
(20+ characters). **A human review is required even if no protected YAML
metadata changed.** Signing is an attestation, not automatic literary proof.

## 3. Sign on the trusted device

The Ed25519 signature covers the UTF-8 bytes of
`JSON.stringify(payload)` (compact JSON, no trailing newline), **not**
the enclosing signature envelope. The verifier rejects extra/unknown payload
fields and invalid signatures.

Example using a trusted device with Node.js and OpenSSL. Save the reviewed
payload as `payload.json` and ensure it has the correct values and no extra
fields. Then normalize, sign and produce the signed envelope:

```sh
node -e 'const fs=require("node:fs"); fs.writeFileSync("canonical.json",JSON.stringify(JSON.parse(fs.readFileSync("payload.json","utf8"))))'
openssl pkeyutl -sign -rawin -inkey /secure/offline/noveltea-author.key \
  -in canonical.json -out signature.bin
node -e 'const fs=require("node:fs"); const payload=JSON.parse(fs.readFileSync("canonical.json","utf8")); const signature=fs.readFileSync("signature.bin").toString("base64"); fs.writeFileSync("signed-evidence.json",JSON.stringify({payload,signature},null,2))'
```

Transfer **only `signed-evidence.json`** back to the generator machine. The
signature can safely be carried through the agent-accessible filesystem:
it cannot be altered or reused for another proposal without a new valid
author signature. Never transfer the private key.

## 4. Import signed authorization and editorial review

```sh
pnpm dev job revision authorize --story /repo/story --job draft-1 \
  --work-item fix-culprit --proposal <exact-proposal-sha256> \
  --signed-evidence /path/to/signed-decision.json
```

Repeat for each protected decision requiring authorization. A signed
`rejected` decision blocks the work item. Then independently review
the prose and sign the **editorial** template (step 3, with
`kind: "editorial"`):

```sh
pnpm dev job revision review --story /repo/story --job draft-1 \
  --work-item fix-culprit --proposal <exact-proposal-sha256> \
  --signed-evidence /path/to/signed-editorial.json
pnpm dev job revision commit --story /repo/story --job draft-1 \
  --work-item fix-culprit --proposal <exact-proposal-sha256>
```

Only the graph commits; the CLI verifies both signatures on ingestion and
again whenever the saved receipt is read or an interrupted commit is
recovered. It independently reconstructs the protected delta inventory using
the pinned canonical validator and original/latest verified Git history.
An agent can submit an unsigned request, but cannot convert it to an
authorization without access to the offline signing key. `--decision`,
`--reason`, `--verdict` and `--notes` flags on the generator CLI
**cannot** authorize or approve a Story revision.

## 5. Sign an architecture completion-contract revision (#17)

`job architecture propose --story /repo/story --job draft-1 --contract revised-scope.json`
returns a precise `proposal.digest` and `authorSigningRequest` with
`kind: "plan"`, `workItemId: "global-architecture"`, the original job
baseline/thread ID, the latest verified HEAD, `planVersion` and the exact
`proposalSha256`. The proposal digest binds the previous plan, verified
HEAD and complete proposed contract, including its production constraints.

Before signing, review **the entire old and proposed scope**, including any
removed targets, branches, constraints and production limits. Set `reason`
to an explicit rationale (at least 12 characters), then sign the reviewed
payload with the independently held original author key using step 3 above.

```sh
pnpm dev job architecture approve --story /repo/story --job draft-1 \
  --proposal <exact-proposal-digest> \
  --signed-evidence /path/to/signed-plan.json
pnpm dev job architecture run --story /repo/story --job draft-1
```

Every imported approval must match the exact outstanding plan proposal and
verified HEAD. Saved plan revisions and signatures are rechecked whenever
the architecture receipt is opened. There is no ordinary `--reason` approval
shortcut. The original plan can be supplied as a completion contract in
`job architecture run`; signatures are required for **subsequent changes**,
not for establishing the initial CLI-requested scope.

## Trust assumptions and rotation

The trusted baseline must be correctly selected when the job is created.
The signer must validate **the exact contents and their scope**, not just
sign a digest suggested by an agent. Retain the author signing key only in a
protected environment inaccessible to the agent. An agent able to overwrite
the running verifier itself, the trusted signer, or the original Git objects
can defeat in-process protections; isolate the writing worker at the OS/container
boundary for adversarial deployments. Key rotation requires a fresh, trusted
job baseline: never silently substitute the working-tree key or a supplied
approval file's key.

The key is an **author identity/consent** key, not an assurance that authored
prose is semantically consistent. A positive signed editorial review means
the authorized reviewer attests to having checked the affected narrative.
