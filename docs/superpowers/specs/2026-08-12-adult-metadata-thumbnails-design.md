# Adult metadata provider — real thumbnails for adult results (scoping spec)

**Date:** 2026-08-12
**Status:** Scoped, NOT yet approved for implementation. Own spec → plan →
implementation cycle. Larger and riskier than the sibling spec.
**Sibling (ships first):** `2026-08-12-adult-result-detail-pane-design.md`

This document scopes the work and records the open risk. It is deliberately a
level less detailed than an implementation-ready spec — the match-quality question
below should be answered with a spike before committing to the full build.

## Problem

Adult results have no poster art. OMDb — the single provider behind every poster
and plot in torlink today (`src/recc/omdb.ts`, `GET /api/title`,
`GET /api/poster`) — has essentially no adult catalog, so it cannot supply them.
Real thumbnails require a *different* metadata provider.

## Proposed provider

**ThePornDB (metadataapi.net)** — a community adult metadata API with scene/movie
search and poster/thumbnail images, accessed with a per-user API token. It is the
closest analogue to OMDb for this domain (REST, JSON, image URLs on a known CDN).

Alternatives considered: scraping torrent descriptions/screenshots — rejected,
because torlink's current sources (TPB top-lists, 1337x) do not ship screenshots
in their data; and Adult DVD Empire / others — weaker or no public API.

## Scope of work

### 1. Credential (TUI-only, per the secret-config rule)

- New token `tpdbApiKey` in config, alongside `omdbApiKey`. It is a credential, so
  it is **TUI-configured only** — the browser never sees it.
- `GET /api/sources` exposes a capability flag `adultMetaConfigured` (mirroring
  `omdbConfigured`), so the web adapts read-only without holding the token. The
  settings dialog shows account status read-only, like the other providers.

### 2. Provider client — `src/recc/tpdb.ts` (new, tested)

- `fetchAdultMetaByName(query, apiKey)` → `{ posterUrl, title, ... } | null`.
- Mirrors the shape/testing style of `src/recc/omdb.ts`. Fails soft (network error
  / no key / no match → `null`, never throws into the UI).

### 3. Adult release → search query parser (new pure module, tested)

Adult P2P release names do not follow the `parse-torrent-title` film/TV shape
(`hintForGroup("Porn")` already returns `undefined`). A dedicated parser turns a
release name into a provider query — studio + scene title/date — reusing the
best-effort studio extraction from `releaseBreakdown` (sibling spec) as a starting
point. Lives in `src/util/`.

### 4. Poster proxy allowlist

- Add ThePornDB's image CDN host(s) to `POSTER_HOSTS` (`src/core/posterCache.ts:18`)
  and to `allowedPosterUrl` / `POSTER_HOSTS` in `src/web/routes.ts`, so the
  existing `GET /api/poster` proxy (which prevents the browser from hitting the CDN
  directly — IP/referer leak, SSRF guard) covers the new host too.

### 5. Lookup path

- Extend `GET /api/title` (or add a sibling route) to serve adult lookups when the
  group is "Porn" **and** `adultMetaConfigured`, routing to `tpdb.ts` instead of
  `omdb.ts`.
- Both front ends: widen the poster/preview gates for "Porn" **only when
  `adultMetaConfigured`**. When it is not configured, behaviour falls back to the
  sibling spec's local name + breakdown pane.

### 6. Both surfaces

- Web: adult cards fetch posters and the preview pane shows the provider plot,
  gated on `adultMetaConfigured`.
- TUI: same, gated on a non-empty `tpdbApiKey` (parallel to the `omdbApiKey`
  requirement).
- README web-UI capability list updated.

## The open risk (why this is separate and gated on a spike)

**Match quality on scrappy P2P release names is the unknown.** A string like
`Things Your Wife Wont Do 10 [<studio> 2026] XXX WEB-DL 1080p SPLIT SCENES
MP4-P2P` is studio-compilation naming, not a clean scene identifier, and the
provider is keyed on studio + scene metadata. A high miss rate would mean adult
cards mostly show the "no poster" placeholder even *with* a key configured — worse
than the honest local breakdown, because it implies a broken lookup.

**Gate:** run a spike first — take a representative sample of real adult release
names from the live `?group=Porn` feed, run them through the candidate parser +
ThePornDB, and measure hit rate. Only commit to the full build if the hit rate is
high enough to be worth a credential. Also confirm the provider's rate limits and
terms of use before shipping.

## Non-goals

- No performer/scene browse features — thumbnails + plot only, matching the OMDb
  parity the rest of the app has.
- No change to which sources provide adult content.
