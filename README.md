# baton

Scheduler and agent runner on top of [Lific](https://github.com/VoidNullable/lific), a single-binary local issue
tracker. Lific holds the issues and is the UI; baton decides **when** each issue runs and **who** takes it, and runs
the coding agent for it in a git worktree of your own checkout. It does not say how a repo is run: branches, PRs, CI,
merging and who sets `done` come from the agents' instructions (`agents/*.json`) and the repo's own `AGENTS.md`.

- **Waves:** humans file issues as `todo`. Up to `maxWave` (default 5) issues are in work (`active`) at once; while
  fewer are, baton asks the orchestrator to fill the free slots: one model call that sees the first `maxWave` (in the
  board's manual order: higher = first) not yet started `todo` issues and every parked one that pass the hard gates
  below (so none overlaps an issue in work), with the not yet started ones taken greedily: one whose footprint overlaps
  an issue already taken into that window is skipped (it stays first in line for the next wave), with their descriptions, footprints, blockers (each with its status: all closed, baton checked) and people's latest comments,
  what is in work, the number of free slots, the other open and recently closed issues,
  every agent's name and description, and each project's `AGENTS.md`. It answers which issues start now (at most one per
  free slot) and which agent takes each; baton starts them. An offered issue it does not start is **refused**: it is
  left out of the offer, so the next wave (on the next tick) is asked about the issues behind it, and one refused issue
  that overlaps the rest cannot hold the whole queue. A refusal lasts until the open issues change (a slot comes free,
  an issue in work closes, goes to `in_review` or is parked, a new board order, an edited issue, a new blocker or
  label) or a person comments on that issue. When it starts nothing, its one-line reason goes to `bridge.log`; once
  everything startable is refused and nothing is in work either, one wrong "nothing" would hold the queue until somebody
  touches an issue, so it is asked again from the top 1, then 5, then 15 minutes later (`waveRetrySec`, seconds;
  `[]` = never); after that its answers stand until something changes.
  For an issue it leaves out it may also fix the board, with a line baton applies and explains in a `Bridge:` comment
  on the issue: `<KEY> after <OTHER>` makes the open issue OTHER its blocker (not one that would close a cycle),
  `<KEY> human` adds `needs-human` (a duplicate, an obsolete or unclear issue: closing it is a person's call).
  `bridge.log` shows each as `fix`.
- **Hard gates** the orchestrator cannot override: `backlog` (move it to `todo`), open blockers (Lific's native
  "blocked by" links, across projects too), the `needs-human` label, an assignment to a person (Lific's "any person" or
  named people; an unassigned issue is the agents', and a running one assigned to a person parks), and a `footprint` property (Haiku-estimated if
  missing) that overlaps an issue of the same project that is `active` or `in_review`.
- **Agents:** one JSON file each (`name`, `model`, `description`, `instructions`) in `agents/` — `worker`, a
  project-independent worker that takes the process from the repo's `AGENTS.md`, and `orchestrator` — plus your own in
  `local/agents/` (gitignored; `agents` in `config.json` names another directory; a file with the same `name` replaces
  the base one). The orchestrator (`orchestrator` in `config.json` names another) never gets an issue: baton reads
  its model and instructions, which are extra guidance for the choice. Files are read every tick: no restart to edit one.
- **Runs:** one git worktree per issue, kept until the issue closes, and one agent session per agent on it, so a
  later run resumes the conversation and reuses the build output. The worktree hangs off the project's local checkout
  (`path`) at `<path>.wt/<KEY>`, detached at `origin/<base>`; the agent makes its own branch. The agent process starts
  in that worktree, so everything the repo ships for coding agents (`.claude/skills`, `.claude/settings.json` with its
  hooks, `.mcp.json`, `CLAUDE.md`) is loaded as in an interactive session there. An `active` issue is the agent's to
  move: baton starts it again whenever its process has ended, parks it back to `todo` (it is offered again in the next
  wave) while it waits on a blocker or a human, and after `maxRuns` (default 3) runs of one agent in a row with nothing
  to show adds `needs-human` instead of burning tokens. When the issue closes, baton removes its worktree and first stops
  every process still running in it (cwd inside the worktree or a path into it on the command line: the agent's
  background commands, dev servers): SIGTERM, SIGKILL 3 s later; `bridge.log` says `cleanup <KEY> killed <n>`.
  **Talking to a running agent:** comment on its issue. baton checks the comments of every running issue each tick;
  a new one goes to `state/inbox/<KEY>` unless the run itself wrote it, and a hook baton adds to the run (`--settings`:
  `PostToolUse` and `Stop`, on top of the repo's own hooks) shows it to the agent after its current tool call, or keeps
  it from ending its turn before it has read it (`bridge.log`: `tell <KEY> <n> comment`). A sub-agent's tool calls leave it
  to the main agent. A comment made while no run is active is read by the next run, as before. All agents share one tracker
  user, so a run's own comments are told apart by a mark: baton's `lific` wrapper appends `<!-- baton <KEY> run <n> -->`
  (`$BATON_RUN`) to the content of every `comment add` of the run. A comment by the agent of another issue (or an earlier
  run of this one) reaches the run like a person's.
  `in_review` waits for a review, not for an agent: baton leaves it alone and keeps its footprint reserved. While an issue runs
  its run log in the tracker shows, a tick behind, what the agent is doing.
- **Hand-offs:** the issue's `agent` property names the agent that holds it. baton sets it when it starts the issue;
  an agent passes the issue on with `lific issue update <KEY> --set agent=<name>` when the repo's rules say so, and the
  next run is that agent's (a new session in the same worktree).
- **Herdr mode** (`"herdr": true` in `config.json`): every issue that runs gets a tab in a [Herdr](https://herdr.dev)
  workspace with the detailed live view of its agent (`node watch.mjs <KEY>`): what it says, every tool call and skill,
  the head of every result. The agent itself runs headless as always; to tell it something, comment on the issue (it sees the comment after its current tool call).
- **Fresh start:** label `fresh` on an issue = its next run starts with a new session and a new worktree (baton drops both, stops the worktree's processes as on close, and removes the label; unpushed work in the old worktree is lost).

## Run
1. Lific: put the binary at `bin/lific` (it must be built from `master` of the fork, GeTechG/lific: `in_review` status, issue properties,
   run log, `issue update --add-label/--remove-label`, `issue link` defaulting to `blocks` — none of it is upstream), `bin/lific init` (config, database, your admin account, a user service on
   `:3456`). Create one project per repo (its name = the key in `config.json`), the labels `needs-human` and `fresh` in each, and two bot users with an API key each
   (`lific user create --bot`, `lific member add --all … --role maintainer`, `lific key create`): one for baton, one for the agents.
2. `.env` (gitignored): `LIFIC_API_KEY=` baton's key, `AGENT_LIFIC_API_KEY=` the agents' key, `AGENT_GH_TOKEN=` the
   GitHub token agents push with. Every `AGENT_X` reaches the agent processes as `X`; baton itself uses the machine's `gh` login.
   An agent's `PATH` starts with baton's `lific` wrapper (the HTTP backend, comments marked with the run) and its worktree's `node_modules/.bin`;
   its env has `BATON_ISSUE` (its issue key) and `BATON_RUN`.
3. Write `config.json` (gitignored):
   ```json
   {
     "lific": { "bin": "bin/lific", "url": "http://127.0.0.1:3456" },
     "projects": {
       "<Lific project name>": { "repo": "owner/repo", "base": "main", "path": "/abs/path/to/your/checkout" }
     }
   }
   ```
   Optional: `orchestrator`, `agents`, `maxWave`, `maxRuns`, `waveRetrySec`, `stateDir`, `tickSec`, `humanLabel`, `freshLabel`, `notify.ntfy` (topic URL), `agent.user`, `agent.cmd`,
   `herdr` (`true`, or `{ "workspace": "baton-agents" }`: the label of the workspace the tabs go to, in the default Herdr session, which must be running).
4. `scripts/up.sh` (or, with `.env` exported, `npm start` / `node baton.mjs --once` for one tick). State and `bridge.log` go to `state/`.

`scripts/`: `up.sh` (starts the tracker if it is down, then the baton loop, idempotent), `down.sh` (`--all` also kills the agent
runs) and `status.sh`.

Once set up, the whole thing (Lific + baton) starts and stops like this:

```sh
scripts/up.sh               # starts the tracker service if it is down (UI on :3456), then the baton loop
scripts/status.sh           # tracker / baton / running agents / last log lines
node watch.mjs              # live view of the agents

scripts/down.sh             # stop baton (agents finish their run); --all kills them too
bin/lific service stop      # stop the tracker (it returns on reboot)
```

baton does not survive a reboot: run `scripts/up.sh` again. After `git pull`: `scripts/down.sh && scripts/up.sh`.

## Adding a project
One entry in `config.json` `projects`, keyed by the Lific project name: `repo` and `base` (any branch; where the
footprint tree and `AGENTS.md` are read from and what issue worktrees start at), and optionally `path` (your local
checkout of the repo — issue worktrees are made from it; without it baton keeps its own clone under `state/src/`),
`worktrees` (where they go; default `<path>.wt`), `footprintHint`, `sharedPaths`, `setup`, `instructions` and `milestone`.

`sharedPaths` lists paths nearly every issue names but writes only its own piece of (its own folder under them, its own
line in a shared file), so a rebase merges the edits, e.g. `["openspec/", "docs/tech-debt.md"]`. When footprints are
compared, a path in the list or under it does not count on either side; a footprint left with only shared paths counts
as empty (it overlaps everything).

`setup` is a shell command baton runs in an issue's worktree right after creating it, before the agent starts (so also
after the `fresh` label; not on later runs in the kept worktree): what the repo needs before a session and its MCP
servers come up, e.g. a toolchain, an LSP config, submodules. Its cwd is the worktree; `BATON_SOURCE` is the project's
local checkout the worktree hangs off, `BATON_ISSUE` the issue key. If it fails, no agent starts: the worktree is
removed, the issue gets `needs-human` and a comment with the tail of the command's output (also a `setup failed` line
in `bridge.log`), and is parked; remove the label to try again. It runs inside baton's tick, so keep it short.

`instructions` is text for the agents of this project only: baton appends it to an agent's first prompt on the issue
as a paragraph headed `Project guidance:`. The agents' own instructions stay project-independent.

`milestone` is the gate of the merged tree, for a repo whose per-issue gate leaves some stages to it. baton runs it
once the project's queue is empty (no agent run is active and no issue of the project waits to start) and `origin/<base>`
has moved past the last green commit: `tag` if set (a tag the command itself moves on green), else the last commit baton
saw green.
```json
"milestone": { "cmd": "make milestone", "tag": "milestone-green", "failed": "^FAIL: (.+)$",
               "bisect": "git bisect start \"$BATON_BAD\" \"$BATON_GOOD\" && git bisect run make stage STAGE=\"$BATON_STAGE\"",
               "timeoutSec": 2400 }
```
It runs detached (the tick goes on; waves are not held) in a clean worktree `<worktrees>/_milestone` at that commit,
after the project's `setup`, under `timeout timeoutSec` (default 2400). On a red exit, `failed` (a regex, capture group 1
= the label of a red stage, one per line of the output) names the red stages; for each, baton runs `bisect` in the same
worktree with the same time limit and `BATON_STAGE` (the stage), `BATON_BAD` (the red commit) and `BATON_GOOD` (the last
green one) set, reads the culprit from git bisect's own line `<sha> is the first bad commit`, and files one `todo` issue
in the project: the stage, the first bad commit, the issue its subject names, the stage's part of the output (from its
first mention to its next) and the log paths. No `bisect`, or no green commit yet: the issues have no culprit. A red exit
that names no stage (a timeout is exit 124, a failed `setup`) files one issue with the tail of the output and
`needs-human`. A commit is tried once; the next milestone waits until the base moves again and every issue the last red
one filed is closed. Logs and state: `state/milestones/`, `state/milestones.json`;
`bridge.log` has a `milestone <KEY> run|red|green|bisect|filed` line for each step.

An agent run is `agent.cmd` in `config.json` (default: Claude Code, headless, stream-json into `state/logs/<KEY>.log`)
plus `--model <the agent's model>`, `--session-id <uuid>` on the agent's first run on the issue or `--resume <uuid>`
after that (a session that never started is not resumed), then the prompt: the agent's `instructions`, the issue key, repo and base branch, and the project's `instructions` if set.
Nothing project-specific lives in this repo: `config.json`, `.env` and `local/` are gitignored.

## Agent skill
`skills/baton/SKILL.md` tells any coding agent (Claude Code, Codex, opencode, …) that a repo is run by baton + Lific
and what not to do by hand. Install: `npx skills add GeTechG/baton` (add `-g` for all your projects).

## Tests
- `node watch.mjs` — live view of what every running agent is doing (run it in a spare terminal pane);
  `node watch.mjs <KEY>` — the detailed view of one issue, from the start of its log.
- `npm test` — pure logic (footprints, gates, run decisions, wave parsing, milestone decisions).
