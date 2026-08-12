# Screenshots for adult results

**Date:** 2026-08-12
**Status:** Approved, ready for implementation plan
**Builds on:** `2026-08-12-adult-result-detail-pane-design.md` (the local breakdown pane is the graceful fallback when no screenshots resolve)
**Related:** `2026-08-12-adult-metadata-thumbnails-design.md` (a different approach — a paid adult metadata provider; this spec instead pulls images the uploader already put in the torrent description)

## Problem

Adult ("Porn" group) results have no OMDb artwork, so the detail pane shows only
the release name and a parsed breakdown. But the torrent descriptions on our two
adult sources **do** carry screenshots. We want to surface them in the preview,
where possible, without letting the browser touch the (untrusted, hotlink-prone)
image hosts directly.

## What the spike established (real data, 2026-08-12)

This design is grounded in a read-only reconnaissance run, not assumptions.

**TPB (apibay):** the search/browse JSON carries **no** description, but
`GET https://apibay.org/t.php?id=<id>` returns a `descr`, and 18/18 sampled adult
releases had one. The `descr` contains **4–6 screenshot links per release**, but
as image-host **landing pages**, not direct images:

- `https://trafficimage.club/image/<id>` (dominant)
- `https://s.starimage.club/image/<id>`
- `https://xxxwebdlxxx.org/img-<hash>.html`

Each landing page resolves to a direct image via its `og:image` meta tag. The
Chevereto-based hosts (`trafficimage.club`, `starimage.club`) expose size
variants — `<name>.jpg` (full), `<name>.md.jpg` (medium), `<name>.th.jpg`
(thumb). The apibay numeric `id` needed for `t.php` is already returned in the
list JSON (`ApibayItem.id`) but currently discarded.

**1337x:** the per-torrent detail page (which the source **already downloads**
for the top rows to get magnets) carries **direct** image URLs — 12/12 sampled
releases had them. Hosts: `imgtraffic.com`, `shotcan.com`, `pixfy.cfd`. No
landing-page resolution needed.

**All hosts:** returned `200` with `content-type: image/jpeg`, needed **no
Referer**, and ranged 10 KB (thumb) to ~360 KB (full).

Note `1337x.to`/`1337x.st` returned 403 (Cloudflare); the working list host in the
sample was `www.1337xx.to`. The source already has a host-failover list, so this
is handled — the screenshot fetch reuses whatever host answered.

## Goal

When an adult result is highlighted and screenshots are enabled, show them:
- **Web:** a strip of up to 4 thumbnails below the breakdown; click one to enlarge
  the full image.
- **TUI:** the first screenshot rendered as truecolor half-blocks (the existing
  poster pipeline), above the name + breakdown.

Everything is **lazy** (fetched on highlight, debounced, like the OMDb preview),
**allowlisted** (SSRF guard on every fetch), and **fails soft** (no screenshots →
the breakdown pane we already ship).

## Architecture

The shape mirrors the existing OMDb path: a front-end-agnostic core, a pure
extraction module beside it, a web route, and a direct call from the TUI.

### 1. Pure extraction — `src/util/screenshotExtract.ts` (new, tested)

No network, no `node:*`; unit-tested against fixtures captured from the spike
(HTML/descr snippets with **invented** studio names, never a real one).

```ts
export interface Shot { thumb: string; full: string; }

// TPB descr → landing-page URLs (known landing hosts + bbcode/href/bare-url forms).
export function extractTpbLandings(descr: string): string[];

// A landing page's HTML → its direct image URL (og:image), or null.
export function directFromLandingHtml(html: string): string | null;

// A 1337x detail page's HTML → direct image URLs (filtered of site chrome).
export function extract1337xImages(html: string): string[];

// Direct URL → a smaller variant for the strip where the host offers one
// (Chevereto ".jpg" → ".md.jpg"), else the URL unchanged.
export function thumbFor(directUrl: string): string;

// The single SSRF gate. Exact-host membership over the spike-verified set.
export function screenshotHostAllowed(url: string): boolean;
```

`screenshotHostAllowed` seeds with: `imgtraffic.com`, `shotcan.com`, `pixfy.cfd`,
`trafficimage.club`, `starimage.club`, `s.starimage.club`, `xxxwebdlxxx.org`.
A single exported `SCREENSHOT_HOSTS` set is the source of truth, shared with the
proxy (§3). New hosts are a one-line addition; until added they fall through to
breakdown-only.

### 2. Fetch/resolve core — `src/core/screenshots.ts` (new, tested with a fake fetch)

```ts
export function screenshotsFor(
  source: string,            // result.source: "TPB" | "1337x" (adult siblings map the same)
  ref: string,               // TorrentResult.screenshotRef (§4)
  opts: { fetchImpl?: FetchImpl; limit: number },
): Promise<Shot[]>;
```

- **TPB** (`ref` = apibay id): `t.php?id=<ref>` → `extractTpbLandings` → for each
  allowed landing (up to `limit`), fetch it → `directFromLandingHtml` →
  `{ full, thumb: thumbFor(full) }`.
- **1337x** (`ref` = detail path, e.g. `/torrent/<id>/<slug>/`): fetch
  `<host><ref>` on the source's host-failover list → `extract1337xImages` → map to
  `Shot` (up to `limit`).
- Every fetch: `fetchResilient`/`torlinkFetch` (`src/util/net.ts`), gated by
  `screenshotHostAllowed` (the landing/detail host **and** the resolved image host
  are both checked). Any failure → that shot is dropped; a total failure → `[]`.
- LRU cache keyed by `source + "\0" + ref`, so re-highlighting is free. `limit`
  is small (4) so a highlight is at most ~1 + 4 landing fetches for TPB, 1 for
  1337x.

### 3. Image proxy — `SCREENSHOT_HOSTS` allowlist + route

Modeled on `getPoster` (`src/core/posterCache.ts`) and `GET /api/poster`
(`src/web/routes.ts`), because `POSTER_HOSTS` is an exact-Set test that would
reject these hosts. Two options, decided in the plan: extend `posterCache` to take
an allowlist parameter, or a sibling `src/core/screenshotCache.ts`. Either way it:
- fetches through `torlinkFetch`, re-checks `screenshotHostAllowed` on the initial
  host and after any single redirect hop,
- validates `content-type` starts with `image/`, enforces a size cap, checks magic
  bytes for jpg/png/webp (posters are jpg-only today; screenshots are broader),
- disk-LRU caches.

Web routes (`src/web/routes.ts`):
- `GET /api/screenshots?source=&ref=` → `{ images: Shot[] }` (calls `screenshotsFor`;
  returns `{ images: [] }` when disabled or nothing resolves — never an error the
  UI has to special-case).
- `GET /api/screenshot?url=` → the proxied image bytes.

Both are gated on adult being enabled **and** `adultScreenshots` on (§5); with
either off they return empty / 404 so a stale client can't fetch.

### 4. Carrying the ref — `TorrentResult.screenshotRef`

`src/sources/types.ts`: add `screenshotRef?: string`. TPB sets it to the apibay
`id` (`piratebay.ts` currently drops it); 1337x sets it to the detail `path` it
already parses (`x1337.ts` `parseRows`). Add the matching
`PublicSearchResult.screenshotRef?` to `src/web/wire.ts` and populate it in
`toPublicResult`. These are public listing refs (not the magnet, which stays off
the wire).

### 5. Settings — `adultScreenshots`, default **on**

A non-secret preference, so it ships in **both** surfaces (per CLAUDE.md):
- `src/config/config.ts`: `adultScreenshots: boolean` (default `true`), read by
  `sanitiseSettingsPatch` (validated) and surfaced through `GET/POST /api/settings`.
- `GET /api/sources` reports a capability flag (e.g. `adultScreenshots`) so the
  browser knows whether to attempt the fetch.
- TUI Settings pane (`src/ui/components/Settings.tsx`) and the web settings dialog
  both get the toggle. When off: no screenshot fetch, both panes show breakdown
  only.
- It is only meaningful when adult content is enabled; the UI can group/hide it
  accordingly, but the config field itself is independent (matches how the other
  adult-adjacent prefs behave).

### 6. Display

**Web** — extends the adult branch added in the detail-pane spec
(`previewModel.ts` local path, wired in `app.ts`):
- After rendering the breakdown, if `adultScreenshots` is on, lazily (reuse the
  preview debounce) `GET /api/screenshots?source=&ref=`.
- Render a strip of up to 4 thumbnails: for each `Shot`, an `<img>` built with
  `createElement` (NEVER innerHTML — these URLs are uploader-controlled),
  `src = /api/screenshot?url=<encodeURIComponent(thumb)>`, `loading="lazy"`,
  `alt=""`. Clicking opens the `full` (via `/api/screenshot?url=<full>`) enlarged —
  a lightbox overlay, or reuse an existing enlarge affordance; decided in the plan.
- The decision of *what to fetch/show* lives in a pure `previewModel`/`searchModel`
  helper (`app.ts` stays DOM wiring): e.g. `screenshotStripModel(shots)` returning
  the thumb/full pairs to mount, so the conditional is tested, not in `app.ts`.
- Fails soft: fetch error / `{images: []}` → no strip, breakdown stands.

**TUI** — extends the adult branch in `Results.tsx`:
- When `adultScreenshots` is on and the section is adult, call `screenshotsFor`
  (debounced/cached, mirroring `useTitlePreview`'s shape — likely a small
  `useScreenshots` hook or an extension of the preview hook), take the first
  `Shot.full`, render it with the existing half-block pipeline
  (`cachedPosterRows`/`src/util/poster.ts`) in the `PreviewPane` poster slot.
- `PreviewPane` already renders `posterRows`; the `local` mode added in the
  detail-pane spec suppressed the poster region — that mode gains an optional
  `posterRows` path so a screenshot can occupy it while the title still wraps and
  the breakdown still shows.

### 7. Testing

- `screenshotExtract.ts`: unit tests for each function against fixtures — a TPB
  `descr` with landing links (invented studio, e.g. `[Meridian Studios 2026]`),
  each landing host's `og:image` HTML shape, a 1337x detail snippet, `thumbFor`
  Chevereto derivation, and `screenshotHostAllowed` (allow known, reject unknown +
  reject a look-alike like `evil-trafficimage.club`).
- `screenshots.ts`: drive `screenshotsFor` with a fake `fetchImpl` returning
  canned descr/HTML; assert the resolved `Shot[]`, the allowlist gate (an
  off-list host in a descr is skipped), the `limit`, and fail-soft (`[]`) on
  fetch errors.
- Proxy: content-type reject, size cap, allowlist reject, redirect re-check —
  mirroring the existing poster-cache tests.
- Web display model + TUI hook logic: pure helpers tested; `app.ts` DOM wiring and
  the Ink pane verified by running (`npm run dev -- serve --web` and the TUI), plus
  a `PreviewPane` render test for the screenshot-in-local-mode case.
- `npm test / typecheck / lint / build`.

## Safety and honesty

- **SSRF:** every outbound fetch (landing pages, detail pages, images) is gated by
  the `SCREENSHOT_HOSTS` allowlist; the browser never learns a third-party URL it
  could be tricked into fetching — it only ever calls same-origin `/api/screenshot`.
- **Malware/oversize:** the proxy validates content-type, magic bytes and size,
  exactly as the poster proxy does.
- **The images are uploader-controlled explicit content** — that is the feature,
  reachable only when adult content is enabled *and* `adultScreenshots` is on. The
  allowlist and validation are a security boundary, not a content filter.
- **Fragility is acknowledged, not hidden:** the allowlist covers the hosts we have
  verified; anything else falls through to the breakdown-only pane. No silent
  half-broken state — a shot either resolves and validates, or it is absent.

## Out of scope

- No downloading/saving screenshots, no full-screen gallery beyond click-to-enlarge.
- No new source; only TPB and 1337x (and their adult siblings, which share the code
  path).
- The paid adult-metadata-provider approach remains a separate, unrelated spec.
