# Real-Debrid vs torrent indicator in downloads — design

**Date:** 2026-07-01
**Branch:** feat/download-source-badge
**Status:** Approved (pending spec review)

## Problem

The user never wants to download via torrent (P2P) — only via Real-Debrid — but
the downloads list gives no clear signal which delivery method an item is using.
`Downloads.tsx` shows the *torrent origin* tag (e.g. `EZTV`, `YTS`) in the source
column whenever the item has one, so a Real-Debrid download of an EZTV torrent
displays `EZTV` and looks identical to a P2P download. There is a `"rd"`/`"mag"`
fallback (`sourceTag`), but the origin tag wins, hiding the method.

## Goal

Make delivery method unmistakable in the downloads list: Real-Debrid items read
as `RD` (green), P2P/torrent items as `P2P` (amber — the method to avoid), each
keeping its origin tag (`RD·EZTV`, `P2P·YTS`). Completed items keep the label in
"Recently downloaded" too.

## Decision (confirmed)

Method badge **+** origin, colored: `RD·EZTV` (RD green, origin in its usual
colour) / `P2P·YTS` (P2P amber). Applies to both active and recent rows.

## Existing architecture (reference)

- `src/ui/components/Downloads.tsx` — active rows and "Recently downloaded" rows
  each render a width-4 source cell: `{it.source ? ss.tag : sourceTag(it.via)}`
  (active, ~line 192-196) and `{h.source ? ss.tag : "mag"}` (recent, ~line
  252-256). `sourceTag(via)` (~line 54-56) returns `"rd"`/`"mag"`. `SOURCE_STYLE`
  maps a `SourceId` → `{ tag, color }`. `COLOR.good` (green) / `COLOR.warn`
  (amber) exist in the theme.
- `src/download/types.ts` — `QueueItem.via?: "p2p" | "realdebrid"` (absent = p2p,
  back-compat). P2P `add()` leaves `via` undefined; `addDebrid` sets
  `"realdebrid"`.
- `src/download/history.ts` — `HistoryItem` has no `via` field.
- `src/download/queue.ts` — `recordHistory(it)` builds a `HistoryItem` from a
  finished `QueueItem` (does not carry `via`).
- `src/ui/downloadState.ts` — existing pure UI helper (no Ink import); good home
  for a method helper.

## Components

### 1. `deliveryMethod` helper — `src/ui/downloadState.ts`

```
export function deliveryMethod(via: DownloadVia | undefined): "RD" | "P2P"
```
`via === "realdebrid"` → `"RD"`, else `"P2P"` (undefined treated as P2P, matching
the "absent = p2p" convention). Pure, unit-tested.

### 2. `HistoryItem.via` — `src/download/history.ts` + `src/download/queue.ts`

- Add `via?: DownloadVia` to `HistoryItem`.
- In `recordHistory`, set `via: it.via ?? "p2p"` so every *new* completed item
  carries an explicit method. Persisted to `history.json`; optional, so old
  entries load with `via` undefined.

### 3. Badge rendering — `src/ui/components/Downloads.tsx`

- A small `SourceBadge` sub-component: `{ method: "RD" | "P2P" | null; source?:
  SourceId; dim?: boolean }`. Renders the colored method (`RD` → `COLOR.good`,
  `P2P` → `COLOR.warn`) + `·` + origin tag (`SOURCE_STYLE[source]`), omitting the
  `·origin` when there's no source, and falling back to a dim `mag` only when
  both method and source are absent (preserves the old bare-magnet look for
  legacy history rows).
- Active rows: `method={deliveryMethod(it.via)}` (always labelled) `source={it.source}`.
- Recent rows: `method={h.via === undefined ? null : deliveryMethod(h.via)}` — so
  legacy history entries (no `via`) show origin-only and are never mislabeled;
  new entries show `RD`/`P2P`.
- Widen both source cells from `width={4}` to `width={8}` to fit `P2P·NNNN` (max
  origin tag is 4 chars); the flex name column absorbs it — no layout math
  changes.
- Remove the now-unused `sourceTag` function.

## Data flow

`QueueItem.via` → active row badge (`deliveryMethod`). On completion,
`recordHistory` stamps `via` into the `HistoryItem` → recent row badge. Legacy
history without `via` → origin-only.

## Error handling / edge cases

- No origin source (bare magnet, active): shows just `RD`/`P2P`.
- Legacy history entry (no `via`) with a source: shows the origin tag only (no
  method); without a source: shows `mag` (unchanged).
- Restored active items persisted by older code without `via`: treated as P2P
  (undefined → P2P) — correct for a magnet download.

## Testing

- `downloadState.test.ts`: `deliveryMethod("realdebrid")==="RD"`,
  `deliveryMethod("p2p")==="P2P"`, `deliveryMethod(undefined)==="P2P"`.
- `HistoryItem.via` + `recordHistory` wiring and the `SourceBadge` rendering
  verified by typecheck + the existing queue tests + a manual smoke (RD download
  shows `RD·<src>`; a P2P one shows `P2P·<src>`; completed RD stays `RD·…` in
  Recently downloaded).

## Scope / sequencing

One small cohesive change. Build order:
1. `deliveryMethod` helper + test.
2. `HistoryItem.via` + `recordHistory` stamps it.
3. `Downloads.tsx` `SourceBadge` (active + recent), widen column, drop `sourceTag`.

## Out of scope

- The Real-Debrid 503 retry-pacing fix (separate follow-up; the log confirmed a
  bare 503 with no Retry-After and over-eager retries).
- Seeding view (inherently P2P; unchanged).

## Open decisions (resolved)

- Method badge + origin, RD green / P2P amber. ✅
- Label completed items in history via a persisted `via` (legacy entries
  origin-only, never mislabeled). ✅
