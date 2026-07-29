# Web UI: saved lists, artwork on the browse tabs, and a tab click that loads

The browser UI shipped with search, For You, streaming and a queue. Three gaps
remain against the terminal UI, and this design closes all three.

1. **The two saved lists are missing.** The TUI has `watchlist` (saved search
   queries, `config.savedSearches`) and `library` (favourited torrents,
   `config.favourites`, each remembering which episodes were watched). Neither is
   reachable from a browser.
2. **A category tab does nothing until you press Enter.** Opening the page and
   clicking "Movies" leaves an empty pane; the browse only starts once the search
   box is submitted.
3. **Only For You has artwork.** The Movies and TV result lists show text rows,
   while the feed next to them is a wall of posters.

Everything below degrades to today's behaviour when OMDb, Real-Debrid or reccd is
unconfigured. That is a requirement, not a nicety: the common install has no OMDb
key.

## Vocabulary

The TUI's names are load-bearing and the web adopts them unchanged, because both
clients read and write the same `config.json`:

| Name | Config key | Contents |
| --- | --- | --- |
| watchlist | `savedSearches` | search query strings, most-recent first, capped at 50 |
| library | `favourites` | `FavouriteItem` — info hash, name, magnet, size, source, `watched[]` — capped at 100 |

A "watchlist" that meant *titles I intend to watch* was considered and rejected:
it is a new data model with no TUI counterpart, so the two clients would show
different lists under the same word.

## Architecture

### Shared list helpers move to `src/util/`

`src/ui/favourites.ts` → `src/util/favouriteList.ts` and
`src/ui/savedSearches.ts` → `src/util/savedSearchList.ts`, tests alongside them,
TUI imports updated.

This follows the precedent set when the web pane needed the TUI's sort and
filter: `src/ui/sort.ts` and `src/ui/filter.ts` became `src/util/resultSort.ts`
and `src/util/resultFilter.ts` rather than being reimplemented in the browser
bundle. `searchModel.ts`'s own header records why — a second copy of the toggle
rule and the 100/50 caps is the copy-then-drift bug this codebase has hit four
times (uploadSpeed, the byte formatter, the progress unit, the API path table).

No behaviour changes in the move. It is a rename plus import updates.

### A config write seam, and read-modify-write on every mutation

`WebDeps` gains:

```ts
saveConfigImpl?: (config: Config) => Promise<void>;
```

resolved as `deps.saveConfigImpl ?? saveConfig`, in the same style as
`loadConfigImpl` and `getPosterImpl`. Without it, `routes.test.ts` would write
the developer's real `~/.config/torlnk/config.json`.

**Every mutating route loads the config, applies the change, and saves — per
request.** It must never hold a config snapshot between requests and write that
back. `serializeWrites()` in `config.ts` serializes writes *within one process*,
and `torlnk serve --web` is a separate process from any running TUI. Writing back
a stale whole-file snapshot would silently revert whatever the TUI changed
meanwhile: the Real-Debrid token, the sort, `disabledSources`.

Last-writer-wins on the specific list being edited is acceptable — it is what the
TUI already does to itself. Last-writer-wins on the whole file from a stale read
is not.

## Routes

Three routes, all placed after the `isAuthorized(token, authHeader)` gate in
`handleWebApi`. None delegate to `handleApi`, so that gate is the only thing
between an anonymous caller and the user's saved lists.

### `GET /api/saved`

```ts
interface SavedResponse {
  watchlist: string[];
  library: PublicFavourite[];
}
```

One round trip for the whole pane, because the pane shows both lists at once.

```ts
interface PublicFavourite {
  id: string;          // info hash
  name: string;
  sizeBytes?: number;
  source?: string;
  addedAt: number;
  watched: number;     // a COUNT, not the filenames
}
```

The magnet is deliberately absent. The page never needs it — playing a favourite
goes through `POST /api/stream { infoHash, name }`, which rebuilds the magnet
server-side. `watched` is a count because the pane renders "3 watched"; shipping
episode filenames would be handing the browser strings from inside a stranger's
torrent for no purpose.

### `POST /api/watchlist`

```ts
interface WatchlistRequest {
  query: string;
  action: "toggle" | "remove";
}
interface WatchlistResponse {
  saved: boolean;      // is the query in the list now
  watchlist: string[];
}
```

`toggle` mirrors the TUI's `w` key. `remove` is idempotent, for the ✕ in the
list — a toggle there would re-add a row the user just deleted if the click
double-fired.

Empty or whitespace-only `query` is a 400. `toggleSavedSearches` already returns
the list unchanged for a blank query, but answering 200 to a request that did
nothing tells the browser a lie about what happened.

### `POST /api/library`

```ts
interface LibraryRequest {
  infoHash: string;
  name: string;
  sizeBytes?: number;
  source?: string;
  action: "toggle" | "remove" | "watched";
  filename?: string;   // required for "watched"
}
interface LibraryResponse {
  favourited: boolean;
  library: PublicFavourite[];
}
```

On an add, the server builds the stored magnet with
`buildMagnet(infoHash, name)`. This is the point the design turns on: a
`PublicSearchResult` deliberately carries no magnet (it would be ~6MB a search),
and `config.favourites` requires a non-empty one — `isFavouriteItem` rejects an
entry without it. `buildMagnet` is the same reconstruction `POST /api/stream`
already performs for a hash-only play, so a favourite created from a search row
still plays correctly weeks later.

`action: "watched"` records an episode filename against a favourite, mirroring
the TUI's `markWatchedInFavourite`. It reuses `markWatched`, which returns the
same array reference when nothing changed (id absent, or already recorded); the
route skips the disk write in that case rather than churning the file.

**reccd parity.** A `toggle` posts a `favourited` or `unfavourited` event to
reccd, fire-and-forget with `.catch(() => {})`, exactly as `reccEvent` does. The
TUI's `toggleFavourite` posts this event; without it a browser favourite does not
teach the taste profile and For You diverges between the two clients. As in
`reccEvent`, the `ts` is the server's clock and `source` is `"torlink"` — a
browser clock years out of date poisons a recommender's recency weighting for
good. An unconfigured reccd makes this a no-op and is not an error.

All new types live in `src/web/wire.ts`. That is the single wire contract;
`searchModel.ts` re-exports from it specifically so nobody redeclares a
producer's payload shape inside the browser bundle.

## The `saved` pane

A fourth nav tab, `saved`, holding two sections:

```
saved  ▸ watchlist        ▸ library
       ┌──────────────┐    ┌────────────────────────┐
       │ dune part two│    │ Severance.S02.1080p ★  │
       │ the bear s03 │    │   3 watched · 24 GB    │
       └──────────────┘    └────────────────────────┘
```

`index.html` currently carries a comment reading "Search / For You / Queue, the
three things this app is", explaining why the nav is buttons rather than routes.
This change falsifies the count, so that comment is rewritten in the same diff.
The reasoning it records (one page, three panes, no bookmarkable mid-search URL)
still holds and is preserved.

Folding both lists into one pane rather than adding two top-level tabs is
deliberate: five tabs across the top of a phone is where this nav stops working.

Affordances:

- ★ on every search result row, its label reflecting whether the hit is already
  in the library.
- "save search" beside the search box, enabled only when the box holds a query.
- ✕ on rows in both lists.
- A watchlist row puts its query in the box, switches to the search pane, and
  runs it — the same thing the TUI's Enter does there.
- A library row plays (through the existing `play()`), and can be removed.

Decisions live in a new pure `src/web/static/savedModel.ts`: the request bodies,
the empty-state and status copy, and the optimistic-then-reconcile state (a ★
flips immediately, and the server's returned list is authoritative). There is no
jsdom in this repo, so pure modules are how browser logic gets tested here, and
`app.ts`'s own header commits it to being wiring only.

Every node is built with `createElement` and filled with `textContent`. A
favourite's name is a release name written by a stranger on a public tracker, so
an `innerHTML` path in this pane is stored XSS — the same rule, and the same
reason, as every other list on the page.

## Immediate browse on a category tab

`searchModel.ts` gains a pure decision:

```ts
export function groupChangePlan(view: SearchView, group: string): "ignore" | "run";
```

`"ignore"` when the group is already selected; `"run"` otherwise. Today's
`if (view.mode === "idle") renderResults()` branch is what leaves the pane empty
— clicking a tab before submitting anything only re-renders nothing.

`app.ts` then calls `startSearch(queryInput.value)` — **not** `startSearch("")`.
`startSearch` assigns its trimmed query back into `queryInput.value`, so passing
the empty string would wipe text the user had typed but not yet submitted.
Passing the box browses when it is blank and searches when it is not, which is
strictly better and is the case manual testing misses (the box is blank when you
click the tab to check the fix).

## Artwork on the browse tabs

### Knowing there is no key, before spending lookups on finding out

`sourcesResponse` gains `omdbConfigured: boolean`, computed as
`resolveOmdbApiKey(config) !== ""` — the resolver, not `config.omdbApiKey`, so a
`TORLINK_OMDB_KEY` env var counts and the browser agrees with the terminal about
whether artwork is available. This is exactly how the neighbouring
`debridConfigured` is derived. A boolean, never the key.

This is what graceful degradation costs here. Without it, a keyless server has
every visible row fire a `/api/title` lookup purely to be told `{status:
"no-key"}`. With it, the browser fetches no posters at all, shows the single
existing hint line, and the list renders exactly as it does today.

### Fetching them safely

Posters load through `/api/poster` as a blob into `createObjectURL`, never as an
`<img src>` pointing at Amazon. Preventing that leak — the user's IP and referer
to whatever CDN host OMDb named, on every row — is the entire reason
`/api/poster` exists.

`/api/title?release=` already caches on `n:<title>|<year>|<type>`, so fifty
releases of one film cost one OMDb call between them.

### The object-URL hazard

**The results list is rebuilt on every snapshot frame, and up to 23 of those
arrive during one search.** Mounting posters naively per render means 23× the
fetches and a leaked blob on each one.

A new pure `src/web/static/resultPosters.ts` carries the
cache/pending/clear-and-revoke structure the For You feed already proved, with
one change: **the blob cache is keyed by the returned poster URL**, not by the
release name. Fifty releases of one film then share a single blob as well as a
single OMDb call. Everything is revoked when a new search starts, which is the
only moment the set of rows can change wholesale.

Lookups are lazy, via `IntersectionObserver`. For You is naturally ~20 picks; a
browse can return 100+ rows, and fetching artwork for rows nobody scrolled to
would spend a daily-capped key on them.

Which tabs get artwork is `previewApplies(group)` — All, Movies, TV, Anime. Not a
second predicate; that function already answers this question for the preview
pane, and OMDb has nothing useful to say about a Games or Music row.

Keyless and no-poster wording reuses `reccPosterNote` and `reccPosterHint`, which
already encode the "say it once for the page, not once per card" rule: twenty
copies of one fix-it sentence are worse than the twenty blank frames they
explain.

### List and grid

A `[≡ list | ▦ grid]` control joins sort / filter / alive-only, shown only on
poster-applicable tabs and remembered in `localStorage`. **List stays the
default.**

- **list** — a thumbnail in the existing row, keeping size, swarm, source and the
  play / add / add-via-RD buttons where they are. With no key the row is
  byte-for-byte today's row.
- **grid** — poster, name, meta line, then the same three action buttons, laid
  out like a For You card. The actions are on the card, not behind a hover or an
  overlay, so nothing the list offers is lost in the grid.

Both paths render from the same `visibleResults(view, …)` output and the same
poster cache, so a toggle costs no fetches.

## Failure and degradation

| Condition | Behaviour |
| --- | --- |
| No OMDb key | No poster fetches at all. One hint line. List rows identical to today; grid frames read "No OMDb key". |
| Title has no poster | Labelled frame, never a broken image. |
| `/api/poster` 400/404, or an offline tab | Labelled frame. No unresolved frame, no retry storm. |
| No reccd | Library toggles work; the taste event is a no-op, not an error. |
| No Real-Debrid | "add via RD" absent, as today. |
| Config unreadable or unwritable | Route answers a non-2xx with an honest message; the browser reverts the optimistic ★ and shows the notice. |
| A TUI editing config concurrently | Read-modify-write per request. Whole-file clobbering from a stale snapshot is impossible by construction. |

## Testing

Tests first, failing, then the code.

- `src/util/favouriteList.test.ts`, `src/util/savedSearchList.test.ts` — moved
  with their modules, unchanged.
- `src/web/routes.test.ts` — the three routes through `saveConfigImpl`: toggle
  adds and removes, the magnet is built and is what `isFavouriteItem` accepts,
  `remove` is idempotent, caps hold, `watched` dedupes and skips the write when
  nothing changed, the reccd event fires on toggle and is swallowed on failure,
  400s for a blank query / missing `infoHash` / `watched` without `filename`,
  401 without the token.
- `src/web/static/savedModel.test.ts` — request bodies, copy, optimistic flip and
  reconcile against the server's returned list.
- `src/web/static/resultPosters.test.ts` — one lookup per parsed title, one blob
  per poster URL, revoke on a new search, no fetches when
  `omdbConfigured` is false, a late answer for a detached row is dropped.
- `src/web/static/searchModel.test.ts` — `groupChangePlan` cases, including the
  idle-then-tab-click case that is the actual bug.
- `sourcesResponse` — `omdbConfigured` true and false, and that the key itself is
  never in the payload.

Lint and the full suite run before this is called done, not just the touched
files.

## Out of scope

- Configuring anything from the browser. Tokens, sources, DNS and limits stay in
  the TUI; the web is a client of that config, and `/api/sources` already marks
  disabled sources rather than offering to enable them.
- A bookmarkable URL per pane. The existing reasoning holds: a search stream is
  not replayable, so a URL restored mid-search would promise results it cannot
  deliver.
- Poster artwork on the queue pane. A queue row is a download in progress; its
  useful information is the bar, not a film poster.
