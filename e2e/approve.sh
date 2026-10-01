#!/usr/bin/env bash
# Human T5 approval (operator action): swap needs-human -> spec:approved.
M=$(dirname "$0")/../multica/m
$M issue label remove $1 fe741f31-ab0d-4461-b9f5-28b49bc8b822 >/dev/null; $M issue label add $1 b4550ea3-6169-45c8-91f4-4b292288cf52 >/dev/null; echo "approved $1 $(date -u +%T)"
