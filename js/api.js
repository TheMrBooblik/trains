/**
 * Data layer with two source stacks:
 *
 *  PRIMARY (bahn stack) — full feature set including live prices:
 *  - v6.db.transport.rest  — community REST wrapper around Deutsche Bahn's
 *    endpoint. Station search, journeys and *live prices*. Covers Germany
 *    fully plus most European long-distance stations.
 *    Rate limit: 100 req/min, CORS enabled. https://v6.db.transport.rest
 *  - api.direkt.bahn.guru  — index of *direct* (no-change) connections per
 *    station, derived from the same live timetable data.
 *
 *  FALLBACK (Transitous) — timetables without prices, used automatically
 *  when the primary stack is down (it is community-run and has outages):
 *  - api.transitous.org (MOTIS) — free, CORS-open, worldwide GTFS-based.
 *    Station search via /geocode; direct destinations computed live from
 *    /stoptimes (departures at the origin) + /trip (each train's full stop
 *    sequence). No fares — prices return when the primary recovers.
 *
 * Nothing is hardcoded: the route network is fetched per station and cached
 * locally (localStorage, TTL below). Prices are always fetched live, with a
 * short session cache only to avoid hammering the API while the user browses.
 */
(function () {
  'use strict';

  const DB_API = 'https://v6.db.transport.rest';
  const DIREKT_API = 'https://api.direkt.bahn.guru';
  const TRANSITOUS_API = 'https://api.transitous.org/api/v1';

  const TOPOLOGY_TTL_MS = 24 * 60 * 60 * 1000; // direct-route network: refresh daily
  const PRICE_TTL_MS = 15 * 60 * 1000;         // live prices: 15 min session cache
  const MIN_REQUEST_SPACING_MS = 700;          // bahn stack: stay well under 100 req/min

  const RAIL_MODES = new Set([
    'HIGHSPEED_RAIL', 'LONG_DISTANCE', 'NIGHT_RAIL',
    'REGIONAL_FAST_RAIL', 'REGIONAL_RAIL', 'RAIL',
  ]);
  const MAX_FALLBACK_TRIPS = 40; // trip look-ups per station in fallback mode

  /* ---- source mode ---- */
  let mode = 'primary'; // 'primary' (bahn stack) | 'fallback' (Transitous)
  const listeners = { health: [], mode: [] };
  function onHealth(fn) { listeners.health.push(fn); }
  function onMode(fn) { listeners.mode.push(fn); }
  function reportHealth(source, ok, detail) {
    listeners.health.forEach((fn) => fn(source, ok, detail));
  }
  function setMode(next, reason) {
    if (mode === next) return;
    mode = next;
    listeners.mode.forEach((fn) => fn(mode, reason));
  }

  const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

  function friendlyError(err, url) {
    const host = new URL(url).host;
    if (err.name === 'AbortError') return `request to ${host} timed out — the free API may be overloaded, try again in a minute`;
    if (err.status === 429) return `${host} is rate-limiting right now (it's a free community API) — wait a minute and retry`;
    if (err.status >= 500) return `${host} is temporarily unavailable (HTTP ${err.status}) — it usually recovers within minutes`;
    if (err.status) return err.message;
    // TypeError "Failed to fetch": DNS/connection/CORS failure before any HTTP response
    return `could not reach ${host} — the API may be briefly down, or something (ad-blocker, firewall) is blocking it; retrying usually works`;
  }

  async function fetchJSON(url, { timeoutMs = 20000, source = 'db', retries = 2 } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1500 * attempt));
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          const err = new Error(`HTTP ${res.status} from ${new URL(url).host}${body ? ` — ${body.slice(0, 140)}` : ''}`);
          err.status = res.status;
          throw err;
        }
        const data = await res.json();
        reportHealth(source, true);
        return data;
      } catch (err) {
        lastErr = err;
        const transient = err.name === 'AbortError' || err instanceof TypeError || RETRYABLE_STATUS.has(err.status);
        if (transient && attempt < retries) continue;
        const friendly = new Error(friendlyError(err, url));
        friendly.status = err.status;
        reportHealth(source, false, friendly.message);
        throw friendly;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr; // unreachable, satisfies control flow
  }

  /** true for errors that mean "source down", not "bad request" */
  function isOutage(err) {
    return !err.status || RETRYABLE_STATUS.has(err.status);
  }

  /* ---- global request queue for the bahn stack: spaces out calls ---- */
  let queueChain = Promise.resolve();
  let lastRequestAt = 0;
  function enqueue(taskFn) {
    const run = queueChain.then(async () => {
      const wait = lastRequestAt + MIN_REQUEST_SPACING_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastRequestAt = Date.now();
      return taskFn();
    });
    queueChain = run.catch(() => {});
    return run;
  }

  /* small parallel worker pool (Transitous handles concurrency fine) */
  async function parallelEach(items, concurrency, workFn) {
    let i = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (i < items.length) {
        const item = items[i]; i += 1;
        try { await workFn(item); } catch { /* one bad trip must not kill the batch */ }
      }
    });
    await Promise.all(workers);
  }

  /* ---- storage helpers (fail soft if storage is unavailable) ---- */
  function storeGet(storage, key, ttlMs) {
    try {
      const raw = storage.getItem(key);
      if (!raw) return null;
      const entry = JSON.parse(raw);
      if (!entry || typeof entry.at !== 'number') return null;
      if (Date.now() - entry.at > ttlMs) return null;
      return entry;
    } catch { return null; }
  }
  function storeSet(storage, key, value) {
    try { storage.setItem(key, JSON.stringify({ at: Date.now(), value })); } catch { /* full/blocked */ }
  }

  /* ---- boot: pick the source stack ---- */
  function ping() {
    return fetchJSON(`${DB_API}/locations?query=berlin&results=1`, { source: 'db', retries: 0, timeoutMs: 12000 });
  }
  async function init() {
    try {
      await ping();
      setMode('primary');
    } catch (err) {
      setMode('fallback', err.message);
    }
    return mode;
  }

  /* ---- station search ---- */
  async function searchStationsPrimary(query) {
    const url = `${DB_API}/locations?query=${encodeURIComponent(query)}&results=8&poi=false&addresses=false`;
    const data = await fetchJSON(url, { source: 'db' });
    return (Array.isArray(data) ? data : [])
      .filter((r) => (r.type === 'stop' || r.type === 'station') && r.location && r.id)
      .map((r) => ({
        id: String(r.id),
        name: r.name,
        lat: r.location.latitude,
        lon: r.location.longitude,
        products: r.products || {},
        src: 'db',
      }));
  }

  async function searchStationsFallback(query) {
    const url = `${TRANSITOUS_API}/geocode?text=${encodeURIComponent(query)}&type=STOP`;
    const data = await fetchJSON(url, { source: 'transitous' });
    return (Array.isArray(data) ? data : [])
      .filter((r) => r.type === 'STOP' && typeof r.lat === 'number' && (r.modes || []).some((m) => RAIL_MODES.has(m)))
      .slice(0, 8)
      .map((r) => ({
        id: String(r.id),
        name: r.name,
        lat: r.lat,
        lon: r.lon,
        products: Object.fromEntries((r.modes || []).filter((m) => RAIL_MODES.has(m)).map((m) => [m.toLowerCase().replace(/_/g, ' '), true])),
        src: 'transitous',
      }));
  }

  async function searchStations(query) {
    if (mode === 'primary') {
      try {
        return await searchStationsPrimary(query);
      } catch (err) {
        if (!isOutage(err)) throw err;
        setMode('fallback', err.message); // bahn stack just died mid-session
      }
    }
    return searchStationsFallback(query);
  }

  async function getStation(id) {
    const data = await fetchJSON(`${DB_API}/stops/${encodeURIComponent(id)}`, { source: 'db' });
    if (!data || !data.location) throw new Error(`Station ${id} not found`);
    return { id: String(data.id), name: data.name, lat: data.location.latitude, lon: data.location.longitude, src: 'db' };
  }

  /* ---- direct destinations (the route network we "own" + refresh) ---- */
  function normalizeDirektDestination(entry) {
    if (!entry || !entry.id || !entry.location) return null;
    const lat = entry.location.latitude;
    const lon = entry.location.longitude;
    if (typeof lat !== 'number' || typeof lon !== 'number') return null;
    return {
      id: String(entry.id),
      name: entry.name || String(entry.id),
      lat,
      lon,
      durationMin: typeof entry.duration === 'number' ? entry.duration : null,
    };
  }

  async function directDestinationsPrimary(station) {
    const url = `${DIREKT_API}/${encodeURIComponent(station.id)}?localTrainsOnly=false`;
    const data = await fetchJSON(url, { source: 'direkt' });
    return (Array.isArray(data) ? data : [])
      .map(normalizeDirektDestination)
      .filter(Boolean)
      .filter((d) => d.id !== String(station.id));
  }

  /* Fallback: departures at the origin (/stoptimes), then each train's full
     stop sequence (/trip). Every stop downstream of the origin is a direct
     destination; keep the fastest observed duration per station. */
  const nearStation = (s, station) => Math.abs(s.lat - station.lat) < 0.01 && Math.abs(s.lon - station.lon) < 0.02;

  async function directDestinationsFallback(station, onProgress) {
    let stopId = station.id;
    if (station.src !== 'transitous') {
      // origin came from the bahn stack — resolve it in Transitous by name
      const matches = await searchStationsFallback(station.name);
      const near = matches.find((m) => nearStation(m, station)) || matches[0];
      if (!near) throw new Error(`could not resolve "${station.name}" in the fallback source`);
      stopId = near.id;
    }
    const now = new Date().toISOString();
    const url = `${TRANSITOUS_API}/stoptimes?stopId=${encodeURIComponent(stopId)}&time=${encodeURIComponent(now)}&n=200`;
    const st = await fetchJSON(url, { source: 'transitous' });

    const rows = (Array.isArray(st.stopTimes) ? st.stopTimes : [])
      .filter((r) => !r.cancelled && !r.tripCancelled && RAIL_MODES.has(r.mode)
        && r.tripId && r.place && r.place.departure);
    const byLine = new Map(); // one look-up per route+direction
    for (const r of rows) {
      const key = `${r.routeId || r.routeShortName || r.tripId}|${r.headsign || (r.tripTo && r.tripTo.name) || ''}`;
      if (!byLine.has(key)) byLine.set(key, r);
    }
    const trips = [...byLine.values()].slice(0, MAX_FALLBACK_TRIPS);

    const best = new Map();
    let done = 0;
    await parallelEach(trips, 4, async (r) => {
      const trip = await fetchJSON(`${TRANSITOUS_API}/trip?tripId=${encodeURIComponent(r.tripId)}`, { source: 'transitous', retries: 1 });
      done += 1;
      if (onProgress) onProgress(done, trips.length);
      const leg = (trip.legs || [])[0];
      if (!leg) return;
      const seq = [leg.from, ...(leg.intermediateStops || []), leg.to]
        .filter((s) => s && typeof s.lat === 'number' && typeof s.lon === 'number');
      const depMs = Date.parse(r.place.departure);
      // locate the origin inside the trip: same departure instant, else proximity
      let idx = seq.findIndex((s) => s.departure && Date.parse(s.departure) === depMs && nearStation(s, station));
      if (idx < 0) idx = seq.findIndex((s) => nearStation(s, station));
      if (idx < 0) return;
      for (let i = idx + 1; i < seq.length; i += 1) {
        const s = seq[i];
        const arrIso = s.arrival || s.scheduledArrival;
        if (!arrIso || nearStation(s, station)) continue;
        const durationMin = Math.round((Date.parse(arrIso) - depMs) / 60000);
        if (durationMin <= 0 || durationMin > 48 * 60) continue;
        const key = s.parentId || s.stopId || s.name;
        const cur = best.get(key);
        if (!cur || durationMin < cur.durationMin) {
          best.set(key, {
            id: String(s.stopId || key),
            name: s.name,
            lat: s.lat,
            lon: s.lon,
            durationMin,
            sample: { line: r.displayName || r.routeShortName || 'train', dep: r.place.departure, arr: arrIso },
          });
        }
      }
    });
    return [...best.values()].sort((a, b) => a.durationMin - b.durationMin);
  }

  async function getDirectDestinations(station, { force = false, onProgress } = {}) {
    const sourceName = mode === 'primary' ? 'direkt' : 'transitous';
    const key = `trainmap:dest:v2:${sourceName}:${station.id}`;
    if (!force) {
      const cached = storeGet(localStorage, key, TOPOLOGY_TTL_MS);
      if (cached) return { destinations: cached.value, fetchedAt: cached.at, fromCache: true, source: sourceName };
    }
    let destinations;
    if (mode === 'primary') {
      try {
        destinations = await directDestinationsPrimary(station);
      } catch (err) {
        if (!isOutage(err)) throw err;
        setMode('fallback', err.message);
        return getDirectDestinations(station, { force, onProgress });
      }
    } else {
      destinations = await directDestinationsFallback(station, onProgress);
    }
    storeSet(localStorage, key, destinations);
    return { destinations, fetchedAt: Date.now(), fromCache: false, source: sourceName };
  }

  /* ---- live prices (bahn stack only — Transitous has no fares) ---- */
  function summarizeJourneys(data) {
    const journeys = (data && Array.isArray(data.journeys)) ? data.journeys : [];
    let best = null;
    const departures = [];
    for (const j of journeys) {
      if (!Array.isArray(j.legs) || j.legs.length === 0) continue;
      const first = j.legs[0];
      const last = j.legs[j.legs.length - 1];
      const dep = first.departure || first.plannedDeparture;
      const arr = last.arrival || last.plannedArrival;
      const line = (first.line && (first.line.name || first.line.id)) || null;
      const amount = j.price && typeof j.price.amount === 'number' ? j.price.amount : null;
      const currency = (j.price && j.price.currency) || 'EUR';
      departures.push({ dep, arr, line, amount, currency });
      if (amount != null && (best == null || amount < best.amount)) best = { amount, currency, dep, arr, line };
    }
    return { best, departures, journeyCount: journeys.length };
  }

  async function getLivePrice(fromId, toId, departureISO, { signal } = {}) {
    const key = `trainmap:price:v1:${fromId}:${toId}:${departureISO}`;
    const cached = storeGet(sessionStorage, key, PRICE_TTL_MS);
    if (cached) return { ...cached.value, fetchedAt: cached.at, fromCache: true };

    const result = await enqueue(async () => {
      if (signal && signal.aborted) { const e = new Error('cancelled'); e.cancelled = true; throw e; }
      const url = `${DB_API}/journeys?from=${encodeURIComponent(fromId)}&to=${encodeURIComponent(toId)}` +
        `&departure=${encodeURIComponent(departureISO)}&transfers=0&results=4&stopovers=false&remarks=false`;
      const data = await fetchJSON(url, { source: 'db' });
      return summarizeJourneys(data);
    });
    storeSet(sessionStorage, key, result);
    return { ...result, fetchedAt: Date.now(), fromCache: false };
  }

  /* ---- hand-off to the operator (they own the sale — we just deep-link) ---- */
  function bookingUrl(fromName, toName, departureISO) {
    const hd = encodeURIComponent(departureISO);
    return `https://int.bahn.de/en/buchung/fahrplan/suche#sts=true&so=${encodeURIComponent(fromName)}&zo=${encodeURIComponent(toName)}&hd=${hd}`;
  }

  window.TrainmapAPI = {
    init,
    ping,
    get mode() { return mode; },
    onMode,
    searchStations,
    getStation,
    getDirectDestinations,
    getLivePrice,
    bookingUrl,
    onHealth,
    TOPOLOGY_TTL_MS,
  };
})();
