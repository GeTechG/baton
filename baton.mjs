#!/usr/bin/env node
// Scheduler and agent runner between Lific (the tracker) and the repos its agents work in; everything project-specific
// is in config.json ($BATON_CONFIG). Humans file issues as `todo`. While fewer than cfg.maxWave issues are in work, the
// orchestrator (one model call) looks at the waiting issues and fills the free slots: which start now and which agent
// (agents/*.json) takes each; an issue it leaves out is not offered again until something changes, and it may fix the
// board (a blocker link, needs-human). baton alone moves an issue to `active`, gives it a git worktree off the project's local checkout and runs
// the agent there (one worktree per issue, one session per agent on it, kept until the issue closes; its `agent`
// property names who holds it and its run log shows what the agent does).
// Hard gates the orchestrator cannot override: backlog, native "blocked by" links, cfg.humanLabel, an assignment to a
// person, overlapping `footprint`. How a change reaches the base branch and who sets done is the repo's and the agent's business,
// unless the project has a land queue (cfg.projects.*.land): then baton merges, gates and pushes the branches agents hand over.
// ponytail: prefix-match footprints (minus a project's sharedPaths), 100 open issues per project and status, one
// `issue get` per open issue per tick, a run is "alive" while its pid exists (a reboot can recycle it), a worktree's
// processes are found in /proc (Linux only),
// one `comment list` per running and per refused issue per tick, a comment reaches a running agent only after its current tool call,
// agents and the orchestrator run on the claude CLI only.
// cfg.herdr: every issue that runs also gets a Herdr tab showing its live log (`node watch.mjs <KEY>`).
// cfg.projects.*.land: the merge queue; agents hand over finished branches, baton merges the ready ones in a batch, gates the
// batch once and pushes it, or bisects it and sends the branch that turns it red back to its agent.
// cfg.projects.*.milestone: once a project's queue is empty, the gate of its merged tree runs; a red stage is bisected and filed as todo.
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { plain, say } from './watch.mjs';

// Relative paths in the config (lific.bin, stateDir, agents, path, worktrees) resolve against the baton checkout.
const ROOT = dirname(fileURLToPath(import.meta.url));
const CFG_FILE = process.env.BATON_CONFIG ?? resolve(ROOT, 'config.json');
const CFG = existsSync(CFG_FILE) ? JSON.parse(readFileSync(CFG_FILE, 'utf8')) : {}; // tests import pure fns without an instance
CFG.projects ??= {}; CFG.humanLabel ??= 'needs-human'; CFG.freshLabel ??= 'fresh'; CFG.landLabel ??= 'land'; CFG.maxWave ??= 5; CFG.maxRuns ??= 3; CFG.tickSec ??= 5; CFG.waveRetrySec ??= [60, 300, 900];
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
// A project's `sharedPaths` (each issue writes its own piece there, a rebase merges them) do not count on either side; a
// footprint left with only them is empty, so it overlaps everything.
export const overlaps = (a, b, shared = []) => {
  const dir = (s) => s.replace(/\/+$/, ''), own = (fp) => (fp ?? []).filter((x) => !shared.some((s) => dir(x) === dir(s) || x.startsWith(`${dir(s)}/`)));
  [a, b] = [own(a), own(b)];
  return !a.length || !b.length || a.some((x) => b.some((y) => x.startsWith(y) || y.startsWith(x)));
};
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
// The part of an agent log one run wrote -> when the account's usage limit it ran into resets (ms), or null if it did
// not run into one. Claude Code ends such a run with a result `usage_limit_reached`, after a rejected rate_limit_event
// that carries the reset (s); without that event, 15 minutes.
export function limitedUntil(text, now) {
  const es = text.split('\n').map((l) => try_(() => JSON.parse(l))).filter(Boolean);
  if (!es.some((e) => e.type === 'result' && e.api_error === 'usage_limit_reached')) return null;
  const at = es.filter((e) => e.type === 'rate_limit_event' && e.rate_limit_info?.status === 'rejected').map((e) => e.rate_limit_info.resetsAt * 1000);
  return at.length ? Math.max(...at) : now + 15 * 60_000;
}
// What an agent process gets: baton's environment, with every AGENT_X variable renamed to X (its own tracker key and
// GitHub token live in .env under that prefix, so baton itself never runs with them), plus `extra`.
export const agentEnv = (env, extra = {}) => ({ ...Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith('AGENT_'))),
  ...Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith('AGENT_')).map(([k, v]) => [k.slice(6), v])), ...extra });
// The agent's PATH: baton's `lific` wrapper, then the worktree's own npm tools (what `npm run` would add), then baton's.
export const agentPath = (bin, wt, path) => `${bin}:${wt}/node_modules/.bin:${path}`;
// Who runs the issue next: the agent its `agent` property names, else the one that ran it last, else the base worker
// (an issue a human set `active` by hand).
export const holder = (i, r, dflt = 'worker') => i.agent ?? r?.agent ?? dflt;
// The config's projects that baton's own tracker identity does not see (listed = `project list` names). Lific hides such
// a project, and drops its issues from every `blocked_by` too, so a blocker there does not hold anything.
export const unseen = (cfgProjects, listed) => Object.keys(cfgProjects).filter((n) => !listed.includes(n));
// null = may start now; otherwise why not. flight = issues already held by agents or picked for this wave. statusOf(key) -> issue status.
export function whyNot(i, flight, statusOf, shared = []) {
  const open = i.blockedBy.filter((k) => statusOf(k) !== 'done');
  if (open.length) return `blocked by ${open}`;
  if (i.labels.includes(CFG.humanLabel)) return CFG.humanLabel;
  // Lific's assignment: an issue nobody is assigned is the agents'; "any person" or named people keep it for humans.
  if (i.needs_human || i.assignees?.length) return `for ${i.assignees?.length ? i.assignees.map((a) => `@${a.username}`) : 'a person'}`;
  const clash = flight.find((f) => f.project_id === i.project_id && overlaps(f.footprint, i.footprint, shared));
  return clash ? `footprint overlaps ${clash.identifier}` : null;
}
// The open issues as the last wave left them. A change of this (a slot came free, a new board order, an edited
// issue) ends every refusal.
export const snapshot = (issues) => JSON.stringify(issues.map((i) => [i.identifier, i.status, i.agent, i.labels, i.blockedBy, i.sort_order, i.footprint, i.title, i.description]));
// Refused = offered to a wave and not started, kept as key -> people's comments then. A refused issue is not offered
// again, so the next wave is asked about the ones behind it (one refused issue overlapping the rest held the whole
// queue). The refusal lasts while the issues stand as they were (same) and nobody comments on it (saidOf(key)).
export const refuse = (refused, waiting, started) => ({ ...refused,
  ...Object.fromEntries(waiting.filter((i) => !started.includes(i.identifier)).map((i) => [i.identifier, JSON.stringify(i.said ?? [])])) });
export const stillRefused = (refused, same, saidOf) => same ? Object.fromEntries(Object.entries(refused).filter(([k, s]) => saidOf(k) === s)) : {};
// Everything startable refused and nothing changed: ask from the top again? Only while nothing runs (one wrong
// "nothing" must not hold the queue until a human touches an issue): once per pause, `sec` after the `empties`-th such
// round in a row. Past the last pause the answers stand until something changes.
export const again = (empties, sec, pauses = CFG.waveRetrySec) => empties > 0 && sec >= pauses[empties - 1];
// The orchestrator's fixes for the offered issues it leaves out (lines picks() does not take): `<KEY> after <OTHER>: why`
// = OTHER, an open issue that does not itself wait on KEY, becomes KEY's blocker; `<KEY> human: why` = for a person.
export function fixes(out, keys, open) {
  const by = Object.fromEntries(open.map((i) => [i.identifier, [...i.blockedBy]])), res = [];
  const waits = (k, on, seen = new Set()) => k === on || (!seen.has(k) && (seen.add(k), (by[k] ?? []).some((b) => waits(b, on, seen))));
  for (const l of out.split('\n')) {
    const m = /^\W*([A-Z][A-Z0-9]*-\d+)\s+(?:after\s+([A-Z][A-Z0-9]*-\d+)|human)\b\W*(.*)$/i.exec(l.replace(/[`*]/g, ''));
    if (!m || !keys.includes(m[1]) || res.some((r) => r.key === m[1])) continue;
    const why = m[3].trim().slice(0, 300) || 'no reason given';
    if (!m[2]) res.push({ key: m[1], why });
    else if (by[m[2]] && !waits(m[2], m[1])) by[m[1]]?.push(m[2]), res.push({ key: m[1], after: m[2], why });
  }
  return res;
}
// What the orchestrator is offered, from the todo issues free of blockers and humans (board order): those that pass
// ok(i, taken) (no footprint overlap with an issue in work nor with `taken`), every parked one (has a run; checked
// against work only) and the first `max` not yet started, taken greedily: one that overlaps an issue already in the
// window is skipped, so the window does not fill with issues of which only one can start. Parked first. ok is called
// only on what is still in reach of the window: it may estimate a footprint.
export function offer(todo, ok, parked, max = CFG.maxWave) {
  let n = 0;
  const res = [];
  for (const i of todo) if ((parked(i) ? ok(i, []) : n < max && ok(i, res) && ++n)) res.push(i);
  return [...res.filter(parked), ...res.filter((i) => !parked(i))];
}
// Free slots: cfg.maxWave issues may be in work (in_progress) at once.
export const slots = (issues, max = CFG.maxWave) => max - issues.filter((i) => i.status === 'in_progress').length;
// One WAITING issue as the orchestrator sees it (r = its run, if it was started before). Its blockers come with their
// status: a description that still says "waits for X" must not outweigh the tracker.
export const offered = (i, repo, r, statusOf) => `## ${i.identifier} [${repo}] ${i.title}\nstatus: ${r ? `started earlier by ${r.agent}, parked` : 'todo (not started)'}; ` +
  `labels: ${i.labels.join(', ') || '-'}; footprint: ${i.footprint.join(', ') || '-'}; blockers: ${i.blockedBy.map((k) => `${k} (${statusOf(k)})`).join(', ') || 'none'}\n${i.description ?? ''}` +
  (i.said?.length ? `\nComments from people since (latest last; they may settle what the description leaves open):\n${i.said.map((c) => `- ${c}`).join('\n')}` : '');
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
// A run's own comments: the agents share one tracker user, so the author does not tell them apart. baton's `lific` wrapper
// appends the run's mark ($BATON_RUN) to every comment it adds, an HTML comment rendered markdown does not show.
export const runMark = (key, n) => `<!-- baton ${key} run ${n} -->`;
// `lific` arguments with `mark` appended to the content of a `comment add` (--content X, --content=X, -c X, -cX); any other command as it is.
export function marked(args, mark) {
  const at = args.findIndex((a, k) => a === 'comment' && args[k + 1] === 'add'), add = (a) => `${a}\n\n${mark}`;
  if (!mark || at < 0) return args;
  return args.map((a, k) => (k < at + 2 ? a : ['--content', '-c'].includes(args[k - 1]) || /^(--content=|-c.)/.test(a) ? add(a) : a));
}
// The agents' `lific` (a CommonJS script for `node`, saved as .cjs: state/ is under baton's "type": "module"): the tracker CLI on the HTTP backend (URL and key come from the env), comments marked.
export const lificWrapper = (node, bin) => `#!${node}
${marked}
const r = require('child_process').spawnSync(${JSON.stringify(bin)}, ['--backend', 'http', ...marked(process.argv.slice(2), process.env.BATON_RUN)], { stdio: 'inherit' });
if (r.error) console.error(r.error.message);
process.exitCode = r.status ?? 1;
`;
// What a running agent hears (r.heard = the newest comment id it has seen or was told of): the comments on its issue newer
// than `since`, oldest first -> { since, said }. Its own comments (the agents' user, its run's mark) only move `since`;
// one by the agent of another issue is heard like a person's.
export function news(comments, since, mark, bot = CFG.agent.user) {
  const fresh = comments.filter((c) => c.id > since).sort((a, b) => a.id - b.id);
  return { since: Math.max(since, ...fresh.map((c) => c.id)), said: fresh.filter((c) => !(c.author === bot && c.content.includes(mark))).map((c) => `${c.author}: ${c.content}`) };
}
// The runs' Claude Code hook (PostToolUse, Stop), a script for `node`: the inbox $BATON_INBOX, if any, goes to the model
// (exit 2 puts stderr in front of it; on Stop it also keeps the turn going) and is gone. A sub-agent's tool call (agent_id
// in the hook input) leaves it to the main agent, which holds the issue.
export const inboxHook = (node) => `#!${node}
const fs = require('fs'), f = process.env.BATON_INBOX, read = f + '.read';
let s = ''; process.stdin.on('data', (d) => (s += d)).on('end', () => {
  try { if (!f || JSON.parse(s || '{}').agent_id) return; fs.renameSync(f, read); } catch { return; }
  process.stderr.write(fs.readFileSync(read, 'utf8')); fs.rmSync(read); process.exitCode = 2;
});
`;
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

// p.milestone: the gate of the merged tree, run by baton once the project's queue is empty. Due when nothing runs and
// nothing of the project waits, the base has moved past the last green commit, this commit was not tried yet and every
// issue the last red milestone filed is closed (a fix has landed, so the next try is not the same red again).
export const milestoneDue = (idle, head, green, tried, open) => idle && !!head && head !== green && head !== tried && !open;
// The labels of the red stages in a milestone's output: capture group 1 of `re` (p.milestone.failed), each once.
export const redStages = (out, re) => (re ? [...new Set([...out.matchAll(new RegExp(re, 'gm'))].map((m) => m[1].trim()))] : []);
// The bisect's verdict: git bisect's own line `<sha> is the first bad commit`; key = the issue the commit's subject names.
export function culprit(out, subjectOf) {
  const sha = /\b([0-9a-f]{7,40}) is the first bad commit\b/.exec(out)?.[1], subject = sha && (subjectOf(sha) ?? '').trim();
  return sha ? { sha, subject, key: /\b[A-Z][A-Z0-9]*-\d+\b/.exec(subject)?.[0] ?? null } : null;
}
// What the output says about one stage: from the first line naming it to the next one (its header and result), capped.
export function excerpt(out, stage, max = 3000) {
  const lines = out.split('\n'), a = lines.findIndex((l) => l.includes(stage)), b = lines.findIndex((l, n) => n > a && l.includes(stage));
  return (a < 0 ? lines.slice(-40) : lines.slice(a, b < 0 ? a + 40 : b + 1)).join('\n').slice(-max);
}
// The todo issue for one red stage (stage = null: the milestone failed without naming one: a timeout, a setup error).
export function fixIssue(p, sha, stage, c, text, logs) {
  const m = p.milestone, at = `\`${m.cmd}\` failed on ${sha.slice(0, 10)} (origin/${p.base})`;
  if (!stage) return { title: `Milestone gate failed on ${sha.slice(0, 10)} without a red stage`, description: `${at} and named no red stage.\n\nIts last output:\n\n\`\`\`\n${text}\n\`\`\`\n\nLog: ${logs.join(', ')}` };
  return { title: `Milestone red: ${stage}${c ? ` since ${c.sha.slice(0, 10)}${c.key ? ` (${c.key})` : ''}` : ''}`,
    description: `${at}${m.tag ? `; \`${m.tag}\` stays where it is until a milestone is green` : ''}.\n\n- stage: ${stage}\n` +
      `- first bad commit: ${c ? `${c.sha} ${c.subject}` : 'not found by the bisect'}\n- issue of that commit: ${c?.key ?? '-'}\n\n` +
      `Stage output:\n\n\`\`\`\n${text}\n\`\`\`\n\nLogs: ${logs.join(', ')}` };
}

// p.land: the issues (of one project) ready to land, in board order: in review, labelled cfg.landLabel, not for a person,
// every blocker done (a blocker in the same queue lands first: what waits on it goes in the batch after); at most `max`.
export const landable = (issues, max = Infinity, statusOf = () => 'done') => issues.filter((i) => i.status === 'in_review' &&
  i.labels.includes(CFG.landLabel) && !i.labels.includes(CFG.humanLabel) && i.blockedBy.every((k) => statusOf(k) === 'done')).slice(0, max);
// Start a batch now? `ready` issues wait, the oldest for `waited` seconds. While another issue of the project is in work
// (`busy`), its branch may come within `hold` seconds and share the gate: wait, unless `max` are ready already.
export const landDue = (ready, waited, busy, hold = 0, max = 5) => ready > 0 && (!busy || ready >= max || waited >= hold);
// The bisect over a batch of n branches merged one after another: prefix k = the base plus the first k of them. g = the
// longest prefix known green (0 = the base itself), r = the shortest known red (n + 1 = none). After prefix k came out ok
// or not -> the next state; k = null once settled: prefix g lands, and branch r, if r <= n, is the one that turns it red.
// Every prefix is tried with the full gate, so the green one is the exact tree that lands.
export function probe(s, ok) {
  const g = ok ? s.k : s.g, r = ok ? s.r : s.k;
  return { ...s, g, r, k: r - g > 1 ? Math.floor((g + r) / 2) : null };
}
// The comment on an issue the land queue sends back to its agent.
export const bounced = (base, why, text = '') => `Bridge: not landed: ${why}. Fix it in this issue (the branch is still yours: ` +
  `merge or rebase onto \`origin/${base}\` if needed), push, then hand it over again: status \`in_review\` with the label \`${CFG.landLabel}\`.` +
  (text ? `\n\nThe gate's last output:\n\n\`\`\`\n${text}\n\`\`\`` : '');

// ---- runs: one detached agent process per issue; state/runs.json = { KEY: { pid, agent, session, wt, n, total, pos, heard } } ----
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
const wtDir = (p, src, name) => resolve(p.worktrees ? resolve(ROOT, p.worktrees) : `${src}.wt`, name);
// null = p.setup failed: no worktree is left (the next attempt makes and prepares a new one) and the issue waits for a human.
function worktree(p, key) { // detached at origin/<base>; the agent creates or checks out its own branch
  const src = source(p), wt = wtDir(p, src, key), git = (...a) => run('git', ['-C', src, ...a]);
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
// The processes still running in a worktree (cwd inside it, or a path into it on the command line): an agent's background
// commands and dev servers leave its process group, so they outlive it. SIGTERM, then SIGKILL after `graceMs`; returns the count.
export function reap(wt, graceMs = 3000) {
  const root = try_(() => realpathSync(wt)) ?? wt, inside = (x) => [root, wt].some((r) => x === r || x.includes(`${r}/`));
  const scan = () => readdirSync('/proc').filter((d) => /^\d+$/.test(d) && +d !== process.pid).map(Number).filter((pid) =>
    try_(() => inside(readlinkSync(`/proc/${pid}/cwd`))) || try_(() => readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').some(inside)));
  const kill = (sig) => scan().map((pid) => try_(() => process.kill(pid, sig)));
  const n = kill('SIGTERM').length, end = Date.now() + graceMs;
  while (n && scan().length && Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); // a zombie has no cwd: it drops out
  kill('SIGKILL');
  return n;
}
// The branch a worktree has checked out (`git symbolic-ref -q HEAD`), if it is the agent's own: never the base, never detached.
export const ownBranch = (ref, base) => { const b = ref?.trim().replace(/^refs\/heads\//, ''); return b && b !== ref?.trim() && b !== base ? b : null; };
// The issue's worktree, its processes and its session are gone; pushed work stays on its branch. Returns log words.
// The worktree's local branch goes with it once origin/<base> contains it (it lives in the shared checkout, so it would pile up).
function forget(p, key, runs) {
  const wt = runs[key]?.wt, killed = wt ? reap(wt) : 0, git = (...a) => run('git', ['-C', source(p), ...a]);
  if (runs[key]?.watch) try_(() => H('tab', 'close', runs[key].watch));
  if (wt) {
    const b = ownBranch(try_(() => run('git', ['-C', wt, 'symbolic-ref', '-q', 'HEAD'])), p.base);
    try_(() => git('worktree', 'remove', '--force', wt)); rmSync(wt, { recursive: true, force: true });
    if (b) try_(() => (git('fetch', '-q', 'origin', p.base), git('merge-base', '--is-ancestor', b, `origin/${p.base}`), git('branch', '-q', '-D', b)));
  }
  rmSync(inbox(key), { force: true }); delete runs[key]; saveRuns(runs);
  return killed ? ['killed', killed] : [];
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
  // A new run reads every comment on its own; the inbox is for what comes while it runs (listen()).
  const last = try_(() => tj('comment', 'list', i.identifier, '--limit', '1')); // null: this run hears nothing new
  r.heard = last && Math.max(0, ...last.map((c) => c.id)); rmSync(inbox(i.identifier), { force: true });
  const logFile = `${DIR}/logs/${i.identifier}.log`, out = openSync(logFile, 'a'), [bin, ...args] = CFG.agent.cmd;
  r.pos ??= statSync(logFile).size; // an earlier life of this issue (before a fresh restart) is already forwarded
  r.from = statSync(logFile).size; // where this run's part of the log starts (limitedUntil)
  const child = spawn(bin, [...args, ...(a.model ? ['--model', a.model] : []), first ? '--session-id' : '--resume', r.session, '--settings', HOOKS, prompt], { cwd: r.wt, detached: true, stdio: ['ignore', out, out],
    env: agentEnv(process.env, { LIFIC_URL: CFG.lific.url, PATH: agentPath(`${DIR}/bin`, r.wt, process.env.PATH), BATON_INBOX: inbox(i.identifier),
      BATON_ISSUE: i.identifier, BATON_RUN: runMark(i.identifier, (r.total ?? 0) + 1) }) });
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
// Comments people add while an agent runs go to its inbox (state/inbox/<KEY>); the run's hook (inboxHook) hands them to
// the model after its next tool call, or keeps it from ending its turn before it has read them.
const inbox = (key) => `${DIR}/inbox/${key}`;
function listen(runs) {
  for (const [key, r] of Object.entries(runs).filter(([, x]) => x.heard != null && alive(x))) {
    const cs = try_(() => tj('comment', 'list', key, '--limit', '50'));
    if (!cs) continue;
    const { since, said } = news(cs, r.heard, runMark(key, r.total));
    if (since === r.heard) continue;
    if (said.length) {
      mkdirSync(`${DIR}/inbox`, { recursive: true });
      appendFileSync(inbox(key), said.map((c) => `New comment on ${key} while you work; read it now, it may change your task.\n${c}\n\n`).join(''));
      log(null, 'tell', key, said.length, said.length > 1 ? 'comments' : 'comment');
    }
    r.heard = since; saveRuns(runs);
  }
}
function restartFresh(p, i, runs) {
  const killed = forget(p, i.identifier, runs);
  relabel(i.identifier, 'remove', CFG.freshLabel);
  i.labels = i.labels.filter((l) => l !== CFG.freshLabel);
  log(null, 'fresh', i.identifier, 'next run starts with a new session and worktree', ...killed);
}

// argv of a one-shot model call (footprint, orchestrator): no tools and no MCP servers, so the one turn is the answer.
// With tools the model may spend it on a look around and `claude -p` exits 1 with "Reached max turns".
export const oneShot = (model) => ['-p', '--model', model, '--max-turns', '1', '--tools', '', '--strict-mcp-config'];
function estimateFootprint(p, i) { // bounded, fresh LLM call; persisted on the issue
  const files = repoMap(gh('api', `repos/${p.repo}/git/trees/${p.base}?recursive=1`, '-q', '.tree[].path').split('\n'));
  const prompt = `Repo paths:\n${files}\n\nTask:\n${i.title}\n${i.description ?? ''}\n\n${p.footprintHint ?? ''}\n` +
    'Reply with ONLY a comma-separated list of repo paths this task will create or edit.';
  const out = execFileSync('claude', oneShot('haiku'), { input: prompt, encoding: 'utf8' }).trim(); // stdin: argv has a size limit
  const fp = list(out);
  t('issue', 'update', i.identifier, `--set=footprint=${fp.join(', ')}`);
  log(null, 'footprint', i.identifier, fp.join(', '));
  return fp;
}

// One model call, no tools: the model and extra guidance come from the orchestrator agent `o` (agents/orchestrator.json).
function orchestrate(projects, issues, waiting, agents, o, runs, statusOf, room) {
  const repo = (i) => projects[i.project_id].repo;
  const rules = [...new Set(waiting.map((i) => projects[i.project_id]))].map((p) => `## ${p.repo}\n` +
    (try_(() => gh('api', `repos/${p.repo}/contents/AGENTS.md?ref=${p.base}`, '-H', 'Accept: application/vnd.github.raw'))?.slice(0, 8000) ?? '(no AGENTS.md)'));
  const line = (i) => `- ${i.identifier} [${repo(i)}] ${i.status}${i.agent && !CLOSED.includes(i.status) ? `, held by ${i.agent}` : ''}${i.blockedBy?.length ? `, blocked-by ${i.blockedBy}` : ''}: ${i.title}`;
  const closed = Object.values(projects).flatMap((p) => tj('issue', 'list', '-p', p.key, '--status', 'done', '--limit', '100'))
    .sort((a, b) => a.updated_at.localeCompare(b.updated_at)).slice(-15);
  const inWork = issues.filter((i) => i.status === 'in_progress').length;
  const prompt = `You are the orchestrator of a team of coding agents. ${inWork ? `${inWork} task(s) are in work right now (in_progress under Other open tasks)` : 'Nothing is running right now'}; ` +
    `${room} slot(s) are free. Decide which of the WAITING tasks start now, in parallel, at most ${room}, and which agent takes each. ` +
    'Start a task only if it makes sense now: leave out one that logically follows another waiting or unfinished task, or would ' +
    'collide with one in work or one you start. Starting nothing is a valid answer.\n' +
    'Every WAITING task has already passed the scheduler\'s own checks: all its blockers are closed (they are listed with their ' +
    'status) and its footprint overlaps no task that is in work. Do not check these two again from descriptions or comments: ' +
    'text that says a task still waits for a closed task is out of date. A closed task is finished and nothing collides with it.\n\n' +
    `# Agents\n${agents.map((a) => `- ${a.name}: ${a.description || '(no description)'}`).join('\n')}\n\n` +
    `# Project rules\n${rules.join('\n\n')}\n\n` +
    `# WAITING (the human's order: top = do first)\n${waiting.map((i) => offered(i, repo(i), runs[i.identifier], statusOf)).join('\n\n')}\n\n` +
    `# Other open tasks\n${issues.filter((i) => !waiting.includes(i)).map(line).join('\n') || '-'}\n\n` +
    `# Recently closed\n${closed.map(line).join('\n') || '-'}\n\n` +
    (o.instructions ? `# Maintainer's guidance\n${o.instructions}\n\n` : '') +
    'Reply with ONLY these lines, no other text: `<KEY> <agent name>` for each task to start. For a WAITING task you leave out ' +
    'because it must wait for another open task, add `<KEY> after <OTHER KEY>: <why>`: OTHER becomes its blocker and it is not ' +
    'offered until OTHER closes. For one only a person can settle (a duplicate, an obsolete or unclear task), add `<KEY> human: <why>`. ' +
    'If you start nothing and add no such line, reply with one line saying why.';
  return execFileSync('claude', oneShot(o.model || 'sonnet'), { input: prompt, encoding: 'utf8' });
}

// ---- p.milestone: one job at a time per project, detached under `timeout`: the milestone in a clean worktree at
// origin/<base>, then p.milestone.bisect once per red stage; each red stage = one todo issue. Logs in state/milestones/,
// state in state/milestones.json = { <project key>: { sha, good, tried, green, filed, wt, pid, log, mlog, stage, queue } }. ----
const MS = `${DIR}/milestones.json`, fetched = {}; // fetched: project key -> when origin was last fetched for it
// A detached job (a milestone, a bisect, a land gate) in the worktree m.wt, under `timeout sec`: its output goes to `log`, its exit code to `<log>.exit`.
function job(m, src, cmd, file, sec = 2400, extra = {}) {
  mkdirSync(dirname(file), { recursive: true });
  m.log = file; rmSync(`${m.log}.exit`, { force: true });
  const out = openSync(m.log, 'w'), child = spawn('sh', ['-c', 'timeout -k 30 "$0" sh -c "$1"; echo $? > "$2"', String(sec), cmd, `${m.log}.exit`],
    { cwd: m.wt, detached: true, stdio: ['ignore', out, out], env: { ...process.env, BATON_SOURCE: src, BATON_ISSUE: 'milestone', ...extra } });
  child.unref(); m.pid = child.pid;
}
function dropTree(m, src) {
  if (!m.wt) return;
  reap(m.wt); try_(() => run('git', ['-C', src, 'worktree', 'remove', '--force', m.wt])); rmSync(m.wt, { recursive: true, force: true });
}
// A job ended: file what it found, start the next bisect or drop the worktree.
function settle(p, m, src) {
  const read = (f) => try_(() => readFileSync(f, 'utf8')) ?? '', out = read(m.log), code = Number(read(`${m.log}.exit`).trim() || NaN);
  const file = (stage, c, text, logs) => {
    const { title, description } = fixIssue(p, m.sha, stage, c, text, logs);
    const k = tj('issue', 'create', '--project', p.key, '--status=todo', `--title=${title}`, `--description=${description}`, ...(stage ? [] : [`--labels=${CFG.humanLabel}`])).identifier;
    m.filed.push(k); log(null, 'milestone', p.key, 'filed', k, stage ?? `exit ${code}`);
  };
  m.pid = null;
  if (m.stage == null) {
    m.mlog = m.log;
    if (code === 0) { m.green = m.sha; log(null, 'milestone', p.key, 'green', m.sha.slice(0, 10)); } else {
      m.queue = redStages(out, p.milestone.failed);
      log(null, 'milestone', p.key, 'red', m.sha.slice(0, 10), `exit ${code}`, m.queue.join(', ') || 'no red stage');
      if (!m.queue.length) file(null, null, out.split('\n').slice(-40).join('\n').slice(-3000), [m.log]);
      else if (!p.milestone.bisect || !m.good) m.queue = (m.queue.forEach((s) => file(s, null, excerpt(out, s), [m.log])), []);
    }
  } else file(m.stage, culprit(out, (sha) => try_(() => run('git', ['-C', src, 'log', '-1', '--format=%s', sha]))), excerpt(read(m.mlog), m.stage), [m.mlog, m.log]);
  if (m.queue?.length) {
    m.stage = m.queue.shift();
    job(m, src, p.milestone.bisect, `${DIR}/milestones/${p.key}-bisect-${m.queue.length}.log`, p.milestone.timeoutSec, { BATON_STAGE: m.stage, BATON_BAD: m.sha, BATON_GOOD: m.good ?? '' });
    log(null, 'milestone', p.key, 'bisect', m.stage, `pid ${m.pid}`);
  } else { m.stage = null; dropTree(m, src); }
}
function milestones(projects, idle, statusOf) {
  const ms = try_(() => JSON.parse(readFileSync(MS, 'utf8'))) ?? {}, save = () => writeFileSync(MS, JSON.stringify(ms));
  for (const p of Object.values(projects).filter((x) => x.milestone)) {
    const m = ms[p.key] ??= {}, src = source(p), git = (...a) => try_(() => run('git', ['-C', src, ...a]));
    if (m.pid) { if (!alive(m)) { settle(p, m, src); save(); } continue; }
    if (!idle(p) || Date.now() - (fetched[p.key] ?? 0) < 60000) continue;
    fetched[p.key] = Date.now(); git('fetch', '-q', 'origin');
    const head = git('rev-parse', `origin/${p.base}`), green = p.milestone.tag ? git('rev-parse', '-q', '--verify', `refs/tags/${p.milestone.tag}^{commit}`) : m.green;
    if (!milestoneDue(true, head, green, m.tried, (m.filed ?? []).some((k) => !CLOSED.includes(statusOf(k))))) continue;
    Object.assign(m, { sha: head, good: green, tried: head, filed: [], queue: [], stage: null, wt: wtDir(p, src, '_milestone') });
    dropTree(m, src); git('worktree', 'prune'); run('git', ['-C', src, 'worktree', 'add', '-q', '--detach', m.wt, head]);
    job(m, src, p.setup ? `(${p.setup}\n) && ${p.milestone.cmd}` : p.milestone.cmd, `${DIR}/milestones/${p.key}-milestone.log`, p.milestone.timeoutSec);
    log(null, 'milestone', p.key, 'run', head.slice(0, 10), green ? `${p.milestone.tag ?? 'green'} at ${green.slice(0, 10)}` : 'no green commit yet', `pid ${m.pid}`);
    save();
  }
}

// ---- p.land: the merge queue, one batch at a time per project. An agent hands its finished branch over (status in_review,
// label cfg.landLabel, property `branch`) instead of merging it; baton merges every ready branch of the project, in board
// order, onto origin/<base> in a clean worktree <worktrees>/_land (`--no-ff`, the subject names the issue), runs p.land.cmd
// once on the whole batch and pushes it. Red: probe() bisects the batch's prefixes; the longest green one lands, the branch
// that turns it red goes back to its agent with the output, the ones after it wait for the next batch. A branch that is
// missing or does not merge goes back at once. Logs in state/lands/, state in state/lands.json =
// { <project key>: { batch: [{ key, branch }], tips: [sha per prefix], g, r, k, logs, wt, pid, log } }. ----
const LANDS = `${DIR}/lands.json`;
// The issue goes back to the agent that holds it (active again, so its footprint stays reserved): the run resumes and reads why.
function bounce(p, i, why, text) {
  comment(i.identifier, bounced(p.base, why, text));
  try_(() => relabel(i.identifier, 'remove', CFG.landLabel));
  t('issue', 'update', i.identifier, '--status=active'); i.status = 'in_progress';
  log(null, 'land', p.key, 'back', i.identifier, why.split('\n')[0].slice(0, 200));
}
function landTry(p, l, src) {
  const cmd = `git checkout -q --detach ${l.tips[l.k]} && ${p.setup ? `(${p.setup}\n) && ` : ''}${p.land.cmd}`;
  job(l, src, cmd, (l.logs[l.k] = `${DIR}/lands/${p.key}-${l.k}.log`), p.land.timeoutSec, { BATON_ISSUE: 'land' });
  log(null, 'land', p.key, 'gate', l.batch.slice(0, l.k).map((b) => b.key).join(','), `pid ${l.pid}`);
}
// Returns the keys of the projects with a batch in work: the milestone waits for them.
function lands(projects, issues, byKey, statusOf) {
  const ls = try_(() => JSON.parse(readFileSync(LANDS, 'utf8'))) ?? {}, save = () => writeFileSync(LANDS, JSON.stringify(ls));
  for (const p of Object.values(projects).filter((x) => x.land)) {
    const l = ls[p.key] ??= {}, src = source(p), git = (...a) => run('git', ['-C', l.wt, ...a]);
    if (l.pid) {
      if (alive(l)) continue;
      const read = (f) => try_(() => readFileSync(f, 'utf8')) ?? '', ok = read(`${l.log}.exit`).trim() === '0';
      Object.assign(l, probe(l, ok), { pid: null }); save(); // a throw below must not run this gate's verdict twice
      log(null, 'land', p.key, ok ? 'green' : 'red', l.batch.slice(0, ok ? l.g : l.r).map((b) => b.key).join(','));
      if (l.k != null) { landTry(p, l, src); save(); continue; }
      const landed = l.batch.slice(0, l.g), sha = l.tips[l.g];
      if (landed.length && try_(() => git('push', '-q', 'origin', `${sha}:refs/heads/${p.base}`)) == null)
        log(null, 'land', p.key, 'push failed', `(origin/${p.base} moved?)`, landed.map((b) => b.key).join(','), 'wait for the next batch');
      else for (const b of landed) {
        t('issue', 'update', b.key, '--status=done'); if (byKey[b.key]) byKey[b.key].status = 'done';
        comment(b.key, `Bridge: landed on \`${p.base}\` at ${sha.slice(0, 10)}${landed.length > 1 ? `, in one gated batch with ${landed.filter((x) => x !== b).map((x) => x.key).join(', ')}` : ''}.`);
        if (try_(() => git('push', '-q', 'origin', '--delete', b.branch)) == null) log(null, 'land', p.key, 'branch kept', b.branch, 'deleting it on origin failed');
        log(null, 'land', p.key, 'landed', b.key, sha.slice(0, 10));
      }
      const red = l.batch[l.r - 1], i = red && byKey[red.key];
      if (i) bounce(p, i, `the gate \`${p.land.cmd}\` is red on \`${p.base}\` + ${l.batch.slice(0, l.r).map((b) => `\`${b.branch}\``).join(' + ')}` +
        (l.r > 1 ? ', green without this branch' : '') + `. Log: ${l.logs[l.r]}`, read(l.logs[l.r]).split('\n').slice(-40).join('\n').slice(-3000));
      dropTree(l, src); ls[p.key] = { seen: l.seen }; save(); continue;
    }
    // seen: key -> when it was first seen ready (kept across batches: an issue that waited out a gate goes in the next one at once).
    const mine = issues.filter((x) => projects[x.project_id] === p), ready = landable(mine, p.land.max ?? 5, statusOf), now = Date.now();
    for (const i of landable(mine).filter((x) => x.blockedBy.some((k) => statusOf(k) !== 'done')))
      log(`land${i.identifier}`, 'land', i.identifier, 'waits for', i.blockedBy.filter((k) => statusOf(k) !== 'done').join(','));
    l.seen = Object.fromEntries(landable(mine, Infinity, statusOf).map((i) => [i.identifier, l.seen?.[i.identifier] ?? now])); save();
    if (!landDue(ready.length, (now - Math.min(now, ...Object.values(l.seen))) / 1000, mine.some((x) => x.status === 'in_progress'), p.land.holdSec, p.land.max ?? 5)) {
      if (ready.length) log(`land${p.key}`, 'land', p.key, 'hold', ready.map((i) => i.identifier).join(','), `up to ${p.land.holdSec}s for the issues in work`);
      continue;
    }
    Object.assign(l, { wt: wtDir(p, src, '_land'), batch: [], tips: [], logs: {} });
    dropTree(l, src); run('git', ['-C', src, 'fetch', '-q', '--prune', 'origin']); run('git', ['-C', src, 'worktree', 'prune']);
    run('git', ['-C', src, 'worktree', 'add', '-q', '--detach', l.wt, `origin/${p.base}`]);
    l.tips.push(git('rev-parse', 'HEAD'));
    for (const i of ready) {
      const branch = i.properties?.branch?.trim();
      let why = !branch ? 'the issue has no `branch` property (`lific issue update <KEY> --set branch=<name>`)'
        : !try_(() => git('rev-parse', '-q', '--verify', `origin/${branch}^{commit}`)) ? `origin has no branch \`${branch}\`` : null;
      if (!why) try { git('merge', '-q', '--no-ff', '-m', `Merge ${branch} (${i.identifier})`, `origin/${branch}`); } catch (e) {
        try_(() => git('merge', '--abort'));
        why = `\`${branch}\` does not merge cleanly onto \`origin/${p.base}\`${l.batch.length ? ` + ${l.batch.map((b) => `\`${b.branch}\``).join(' + ')} (they land before it)` : ''}:\n${(e.stdout || e.message).slice(-1500)}`;
      }
      if (why) { bounce(p, i, why); continue; }
      l.batch.push({ key: i.identifier, branch }); l.tips.push(git('rev-parse', 'HEAD'));
    }
    if (!l.batch.length) { dropTree(l, src); ls[p.key] = { seen: l.seen }; save(); continue; }
    Object.assign(l, { g: 0, r: l.batch.length + 1, k: l.batch.length });
    landTry(p, l, src); save();
  }
  return new Set(Object.entries(ls).filter(([, l]) => l.pid).map(([k]) => k));
}

let last = { snap: null, refused: {}, empties: 0, at: 0 }; // the last wave: the issues it left, what stays refused, rounds in a row that started nothing, when
let limit = 0; // until when the usage limit holds every start (ms); a restart forgets it and learns it again from one cut-off run
function tick() {
  const runs = loadRuns(), { o, agents } = team(loadAgents(), CFG.orchestrator), NOTIFIED = `${DIR}/notified.json`, notified = try_(() => JSON.parse(readFileSync(NOTIFIED, 'utf8'))) ?? [];
  const listed = tj('project', 'list'), hidden = unseen(CFG.projects, listed.map((p) => p.name));
  if (hidden.length) log('unseen', 'unseen', hidden.join(', '), "not visible to baton's Lific user: add it as a member"); else seen.delete('unseen');
  const projects = Object.fromEntries(listed.filter((p) => CFG.projects[p.name])
    .map((p) => [p.id, Object.assign(CFG.projects[p.name], { key: p.identifier })]));
  // Every open status but backlog (= not ready yet: the human moves it to todo).
  const issues = Object.values(projects).flatMap((p) => ['todo', 'active', 'in_review'].flatMap((s) => tj('issue', 'list', '-p', p.key, '--status', s, '--limit', '100')))
    .map((i) => meta(tj('issue', 'get', i.identifier), notified)).sort(byBoard);
  const byKey = Object.fromEntries(issues.map((i) => [i.identifier, i]));
  const statusOf = (k) => (byKey[k] ??= meta(tj('issue', 'get', k))).status;
  forward(runs); listen(runs);

  // A closed issue gives its worktree and session back.
  for (const key of Object.keys(runs)) {
    const i = try_(() => (statusOf(key), byKey[key]));
    if (i && CLOSED.includes(i.status) && !alive(runs[key])) log(null, 'cleanup', key, ...forget(projects[i.project_id], key, runs));
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
  // A run the usage limit cut off is not one of them: it does not count, and no agent or wave starts until the limit
  // resets (it is the account's: every other run would hit it too).
  for (const [key, r] of Object.entries(runs).filter(([, x]) => x.from != null && !alive(x))) {
    const until = limitedUntil(try_(() => readFileSync(`${DIR}/logs/${key}.log`).subarray(r.from).toString('utf8')) ?? '', Date.now());
    if (until) { r.n = Math.max(0, r.n - 1); limit = Math.max(limit, until); log(null, 'limit', key, 'run not counted, agents wait until', new Date(limit).toISOString().slice(11, 16), 'UTC'); }
    delete r.from; saveRuns(runs);
  }
  const limited = Date.now() < limit;
  for (const i of issues.filter((x) => x.status === 'in_progress')) {
    const r = runs[i.identifier], name = holder(i, r), a = agents.find((x) => x.name === name);
    const why = whyNot(i, [], statusOf) ?? (a ? null : `no agent "${name}"`), step = runStep(alive(r), why, r?.agent === name ? r.n : 0);
    if (step === 'park') {
      if (!a) { comment(i.identifier, `Bridge: this issue names the agent "${name}", which does not exist. Agents: ${agents.map((x) => x.name).join(', ')}.`); relabel(i.identifier, 'add', CFG.humanLabel); }
      t('issue', 'update', i.identifier, '--status=todo'); i.status = 'todo';
      if (r) { r.n = 0; saveRuns(runs); }
      log(null, 'park', i.identifier, why);
    } else if (step === 'stuck') {
      comment(i.identifier, `Bridge: ${r.n} runs of ${name} in a row ended without closing the issue, a hand-off, a blocker or a question. Log: ${DIR}/logs/${i.identifier}.log`);
      relabel(i.identifier, 'add', CFG.humanLabel); i.labels.push(CFG.humanLabel);
      log(null, 'stuck', i.identifier, `after ${r.n} runs`);
    } else if (step === 'start' && !limited) start(projects[i.project_id], i, runs, a);
  }

  // Wave: whenever fewer than cfg.maxWave issues are in work, the orchestrator fills the free slots from the startable
  // issues, in board order. cfg.maxWave also caps the not yet started ones offered, none overlapping another; a todo issue that has a run was
  // parked mid-work and is always offered. A needs-human issue is human-owned (spec approval, QA): no footprint call,
  // never offered.
  const held = issues.filter(flying);
  const free = issues.filter((x) => x.status === 'todo' && !whyNot(x, [], statusOf));
  // The land queue and the milestone do not hold the waves: they run detached. The milestone only while nothing runs and
  // nothing of the project waits, to start or to land.
  const landing = lands(projects, issues, byKey, statusOf);
  milestones(projects, (p) => !issues.some((x) => x.status === 'in_progress') && !free.some((x) => projects[x.project_id] === p) &&
    !landing.has(p.key) && !landable(issues.filter((x) => projects[x.project_id] === p), Infinity, statusOf).length, statusOf);
  const room = slots(issues);
  if (room <= 0 || limited) return;
  // Asked about every issue once: what an earlier wave did not start stays out until the issues change or a person
  // comments on it, so the next wave gets the ones behind it at once.
  const same = snapshot(issues) === last.snap, busy = () => issues.some((x) => x.status === 'in_progress');
  let refused = stillRefused(last.refused, same, (k) => JSON.stringify(byKey[k].said ??= said(tj('comment', 'list', k))));
  const offering = () => offer(free.filter((x) => x.status === 'todo' && !(x.identifier in refused)), (x, taken) => (x.footprint ??= estimateFootprint(projects[x.project_id], x),
    !whyNot(x, [...held, ...taken], statusOf, projects[x.project_id].sharedPaths)), (x) => runs[x.identifier])
    .map((x) => (x.said ??= said(tj('comment', 'list', x.identifier)), x));
  let waiting = offering();
  if (!waiting.length && Object.keys(refused).length && again(last.empties, (Date.now() - last.at) / 1000)) refused = {}, waiting = offering();
  if (!waiting.length) return;
  if (!o) throw new Error(`no orchestrator agent "${CFG.orchestrator ?? 'orchestrator'}" in agents/`);
  const out = orchestrate(projects, issues, waiting, agents, o, runs, statusOf, room), wave = picks(out, waiting.map((i) => i.identifier), agents.map((a) => a.name));
  for (const { key, agent } of wave) {
    const i = byKey[key], p = projects[i.project_id], why = slots(issues) <= 0 ? 'no free slot' : whyNot(i, held, statusOf, p.sharedPaths);
    if (why) { log(null, 'wait', key, why); continue; }
    if (freshStep(i, false, 0) === 'on-assign') restartFresh(p, i, runs);
    t('issue', 'update', key, '--status=active', `--set=agent=${agent}`); i.status = 'in_progress'; i.agent = agent;
    log(null, 'assign', key, p.repo, '->', agent, `footprint=${i.footprint.join(',')}`);
    start(p, i, runs, agents.find((a) => a.name === agent));
    held.push(i);
  }
  log(null, 'wave', wave.length ? wave.map((w) => w.key).join(',') : `nothing to start (${reason(out)})`, `of ${waiting.map((i) => i.identifier)}`);
  const picked = wave.map((w) => w.key);
  for (const f of fixes(out, waiting.map((i) => i.identifier).filter((k) => !picked.includes(k)), issues)) {
    const done = try_(() => (f.after ? t('issue', 'link', f.after, f.key) : relabel(f.key, 'add', CFG.humanLabel),
      comment(f.key, `Bridge: ${f.after ? `waits for ${f.after}` : 'for a person'} (the orchestrator: ${f.why})`), true));
    log(null, 'fix', f.key, f.after ? `after ${f.after}` : CFG.humanLabel, done ? f.why : 'failed');
  }
  // The snapshot the next tick will see (its own starts are no change; the fixes are). A round ends when nothing is
  // left to offer; while something runs it is not retried: the next free slot asks again.
  refused = refuse(refused, waiting, picked);
  const over = !wave.length && !busy() && !offering().length;
  last = { snap: snapshot(issues), refused, empties: wave.length || busy() ? 0 : (same ? last.empties : 0) + (over ? 1 : 0), at: Date.now() };
}

// Agents call the tracker as plain `lific …`: a wrapper on their PATH (lificWrapper) pins the HTTP backend and marks their comments.
// It is lific.cjs with `lific` a symlink to it: Node takes the module type from the real path, so require works there.
// baton-inbox.cjs is the runs' hook (inboxHook), passed with --settings so it adds to the repo's own hooks.
const HOOKS = JSON.stringify({ hooks: Object.fromEntries(['PostToolUse', 'Stop'].map((e) => [e, [{ hooks: [{ type: 'command', command: `"${DIR}/bin/baton-inbox.cjs"` }] }]])) });
function agentBin() {
  mkdirSync(`${DIR}/bin`, { recursive: true });
  writeFileSync(`${DIR}/bin/lific.cjs`, lificWrapper(process.execPath, CFG.lific.bin)); chmodSync(`${DIR}/bin/lific.cjs`, 0o755);
  rmSync(`${DIR}/bin/lific`, { force: true }); symlinkSync('lific.cjs', `${DIR}/bin/lific`);
  writeFileSync(`${DIR}/bin/baton-inbox.cjs`, inboxHook(process.execPath)); chmodSync(`${DIR}/bin/baton-inbox.cjs`, 0o755);
}
const loop = async () => {
  for (; ; await new Promise((r) => setTimeout(r, CFG.tickSec * 1000))) {
    try { tick(); } catch (e) { log('err', 'tick error', e.message.split('\n')[0]); }
  }
};
if (process.argv[1] === fileURLToPath(import.meta.url)) mkdirSync(DIR, { recursive: true }), agentBin(), process.argv.includes('--once') ? tick() : loop();
