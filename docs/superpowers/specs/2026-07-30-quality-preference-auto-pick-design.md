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
| C — Debrid-aware picking | Walk the ranking until one resolves: skip releases that are uncached, dead, or taken down | later; loops over A's ranking |

A ships alone because it needs nothing from B or C. B without A is a list that still
makes you choose manually. C without A has nothing to constrain.

### Why there are two triggers, not one

A drives auto-play from **For You** and **Continue Watching**. The second was added after
review found two problems with For You alone, both of which it fixes:

**For You is gated on reccd.** `App.tsx:399` falls back to the `all` section when
`resolveReccConfig(cfg).reccUrl` is absent, and the web returns
`{status: "not-configured"}`. With For You as the only trigger, anyone who has not stood
up a self-hosted reccd would get a settings block wired to no action at all. Continue
Watching has no such gate — it reads local stream history — so A is useful to everyone
on day one.

**For You cannot exercise the episode logic.** It surfaces titles the user has *not*
watched, so `nextEpisode()` finds no history and the intent is always season 1, episode 1.
The banding rules and the `nextEpisodeIndex()` handoff would ship specified, tested, and
called by nothing. Continue Watching is precisely the surface where `nextEpisode()` is
live, so the pack-versus-resolution ranking runs against real intent rather than a
constant.

It is a small addition: `nextEpisode(item)` is already computed server-side and sent over
the wire as `next` (`src/web/routes.ts:824`), and the TUI already renders `nextLabel(item)`
(`src/ui/components/ContinueWatching.tsx:41`). Neither surface needs new data — only a new
action over data it already has. The browser must keep taking `next` from the wire and
must not import `streamHistory`, which pulls in `node:fs`; `savedModel.ts:285` documents
that constraint and the four copy-then-drift bugs behind it.

### Explicitly not in this spec

- The New Releases tree. No grouping of results by title.
- Any Real-Debrid awareness — neither cache-checking nor takedown recovery. See "What we
  learned about Real-Debrid" below: both need a retry loop that mutates the user's RD
  account, and folding that in here would stall A. A's current behaviour on a dead or
  flagged torrent is unchanged: the action fails with the existing message.
- A "play best match" action on ordinary search results. It is a natural follow-up, but
  a picker needs a set of candidates for one title, and For You and Continue Watching are
  the two surfaces that name a *title* rather than a *release*. Search rows are already
  individual releases, so the pick has been made by the time you are looking at one.
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

### "Removed" and "taken down" are the same question, and detection already exists

C also has to answer *has this been pulled?*, not just *is it cached?*. That needs no new
detection work:

- `ERROR_STATUSES` (`src/integrations/realdebrid.ts:12`) is
  `{error, magnet_error, virus, dead}`. `virus` is Real-Debrid's flag for content it has
  removed; `messageForTorrentStatus` already renders it as "Real-Debrid flagged this
  torrent's contents", and `dead` as "No seeders".
- The unrestrict step separately maps `file_unavailable` and `no_longer_available` to
  "No longer available on Real-Debrid (removed)."

The constraint is identical to caching: all of it is knowable only *after* adding the
magnet. What it changes is C's **value**. Today a `virus` or `dead` status fails the whole
action and the user restarts by hand; with a fallback loop it simply advances to the next
candidate. Recovering from a takedown is a better argument for building C than the
caching speed-up was — and it is why C must be a loop over ranked candidates rather than
a filter, which is exactly what `pickBestRelease` returning a ranked list (see
"Ordering C's future needs" below) is designed to allow.

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
  /**
   * True when the intent named an episode but `chosen` does not name that episode —
   * a season pack, a series pack, or an unbanded release. The caller must then pick
   * the file inside it rather than playing the first one.
   */
  fromPack: boolean;
}

/** Every surviving candidate, best first. */
export function rankReleases<T extends PickableResult>(
  candidates: readonly T[],
  prefs: QualityPrefs,
  intent: PickIntent,
): Pick<T>[];

/** The winner, or null. Exactly `rankReleases(...)[0] ?? null`. */
export function pickBestRelease<T extends PickableResult>(
  candidates: readonly T[],
  prefs: QualityPrefs,
  intent: PickIntent,
): Pick<T> | null;
```

#### Ordering C's future needs

`rankReleases` exists because of the Real-Debrid findings above: neither "is it cached"
nor "has it been taken down" can be answered without *trying* a candidate, so C is a loop
that walks the ranking until one resolves. Returning only a winner would force C either to
re-rank with the failed candidate removed, or to reimplement the ordering — the
copy-then-drift bug this codebase has already hit four times.

A ships `rankReleases` and uses only its head. That is a deliberate, single-line piece of
scaffolding for a spec that is already designed, not speculative generality — and it costs
nothing, because the ranking has to be computed in full either way.

Structural `PickableResult` rather than `TorrentResult`, matching how `SortableResult`
and `FilterableResult` are defined — so `TorrentResult` (terminal) and
`PublicSearchResult` (browser wire shape, which has no `magnet`) both satisfy it without
either layer importing the other's type.

### The ranking

Steps 1–4 **filter**; steps 5–8 **sort** what survives. The winner is the first row of
the sorted list.

1. **Parse and drop noise.** Candidates whose `parseRelease()` returns `null` are
   dropped — they are quality/codec residue with no title.

2. **Excluded features. Hard.** Any candidate matching an excluded feature is dropped
   and never comes back, even if that empties the set — at which point the pick returns
   `null` and the caller reports that everything found was excluded. "Never play DV"
   has to mean never.

3. **Resolution cap.** With `maxResolution` set, candidates above it are dropped.

   **A candidate whose resolution did not parse counts as under the cap.** This is the
   same trap `resultFilter.ts` documents for `seeders: 0`: several sources emit names
   with no resolution token at all, and treating "unknown" as "too big" would empty
   those sources entirely. If every candidate is over the cap, the cap is dropped and
   `overCap` is set — the fail-soft choice, so the action still plays something.

   **When `overCap` is set, step 5 ranks resolution *ascending* instead**, so the
   closest thing above the ceiling wins. Someone who capped at 1080p and is offered
   only 2160p and 4320p should get the 2160p; handing them the largest file in the
   list is the opposite of what the setting asked for. This inversion applies only to
   the over-cap pass — with any candidate under the cap, ranking is descending as
   normal.

4. **Required features. Soft.** Keep only candidates matching *all* required features.
   If none do, drop the least-satisfied requirement and retry, recording each dropped
   id in `relaxed`. Ordering is by how many candidates satisfy each requirement — the
   rarest requirement is dropped first, so the commonest preference survives longest.

   Requirements are applied *before* the resolution ranking below, so an explicitly
   requested feature beats a higher resolution: with `require: ["atmos"]`, a 1080p
   Atmos release wins over a 2160p one without it. A requirement the user ticked is a
   stronger signal than a resolution they did not.

5. **Resolution, highest first** (ascending when `overCap`, per step 3). The primary
   ranker, not merely a filter. This is what makes a 2160p season pack beat a 720p
   single episode.

   A candidate whose resolution did not parse **ranks last** among known resolutions.
   Note the deliberate asymmetry with step 3: unknown is optimistic for the cap (kept)
   and pessimistic for the ranking (last), so such a release is never *excluded* but is
   only *chosen* when nothing with a stated resolution is available.

6. **Intent, as a tiebreak within one resolution.** For
   `{ kind: "episode", season, episode }`, candidates band as:

   - **Band 1** — names that exact episode (`season` and `episode` both match).
   - **Band 2** — a pack covering it: the same `season`, no `episode` in the name.
   - **Band 3** — everything else. A complete-series pack (`S01-S05`) lands here,
     because `parse-torrent-title` reports no single `season` for a range. That is
     the right place for it: it is usable but it is nobody's first choice for one
     episode, and it will still be picked when it is all that exists.

   If the winner is band 2 or 3, `fromPack` is true and the caller hands the resolved
   torrent's file list to the existing `nextEpisodeIndex()`
   (`src/util/nextEpisodeFile.ts:87`) to select the file inside the pack — that
   machinery already exists and is not duplicated here.

   For `{ kind: "film" }` this step is a no-op.

7. **Largest `sizeBytes`.** Only ever separates releases of the same resolution and
   band, so "largest available" means "largest at the best resolution available".

8. **`seeders` descending, then `name` ascending**, so the result is deterministic
   for tests.

Returns `null` only when the candidate list is empty, every candidate was noise, or
step 2 removed everything.

### Why resolution outranks size and intent

Two decisions, taken together because they are the same decision:

**Resolution over intent.** Strict banding (episode always beats pack) is smaller to
download and much friendlier to a debrid cache, but it plays a visibly worse copy
whenever the only single-episode release is poor. Resolution-first accepts the download
cost to always get the best picture available under the cap. The practical consequence
is real and worth stating plainly: **watching one episode may fetch an entire season.**

**Resolution over size.** With no cap set, "largest file" alone would choose a 42 GB
1080p remux over a 15 GB 2160p WEB-DL. Ranking on resolution first keeps one rule in
force whether or not a cap is configured, rather than the picker behaving differently
depending on a setting the user may not have touched.

### Why relax-and-report rather than refuse

`CONTRIBUTING.md`'s fail-soft house style, and the concrete failure mode: a user who ticks
"Atmos" gets a dead Enter key on most of their library. `relaxed` and `overCap` exist so
the UI can be honest about it — "no Atmos release — playing 1080p DD 5.1" — rather than
either lying or refusing.

The one hard rule is the exclusion list, for the reason above.

## 3. The front ends

### Terminal UI

Both panes gain the same pair of bindings, so the vocabulary is identical wherever
auto-play appears:

| Pane | Key | Before | After |
| --- | --- | --- | --- |
| `ForYou.tsx` | `Enter` | `setSection(TYPE_SECTION[type])` + `submitQuery(item.title)` | search the title, pick, play |
| `ForYou.tsx` | `s` | — | today's Enter: jump to the results list for that title |
| `ContinueWatching.tsx` | `Enter` | resume the stored torrent | search the title, pick, play the next episode |
| `ContinueWatching.tsx` | `s` | — | jump to the results list for that title |

`s` is free in both panes — key handling is per-component (`Results.tsx:389`,
`Downloads.tsx:143`), and the only global letters in `App.tsx` are `?`, `o` and `S`. It
already means different things in different panes (Sort in results, Export in the
torrent prompt), so a third sense here follows the existing convention rather than
breaking one. Both new bindings go in **both** halves of `src/ui/keymap.ts` —
`HELP_GROUPS` and `footerHints`.

The auto-play path, shared by both panes: run the existing search for the title, wait for
the snapshot, build a `PickIntent`, call `pickBestRelease`, hand the winner to the
existing stream launch path. Nothing about streaming, Real-Debrid, or player launch is
modified.

The intent differs only in where it comes from:

- **Continue Watching** — `nextEpisode(item)` (`src/core/streamHistory.ts:116`) gives the
  season and episode directly. This is the live case, and the one that exercises the
  banding.
- **For You** — a film picked by `type` is `{ kind: "film" }`; a series has no history, so
  it is season 1, episode 1.

**`nextEpisode` returning null means Enter does not change at all.** It is null for a film
*and* for a series watched via a season pack, because `Harrowgate.S03` parses to a season
with no episode and guessing episode 1 would point at something already watched
(`streamHistory.ts:111-114`). In both cases there is no honest thing to search *for*, so
Enter keeps today's behaviour exactly: resume the stored torrent. Auto-pick applies only
to rows that name a real next episode.

Inventing an intent for those rows would undo a deliberate piece of existing design, so
this is a constraint on the implementation, not a gap in it.

**Where `next` is non-null, Enter is a widening, not a replacement.** It searches for the
best release of that episode; when the search returns nothing usable, it falls back to
resuming the stored torrent rather than failing. That keeps the pane working offline and
when a title has aged out of every source.

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

`src/web/static/` — on both the For You card and the Continue Watching row, the primary
click becomes play and a secondary button keeps today's behaviour ("search this title",
and on Continue Watching also "resume this torrent").

- **The episode ref comes from the wire, not from a local import.** Continue Watching
  rows already carry `next: nextEpisode(item)` (`src/web/routes.ts:824`), which is what
  builds the `PickIntent`. `src/web/static/` must not import `src/core/streamHistory.ts`
  — it pulls in `node:fs` and would break the browser bundle. `savedModel.ts:285`
  records this and the copy-then-drift bugs behind it.
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

- **The pack trap, at equal resolution.** Candidates = `Harrowgate.S03.1080p` (large) and
  `Harrowgate.S03E02.1080p` (small), intent = episode 2. The **episode wins** despite
  being smaller — intent breaks the tie once resolution is level.
- **Resolution outranks intent.** Candidates = `Harrowgate.S03.2160p` (pack) and
  `Harrowgate.S03E02.720p` (episode), intent = episode 2, no cap. The **pack wins**, and
  `fromPack` is true. With `maxResolution: "1080p"` the same set picks the 720p episode,
  because the cap removes the pack first.
- **Resolution outranks size.** `Kestrel.2010.1080p.BluRay.REMUX` at 42 GB versus
  `Kestrel.2010.2160p.WEB-DL` at 15 GB, no cap: the **2160p wins**.
- **Size only breaks a resolution tie.** Two 2160p releases, the larger wins.
- **A requirement outranks resolution.** `require: ["atmos"]`, with a 1080p Atmos release
  and a 2160p release without it: the **1080p wins**, and `relaxed` is empty.
- **Cap respected.**
- **Over-cap relaxation picks the closest, not the biggest.** `maxResolution: "1080p"`
  with only a 2160p and a 4320p release available returns the **2160p**, with `overCap`
  set. The regression this guards against is the descending rank handing a capped user
  the largest file in the list.
- **Unparseable resolution is asymmetric** — a candidate with no resolution token is not
  dropped by a `1080p` cap (step 3), but loses to any candidate with a stated resolution
  (step 5), and is chosen when it is the only one.
- **`rankReleases` returns every survivor in order**, and `pickBestRelease` equals its
  head — the property C depends on.

Intent construction gets its own cases, since it is where the two triggers differ:

- Continue Watching builds `{ kind: "episode" }` from the row's `next`.
- **A Continue Watching row whose `next` is null never reaches the picker** — asserted
  for both a film and a series watched via a season pack, since `nextEpisode` returns
  null for each. The existing resume path runs and `pickBestRelease` is not called.
- For You builds `{ kind: "film" }` for a film and season 1 episode 1 for a series.
- **Continue Watching falls back to resuming the stored torrent** when the search
  returns no usable candidate — asserted by a case where `pickBestRelease` returns
  `null` and the existing resume path is still invoked.
- **Exclusion is hard**: excluding `dv` with only `Tin.Rivers…DV…` available returns
  `null`, not a fallback.
- **Requirement is soft**: requiring `atmos` with none available returns the best
  candidate and `relaxed: ["atmos"]`.
- **Rarest requirement drops first** when two are set and neither is fully satisfiable.
- **Deterministic tiebreak** on equal size and seeders.
- **`dd` matches both `DD5.1` and `DDP5.1`.**
- **`dd` is not fooled by a release group.** `require: ["dd"]` against only
  `Kestrel.2010.1080p.BluRay.x264-REDDD` returns that release with
  `relaxed: ["dd"]` — the requirement was dropped, not satisfied. Asserting on
  `relaxed` rather than on which release came back is what makes this test real: with
  one candidate the winner is the same either way, so a test that only checked the
  chosen release would pass against a naive substring implementation.

Config: sanitisation tests for unknown ids, non-string entries, an invalid
`maxResolution`, and the require/exclude collision resolving in favour of exclude.

Web: a `routes.test.ts` case that `PUT /api/preferences` is read-modify-write — a
concurrent change to an unrelated config field is not clobbered. Plus `pickModel.test.ts`
for the phase machine and copy.

Front-end wiring is verified by running it (`npm run dev -- serve --web`), per the
no-jsdom rule. `npm run build` is the check that `releasePick.ts` pulled no `node:*` into
the browser bundle — it must be run.

## 5. Documentation

- `README.md`: the preference, what Enter now does on **both** For You and Continue
  Watching, and the season-pack consequence named under Risks.
- The web UI's own limitations list — confirm it is still true once settings are
  web-editable.

## Risks

**Enter changes meaning in two panes**, and this is the only behavioural regression here.
On For You, someone used to Enter-then-browse now gets a player. On Continue Watching the
change is subtler and therefore easier to get wrong: on a row that names a next episode,
Enter used to resume *the torrent you already had* and now searches for the *next
episode*. Someone who wanted to finish what they were part-way through will find it starts
the following one instead.

Mitigated by `s` and the secondary buttons being visible in the footer hints and on the
rows, by Continue Watching keeping an explicit "resume this torrent" action, and by the
fallback to resume when nothing is found. Both changes belong in the PR body rather than
buried.

**One episode can fetch a whole season.** Resolution ranks above intent, so a 2160p
season pack beats a 720p single episode. Chosen deliberately (see "Why resolution
outranks size and intent"), but it is the surprise most likely to generate a bug report:
the download is an order of magnitude larger than the thing being watched, and on
Real-Debrid a season pack is much less likely to already be cached. Two things make it
survivable — `maxResolution` is the direct lever, and the status line names the release
it chose, including its size, before playback starts. Worth a sentence in the README
rather than leaving people to discover it.

**`parse-torrent-title`'s vocabulary is the ceiling.** If it does not recognise a token,
no feature test can. That is acceptable — it is already the basis of every title lookup
in the app — but it means a preference can quietly under-match on unusual release naming.
The relax-and-report behaviour is what keeps that from being silent.
