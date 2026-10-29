# baton

Scheduler and agent runner on top of [Lific](https://github.com/VoidNullable/lific), a single-binary local issue
tracker. Lific holds the issues and is the UI; baton decides **when** each issue runs and **who** takes it, and runs
the coding agent for it in a git worktree of your own checkout. It does not say how a repo is run: branches, PRs, CI,
merging and who sets `done` come from the agents' instructions (`agents/*.json`) and the repo's own `AGENTS.md`, unless a
project turns on the land queue (`land`, below): then baton merges, gates and pushes what the agents hand over.

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
  to show adds `needs-human` instead of burning tokens. A run the account's usage limit cut off (Claude Code's
  `usage_limit_reached`) does not count; no agent and no wave starts until the limit resets (`bridge.log`:
  `limit <KEY> run not counted, agents wait until <time>`, UTC like the rest of the log). When the issue closes, baton removes its worktree and first stops
  every process still running in it (cwd inside the worktree or a path into it on the command line: the agent's
  background commands, dev servers): SIGTERM, SIGKILL 3 s later; `bridge.log` says `cleanup <KEY> killed <n>`.
  The local branch the worktree had checked out (it lives in the shared checkout) goes too, once `origin/<base>` contains it;
  an unmerged one stays.
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
- **Land queue** (a project's `land`): an agent does not merge its own branch. It pushes it, names it in the issue's
  `branch` property and hands the issue over: `in_review` with the label `land` (`landLabel`). baton merges every ready
  branch of the project in one batch, runs the landing gate once on the whole batch and pushes it; a red batch is
  bisected, and the branch that turns it red goes back to its agent (`active` again, with the gate's output in a
  `Bridge:` comment), while the branches before it land. Details under *Adding a project*.
- **Fresh start:** label `fresh` on an issue = its next run starts with a new session and a new worktree (baton drops both, stops the worktree's processes as on close, and removes the label; unpushed work in the old worktree is lost).

## Run
1. Lific: put the binary at `bin/lific` (it must be built from `master` of the fork, GeTechG/lific: `in_review` status, issue properties,
   run log, `issue update --add-label/--remove-label`, `issue link` defaulting to `blocks` — none of it is upstream), `bin/lific init` (config, database, your admin account, a user service on
   `:3456`). Create one project per repo (its name = the key in `config.json`), the labels `needs-human` and `fresh` in each (and `land` in a project with a land queue), and two bot users with an API key each
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
   Optional: `orchestrator`, `agents`, `maxWave`, `maxRuns`, `waveRetrySec`, `stateDir`, `tickSec`, `humanLabel`, `freshLabel`, `landLabel`, `notify.ntfy` (topic URL), `agent.user`, `agent.cmd`,
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
`worktrees` (where they go; default `<path>.wt`), `footprintHint`, `sharedPaths`, `setup`, `instructions`, `land` and `milestone`.
baton's Lific user must be a member of the project (`lific member add --project <PREFIX> --user <baton's user> --role maintainer`):
Lific hides a project from a non-member, and its issues from every `blocked_by`, so a blocker there would not hold the
issue that waits on it. A configured project baton does not see is in `bridge.log` as `unseen <name>`.

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

`land` turns on the merge queue for the project. The landing gate (say 15 minutes of the whole machine) then runs once per
batch instead of once per issue, plus again after every rebase onto a base another issue has just moved; and agents
never wait for it.
```json
"land": { "cmd": "tools/check release --merge-gate", "max": 5, "timeoutSec": 3600, "holdSec": 300 }
```
An issue is ready to land when it is `in_review`, has the label `land` (`landLabel`; create it in the project), no
`needs-human` and no blocker that is not `done` (a blocker in the queue lands first, the issue in the batch after it;
`bridge.log`: `land <KEY> waits for <blockers>`), and its `branch` property names a branch on origin; what has to happen before that (a review, human QA)
is the repo's rules. While no batch of the project is in work, baton takes the ready issues; with `holdSec`, only once the oldest of
them has waited that long (seconds, counted from when baton first saw it ready, a gate it waited out included) while
another issue of the project is `active`, so a branch handed over a minute later shares the gate (none `active`, or
`max` ready: no wait; `bridge.log` says `land <KEY> hold`). It takes them (board order, at most `max`,
default 5), merges their branches one after another onto `origin/<base>` in a clean worktree `<worktrees>/_land`
(`git merge --no-ff`, subject `Merge <branch> (<KEY>)`, so the milestone's bisect finds the issue) and runs `cmd` there,
detached like the milestone, after the project's `setup`, under `timeout timeoutSec` (default 2400). The gate sees the
batch as one change against `origin/<base>`. Green: baton pushes the merged commit to `<base>` (a plain push: if the base
has moved meanwhile, it is rejected and the batch is tried again from the start), sets each issue `done` with a comment,
and deletes its branch on origin (`bridge.log`: `land <project> branch kept <branch>` if that fails). Red: the batch's prefixes (the base plus its first k branches) are bisected, each with
the full `cmd`, so at most 1 + log2(n) gate runs; the longest green prefix lands as above, the branch that turns it red goes
back to its agent: the issue is `active` again (its footprint stays reserved; this may take the wave past `maxWave` for a while), loses the label, and gets a `Bridge:`
comment with the gate's output; the branches after it wait for the next batch. A branch that is missing on origin or
does not merge cleanly onto the base and the branches before it goes back at once, the same way. An issue waiting in
the queue holds no agent and no slot, but keeps its footprint reserved until it lands. The milestone waits while a
batch runs or an issue waits to land. Logs and state: `state/lands/`, `state/lands.json`; `bridge.log` has a
`land <KEY> hold|gate|green|red|landed|back|push failed` line for each step.

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
- `npm test` — pure logic (footprints, gates, run decisions, wave parsing, land queue and milestone decisions).
