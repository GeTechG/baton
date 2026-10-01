#!/usr/bin/env node
// Live view of what the agents are doing: one line per tool call / message of every in-flight run in the
// configured projects, plus baton's own decisions (new lines of <stateDir>/bridge.log). Read-only; run it in a
// spare terminal pane: `node watch.mjs`. Uses config.json ($BATON_CONFIG) only for the multica CLI and stateDir.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const CFG = JSON.parse(readFileSync(process.env.BATON_CONFIG ?? resolve(ROOT, 'config.json'), 'utf8'));
const BIN = resolve(ROOT, CFG.multica.bin), LOG = resolve(ROOT, CFG.stateDir ?? 'state', 'bridge.log');
const mj = (...a) => JSON.parse(execFileSync(BIN, ['--profile', CFG.multica.profile, '--server-url', CFG.multica.server, ...a, '--output', 'json'],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64e6 }) || 'null');
const c = (n, s) => (process.stdout.isTTY ? `\x1b[${n}m${s}\x1b[0m` : s);
const one = (s, n = 160) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

export function line(key, m) { // one run message -> one printable line (null = not worth showing)
  const t = (m.created_at ?? '').slice(11, 19), i = m.input ?? {};
  if (m.type === 'tool_use') return `${c(2, t)} ${c(36, key)} ${c(33, m.tool ?? 'tool')} ${one(i.description ?? i.command ?? i.file_path ?? i.pattern ?? i.prompt ?? JSON.stringify(i))}`;
  if (m.type === 'tool_result') return /error|failed|✖|exit code [1-9]/i.test(String(m.output ?? '').slice(0, 400)) ? `${c(2, t)} ${c(36, key)} ${c(31, '  ✖ ' + one(m.output, 140))}` : null;
  const text = one(m.content ?? m.text ?? m.output, 300);
  return text ? `${c(2, t)} ${c(36, key)} ${c(1, text)}` : null;
}

async function main() {
  const seen = new Map(); // run id -> last seq
  let logPos = existsSync(LOG) ? statSync(LOG).size : 0;
  console.log(c(2, `baton watch — ${CFG.multica.server} — Ctrl+C to quit`));
  for (;; await new Promise((r) => setTimeout(r, 3000))) {
    try {
      if (existsSync(LOG) && statSync(LOG).size > logPos) {
        const buf = readFileSync(LOG, 'utf8'); // bridge.log is small; re-read and slice
        for (const l of buf.slice(logPos).split('\n').filter(Boolean)) console.log(c(35, `baton  ${l}`));
        logPos = buf.length;
      }
      const busy = mj('issue', 'list', '--limit', '100').issues.filter((i) => i.assignee_type === 'agent' && !['done', 'cancelled'].includes(i.status));
      for (const i of busy) {
        for (const r of mj('issue', 'runs', i.identifier, '--active')) {
          const msgs = mj('issue', 'run-messages', r.id, '--since', String(seen.get(r.id) ?? 0)) ?? [];
          if (!seen.has(r.id)) console.log(c(32, `▶ ${i.identifier} ${one(i.title, 80)} — run ${r.id.slice(0, 8)} (${r.status})`));
          for (const m of seen.has(r.id) ? msgs : msgs.slice(-15)) { const l = line(i.identifier, m); if (l) console.log(l); } // joining mid-run: recent tail only
          seen.set(r.id, msgs.length ? Math.max(...msgs.map((m) => m.seq ?? 0), seen.get(r.id) ?? 0) : seen.get(r.id) ?? 0);
        }
      }
    } catch (e) { console.log(c(31, `watch error: ${one(e.message, 120)}`)); }
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
