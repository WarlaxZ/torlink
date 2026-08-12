# Anime metadata via AniList

**Date:** 2026-08-12
**Surfaces:** both front ends (web + terminal), shared logic in `src/recc` and `src/util`

## Problem

Every result in the **Anime** group renders with no poster and no plot — the
preview pane shows "No match on OMDb (Series or episode not found!)". This is not
a matching bug; it is the wrong database. OMDb is an IMDb mirror, and anime
releases from Nyaa and SubsPlease ask it questions it cannot answer:

1. **The titles are not the titles IMDb indexes.** `parseRelease`
   (`src/util/release.ts:97`) runs `parse-torrent-title`, built for Western scene
   naming. Fed anime it yields romaji (`Mushoku Tensei III`,
   `Gaikotsu Kishi-sama…`), CJK text (`[LoliHouse] 尼古喵喵`, `[ANi] Animatica「…」`),
   or a fansub-tag-mangled string. IMDb indexes these under their English titles,
   and OMDb cannot translate romaji → English, so the `t=` query misses.
2. **Absolute episode numbering.** SubsPlease/Nyaa use `- 06` or `One Piece 1173`,
   not `S01E06`. The parser reads `1173` as *episode 1173*, so the lookup becomes
   `Season=1&Episode=1173`, which IMDb — organised by real seasons — never has.
   That is the exact "Series or episode not found!" string, OMDb's own `Error`
   surfaced verbatim (`src/recc/omdb.ts:56` → `src/web/routes.ts:1644` →
   `src/web/static/previewModel.ts:229`).
3. **A lot of it is not on IMDb at all** — Chinese donghua (`[Doomdos] … BILIBILI
   WEB-DL`), light-novel/manga scans (`第01-03巻`, artbook `.zip`s), brand-new
   seasonal shows.

The whole Anime tab is asking an English movie/TV database questions in the wrong
language, with the wrong episode scheme, about titles it often does not carry.

## Desired behaviour

For the **Anime** group, look up metadata against **AniList** — a free, keyless
GraphQL API that indexes anime by romaji, English, and native titles plus
synonyms, and serves cover art and descriptions. AniList is tried **first**; OMDb
is a fallback used only when AniList misses **and** an OMDb key is configured.
Because AniList needs no key, anime posters/plots appear even for users who have
never configured OMDb.

All other groups (Movies, TV, All, …) are unchanged: OMDb only.

### Settled decisions

- **AniList-first for the Anime group; OMDb-only elsewhere.** (Not a universal
  OMDb→AniList fallback, and not an AniList-only split that would drop OMDb as a
  safety net.)
- **Always on, no key, no toggle.** AniList is keyless and host-agnostic, so the
  Anime group stops requiring an OMDb key to preview. No config field, no
  `/api/sources` capability flag, no settings dialog entry. If a toggle is ever
  wanted it is a later, additive change.
- **Series-level metadata only.** AniList has no per-episode plots; anime shows
  the series poster + description. The absolute episode number is stripped from
  the query, never sent as `Season`/`Episode`.
- **`imdbId` stays `null` for AniList matches.** The TUI's "open on IMDb" action
  keeps its existing name-search fallback; expanding that action is out of scope.

## Scope boundary (documented limitation, not a bug)

This is scoped to the **Anime tab/section**. In the **All** tab the client sends
no `group=` (`app.ts` only sends it for non-All tabs), so an anime row there is
not marked as anime and still goes through OMDb only — it can still render blank.
Fixing All-tab anime would require per-row source-group signalling and messier
grid gating; it is deliberately left out rather than half-built.

Titles AniList has no entry for — manga/light-novel volume scans, artbook `.zip`s,
some region-locked donghua — stay posterless. Expected, not a failure.

## Architecture

The "AniList then OMDb" ordering must exist exactly once. Both front ends reach
metadata providers through `src/recc/`, so the orchestration lives there and each
front end changes only at the point where it already decides "this is anime". The
alternative — orchestrating separately in the web route and the React hook — is
the copy-then-drift this codebase keeps recording, and is rejected.

### Components

| Unit | File | Responsibility | Depends on |
| --- | --- | --- | --- |
| **Title normalizer** | `src/util/animeTitle.ts` *(new)* | Pure. Raw release name → clean AniList search string, or `null`. Browser-safe (no `node:*`). | — |
| **AniList client** | `src/recc/anilist.ts` *(new)* | GraphQL POST to `graphql.anilist.co`. Title → `FetchTitleMetaResult`. `fetchImpl` injection, timeout, keyless. | `util/net`, `util/logger` |
| **Anime-first resolver** | `src/recc/animeMeta.ts` *(new)* | The single home of the ordering: normalize → AniList → OMDb fallback (only if key present). | `anilist.ts`, `omdb.ts`, `animeTitle.ts` |
| **Poster allowlist** | `src/core/posterCache.ts` *(edit)* | Add `s4.anilist.co` to the one `POSTER_HOSTS` Set. | — |

### Title normalizer — `animeSearchTitle(rawName: string): string | null`

Pipeline, in order:

1. **Strip leading fansub/group tags:** drop leading `[…]` and `(…)` blocks
   (`[LoliHouse]`, `[ANi]`, `[Reza]`).
2. **Cut trailing metadata:** everything from the first `[` that begins a
   quality/codec/subtitle block (`[WebRip 1080p HEVC…]`, `[简繁内封字幕]`) onward.
3. **Strip the episode tail:** trailing `- 06`, `- 1173`, `- 第243話`, `E06`,
   `S01E06` markers — AniList is queried at series level.
4. **Split alternative titles** on `/` and `|` and pick the best candidate: prefer
   a Latin-script segment (romaji/English) over a CJK-only one, since AniList
   ranks romaji/English strongly. If every segment is CJK, keep the first (AniList
   indexes native titles too).
5. **Collapse whitespace; return `null`** if nothing usable survives (mirrors
   `parseRelease` returning `null` on pure noise).

Worked examples (illustrative — from live data, not the test cast):

- `[LoliHouse] 超超超超超喜歡你的100個女朋友 / Hyakkano - 30 [WebRip 1080p…][简繁内封字幕]` → `Hyakkano`
- `[Reza] THE GHOST IN THE SHELL (2026) - S01E06 [WEBRip …]` → `THE GHOST IN THE SHELL`
- `Mushoku Tensei III ～… Honki Dasu [07][…]` → `Mushoku Tensei III`
- `Tefuda ga Oome no Victoria - 06 [1080p]` (SubsPlease) → `Tefuda ga Oome no Victoria`

### AniList client — `fetchAnimeMetaByName(title, { fetchImpl?, timeoutMs? })`

Mirrors `src/recc/omdb.ts`: one exported function, injected `fetchImpl`, returns
the shared `FetchTitleMetaResult` union so callers need no new handling.

- **Transport:** `POST https://graphql.anilist.co`, `Content-Type:
  application/json`, body `{ query, variables: { search: title } }`. No key.
  `AbortSignal.timeout(timeoutMs ?? 8000)`, matching OMDb.
- **Query:** one `Media(search: $search, type: ANIME, sort: SEARCH_MATCH)`
  selecting `id`, `title { romaji english native }`,
  `description(asHtml: false)`, `coverImage { extraLarge large }`, `format`,
  `siteUrl`.
- **Mapping to `FetchTitleMetaResult`:**
  - `posterUrl` ← `coverImage.extraLarge` (fall back to `large`); host `s4.anilist.co`.
  - `plot` ← `description`, with `<br>`/`<i>` and similar light HTML stripped and
    whitespace collapsed; `null` if empty.
  - `type` ← `format === "MOVIE" ? "movie" : "series"` (TV/TV_SHORT/OVA/ONA/SPECIAL
    → series). `MUSIC` / non-video formats → treated as a miss.
  - `imdbId` ← `null`.
  - Miss (`Media` null / GraphQL `errors` / empty data) → `{ ok: false, error:
    "not found" }`; network/parse failure → `{ ok: false, error: "couldn't reach
    AniList" }`, logged at debug. Same shape OMDb uses.
- **Rate limits:** ~90 req/min unauthenticated. The existing 150ms debounce on
  both preview paths keeps us well under; no extra throttling in scope. A 429
  degrades to the ordinary miss → placeholder.

### Anime-first resolver — `fetchAnimeFirstMeta({ rawName, omdb, omdbApiKey, fetchImpl?, timeoutMs? })`

- `title = animeSearchTitle(rawName)`. If non-null → `fetchAnimeMetaByName(title, …)`.
- AniList `ok` → return it.
- AniList miss/error **and** `omdbApiKey` non-empty → fall through to
  `fetchTitleMetaByName(omdb.title, omdbApiKey, { year, type })` — no
  season/episode (anime absolute numbering is meaningless to OMDb).
- AniList miss with no OMDb key → return the AniList miss.

Net effect: keyless users get AniList or a clean placeholder; keyed users get
AniList-then-OMDb.

## Data flow

### Web (server-authoritative)

1. Grid/preview calls `GET /api/title?release=<raw>&group=Anime` (already sends
   `group=` for non-All tabs; `app.ts:2109`).
2. `titleMeta()` parses with `parseRelease`, builds the same `cacheKey`, checks
   `titleCache` — unchanged.
3. On a cache miss, branch on group: `group === "Anime"` → call
   `fetchAnimeFirstMeta({ rawName: release, omdb: { title, year, type },
   omdbApiKey })`. Every other group → the existing `fetchTitleMetaByName` path.
4. Result runs through the existing `allowedPosterUrl` (now passing
   `s4.anilist.co`), is cached and returned as today's `PublicTitleMeta`.
5. The image comes via the existing `GET /api/poster?url=` proxy — no change
   beyond the allowlist entry.

### TUI (in-process)

1. `Results.tsx` already parses the selection and knows `section === "anime"`.
2. It passes `anime: true` into `useTitlePreview`. The hook's metadata effect,
   when `anime` is set, calls `fetchAnimeFirstMeta(...)` instead of
   `fetchTitleMetaByName(...)`; the poster effect (`cachedPosterRows` →
   `getPoster`) is unchanged and now accepts AniList hosts.
3. Cache key is the same `parsed.key`-based string, so scrolling still collapses
   to one lookup.

Both share the resolver and the poster allowlist, so the ordering decision and
the host trust list each exist exactly once.

## Enablement / gating

The Anime group stops requiring an OMDb key:

- `src/web/static/resultPosters.ts` — `postersApply(group, omdbConfigured)`
  returns `true` for `group === "Anime"` regardless of `omdbConfigured`; other
  groups unchanged. `searchHint` skips the "add an OMDb key" nudge on the Anime
  tab (a key buys nothing extra there). Both are pure, already-tested functions.
- `src/ui/components/Results.tsx` — `showPreview` drops the `omdbApiKey !== ""`
  requirement when `section === "anime"`; other sections unchanged.

The "Anime is keyless" rule lives in `postersApply` (tested), not loose in
`app.ts`. No `/api/sources` flag, no config field, no settings toggle.

## Poster allowlist

Add `"s4.anilist.co"` to the single `POSTER_HOSTS` Set in
`src/core/posterCache.ts`. This is what lets AniList covers pass both
`allowedPosterUrl` (web) and `getPoster`/`cachedPosterRows` (both). Posters still
go through the proxy and an `<img src>` with a proxied URL; no `innerHTML`
anywhere.

## Error handling & caching

- Provider failures/misses use the shared `{ ok: false, error }` shape; callers
  render their existing placeholder.
- Caching mechanics unchanged. Web caches successes in `titleCache` by the
  existing `cacheKey`; misses/errors stay uncached (same policy as OMDb, so a
  transient AniList blip is not pinned to a title). TUI keeps its in-hook
  `metas`/`posters` maps keyed by `parsed.key`.

## Testing

No jsdom for `app.ts` (per CLAUDE.md); decisions live in pure modules that get
real tests.

- `src/util/animeTitle.test.ts` — the normalizer against **invented anime-shaped
  fixtures** (not the live titles above), covering each pipeline step: group-tag
  strip, trailing-metadata cut, absolute-episode strip, `/`-split Latin-vs-CJK
  pick, null-on-noise.
- `src/recc/anilist.test.ts` — fake `fetchImpl` with canned GraphQL bodies: happy
  path, `Media: null` miss, GraphQL `errors`, network throw, MOVIE→movie /
  TV→series mapping, description tag-stripping.
- `src/recc/animeMeta.test.ts` — resolver ordering: AniList hit short-circuits;
  AniList miss + key → OMDb called; AniList miss + no key → no OMDb call, miss
  returned.
- `src/web/static/resultPosters.test.ts` — Anime `true` without an OMDb key;
  other groups still gated.
- `src/web/routes.test.ts` — `?release=…&group=Anime` routes to an injected
  resolver stub; non-Anime groups still hit the OMDb path.
- TUI wiring verified by running it (`npm run dev -- serve --web` for the web,
  a manual TUI anime-section check) — no unit reach into `app.ts`.
- Full gate before "done": `npm test`, `npm run typecheck`, `npm run lint`,
  `npm run build`.

## Docs

Update both front ends' notes per CLAUDE.md's docs row: the web UI's limitations
list (anime now gets posters) and any OMDb-only phrasing in `README.md`.

## Out of scope

- All-tab anime posters (needs per-row source-group signalling).
- Per-episode anime plots (AniList is series-level).
- Any settings toggle or capability flag for AniList.
- Changing the TUI "open on IMDb" action for anime.
- AniList lookups for manga/light-novel/artbook entries that have no anime record.
