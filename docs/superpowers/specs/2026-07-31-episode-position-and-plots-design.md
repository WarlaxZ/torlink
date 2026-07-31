# Piece B: where you are in a show, and what each episode is

Status: approved, not yet implemented.
Depends on: `2026-07-31-tv-season-tree-design.md` (Piece A), which must be merged first.

Fixture names throughout are the repo's shared cast (`CLAUDE.md`).

## The flow this serves

Stated by the repo owner, near enough verbatim: *"I'm watching a show, I'm on season 4,
maybe I can remember which episode I'm on, maybe not. I'd love to search the show, see the
last one I watched so I can pick the next one — maybe flick forward or back an episode to
check the plot and see whether I've seen it, since it might have been ages."*

Piece A made the results a tree. This makes the tree know where you are.

## What already exists — do not rebuild it

| Capability | Where |
| --- | --- |
| High-water mark per series (highest season + episode) | `StreamHistoryItem`, `src/core/streamHistory.ts` |
| "The episode to offer next" | `nextEpisode()`, `nextLabel()`, same file |
| Which file in a pack to open on | `PackTarget` / `packTargetFor`, `src/util/nextEpisodeFile.ts` |
| History reachable from the browser | `PublicStreamHistoryItem` (`src/web/wire.ts:615`) via `GET /api/saved` |
| The season tree and its expand seed | `seasonTree`, `defaultExpandedKeys`, `src/util/resultGroup.ts` |
| Preview fetching + caching | `useTitlePreview` (TUI), `GET /api/title` (browser) |

## Decisions already settled

**No per-episode watched tracking.** The store holds a high-water mark, one entry per
title, and `recordStream`'s comment explains why it deliberately is not the last-played:
rewatching S02E02 after S02E05 must leave "next" at S02E06. Marking E01–E06 as *watched*
would claim something that data cannot support once someone jumps around. We mark the
**position** — "up to S04E07", and the next one highlighted — and let the plot do the
memory work, which is what the owner described doing anyway.

**Episodes keep the series poster.** OMDb's per-episode artwork is patchy, and a preview
pane flickering between a poster and a blank frame as you arrow down a season is worse
than a stable one. Only the plot changes.

---

## Phase 1 — make the store tell the truth

Two bugfixes. **Both exist today**, independent of this feature, and both must land before
anything reads the store more heavily.

### 1a. The history key and the group key disagree

`historyKeyFor` (`src/util/streamHistoryKey.ts`) lower-cases the parsed title and stops.
`normaliseTitle` (`src/util/resultGroup.ts`) also strips a tracker prefix, a bracketed
release-group tag, trailing pack filler, and a leading article. Measured on fixtures,
**four of six shapes disagree**:

| Streamed | History key | Group show key | |
| --- | --- | --- | --- |
| `Harrowgate.S03E01.1080p.WEB-DL` | `harrowgate\|series` | `harrowgate` | ✅ |
| `[Judas] Harrowgate S03E01 (1080p)` | `[judas] harrowgate\|series` | `harrowgate` | ❌ |
| `www.uindex.org - Harrowgate.S03E01.1080p` | `www.uindex.org - harrowgate\|series` | `harrowgate` | ❌ |
| `The.Harrowgate.S03E01.1080p.WEB-DL` | `the harrowgate\|series` | `harrowgate` | ❌ |

This is already a live bug with nothing to do with Piece B: stream `[Judas] Harrowgate
S03E01`, then `Harrowgate S03E02`, and Continue-watching shows **two rows for one show**,
each with its own stale position. `streamHistoryKey.ts`'s own header predicted it — *"a
drifted key does not crash, it silently stops matching the row it is looking for."*

**Fix.** `normaliseTitle` moves into a new **`src/util/titleKey.ts`** which imports
nothing, and both `resultGroup.ts` and `streamHistoryKey.ts` import it. One definition of
"the same show".

`src/util/titleKey.ts` imports nothing on purpose, for the reason `streamHistoryKey.ts`
already states about itself: `streamHistoryKey.ts` must stay reachable from
`src/web/static/**`, which may not touch a Node builtin even transitively. Putting the
shared helper in `resultGroup.ts` instead would drag `parse-torrent-title` into every
consumer of the history key.

**Migration: none, and that is deliberate.** `removeStreamHistory` filters on the *stored*
value, so rows written under the old key keep working and merge into the new one the next
time that title is streamed — the same answer this file's header already gives for the
previous key change. A row written the old way shows as its own Continue-watching entry
until then. Say so in the header rather than silently re-keying on load.

### 1b. Playing from a season pack records no episode

`historyItemFor` derives season and episode by parsing the **torrent's** name
(`src/ui/App.tsx:1245`, `src/web/routes.ts:452`). Stream E03 out of
`Harrowgate.S03.COMPLETE.1080p` and the entry stores season 3 with `episode: undefined`,
so `nextEpisode()` returns null and there is nothing to offer.

This was a minor gap before. **Piece A made it the likely path**: a collapsed season row
resolves to its best season pack, so `play` on a season is now the natural action.

**Fix — revised after tracing, which found a better seam than this spec first assumed.**

The original plan here was a third argument on `historyItemFor`. Tracing killed it: the web
records inside `recordStreamStart`, hung off the session *resolving*, and at that moment
**the user has not picked a file yet** — the browser shows its picker afterwards. There is
no episode to pass in.

But both front ends already have a hook that fires when a player *actually launches*,
carrying the chosen filename:

| | Where |
| --- | --- |
| Terminal | `markPlayed(favId, filename)`, `src/ui/App.tsx:788` |
| Browser | the `"watched"` action, posted from `src/web/static/app.ts:734` |

That is the right seam: it is after the pick, it already exists on both surfaces, and its
own comment says it is "called only once a player actually launches, so a failed/cancelled
stream never earns a ✓" — precisely the bar a watch position wants.

So `historyItemFor` is left alone, and `src/core/streamHistory.ts` gains:

    recordPlayedFile(current, infoHash, filename): StreamHistoryItem[]

which finds the entry by info hash, parses the **filename** for season/episode, and
advances the mark only when the file names something later than what is stored — the same
high-water rule `recordStream` already applies, for the same reason.

It **returns the same array reference when nothing changed**, matching `markWatched`
(`src/util/favouriteList.ts:31`), whose callers use exactly that as the write gate. This
fires on every player launch, so churning the history file on every re-watch is the thing
to avoid.

---

## Phase 2 — the landing

`defaultExpandedKeys` gains a lookup, in the idiom `reportsHealthLookup(sources)` already
establishes for `filterResults` — a function rather than a data structure, so
`resultGroup.ts` stays front-end-agnostic and unit-testable:

    defaultExpandedKeys(groups, positionFor?: (showKey: string) => EpisodeRef | null): string[]

**Rule.** If any season node belongs to a show with a recorded position, open the season
containing the **next** episode. Otherwise fall back to Piece A's highest-ranked season.
Piece A's spec promised exactly this degradation, so its existing tests stay valid with
the argument omitted.

Additionally the **next-up episode row becomes the initially selected row** — the TUI's
cursor, the browser's selection. That is the "see the last one I watched so I can pick the
next one" half of the request; expansion alone still leaves the user hunting.

**When the next episode is not in the results**, selection falls back to the season row and
nothing is marked. `nextEpisode()` is a suggestion and has never asked a tracker whether
the episode exists, so the results are the authority on what can be selected. A season that
has aired up to E07 and returns no E08 must not grow a phantom row.

**Seeded once per result set**, exactly as Piece A's seed is, and for the same reason: a
running rule fights the user as sources stream in. The TUI's seeding effect must stay
declared **below** the effect that clears `expanded` on a query change — effects run in
declaration order, and Piece A's first attempt was silently wiped by getting this wrong.
The browser's seed must run **before** the row plan is built, or the first frame renders
collapsed.

**The join.** Both sides derive the show key through `titleKey.ts` after Phase 1, so the
lookup is keyed on the normalised show title. The browser builds it from `continueWatching`
in `GET /api/saved`, which already carries `season`, `episode` and `next`.

---

## Phase 3 — the marks

- A season row for a show with a position says so: `Harrowgate S03 · up to E07`.
- The next-up episode row is marked — calm, in the theme's existing vocabulary, not a
  colour that already means something else. `COLOR.accent` is spoken for by "this source
  reports health" and "this is cached" in the browser rows; check `src/ui/theme.ts` and
  `styles.css` before choosing, and reuse rather than inventing.
- Both front ends, same change.

**The decision lives in the pure module** — which row is "next", what the label reads —
next to `groupHeading`. The renderers only draw it. `app.ts` is DOM wiring; a conditional
there deciding *what to show* is the thing review has caught twice.

A show with a position but no matching season in the results gets no mark. Nothing is
claimed that the results cannot show.

---

## Phase 4 — per-episode plots

Largest phase, the only one touching an external API, and **shippable on its own**.

- `src/recc/omdb.ts`: the by-name lookup gains optional `season`/`episode`, sent as
  `&Season=`/`&Episode=`. The existing `request()` core already takes a `URLSearchParams`,
  so this is a params change, not a new code path.
- `GET /api/title` (`src/web/routes.ts:1616` → `titleMeta`) gains the two query params and
  passes them through.
- `MetaQuery`'s `{ by: "name" }` variant (`src/ui/hooks/useTitlePreview.ts`) carries them.

**The trap, and the thing to write a test for first: `cacheKey` must include season and
episode.** It is currently the identity of "the same title", which is exactly what makes
quality variants share one lookup. Leave it alone and every episode of a season renders
the first episode's plot — a bug that looks like OMDb being wrong rather than like a cache
key being too coarse.

**A missing episode is not an error.** OMDb answers `Response: "False"` for an episode it
does not have; that must arrive as `plot: null` through the existing
`undefined = loading, null = none available` contract both preview panes already speak,
and render as "no plot available". The pane must not show an error state, and one missing
episode must not blank the poster.

---

## Testing

Pure modules get real tests; there is no jsdom, deliberately.

- `src/util/titleKey.test.ts` — the four disagreeing shapes above now agree, asserted as
  `historyKeyFor` against the group's show key rather than against a hardcoded string, so
  the test fails if either side drifts again.
- `src/core/streamHistory.test.ts` — `historyItemFor` with an `opened` episode beats the
  torrent name; without one, behaviour is unchanged.
- `src/util/resultGroup.test.ts` — `defaultExpandedKeys` opens the season holding the next
  episode; falls back to highest-ranked when the lookup returns null; unchanged when the
  argument is omitted.
- Phase 3's label helper — a season with a position, a season without, a show whose
  position names a season not in the results.
- Phase 4 — the cache key differs per episode; a `Response: "False"` becomes `null`, not a
  throw.
- `Results.test.tsx` — the next-up row is selected on mount.
- Browser wiring is verified by running it: `npm run dev -- serve --web`.

Gates: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`. One known
pre-existing lint warning (`react-hooks/exhaustive-deps`, `src/ui/App.tsx`) — leave it.

## Risks

- **Phase 1a changes stored keys.** Existing Continue-watching rows keep their old keys
  until re-streamed. Intended, precedented, and must be in the header comment — not a
  surprise for whoever reads the file next.
- **OMDb quota.** Episode lookups are per-selection and lazy, so arrowing through a season
  costs one call per episode visited, cached thereafter. Worth stating; not worth
  pre-fetching a whole season for.
- **`nextEpisode()` is a suggestion, never a claim** the episode exists — its own comment
  says so. A "next up" mark on an episode with no release must therefore be drawn from the
  results, not from history alone, or the UI promises something it cannot play.

## Out of scope

- Per-episode watched/unwatched state (see Decisions above).
- The TUI's `g` grouping toggle not persisting across runs, unlike the browser's. Noted in
  Piece A, still true, still its own change.
