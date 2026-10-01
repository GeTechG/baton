#!/usr/bin/env bash
# Stop baton and the daemon (running agent tasks die with the daemon and are retried on next start).
# `down.sh --all` also stops the containers; data volumes are always kept.
R=$(cd "$(dirname "$0")/.." && pwd); cd "$R"
P=$(cat state/baton.pid 2>/dev/null); [ -n "$P" ] && kill "$P" 2>/dev/null; rm -f state/baton.pid
multica/m daemon stop
[ "${1:-}" = --all ] && docker compose -p baton -f multica/docker-compose.yml stop
exit 0
