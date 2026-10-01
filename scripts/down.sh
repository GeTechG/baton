#!/usr/bin/env bash
# Stop baton. Agent runs are separate processes and finish on their own (baton picks their issues up again on the next
# start); `down.sh --all` also kills them — their sessions and worktrees stay, so they resume.
R=$(cd "$(dirname "$0")/.." && pwd); cd "$R"
P=$(cat state/baton.pid 2>/dev/null); [ -n "$P" ] && kill "$P" 2>/dev/null; rm -f state/baton.pid
[ "${1:-}" = --all ] && for p in $(jq -r '.[].pid // empty' state/runs.json 2>/dev/null); do kill -- "-$p" 2>/dev/null; done
exit 0
