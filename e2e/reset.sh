#!/usr/bin/env bash
# Reset both spike repos to the `baseline` tag: close/delete PRs' branches, delete issues, drop extra branches & labels.
set -euo pipefail
for R in GeTechG/orch-spike-app GeTechG/orch-spike-lib; do
  for n in $(gh pr list -R $R --state open --json number -q '.[].number'); do gh pr close -R $R $n --delete-branch >/dev/null || true; done
  for n in $(gh issue list -R $R --state all --limit 200 --json number -q '.[].number'); do gh issue delete -R $R $n --yes >/dev/null || true; done
  sha=$(gh api repos/$R/git/refs/tags/baseline -q .object.sha)
  gh api -X PATCH repos/$R/git/refs/heads/main -f sha=$sha -F force=true >/dev/null
  for b in $(gh api repos/$R/branches --paginate -q '.[].name' | grep -vx main); do gh api -X DELETE repos/$R/git/refs/heads/$b >/dev/null || true; done
  echo "reset $R -> $sha"
done
