# Saved Searches and Continue Watching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each of the four things called "watchlist" an honest name, resolve the cross-front-end divergence in what the For You action does, and then build a real Continue-watching list fed by what the user actually streamed — in both front ends.

**Architecture:** A new pure store in `src/core/` (the front-end-agnostic middle both UIs sit on) holds stream history on disk, written from three call sites: the TUI's two stream branches and the web's `startStream`. The rename is mechanical and must leave every existing assertion passing. The one behaviour change — the web's For You action adopting the terminal's — is carried by a type split so the compiler prevents the local action from being posted to reccd.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`), Vitest, Ink/React for the TUI, plain DOM for the browser bundle (tsup, `platform: "browser"`), `parse-torrent-title` for release parsing.

**Spec:** `docs/superpowers/specs/2026-07-30-saved-searches-and-continue-watching-design.md`

## Global Constraints

- **A feature ships in both front ends.** Newly written down in `CLAUDE.md` and `CONTRIBUTING.md` in this branch. Every user-facing item here lands in the TUI *and* the browser.
- **`src/web/**` must not import from `src/ui/**`** and **`src/core/**` must not import from either** — both enforced by `no-restricted-imports` in `eslint.config.js`. Share by moving code down into `src/util/` or `src/core/`.
- **`src/web/static/**` must import nothing from `node:*`**, directly or transitively. Only `npm run build` catches this (`platform: "browser"` in `tsup.web.config.ts`). Type-only imports are erased and safe.
- **No `innerHTML` / `insertAdjacentHTML` / `document.write` / `outerHTML` in `src/web/static/`.** `createElement` + `textContent` only — release names and filenames come from whoever uploaded a torrent.
- **All wire types live in `src/web/wire.ts`**; never redeclared elsewhere.
- **Config mutation is read-modify-write per request**: `loadConfig()` → change → `saveConfig()`. Never a snapshot held between requests — `serializeWrites()` only serializes within one process and `serve --web` is a separate process from any running TUI.
- **`app.ts` is DOM wiring only.** Decisions belong in pure modules (`savedModel.ts`, `reccModel.ts`, `searchModel.ts`, `resultPosters.ts`) because **there is no jsdom in this repo, deliberately**. This was caught in review twice on the previous branch.
- **Tests must never touch the user's real `~/.config/torlnk/config.json` or data directory.** Inject `loadConfigImpl` / `saveConfigImpl`, and the new `saveStreamHistoryImpl`. `deps()` in `routes.test.ts` defaults `saveConfigImpl` to a **throw** so a forgotten seam fails loudly — do the same for the new one.
- **A new TUI key means both halves of `src/ui/keymap.ts`** (`HELP_GROUPS` and `footerHints`). **A new `Store` field means a matching entry in `makeStore`** (`scripts/render-previews-impl.tsx`) or `npm run previews` breaks.
- **Never break muscle memory** (`CONTRIBUTING.md`): the `w` key keeps its binding. Only its caption changes.
- Caps: **200** stream-history entries, **50** saved searches, **100** favourites.
- Commands: `npm test`, `npm run lint`, `npm run typecheck`, `npm run build`. Single file: `npx vitest run <path>`. Single test: `npx vitest run <path> -t "<name>"`.

## Verified Facts — do not re-derive

- **`parse-torrent-title` output**, confirmed by running it:
  - `Severance.S02E04.1080p.WEB-DL.x265-GROUP` → `{title:"Severance", season:2, episode:4}`
  - `The.Bear.S03.1080p.WEB-DL` → `{title:"The Bear", season:3}` — **a season pack has NO episode**
  - `Dune.Part.Two.2024.2160p.BluRay` → `{title:"Dune Part Two", year:2024}`
- **`DownloadInput`** (`src/ui/App.tsx:126-132`) is `{ id, name, magnet, source?, sizeBytes? }` — `id` is the info hash. This is what the TUI holds at both stream sites, and it carries everything the history store needs.
- **The rename's blast radius**, by file: `store.ts` 3, `keymap.ts` 2, `Watchlist.tsx` 3, `Sidebar.tsx` 1, `App.tsx` 4, `store.test.ts` 2, `ForYou.test.tsx` 1, `wire.ts` 8, `routes.ts` 9, `routes.test.ts` 12, `app.ts` 24, `reccModel.ts` 10, `reccModel.test.ts` 4, `savedModel.ts` 21, `savedModel.test.ts` 40, `index.html` 5, `styles.css` 1, `README.md` 5. **149 total across 18 files.**
- **`dismissesPick` is `action !== "watchlist"`** (`reccModel.ts:313-315`), so the action already does not dismiss a pick.
- **`actOnPick` posts every action to `/api/recc-event`** (`app.ts:1431-1437`), and `reccEventBody` does `ACTION_EVENT[action]` unconditionally — which is why Task 6 needs the type split.
- **`Section`** is `src/ui/store.ts:14-21`; `isCategory`'s guard chain is `:26-30`; the section list is `:58`.
- **Baseline:** 1574 tests / 114 files, typecheck clean, `npm run lint` exit 0 with **one pre-existing warning** (`react-hooks/exhaustive-deps`, `src/ui/App.tsx`) that is **not yours** — leave it.

---

### Task 1: `ParsedRelease` gains `season` and `episode`

`parseRelease` already reads `p.season` / `p.episode` to compute `isSeries`, then throws both away. The history store needs them. This is a purely additive change: existing consumers destructure the fields they use and are unaffected.

**Files:**
- Modify: `src/util/release.ts` (the `ParsedRelease` interface and `parseRelease`'s return)
- Test: `src/util/release.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ParsedRelease` gains `season?: number` and `episode?: number`. Task 2 depends on both.

- [ ] **Step 1: Write the failing tests**

Append to `src/util/release.test.ts`:

```ts
describe("parseRelease — season and episode", () => {
  it("returns both for an episode release", () => {
    const p = parseRelease("Severance.S02E04.1080p.WEB-DL.x265-GROUP");
    expect(p?.title).toBe("Severance");
    expect(p?.season).toBe(2);
    expect(p?.episode).toBe(4);
  });

  it("returns season but NOT episode for a season pack", () => {
    // A pack names the season and no episode. The history store must not
    // invent episode 1 from this — see nextEpisode in Task 2.
    const p = parseRelease("The.Bear.S03.1080p.WEB-DL");
    expect(p?.title).toBe("The Bear");
    expect(p?.season).toBe(3);
    expect(p?.episode).toBeUndefined();
  });

  it("returns neither for a film", () => {
    const p = parseRelease("Dune.Part.Two.2024.2160p.BluRay");
    expect(p?.title).toBe("Dune Part Two");
    expect(p?.season).toBeUndefined();
    expect(p?.episode).toBeUndefined();
  });

  it("still classifies an episode release as a series", () => {
    // The existing isSeries behaviour must not regress: season/episode were
    // already being read for exactly this, they were just not returned.
    expect(parseRelease("Severance.S02E04.1080p")?.type).toBe("series");
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run src/util/release.test.ts -t "season and episode"
```

Expected: FAIL — `season` and `episode` do not exist on `ParsedRelease`.

- [ ] **Step 3: Add the two fields**

In `src/util/release.ts`, add to `ParsedRelease`:

```ts
  /**
   * Season and episode, when the release named them. Both optional and
   * independent: a SEASON PACK ("The.Bear.S03") yields a season with no
   * episode, so a consumer must not treat a known season as implying episode 1.
   */
  season?: number;
  episode?: number;
```

In `parseRelease`, the values are already in scope via `p`. Return them, preserving the existing `key` exactly (the key must NOT gain season/episode, or every cached OMDb lookup for a series re-fetches per episode):

```ts
  const result: ParsedRelease = { title, year, type, key };
  if (typeof p.season === "number") result.season = p.season;
  if (typeof p.episode === "number") result.episode = p.episode;
  return result;
```

- [ ] **Step 4: Run to verify pass**

```bash
npx vitest run src/util/release.test.ts
npm test
```

Expected: PASS, and the full suite unchanged at 1574 + 4 = 1578. If any other test moved, the change was not additive.

- [ ] **Step 5: Commit**

```bash
git add src/util/release.ts src/util/release.test.ts
git commit -m "feat: parseRelease returns the season and episode it already read

isSeries was computed from p.season/p.episode and both were then discarded.
The stream-history store needs them. Additive: `key` deliberately does NOT
gain them, or every OMDb lookup for a series would re-fetch per episode.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: `src/core/streamHistory.ts` — the store

**Files:**
- Create: `src/core/streamHistory.ts`
- Create: `src/core/streamHistory.test.ts`
- Modify: `src/config/paths.ts` (one new export)

**Interfaces:**
- Consumes: `ParsedRelease.season`/`.episode` (Task 1); `SourceId` from `src/sources/types`.
- Produces:
  - `interface StreamHistoryItem { key; title; year?; type?; season?; episode?; rawName; infoHash; magnet; source?; startedAt }`
  - `STREAM_HISTORY_CAP = 200`
  - `historyItemFor(input: { id: string; name: string; magnet: string; source?: SourceId }, now: number): StreamHistoryItem | null`
  - `recordStream(current: readonly StreamHistoryItem[], item: StreamHistoryItem, limit?: number): StreamHistoryItem[]`
  - `nextEpisode(item: StreamHistoryItem): { season: number; episode: number } | null`
  - `removeStreamHistory(current: readonly StreamHistoryItem[], key: string): StreamHistoryItem[]`
  - `loadStreamHistory(): Promise<StreamHistoryItem[]>`, `saveStreamHistory(items): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Create `src/core/streamHistory.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  historyItemFor,
  nextEpisode,
  recordStream,
  removeStreamHistory,
  STREAM_HISTORY_CAP,
  type StreamHistoryItem,
} from "./streamHistory";

const HASH = "a".repeat(40);

function item(over: Partial<StreamHistoryItem> = {}): StreamHistoryItem {
  return {
    key: "severance||series",
    title: "Severance",
    type: "series",
    season: 2,
    episode: 4,
    rawName: "Severance.S02E04.1080p.WEB-DL",
    infoHash: HASH,
    magnet: `magnet:?xt=urn:btih:${HASH}`,
    startedAt: 1_700_000_000_000,
    ...over,
  };
}

describe("historyItemFor", () => {
  it("builds an entry from a stream input, parsing the release name", () => {
    const built = historyItemFor(
      { id: HASH, name: "Severance.S02E04.1080p.WEB-DL.x265-GROUP", magnet: "magnet:?x", source: "eztv" },
      1_700_000_000_000,
    );
    expect(built?.title).toBe("Severance");
    expect(built?.season).toBe(2);
    expect(built?.episode).toBe(4);
    expect(built?.type).toBe("series");
    expect(built?.infoHash).toBe(HASH);
    expect(built?.rawName).toBe("Severance.S02E04.1080p.WEB-DL.x265-GROUP");
    expect(built?.startedAt).toBe(1_700_000_000_000);
    expect(built?.source).toBe("eztv");
  });

  it("returns null when the release name has no title in it", () => {
    // A name that is only quality noise gives no row to draw, and a list of
    // unparseable release names is what this feature exists to avoid.
    expect(historyItemFor({ id: HASH, name: "1080p.WEB-DL.x265", magnet: "m" }, 1)).toBeNull();
  });

  it("omits source when the caller had none", () => {
    const built = historyItemFor({ id: HASH, name: "Dune.Part.Two.2024.2160p", magnet: "m" }, 1);
    expect(built).not.toBeNull();
    expect("source" in (built as object)).toBe(false);
  });
});

describe("recordStream", () => {
  it("prepends a new title", () => {
    const out = recordStream([item({ key: "other", title: "The Bear" })], item());
    expect(out).toHaveLength(2);
    expect(out[0]?.title).toBe("Severance");
  });

  it("dedupes on key and moves the entry to the front", () => {
    const current = [item({ key: "a", title: "A" }), item({ key: "b", title: "B" })];
    const out = recordStream(current, item({ key: "b", title: "B", episode: 5 }));
    expect(out).toHaveLength(2);
    expect(out[0]?.key).toBe("b");
    expect(out[0]?.episode).toBe(5);
  });

  it("keeps the HIGHEST episode seen, so rewatching does not move next backwards", () => {
    // Watch S02E05, then rewatch S02E02. "next" must still be S02E06.
    const current = [item({ season: 2, episode: 5 })];
    const out = recordStream(current, item({ season: 2, episode: 2 }));
    expect(out[0]?.season).toBe(2);
    expect(out[0]?.episode).toBe(5);
  });

  it("advances across a season boundary", () => {
    const current = [item({ season: 1, episode: 9 })];
    const out = recordStream(current, item({ season: 2, episode: 1 }));
    expect(out[0]?.season).toBe(2);
    expect(out[0]?.episode).toBe(1);
  });

  it("still refreshes startedAt and the torrent when the episode is older", () => {
    // The user watched something, so the row must rise to the top and point at
    // the torrent they actually used, even though the episode marker does not move.
    const current = [item({ season: 2, episode: 5, startedAt: 1000, infoHash: "b".repeat(40) })];
    const out = recordStream(current, item({ season: 2, episode: 2, startedAt: 2000 }));
    expect(out[0]?.startedAt).toBe(2000);
    expect(out[0]?.infoHash).toBe(HASH);
  });

  it("caps the list, dropping the oldest", () => {
    const current = Array.from({ length: STREAM_HISTORY_CAP }, (_, i) =>
      item({ key: `k${i}`, title: `T${i}` }),
    );
    const out = recordStream(current, item({ key: "new", title: "New" }));
    expect(out).toHaveLength(STREAM_HISTORY_CAP);
    expect(out[0]?.key).toBe("new");
    expect(out.some((e) => e.key === `k${STREAM_HISTORY_CAP - 1}`)).toBe(false);
  });
});

describe("nextEpisode", () => {
  it("returns the following episode in the same season", () => {
    expect(nextEpisode(item({ season: 2, episode: 4 }))).toEqual({ season: 2, episode: 5 });
  });

  it("returns null for a film", () => {
    expect(nextEpisode(item({ type: "movie", season: undefined, episode: undefined }))).toBeNull();
  });

  it("returns null for a SEASON PACK, which names no episode", () => {
    // "The.Bear.S03" parses to season 3 with no episode. Guessing episode 1
    // would tell the user to watch something they may already have seen.
    expect(nextEpisode(item({ season: 3, episode: undefined }))).toBeNull();
  });
});

describe("removeStreamHistory", () => {
  it("drops the entry with that key and is idempotent", () => {
    const current = [item({ key: "a" }), item({ key: "b" })];
    expect(removeStreamHistory(current, "a")).toHaveLength(1);
    expect(removeStreamHistory(current, "nope")).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run src/core/streamHistory.test.ts
```

Expected: FAIL — cannot resolve `./streamHistory`.

- [ ] **Step 3: Add the path export**

In `src/config/paths.ts`, beside `historyFile`:

```ts
// Streams, not downloads. history.json is completed DOWNLOADS; this is what the
// user watched. Separate files because they are different facts — someone who
// downloads a season pack once and watches it over three weeks would otherwise
// see one list misreport the other.
export const streamHistoryFile = path.join(dataDir, "stream-history.json");
```

- [ ] **Step 4: Write the module**

Create `src/core/streamHistory.ts`:

```ts
// What the user streamed, so a Continue-watching list can exist. Lives in
// src/core because both front ends write it and eslint forbids src/web
// importing src/ui — this is the front-end-agnostic middle they share.
//
// Deliberately NOT src/download/history.ts, which is completed downloads.
import { promises as fs } from "node:fs";
import { streamHistoryFile } from "../config/paths";
import { serializeWrites, writeJsonAtomic } from "../util/atomic";
import { parseRelease } from "../util/release";
import type { SourceId } from "../sources/types";

/**
 * One title the user streamed. ONE ENTRY PER TITLE, not per stream: the list
 * answers "what am I part-way through", and twenty rows of one series is the
 * opposite of that.
 */
export interface StreamHistoryItem {
  /** `parseRelease`'s key — the group and dedupe key. */
  key: string;
  /** "Severance", never "Severance.S02E04.1080p.WEB-DL-GROUP". */
  title: string;
  year?: number;
  type?: "movie" | "series";
  /**
   * The HIGHEST season/episode seen for this title. Independent of each other:
   * a season pack names a season and no episode.
   */
  season?: number;
  episode?: number;
  /** The release it came from, so a fallback search has something specific to ask. */
  rawName: string;
  infoHash: string;
  magnet: string;
  source?: SourceId;
  /** Epoch ms of the most recent stream of this title. */
  startedAt: number;
}

export const STREAM_HISTORY_CAP = 200;

/**
 * Build an entry from whatever a front end holds when a stream starts.
 *
 * Returns null when the release name carries no title — a name that is only
 * quality noise ("1080p.WEB-DL.x265") gives no row worth drawing, and this list
 * exists precisely so the user sees titles rather than release names.
 */
export function historyItemFor(
  input: { id: string; name: string; magnet: string; source?: SourceId },
  now: number,
): StreamHistoryItem | null {
  const parsed = parseRelease(input.name);
  if (!parsed) return null;
  const out: StreamHistoryItem = {
    key: parsed.key,
    title: parsed.title,
    rawName: input.name,
    infoHash: input.id,
    magnet: input.magnet,
    startedAt: now,
  };
  if (parsed.year !== undefined) out.year = parsed.year;
  if (parsed.type !== undefined) out.type = parsed.type;
  if (parsed.season !== undefined) out.season = parsed.season;
  if (parsed.episode !== undefined) out.episode = parsed.episode;
  if (input.source !== undefined) out.source = input.source;
  return out;
}

/** True when `next` is further through the series than `prev`. */
function isLaterThan(next: StreamHistoryItem, prev: StreamHistoryItem): boolean {
  const ns = next.season ?? 0;
  const ps = prev.season ?? 0;
  if (ns !== ps) return ns > ps;
  return (next.episode ?? 0) > (prev.episode ?? 0);
}

/**
 * Fold a stream into the list: newest title first, one entry per title.
 *
 * THE EPISODE IS A HIGH-WATER MARK, not the last thing played. Rewatching
 * S02E02 after S02E05 must leave "next" at S02E06 — otherwise finishing a
 * series and dipping back into an early episode silently rewinds your progress.
 * Everything else (startedAt, the torrent, the raw name) DOES take the new
 * value, because the row should rise to the top and point at the torrent that
 * actually worked.
 */
export function recordStream(
  current: readonly StreamHistoryItem[],
  item: StreamHistoryItem,
  limit = STREAM_HISTORY_CAP,
): StreamHistoryItem[] {
  const prev = current.find((e) => e.key === item.key);
  const merged: StreamHistoryItem = prev && !isLaterThan(item, prev)
    ? { ...item, ...(prev.season !== undefined ? { season: prev.season } : {}),
        ...(prev.episode !== undefined ? { episode: prev.episode } : {}) }
    : item;
  return [merged, ...current.filter((e) => e.key !== item.key)].slice(0, limit);
}

/**
 * The episode to offer next, or null when there is nothing honest to offer.
 *
 * A SUGGESTION, never a claim the episode exists — nothing here has asked a
 * tracker. Null for a film, and null for a SEASON PACK: "The.Bear.S03" parses
 * to a season with no episode, and guessing episode 1 would point the user at
 * something they may have already watched.
 */
export function nextEpisode(item: StreamHistoryItem): { season: number; episode: number } | null {
  if (item.type !== "series") return null;
  if (item.season === undefined || item.episode === undefined) return null;
  return { season: item.season, episode: item.episode + 1 };
}

export function removeStreamHistory(
  current: readonly StreamHistoryItem[],
  key: string,
): StreamHistoryItem[] {
  return current.filter((e) => e.key !== key);
}

const write = serializeWrites();

export function saveStreamHistory(items: readonly StreamHistoryItem[]): Promise<void> {
  return write(() => writeJsonAtomic(streamHistoryFile, items.slice(0, STREAM_HISTORY_CAP)));
}

/** An unreadable or corrupt file is an empty list, exactly as `loadHistory` treats one. */
export async function loadStreamHistory(): Promise<StreamHistoryItem[]> {
  let raw: string;
  try {
    raw = await fs.readFile(streamHistoryFile, "utf8");
  } catch {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isStreamHistoryItem).slice(0, STREAM_HISTORY_CAP);
  } catch {
    return [];
  }
}

/** Drops hand-edited junk before it reaches a UI, mirroring `isFavouriteItem`. */
function isStreamHistoryItem(v: unknown): v is StreamHistoryItem {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.key === "string" && r.key.length > 0 &&
    typeof r.title === "string" && r.title.length > 0 &&
    typeof r.infoHash === "string" && r.infoHash.length > 0 &&
    typeof r.startedAt === "number"
  );
}
```

- [ ] **Step 5: Run to verify pass, and check the layering rule**

```bash
npx vitest run src/core/streamHistory.test.ts
npm run lint    # src/core must not import src/ui or src/web
npm test
```

Expected: PASS. Lint proves the layering. Suite at 1578 + 14 = 1592.

- [ ] **Step 6: Commit**

```bash
git add src/core/streamHistory.ts src/core/streamHistory.test.ts src/config/paths.ts
git commit -m "feat(core): a stream-history store both front ends can write

One entry per title, newest first, capped at 200. The episode is a
high-water mark, not the last thing played — rewatching S02E02 after S02E05
must not rewind 'next' to S02E03.

nextEpisode returns null for a season pack: 'The.Bear.S03' parses to a
season with no episode, and guessing episode 1 would point at something
already watched.

src/core because both UIs write it and eslint forbids src/web importing
src/ui. Separate from download/history.ts, which is completed downloads.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Rename in the terminal UI

16 occurrences across 7 files. Mechanical, plus one caption that was describing the wrong thing.

**Files:**
- Rename: `src/ui/components/Watchlist.tsx` → `src/ui/components/SavedSearches.tsx`
- Modify: `src/ui/store.ts` (`:14-21` union, `:26-30` guard, `:58` list)
- Modify: `src/ui/keymap.ts` (`HELP_GROUPS` `w` caption, `footerHints` section branch)
- Modify: `src/ui/components/Sidebar.tsx:17`
- Modify: `src/ui/App.tsx` (4 occurrences)
- Modify: `src/ui/store.test.ts`, `src/ui/components/ForYou.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: `Section` member `"savedSearches"` replaces `"watchlist"`. Tasks 4-10 and 9 rely on the new name.

- [ ] **Step 1: Capture the baseline**

```bash
npx vitest run src/ui/ 2>&1 | tail -3
```

Record the number. Every one of these tests must still pass with **the same assertions** — that is the check that this is a rename.

- [ ] **Step 2: Rename the component file**

```bash
git mv src/ui/components/Watchlist.tsx src/ui/components/SavedSearches.tsx
```

Inside it: `export function Watchlist()` → `export function SavedSearches()`, `section === "watchlist"` → `section === "savedSearches"`, and the `Panel title="watchlist"` → `title="saved searches"`. Leave the `x`/`Enter` behaviour and the empty-state text's *meaning* alone, but correct its wording — it currently says "Save a search with w from the results view", which is already accurate and needs no change.

- [ ] **Step 3: Rename the Section member and its guards**

`src/ui/store.ts`: `| "watchlist"` → `| "savedSearches"` in the union (`:14-21`); `section !== "watchlist"` → `section !== "savedSearches"` in `isCategory` (`:26-30`); and `"watchlist"` → `"savedSearches"` in the section list at `:58`.

- [ ] **Step 4: Fix both halves of keymap.ts**

**`HELP_GROUPS`** — the For You group's `w` entry currently reads:

```ts
      { keys: "w", label: "Add to watchlist" },
```

It calls `toggleSavedSearch(item.title)`, so the caption is describing the wrong feature. Change to:

```ts
      { keys: "w", label: "Save this title as a search" },
```

**`footerHints`** — rename the section branch:

```ts
  if (section === "savedSearches") {
    return [NAVIGATE, { keys: "↵", label: "Run" }, { keys: "x", label: "Remove" }, SWITCH, ALWAYS];
  }
```

Also search `keymap.ts` for any other `w` caption in the results group and correct it the same way if it says "watchlist".

- [ ] **Step 5: Update the sidebar, App.tsx and the tests**

`Sidebar.tsx:17`: `{ key: "watchlist", label: "Watchlist" }` → `{ key: "savedSearches", label: "Saved searches" }`.

`App.tsx`: the `<Box display={section === "watchlist" ? …}` at `:2502`, the `Watchlist` import and its JSX element, and any remaining `"watchlist"` string. The `toggleSavedSearch` callback is already correctly named — leave it.

`store.test.ts` and `ForYou.test.tsx`: update the `"watchlist"` literals. **Do not change what any test asserts** — only the section name.

- [ ] **Step 6: Verify nothing is left and nothing broke**

```bash
grep -rn "watchlist\|Watchlist" src/ui/ || echo "TUI clean"
npx vitest run src/ui/ 2>&1 | tail -3
npm run typecheck
npm run lint
```

Expected: "TUI clean", and the same test count as Step 1 with no assertion changes.

- [ ] **Step 7: Commit**

```bash
git add -A src/ui
git commit -m "refactor(ui): the Watchlist section is saved searches

It shows config.savedSearches — query strings, not things to watch. Renames
the section, component and label, and fixes the ? sheet's w caption, which
said 'Add to watchlist' for a key that calls toggleSavedSearch.

Pure rename: no assertion changed.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Rename on the web server side

29 occurrences across `wire.ts`, `routes.ts`, `routes.test.ts`.

**Files:**
- Modify: `src/web/wire.ts` (8), `src/web/routes.ts` (9), `src/web/routes.test.ts` (12)

**Interfaces:**
- Consumes: nothing.
- Produces: `SavedResponse.savedSearches` replaces `.watchlist`; `SavedSearchesRequest` replaces `WatchlistRequest`; `SavedSearchesResponse` replaces `WatchlistResponse`; route `POST /api/saved-searches` replaces `POST /api/watchlist`. Task 5 consumes all four.

- [ ] **Step 1: Rename the wire types**

In `src/web/wire.ts`: `SavedResponse.watchlist` → `savedSearches`; `WatchlistRequest` → `SavedSearchesRequest`; `WatchlistResponse` → `SavedSearchesResponse` and its `watchlist` field → `savedSearches`. Update the doc comments so they say "saved searches" — and keep the sentence explaining *why* `remove` is separate from `toggle` (a double-fired tap must not re-add), which is still true.

- [ ] **Step 2: Rename the route and handler**

In `src/web/routes.ts`: `watchlistAction` → `savedSearchesAction`; the registration `urlPath === "/api/watchlist"` → `"/api/saved-searches"`; `savedLists`'s `watchlist:` key → `savedSearches:`. The `toggleSavedSearches` import from `src/util/savedSearchList` is already correctly named.

- [ ] **Step 3: Update the route tests**

In `src/web/routes.test.ts`, rename the `describe`, the posted paths, and the asserted body keys. **Assertions keep their values** — only names change.

- [ ] **Step 4: Verify**

```bash
grep -rn "watchlist\|Watchlist" src/web/wire.ts src/web/routes.ts src/web/routes.test.ts || echo "server clean"
npx vitest run src/web/routes.test.ts 2>&1 | tail -3
npm run typecheck
```

Expected: "server clean", route tests pass with the same count.

- [ ] **Step 5: Commit**

```bash
git add src/web/wire.ts src/web/routes.ts src/web/routes.test.ts
git commit -m "refactor(web): POST /api/saved-searches, and the wire field to match

Breaking the field and path is free now — nothing outside this repo consumes
them and #53 merged hours ago. The legacy scripted API (/status, /downloads,
/add, /control) is untouched.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Rename in the browser bundle

91 occurrences across `savedModel.ts` (21), `savedModel.test.ts` (40), `app.ts` (24), `index.html` (5), `styles.css` (1). The biggest file count, entirely mechanical.

**Files:**
- Modify: `src/web/static/savedModel.ts`, `savedModel.test.ts`, `app.ts`, `index.html`, `styles.css`

**Interfaces:**
- Consumes: the Task 4 wire names.
- Produces: `savedSearchesBody`, `savedSearchesStatus`, `applySavedSearchesResponse`, `savedSearchesToggleNotice` in `savedModel.ts`; `toggleSavedSearch` / `removeSavedSearch` in `app.ts`. Task 6 calls `toggleSavedSearch`; Task 10 calls the status function.

- [ ] **Step 1: Rename the model functions and their tests**

`savedModel.ts`: `watchlistBody` → `savedSearchesBody`, `watchlistStatus` → `savedSearchesStatus`, `applyWatchlistResponse` → `applySavedSearchesResponse`, `watchlistToggleNotice` → `savedSearchesToggleNotice`, `SavedState.watchlist` → `.savedSearches`, and the notice strings "Saved to your watchlist." / "Removed from your watchlist." → "Saved to your searches." / "Removed from your searches."

`savedModel.test.ts`: rename to match. **The notice-text assertions change value here** — that is expected and is the only place in Tasks 3-5 where an assertion's value moves. Everything else keeps its value.

- [ ] **Step 2: Rename the app.ts wiring**

`toggleWatchlist` → `toggleSavedSearch`, `removeFromWatchlist` → `removeSavedSearch`, `watchlistStatusLine`/`watchlistRows` element handles → `savedSearchesStatusLine`/`savedSearchesRows`, the posted path → `/api/saved-searches`, and `renderWatchlistRow` → `renderSavedSearchRow`.

- [ ] **Step 3: Rename the markup and styles**

`index.html`: the `watchlist-status` / `watchlist-rows` ids → `saved-searches-status` / `saved-searches-rows`, and the `<h2>watchlist</h2>` heading → `saved searches`. `styles.css`: the one occurrence.

- [ ] **Step 4: Verify**

```bash
grep -rn "watchlist\|Watchlist" src/web/static/ || echo "bundle clean"
npx vitest run src/web/static/ 2>&1 | tail -3
npm run typecheck && npm run lint && npm run build
```

Expected: "bundle clean", tests pass, build passes. **Then load the page** (`npm run dev -- serve --web`) and confirm the saved pane still renders both lists — a mistyped element id fails silently at runtime, not at build time, and `el()` returns null which only shows up as a blank pane.

- [ ] **Step 5: Commit**

```bash
git add src/web/static
git commit -m "refactor(web): saved searches in the browser bundle

Element ids, model functions and the two notice strings. The notices are the
only assertion values that move in this rename — 'Saved to your watchlist.'
was describing the wrong feature.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: The For You divergence — the web adopts the terminal's behaviour

The one behaviour change in the rename half. Today the TUI's For You `w` saves the pick's title as a **search**, while the web's "watchlist" button posts `favourited` and puts it in the **Library**. Same card, same action, different result per front end.

**Files:**
- Modify: `src/web/static/reccModel.ts` (10 occurrences), `src/web/static/reccModel.test.ts` (4)
- Modify: `src/web/static/app.ts` (`actOnPick`, ~`:1431`, and the card's button loop)

**Interfaces:**
- Consumes: `toggleSavedSearch` (Task 5).
- Produces: `ReccRatingAction`, `isRatingAction`, a narrowed `ACTION_EVENT`, `reccEventBody(action: ReccRatingAction, …)`.

- [ ] **Step 1: Write the failing tests**

In `src/web/static/reccModel.test.ts`, replace the `watchlist` cases with:

```ts
describe("the card's actions", () => {
  it("maps only the three ratings to reccd events", () => {
    expect(ACTION_EVENT.watched).toBe("watched");
    expect(ACTION_EVENT.like).toBe("liked");
    expect(ACTION_EVENT.dislike).toBe("disliked");
    // A swap in this table is invisible on screen and teaches the recommender
    // the opposite of what the user said, which is why it is asserted.
    expect(Object.keys(ACTION_EVENT)).toHaveLength(3);
  });

  it("narrows rating actions and excludes the local one", () => {
    expect(isRatingAction("watched")).toBe(true);
    expect(isRatingAction("like")).toBe(true);
    expect(isRatingAction("dislike")).toBe(true);
    // saveSearch is local: it writes config.savedSearches and tells reccd
    // nothing. If it reached reccEventBody it would post `type: undefined`.
    expect(isRatingAction("saveSearch")).toBe(false);
  });

  it("still offers four actions, with saveSearch last", () => {
    expect(RECC_ACTIONS).toEqual(["watched", "like", "dislike", "saveSearch"]);
  });

  it("captions saveSearch as save search", () => {
    expect(ACTION_LABEL.saveSearch).toBe("save search");
  });

  it("does not dismiss the pick when saving a search", () => {
    // Saving a search should no more remove a pick from the feed than adding
    // to a watchlist did.
    expect(dismissesPick("saveSearch")).toBe(false);
    expect(dismissesPick("watched")).toBe(true);
    expect(dismissesPick("like")).toBe(true);
    expect(dismissesPick("dislike")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run src/web/static/reccModel.test.ts -t "the card's actions"
```

Expected: FAIL — `isRatingAction` is not exported and `ACTION_EVENT` still has four keys.

- [ ] **Step 3: Split the type**

In `src/web/static/reccModel.ts`:

```ts
/** The three actions that post a rating to reccd. */
export type ReccRatingAction = "watched" | "like" | "dislike";

/**
 * Every action a card offers: the three ratings, plus one LOCAL action.
 *
 * `saveSearch` saves the pick's title as a search — which is what the TUI's `w`
 * on a For You pick has always done. The web used to call this "watchlist" and
 * post `favourited`, so the same gesture put the pick in your Library here and
 * in your saved searches there. Same card, same button, different result
 * depending on which front end you opened.
 */
export type ReccAction = ReccRatingAction | "saveSearch";

/**
 * Intent → the event reccd is told about.
 *
 * THE MAPPING IS THE WHOLE POINT OF THIS TABLE. `like` is `"liked"` and
 * `dislike` is `"disliked"` — a swap here is invisible on screen (the button
 * still highlights, the card still leaves the list) and quietly teaches the
 * recommender the opposite of what the user said.
 *
 * `saveSearch` IS DELIBERATELY ABSENT. It is local — it writes
 * `config.savedSearches` and reccd hears nothing. Keying it here would let
 * `reccEventBody` post `type: undefined`, which is why the record is typed on
 * `ReccRatingAction` rather than `ReccAction`.
 */
export const ACTION_EVENT: Record<ReccRatingAction, PublicReccEventType> = {
  watched: "watched",
  like: "liked",
  dislike: "disliked",
};

export function isRatingAction(action: ReccAction): action is ReccRatingAction {
  return action !== "saveSearch";
}
```

Change `ACTION_LABEL` to `Record<ReccAction, string>` with `saveSearch: "save search"`, `RECC_ACTIONS` to `["watched", "like", "dislike", "saveSearch"]`, `dismissesPick` to `action !== "saveSearch"`, and `reccEventBody`'s parameter to `ReccRatingAction`.

- [ ] **Step 4: Route the local action in app.ts**

In `actOnPick`, branch before the fetch:

```ts
async function actOnPick(action: ReccAction, item: PublicRecommendation): Promise<void> {
  // The local action never reaches reccd. Its title is the pick's own, exactly
  // as the TUI's `w` uses `item.title` — not a release name.
  if (!isRatingAction(action)) {
    const title = item.title.trim();
    if (!title) {
      showNotice("That pick has no title to save.");
      return;
    }
    await toggleSavedSearch(title);
    return;
  }
  // …existing rating path, unchanged…
}
```

Add `isRatingAction` to the `./reccModel` import.

- [ ] **Step 5: Run to verify pass**

```bash
npx vitest run src/web/static/reccModel.test.ts
npm test && npm run typecheck && npm run lint && npm run build
```

Expected: PASS. The typecheck is doing real work here — if `reccEventBody` were still typed on `ReccAction` it would fail on the narrowed `ACTION_EVENT`.

- [ ] **Step 6: Verify the divergence is actually closed — both surfaces**

```bash
npm run dev -- serve --web
```

In the browser: open For You, click **save search** on a pick, then open **saved** and confirm the pick's title is in saved searches (not Library). Then in the TUI: press `w` on a For You pick and confirm it lands in the same place. **Both must agree — that is the whole point of this task, and only a two-surface check proves it.**

- [ ] **Step 7: Commit**

```bash
git add src/web/static/reccModel.ts src/web/static/reccModel.test.ts src/web/static/app.ts
git commit -m "fix(web): For You's save-search action matches the terminal's

The web's 'watchlist' button posted favourited, putting the pick in Library,
while the TUI's w on the same card saved the title as a search. Same gesture,
different result per front end.

The web adopts the terminal's behaviour. ReccRatingAction is split out so the
compiler prevents the local action reaching reccEventBody, which would have
posted type: undefined.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Record history at all three write points

**Files:**
- Modify: `src/ui/App.tsx` (the two `started` sites, ~`:1161` and ~`:1308`)
- Modify: `src/web/routes.ts` (`startStream`, plus a new `WebDeps` seam)
- Modify: `src/web/routes.test.ts`

**Interfaces:**
- Consumes: `historyItemFor`, `recordStream`, `loadStreamHistory`, `saveStreamHistory` (Task 2).
- Produces: `WebDeps.loadStreamHistoryImpl?`, `WebDeps.saveStreamHistoryImpl?`.

- [ ] **Step 1: Write the failing tests**

Append to `src/web/routes.test.ts`. Extend the local `deps()` to default the new seams — `saveStreamHistoryImpl` to a **throw**, for the same reason `saveConfigImpl` throws (the real one writes the developer's own data directory):

```ts
    loadStreamHistoryImpl: async () => [],
    saveStreamHistoryImpl: async () => {
      throw new Error("test must inject saveStreamHistoryImpl");
    },
```

```ts
describe("POST /api/stream — records stream history", () => {
  const HASH = "c".repeat(40);

  it("records the title and posts started to reccd", async () => {
    const saved: StreamHistoryItem[][] = [];
    const events: ReccEvent[] = [];
    const res = await handleWebApi(
      deps({
        loadConfigImpl: async () => ({
          ...defaultConfig, downloadDir: "/tmp/dl", reccUrl: "http://localhost:4100",
        }),
        loadStreamHistoryImpl: async () => [],
        saveStreamHistoryImpl: async (items) => { saved.push([...items]); },
        postEventImpl: async (_c, e) => { events.push(e); },
      }),
      "POST", "/api/stream", new URLSearchParams(), undefined,
      JSON.stringify({ infoHash: HASH, name: "Severance.S02E04.1080p.WEB-DL", confirm: true }),
    );

    expect(res.status).toBeLessThan(500);
    expect(saved[0]?.[0]?.title).toBe("Severance");
    expect(saved[0]?.[0]?.episode).toBe(4);
    // The web posted NO started event before this change — a browser stream
    // taught reccd nothing about having begun.
    expect(events).toEqual([
      expect.objectContaining({ type: "started", rawName: "Severance.S02E04.1080p.WEB-DL" }),
    ]);
  });

  it("does not write history for a name with no title in it", async () => {
    const saved: StreamHistoryItem[][] = [];
    await handleWebApi(
      deps({
        loadStreamHistoryImpl: async () => [],
        saveStreamHistoryImpl: async (items) => { saved.push([...items]); },
      }),
      "POST", "/api/stream", new URLSearchParams(), undefined,
      JSON.stringify({ infoHash: HASH, name: "1080p.WEB-DL.x265", confirm: true }),
    );
    expect(saved).toHaveLength(0);
  });

  it("survives a history write that rejects", async () => {
    // History is a convenience. It must never take a stream down with it.
    const res = await handleWebApi(
      deps({
        loadStreamHistoryImpl: async () => [],
        saveStreamHistoryImpl: async () => { throw new Error("disk full"); },
      }),
      "POST", "/api/stream", new URLSearchParams(), undefined,
      JSON.stringify({ infoHash: HASH, name: "Severance.S02E04.1080p", confirm: true }),
    );
    expect(res.status).toBeLessThan(500);
  });
});
```

Add `type StreamHistoryItem` from `../core/streamHistory` and `type ReccEvent` from `../recc/client` to the imports if absent.

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run src/web/routes.test.ts -t "records stream history"
```

Expected: FAIL — the seams do not exist and nothing is written.

- [ ] **Step 3: Add the seams and the write**

In `WebDeps`, beside `saveConfigImpl`:

```ts
  loadStreamHistoryImpl?: () => Promise<StreamHistoryItem[]>;
  /** Injected for the reason `saveConfigImpl` is: the real one writes the developer's own data dir. */
  saveStreamHistoryImpl?: (items: readonly StreamHistoryItem[]) => Promise<void>;
```

In `startStream`, after the session resolves successfully, add:

```ts
  // History and the reccd `started` event, both fire-and-forget. The TUI has
  // posted `started` from its two stream branches all along; the web posted
  // nothing, so a browser stream taught the recommender nothing about having
  // begun. Recorded when the session RESOLVES — the moment the user asked to
  // watch something — not when a file is picked.
  void recordStreamStart(deps, body.infoHash, body.name ?? "");
```

and a helper in the same file:

```ts
async function recordStreamStart(deps: WebDeps, infoHash: string, name: string): Promise<void> {
  const item = historyItemFor({ id: infoHash, name, magnet: buildMagnet(infoHash, name) }, Date.now());
  // No title in the release name means no row worth drawing.
  if (item) {
    try {
      const current = await (deps.loadStreamHistoryImpl ?? loadStreamHistory)();
      await (deps.saveStreamHistoryImpl ?? saveStreamHistory)(recordStream(current, item));
    } catch {
      // A convenience list must never take a stream down with it.
    }
  }
  const config = await (deps.loadConfigImpl ?? loadConfig)();
  const reccConfig = resolveReccConfig(config);
  if (!reccConfig.reccUrl || !name) return;
  const event: ReccEvent = { type: "started", rawName: name, ts: Date.now(), source: "torlink" };
  void (deps.postEventImpl ?? postEvent)(reccConfig, event).catch(() => {});
}
```

- [ ] **Step 4: Add the TUI's two write points**

In `src/ui/App.tsx`, at **both** `started` sites (~`:1161` and ~`:1308`), directly after the existing `postEvent` call:

```ts
          void recordStreamHistory(input);
```

and one `useCallback` beside the other stream helpers:

```ts
  // The same store the web writes, from src/core so neither front end owns it.
  // Fire-and-forget: a convenience list must never interrupt a stream.
  const recordStreamHistory = useCallback(async (input: DownloadInput) => {
    const item = historyItemFor(input, Date.now());
    if (!item) return; // no title in the release name, so no row to draw
    try {
      const current = await loadStreamHistory();
      const next = recordStream(current, item);
      await saveStreamHistory(next);
      setStreamHistory(next);
    } catch {
      /* ignore — see above */
    }
  }, []);
```

`setStreamHistory` is the state Task 9 adds; add the `useState` for it here so both tasks stay independently testable:

```ts
  const [streamHistory, setStreamHistory] = useState<StreamHistoryItem[]>([]);
```

Load it once on mount alongside the other persisted state.

- [ ] **Step 5: Run to verify pass**

```bash
npx vitest run src/web/routes.test.ts
npm test && npm run typecheck && npm run lint
```

Expected: PASS.

- [ ] **Step 6: Verify by hand in both front ends**

Stream something in the TUI, then something else in the browser. Confirm `stream-history.json` gains an entry for each with a **parsed title**, not a release name:

```bash
cat "$(node -e 'console.log(require("env-paths")("torlink").data)')/stream-history.json" | jq '.[0] | {title,season,episode,startedAt}'
```

- [ ] **Step 7: Commit**

```bash
git add src/ui/App.tsx src/web/routes.ts src/web/routes.test.ts
git commit -m "feat: record what was streamed, from both front ends

Three write points into one src/core store: the TUI's two stream branches
and the web's startStream. The web also gains the reccd 'started' event it
never posted — a browser stream taught the recommender nothing about having
begun, which is a parity bug this surfaced.

Fire-and-forget both sides: a convenience list must never take a stream
down with it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: `GET /api/saved` reports Continue watching

**Files:**
- Modify: `src/web/wire.ts`, `src/web/routes.ts` (`savedLists`), `src/web/routes.test.ts`

**Interfaces:**
- Consumes: `loadStreamHistory`, `nextEpisode`, `StreamHistoryItem` (Task 2); `loadStreamHistoryImpl` (Task 7).
- Produces: `PublicStreamHistoryItem`, `SavedResponse.continueWatching`. Task 10 renders it.

- [ ] **Step 1: Write the failing test**

```ts
describe("GET /api/saved — continueWatching", () => {
  it("reports titles with their next episode, and no magnets", async () => {
    const res = await handleWebApi(
      deps({
        loadStreamHistoryImpl: async () => [
          { key: "severance||series", title: "Severance", type: "series", season: 2, episode: 4,
            rawName: "Severance.S02E04.1080p", infoHash: "a".repeat(40),
            magnet: `magnet:?xt=urn:btih:${"a".repeat(40)}`, startedAt: 1_700_000_000_000 },
          { key: "the bear||series", title: "The Bear", type: "series", season: 3,
            rawName: "The.Bear.S03.1080p", infoHash: "b".repeat(40),
            magnet: `magnet:?xt=urn:btih:${"b".repeat(40)}`, startedAt: 1_600_000_000_000 },
        ],
      }),
      "GET", "/api/saved", new URLSearchParams(), undefined, "",
    );

    const body = res.json as SavedResponse;
    expect(body.continueWatching).toHaveLength(2);
    expect(body.continueWatching[0]).toEqual({
      key: "severance||series", title: "Severance", type: "series",
      season: 2, episode: 4, next: { season: 2, episode: 5 },
      rawName: "Severance.S02E04.1080p", infoHash: "a".repeat(40),
      startedAt: 1_700_000_000_000,
    });
    // A season pack names no episode, so there is no honest next to offer.
    expect(body.continueWatching[1]?.next).toBeNull();
    // Same exclusion as PublicFavourite: playing goes through
    // POST /api/stream { infoHash, name }, which rebuilds the magnet.
    expect(JSON.stringify(body)).not.toContain("magnet:");
  });

  it("answers an empty list when nothing has been streamed", async () => {
    const res = await handleWebApi(deps(), "GET", "/api/saved", new URLSearchParams(), undefined, "");
    expect((res.json as SavedResponse).continueWatching).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run src/web/routes.test.ts -t "continueWatching"
```

Expected: FAIL — the field does not exist.

- [ ] **Step 3: Add the wire type**

```ts
/**
 * One title the user is part-way through, as `GET /api/saved` sends it.
 *
 * The MAGNET is absent for the reason it is absent from `PublicFavourite`:
 * playing goes through `POST /api/stream { infoHash, name }`, which rebuilds it
 * server-side, so shipping it would be tracker URLs on the wire to no end.
 *
 * `next` is computed server-side by `nextEpisode` and is a SUGGESTION — null
 * for a film and for a season pack, which names a season but no episode.
 */
export interface PublicStreamHistoryItem {
  key: string;
  title: string;
  year?: number;
  type?: "movie" | "series";
  season?: number;
  episode?: number;
  next: { season: number; episode: number } | null;
  rawName: string;
  infoHash: string;
  startedAt: number;
}
```

Add `continueWatching: PublicStreamHistoryItem[]` to `SavedResponse`.

- [ ] **Step 4: Populate it**

Add an exported mapper beside `toPublicFavourite` and use it in `savedLists`:

```ts
export function toPublicStreamHistoryItem(item: StreamHistoryItem): PublicStreamHistoryItem {
  const out: PublicStreamHistoryItem = {
    key: item.key, title: item.title, rawName: item.rawName,
    infoHash: item.infoHash, startedAt: item.startedAt, next: nextEpisode(item),
  };
  if (item.year !== undefined) out.year = item.year;
  if (item.type !== undefined) out.type = item.type;
  if (item.season !== undefined) out.season = item.season;
  if (item.episode !== undefined) out.episode = item.episode;
  return out;
}
```

- [ ] **Step 5: Run to verify pass**

```bash
npx vitest run src/web/routes.test.ts && npm test && npm run typecheck
```

Expected: PASS. Existing `SavedResponse` assertions using `toEqual` need `continueWatching: []` added — **add the field, do not weaken `toEqual` to `toMatchObject`**, which would stop those tests catching unexpected fields.

- [ ] **Step 6: Commit**

```bash
git add src/web/wire.ts src/web/routes.ts src/web/routes.test.ts
git commit -m "feat(web): GET /api/saved reports continueWatching

next is computed server-side and is null for a film and for a season pack,
which names a season but no episode — guessing episode 1 there would point
the user at something already watched. No magnet on the wire, same as
PublicFavourite.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: The terminal UI's Continue watching pane

**Files:**
- Create: `src/ui/components/ContinueWatching.tsx`
- Modify: `src/ui/store.ts` (`Section`, `isCategory`, the section list), `src/ui/components/Sidebar.tsx`, `src/ui/keymap.ts` (`footerHints`), `src/ui/App.tsx`, `scripts/render-previews-impl.tsx`

**Interfaces:**
- Consumes: `streamHistory` state and `recordStreamHistory` (Task 7); `nextEpisode`, `removeStreamHistory`, `saveStreamHistory` (Task 2); `streamResult` (existing, `App.tsx:1254`).
- Produces: `Store.streamHistory`, `Store.openStreamHistory`, `Store.removeStreamHistory`.

- [ ] **Step 1: Add the section**

`store.ts`: `| "continueWatching"` in the `Section` union, `section !== "continueWatching"` in `isCategory`'s chain, and `"continueWatching"` in the section list. Add the three `Store` fields:

```ts
  streamHistory: StreamHistoryItem[];
  openStreamHistory: (item: StreamHistoryItem) => void;
  removeStreamHistory: (key: string) => void;
```

`Sidebar.tsx`: `{ key: "continueWatching", label: "Continue watching" }` above the `savedSearches` entry — it is the thing a returning user wants first.

`keymap.ts` `footerHints`: a branch matching the library's shape:

```ts
  if (section === "continueWatching") {
    return [NAVIGATE, { keys: "↵", label: "Play" }, { keys: "x", label: "Remove" }, SWITCH, ALWAYS];
  }
```

No `HELP_GROUPS` change: no new key is introduced.

- [ ] **Step 2: Add the makeStore entries**

In `scripts/render-previews-impl.tsx`, add `streamHistory: []`, `openStreamHistory: () => {}`, `removeStreamHistory: () => {}`. **Skipping this breaks `npm run previews`** and therefore the README screenshots — the rule `CONTRIBUTING.md` records and `#6`'s `copyMagnet` noop exists to demonstrate.

- [ ] **Step 3: Write the component**

Create `src/ui/components/ContinueWatching.tsx`, modelled on `Favourites.tsx` — same `useInput` shape, same `Panel`, same `wrapStep` cursor:

```tsx
import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { useStore } from "../store";
import { Panel } from "./Panel";
import { wrapStep } from "../move";
import { COLOR, GUTTER, ICON } from "../theme";
import { nextEpisode, type StreamHistoryItem } from "../../core/streamHistory";
import { cleanText, truncate } from "../../util/format";

/** "next S02E05", or "" when there is nothing honest to offer. */
function nextLabel(item: StreamHistoryItem): string {
  const next = nextEpisode(item);
  if (!next) return "";
  return `next S${String(next.season).padStart(2, "0")}E${String(next.episode).padStart(2, "0")}`;
}

export function ContinueWatching() {
  const { streamHistory, openStreamHistory, removeStreamHistory, region, section, contentWidth, listRows } = useStore();
  const focused = region === "content" && section === "continueWatching";
  const [cursor, setCursor] = useState(0);
  const clamped = Math.min(cursor, Math.max(0, streamHistory.length - 1));

  useInput(
    (input, key) => {
      if (key.upArrow || input === "k") setCursor(wrapStep(clamped, -1, streamHistory.length));
      else if (key.downArrow || input === "j") setCursor(wrapStep(clamped, 1, streamHistory.length));
      else if (key.return) {
        const item = streamHistory[clamped];
        if (item) openStreamHistory(item);
      } else if (input === "x") {
        const item = streamHistory[clamped];
        if (item) removeStreamHistory(item.key);
      }
    },
    { isActive: focused && streamHistory.length > 0 },
  );

  const nameW = Math.max(10, contentWidth - 24);

  return (
    <Panel title="continue watching" width={contentWidth} focused={focused} height={Math.max(5, listRows - 1)}>
      {streamHistory.length === 0 ? (
        <Text dimColor>Stream something and it will show up here.</Text>
      ) : (
        <Box flexDirection="column">
          {streamHistory.map((item, index) => {
            const here = focused && index === clamped;
            const next = nextLabel(item);
            return (
              <Box key={item.key}>
                <Box width={GUTTER} flexShrink={0}>
                  <Text color={COLOR.accent}>{here ? ICON.pointer : ""}</Text>
                </Box>
                <Box flexGrow={1} minWidth={0}>
                  <Text color={here ? COLOR.accent : undefined} dimColor={!here} bold={here} wrap="truncate-end">
                    {truncate(cleanText(item.title), nameW)}
                  </Text>
                </Box>
                {next ? (
                  <Box flexShrink={0} marginLeft={1}>
                    <Text dimColor>{next}</Text>
                  </Box>
                ) : null}
              </Box>
            );
          })}
        </Box>
      )}
    </Panel>
  );
}
```

- [ ] **Step 4: Wire it in App.tsx**

Import the component, render it in a `<Box display={section === "continueWatching" ? "flex" : "none"}>` beside the others, and add the two store callbacks:

```ts
  // Replay the remembered torrent. `streamResult` is the same path a search hit
  // takes, so a dead swarm surfaces the same way it does anywhere else.
  const openStreamHistory = useCallback(
    (item: StreamHistoryItem) => {
      streamResult({ id: item.infoHash, name: item.rawName, magnet: item.magnet, source: item.source });
    },
    [streamResult],
  );

  const removeStreamHistoryEntry = useCallback((key: string) => {
    setStreamHistory((prev) => {
      const next = removeStreamHistory(prev, key);
      void saveStreamHistory(next);
      return next;
    });
  }, []);
```

Expose all three through the store provider.

- [ ] **Step 5: Verify**

```bash
npm test && npm run typecheck && npm run lint
npm run previews    # proves the makeStore entries are right
```

Then run the TUI, stream something, and confirm the row appears under **Continue watching** with its next episode, `Enter` replays it, and `x` removes it.

- [ ] **Step 6: Commit**

```bash
git add -A src/ui scripts/render-previews-impl.tsx
git commit -m "feat(ui): a Continue watching section

Titles you are part-way through, newest first, with the next episode where
one can honestly be offered. Enter replays the remembered torrent through
the same streamResult path a search hit takes; x forgets the row.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: The browser's Continue watching strip

**Files:**
- Modify: `src/web/static/savedModel.ts`, `savedModel.test.ts`, `app.ts`, `index.html`, `styles.css`

**Interfaces:**
- Consumes: `PublicStreamHistoryItem`, `SavedResponse.continueWatching` (Task 8).
- Produces: `continueWatchingSub`, `continueWatchingStatus`, `SavedState.continueWatching`.

- [ ] **Step 1: Write the failing tests**

Note the fixture is declared at **module scope**, not inside the first `describe` — both blocks below use it.

```ts
const base: PublicStreamHistoryItem = {
  key: "k", title: "Severance", type: "series", season: 2, episode: 4,
  next: { season: 2, episode: 5 }, rawName: "Severance.S02E04.1080p",
  infoHash: "a".repeat(40), startedAt: 1_700_000_000_000,
};
// Exactly 86,400,000 ms after `base.startedAt`, so "1 day ago" is arithmetic
// rather than a guess about how the formatter rounds.
const A_DAY_LATER = 1_700_086_400_000;

describe("continueWatchingSub", () => {
  it("reports the last episode and the next one", () => {
    expect(continueWatchingSub(base, A_DAY_LATER)).toBe("1 day ago · last S02E04 · next S02E05");
  });

  it("omits next when there is none to offer", () => {
    // A season pack, or a film.
    expect(continueWatchingSub({ ...base, next: null }, A_DAY_LATER)).toBe("1 day ago · last S02E04");
  });

  it("says only the age for a film", () => {
    expect(
      continueWatchingSub(
        { ...base, type: "movie", season: undefined, episode: undefined, next: null },
        A_DAY_LATER,
      ),
    ).toBe("1 day ago");
  });
});

describe("continueWatchingFallbackQuery", () => {
  it("asks for the next episode when there is one", () => {
    // The remembered torrent is dead, so we search — and searching for the
    // episode you have NOT seen beats searching for the one you just watched.
    expect(continueWatchingFallbackQuery(base)).toBe("Severance S02E05");
  });

  it("asks for the bare title when there is no next episode", () => {
    // A season pack that named no episode.
    expect(continueWatchingFallbackQuery({ ...base, next: null })).toBe("Severance");
  });

  it("asks for the bare title for a film", () => {
    expect(
      continueWatchingFallbackQuery({
        ...base,
        title: "Dune Part Two",
        type: "movie",
        season: undefined,
        episode: undefined,
        next: null,
      }),
    ).toBe("Dune Part Two");
  });
});

describe("continueWatchingStatus", () => {
  it("says loading before the first response, not empty", () => {
    expect(continueWatchingStatus(emptySaved())).toEqual({ text: "Loading…", show: true, tone: "dim" });
  });

  it("explains how to fill it when empty", () => {
    expect(continueWatchingStatus({ ...emptySaved(), loaded: true })).toEqual({
      text: "Stream something and it will show up here.", show: true, tone: "dim",
    });
  });

  it("hides once there are rows", () => {
    const state = { ...emptySaved(), loaded: true, continueWatching: [{ ...base }] };
    expect(continueWatchingStatus(state).show).toBe(false);
  });
});
```

Reuse the module's existing relative-time helper if one exists; if not, add `relativeAge(then, now)` with tests for "just now", "1 day ago", "2 weeks ago", and assert the exact strings.

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run src/web/static/savedModel.test.ts -t "continueWatching"
```

Expected: FAIL — neither function is exported.

- [ ] **Step 3: Add them to `savedModel.ts`**

Add `continueWatching: PublicStreamHistoryItem[]` to `SavedState` and `emptySaved()`, fold it in `applySaved` (which already takes `body: unknown` and guards with `Array.isArray`), and add the two pure functions plus `relativeAge`. `continueWatchingStatus` reuses the existing private `statusFor` helper.

- [ ] **Step 4: Add the markup and styles**

In `index.html`, above the `saved-split` div:

```html
        <div class="saved-strip">
          <h2 class="saved-heading">continue watching</h2>
          <p id="continue-status" class="empty">Loading…</p>
          <ul id="continue-rows" class="rows"></ul>
        </div>
```

In `styles.css`, a `.saved-strip { margin-bottom: 1rem; }` and nothing more — the rows reuse `.rows`/`.row`, as the two columns already do.

- [ ] **Step 5: Wire it in app.ts**

A `renderContinueRow(item)` built with `createElement` + `textContent` (a title from a release name is still a stranger's string), a play button calling `play(dashRowForPlay(item.infoHash, item.rawName))` — the helper the last branch extracted — and a remove button. Fold the rendering into `renderSaved()`.

The **fallback** is the one decision here, so it goes in `savedModel.ts`, not `app.ts`:

```ts
/** What to search for when the remembered torrent will not resolve. */
export function continueWatchingFallbackQuery(item: PublicStreamHistoryItem): string;
```

`"Severance S02E05"` when there is a next episode, else the bare title. `app.ts` calls it in `play`'s failure path.

- [ ] **Step 6: Verify**

```bash
npm test && npm run typecheck && npm run lint && npm run build
npm run dev -- serve --web
```

Confirm: the strip appears above the two columns; a streamed title shows with its next episode; play replays it; remove forgets it; and with an empty history the strip says "Stream something and it will show up here." rather than "Loading…".

- [ ] **Step 7: Commit**

```bash
git add src/web/static
git commit -m "feat(web): a Continue watching strip above the saved lists

Full-width above the two columns rather than a fifth top-level tab — five
tabs is where this nav stops working on a phone, which the previous branch
already recorded. The fallback query is a pure function, not an app.ts
conditional.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 11: Documentation

**Files:**
- Modify: `README.md` (5 rename occurrences, plus the new feature)

- [ ] **Step 1: Rename and document**

Replace the 5 "watchlist" occurrences with "saved searches". Then add Continue watching to the `--web` feature sentence and to the TUI's section list, and state plainly what it does **not** do — there is no resume position, because playback happens in an external player or a browser tab that reports nothing back. The README already lists "no resume position" as a limitation; make sure it still reads correctly next to a feature called Continue watching, since a reader could otherwise expect one.

- [ ] **Step 2: Verify no stale references anywhere**

```bash
grep -rn "watchlist\|Watchlist" src README.md CLAUDE.md CONTRIBUTING.md docs/superpowers/specs/2026-07-30-*.md || echo "no stale references"
```

Expected: only the **spec** may still contain the word, because it documents the rename's history. Everything in `src/` and `README.md` must be clean.

- [ ] **Step 3: Full verification**

```bash
npm test && npm run typecheck && npm run lint && npm run build && npm run previews
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: saved searches, and Continue watching

Also checks the existing 'no resume position' limitation still reads
correctly beside a feature called Continue watching — a reader could
otherwise reasonably expect one.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Final Verification

- [ ] `npm test && npm run typecheck && npm run lint && npm run build && npm run previews`
- [ ] **No stale name anywhere in shipped code:** `grep -rn "watchlist\|Watchlist" src README.md` returns nothing.
- [ ] **No XSS sink introduced:** `grep -rn "innerHTML\|insertAdjacentHTML\|document.write\|outerHTML" src/web/static` returns only the prohibition comments.
- [ ] **Layering intact:** `grep -rn 'from "\.\./ui/\|from "\.\./\.\./ui/' src/web src/core` returns nothing (lint also enforces it).
- [ ] **Both front ends, the whole point:** stream one title in the TUI and a different one in the browser. Both appear in **both** Continue-watching lists. Then press `w` on a For You pick in the TUI and click **save search** on a pick in the browser — both land in Saved searches. This is the check that the divergence is closed and the new feature honours the both-surfaces rule.
- [ ] **A season pack offers no next episode:** stream a `SxxE`-less pack and confirm the row shows no "next", rather than "next S03E01".
