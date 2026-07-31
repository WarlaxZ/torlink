# Title Autocomplete From reccd — Design

**Date:** 2026-07-31
**Status:** Approved, not yet implemented

## Problem

Both search boxes are blind. You type a title from memory, and if you misremember the
spelling or the year, the torrent search returns nothing and says nothing about why. The
recovery is to leave torlink, look the title up somewhere else, and come back.

reccd already has the catalog that answers this. It shipped `GET /search?q=&limit=` — a
prefix and word-prefix lookup over IMDb's ~1.5M-title catalog, ranked by popularity,
returning canonical titles with years. torlink talks to reccd already (`/recommendations`,
`/events`, `/profile`) but not to `/search`.

So: when reccd is configured, both front ends offer live title suggestions as you type,
and picking one puts the canonical title and year into the search.

**Note on reccd's own docs.** `reccd/docs/superpowers/specs/2026-07-31-search-autocomplete-design.md`
is headed "Approved, not yet implemented". That header is stale — the route is live at
`reccd/src/api/server.ts:370` with `reccd/src/db/titleSearch.ts` behind it. Read the code,
not the header. Everything below was verified against the code.

## What reccd actually returns

Verified at `reccd/src/api/server.ts:68-70` and `reccd/src/db/titleSearch.ts`:

| Constant | Value |
|---|---|
| `SEARCH_MIN_QUERY_LENGTH` | 2 — shorter than this returns `[]` with no DB round trip |
| `SEARCH_LIMIT_DEFAULT` | 10 |
| `SEARCH_LIMIT_MAX` | 25 — oversized `limit` is clamped, not rejected |

A hit is `SearchHit extends CatalogTitle`:

```json
{
  "imdbId": "tt0000001",
  "title": "Kestrel",
  "year": 2010,
  "type": "movie",
  "genres": ["Drama"],
  "rating": 7.4,
  "votes": 90000,
  "matchedAka": null
}
```

- `title` is always the **primary** catalog title.
- `matchedAka` is the alternate title that caused the hit, so a client can render the
  "you typed X, we mean Y" affordance. `null` for primary-title hits.
- `q` absent from the query string → `400`. A non-integer or negative `limit` → `400`.
- reccd parses a trailing year out of `q` itself, so `"kestrel 2010"` works with no
  client-side parsing. We must not strip years before sending.

torlink models only the fields it renders. `genres` and `rating` are dropped at the client
boundary — nothing on screen uses them, and carrying unused fields through
`wire.ts` invites a future reader to assume something reads them.

## Data path

```
TUI   ─ useTitleSuggest ──────────────────────────────► reccd GET /search
Web   ─ app.ts ─► GET /api/title-search ─► routes.ts ─┘
```

The TUI calls reccd directly: same process, same config, exactly as `ForYou` already calls
`fetchRecommendations`.

The browser cannot. It must never see `reccToken`, so `src/web/routes.ts` proxies. This is
not a new pattern — it is `recommendations()` with a different reccd path, and it copies
that route's two load-bearing details:

- **`loadConfig()` per request**, never a snapshot. A reccd URL can be pasted into the
  Accounts pane at any moment, and `serve --web` is a separate process from the TUI.
- **`status: "not-configured"` at HTTP 200** when there is no `reccUrl`. Not a 500 —
  nothing is broken, and the browser needs to distinguish "you have no reccd" from "the
  server fell over".

### Tuning, with reasons

| Setting | Value | Why this value |
|---|---|---|
| Debounce | **250ms** | reccd's own measured latency is 174–311ms for broad prefixes. The 150ms `useTitlePreview` uses is tuned for OMDb and would queue requests behind each other here. |
| Min query length | **2** | Matches `SEARCH_MIN_QUERY_LENGTH` exactly. A different number either fires requests guaranteed to return `[]` or hides results reccd would have given. |
| `limit` | **8** | The terminal renders 5 rows (vertical space is scarce there) and the browser renders all 8. One `limit` for both keeps the two surfaces asking reccd the same question. |
| Timeout | **2500ms** | Not the 10s `fetchRecommendations` uses. A suggestion that arrives after 10 seconds is noise — the user has finished typing and pressed Enter. |
| On failure | **silent** | Unlike `/api/recommendations`, which surfaces `{status:"error"}` to a pane the user deliberately opened. An error banner per keystroke is worse than no suggestions. |

### Failure cases, enumerated

| Case | Behaviour |
|---|---|
| No `reccUrl` | Never fires. TUI checks `resolveReccConfig`; the browser checks `reccConfigured` (below). |
| `401` | No suggestions. Silent — the Accounts pane already reports `badToken` via `checkReccConnection`, which is where a token problem belongs. |
| `404` | No suggestions, treated as "this reccd predates the endpoint" rather than as an error. A user running an older reccd gets a search box that behaves exactly as it does today. |
| Timeout / network error | No suggestions. Logged at debug only. |
| Malformed body | No suggestions. The type guard rejects the whole array rather than filtering it, matching `isRecommendation`'s all-or-nothing check. |

**No unavailability latch.** A 404 does not disable future requests for the process
lifetime. It could — but that means module-level mutable state in `client.ts` with a
test-only reset, and the cost it saves is one cheap 404 per debounced keystroke against a
service on the user's own network. Noted as an option if it ever matters.

### Stale responses are a real bug here

reccd's measured numbers make this concrete, not hypothetical: `q="th"` costs ~311ms and
`q="dark kni"` costs ~71ms. Type the second while the first is in flight and the broad,
stale result lands **after** the fresh one and overwrites it — the list contents disagree
with the input box.

Debouncing does not fix this. Two keystroke bursts separated by more than the debounce
window both fire, and nothing orders their replies.

The fix is a monotonic request sequence number: every request carries one, and a reply is
applied only if its sequence is the highest yet applied. This lives in the pure model with
a named test, because it is exactly the kind of thing that is invisible when it regresses.

## Capability flag

`/api/sources` gains **`reccConfigured: boolean`**, joining `debridConfigured`,
`debridProvider`, `debridCachedCheck` and `omdbConfigured`.

The browser fetches `/api/sources` on load, so this costs nothing extra and means a user
without reccd never spends a request per keystroke discovering that again. It follows the
established rule for that response: a capability boolean, never a credential — the URL and
token stay server-side.

Resolved through `resolveReccConfig(config)`, not raw `config.reccUrl`, so
`TORLINK_RECC_URL` counts. The browser must agree with the TUI about whether reccd is on,
and the TUI resolves it that way.

Touches `SourcesResponse` in `wire.ts` (`src/web/wire.ts:340`) and the fixtures in
`routes.test.ts`.

## Module layout

| File | Change |
|---|---|
| `src/recc/client.ts` | **New export.** `fetchTitleSuggestions(config, {q, limit}, opts)` plus an `isTitleSuggestion` guard, mirroring `fetchRecommendations` / `isRecommendation`: injected `fetchImpl`, `AbortSignal.timeout`, discriminated `{ok:true, items} | {ok:false, error}`. |
| `src/util/titleSuggest.ts` | **New.** Shared pure logic — see below. |
| `src/web/routes.ts` | **New route** `GET /api/title-search`. Plus `reccConfigured` on the sources response. |
| `src/web/wire.ts` | Response type for the new route; `reccConfigured` on `PublicSources`. |
| `src/web/static/suggestModel.ts` | **New.** Browser list state — see below. |
| `src/web/static/index.html` | The listbox container under `#query`. |
| `src/web/static/app.ts` | DOM wiring only. |
| `src/ui/hooks/useTitleSuggest.ts` | **New.** Debounce + fetch + seq, modelled on `useTitlePreview`. |
| `src/ui/components/SearchBar.tsx` | Renders the suggestion rows; Tab-completes. |
| `src/ui/components/Results.tsx`, `src/ui/views/Splash.tsx` | Pass the hook's state in. |
| `src/ui/keymap.ts` | Tab-completes, in **both** `HELP_GROUPS` and `footerHints`. |
| `README.md` | Both surfaces; re-check the web UI's limitations list. |

`src/util/titleSuggest.ts` rather than a helper inside `src/ui/` that the web later copies.
This codebase records four bugs caused by copy-then-drift, and `resultSort.ts`,
`resultFilter.ts`, `favouriteList.ts` and `savedSearchList.ts` all moved down for exactly
this reason. It goes to `src/util/` on day one.

### `src/util/titleSuggest.ts`

Pure, no I/O, no DOM, imported by both front ends.

- `shouldQuery(raw: string): boolean` — trimmed length ≥ 2. The one place the min-length
  rule is written down.
- `suggestionLabel(hit): string` — `"Kestrel (2010) · film"`. `type` is mapped to
  `film`/`show` for display; reccd's `movie`/`tv` are its vocabulary, not torlink's.
- `akaNote(hit): string | null` — the "you typed X, we mean Y" line, `null` when
  `matchedAka` is `null`.
- `submitTextFor(hit): string` — `"Kestrel 2010"`. **Title and year.** The year is why
  canonicalising through a catalog is worth doing at all: it separates a remake from its
  original, and torrent release names carry it.
- `applyReply(state, seq, items)` — the sequence guard. Returns state unchanged when `seq`
  is not the newest.

### `src/web/static/suggestModel.ts`

Browser list state, so that `app.ts` contains no conditional deciding what to show or what
to send. That rule is explicit in `CLAUDE.md` and has been caught in review twice.

Owns: open/closed, highlight index (and its wrap behaviour), which sequence is
authoritative, and what a click or an Enter press submits.

## Terminal UI

`SearchBar` gains an optional suggestion block: up to **5** dim rows below the panel,
rendered only when there are suggestions, so an empty list costs no vertical space and the
layout does not jitter as replies arrive.

```
┌─ search ────────────────────────────┐
│ › dark kni                          │
└─────────────────────────────────────┘
  Kestrel (2010) · film      ← tab
  Ashfall (1999) · film
  Kepler (2019) · show
```

### Keys

The search box already spends its arrows and its Tab (`TextField.tsx:118-144`): `↑`/`↓`
recall search history, `Tab` calls `onExitDown()`. So:

| Key | Meaning |
|---|---|
| `Tab`, list open | Complete to the **top** suggestion. |
| `Tab`, list closed | Exit the field, exactly as today. |
| `↑` / `↓` | Search history. **Unchanged.** |
| `Esc` | Dismiss the list. |
| `Enter` | Submit whatever is in the box. **Unchanged** — Enter never silently substitutes a suggestion for what the user typed. |

The list is not navigable. A navigable list means overloading `↑`, `↓` and `Enter` — three
bindings that already work — and gains one thing: reaching row 3 instead of row 1. Tab-to-
top-hit is a fraction of the code, collides with nothing, and changes no existing key's
meaning. Rejected deliberately, not for time.

### Both call sites

`Results.tsx:708` and `Splash.tsx:128`. Splash is the larger win — it is the box you land
on at launch, before any results exist to narrow.

### State lives in the hook, not the `Store`

A `Store` field would need matching entries in `makeStore`
(`scripts/render-previews-impl.tsx`) and `makeTestStore` (`src/ui/testHarness.ts`), or
`npm run previews` and `npm run typecheck` break respectively. That is the right cost for
state other panes read. No other pane reads this, so `useTitleSuggest` owns it.

## Browser UI

A listbox under `#query`. Arrows are free in a browser, so it is fully navigable:

| Key | Meaning |
|---|---|
| `↓` / `↑` | Move the highlight. Wraps. |
| `Enter` | Accept the highlighted suggestion; with nothing highlighted, submit the raw text. |
| `Esc` | Close the list. |
| Click | Accept that suggestion. |

Accepting fills the input with `submitTextFor(hit)` and submits the search.

The asymmetry with the TUI is the sanctioned kind: the terminal has no free arrows here and
the browser has no keybinding budget to protect. Each surface expresses the same feature
the way it can.

Rows render `suggestionLabel(hit)` and, when `matchedAka` is set, `akaNote(hit)`.

**Every node is `createElement` + `textContent`.** No `innerHTML`, `insertAdjacentHTML`,
`outerHTML` or `document.write`. Catalog titles are less hostile than release names, but the
rule in `src/web/static/` is absolute for a reason and a suggestion row is not the place to
start making exceptions.

## Testing

TDD — failing test first.

**`src/util/titleSuggest.test.ts`:**
- `shouldQuery` — `""`, `"k"`, `" k "` → false; `"ke"`, `"kestrel"` → true.
- `suggestionLabel` — movie → `"Kestrel (2010) · film"`; tv → `"Kepler (2019) · show"`.
- `akaNote` — `null` when `matchedAka` is null; the note when it is set.
- `submitTextFor` — `"Kestrel 2010"`, year included.
- `applyReply` — a reply with a stale sequence is **discarded**; the newest is applied;
  out-of-order arrival (seq 2 then seq 1) leaves seq 2's items in place. This is the
  mutation guard for the stale-response bug.

**`src/web/static/suggestModel.test.ts`:**
- Highlight moves and wraps at both ends.
- Accepting with a highlight sends `submitTextFor` of that hit; with none, the raw input.
- A new query closes the list and resets the highlight.
- Escape closes without changing the input.

**`src/recc/client.test.ts`:**
- Happy path — query string carries `q` and `limit`; `authorization: Bearer …` is sent.
- No `reccUrl` → `{ok:false}` without calling fetch.
- `401` → `ok:false`.
- `404` → `ok:false` (older reccd).
- Non-array body, and an array with one malformed member → `ok:false`.
- Abort/timeout → `ok:false`, no throw.
- A year in `q` is forwarded verbatim, not stripped — reccd parses it.

**`src/web/routes.test.ts`:**
- No `reccUrl` → 200 `{status:"not-configured"}`, and reccd is not called.
- Configured → items proxied.
- **The response body contains neither `reccToken` nor `reccUrl`.** Assert against the
  serialised body, not the object, and assert on a token value that appears nowhere else in
  the fixture so the negative cannot go vacuous.
- Missing `q` → 400.
- `reccConfigured` is `true`/`false` on `/api/sources` per config, and resolves
  `TORLINK_RECC_URL`.

**Fixtures use the repo cast** — `Kestrel.2010`, `Ashfall.1999`, `Kepler.S02E04`,
`Harrowgate.S03`, `Tin.Rivers.2024`. No real titles.

**Wiring is not unit-testable and is not pretended to be.** There is no jsdom. `app.ts` and
the Ink render are verified by running them: `npm run dev -- serve --web` for the browser,
`npm run dev` for the terminal. `npm run build` is the only check that
`src/web/static/` imports no `node:*`.

## Known limits, stated rather than discovered later

**Suggestions are catalog titles, not torrents.** `Harrowgate S03` will never appear as a
suggestion — reccd's catalog holds titles, and `parseBasicsLine` drops `tvEpisode`
entirely. You get `Harrowgate`, then narrow by hand. This is the season-pack edge case the
fixture cast exists to keep in view, and it is worth putting in the README so the first
person to notice does not file it as a bug.

**No typo tolerance.** `"kestrl"` returns nothing. That is reccd's design (prefix matching,
no trigram pass), and reccd's own doc flags typo tolerance as an additive change on their
side. Nothing here needs to change if they add it.

**`ForYou` and autocomplete now submit different things.** `ForYou.tsx:119` and `:133`
submit `selectedItem.title` — title only, no year. Autocomplete submits title and year.
Left alone deliberately: changing a shipped pick path is not in scope for this change.
Recorded here as a follow-up so the divergence is a decision on the record rather than an
inconsistency someone finds.

## Before it is done

`npm test`, `npm run typecheck`, `npm run lint`, `npm run build`. One known pre-existing
lint warning (`react-hooks/exhaustive-deps`, `src/ui/App.tsx`) stays.
