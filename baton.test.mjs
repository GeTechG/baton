// node --test baton.test.mjs — baton's pure scheduling logic (no tracker, no GitHub).
import test from 'node:test';
import assert from 'node:assert/strict';
import { list, overlaps, meta, whyNot, rollup, candidates, batchStep, keyOf, notifyStep, repoMap, freshStep, releaseTag, releaseLate, brief, fpOf, runStep, agentEnv } from './baton.mjs';

const issue = (key, props = {}, labels = [], project_id = 'app') => meta({ identifier: key, project_id, labels, status: 'todo',
  description: props.fp == null ? 'Do the thing.' : `Do the thing.\n\nfootprint: ${props.fp}`, blocked_by: props.bb });

test('footprint parsing: backticks, trailing punctuation, bullets, prose', () => {
  assert.deepEqual(list('`src/a.js`, `test/greet.test.js`'), ['src/a.js', 'test/greet.test.js']); // round-1 Haiku bug
  assert.deepEqual(list('src/b.js, test/farewell.test.js.'), ['src/b.js', 'test/farewell.test.js']);
  assert.deepEqual(list('Files this task edits:\n- **src/c.js**\n- test/area.test.js;'), ['src/c.js', 'test/area.test.js']);
  assert.deepEqual(list(undefined), []);
});

test('tracker issue -> scheduler terms: footprint line, native blockers, review label', () => {
  assert.deepEqual(issue('OS-2', { bb: ['OS-12', 'LIB-3'] }).blockedBy, ['OS-12', 'LIB-3']);
  assert.deepEqual(issue('OS-2').blockedBy, []);
  assert.equal(issue('OS-2').footprint, null); // no footprint line => baton estimates it
  assert.deepEqual(fpOf('Text.\nFootprint: `src/a.js`, test/a.test.js.\nMore text.'), ['src/a.js', 'test/a.test.js']);
  assert.deepEqual(fpOf('footprint:'), []); // declared empty: overlaps everything
  assert.equal(meta({ identifier: 'K-1', status: 'active', labels: [] }).status, 'in_progress');
  assert.equal(meta({ identifier: 'K-1', status: 'active', labels: ['in-review'] }).status, 'in_review');
  assert.equal(meta({ identifier: 'K-1', status: 'todo', labels: ['in-review'] }).status, 'todo');
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
  assert.deepEqual(batchStep({ ...batch, landed: true }, 'moved', [], []), { act: 'land' }); // landed, release awaited: never rebuilt
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

test('fresh label: rerun when idle, wait while a run is active, defer to assignment when parked', () => {
  const i = (labels) => ({ labels });
  assert.equal(freshStep(i([]), true, 0), null);
  assert.equal(freshStep(i(['fresh']), true, 0), 'rerun');
  assert.equal(freshStep(i(['fresh']), true, 1), 'wait');
  assert.equal(freshStep(i(['fresh', 'needs-human']), false, 0), 'on-assign');
});

test('release gate: tag of the landed commit, none unless configured', () => {
  assert.equal(releaseTag({ release: 'build-{sha}' }, 'abc'), 'build-abc');
  assert.equal(releaseTag({}, 'abc'), null);
  assert.equal(releaseLate({ landed: 0 }, 59 * 60e3), false);
  assert.equal(releaseLate({ landed: 0 }, 61 * 60e3), true);
  assert.equal(releaseLate({ landed: 0 }, 11 * 60e3, 10), true);
  assert.equal(releaseLate({ landed: 0, late: true }, 61 * 60e3), false); // told once
});

test('brief: {{projects}} lists base branch, PR branch and check of every project the agent serves', () => {
  const ps = [{ key: 'LIB', repo: 'o/lib', base: 'development', branchPrefix: 'mc/', check: 'make test | tee log' }, { repo: 'o/app', base: 'main', branchPrefix: 'mc/' }];
  assert.equal(brief('Projects:\n{{projects}}\nEnd', ps), 'Projects:\n- LIB = o/lib: base branch `development`, PR branch `mc/<KEY>`, check: `make test | tee log`\n' +
    '- o/app: base branch `main`, PR branch `mc/<KEY>`, check: none configured\nEnd');
  assert.equal(brief('no placeholder', ps), 'no placeholder');
});
