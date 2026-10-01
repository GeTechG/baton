---
name: baton
description: Context for repos whose work is orchestrated by baton (a scheduler + batch merge queue) on top of a self-hosted Multica (the issue tracker and agent runtime). Use when the project mentions baton or Multica, when you see `mc/<KEY>` or `batch/<ts>` branches or issue keys like `ABC-7`, and before filing or picking up a task, opening or merging a PR, pushing to the base branch, or changing an issue's status, assignee, labels, `footprint` or `blocked-by`.
---

# baton + Multica

This project is not driven by hand. Two systems own the flow of work:

- **Multica** (https://github.com/multica-ai/multica, self-hosted) — the issue tracker and agent runtime. It holds
  projects (one per repo), issues, labels and properties, and its local daemon runs the coding agents
  (Claude Code, Codex, opencode) in per-issue worktrees. UI: `http://localhost:3000`, API: `http://localhost:8080`.
- **baton** (https://github.com/GeTechG/baton) — a small scheduler on top of Multica. It decides **when** each issue
  runs and **what** reaches the base branch. Agent instructions call it "the bridge".

If you were started by Multica on an issue, your agent instructions are the authority for the workflow; this skill
only explains the system around them. If you are in an interactive session in such a repo, the rules below are what
keep you from fighting the scheduler.

## Who does what

| Step | Owner |
|---|---|
| File an issue (unassigned) | human, or an agent that needs work done elsewhere |
| Assign the agent, start the run | **baton only** |
| Implement on `mc/<KEY>`, open the PR, set `in_review` | the agent |
| Watch CI, batch, merge, fast-forward the base branch | **baton only** |
| Set `done` | **baton** (the agent only for `after-landing` issues) |

## Rules

- **Never merge a PR and never push to the base branch.** baton merges green PRs `--no-ff` into `batch/<ts>` and
  fast-forwards base only to a batch whose exact tree passed CI. A manual merge breaks that guarantee.
- **Never assign an issue to an agent yourself.** File it unassigned; baton assigns it when it is ready.
- **Never set `done`** unless the issue carries `after-landing` and you are finishing its post-landing steps.
- Don't touch `batch/*` branches or someone else's `mc/*` branch. One issue = one branch `mc/<KEY>` = one PR whose
  title starts with the key.
- Don't wait for CI after handing off: set `in_review` and stop. A red PR comes back as `in_progress` with a comment.
- Stay inside the issue's `footprint`. It is how baton keeps parallel agents off each other's files.

## How an issue becomes ready

baton assigns an unassigned, open issue when all of these hold:

- its status is not `backlog` (backlog = not ready; a human moves it to `todo`),
- every issue in its `blocked-by` property is done (cross-project keys work),
- it has no `needs-human` label,
- its `footprint` does not overlap an in-flight issue of the same project (path-prefix match),
- the in-flight cap is not reached.

## Issue properties and labels

| Name | Kind | Meaning |
|---|---|---|
| `footprint` | property | Comma-separated paths the task will touch. Estimated by an LLM if missing; set it yourself when you know better. |
| `blocked-by` | property | Comma-separated issue keys that must be done first. |
| `needs-human` | label | Parked for a human; baton will not assign it and pings the human once. |
| `gate:spec` | label | The agent posts a `## Plan` comment and parks on `needs-human` instead of coding. |
| `spec:approved` | label | Replaces `needs-human` on a gated issue: the plan is approved, implement it. |
| `after-landing` | label | After the PR lands baton returns the issue to the agent (`in_progress` + comment) for post-landing steps. |
| `fresh` | label | Next run starts with a clean session and working directory; baton removes the label. |

Label names and the in-flight cap are configurable in baton's `config.json`; the names above are the defaults.

## Working with it

The Multica CLI is `multica`; on the baton host use the wrapper `<baton checkout>/multica/m`, which pins the profile
and server.

```sh
multica project list
multica issue get <KEY>                      # plus its comments
multica issue property list <KEY>
multica issue create --project <project-id> --title "..." --description "..." \
  --property "footprint=src/foo/, test/foo.test.js"          # leave it unassigned
multica issue property set <KEY> --name blocked-by --value <OTHER-KEY>
multica issue status <KEY> in_review --no-start              # hand off an open PR
multica issue status <KEY> blocked --no-start                # waiting on a blocker or a human
```

Always pass `--no-start` when changing status: starting runs is baton's job.

To see what the system is doing, in the baton checkout: `node watch.mjs` (live view of in-flight agent runs),
`state/bridge.log` (every assign / batch / merge / landed decision), `node baton.mjs --once` (a single tick).

When the user asks for work in such a repo, prefer filing a well-scoped unassigned issue with a `footprint` over
doing a large change directly on the base branch — unless they clearly want it done in this session.
