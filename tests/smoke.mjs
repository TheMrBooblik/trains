/**
 * Offline smoke test for the Trainmap UI.
 *
 * The production app always fetches live data — nothing is hardcoded. This
 * test exists so the full UI flow can be verified in CI/sandboxes without
 * network access: it intercepts the API hosts and serves recorded responses
 * in the exact documented shapes.
 *
 * Scenario A — primary (bahn) stack healthy: search → destinations →
 *   batch live prices → popup → booking link → topology cache.
 * Scenario B — primary stack down (503): the app must switch to the
 *   Transitous fallback: search via geocode, destinations via
 *   stoptimes + trip fan-out, prices hidden with an explanatory notice.
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

const failures = [];
const check = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failures.push(name); };

const px = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mPcv2//fwAJhAPTaenPbAAAAABJRU5ErkJggg==', 'base64');

/** Installs API interception. dbDown=true simulates today's bahn-stack outage. */
async function installRoutes(page, { dbDown }) {
  const log = { locations: 0, journeys: 0, direkt: 0, geocode: 0, stoptimes: 0, trips: [] };
  await page.route('**://v6.db.transport.rest/**', async (route) => {
    const url = new URL(route.request().url());
    if (dbDown) return route.fulfill({ status: 503, body: '' });
    if (url.pathname === '/locations') {
      // Second call fails once: the first user search must retry transparently.
      log.locations += 1;
      if (log.locations === 2) return route.fulfill({ status: 503, contentType: 'application/json', body: '{"msg":"synthetic blip"}' });
      return route.fulfill({ contentType: 'application/json', body: await fixture('locations.json') });
    }
    if (url.pathname === '/journeys') {
      log.journeys += 1;
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
    if (dbDown) return route.abort('failed'); // mirrors today's broken-TLS behaviour
    log.direkt += 1;
    return route.fulfill({ contentType: 'application/json', body: await fixture('direct.json') });
  });
  await page.route('**://api.transitous.org/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/geocode')) {
      log.geocode += 1;
      return route.fulfill({ contentType: 'application/json', body: await fixture('transitous-geocode.json') });
    }
    if (url.pathname.endsWith('/stoptimes')) {
      log.stoptimes += 1;
      return route.fulfill({ contentType: 'application/json', body: await fixture('transitous-stoptimes.json') });
    }
    if (url.pathname.endsWith('/trip')) {
      const tripId = url.searchParams.get('tripId') || '';
      log.trips.push(tripId);
      if (tripId.includes('T1')) return route.fulfill({ contentType: 'application/json', body: await fixture('transitous-trip-T1.json') });
      if (tripId.includes('T2')) return route.fulfill({ contentType: 'application/json', body: await fixture('transitous-trip-T2.json') });
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"unexpected trip requested"}' });
    }
    return route.fulfill({ status: 404, body: '{}' });
  });
  await page.route('**://tile.openstreetmap.org/**', (route) => route.fulfill({ contentType: 'image/png', body: px }));
  return log;
}

/* ================= Scenario A: primary stack healthy ================= */
{
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('pageerror', (err) => failures.push(`A pageerror: ${err.message}`));
  const log = await installRoutes(page, { dbDown: false });

  await page.goto(base, { waitUntil: 'load' });
  check('A: page loads with title', (await page.title()).includes('Trainmap'));

  await page.fill('#station-input', 'berlin');
  await page.waitForSelector('#suggestions li', { timeout: 10000 });
  const suggestions = await page.$$eval('#suggestions li', (els) => els.map((e) => e.textContent));
  check('A: autocomplete shows Berlin Hbf', suggestions.some((s) => s.includes('Berlin Hbf')));
  check('A: search survived a transient 503 via retry', log.locations >= 3);
  check('A: no fallback notice in primary mode', await page.isHidden('#notice'));

  await page.click('#suggestions li');
  await page.waitForSelector('#dest-list li', { timeout: 5000 });
  check('A: 12 destination markers on map', (await page.$$eval('#map path.leaflet-interactive', (els) => els.length)) === 12);
  check('A: stat tile: 12 destinations', (await page.textContent('#tile-count')) === '12');
  check('A: legend visible', await page.isVisible('#legend'));
  check('A: freshness row mentions sync', (await page.textContent('#freshness')).includes('synced'));

  await page.click('#load-prices-btn');
  await page.waitForFunction(
    () => [...document.querySelectorAll('.dest-price')].filter((e) => e.textContent.includes('€')).length >= 12,
    null, { timeout: 30000 }
  );
  check('A: all rows show a live € price', true);
  check('A: cheapest tile shows €19.99', (await page.textContent('#tile-cheapest')).includes('19.99'));
  await page.waitForFunction(() => document.querySelectorAll('.price-label').length === 5, null, { timeout: 5000 }).catch(() => {});
  check('A: best-deal labels on map (max 5)', (await page.$$eval('.price-label', (els) => els.length)) === 5);

  await page.click('#dest-list li');
  await page.waitForSelector('.popup', { timeout: 5000 });
  const popup = await page.textContent('.popup');
  check('A: popup shows live fare', popup.includes('€19.99'));
  check('A: booking hand-off links to bahn.de', (await page.getAttribute('.popup a.btn', 'href'))?.startsWith('https://int.bahn.de/'));

  const shot = process.env.SCREENSHOT_PATH;
  if (shot) { await page.screenshot({ path: shot }); console.log(`screenshot: ${shot}`); }

  const direktCallsBefore = log.direkt;
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#dest-list li', { timeout: 5000 });
  check('A: route network served from local cache on reload', log.direkt === direktCallsBefore);
  check('A: hash restores origin station', (await page.inputValue('#station-input')) === 'Berlin Hbf');
  await page.close();
}

/* ============ Scenario B: bahn stack down → Transitous fallback ============ */
{
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', (err) => failures.push(`B pageerror: ${err.message}`));
  const log = await installRoutes(page, { dbDown: true });

  await page.goto(base, { waitUntil: 'load' });
  await page.waitForSelector('#notice:not([hidden])', { timeout: 10000 });
  const notice = await page.textContent('#notice');
  check('B: fallback notice shown', notice.includes('fallback') && notice.includes('prices are unavailable'));

  await page.fill('#station-input', 'berlin');
  await page.waitForSelector('#suggestions li', { timeout: 10000 });
  const items = await page.$$eval('#suggestions li', (els) => els.map((e) => e.textContent));
  check('B: fallback search shows Berlin Hbf', items.some((s) => s.includes('Berlin Hbf')));
  check('B: non-rail geocode results filtered out', !items.some((s) => s.includes('Ibis')) && !items.some((s) => s.includes('bus stop')));

  await page.click('#suggestions li');
  await page.waitForSelector('#dest-list li', { timeout: 15000 });
  const names = await page.$$eval('#dest-list .dest-name', (els) => els.map((e) => e.textContent));
  check('B: 4 direct destinations from trip fan-out', names.length === 4);
  check('B: destinations include downstream stops, not just termini', names.some((n) => n.includes('Wittenberge')) && names.some((n) => n.includes('Königs Wusterhausen')));
  check('B: one trip look-up per line+direction (dedupe)', log.trips.length === 2 && !log.trips.some((t) => t.includes('T3')));
  check('B: bus departures excluded', !names.some((n) => n.includes('Flughafen')));
  check('B: load-prices button hidden in fallback', await page.isHidden('#load-prices-btn'));
  check('B: freshness mentions fallback source', (await page.textContent('#freshness')).includes('fallback'));

  await page.click('#dest-list li');
  await page.waitForSelector('.popup', { timeout: 5000 });
  const popupB = await page.textContent('.popup');
  check('B: popup explains prices unavailable', popupB.includes('unavailable'));
  check('B: popup shows sample departure', popupB.includes('→'));
  check('B: booking hand-off still available', (await page.getAttribute('.popup a.btn', 'href'))?.startsWith('https://int.bahn.de/'));

  const shotB = process.env.SCREENSHOT_FALLBACK_PATH;
  if (shotB) { await page.waitForTimeout(900); await page.screenshot({ path: shotB }); console.log(`screenshot: ${shotB}`); }
  await context.close();
}

await browser.close();
server.close();
check('no page errors', failures.filter((f) => f.includes('pageerror')).length === 0);
if (failures.length) { console.error(`\n${failures.length} failure(s):\n- ${failures.join('\n- ')}`); process.exit(1); }
console.log('\nAll smoke checks passed.');
