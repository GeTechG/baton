#!/usr/bin/env bash
R=$(cd "$(dirname "$0")/.." && pwd); cd "$R"
URL=$(jq -r .lific.url config.json)
curl -fsS -m 3 -o /dev/null "$URL/" && echo "tracker: up ($URL)" || echo "tracker: DOWN ($URL)"
P=$(cat state/baton.pid 2>/dev/null); kill -0 "$P" 2>/dev/null && echo "baton: running (pid $P)" || echo "baton: stopped"
jq -r 'to_entries[] | "\(.key): run #\(.value.n) pid \(.value.pid) \(.value.wt)"' state/runs.json 2>/dev/null | while read -r l; do
  kill -0 "$(sed -E 's/.* pid ([0-9]+) .*/\1/' <<<"$l")" 2>/dev/null && echo "agent $l" || true
done
tail -n 5 state/bridge.log 2>/dev/null
