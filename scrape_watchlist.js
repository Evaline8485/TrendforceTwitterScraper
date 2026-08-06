require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');
const { toTaiwanISOString } = require('./tz_util');

const sinceArg = process.argv.includes('--since') ? process.argv[process.argv.indexOf('--since') + 1] : null;
const sinceDate = sinceArg || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
if (sinceArg) console.log(`Running with custom since date: ${sinceDate}`);

const KNOWN_ACCOUNTS = {
  '@QQ_Timmy':         { name: '駿HaYaO',            type: 'amplifier',  region: 'Asia' },
  '@jukan05':          { name: 'Jukan',               type: 'amplifier',  region: 'South Korea' },
  '@aleabitoreddit':   { name: 'Serenity',            type: 'amplifier',  region: 'International' },
  '@bubbleboi':        { name: 'bubble boi',          type: 'amplifier',  region: 'International' },
  '@dnystedt':         { name: 'Dan Nystedt',         type: 'amplifier',  region: 'Taiwan' },
  '@tculpan':          { name: 'Tim Culpan',          type: 'amplifier',  region: 'Taiwan' },
  '@mingchikuo':       { name: 'Ming-Chi Kuo',        type: 'watch-only', region: 'Asia' },
  '@damnang2':         { name: 'Damnang2',            type: 'amplifier',  region: 'United States' },
  '@zephyr_z9':        { name: 'Zephyr',              type: 'amplifier',  region: 'South Korea' },
  '@HyperTechInvest':  { name: 'Daniel Romero',       type: 'amplifier',  region: 'United States' },
  '@sssjeffpu':        { name: 'Jeff Pu',             type: 'amplifier',  region: 'Asia' },
  '@LinQingV':         { name: 'Macro_Lin',           type: 'amplifier',  region: 'China' },
  '@antiAIvo':         { name: '纳米AI',              type: 'amplifier',  region: 'China' },
  '@dylan522p':        { name: 'Dylan Patel',         type: 'competitor', region: 'International' },
  '@SemiAnalysis_':    { name: 'SemiAnalysis',        type: 'competitor', region: 'International' },
  '@ChipsandWafers':   { name: 'Chips & Wafers',      type: 'competitor', region: 'International' },
  '@fabknowledge':     { name: 'Fabricated Knowledge',type: 'competitor', region: 'International' },
  '@SKundojjala':      { name: 'Sravan Kundojjala',   type: 'competitor', region: 'International' },
  '@semivision_tw':    { name: 'SemiVision',          type: 'competitor', region: 'Taiwan' },
  '@qinbafrank':       { name: 'qinbafrank',          type: 'amplifier',  region: 'International' },
  '@insane_analyst':   { name: 'Irrational Analysis', type: 'amplifier',  region: 'International' },
  '@vikramskr':        { name: 'Vikram Sekar',        type: 'amplifier',  region: 'International' },
  '@pequityresearch':  { name: 'P Equity Research',   type: 'amplifier',  region: 'International' },
  '@dmjk001':          { name: 'kuaixun',             type: 'amplifier',  region: 'China' },
  '@wallstengine':     { name: 'Wall St Engine',      type: 'amplifier',  region: 'International' },
  '@oguzerkan':        { name: 'Oguz Erkan',          type: 'amplifier',  region: 'United States' },
  '@BSkypia59338':     { name: 'Moneytopia',          type: 'amplifier',  region: 'United States' },
  '@jordanschnyc':     { name: 'Jordan Schneider',    type: 'amplifier',  region: 'United States' },
};

const KNOWN_HANDLES = Object.keys(KNOWN_ACCOUNTS);

// Batch accounts into groups of 6 and use OR — reduces 28 queries to ~5
// Twitter search supports: (from:a OR from:b OR from:c) since:date
const BATCH_SIZE = 6;
const SEARCH_QUERIES = [];
for (let i = 0; i < KNOWN_HANDLES.length; i += BATCH_SIZE) {
  const batch = KNOWN_HANDLES.slice(i, i + BATCH_SIZE);
  const fromPart = batch.map(h => `from:${h.replace('@', '')}`).join(' OR ');
  SEARCH_QUERIES.push(`(${fromPart}) since:${sinceDate}`);
}

const SESSION_FILE    = path.join(__dirname, 'session.json');
const FOLLOWER_CACHE_FILE = path.join(__dirname, 'follower_cache.json');
const CSV_DIR         = path.join(__dirname, 'csv');
const TWEET_IMAGES_DIR = path.join(__dirname, 'images', 'tweets');

fs.mkdirSync(CSV_DIR, { recursive: true });
fs.mkdirSync(TWEET_IMAGES_DIR, { recursive: true });

const followerCache = fs.existsSync(FOLLOWER_CACHE_FILE)
  ? JSON.parse(fs.readFileSync(FOLLOWER_CACHE_FILE, 'utf8'))
  : {};

function downloadImage(url, destPath) {
  return new Promise((resolve) => {
    if (fs.existsSync(destPath)) return resolve(destPath);
    const file = fs.createWriteStream(destPath);
    https.get(url + ':large', (res) => {
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(destPath); });
    }).on('error', () => { fs.unlink(destPath, () => {}); resolve(null); });
  });
}

async function downloadImages(urls, destDir, prefix) {
  const results = [];
  for (const [i, url] of (urls || []).entries()) {
    const ext = url.includes('.png') ? 'png' : 'jpg';
    const destPath = path.join(destDir, `${prefix}_${i}.${ext}`);
    const result = await downloadImage(url, destPath);
    if (result) results.push(result);
  }
  return results;
}

function analyzeSentimentBatch(tweets) {
  try {
    const output = execSync('python3 sentiment.py', {
      input: JSON.stringify(tweets),
      cwd: __dirname,
      maxBuffer: 10 * 1024 * 1024,
    });
    return JSON.parse(output.toString());
  } catch (e) {
    console.warn('VADER sentiment failed:', e.message);
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

async function scrapeTweets(page, query, maxScrolls = 15) {
  const url = `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query&f=live`;
  console.log(`\nSearching: "${query}"`);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);

  // Detect blank/error page and wait for recovery
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

        const imageUrls = Array.from(el.querySelectorAll('[data-testid="tweetPhoto"] img'))
          .map(img => img.src)
          .filter(src => src && src.includes('pbs.twimg.com'));

        return {
          text, displayName, handle, timestamp, tweetUrl, imageUrls,
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

  tweets.forEach(t => { t.timestamp = toTaiwanISOString(t.timestamp); });
  return tweets;
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

    const RAW_FILE = path.join(__dirname, 'raw_watchlist.json');
    let allTweets = [];

    if (fs.existsSync(RAW_FILE)) {
      allTweets = JSON.parse(fs.readFileSync(RAW_FILE, 'utf8'));
      console.log(`\nResuming — loaded ${allTweets.length} tweets from raw_watchlist.json`);
      console.log('Delete raw_watchlist.json to start a fresh scrape.\n');
    } else {
      for (let qi = 0; qi < SEARCH_QUERIES.length; qi++) {
        // Cut 15 -> 8 (2026-08-05) - the account got suspended for
        // crawling too fast; see scrape_accounts.js's maxScrolls comment.
        const tweets = await scrapeTweets(page, SEARCH_QUERIES[qi], 8);
        allTweets.push(...tweets);
        fs.writeFileSync(RAW_FILE, JSON.stringify(allTweets, null, 2));
        // Cooldown between batches to avoid rate limiting
        if (qi < SEARCH_QUERIES.length - 1) {
          console.log('  Cooling down 20s before next batch...');
          await page.waitForTimeout(20000);
        }
      }
    }

    // Download images
    console.log('\nDownloading tweet images...');
    let imageCount = 0;
    for (const tweet of allTweets) {
      if (!tweet.imageUrls?.length || tweet.localImagePaths?.length) continue;
      const tweetId = tweet.tweetUrl.split('/status/')[1]?.split('?')[0] || 'unknown';
      const prefix = `${tweet.handle.replace('@', '')}_${tweetId}`;
      tweet.localImagePaths = await downloadImages(tweet.imageUrls, TWEET_IMAGES_DIR, prefix);
      imageCount += tweet.localImagePaths.length;
    }
    console.log(`  Downloaded ${imageCount} new images.`);
    fs.writeFileSync(RAW_FILE, JSON.stringify(allTweets, null, 2));

    // Deduplicate
    const deduped = [];
    const seenUrls = new Set();
    for (const tweet of allTweets) {
      const key = tweet.tweetUrl || tweet.text;
      if (key && !seenUrls.has(key)) { seenUrls.add(key); deduped.push(tweet); }
    }

    // Filter: only last 24h, only tweets that belong to the watchlist account (from: query)
    const cutoff = sinceArg ? new Date(sinceArg) : new Date(Date.now() - 24 * 60 * 60 * 1000);
    const filtered = deduped.filter(t => {
      if (t.timestamp && new Date(t.timestamp) < cutoff) return false;
      return true;
    });
    console.log(`\n${filtered.length} watchlist tweets in the last 24 hours.`);

    // Fetch profiles (cached)
    console.log('\nFetching profile data (followers + location)...');
    const uniqueHandles = [...new Set(filtered.map(t => t.handle).filter(Boolean))];
    const uncachedHandles = uniqueHandles.filter(h => followerCache[h.replace('@', '')] === undefined);
    if (uniqueHandles.length - uncachedHandles.length > 0)
      console.log(`  Skipping ${uniqueHandles.length - uncachedHandles.length} already-cached profiles.`);

    for (let i = 0; i < uncachedHandles.length; i++) {
      const handle = uncachedHandles[i];
      process.stdout.write(`  [${i + 1}/${uncachedHandles.length}] ${handle} ... `);
      try {
        const data = await getProfileData(page, handle);
        console.log(`followers: ${data.followers}, location: ${data.location || 'not set'}`);
      } catch {
        console.log('error');
        followerCache[handle.replace('@', '')] = { followers: 'unknown', location: null };
      }
      fs.writeFileSync(FOLLOWER_CACHE_FILE, JSON.stringify(followerCache, null, 2));
      await page.waitForTimeout(1000);
    }
    if (uncachedHandles.length === 0) console.log('  All profiles already cached.');

    // Attach profile + known account info
    const withMeta = filtered.map(tweet => {
      const profile = followerCache[tweet.handle.replace('@', '')] || {};
      const known = KNOWN_ACCOUNTS[tweet.handle] || KNOWN_ACCOUNTS[tweet.handle?.toLowerCase()] || null;
      return {
        ...tweet,
        followers: profile.followers || 'unknown',
        profileLocation: profile.location || 'unknown',
        knownAccount: !!known,
        accountType: known ? known.type : 'unknown',
        knownRegion: known ? known.region : null,
        knownName: known ? known.name : null,
      };
    });

    // Sentiment
    console.log('\nRunning VADER sentiment analysis...');
    const enriched = analyzeSentimentBatch(withMeta);

    // Load all existing watchlist CSVs to collect already-saved tweet URLs (prevents cross-day overlap)
    const existingUrls = new Set();
    const csvFiles = fs.readdirSync(CSV_DIR).filter(f => f.startsWith('watchlist_') && f.endsWith('.csv'));
    for (const file of csvFiles) {
      const lines = fs.readFileSync(path.join(CSV_DIR, file), 'utf8').split('\n').slice(1);
      for (const line of lines) {
        // tweetUrl is the 13th column (index 12); extract it safely
        const match = line.match(/https:\/\/x\.com\/[^\s,"]+/);
        if (match) existingUrls.add(match[0]);
      }
    }

    const truly_new = enriched.filter(t => !existingUrls.has(t.tweetUrl));
    const skipped = enriched.length - truly_new.length;
    if (skipped > 0) console.log(`  Skipped ${skipped} tweets already saved in a previous day's file.`);

    // Save CSV grouped by the tweet's actual date (not today's date)
    const header = 'timestamp,handle,displayName,followers,accountType,region,country,sentiment,sentimentScore,likes,retweets,replies,tweetUrl,text\n';

    const byDay = {};
    for (const t of truly_new) {
      const day = t.timestamp ? t.timestamp.slice(0, 10) : new Date().toISOString().slice(0, 10);
      if (!byDay[day]) byDay[day] = [];
      byDay[day].push(t);
    }

    for (const [day, dayTweets] of Object.entries(byDay)) {
      const csvFile = path.join(CSV_DIR, `watchlist_${day}.csv`);
      const existingContent = fs.existsSync(csvFile)
        ? fs.readFileSync(csvFile, 'utf8')
        : header;
      const hasHeader = existingContent.startsWith('timestamp');
      const rows = dayTweets.map(t => {
        const country = t.knownRegion || t.guessedCountry || 'Unknown';
        return [
          t.timestamp, safe(t.handle), safe(t.displayName), safe(t.followers),
          safe(t.accountType), safe(t.knownRegion || ''), safe(country),
          t.sentiment, t.sentimentScore,
          t.likes, t.retweets, t.replies,
          safe(t.tweetUrl), safe(t.text),
        ].join(',');
      }).join('\n');
      const content = hasHeader ? existingContent.trimEnd() + '\n' + rows + '\n' : header + rows + '\n';
      fs.writeFileSync(csvFile, content);
      console.log(`  csv/watchlist_${day}.csv — ${dayTweets.length} new tweets`);
    }
    console.log(`\nDone. ${truly_new.length} new tweets saved across ${Object.keys(byDay).length} day file(s).`);

    // Cleanup raw file
    fs.unlinkSync(RAW_FILE);

    const sentimentSummary = enriched.reduce((acc, t) => {
      acc[t.sentiment] = (acc[t.sentiment] || 0) + 1;
      return acc;
    }, {});
    console.log('Sentiment breakdown:', sentimentSummary);

  } catch (err) {
    console.error('Error:', err.message);
    await page.screenshot({ path: 'error-watchlist.png' });
  } finally {
    await browser.close();
  }
}

main();
