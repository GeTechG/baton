// node --test baton.test.mjs — baton's pure scheduling logic (no tracker, no GitHub).
import test from 'node:test';
import assert from 'node:assert/strict';
import { list, overlaps, meta, whyNot, notifyStep, repoMap, freshStep, runStep, agentEnv, agentPath, tail, holder, snapshot, refuse, stillRefused, again, fixes, offer, slots, offered, said, team, picks, reason, oneShot, byBoard, firstPrompt, setup, reap, milestoneDue, redStages, culprit, excerpt, fixIssue, landable, landDue, probe, bounced, news, inboxHook, runMark, marked, lificWrapper } from './baton.mjs';

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

test('agent PATH: the lific wrapper first, then the tools installed in the worktree, then the inherited PATH', () => {
  assert.equal(agentPath('/b/bin', '/wt/K-1', '/usr/bin'), '/b/bin:/wt/K-1/node_modules/.bin:/usr/bin');
});

test('project setup: nothing runs without the field; with it the command runs in the new worktree; a failure parks the issue', async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const wt = mkdtempSync(`${(await import('node:os')).tmpdir()}/baton-`);
  try {
    assert.equal(setup({}, 'OS-1', `${wt}/missing`, '/src'), null); // a command would have failed in a missing directory
    assert.equal(setup({ setup: 'echo "$BATON_ISSUE $BATON_SOURCE" > out\npwd >> out' }, 'OS-1', wt, '/src'), null);
    const [env, cwd] = readFileSync(`${wt}/out`, 'utf8').trim().split('\n');
    assert.equal(env, 'OS-1 /src');
    assert.equal(cwd.split('/').pop(), wt.split('/').pop());
    assert.equal(setup({ setup: 'echo one; echo two >&2; exit 3' }, 'OS-1', wt, '/src'), 'one\ntwo'); // the comment's text
    assert.match(setup({ setup: 'exit 3' }, 'OS-1', wt, '/src'), /sh/); // silent failure: the error itself
    assert.equal(setup({ setup: 'yes | head -c 5000; exit 1' }, 'OS-1', wt, '/src').length, 1500);
  } finally { rmSync(wt, { recursive: true, force: true }); }
  // The failed issue gets the human label and no run: the next tick parks it.
  assert.equal(runStep(false, whyNot(issue('OS-1', { fp: 'src/a.js' }, ['needs-human']), [], () => 'done'), 0, 3), 'park');
});

test('first prompt: the agent instructions and the issue; project guidance only when the project has it', () => {
  const a = { instructions: 'You implement one issue.' }, p = { repo: 'o/r', base: 'main' }, i = { identifier: 'OS-1' };
  assert.equal(firstPrompt(a, p, i), 'You implement one issue.\n\nYour issue: OS-1. Repo o/r, base branch `main`.');
  assert.equal(firstPrompt(a, { ...p, instructions: 'Search Haxe code with Serena.' }, i),
    'You implement one issue.\n\nYour issue: OS-1. Repo o/r, base branch `main`.\n\nProject guidance:\nSearch Haxe code with Serena.');
});

test('overlaps: path prefix, directory, disjoint, empty is conservative', () => {
  assert.ok(overlaps(['src/a.js', 'test/greet.test.js'], ['src/a.js', 'test/hello.test.js']));
  assert.ok(overlaps(['src/'], ['src/b.js']));
  assert.ok(!overlaps(['src/b.js', 'test/farewell.test.js'], ['src/a.js', 'test/greet.test.js']));
  assert.ok(overlaps([], ['src/a.js']));
});

test('overlaps: shared paths count on neither side, only shared paths is empty', () => {
  const shared = ['openspec/', 'docs/tech-debt.md'];
  const a = ['openspec/changes/a/', 'docs/tech-debt.md', 'src/a.js'], b = ['openspec', 'docs/tech-debt.md', 'src/b.js'];
  assert.ok(overlaps(a, b));
  assert.ok(!overlaps(a, b, shared));
  assert.ok(!overlaps(['docs/', 'src/a.js'], ['docs/tech-debt.md', 'src/b.js'], shared));
  assert.ok(overlaps(['docs/'], ['docs/other.md', 'src/b.js'], shared));
  assert.ok(overlaps(['openspec/changes/a/', 'docs/tech-debt.md'], ['src/b.js'], shared));
  assert.ok(overlaps(['openspecs/x.md'], ['src/b.js', 'openspecs/'], shared)); // a sibling is not under openspec/
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
  assert.equal(whyNot(t3, [t1], statusOf, ['src/a.js']), null);
  assert.equal(whyNot(issue('OS-4', { fp: 'src/c.js', bb: ['OS-12', 'OS-13'] }), [], statusOf), 'blocked by OS-12');
  assert.equal(whyNot(issue('OS-4', { fp: 'src/c.js', bb: ['OS-13'] }), [], statusOf), null);
  assert.equal(whyNot(issue('OS-5', { fp: 'src/d.js' }, ['gate:spec', 'needs-human']), [], statusOf), 'needs-human');
  // Lific's assignment: unassigned is the agents'; any person or named people keep an issue for humans.
  const t4 = issue('OS-6', { fp: 'src/e.js' });
  assert.equal(whyNot({ ...t4, needs_human: false, assignees: [] }, [], statusOf), null);
  assert.equal(whyNot({ ...t4, needs_human: true }, [], statusOf), 'for a person');
  assert.equal(whyNot({ ...t4, needs_human: true, assignees: [{ username: 'kit' }, { username: 'ann' }] }, [], statusOf), 'for @kit,@ann');
  assert.equal(runStep(false, whyNot({ ...t4, needs_human: true }, [], statusOf), 0, 3), 'park');
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

test('watch: detailed view shows the skill, the command, the head of a result, full text and the outcome', async () => {
  const { detail, say } = await import('./watch.mjs');
  const ev = (type, content, extra = {}) => JSON.stringify({ type, message: { content }, ...extra });
  assert.deepEqual(detail(ev('assistant', [{ type: 'tool_use', name: 'Skill', input: { skill: 'herdr', args: 'x' } }])), ['', '● Skill(herdr)']);
  assert.deepEqual(detail(ev('assistant', [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test\nls', description: 'Run tests' } }])), ['', '● Bash(npm test', '    ls)']);
  assert.deepEqual(detail(ev('user', [{ type: 'tool_result', content: [{ type: 'text', text: '1\n2\n3\n4\n5\n6' }] }])), ['  ⎿ 1', '    2', '    3', '    4', '    … +2 lines']);
  assert.deepEqual(detail(ev('user', [{ type: 'tool_result', content: '' }])), ['  ⎿ (no output)']);
  assert.deepEqual(detail(ev('assistant', [{ type: 'text', text: 'Done.\nNext.' }], { parent_tool_use_id: 't1' })), ['', '  ● Done.', '    Next.']);
  assert.deepEqual(detail(JSON.stringify({ type: 'result', subtype: 'success', num_turns: 12, duration_ms: 180000, total_cost_usd: 1.234 })), ['', '◆ success: 12 turns, 3 min, $1.23']);
  assert.deepEqual(detail(ev('user', [{ type: 'text', text: 'Base directory\n# Skill\nbody' }])), ['  Base directory', '  # Skill', '  … +1 lines']);
  assert.deepEqual(detail('not json'), ['not json']);
  assert.deepEqual([detail(''), detail(ev('user', 'typed text')), say(ev('user', 'typed text'))], [[], [], []]);
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

test('wave: a change of the open issues is a change of the snapshot; footprint estimates and comments are not', () => {
  const a = issue('OS-1', { fp: 'src/a.js' });
  assert.equal(snapshot([a]), snapshot([issue('OS-1', { fp: 'src/a.js' })]));
  assert.notEqual(snapshot([a]), snapshot([{ ...a, status: 'done' }]));
  assert.notEqual(snapshot([a]), snapshot([{ ...a, agent: 'reviewer' }]));
  assert.notEqual(snapshot([a]), snapshot([{ ...a, blockedBy: ['OS-2'] }]));
  assert.notEqual(snapshot([a]), snapshot([{ ...a, sort_order: 2 }])); // a new board order
  assert.equal(snapshot([a]), snapshot([{ ...a, said: ['sergey: follow upstream'] }])); // a comment ends only its own issue's refusal
});

test('wave: what a wave did not start stays out of the offer until the issues change or a person comments on it', () => {
  const a = { ...issue('OS-1'), said: [] }, b = { ...issue('OS-2'), said: ['sergey: later'] }, c = { ...issue('OS-3'), said: [] };
  const r = refuse({}, [a, b, c], ['OS-1']);
  assert.deepEqual(Object.keys(r), ['OS-2', 'OS-3']); // the started one is not refused
  assert.deepEqual(Object.keys(refuse(r, [{ ...issue('OS-4'), said: [] }], [])), ['OS-2', 'OS-3', 'OS-4']); // refusals add up
  const saidNow = { 'OS-2': JSON.stringify(['sergey: later']), 'OS-3': JSON.stringify([]) };
  assert.deepEqual(stillRefused(r, true, (k) => saidNow[k]), r);
  assert.deepEqual(stillRefused(r, false, (k) => saidNow[k]), {}); // the issues changed: everything is offered again
  assert.deepEqual(Object.keys(stillRefused(r, true, (k) => k === 'OS-3' ? JSON.stringify(['sergey: start it']) : saidNow[k])), ['OS-2']);
});

test('wave: the orchestrator fixes the board for issues it leaves out: a blocker link or a person, never a cycle', () => {
  const open = [issue('OS-1'), issue('OS-2'), issue('OS-3', { bb: ['OS-1'] }), issue('OS-4')];
  const keys = ['OS-1', 'OS-2', 'OS-4'];
  assert.deepEqual(fixes('OS-2 after OS-1: same work as OS-1\n`OS-4 human`: duplicates OS-9', keys, open),
    [{ key: 'OS-2', after: 'OS-1', why: 'same work as OS-1' }, { key: 'OS-4', why: 'duplicates OS-9' }]);
  assert.deepEqual(fixes('OS-1 after OS-3: OS-3 first', keys, open), []); // OS-3 waits on OS-1 already
  assert.deepEqual(fixes('OS-2 after OS-4\nOS-4 after OS-2', keys, open), [{ key: 'OS-2', after: 'OS-4', why: 'no reason given' }]); // nor a new one
  assert.deepEqual(fixes('OS-2 after OS-2', keys, open), []);
  assert.deepEqual(fixes('OS-2 after OS-77: closed long ago', keys, open), []); // not an open issue
  assert.deepEqual(fixes('OS-3 human: not offered\nOS-1 worker\nnothing to start', keys, open), []); // not offered; picks and prose are not fixes
  assert.deepEqual(fixes('OS-1 human: a\nOS-1 after OS-2: b', keys, open), [{ key: 'OS-1', why: 'a' }]); // one fix per issue
});

test('wave: free slots are filled while other issues run; the offer skips what overlaps work in progress', () => {
  const run = { ...issue('OS-1', { fp: 'src/a.js' }), status: 'in_progress' };
  const rev = { ...issue('OS-2', { fp: 'src/r.js' }), status: 'in_review' };
  assert.equal(slots([run, rev, issue('OS-3')], 3), 2); // in_review waits for a review, not a run: no slot
  assert.equal(slots([run, { ...run, identifier: 'OS-4' }], 2), 0);
  assert.equal(slots([], 5), 5);
  const todo = [issue('OS-5', { fp: 'src/a.js' }), issue('OS-6', { fp: 'src/r.js/x' }), issue('OS-7', { fp: 'src/b.js' }),
    issue('OS-8', { fp: 'src/c.js' }), issue('OS-9', { fp: 'src/d.js' }), issue('OS-10', { fp: 'src/a.js' })];
  const ok = (i) => !whyNot(i, [run, rev], () => 'done'), keys = (l) => l.map((i) => i.identifier);
  assert.deepEqual(keys(offer(todo, ok, () => false, 2)), ['OS-7', 'OS-8']); // an overlapping one does not take a place in the window
  assert.deepEqual(keys(offer(todo, ok, (i) => i.identifier === 'OS-9', 1)), ['OS-9', 'OS-7']); // parked: always offered, first
  assert.deepEqual(keys(offer(todo, ok, (i) => i.identifier === 'OS-10', 5)), ['OS-7', 'OS-8', 'OS-9']); // a parked one overlapping work waits too
  const asked = [];
  offer(todo, (i) => (asked.push(i.identifier), ok(i)), () => false, 1);
  assert.deepEqual(asked, ['OS-5', 'OS-6', 'OS-7']); // ok (it may estimate a footprint) only while the window is not full

});

test('wave: the window is filled greedily in board order with issues that overlap neither work nor each other', () => {
  const run = { ...issue('OS-1', { fp: 'src/a.js' }), status: 'in_progress' };
  const todo = [issue('OS-2', { fp: 'src/p/x.js' }), issue('OS-3', { fp: 'src/p/' }), issue('OS-4', { fp: 'src/p/x.js' }),
    issue('OS-5', { fp: 'src/a.js' }), issue('OS-6', { fp: 'src/b.js' }), issue('OS-7', { fp: 'src/p' }), issue('OS-8', { fp: 'src/c.js' })];
  const ok = (i, taken) => !whyNot(i, [run, ...taken], () => 'done'), keys = (l) => l.map((i) => i.identifier);
  assert.deepEqual(keys(offer(todo, ok, () => false, 3)), ['OS-2', 'OS-6', 'OS-8']); // OS-3, OS-4, OS-7 clash with OS-2, OS-5 with work
  assert.deepEqual(keys(offer(todo.slice(1), ok, () => false, 2)), ['OS-3', 'OS-6']); // a skipped one stays first next wave
  assert.deepEqual(keys(offer(todo, ok, (i) => i.identifier === 'OS-4', 2)), ['OS-4', 'OS-2', 'OS-6']); // parked: offered anyway
});

test('wave: a round that started nothing is asked again from the top after each pause, a limited number of times', () => {
  const pauses = [60, 300];
  assert.equal(again(0, 9999, pauses), false); // the last wave started something, something runs, or no round is over
  assert.equal(again(1, 59, pauses), false);
  assert.equal(again(1, 60, pauses), true);
  assert.equal(again(2, 60, pauses), false);
  assert.equal(again(2, 300, pauses), true);
  assert.equal(again(3, 9999, pauses), false); // out of retries: the answer stands until the issues change
  assert.equal(again(1, 9999, []), false); // waveRetrySec: [] turns it off
});

test('wave: a waiting issue is shown with its blockers and their status, whatever its description says', () => {
  const i = { ...issue('APP-158', { fp: 'src/a.js', bb: ['APP-157', 'LIB-3'] }, ['mobile']), title: 'Screen', description: 'Waits for APP-157.' };
  assert.equal(offered(i, 'o/r', undefined, () => 'done'),
    '## APP-158 [o/r] Screen\nstatus: todo (not started); labels: mobile; footprint: src/a.js; blockers: APP-157 (done), LIB-3 (done)\nWaits for APP-157.');
  assert.equal(offered({ ...issue('OS-1', { fp: '' }), title: 'T', said: ['sergey: go'] }, 'o/r', { agent: 'worker' }, () => 'done'),
    '## OS-1 [o/r] T\nstatus: started earlier by worker, parked; labels: -; footprint: -; blockers: none\n' +
    '\nComments from people since (latest last; they may settle what the description leaves open):\n- sergey: go');
});

test('wave: the orchestrator sees what people commented, not the agents, latest last', () => {
  const c = (author, content, created_at) => ({ author, content, created_at });
  const cs = [c('sergey', 'second\n\nline', '2026-01-02'), c('agent', 'PR opened', '2026-01-03'), c('sergey', 'first', '2026-01-01')];
  assert.deepEqual(said(cs, 'agent'), ['sergey: first', 'sergey: second line']);
  assert.deepEqual(said(cs, 'agent', 1), ['sergey: second line']);
  assert.equal(said([c('sergey', 'x'.repeat(900), '2026-01-01')], 'agent')[0].length, 'sergey: '.length + 600);
  assert.deepEqual(said([], 'agent'), []);
});

test('a running agent hears comments newer than the last one it saw, not its own run\'s, oldest first', () => {
  const c = (id, author, content) => ({ id, author, content }), me = runMark('OS-1', 3);
  const cs = [c(9, 'sergey', 'also X'), c(8, 'agent', `PR opened\n\n${me}`), c(7, 'sergey', 'use Y'), c(5, 'sergey', 'old')];
  assert.deepEqual(news(cs, 5, me, 'agent'), { since: 9, said: ['sergey: use Y', 'sergey: also X'] });
  assert.deepEqual(news([c(8, 'agent', `PR opened\n\n${me}`)], 7, me, 'agent'), { since: 8, said: [] }); // its own comment only moves `since`
  assert.deepEqual(news(cs, 9, me, 'agent'), { since: 9, said: [] });
  assert.deepEqual(news([], 0, me, 'agent'), { since: 0, said: [] });
  // the agents share one tracker user: another issue's agent, or an earlier run of this one, is heard
  const other = c(10, 'agent', `not needed, cancelled\n\n${runMark('SPR-2', 1)}`);
  assert.deepEqual(news([other], 9, me, 'agent').said, [`agent: ${other.content}`]);
  assert.deepEqual(news([c(10, 'agent', `x\n\n${runMark('OS-1', 2)}`), c(11, 'agent', 'unmarked')], 9, me, 'agent').said.length, 2);
  assert.notEqual(news([c(10, 'agent', `x\n\n${runMark('OS-1', 31)}`)], 9, me, 'agent').said.length, 0); // run 31 is not run 3
  assert.equal(news([c(10, 'sergey', `quoting ${me}`)], 9, me, 'agent').said.length, 1); // a person is always heard
});

test('agents\' lific: marks the content of comment add, in every spelling, and nothing else', () => {
  const m = '<!-- m -->', x = 'hi\n\n<!-- m -->';
  assert.deepEqual(marked(['comment', 'add', 'OS-1', '--content=hi'], m), ['comment', 'add', 'OS-1', `--content=${x}`]);
  assert.deepEqual(marked(['comment', 'add', '--content', 'hi', 'OS-1'], m), ['comment', 'add', '--content', x, 'OS-1']);
  assert.deepEqual(marked(['--json', 'comment', 'add', 'OS-1', '-c', 'hi'], m), ['--json', 'comment', 'add', 'OS-1', '-c', x]);
  assert.deepEqual(marked(['comment', 'add', 'OS-1', '-chi'], m), ['comment', 'add', 'OS-1', `-c${x}`]);
  assert.deepEqual(marked(['comment', 'list', 'OS-1', '-c', 'hi'], m), ['comment', 'list', 'OS-1', '-c', 'hi']);
  assert.deepEqual(marked(['issue', 'create', '--description=hi'], m), ['issue', 'create', '--description=hi']);
  assert.deepEqual(marked(['comment', 'add', 'OS-1', '--content=hi'], undefined), ['comment', 'add', 'OS-1', '--content=hi']); // not in a run
});

test('agents\' lific wrapper: runs the tracker CLI on the HTTP backend with the run\'s mark, passes its exit code', async () => {
  const { mkdtempSync, writeFileSync, chmodSync, symlinkSync } = await import('node:fs'), { tmpdir } = await import('node:os'), { spawnSync } = await import('node:child_process');
  const dir = mkdtempSync(`${tmpdir()}/baton-lific-`), fake = `${dir}/real-lific.cjs`, wrap = `${dir}/lific`;
  // as baton lays it out: lific -> lific.cjs, in a directory under a "type": "module" package.json (state/ in baton's repo)
  writeFileSync(`${dir}/package.json`, '{ "type": "module" }');
  writeFileSync(fake, `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2))); process.exitCode = 3;\n`); chmodSync(fake, 0o755);
  writeFileSync(`${dir}/lific.cjs`, lificWrapper(process.execPath, fake)); chmodSync(`${dir}/lific.cjs`, 0o755); symlinkSync('lific.cjs', wrap);
  const r = spawnSync(wrap, ['comment', 'add', 'OS-1', '--content=it\'s "done"'], { env: { BATON_RUN: runMark('OS-1', 2) }, encoding: 'utf8' });
  assert.equal(r.status, 3);
  assert.deepEqual(JSON.parse(r.stdout), ['--backend', 'http', 'comment', 'add', 'OS-1', '--content=it\'s "done"\n\n<!-- baton OS-1 run 2 -->']);
});

test('inbox hook: hands the inbox to the main agent once (exit 2, stderr), leaves it to no sub-agent', async () => {
  const { mkdtempSync, writeFileSync, existsSync } = await import('node:fs'), { tmpdir } = await import('node:os'), { spawnSync } = await import('node:child_process');
  const dir = mkdtempSync(`${tmpdir()}/baton-inbox-`), hook = `${dir}/hook.cjs`, inbox = `${dir}/OS-1`;
  writeFileSync(hook, inboxHook(process.execPath));
  const fire = (input) => spawnSync(process.execPath, [hook], { input: JSON.stringify(input), env: { BATON_INBOX: inbox }, encoding: 'utf8' });
  assert.equal(fire({ hook_event_name: 'Stop' }).status, 0); // nothing queued: the turn may end
  writeFileSync(inbox, 'New comment on OS-1\nsergey: use Y\n');
  assert.equal(fire({ hook_event_name: 'PostToolUse', agent_id: 'a1' }).status, 0);
  const r = fire({ hook_event_name: 'PostToolUse' });
  assert.equal(r.status, 2); assert.equal(r.stderr, 'New comment on OS-1\nsergey: use Y\n'); assert.equal(existsSync(inbox), false);
  assert.equal(fire({ hook_event_name: 'Stop' }).status, 0);
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

test('cleanup kills what still runs in the worktree (cwd inside, or a path into it), in its own session; nothing else', async () => {
  const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const tmp = mkdtempSync(`${(await import('node:os')).tmpdir()}/baton-`), wt = `${tmp}/wt`, out = `${tmp}/out`;
  const nap = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  // setsid -f: a new session, and not our child (no zombie of ours keeps the pid)
  const bg = (cwd, name, ...args) => {
    execFileSync('setsid', ['-f', 'sh', '-c', `echo $$ > ${tmp}/${name}.n && mv ${tmp}/${name}.n ${tmp}/${name}.pid; exec "$@"`, 'sh', ...args], { cwd, stdio: 'ignore' });
    for (let i = 0; i < 100 && !existsSync(`${tmp}/${name}.pid`); i++) nap();
    return +readFileSync(`${tmp}/${name}.pid`, 'utf8');
  };
  const gone = (pid) => {
    for (let i = 0; i < 50; i++, nap()) if (!existsSync(`/proc/${pid}`) || readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1][0] === 'Z') return true;
    return false;
  };
  mkdirSync(wt); mkdirSync(out); writeFileSync(`${wt}/server.js`, 'setInterval(() => {}, 1000)');
  const inCwd = bg(wt, 'a', 'sleep', '60'), byPath = bg(out, 'b', process.execPath, `${wt}/server.js`), stray = bg(out, 'c', 'sleep', '60');
  const stubborn = bg(wt, 'd', process.execPath, '-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'); // SIGKILL after the grace
  try {
    assert.equal(reap(wt, 300), 3);
    for (const pid of [inCwd, byPath, stubborn]) assert.ok(gone(pid), `pid ${pid} still alive`);
    assert.ok(!gone(stray)); // outside the worktree: untouched
    assert.equal(reap(wt, 300), 0);
  } finally { try { process.kill(stray, 'SIGKILL'); } catch {} rmSync(tmp, { recursive: true, force: true }); }
});

test('milestone due: queue empty, base moved past the green commit, not tried yet, the last red fixed', () => {
  assert.equal(milestoneDue(true, 'b', 'a', null, false), true);
  assert.equal(milestoneDue(true, 'b', null, null, false), true); // no green commit yet
  assert.equal(milestoneDue(false, 'b', 'a', null, false), false); // something runs or waits
  assert.equal(milestoneDue(true, 'a', 'a', null, false), false); // green already
  assert.equal(milestoneDue(true, 'b', 'a', 'b', false), false); // this commit was tried
  assert.equal(milestoneDue(true, 'c', 'a', 'b', true), false); // an issue the last red filed is still open
  assert.equal(milestoneDue(true, null, 'a', null, false), false); // origin unreadable
});

test('milestone red: stage labels, the bisect verdict, the stage output, the issue', () => {
  const out = '\n== build\ncompile error: boom\nFAIL: build (279 ms)\n\n== lint\nok: lint (5 ms)\n' +
    '-- summary --\nok: lint\nFAIL: build\nFAIL: e2e\nFAIL: build\n\n2 stage(s) failed\n';
  assert.deepEqual(redStages(out, '^FAIL: (\\S+)'), ['build', 'e2e']);
  assert.deepEqual(redStages(out, undefined), []);
  assert.equal(excerpt(out, 'build'), '== build\ncompile error: boom\nFAIL: build (279 ms)');
  assert.equal(excerpt('a\nb', 'nope'), 'a\nb'); // not named: the tail
  const subjects = { '0123abcdef': 'APP-12: Faster parser', '0123abcd00': 'no key' };
  assert.deepEqual(culprit('Bisecting...\n0123abcdef is the first bad commit\ncommit 0123abcdef\n', (s) => subjects[s]),
    { sha: '0123abcdef', subject: 'APP-12: Faster parser', key: 'APP-12' });
  assert.equal(culprit('0123abcd00 is the first bad commit', (s) => subjects[s]).key, null);
  assert.equal(culprit('0123abcd00 is the first bad commit', () => null).subject, ''); // subject unreadable
  assert.equal(culprit('no first bad commit found', () => 'x'), null);
  const p = { base: 'main', milestone: { cmd: 'make milestone', tag: 'milestone-green' } };
  const f = fixIssue(p, '9'.repeat(40), 'build', { sha: '0123abcdef', subject: 'APP-12: x', key: 'APP-12' }, 'compile error: boom', ['m.log', 'b.log']);
  assert.equal(f.title, 'Milestone red: build since 0123abcdef (APP-12)');
  assert.match(f.description, /first bad commit: 0123abcdef APP-12: x\n- issue of that commit: APP-12/);
  assert.match(f.description, /`milestone-green` stays/);
  assert.match(f.description, /compile error: boom[\s\S]*Logs: m.log, b.log/);
  assert.equal(fixIssue(p, '9'.repeat(40), 'lint', null, '', []).title, 'Milestone red: lint');
  assert.match(fixIssue(p, '9'.repeat(40), null, null, 'timeout', ['m.log']).title, /without a red stage/);
});

test('land queue: in review with the land label, not for a person, board order, capped', () => {
  const r = (key, labels, status = 'in_review') => ({ ...issue(key, {}, labels), status });
  const all = [r('A-1', ['land']), r('A-2', []), r('A-3', ['land', 'needs-human']), r('A-4', ['land'], 'in_progress'), r('A-5', ['land']), r('A-6', ['land'])];
  assert.deepEqual(landable(all).map((i) => i.identifier), ['A-1', 'A-5', 'A-6']);
  assert.deepEqual(landable(all, 2).map((i) => i.identifier), ['A-1', 'A-5']);
});

test('land queue: a batch waits up to holdSec for the issues in work, not when nothing else runs or max are ready', () => {
  assert.equal(landDue(0, 0, false, 300), false); // nothing ready
  assert.equal(landDue(1, 0, false, 300), true); // nobody else could join: no wait
  assert.equal(landDue(1, 60, true, 300), false); // others in work: hold
  assert.equal(landDue(1, 300, true, 300), true); // held long enough
  assert.equal(landDue(5, 0, true, 300, 5), true); // a full batch does not wait
  assert.equal(landDue(1, 0, true), true); // no holdSec: as before
});

test('land queue: the batch is gated once when green; when red, its prefixes are bisected to the branch that turns it red', () => {
  // Simulate a batch of n branches where branch `bad` (1-based, 0 = none) turns the gate red; count the gate runs.
  const settle = (n, bad) => {
    let s = { g: 0, r: n + 1, k: n }, runs = 0;
    while (s.k != null) runs++, s = probe(s, !bad || s.k < bad);
    return { lands: s.g, back: s.r <= n ? s.r : null, runs };
  };
  assert.deepEqual(settle(4, 0), { lands: 4, back: null, runs: 1 }); // one gate for four branches
  assert.deepEqual(settle(1, 1), { lands: 0, back: 1, runs: 1 });
  assert.deepEqual(settle(4, 1), { lands: 0, back: 1, runs: 3 });
  assert.deepEqual(settle(4, 3), { lands: 2, back: 3, runs: 3 }); // A-1, A-2 land; A-4 waits for the next batch
  assert.deepEqual(settle(5, 5), { lands: 4, back: 5, runs: 4 });
  for (let n = 1; n <= 8; n++) for (let bad = 1; bad <= n; bad++) {
    const x = settle(n, bad);
    assert.equal(x.back, bad); assert.equal(x.lands, bad - 1);
    assert.ok(x.runs <= 1 + Math.ceil(Math.log2(n)));
  }
});

test('land queue: a bounced issue is told why, how to hand it over again, and the gate output', () => {
  const c = bounced('master', 'the gate is red', 'FAIL: x');
  assert.match(c, /^Bridge: not landed: the gate is red\./);
  assert.match(c, /`origin\/master`/); assert.match(c, /`in_review` with the label `land`/);
  assert.match(c, /```\nFAIL: x\n```/);
  assert.doesNotMatch(bounced('master', 'no branch'), /```/);
});

test('a one-shot model call has no tools and no MCP servers, so its single turn is the answer', () => {
  const a = oneShot('haiku');
  assert.deepEqual(a.slice(0, 5), ['-p', '--model', 'haiku', '--max-turns', '1']);
  assert.equal(a[a.indexOf('--tools') + 1], '');
  assert.ok(a.includes('--strict-mcp-config'));
});
