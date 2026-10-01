#!/usr/bin/env node
// Scheduler, agent runner and batch merge queue between Lific (the tracker) and GitHub; everything project-specific
// is in config.json ($BATON_CONFIG). Humans file issues as `todo`; baton alone moves one to `active`, gives it a git
// worktree off the project's local checkout and runs the agent there (one worktree and one agent session per issue,
// kept until the issue closes; the issue is assigned to cfg.agent.user and its run log shows what the agent does). Native "blocked by" links and the text property `footprint` gate readiness;
// cfg.humanLabel parks; status in_review = the agent handed off a PR on <branchPrefix><KEY>.
// Queue (Bors-style): green PRs merge --no-ff into batch/<ts> on base; base fast-forwards only to a batch whose exact tree
// passed CI; red -> bisect. Batch cached in batch-<repo>.json, recoverable from the remote branch's merge subjects.
// ponytail: prefix-match footprints, 100 open issues per project and status, one `issue get` per open issue per tick,
// serial bisect, a run is "alive" while its pid exists (a reboot can recycle it); refine when they hurt.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { plain, say } from './watch.mjs';

// Relative paths in the config (lific.bin, stateDir, instructions, path, worktrees) resolve against the baton checkout.
const ROOT = dirname(fileURLToPath(import.meta.url));
const CFG_FILE = process.env.BATON_CONFIG ?? resolve(ROOT, 'config.json');
const CFG = existsSync(CFG_FILE) ? JSON.parse(readFileSync(CFG_FILE, 'utf8')) : {}; // tests import pure fns without an instance
CFG.projects ??= {}; CFG.humanLabel ??= 'needs-human'; CFG.freshLabel ??= 'fresh'; CFG.afterLandLabel ??= 'after-landing'; CFG.maxInFlight ??= 4; CFG.maxRuns ??= 3; CFG.tickSec ??= 5;
CFG.agent ??= {}; CFG.agent.user ??= 'agent'; CFG.agent.cmd ??= ['claude', '-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'auto'];
const DIR = resolve(ROOT, CFG.stateDir ?? 'state'), CLOSED = ['done', 'cancelled'];
if (CFG.lific) CFG.lific.bin = resolve(ROOT, CFG.lific.bin);

const seen = new Map(); // log de-dup only: repeat decisions are logged once
const log = (key, ...a) => {
  const msg = a.join(' ');
  if (key && seen.get(key) === msg) return; else if (key) seen.set(key, msg);
  const line = `${new Date().toISOString().slice(11, 19)} ${msg}`;
  console.log(line); appendFileSync(`${DIR}/bridge.log`, line + '\n');
};
const run = (bin, args) => execFileSync(bin, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
// The tracker: Lific's CLI over HTTP, as the identity of $LIFIC_API_KEY. `--flag=value` so a value may start with a dash.
const t = (...a) => run(CFG.lific.bin, ['--json', '--backend', 'http', '--url', CFG.lific.url, ...a]);
const tj = (...a) => JSON.parse(t(...a) || 'null');
const LIFIC = () => [CFG.lific.bin, ['--json', '--backend', 'http', '--url', CFG.lific.url]];
const comment = (key, text) => t('comment', 'add', key, `--content=${text}`);
// A label edit is read-modify-write inside the CLI and loses to any concurrent write on the issue (a comment is enough): once more.
const relabel = (key, flag, label) => { const go = () => t('issue', 'update', key, `--${flag}-label=${label}`); return try_(go) ?? go(); };
const gh = (...a) => run('gh', a), ghj = (...a) => JSON.parse(gh(...a) || 'null');
const try_ = (f) => { try { return f(); } catch { return null; } };

// ---- pure logic (tested in baton.test.mjs) ----
// list() takes a property value or raw Haiku output: comma/newline separated, quotes/backticks/bullets/trailing
// punctuation stripped, prose (anything with a space) dropped.
export const list = (s) => (s ?? '').split(/[,\n]/).map((x) => x.replace(/[`'"*]/g, '').trim().replace(/^- /, '').replace(/[.;:]+$/, ''))
  .filter((x) => x && !/\s/.test(x));
export const overlaps = (a, b) => !a?.length || !b?.length || a.some((x) => b.some((y) => x.startsWith(y) || y.startsWith(x)));
// A tracker issue in the scheduler's terms: text property `footprint` (null = not set yet: baton estimates it), native
// blockers, and Lific's `active` under the name the rest of this file uses. notified = the human was already pinged.
export const meta = (i, notified = []) => ({ ...i, labels: i.labels ?? [], blockedBy: i.blocked_by ?? [],
  footprint: i.properties?.footprint == null ? null : list(i.properties.footprint),
  status: i.status === 'active' ? 'in_progress' : i.status, notified: notified.includes(i.identifier) });
// Human-label edge -> 'notify' (label appeared, not yet announced) | 'clear' (label gone, re-arm) | null.
export const notifyStep = (i) => (i.labels.includes(CFG.humanLabel) === i.notified ? null : i.notified ? 'clear' : 'notify');
// cfg.freshLabel on an issue = "its next run starts with a new session and a new worktree" (a plain rerun resumes
// both). 'rerun' now | 'wait' for the active run to end | 'on-assign' when the scheduler next starts it.
export const freshStep = (i, isAssigned, activeRuns) =>
  (!i.labels.includes(CFG.freshLabel) ? null : !isAssigned ? 'on-assign' : activeRuns ? 'wait' : 'rerun');
// New complete lines of an agent log from byte `pos` -> { pos: where the next read starts, out: what to show of them }.
// A line still being written (no newline yet) stays for the next read.
export function tail(buf, pos) {
  const end = buf.lastIndexOf('\n') + 1;
  return end <= pos ? { pos, out: [] } : { pos: end, out: buf.subarray(pos, end).toString('utf8').split('\n').flatMap(say).map(plain) };
}
// An in_progress issue with no hand-off yet: null = its agent is still running | 'park' it (waits on a blocker or a
// human) | 'start' the next run | 'stuck' = max runs in a row ended with nothing to show, so a human has to look.
export const runStep = (alive, why, n, max = CFG.maxRuns) => (alive ? null : why ? 'park' : n >= max ? 'stuck' : 'start');
// What an agent process gets: baton's environment, with every AGENT_X variable renamed to X (its own tracker key and
// GitHub token live in .env under that prefix, so baton itself never runs with them), plus `extra`.
export const agentEnv = (env, extra = {}) => ({ ...Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith('AGENT_'))),
  ...Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith('AGENT_')).map(([k, v]) => [k.slice(6), v])), ...extra });
// null = ready to start now; otherwise why not. statusOf(key) -> issue status.
export function whyNot(i, flight, statusOf, max = CFG.maxInFlight) {
  const open = i.blockedBy.filter((k) => statusOf(k) !== 'done');
  if (open.length) return `blocked by ${open}`;
  if (i.labels.includes(CFG.humanLabel)) return CFG.humanLabel;
  const clash = flight.find((f) => f.project_id === i.project_id && overlaps(f.footprint, i.footprint));
  if (clash) return `footprint overlaps ${clash.identifier}`;
  return flight.length >= max ? `in flight ${flight.length}` : null;
}
// Check runs (gh statusCheckRollup or the check-runs REST API) -> 'pending' | 'green' | 'red'.
// names: 'all', a list, or 'none' (repo without a CI gate, e.g. a vendored fork validated by its consumer's CI).
export function rollup(checks, names = 'all') {
  if (names === 'none') return 'green';
  const cs = checks.filter((c) => names === 'all' || names.includes(c.name));
  if (names !== 'all' && names.some((n) => !cs.some((c) => c.name === n))) return 'pending'; // not registered yet
  if (!cs.length || cs.some((c) => (c.status ?? 'completed').toLowerCase() !== 'completed')) return 'pending';
  return cs.every((c) => ['success', 'skipped', 'neutral'].includes((c.conclusion ?? c.state ?? '').toLowerCase())) ? 'green' : 'red';
}
// Branch <prefix><KEY>[-slug] -> KEY (e.g. change/OS-12-tileset-fixes -> OS-12); null if not ours.
export const keyOf = (ref, prefix) => (ref.startsWith(prefix) && /^[A-Z][A-Z0-9]*-\d+/.exec(ref.slice(prefix.length))?.[0]) || null;
// Open PRs on the branch prefix whose issue is in_review and that are not in the batch -> { ready, red } (pending omitted).
export function candidates(prs, byKey, batch, p) {
  const inBatch = new Set((batch?.prs ?? []).map((x) => x.number)), out = { ready: [], red: [] };
  for (const pr of [...prs].sort((a, b) => a.number - b.number)) {
    const key = keyOf(pr.headRefName, p.branchPrefix);
    if (!key || byKey[key]?.status !== 'in_review' || inBatch.has(pr.number)) continue;
    const s = rollup(pr.statusCheckRollup ?? [], p.prChecks ?? p.checks); // prChecks 'none': PRs aren't gated, only the batch is
    if (s !== 'pending') out[s === 'green' ? 'ready' : 'red'].push({ number: pr.number, key, head: pr.headRefOid });
  }
  out.ready = out.ready.slice(0, p.maxBatch);
  return out;
}
// Queue decision. base = current tip of the base branch; checks = the batch commit's check runs.
export function batchStep(batch, base, checks, ready, names = 'all') {
  if (!batch) return ready.length ? { act: 'form', prs: ready } : { act: 'idle' };
  if (base === batch.sha || batch.landed) return { act: 'land' }; // already fast-forwarded (restart mid-land, release wait): just finish
  if (base !== batch.base) return { act: 'rebuild' };
  const s = rollup(checks, names);
  if (s !== 'red') return { act: s === 'green' ? 'land' : 'wait' };
  return batch.prs.length > 1 ? { act: 'bisect', prs: batch.prs.slice(0, batch.prs.length >> 1) } : { act: 'sendback' };
}
// cfg project.release, e.g. 'build-{sha}': the GitHub release that must exist for the landed commit before its issues
// close (a consumer pins that commit and needs the build). null = no release gate.
export const releaseTag = (p, sha) => p.release?.replace('{sha}', sha) ?? null;
// A landed batch whose release has not shown up in time (once per batch; batch.landed = ms it landed).
export const releaseLate = (batch, now, min = 60) => !batch.late && now - batch.landed > min * 60e3;
// Agent instructions with {{projects}} replaced by what a shared, project-independent worker cannot guess per repo.
// p.key = the project's tracker prefix (issue keys are <key>-<n>).
export const brief = (text, ps) => text.replace('{{projects}}', ps.map((p) => `- ${p.key ? `${p.key} = ` : ''}${p.repo}: base branch \`${p.base}\`, ` +
  `PR branch \`${p.branchPrefix}<KEY>\`, check: ${p.check ? `\`${p.check}\`` : 'none configured'}`).join('\n'));

// The path list for the footprint prompt: every file while the repo is small, otherwise its directories cut to the
// deepest level that still fits the budget (so every top-level area stays visible rather than an alphabetical prefix).
export function repoMap(paths, budget = 40000) {
  const all = paths.join('\n');
  if (all.length <= budget) return all;
  for (let depth = 8; depth > 1; depth--) {
    const dirs = [...new Set(paths.map((f) => f.split('/').slice(0, -1).slice(0, depth).join('/') + '/'))].join('\n');
    if (dirs.length <= budget) return dirs;
  }
  return [...new Set(paths.map((f) => f.split('/')[0]))].join('\n');
}

// ---- runs: one detached agent process per issue; state/runs.json = { KEY: { pid, session, wt, n } } ----
const RUNS = `${DIR}/runs.json`;
const loadRuns = () => try_(() => JSON.parse(readFileSync(RUNS, 'utf8'))) ?? {};
const saveRuns = (runs) => writeFileSync(RUNS, JSON.stringify(runs));
const alive = (r) => !!r?.pid && try_(() => process.kill(r.pid, 0)) === true;

// The local checkout the issue worktrees hang off: the configured one (p.path), else baton's own clone.
function source(p) {
  if (p.path) return resolve(ROOT, p.path);
  const dir = `${DIR}/src/${p.repo.replace('/', '__')}`;
  if (!existsSync(dir)) run('git', ['clone', '-q', `https://github.com/${p.repo}.git`, dir]);
  return dir;
}
function worktree(p, key) { // detached at origin/<base>; the agent creates or checks out its own branch
  const src = source(p), wt = resolve(p.worktrees ? resolve(ROOT, p.worktrees) : `${src}.wt`, key), git = (...a) => run('git', ['-C', src, ...a]);
  if (existsSync(wt)) return wt;
  git('fetch', '-q', 'origin'); git('worktree', 'prune');
  git('worktree', 'add', '-q', '--detach', wt, `origin/${p.base}`);
  return wt;
}
function forget(p, key, runs) { // the issue's worktree and session are gone; pushed work stays on its branch
  const wt = runs[key]?.wt;
  if (wt) { try_(() => run('git', ['-C', source(p), 'worktree', 'remove', '--force', wt])); rmSync(wt, { recursive: true, force: true }); }
  delete runs[key]; saveRuns(runs);
}
function start(p, i, runs) {
  const r = runs[i.identifier] ??= { session: randomUUID(), n: 0 }, first = !r.wt;
  r.wt ??= worktree(p, i.identifier);
  const prompt = first ? `${brief(readFileSync(resolve(ROOT, p.instructions ?? 'agents/default.md'), 'utf8'), Object.values(CFG.projects))}\n\nYour issue: ${i.identifier}.`
    : `Continue issue ${i.identifier}: read its new comments and its labels first.`;
  mkdirSync(`${DIR}/logs`, { recursive: true });
  const logFile = `${DIR}/logs/${i.identifier}.log`, out = openSync(logFile, 'a'), [bin, ...args] = CFG.agent.cmd;
  r.pos ??= statSync(logFile).size; // an earlier life of this issue (before a fresh restart) is already forwarded
  const child = spawn(bin, [...args, first ? '--session-id' : '--resume', r.session, prompt], { cwd: r.wt, detached: true, stdio: ['ignore', out, out],
    env: agentEnv(process.env, { LIFIC_URL: CFG.lific.url, PATH: `${DIR}/bin:${process.env.PATH}` }) });
  child.on('error', (e) => log(null, 'run failed', i.identifier, e.message));
  child.unref(); r.pid = child.pid; r.n++;
  saveRuns(runs); // persist right away: a later throw in this tick must not orphan the process
  log(null, 'run', i.identifier, `#${r.n}`, first ? 'new session' : 'resumed', `pid ${r.pid}`, r.wt);
}
// The tracker's run log of an issue = the readable part of its agent log, forwarded once per tick.
function forward(runs) {
  for (const [key, r] of Object.entries(runs)) {
    const f = `${DIR}/logs/${key}.log`;
    if (!existsSync(f) || statSync(f).size <= (r.pos ?? 0)) continue;
    const { pos, out } = tail(readFileSync(f), r.pos ?? 0), [bin, args] = LIFIC();
    if (out.length && try_(() => execFileSync(bin, [...args, 'issue', 'log', 'add', key, `--source=run ${r.n}`], { input: out.join('\n'), stdio: ['pipe', 'pipe', 'pipe'] })) == null) continue;
    r.pos = pos; saveRuns(runs);
  }
}
function restartFresh(p, i, runs) {
  forget(p, i.identifier, runs);
  relabel(i.identifier, 'remove', CFG.freshLabel);
  i.labels = i.labels.filter((l) => l !== CFG.freshLabel);
  log(null, 'fresh', i.identifier, 'next run starts with a new session and worktree');
}

function estimateFootprint(p, i) { // bounded, fresh LLM call; persisted on the issue
  const files = repoMap(gh('api', `repos/${p.repo}/git/trees/${p.base}?recursive=1`, '-q', '.tree[].path').split('\n'));
  const prompt = `Repo paths:\n${files}\n\nTask:\n${i.title}\n${i.description ?? ''}\n\n${p.footprintHint ?? ''}\n` +
    'Reply with ONLY a comma-separated list of repo paths this task will create or edit.';
  const out = execFileSync('claude', ['-p', '--model', 'haiku', '--max-turns', '1'], { input: prompt, encoding: 'utf8' }).trim(); // stdin: argv has a size limit
  const fp = list(out);
  t('issue', 'update', i.identifier, `--set=footprint=${fp.join(', ')}`);
  log(null, 'footprint', i.identifier, fp.join(', '));
  return fp;
}

function sendBack(p, pr, i, why) {
  try_(() => gh('pr', 'comment', String(pr.number), '-R', p.repo, '--body', `bridge: ${why} — sent back to the agent`));
  comment(pr.key, `Bridge: PR #${pr.number} ${why}. Fix it on that PR's branch ` +
    `(git fetch && git rebase origin/${p.base}, resolve, re-test, force-push), then set in_review again.`);
  t('issue', 'update', pr.key, '--status=active'); // comment first: the status change is what starts the agent's next run
  if (i) i.status = 'in_progress';
  log(null, 'send-back', p.repo, `#${pr.number}`, pr.key, why);
}

function clone(p) {
  const dir = `${DIR}/refinery/${p.repo.replace('/', '__')}`, git = (...a) => run('git', ['-C', dir, ...a]);
  if (!existsSync(dir)) run('git', ['clone', '-q', '-c', 'user.name=bridge', '-c', 'user.email=bridge@localhost', `https://github.com/${p.repo}.git`, dir]);
  git('fetch', '-q', '--prune', 'origin', '+refs/heads/*:refs/remotes/origin/*');
  return git;
}
const stateFile = (p) => `${DIR}/batch-${p.repo.replace('/', '__')}.json`;
function loadBatch(p, git) {
  const b = try_(() => JSON.parse(readFileSync(stateFile(p), 'utf8')));
  if (b) return b;
  const tip = git('for-each-ref', '--format=%(refname:short)', `refs/remotes/origin/${p.batchPrefix}`).split('\n').filter(Boolean).sort().pop();
  if (!tip) return null;
  const branch = tip.slice('origin/'.length), prs = []; let base = null; // walk this batch's merges back to base
  for (const l of git('log', '--first-parent', '-n', '100', '--format=%P|%s', tip).split('\n')) {
    const mm = l.match(/^(\S+) (\S+)\|Merge PR #(\d+) \((\S+)\) into (\S+)$/);
    if (mm?.[5] !== branch) break;
    prs.unshift({ number: +mm[3], key: mm[4], head: mm[2] }); base = mm[1];
  }
  const batch = { branch, sha: git('rev-parse', tip), base, prs };
  writeFileSync(stateFile(p), JSON.stringify(batch));
  log(null, 'recovered batch', p.repo, batch.branch, `#${prs.map((x) => x.number).join(',#')}`);
  return batch;
}

function form(p, git, prs, byKey, base) {
  const branch = `${p.batchPrefix}${new Date().toISOString().replace(/\D/g, '').slice(0, 17)}`, inBatch = [];
  git('checkout', '-q', '--detach', base);
  for (const pr of prs) {
    try { git('merge', '--no-ff', '-q', '-m', `Merge PR #${pr.number} (${pr.key}) into ${branch}`, pr.head); inBatch.push(pr); }
    catch { try_(() => git('merge', '--abort')); sendBack(p, pr, byKey[pr.key], `conflicts with ${p.base}/batch`); }
  }
  if (!inBatch.length) return null;
  const batch = { branch, sha: git('rev-parse', 'HEAD'), base, prs: inBatch };
  git('push', '-q', 'origin', `${batch.sha}:refs/heads/${branch}`);
  writeFileSync(stateFile(p), JSON.stringify(batch));
  log(null, 'batch', p.repo, branch, `#${inBatch.map((x) => x.number).join(',#')}`, batch.sha.slice(0, 7));
  return batch;
}
const drop = (p, git, batch) => { try_(() => git('push', '-q', 'origin', '--delete', batch.branch)); rmSync(stateFile(p), { force: true }); };

function land(p, git, batch, base, byKey) {
  if (base !== batch.sha && !batch.landed) git('push', '-q', 'origin', `${batch.sha}:refs/heads/${p.base}`); // non-force: fast-forward or fail
  if (!batch.landed) writeFileSync(stateFile(p), JSON.stringify(batch = { ...batch, landed: Date.now() })); // base may move on while a release is awaited
  const tag = releaseTag(p, batch.sha);
  if (tag && try_(() => gh('release', 'view', tag, '-R', p.repo, '--json', 'isDraft', '-q', '.isDraft')) !== 'false') {
    if (releaseLate(batch, Date.now(), p.releaseTimeoutMin)) { // the build probably failed: tell the human once, keep waiting
      const why = `release ${tag} of ${p.repo} is still missing ${p.releaseTimeoutMin ?? 60} min after landing on ${p.base}`;
      for (const pr of batch.prs) comment(pr.key, `Bridge: ${why}. Re-run its build; this issue closes once the release exists.`);
      if (CFG.notify?.ntfy) try_(() => run('curl', ['-fsS', '-m', '10', '-H', `Title: ${p.repo} release missing`, '-d', why, CFG.notify.ntfy]));
      writeFileSync(stateFile(p), JSON.stringify({ ...batch, late: true }));
      log(null, 'release late', p.repo, tag);
    }
    return log(`rel${p.repo}`, 'landed, waiting for release', p.repo, tag);
  }
  for (const pr of batch.prs) {
    let state = null, ref = null; // GitHub marks the PR merged once its head is reachable from base (asynchronously)
    for (let n = 0; n < 10 && state !== 'MERGED'; n++, state === 'MERGED' || spawnSync('sleep', ['2'])) {
      ({ state, headRefName: ref } = ghj('pr', 'view', String(pr.number), '-R', p.repo, '--json', 'state,headRefName'));
    }
    if (state === 'OPEN') gh('pr', 'close', String(pr.number), '-R', p.repo, '--comment', `bridge: landed on ${p.base} in ${batch.sha}`);
    // cfg.afterLandLabel on an issue = its agent has post-landing steps: hand it back instead of closing; the agent sets done.
    const after = byKey[pr.key]?.labels.includes(CFG.afterLandLabel);
    if (after) comment(pr.key, `Bridge: PR #${pr.number} landed on ${p.base} in ${batch.sha}. ` +
      `Do your post-landing steps now, comment the result, then set this issue done.`);
    t('issue', 'update', pr.key, `--status=${after ? 'active' : 'done'}`);
    try_(() => git('push', '-q', 'origin', '--delete', ref));
    log(null, 'merged', p.repo, `#${pr.number}`, pr.key, `(${state})`, after ? '-> after-landing' : '-> done');
  }
  drop(p, git, batch);
  log(null, 'landed', p.repo, batch.branch, batch.sha.slice(0, 7));
}

// One queue step per repo per tick. Skips GitHub entirely while nothing is in review and no batch is in flight.
function refinery(p, byKey, projectId) {
  const reviewing = Object.values(byKey).some((i) => i.project_id === projectId && i.status === 'in_review');
  if (!reviewing && !existsSync(stateFile(p))) return;
  const git = clone(p), base = git('rev-parse', `origin/${p.base}`);
  const batch = loadBatch(p, git);
  const prs = ghj('pr', 'list', '-R', p.repo, '--state', 'open', '--json', 'number,headRefName,headRefOid,statusCheckRollup');
  const c = candidates(prs, byKey, batch, p);
  for (const pr of c.red) sendBack(p, pr, byKey[pr.key], 'has red CI');
  const checks = batch && base === batch.base ? ghj('api', `repos/${p.repo}/commits/${batch.sha}/check-runs`).check_runs : [];
  const step = batchStep(batch, base, checks, c.ready, p.checks);
  if (step.act === 'wait') log(`q${p.repo}`, 'batch pending', p.repo, batch.branch);
  if (step.act === 'form') form(p, git, step.prs, byKey, base);
  if (step.act === 'land') land(p, git, batch, base, byKey);
  if (step.act === 'rebuild') { log(null, 'rebuild', p.repo, batch.branch, `${p.base} moved`); drop(p, git, batch); }
  if (step.act === 'sendback') { drop(p, git, batch); sendBack(p, batch.prs[0], byKey[batch.prs[0].key], `fails CI together with ${p.base}`); }
  if (step.act === 'bisect') {
    log(null, 'bisect', p.repo, batch.branch, 'red; testing', `#${step.prs.map((x) => x.number).join(',#')}`);
    const next = form(p, git, step.prs, byKey, base); // new batch first, then delete the old one: a crash never loses both
    try_(() => git('push', '-q', 'origin', '--delete', batch.branch));
    if (!next) rmSync(stateFile(p), { force: true });
  }
}

function tick() {
  const runs = loadRuns(), NOTIFIED = `${DIR}/notified.json`, notified = try_(() => JSON.parse(readFileSync(NOTIFIED, 'utf8'))) ?? [];
  const projects = Object.fromEntries(tj('project', 'list').filter((p) => CFG.projects[p.name])
    .map((p) => [p.id, Object.assign(CFG.projects[p.name], { key: p.identifier })]));
  // Every open status but backlog (= not ready yet: the human moves it to todo).
  const issues = Object.values(projects).flatMap((p) => ['todo', 'active', 'in_review'].flatMap((s) => tj('issue', 'list', '-p', p.key, '--status', s, '--limit', '100')))
    .map((i) => meta(tj('issue', 'get', i.identifier), notified)).sort((a, b) => a.project_id - b.project_id || a.sequence - b.sequence);
  const byKey = Object.fromEntries(issues.map((i) => [i.identifier, i]));
  const statusOf = (k) => (byKey[k] ??= meta(tj('issue', 'get', k))).status;
  forward(runs);
  for (const [id, p] of Object.entries(projects)) {
    try { refinery(p, byKey, +id); } catch (e) { log(`rq${p.repo}`, 'refinery error', p.repo, e.message.split('\n')[0]); }
  }

  // A closed issue gives its worktree and session back (after-landing issues close only when their agent says so).
  for (const key of Object.keys(runs)) {
    const i = try_(() => (statusOf(key), byKey[key]));
    if (i && CLOSED.includes(i.status) && !alive(runs[key])) { forget(projects[i.project_id], key, runs); log(null, 'cleanup', key); }
  }

  // Tell the human once per needs-human episode (state/notified.json, so restarts don't re-ping).
  for (const i of issues.filter(() => CFG.notify?.ntfy)) {
    const step = notifyStep(i);
    if (step === 'notify') {
      try_(() => run('curl', ['-fsS', '-m', '10', '-H', `Title: ${i.identifier} needs you`, '-d', i.title, CFG.notify.ntfy]));
      notified.push(i.identifier); log(null, 'notify', i.identifier);
    } else if (step === 'clear') notified.splice(notified.indexOf(i.identifier), 1);
    if (step) writeFileSync(NOTIFIED, JSON.stringify(notified));
  }

  const flying = (i) => ['in_progress', 'in_review'].includes(i.status);
  for (const i of issues.filter((x) => flying(x) && x.labels.includes(CFG.freshLabel))) {
    const step = freshStep(i, true, alive(runs[i.identifier]) ? 1 : 0);
    if (step === 'rerun') restartFresh(projects[i.project_id], i, runs); else log(`f${i.identifier}`, 'fresh', i.identifier, 'waits for the active run to end');
  }

  // In progress = the agent owes a hand-off: keep it running until it sets in_review, parks on a blocker or a
  // human, or closes the issue. A handed-off or parked issue starts the count of fruitless runs afresh.
  for (const i of issues.filter((x) => x.status === 'in_review' && runs[x.identifier]?.n)) { runs[i.identifier].n = 0; saveRuns(runs); }
  for (const i of issues.filter((x) => x.status === 'in_progress')) {
    const r = runs[i.identifier], why = whyNot(i, [], statusOf), step = runStep(alive(r), why, r?.n ?? 0);
    if (step === 'park') {
      t('issue', 'update', i.identifier, '--status=todo', '--unassign'); i.status = 'todo';
      if (r) { r.n = 0; saveRuns(runs); }
      log(null, 'park', i.identifier, why);
    } else if (step === 'stuck') {
      comment(i.identifier, `Bridge: ${r.n} agent runs in a row ended without a hand-off, a blocker or a question. Log: ${DIR}/logs/${i.identifier}.log`);
      relabel(i.identifier, 'add', CFG.humanLabel); i.labels.push(CFG.humanLabel);
      log(null, 'stuck', i.identifier, `after ${r.n} runs`);
    } else if (step === 'start') start(projects[i.project_id], i, runs);
  }

  // Start when ready (oldest first).
  const flight = issues.filter(flying);
  for (const i of issues.filter((x) => x.status === 'todo')) {
    const p = projects[i.project_id];
    if (i.labels.includes(CFG.humanLabel)) continue; // human-owned (spec approval, QA): no footprint call, no run
    i.footprint ??= estimateFootprint(p, i);
    const why = whyNot(i, flight, statusOf);
    if (why) { log(i.identifier, 'wait', i.identifier, why); continue; }
    if (freshStep(i, false, 0) === 'on-assign') restartFresh(p, i, runs);
    t('issue', 'update', i.identifier, '--status=active', `--assignee=${CFG.agent.user}`); i.status = 'in_progress';
    log(i.identifier, 'assign', i.identifier, p.repo, `footprint=${i.footprint.join(',')}`);
    start(p, i, runs);
    flight.push(i);
  }
}

// Agents call the tracker as plain `lific …`: a wrapper on their PATH pins the HTTP backend (URL and key come from the env).
function agentBin() {
  mkdirSync(`${DIR}/bin`, { recursive: true });
  writeFileSync(`${DIR}/bin/lific`, `#!/bin/sh\nexec "${CFG.lific.bin}" --backend http "$@"\n`); chmodSync(`${DIR}/bin/lific`, 0o755);
}
const loop = async () => {
  for (; ; await new Promise((r) => setTimeout(r, CFG.tickSec * 1000))) {
    try { tick(); } catch (e) { log('err', 'tick error', e.message.split('\n')[0]); }
  }
};
if (process.argv[1] === fileURLToPath(import.meta.url)) mkdirSync(DIR, { recursive: true }), agentBin(), process.argv.includes('--once') ? tick() : loop();
