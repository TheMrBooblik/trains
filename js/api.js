/**
 * Data layer. Two live, free, keyless sources:
 *
 *  - v6.db.transport.rest  — community REST wrapper around Deutsche Bahn's
 *    HAFAS endpoint. Station search, journeys and *live prices*. Covers
 *    Germany fully plus most European long-distance stations.
 *    Rate limit: 100 req/min, CORS enabled. https://v6.db.transport.rest
 *
 *  - api.direkt.bahn.guru  — index of *direct* (no-change) connections per
 *    station, derived from the same live timetable data.
 *    https://direkt.bahn.guru
 *
 * Nothing is hardcoded: the route network is fetched per station and cached
 * locally (localStorage, TTL below) — "we own the topology data, refreshed
 * periodically". Prices are always fetched live, with a short session cache
 * only to avoid hammering the API while the user browses.
 */
(function () {
  'use strict';

  const DB_API = 'https://v6.db.transport.rest';
  const DIREKT_API = 'https://api.direkt.bahn.guru';

  const TOPOLOGY_TTL_MS = 24 * 60 * 60 * 1000; // direct-route network: refresh daily
  const PRICE_TTL_MS = 15 * 60 * 1000;         // live prices: 15 min session cache
  const MIN_REQUEST_SPACING_MS = 700;          // stay well under 100 req/min

  const listeners = { health: [] };
  function onHealth(fn) { listeners.health.push(fn); }
  function reportHealth(source, ok, detail) {
    listeners.health.forEach((fn) => fn(source, ok, detail));
  }

  async function fetchJSON(url, { timeoutMs = 20000, source = 'db' } = {}) {
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
      reportHealth(source, false, err.message);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /* ---- global request queue: spaces out API calls, cancellable ---- */
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

  /* ---- station search (autocomplete) ---- */
  async function searchStations(query) {
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
      }));
  }

  async function getStation(id) {
    const data = await fetchJSON(`${DB_API}/stops/${encodeURIComponent(id)}`, { source: 'db' });
    if (!data || !data.location) throw new Error(`Station ${id} not found`);
    return { id: String(data.id), name: data.name, lat: data.location.latitude, lon: data.location.longitude };
  }

  /* ---- direct destinations (the route network we "own" + refresh) ---- */
  function normalizeDestination(entry) {
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

  async function getDirectDestinations(stationId, { force = false } = {}) {
    const key = `trainmap:dest:v1:${stationId}`;
    if (!force) {
      const cached = storeGet(localStorage, key, TOPOLOGY_TTL_MS);
      if (cached) return { destinations: cached.value, fetchedAt: cached.at, fromCache: true };
    }
    const url = `${DIREKT_API}/${encodeURIComponent(stationId)}?localTrainsOnly=false`;
    const data = await fetchJSON(url, { source: 'direkt' });
    const destinations = (Array.isArray(data) ? data : [])
      .map(normalizeDestination)
      .filter(Boolean)
      .filter((d) => d.id !== String(stationId));
    storeSet(localStorage, key, destinations);
    return { destinations, fetchedAt: Date.now(), fromCache: false };
  }

  /* ---- live prices (direct journeys only) ---- */
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
    searchStations,
    getStation,
    getDirectDestinations,
    getLivePrice,
    bookingUrl,
    onHealth,
    TOPOLOGY_TTL_MS,
  };
})();
