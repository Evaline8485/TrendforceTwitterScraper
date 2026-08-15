#!/bin/bash
# Run after a scrape: validates data, generates docs/index.html, and pushes
# to GitHub Pages with retry/backoff around both git push and the Pages
# deployment itself (GitHub Pages deployments race and fail if two pushes
# land within seconds of each other — this detects that and auto-redeploys
# instead of needing manual intervention).

cd "$(dirname "$0")"

notify() { bash alert.sh "$1" "$2"; }

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting publish..."

# 0. Validate account CSVs before touching git — a corrupt/truncated CSV
#    (e.g. a scraper crash mid-write) must never get silently committed
#    and published, which is exactly what happened on 2026-07-03.
if ! python3 validate_csv.py; then
  notify "TrendForce Publish FAILED" "CSV validation failed — a corrupt scrape was blocked before publish. Check terminal/cron.log."
  exit 1
fi

set -e

# 1. Re-run engagement analysis so the JSON is fresh
python3 analyze_engagement.py

# 1a. FR-01: recluster competitor topics and update the gap list
python3 cluster_topics.py

# 2. Generate docs/index.html from the JSON
python3 generate_dashboard.py

# 3. Stage and commit the dashboard HTML and topic-cluster output
git add docs/index.html analysis/topic_clusters.json
if git diff --cached --quiet; then
  echo "Nothing changed in docs/index.html, skipping push."
  exit 0
fi

git commit -m "Weekly dashboard update $(date '+%Y-%m-%d')"

set +e  # from here on, handle failures ourselves instead of dying on the first one

# 4. Push with retry + backoff. Handles transient failures (network blips,
#    remote moved on — rebase and retry) as well as outright auth errors
#    (reported clearly, since those need a human to fix credentials).
PUSH_OK=0
for attempt in 1 2 3; do
  PUSH_OUTPUT=$(git push 2>&1)
  if [ $? -eq 0 ]; then
    PUSH_OK=1
    break
  fi
  echo "$PUSH_OUTPUT"
  if echo "$PUSH_OUTPUT" | grep -qi "authentication failed\|invalid username or token"; then
    notify "TrendForce Publish FAILED" "git push auth failed — GitHub credentials need to be refreshed."
    echo "[ERROR] Authentication failure — not retrying, this needs manual credential setup."
    exit 1
  fi
  # Only rebase if the remote actually moved on (rejected/non-fast-forward).
  # A plain network/DNS failure needs nothing but a retry — attempting
  # `git pull --rebase` unconditionally fails whenever the working tree has
  # any of the scraped-data files (csv/, analysis/) sitting uncommitted,
  # which is most of the time since publish.sh only ever commits
  # docs/index.html. That masked the real error behind a useless "you have
  # unstaged changes" on every retry, guaranteeing failure regardless of
  # whether the outage had cleared (seen repeatedly: 2026-07-09, 07-17, 07-21).
  if echo "$PUSH_OUTPUT" | grep -qi "rejected\|non-fast-forward\|fetch first"; then
    echo "[WARN] git push failed (attempt $attempt/3), remote has diverged — rebasing and retrying..."
    git pull --rebase 2>&1
  else
    echo "[WARN] git push failed (attempt $attempt/3), likely transient (network) — retrying without rebase..."
  fi
  sleep $((attempt * 5))
done

if [ "$PUSH_OK" -ne 1 ]; then
  notify "TrendForce Publish FAILED" "git push failed after 3 attempts. Check cron.log."
  echo "[ERROR] git push failed after 3 attempts."
  exit 1
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Pushed. Watching GitHub Pages deployment..."

# 5. Watch the resulting GitHub Pages deployment. Two pushes landing within
#    seconds of each other cause GitHub to race two deployments — one gets
#    cancelled cleanly, but the other sometimes fails outright instead of
#    just being superseded. Detect that and auto-redeploy with an empty
#    commit instead of leaving the site stale until someone notices.
#
# Matches runs by exact head_sha (not just "the latest push run"), since
# querying too soon after a push can return a stale previous run and cause
# a false "failure" — the earlier version of this script did that and kept
# redeploying on top of runs that had actually already succeeded.
REPO="Evaline8485/TrendforceTwitterScraper"

wait_for_run_conclusion() {
  # $1 = commit SHA to match. Polls up to ~3 minutes. Echoes the conclusion
  # ("success", "failure", "cancelled", "ratelimited", or "" if it never
  # showed up/finished). Unauthenticated GitHub API calls are capped at
  # 60/hour — at one push/day this is a non-issue, but detect it explicitly
  # so a rate-limit response never gets misread as a real deploy failure
  # and triggers a pointless redeploy loop.
  local sha="$1"
  for i in $(seq 1 12); do
    sleep 15
    local raw
    # No &event=push filter here on purpose: GitHub's Pages build-and-deploy
    # workflow runs under event type "dynamic", not "push" — filtering by
    # push silently excluded every run and made this always time out, even
    # on deploys that had actually succeeded (found 2026-07-06).
    raw=$(curl -s "https://api.github.com/repos/${REPO}/actions/runs?per_page=10")
    if echo "$raw" | grep -qi "API rate limit exceeded"; then
      echo "ratelimited"
      return
    fi
    local run
    run=$(echo "$raw" | python3 -c "
import json, sys
sha = sys.argv[1]
try:
    d = json.load(sys.stdin)
except ValueError:
    sys.exit(0)
for r in d.get('workflow_runs', []):
    if r.get('head_sha') == sha:
        print(r.get('status',''), r.get('conclusion') or '')
        break
" "$sha")
    local run_status="${run%% *}"
    local run_conclusion="${run#* }"
    if [ "$run_status" = "completed" ]; then
      echo "$run_conclusion"
      return
    fi
  done
  echo ""  # timed out without finding a completed run for this SHA
}

DEPLOY_OK=0
for redeploy_attempt in 1 2 3; do
  SHA=$(git rev-parse HEAD)
  CONCLUSION=$(wait_for_run_conclusion "$SHA")

  if [ "$CONCLUSION" = "success" ]; then
    DEPLOY_OK=1
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Deployment succeeded (commit ${SHA:0:7})."
    break
  fi

  if [ "$CONCLUSION" = "ratelimited" ]; then
    echo "[WARN] GitHub API rate limit hit while checking deploy status — can't confirm, but the push itself succeeded. Skipping further checks."
    DEPLOY_OK=1  # don't treat our own inability to check as a deploy failure
    break
  fi

  echo "[WARN] Deployment for commit ${SHA:0:7} concluded '$CONCLUSION' (attempt $redeploy_attempt/3)."
  if [ "$redeploy_attempt" -lt 3 ]; then
    echo "  Backing off before redeploying..."
    sleep 20
    git commit --allow-empty -m "Redeploy dashboard (previous deploy: ${CONCLUSION:-timeout})" >/dev/null
    git push >/dev/null 2>&1
  fi
done

if [ "$DEPLOY_OK" -ne 1 ]; then
  notify "TrendForce Publish WARNING" "GitHub Pages deploy did not confirm success after 3 attempts. Check the Actions tab."
  echo "[WARN] Could not confirm a successful deployment after 3 attempts. Site may be stale — check Actions tab manually."
  exit 1
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Done. Dashboard pushed and deployed to GitHub Pages."
