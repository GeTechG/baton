#!/usr/bin/env node
// Scheduler and agent runner between Lific (the tracker) and the repos its agents work in; everything project-specific
// is in config.json ($BATON_CONFIG). Humans file issues as `todo`. When no agent run is active, the orchestrator (one
// model call) looks at the waiting issues and picks the next wave: which start now and which agent (agents/*.json)
// takes each. baton alone moves an issue to `active`, gives it a git worktree off the project's local checkout and runs
// the agent there (one worktree per issue, one session per agent on it, kept until the issue closes; the issue is
// assigned to cfg.agent.user, its `agent` property names who holds it and its run log shows what the agent does).
// Hard gates the orchestrator cannot override: backlog, native "blocked by" links, cfg.humanLabel, overlapping
// `footprint`. How a change reaches the base branch and who sets done is the repo's and the agent's business.
// ponytail: prefix-match footprints, 100 open issues per project and status, one `issue get` per open issue per tick,
// a run is "alive" while its pid exists (a reboot can recycle it), agents and the orchestrator run on the claude CLI only.
// cfg.herdr: every issue that runs also gets a Herdr tab showing its live log (`node watch.mjs <KEY>`).
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { plain, say } from './watch.mjs';

// Relative paths in the config (lific.bin, stateDir, agents, path, worktrees) resolve against the baton checkout.
const ROOT = dirname(fileURLToPath(import.meta.url));
const CFG_FILE = process.env.BATON_CONFIG ?? resolve(ROOT, 'config.json');
const CFG = existsSync(CFG_FILE) ? JSON.parse(readFileSync(CFG_FILE, 'utf8')) : {}; // tests import pure fns without an instance
CFG.projects ??= {}; CFG.humanLabel ??= 'needs-human'; CFG.freshLabel ??= 'fresh'; CFG.maxWave ??= 5; CFG.maxRuns ??= 3; CFG.tickSec ??= 5;
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
const gh = (...a) => run('gh', a);
const H = (...a) => JSON.parse(run('herdr', a) || '{}').result; // cfg.herdr; some commands (pane run) print nothing
const try_ = (f) => { try { return f(); } catch { return null; } };

// ---- pure logic (tested in baton.test.mjs) ----
// list() takes a property value or raw Haiku output: comma/newline separated, quotes/backticks/bullets/trailing
// punctuation stripped, prose (anything with a space) dropped.
export const list = (s) => (s ?? '').split(/[,\n]/).map((x) => x.replace(/[`'"*]/g, '').trim().replace(/^- /, '').replace(/[.;:]+$/, ''))
  .filter((x) => x && !/\s/.test(x));
export const overlaps = (a, b) => !a?.length || !b?.length || a.some((x) => b.some((y) => x.startsWith(y) || y.startsWith(x)));
// A tracker issue in the scheduler's terms: text property `footprint` (null = not set yet: baton estimates it), text
// property `agent` (who holds it; an agent hands the issue on by naming another), native blockers, and Lific's `active`
// under the name the rest of this file uses. notified = the human was already pinged.
export const meta = (i, notified = []) => ({ ...i, labels: i.labels ?? [], blockedBy: i.blocked_by ?? [],
  footprint: i.properties?.footprint == null ? null : list(i.properties.footprint), agent: i.properties?.agent?.trim() || null,
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
// An in_progress issue: null = its agent is still running | 'park' it (waits on a blocker or a human) | 'start' the
// next run | 'stuck' = max runs of one agent in a row ended with nothing to show, so a human has to look.
export const runStep = (alive, why, n, max = CFG.maxRuns) => (alive ? null : why ? 'park' : n >= max ? 'stuck' : 'start');
// What an agent process gets: baton's environment, with every AGENT_X variable renamed to X (its own tracker key and
// GitHub token live in .env under that prefix, so baton itself never runs with them), plus `extra`.
export const agentEnv = (env, extra = {}) => ({ ...Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith('AGENT_'))),
  ...Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith('AGENT_')).map(([k, v]) => [k.slice(6), v])), ...extra });
// Who runs the issue next: the agent its `agent` property names, else the one that ran it last, else the base worker
// (an issue a human set `active` by hand).
export const holder = (i, r, dflt = 'worker') => i.agent ?? r?.agent ?? dflt;
// null = may start now; otherwise why not. flight = issues already held by agents or picked for this wave. statusOf(key) -> issue status.
export function whyNot(i, flight, statusOf) {
  const open = i.blockedBy.filter((k) => statusOf(k) !== 'done');
  if (open.length) return `blocked by ${open}`;
  if (i.labels.includes(CFG.humanLabel)) return CFG.humanLabel;
  const clash = flight.find((f) => f.project_id === i.project_id && overlaps(f.footprint, i.footprint));
  return clash ? `footprint overlaps ${clash.identifier}` : null;
}
// What the orchestrator decided on; it is asked again only when this changes (so an empty wave is not re-asked every tick).
export const snapshot = (issues) => JSON.stringify(issues.map((i) => [i.identifier, i.status, i.agent, i.labels, i.blockedBy, i.footprint, i.title, i.description, i.said]));
// What people wrote on a waiting issue, for the orchestrator (a decision is often given in a comment, not in the
// description): the last `n` comments not by the agents' tracker user, oldest first, one capped line each.
export const said = (comments, bot = CFG.agent.user, n = 5) => comments.filter((c) => c.author !== bot)
  .sort((a, b) => a.created_at.localeCompare(b.created_at)).slice(-n).map((c) => `${c.author}: ${c.content.replace(/\s+/g, ' ').trim().slice(0, 600)}`);
// The agents (agents/*.json, then cfg.agents: a later file with the same name wins) -> the orchestrator, named
// cfg.orchestrator (default "orchestrator") and never given an issue, and the rest.
export function team(all, who = 'orchestrator') {
  const o = all.find((a) => a.name === who);
  return { o, agents: all.filter((a) => a !== o) };
}
// Orchestrator reply, one `KEY agent-name` per line -> [{ key, agent }]; unknown keys/agents, repeats and prose are dropped.
export function picks(out, keys, agents) {
  const res = [];
  for (const l of out.split('\n')) {
    const mm = /([A-Z][A-Z0-9]*-\d+)\W+(.+)/.exec(l), name = mm?.[2].replace(/[`*"'.]/g, '').trim().toLowerCase();
    const agent = agents.find((a) => a.toLowerCase() === name);
    if (agent && keys.includes(mm[1]) && !res.some((r) => r.key === mm[1])) res.push({ key: mm[1], agent });
  }
  return res;
}
// Why a wave came out empty, for the log: the orchestrator's reply on one line, capped.
export const reason = (out) => out.replace(/\s+/g, ' ').trim().slice(0, 300) || 'empty reply';
// Manual board order (what the human dragged higher goes first); issue number breaks ties.
export const byBoard = (a, b) => a.sort_order - b.sort_order || a.sequence - b.sequence;

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
// The first prompt of an agent on an issue: its own instructions (project-independent), the issue, and what only this
// project's repo needs (p.instructions).
export const firstPrompt = (a, p, i) => `${a.instructions}\n\nYour issue: ${i.identifier}. Repo ${p.repo}, base branch \`${p.base}\`.` +
  (p.instructions ? `\n\nProject guidance:\n${p.instructions}` : '');
// p.setup: a shell command that prepares a new issue worktree (toolchain, LSP config, submodules) before the agent's
// session and its MCP servers start in it. null = done or nothing to do; otherwise the tail of what it printed.
// ponytail: it runs inside the tick with no timeout, so a slow setup delays every other issue; make it async if that hurts.
export function setup(p, key, wt, src) {
  if (!p.setup) return null;
  try {
    execFileSync('sh', ['-c', `exec 2>&1\n${p.setup}`], { cwd: wt, env: { ...process.env, BATON_SOURCE: src, BATON_ISSUE: key }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: Infinity });
    return null;
  } catch (e) { return (e.stdout?.trim() || e.message).slice(-1500); }
}

// ---- runs: one detached agent process per issue; state/runs.json = { KEY: { pid, agent, session, wt, n, total, pos } } ----
const RUNS = `${DIR}/runs.json`;
const loadRuns = () => try_(() => JSON.parse(readFileSync(RUNS, 'utf8'))) ?? {};
const saveRuns = (runs) => writeFileSync(RUNS, JSON.stringify(runs));
const alive = (r) => !!r?.pid && try_(() => process.kill(r.pid, 0)) === true;
function loadAgents() {
  const dirs = [resolve(ROOT, 'agents'), resolve(ROOT, CFG.agents ?? 'local/agents')].filter(existsSync);
  const all = dirs.flatMap((d) => readdirSync(d).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(`${d}/${f}`, 'utf8'))));
  return [...new Map(all.map((a) => [a.name, a])).values()];
}

// The local checkout the issue worktrees hang off: the configured one (p.path), else baton's own clone.
function source(p) {
  if (p.path) return resolve(ROOT, p.path);
  const dir = `${DIR}/src/${p.repo.replace('/', '__')}`;
  if (!existsSync(dir)) run('git', ['clone', '-q', `https://github.com/${p.repo}.git`, dir]);
  return dir;
}
// null = p.setup failed: no worktree is left (the next attempt makes and prepares a new one) and the issue waits for a human.
function worktree(p, key) { // detached at origin/<base>; the agent creates or checks out its own branch
  const src = source(p), wt = resolve(p.worktrees ? resolve(ROOT, p.worktrees) : `${src}.wt`, key), git = (...a) => run('git', ['-C', src, ...a]);
  if (existsSync(wt)) return wt;
  git('fetch', '-q', 'origin'); git('worktree', 'prune');
  git('worktree', 'add', '-q', '--detach', wt, `origin/${p.base}`);
  const err = setup(p, key, wt, src);
  if (err == null) return wt;
  try_(() => git('worktree', 'remove', '--force', wt)); rmSync(wt, { recursive: true, force: true });
  comment(key, `Bridge: the project's \`setup\` command failed in the new worktree, so no agent was started. Its last output:\n\n\`\`\`\n${err}\n\`\`\``);
  relabel(key, 'add', CFG.humanLabel);
  log(null, 'setup failed', key, err.split('\n').pop());
  return null;
}
function forget(p, key, runs) { // the issue's worktree and session are gone; pushed work stays on its branch
  const wt = runs[key]?.wt;
  if (runs[key]?.watch) try_(() => H('tab', 'close', runs[key].watch));
  if (wt) { try_(() => run('git', ['-C', source(p), 'worktree', 'remove', '--force', wt])); rmSync(wt, { recursive: true, force: true }); }
  delete runs[key]; saveRuns(runs);
}
// The Claude Code transcript of the run's session, if that session ever started (a run that died before it has nothing to resume).
function sessionFile(r, root = `${process.env.CLAUDE_CONFIG_DIR ?? `${homedir()}/.claude`}/projects`) {
  return try_(() => readdirSync(root).map((d) => `${root}/${d}/${r.session}.jsonl`).find(existsSync));
}
// cfg.herdr: the issue's tab (label = its key) in the workspace labelled cfg.herdr.workspace of the default Herdr session,
// running the live view of its log. Made on the issue's first run, made again if it was closed, closed with the issue.
function watchTab(key, r) {
  if (r.watch && try_(() => H('tab', 'get', r.watch))) return;
  const label = CFG.herdr.workspace ?? 'baton-agents';
  const ws = (H('workspace', 'list').workspaces.find((w) => w.label === label) ?? H('workspace', 'create', '--label', label, '--no-focus').workspace).workspace_id;
  const made = H('tab', 'create', '--workspace', ws, '--cwd', ROOT, '--label', key, '--no-focus');
  r.watch = made.tab.tab_id;
  H('pane', 'run', made.root_pane.pane_id, `BATON_CONFIG='${CFG_FILE}' node watch.mjs ${key}`);
}
function start(p, i, runs, a) {
  // Another agent on the issue = a new session in the same worktree; so is a session that never started.
  const r = runs[i.identifier] ??= { n: 0 }, handed = r.agent !== a.name, first = handed || !sessionFile(r);
  if (handed) Object.assign(r, { agent: a.name, n: 0 });
  if (first) r.session = randomUUID();
  if (!(r.wt ??= worktree(p, i.identifier))) { delete runs[i.identifier]; i.labels.push(CFG.humanLabel); return; } // parked on the next tick
  const prompt = first ? firstPrompt(a, p, i)
    : `Continue issue ${i.identifier}: read its new comments and its labels first.`;
  mkdirSync(`${DIR}/logs`, { recursive: true });
  const logFile = `${DIR}/logs/${i.identifier}.log`, out = openSync(logFile, 'a'), [bin, ...args] = CFG.agent.cmd;
  r.pos ??= statSync(logFile).size; // an earlier life of this issue (before a fresh restart) is already forwarded
  const child = spawn(bin, [...args, ...(a.model ? ['--model', a.model] : []), first ? '--session-id' : '--resume', r.session, prompt], { cwd: r.wt, detached: true, stdio: ['ignore', out, out],
    env: agentEnv(process.env, { LIFIC_URL: CFG.lific.url, PATH: `${DIR}/bin:${process.env.PATH}` }) });
  child.on('error', (e) => log(null, 'run failed', i.identifier, e.message));
  if (CFG.herdr) try { watchTab(i.identifier, r); } catch (e) { log('herdr', 'herdr tab failed', e.message.split('\n')[0]); }
  child.unref(); r.pid = child.pid; r.n++; r.total = (r.total ?? 0) + 1; // n restarts at every hand-off, review or park; total names the run
  saveRuns(runs); // persist right away: a later throw in this tick must not orphan the process
  log(null, 'run', i.identifier, `#${r.total}`, a.name, first ? 'new session' : 'resumed', `pid ${r.pid}`, r.wt);
}
// The tracker's run log of an issue = the readable part of its agent log, forwarded once per tick.
function forward(runs) {
  for (const [key, r] of Object.entries(runs)) {
    const f = `${DIR}/logs/${key}.log`;
    if (!existsSync(f) || statSync(f).size <= (r.pos ?? 0)) continue;
    const { pos, out } = tail(readFileSync(f), r.pos ?? 0), [bin, args] = LIFIC();
    if (out.length && try_(() => execFileSync(bin, [...args, 'issue', 'log', 'add', key, `--source=run ${r.total}`], { input: out.join('\n'), stdio: ['pipe', 'pipe', 'pipe'] })) == null) continue;
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

// One model call, no tools: the model and extra guidance come from the orchestrator agent `o` (agents/orchestrator.json).
function orchestrate(projects, issues, waiting, agents, o, runs) {
  const repo = (i) => projects[i.project_id].repo;
  const rules = [...new Set(waiting.map((i) => projects[i.project_id]))].map((p) => `## ${p.repo}\n` +
    (try_(() => gh('api', `repos/${p.repo}/contents/AGENTS.md?ref=${p.base}`, '-H', 'Accept: application/vnd.github.raw'))?.slice(0, 8000) ?? '(no AGENTS.md)'));
  const line = (i) => `- ${i.identifier} [${repo(i)}] ${i.status}${i.agent && !CLOSED.includes(i.status) ? `, held by ${i.agent}` : ''}${i.blockedBy?.length ? `, blocked-by ${i.blockedBy}` : ''}: ${i.title}`;
  const closed = Object.values(projects).flatMap((p) => tj('issue', 'list', '-p', p.key, '--status', 'done', '--limit', '100'))
    .sort((a, b) => a.updated_at.localeCompare(b.updated_at)).slice(-15);
  const prompt = 'You are the orchestrator of a team of coding agents. Nothing is running right now. Decide which of the WAITING ' +
    'tasks start now, in parallel, and which agent takes each. Start a task only if it makes sense now: leave out one that ' +
    'logically follows another waiting or unfinished task, or would collide with one you start. Starting nothing is a valid answer.\n\n' +
    `# Agents\n${agents.map((a) => `- ${a.name}: ${a.description || '(no description)'}`).join('\n')}\n\n` +
    `# Project rules\n${rules.join('\n\n')}\n\n` +
    `# WAITING (the human's order: top = do first)\n${waiting.map((i) => `## ${i.identifier} [${repo(i)}] ${i.title}\nstatus: ${runs[i.identifier] ? `started earlier by ${runs[i.identifier].agent}, parked` : 'todo (not started)'}; labels: ${i.labels.join(', ') || '-'}; ` +
      `footprint: ${i.footprint.join(', ') || '-'}\n${i.description ?? ''}` +
      (i.said?.length ? `\nComments from people since (latest last; they may settle what the description leaves open):\n${i.said.map((c) => `- ${c}`).join('\n')}` : '')).join('\n\n')}\n\n` +
    `# Other open tasks\n${issues.filter((i) => !waiting.includes(i)).map(line).join('\n') || '-'}\n\n` +
    `# Recently closed\n${closed.map(line).join('\n') || '-'}\n\n` +
    (o.instructions ? `# Maintainer's guidance\n${o.instructions}\n\n` : '') +
    'Reply with ONLY one line per task to start: `<KEY> <agent name>`. No other text. If you start nothing, reply with one line saying why.';
  return execFileSync('claude', ['-p', '--model', o.model || 'sonnet', '--max-turns', '1'], { input: prompt, encoding: 'utf8' });
}

let lastWave = null;
function tick() {
  const runs = loadRuns(), { o, agents } = team(loadAgents(), CFG.orchestrator), NOTIFIED = `${DIR}/notified.json`, notified = try_(() => JSON.parse(readFileSync(NOTIFIED, 'utf8'))) ?? [];
  const projects = Object.fromEntries(tj('project', 'list').filter((p) => CFG.projects[p.name])
    .map((p) => [p.id, Object.assign(CFG.projects[p.name], { key: p.identifier })]));
  // Every open status but backlog (= not ready yet: the human moves it to todo).
  const issues = Object.values(projects).flatMap((p) => ['todo', 'active', 'in_review'].flatMap((s) => tj('issue', 'list', '-p', p.key, '--status', s, '--limit', '100')))
    .map((i) => meta(tj('issue', 'get', i.identifier), notified)).sort(byBoard);
  const byKey = Object.fromEntries(issues.map((i) => [i.identifier, i]));
  const statusOf = (k) => (byKey[k] ??= meta(tj('issue', 'get', k))).status;
  forward(runs);

  // A closed issue gives its worktree and session back.
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

  // In progress = an agent holds the issue: keep it running until it closes the issue, sets in_review (waits for a
  // review, not for an agent) or parks on a blocker or a human. Naming another agent in `agent` hands the issue on:
  // the next run is that agent's. A reviewed, handed-on or parked issue starts the count of fruitless runs afresh.
  for (const i of issues.filter((x) => x.status === 'in_review' && runs[x.identifier]?.n)) { runs[i.identifier].n = 0; saveRuns(runs); }
  for (const i of issues.filter((x) => x.status === 'in_progress')) {
    const r = runs[i.identifier], name = holder(i, r), a = agents.find((x) => x.name === name);
    const why = whyNot(i, [], statusOf) ?? (a ? null : `no agent "${name}"`), step = runStep(alive(r), why, r?.agent === name ? r.n : 0);
    if (step === 'park') {
      if (!a) { comment(i.identifier, `Bridge: this issue names the agent "${name}", which does not exist. Agents: ${agents.map((x) => x.name).join(', ')}.`); relabel(i.identifier, 'add', CFG.humanLabel); }
      t('issue', 'update', i.identifier, '--status=todo', '--unassign'); i.status = 'todo';
      if (r) { r.n = 0; saveRuns(runs); }
      log(null, 'park', i.identifier, why);
    } else if (step === 'stuck') {
      comment(i.identifier, `Bridge: ${r.n} runs of ${name} in a row ended without closing the issue, a hand-off, a blocker or a question. Log: ${DIR}/logs/${i.identifier}.log`);
      relabel(i.identifier, 'add', CFG.humanLabel); i.labels.push(CFG.humanLabel);
      log(null, 'stuck', i.identifier, `after ${r.n} runs`);
    } else if (step === 'start') start(projects[i.project_id], i, runs, a);
  }

  // Wave: once nothing runs, the orchestrator picks from the startable issues, in board order. cfg.maxWave caps only the
  // not yet started ones; a todo issue that has a run was parked mid-work and is always offered. A needs-human issue
  // is human-owned (spec approval, QA): no footprint call, never offered.
  const held = issues.filter(flying);
  const free = issues.filter((x) => x.status === 'todo' && !whyNot(x, [], statusOf));
  const waiting = [...free.filter((x) => runs[x.identifier]), ...free.filter((x) => !runs[x.identifier]).slice(0, CFG.maxWave)];
  if (!waiting.length) return;
  for (const i of waiting) { i.footprint ??= estimateFootprint(projects[i.project_id], i); i.said = said(tj('comment', 'list', i.identifier)); }
  if (snapshot(issues) === lastWave || issues.some((x) => x.status === 'in_progress')) return;
  if (!o) throw new Error(`no orchestrator agent "${CFG.orchestrator ?? 'orchestrator'}" in agents/`);
  const out = orchestrate(projects, issues, waiting, agents, o, runs), wave = picks(out, waiting.map((i) => i.identifier), agents.map((a) => a.name));
  for (const { key, agent } of wave) {
    const i = byKey[key], p = projects[i.project_id], why = whyNot(i, held, statusOf);
    if (why) { log(null, 'wait', key, why); continue; }
    if (freshStep(i, false, 0) === 'on-assign') restartFresh(p, i, runs);
    t('issue', 'update', key, '--status=active', `--assignee=${CFG.agent.user}`, `--set=agent=${agent}`); i.status = 'in_progress'; i.agent = agent;
    log(null, 'assign', key, p.repo, '->', agent, `footprint=${i.footprint.join(',')}`);
    start(p, i, runs, agents.find((a) => a.name === agent));
    held.push(i);
  }
  log(null, 'wave', wave.length ? wave.map((w) => w.key).join(',') : `nothing to start (${reason(out)})`, `of ${waiting.map((i) => i.identifier)}`);
  lastWave = snapshot(issues);
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
