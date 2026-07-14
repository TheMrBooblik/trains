/* Trainmap prototype UI. See js/api.js for the data sources. */
(function () {
  'use strict';

  const API = window.TrainmapAPI;

  /* Validated ordinal ramp (single blue hue, light→dark) for travel time. */
  const DURATION_BINS = [
    { maxMin: 120, color: '#6da7ec', label: '< 2 h' },
    { maxMin: 240, color: '#3987e5', label: '2–4 h' },
    { maxMin: 360, color: '#256abf', label: '4–6 h' },
    { maxMin: 480, color: '#184f95', label: '6–8 h' },
    { maxMin: Infinity, color: '#0d366b', label: '8 h +' },
  ];
  const BEST_DEAL_LABELS = 5; // only the N cheapest fares get permanent labels

  const el = (id) => document.getElementById(id);
  const ui = {
    input: el('station-input'),
    suggestions: el('suggestions'),
    date: el('date-input'),
    time: el('time-input'),
    loadPrices: el('load-prices-btn'),
    stopPrices: el('stop-prices-btn'),
    refresh: el('refresh-btn'),
    progress: el('price-progress'),
    progressFill: el('price-progress-fill'),
    progressLabel: el('price-progress-label'),
    alert: el('alert'),
    tiles: el('tiles'),
    tileCount: el('tile-count'),
    tileUnder2h: el('tile-under2h'),
    tileCheapest: el('tile-cheapest'),
    legend: el('legend'),
    destSection: el('dest-section'),
    destTitle: el('dest-title'),
    destList: el('dest-list'),
    sortSelect: el('sort-select'),
    freshness: el('freshness'),
    dotDb: el('dot-db'),
    dotDirekt: el('dot-direkt'),
    statusDb: el('status-db'),
    statusDirekt: el('status-direkt'),
  };

  const state = {
    origin: null,          // {id, name, lat, lon}
    destinations: [],      // [{id, name, lat, lon, durationMin}]
    fetchedAt: null,
    prices: new Map(),     // destId -> {status:'loading'|'done'|'none'|'error', best, departures}
    markers: new Map(),    // destId -> L.CircleMarker
    priceRun: null,        // AbortController for the batch price load
  };

  /* ---------- map ---------- */
  const map = L.map('map', { zoomControl: true }).setView([50.5, 10.0], 5);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  const destLayer = L.layerGroup().addTo(map);
  let originMarker = null;

  /* ---------- small helpers ---------- */
  function binFor(durationMin) {
    const min = durationMin == null ? Infinity : durationMin;
    return DURATION_BINS.find((b) => min < b.maxMin) || DURATION_BINS[DURATION_BINS.length - 1];
  }
  function fmtDuration(min) {
    if (min == null) return '—';
    const h = Math.floor(min / 60);
    const m = Math.round(min % 60);
    return h > 0 ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`;
  }
  function fmtPrice(p) {
    if (!p) return null;
    const sym = p.currency === 'EUR' ? '€' : `${p.currency} `;
    return `${sym}${p.amount.toFixed(2)}`;
  }
  function fmtTime(iso) {
    if (!iso) return '–';
    const d = new Date(iso);
    return isNaN(d) ? '–' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  function fmtAge(ts) {
    const min = Math.round((Date.now() - ts) / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min} min ago`;
    const h = Math.round(min / 60);
    return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function showAlert(msg, retryFn) {
    ui.alert.textContent = msg;
    if (retryFn) {
      const btn = document.createElement('button');
      btn.className = 'btn alert-retry';
      btn.textContent = 'Retry';
      btn.addEventListener('click', () => { clearAlert(); retryFn(); });
      ui.alert.appendChild(btn);
    }
    ui.alert.hidden = false;
  }
  function clearAlert() { ui.alert.hidden = true; }

  function departureISO() {
    const date = ui.date.value || new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const time = ui.time.value || '08:00';
    return `${date}T${time}:00`;
  }

  /* ---------- API health footer ---------- */
  API.onHealth((source, ok, detail) => {
    const dot = source === 'db' ? ui.dotDb : ui.dotDirekt;
    const note = source === 'db' ? ui.statusDb : ui.statusDirekt;
    dot.className = `dot ${ok ? 'ok' : 'err'}`;
    note.textContent = ok ? `ok · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : `error${detail ? `: ${detail.slice(0, 60)}` : ''}`;
  });

  /* ---------- autocomplete ---------- */
  let searchTimer = null;
  let searchSeq = 0;
  ui.input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = ui.input.value.trim();
    if (q.length < 2) { ui.suggestions.hidden = true; return; }
    searchTimer = setTimeout(async () => {
      const seq = ++searchSeq;
      try {
        const results = await API.searchStations(q);
        if (seq !== searchSeq) return; // stale response
        renderSuggestions(results);
      } catch (err) {
        if (seq !== searchSeq) return;
        ui.suggestions.hidden = true;
        showAlert(`Station search failed — ${err.message}`, () => ui.input.dispatchEvent(new Event('input')));
      }
    }, 300);
  });
  ui.input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') ui.suggestions.hidden = true;
    if (e.key === 'Enter') {
      const first = ui.suggestions.querySelector('li');
      if (first && !ui.suggestions.hidden) first.click();
    }
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-field')) ui.suggestions.hidden = true;
  });

  function renderSuggestions(results) {
    ui.suggestions.innerHTML = '';
    if (!results.length) { ui.suggestions.hidden = true; return; }
    for (const st of results) {
      const li = document.createElement('li');
      const products = Object.entries(st.products).filter(([, v]) => v).map(([k]) => k);
      li.innerHTML = `${escapeHtml(st.name)} <span class="sub">${products.slice(0, 4).join(' · ')}</span>`;
      li.addEventListener('click', () => {
        ui.suggestions.hidden = true;
        ui.input.value = st.name;
        selectOrigin(st);
      });
      ui.suggestions.appendChild(li);
    }
    ui.suggestions.hidden = false;
  }

  /* ---------- origin selection + destinations ---------- */
  async function selectOrigin(station, { force = false } = {}) {
    clearAlert();
    stopPriceRun();
    state.origin = station;
    state.destinations = [];
    state.prices.clear();
    state.markers.clear();
    destLayer.clearLayers();
    location.hash = `s=${station.id}`;

    if (originMarker) originMarker.remove();
    originMarker = L.marker([station.lat, station.lon], { title: station.name })
      .addTo(map)
      .bindTooltip(escapeHtml(station.name), { direction: 'top' });

    ui.destTitle.textContent = `Loading direct routes from ${station.name}…`;
    ui.destSection.hidden = false;
    ui.destList.innerHTML = '';
    ui.refresh.disabled = true;
    ui.loadPrices.disabled = true;

    try {
      const { destinations, fetchedAt, fromCache } = await API.getDirectDestinations(station.id, { force });
      if (state.origin !== station) return; // user switched origin meanwhile
      state.destinations = destinations;
      state.fetchedAt = fetchedAt;
      renderDestinations();
      ui.freshness.hidden = false;
      ui.freshness.textContent = `Route network for ${station.name}: ${destinations.length} destinations · synced ${fmtAge(fetchedAt)}${fromCache ? ' (local copy, auto-refreshes daily)' : ' (fresh)'}`;
      ui.refresh.disabled = false;
      ui.loadPrices.disabled = destinations.length === 0;
      if (!destinations.length) {
        showAlert('No direct long-distance routes found for this station. Try the city’s main station (Hbf / Central).');
      }
    } catch (err) {
      if (state.origin !== station) return;
      ui.destTitle.textContent = 'Destinations';
      ui.refresh.disabled = false;
      const hint = err.status === 404
        ? 'This station is not in the direct-connection index — try the main station of the city.'
        : 'The route-network service may be briefly unavailable.';
      showAlert(`Could not load direct destinations — ${err.message}. ${hint}`,
        err.status === 404 ? null : () => selectOrigin(station, { force }));
    }
  }

  function renderDestinations() {
    const dests = state.destinations;
    ui.destTitle.textContent = `Direct from ${state.origin.name}`;
    ui.tiles.hidden = false;
    ui.legend.hidden = false;
    ui.tileCount.textContent = String(dests.length);
    ui.tileUnder2h.textContent = String(dests.filter((d) => d.durationMin != null && d.durationMin <= 120).length);
    updateCheapestTile();

    destLayer.clearLayers();
    state.markers.clear();
    const bounds = [[state.origin.lat, state.origin.lon]];
    for (const d of dests) {
      const bin = binFor(d.durationMin);
      const marker = L.circleMarker([d.lat, d.lon], {
        radius: 7,
        weight: 2,
        color: '#ffffff',      // surface ring so overlapping marks stay separable
        fillColor: bin.color,
        fillOpacity: 0.95,
      })
        .addTo(destLayer)
        .bindTooltip(() => tooltipHtml(d), { direction: 'top', opacity: 0.95 })
        .on('click', () => openDestination(d));
      state.markers.set(d.id, marker);
      bounds.push([d.lat, d.lon]);
    }
    if (bounds.length > 1) map.fitBounds(bounds, { padding: [30, 30] });
    renderList();
  }

  function tooltipHtml(d) {
    const p = state.prices.get(d.id);
    const price = p && p.status === 'done' ? ` · from ${fmtPrice(p.best)}` : '';
    return `<strong>${escapeHtml(d.name)}</strong><br>${fmtDuration(d.durationMin)} direct${price}`;
  }

  function sortedDestinations() {
    const mode = ui.sortSelect.value;
    const copy = [...state.destinations];
    if (mode === 'name') copy.sort((a, b) => a.name.localeCompare(b.name));
    else if (mode === 'price') {
      const amount = (d) => {
        const p = state.prices.get(d.id);
        return p && p.status === 'done' && p.best ? p.best.amount : Infinity;
      };
      copy.sort((a, b) => amount(a) - amount(b) || (a.durationMin ?? 1e9) - (b.durationMin ?? 1e9));
    } else copy.sort((a, b) => (a.durationMin ?? 1e9) - (b.durationMin ?? 1e9));
    return copy;
  }

  function renderList() {
    ui.destList.innerHTML = '';
    for (const d of sortedDestinations()) {
      const li = document.createElement('li');
      const bin = binFor(d.durationMin);
      const p = state.prices.get(d.id);
      let priceHtml = '<span class="dest-price na">price?</span>';
      if (p) {
        if (p.status === 'loading') priceHtml = '<span class="dest-price loading">…</span>';
        else if (p.status === 'done' && p.best) priceHtml = `<span class="dest-price">${fmtPrice(p.best)}</span>`;
        else if (p.status === 'done') priceHtml = '<span class="dest-price na">no fare</span>';
        else priceHtml = '<span class="dest-price na">n/a</span>';
      }
      li.innerHTML = `<span class="swatch" style="background:${bin.color}"></span>` +
        `<span class="dest-name">${escapeHtml(d.name)}</span>` +
        `<span class="dest-duration">${fmtDuration(d.durationMin)}</span>` + priceHtml;
      li.addEventListener('click', () => openDestination(d, { fly: true }));
      ui.destList.appendChild(li);
    }
  }
  ui.sortSelect.addEventListener('change', renderList);

  /* ---------- destination popup + on-demand live price ---------- */
  async function openDestination(d, { fly = false } = {}) {
    const marker = state.markers.get(d.id);
    if (!marker) return;
    if (fly) map.flyTo([d.lat, d.lon], Math.max(map.getZoom(), 7), { duration: 0.6 });
    marker.bindPopup(popupHtml(d), { minWidth: 230 }).openPopup();
    const entry = state.prices.get(d.id);
    if (!entry || entry.status === 'error') {
      await loadPriceFor(d);
      if (marker.isPopupOpen()) marker.setPopupContent(popupHtml(d));
    }
  }

  function popupHtml(d) {
    const p = state.prices.get(d.id);
    let fareHtml = '<div class="fare"><small>fetching live fare…</small></div>';
    let journeysHtml = '';
    if (p && p.status === 'done') {
      fareHtml = p.best
        ? `<div class="fare">from ${fmtPrice(p.best)} <small>live · ${escapeHtml(p.best.line || 'direct')}</small></div>`
        : `<div class="fare"><small>${p.journeyCount ? 'no fare via this API — check operator site' : 'no direct journey on this date'}</small></div>`;
      journeysHtml = (p.departures || []).slice(0, 3).map((j) =>
        `<div class="journey-row">${fmtTime(j.dep)} → ${fmtTime(j.arr)} · ${escapeHtml(j.line || 'train')}${j.amount != null ? ` · €${j.amount.toFixed(2)}` : ''}</div>`
      ).join('');
    } else if (p && p.status === 'error') {
      fareHtml = '<div class="fare"><small>price lookup failed — click list row to retry</small></div>';
    }
    const book = API.bookingUrl(state.origin.name, d.name, departureISO());
    return `<div class="popup">
      <h3>${escapeHtml(d.name)}</h3>
      <p class="meta">${fmtDuration(d.durationMin)} direct from ${escapeHtml(state.origin.name)} · ${escapeHtml(ui.date.value || 'tomorrow')}</p>
      ${fareHtml}${journeysHtml}
      <div class="actions"><a class="btn primary" href="${book}" target="_blank" rel="noopener">Book on bahn.de ↗</a></div>
      <div class="note">Sale handled by the operator — Trainmap only finds the deal.</div>
    </div>`;
  }

  async function loadPriceFor(d, signal) {
    state.prices.set(d.id, { status: 'loading' });
    renderList();
    try {
      const res = await API.getLivePrice(state.origin.id, d.id, departureISO(), { signal });
      state.prices.set(d.id, { status: 'done', ...res });
    } catch (err) {
      if (err.cancelled) state.prices.delete(d.id);
      else state.prices.set(d.id, { status: 'error' });
    }
    const marker = state.markers.get(d.id);
    if (marker) marker.setTooltipContent(tooltipHtml(d));
    renderList();
    updateCheapestTile();
    updateBestDealLabels();
  }

  function updateCheapestTile() {
    let best = null;
    for (const p of state.prices.values()) {
      if (p.status === 'done' && p.best && (best == null || p.best.amount < best.amount)) best = p.best;
    }
    ui.tileCheapest.textContent = best ? fmtPrice(best) : '–';
  }

  /* Permanent labels only on the few best deals (selective direct labels). */
  function updateBestDealLabels() {
    const priced = state.destinations
      .filter((d) => { const p = state.prices.get(d.id); return p && p.status === 'done' && p.best; })
      .sort((a, b) => state.prices.get(a.id).best.amount - state.prices.get(b.id).best.amount);
    const top = new Set(priced.slice(0, BEST_DEAL_LABELS).map((d) => d.id));
    for (const d of state.destinations) {
      const marker = state.markers.get(d.id);
      if (!marker) continue;
      const p = state.prices.get(d.id);
      if (top.has(d.id)) {
        marker.unbindTooltip();
        marker.bindTooltip(`${fmtPrice(p.best)}`, {
          permanent: true, direction: 'right', offset: [8, 0], className: 'price-label',
        });
      } else if (marker.getTooltip() && marker.getTooltip().options.permanent) {
        marker.unbindTooltip();
        marker.bindTooltip(() => tooltipHtml(d), { direction: 'top', opacity: 0.95 });
      }
    }
  }

  /* ---------- batch price load ---------- */
  ui.loadPrices.addEventListener('click', async () => {
    if (!state.origin || !state.destinations.length) return;
    stopPriceRun();
    const ctrl = new AbortController();
    state.priceRun = ctrl;
    ui.loadPrices.hidden = true;
    ui.stopPrices.hidden = false;
    ui.progress.hidden = false;

    const targets = [...state.destinations].sort((a, b) => (a.durationMin ?? 1e9) - (b.durationMin ?? 1e9));
    let done = 0;
    for (const d of targets) {
      if (ctrl.signal.aborted) break;
      const existing = state.prices.get(d.id);
      if (!existing || existing.status === 'error') await loadPriceFor(d, ctrl.signal);
      done += 1;
      const pct = Math.round((done / targets.length) * 100);
      ui.progressFill.style.width = `${pct}%`;
      ui.progressLabel.textContent = `${done}/${targets.length}`;
    }
    if (state.priceRun === ctrl) stopPriceRun();
  });
  ui.stopPrices.addEventListener('click', stopPriceRun);
  function stopPriceRun() {
    if (state.priceRun) { state.priceRun.abort(); state.priceRun = null; }
    ui.loadPrices.hidden = false;
    ui.stopPrices.hidden = true;
    ui.progress.hidden = true;
    ui.progressFill.style.width = '0%';
  }

  ui.refresh.addEventListener('click', () => {
    if (state.origin) selectOrigin(state.origin, { force: true });
  });

  /* Date/time change invalidates loaded prices (they are date-specific). */
  function onDateChange() {
    state.prices.clear();
    stopPriceRun();
    if (state.destinations.length) { renderList(); updateCheapestTile(); updateBestDealLabels(); }
  }
  ui.date.addEventListener('change', onDateChange);
  ui.time.addEventListener('change', onDateChange);

  /* ---------- boot ---------- */
  (function init() {
    const tomorrow = new Date(Date.now() + 86400000);
    ui.date.value = tomorrow.toISOString().slice(0, 10);
    ui.date.min = new Date().toISOString().slice(0, 10);

    const m = location.hash.match(/s=([A-Za-z0-9]+)/);
    if (m) {
      API.getStation(m[1])
        .then((st) => { ui.input.value = st.name; selectOrigin(st); })
        .catch(() => { /* stale hash — ignore */ });
    }

    // Surface an upstream outage immediately instead of on the first keystroke.
    API.ping().catch((err) => {
      showAlert(`Heads-up: the live timetable source appears to be unavailable right now — ${err.message} ` +
        'Trainmap fetches everything live (nothing is hardcoded), so search stays empty until the source recovers. ' +
        'Community-API outages usually last hours, not days.',
        () => location.reload());
    });
  })();
})();
