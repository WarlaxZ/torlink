# Web browse mode (blank search) — design

**Date:** 2026-07-28
**Status:** approved, ready to plan

## Problem

The TUI lets you press Enter on an empty search box to browse curated top lists.
The web UI cannot. The capability is not missing from the core — it is fenced off
at two points in the web layer:

- `src/web/routes.ts:448-451` — `parseSearchParams` answers `400 {"error":"missing query"}`
  for a blank `q`.
- `src/web/static/app.ts:657-662` — the submit handler silently returns on a
  blank input, so the request is never made.

## How browse mode already works

Browse is not a mode in the core. It is `query === ""` flowing through the same
pipeline: `runSearch("")` → `cachedSearch(source, "")` → `source.search("")`.
`runSearch` (`src/core/search.ts:114`) contains no empty-query check. Each source
decides what an empty query means for itself:

- TPB/apibay: the precompiled per-category Top-100 JSON (`data_top100_207.json`, …)
- 1337x: `/popular-<slug>` pages
- YTS: `list_movies.json?sort_by=date_added`
- EZTV: browse-only — it returns `[]` for a *non-empty* query
- SubsPlease: `?f=latest`; Nyaa: the newest RSS listing; FitGirl: `/feed/`
- RuTracker: `tracker.php?nm=` (empty `nm`)
- Torrents-CSV and BitTorrented deliberately opt out (`return []`) — no browse endpoint

Merging, dedupe by infohash, and the default seeders-desc-then-recency order are
identical to a real search. Category tabs, sort, text filter and alive-only all
apply unchanged. There is no pagination in browse mode.

The TUI's own affordances (`src/ui/components/Results.tsx`) derive everything from
`const browsing = query.trim() === ""`: panel title `latest`, status
`newest across all sources`, spinner `Loading n/m sources`, empty state
`Nothing new right now.`

## Decisions

1. **Entry point: submitting a blank search box**, matching the TUI exactly. No
   new pane, no separate button. A visible hint makes it discoverable.
2. **No auto-load on page open.** The TUI lands in browse mode because its
   initial query state is `""`; the web will not. A fresh tab or refresh would
   otherwise cost a full 23-source fan-out per load, and web refreshes are cheap
   and frequent in a way TUI launches are not. Browse fires only on explicit
   blank submit.
3. **`q` must be present, but may be empty.** `?q=` is browse; a bare
   `GET /api/search` with no `q` at all stays a 400, so a stray unparameterised
   request cannot trigger a 23-source fan-out.
4. **Browse state is explicit, not inferred from the empty string.** See below.

## Changes

### Server: `src/web/routes.ts`

`parseSearchParams` (`:447-457`) stops treating blank as invalid:

```ts
const raw = query.get("q");
if (raw === null) return { ok: false, error: "missing query" };
const q = raw.trim();   // "" is legal: browse the top lists
```

Group handling is untouched, so `?q=&group=Movies` browses the movie top lists —
the same set the TUI's Movies tab shows while browsing. An unknown group is still
rejected. `searchSources` and `startSearchStream` need no change: they pass the
query straight through to `runSearch`.

The doc comment on `parseSearchParams` must be updated — it currently explains
why a blank query is rejected.

### Browser state: `src/web/static/searchModel.ts`

`SearchView` overloads `query` as both the query text and the "has anything run
yet" flag: `searchStatus` returns the idle line whenever `!view.query`
(`:152`). A blank browse query would therefore be indistinguishable from a fresh
page. Add an explicit field:

```ts
mode: "idle" | "search" | "browse"
```

`searchStatus` switches on `mode` instead of on `!view.query`. The resulting
lines, mirroring the TUI:

| state | line | tone |
|---|---|---|
| idle | `Search across every enabled source.` (unchanged) | dim |
| browse, running | `Loading 12/23 sources`, or `loading… 12/23 sources` once rows are showing | dim |
| browse, settled, 0 shown | `Nothing new right now.` | dim |
| browse, settled, n shown | `n results · newest across all sources` | dim |
| search, running | `Searching 12/23 sources`, or `searching… 12/23 sources` once rows are showing (unchanged) | dim |
| search, settled, 0 shown | `No results for “x”.` (unchanged) | dim |
| search, settled, n shown | `n results` (unchanged) | dim |

One deliberate divergence from the TUI: the TUI's browse status line is *only*
`newest across all sources`, dropping the count, because its panel title already
flips to `latest`. The web has no such title, so the count stays and the phrase
is appended to it.

The `Couldn't reach any source. They may be down.` and
`Nothing matches those filters.` branches are mode-independent and stay shared,
keeping their precedence over the per-mode empty lines. The
`· n sources down` suffix likewise applies in both modes.

`searchUrl` already emits `q=` for an empty query, because
`new URLSearchParams({ q: "" })` keeps the key. No change needed, but it gets a
test.

### DOM: `src/web/static/app.ts`, `src/web/static/index.html`

- `app.ts:657-662`: drop `if (!query) return`; pass the trimmed value to
  `startSearch` and set `mode` to `browse` when it is empty, `search` otherwise.
- `app.ts:606` `startSearch`: set `mode` on the view alongside `query`.
- `index.html:52-53`: label → `Search every source`, placeholder →
  `the matrix 1999 — or leave blank to browse`.

- `app.ts:576`: the tab-switch re-run is guarded on `if (searchView.query)`,
  which would silently do nothing while browsing. It must switch on `mode`
  instead — a browse has an empty query but still needs re-running, because the
  server only fetched the previous tab's sources.

Explicitly unchanged: the results list and row rendering, the preview pane,
`POST /api/add`, and the play/stream flows — all are query-agnostic. Unlike the
TUI there is no watchlist key to disable on the web, so that asymmetry needs no
handling.

## Testing

- `src/web/routes.test.ts:749-783` — the existing
  `it.each(["", "q=", "q=%20%20"])` → `"missing query"` case inverts: `q=` and
  `q=%20%20` become valid browse params (`query: ""`), and only the
  no-`q`-at-all case stays a 400. Add a blank-`q`-with-`group` case.
- `src/web/server.test.ts` (`describe("/api/search")`, `:592`) — a blank-`q`
  stream opens `200 text/event-stream` and reaches `done`.
- `src/web/static/searchModel.test.ts` — the browse status branches, that filter
  and all-sources-down branches still win over them, and that
  `searchUrl("", …)` emits `q=`.
- `app.ts` is untested by design (no DOM environment); its changes are the two
  guard/label edits, verified by hand.
- Manual: `npm run build`, run with `--web`, drive it in Chrome DevTools and
  confirm real top-list results arrive over the SSE stream. Note
  `README.md:269-271` — assets are served from `dist/web`, so `npm run dev`
  alone shows stale browser bundles.

## Out of scope

- Pagination or "load more" for browse results.
- A dedicated `latest` pane or tab.
- Any change to which endpoint a source uses for an empty query.
