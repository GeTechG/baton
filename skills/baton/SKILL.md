---
name: baton
description: Context for repos whose work is scheduled by baton (a scheduler and agent runner) on top of Lific (a local issue tracker). Use when the project mentions baton or Lific, when you see issue keys like `ABC-7`, and before filing or picking up a task or changing an issue's status, assignee, labels, `footprint`, `agent` or blockers.
---

# baton + Lific

This project is not driven by hand. Two systems own the flow of work:

- **Lific** (https://github.com/VoidNullable/lific, self-hosted, one binary) — the issue tracker: projects (one per
  repo), issues, labels, properties, "blocked by" links, comments. UI: `http://localhost:3456`. CLI: `lific`.
- **baton** (https://github.com/GeTechG/baton) — a small scheduler on top of Lific. It decides **when** each issue
  runs and **which agent** takes it, and runs that agent in a per-issue git worktree of the maintainer's checkout.
  Nothing else: how a change reaches the base branch (push, PR, CI, review) is the repo's own process.

If baton started you on an issue, your agent instructions are the authority for the workflow; this skill only explains
the system around them. If you are in an interactive session in such a repo, the rules below are what keep you from
fighting the scheduler.

## Who does what

| Step | Owner |
|---|---|
| File an issue (`todo`, or `backlog` if it is not ready) | human, or an agent that needs work done elsewhere |
| Move it to `active`, pick its agent, start the run | **baton only** |
| Hand the issue to another agent (`lific issue update <KEY> --set agent=<name>`) | the agent holding it, when the repo's `AGENTS.md` says so |
| Implement, deliver the way the repo's `AGENTS.md` says, set `done` | the agent |

## Rules

- **Never set an issue `active` yourself.** File it as `todo`; baton starts it when it is ready. Handing on an issue you
  hold is fine: it stays in flight under its new agent.
- Stay inside the issue's `footprint`. It is how baton keeps parallel agents off each other's files.
- Don't touch an issue worktree (`<checkout>.wt/<KEY>`) that is not yours.
- An issue is done as planned. What comes up on the way: same area, small and needing no decision — done in the same
  issue and mentioned in the comment; same area but larger, or unrelated — a separate issue; work for another project —
  an issue there, linked as a blocker of the one that needs it. All filed as `todo`, none started by hand.
- An issue that asks for a review is done when the review comes back clean: its findings are fixed in the same issue
  and the review is run again, not filed as new issues. Write "read-only" in the issue if you want only the report.

## How an issue becomes ready

baton works in waves. While any agent run is active it starts nothing. Once all runs have ended, its orchestrator (one
model call) reads the waiting issues, the agents' descriptions and each repo's `AGENTS.md`, and picks which issues start
now and which agent takes each. An issue can be picked only when all of these hold:

- its status is `todo` (`backlog` = not ready, a human moves it; `in_review` waits for a review, not an agent),
- every issue that blocks it is done (links work across projects),
- it has no `needs-human` label,
- its `footprint` does not overlap an issue of the same project that is `active` or `in_review` (path-prefix match),
- if it has not been started yet, it is among the first few such issues in the board's manual order (drag an issue up to
  have it considered sooner).

So a new issue filed mid-wave waits for the wave to end, and a clear title and description are what the orchestrator
orders work by.

## Issue properties and labels

| Name | Kind | Meaning |
|---|---|---|
| `footprint` | property | Comma-separated paths the task will touch. Estimated by an LLM if missing; set it yourself when you know better. |
| `agent` | property | The agent that holds the issue. Set by baton; an agent names another one here to hand the issue on. |
| blocked by | link | `lific issue link <BLOCKER> <BLOCKED>`: the blocked issue waits until the blocker is done. |
| `needs-human` | label | Parked for a human; baton will not run it and pings the human once. |
| `fresh` | label | Next run starts with a new session and a new worktree; baton removes the label. |

Label names and the wave size are configurable in baton's `config.json`; the names above are the defaults.

## Working with it

```sh
lific project list
lific issue get <KEY>; lific comment list <KEY>
lific issue create --project <PREFIX> --status todo --title=… --description=… --set footprint="src/foo/, test/foo.test.js"
lific issue link <BLOCKER-KEY> <KEY>                     # KEY waits for BLOCKER-KEY
lific issue update <KEY> --status done                   # delivered; unblocks what waits on it
lific issue update <KEY> --add-label needs-human         # park for a human
```

Add `--json` for scripts. Against a running server pass `--backend http` with `LIFIC_URL` and `LIFIC_API_KEY` set
(agents started by baton get a `lific` on their PATH that already does).

To see what the system is doing: the issue's run log and assignee in the tracker UI; in the baton checkout `node watch.mjs`
(live view of the agent runs), `state/bridge.log` (every wave / assign / run / park decision), `state/logs/<KEY>.log` (an
issue's raw agent output), `scripts/status.sh`.

When the user asks for work in such a repo, prefer filing a well-scoped `todo` issue with a `footprint` over doing a
large change directly on the base branch — unless they clearly want it done in this session.
