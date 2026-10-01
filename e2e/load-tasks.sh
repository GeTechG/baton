#!/usr/bin/env bash
# Load T1–T5 as a human would: todo, no footprint, no dependency; T5 gets gate:spec. Needs LIFIC_URL and LIFIC_API_KEY,
# projects `app` (prefix APP) and `lib` (LIB), and labels needs-human, gate:spec, spec:approved, in-review, fresh in APP.
set -euo pipefail
L="$(dirname "$0")/../bin/lific --backend http --json"
c() { $L issue create --project APP --status todo "--title=$1" "--description=$2" | jq -r .identifier; }
c "T1: add greet()" "Add \`export function greet(name)\` returning \`Hi, <name>!\` to src/a.js, with a test."
c "T2: add farewell()" "Add \`export function farewell(name)\` returning \`Farewell, <name>.\` to src/b.js, with a test."
c "T3: hello() -> 'Hello, <name>'" "Change \`hello()\` in src/a.js to return \`Hello, <name>\` (capital H + comma) and update its test."
c "T4: add area() via lib mul" "Add src/c.js with \`export function area(w, h)\` implemented via \`mul\` from vendor/lib/src/math.js (the lib submodule), with a test."
T5=$(c "T5: add shout()" "Add src/d.js with \`export function shout(s)\` returning s uppercased plus \`!\`, with a test. Requires human spec approval before implementation.")
$L issue update "$T5" --add-label gate:spec >/dev/null; echo "$T5 (gate:spec)"
