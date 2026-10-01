#!/usr/bin/env bash
R=$(cd "$(dirname "$0")/.." && pwd); cd "$R"
docker compose -p baton -f multica/docker-compose.yml ps --format '{{.Service}}: {{.Status}}'
multica/m daemon status 2>&1 | head -5
P=$(cat state/baton.pid 2>/dev/null); kill -0 "$P" 2>/dev/null && echo "baton: running (pid $P)" || echo "baton: stopped"
tail -n 5 state/bridge.log 2>/dev/null
echo "UI http://localhost:3000  API http://localhost:8080"
