#!/usr/bin/env bash
# Human T5 approval (operator action): swap needs-human -> spec:approved. Needs LIFIC_URL and LIFIC_API_KEY (the human's).
L="$(dirname "$0")/../bin/lific --backend http"
$L issue update "$1" --remove-label needs-human --add-label spec:approved >/dev/null; echo "approved $1 $(date -u +%T)"
