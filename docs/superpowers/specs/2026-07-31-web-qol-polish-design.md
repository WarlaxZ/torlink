# Result grouping, a preview you can actually see, and the polish either front end was missing

Date: 2026-07-31

## Why

Three complaints, one of which turned out to be three bugs.

**The preview pane is unreachable.** Select a row a screen or two down the results list and the
poster/plot pane loads correctly and then sits above the top of the window. Measured, with a row
selected about 1400px down a Movies browse:

```
previewTitle:   "Toy Story 5"   ← the lookup worked
previewTop:     -1402           ← 1402px above the viewport
previewVisible: false
```

`#preview` (`src/web/static/index.html:143`) is an ordinary grid item in `.split`
(`src/web/static/styles.css:487`) inside a single document-level scroll. Nothing pins it. Below the
`46rem` breakpoint it is worse: the split collapses to one column, so the preview renders *after*
every row — on a 210-result browse that is roughly 25,000px below the fold.

**Duplicate titles.** There is no title grouping in either front end. The only dedupe is by info
hash (`src/core/search.ts:46`), so two different uploads of one film are two rows by design. A live
Movies browse shows 210 rows with `Disclosure Day` ×4, `Obsession` ×3, `Project Hail Mary` ×2; a
search for one popular film returned **129 results that are 22 actual things**. Title grouping is
already written down as future work in
`docs/superpowers/specs/2026-07-30-quality-preference-auto-pick-design.md:31` ("a title-grouped tree
list over the browse feeds"). This spec is that work.

**Focus dies on every click.** `selectResult` calls `renderResults()`, which does
`resultsList.replaceChildren(...)` (`src/web/static/app.ts:1426`), destroying the button that was
just clicked. Measured `focusAfterClick: "BODY."`. The results list is unusable by keyboard, and it
blocks any arrow-key navigation.

## What this is not

Not a fuzzy title matcher. Not virtualisation (210 rows over a 25,000px document renders fine, and
the poster `IntersectionObserver` depends on that document scroll). Not a settings page.

## 1. `src/util/resultGroup.ts` — the grouping engine

A new file next to `resultSort.ts` and `resultFilter.ts`, the seam both front ends already import
from. New file rather than an addition to `resultSort.ts`, because that file's header states it
"IMPORTS NOTHING, deliberately" and this module needs `./release`. That import is browser-safe and
already in the web bundle — `src/web/static/streamFlow.ts:37` imports `parseRelease`, and
`tsup.web.config.ts:59` carries `noExternal: [/^parse-torrent-title$/]` for exactly that reason.

Structural input type and a generic return, so `TorrentResult` and `PublicSearchResult` both fit
without either front end's types leaking in — the convention `resultSort.ts` and `resultFilter.ts`
already follow:

```ts
export interface GroupableResult { name: string }
export interface ResultGroup<T> { key: string; title: string; year?: number; members: T[] }
export function groupResults<T extends GroupableResult>(
  list: readonly T[], hint?: OmdbType,
): ResultGroup<T>[]
```

### The key

`parseRelease().key` is `title|year|type`, which must **not** be reused: for any series it is
`kepler||series`, collapsing every episode of every season into one bucket. The key is built here:

| Release | Key |
| --- | --- |
| `Kestrel.2010.1080p.BluRay.x264` | `kestrel\|2010\|movie` |
| `Ashfall.1999.1080p` | `ashfall\|1999\|movie` |
| `Kepler.S02E04.1080p.WEB-DL` | `kepler\|series\|s2\|e4` |
| `Harrowgate.S03.1080p.WEB-DL` | `harrowgate\|series\|s3\|pack` |
| no year, no type (`Super Mario Galaxy`) | `super mario galaxy\|\|` |

`Kepler.S02E04` and `Harrowgate.S03` are the fixtures that exist to catch precisely this
episode-versus-season-pack confusion; both belong in the tests.

### Title normalisation, in this order

1. Strip a leading tracker prefix — `www.uindex.org    -    The Super Mario…`.
2. Strip a container extension — `.mkv`, `.mp4`, `.avi`, `.7z`, `.zip`, `.iso`.
3. Lowercase.
4. Punctuation → spaces, collapse runs of whitespace.
5. **Then** drop a leading article (`the`, `a`, `an`).

Step 5 must come after step 4. Built the other way round in a scratch probe, a Cyrillic-wrapped
name (`супер марио … (the super mario galaxy movie)`) kept its `the` once the Cyrillic was stripped
and split off into its own group.

`parseRelease` **returns null** on some real names — a Korean-titled release in live data does —
so the null branch keys on the normalised raw name and the group is effectively a group of one.

### Measured effect

129 live results for one film:

| Key | Groups | Largest |
| --- | --- | --- |
| raw `parseRelease().key` | 30 | 85 (5 stranded on a tracker prefix) |
| with normalisation | 22 | 92 |

The remaining tail is foreign-language titles (`o filme` ×5, `il film` ×5, `la película` ×7) and the
actual Wii games. **Deliberately not chased.** Merging across languages is a judgement call, and a
fuzzy key that wrongly merges two distinct films is worse than one that leaves five rows —
`Obsession (2025)` and `Obsession (2026)` are two different films and must stay apart, which the
year component guarantees. 129 rows → ~10 visible entries is the win.

### Ordering

Grouping runs **after** filter and sort. Members keep the order they arrived in; groups order by
their best (first) member. Every existing sort therefore still means what it means. A group of one
renders as a plain row — no disclosure arrow, no "1 release" noise.

## 2. Rendering groups in both front ends

A user-facing feature, so it lands in both surfaces in this change. The terminal can express a
collapsed list, so no exception applies.

### Web

`searchModel.ts` gains `visibleGroups()` and a flat `rowPlan()` returning
`{ kind: "group" | "release", … }` items. `app.ts` stays pure DOM wiring — a conditional there
deciding *what to show* is the thing CLAUDE.md records being caught in review twice.

Group header row: poster thumbnail, clean title + year, quality badges, best resolution, max
seeders, `12 releases`, and a disclosure button carrying `aria-expanded`. Every node is
`createElement` + `textContent`; there is no `innerHTML` path anywhere in `src/web/static/`, because
release names are strangers' strings.

Actions on a collapsed group act on its **first member in the current sort order**. No new picking
logic is invented, and nothing new is imported.

A group header is also a *better* preview target than a release row: its title is the normalised
one, so the OMDb lookup gets a clean string instead of a 70-character release name.

### Terminal

Follow `src/ui/components/Downloads.tsx:113-134`, this repo's existing answer to a grouped list:
flatten to one cursor index over `[header, …rows, header, …rows]`, derive which region the cursor is
in, single `wrapStep` over the total. There is no collapsible/tree pattern anywhere in `src/ui` to
copy — this is the closest analogue and it is a real one.

- Expand/collapse on **`g`** and **`c`**. Both verified free against `Results.tsx`'s local
  `useInput` and `App.tsx`'s global one (`App.tsx:2146-2310`). `→`/`←` are pane navigation
  (`App.tsx:2288-2295`) and are therefore out.
- Both halves of `src/ui/keymap.ts`: an entry in `HELP_GROUPS`' "Search" group, and one in the
  results fallthrough of `footerHints` (`keymap.ts:229-244`). That footer row already measures 115
  cols bare and **131 with Real-Debrid configured**, so it is truncated at 80 today — the new hint
  goes early in the array or it is invisible.
- Expansion state stays **local `useState` in `Results.tsx`**, matching `previewOn`, `aliveOnly`,
  `textFilter`, `mode` and `cursor`. No new `Store` field, so neither `makeStore`
  (`scripts/render-previews-impl.tsx`) nor `makeTestStore` (`src/ui/testHarness.ts`) moves.
- **`selRef` is currently written and never read** (`Results.tsx:265`, `:287`, `:389`), so its
  comment about holding the cursor while streamed-in sources reshuffle the list is a false promise.
  Grouping reshuffles rows, so make it real: anchor the cursor by info hash.

### The toggle

Session-local in each surface, **default on**. This matches how sort already behaves — the TUI
persists `config.sort`, the web never writes it (verified: no `saveConfig` call in
`src/web/routes.ts` touches `sort`). No new config field, no new route, no read-modify-write
question.

Web: a `group` control beside `layout`. Terminal: the `g`/`c` keys plus a header indicator.

## 3. The preview pane

**Wide (> 46rem):** `position: sticky`, `top` derived from the sticky toolbar height (§4), with
`max-height: calc(100vh - top - 1rem)` and its own internal scroll for a long plot.

**Narrow (≤ 46rem):** the preview and the list share a single grid area, and the preview pins to the
*bottom* of the viewport as a compact bar — small poster, title, two-line plot clamp, close button.
The now-playing-bar pattern.

Pinning it to the top instead does not work, and the reason is worth writing down: a sticky item can
only move within its own grid area. Given its own single-column row above a 25,000px list, the
preview is still 25,000px away from a selection at the bottom. Sharing the list's grid area is what
gives the sticky element something to travel through.

**`#results` must not become its own scroll container.** The poster `IntersectionObserver`
(`src/web/static/app.ts:1195-1208`) uses the default viewport root; a new scrolling ancestor makes
it silently stop firing and posters simply never load. Keep the single document scroll.

## 4. Sticky toolbar, focus, keyboard

`#tabs` and `.controls` are wrapped into one sticky element alongside the header — about 140px of a
774px viewport, measured. The search form stays unpinned (100px on its own is too much to spend);
`/` focuses it from anywhere instead. The preview's sticky `top` derives from the toolbar height.

**Focus:** after every list rebuild, focus returns to the row matching `selectedHash` when focus was
inside `#results` beforehand. The *decision* — which row key should receive focus — goes in a pure
module; `app.ts` performs the `.focus()` call. Check the queue pane for the same bug: it rebuilds
four times a second.

**Keyboard:** roving tabindex, `↑`/`↓` to move, `Enter` to select, and the disclosure button's
native activation to expand a group. Framed as listbox accessibility, not as keybindings — the
browser's vocabulary is buttons, and this is the standard behaviour a list of options already owes a
keyboard user.

## 5. Quality badges, both surfaces

`resolution` plus `hasFeature()` from `src/util/releasePick.ts`, labelled with `FEATURES[id].label`
(`releasePick.ts:48-66`), so a badge on a row means exactly what the user's `P` quality preference
means. `releasePick.ts` imports only `./release` and is already reached from the web bundle via
`src/web/static/pickModel.ts:9` — no new shared module is needed for the labels.

Resolution comparisons go through `resolutionHeight()` (`releasePick.ts:25`), never string equality;
the parser's vocabulary includes `1080i` and `4k` and that file's own comment says so.

Terminal: copy the `cached` badge pattern (`Results.tsx:680-684`) — a `flexShrink={0} marginLeft={1}`
box between Name and the stats columns. The header row at `Results.tsx:623-651` must stay in sync
with the columns.

## 6. Width and back-to-top

**Width.** `body`'s `max-width: 60rem` (`styles.css:31-40`) leaves roughly a third of a 1440px
screen empty, which grouping makes more noticeable — a group header carries more per row than a
release row does. Raise the cap to `78rem`, and let the extra room go to the results column plus a
preview that widens from `16rem` to `20rem` above `76rem`. Cards, prose and the search form keep a
comfortable measure rather than stretching to fill.

**Back to top.** A `position: fixed` control appearing after roughly two viewports of scroll. On
narrow widths it sits *above* the compact preview bar so the two never overlap.

## Testing

No jsdom, deliberately, so:

- `resultGroup.test.ts` is the substantial one and is written first, proving failure before the
  implementation. It must cover: both TV fixtures keying distinctly (`kepler|series|s2|e4` vs
  `harrowgate|series|s3|pack`); `Obsession (2025)` and `Obsession (2026)` staying apart; the tracker
  prefix and container extension being stripped; the article-after-punctuation ordering; a null
  `parseRelease` degrading to a group of one; sort order surviving grouping.
- `searchModel.test.ts` covers `visibleGroups()` and `rowPlan()`; the focus decision gets its own
  pure module and test.
- Terminal side via the existing Ink test harness.
- Wiring is verified by running it: `npm run dev -- serve --web`, wide and at phone width.
- `npm run build` is the only check that `src/web/static/` imports no `node:*`.

Fixtures name invented titles only — the cast in CLAUDE.md. The `preview/web-*.jpg` screenshots are
the documented exception and are not touched by this work.

## Gates

`npm test`, `npm run typecheck`, `npm run lint`, `npm run build`. Baseline before this work: 132
files, 2025 tests, green. The known `react-hooks/exhaustive-deps` warning in `src/ui/App.tsx`
predates this and stays.

README: the browser UI's "What the browser can't do yet" list must still be true afterwards, and
grouping plus the badges are worth a line in the browser-interface section.
