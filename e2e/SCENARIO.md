# Orchestrator spike — common scenario

Repos (private, throwaway): `GeTechG/orch-spike-app` (has submodule `vendor/lib` → `GeTechG/orch-spike-lib`),
`GeTechG/orch-spike-lib`. Both: Node ESM, tests `node --test`, GitHub Actions CI `test` on PR/push.
Local clones for reference: /home/sergey/Documents/orch-spike/work/{app,lib}. Reset: `./reset.sh` (restores `baseline` tag).

## Tasks to load into the candidate (as the human would, in its native way)
- **T1 (app):** add `export function greet(name)` returning `Hi, <name>!` to `src/a.js` + test.
- **T2 (app):** add `export function farewell(name)` returning `Farewell, <name>.` to `src/b.js` + test.
- **T3 (app):** change `hello()` in `src/a.js` to return `Hello, <name>` (capital + comma) and update its test.
  T3 has NO declared dependency on T1 but edits the same file → a good orchestrator serializes T1/T3
  (or detects/handles the conflict: rebase / re-dispatch). T2 should run parallel to T1.
- **T4 (app):** add `src/c.js` with `export function area(w, h)` implemented **via `mul` from `vendor/lib/src/math.js`**.
  lib has no `mul`. Expected: a task is filed on **lib** ("add mul"), T4 blocks, lib task is done → lib PR merged,
  then T4 resumes automatically, bumps the `vendor/lib` submodule to lib's new main, implements `area`, PR.
  You MAY pre-declare the lib task + dependency if the tool can't create cross-project tasks itself (record that).
- **T5 (app):** add `src/d.js` `export function shout(s)` (uppercase + `!`). Marked as requiring **human spec
  approval before implementation**. The operator (you) approves it only after T1 is merged, via the tool's own
  gate mechanism (UI/CLI) — this simulates a delayed human; other tasks must keep flowing meanwhile.

## Definition of done per task
PR opened against `main`, CI green, PR merged (by the system, not the operator — if the tool can't merge,
configure its agent instructions to `gh pr merge --squash --delete-branch` after green CI; record that glue).

## Worker model
Claude Code with `--model sonnet` (or the tool's equivalent setting). Keep budgets small.

## Also test
- **Restart resilience:** kill the orchestrator/daemon mid-run (while ≥1 task in progress), restart, observe.
- **Context:** does any long-lived LLM session accumulate context, or is orchestration stateless?

## Record (in RESULTS-<candidate>.md)
Setup steps + time; lines of config/glue you wrote; whether T1‖T2 ran in parallel; how T1/T3 was handled;
whether T4 cross-repo chain completed without operator help (and which parts were pre-declared);
how the T5 gate worked + where the human approves (UI/CLI/mobile) + notifications; restart behaviour;
every operator intervention beyond the T5 approval (each is a mark against); wall-clock; approximate cost if visible;
observability (can a human see what's going on?); bugs/rough edges. End with a 1–10 fit score + 3-line verdict.

## Notes from earlier legs
- App CI now fetches the private lib submodule via a read-only deploy key and is GREEN on baseline. No CI waiver:
  red CI must block merge.
- Check the tool's worktree/workspace isolation is REALLY active (Paperclip needed an experimental flag that was
  silently ignored otherwise) — verify tasks run in separate checkouts before judging parallelism.
