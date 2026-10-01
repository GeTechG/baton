#!/usr/bin/env bash
# Load T1–T5 as a human would: unassigned, no footprint, no dependency; T5 gets gate:spec.
set -euo pipefail
M=$(dirname "$0")/../multica/m; APP=c7a6a839-58da-4a66-b1d4-a9c3e0eb4c95
c() { $M issue create --project $APP --status todo --title "$1" --description "$2" --output json | jq -r .identifier; }
c "T1: add greet()" "Add \`export function greet(name)\` returning \`Hi, <name>!\` to src/a.js, with a test."
c "T2: add farewell()" "Add \`export function farewell(name)\` returning \`Farewell, <name>.\` to src/b.js, with a test."
c "T3: hello() -> 'Hello, <name>'" "Change \`hello()\` in src/a.js to return \`Hello, <name>\` (capital H + comma) and update its test."
c "T4: add area() via lib mul" "Add src/c.js with \`export function area(w, h)\` implemented via \`mul\` from vendor/lib/src/math.js (the lib submodule), with a test."
T5=$(c "T5: add shout()" "Add src/d.js with \`export function shout(s)\` returning s uppercased plus \`!\`, with a test. Requires human spec approval before implementation.")
$M issue label add $T5 b79bc9be-b2fe-4315-bcff-246ee152a357 >/dev/null; echo "$T5 (gate:spec)"
