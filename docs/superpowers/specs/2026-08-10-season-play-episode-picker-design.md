# Season play → episode picker

**Date:** 2026-08-10
**Surfaces:** both front ends (web + terminal), shared logic in `src/util`

## Problem

Searching a TV season in grouped mode (e.g. `silo s03`) collapses all the
releases into one season row. Pressing **play** on that collapsed row silently
resolves to the group's single "best" member and starts playing it — with no
chance to choose an episode.

For a season made of **loose episode releases** (no season pack), the children
sort packs-first then episodes ascending, so `members[0]` is the best release of
the **lowest** episode. Confirmed live: play on collapsed `Silo S03` streamed
`Silo_S03E01_Kdo jste_.mkv` (E01) and jumped straight to the player.

Two defects combine into the bad experience:

1. **Season play ignores the episode structure.** `resultAtRow` returns
   `members[0]` (`src/util/resultGroup.ts:512`); a loose-episode season plays E01
   with no picker.
2. **Continue-watching seeding never fires on a live search.** The browser
   already has `defaultExpandedKeys` (open the season holding the next episode)
   and `nextUpRowKey` (find the next-episode row), wired at `app.ts:2559-2572`.
   But `seededExpansion` latches `true` on the **first** SSE frame, which arrives
   too sparse to have formed the multi-episode season, so it seeds nothing and
   never retries. Verified live: a fully-loaded `silo s03` search (position known,
   header shows "up to E02", `next: {season:3, episode:3}` present in
   `/api/saved`) still renders the season **collapsed** with nothing preselected.

## What already works (do not rebuild)

**Season packs are essentially already correct.** Play on a collapsed season that
contains a pack grabs the pack (`members[0]`, packs sort first), resolves it, and
— when it has multiple files — shows the file picker with the next episode
**preselected**: `streamOutcome` → `nextEpisodeIndex(files, { next })`
(`streamFlow.ts:188-200`), and `wantedEpisodeFor` (`streamFlow.ts:291`) finds the
stored position even for a pack discovered in search. This satisfies the user's
"prioritise seeing what's inside the pack (bloopers/outtakes/extras)" goal for
free, including mixed pack+episode seasons.

The gap is **only** the loose-episode-only season.

## Desired behaviour

Pressing play on a show/season never silently plays. It always leads to a
"which one do you want?" choice, then plays from there. The **flow** is identical
across cases; the **surface** fits the data (a hard constraint — pack contents
can only be listed after a network resolve, loose episodes can be listed
instantly):

| Season shape | Play does | Surface |
| --- | --- | --- |
| Loose episodes only (Silo S03) | expand the season inline, move selection to the next-up episode; **does not auto-play** | instant inline episode rows |
| Contains a pack (incl. mixed) | resolve the pack, show its file picker with next-up preselected (**unchanged**) | resolve-then-file-picker |

"Next-up" = the episode after the stored high-water mark, when it is present in
the results (`nextUpRowKey`). When there is no position, or the next episode is
not in the results, selection falls back to the **first** episode of the season.
Nothing phantom is ever selected or played.

## Design

### 1. Shared decision function (`src/util/resultGroup.ts`)

A new pure function decides what play does on a season, so both front ends stay
thin wiring (CLAUDE.md: decisions live in pure modules; move shared logic down,
never copy). It rebuilds the tree from the already-available flat `groups`
(cheap, click-time only) and returns a discriminated union:

```ts
export type SeasonPlayPlan<T> =
  // Season has a pack (best pack = members[0]); run the existing play path.
  | { kind: "resolve"; result: T }
  // Loose episodes only; expand this season and select the next-up release.
  | { kind: "reveal"; expandKey: string; select: T | null };

export function seasonPlayPlan<T extends GroupableResult>(
  groups: readonly ResultGroup<T>[],   // the flat list the front end already has
  seasonKey: string,
  positionFor?: PositionLookup,
): SeasonPlayPlan<T>;
```

Logic:
- Find the `SeasonNode` for `seasonKey` via `seasonTree(groups)`.
- **Has a pack** (`node.children.some(c => c.episode === undefined)`) →
  `{ kind: "resolve", result: node.members[0] }`.
- **Loose only** → pick the target episode group: `nextUpRowKey`-style match
  against `positionFor`, else the first (lowest) episode child. Return
  `{ kind: "reveal", expandKey: node.key, select: target.members[0] ?? null }`.
- Not a season / not found → `{ kind: "resolve", result: members[0] }` (today's
  behaviour; films and single-episode groups are untouched).

`resultAtRow` is **not** changed — `add`, `favourite` and the preview lookup keep
resolving a release from it exactly as now. Only the **play** action consults
`seasonPlayPlan`.

### 2. Web wiring (`src/web/static/app.ts`)

Where the season row's play button is wired (`resultActions` / `renderGroupRow`,
around `app.ts:2077`, `2514`), for a `kind: "season"` row call `seasonPlayPlan`:
- `resolve` → existing `play(rowForPlay(result))`.
- `reveal` → `expandedGroups.add(expandKey)`, set `selectedHash =
  select.infoHash`, re-render, and scroll/focus the selected row into view. No
  decision logic in `app.ts`.

### 3. Terminal wiring (`src/ui/components/Results.tsx`)

The stream key (`v`, `Results.tsx:729`) on a collapsed season calls the same
`seasonPlayPlan`:
- `resolve` → existing `openStream(...)` (→ `StreamFilePrompt` with preselection).
- `reveal` → add `expandKey` to the expanded set, recompute rows, move the cursor
  to the row for the selected release. Does not stream.

This keeps the two front ends behaviourally aligned through the one shared
function, as `resultAtRow`/`groupRowPlan` already are.

### 4. Auto-expand seeding fix (both front ends)

Replace the "latch on first non-empty frame" rule with "seed once we can, retry
until then":

- While not yet seeded, attempt seeding on each render.
- Set the seeded latch `true` **only when** `defaultExpandedKeys` actually
  returns a key to open (i.e. the multi-child season has formed) **or** the
  search has completed (`done`) with nothing to open.
- Once a seed is applied, latch — so re-seeding never re-opens a season the user
  has since collapsed mid-stream.

Apply the same correction to the terminal UI's equivalent seeding path if it
shares the latch. Known minor ordering caveat (documented, not fixed here): if
`/api/saved` has not loaded when the season first forms, the expansion still
happens but selection falls back to the first episode rather than next-up; in
practice saved loads before a search completes.

## Testing

- **Unit (`src/util/resultGroup.test.ts`)** for `seasonPlayPlan`:
  - pack present → `resolve` with the best pack;
  - mixed pack + episodes → `resolve` (pack prioritised);
  - loose only, position known & next episode present → `reveal` selecting next-up;
  - loose only, no position → `reveal` selecting the first episode;
  - loose only, position's next episode absent from results → `reveal` selecting
    the first episode (no phantom);
  - non-season group / film → `resolve` (unchanged).
- **Seeding fix**: a unit test over the seeding decision (extract the "should we
  latch yet?" predicate into a pure helper if it is not already testable) proving
  a sparse first frame does not latch and a later multi-child frame seeds.
- Fixtures use the invented cast from CLAUDE.md (`Harrowgate.S03…` season pack,
  `Kepler.S02E04…` episodes). No real titles.

## Out of scope

- No change to `resultAtRow`, `add`, `favourite`, or preview behaviour.
- No new backend routes or wire types — grouping stays client-side from names.
- No change to the pack file-picker itself (it already preselects next-up).
