// One-time full rescrape — 225 scrolls, appends to existing CSV without clearing it.
// Usage: node rescrape_full.js @jukan05 @QQ_Timmy
require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { toTaiwanISOString } = require('./tz_util');

const SESSION_FILE = path.join(__dirname, 'session.json');
const CSV_DIR = path.join(__dirname, 'csv');
const MAX_SCROLLS = 225;

const HANDLES = process.argv.slice(2);
if (!HANDLES.length) {
  console.error('Usage: node rescrape_full.js @handle1 @handle2 ...');
  process.exit(1);
}

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

async function scrapeTimeline(page, handle, maxScrolls) {
  const cleanHandle = handle.replace('@', '');
  console.log(`\nScraping ${handle} (${maxScrolls} scrolls)...`);
  await page.goto(`https://x.com/${cleanHandle}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);

  for (let attempt = 0; attempt < 3; attempt++) {
    const errorEl = await page.$('span:has-text("Something went wrong")');
    if (!errorEl) break;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);
  }

  const seen = new Set();
  const tweets = [];

  for (let scroll = 0; scroll < maxScrolls; scroll++) {
    const errorEl = await page.$('span:has-text("Something went wrong")');
    if (errorEl) {
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
        const isRetweet = text.startsWith('RT @');
        const userEl = el.querySelector('[data-testid="User-Name"]');
        const userLinks = userEl ? Array.from(userEl.querySelectorAll('a')) : [];
        const tweetHandle = userLinks[1] ? userLinks[1].innerText.toLowerCase() : '';
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
        return { text, timestamp, tweetUrl, hasImages, isRetweet, tweetHandle, views,
          likes: getStatText('like'), retweets: getStatText('retweet'), replies: getStatText('reply') };
      });
    });

    let added = 0;
    for (const t of newTweets) {
      const key = t.tweetUrl || t.text;
      if (key && !seen.has(key)) { seen.add(key); tweets.push(t); added++; }
    }
    console.log(`  Scroll ${scroll + 1}/${maxScrolls} — +${added} (total: ${tweets.length})`);
    if (added === 0 && scroll > 15) { console.log('  No new tweets, stopping early.'); break; }

    await page.evaluate(() => {
      const tweets = document.querySelectorAll('[data-testid="tweet"]');
      if (tweets.length > 0) tweets[tweets.length - 1].scrollIntoView({ behavior: 'instant', block: 'end' });
      else window.scrollBy(0, window.innerHeight * 2);
    });
    await page.waitForTimeout(4000);
  }
  tweets.forEach(t => { t.timestamp = toTaiwanISOString(t.timestamp); });
  return tweets;
}

async function main() {
  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome', // real Google Chrome - see scraper.js main() for why
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  const contextOptions = {
    viewport: { width: 1280, height: 900 },
  };
  if (fs.existsSync(SESSION_FILE)) contextOptions.storageState = SESSION_FILE;
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  try {
    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    const isLoggedIn = await page.$('[data-testid="SideNav_AccountSwitcher_Button"]');
    if (!isLoggedIn) { console.log('Not logged in.'); process.exit(1); }

    for (const handle of HANDLES) {
      const cleanHandle = handle.replace('@', '');
      const csvFile = path.join(CSV_DIR, `${cleanHandle}.csv`);

      // Load existing URLs from master CSV — we never clear this
      const existingUrls = new Set();
      let existingRows = '';
      if (fs.existsSync(csvFile)) {
        const lines = fs.readFileSync(csvFile, 'utf8').split('\n');
        existingRows = lines.slice(1).filter(l => l.trim()).join('\n');
        for (const line of lines.slice(1)) {
          const cols = line.match(/("(?:[^"]|"")*"|[^,]*)/g) || [];
          const url = cols[7] ? cols[7].replace(/^"|"$/g, '') : '';
          if (url) existingUrls.add(url);
        }
        console.log(`${handle}: ${existingUrls.size} existing tweets in master CSV.`);
      }

      const allTweets = await scrapeTimeline(page, handle, MAX_SCROLLS);

      const newTweets = allTweets.filter(t => {
        if (t.isRetweet) return false;
        if (!t.tweetUrl) return false;
        const urlHandle = t.tweetUrl.split('/')[3]?.toLowerCase();
        if (urlHandle !== cleanHandle.toLowerCase()) return false;
        if (existingUrls.has(t.tweetUrl)) return false;
        existingUrls.add(t.tweetUrl);
        return true;
      });

      console.log(`  ${newTweets.length} new tweets to enrich and add.`);
      if (newTweets.length === 0) { console.log('  Nothing new.'); continue; }

      console.log(`  Enriching...`);
      const enriched = enrichTweets(newTweets);

      const header = 'timestamp,views,likes,retweets,replies,hasImages,keywords,tweetUrl,text,translated_text\n';
      const newRows = enriched.map(t =>
        [t.timestamp, t.views ?? '0', t.likes, t.retweets, t.replies,
         t.hasImages ? 'yes' : 'no',
         safe(t.keywords), safe(t.tweetUrl), safe(t.text), safe(t.translatedText ?? '')].join(',')
      ).join('\n');

      const combined = existingRows ? header + newRows + '\n' + existingRows : header + newRows;
      fs.writeFileSync(csvFile, combined);
      console.log(`Updated csv/${cleanHandle}.csv (+${newTweets.length} new, ${existingUrls.size} total)`);
    }
  } catch (err) {
    console.error('Error:', err.message);
    await page.screenshot({ path: 'error-screenshot.png' });
  } finally {
    await browser.close();
  }
}

main();
