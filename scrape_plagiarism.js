// Plagiarism hunter for Twitter/X
// Extracts distinctive phrases/stats from TrendForce's own tweets,
// then searches Twitter for anyone using them without crediting TrendForce.
// Run after scraper.js so tf_reference.json exists.
require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const TF_REF_FILE  = path.join(__dirname, 'tf_reference.json');
const OUTPUT_FILE  = path.join(__dirname, 'results_plagiarism_twitter.json');
const SESSION_FILE = path.join(__dirname, 'session.json');
const CSV_DIR      = path.join(__dirname, 'csv');

fs.mkdirSync(CSV_DIR, { recursive: true });

const sinceDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

const TRENDFORCE_HANDLES = new Set([
  'trendforce', 'trendforce_', 'trendforceresearch', 'trendforce_inc',
]);

const CITATION_PATTERNS = [
  /according to trendforce/i,
  /trendforce (reports?|says?|notes?|data|research|estimates?|forecasts?|predicts?)/i,
  /per trendforce/i, /citing trendforce/i,
  /source[d]?[: ]+trendforce/i, /via trendforce/i,
  /trendforce\.com/i, /trendforce research/i, /\(trendforce\)/i,
];

function isCitation(text) {
  return CITATION_PATTERNS.some(p => p.test(text));
}

function isTrendForceAccount(handle) {
  const lower = handle.toLowerCase().replace('@', '').replace(/\s/g, '');
  return TRENDFORCE_HANDLES.has(lower) || lower.includes('trendforce');
}

function extractPhrases(referencePosts) {
  try {
    const output = execSync('python3 extract_phrases.py', {
      input: JSON.stringify(referencePosts),
      cwd: __dirname,
      maxBuffer: 10 * 1024 * 1024,
    });
    return JSON.parse(output.toString());
  } catch (e) {
    console.warn('Phrase extraction failed:', e.message);
    return [];
  }
}

async function searchTwitter(page, phrase, maxScrolls = 8) {
  // Search for the phrase, exclude TrendForce's own accounts
  const query = `"${phrase}" since:${sinceDate} -from:TrendForce -from:TrendForce_`;
  const url = `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query&f=live`;

  console.log(`  Searching: "${phrase}"`);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);

  // Blank/error page detection
  for (let attempt = 0; attempt < 3; attempt++) {
    const bodyText = await page.evaluate(() => document.body?.innerText?.trim() || '');
    const hasError = await page.$('span:has-text("Something went wrong")');
    if (bodyText.length >= 50 && !hasError) break;
    console.log(`    Blank/error page, waiting 15s (${attempt + 1}/3)...`);
    await page.waitForTimeout(15000);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);
  }

  const seen = new Set();
  const results = [];

  for (let scroll = 0; scroll < maxScrolls; scroll++) {
    await page.waitForSelector('[data-testid="tweet"]', { timeout: 10000 }).catch(() => {});

    const tweets = await page.evaluate(() => {
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
          likes: getStatText('like'),
          retweets: getStatText('retweet'),
          replies: getStatText('reply'),
        };
      });
    });

    let added = 0;
    for (const t of tweets) {
      const key = t.tweetUrl || t.text;
      if (!key || seen.has(key)) continue;
      if (isTrendForceAccount(t.handle)) continue;
      seen.add(key);
      results.push(t);
      added++;
    }

    console.log(`    Scroll ${scroll + 1}/${maxScrolls} — +${added} (total: ${results.length})`);
    if (added === 0 && scroll > 2) break;

    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 3));
    await page.waitForTimeout(3000);
  }

  return results;
}

const safe = (s) => `"${String(s ?? '').replace(/"/g, '""').replace(/\n/g, ' ')}"`;

async function main() {
  if (!fs.existsSync(TF_REF_FILE)) {
    console.error('tf_reference.json not found. Run npm run scrape first to generate it.');
    process.exit(1);
  }

  const tfPosts = JSON.parse(fs.readFileSync(TF_REF_FILE, 'utf8'));
  console.log(`Loaded ${tfPosts.length} TrendForce reference tweets.`);

  // Extract distinctive phrases
  console.log('Extracting distinctive phrases from TF tweets...');
  const phraseData = extractPhrases(tfPosts);
  // Cap at 10 phrases to avoid rate limiting
  const cappedPhraseData = [];
  let total = 0;
  for (const pd of phraseData) {
    if (total >= 10) break;
    const phrases = pd.phrases.slice(0, 2);
    cappedPhraseData.push({ ...pd, phrases });
    total += phrases.length;
  }

  if (cappedPhraseData.length === 0) {
    console.error('No phrases extracted. TF reference tweets may not contain enough numeric content.');
    process.exit(1);
  }

  console.log(`\nWill search for ${total} phrases from ${cappedPhraseData.length} TF tweets:`);
  cappedPhraseData.forEach(pd => {
    console.log(`\n  TF tweet: "${pd.text.slice(0, 80)}..."`);
    pd.phrases.forEach(ph => console.log(`    → "${ph}"`));
  });

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
    if (!isLoggedIn) {
      console.error('Not logged in. Run npm run scrape first.');
      process.exit(1);
    }

    const allResults = [];
    const seen = new Set();

    for (let pi = 0; pi < cappedPhraseData.length; pi++) {
      const pd = cappedPhraseData[pi];
      console.log(`\n[${pi + 1}/${cappedPhraseData.length}] TF tweet: "${pd.text.slice(0, 60)}..."`);

      for (const phrase of pd.phrases) {
        const tweets = await searchTwitter(page, phrase);

        for (const t of tweets) {
          const key = t.tweetUrl || t.text.slice(0, 60);
          if (seen.has(key)) continue;
          seen.add(key);
          allResults.push({
            ...t,
            matchedPhrase: phrase,
            tfSourceText: pd.text,
            cited: isCitation(t.text),
            creditFlag: isCitation(t.text) ? 'credited' : 'uncredited',
            scrapedAt: new Date().toISOString(),
          });
        }

        // Cooldown between searches
        if (phrase !== pd.phrases[pd.phrases.length - 1] || pi < cappedPhraseData.length - 1) {
          console.log('    Cooling down 8s...');
          await page.waitForTimeout(8000);
        }
      }
    }

    console.log(`\nTotal matches found: ${allResults.length}`);
    const uncredited = allResults.filter(r => r.creditFlag === 'uncredited');
    const credited   = allResults.filter(r => r.creditFlag === 'credited');
    console.log(`  Credited (cited TF):          ${credited.length}`);
    console.log(`  Uncredited (potential plagiarism): ${uncredited.length}`);

    // Merge with previous results
    let previous = [];
    if (fs.existsSync(OUTPUT_FILE)) {
      try { previous = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8')); } catch { previous = []; }
    }
    const merged = [...allResults];
    const mergedKeys = new Set(allResults.map(r => r.tweetUrl || r.text.slice(0, 60)));
    for (const r of previous) {
      const key = r.tweetUrl || r.text.slice(0, 60);
      if (!mergedKeys.has(key)) { mergedKeys.add(key); merged.push(r); }
    }
    merged.sort((a, b) => new Date(b.scrapedAt) - new Date(a.scrapedAt));

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(merged, null, 2));
    console.log('Saved results_plagiarism_twitter.json');

    // Save CSV
    const today = new Date().toISOString().slice(0, 10);
    const header = 'scrapedAt,creditFlag,handle,displayName,matchedPhrase,tfSourceText,likes,retweets,replies,tweetUrl,text\n';
    const rows = merged.map(r => [
      safe(r.scrapedAt), safe(r.creditFlag), safe(r.handle), safe(r.displayName),
      safe(r.matchedPhrase), safe(r.tfSourceText),
      r.likes, r.retweets, r.replies,
      safe(r.tweetUrl), safe(r.text),
    ].join(',')).join('\n');

    const csvFile = path.join(CSV_DIR, `plagiarism_twitter_${today}.csv`);
    fs.writeFileSync(csvFile, header + rows);
    console.log(`Saved csv/plagiarism_twitter_${today}.csv (${merged.length} rows)`);

    // Print uncredited clearly
    if (uncredited.length > 0) {
      console.log('\n--- POTENTIAL PLAGIARISM ---');
      uncredited.forEach(r => {
        console.log(`\n  @${r.handle} (${r.displayName})`);
        console.log(`  Matched phrase: "${r.matchedPhrase}"`);
        console.log(`  Their tweet: "${r.text.slice(0, 150)}"`);
        console.log(`  URL: ${r.tweetUrl}`);
      });
    } else {
      console.log('\nNo uncredited matches found.');
    }

  } catch (err) {
    console.error('Error:', err.message);
    await page.screenshot({ path: 'error-plagiarism.png' });
  } finally {
    await browser.close();
  }
}

main();
