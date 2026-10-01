# Working in this repo

baton is the scheduler + merge queue that may have assigned you this very issue (see `skills/baton/SKILL.md`).

- **A live instance is off limits.** A checkout of this repo outside your own working directory may be the one a running
  scheduler was started from: treat it as read-only. Never edit files or run state-changing git there, never read `.env`,
  never start, stop or restart baton, the Multica daemon or the containers (`local/up.sh`, `local/down.sh`,
  `docker compose`), and never run `node baton.mjs` (even `--once`) or anything under `e2e/` — they act on a real
  Multica workspace and real GitHub repos. `node watch.mjs` and read-only `multica … list/get` are fine.
- Read `README.md` first. Keep the style: plain Node ESM, zero dependencies, `baton.mjs` stays one compact file,
  decisions live in pure functions that `baton.test.mjs` covers, a comment only where the reason is not obvious.
- Nothing instance-specific goes into the repo (ids, repo names, tokens, paths under `local/`): `config.json`, `.env`,
  `local/` and `state/` are gitignored.
- New behaviour = a pure function + a test for it; update `README.md` (and `skills/baton/SKILL.md` if the rules for
  agents change) in the same change.
- There is no CI: `npm test` green is the gate. Run it before every push and say so in the PR. What tests cannot cover
  (calls to `multica`/`gh`/`git`), verify by reading the CLI's `--help` and say in the PR what stays unverified.
- A landed change takes effect only once the maintainer pulls and restarts the live instance. If it needs a
  `config.json`/`local/` edit or anything beyond `git pull` + restart, list that in the hand-off comment, one line each.
- Scheduling and merge semantics are the maintainer's call: when an issue needs such a decision, ask instead of guessing.
