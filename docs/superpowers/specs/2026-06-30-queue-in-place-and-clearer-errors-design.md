# Queue-in-place, persistent results & clearer RD errors — design

**Date:** 2026-06-30
**Branch:** main (start a feature branch for the work)
**Status:** Approved (pending spec review)

## Problem

Two friction points reported while using the app:

1. **Losing your place when queueing downloads.** Pressing `r` (Real-Debrid) or
   `d` (P2P) on a result switches the view to the downloads section, which
   unmounts the results list. Returning to results re-runs the entire
   multi-source search from scratch and resets the cursor to the top — so it's
   hard to queue several items in a row or tell what's already downloading/done.
2. **Misleading error copy.** Some torrents surface "Real-Debrid is temporarily
   unavailable" (the generic HTTP 503 message), which reads like an RD outage
   even when the real cause is dead/removed content. There's no way to tell
   "retry later" from "this is gone".

## Goal

Let the user queue multiple downloads without leaving the results list, see at a
glance which results are already downloading/done, navigate to the downloads
view and back without a reload or losing position, and get Real-Debrid error
messages that accurately distinguish transient outages from gone/unavailable
content.

## Existing architecture (reference)

- `src/ui/App.tsx` — `startDownload` and `startDebridDownload` both end with
  `setSection("downloads"); setRegion("content");`. The body renders exactly one
  of `<Results/>` / `<Downloads/>` / `<Seeding/>` based on `section`.
- `src/ui/components/Results.tsx` — owns search via `useConcurrentSearch(query)`,
  plus local `cursor`, `mode`, `detail`, `sort` state. `useInput` is gated on
  `focused = region === "content"` (NOT on section). A `useEffect(() =>
  setCursor(0), [results])` resets the cursor whenever the results array
  identity changes.
- `src/ui/hooks/useConcurrentSearch.ts` — fires its fetch effect on mount, keyed
  on `[query]`. State is local to the hook, so unmount loses it and remount
  re-fetches.
- `src/ui/store.ts` — exposes `queue`, plus `useQueueItems(queue)` and
  `useQueueHistory(queue)` hooks returning live `QueueItem[]` / `HistoryItem[]`.
  Queue items and history items are keyed by `id`, which equals the torrent
  `infoHash` (Results builds inputs with `id: r.infoHash`).
- `src/integrations/realdebrid.ts` — `mapStatus(status, code)` maps HTTP codes
  (incl. 503 → "Real-Debrid is temporarily unavailable.") and `resolveMagnet`
  throws `"Real-Debrid could not fetch this torrent (<status>)."` for the
  `ERROR_STATUSES` set `{ error, magnet_error, virus, dead }`. The JSON
  `error`/`error_code` from RD is already captured as `code`.

## Features

### 1. Stay in the results list when downloading

Remove the `setSection("downloads")` and `setRegion("content")` lines from BOTH
`startDownload` and `startDebridDownload` in `App.tsx`. The existing notice
("Real-Debrid: X" / "Added: X") still fires. The user stays on the current
results row and can queue more. No other behavior in those handlers changes. The
P2P confirm flow (`requestP2PDownload` → `ConfirmPrompt`) is unaffected beyond no
longer navigating after confirm.

### 2. Status markers on result rows

Add a one-character status indicator to each result row, derived live by matching
the row's `infoHash` against the download queue + history.

- New pure helper, e.g. `downloadStateFor(hash, items, history)` returning one of
  `"downloading" | "paused" | "failed" | "done" | null`:
  - active queue item with status `downloading` (or RD `resolving` phase) →
    `"downloading"`
  - active queue item status `paused` → `"paused"`
  - active queue item status `failed` → `"failed"`
  - present in history → `"done"`
  - otherwise → `null`
  - Precedence: an active queue item wins over history (re-downloading something
    already in history shows its active state).
- Glyphs/colours via the existing theme: `↓` accent (downloading), `⏸`
  (paused), `✗` `COLOR.bad` (failed), `✓` `COLOR.good` (done), blank when null.
- Placement: a fixed one-character column immediately left of the name (the row
  already has a pointer gutter + index number; this slots between them without
  reflowing the size/seeders/source columns). Show the same marker in the detail
  view header.
- Results obtains the live arrays via the existing `useQueueItems(queue)` /
  `useQueueHistory(queue)` hooks and builds a `Map<hash, state>` once per render.

### 3. Non-destructive navigation (persistent panes)

Stop mounting/unmounting body views on section change. Instead render Results,
Downloads, and Seeding as persistent, visibility-toggled panes, and gate each
pane's keyboard input on its section being active.

- In `App.tsx`, render all three body components, each wrapped so only the one
  matching `section` is visible (`display: "flex"` vs `"none"`); the others stay
  mounted but take no layout space.
- Input gating: each pane's `useInput` `isActive` must additionally require its
  section to be the active one, so hidden panes don't double-handle keys:
  - Results: active when `section` is a category (not `downloads`/`seeding`).
  - Downloads: active when `section === "downloads"`.
  - Seeding: active when `section === "seeding"`.
  Each component already reads `region`/`section` from the store (or can), so
  this is a localized `isActive` change.
- Effect: switching to Downloads and back is instant and preserves Results'
  search results, cursor (scroll position), and sort — because Results never
  unmounts and its background search isn't restarted. The existing
  `setCursor(0)` on `[results]` still fires only on a genuine new query (the
  results array reference is stable across section toggles), so position is kept
  on return but correctly resets on a fresh search.
- Open detail panel (`mode === "detail"`) is local and returning to the list on
  a later interaction is acceptable; no requirement to persist detail mode.

### 4. Clearer Real-Debrid error messages

Rework messages in `realdebrid.ts` so each failure category reads accurately.

- Pipeline torrent statuses (currently all collapse to "could not fetch this
  torrent (<status>)") become specific, terminal-sounding messages:
  - `dead` → "No seeders — Real-Debrid can't fetch this torrent."
  - `magnet_error` → "Real-Debrid couldn't read this magnet (it may be invalid
    or removed)."
  - `virus` → "Real-Debrid flagged this torrent's contents."
  - `error` (catch-all) → "Real-Debrid couldn't process this torrent."
- HTTP 503 → transient wording: "Real-Debrid is busy — try again shortly."
- Map RD's known JSON `error_code`s (already captured as `code`) for
  file/hoster-no-longer-available cases to: "This is no longer available on
  Real-Debrid (it may have been removed)." Unknown codes keep the existing
  generic fallback. Code→message mapping is derived from RD's public API error
  semantics and lives in a small pure function.
- All mapping is pure and unit-tested by (status, code) → message.

## Data flow

`queue` + history (App store) → `useQueueItems`/`useQueueHistory` in Results →
`downloadStateFor(hash, …)` per row → status glyph. Download actions mutate the
queue but no longer change `section`, so Results stays mounted and its markers
update live. RD failures flow through the reworked `mapStatus` / status mapping
into the same notice/queue-error surfaces as today.

## Error handling

- Status markers: a result with no matching queue/history entry renders no glyph
  (no error state). Lookup is a pure map build; never throws.
- Persistent panes: hidden panes are inert (input gated off); no double input.
- Error messages: unknown RD codes/statuses fall back to the existing generic
  message — no regression, just better copy for the known cases.

## Testing

- Pure logic via vitest:
  - `downloadStateFor` precedence (active over history; each status; null).
  - RD message mapping: each torrent status and the mapped HTTP/error_code cases
    produce the expected strings; unknown inputs hit the fallback.
- UI changes (no-navigate, marker column, persistent-pane gating) verified by
  `npm run typecheck` + a manual smoke run (queue several without leaving the
  list; toggle to Downloads and back; confirm position/sort preserved).

## Scope / sequencing

One cohesive spec. Natural build order:
1. #4 error-message mapping (isolated, pure) — independent.
2. #2 `downloadStateFor` helper + marker rendering.
3. #1 remove navigation from the download handlers.
4. #3 persistent panes + input gating (the one structural change), last so the
   marker/no-navigate behavior is already in place to verify against.

## Open decisions (resolved)

- Download flow: stay in results AND make navigation non-destructive. ✅
- Error goal: clearer, accurate messages distinguishing dead/removed vs RD
  outage (no auto-retry behavior). ✅
