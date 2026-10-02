#!/usr/bin/env bash
# First-time setup of a single-machine instance (idempotent: every step is skipped if already done), then starts it.
# Needs docker, gh (logged in), jq, node, and .env with GH_TOKEN=<the token agents push with>. After it: create one
# Multica project per repo, list them in config.json. Day to day: scripts/up.sh, scripts/down.sh.
set -euo pipefail
R=$(cd "$(dirname "$0")/.." && pwd); cd "$R"
[ -f .env ] || { echo "write GH_TOKEN=... into $R/.env first" >&2; exit 1; }
[ -f multica/.env ] || sed "s/^JWT_SECRET=.*/JWT_SECRET=$(openssl rand -hex 32)/" multica/.env.example >multica/.env
if [ ! -x multica/bin/multica ]; then
  a=$(uname -m); a=${a/x86_64/amd64}; a=${a/aarch64/arm64}; mkdir -p multica/bin
  # ponytail: latest CLI release; pin it together with MULTICA_IMAGE_TAG in multica/.env if the two drift apart.
  gh release download -R multica-ai/multica -p "multica-cli-*-$(uname -s | tr A-Z a-z)-$a.tar.gz" -O - | tar -xz -C multica/bin multica
fi
[ -f config.json ] || echo '{ "multica": { "bin": "multica/bin/multica", "profile": "baton", "server": "http://localhost:8080" }, "projects": {} }' >config.json
docker compose -p baton -f multica/docker-compose.yml up -d
until curl -fsS -m 3 localhost:8080/health >/dev/null 2>&1; do sleep 2; done
if ! multica/m agent list >/dev/null 2>&1; then
  echo "Log in: the browser asks for an email, the one-time code is printed by scripts/login-code.sh (other terminal)."
  multica/m login
fi
scripts/up.sh
until multica/m runtime list --output json | jq -e 'length>0' >/dev/null; do sleep 2; done # the daemon registers its runtimes
exec scripts/agents.sh
