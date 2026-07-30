# Saved searches, and a watchlist that means watching

Four things in torlink are called a watchlist. None of them is one, and two of them disagree with each other **across front ends**.

1. The TUI sidebar's **Watchlist** shows `config.savedSearches` — search query strings you pressed `w` on.
2. The TUI's For You pane offers `w`, captioned **"Add to watchlist"** in the `?` sheet. It calls `toggleSavedSearch(item.title)` — it saves the title as a **search**. Consistent with (1).
3. The web's For You card offers a **watchlist** button. It posts `favourited` — the event the `b` key posts. It adds to your **Library**. Inconsistent with (1) and (2).
4. None of them is a list of things you intend to watch.

So the same action, on the same card, does different things depending on which front end you opened. A user can press **watchlist** on a web pick, open the **Watchlist** pane, and not find it — it went to Library. In the terminal the same gesture works. Two features share a name, three behaviours share two names, and the word describes none of them.

That cross-surface divergence is exactly the failure the "a feature ships in both" convention exists to prevent — and it predates the convention being written down.

This design gives each of them an honest name and then builds the thing the word was reaching for: a **Continue watching** list, fed by what you actually streamed.

Both front ends get all of it. That default is now written down in `CLAUDE.md` and `CONTRIBUTING.md`, added in this branch after the discovery that `CONTRIBUTING.md`'s UI standard predated the web UI and so told contributors to build for the terminal only.

## What exists today

- `config.savedSearches` — already honestly named. Only its *displays* lie.
- `config.favourites` — pinned torrents, each with a `watched: string[]` of episode filenames. Real continue-watching data, but only for favourited items.
- `src/download/history.ts` — completed **downloads** (`completedAt`, `dir`, `sizeBytes`). Not streams.
- reccd receives `started` and `watched` events carrying `rawName` and `ts`. **Nothing is stored locally.**
- `parseRelease` (`src/util/release.ts`) returns `title`, `year`, `type`, `key` — and discards everything else `parse-torrent-title` produces, including `season` and `episode`.
- **The web posts no `started` event at all.** Only the TUI does, from two sites in `App.tsx`.

That last point is a parity bug this design fixes on the way past: a browser stream currently teaches reccd nothing about having begun.

## Part 1 — The rename

| Where | Now | Becomes |
| --- | --- | --- |
| TUI section key + sidebar label | `watchlist` / "Watchlist" | `savedSearches` / "Saved searches" |
| TUI `Section` union + guards | `"watchlist"` (`store.ts:14`, `:27`, `:58`) | `"savedSearches"` |
| TUI component | `src/ui/components/Watchlist.tsx` | `SavedSearches.tsx` |
| TUI `?` cheatsheet (`keymap.ts` `HELP_GROUPS`) | `w` — "Add to watchlist" | `w` — "Save this search" |
| TUI footer (`keymap.ts` `footerHints`) | `if (section === "watchlist")` | `"savedSearches"`, plus a new `continueWatching` branch |
| Web wire field | `SavedResponse.watchlist` | `SavedResponse.savedSearches` |
| Web route | `POST /api/watchlist` | `POST /api/saved-searches` |
| Web request type | `WatchlistRequest` | `SavedSearchesRequest` |
| Web pane heading | "watchlist" | "saved searches" |
| Model functions | `watchlistBody`, `watchlistStatus`, `applyWatchlistResponse`, `watchlistToggleNotice` | `savedSearches…` equivalents |
| `app.ts` handlers | `toggleWatchlist`, `removeFromWatchlist` | `toggleSavedSearch`, `removeSavedSearch` |
| README | "watchlist" | "saved searches" |

`config.savedSearches` and the `w` key itself are untouched — the key is muscle memory (`CONTRIBUTING.md`: "never break muscle memory") and the config key was always right. Only `w`'s **caption** changes, because it described the wrong thing.

Breaking the wire field and route path is free now and expensive later: nothing outside this repo consumes them, and #53 merged hours ago. The legacy scripted API (`/status`, `/downloads`, `/add`, `/control`) is untouched.

Apart from the For You change below, this is a pure rename: every existing assertion must still pass unchanged, and that is the check that it *is* one.

### The For You divergence, resolved

**The web adopts the terminal's behaviour.** Its For You button becomes **"save search"** and adds the pick's title as a saved search, which is what the TUI's `w` has always done and what both captions claimed. Nothing is lost: favouriting is available on every search result row, where #53 put it and where favouriting already lives.

This is the one behaviour change in Part 1, and it needs the type system's help, because `saveSearch` posts **no reccd event** while every other card action does. Today `reccEventBody` does `ACTION_EVENT[action]` unconditionally — leaving `saveSearch` in that record's key space would silently send `type: undefined`.

```ts
/** The three actions that post a rating to reccd. */
export type ReccRatingAction = "watched" | "like" | "dislike";
/** Every action a card offers — the ratings, plus the local one. */
export type ReccAction = ReccRatingAction | "saveSearch";

/** Only ratings map to an event. `saveSearch` is deliberately not in this record. */
export const ACTION_EVENT: Record<ReccRatingAction, PublicReccEventType> = {
  watched: "watched",
  like: "liked",
  dislike: "disliked",
};

export function isRatingAction(action: ReccAction): action is ReccRatingAction;
```

`reccEventBody` then takes a `ReccRatingAction`, so a future editor cannot hand it `saveSearch` without the build failing. `dismissesPick` becomes `action !== "saveSearch"` — unchanged in effect, since saving a search should no more remove a pick from the feed than adding to a watchlist did. `actOnPick` branches on `isRatingAction` and routes `saveSearch` to the existing saved-searches toggle instead of `/api/recc-event`.

## Part 2 — The stream-history store

New module `src/core/streamHistory.ts`. `src/core` because it is the front-end-agnostic middle both UIs sit on, and eslint forbids `src/web` importing `src/ui`. New path `streamHistoryFile = path.join(dataDir, "stream-history.json")`.

Kept separate from `history.json` on purpose: "I finished downloading this" and "I watched this" are different facts, and a user who downloads a season pack once but watches it over three weeks would see one list lie about the other.

```ts
export interface StreamHistoryItem {
  /** parseRelease's `key` — the group and dedupe key. One entry per title. */
  key: string;
  /** "Severance", not "Severance.S02E04.1080p.WEB-DL-GROUP". */
  title: string;
  year?: number;
  type?: "movie" | "series";
  /** Highest season/episode seen for this title, when the release named one. */
  season?: number;
  episode?: number;
  /** The release this came from, so a fallback search has something specific to ask for. */
  rawName: string;
  infoHash: string;
  magnet: string;
  source?: SourceId;
  /** Epoch ms of the most recent stream of this title. Server clock. */
  startedAt: number;
}
```

Pure functions, shaped like `src/util/favouriteList.ts`:

- `recordStream(current, item, limit = 200): StreamHistoryItem[]` — dedupes on `key`, moves the entry to the front, and keeps the **highest** season/episode seen. Rewatching episode 2 after episode 5 must not move "next" backwards. Returns the same array reference when nothing changed, so callers can skip a redundant write — the same contract `markWatched` uses.
- `nextEpisode(item): { season: number; episode: number } | null` — the following episode for a series with a known position. A **suggestion**, not a claim the episode exists.
- `loadStreamHistory()` / `saveStreamHistory(items)` — mirroring `download/history.ts`, including its "unreadable file returns empty" behaviour.

An item whose `rawName` parses to no title is **not recorded**. Without a title there is no row to draw, and a list of un-parseable release names is the thing this feature exists to avoid.

## Part 3 — Where it gets written

Three call sites, one store:

- `src/ui/App.tsx` — the two existing `started` sites (the P2P and Real-Debrid stream branches). Both already hold the `input` carrying name, magnet, hash, source and size.
- `src/web/routes.ts` — `startStream`, which currently records nothing and posts no reccd event. It gains both.

Recording happens when a session **resolves**, not when a file is picked. That is the moment the user asked to watch something, and it is where the TUI already posts `started`.

## Part 4 — The surfaces

### Terminal UI

A new `continueWatching` section: a `Section` union member (`store.ts:14`), a `Sidebar.tsx` entry labelled "Continue watching", and a component modelled on `Favourites.tsx` — `j`/`k` to move, `Enter` to play, `x` to remove a row.

No **new** key is introduced, so `HELP_GROUPS` needs no new entry — but `footerHints` is per-section and gains a `continueWatching` branch, alongside the `savedSearches` rename of its existing `watchlist` branch. (Both halves of `keymap.ts` are touched by this design, contrary to a first reading: the `?` sheet because `w`'s caption was wrong, the footer because a section was renamed and another added.)

The new `Store` fields — `streamHistory`, `openStreamHistory`, `removeStreamHistory` — each need a matching entry in `makeStore` (`scripts/render-previews-impl.tsx`) or `npm run previews` breaks, which is the rule `CONTRIBUTING.md` records and `#6`'s `copyMagnet` noop exists to demonstrate.

### Browser UI

`GET /api/saved` grows `continueWatching: PublicStreamHistoryItem[]`, and the `saved` pane gains a **full-width strip above** its two columns:

```
saved
┌────────────────────────────────────────────────────┐
│ continue watching                                  │
│  ▸ Severance         2d   last S02E04 · next S02E05│
│  ▸ Dune: Part Two    1w   watched                  │
└────────────────────────────────────────────────────┘
  ▸ saved searches            ▸ library
    dune part two               Severance.S02.1080p ★
```

A strip rather than a fifth tab: five top-level tabs is where this nav stops working on a phone, which #53 already recorded. Above the columns rather than beside them because it is what a returning user wants first.

The honest tension, stated rather than hidden: continue-watching is not something you *saved*, so it sits slightly awkwardly in a pane called "saved". The alternative is renaming that tab to cover all three lists, and nothing short and honest does.

`PublicStreamHistoryItem` omits the magnet, exactly as `PublicFavourite` does — playing goes through `POST /api/stream { infoHash, name }`, which rebuilds it server-side.

## Part 5 — What a click does

1. `POST /api/stream` with the remembered `infoHash` and `name`. The route already reconstructs the magnet from a hash, so nothing new is needed server-side.
2. Session resolves → for a multi-file torrent the picker opens with the next episode's file preselected, using the `watched` filename list `favourites` already tracks; for a single file it plays.
3. Session fails to resolve → fall through to `startSearch(<title> <next episode>)`. A dead swarm becomes a search, never a dead end.

The decision of *what to do* — replay, pick a file, or search — goes in a pure module (`savedModel.ts` for the browser), not in `app.ts`.

## Errors and degradation

| Condition | Behaviour |
| --- | --- |
| `stream-history.json` missing or corrupt | Empty list, same as `loadHistory` today |
| Release name parses to no title | Not recorded — no row to draw |
| Remembered torrent dead | Search fallback |
| reccd unconfigured | History still records; it is local and reccd is a separate concern |
| No favourites for a series | "next" still offered from the history entry's own season/episode |
| Config unwritable | Non-2xx with an honest message; the browser reverts optimistically-shown state |
| A TUI editing config concurrently | Read-modify-write per request, as the saved-list routes already do |

## Testing

- `src/core/streamHistory.test.ts` — dedupe by key, the episode high-water mark (record 5 then 2, next is still 6), the 200 cap, same-reference-on-no-change, unparseable name dropped, corrupt file.
- `src/web/routes.test.ts` — the new `continueWatching` field, the renamed route, and `startStream` recording history and posting `started`. Through the existing `loadConfigImpl` / `saveConfigImpl` seams; a new `saveStreamHistoryImpl` seam is needed for the same reason `saveConfigImpl` was — the real one writes the developer's own data directory.
- `src/web/static/savedModel.test.ts` — the click decision and the Continue-watching row's copy.
- `src/web/static/reccModel.test.ts` — `isRatingAction` narrows correctly, `ACTION_EVENT` still maps the three ratings to the three events (the existing test that a swap here is invisible on screen must survive), `dismissesPick("saveSearch")` is false, and `RECC_ACTIONS` still lists four actions in order.
- The rename gets **no new tests** — every existing assertion passing unchanged is the check. The For You change is the exception: it alters behaviour, so it gets the `reccModel` tests above.
- Manual, both UIs: stream something, confirm it appears in both lists, click it back. Then press `w` on a For You pick in the TUI and click "save search" on the same pick in the browser, and confirm **both** land in Saved searches — that is the divergence this design closes, and only a two-surface check proves it.

## Out of scope

- **Resume positions.** Playback happens in an external player or a browser tab that reports nothing back, so "47% through" is not knowable. `README.md` already lists this as a limitation and it stays.
- **Verifying the next episode exists.** "next S02E05" is a suggestion; the search will find it or not.
- **Title-first search and auto-play with quality preferences.** Separately scoped, and the Real-Debrid availability pre-check they would need may not be possible — `/torrents/instantAvailability` appears to have been withdrawn, which needs confirming against the live API before that work is designed.
- **Backfilling history** from `favourites[].watched` or reccd. The list starts empty and fills as you watch.
