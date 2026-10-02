---
name: baton
description: Context for repos whose work is scheduled by baton on top of a self-hosted Multica (the issue tracker and agent runtime). Use when the project mentions baton or Multica, when you see issue keys like `ABC-7`, and before filing or picking up a task or changing an issue's status, assignee, labels, `footprint` or `blocked-by`.
---

# baton + Multica

This project is not driven by hand. Two systems own the flow of work:

- **Multica** (https://github.com/multica-ai/multica, self-hosted) — the issue tracker and agent runtime. It holds
  projects (one per repo), issues, labels and properties, and its local daemon runs the coding agents
  (Claude Code, Codex, opencode) in per-issue worktrees. UI: `http://localhost:3000`, API: `http://localhost:8080`.
- **baton** (https://github.com/GeTechG/baton) — a small scheduler on top of Multica. It decides **when** each issue
  runs and **which agent** takes it, nothing else: how a change reaches the base branch (push, PR, CI, review) is the repo's own process.

If you were started by Multica on an issue, your agent instructions are the authority for the workflow; this skill
only explains the system around them. If you are in an interactive session in such a repo, the rules below are what
keep you from fighting the scheduler.

## Who does what

| Step | Owner |
|---|---|
| File an issue (unassigned) | human, or an agent that needs work done elsewhere |
| Assign the first agent, start the run | **baton only** |
| Hand the issue to another agent (`multica issue assign <KEY> --to <agent>`) | the agent holding it, when the repo's `AGENTS.md` says so |
| Implement, deliver the way the repo's `AGENTS.md` says, set `done` | the agent |

## Rules

- **Never assign an unassigned issue to an agent yourself.** File it unassigned; baton assigns it when it is ready.
  Handing on an issue you hold is fine: it stays in flight under its new agent.
- Stay inside the issue's `footprint`. It is how baton keeps parallel agents off each other's files.
- An issue is done as planned. What comes up on the way: same area, small and needing no decision — done in the same
  issue and mentioned in the comment; same area but larger — a sub-issue (`--parent`); unrelated — a separate issue;
  work for another project — an issue there, listed in `blocked-by` of the one that needs it. All filed unassigned.
- An issue that asks for a review is done when the review comes back clean: its findings are fixed in the same issue
  and the review is run again, not filed as new issues. Write "read-only" in the issue if you want only the report.

## How an issue becomes ready

baton works in waves. While any agent run is active it does nothing. Once all runs have ended, its orchestrator (one
model call) reads the waiting issues, the agents' descriptions and each repo's `AGENTS.md`, and picks which issues start
now and which agent takes each. An issue can be picked only when all of these hold:

- it is unassigned and its status is not `backlog` (not ready; a human moves it to `todo`) or `in_review` (waits for a review, not an agent),
- every issue in its `blocked-by` property is done (cross-project keys work),
- it has no `needs-human` label,
- its `footprint` does not overlap an issue of the same project that an agent holds (path-prefix match),
- if it has not been started yet (`todo`), it is among the first few such issues in the board's manual order (drag an issue up to have it considered sooner).

So a new issue filed mid-wave waits for the wave to end, and a clear title and description are what the orchestrator
orders work by.

## Issue properties and labels

| Name | Kind | Meaning |
|---|---|---|
| `footprint` | property | Comma-separated paths the task will touch. Estimated by an LLM if missing; set it yourself when you know better. |
| `blocked-by` | property | Comma-separated issue keys that must be done first. |
| `needs-human` | label | Parked for a human; baton will not assign it and pings the human once. |
| `fresh` | label | Next run starts with a clean session and working directory; baton removes the label. |

Label names and the wave size are configurable in baton's `config.json`; the names above are the defaults.

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
multica issue status <KEY> done --no-start                   # delivered; unblocks what waits on it
multica issue status <KEY> blocked --no-start                # waiting on a blocker or a human
```

Always pass `--no-start` when changing status: starting runs is baton's job.

To see what the system is doing, in the baton checkout: `node watch.mjs` (live view of in-flight agent runs),
`state/bridge.log` (every wave / assign / park decision), `node baton.mjs --once` (a single tick).

When the user asks for work in such a repo, prefer filing a well-scoped unassigned issue with a `footprint` over
doing a large change directly on the base branch — unless they clearly want it done in this session.
