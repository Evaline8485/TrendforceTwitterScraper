#!/bin/bash
export PATH="/usr/local/bin:/usr/bin:/bin:/Library/Frameworks/Python.framework/Versions/3.10/bin:$PATH"
cd /Users/elainekao/TrendforceTwitterScraper

# launchd's StandardOutPath/StandardErrorPath (com.elainekao.trendforce-daily)
# just append to cron.log forever with no rotation of its own - same gap
# TrendforceFacebookScraper/run_all.sh had before it got this same fix.
# Six runs/day here (every 4h) adds up; rotate once it crosses 5MB, keeping
# one prior generation rather than growing unbounded.
CRON_LOG="$(dirname "$0")/cron.log"
if [ -f "$CRON_LOG" ] && [ "$(stat -f%z "$CRON_LOG" 2>/dev/null || stat -c%s "$CRON_LOG" 2>/dev/null)" -gt 5242880 ]; then
  mv "$CRON_LOG" "$CRON_LOG.old"
fi

# The Mac sleeps between scheduled runs (nothing here ever disabled system
# sleep), so launchd's own StartCalendarInterval silently SKIPS a firing
# whenever the Mac is asleep at that exact time - found 2026-07-23 when the
# 04:30 run never appeared in this log at all. `pmset repeat` only holds
# ONE daily wake time, not all six of this job's slots, so instead each run
# schedules a ONE-TIME wake for whichever of the six slots comes next -
# scheduled right at the START of the run (before any scraping) so it
# still happens even if this run itself fails or crashes partway through.
# Requires passwordless sudo for `pmset schedule` (see sudoers setup note
# in the project's own docs/history) - without that, this just logs a
# warning and the run continues normally; it only affects whether the
# NEXT slot gets a wake scheduled, not this run.
schedule_next_wake() {
  local slots=("00:30:00" "04:30:00" "08:30:00" "12:30:00" "16:30:00" "20:30:00")
  local now_epoch today next_epoch candidate_epoch
  now_epoch=$(date +%s)
  today=$(date +%Y-%m-%d)
  for slot in "${slots[@]}"; do
    candidate_epoch=$(date -j -f "%Y-%m-%d %H:%M:%S" "$today $slot" "+%s" 2>/dev/null)
    if [ -n "$candidate_epoch" ] && [ "$candidate_epoch" -gt "$now_epoch" ]; then
      next_epoch="$candidate_epoch"
      break
    fi
  done
  if [ -z "$next_epoch" ]; then
    local tomorrow
    tomorrow=$(date -v+1d +%Y-%m-%d)
    next_epoch=$(date -j -f "%Y-%m-%d %H:%M:%S" "$tomorrow 00:30:00" "+%s")
  fi
  local wake_str
  wake_str=$(date -j -f "%s" "$next_epoch" "+%m/%d/%y %H:%M:%S")
  if sudo -n pmset schedule wake "$wake_str" 2>/dev/null; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Scheduled next wake at $wake_str"
  else
    echo "[WARN] Could not schedule next wake ($wake_str) - passwordless sudo for pmset isn't set up. See docs/history for the sudoers line needed."
  fi
}
schedule_next_wake

# schedule_next_wake above only fixes the Mac being fully asleep BEFORE this
# run's own start time - it does nothing once the run is actually in
# progress. Found 2026-07-27 (TrendforceFacebookScraper/run_all.sh): a run
# left unattended can drift into Deep Idle/Power Nap dark-wake cycling
# mid-scrape, throttling network access and making page loads/scrolls crawl
# for hours instead of minutes. caffeinate -i -w $$ blocks idle sleep for
# exactly this script's own lifetime (tied to our PID, so it exits on its
# own when we do); doesn't override a user-initiated sleep, only the
# automatic idle path.
caffeinate -i -w $$ &
disown

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting daily run..."

# Captured once, at the START of the run - found 2026-07-27: checking
# date +%H right before the watchlist/competitor gate (below) meant a slow
# mention/account scrape ahead of it could push the wall clock into the
# next hour before the gate ever ran, so the 00:30 slot's own watchlist
# scrape got silently skipped because it didn't finish evaluating the
# check until 08:18. This ties the gate to which SLOT triggered this run,
# not whatever hour happens to be current whenever execution reaches it.
RUN_HOUR=$(date +%H)

FAILURES=()

# Clear mention scraper cache so it does a fresh scrape each day
rm -f raw_tweets.json tf_reference.json

npm run scrape || { echo "[WARN] scrape failed"; FAILURES+=("mention scrape"); }

# Capture scrape:accounts output (while still streaming it to cron.log as
# before) so we can verify @TrendForce was actually attempted — checking
# "did the CSV change" isn't reliable, since a run with genuinely nothing
# new/updated for TrendForce in that window won't touch the file at all
# even though it scraped successfully.
ACCOUNTS_LOG=$(mktemp)
npm run scrape:accounts 2>&1 | tee "$ACCOUNTS_LOG"
ACCOUNTS_EXIT=${PIPESTATUS[0]:-$?}
if [ "$ACCOUNTS_EXIT" -ne 0 ]; then
  echo "[WARN] scrape:accounts failed"
  FAILURES+=("account scrape")
fi

if ! grep -q "@TrendForce: scraping recent tweets" "$ACCOUNTS_LOG" || grep -q "\[!\] @TrendForce failed" "$ACCOUNTS_LOG"; then
  echo "[WARN] @TrendForce wasn't successfully scraped this run — retrying it specifically..."
  node scrape_accounts.js @TrendForce
  if [ $? -ne 0 ]; then
    echo "[WARN] @TrendForce retry failed"
    FAILURES+=("TrendForce not scraped")
  fi
fi
rm -f "$ACCOUNTS_LOG"

# Watchlist/competitor scraping used to run every slot (6x/day, same as
# the rest of this script) - cut to once/day (2026-07-24) since neither
# changes fast enough to need a 4h refresh; only the 00:30 slot runs it,
# the other five slots skip straight to video-discovery.
if [ "$RUN_HOUR" = "00" ]; then
  npm run scrape:watchlist || { echo "[WARN] scrape:watchlist failed"; FAILURES+=("watchlist scrape"); }
  npm run scrape:competitors || { echo "[WARN] scrape:competitors failed"; FAILURES+=("competitor scrape"); }
else
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Skipping watchlist/competitor scrape (once/day, 00:30 slot only)."
fi
npm run scrape:video-discovery || { echo "[WARN] scrape:video-discovery failed"; FAILURES+=("video discovery scrape"); }

# Update and publish the dashboard to GitHub Pages
# (publish.sh sends its own alert on CSV-validation/push/deploy failures)
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Running publish..."
bash /Users/elainekao/TrendforceTwitterScraper/publish.sh || { echo "[ERROR] publish failed"; FAILURES+=("publish"); }

# TrendForceDash runs on its own independent schedule (0/4/6/8/12/16/18/20),
# not this repo's :30-past-the-hour schedule - a fresh scrape here could sit
# unsynced for hours until TrendForceDash's own next scheduled run. Sync and
# push it immediately after every run here instead of waiting.
#
# Backgrounded (not awaited): trendforce-daily is a single launchd Label with
# a fixed StartCalendarInterval (0:30/4:30/8:30/...) - launchd does NOT queue
# a missed firing while the previous instance of the same Label is still
# running, it just skips it. This chained sync occasionally took several
# hours (observed 2026-07-14: a run starting 00:44 didn't finish until
# ~09:32), which silently ate the 4:30 AND 8:30 firings entirely - nothing
# re-scraped tphuang (or anyone else) for ~9 hours, purely because this
# script itself hadn't returned yet. Running it detached lets run_daily.sh
# (and therefore the next scheduled scrape) finish on time regardless of how
# long the sync takes. run_pipeline.sh has its own independent
# FAILURES/alert.sh handling and logs to TrendForceDash/pipeline.log, so
# nothing here needs to wait for or re-check its result.
#
# nohup + disown alone are NOT enough under launchd (found the hard way,
# same day: the 16:30 run's backgrounded sync never even logged its first
# line). nohup only blocks SIGHUP; launchd's default behavior on a user
# LaunchAgent is to kill the ENTIRE process group the moment the tracked
# process (this script) exits, which kills the backgrounded child too since
# disown doesn't move it to a different process group. The actual fix is
# the plist's own <key>AbandonProcessGroup</key><true/> (added to
# com.elainekao.trendforce-daily.plist), which tells launchd to leave
# stragglers alone - nothing to change here, just don't remove the
# backgrounding above assuming it's self-sufficient without that plist key.
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Syncing TrendForceDash (backgrounded)..."
nohup bash -c '
  bash /Users/elainekao/TrendForceDash/run_pipeline.sh core
  bash /Users/elainekao/TrendForceDash/run_pipeline.sh accounts
' >> /Users/elainekao/TrendForceDash/pipeline.log 2>&1 &
disown

if [ ${#FAILURES[@]} -gt 0 ]; then
  JOINED=$(IFS=', '; echo "${FAILURES[*]}")
  bash alert.sh "TrendForce Daily Run — Issues" "Steps that failed: ${JOINED}. Check cron.log."
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Daily run complete."
