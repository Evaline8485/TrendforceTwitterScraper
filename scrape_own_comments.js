require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { toTaiwanISOString } = require('./tz_util');

// Scrapes the actual reply/comment text under our own tweets, so
// TrendForceDash's FR-05 reply queue can show real comment content
// instead of just a reply count. Scoped deliberately narrow: only the
// specific tweet URLs passed in (TrendForceDash decides which of our own
// posts currently qualify - see account_comment_management.py's
// NEEDS_RESPONSE_THRESHOLD / RECENT_WITHIN_DAYS), not a general scrape.
//
// Usage: node scrape_own_comments.js <tweetUrl1> [tweetUrl2 ...]
//   or:  node scrape_own_comments.js --file urls.json   (a JSON array of URLs)
//
// Output: own_comments.json, keyed by tweet URL:
//   { "<tweetUrl>": [{ author, text, timestamp, likes }, ...] }

const SESSION_FILE = path.join(__dirname, 'session.json');
const OUT_FILE = path.join(__dirname, 'own_comments.json');
const MAX_COMMENTS_PER_POST = 20;

function parseArgs() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--file') {
    return JSON.parse(fs.readFileSync(argv[1], 'utf8'));
  }
  return argv.filter(a => a.startsWith('http'));
}

async function scrapeCommentsForUrl(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="tweet"]', { timeout: 15000 }).catch(() => {});
  // Give replies a moment to stream in below the main tweet.
  await page.waitForTimeout(2500);

  const comments = await page.evaluate((maxComments) => {
    const cards = Array.from(document.querySelectorAll('[data-testid="tweet"]'));
    // The first card on a tweet's own detail page is the tweet itself, not
    // a reply - every card after it in document order is a reply/comment.
    return cards.slice(1, 1 + maxComments).map((el) => {
      const textEl = el.querySelector('[data-testid="tweetText"]');
      const text = textEl ? textEl.innerText : '';
      const timeEl = el.querySelector('time');
      const timestamp = timeEl ? timeEl.getAttribute('datetime') : '';
      const userEl = el.querySelector('[data-testid="User-Name"]');
      const userLinks = userEl ? Array.from(userEl.querySelectorAll('a')) : [];
      const author = userLinks[1] ? userLinks[1].innerText : '';
      const likeBtn = el.querySelector('[data-testid="like"]');
      const likeSpan = likeBtn ? likeBtn.querySelector('span > span') : null;
      const likes = likeSpan ? likeSpan.innerText : '0';
      return { author, text, timestamp, likes };
    }).filter(c => c.text);
  }, MAX_COMMENTS_PER_POST);

  return comments.map(c => ({ ...c, timestamp: c.timestamp ? toTaiwanISOString(c.timestamp) : '' }));
}

async function main() {
  const urls = parseArgs();
  if (!urls.length) {
    console.log('Usage: node scrape_own_comments.js <tweetUrl1> [tweetUrl2 ...]');
    console.log('   or: node scrape_own_comments.js --file urls.json');
    process.exit(1);
  }

  const contextOptions = {
    viewport: { width: 1280, height: 900 },
  };
  if (fs.existsSync(SESSION_FILE)) contextOptions.storageState = SESSION_FILE;

  const browser = await chromium.launch({ headless: false, channel: 'chrome', args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  const results = fs.existsSync(OUT_FILE) ? JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')) : {};

  for (const url of urls) {
    console.log(`Scraping comments for ${url} ...`);
    try {
      const comments = await scrapeCommentsForUrl(page, url);
      results[url] = comments;
      console.log(`  Found ${comments.length} comment(s).`);
    } catch (err) {
      console.log(`  [!] Failed: ${err.message}`);
    }
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(results, null, 2));
  console.log(`Saved to ${OUT_FILE}`);

  await browser.close();
}

main();
