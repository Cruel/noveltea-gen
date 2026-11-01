# Canonical Story content and sandbox layout

Decision (2026-11-01): use one `story/` directory as the **canonical
content root**. The selected Story **workspace** is its parent; the native
NovelTea narrative CLI and generator use `<workspace>/story` as the Story root.
This changes the workspace layout, not the canonical schema or record-relative
paths (for example, `events/intro.md`).

```text
Git repository/
  .git/                         # Trusted Git operations only
  projects/example/              # Story workspace (can also be repo root)
    story/                       # One sandbox bind mount -> /story
      creative-direction/
      arcs/
      milestones/
      events/
      ... any future canonical record-type directories ...
      authored-content/
    .story-inbox/                 # Git-tracked, trusted author-only deferred ideas
      ideas/*.yaml
```

For new GitHub/GitLab Story initialization, the submitted directory specifies
the **workspace**, not the canonical content root. Empty means repository root;
`projects/example` means records are created in `projects/example/story`.
An input ending with `story` is already a content path and is not doubled.
The persisted Story catalog points to the content root. Existing Story
discovery continues to identify the canonical directory containing known
record types. Native `noveltea narrative validate`, `readiness`, and
`context` operate directly on the content root, with no extra path prefix.

The trusted controller authorizes exactly **one** `/story` bind mount derived
from the signed-in owner's registered Story/job manifest and pinned Git
worktree. It validates the complete projected tree, rejecting hidden entries,
symlinks, and special files. The container has no parent workspace, Git
metadata, author-only inbox, Docker socket, credentials, network, or alternate
host filesystem access. The agent-facing path mapper confines all structured
tools to non-hidden paths under `/story`, without listing record-type
directories. Writers retain sandboxed `bash` for now; reviewers receive
read/search tools only. Trusted orchestration owns native CLI validation,
Git baseline comparisons, author approval, and commits.

The trusted Git worktree *does* retain the sibling `.story-inbox`, including
in the sparse checkout. The generator's receipts and Git path helpers resolve
that inbox relative to the workspace, not to `story/`. It remains outside the
sandbox. The author inbox is not replaced by Docker storage or a separate
untracked database. No special command telemetry is added; existing LangGraph
traces can be inspected.

## Compatibility and migration

- Existing canonical record-relative names, IDs and `schema: '0.1'` are
  unchanged. The selected `--story` path is the *content root*, typically
  `/repo/story` or `/repo/projects/example/story`.
- Existing imported Story directories may still be discovered, but **hosted
  sandbox execution requires a directory named `story/` and no `.git` or
  `.story-inbox` entry inside it**. In particular, a legacy registered
  non-`story/` directory, repository-root Story, or Story with its inbox
  inside the content tree must be reorganized.
  The controller will fail closed rather than mount those entries.
- Existing worktrees, Git branches, catalog directory identities, deferred
  idea receipts and sparse-checkout patterns cannot be transparently repointed
  by changing a string. Review/preserve existing work, migrate canonical
  files into a `story/` child and `.story-inbox` beside it in a controlled
  Git revision, then initialize/re-register a new Story job. Do not silently
  rewrite active job manifests or auto-migrate author-only receipts.
- Existing Docker containers with the old per-record mount layout are
  rejected by the new layout label. An operator must retire those legacy
  containers before acquiring a migrated job; the controller rejects the
  legacy registered Story identity and cannot dispose it through the normal
  job API. Do not rebind an active job in place. The image and rootless Docker
  prerequisites do not change.

## Future-ticket acceptance guidance

The web-delivery parent specification **#38** and its child tickets must treat
`<workspace>/story` as the content root, not require per-record-type bind
mounts. In particular:

- **#55 (sandbox certification):** Prove exactly one bind mount and test
  arbitrary future content subdirectories, sibling inbox/Git denial, host
  path traversal/symlinks, rootless limits, old-container rejection and
  recovery, and no host fallback.
- **#63 (new Story onboarding):** Display workspace versus canonical Story
  paths accurately; create records under `story/`, keep the user-only inbox
  outside it, and test GitHub/GitLab empty/default/nonempty repository flows.
- **#60 (Story explorer):** Read canonical records under the selected Story
  content root; do not expose sibling `.story-inbox`. Avoid hard-coding the
  container's bind-mount list as the narrative schema.
- **#66 (web Pi execution) and #71 (end-to-end certification):** Pass the
  persisted content-root identity into hosted jobs and check confinement,
  native CLI validation and trace evidence after a real job.
- Existing #48/#49 initialization semantics are implemented through the
  canonical content-root normalization, with separate provider tests.

Future NovelTea *engine* record authoring is not part of this layout. It can
access a NovelTea project root with `AGENTS.md` and `.noveltea/` under a
separately reviewed mount policy when implemented. Do not reserve a generated
engine-record directory here.
