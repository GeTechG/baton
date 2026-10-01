# baton

Scheduler + batch merge queue on top of a self-hosted [Multica](https://github.com/multica-ai/multica).
Multica runs the agents (local daemon, worktrees, UI); baton decides **when** each issue runs and **what** reaches `main`.

- **Scheduling (stateless):** humans file issues *unassigned*; baton assigns the project's agent only when the issue's
  `blocked-by` issues are done, it has no `needs-human` label, and its `footprint` (Haiku-estimated if missing) doesn't
  overlap an in-flight issue. Cross-project blockers work the same way.
- **Merge queue (Bors-style):** agents only open PRs and set `in_review`. Green PRs are merged `--no-ff` into
  `batch/<ts>` on top of base; base fast-forwards only to a batch whose exact tree passed CI. Red batch → bisect;
  a single red PR goes back to its agent. `main` is never red.
- **Human gates:** `gate:spec` issues post a plan and park on `needs-human`; swap it for `spec:approved` to proceed.

## Run
1. Multica: `cp multica/.env.example multica/.env` (set secrets), `docker compose -p baton -f multica/docker-compose.yml up -d`;
   put the CLI binary at `multica/bin/multica`, log in (`multica/m login`), start the daemon, create one project per repo + an agent.
2. `cp e2e/config.json config.json` and edit: repos, agent ids, checks, batch/in-flight caps, footprint hint, instructions file.
3. `npm start` (or `node baton.mjs --once` for one tick). State and `bridge.log` go to `state/`.

## Adding a project
One entry in `config.json` `projects` + an agent-instructions markdown (the workflow: plain issue→PR, OpenSpec, …).
Nothing project-specific lives in this repo: `config.json`, `.env` and your instruction files in `local/` are gitignored;
`agents/default.md` is only a generic starting point.

## Tests
- `node watch.mjs` — live view of what every in-flight agent is doing (run it in a spare terminal pane).
- `npm test` — pure logic (footprints, readiness, batch decisions).
- `e2e/` — the end-to-end bench on throwaway repos `GeTechG/orch-spike-{app,lib}`: `e2e/SCENARIO.md`, `e2e/reset.sh`.
  Scripts there hold instance-specific Multica ids — refresh them after re-creating the instance.
