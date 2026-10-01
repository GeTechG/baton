#!/usr/bin/env bash
# One-line status: issue key:status:assignee(active runs)
M=$(dirname "$0")/../multica/m
$M issue list --limit 100 --output json | jq -r '[.issues[] | select(.number>=6) | "\(.identifier):\(.status):\(if .assignee_id then "A" else "-" end)"] | join(" ")'
