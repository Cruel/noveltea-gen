# Issue tracker: GitHub

Issues and specs live in GitHub Issues for `Cruel/noveltea-gen`.
Use the `gh` CLI for issue operations. Inside this clone, `gh` infers
the repository from the Git remote.

## Operations

- Create: `gh issue create --title "..." --body-file <file>`
- Read: `gh issue view <number> --comments`; also inspect labels.
- List: `gh issue list --state open --json number,title,body,labels,comments`
  with appropriate label and state filters.
- Comment: `gh issue comment <number> --body "..."`
- Label: `gh issue edit <number> --add-label "..."`
  or `--remove-label "..."`
- Close: `gh issue close <number> --comment "..."`

When a skill says "publish to the issue tracker", create a GitHub issue.
When it says "fetch the relevant ticket", read the issue with its comments
and labels.

## Pull requests as a triage surface

**PRs as a request surface: no.**

GitHub shares a number space across issues and PRs. If a reference is
ambiguous, resolve its type before operating on it.

## Wayfinding operations

- Map: one issue labelled `wayfinder:map`, holding Notes,
  Decisions-so-far, and Fog.
- Children: link tickets as GitHub sub-issues. If unavailable, use a task
  list in the map and `Part of #<map>` in each child.
- Ticket types: `wayfinder:research`, `wayfinder:prototype`,
  `wayfinder:grilling`, or `wayfinder:task`.
- Blocking: use GitHub native issue dependencies. Add a blocker with
  `gh api --method POST repos/Cruel/noveltea-gen/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-database-id>`.
  Fetch that database ID with
  `gh api repos/Cruel/noveltea-gen/issues/<number> --jq .id`.
  If dependencies are unavailable, use a `Blocked by: #<number>` line.
- Frontier: select the first open child in map order with no open
  blockers and no assignee.
- Claim: assign the ticket to the driving developer before other writes.
- Resolve: comment with the answer, close the ticket, and append a gist
  and link to the map's Decisions-so-far.
