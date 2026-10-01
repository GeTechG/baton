#!/usr/bin/env bash
# One-line status: issue key:status[:labels]. Needs LIFIC_URL and LIFIC_API_KEY.
L="$(dirname "$0")/../bin/lific --backend http --json"
for p in APP LIB; do $L issue list -p $p --limit 100 | jq -r '[.[] | "\(.identifier):\(.status)\(if .labels|length>0 then ":"+(.labels|join("+")) else "" end)"] | join(" ")'; done
