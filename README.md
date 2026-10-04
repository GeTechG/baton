# baton

Scheduler and agent runner on top of [Lific](https://github.com/VoidNullable/lific), a single-binary local issue
tracker. Lific holds the issues and is the UI; baton decides **when** each issue runs and **who** takes it, and runs
the coding agent for it in a git worktree of your own checkout. It does not say how a repo is run: branches, PRs, CI,
merging and who sets `done` come from the agents' instructions (`agents/*.json`) and the repo's own `AGENTS.md`.

- **Waves:** humans file issues as `todo`. When no agent run is active, baton asks the orchestrator once: one model
  call that sees the first `maxWave` (default 5, in the board's manual order: higher = first) not yet started `todo`
  issues and every parked one, with their descriptions and footprints, the other open and recently closed issues,
  every agent's name and description, and each project's `AGENTS.md`. It answers which issues start now and which
  agent takes each; baton starts them and stays out of the way until every run has ended. It is asked again only
  when something about the issues changed. When it starts nothing, its one-line reason goes to `bridge.log`.
- **Hard gates** the orchestrator cannot override: `backlog` (move it to `todo`), open blockers (Lific's native
  "blocked by" links, across projects too), the `needs-human` label, and a `footprint` property (Haiku-estimated if
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
  to show adds `needs-human` instead of burning tokens. `in_review` waits for a review, not for an agent: baton
  leaves it alone and keeps its footprint reserved. While an issue runs it is assigned to the agents' tracker user
  (`agent.user`, default `agent`) and its run log in the tracker shows, a tick behind, what the agent is doing.
- **Hand-offs:** the issue's `agent` property names the agent that holds it. baton sets it when it starts the issue;
  an agent passes the issue on with `lific issue update <KEY> --set agent=<name>` when the repo's rules say so, and the
  next run is that agent's (a new session in the same worktree).
- **Herdr mode** (`"herdr": true` in `config.json`): a run is an interactive Claude Code in a tab of a
  [Herdr](https://herdr.dev) workspace instead of a headless process, so you can watch every agent work and type into
  its pane. The agent is told that it runs unattended and that nobody will answer (and has no `AskUserQuestion` tool):
  it works as it does headless, and what you do write to it is an instruction. A run is over when Herdr sees the agent
  stop working (idle); `blocked` on a dialog counts as still running and waits for you. The tab stays open after the
  run; the next run of the issue replaces it with a new tab that resumes the session, and closing the issue closes it.
- **Fresh start:** label `fresh` on an issue = its next run starts with a new session and a new worktree (baton drops both and removes the label; unpushed work in the old worktree is lost).

## Run
1. Lific: put the binary at `bin/lific` (it must be built from the `baton-features` branch of the fork: `in_review` status, issue properties,
   assignee, run log, `issue update --add-label/--remove-label`, `issue link` — none of it is upstream), `bin/lific init` (config, database, your admin account, a user service on
   `:3456`). Create one project per repo (its name = the key in `config.json`), the labels `needs-human` and `fresh` in each, and two bot users with an API key each
   (`lific user create --bot`, `lific member add --all … --role maintainer`, `lific key create`): one for baton, one for the agents.
2. `.env` (gitignored): `LIFIC_API_KEY=` baton's key, `AGENT_LIFIC_API_KEY=` the agents' key, `AGENT_GH_TOKEN=` the
   GitHub token agents push with. Every `AGENT_X` reaches the agent processes as `X`; baton itself uses the machine's `gh` login.
3. Write `config.json` (gitignored):
   ```json
   {
     "lific": { "bin": "bin/lific", "url": "http://127.0.0.1:3456" },
     "projects": {
       "<Lific project name>": { "repo": "owner/repo", "base": "main", "path": "/abs/path/to/your/checkout" }
     }
   }
   ```
   Optional: `orchestrator`, `agents`, `maxWave`, `maxRuns`, `stateDir`, `tickSec`, `humanLabel`, `freshLabel`, `notify.ntfy` (topic URL), `agent.user`, `agent.cmd`,
   `herdr` (`true`, or `{ "workspace": "baton-agents", "args": [...] }`: the workspace label and the `claude` arguments of a run).
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
`worktrees` (where they go; default `<path>.wt`) and `footprintHint`.

An agent run is `agent.cmd` in `config.json` (default: Claude Code, headless, stream-json into `state/logs/<KEY>.log`)
plus `--model <the agent's model>`, `--session-id <uuid>` on the agent's first run on the issue or `--resume <uuid>`
after that, then the prompt: the agent's `instructions` and the issue key, repo and base branch.
In Herdr mode `agent.cmd` is not used: baton opens a tab labelled with the issue key in the workspace labelled `baton-agents`
of the default Herdr session (which must be running; the workspace is created when missing), sources `state/agent.env`
(the `AGENT_X` values, mode 600) in its shell, starts `claude` there under the agent name `<key in lower case>` and sends
the prompt. `state/logs/<KEY>.log` is then a link to the session's Claude Code transcript, so the tracker's run log,
`watch.mjs`, `status.sh` and `down.sh --all` work as for a headless run (a killed agent leaves its tab with a shell). Trust the worktrees directory in Claude Code once, or the first run of an issue
stops at the trust dialog.
Nothing project-specific lives in this repo: `config.json`, `.env` and `local/` are gitignored.

## Agent skill
`skills/baton/SKILL.md` tells any coding agent (Claude Code, Codex, opencode, …) that a repo is run by baton + Lific
and what not to do by hand. Install: `npx skills add GeTechG/baton` (add `-g` for all your projects).

## Tests
- `node watch.mjs` — live view of what every running agent is doing (run it in a spare terminal pane).
- `npm test` — pure logic (footprints, gates, run decisions, wave parsing).
