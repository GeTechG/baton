# baton

Scheduler, agent runner and batch merge queue on top of [Lific](https://github.com/VoidNullable/lific), a single-binary
local issue tracker. Lific holds the issues and is the UI; baton decides **when** each issue runs, runs the coding agent
for it in a git worktree of your own checkout, and decides **what** reaches `main`.

- **Scheduling (stateless):** humans file issues as `todo`; baton moves one to `active` and starts its agent only when
  every issue that blocks it (Lific's native "blocked by" links, across projects too) is done, it has no `needs-human`
  label, and its `footprint` property (Haiku-estimated if missing)
  doesn't overlap an in-flight issue. `backlog` issues are never picked up: move them to `todo`.
- **Runs:** one git worktree and one agent session per issue, both kept until the issue closes, so a later run resumes
  the conversation and reuses the build output. The worktree hangs off the project's local checkout (`path`) at
  `<path>.wt/<KEY>`, detached at `origin/<base>`; the agent makes its own branch. An `active` issue is the agent's to move: baton starts it again whenever its process has ended, parks it back to
  `todo` while it waits on a blocker or a human, and after `maxRuns` (default 3) runs in a row with nothing to show
  adds `needs-human` instead of burning tokens. While it runs the issue is assigned to the agents' tracker user
  (`agent.user`, default `agent`) and its run log in the tracker shows, a tick behind, what the agent is doing.
- **Merge queue (Bors-style):** agents only open PRs and set `in_review`. Green PRs are merged `--no-ff` into
  `batch/<ts>` on top of base; base fast-forwards only to a batch whose exact tree passed CI. Red batch → bisect;
  a single red PR goes back to its agent. `main` is never red.
- **Post-landing steps:** label `after-landing` on an issue = after its PR lands baton hands it back to the agent (`active` + a comment) instead of closing it; the agent sets `done`.
- **Fresh start:** label `fresh` on an issue = its next run starts with a new session and a new worktree (baton drops both and removes the label; unpushed work in the old worktree is lost).
- **Release gate:** `"release": "build-{sha}"` on a project = after its batch lands, the issues stay in review (and the
  queue of that repo waits) until that GitHub release exists for the landed commit (after `releaseTimeoutMin`, default 60, baton comments on the issues and pings ntfy once, then keeps waiting) — for repos whose consumers pin a commit and need its build.
- **Human gates:** `gate:spec` issues post a plan and park on `needs-human`; swap it for `spec:approved` to proceed.

## Run
1. Lific: put the binary at `bin/lific` (it must be built from the `baton-features` branch of the fork: `in_review` status, issue properties,
   assignee, run log, `issue update --add-label/--remove-label`, `issue link` — none of it is upstream), `bin/lific init` (config, database, your admin account, a user service on
   `:3456`). Create one project per repo (its name = the key in `config.json`), the labels `needs-human`, `gate:spec`,
   `spec:approved`, `fresh`, `after-landing` in each, and two bot users with an API key each
   (`lific user create --bot`, `lific member add --all … --role maintainer`, `lific key create`): one for baton, one for the agents.
2. `.env` (gitignored): `LIFIC_API_KEY=` baton's key, `AGENT_LIFIC_API_KEY=` the agents' key, `AGENT_GH_TOKEN=` the
   GitHub token agents push with. Every `AGENT_X` reaches the agent processes as `X`; baton itself uses the machine's `gh` login.
3. `cp e2e/config.example.json config.json` and edit: repos, local checkouts, checks, batch/in-flight caps, footprint hint, instructions file.
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
One entry in `config.json` `projects`: `repo`, `base` (any branch — `main`, `development`, …), `branchPrefix`, `batchPrefix`,
`checks` (`"all"`, a list of check names, or `"none"` for a repo without CI — turn it on once the repo has CI), `maxBatch`,
`instructions`, and optionally `path` (your local checkout of the repo — issue worktrees are made from it; without it
baton keeps its own clone under `state/src/`), `worktrees` (where they go; default `<path>.wt`), `prChecks`, `check` (the command the agent runs before pushing), `release`, `footprintHint`.

The agent is whatever `agent.cmd` in `config.json` starts (default: Claude Code, headless, stream-json into
`state/logs/<KEY>.log`); baton appends `--session-id <uuid>` on an issue's first run and `--resume <uuid>` after that,
then the prompt. `agents/default.md` is a project-independent worker that takes the process from the repo's own
`AGENTS.md`. `{{projects}}` in an instructions file is replaced with one line per project — key prefix, repo, base
branch, PR branch, `check` — so nothing per-project is hardcoded in the text. A project that needs its own workflow
(OpenSpec, …) gets its own instructions file.
Nothing project-specific lives in this repo: `config.json`, `.env` and your instruction files in `local/` are gitignored.

## Agent skill
`skills/baton/SKILL.md` tells any coding agent (Claude Code, Codex, opencode, …) that a repo is run by baton + Lific
and what not to do by hand. Install: `npx skills add GeTechG/baton` (add `-g` for all your projects).

## Tests
- `node watch.mjs` — live view of what every running agent is doing (run it in a spare terminal pane).
- `npm test` — pure logic (footprints, readiness, batch decisions).
- `e2e/` — the end-to-end bench on throwaway repos `GeTechG/orch-spike-{app,lib}`: `e2e/SCENARIO.md`, `e2e/reset.sh`.
  Its scripts expect projects `app` (prefix `APP`) and `lib` (`LIB`) in the tracker.
