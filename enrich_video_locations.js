require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

/**
 * Fetches each X account's own profile-location field (the free-text
 * "UserLocation" a user can set, e.g. "San Francisco, CA" or "Tokyo,
 * Japan") for every handle that shows up in X Video Ranking's pool -
 * both our tracked accounts (accounts_config.json) and any account
 * discovered via scrape_video_discovery.js's keyword search (the whole
 * point of that feature is surfacing accounts we've never seen before,
 * so this can't be limited to a hand-curated list the way
 * scrape_watchlist.js's region tagging is).
 *
 * Same technique as scrape_watchlist.js's getProfileData() (same
 * UserLocation selector), but a separate cache/script since video
 * ranking's account pool is much larger and grows daily via discovery -
 * mixing it into scrape_watchlist.js's smaller, hand-curated cache would
 * make that file's own purpose less clear.
 *
 * Cached permanently once fetched (including a null/not-set result) -
 * profile location changes are rare, and re-checking indefinitely-growing
 * discovery accounts every day would make this slower every day for no
 * benefit. Bounded per run (MAX_LOOKUPS_PER_RUN) so a day with many newly
 * discovered accounts doesn't turn this into an hours-long step.
 */
const SESSION_FILE = path.join(__dirname, 'session.json');
const LOCATION_CACHE_FILE = path.join(__dirname, 'account_locations.json');
const VIDEO_DISCOVERY_CSV = path.join(__dirname, 'csv', 'video_discovery.csv');
const ACCOUNTS_CONFIG_FILE = '/Users/elainekao/TrendForceDash/accounts_config.json';
const MAX_LOOKUPS_PER_RUN = 100;

const locationCache = fs.existsSync(LOCATION_CACHE_FILE)
  ? JSON.parse(fs.readFileSync(LOCATION_CACHE_FILE, 'utf8'))
  : {};

function loadTrackedXHandles() {
  try {
    const cfg = JSON.parse(fs.readFileSync(ACCOUNTS_CONFIG_FILE, 'utf8'));
    const x = cfg.X || {};
    return [...(x.own || []), ...(x.competitors || [])];
  } catch {
    return [];
  }
}

function loadDiscoveryHandles() {
  if (!fs.existsSync(VIDEO_DISCOVERY_CSV)) return [];
  const lines = fs.readFileSync(VIDEO_DISCOVERY_CSV, 'utf8').split('\n').filter(Boolean);
  if (lines.length < 2) return [];
  const header = lines[0].split(',');
  const handleIdx = header.indexOf('handle');
  if (handleIdx === -1) return [];
  const handles = new Set();
  for (let i = 1; i < lines.length; i++) {
    // Plain split on the raw line is still fine for finding the handle
    // COLUMN (it's a comma-free field that comes before text/topic, whose
    // embedded commas only ever shift columns AFTER them) - but
    // scrape_video_discovery.js's safe() writer wraps every field in
    // literal double quotes ("@handle"), which a plain split does NOT
    // strip. Found 2026-08-03: uncached handles like '"@WizzyXchangeBet"'
    // (quotes included) were being looked up as-is, wasting this run's
    // limited MAX_LOOKUPS_PER_RUN slots on profile URLs that never
    // existed instead of real accounts.
    const cols = lines[i].split(',');
    const h = (cols[handleIdx] || '').trim().replace(/^"|"$/g, '').replace(/^@/, '');
    if (h) handles.add(h);
  }
  return [...handles];
}

async function getLocation(page, handle) {
  if (locationCache[handle] !== undefined) return locationCache[handle];
  try {
    await page.goto(`https://x.com/${handle}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('[data-testid="primaryColumn"]', { timeout: 10000 });
    await page.waitForTimeout(1500);
    const location = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="UserProfileHeader_Items"] [data-testid="UserLocation"]');
      return el ? el.innerText.trim() : null;
    });
    locationCache[handle] = location;
  } catch {
    locationCache[handle] = null;
  }
  return locationCache[handle];
}

async function main() {
  // Optional `node enrich_video_locations.js @handle1 @handle2 ...` -
  // same pattern as scrape_accounts.js's own handle-list override - looks
  // up exactly those handles (re-checking even if already cached, so this
  // doubles as a manual refresh) instead of scanning the whole pool. Used
  // to prioritize a specific set (e.g. whatever's currently in the top 30
  // shown on the dashboard) ahead of the general backlog.
  const explicitHandles = process.argv.slice(2).filter((a) => a.startsWith('@')).map((a) => a.slice(1));

  let toFetch;
  if (explicitHandles.length > 0) {
    toFetch = explicitHandles;
    console.log(`Looking up ${toFetch.length} explicitly-requested handle(s), ignoring the cache/bound.`);
    for (const h of toFetch) delete locationCache[h];
  } else {
    const allHandles = [...new Set([...loadTrackedXHandles(), ...loadDiscoveryHandles()])];
    const uncached = allHandles.filter((h) => locationCache[h] === undefined);
    console.log(`${allHandles.length} unique handle(s) in the video-ranking pool, ${uncached.length} not yet cached.`);
    if (uncached.length === 0) {
      console.log('Nothing new to look up.');
      return;
    }
    toFetch = uncached.slice(0, MAX_LOOKUPS_PER_RUN);
    if (uncached.length > toFetch.length) {
      console.log(`Bounding this run to ${toFetch.length} lookup(s); ${uncached.length - toFetch.length} remaining for future runs.`);
    }
  }

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

    for (let i = 0; i < toFetch.length; i++) {
      const handle = toFetch[i];
      process.stdout.write(`  [${i + 1}/${toFetch.length}] @${handle} ... `);
      const location = await getLocation(page, handle);
      console.log(location || 'not set');
      if (i % 10 === 9) fs.writeFileSync(LOCATION_CACHE_FILE, JSON.stringify(locationCache, null, 2));
    }
  } finally {
    fs.writeFileSync(LOCATION_CACHE_FILE, JSON.stringify(locationCache, null, 2));
    await browser.close();
  }
  console.log(`Wrote ${LOCATION_CACHE_FILE}`);
}

main();
