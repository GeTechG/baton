// node --test baton.test.mjs — baton's pure scheduling logic (no tracker, no GitHub).
import test from 'node:test';
import assert from 'node:assert/strict';
import { list, overlaps, meta, whyNot, notifyStep, repoMap, freshStep, runStep, agentEnv, tail, holder, snapshot, team, picks, reason, byBoard, busy, prompt, exports_ } from './baton.mjs';

const issue = (key, props = {}, labels = [], project_id = 'app') => meta({ identifier: key, project_id, labels, status: 'todo',
  properties: { ...(props.fp == null ? {} : { footprint: props.fp }), ...(props.agent ? { agent: props.agent } : {}) }, blocked_by: props.bb });

test('footprint parsing: backticks, trailing punctuation, bullets, prose', () => {
  assert.deepEqual(list('`src/a.js`, `test/greet.test.js`'), ['src/a.js', 'test/greet.test.js']); // round-1 Haiku bug
  assert.deepEqual(list('src/b.js, test/farewell.test.js.'), ['src/b.js', 'test/farewell.test.js']);
  assert.deepEqual(list('Files this task edits:\n- **src/c.js**\n- test/area.test.js;'), ['src/c.js', 'test/area.test.js']);
  assert.deepEqual(list(undefined), []);
});

test('tracker issue -> scheduler terms: footprint and agent properties, native blockers, active = in_progress', () => {
  assert.equal(issue('OS-2', { agent: ' reviewer ' }).agent, 'reviewer');
  assert.equal(issue('OS-2').agent, null);
  assert.deepEqual(issue('OS-2', { bb: ['OS-12', 'LIB-3'] }).blockedBy, ['OS-12', 'LIB-3']);
  assert.deepEqual(issue('OS-2').blockedBy, []);
  assert.equal(issue('OS-2').footprint, null); // no footprint property => baton estimates it
  assert.deepEqual(issue('OS-2', { fp: '`src/a.js`, test/a.test.js.' }).footprint, ['src/a.js', 'test/a.test.js']);
  assert.equal(meta({ identifier: 'K-1', status: 'active', labels: [] }).status, 'in_progress');
  assert.equal(meta({ identifier: 'K-1', status: 'in_review' }).status, 'in_review');
  assert.equal(meta({ identifier: 'K-1', status: 'todo' }, ['K-1']).notified, true);
});

test('run decision: leave a live agent alone, park a waiting issue, restart a quiet one, give up after max runs', () => {
  assert.equal(runStep(true, 'needs-human', 9, 3), null);
  assert.equal(runStep(false, 'blocked by LIB-3', 1, 3), 'park');
  assert.equal(runStep(false, null, 0, 3), 'start');
  assert.equal(runStep(false, null, 2, 3), 'start');
  assert.equal(runStep(false, null, 3, 3), 'stuck');
});

test('agent env: AGENT_X becomes X and overrides, baton-only values stay out of reach of the rename', () => {
  assert.deepEqual(agentEnv({ HOME: '/h', LIFIC_API_KEY: 'baton', AGENT_LIFIC_API_KEY: 'bot', AGENT_GH_TOKEN: 't' }, { LIFIC_URL: 'u' }),
    { HOME: '/h', LIFIC_API_KEY: 'bot', GH_TOKEN: 't', LIFIC_URL: 'u' });
});

test('herdr mode: a working or blocked agent is a live run, the prompt tells it nobody will answer, env file is quoted', () => {
  assert.deepEqual(['working', 'blocked', 'idle', 'done', 'unknown', null].map(busy), [true, true, false, false, false, false]);
  const a = { instructions: 'Do it.' }, i = { identifier: 'LIB-1' }, p = { repo: 'o/r', base: 'main' };
  assert.equal(prompt(a, i, p, true, false), 'Do it.\n\nYour issue: LIB-1. Repo o/r, base branch `main`.');
  assert.equal(prompt(a, i, p, false, false), 'Continue issue LIB-1: read its new comments and its labels first.');
  for (const first of [true, false]) {
    const w = prompt(a, i, p, first, true);
    assert.ok(w.startsWith(prompt(a, i, p, first, false)) && /unattended/.test(w) && /never ask a question/.test(w));
  }
  assert.equal(exports_({ GH_TOKEN: "a'b", LIFIC_URL: 'http://x' }), "export GH_TOKEN='a'\\''b'\nexport LIFIC_URL='http://x'\n");
});

test('overlaps: path prefix, directory, disjoint, empty is conservative', () => {
  assert.ok(overlaps(['src/a.js', 'test/greet.test.js'], ['src/a.js', 'test/hello.test.js']));
  assert.ok(overlaps(['src/'], ['src/b.js']));
  assert.ok(!overlaps(['src/b.js', 'test/farewell.test.js'], ['src/a.js', 'test/greet.test.js']));
  assert.ok(overlaps([], ['src/a.js']));
});

test('ready decision', () => {
  const t1 = issue('OS-1', { fp: 'src/a.js, test/greet.test.js' });
  const t3 = issue('OS-3', { fp: 'src/a.js, test/hello.test.js' });
  const t2 = issue('OS-2', { fp: 'src/b.js' });
  const lib = issue('OS-9', { fp: 'src/a.js' }, [], 'lib');
  const status = { 'OS-12': 'in_progress', 'OS-13': 'done' };
  const statusOf = (k) => status[k];
  assert.equal(whyNot(t2, [t1], statusOf), null);
  assert.equal(whyNot(lib, [t1], statusOf), null); // same path, other project
  assert.equal(whyNot(t3, [t1], statusOf), 'footprint overlaps OS-1');
  assert.equal(whyNot(issue('OS-4', { fp: 'src/c.js', bb: ['OS-12', 'OS-13'] }), [], statusOf), 'blocked by OS-12');
  assert.equal(whyNot(issue('OS-4', { fp: 'src/c.js', bb: ['OS-13'] }), [], statusOf), null);
  assert.equal(whyNot(issue('OS-5', { fp: 'src/d.js' }, ['gate:spec', 'needs-human']), [], statusOf), 'needs-human');
});

test('human notification fires once per needs-human episode', () => {
  const i = (labels, notified) => ({ labels, notified });
  assert.equal(notifyStep(i(['needs-human'], false)), 'notify');
  assert.equal(notifyStep(i(['needs-human'], true)), null);
  assert.equal(notifyStep(i([], true)), 'clear');
  assert.equal(notifyStep(i([], false)), null);
});

test('repo map: files for a small repo, directories at the deepest depth that fits for a big one', () => {
  assert.equal(repoMap(['a.js', 'src/b.js']), 'a.js\nsrc/b.js');
  const big = Array.from({ length: 5000 }, (_, n) => `pkg${n % 7}/src/mod${n % 300}/file${n}.hx`);
  const deep = repoMap(big, 40000).split('\n');
  assert.equal(deep.length, 2100); // pkgN/src/modM/ — all dirs fit
  const shallow = repoMap(big, 1000).split('\n');
  assert.deepEqual(shallow, ['pkg0/src/', 'pkg1/src/', 'pkg2/src/', 'pkg3/src/', 'pkg4/src/', 'pkg5/src/', 'pkg6/src/']);
});

test('watch: one line per tool call, quiet on clean results, loud on failures', async () => {
  const { lines } = await import('./watch.mjs');
  const use = { type: 'assistant', message: { content: [{ type: 'text', text: 'Opening the PR' },
    { type: 'tool_use', name: 'Bash', input: { description: 'Run tests', command: 'npm test' } }] } };
  const [text, tool] = lines('K-1', JSON.stringify(use), '10:20:30');
  assert.match(text, /10:20:30 K-1 Opening the PR$/);
  assert.match(tool, /10:20:30 K-1 Bash Run tests$/);
  const result = (content, is_error) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content, is_error }] } });
  assert.deepEqual(lines('K-1', result('ok 12 passed', false), ''), []);
  assert.match(lines('K-1', result([{ type: 'text', text: 'Error: boom' }], true), '')[0], /✖ Error: boom/);
  assert.match(lines('K-1', 'not json: a crash trace', '')[0], /not json: a crash trace/); // whatever the agent CLI prints raw
  assert.deepEqual(lines('K-1', JSON.stringify({ type: 'system', subtype: 'init' }), ''), []);
});

test('watch: a transcript line whose content is a string (typed to an interactive agent) shows nothing', async () => {
  const { say } = await import('./watch.mjs');
  assert.deepEqual(say(JSON.stringify({ type: 'user', message: { role: 'user', content: 'Continue issue LIB-1' } })), []);
});

test('run log: complete new lines only, readable form, nothing for noise', () => {
  const ev = (content) => JSON.stringify({ type: 'assistant', message: { content } });
  const log = Buffer.from([ev([{ type: 'text', text: 'Читаю задачу' }]), JSON.stringify({ type: 'system', subtype: 'init' }),
    ev([{ type: 'tool_use', name: 'Bash', input: { description: 'Run tests' } }]), '{"type":"assistant","message":{"content":[{"type":"te'].join('\n'));
  const first = tail(log, 0);
  assert.deepEqual(first.out, ['Читаю задачу', 'Bash Run tests']);
  assert.equal(log.subarray(first.pos).toString(), '{"type":"assistant","message":{"content":[{"type":"te'); // the unfinished line waits
  assert.deepEqual(tail(log, first.pos), { pos: first.pos, out: [] });
});

test('fresh label: rerun when idle, wait while a run is active, defer to assignment when parked', () => {
  const i = (labels) => ({ labels });
  assert.equal(freshStep(i([]), true, 0), null);
  assert.equal(freshStep(i(['fresh']), true, 0), 'rerun');
  assert.equal(freshStep(i(['fresh']), true, 1), 'wait');
  assert.equal(freshStep(i(['fresh', 'needs-human']), false, 0), 'on-assign');
});

test('who runs next: the agent the issue names, else the one that ran it last, else the base worker', () => {
  assert.equal(holder({ agent: 'reviewer' }, { agent: 'worker' }), 'reviewer'); // handed on
  assert.equal(holder({ agent: null }, { agent: 'reviewer' }), 'reviewer');
  assert.equal(holder({ agent: null }, undefined), 'worker'); // set active by hand
});

test('wave: orchestrator reply -> picks; unknown keys and agents, repeats and prose dropped', () => {
  const out = 'Starting two:\n- OS-1 `worker`\nOS-2: Reviewer.\nOS-1 reviewer\nOS-3 nobody\nOS-9 worker\n';
  assert.deepEqual(picks(out, ['OS-1', 'OS-2', 'OS-3'], ['worker', 'reviewer']), [{ key: 'OS-1', agent: 'worker' }, { key: 'OS-2', agent: 'reviewer' }]);
  assert.deepEqual(picks('nothing to start', ['OS-1'], ['worker']), []);
});

test('wave: an empty wave logs the orchestrator reply on one line, capped', () => {
  assert.equal(reason('OS-1 needs a decision first.\n\n  Too vague.\n'), 'OS-1 needs a decision first. Too vague.');
  assert.equal(reason(' \n'), 'empty reply');
  assert.equal(reason('x'.repeat(500)).length, 300);
});

test('wave: the orchestrator is found by name (default "orchestrator") and is not offered issues', () => {
  const w = { name: 'worker' }, o = { name: 'orchestrator' }, b = { name: 'boss' };
  assert.deepEqual(team([w, o, b]), { o, agents: [w, b] });
  assert.deepEqual(team([w, o, b], 'boss'), { o: b, agents: [w, o] });
  assert.deepEqual(team([w], 'boss'), { o: undefined, agents: [w] });
});

test('wave: the orchestrator is asked again only when the issues changed', () => {
  const a = issue('OS-1', { fp: 'src/a.js' });
  assert.equal(snapshot([a]), snapshot([issue('OS-1', { fp: 'src/a.js' })]));
  assert.notEqual(snapshot([a]), snapshot([{ ...a, status: 'done' }]));
  assert.notEqual(snapshot([a]), snapshot([{ ...a, agent: 'reviewer' }]));
});

test('wave order: manual board order first, issue number on ties', () => {
  const xs = [{ sequence: 1, sort_order: 0 }, { sequence: 3, sort_order: -2 }, { sequence: 2, sort_order: -2 }, { sequence: 4, sort_order: -1 }];
  assert.deepEqual(xs.sort(byBoard).map((x) => x.sequence), [2, 3, 4, 1]);
});

test('base agents: valid JSON with a name, a description and instructions; one of them is the orchestrator', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const all = readdirSync('agents').map((f) => JSON.parse(readFileSync(`agents/${f}`, 'utf8')));
  for (const a of all) assert.ok(a.name && a.description && a.instructions, a.name);
  assert.deepEqual(team(all).agents.map((a) => a.name), ['worker']);
  assert.ok(team(all).o);
});
