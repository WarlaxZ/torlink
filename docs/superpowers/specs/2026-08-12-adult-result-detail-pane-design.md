# Adult-result detail pane (full name + parsed breakdown)

**Date:** 2026-08-12
**Status:** Approved, ready for implementation plan
**Follow-on:** `2026-08-12-adult-metadata-thumbnails-design.md` (real thumbnails, separate cycle)

## Problem

Adult ("Porn" group) results carry no OMDb metadata, so they render with only a
title — and that title is truncated in the results list (CSS ellipsis). The full
release name, which is the *only* metadata these results have, is never fully
visible, and the highlight/preview pane that Movies/TV/Anime get is switched off
for the group entirely.

Concrete example of what the user sees (names elided):

```
The most beautiful office lady shares a room with her hated middle-aged boss on
7.10 GB · 731 seeders · 239 leechers · TPB · cached
Things Your Wife Wont Do 10 [<studio> 2026] XXX WEB-DL 1080p SPLIT SCENES MP
```

Both lines are cut off mid-string; the tail (`…boss on`, `…MP4-P2P [XC`) is lost.

## Goal

When an adult result is highlighted, show a detail pane containing:

1. The **full, untruncated release name**.
2. A **parsed breakdown** of the release string — resolution, source, codec,
   group, year, and a best-effort studio/site.

No poster, no plot, **no network lookup**. Everything is built from data already
on the result row, client-side, in both front ends.

Explicitly out of scope: real poster art (that is the follow-on spec), and any
size/seeders line in the pane (those already appear on the list row).

## Key constraint that shapes the design

`previewApplies(group)` (`src/web/static/searchModel.ts:555`) is doing double duty
today: it gates the OMDb **poster** fetch (`postersApply` =
`omdbConfigured && previewApplies(group)`, `resultPosters.ts:73`) *and* the
preview pane's `select` call (`app.ts:2871`). The TUI has the parallel
`previewSection` predicate (`Results.tsx:530-533`), and its `showPreview` also
hard-requires `omdbApiKey !== ""` (`Results.tsx:534-535`).

If we simply widened those predicates to include "Porn", the UIs would start
firing OMDb poster/title lookups for adult results. OMDb has essentially no adult
catalog, so every lookup would be a wasted miss (and a needless request).

**Therefore:** `previewApplies` keeps meaning *"OMDb applies"*. We add a
**separate, local-only preview path** for adult groups that builds the pane from
the result row with zero network calls. The poster gate (`postersApply` /
`previewSection`'s OMDb use) is left untouched, so adult cards still fetch no
posters.

## Architecture

### Shared pure module — `src/util/releaseBreakdown.ts` (new)

One pure function, unit-tested, imported by **both** front ends (lives in
`src/util/`, below `src/web` and `src/ui`, so no copy-drift — this is the
codebase's stated rule for a second consumer).

```ts
export interface BreakdownField { label: string; value: string; }
export function releaseBreakdown(name: string): { fields: BreakdownField[] };
```

- Reuses `parseRelease` (`src/util/release.ts`), which wraps `parse-torrent-title`
  and is already bundled into the browser (`previewEpisodeFor`, `resultGroup`), so
  it is browser-safe — no `node:*` reaches `src/web/static`.
- Reliable fields from `parse-torrent-title`: **resolution, source
  (WEB-DL/BluRay/…), codec, group, year**.
- **Best-effort studio/site:** the first bracketed token, since adult releases
  commonly embed `[Studio Year]`. Extract the studio words (strip a trailing
  year). This is explicitly best-effort and is **omitted** when there is no
  bracketed segment — it never shows a wrong-looking blank.
- Empty / noise-only fields are dropped so the pane never renders blank rows.
- Field order is fixed and stable: studio, year, resolution, source, codec, group.

### Web — `src/web/static/`

- **`previewModel.ts`:** new pure helper `localPreviewCopy(name)` (tested) →
  returns a `PreviewCopy` with `heading = name`, `body` built from
  `releaseBreakdown(name)`, `posterUrl = null`, `imdbUrl = null`,
  `posterNote = "Adult content"`. Reuses the existing `PreviewCopy` shape so the
  render path in `app.ts:3182-3208` is unchanged.
- **`createPreviewController.select`:** add a **local branch** — when the group is
  adult, render `localPreviewCopy(release)` synchronously (like the existing
  cache-hit path at `previewModel.ts:131-135`); do **not** schedule the debounced
  `fx.fetch`. The controller learns the group is adult via a predicate (below).
- **`searchModel.ts`:** new predicate `adultPreviewApplies(group)` returning
  `group === "Porn"`, mirroring `previewApplies`. Pane visibility / the decision
  to call `select` becomes `previewApplies(group) || adultPreviewApplies(group)`.
- **`postersApply` is not touched** — adult cards keep fetching no posters.
- **`app.ts`** is DOM wiring only (per CLAUDE.md): it passes the group through and
  keeps the pane column visible for the adult case. No "what to show / what to
  send" logic lands in `app.ts` — that all lives in the two pure modules above.

### TUI — `src/ui/`

- **`Results.tsx`:** split `showPreview` so the adult section shows the pane
  **without** requiring `omdbApiKey` and **without** calling `useTitlePreview`
  (no network). For an adult selection, build local pane inputs directly from the
  `TorrentResult`: `title = name`, breakdown lines from `releaseBreakdown(name)`,
  `posterRows = null`.
- **`PreviewPane.tsx`:** small copy tweak so the local/adult case does **not**
  render "No poster available." / "No plot available." (both imply a failed
  lookup). It renders the full name + breakdown cleanly. The component stays
  purely presentational — it gains, at most, a flag/mode input; it does not learn
  what "adult" means.
- No new keymap entry (the pane already exists), no new `Store` field (so
  `makeStore` / `makeTestStore` are untouched).

## Data availability (verified)

Both surfaces already carry the full name locally, and both panes can render from
local data:

- Web: `PublicSearchResult.name` (`wire.ts:325`) is the full string; the list
  truncates via CSS only (`styles.css:852-864`). `previewCopy` already falls back
  to the raw release name as `heading`.
- TUI: `TorrentResult.name` (`sources/types.ts:28-40`); `PreviewPane` renders from
  `title` + optional `note` alone (`PreviewPane.tsx:6-54`).

## Testing

- Unit tests for `releaseBreakdown` (field extraction, studio bracket heuristic,
  noise-only → dropped fields, missing-bracket → no studio) and `localPreviewCopy`
  (heading = full name, body from breakdown, null poster/imdb).
- **Fixtures use invented studios** — never a real brand — and reuse the
  CLAUDE.md cast words in adult-release shapes, e.g.
  `Kestrel [Meridian Studios 2026] XXX WEB-DL 1080p SPLIT SCENES MP4-P2P` and
  `Ashfall.1999.1080p.WEB-DL.x264`. No real title, studio, or performer appears in
  any fixture.
- Verify wiring by running it: `npm run dev -- serve --web` (web) and the TUI.
- `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` (build is the
  check that `src/web/static` pulls in no `node:*`).

## Ships in both surfaces

This is a non-secret, user-facing behaviour, so per CLAUDE.md it lands in the TUI
and the web in the same change. It is only ever visible when adult content is
enabled (the group is otherwise absent from `/api/sources` and the sidebar).
No new preference or credential is introduced. README's web-UI limitations list is
re-checked for the "adult results show only a title" claim.

## Future work

Real poster art for adult results is scoped separately in
`2026-08-12-adult-metadata-thumbnails-design.md`.
