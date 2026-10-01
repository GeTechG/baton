// node --test bridge.test.mjs — the bridge's pure scheduling logic (no Multica, no GitHub).
import test from 'node:test';
import assert from 'node:assert/strict';
import { list, overlaps, meta, whyNot, rollup, candidates, batchStep, keyOf, notifyStep } from './baton.mjs';

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
  const full = ['x1', 'x2', 'x3', 'x4'].map((k) => issue(k, { fp: `src/${k}.js` }));
  assert.equal(whyNot(t2, full, statusOf), 'in flight 4');
});

const ok = [{ name: 'test', status: 'completed', conclusion: 'success' }], red = [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }];
const run = [{ name: 'test', status: 'IN_PROGRESS', conclusion: '' }];
test('check rollup', () => {
  assert.equal(rollup(ok), 'green');
  assert.equal(rollup([...ok, ...red]), 'red');
  assert.equal(rollup([...ok, ...run]), 'pending');
  assert.equal(rollup([]), 'pending'); // fresh push, checks not registered yet
  assert.equal(rollup(ok, ['test', 'lint']), 'pending'); // a required check has not shown up
});

test('candidates: in_review + green, red goes back, pending/other/in-batch skipped, capped', () => {
  const p = { branchPrefix: 'mc/', checks: 'all', maxBatch: 2 };
  const pr = (number, key, rollup) => ({ number, headRefName: `mc/${key}`, headRefOid: `h${number}`, statusCheckRollup: rollup });
  const byKey = Object.fromEntries(['K-1', 'K-2', 'K-3', 'K-4', 'K-5', 'K-6'].map((k) => [k, { status: k === 'K-5' ? 'in_progress' : 'in_review' }]));
  const c = candidates([pr(6, 'K-6', ok), pr(1, 'K-1', ok), pr(2, 'K-2', red), pr(3, 'K-3', run), pr(4, 'K-4', ok), pr(5, 'K-5', ok),
    { ...pr(7, 'K-1', ok), headRefName: 'feature/x' }], byKey, { prs: [{ number: 1 }] }, p);
  assert.deepEqual(c.ready.map((x) => x.number), [4, 6]);
  assert.deepEqual(c.red.map((x) => x.key), ['K-2']);
});

test('batch decisions', () => {
  const X = { number: 1 }, Y = { number: 2 }, Z = { number: 3 };
  const batch = { sha: 's', base: 'b', prs: [X, Y, Z] };
  assert.deepEqual(batchStep(null, 'b', [], [X, Y]), { act: 'form', prs: [X, Y] });
  assert.deepEqual(batchStep(null, 'b', [], []), { act: 'idle' });
  assert.deepEqual(batchStep(batch, 'b', run, []), { act: 'wait' });
  assert.deepEqual(batchStep(batch, 'b', ok, []), { act: 'land' });
  assert.deepEqual(batchStep(batch, 's', [], []), { act: 'land' }); // restart after the fast-forward: finish landing
  assert.deepEqual(batchStep(batch, 'b', red, []), { act: 'bisect', prs: [X] });
  assert.deepEqual(batchStep({ ...batch, prs: [X, Y, Z, { number: 4 }] }, 'b', red, []).prs, [X, Y]);
  assert.deepEqual(batchStep({ ...batch, prs: [Y] }, 'b', red, []), { act: 'sendback' });
  assert.deepEqual(batchStep(batch, 'moved', ok, []), { act: 'rebuild' });
});

test('branch key and gate-less repos', () => {
  assert.equal(keyOf('change/OS-12-tileset-fixes', 'change/'), 'OS-12');
  assert.equal(keyOf('mc/OS-7', 'mc/'), 'OS-7');
  assert.equal(keyOf('change/tileset-fixes', 'change/'), null);
  assert.equal(keyOf('feature/OS-7', 'mc/'), null);
  assert.equal(rollup([], 'none'), 'green');
  assert.equal(rollup([], 'all'), 'pending');
});

test('human notification fires once per needs-human episode', () => {
  const i = (labels, notified) => ({ labels, notified });
  assert.equal(notifyStep(i(['needs-human'], false)), 'notify');
  assert.equal(notifyStep(i(['needs-human'], true)), null);
  assert.equal(notifyStep(i([], true)), 'clear');
  assert.equal(notifyStep(i([], false)), null);
});

test('prChecks none: a PR with no CI of its own is batch-ready', () => {
  const p = { branchPrefix: 'change/', checks: 'all', prChecks: 'none', maxBatch: 4 };
  const prs = [{ number: 1, headRefName: 'change/K-1-x', headRefOid: 'h1', statusCheckRollup: [] }];
  assert.deepEqual(candidates(prs, { 'K-1': { status: 'in_review' } }, null, p).ready.map((x) => x.key), ['K-1']);
  assert.deepEqual(candidates(prs, { 'K-1': { status: 'in_review' } }, null, { ...p, prChecks: undefined }).ready, []);
});
