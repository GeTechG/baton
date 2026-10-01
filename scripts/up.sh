#!/usr/bin/env bash
# Start the baton instance (idempotent): check the tracker, then the baton loop. Logs: state/baton.out, state/bridge.log,
# state/logs/<KEY>.log (one per issue). Stop with scripts/down.sh. The tracker is not ours to start: `lific init`
# installs it as a user service that survives reboots (`lific service status`).
set -euo pipefail
R=$(cd "$(dirname "$0")/.." && pwd); cd "$R"; mkdir -p state
# Started from inside an agent/Herdr session? Don't leak that session (or a personal token) into agent runs: baton
# uses the machine's `gh` login and LIFIC_API_KEY; agents get the AGENT_* values of .env with the prefix dropped.
for v in $(compgen -e | grep -E '^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_PID$|CLAUDE_EFFORT$|CLAUDE_PLUGIN_|HERDR_|GH_TOKEN$|GITHUB_TOKEN$)' || true); do unset "$v"; done
set -a; . ./.env; set +a
URL=$(jq -r .lific.url config.json)
curl -fsS -m 3 "$URL/api/projects" -H "Authorization: Bearer $LIFIC_API_KEY" >/dev/null || { echo "tracker not reachable at $URL (lific service status)"; exit 1; }
if ! kill -0 "$(cat state/baton.pid 2>/dev/null)" 2>/dev/null; then
  setsid nohup node baton.mjs >>state/baton.out 2>&1 </dev/null & echo $! >state/baton.pid
fi
exec "$R/scripts/status.sh"
