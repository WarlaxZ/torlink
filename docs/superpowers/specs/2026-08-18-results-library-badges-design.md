# Design: library-aware search results (downloaded & played badges)

Date: 2026-08-18
Status: approved direction, pending spec review
Visual pitch: the private Artifact "Library-Aware Results" (badge system, poster grid,
list view, TUI parity strip).

## Problem

On the search results page you cannot tell, at a glance, which releases you have
**already downloaded** or **already watched**. When hoovering up every release of a
title, this leads to re-adding something you already grabbed. The terminal UI already
draws a download-state glyph on each row; the browser draws nothing. Neither surface
shows a "played" signal on results.

## Goal

A badge system on search results, in **both** front ends, that answers two questions
per row:

1. **Have I downloaded this?** — covering the full download history, not just what is
   currently in the queue (so something grabbed weeks ago and long cleared still shows).
2. **Have I watched this?** — at the **title** level (a film you've played, or a show
   you've started), reusing the existing stream-history high-water mark.

Plus one workflow companion: a **"Hide downloaded"** filter so the grid collapses to
only what's left to grab, and a small `N downloaded` count.

## Design thesis: three axes, three colours

The web CSS already runs an explicit "accent budget" (`styles.css:1111`): dim+bordered
chips are *facts about the release* (quality); the scarce **accent blue** is *news about
the swarm* (health, cached-on-debrid). Downloaded/played are neither — they are **your
personal history with the item**, a third axis, so they get their own colour family and
never compete for the accent budget.

The palette is Tokyo Night, so the new tokens come from the same family:

- `--done: #9ece6a` (green) — **downloaded / owned**.
- `--played: #73daca` (teal) — **watched**.
- Downloading stays **accent blue** (it *is* live swarm activity) — its active cousin.

### Declutter rule

Once a row is **✓ Downloaded**, the **⚡ cached** badge is hidden — you do not care that
debrid has a copy of something you already own. Owning it silences the swarm news.

## Data model

Everything joins on **infoHash**. `TorrentResult.infoHash` == `QueueItem.id` ==
`HistoryItem.id`. Played joins on a normalised **title key** derived from the release
name (`parseRelease` → `historyKeyFor`), both already browser-safe in `src/util/`.

### Downloaded — the one new backend piece

`statusPayload()` (`src/daemon/serve.ts:198`) sends only `queue.getItems()` (live), never
`queue.getHistory()` (completed, capped 500). The browser therefore has no way to know
about a download that finished and left the queue.

**Do NOT add the history set to `StatusPayload`.** That payload is pushed over SSE on
every progress tick; 500 × 40-char hashes on every frame is ~20 KB of churn per tick.

**Add a dedicated fetch-once route** instead, mirroring `/api/saved`:

```
GET /api/library/downloaded  ->  { hashes: string[] }   // queue.getHistory() ids
```

Client behaviour:

- On search-view mount, fetch the route once, cache as a `Set<string>` (the "ever
  downloaded" set).
- Keep it fresh live **without refetching**: the existing SSE `StatusPayload.downloads`
  already reports in-flight items. When the client observes a download reach a completed
  status in an SSE frame, add its id to the set. So the set = (initial fetch) ∪ (completions
  seen this session).
- Live in-flight state (downloading / paused / failed) comes straight from the current
  SSE `downloads`, exactly as the TUI reads its live `queue` items.

This makes the web's inputs a direct parallel of the TUI's `downloadStateFor(hash,
items, history)`: `items` = current SSE downloads, `history` = the fetched+augmented set.

### Played — already on the client

`PublicStreamHistoryItem` (`wire.ts:901`) already ships over `GET /api/saved` with
`key / title / year / type / season / episode / infoHash`. No new backend or wire field
is needed for played. The browser just needs the matching logic the TUI already has.

## Shared pure modules (the layering work)

Per the codebase rule "when a second consumer appears, move the helper down rather than
copying it," two helpers move/emerge in `src/util/` so both front ends share one
implementation and cannot drift:

1. **`src/util/downloadState.ts`** — MOVE the existing `src/ui/downloadState.ts` here
   (`downloadStateFor`, `deliveryMethod`, `DownloadState`). It imports only types, so it
   is browser-bundle safe. Re-export from the old `src/ui/downloadState.ts` path so every
   current TUI caller is untouched (the same move `streamHistoryKey.ts` made).

2. **`src/util/playedState.ts`** — NEW. Extracts and generalises the logic currently
   inline in `Results.tsx:290` (`positionFor`, which only handles *series*). It answers,
   for one result, both "played?" and "up to which episode?":

   ```ts
   // Minimal structural input so both StreamHistoryItem and PublicStreamHistoryItem fit.
   type HistoryLike = {
     key: string;
     type?: "movie" | "series";
     season?: number;
     episode?: number;
   };

   // Build once per render from the whole history list.
   function playedIndex(history: readonly HistoryLike[]): PlayedIndex;

   // Look up one result by its derived title key.
   function playedStateFor(showKey: string, index: PlayedIndex):
     { played: boolean; upTo?: { season: number; episode: number } } | null;
   ```

   - **Series** → `played: true` plus `upTo` from the high-water episode (the existing
     "up to E0x" note).
   - **Film / one-off** → `played: true` when a matching movie-type entry exists; no `upTo`.
   - A miss is ordinary (`null`) — keys can be re-derived and not match, exactly as
     `streamHistoryKey.ts` documents.

## Render seams

### Web (`src/web/static/`)

Decisions live in pure, tested modules; `app.ts` is DOM wiring only (the house rule).

- **`searchModel.ts`** gains, parallel to the existing `cachedTag`:
  - `downloadTag(infoHash, liveDownloads, downloadedSet)` → the `done/downloading/…`
    marker (delegates to `src/util/downloadState.ts`).
  - `playedTag(result, playedIndex)` → the `▸ Played` / `▸ up to E05` marker
    (delegates to `src/util/playedState.ts`).
  - The **declutter rule** (hide cached when owned) is decided here, not in `app.ts`.
  - **Hide-downloaded filter**: extend `SearchView` state with a `hideDownloaded` flag;
    `visibleResults` drops owned rows when set. A `downloadedCount(results, downloadedSet)`
    helper feeds the `N downloaded` count.
- **`app.ts`**: alongside `appendCachedBadge` (`app.ts:2442`), add `appendDownloadedBadge`
  and `appendPlayedBadge` in both `renderResultCard` (poster) and the list-row renderer.
  Add the toolbar toggle + count. All "what to show" logic comes from `searchModel.ts`;
  `app.ts` only reads the returned plan and builds nodes with `createElement` + `textContent`
  (no `innerHTML` — release names are attacker-controlled).
- **`styles.css`**: new tokens `--done`, `--played`; poster `.pin` (corner ✓), `.watchbar`
  (teal foot bar, `.partial` for mid-season), owned-poster scrim; list-row leading glyph
  + faint owned tint; the toggle switch. Respect the existing reduced-motion block.

### Terminal (`src/ui/`)

- `Results.tsx`: `stateFor` already calls `downloadStateFor` — repoint the import to
  `src/util/`. Replace inline `positionFor` with `src/util/playedState.ts`. Add a
  `▸ played` marker (teal) for films/titles — today only the series "up to E0x" note is
  drawn.
- **Hide-downloaded toggle** parallels the existing `aliveOnly` toggle. Per the house
  rules this is a **new key**, so it lands in **both halves of `src/ui/keymap.ts`**
  (`HELP_GROUPS` and `footerHints`) and filters the results `useMemo`.

### No new Store field

The badges reuse existing store data (`streamHistory`, `queue`); the hide-downloaded
toggle is component-local `useState` like `aliveOnly`. So neither `makeStore`
(`scripts/render-previews-impl.tsx`) nor `makeTestStore` (`src/ui/testHarness.ts`) needs
a new entry. (Called out because a missed pair there breaks `previews`/`typecheck`.)

## Testing

No jsdom, so browser behaviour is proven through pure modules + a manual run.

- `downloadState.test.ts` — exists at `src/ui/downloadState.test.ts`; moves alongside
  the module to `src/util/downloadState.test.ts`.
- `src/util/playedState.test.ts` — NEW: series high-water, film presence, key miss,
  partial `?? []` degrade (mirrors the `Results.tsx` guard).
- `searchModel.test.ts` — `downloadTag` / `playedTag` output, declutter rule
  (cached hidden when owned), `hideDownloaded` filtering, `downloadedCount`.
- Backend: a route test for `GET /api/library/downloaded` (shape + that it reads history).
- TUI: extend `Results` tests for the played marker and the new toggle key.
- Manual: `npm run dev -- serve --web` to verify wiring; `npm run build` to prove
  `src/web/static/` pulls in no `node:*` via the moved util.
- Use the invented-title fixture cast only (Kestrel / Ashfall / Tin Rivers / Kepler /
  Harrowgate).

## Docs

- `README.md`: mention the new badges + filter; re-check the web UI limitations list is
  still true (a "no download-state on results" caveat, if present, is now false).

## Open calls (settle during implementation)

- Exact glyphs: `✓` vs `●` for owned; `▸` vs an eye for played.
- Whether "Hide downloaded" sits beside the existing filters or is its own control.
- Whether the `N downloaded` count is worth surfacing (cheap — computed client-side).

## Out of scope

- Per-release exact "played" (stream history is title-keyed; ruled out with the user).
- Any change to how downloads or playback are *recorded* — this feature only *reads*
  existing state.
- Live-updating the download badge via a new SSE field (rejected for byte churn; the
  fetch-once route + SSE-completion augmentation covers it).
