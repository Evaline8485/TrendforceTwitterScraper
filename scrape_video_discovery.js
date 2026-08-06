/**
 * Platform-wide video discovery — unlike scrape_accounts.js/scrape_watchlist.js
 * (which only ever see tracked accounts' own timelines), this searches X's
 * public search with filter:videos so ANY account's video post can surface,
 * not just ones already tracked in accounts_config.json. Feeds
 * TrendForceDash's cross-platform X Video Ranking section (see
 * video_ranking.py on the dashboard side).
 *
 * Two query sources, both combined into one flat list each run:
 *  - KEYWORD_BATCHES: a fixed set of TrendForce's own industry terms
 *    (semiconductor/AI hardware), so that coverage never depends on
 *    whether those topics happen to be trending right now.
 *  - Rising Topics: read live from TrendForceDash's own FR-02 output
 *    (analysis/fuzzy_trends_1d.json - see getRisingTopicQueries()), not
 *    X's generic platform-wide Trending tab. That was tried first and
 *    rejected: it surfaces whatever's popular on X overall (K-pop,
 *    celebrity gossip, Bitcoin, ...), which has nothing to do with
 *    TrendForce's own coverage. Rising Topics is already scoped to our
 *    tracked accounts' actual domain, so searching video for whatever's
 *    rising there stays broader than the fixed keyword list (follows
 *    whatever's actually heating up right now) while staying relevant.
 *
 * Reuses session.json - the same login session scrape_watchlist.js expects,
 * saved by the main mention-tracker scraper. Run that first if this errors
 * out with "Not logged in."
 *
 * Usage: node scrape_video_discovery.js [--since YYYY-MM-DD]
 */
require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { toTaiwanISOString } = require('./tz_util');

const sinceArg = process.argv.includes('--since') ? process.argv[process.argv.indexOf('--since') + 1] : null;
const sinceDate = sinceArg || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
if (sinceArg) console.log(`Running with custom since date: ${sinceDate}`);

// Up to 8 query batches (3 fixed + up to 5 Rising Topics) at 15 scrolls each
// was adding 60-130+ min to the shared run_daily.sh schedule (found
// 2026-07-24: daily runs went from ~35min to 69min-4h after this script
// was added to it) - 10 is enough to catch what's genuinely new on a 4h
// cadence without re-walking as deep into each query's results every
// time. Override via --scrolls for a deeper one-off pass:
// `node scrape_video_discovery.js --scrolls 20`.
// Cut 10 -> 6 (2026-08-05) - the account got suspended for crawling too
// fast. Cumulative daily request volume across every scraper hitting this
// one X account is the real driver, not any single script's own pace.
const scrollsArg = process.argv.includes('--scrolls') ? process.argv[process.argv.indexOf('--scrolls') + 1] : null;
const MAX_SCROLLS_PER_QUERY = scrollsArg ? parseInt(scrollsArg, 10) : 6;

// Batched industry keywords (TrendForce's own coverage domain - semiconductor
// / AI hardware news), each combined with filter:videos so results are
// video posts from ANY account, not a fixed list. Kept to ~5 terms per
// query, same batching reasoning as scrape_watchlist.js's from: batches -
// a handful of broad queries costs far less scrape time than one query per
// term while still covering the domain.
const KEYWORD_BATCHES = [
  ['TSMC', 'Nvidia', 'Samsung', 'SK hynix', 'Micron'],
  ['Intel', 'AMD', 'semiconductor', 'chip', 'foundry'],
  ['DRAM', 'NAND', 'HBM', 'EUV', 'AI chip'],
];
// Each query now carries a display "topic" label alongside it (same
// " / "-joined shape as a Rising Topic's own label) so every discovered
// video can be tagged with which topic surfaced it - shown as a Topics
// column on the dashboard.
const SEARCH_QUERIES = KEYWORD_BATCHES.map((terms) => {
  const orPart = terms.map((t) => (t.includes(' ') ? `"${t}"` : t)).join(' OR ');
  return { query: `(${orPart}) filter:videos since:${sinceDate}`, topic: terms.join(' / ') };
});

// TrendForceDash is a sibling repo at a fixed local path - run_daily.sh
// already reaches across to it by absolute path (calls its run_pipeline.sh
// directly), so reading its analysis output the same way isn't a new kind
// of cross-repo dependency, just the reverse direction of an existing one.
const RISING_TOPICS_FILE = '/Users/elainekao/TrendForceDash/analysis/fuzzy_trends_1d.json';
// Cut 10 -> 5 (2026-07-24, alongside the scroll-depth reduction above) -
// this script's 13 query batches (3 fixed + up to 10 Rising Topics) were
// still the single biggest remaining cost in run_daily.sh's 6x/day
// schedule (~30min/run just here). Keeping only the top 5 by rising_score
// still covers the topics most likely to actually have new video content,
// at roughly half the batches' worth of scroll time.
const MAX_RISING_TOPICS = 5;

// Each topic's label is already an OR-able keyword set (topic_clusters.py's
// label_cluster() joins a cluster's top terms with " / ", e.g.
// "sk / hynix / samsung / hbm") - one query per topic, no extra batching
// needed since a topic's own keywords already fill that role.
function getRisingTopicQueries() {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(RISING_TOPICS_FILE, 'utf8'));
  } catch (err) {
    console.log(`  [!] Could not read ${RISING_TOPICS_FILE} (${err.message}).`);
    return [];
  }

  // Same topic can legitimately show up on more than one platform (e.g.
  // "sk / hynix / samsung / hbm" rising on both Facebook and X) - dedup by
  // label and keep the higher rising_score seen, then take the top N
  // overall so one platform having many topics can't crowd out the rest.
  const byLabel = new Map();
  for (const platformData of Object.values(data.platforms || {})) {
    for (const topic of platformData.top_rising_topics || []) {
      if (!topic.label) continue;
      const existing = byLabel.get(topic.label);
      if (!existing || topic.rising_score > existing.rising_score) {
        byLabel.set(topic.label, topic);
      }
    }
  }

  const topTopics = Array.from(byLabel.values())
    .sort((a, b) => b.rising_score - a.rising_score)
    .slice(0, MAX_RISING_TOPICS);

  console.log(`  Found ${topTopics.length} rising topic(s): ${topTopics.map((t) => t.label).join(' | ')}`);

  return topTopics.map((t) => {
    const terms = t.label.split(' / ').map((s) => s.trim()).filter(Boolean);
    const orPart = terms.map((term) => (/\s/.test(term) ? `"${term}"` : term)).join(' OR ');
    return { query: `(${orPart}) filter:videos since:${sinceDate}`, topic: t.label };
  });
}

const SESSION_FILE = path.join(__dirname, 'session.json');
const CSV_DIR = path.join(__dirname, 'csv');
const RAW_FILE = path.join(__dirname, 'raw_video_discovery.json');
fs.mkdirSync(CSV_DIR, { recursive: true });

async function scrapeVideoTweets(page, query, maxScrolls = 15) {
  const url = `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query&f=live`;
  console.log(`\nSearching: "${query}"`);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);

  // Detect blank/error page and wait for recovery - same recovery loop as
  // scrape_watchlist.js's scrapeTweets(), same underlying flakiness.
  for (let attempt = 0; attempt < 3; attempt++) {
    const bodyText = await page.evaluate(() => document.body?.innerText?.trim() || '');
    const isBlank = bodyText.length < 50;
    const hasError = await page.$('span:has-text("Something went wrong")');
    if (!isBlank && !hasError) break;
    console.log(`  Blank or error page detected, waiting 15s before retry (${attempt + 1}/3)...`);
    await page.waitForTimeout(15000);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);
  }

  const seen = new Set();
  const tweets = [];

  for (let scroll = 0; scroll < maxScrolls; scroll++) {
    await page.waitForSelector('[data-testid="tweet"]', { timeout: 10000 }).catch(() => {});

    const newTweets = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('[data-testid="tweet"]')).map((el) => {
        const textEl = el.querySelector('[data-testid="tweetText"]');
        const text = textEl ? textEl.innerText : '';

        const userEl = el.querySelector('[data-testid="User-Name"]');
        const links = userEl ? Array.from(userEl.querySelectorAll('a')) : [];
        const handle = links[1] ? links[1].innerText : '';

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

        // filter:videos in the search query already restricts results to
        // video posts, but confirm via the player element itself rather
        // than trusting the query filter blindly - same reasoning as
        // scrape_accounts.js's hasVideo check.
        const hasVideo = el.querySelectorAll('[data-testid="videoPlayer"], [data-testid="videoComponent"]').length > 0;

        // Views - same analytics-link technique as scrape_accounts.js.
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
          text, handle, timestamp, tweetUrl, hasVideo, views,
          likes: getStatText('like'),
          retweets: getStatText('retweet'),
        };
      });
    });

    let addedCount = 0;
    for (const tweet of newTweets) {
      if (!tweet.hasVideo) continue; // belt-and-suspenders past the query filter
      const key = tweet.tweetUrl || tweet.text;
      if (key && !seen.has(key)) { seen.add(key); tweets.push(tweet); addedCount++; }
    }

    console.log(`  Scroll ${scroll + 1}/${maxScrolls} — +${addedCount} new video post(s) (total: ${tweets.length})`);
    if (addedCount === 0 && scroll > 2) { console.log('  No new video posts, stopping early.'); break; }

    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 3));
    await page.waitForTimeout(2500);
  }

  tweets.forEach((t) => { t.timestamp = toTaiwanISOString(t.timestamp); });
  return tweets;
}

const safe = (s) => `"${String(s ?? '').replace(/"/g, '""').replace(/\n/g, ' ')}"`;

function writeDiscoveryCsv(tweets) {
  const outFile = path.join(CSV_DIR, 'video_discovery.csv');
  // topic appended at the end rather than inserted among the existing
  // columns, so the existing-row re-parse below (keyed off a fixed index
  // for tweetUrl) doesn't need to change.
  const header = 'timestamp,handle,views,likes,retweets,tweetUrl,text,topic\n';

  // Merge with whatever's already on disk (keyed by tweetUrl), same
  // refresh-in-place reasoning as scrape_accounts.js - views/likes keep
  // climbing after posting, and re-running this script shouldn't just
  // pile up duplicate rows for the same video.
  const existingByUrl = new Map();
  if (fs.existsSync(outFile)) {
    const lines = fs.readFileSync(outFile, 'utf8').split('\n').slice(1).filter((l) => l.trim());
    for (const line of lines) {
      const cols = line.match(/(".*?"|[^,]+)(?=,|$)/g) || [];
      const unq = (s) => (s || '').replace(/^"|"$/g, '').replace(/""/g, '"');
      const url = unq(cols[5]);
      if (url) existingByUrl.set(url, line);
    }
  }

  for (const t of tweets) {
    const row = [t.timestamp, safe(t.handle), t.views || '0', t.likes, t.retweets, safe(t.tweetUrl), safe(t.text), safe(t.topic || '')].join(',');
    existingByUrl.set(t.tweetUrl, row);
  }

  const body = Array.from(existingByUrl.values()).join('\n');
  fs.writeFileSync(outFile, header + body + (body ? '\n' : ''));
  console.log(`\nWrote ${outFile} (${existingByUrl.size} total video posts discovered)`);
}

async function main() {
  const browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  const contextOptions = {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  };
  if (fs.existsSync(SESSION_FILE)) contextOptions.storageState = SESSION_FILE;

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  try {
    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded' });
    const isLoggedIn = await page.waitForSelector('[data-testid="SideNav_AccountSwitcher_Button"]', { timeout: 15000 }).catch(() => null);
    if (!isLoggedIn) {
      console.log('Not logged in. Please run the main scraper first to save a session.');
      process.exit(1);
    }

    let allTweets = [];
    if (fs.existsSync(RAW_FILE)) {
      allTweets = JSON.parse(fs.readFileSync(RAW_FILE, 'utf8'));
      console.log(`\nResuming — loaded ${allTweets.length} video posts from raw_video_discovery.json`);
      console.log('Delete raw_video_discovery.json to start a fresh scrape.\n');
    } else {
      console.log('\nReading Rising Topics from TrendForceDash...');
      const risingTopicQueries = getRisingTopicQueries();
      const allQueries = SEARCH_QUERIES.concat(risingTopicQueries);

      for (let qi = 0; qi < allQueries.length; qi++) {
        const tweets = await scrapeVideoTweets(page, allQueries[qi].query, MAX_SCROLLS_PER_QUERY);
        const topic = allQueries[qi].topic;
        // X's search can return a result that matches the QUERY but not
        // the tweet's own TEXT - found 2026-07-23: @ChipGotIt_'s account
        // name contains "Chip", so an unrelated video got tagged "Intel /
        // AMD / semiconductor / chip / foundry" purely from a username
        // match. Keep only results where one of the topic's own terms
        // actually appears in the tweet text, same content-verification
        // spirit as the hasVideo double-check above.
        //
        // Plain substring alone still false-positives on short ASCII terms
        // (a Rising Topic label like "sk / hynix / samsung / hbm" has "sk"
        // as its own term, and "sk" is a substring of "Haskell") - a
        // word-boundary regex for pure-ASCII terms avoids that; multi-word
        // and CJK terms (no spaces to bound on) keep plain substring.
        //
        // Word-boundary alone still isn't enough for all-caps industry
        // acronyms (NAND, DRAM, HBM, EUV, ...) - "Injured Inspector Nand
        // Kishor Singh" case-insensitively matched "NAND" as a whole word,
        // tagging an unrelated news video (found 2026-07-23). Industry
        // acronyms are almost always written ALL CAPS in real posts, while
        // a name/word that happens to collide is typically title-case - so
        // when the TERM ITSELF (before lowercasing) is all-uppercase,
        // require a case-SENSITIVE match against the original tweet text.
        const termMatches = (term, text, textLower) => {
          if (/^[a-zA-Z0-9]+$/.test(term)) {
            if (term === term.toUpperCase() && term.length > 1) {
              return new RegExp(`\\b${term}\\b`).test(text);
            }
            return new RegExp(`\\b${term.toLowerCase()}\\b`).test(textLower);
          }
          return textLower.includes(term.toLowerCase());
        };
        const terms = topic.split(' / ').map((s) => s.trim()).filter(Boolean);
        const relevant = tweets.filter((t) => {
          const lower = t.text.toLowerCase();
          return terms.some((term) => termMatches(term, t.text, lower));
        });
        const dropped = tweets.length - relevant.length;
        if (dropped) console.log(`  Dropped ${dropped} result(s) matching the search but not the tweet's own text (likely a username match).`);
        relevant.forEach((t) => { t.topic = topic; });
        allTweets.push(...relevant);
        fs.writeFileSync(RAW_FILE, JSON.stringify(allTweets, null, 2));
        if (qi < allQueries.length - 1) {
          console.log('  Cooling down 20s before next batch...');
          await page.waitForTimeout(20000);
        }
      }
    }

    const deduped = [];
    const seenUrls = new Set();
    for (const t of allTweets) {
      const key = t.tweetUrl || t.text;
      if (key && !seenUrls.has(key)) { seenUrls.add(key); deduped.push(t); }
    }

    writeDiscoveryCsv(deduped);
    fs.unlinkSync(RAW_FILE);
  } catch (err) {
    console.error('Error:', err.message);
    await page.screenshot({ path: path.join(__dirname, 'error-video-discovery.png') }).catch(() => {});
  } finally {
    await browser.close();
  }
}

main();
