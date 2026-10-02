# baton

Scheduler on top of a self-hosted [Multica](https://github.com/multica-ai/multica).
Multica runs the agents (local daemon, worktrees, UI); baton decides **when** each issue runs and **who** takes it. It
does not say how a repo is run: branches, PRs, CI, merging and who sets `done` come from the agents' instructions (set
in Multica) and the repo's own `AGENTS.md`.

- **Waves:** humans file issues *unassigned*. When no agent run is active, baton asks the orchestrator once: one model
  call that sees the first `maxWave` (default 5, in the board's manual order: higher = first) not yet started `todo` issues and every parked one, with
  their descriptions and footprints,
  the other open and recently closed issues, every agent's name and description, and each project's `AGENTS.md`. It
  answers which issues start now and which agent takes each; baton assigns them and stays out of the way until every
  run has ended. It is asked again only when something about the issues changed.
- **Hard gates** the orchestrator cannot override: `backlog` (move it to `todo`), open `blocked-by` issues (cross-project
  keys work), the `needs-human` label, and a `footprint` (Haiku-estimated if missing) that overlaps an issue an agent holds.
- **Orchestrator:** a Multica agent (the one named `orchestrator`; `orchestrator` in `config.json` names another, by id or name) that is never assigned an issue: baton reads its
  model and instructions, so both are edited in the Multica UI. Its instructions are extra guidance for the choice.
- **Hand-offs:** an agent passes an issue on with `multica issue assign <KEY> --to <agent>` when the repo's rules say so;
  it stays held (footprint, parking). A parked issue goes back to waiting for the next wave.
- **Fresh start:** label `fresh` on an issue = its next run starts with a clean session and working directory (baton reruns it and removes the label).
- **Human gate:** label `needs-human` on an issue = baton does not assign it (or parks it once its run ends) and pings ntfy once.

## Run
1. Multica: `cp multica/.env.example multica/.env` (set secrets), `docker compose -p baton -f multica/docker-compose.yml up -d`;
   put the CLI binary at `multica/bin/multica`, log in (`multica/m login`), start the daemon, create one project per repo,
   then `scripts/agents.sh` creates the base agents from `agents/*.json` (`worker`, `orchestrator`) and gives them `GH_TOKEN` from `.env`.
2. Write `config.json` (gitignored):
   ```json
   {
     "multica": { "bin": "multica/bin/multica", "profile": "baton", "server": "http://localhost:8080" },
     "projects": {
       "<Multica project title>": { "repo": "owner/repo", "base": "main" }
     }
   }
   ```
   Optional: `orchestrator`, `maxWave`, `stateDir`, `tickSec`, `humanLabel`, `freshLabel`, `notify.ntfy` (topic URL), per project `footprintHint`.
3. `npm start` (or `node baton.mjs --once` for one tick). State and `bridge.log` go to `state/`.

`scripts/` wraps this for a single-machine instance, so it comes down to two commands: `install.sh` once (writes
`multica/.env` with a fresh `JWT_SECRET`, downloads the CLI, writes a `config.json` without projects, starts everything,
logs in, creates the base agents; needs `.env` with `GH_TOKEN`; idempotent) and `up.sh` to run (containers → daemon →
baton, idempotent). Also: `down.sh` (`--all` also stops the containers), `status.sh`, `login-code.sh` (the web UI's
one-time login code), `agents.sh` (creates the agents in `agents/*.json` that are missing by name, existing ones are
never overwritten, then runs `agent-env.sh`) and `agent-env.sh` (puts `GH_TOKEN` from `.env` into every agent's custom env).

## Adding a project
One entry in `config.json` `projects`, keyed by the Multica project title: `repo` and `base` (where the footprint tree and
`AGENTS.md` are read from), and optionally `footprintHint`.
Nothing project-specific lives in this repo: `config.json`, `.env` and `local/` are gitignored.

## Agent skill
`skills/baton/SKILL.md` tells any coding agent (Claude Code, Codex, opencode, …) that a repo is run by baton + Multica
and what not to do by hand. Install: `npx skills add GeTechG/baton` (add `-g` for all your projects).

## Tests
- `node watch.mjs` — live view of what every in-flight agent is doing (run it in a spare terminal pane).
- `npm test` — pure logic (footprints, gates, wave parsing).
