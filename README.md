# baton

Scheduler + batch merge queue on top of a self-hosted [Multica](https://github.com/multica-ai/multica).
Multica runs the agents (local daemon, worktrees, UI); baton decides **when** each issue runs and **what** reaches `main`.

- **Scheduling (stateless):** humans file issues *unassigned*; baton assigns the project's agent only when the issue's
  `blocked-by` issues are done, it has no `needs-human` label, and its `footprint` (Haiku-estimated if missing) doesn't
  overlap an in-flight issue. Cross-project blockers work the same way. `backlog` issues are never picked up: move them to `todo`.
- **Merge queue (Bors-style):** agents only open PRs and set `in_review`. Green PRs are merged `--no-ff` into
  `batch/<ts>` on top of base; base fast-forwards only to a batch whose exact tree passed CI. Red batch → bisect;
  a single red PR goes back to its agent. `main` is never red.
- **Post-landing steps:** label `after-landing` on an issue = after its PR lands baton hands it back to the agent (`in_progress` + a comment) instead of closing it; the agent sets `done`.
- **Fresh start:** label `fresh` on an issue = its next run starts with a clean session and working directory (baton reruns it and removes the label).
- **Release gate:** `"release": "build-{sha}"` on a project = after its batch lands, the issues stay `in_review` (and the
  queue of that repo waits) until that GitHub release exists for the landed commit (after `releaseTimeoutMin`, default 60, baton comments on the issues and pings ntfy once, then keeps waiting) — for repos whose consumers pin a commit and need its build.
- **Human gates:** `gate:spec` issues post a plan and park on `needs-human`; swap it for `spec:approved` to proceed.

## Run
1. Multica: `cp multica/.env.example multica/.env` (set secrets), `docker compose -p baton -f multica/docker-compose.yml up -d`;
   put the CLI binary at `multica/bin/multica`, log in (`multica/m login`), start the daemon, create one project per repo + an agent.
2. `cp e2e/config.json config.json` and edit: repos, agent ids, checks, batch/in-flight caps, footprint hint, instructions file.
3. `npm start` (or `node baton.mjs --once` for one tick). State and `bridge.log` go to `state/`.

## Adding a project
One entry in `config.json` `projects`: `repo`, `base` (any branch — `main`, `development`, …), `branchPrefix`, `batchPrefix`,
`checks` (`"all"`, a list of check names, or `"none"` for a repo without CI — turn it on once the repo has CI), `maxBatch`,
`agent`, `instructions`, and optionally `prChecks`, `check` (the command the agent runs before pushing), `release`, `footprintHint`.

One agent can serve every project: `agents/default.md` is a project-independent worker that takes the process from the
repo's own `AGENTS.md`. `{{projects}}` in an instructions file is replaced on start with one line per project of that
agent — repo, base branch, PR branch, `check` — so nothing per-project is hardcoded in the text. A project that needs
its own workflow (OpenSpec, …) gets its own agent and instructions file.
Nothing project-specific lives in this repo: `config.json`, `.env` and your instruction files in `local/` are gitignored.

## Agent skill
`skills/baton/SKILL.md` tells any coding agent (Claude Code, Codex, opencode, …) that a repo is run by baton + Multica
and what not to do by hand. Install: `npx skills add GeTechG/baton` (add `-g` for all your projects).

## Tests
- `node watch.mjs` — live view of what every in-flight agent is doing (run it in a spare terminal pane).
- `npm test` — pure logic (footprints, readiness, batch decisions).
- `e2e/` — the end-to-end bench on throwaway repos `GeTechG/orch-spike-{app,lib}`: `e2e/SCENARIO.md`, `e2e/reset.sh`.
  Scripts there hold instance-specific Multica ids — refresh them after re-creating the instance.
