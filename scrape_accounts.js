require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { toTaiwanISOString } = require('./tz_util');

const SESSION_FILE = path.join(__dirname, 'session.json');
const CSV_DIR = path.join(__dirname, 'csv');
const FOLLOWER_HISTORY_FILE = path.join(__dirname, 'follower_history.json');
fs.mkdirSync(CSV_DIR, { recursive: true });

// Locking: scrapeOneAccount() reads a whole CSV, computes changes, then
// writes the whole file back with fs.writeFileSync - a classic
// read-modify-write race if two invocations run concurrently against the
// same account. Observed directly 2026-07-16: a manual `node
// scrape_accounts.js @TrendForce` overlapped with the scheduled run's own
// (unscoped) invocation, both starting from the same "591 existing
// tweets" baseline and each writing csv/TrendForce.csv independently -
// whichever finished last silently discarded the other's update, with no
// error or warning either way. A lock on run_daily.sh itself wouldn't
// have caught this: launchd already guarantees a single Label can't
// overlap with itself (confirmed earlier the same day - a missed
// StartCalendarInterval firing is skipped, not queued), so two *scheduled*
// runs can't collide - the actual gap is a manual/ad-hoc invocation (like
// this one) running alongside a scheduled one, which bypasses run_daily.sh
// entirely. Locking here instead, at the actual point of collision,
// covers every caller (manual or scheduled) the same mkdir-mutex way as
// TrendForceDash's run_pipeline.sh and TrendforceFacebookScraper's
// run_all.sh.
const LOCK_DIR = path.join(__dirname, '.scrape_accounts.lock');
const LOCK_STALE_AFTER_MS = 30 * 60 * 1000; // 30min - a full 8-account run normally takes a few minutes

function releaseLock() {
  try { fs.rmdirSync(LOCK_DIR); } catch {}
}
// process.exit() (used below on a failed login check) skips any pending
// try/finally - this is the safety net that still releases the lock then.
process.on('exit', releaseLock);

async function acquireLock() {
  // Staleness must be judged by the lock DIRECTORY's own age (its mtime
  // from when mkdirSync created it), not by how long THIS waiter has been
  // polling - a per-waiter timer conflates "how long have I waited" (which
  // can span several different legitimate holders in sequence) with "how
  // long has the CURRENT holder had it" (found as a real bug in
  // TrendForceDash's run_pipeline.sh lock 2026-07-17: a long-queued waiter
  // stole the lock from a still-actively-running job).
  while (true) {
    try {
      fs.mkdirSync(LOCK_DIR);
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const lockAgeMs = Date.now() - fs.statSync(LOCK_DIR).mtimeMs;
      if (lockAgeMs >= LOCK_STALE_AFTER_MS) {
        console.log(`[WARN] scrape_accounts: lock directory is ${Math.round(lockAgeMs / 1000)}s old - assuming a crashed run left it behind, taking over`);
        releaseLock();
        try { fs.mkdirSync(LOCK_DIR); return; } catch {}
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

function parseFollowerCount(str) {
  if (!str || str === 'unknown') return null;
  str = str.replace(/,/g, '').trim();
  if (str.endsWith('K')) return Math.round(parseFloat(str) * 1000);
  if (str.endsWith('M')) return Math.round(parseFloat(str) * 1000000);
  return parseInt(str) || null;
}

function recordFollowers(handle, count) {
  const history = fs.existsSync(FOLLOWER_HISTORY_FILE)
    ? JSON.parse(fs.readFileSync(FOLLOWER_HISTORY_FILE, 'utf8'))
    : {};
  if (!history[handle]) history[handle] = [];
  // Taiwan date, not UTC — using UTC here meant the once-per-day guard
  // treated "today" as still the previous day until 8 AM Taiwan time
  // (UTC+8), so the very first run of the Taiwan morning would silently
  // skip recording, thinking it already had today's entry.
  const today = toTaiwanISOString(new Date().toISOString()).slice(0, 10);
  // Only record once per day
  if (!history[handle].length || history[handle][history[handle].length - 1].date !== today) {
    history[handle].push({ date: today, followers: count });
    fs.writeFileSync(FOLLOWER_HISTORY_FILE, JSON.stringify(history, null, 2));
    console.log(`  Followers recorded: ${count.toLocaleString()}`);
  }
}

async function scrapeFollowers(page, handle) {
  const cleanHandle = handle.replace('@', '');
  try {
    await page.goto(`https://x.com/${cleanHandle}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    const count = await page.evaluate(() => {
      // X no longer wraps the follower count in an <a href="/followers"> link —
      // it's now plain text like "5,242 Followers" (link target is /verified_followers).
      const match = document.body.innerText.match(/([\d,.]+[KMB]?)\s*Followers/i);
      return match ? match[1] : null;
    });
    return parseFollowerCount(count);
  } catch (e) {
    console.warn(`  Could not scrape followers for ${handle}:`, e.message);
    return null;
  }
}

// Read from TrendForceDash's accounts_config.json (own + competitors)
// rather than keeping a second, separately-maintained handle list here -
// found 2026-07-27: nvidianewsroom and FT were added to accounts_config.json
// (via add_account.py) but never made it into this file's own hardcoded
// array, so they silently never got scraped despite showing as "tracked"
// everywhere else. Same cross-repo absolute-path read already used by
// scrape_video_discovery.js for TrendForceDash's fuzzy_trends_1d.json.
// Derived relative to this file (sibling repo) rather than a hardcoded
// absolute path - see TrendForceDash/add_account.py's matching comment.
const ACCOUNTS_CONFIG_FILE = path.join(__dirname, '..', 'TrendForceDash', 'accounts_config.json');
function loadAllAccounts() {
  const cfg = JSON.parse(fs.readFileSync(ACCOUNTS_CONFIG_FILE, 'utf8'));
  const x = cfg.X || {};
  return [...(x.own || []), ...(x.competitors || [])].map((h) => `@${h.replace(/^@/, '')}`);
}
const ALL_ACCOUNTS = loadAllAccounts();
// Optional: `node scrape_accounts.js @Handle1 @Handle2` scrapes only those
// accounts (used by run_daily.sh to retry just @TrendForce if it got missed
// earlier in a run). No handle args = scrape everything, as before.
const requestedHandles = process.argv.slice(2).filter(a => a.startsWith('@'));
const INDIVIDUAL_ACCOUNTS = requestedHandles.length ? requestedHandles : ALL_ACCOUNTS;

function enrichTweets(tweets) {
  try {
    const output = execSync('python3 enrich_accounts.py', {
      input: JSON.stringify(tweets),
      cwd: __dirname,
      maxBuffer: 20 * 1024 * 1024,
    });
    return JSON.parse(output.toString());
  } catch (e) {
    console.warn('Enrichment failed:', e.message);
    return tweets.map(t => ({ ...t, keywords: '', language: 'unknown', translatedText: '' }));
  }
}

const safe = (s) => `"${String(s ?? '').replace(/"/g, '""').replace(/\n/g, ' ')}"`;

// Parses one CSV line into raw fields, preserving quotes so a field can be
// reassigned and the row rejoined with `.join(',')` without re-escaping.
function parseCsvLine(line) {
  const cols = [];
  let i = 0;
  const n = line.length;
  while (i <= n) {
    if (line[i] === '"') {
      let j = i + 1, val = '"';
      while (j < n) {
        if (line[j] === '"' && line[j + 1] === '"') { val += '""'; j += 2; }
        else if (line[j] === '"') { val += '"'; j++; break; }
        else { val += line[j]; j++; }
      }
      cols.push(val);
      i = j + 1;
    } else {
      let j = line.indexOf(',', i);
      if (j === -1) j = n;
      cols.push(line.slice(i, j));
      i = j + 1;
    }
  }
  return cols;
}

const unquote = (s) => (s || '').replace(/^"|"$/g, '').replace(/""/g, '"');

const UPDATE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

async function scrapeTimeline(page, handle, maxScrolls = 15) {
  const cleanHandle = handle.replace('@', '');
  console.log(`\nScraping timeline for ${handle}...`);
  await page.goto(`https://x.com/${cleanHandle}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);

  // Retry up to 3 times if Twitter shows "Something went wrong"
  for (let attempt = 0; attempt < 3; attempt++) {
    const errorEl = await page.$('span:has-text("Something went wrong")');
    if (!errorEl) break;
    console.log(`  Twitter error page detected, retrying (${attempt + 1}/3)...`);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);
  }

  const seen = new Set();
  const tweets = [];

  for (let scroll = 0; scroll < maxScrolls; scroll++) {
    // Handle mid-scroll "Something went wrong" errors
    const errorEl = await page.$('span:has-text("Something went wrong")');
    if (errorEl) {
      console.log('  Twitter error mid-scroll, reloading...');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(5000);
    }
    await page.waitForSelector('[data-testid="tweet"]', { timeout: 10000 }).catch(() => {});

    const newTweets = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('[data-testid="tweet"]')).map((el) => {
        const textEl = el.querySelector('[data-testid="tweetText"]');
        const text = textEl ? textEl.innerText : '';

        const timeEl = el.querySelector('time');
        const timestamp = timeEl ? timeEl.getAttribute('datetime') : '';

        const tweetLinkEl = el.querySelector('a[href*="/status/"]');
        const tweetUrl = tweetLinkEl ? 'https://x.com' + tweetLinkEl.getAttribute('href') : '';

        const getStatText = (testId) => {
          const btn = el.querySelector(`[data-testid="${testId}"]`);
          if (!btn) return '0';
          const span = btn.querySelector('span > span');
          return span ? span.innerText : '0';
        };

        const hasImages = el.querySelectorAll('[data-testid="tweetPhoto"] img').length > 0;
        // videoPlayer covers native video; videoComponent covers GIFs (X
        // renders both through the same player chrome) - either counts as
        // video for ranking purposes.
        const hasVideo = el.querySelectorAll('[data-testid="videoPlayer"], [data-testid="videoComponent"]').length > 0;

        // text.startsWith('RT @') only ever caught X's old-style retweet
        // syntax, which the modern Repost button doesn't produce at all -
        // a repost renders as the identical original tweet with no text
        // change, distinguished only by a small "<handle> reposted" label
        // above the tweet (data-testid="socialContext"). Checked zero
        // historical rows matched the old text-only check despite reposts
        // clearly existing in practice - this is why.
        const socialContextEl = el.querySelector('[data-testid="socialContext"]');
        const socialContextText = socialContextEl ? socialContextEl.innerText : '';
        const isRetweet = text.startsWith('RT @') || /repost|retweet/i.test(socialContextText);

        const userEl = el.querySelector('[data-testid="User-Name"]');
        const userLinks = userEl ? Array.from(userEl.querySelectorAll('a')) : [];
        const tweetHandle = userLinks[1] ? userLinks[1].innerText.toLowerCase() : '';

        // Views — rendered as an analytics link with aria-label containing "views"
        const viewsEl = el.querySelector('a[href*="/analytics"]');
        let views = '0';
        if (viewsEl) {
          const ariaLabel = viewsEl.getAttribute('aria-label') || '';
          const match = ariaLabel.match(/([\d,\.]+[KMB]?)\s*view/i);
          if (match) views = match[1];
          else {
            const span = viewsEl.querySelector('span > span');
            if (span) views = span.innerText.trim();
          }
        }

        return {
          text, timestamp, tweetUrl, hasImages, hasVideo, isRetweet, tweetHandle, views,
          likes: getStatText('like'),
          retweets: getStatText('retweet'),
          replies: getStatText('reply'),
        };
      });
    });

    let addedCount = 0;
    for (const tweet of newTweets) {
      const key = tweet.tweetUrl || tweet.text;
      if (key && !seen.has(key)) { seen.add(key); tweets.push(tweet); addedCount++; }
    }

    console.log(`  Scroll ${scroll + 1}/${maxScrolls} — +${addedCount} new (total: ${tweets.length})`);
    if (addedCount === 0 && scroll > 15) { console.log('  No new tweets after 15 empty scrolls, stopping early.'); break; }

    // Scroll to the last tweet element rather than a fixed pixel amount
    // This is more reliable with Twitter's virtualized rendering
    await page.evaluate(() => {
      const tweets = document.querySelectorAll('[data-testid="tweet"]');
      if (tweets.length > 0) {
        tweets[tweets.length - 1].scrollIntoView({ behavior: 'instant', block: 'end' });
      } else {
        window.scrollBy(0, window.innerHeight * 2);
      }
    });
    await page.waitForTimeout(4000);
  }

  // Convert from X's raw UTC timestamp to Taiwan time so everything
  // downstream (CSV rows, 7-day refresh window, top-tweets-by-day grouping)
  // reflects Taiwan wall-clock time consistently.
  tweets.forEach(t => { t.timestamp = toTaiwanISOString(t.timestamp); });

  return tweets;
}

async function main() {
  const contextOptions = {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  };
  if (fs.existsSync(SESSION_FILE)) contextOptions.storageState = SESSION_FILE;

  let browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  let context = await browser.newContext(contextOptions);
  let page = await context.newPage();

  // If the browser/page dies mid-run (observed 2026-07-07: an X error mid-scroll
  // triggered a reload that never came back, closing the page entirely and taking
  // the whole script down with it — nothing after that account ever scraped, and
  // the daily run silently stopped before watchlist/competitors/publish ever ran),
  // relaunch a fresh browser so the remaining accounts still get processed instead
  // of one account's crash aborting everything downstream.
  async function relaunchBrowser() {
    console.log('  Browser/page appears dead — relaunching a fresh one...');
    try { await browser.close(); } catch {}
    browser = await chromium.launch({
      headless: false,
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    });
    context = await browser.newContext(contextOptions);
    page = await context.newPage();
  }

  const failedAccounts = [];

  try {
    // Verify logged in - a fixed 2s wait after only 'domcontentloaded' (not
    // full render/hydration) intermittently misfired as "not logged in" on
    // a genuinely fresh, valid session (reproduced 2026-07-10 right after
    // the main scraper had just saved a working session.json). Wait for
    // the actual login-only element to appear instead of a fixed delay.
    //
    // One retry (fresh reload + a second wait) before giving up entirely:
    // observed 2026-07-14 20:35 - this exact check failed here, but
    // run_daily.sh's own "retry just @TrendForce" fallback (a brand-new
    // process invocation moments later, re-running this identical check)
    // succeeded - proving the session itself was fine and this was a
    // transient render-timing miss, not a dead session. That fallback only
    // ever covered @TrendForce specifically, silently skipping every
    // competitor account for the whole run on the same transient failure -
    // retrying the check itself here covers all of them, not just one.
    let isLoggedIn = await (async () => {
      await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded' });
      return page.waitForSelector('[data-testid="SideNav_AccountSwitcher_Button"]', { timeout: 15000 }).catch(() => null);
    })();
    if (!isLoggedIn) {
      console.log('Login check failed once, retrying after a fresh reload...');
      await page.waitForTimeout(3000);
      isLoggedIn = await (async () => {
        await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded' });
        return page.waitForSelector('[data-testid="SideNav_AccountSwitcher_Button"]', { timeout: 20000 }).catch(() => null);
      })();
    }
    if (!isLoggedIn) {
      console.log('Not logged in. Please run the main scraper first to save a session.');
      process.exit(1);
    }

    for (const handle of INDIVIDUAL_ACCOUNTS) {
      try {
        await scrapeOneAccount(page, handle);
      } catch (err) {
        console.error(`  [!] ${handle} failed: ${err.message}`);
        failedAccounts.push(handle);
        // A page/browser closure kills every subsequent page.* call the same
        // way, so detect that specifically and recover instead of letting it
        // silently take out every account after this one.
        if (page.isClosed() || /Target page|context or browser has been closed/i.test(err.message)) {
          try {
            await relaunchBrowser();
          } catch (relaunchErr) {
            console.error(`  [!] Could not relaunch browser: ${relaunchErr.message}. Aborting remaining accounts.`);
            break;
          }
        }
      }
    }

    if (failedAccounts.length) {
      console.log(`\nCompleted with failures on: ${failedAccounts.join(', ')}`);
    }
  } catch (err) {
    console.error('Error:', err.message);
    if (!page.isClosed()) {
      await page.screenshot({ path: 'error-screenshot.png' }).catch(() => {});
    }
  } finally {
    await browser.close().catch(() => {});
  }

  if (failedAccounts.length) process.exitCode = 1;
}

async function scrapeOneAccount(page, handle) {
  const cleanHandle = handle.replace('@', '');
  const csvFile = path.join(CSV_DIR, `${cleanHandle}.csv`);

  // Load existing rows, keyed by tweetUrl, so we can refresh stats in place.
  // Self-heals duplicate rows left behind by prior overlapping scrape runs:
  // if a URL already appeared, keep whichever row has higher views and
  // drop the other instead of silently leaving both in the file.
  const existingByUrl = new Map(); // url -> { cols, idx }
  const existingLines = [];
  const droppedIdx = new Set();
  if (fs.existsSync(csvFile)) {
    const lines = fs.readFileSync(csvFile, 'utf8').split('\n').filter(l => l.trim());
    let dupesFound = 0;
    for (const line of lines.slice(1)) {
      const cols = parseCsvLine(line);
      const idx = existingLines.push(line) - 1;
      const url = unquote(cols[7]);
      if (!url) continue;
      const prior = existingByUrl.get(url);
      if (!prior) {
        existingByUrl.set(url, { cols, idx });
        continue;
      }
      dupesFound++;
      const priorViews = parseFollowerCount(prior.cols[1]) || 0;
      const thisViews = parseFollowerCount(cols[1]) || 0;
      if (thisViews > priorViews) {
        droppedIdx.add(prior.idx);
        existingByUrl.set(url, { cols, idx });
      } else {
        droppedIdx.add(idx);
      }
    }
    if (dupesFound) console.log(`  ${handle}: cleaned up ${dupesFound} duplicate row(s) found in CSV.`);
    console.log(`${handle}: ${existingByUrl.size} existing tweets in CSV.`);
  }

  // Scrape recent timeline (fewer scrolls for daily top-up; override via
  // MAX_SCROLLS env var for a deeper one-off pass, e.g. onboarding a
  // brand-new account with no history yet)
  console.log(`${handle}: scraping recent tweets...`);
  // Cut 15 -> 8 -> 5 (2026-08-05/07): the account got suspended for
  // crawling too fast. Cumulative daily request volume across every
  // scraper hitting this one X account (accounts, watchlist, competitors,
  // video-discovery) is the real driver, not any single script's own
  // pace - cutting scroll depth everywhere reduces total volume. The
  // 12:30 daily-run slot was restored on the same day as this second cut,
  // trading run frequency back for per-run depth instead.
  const maxScrolls = parseInt(process.env.MAX_SCROLLS, 10) || 5;
  const tweets = await scrapeTimeline(page, handle, maxScrolls);

  // Split into: brand-new tweets to enrich+append, and existing tweets
  // (posted within the last 7 days) whose stats we refresh in place —
  // views/likes keep climbing for days after posting, so a one-time
  // scrape at first sight was undercounting them.
  const now = Date.now();
  const seenThisBatch = new Set();
  const newTweets = [];
  let updatedCount = 0;

  for (const t of tweets) {
    if (t.isRetweet) continue;
    if (!t.tweetUrl) continue;
    const urlHandle = t.tweetUrl.split('/')[3]?.toLowerCase();
    if (urlHandle !== cleanHandle.toLowerCase()) continue;
    if (seenThisBatch.has(t.tweetUrl)) continue;
    seenThisBatch.add(t.tweetUrl);

    const existing = existingByUrl.get(t.tweetUrl);
    if (existing) {
      const age = now - new Date(t.timestamp).getTime();
      if (age <= UPDATE_WINDOW_MS) {
        existing.cols[1] = t.views || '0';
        existing.cols[2] = t.likes;
        existing.cols[3] = t.retweets;
        existing.cols[4] = t.replies;
        existing.cols[5] = t.hasImages ? 'yes' : 'no';
        // hasVideo is appended as column 10 (added after every other column
        // was already in place) - assigning past the end of an older row's
        // shorter cols array is safe in JS (it just extends the array), so
        // this refresh is what backfills hasVideo onto pre-existing rows
        // within their first 7 days (UPDATE_WINDOW_MS) rather than needing
        // a separate one-off backfill pass.
        existing.cols[10] = t.hasVideo ? 'yes' : 'no';
        existingLines[existing.idx] = existing.cols.join(',');
        updatedCount++;
      }
      continue;
    }
    newTweets.push(t);
  }

  // Always record follower count regardless of new/updated tweets
  const followerCount = await scrapeFollowers(page, handle);
  if (followerCount) recordFollowers(cleanHandle, followerCount);

  console.log(`  ${newTweets.length} new tweets, ${updatedCount} existing tweets refreshed.`);
  if (newTweets.length === 0 && updatedCount === 0 && droppedIdx.size === 0) {
    console.log(`  Nothing new, updated, or duplicated for ${handle}, skipping write.`);
    return;
  }

  let newRows = '';
  if (newTweets.length) {
    console.log(`  Enriching ${newTweets.length} new tweets...`);
    const enriched = enrichTweets(newTweets);
    newRows = enriched.map(t =>
      [t.timestamp, t.views ?? '0', t.likes, t.retweets, t.replies,
       t.hasImages ? 'yes' : 'no',
       safe(t.keywords), safe(t.tweetUrl), safe(t.text), safe(t.translatedText ?? ''),
       t.hasVideo ? 'yes' : 'no'].join(',')
    ).join('\n');
  }

  const header = 'timestamp,views,likes,retweets,replies,hasImages,keywords,tweetUrl,text,translated_text,hasVideo\n';
  const survivingLines = existingLines.filter((_, i) => !droppedIdx.has(i));
  // Prepend new rows (newest first) then existing rows (refreshed in place)
  const combined = header
    + (newRows ? newRows + '\n' : '')
    + survivingLines.join('\n') + (survivingLines.length ? '\n' : '');
  fs.writeFileSync(csvFile, combined);
  console.log(`Updated csv/${cleanHandle}.csv (+${newTweets.length} new, ${updatedCount} refreshed, ${droppedIdx.size} duplicates removed, ${existingByUrl.size + newTweets.length} total)`);
}

(async () => {
  await acquireLock();
  try {
    await main();
  } finally {
    releaseLock();
  }
})();
