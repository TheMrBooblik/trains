/**
 * Offline smoke test for the Trainmap UI.
 *
 * The production app always fetches live data from v6.db.transport.rest and
 * api.direkt.bahn.guru — nothing is hardcoded. This test exists so the full
 * UI flow (search → pick station → markers → live-price load → popup) can be
 * verified in CI/sandboxes without network access: it intercepts the API
 * hosts and serves recorded responses in the exact documented shapes.
 *
 * Run:  node tests/smoke.mjs
 */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixture = (name) => readFile(join(root, 'tests', 'fixtures', name), 'utf8');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };

const server = createServer(async (req, res) => {
  try {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
    const file = join(root, path === '' || path === '.' ? 'index.html' : path);
    if (!file.startsWith(root)) throw new Error('traversal');
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const executablePath = process.env.CHROMIUM_PATH
  || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

const apiLog = [];
let locationCalls = 0;
await page.route('**://v6.db.transport.rest/**', async (route) => {
  const url = new URL(route.request().url());
  apiLog.push(url.pathname + url.search);
  if (url.pathname === '/locations') {
    // First two calls fail with 503: the boot ping must show the outage banner,
    // and the first user search must retry transparently (resilience path).
    locationCalls += 1;
    if (locationCalls <= 2) return route.fulfill({ status: 503, contentType: 'application/json', body: '{"msg":"synthetic outage"}' });
    return route.fulfill({ contentType: 'application/json', body: await fixture('locations.json') });
  }
  if (url.pathname === '/journeys') {
    if (url.searchParams.get('transfers') !== '0') {
      return route.fulfill({ status: 400, contentType: 'application/json', body: '{"msg":"test expects transfers=0 (direct only)"}' });
    }
    return route.fulfill({ contentType: 'application/json', body: await fixture('journeys.json') });
  }
  if (url.pathname.startsWith('/stops/')) {
    const all = JSON.parse(await fixture('locations.json'));
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(all[0]) });
  }
  return route.fulfill({ status: 404, body: '{}' });
});
await page.route('**://api.direkt.bahn.guru/**', async (route) => {
  apiLog.push(new URL(route.request().url()).pathname);
  return route.fulfill({ contentType: 'application/json', body: await fixture('direct.json') });
});
// Blank out map tiles: no network in the sandbox, and the test targets UI logic.
const px = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mPcv2//fwAJhAPTaenPbAAAAABJRU5ErkJggg==', 'base64');
await page.route('**://tile.openstreetmap.org/**', (route) => route.fulfill({ contentType: 'image/png', body: px }));

const failures = [];
const check = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failures.push(name); };
page.on('pageerror', (err) => failures.push(`pageerror: ${err.message}`));

await page.goto(base, { waitUntil: 'load' });
check('page loads with title', (await page.title()).includes('Trainmap'));

// 0. boot ping fails (503) -> outage banner up front
await page.waitForSelector('#alert:not([hidden])', { timeout: 8000 });
check('outage banner shown at boot', (await page.textContent('#alert')).includes('unavailable'));

// 1. search
await page.fill('#station-input', 'berlin');
await page.waitForSelector('#suggestions li', { timeout: 10000 });
const suggestions = await page.$$eval('#suggestions li', (els) => els.map((e) => e.textContent));
check('autocomplete shows Berlin Hbf', suggestions.some((s) => s.includes('Berlin Hbf')));
check('search survived a transient 503 via retry', locationCalls >= 2);

// 2. pick origin -> destinations render
await page.click('#suggestions li');
await page.waitForSelector('#dest-list li', { timeout: 5000 });
const markerCount = await page.$$eval('#map path.leaflet-interactive', (els) => els.length);
check('12 destination markers on map', markerCount === 12);
check('stat tile: 12 destinations', (await page.textContent('#tile-count')) === '12');
check('stat tile: 3 reachable under 2h', (await page.textContent('#tile-under2h')) === '3');
check('legend visible', await page.isVisible('#legend'));
check('freshness row mentions sync', (await page.textContent('#freshness')).includes('synced'));

// 3. batch live prices
await page.click('#load-prices-btn');
await page.waitForFunction(
  () => [...document.querySelectorAll('.dest-price')].filter((e) => e.textContent.includes('€')).length >= 12,
  null, { timeout: 30000 }
);
check('all rows show a live € price', true);
check('cheapest tile shows €19.99', (await page.textContent('#tile-cheapest')).includes('19.99'));
await page.waitForFunction(() => document.querySelectorAll('.price-label').length === 5, null, { timeout: 5000 })
  .catch(() => {});
const priceLabels = await page.$$eval('.price-label', (els) => els.length);
check('best-deal labels on map (max 5)', priceLabels === 5);

// 4. popup with booking hand-off
await page.click('#dest-list li');
await page.waitForSelector('.popup', { timeout: 5000 });
const popup = await page.textContent('.popup');
check('popup shows live fare', popup.includes('€19.99'));
check('popup shows departure times', popup.includes('→'));
const bookHref = await page.getAttribute('.popup a.btn', 'href');
check('booking hand-off links to bahn.de', bookHref?.startsWith('https://int.bahn.de/'));

const shot = process.env.SCREENSHOT_PATH;
if (shot) { await page.screenshot({ path: shot, fullPage: false }); console.log(`screenshot: ${shot}`); }

// 5. topology cache: reload uses localStorage, no second direkt call
const direktCallsBefore = apiLog.filter((u) => u.startsWith('/8011160')).length;
await page.reload({ waitUntil: 'load' });
await page.waitForSelector('#dest-list li', { timeout: 5000 });
const direktCallsAfter = apiLog.filter((u) => u.startsWith('/8011160')).length;
check('route network served from local cache on reload', direktCallsAfter === direktCallsBefore);
check('hash restores origin station', (await page.inputValue('#station-input')) === 'Berlin Hbf');

await browser.close();
server.close();
check('no page errors', failures.filter((f) => f.startsWith('pageerror')).length === 0);
if (failures.length) { console.error(`\n${failures.length} failure(s):\n- ${failures.join('\n- ')}`); process.exit(1); }
console.log('\nAll smoke checks passed.');
