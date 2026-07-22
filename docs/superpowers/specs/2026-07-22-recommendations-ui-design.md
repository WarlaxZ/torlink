# "For You" Recommendations UI — Design

**Date:** 2026-07-22
**Status:** Approved (design)
**Depends on:** the existing reccd event-posting integration (`src/recc/client.ts`, config fields `reccUrl`/`reccToken`, event wiring in `App.tsx`) already present on branch `docs/recommendation-engine-spec`.

## Problem

torlink's reccd integration is currently one-directional: it *sends* activity events
(`started`/`watched`/`favourited`/`liked`/`disliked`/`abandoned`) to the self-hosted reccd
service, but it never *fetches or displays* recommendations. The "smart recommendations"
payoff — reccd's `GET /recommendations` — is not surfaced anywhere in the UI.

This design adds a **For You** section that fetches ranked picks from reccd and lets the user
launch a torrent search for any of them, closing the loop: search → stream → rate feeds reccd,
so future recommendations personalize over time.

## Context: the reccd API we consume

`GET /recommendations?type=movie|tv&genre=<str>&limit=<n>&explore=true`, `Authorization: Bearer <token>`.

Response: JSON array of `{ imdbId: string, title: string, year: number, score: number, reasons: string[] }`.

Notes that shape this design:
- reccd returns **no magnet/torrent** — only IMDb id + title + year. Selecting a recommendation
  must therefore start a torlink **search** for that title.
- Results are diversity re-ranked and may include a **wildcard pick** (a title with `reasons`
  exactly `["wildcard pick"]`), so the array is not strictly score-descending.
- `genre` is a free string on reccd's side (no fixed vocabulary torlink can enumerate).
- `explore=true` ranks purely on a title's own recency/quality with personalization off — good
  for browsing outside your usual taste, especially combined with a genre.
- A missing/unknown token returns `401 { "error": "unauthorized" }`.
- The user's `/profile` is empty until posted events resolve against reccd's catalog; until then
  recommendations fall back to recency/quality priors. This is expected, not an error.

## Non-goals (deferred beyond v1)

- Group "movie night" blending across users (`with=` param).
- `/similar/:imdbId` "because you liked X" drilldowns.
- An in-app reccd setup wizard — v1 configures via `config.json` / env vars.
- Cross-session caching of recommendations.

## Architecture

Three units, each independently understandable and testable:

### 1. reccd client — `fetchRecommendations` (`src/recc/client.ts`)

Add alongside the existing `postEvent`:

```
interface Recommendation { imdbId: string; title: string; year: number; score: number; reasons: string[]; }

interface RecommendationQuery { type?: "movie" | "tv"; genre?: string; explore?: boolean; limit?: number; }

type FetchRecommendationsResult =
  | { ok: true; items: Recommendation[] }
  | { ok: false; error: string };

async function fetchRecommendations(
  config: ReccClientConfig,
  query: RecommendationQuery,
  opts?: { fetchImpl?: FetchImpl; timeoutMs?: number },
): Promise<FetchRecommendationsResult>;
```

Behaviour — deliberately **different from `postEvent`**:
- `postEvent` is fire-and-forget (an analytics write that must never affect torlink).
  `fetchRecommendations` is a **blocking read the user is waiting on**, so failures are
  surfaced, not swallowed.
- Builds the query string from provided fields only (omit `type`/`genre` when unset;
  `explore=true` only when true; `limit` always sent, default 20).
- `Bearer ${config.reccToken ?? ""}` auth header (same convention as `postEvent`).
- Timeout ~10s via `AbortSignal.timeout`.
- Returns a discriminated result:
  - `401` → `{ ok: false, error: "reccd rejected the token — check reccToken" }`
  - other non-2xx → `{ ok: false, error: "recommendations unavailable (HTTP <status>)" }`
  - network error / timeout → `{ ok: false, error: "couldn't reach reccd" }`
  - success → `{ ok: true, items }` (parsed/shape-guarded; malformed body → `ok:false`).

### 2. `useRecommendations` hook (`src/ui/hooks/useRecommendations.ts`)

Owns fetch state and filters so the view component stays presentational:

- State: `items`, `loading`, `error`, and filters `{ type: "all" | "movie" | "tv"; genre?: string; explore: boolean }`.
- Exposes `refresh()`, `setType()`, `setGenre()`, `toggleExplore()`. Any filter change triggers a refetch.
- Maps `type: "all"` to *omitting* the reccd `type` param.
- Reads reccd config (resolved `reccUrl`/`reccToken`) passed in from `App.tsx`.
- Does not fetch when `reccUrl` is unset (drives the "set up" hint in the view).

### 3. `ForYou` view (`src/ui/components/ForYou.tsx`)

Presentational list bound to the hook.

- **Rows:** `title · year · reason-tag`. The reason tag is the first `reasons` entry
  (or `wildcard pick` when that is the sole reason). Score is not shown (internal ranking detail).
- **Controls (footer hints):**
  - `t` — cycle type: all → movie → tv → all
  - `g` — set genre: opens a free-text prompt (empty submission clears the genre)
  - `e` — toggle explore mode
  - `r` — refresh
  - `↑↓` / `j k` — move selection
  - `↵` — search this title (see bridge below)
  - `esc` — back to sidebar
- **States:**
  - loading → spinner "Finding recommendations…"
  - error → the hook's error string + "press r to retry"
  - empty list → "No picks yet — stream something and they'll start showing up here."
  - `reccUrl` unset → "Set up recommendations: add reccUrl/reccToken to config.json
    (or TORLINK_RECC_URL / TORLINK_RECC_TOKEN)."

**Genre input** uses a free-text prompt (reusing torlink's existing prompt/TextField pattern)
rather than a curated cycle-list, because reccd's genre vocabulary is open-ended and a fixed
list would be guesswork.

### 4. Selection → search bridge

On `↵` over a recommendation, `ForYou` calls two things already available in `App.tsx`:
1. `setSection(category)` where category derives from the current type filter
   (`movie → "movies"`, `tv → "tv"`, `all → "all"`), so the Results view's category is sensible.
2. `submitQuery(title)` — the existing callback that sets the query, records search history,
   and runs the concurrent search.

Query is **title-only** for v1. Torrent release names are matched better without an appended
year (year often hurts recall); if recall proves poor we can add `"{title} {year}"` for movies
later. After the jump, the normal Results flow applies (stream / download / favourite), and the
existing `postEvent` wiring records the resulting activity back to reccd — closing the loop.

## Wiring changes (`src/ui/store.ts`, `Sidebar.tsx`, `App.tsx`, `keymap.ts`)

- `Section` type: add `"forYou"`. `isCategory()` already excludes non-category sections by
  explicit checks; add `"forYou"` to that exclusion list.
- `Sidebar.tsx`: add `{ key: "forYou", label: "For You" }` at the **top of the `LIBRARY` group**,
  but **only when reccd is configured** — the item is filtered out entirely when `reccConfigured`
  is false, so an unconfigured install never shows it. A `reccConfigured: boolean` field is added
  to the store (computed as `Boolean(resolveReccConfig(config).reccUrl)`, mirroring the existing
  `debridConfigured`) and read by the sidebar. The rail width (`RAIL_WIDTH`) is still derived from
  the full nav list so it stays stable regardless.
- `App.tsx`: render a `display`-toggled content block
  `display={section === "forYou" ? "flex" : "none"}` wrapping `<ForYou … />`, passing reccd
  config, `submitQuery`, and `setSection`.
- `keymap.ts`: add a "For You" `HELP_GROUPS` entry and any footer hint labels.

## Config

- Read `reccUrl` / `reccToken` from `config.json` (fields already exist).
- Add **env overrides** `TORLINK_RECC_URL` / `TORLINK_RECC_TOKEN`, resolved the same way
  torlink already resolves `realDebridToken`, media player, and DNS from env (a
  `resolveReccConfig(config, env)` helper mirroring the existing `resolve*` functions).
- No new persisted config keys.

## Error handling summary

| Situation | Behaviour |
|---|---|
| `reccUrl` unset | The "For You" nav item is hidden entirely; no fetch. The in-pane setup hint remains only as a defensive fallback for the rare case where config is removed at runtime while the section is open. |
| 401 from reccd | Error row: "reccd rejected the token — check reccToken", `r` retries. |
| Network/timeout | Error row: "couldn't reach reccd", `r` retries. |
| Empty array | Friendly empty state, not an error. |
| Malformed body | Treated as `ok:false` with a generic "unexpected response from reccd". |

## Testing

- **`src/recc/client.test.ts`** (extend): `fetchRecommendations` — success parse; 401 mapping;
  timeout/network mapping; malformed-body mapping; query-string building across
  type/genre/explore/limit combinations (including `type:"all"` omitting the param).
- **`src/ui/hooks/useRecommendations.test.ts`** (new): filter changes trigger refetch;
  `type:"all"` omits param; error state surfaces from the client.
- **`src/ui/components/ForYou.test.tsx`** (new): renders list / loading / error / empty /
  unconfigured states; `t`/`e` change filters; `g` opens the genre prompt; `↵` calls
  `submitQuery(title)` + `setSection(expectedCategory)`. Mirrors the existing
  `RatePrompt.test.tsx` component-test style.

## Rollout / verification

1. Set `reccUrl` (`http://192.168.0.98:4100`) and `reccToken` in the local `config.json`.
2. Launch torlink, open **For You**, confirm live picks render, filters work, and selecting a
   pick runs a search and lands in Results.
3. Stream a title, confirm the existing event posting reaches reccd (personalization loop).
