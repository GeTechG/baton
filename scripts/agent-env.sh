#!/usr/bin/env bash
# Re-inject GH_TOKEN from baton/.env into every agent' custom env (run after rotating the token). Prints key names only.
set -euo pipefail
R=$(cd "$(dirname "$0")/.." && pwd); cd "$R"; umask 077; mkdir -p state
( set -a; . ./.env; set +a; jq -n '{GH_TOKEN: env.GH_TOKEN, GIT_TERMINAL_PROMPT: "0"}' >state/agent-env.json )
for a in $(jq -r '[.projects[].agent]|unique[]' config.json); do
  multica/m agent env set "$a" --custom-env-file state/agent-env.json --output json | jq -c 'keys'
done
