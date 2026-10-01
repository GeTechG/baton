#!/usr/bin/env node
// Scheduler + batch merge queue between Multica and GitHub; everything project-specific is in config.json ($BATON_CONFIG).
// Scheduling is stateless: humans file issues UNASSIGNED, only the bridge assigns the agent; text properties `blocked-by`
// and `footprint` gate readiness; cfg.humanLabel parks; status in_review = agent handed off a PR on <branchPrefix><KEY>.
// Queue (Bors-style): green PRs merge --no-ff into batch/<ts> on base; base fast-forwards only to a batch whose exact tree
// passed CI; red -> bisect. Batch cached in batch-<repo>.json, recoverable from the remote branch's merge subjects.
// ponytail: prefix-match footprints, a 100-issue page, serial bisect; add globbing/paging/parallel bisect if they hurt.
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Relative paths in the config (multica.bin, stateDir, instructions) resolve against the baton checkout.
const ROOT = dirname(fileURLToPath(import.meta.url));
const CFG_FILE = process.env.BATON_CONFIG ?? resolve(ROOT, 'config.json');
const CFG = existsSync(CFG_FILE) ? JSON.parse(readFileSync(CFG_FILE, 'utf8')) : {}; // tests import pure fns without an instance
CFG.projects ??= {}; CFG.humanLabel ??= 'needs-human'; CFG.freshLabel ??= 'fresh'; CFG.afterLandLabel ??= 'after-landing'; CFG.maxInFlight ??= 4; CFG.tickSec ??= 5;
const DIR = resolve(ROOT, CFG.stateDir ?? 'state'), CLOSED = ['done', 'cancelled'];
if (CFG.multica) CFG.multica.bin = resolve(ROOT, CFG.multica.bin);

const seen = new Map(); // log de-dup only: repeat decisions are logged once
const log = (key, ...a) => {
  const msg = a.join(' ');
  if (key && seen.get(key) === msg) return; else if (key) seen.set(key, msg);
  const line = `${new Date().toISOString().slice(11, 19)} ${msg}`;
  console.log(line); appendFileSync(`${DIR}/bridge.log`, line + '\n');
};
const run = (bin, args) => execFileSync(bin, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const m = (...a) => run(CFG.multica.bin, ['--profile', CFG.multica.profile, '--server-url', CFG.multica.server, ...a]);
const mj = (...a) => JSON.parse(m(...a, '--output', 'json') || 'null');
const gh = (...a) => run('gh', a), ghj = (...a) => JSON.parse(gh(...a) || 'null');
const try_ = (f) => { try { return f(); } catch { return null; } };

// ---- pure logic (tested in bridge.test.mjs) ----
// list() takes a property value or raw Haiku output: comma/newline separated, quotes/backticks/bullets/trailing
// punctuation stripped, prose (anything with a space) dropped.
export const list = (s) => (s ?? '').split(/[,\n]/).map((x) => x.replace(/[`'"*]/g, '').trim().replace(/^- /, '').replace(/[.;:]+$/, ''))
  .filter((x) => x && !/\s/.test(x));
export const overlaps = (a, b) => !a?.length || !b?.length || a.some((x) => b.some((y) => x.startsWith(y) || y.startsWith(x)));
export const meta = (i, P) => ({ ...i, labels: (i.labels ?? []).map((l) => l.name),
  footprint: i.properties?.[P.footprint] == null ? null : list(i.properties[P.footprint]), blockedBy: list(i.properties?.[P['blocked-by']]), notified: !!i.properties?.[P.notified] });
// Human-label edge -> 'notify' (label appeared, not yet announced) | 'clear' (label gone, re-arm) | null.
export const notifyStep = (i) => (i.labels.includes(CFG.humanLabel) === i.notified ? null : i.notified ? 'clear' : 'notify');
// cfg.freshLabel on an issue = "its next run starts with a clean session and working directory" (the UI's Retry
// always resumes). 'rerun' now | 'wait' for the active run to end | 'on-assign' when the scheduler next assigns it.
export const freshStep = (i, isAssigned, activeRuns) =>
  (!i.labels.includes(CFG.freshLabel) ? null : !isAssigned ? 'on-assign' : activeRuns ? 'wait' : 'rerun');
// null = ready to assign now; otherwise why not. statusOf(key) -> issue status.
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
  if (base === batch.sha) return { act: 'land' }; // already fast-forwarded (restart mid-land): just finish
  if (base !== batch.base) return { act: 'rebuild' };
  const s = rollup(checks, names);
  if (s !== 'red') return { act: s === 'green' ? 'land' : 'wait' };
  return batch.prs.length > 1 ? { act: 'bisect', prs: batch.prs.slice(0, batch.prs.length >> 1) } : { act: 'sendback' };
}

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

function restartFresh(i) { // fresh session + workdir; the agent rebuilds state from the branch, PR and issue
  m('issue', 'rerun', i.identifier);
  const id = mj('label', 'list').find((l) => l.name === CFG.freshLabel)?.id;
  if (id) m('issue', 'label', 'remove', i.identifier, id);
  i.labels = i.labels.filter((l) => l !== CFG.freshLabel);
  log(null, 'fresh', i.identifier, 'rerun with a clean session');
}

const assigned = (i, p) => i.assignee_type === 'agent' && i.assignee_id === p?.agent;

function estimateFootprint(p, i) { // bounded, fresh LLM call; persisted on the issue
  const files = repoMap(gh('api', `repos/${p.repo}/git/trees/${p.base}?recursive=1`, '-q', '.tree[].path').split('\n'));
  const prompt = `Repo paths:\n${files}\n\nTask:\n${i.title}\n${i.description ?? ''}\n\n${p.footprintHint ?? ''}\n` +
    'Reply with ONLY a comma-separated list of repo paths this task will create or edit.';
  const out = execFileSync('claude', ['-p', '--model', 'haiku', '--max-turns', '1'], { input: prompt, encoding: 'utf8' }).trim(); // stdin: argv has a size limit
  const fp = list(out);
  m('issue', 'property', 'set', i.identifier, '--name', 'footprint', '--value', fp.join(', '));
  log(null, 'footprint', i.identifier, fp.join(', '));
  return fp;
}

function sendBack(p, pr, i, why) {
  try_(() => gh('pr', 'comment', String(pr.number), '-R', p.repo, '--body', `bridge: ${why} — sent back to the agent`));
  m('issue', 'status', pr.key, 'in_progress', '--no-start');
  m('issue', 'comment', 'add', pr.key, '--content', `Bridge: PR #${pr.number} ${why}. Fix it on that PR's branch ` +
    `(git fetch && git rebase origin/${p.base}, resolve, re-test, force-push), then set in_review again.`);
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
  if (base !== batch.sha) git('push', '-q', 'origin', `${batch.sha}:refs/heads/${p.base}`); // non-force: fast-forward or fail
  for (const pr of batch.prs) {
    let state = null, ref = null; // GitHub marks the PR merged once its head is reachable from base (asynchronously)
    for (let n = 0; n < 10 && state !== 'MERGED'; n++, state === 'MERGED' || spawnSync('sleep', ['2'])) {
      ({ state, headRefName: ref } = ghj('pr', 'view', String(pr.number), '-R', p.repo, '--json', 'state,headRefName'));
    }
    if (state === 'OPEN') gh('pr', 'close', String(pr.number), '-R', p.repo, '--comment', `bridge: landed on ${p.base} in ${batch.sha}`);
    // cfg.afterLandLabel on an issue = its agent has post-landing steps: hand it back instead of closing; the agent sets done.
    const after = byKey[pr.key]?.labels.includes(CFG.afterLandLabel);
    m('issue', 'status', pr.key, after ? 'in_progress' : 'done', '--no-start');
    if (after) m('issue', 'comment', 'add', pr.key, '--content', `Bridge: PR #${pr.number} landed on ${p.base} in ${batch.sha}. ` +
      `Do your post-landing steps now, comment the result, then set this issue done.`);
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
  const projects = Object.fromEntries(mj('project', 'list').filter((p) => CFG.projects[p.title]).map((p) => [p.id, CFG.projects[p.title]]));
  const P = Object.fromEntries(mj('property', 'list').map((p) => [p.name, p.id]));
  const issues = mj('issue', 'list', '--limit', '100').issues.filter((i) => projects[i.project_id])
    .map((i) => meta(i, P)).sort((a, b) => a.number - b.number);
  const byKey = Object.fromEntries(issues.map((i) => [i.identifier, i]));
  const statusOf = (k) => (byKey[k] ??= mj('issue', 'get', k)).status;
  for (const [id, p] of Object.entries(projects)) {
    try { refinery(p, byKey, id); } catch (e) { log(`rq${p.repo}`, 'refinery error', p.repo, e.message.split('\n')[0]); }
  }

  // Tell the human once per needs-human episode (state = the `notified` property, so restarts don't re-ping).
  for (const i of issues.filter((x) => !CLOSED.includes(x.status) && CFG.notify?.ntfy && P.notified)) {
    const step = notifyStep(i);
    if (step === 'notify') {
      try_(() => run('curl', ['-fsS', '-m', '10', '-H', `Title: ${i.identifier} needs you`, '-d', i.title, CFG.notify.ntfy]));
      m('issue', 'property', 'set', i.identifier, '--name', 'notified', '--value', '1');
      log(null, 'notify', i.identifier);
    } else if (step === 'clear') m('issue', 'property', 'unset', i.identifier, '--name', 'notified');
  }

  for (const i of issues.filter((x) => !CLOSED.includes(x.status) && assigned(x, projects[x.project_id]) && x.labels.includes(CFG.freshLabel))) {
    const step = freshStep(i, true, mj('issue', 'runs', i.identifier, '--active').length);
    if (step === 'rerun') restartFresh(i); else log(`f${i.identifier}`, 'fresh', i.identifier, 'waits for the active run to end');
  }

  // Park: an assigned issue that waits on a blocker or a human leaves the flight once its run has ended.
  for (const i of issues.filter((x) => assigned(x, projects[x.project_id]) && !CLOSED.includes(x.status))) {
    const why = whyNot(i, [], statusOf);
    if (!why || mj('issue', 'runs', i.identifier, '--active').length) continue;
    m('issue', 'assign', i.identifier, '--unassign');
    i.assignee_id = i.assignee_type = null;
    log(null, 'park', i.identifier, why);
  }

  // Assign when ready (oldest first).
  const flight = issues.filter((i) => assigned(i, projects[i.project_id]) && !CLOSED.includes(i.status));
  for (const i of issues.filter((x) => !x.assignee_id && !CLOSED.includes(x.status) && x.status !== 'in_review')) {
    const p = projects[i.project_id];
    if (i.labels.includes(CFG.humanLabel)) continue; // human-owned (spec approval, QA): no footprint call, no assign
    i.footprint ??= estimateFootprint(p, i);
    const why = whyNot(i, flight, statusOf);
    if (why) { log(i.identifier, 'wait', i.identifier, why); continue; }
    if (i.status === 'blocked') m('issue', 'status', i.identifier, 'todo', '--no-start');
    if (freshStep(i, false, 0) === 'on-assign') { m('issue', 'assign', i.identifier, '--to-id', p.agent, '--no-start'); restartFresh(i); }
    else m('issue', 'assign', i.identifier, '--to-id', p.agent);
    flight.push(i);
    log(i.identifier, 'assign', i.identifier, p.repo, `footprint=${i.footprint.join(',')}`);
  }
}

// On start, push each project's instruction file to its agent (one agent may serve several projects).
function syncAgents() {
  const byAgent = Object.fromEntries(Object.values(CFG.projects).map((p) => [p.agent, p.instructions]));
  for (const [id, f] of Object.entries(byAgent)) m('agent', 'update', id, '--instructions', readFileSync(resolve(ROOT, f), 'utf8'));
}
const loop = async () => {
  for (syncAgents(); ; await new Promise((r) => setTimeout(r, CFG.tickSec * 1000))) {
    try { tick(); } catch (e) { log('err', 'tick error', e.message.split('\n')[0]); }
  }
};
if (process.argv[1] === fileURLToPath(import.meta.url)) mkdirSync(DIR, { recursive: true }), process.argv.includes('--once') ? tick() : loop();
