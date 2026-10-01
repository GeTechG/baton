#!/usr/bin/env bash
# Start the baton instance (idempotent): Multica stack -> daemon -> baton loop. Logs: state/baton.out, state/bridge.log,
# ~/.multica/profiles/baton/daemon.log. Stop with scripts/down.sh (volumes are kept; never `compose down -v`).
set -euo pipefail
R=$(cd "$(dirname "$0")/.." && pwd); cd "$R"; mkdir -p state
# Started from inside an agent/Herdr session? Don't leak that session (or a personal token) into agent runs:
# agents get GH_TOKEN from their Multica custom env only; baton itself uses the machine's `gh` login.
for v in $(compgen -e | grep -E '^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_PID$|CLAUDE_EFFORT$|CLAUDE_PLUGIN_|HERDR_|GH_TOKEN$|GITHUB_TOKEN$)' || true); do unset "$v"; done
docker compose -p baton -f multica/docker-compose.yml up -d
until curl -fsS -m 3 localhost:8080/health >/dev/null 2>&1; do sleep 2; done
# GC must not drop untracked files (dependency symlinks) in the task dirs of parked issues; server and CLI are pinned, so no self-update.
export MULTICA_GC_ARTIFACT_TTL=0 MULTICA_DAEMON_MAX_CONCURRENT_TASKS=4 MULTICA_DAEMON_AUTO_UPDATE=false MULTICA_DAEMON_AUTO_RELOAD=false
multica/m daemon status 2>&1 | grep -q running || multica/m daemon start
if ! kill -0 "$(cat state/baton.pid 2>/dev/null)" 2>/dev/null; then
  setsid nohup node baton.mjs >>state/baton.out 2>&1 </dev/null & echo $! >state/baton.pid
fi
exec "$R/scripts/status.sh"
