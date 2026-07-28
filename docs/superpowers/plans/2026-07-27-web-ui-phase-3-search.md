# Web UI Phase 3: Search, posters and plot — Implementation Plan

**Goal:** Make the browser feel like torlink — search across every source with results streaming in, poster art, plot and IMDb info, and add-or-play straight from a result.

**Spec:** `docs/superpowers/specs/2026-07-27-web-ui-design.md`. Prior plans and their recorded traps: `…-phase-1.md`, `…-phase-2-streaming.md`.

**Architecture:** All of the logic already exists and is tested. `core/search.ts` fans out across 23 sources with per-source timeouts and health benching; `core/posterCache.ts` serves full-quality posters at `/api/poster` (live today, nothing calls it); `recc/omdb.ts` fetches plot and IMDb id. This phase is HTTP routes and frontend.

---

## What already exists

- `src/core/search.ts` — `runSearch(query, sources, {signal, onUpdate, …})` → `SearchSnapshot {results, perSource, done, total}`. Emits a snapshot per settled source.
- `src/sources/registry.ts` — `enabledSources(disabled, adultEnabled)`, `sourcesByGroup`, `SOURCES`.
- `src/sources/types.ts` — `TorrentResult {infoHash, name, sizeBytes, seeders, leechers, source, sources?, magnet, added?}`.
- `src/recc/omdb.ts` — `fetchTitleMeta(imdbId, key)`, `fetchTitleMetaByName(title, key, {year, type})` → `{imdbId, plot, posterUrl}`.
- `src/ui/filter.ts`, `sort.ts` — the TUI's result filtering and sort orders, pure.
- `parse-torrent-title` (dependency) — the TUI parses release names for title/year/season.
- `/api/poster?url=` — live, host-allowlisted on every hop.
- `POST /api/stream` and the player from Phase 2.

## Carried-forward constraints

1. **Share logic, never re-copy it.** Four bugs in this project came from a second copy drifting: a hand-copied status payload that dropped a field, a byte formatter that diverged from the TUI, a progress unit read as a fraction, and an API path table in three places. `src/web/static/` is browser-bundled, so anything shared must be dependency-free — `src/util/videoFiles.ts` is the pattern.
2. **Serialise by picking fields**, never by omitting.
3. **A guard's mutant must die**, with the failure quoted.
4. **`createElement`/`textContent` only.** Release names and plots are attacker-influenced.
5. **Never `console` from the web layer.**
6. **`npm run build` after editing `src/web/static/`.**

---

## Unit 1 — Search over HTTP

**Files:** `src/web/wire.ts`, `src/web/routes.ts`, `src/web/server.ts`, `+ tests`

Search takes tens of seconds across 23 sources, and the whole point of the TUI's experience is that results appear as each source answers. A single blocking `GET /api/search` would throw that away and risk a proxy timeout.

**Use SSE**, the channel that already exists: `GET /api/search?q=…&group=…` streams `event: results` frames carrying a `SearchSnapshot`, then `event: done`. Reuse `src/web/sse.ts`'s framing; do not write a second SSE implementation.

- Wire types for the snapshot: `PublicSearchResult` picked explicitly from `TorrentResult`, plus per-source state so the UI can show "8/23 sources".
- One search per connection; abort `runSearch` when the client disconnects. **A dropped browser tab must not leave 23 HTTP requests running** — assert this with listener/timer counts, not output.
- `GET /api/sources` → the groups and per-source health, so the browser can offer the same category tabs the TUI has.
- Token-gated like every other `/api/*` route. `EventSource` can't set headers, so accept `?k=` — but note the capability in Phase 2 is *per stream session*; for search, the bearer token is what's in `sessionStorage`, exactly as `/api/events` already does it.

**Mutation checks:** the token gate; the disconnect abort; `done` never being emitted; per-source errors being swallowed rather than reported.

---

## Unit 2 — Title metadata over HTTP

**Files:** `src/web/routes.ts`, `+ tests`

`GET /api/title?name=…&year=…&type=…` or `?imdb=tt…` → `{imdbId, plot, posterUrl}`.

- Needs the user's OMDb key from config. Reuse the `loadConfigImpl` seam Phase 2 added to `routes.ts`.
- No key configured → a clean, distinguishable response, not a 500. The UI must be able to say "add an OMDb key to see plots" rather than looking broken.
- The poster URL returned here is fed to `/api/poster?url=`, which enforces the CDN allowlist — so this route must not be a way to smuggle an arbitrary URL to the browser. Check what OMDb can actually return and whether it needs its own validation.
- Cache in memory per process: scrolling a results list must not hammer OMDb, and the TUI already debounces for the same reason.

**Mutation checks:** the token gate; the no-key path returning 500; the cache never being consulted.

---

## Unit 3 — The search UI

**Files:** `src/web/static/searchModel.ts` (new, pure), `app.ts`, `index.html`, `styles.css`, `+ tests`

- A search box and category tabs matching the TUI's groups.
- Results streaming in as sources answer, with a "12/23 sources" progress indicator and the same default ordering (seeders, then recency — `core/search.ts` already orders; do not re-sort differently in the browser).
- Each row: name, size, seeders/leechers, source badge. Reuse `formatBytes` from `dashboard.ts`.
- Actions per result: **add to queue**, **play** (reusing Phase 2's `runPlay`), and **add via Real-Debrid** where configured.
- Sort and filter controls mirroring the TUI's (`src/ui/sort.ts`, `filter.ts` are pure — share them rather than reimplementing).

Keep every decidable thing in `searchModel.ts`; `app.ts` stays DOM binding. There is no jsdom here, so pure modules are how this gets tested.

---

## Unit 4 — Poster and plot preview

**Files:** `src/web/static/app.ts`, `styles.css`, `+ tests`

- Selecting a result shows a preview: poster via `/api/poster?url=` (already live), plot and IMDb link via `/api/title`.
- Parse the release name for title/year the way the TUI does — `parse-torrent-title` is a dependency but is Node-side; check whether it can be bundled for the browser, and if not, do the parsing server-side in `/api/title` and pass the raw release name. **Do not hand-roll a second release-name parser.**
- Lazy and debounced: arrowing through fifty results must not fire fifty OMDb lookups.
- Missing poster or missing key degrades to a placeholder, never a broken image.

---

## Unit 5 — Docs, verification, milestone

- README: searching from the browser, what the OMDb key buys.
- Full suite, typecheck, lint, build.
- **Real browser verification** with screenshots: a live search streaming in, a poster and plot rendering, add-to-queue from a result, play-from-result reaching the player.
- Commit and push.

---

## Out of scope for Phase 3

The For You feed (Phase 4), saved searches, search history, per-source toggles in the browser (the TUI owns configuration), RuTracker login from the browser.
