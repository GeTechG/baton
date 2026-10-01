---
name: baton
description: Context for repos whose work is orchestrated by baton (a scheduler, agent runner and batch merge queue) on top of Lific (a local issue tracker). Use when the project mentions baton or Lific, when you see `mc/<KEY>` or `batch/<ts>` branches or issue keys like `ABC-7`, and before filing or picking up a task, opening or merging a PR, pushing to the base branch, or changing an issue's status, labels, footprint or blockers.
---

# baton + Lific

This project is not driven by hand. Two systems own the flow of work:

- **Lific** (https://github.com/VoidNullable/lific, self-hosted, one binary) — the issue tracker: projects (one per
  repo), issues, labels, "blocked by" links, comments. UI: `http://localhost:3456`. CLI: `lific`.
- **baton** (https://github.com/GeTechG/baton) — decides **when** each issue runs, runs the coding agent for it in a
  per-issue git worktree of the maintainer's checkout, and decides **what** reaches the base branch. Agent
  instructions call it "the bridge".

If baton started you on an issue, your instructions are the authority for the workflow; this skill only explains the
system around them. If you are in an interactive session in such a repo, the rules below are what keep you from
fighting the scheduler.

## Who does what

| Step | Owner |
|---|---|
| File an issue (`todo`, or `backlog` if it is not ready) | human, or an agent that needs work done elsewhere |
| Move it to `active`, start the agent | **baton only** |
| Implement on `mc/<KEY>`, open the PR, add the `in-review` label | the agent |
| Watch CI, batch, merge, fast-forward the base branch | **baton only** |
| Set `done` | **baton** (the agent only for `after-landing` issues) |

## Rules

- **Never merge a PR and never push to the base branch.** baton merges green PRs `--no-ff` into `batch/<ts>` and
  fast-forwards base only to a batch whose exact tree passed CI. A manual merge breaks that guarantee.
- **Never set an issue `active` yourself.** File it as `todo`; baton starts it when it is ready.
- **Never set `done`** unless the issue carries `after-landing` and you are finishing its post-landing steps.
- Don't touch `batch/*` branches, someone else's `mc/*` branch, or an issue worktree (`<checkout>.wt/<KEY>`) that is
  not yours. One issue = one branch `mc/<KEY>` = one PR whose title starts with the key.
- Don't wait for CI after handing off: add `in-review` and stop. A red PR comes back with a comment and the label removed.
- Stay inside the issue's footprint. It is how baton keeps parallel agents off each other's files.

## How an issue becomes ready

baton starts a `todo` issue when all of these hold:

- every issue that blocks it is done (links work across projects),
- it has no `needs-human` label,
- its footprint does not overlap an in-flight issue of the same project (path-prefix match),
- the in-flight cap is not reached.

## Issue fields and labels

| Name | Kind | Meaning |
|---|---|---|
| `footprint: a, b` | a line of the description | Comma-separated paths the task will touch. Estimated by an LLM and appended if missing; write it yourself when you know better. |
| blocked by | link | `lific issue link <BLOCKER> <BLOCKED>`: the blocked issue waits until the blocker is done. |
| `in-review` | label | The agent handed off a PR; the merge queue owns the issue now. |
| `needs-human` | label | Parked for a human; baton will not run it and pings the human once. |
| `gate:spec` | label | The agent posts a `## Plan` comment and parks on `needs-human` instead of coding. |
| `spec:approved` | label | Replaces `needs-human` on a gated issue: the plan is approved, implement it. |
| `after-landing` | label | After the PR lands baton returns the issue to the agent (drops `in-review` + a comment) for post-landing steps. |
| `fresh` | label | Next run starts with a new session and a new worktree; baton removes the label. |

Label names and the in-flight cap are configurable in baton's `config.json`; the names above are the defaults.

## Working with it

```sh
lific project list
lific issue get <KEY>; lific comment list <KEY>
lific issue create --project <PREFIX> --status todo --title=… --description=$'…\n\nfootprint: src/foo/, test/foo.test.js'
lific issue link <BLOCKER-KEY> <KEY>                     # KEY waits for BLOCKER-KEY
lific issue update <KEY> --add-label in-review           # hand off an open PR
lific issue update <KEY> --add-label needs-human         # park for a human
```

Add `--json` for scripts. Against a running server pass `--backend http` with `LIFIC_URL` and `LIFIC_API_KEY` set
(agents started by baton get a `lific` on their PATH that already does).

To see what the system is doing, in the baton checkout: `node watch.mjs` (live view of the agent runs),
`state/bridge.log` (every start / park / batch / merge / landed decision), `state/logs/<KEY>.log` (an issue's raw agent
output), `scripts/status.sh`.

When the user asks for work in such a repo, prefer filing a well-scoped `todo` issue with a footprint over doing a
large change directly on the base branch — unless they clearly want it done in this session.
