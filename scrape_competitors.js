require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { toTaiwanISOString } = require('./tz_util');

const sinceDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

// Competitors to monitor — search for mentions/citations of each
const COMPETITORS = [
  { name: 'SemiAnalysis',         queries: ['SemiAnalysis', 'semianalysis.com'] },
  { name: 'Fabricated Knowledge', queries: ['Fabricated Knowledge', 'fabknowledge.com'] },
  { name: 'SemiVision',           queries: ['SemiVision', 'semivision.com'] },
  { name: 'Chips and Wafers',     queries: ['ChipsandWafers', '"Chips and Wafers"'] },
  { name: 'Sravan Kundojjala',    queries: ['SKundojjala'] },
];

// Build one query per competitor (OR their search terms)
const SEARCH_QUERIES = COMPETITORS.map(c => {
  const terms = c.queries.map(q => `"${q}"`).join(' OR ');
  return { label: c.name, query: `(${terms}) since:${sinceDate} -from:SemiAnalysis_ -from:fabknowledge -from:semivision_tw -from:ChipsandWafers -from:SKundojjala` };
});

const SESSION_FILE = path.join(__dirname, 'session.json');
const FOLLOWER_CACHE_FILE = path.join(__dirname, 'follower_cache.json');
const CSV_DIR = path.join(__dirname, 'csv');

fs.mkdirSync(CSV_DIR, { recursive: true });

const followerCache = fs.existsSync(FOLLOWER_CACHE_FILE)
  ? JSON.parse(fs.readFileSync(FOLLOWER_CACHE_FILE, 'utf8'))
  : {};

function analyzeSentimentBatch(tweets) {
  try {
    const output = execSync('python3 sentiment.py', {
      input: JSON.stringify(tweets),
      cwd: __dirname,
      maxBuffer: 10 * 1024 * 1024,
    });
    return JSON.parse(output.toString());
  } catch (e) {
    console.warn('Sentiment failed:', e.message);
    return tweets.map(t => ({ ...t, sentiment: 'neutral', sentimentScore: 0 }));
  }
}

async function getProfileData(page, handle) {
  const cleanHandle = handle.replace('@', '');
  if (followerCache[cleanHandle] !== undefined) return followerCache[cleanHandle];
  try {
    await page.goto(`https://x.com/${cleanHandle}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('[data-testid="primaryColumn"]', { timeout: 10000 });
    await page.waitForTimeout(2000);
    const data = await page.evaluate(() => {
      const followerLink = document.querySelector('a[href$="/verified_followers"], a[href$="/followers"]');
      const followers = followerLink ? followerLink.innerText.trim().split(/\s+/)[0] : 'unknown';
      const locationEl = document.querySelector('[data-testid="UserProfileHeader_Items"] [data-testid="UserLocation"]');
      const location = locationEl ? locationEl.innerText.trim() : null;
      return { followers, location };
    });
    followerCache[cleanHandle] = data;
  } catch {
    followerCache[cleanHandle] = { followers: 'unknown', location: null };
  }
  return followerCache[cleanHandle];
}

async function scrapeTweets(page, query, label, maxScrolls = 15) {
  const url = `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query&f=live`;
  console.log(`\nSearching [${label}]: "${query}"`);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);

  // Blank/error page detection
  for (let attempt = 0; attempt < 3; attempt++) {
    const bodyText = await page.evaluate(() => document.body?.innerText?.trim() || '');
    const hasError = await page.$('span:has-text("Something went wrong")');
    if (bodyText.length >= 50 && !hasError) break;
    console.log(`  Blank/error page, waiting 15s before retry (${attempt + 1}/3)...`);
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
        const displayName = links[0] ? links[0].innerText : '';
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

        return {
          text, displayName, handle, timestamp, tweetUrl,
          replies: getStatText('reply'),
          retweets: getStatText('retweet'),
          likes: getStatText('like'),
          scrapedAt: new Date().toISOString(),
        };
      });
    });

    let addedCount = 0;
    for (const tweet of newTweets) {
      const key = tweet.tweetUrl || tweet.text;
      if (key && !seen.has(key)) { seen.add(key); tweets.push(tweet); addedCount++; }
    }

    console.log(`  Scroll ${scroll + 1}/${maxScrolls} — +${addedCount} new (total: ${tweets.length})`);
    if (addedCount === 0 && scroll > 2) { console.log('  No new tweets, stopping early.'); break; }

    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 3));
    await page.waitForTimeout(2500);
  }

  return tweets.map(t => ({ ...t, timestamp: toTaiwanISOString(t.timestamp), competitorMentioned: label }));
}

const safe = (s) => `"${String(s ?? '').replace(/"/g, '""').replace(/\n/g, ' ')}"`;

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
    // A fixed wait after only 'domcontentloaded' (not full render/hydration)
    // intermittently misfired as "not logged in" against a genuinely fresh,
    // valid session (reproduced 2026-07-10, same as scrape_accounts.js) -
    // wait for the actual login-only element instead of guessing a delay.
    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded' });
    const isLoggedIn = await page.waitForSelector('[data-testid="SideNav_AccountSwitcher_Button"]', { timeout: 15000 }).catch(() => null);
    if (!isLoggedIn) {
      console.log('Not logged in. Please run the main scraper first to save a session.');
      process.exit(1);
    }

    let allTweets = [];

    for (let qi = 0; qi < SEARCH_QUERIES.length; qi++) {
      const { label, query } = SEARCH_QUERIES[qi];
      // Cut 15 -> 8 -> 5 (2026-08-05/07) - the account got suspended for
      // crawling too fast; see scrape_accounts.js's maxScrolls comment.
      const tweets = await scrapeTweets(page, query, label, 5);
      allTweets.push(...tweets);
      if (qi < SEARCH_QUERIES.length - 1) {
        console.log('  Cooling down 20s...');
        await page.waitForTimeout(20000);
      }
    }

    // Deduplicate by URL
    const deduped = [];
    const seenUrls = new Set();
    for (const t of allTweets) {
      const key = t.tweetUrl || t.text;
      if (key && !seenUrls.has(key)) { seenUrls.add(key); deduped.push(t); }
    }

    // Filter to last 24h
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const filtered = deduped.filter(t => !t.timestamp || new Date(t.timestamp) >= cutoff);
    console.log(`\n${filtered.length} competitor mention tweets in the last 24 hours.`);

    // Fetch profiles (cached)
    console.log('\nFetching profile data...');
    const uniqueHandles = [...new Set(filtered.map(t => t.handle).filter(Boolean))];
    const uncached = uniqueHandles.filter(h => followerCache[h.replace('@', '')] === undefined);
    for (let i = 0; i < uncached.length; i++) {
      const handle = uncached[i];
      process.stdout.write(`  [${i + 1}/${uncached.length}] ${handle} ... `);
      try {
        const data = await getProfileData(page, handle);
        console.log(`followers: ${data.followers}`);
      } catch {
        console.log('error');
        followerCache[handle.replace('@', '')] = { followers: 'unknown', location: null };
      }
      fs.writeFileSync(FOLLOWER_CACHE_FILE, JSON.stringify(followerCache, null, 2));
      await page.waitForTimeout(1000);
    }
    if (uncached.length === 0) console.log('  All profiles already cached.');

    // Attach profile info
    const withMeta = filtered.map(tweet => {
      const profile = followerCache[tweet.handle.replace('@', '')] || {};
      return { ...tweet, followers: profile.followers || 'unknown' };
    });

    // Sentiment
    console.log('\nRunning sentiment analysis...');
    const enriched = analyzeSentimentBatch(withMeta);

    // Load existing competitor CSVs to avoid overlap
    const existingUrls = new Set();
    const existingFiles = fs.readdirSync(CSV_DIR).filter(f => f.startsWith('competitors_') && f.endsWith('.csv'));
    for (const file of existingFiles) {
      const lines = fs.readFileSync(path.join(CSV_DIR, file), 'utf8').split('\n').slice(1);
      for (const line of lines) {
        const match = line.match(/https:\/\/x\.com\/[^\s,"]+/);
        if (match) existingUrls.add(match[0]);
      }
    }

    const truly_new = enriched.filter(t => !existingUrls.has(t.tweetUrl));
    const skipped = enriched.length - truly_new.length;
    if (skipped > 0) console.log(`  Skipped ${skipped} already-saved tweets.`);

    // Save grouped by actual tweet date
    const header = 'timestamp,handle,displayName,followers,competitorMentioned,sentiment,sentimentScore,likes,retweets,replies,tweetUrl,text\n';
    const byDay = {};
    for (const t of truly_new) {
      const day = t.timestamp ? t.timestamp.slice(0, 10) : new Date().toISOString().slice(0, 10);
      if (!byDay[day]) byDay[day] = [];
      byDay[day].push(t);
    }

    for (const [day, dayTweets] of Object.entries(byDay)) {
      const csvFile = path.join(CSV_DIR, `competitors_${day}.csv`);
      const existingContent = fs.existsSync(csvFile) ? fs.readFileSync(csvFile, 'utf8') : header;
      const rows = dayTweets.map(t => [
        t.timestamp, safe(t.handle), safe(t.displayName), safe(t.followers),
        safe(t.competitorMentioned), t.sentiment, t.sentimentScore,
        t.likes, t.retweets, t.replies,
        safe(t.tweetUrl), safe(t.text),
      ].join(',')).join('\n');
      fs.writeFileSync(csvFile, existingContent.trimEnd() + '\n' + rows + '\n');
      console.log(`  csv/competitors_${day}.csv — ${dayTweets.length} new tweets`);
    }

    console.log(`\nDone. ${truly_new.length} new competitor mention tweets saved.`);

  } catch (err) {
    console.error('Error:', err.message);
    await page.screenshot({ path: 'error-competitors.png' });
  } finally {
    await browser.close();
  }
}

main();
