#!/usr/bin/env node
// Scheduler between Multica and the repos its agents work in; everything project-specific is in config.json ($BATON_CONFIG).
// Humans file issues UNASSIGNED. When no agent run is active, the orchestrator (one model call) looks at the waiting
// issues and picks the next wave: which start now and which agent takes each. Hard gates it cannot override: backlog,
// `blocked-by`, cfg.humanLabel, overlapping `footprint`. How a change reaches the base branch and who sets done is
// the repo's and the agent's business, not the bridge's.
// ponytail: prefix-match footprints, a 100-issue page, orchestrator runs on the claude CLI only; add globbing/paging/other runtimes if they hurt.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Relative paths in the config (multica.bin, stateDir) resolve against the baton checkout.
const ROOT = dirname(fileURLToPath(import.meta.url));
const CFG_FILE = process.env.BATON_CONFIG ?? resolve(ROOT, 'config.json');
const CFG = existsSync(CFG_FILE) ? JSON.parse(readFileSync(CFG_FILE, 'utf8')) : {}; // tests import pure fns without an instance
CFG.projects ??= {}; CFG.humanLabel ??= 'needs-human'; CFG.freshLabel ??= 'fresh'; CFG.maxWave ??= 5; CFG.tickSec ??= 5;
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
const gh = (...a) => run('gh', a);
const try_ = (f) => { try { return f(); } catch { return null; } };

// ---- pure logic (tested in baton.test.mjs) ----
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
// null = may start now; otherwise why not. flight = issues already held by agents or picked for this wave. statusOf(key) -> issue status.
export function whyNot(i, flight, statusOf) {
  const open = i.blockedBy.filter((k) => statusOf(k) !== 'done');
  if (open.length) return `blocked by ${open}`;
  if (i.labels.includes(CFG.humanLabel)) return CFG.humanLabel;
  const clash = flight.find((f) => f.project_id === i.project_id && overlaps(f.footprint, i.footprint));
  return clash ? `footprint overlaps ${clash.identifier}` : null;
}
// What the orchestrator decided on; it is asked again only when this changes (so an empty wave is not re-asked every tick).
export const snapshot = (issues) => JSON.stringify(issues.map((i) => [i.identifier, i.status, i.assignee_id, i.labels, i.blockedBy, i.footprint, i.title, i.description]));
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

function restartFresh(i) { // fresh session + workdir; the agent rebuilds state from the repo and the issue
  m('issue', 'rerun', i.identifier);
  const id = mj('label', 'list').find((l) => l.name === CFG.freshLabel)?.id;
  if (id) m('issue', 'label', 'remove', i.identifier, id);
  i.labels = i.labels.filter((l) => l !== CFG.freshLabel);
  log(null, 'fresh', i.identifier, 'rerun with a clean session');
}

// In flight = held by any agent, not only the project's: the first agent may hand the issue on (`multica issue assign`),
// and it must keep its footprint and flight slot. A human assignee is never the bridge's business.
export const assigned = (i) => i.assignee_type === 'agent';
// Manual board order (what the human dragged higher goes first); issue number breaks ties.
export const byBoard = (a, b) => a.position - b.position || a.number - b.number;

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

// One model call, no tools: the model and extra guidance come from the Multica agent cfg.orchestrator (edit them in the UI).
function orchestrate(projects, issues, waiting, agents) {
  const o = mj('agent', 'get', CFG.orchestrator), repo = (i) => projects[i.project_id].repo;
  const rules = [...new Set(waiting.map((i) => projects[i.project_id]))].map((p) => `## ${p.repo}\n` +
    (try_(() => gh('api', `repos/${p.repo}/contents/AGENTS.md?ref=${p.base}`, '-H', 'Accept: application/vnd.github.raw'))?.slice(0, 8000) ?? '(no AGENTS.md)'));
  const line = (i) => `- ${i.identifier} [${repo(i)}] ${i.status}${i.assignee_id ? ', held by an agent' : ''}${i.blockedBy.length ? `, blocked-by ${i.blockedBy}` : ''}: ${i.title}`;
  const prompt = 'You are the orchestrator of a team of coding agents. Nothing is running right now. Decide which of the WAITING ' +
    'tasks start now, in parallel, and which agent takes each. Start a task only if it makes sense now: leave out one that ' +
    'logically follows another waiting or unfinished task, or would collide with one you start. Starting nothing is a valid answer.\n\n' +
    `# Agents\n${agents.map((a) => `- ${a.name}: ${a.description || '(no description)'}`).join('\n')}\n\n` +
    `# Project rules\n${rules.join('\n\n')}\n\n` +
    `# WAITING (the human's order: top = do first)\n${waiting.map((i) => `## ${i.identifier} [${repo(i)}] ${i.title}\nstatus: ${i.status === 'todo' ? 'todo (not started)' : `${i.status} (started earlier, parked)`}; labels: ${i.labels.join(', ') || '-'}; ` +
      `footprint: ${i.footprint.join(', ') || '-'}\n${i.description ?? ''}`).join('\n\n')}\n\n` +
    `# Other open tasks\n${issues.filter((i) => !CLOSED.includes(i.status) && !waiting.includes(i)).map(line).join('\n') || '-'}\n\n` +
    `# Recently closed\n${issues.filter((i) => CLOSED.includes(i.status)).sort((a, b) => a.updated_at.localeCompare(b.updated_at)).slice(-15).map(line).join('\n') || '-'}\n\n` +
    (o.instructions ? `# Maintainer's guidance\n${o.instructions}\n\n` : '') +
    'Reply with ONLY one line per task to start: `<KEY> <agent name>`. No other text.';
  return execFileSync('claude', ['-p', '--model', o.model || 'sonnet', '--max-turns', '1'], { input: prompt, encoding: 'utf8' });
}

let lastWave = null;
function tick() {
  const projects = Object.fromEntries(mj('project', 'list').filter((p) => CFG.projects[p.title]).map((p) => [p.id, CFG.projects[p.title]]));
  const P = Object.fromEntries(mj('property', 'list').map((p) => [p.name, p.id]));
  const issues = mj('issue', 'list', '--limit', '100').issues.filter((i) => projects[i.project_id])
    .map((i) => meta(i, P)).sort(byBoard);
  const byKey = Object.fromEntries(issues.map((i) => [i.identifier, i]));
  const statusOf = (k) => (byKey[k] ??= mj('issue', 'get', k)).status;
  // Tell the human once per needs-human episode (state = the `notified` property, so restarts don't re-ping).
  for (const i of issues.filter((x) => !CLOSED.includes(x.status) && CFG.notify?.ntfy && P.notified)) {
    const step = notifyStep(i);
    if (step === 'notify') {
      try_(() => run('curl', ['-fsS', '-m', '10', '-H', `Title: ${i.identifier} needs you`, '-d', i.title, CFG.notify.ntfy]));
      m('issue', 'property', 'set', i.identifier, '--name', 'notified', '--value', '1');
      log(null, 'notify', i.identifier);
    } else if (step === 'clear') m('issue', 'property', 'unset', i.identifier, '--name', 'notified');
  }

  for (const i of issues.filter((x) => !CLOSED.includes(x.status) && assigned(x) && x.labels.includes(CFG.freshLabel))) {
    const step = freshStep(i, true, mj('issue', 'runs', i.identifier, '--active').length);
    if (step === 'rerun') restartFresh(i); else log(`f${i.identifier}`, 'fresh', i.identifier, 'waits for the active run to end');
  }

  // Park: an assigned issue that waits on a blocker or a human leaves the flight once its run has ended.
  for (const i of issues.filter((x) => assigned(x) && !CLOSED.includes(x.status))) {
    const why = whyNot(i, [], statusOf);
    if (!why || mj('issue', 'runs', i.identifier, '--active').length) continue;
    m('issue', 'assign', i.identifier, '--unassign');
    i.assignee_id = i.assignee_type = null;
    log(null, 'park', i.identifier, why);
  }

  // Wave: once nothing runs, the orchestrator picks from the startable issues, in board order. cfg.maxWave caps only the
  // not yet started ones (todo); an unassigned issue in any other status was parked mid-work and is always offered.
  const held = issues.filter((i) => assigned(i) && !CLOSED.includes(i.status));
  // backlog = not ready yet (the human moves it to todo); in_review = waits for a review, not for an agent.
  const free = issues.filter((x) => !x.assignee_id && !CLOSED.includes(x.status) && !['in_review', 'backlog'].includes(x.status) && !whyNot(x, [], statusOf));
  const waiting = [...free.filter((x) => x.status !== 'todo'), ...free.filter((x) => x.status === 'todo').slice(0, CFG.maxWave)];
  if (!waiting.length) return;
  for (const i of waiting) i.footprint ??= estimateFootprint(projects[i.project_id], i);
  if (snapshot(issues) === lastWave || held.some((i) => mj('issue', 'runs', i.identifier, '--active').length)) return;
  const all = mj('agent', 'list'), agents = (all.agents ?? all).filter((a) => !a.archived_at && a.id !== CFG.orchestrator);
  const wave = picks(orchestrate(projects, issues, waiting, agents), waiting.map((i) => i.identifier), agents.map((a) => a.name));
  for (const { key, agent } of wave) {
    const i = byKey[key], id = agents.find((a) => a.name === agent).id, why = whyNot(i, held, statusOf);
    if (why) { log(null, 'wait', key, why); continue; }
    if (i.status === 'blocked') m('issue', 'status', key, 'todo', '--no-start');
    if (freshStep(i, false, 0) === 'on-assign') { m('issue', 'assign', key, '--to-id', id, '--no-start'); restartFresh(i); }
    else m('issue', 'assign', key, '--to-id', id);
    i.assignee_type = 'agent'; i.assignee_id = id; held.push(i);
    log(null, 'assign', key, projects[i.project_id].repo, '->', agent, `footprint=${i.footprint.join(',')}`);
  }
  log(null, 'wave', wave.length ? wave.map((w) => w.key).join(',') : 'nothing to start', `of ${waiting.map((i) => i.identifier)}`);
  lastWave = snapshot(issues);
}

const loop = async () => {
  for (;; await new Promise((r) => setTimeout(r, CFG.tickSec * 1000))) {
    try { tick(); } catch (e) { log('err', 'tick error', e.message.split('\n')[0]); }
  }
};
if (process.argv[1] === fileURLToPath(import.meta.url)) mkdirSync(DIR, { recursive: true }), process.argv.includes('--once') ? tick() : loop();
