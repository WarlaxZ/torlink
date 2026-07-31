# The season tree: results that match the shape of a show

Status: approved, not yet implemented.
Scope: **Piece A (structure) only.** Piece B is sketched at the end and is a separate spec.

Fixture names throughout are the repo's shared cast (`CLAUDE.md`), not the real
show the reports came from.

## The problem

A search for a show's season returns a readable set of rows now that group headings
name the season and episode — `Harrowgate S03`, `Harrowgate S03E01` — but the rows are
still **flat and ordered by seeders**, so a season pack lands in the middle of its own
episodes:

    ▸ Harrowgate S03E04     9 releases
    ▸ Harrowgate S03E08     9 releases
    ▸ Harrowgate S03E05     5 releases
    ▸ Harrowgate S03       17 releases      <- the whole season, fourth
    ▸ Harrowgate S03E06     7 releases

A broad search for the show alone is worse: about forty sibling rows covering five
seasons, in seeder order, with no sense that seasons contain episodes.

The data is a tree — show → season → episode → release — and the list is flat. Grouping
already collapsed release→episode. The remaining noise is that **seasons and episodes of
one show are siblings**. Reordering a flat list treats the symptom; matching the tree
removes it.

## What already exists

Most of the machinery is present and merely unwired. Do not rebuild any of it:

| Capability | Where |
| --- | --- |
| High-water mark per series (highest season + episode watched) | `src/core/streamHistory.ts` |
| "The episode to offer next" | `nextEpisode()`, `src/core/streamHistory.ts` |
| Opening a specific episode's file inside a season pack | `PackTarget` / `packTargetFor`, `src/util/nextEpisodeFile.ts` |
| Per-episode plot | OMDb accepts `&Season=&Episode=`; `src/recc/omdb.ts` currently sends only `t`/`y`/`type` |
| Grouping on/off, defaulting on | `parseGrouping()` (`searchModel.ts`), `g` (`Results.tsx`) |

## The toggle

**No new control.** The existing `group` toggle already defaults on — `parseGrouping`
treats anything but the explicit opt-out as ON, and persists in `localStorage`. Off
still means every release as its own row, which is the manual, see-everything view.
The tree is simply what "grouped" *means* for a series, so it inherits the switch.

Known asymmetry, **out of scope here**: the browser remembers the preference across
sessions, the TUI's `g` is `useState(true)` and resets each run. Worth persisting to
config for parity, as its own change.

## Design

### Row model

`groupResults` keeps its current behaviour unchanged — it produces episode groups, pack
groups and film groups, and its existing tests must not move. A **second pass** folds a
series' groups under a season node.

Rows gain a `depth`, and `GroupRow` gains a `season` variant:

    ▾ Harrowgate S03                    47 releases     depth 0
      ▸ S03 pack                        17 releases     depth 1
      ▸ S03E01                           4 releases     depth 1
      ▸ S03E02                           5 releases     depth 1
          Harrowgate.S03E02.1080p.WEB-DL                depth 2

Expansion continues to use the single `expanded: ReadonlySet<string>`. Season keys carry
no episode part (`harrowgate|series|s3`), so they cannot collide with the episode keys
(`harrowgate|series|s3|e1`) or the pack key (`harrowgate|series|s3|pack`).

Films are untouched: a film group has no season node above it and renders exactly as it
does today.

### What does not get a season node

Two series shapes have no single season to sit under, and both stay **top-level rows**
rather than being forced into one:

- A **multi-season span pack** — key `harrowgate|series|s1-3|pack`, heading
  `Harrowgate S01-S03`. Folding it under S01 would claim it is a season-1 release.
- A **series release with no season at all** — key `harrowgate|series|s|pack`, the
  "complete series" shape. There is nothing honest to file it under.

Both already key distinctly today, so this is a rule about the fold, not about keys.

### Ordering

- **Between shows** — unchanged. A show's block sits where its best member sits under
  the current sort. This preserves the promise in `resultGroup.ts` that order is
  "groups by their first member", which every existing sort depends on.
- **Seasons within a show** — **descending**. S05, S04, S03: newest at the top.
- **Within a season** — **packs first, then episodes ascending**. Packs first is
  load-bearing, not cosmetic: `resultAtRow` resolves a collapsed row to `members[0]`, so
  packs-first makes `play`/`add` on a collapsed `Harrowgate S03` act on the best season
  pack, which is the honest reading of that row. Where a season has no pack it falls
  through to E01's best release.
- **Within an episode** — members as given. Unchanged.

### Headings need a depth-aware form

`groupHeading` returns the full `Harrowgate S03E01`. Nested under a `Harrowgate S03`
season row that is correct but noisy — the show's name repeats at every level. A season's
children want the short form (`S03E01`, `S03 pack`), so `groupHeading` gains a variant
that omits the parts the parent row already states. Wiring the existing function
unchanged is the easy mistake here, and it reads badly rather than failing.

### The sort control

The sort orders **releases inside a group**, and orders **unrelated results against each
other**. A series' internal structure is structural and not re-sortable — "order these
episodes by seeders" is not a thing anyone wants. Write this down in the module header;
it is the kind of rule that gets "fixed" by a later reader.

### Expansion defaults

**The highest-ranked season node in the plan starts expanded. Every other node starts
collapsed.**

Rationale: without something like this, a search for one season collapses to a single
line, which reads as the list having failed.

An earlier draft said "the season node that is the *only* top-level row expands", and it
was wrong on exactly the query that motivated this work. A real search for one season of
one show also returned a *different* show's season 4, plus two unrelated episodes whose
names merely contained a matching word. There were four top-level rows, so "only" was
false and the season would have stayed shut. **The test fixture must therefore include
those strays** — a clean single-season fixture passes while the real behaviour is wrong.
`scratchpad/names.txt` from the investigation has the real shape to mirror, renamed to
the cast.

Highest-ranked needs no counting, cannot be defeated by strays, and degrades cleanly into
Piece B, where "the season you are part-way through" takes over as the thing that opens.

## Where the code lands

- **`src/util/resultGroup.ts`** — tree building and row planning. Pure, unit-tested, and
  shared: this is the module both front ends already render from, which is the whole
  reason it exists.
- **`src/ui/components/Results.tsx`** — depth indent in the name cell, nothing more. The
  `space` toggle already keys off the row's key and needs no change for a third level.
- **`src/web/static/app.ts`** — depth indent as a class, nothing more. No new decisions:
  `app.ts` is DOM wiring, per `CLAUDE.md`.

Both surfaces in the same change, per the repo's two-front-ends rule.

## Testing

In `src/util/resultGroup.test.ts` (pure, so it gets real tests):

- A season node is built over a show's packs and episodes, with the right key.
- Seasons come back descending; episodes within a season ascending; packs before episodes.
- `resultAtRow` on a collapsed season resolves to the **best pack**, and to E01's best
  release when the season has no pack.
- A film's rows are unchanged — same keys, same shape, same order as today.
- The highest-ranked season node starts expanded **in a fixture that also contains a
  second show's season and two unrelated episodes**, not a clean one-season fixture.
- A multi-season span pack and a seasonless "complete series" pack each stay top-level
  and are not folded under a season node.

In `src/ui/components/Results.test.tsx`:

- A season row renders with its episodes indented beneath it.
- Cursor stability (`selRef`) survives the deeper nesting and larger row count. There is
  an existing test for a later frame adding a result while a group is open; extend it
  rather than writing a parallel one.

Gates before done, per `CLAUDE.md`: `npm test`, `npm run typecheck`, `npm run lint`,
`npm run build`. One known pre-existing lint warning (`react-hooks/exhaustive-deps`,
`src/ui/App.tsx`) — leave it.

## Risks

- **`resultAtRow` semantics.** The comment at `resultGroup.ts` states a collapsed header
  resolves to its first member because "under the current sort, that is its best one".
  A season node breaks that reasoning — its first member is the best *pack*, chosen
  structurally rather than by sort. Update the comment to say so, or the next reader
  will treat packs-first as an accident and sort it away.
- **Depth eats the name column in the terminal.** `Results.tsx:779-782` records that at
  80 columns the list has about 61 to spend and the name is already truncated. A
  depth-2 release row spends more of that on indent. Not solved here — but look at the
  80-column case rather than discovering it later.
- **Row-count growth.** Three levels expanded on a broad search is a lot of rows. The
  TUI windows its list; confirm the window maths still holds at depth.
- **Season keys must not collide** with pack or episode keys. Covered by test, but it is
  the failure that would silently merge a whole season into one bucket.

## Out of scope — Piece B (memory), a later spec

Ships after A, and is what makes the browse-a-show flow work end to end:

- Watched episodes marked in the results list, read from `streamHistory`.
- The next unwatched episode highlighted, and its season auto-expanded to it.
- The preview pane showing **that episode's** plot when the cursor is on an episode row,
  via OMDb `&Season=&Episode=` — which turns "flick forward and back to see what I've
  already watched" into ordinary arrow keys.

A is a prerequisite: the marks and the landing position need somewhere to land.

## Rejected

**Hide season packs; episodes only, sourced from a pack when no standalone release
exists.** The good instinct — the season is the unit people think in — is kept by the
season node. Rejected because it removes the ability to grab a whole season, which is a
stated use, and because sourcing one episode from a large multi-file pack needs a
file-list resolve before you know the file is even there. Making that the primary path
trades a healthy single-episode torrent for a slower, less certain one.

**Reorder the flat list only** (packs first, episodes ascending, no nesting). Half the
work, but a broad show search stays a forty-row wall, so it does not deliver the thing
that was actually asked for.
