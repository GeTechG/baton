#!/usr/bin/env node
// Live view of what the agents are doing: one line per tool call / message of every agent run (new lines of
// <stateDir>/logs/<KEY>.log, the agent CLI's stream-json output), plus baton's own decisions (new lines of
// <stateDir>/bridge.log). Read-only; run it in a spare terminal pane: `node watch.mjs`.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const c = (n, s) => (process.stdout.isTTY ? `\x1b[${n}m${s}\x1b[0m` : s);
const one = (s, n = 160) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const text = (x) => (Array.isArray(x) ? x.map((b) => b.text ?? '').join(' ') : x);

export function lines(key, raw, t) { // one log line (a stream-json event, or anything else printed raw) -> printable lines
  const at = `${c(2, t)} ${c(36, key)}`;
  let ev; try { ev = JSON.parse(raw); } catch { return one(raw) ? [`${at} ${one(raw, 300)}`] : []; }
  return (ev.message?.content ?? []).flatMap((b) => {
    const i = b.input ?? {};
    if (b.type === 'tool_use') return [`${at} ${c(33, b.name ?? 'tool')} ${one(i.description ?? i.command ?? i.file_path ?? i.pattern ?? i.prompt ?? JSON.stringify(i))}`];
    if (b.type === 'tool_result') return b.is_error ? [`${at} ${c(31, '  ✖ ' + one(text(b.content), 140))}`] : [];
    return b.type === 'text' && one(b.text) ? [`${at} ${c(1, one(b.text, 300))}`] : [];
  });
}

async function main() {
  const CFG = JSON.parse(readFileSync(process.env.BATON_CONFIG ?? resolve(ROOT, 'config.json'), 'utf8'));
  const DIR = resolve(ROOT, CFG.stateDir ?? 'state'), pos = new Map(); // file -> bytes already shown
  const fresh = (f) => { // text appended since the last look; a file first seen mid-run starts at its end
    if (!existsSync(f)) return '';
    const size = statSync(f).size, from = pos.get(f) ?? size;
    pos.set(f, size);
    return size > from ? readFileSync(f).subarray(from).toString('utf8') : '';
  };
  console.log(c(2, `baton watch — ${DIR} — Ctrl+C to quit`));
  for (;; await new Promise((r) => setTimeout(r, 3000))) {
    try {
      for (const l of fresh(`${DIR}/bridge.log`).split('\n').filter(Boolean)) console.log(c(35, `baton  ${l}`));
      for (const f of existsSync(`${DIR}/logs`) ? readdirSync(`${DIR}/logs`).filter((x) => x.endsWith('.log')) : []) {
        const t = new Date().toTimeString().slice(0, 8);
        for (const raw of fresh(`${DIR}/logs/${f}`).split('\n').filter(Boolean)) for (const l of lines(f.slice(0, -4), raw, t)) console.log(l);
      }
    } catch (e) { console.log(c(31, `watch error: ${one(e.message, 120)}`)); }
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
