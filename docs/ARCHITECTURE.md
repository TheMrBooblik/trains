# Trainmap — architecture & product notes

How the prototype maps onto the original requirements, and what the path to a real
product looks like.

## Requirements → decisions

| # | Requirement | Decision in this prototype |
|---|---|---|
| 1 | Free to maintain | Static site (GitHub Pages), keyless public APIs, browser-side fetching → **€0/month** infra. Only real costs later: domain, app-store fees. |
| 2 | Flexibility: "I know where I start" | The core interaction *is* the direct-destination fan-out per origin station, not an A→B search. |
| 3 | Unofficial data OK for v1 | `v6.db.transport.rest` (community wrapper over DB's HAFAS endpoint) + `api.direkt.bahn.guru`. No scraping needed yet. |
| 4 | Operators own the sale | Every destination popup deep-links into bahn.de's booking flow with origin/destination/date pre-filled. We never touch payment. |
| 5 | Commission-only revenue | The hand-off link is the future affiliate channel (DB has a partner programme; Trainline/Omio-style affiliate APIs exist as fallback). No ads anywhere. |
| 6 | Own the data; prices real-time | Route topology is fetched per station and cached client-side with a 24 h TTL ("synced X ago" is shown in the UI). Prices are always live, with only a 15-min session cache to respect rate limits. |
| 7 | Scalable Europe → world | Source-adapter pattern, see below. |
| 8 | Full picture, no missing routes | Direct-connection index covers *every* train in the timetable, incl. regional and night trains — not just routes an operator's sales API wants to sell. |

## Data-source adapter pattern (scaling, req. 7 & 8)

`js/api.js` is deliberately the only file that knows where data comes from. Its
interface is three calls:

```
searchStations(query)                → [{id, name, lat, lon}]
getDirectDestinations(stationId)     → [{id, name, lat, lon, durationMin}]
getLivePrice(fromId, toId, date)     → {best: {amount, currency}, departures}
```

Anything that can answer those three questions can be a source. The roadmap is a
source registry keyed by region:

1. **Now (v0)** — DB HAFAS via `transport.rest`: Germany complete + European
   long-distance reachable from DB's timetable.
2. **Europe (v1)** — add sibling endpoints of the same open-source family
   (`hafas-client` / `db-vendo-client` profiles exist for ÖBB, SNCB, and others) and
   national open-data feeds (GTFS from SNCF, Trenitalia, Renfe, PKP…). Each becomes an
   adapter; a merge layer dedupes stations via coordinates + UIC codes.
3. **Own the topology (v1)** — a nightly free-tier job (GitHub Actions cron) walks the
   sources and materializes the direct-connection graph into static JSON shards served
   from the same static host. The client then reads *our* dataset (fast, complete,
   ours — req. 6) and only hits operator APIs for live prices.
4. **World (v2)** — the adapter interface is geography-agnostic; add Amtrak, JR,
   Indian Railways, etc. The map UI needs zero changes.

Prices stay federated forever: they are the one thing that must come live from
whoever sells the ticket, because that's also who pays the commission.

## Cost model

- **Hosting**: static files + client-side API calls → GitHub Pages / Cloudflare Pages
  free tier indefinitely.
- **Nightly topology sync**: GitHub Actions free minutes.
- **Rate limits**: 100 req/min on transport.rest is plenty for a prototype; the batch
  price loader spaces requests (700 ms) and caches. At real traffic, prices move behind
  a tiny caching proxy (Cloudflare Workers free tier: 100k req/day) so N users share
  one upstream call per route+date.
- **When traffic outgrows goodwill**: transport.rest and bahn.guru are open source —
  we self-host the same stack (`db-vendo-client`) rather than depend on someone's
  hobby server. OSM tiles likewise move to a free-tier tile CDN or self-rendered
  vector tiles.

## Mobile

The prototype is a responsive web app. The intended mobile path is a thin wrapper
(Capacitor) around the same codebase — one codebase, both stores, only the store fees
(req. 1). The map-first UI already works on phone viewports.

## Single-provider risk (learned the hard way)

On 2026-07-14 both community APIs had a same-day infrastructure outage
(`v6.db.transport.rest` → HTTP 503; `api.direkt.bahn.guru` → default reverse-proxy
TLS certificate). The app now detects this at boot and explains it instead of
failing cryptically, and the `API health check` workflow (Actions tab) probes all
sources on demand to separate "API down" from "app broken".

Validated fallback candidate: **[Transitous](https://transitous.org)**
(`api.transitous.org`, MOTIS) — free, community-run, CORS-open (`*`), worldwide
coverage from GTFS feeds. Confirmed healthy from CI with usable station search
(`/api/v1/geocode`). It has no prices, so it can back up station search and
timetables but not fares; wiring it in as a second adapter is the next step on
the roadmap above.

## Known prototype limitations (honest list)

- Fares come from DB's price API: reliable for German long-distance; regional-only and
  some foreign legs return no fare (the UI says so and still links to booking).
- The bahn.de deep link pre-fills origin/destination/date but the visitor completes the
  search there — a real affiliate integration would use tracked links.
- Coverage is DB-timetable-centric until more adapters land (see roadmap).
- direkt.bahn.guru's index is strictly *direct* trains; multi-leg "cheapest anywhere"
  search is a later feature on top of our own topology dataset.
