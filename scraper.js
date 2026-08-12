require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');
const { toTaiwanISOString } = require('./tz_util');

// Build since date — pass --since YYYY-MM-DD to override, defaults to last 24h
const sinceArg = process.argv.includes('--since') ? process.argv[process.argv.indexOf('--since') + 1] : null;
const sinceDate = sinceArg || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const since7d   = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
if (sinceArg) console.log(`Running with custom since date: ${sinceDate}`);

// Known influencer accounts from the watchlist
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
  '@tphuang':          { name: 'tphuang',             type: 'competitor', region: 'International' },
  '@tengyanAI':        { name: 'tengyanAI',           type: 'competitor', region: 'International' },
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
const SEARCH_QUERIES = [
  `TrendForce since:${sinceDate}`,
  `trendforce.com since:${sinceDate}`,
  `insights.trendforce.com since:${sinceDate}`,
];

const TRENDFORCE_HANDLES = new Set([
  '@trendforce', '@trendforce_', '@trendforceresearch', '@trendforce_inc', 'trendforce',
]);

const OUTPUT_FILE      = path.join(__dirname, 'results.json');
const SESSION_FILE     = path.join(__dirname, 'session.json');
const TF_REFERENCE_FILE = path.join(__dirname, 'tf_reference.json');
const TF_IMAGES_DIR    = path.join(__dirname, 'images', 'trendforce');
const TWEET_IMAGES_DIR = path.join(__dirname, 'images', 'tweets');
const FOLLOWER_CACHE_FILE = path.join(__dirname, 'follower_cache.json');

fs.mkdirSync(TF_IMAGES_DIR,    { recursive: true });
fs.mkdirSync(TWEET_IMAGES_DIR, { recursive: true });

const followerCache = fs.existsSync(FOLLOWER_CACHE_FILE)
  ? JSON.parse(fs.readFileSync(FOLLOWER_CACHE_FILE, 'utf8'))
  : {};

// --- Image downloading ---
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

// --- Python batch calls ---
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

function analyzeCreditBatch(tweets, tfReference) {
  try {
    const output = execSync('python3 analyze_credit.py', {
      input: JSON.stringify({ tweets, tfReference }),
      cwd: __dirname,
      maxBuffer: 50 * 1024 * 1024,
    });
    return JSON.parse(output.toString());
  } catch (e) {
    console.warn('Credit analysis failed:', e.message);
    return tweets.map(t => ({ ...t, creditFlag: 'analysis_error' }));
  }
}

// --- Profile data ---
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

async function saveSession(context) {
  const storage = await context.storageState();
  fs.writeFileSync(SESSION_FILE, JSON.stringify(storage, null, 2));
  console.log('Session saved to session.json');
}

async function login(page) {
  console.log('\n=== MANUAL LOGIN REQUIRED ===');
  console.log('A browser window has opened. Please log in to X/Twitter manually.');
  console.log('The script will continue automatically once you reach the home feed.\n');
  await page.goto('https://x.com/login', { waitUntil: 'domcontentloaded' });
  await page.waitForURL('**/home', { timeout: 180000 });
  console.log('Login detected. Continuing...');
}

function isTrendForceAccount(handle) {
  const lower = handle.toLowerCase().replace('@', '');
  return TRENDFORCE_HANDLES.has('@' + lower) || TRENDFORCE_HANDLES.has(lower) || lower.includes('trendforce');
}

// --- Keyword/topic extraction ---
const TECH_KEYWORDS = [
  'nand', 'dram', 'hbm', 'hbm2', 'hbm3', 'ddr5', 'lpddr', 'qlc', 'tlc',
  'semiconductor', 'chip', 'wafer', 'foundry', 'tsmc', 'samsung', 'sk hynix',
  'micron', 'intel', 'nvidia', 'amd', 'qualcomm', 'apple', 'mediatek',
  'memory', 'storage', 'ssd', 'nand flash', 'server', 'ai server', 'datacenter',
  'data center', 'gpu', 'cpu', 'arm', 'supply chain', 'panel', 'oled', 'lcd',
  'display', 'smartphone', 'iphone', 'shipment', 'capacity', 'demand', 'price',
  'contract price', 'spot price', 'inventory', 'oversupply', 'shortage',
  'trendforce', 'semianalysis', 'semivision', 'ics', 'packaging', 'cowos',
  'ai', 'ml', 'llm', 'inference', 'training', 'hyperscaler', 'capex',
];

function extractKeywords(text) {
  const lower = text.toLowerCase();
  // Hashtags
  const hashtags = (text.match(/#\w+/g) || []).map(h => h.toLowerCase());
  // Tech keyword matches
  const techMatches = TECH_KEYWORDS.filter(kw => lower.includes(kw));
  // Combine and deduplicate
  const all = [...new Set([...hashtags, ...techMatches])];
  return all.join('; ');
}

// --- Scrape individual account profile timeline ---
async function scrapeAccountTimeline(page, handle, maxScrolls = 15) {
  const cleanHandle = handle.replace('@', '');
  console.log(`\nScraping timeline for ${handle}...`);
  await page.goto(`https://x.com/${cleanHandle}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  const seen = new Set();
  const tweets = [];

  for (let scroll = 0; scroll < maxScrolls; scroll++) {
    await page.waitForSelector('[data-testid="tweet"]', { timeout: 10000 }).catch(() => {});

    const newTweets = await page.evaluate((h) => {
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

        return { text, timestamp, tweetUrl,
          likes: getStatText('like'),
          retweets: getStatText('retweet'),
          replies: getStatText('reply'),
        };
      });
    }, cleanHandle);

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

// --- Tweet scraping (with image URL extraction) ---
async function scrapeTweets(page, query, maxScrolls = 15) {
  const url = `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query&f=live`;
  console.log(`\nSearching: "${query}"`);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

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

        // Extract image URLs from tweet photos
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

// --- Scrape TrendForce's own tweets as reference ---
async function scrapeTFReference(page) {
  if (fs.existsSync(TF_REFERENCE_FILE)) {
    const existing = JSON.parse(fs.readFileSync(TF_REFERENCE_FILE, 'utf8'));
    console.log(`TF reference already cached (${existing.length} tweets). Delete tf_reference.json to refresh.`);
    return existing;
  }

  console.log('\nScraping TrendForce reference tweets (last 7 days)...');
  const tweets = await scrapeTweets(page, `from:TrendForce since:${since7d}`, 20);

  for (const tweet of tweets) {
    const tweetId = tweet.tweetUrl.split('/status/')[1]?.split('?')[0] || Date.now().toString();
    tweet.localImagePaths = await downloadImages(tweet.imageUrls, TF_IMAGES_DIR, `tf_${tweetId}`);
  }

  fs.writeFileSync(TF_REFERENCE_FILE, JSON.stringify(tweets, null, 2));
  console.log(`TF reference: ${tweets.length} tweets + images saved.`);
  return tweets;
}

async function main() {
  const hasSession = fs.existsSync(SESSION_FILE);

  const browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  const contextOptions = {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  };
  if (hasSession) {
    console.log('Found saved session, reusing...');
    contextOptions.storageState = SESSION_FILE;
  }

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  try {
    if (!hasSession) {
      await login(page);
      await saveSession(context);
    } else {
      await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
      const isLoggedIn = await page.$('[data-testid="SideNav_AccountSwitcher_Button"]');
      if (!isLoggedIn) {
        console.log('Session expired, logging in again...');
        await login(page);
        await saveSession(context);
      } else {
        console.log('Session valid, skipping login.');
      }
    }

    // TrendForce/watchlist mention search is no longer needed (2026-08-12),
    // but this is still the only script that knows how to log in/refresh
    // session.json - every other script (scrape_accounts.js,
    // scrape_video_discovery.js, ...) just reads that file and fails if
    // it's stale. --login-only keeps that refresh alive on the daily
    // schedule without running the mention-scraping/credit-analysis flow
    // below it.
    if (process.argv.includes('--login-only')) {
      console.log('--login-only: session is valid/refreshed, skipping mention search.');
      return;
    }

    const safe = (s) => `"${String(s ?? '').replace(/"/g, '""').replace(/\n/g, ' ')}"`;
    const csvDir = path.join(__dirname, 'csv');
    fs.mkdirSync(csvDir, { recursive: true });

    // --- TrendForce reference tweets ---
    const tfReference = await scrapeTFReference(page);

    // --- Scrape watchlist + TF mention tweets ---
    const RAW_FILE = path.join(__dirname, 'raw_tweets.json');
    let allTweets = [];
    if (fs.existsSync(RAW_FILE)) {
      allTweets = JSON.parse(fs.readFileSync(RAW_FILE, 'utf8'));
      console.log(`\nResuming — loaded ${allTweets.length} tweets from raw_tweets.json`);
      console.log('Delete raw_tweets.json to start a fresh scrape.\n');
    } else {
      for (const query of SEARCH_QUERIES) {
        const tweets = await scrapeTweets(page, query, 15);
        allTweets.push(...tweets);
        fs.writeFileSync(RAW_FILE, JSON.stringify(allTweets, null, 2));
      }
    }

    // --- Download images for watchlist tweets ---
    console.log('\nDownloading tweet images...');
    let imageCount = 0;
    for (const tweet of allTweets) {
      if (!tweet.imageUrls?.length) continue;
      if (tweet.localImagePaths?.length) continue; // already downloaded
      const tweetId = tweet.tweetUrl.split('/status/')[1]?.split('?')[0] || 'unknown';
      const prefix = `${tweet.handle.replace('@', '')}_${tweetId}`;
      tweet.localImagePaths = await downloadImages(tweet.imageUrls, TWEET_IMAGES_DIR, prefix);
      imageCount += tweet.localImagePaths.length;
    }
    console.log(`  Downloaded ${imageCount} new images.`);
    fs.writeFileSync(RAW_FILE, JSON.stringify(allTweets, null, 2));

    // --- Deduplicate ---
    const deduped = [];
    const seenUrls = new Set();
    for (const tweet of allTweets) {
      const key = tweet.tweetUrl || tweet.text;
      if (key && !seenUrls.has(key)) { seenUrls.add(key); deduped.push(tweet); }
    }

    // --- Filter TrendForce accounts + older than since date + known accounts with no TF relevance ---
    const cutoff = sinceArg ? new Date(sinceArg) : new Date(Date.now() - 24 * 60 * 60 * 1000);
    const TF_KEYWORDS = [
      'trendforce', 'trendforce.com', 'nand', 'dram', 'hbm', 'semiconductor',
      'wafer', 'foundry', 'tsmc', 'memory', 'server', 'ai server', 'panel',
      'display', 'smartphone', 'shipment', 'supply chain', 'chip', 'fab',
    ];
    function hasTFRelevance(tweet) {
      const lower = tweet.text.toLowerCase();
      return TF_KEYWORDS.some(kw => lower.includes(kw));
    }
    const beforeFilter = deduped.length;
    const filtered = deduped.filter(t => {
      if (isTrendForceAccount(t.handle)) return false;
      if (t.timestamp && new Date(t.timestamp) < cutoff) return false;
      // For known watchlist accounts scraped via from: query, only keep TF-relevant tweets
      const isKnown = !!(KNOWN_ACCOUNTS[t.handle] || KNOWN_ACCOUNTS[t.handle?.toLowerCase()]);
      if (isKnown && !hasTFRelevance(t)) return false;
      return true;
    });
    console.log(`\nFiltered out ${beforeFilter - filtered.length} irrelevant tweets. ${filtered.length} remain.`);

    // --- Fetch profiles (cached) ---
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

    // --- Attach profile + known account info ---
    const withMeta = filtered.map(tweet => {
      const profile = followerCache[tweet.handle.replace('@', '')] || {};
      const known = KNOWN_ACCOUNTS[tweet.handle] || KNOWN_ACCOUNTS[tweet.handle.toLowerCase()] || null;
      return {
        ...tweet,
        followers: profile.followers || 'unknown',
        profileLocation: profile.location || 'unknown',
        knownAccount: !!known,
        accountType: known ? known.type : 'unknown',
        knownRegion: known ? known.region : null,
      };
    });

    // --- Sentiment ---
    console.log('\nRunning VADER sentiment analysis...');
    const withSentiment = analyzeSentimentBatch(withMeta);

    // --- Credit analysis ---
    console.log('Running credit analysis...');
    const enriched = analyzeCreditBatch(withSentiment, tfReference);

    // --- Merge with previous results ---
    let previous = [];
    if (fs.existsSync(OUTPUT_FILE)) {
      try {
        previous = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
        console.log(`\nLoaded ${previous.length} tweets from previous runs.`);
      } catch { previous = []; }
    }

    const merged = [...enriched];
    const mergedKeys = new Set(enriched.map(t => t.tweetUrl || t.text));
    const previousNeedingCredit = [];
    for (const t of previous) {
      const key = t.tweetUrl || t.text;
      if (!mergedKeys.has(key)) {
        mergedKeys.add(key);
        if (!t.creditFlag) previousNeedingCredit.push(t);
        else merged.push(t);
      }
    }
    if (previousNeedingCredit.length > 0) {
      console.log(`Re-running credit analysis on ${previousNeedingCredit.length} older tweets...`);
      const reanalyzed = analyzeCreditBatch(previousNeedingCredit, tfReference);
      merged.push(...reanalyzed);
    }

    merged.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    console.log(`Merged total: ${merged.length} tweets (${merged.length - previous.length} new).`);

    // --- Save JSON ---
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(merged, null, 2));
    console.log(`Saved to results.json`);

    // --- Save CSV (one file per day) ---
    const header ='timestamp,handle,displayName,followers,knownAccount,accountType,country,sentiment,sentimentScore,creditFlag,cited,textSimilarity,imageMatch,ocrFoundTF,likes,retweets,replies,tweetUrl,text\n';

    const byDay = {};
    for (const t of merged) {
      const day = t.timestamp ? t.timestamp.slice(0, 10) : 'unknown';
      if (!byDay[day]) byDay[day] = [];
      byDay[day].push(t);
    }

    for (const [day, tweets] of Object.entries(byDay)) {
      const rows = tweets.map(t => {
        const country = t.knownRegion || t.guessedCountry || 'Unknown';
        return [
          t.timestamp, safe(t.handle), safe(t.displayName), safe(t.followers),
          t.knownAccount ? 'yes' : 'no', safe(t.accountType), safe(country),
          t.sentiment, t.sentimentScore,
          safe(t.creditFlag ?? ''), t.cited ? 'yes' : 'no',
          t.textSimilarity ?? '', t.imageMatch ? 'yes' : 'no', t.ocrFoundTF ? 'yes' : 'no',
          t.likes, t.retweets, t.replies, safe(t.tweetUrl), safe(t.text),
        ].join(',');
      }).join('\n');
      const csvFile = path.join(csvDir, `${day}.csv`);
      fs.writeFileSync(csvFile, header + rows);
      console.log(`  csv/${day}.csv — ${tweets.length} tweets`);
    }
    console.log(`CSVs saved to csv/ folder`);

    // --- Summary ---
    const creditSummary = merged.reduce((acc, t) => {
      if (t.creditFlag) acc[t.creditFlag] = (acc[t.creditFlag] || 0) + 1;
      return acc;
    }, {});
    const sentimentSummary = merged.reduce((acc, t) => {
      acc[t.sentiment] = (acc[t.sentiment] || 0) + 1;
      return acc;
    }, {});
    console.log('\nCredit breakdown:', creditSummary);
    console.log('Sentiment breakdown:', sentimentSummary);

  } catch (err) {
    console.error('Error:', err.message);
    await page.screenshot({ path: 'error-screenshot.png' });
    console.log('Screenshot saved to error-screenshot.png');
  } finally {
    await browser.close();
  }
}

if (process.argv[2] === '--debug-followers') {
  const handle = process.argv[3] || '@trendforce';
  (async () => {
    const browser = await chromium.launch({ headless: false });
    const contextOptions = {
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 900 },
    };
    if (fs.existsSync(SESSION_FILE)) contextOptions.storageState = SESSION_FILE;
    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();
    const result = await getProfileData(page, handle);
    console.log(`Profile for ${handle}:`, result);
    await browser.close();
  })();
} else {
  main();
}
