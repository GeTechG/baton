#!/usr/bin/env bash
# Create the base agents (agents/*.json) the workspace does not have yet; an existing agent with that name is left as is.
# Then gives every agent GH_TOKEN (agent-env.sh). baton finds the orchestrator by its name, so config.json needs no id.
set -euo pipefail
R=$(cd "$(dirname "$0")/.." && pwd); cd "$R"
have=$(multica/m agent list --output json); rts=$(multica/m runtime list --output json)
for f in agents/*.json; do
  n=$(jq -r .name "$f"); p=$(jq -r .provider "$f")
  if jq -e --arg n "$n" 'all(.[]; .name!=$n)' <<<"$have" >/dev/null; then
    rt=$(jq -r --arg p "$p" '[.[]|select(.provider==$p)][0].id // empty' <<<"$rts")
    [ -n "$rt" ] || { echo "$n: no $p runtime (is the daemon running?)" >&2; exit 1; }
    multica/m agent create --name "$n" --runtime-id "$rt" --model "$(jq -r .model "$f")" \
      --max-concurrent-tasks "$(jq -r .max_concurrent_tasks "$f")" --description "$(jq -r .description "$f")" \
      --instructions "$(jq -r .instructions "$f")" --output json | jq -r '"created \(.name) \(.id)"'
  fi
done
exec scripts/agent-env.sh
