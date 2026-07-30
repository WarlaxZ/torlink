# Quality preference and one-click play from For You

Date: 2026-07-30
Status: approved, ready for an implementation plan

## Why

torlink has no idea what a release *is* beyond its size and swarm. `resultSort.ts`
sorts on size / seeders / source / added; `resultFilter.ts` does hide-dead plus text
scoring. Neither reads resolution, audio, or HDR, even though every result already
passes through `parse-torrent-title`, which reports all of them and whose output
`parseRelease()` currently discards.

The consequence is that picking something to watch is always manual. You highlight a
For You recommendation, jump to a search, read a list of near-identical release names,
and choose. The information needed to choose for you is already on screen — torlink
just never looks at it.

This spec gives torlink a stated preference (a resolution ceiling, features to require,
features to avoid) and one action that uses it: **Enter on a For You pick searches the
title, chooses a release, and plays it.**

## Scope

This is the first of three related specs. It is deliberately the smallest one that is
useful on its own.

| | | |
| --- | --- | --- |
| **A — this spec** | Quality preference + `pickBestRelease` + auto-play from For You | ships first |
| B — New Releases | A title-grouped tree list over the browse feeds, sorted by recency | later; reuses A's picker |
| C — Debrid-aware picking | Prefer a release that will resolve instantly on Real-Debrid | later; wraps A's picker |

A ships alone because it needs nothing from B or C, and because it improves the surface
people already use. B without A is a list that still makes you choose manually. C without
A has nothing to constrain.

### Explicitly not in this spec

- The New Releases tree. No grouping of results by title.
- Any Real-Debrid cache awareness. See "What we learned about Real-Debrid" below —
  it is a bigger problem than it looks, and folding it in here would stall A.
- A "play best match" action on ordinary search results. It is a natural follow-up,
  but For You is the only surface that names a *title* rather than a *release*, and
  a picker needs a set of candidates for one title.
- Auto-download. This spec plays; it does not queue. The picker is reusable for a
  download action later, and its signature does not assume streaming.

## What we learned about Real-Debrid (recorded so C does not relitigate it)

Real-Debrid **has no cache-check endpoint.** The official API documentation at
`https://api.real-debrid.com/` lists exactly these under `/torrents/`:

    GET    /torrents                 GET    /torrents/info/{id}
    GET    /torrents/activeCount     GET    /torrents/availableHosts
    PUT    /torrents/addTorrent      POST   /torrents/addMagnet
    POST   /torrents/selectFiles/{id}  DELETE /torrents/delete/{id}

`/torrents/instantAvailability/{hash}` — the endpoint every "is it cached?" feature was
historically built on — is absent. So cached-ness is observable **only after adding the
magnet**: the torrent's status goes to `downloaded` almost immediately if RD already has
it, and to `downloading` with a progress figure if it does not.

That makes "only pick releases available on debrid" a **try-and-fall-back loop**, not a
filter over a list. It is a different feature with different failure modes (it mutates
the user's RD account as a side effect of *asking a question*), which is why it is spec C.

One cheap partial win already exists and belongs to C: `listTorrents` and `findExisting`
(`src/integrations/realdebrid.ts:274`, `:291`) already locate a torrent by infohash in
the user's own account. Anything already there is instant. That covers re-watches for
free; it says nothing about a title the user has never fetched.

## 1. The preference

Three new fields on `Config` (`src/config/config.ts`), all meaning "no preference" when
absent:

```ts
export type Resolution = "2160p" | "1080p" | "720p" | "480p";

export interface Config {
  // …existing fields…

  // Ceiling for auto-picked releases. Absent = no ceiling, so the largest file
  // wins. Note that with no ceiling set, a remux will usually win — that is the
  // intended reading of "largest available", not a bug.
  maxResolution?: Resolution;
  // Features an auto-picked release should have. SOFT: when nothing has them,
  // the pick falls back and reports which requirements it dropped.
  requireFeatures?: FeatureId[];
  // Features an auto-picked release must not have. HARD: never chosen.
  excludeFeatures?: FeatureId[];
}
```

`loadConfig()` sanitises both arrays the way it already sanitises `savedSearches` and
`favourites`: non-strings dropped, unknown `FeatureId`s dropped, duplicates collapsed.
An id appearing in both `requireFeatures` and `excludeFeatures` is resolved in favour of
*exclude*, and the id is removed from `requireFeatures` at load. This matters because a
hand-edited config or a downgrade to an older build must not be able to express a
preference that matches nothing.

`maxResolution` is validated against the `Resolution` union and dropped if it is anything
else.

**No environment variable override.** Every existing resolver (`resolveOmdbApiKey`,
`resolveDnsServers`, and the rest) exists for a secret or a machine-specific path. A
playback preference is neither, and adding a resolver would imply the others were
arbitrary.

### Which surfaces can change it

**Both.** This departs from the "configuration is TUI-only" rule in `CLAUDE.md`, and the
reason is that the rule is really about *credentials, sources, limits, folders and DNS* —
things where the browser is a client of a system the terminal owns. A resolution
preference is a viewing preference, structurally the same as `savedSearches` and
`favourites`, which the web already writes today.

Web writes follow the existing rule without exception: `loadConfig()` → change →
`saveConfig()`, **per request**, never a snapshot held between requests.

## 2. The picker — `src/util/releasePick.ts`

A new pure module beside `resultSort.ts` and `resultFilter.ts`.

**It imports nothing**, for the reason both of those files document at the top:
`src/web/static/` is bundled with `platform: "browser"` and cannot reach the source
registry or anything Node-shaped. `parse-torrent-title` is the one exception — it is
already in the browser bundle's dependency graph via `release.ts`.

### The feature table

```ts
export type FeatureId =
  | "hdr" | "dv" | "atmos" | "dd" | "dts" | "truehd" | "remux" | "hevc" | "tenbit";

export const FEATURES: Record<FeatureId, { label: string; test: (p: ParsedRelease) => boolean }> = {
  hdr:    { label: "HDR",            test: (p) => hasColor(p, "HDR") },
  dv:     { label: "Dolby Vision",   test: (p) => hasColor(p, "DV") },
  atmos:  { label: "Atmos",          test: (p) => hasAudio(p, "atmos") },
  dd:     { label: "Dolby Digital",  test: (p) => hasAudio(p, "dd") || hasAudio(p, "ddp") },
  dts:    { label: "DTS",            test: (p) => p.audioList?.some((a) => a.startsWith("dts")) ?? false },
  truehd: { label: "TrueHD",         test: (p) => hasAudio(p, "truehd") },
  remux:  { label: "Remux",          test: (p) => p.remux === true },
  hevc:   { label: "HEVC / x265",    test: (p) => p.codec === "x265" || p.codec === "hevc" },
  tenbit: { label: "10-bit",         test: (p) => p.bitdepth === 10 },
};
```

A fixed list rather than free text, because free text cannot fail loudly: a user typing
`4k` or `DD+` gets a preference that silently matches nothing, and a bare substring test
for `DD` also matches `DDP`, `RED-DD`, and any release group with those letters in its
name.

`dts` matches the family (`dts`, `dts-hd-ma`, `dts-x`) via prefix rather than an
enumeration, because the parser's `audiolist` reports the specific variant and new ones
appear. This is the one place a prefix test is safe: `dts` is not a substring of another
audio codec's name.

### Extending `ParsedRelease`

`parseRelease()` keeps its current output and gains the fields the table needs. Verified
parser output:

```
Tin.Rivers.2024.2160p.WEB-DL.DV.HDR.Atmos.7.1-GROUP
  → resolution:"2160p" source:"web-dl" color:"HDR" colorlist:["HDR","DV"]
    audio:"atmos" channels:7.1 group:"GROUP" title:"Tin Rivers" year:2024
Kepler.S02E04.1080p.WEB-DL.DD5.1
  → resolution:"1080p" source:"web-dl" audio:"dd" channels:5.1 season:2 episode:4
Harrowgate.S03.1080p.WEB-DL.DDP5.1.x265
  → resolution:"1080p" source:"web-dl" codec:"x265" audio:"ddp" channels:5.1 season:3
```

Added to `ParsedRelease`: `resolution?`, `codec?`, `colorList?`, `audioList?`,
`channels?`, `bitdepth?`, `remux?`.

**`ParsedRelease.key` does not change.** It stays `title|year|type`. The OMDb title cache
(`titleCache` in `routes.ts`), `historyKeyFor` (`src/util/streamHistoryKey.ts`) and
continue-watching all key off it, and widening it would invalidate every cached lookup and
silently split existing history entries.

No local type declarations are needed: `parse-torrent-title` ships its own
`index.d.ts` covering all of these. (The repo's 213-byte `src/parse-torrent.d.ts` is for
the unrelated `parse-torrent` package and is not touched.)

### The signature

```ts
export interface PickableResult {
  name: string;
  sizeBytes: number;
  seeders: number;
}

export interface QualityPrefs {
  maxResolution?: Resolution;
  require: readonly FeatureId[];
  exclude: readonly FeatureId[];
}

/** What the caller is trying to watch. Decides how packs rank against episodes. */
export type PickIntent =
  | { kind: "film" }
  | { kind: "episode"; season: number; episode: number };

export interface Pick<T> {
  chosen: T;
  parsed: ParsedRelease;
  /** Requirements dropped to find a candidate. Empty when the preference was met. */
  relaxed: FeatureId[];
  /** True when no candidate was at or under the cap, so the cap was ignored. */
  overCap: boolean;
  /** True when `chosen` is a season pack and the intent named an episode. */
  fromPack: boolean;
}

export function pickBestRelease<T extends PickableResult>(
  candidates: readonly T[],
  prefs: QualityPrefs,
  intent: PickIntent,
): Pick<T> | null;
```

Structural `PickableResult` rather than `TorrentResult`, matching how `SortableResult`
and `FilterableResult` are defined — so `TorrentResult` (terminal) and
`PublicSearchResult` (browser wire shape, which has no `magnet`) both satisfy it without
either layer importing the other's type.

### The ranking

Applied in order. Each step narrows the candidate set; a step that would empty it is
skipped and recorded.

1. **Parse and drop noise.** Candidates whose `parseRelease()` returns `null` are
   dropped — they are quality/codec residue with no title.

2. **Intent.** For `{ kind: "episode", season, episode }`, candidates are banded:

   - **Band 1** — names that exact episode (`season` and `episode` both match).
   - **Band 2** — a pack covering it: the same `season`, no `episode` in the name.
   - **Band 3** — everything else. A complete-series pack (`S01-S05`) lands here,
     because `parse-torrent-title` reports no single `season` for a range. That is
     the right place for it: it is usable but it is nobody's first choice for one
     episode, and it will still be picked when it is all that exists.

   The highest non-empty band wins outright, and later steps run only within it.
   This is the step that stops "largest file" from always choosing
   `Harrowgate.S03.1080p.WEB-DL` when the user wanted one episode of it. If band 2
   wins, `fromPack` is true and the caller hands the resolved torrent's file list to
   the existing `nextEpisodeIndex()` (`src/util/nextEpisodeFile.ts:87`) to select the
   file inside the pack — that machinery already exists and is not duplicated here.

   For `{ kind: "film" }` this step is a no-op.

3. **Resolution cap.** With `maxResolution` set, candidates above it are dropped.

   **A candidate whose resolution did not parse counts as under the cap.** This is the
   same trap `resultFilter.ts` documents for `seeders: 0`: several sources emit names
   with no resolution token at all, and treating "unknown" as "too big" would empty
   those sources entirely. If every candidate is over the cap, the cap is dropped and
   `overCap` is set — the fail-soft choice, so the action still plays something.

4. **Excluded features. Hard.** Any candidate matching an excluded feature is dropped
   and never comes back, even if that empties the set — at which point the pick returns
   `null` and the caller reports that everything found was excluded. "Never play DV"
   has to mean never.

5. **Required features. Soft.** Prefer candidates matching *all* required features. If
   none do, drop the least-satisfied requirement and retry, recording each dropped id
   in `relaxed`. Ordering is by how many candidates satisfy each requirement — the
   rarest requirement is dropped first, so the commonest preference survives longest.

6. **Largest `sizeBytes`**, then `seeders` descending as a tiebreak, then `name`
   ascending so the result is deterministic for tests.

Returns `null` only when the candidate list is empty, every candidate was noise, or
step 4 removed everything.

### Why relax-and-report rather than refuse

`CONTRIBUTING.md`'s fail-soft house style, and the concrete failure mode: a user who ticks
"Atmos" gets a dead Enter key on most of their library. `relaxed` and `overCap` exist so
the UI can be honest about it — "no Atmos release — playing 1080p DD 5.1" — rather than
either lying or refusing.

The one hard rule is the exclusion list, for the reason above.

## 3. The front ends

### Terminal UI

`src/ui/components/ForYou.tsx` — Enter changes meaning:

| Key | Before | After |
| --- | --- | --- |
| `Enter` | `setSection(TYPE_SECTION[type])` + `submitQuery(item.title)` | search the title, pick, play |
| `s` | — | today's Enter: jump to the results list for that title |

`s` is added to **both** halves of `src/ui/keymap.ts` — `HELP_GROUPS` and `footerHints`.

The auto-play path: run the existing search for `item.title`, wait for the snapshot,
build a `PickIntent` (for a series, `nextEpisode()` from `src/core/streamHistory.ts:116`
against the user's history for that title; `{ kind: "film" }` otherwise, and for a series
with no history, episode 1 of season 1), call `pickBestRelease`, then hand the winner to
the existing stream launch path unchanged. Nothing about streaming, Real-Debrid, or
player launch is modified.

Status copy while this runs, on the existing status line: `Finding a release for
Tin Rivers…` → the pick's outcome. When `relaxed` is non-empty or `overCap` is set, the
note names what gave way.

A new `Store` field for the in-flight pick state means matching entries in **both**
`makeStore` (`scripts/render-previews-impl.tsx`) and `makeTestStore`
(`src/ui/testHarness.ts`), or `npm run previews` and `npm run typecheck` respectively
break.

**Settings:** a block in the existing config pane — a resolution cycle and two feature
lists, built from `FEATURES` so the terminal and browser cannot drift.

### Browser UI

`src/web/static/` — the For You card's primary click becomes play; a secondary button
keeps today's "search this title" behaviour.

- **Route.** `PUT /api/preferences` in `src/web/routes.ts`, read-modify-write per
  request. `GET` of the current preference joins the existing config payload rather
  than getting its own endpoint.
- **Wire.** `PublicQualityPrefs` in `src/web/wire.ts`, plus the `FeatureId` union.
  `FEATURES`' labels are *not* sent over the wire — the browser imports the same
  `src/util/releasePick.ts` the server uses.
- **Pure module.** `src/web/static/pickModel.ts` beside `reccModel.ts`, holding the
  phase machine (`idle → searching → picking → playing → no-results`) and the copy for
  a relaxed or over-cap pick. `app.ts` gets DOM wiring only — no conditional in `app.ts`
  decides what to show or what to send.
- **Settings pane:** checkboxes and a select, generated from `FEATURES`.

Playback itself reuses `streamFlow.ts` unchanged.

## 4. Testing

`src/util/releasePick.test.ts` carries the weight, using the standard fixture cast — no
real titles anywhere:

- `Kestrel.2010.1080p.BluRay.x264` — a plain film.
- `Ashfall.1999.1080p` — a second film; also the resolution-parses-but-nothing-else case.
- `Tin.Rivers.2024.2160p.WEB-DL.DV.HDR.Atmos.7.1-GROUP` — the feature-rich 4K case.
- `Kepler.S02E04.1080p.WEB-DL` — a single episode.
- `Harrowgate.S03.1080p.WEB-DL` — a season pack.

Cases that must exist:

- **The pack trap.** Candidates = a `Harrowgate.S03` pack (large) and a
  `Harrowgate.S03E02` episode (small), intent = episode 2. The episode wins despite being
  smaller. Same set with intent = film, and the pack wins on size.
- **Cap respected**, and **cap ignored with `overCap` set** when nothing is under it.
- **Unparseable resolution counts as under the cap** — a candidate with no resolution
  token is not dropped by a `1080p` cap.
- **Exclusion is hard**: excluding `dv` with only `Tin.Rivers…DV…` available returns
  `null`, not a fallback.
- **Requirement is soft**: requiring `atmos` with none available returns the best
  candidate and `relaxed: ["atmos"]`.
- **Rarest requirement drops first** when two are set and neither is fully satisfiable.
- **Deterministic tiebreak** on equal size and seeders.
- **`dd` matches both `DD5.1` and `DDP5.1`**, and does not match a group named `RED-DD`.

Config: sanitisation tests for unknown ids, non-string entries, an invalid
`maxResolution`, and the require/exclude collision resolving in favour of exclude.

Web: a `routes.test.ts` case that `PUT /api/preferences` is read-modify-write — a
concurrent change to an unrelated config field is not clobbered. Plus `pickModel.test.ts`
for the phase machine and copy.

Front-end wiring is verified by running it (`npm run dev -- serve --web`), per the
no-jsdom rule. `npm run build` is the check that `releasePick.ts` pulled no `node:*` into
the browser bundle — it must be run.

## 5. Documentation

- `README.md`: the preference and what Enter now does on For You.
- The web UI's own limitations list — confirm it is still true once settings are
  web-editable.

## Risks

**Enter changing meaning on For You** is the only behavioural regression here. Someone
used to Enter-then-browse now gets a player. Mitigated by `s` / the secondary button
being visible in the footer hints and on the card, but it is a real change and belongs in
the PR body rather than buried.

**`parse-torrent-title`'s vocabulary is the ceiling.** If it does not recognise a token,
no feature test can. That is acceptable — it is already the basis of every title lookup
in the app — but it means a preference can quietly under-match on unusual release naming.
The relax-and-report behaviour is what keeps that from being silent.
