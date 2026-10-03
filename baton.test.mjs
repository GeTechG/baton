// node --test bridge.test.mjs — the bridge's pure scheduling logic (no Multica, no GitHub).
import test from 'node:test';
import assert from 'node:assert/strict';
import { list, overlaps, meta, whyNot, notifyStep, repoMap, freshStep, assigned, snapshot, picks, reason, byBoard, team } from './baton.mjs';

const P = { footprint: 'fp-id', 'blocked-by': 'bb-id' };
const issue = (key, props = {}, labels = [], project_id = 'app') => meta({ identifier: key, project_id,
  labels: labels.map((name) => ({ name })), properties: { 'fp-id': props.fp, 'bb-id': props.bb } }, P);

test('footprint parsing: backticks, trailing punctuation, bullets, prose', () => {
  assert.deepEqual(list('`src/a.js`, `test/greet.test.js`'), ['src/a.js', 'test/greet.test.js']); // round-1 Haiku bug
  assert.deepEqual(list('src/b.js, test/farewell.test.js.'), ['src/b.js', 'test/farewell.test.js']);
  assert.deepEqual(list('Files this task edits:\n- **src/c.js**\n- test/area.test.js;'), ['src/c.js', 'test/area.test.js']);
  assert.deepEqual(list(undefined), []);
});

test('blocked-by parsing', () => {
  assert.deepEqual(issue('OS-2', { bb: 'OS-12, `OS-13`.' }).blockedBy, ['OS-12', 'OS-13']);
  assert.deepEqual(issue('OS-2').blockedBy, []);
  assert.equal(issue('OS-2').footprint, null); // missing property => bridge estimates it
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
  assert.equal(whyNot(issue('OS-4', { fp: 'src/c.js', bb: 'OS-12, OS-13' }), [], statusOf), 'blocked by OS-12');
  assert.equal(whyNot(issue('OS-4', { fp: 'src/c.js', bb: 'OS-13' }), [], statusOf), null);
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
  const { line } = await import('./watch.mjs');
  const at = { created_at: '2026-01-01T10:20:30.000Z' };
  assert.match(line('K-1', { ...at, type: 'tool_use', tool: 'Bash', input: { description: 'Run tests', command: 'npm test' } }), /10:20:30 K-1 Bash Run tests$/);
  assert.equal(line('K-1', { ...at, type: 'tool_result', output: 'ok 12 passed' }), null);
  assert.match(line('K-1', { ...at, type: 'tool_result', output: 'Error: boom' }), /✖ Error: boom/);
  assert.match(line('K-1', { ...at, type: 'text', content: 'Opening the PR' }), /Opening the PR/);
});

test('fresh label: rerun when idle, wait while a run is active, defer to assignment when parked', () => {
  const i = (labels) => ({ labels });
  assert.equal(freshStep(i([]), true, 0), null);
  assert.equal(freshStep(i(['fresh']), true, 0), 'rerun');
  assert.equal(freshStep(i(['fresh']), true, 1), 'wait');
  assert.equal(freshStep(i(['fresh', 'needs-human']), false, 0), 'on-assign');
});

test('in flight: an issue held by any agent, handed on or not; never a human or nobody', () => {
  assert.equal(assigned({ assignee_type: 'agent', assignee_id: 'reviewer' }), true);
  assert.equal(assigned({ assignee_type: 'member', assignee_id: 'me' }), false);
  assert.equal(assigned({ assignee_type: null, assignee_id: null }), false);
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

test('wave: the orchestrator is found by id or name (default "orchestrator") and is not offered issues', () => {
  const w = { id: '1', name: 'worker' }, o = { id: '2', name: 'orchestrator' }, b = { id: '3', name: 'boss' }, old = { id: '4', name: 'old', archived_at: 'x' };
  assert.deepEqual(team([w, o, b, old]), { o, agents: [w, b] });
  assert.deepEqual(team([w, o, b], '3'), { o: b, agents: [w, o] });
  assert.deepEqual(team([w, o, b], 'boss'), { o: b, agents: [w, o] });
  assert.deepEqual(team([w, old], 'old'), { o: undefined, agents: [w] });
});

test('wave: the orchestrator is asked again only when the issues changed', () => {
  const a = issue('OS-1', { fp: 'src/a.js' });
  assert.equal(snapshot([a]), snapshot([issue('OS-1', { fp: 'src/a.js' })]));
  assert.notEqual(snapshot([a]), snapshot([{ ...a, status: 'done' }]));
  assert.notEqual(snapshot([a]), snapshot([{ ...a, assignee_id: 'x' }]));
});

test('wave order: manual board position first, issue number on ties', () => {
  const xs = [{ number: 1, position: 0 }, { number: 3, position: -2 }, { number: 2, position: -2 }, { number: 4, position: -1 }];
  assert.deepEqual(xs.sort(byBoard).map((x) => x.number), [2, 3, 4, 1]);
});
