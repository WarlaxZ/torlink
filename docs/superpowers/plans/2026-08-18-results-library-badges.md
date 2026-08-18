# Library-Aware Search Results Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show, on every search result in both front ends, whether you have already
downloaded it (full history) and whether you have already watched it (title level), plus
a "Hide downloaded" filter.

**Architecture:** Join on infoHash (downloaded) and a normalised title key (played). Two
shared pure modules in `src/util/` (`downloadState.ts` moved down, `playedState.ts` new)
are consumed by both front ends so they cannot drift. The one new backend surface is a
fetch-once `GET /api/library/downloaded` route exposing completed-download infoHashes;
live in-flight state reuses the existing SSE `StatusPayload.downloads`, and played state
reuses the `PublicStreamHistoryItem[]` the browser already fetches from `/api/saved`.

**Tech Stack:** TypeScript, React + Ink (TUI), vanilla DOM (web), vitest, esbuild.

**Spec:** `docs/superpowers/specs/2026-08-18-results-library-badges-design.md`

## Global Constraints

- **Feature ships in both front ends** (`src/ui` and `src/web`) in this change.
- **`src/web` must not import from `src/ui`**; `src/util`/`src/core` must not import from
  either front end. Shared code lives in `src/util/`.
- **No `innerHTML`/`insertAdjacentHTML`/`document.write`/`outerHTML` in `src/web/static/`** —
  build nodes with `createElement` + `textContent` (release names are attacker-controlled).
- **`src/web/static/app.ts` is DOM wiring only** — every "what to show / what to send"
  decision lives in a pure module (`searchModel.ts`, `playedState.ts`, …) with tests.
- **No jsdom:** web wiring is verified by `npm run dev -- serve --web` and by
  `npm run build` (which proves `src/web/static/` pulls in no `node:*`).
- **Test fixtures use only the invented cast:** Kestrel / Ashfall / Tin Rivers / Kepler /
  Harrowgate. Never a real title.
- **A new TUI key lands in BOTH halves of `src/ui/keymap.ts`** (`HELP_GROUPS` and `footerHints`).
- **Config writes from the web are read-modify-write per request.** (This feature only
  reads; no config writes — noted so no task adds one.)
- **Definition of done for every task's commit:** `npm test`, `npm run typecheck`,
  `npm run lint`, `npm run build` all pass. One pre-existing lint warning
  (`react-hooks/exhaustive-deps`, `src/ui/App.tsx`) is expected — leave it.
- **Chosen glyphs** (spec left these open; settle them here): owned `✓`, downloading `⤓`,
  played `▸`. New palette tokens: `--done: #9ece6a`, `--played: #73daca`.

---

### Task 1: Move `downloadState` down to `src/util`

Second consumer (the web) appears, so the helper moves down rather than being copied.
Type-only imports, so it is browser-bundle safe. Re-export from the old path so every
current TUI caller is untouched (the move `streamHistoryKey.ts` already made).

**Files:**
- Create: `src/util/downloadState.ts` (moved content)
- Create: `src/util/downloadState.test.ts` (moved test)
- Modify: `src/ui/downloadState.ts` → becomes a re-export shim
- Delete: `src/ui/downloadState.test.ts` (moved to util)

**Interfaces:**
- Produces: `downloadStateFor(hash: string, items: readonly {id:string;status:string}[], history: readonly {id:string}[]): DownloadState | null`; `deliveryMethod(...)`; `type DownloadState = "downloading"|"paused"|"failed"|"done"` — all now importable from `src/util/downloadState`.

- [ ] **Step 1: Move the module.** `git mv src/ui/downloadState.ts src/util/downloadState.ts` and `git mv src/ui/downloadState.test.ts src/util/downloadState.test.ts`. The relative type imports at the top of the module (`../download/types`, `../integrations/debrid/types`) are still correct from `src/util/` — verify the paths resolve (both are `../download/...` and `../integrations/...`, unchanged depth).

- [ ] **Step 2: Fix the test's import.** In `src/util/downloadState.test.ts` the import `from "./downloadState"` is already correct after the move — no change needed. Confirm it reads `import { downloadStateFor, deliveryMethod } from "./downloadState";`.

- [ ] **Step 3: Add the re-export shim** at `src/ui/downloadState.ts`:

```ts
// Moved to src/util/downloadState.ts so src/web/static can share it (the web bundles
// with platform:"browser"; this module imports only types, so it is safe from either
// side). Re-exported so existing src/ui callers are untouched.
export { downloadStateFor, deliveryMethod, type DownloadState } from "../util/downloadState";
```

- [ ] **Step 4: Run the suite.** Run: `npm test -- downloadState` — Expected: the moved tests PASS from their new location.

- [ ] **Step 5: Typecheck** the re-export and existing importers (`Results.tsx`, downloads list). Run: `npm run typecheck` — Expected: no errors.

- [ ] **Step 6: Commit.**

```bash
git add -A src/util/downloadState.ts src/util/downloadState.test.ts src/ui/downloadState.ts
git commit -m "refactor: move downloadState to src/util so the web can share it"
```

---

### Task 2: `src/util/playedState.ts` — title-level played index

Generalises the TUI's inline `positionFor` (series-only) to also answer "played?" for
films. Pure, no I/O, browser-safe. Derives a result's key with the same
`parseRelease`→`historyKeyFor` path the store writes with, so lookups agree by construction.

**Files:**
- Create: `src/util/playedState.ts`
- Create: `src/util/playedState.test.ts`

**Interfaces:**
- Consumes: `parseRelease` from `src/util/release`, `historyKeyFor` from `src/util/streamHistoryKey`, `normaliseTitle` from `src/util/titleKey`, `type EpisodeRef`.
- Produces:
  - `type HistoryLike = { key: string; type?: "movie"|"series"; season?: number; episode?: number }`
  - `interface PlayedIndex { series: Map<string, EpisodeRef>; titles: Set<string> }`
  - `buildPlayedIndex(history: readonly HistoryLike[]): PlayedIndex`
  - `interface PlayedState { played: boolean; upTo?: EpisodeRef }`
  - `playedStateFor(releaseName: string, index: PlayedIndex): PlayedState`
  - `seriesPosition(showKey: string, index: PlayedIndex): EpisodeRef | null` (drop-in for the TUI's `positionFor`)

- [ ] **Step 1: Write the failing test** at `src/util/playedState.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildPlayedIndex, playedStateFor, seriesPosition } from "./playedState";

// Structural rows standing in for StreamHistoryItem / PublicStreamHistoryItem.
const film = (key: string) => ({ key, type: "movie" as const });
const ep = (key: string, season: number, episode: number) => ({
  key,
  type: "series" as const,
  season,
  episode,
});

describe("buildPlayedIndex + playedStateFor", () => {
  it("marks a film played when its derived key is in history", () => {
    const idx = buildPlayedIndex([film("kestrel|2010")]);
    expect(playedStateFor("Kestrel.2010.1080p.BluRay.x264-GROUP", idx).played).toBe(true);
  });

  it("does not mark an unrelated film", () => {
    const idx = buildPlayedIndex([film("kestrel|2010")]);
    expect(playedStateFor("Ashfall.1999.1080p", idx).played).toBe(false);
  });

  it("marks a series episode played and reports the high-water episode", () => {
    const idx = buildPlayedIndex([ep("kepler|series", 2, 4)]);
    const state = playedStateFor("Kepler.S02E04.1080p.WEB-DL", idx);
    expect(state.played).toBe(true);
    expect(state.upTo).toEqual({ season: 2, episode: 4 });
  });

  it("marks a later episode of a watched series played (title-level)", () => {
    const idx = buildPlayedIndex([ep("kepler|series", 2, 4)]);
    // A different episode of the same show still counts as watched at title level.
    expect(playedStateFor("Kepler.S02E07.1080p.WEB-DL", idx).played).toBe(true);
  });

  it("exposes series position by show key for the TUI's season rows", () => {
    const idx = buildPlayedIndex([ep("harrowgate|series", 3, 5)]);
    expect(seriesPosition("harrowgate", idx)).toEqual({ season: 3, episode: 5 });
    expect(seriesPosition("kestrel", idx)).toBeNull();
  });

  it("degrades to not-played on an empty index", () => {
    const idx = buildPlayedIndex([]);
    expect(playedStateFor("Kestrel.2010.1080p.BluRay.x264-GROUP", idx).played).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails.** Run: `npm test -- playedState` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement** `src/util/playedState.ts`:

```ts
import { parseRelease } from "./release";
import { historyKeyFor } from "./streamHistoryKey";
import type { EpisodeRef } from "./resultGroup";

// A stream-history row, reduced to just what "played?" needs. Both StreamHistoryItem
// (TUI) and PublicStreamHistoryItem (web) satisfy this.
export type HistoryLike = {
  key: string;
  type?: "movie" | "series";
  season?: number;
  episode?: number;
};

export interface PlayedIndex {
  // Series keyed by the normalised title (the stored key with any trailing `|series`
  // removed) so it agrees with the results list's group key (showKeyOf).
  series: Map<string, EpisodeRef>;
  // Everything else keyed by its stored key verbatim (year included).
  titles: Set<string>;
}

const stripSeries = (key: string): string => key.replace(/\|series$/, "");

export function buildPlayedIndex(history: readonly HistoryLike[]): PlayedIndex {
  const series = new Map<string, EpisodeRef>();
  const titles = new Set<string>();
  // `?? []`-style tolerance: a partial/undefined row must degrade to "not played",
  // never throw — the same guard the TUI's positionFor documents.
  for (const item of history ?? []) {
    if (!item || typeof item.key !== "string") continue;
    if (item.type === "series") {
      if (item.season === undefined || item.episode === undefined) continue;
      series.set(stripSeries(item.key), { season: item.season, episode: item.episode });
    } else {
      titles.add(item.key);
    }
  }
  return { series, titles };
}

export interface PlayedState {
  played: boolean;
  upTo?: EpisodeRef;
}

// Derive the same key the store wrote with, then look it up. A miss is ordinary.
export function playedStateFor(releaseName: string, index: PlayedIndex): PlayedState {
  const parsed = parseRelease(releaseName);
  if (parsed.type === "series") {
    const showKey = stripSeries(historyKeyFor(parsed));
    const upTo = index.series.get(showKey);
    return upTo ? { played: true, upTo } : { played: false };
  }
  return index.titles.has(historyKeyFor(parsed)) ? { played: true } : { played: false };
}

// The TUI's season rows already hold a normalised show key; this is the drop-in for
// the old inline positionFor.
export function seriesPosition(showKey: string, index: PlayedIndex): EpisodeRef | null {
  return index.series.get(showKey) ?? null;
}
```

- [ ] **Step 4: Run to verify it passes.** Run: `npm test -- playedState` — Expected: PASS. (If `parseRelease`'s return shape lacks a field `historyKeyFor` needs, adapt the call to match `parseRelease`'s actual `{title, year?, type?, key}` output — check `src/util/release.ts`.)

- [ ] **Step 5: Commit.**

```bash
git add src/util/playedState.ts src/util/playedState.test.ts
git commit -m "feat: add playedState — title-level watched index shared by both front ends"
```

---

### Task 3: `GET /api/library/downloaded` route

Exposes completed-download infoHashes. A dedicated fetch-once route, NOT a new
`StatusPayload` field (that payload is pushed on every SSE progress tick — 500 hashes ×
every frame is unacceptable churn).

**Files:**
- Modify: `src/web/wire.ts` (add `DownloadedResponse`)
- Modify: `src/web/routes.ts` (add route guard + `downloadedLibrary` handler, near line 2315)
- Test: `src/web/routes.test.ts` (or the existing routes test file — match what's there)

**Interfaces:**
- Consumes: `deps.runtime.queue.getHistory(): HistoryItem[]` (`HistoryItem.id` is the infoHash).
- Produces: `interface DownloadedResponse { hashes: string[] }`; route `GET /api/library/downloaded` → `{ status: 200, json: DownloadedResponse }`.

- [ ] **Step 1: Add the wire type** to `src/web/wire.ts` (near the other saved/library types, ~line 915):

```ts
/**
 * `GET /api/library/downloaded`: the infoHashes of every COMPLETED download the
 * daemon still remembers (`queue.getHistory()`, capped at 500). Lower-cased so the
 * browser can match case-insensitively, like cachedHashes.
 *
 * Deliberately its own fetch-once route rather than a field on StatusPayload: that
 * payload streams over SSE on every progress tick, and 500 hashes per frame is churn
 * to no end. Live in-flight downloads already ride StatusPayload.downloads; the client
 * unions this initial set with completions it sees there.
 */
export interface DownloadedResponse {
  hashes: string[];
}
```

- [ ] **Step 2: Write the failing route test.** In the web routes test file, add:

```ts
it("GET /api/library/downloaded returns completed-download infoHashes", async () => {
  const runtime = fakeRuntime({
    history: [{ id: "AABB", name: "Kestrel.2010.1080p.BluRay.x264" }],
  });
  const res = await handleWebApi(
    { runtime, token: null } as WebDeps,
    "GET",
    "/api/library/downloaded",
    new URLSearchParams(),
    undefined,
    "",
  );
  expect(res.status).toBe(200);
  expect((res.json as DownloadedResponse).hashes).toEqual(["aabb"]);
});
```

Match the file's existing runtime/deps test helpers (grep the test file for how `handleWebApi` is already called and how a fake `runtime.queue.getHistory` is stubbed; reuse that helper rather than inventing `fakeRuntime` if one exists).

- [ ] **Step 3: Run to verify it fails.** Run: `npm test -- routes` — Expected: FAIL (404 or handler missing).

- [ ] **Step 4: Add the handler and route guard** in `src/web/routes.ts`. Handler near the other private handlers:

```ts
/** `GET /api/library/downloaded`: infoHashes of completed downloads, lower-cased. */
function downloadedLibrary(deps: WebDeps): WebResponse {
  const hashes = deps.runtime.queue.getHistory().map((h) => h.id.toLowerCase());
  return { status: 200, json: { hashes } satisfies DownloadedResponse };
}
```

Route guard alongside the other `GET` guards (after the `/api/saved` guard, ~line 2315):

```ts
  if (method === "GET" && urlPath === "/api/library/downloaded") {
    return downloadedLibrary(deps);
  }
```

Add `DownloadedResponse` to the `wire.ts` import at the top of `routes.ts`.

- [ ] **Step 5: Run to verify it passes.** Run: `npm test -- routes` — Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add src/web/wire.ts src/web/routes.ts src/web/routes.test.ts
git commit -m "feat(web): expose completed-download infoHashes via GET /api/library/downloaded"
```

---

### Task 4: `searchModel.ts` pure helpers — download/played tags, filter, count

All the browser's "what to show / what to filter" decisions, as pure tested functions.
`app.ts` (Task 6) only renders their output.

**Files:**
- Modify: `src/web/static/searchModel.ts`
- Modify: `src/web/static/searchModel.test.ts`

**Interfaces:**
- Consumes: `downloadStateFor` from `../../util/downloadState`, `playedStateFor`/`PlayedIndex` from `../../util/playedState`, `PublicSearchResult`.
- Produces:
  - `hideDownloaded: boolean` added to `SearchView` (+ default in `emptyView`)
  - `downloadTag(infoHash, live: readonly {id:string;status:string}[], downloaded: ReadonlySet<string>): DownloadState | null`
  - `playedTag(name: string, index: PlayedIndex): { text: string } | null` → `{ text: "Played" }` or `{ text: "up to E05" }`
  - `showCached(download: DownloadState | null, cached: "cached"|null): boolean` (declutter rule)
  - `visibleResults(view, reportsHealth, downloaded)` — extra param
  - `downloadedCount(results: readonly PublicSearchResult[], downloaded: ReadonlySet<string>): number`

- [ ] **Step 1: Write the failing tests** in `src/web/static/searchModel.test.ts`:

```ts
import { buildPlayedIndex } from "../../util/playedState";
// add to the existing import from "./searchModel":
//   downloadTag, playedTag, showCached, downloadedCount

describe("downloadTag", () => {
  it("reports the live queue state over history", () => {
    const live = [{ id: "aabb", status: "downloading" }];
    expect(downloadTag("aabb", live, new Set(["aabb"]))).toBe("downloading");
  });
  it("reports done when only in the downloaded set", () => {
    expect(downloadTag("aabb", [], new Set(["aabb"]))).toBe("done");
  });
  it("returns null for an untouched hash", () => {
    expect(downloadTag("ccdd", [], new Set(["aabb"]))).toBeNull();
  });
});

describe("playedTag", () => {
  it("labels a played film", () => {
    const idx = buildPlayedIndex([{ key: "kestrel|2010", type: "movie" }]);
    expect(playedTag("Kestrel.2010.1080p.BluRay.x264-GROUP", idx)).toEqual({ text: "Played" });
  });
  it("labels a series with its high-water episode", () => {
    const idx = buildPlayedIndex([{ key: "kepler|series", type: "series", season: 2, episode: 4 }]);
    expect(playedTag("Kepler.S02E04.1080p.WEB-DL", idx)).toEqual({ text: "up to E04" });
  });
  it("returns null when never played", () => {
    expect(playedTag("Ashfall.1999.1080p", buildPlayedIndex([]))).toBeNull();
  });
});

describe("showCached — declutter rule", () => {
  it("hides the cached badge once the result is downloaded", () => {
    expect(showCached("done", "cached")).toBe(false);
  });
  it("keeps the cached badge for a result you do not have", () => {
    expect(showCached(null, "cached")).toBe(true);
  });
});

describe("visibleResults hideDownloaded", () => {
  it("drops downloaded results when the flag is set", () => {
    const owned = result({ infoHash: "a".repeat(40) });
    const fresh = result({ infoHash: "b".repeat(40), name: "Ashfall.1999.1080p" });
    const v = { ...view(), hideDownloaded: true, snapshot: snapshot([owned, fresh]) };
    const out = visibleResults(v, () => true, new Set(["a".repeat(40)]));
    expect(out.map((r) => r.infoHash)).toEqual(["b".repeat(40)]);
  });
});

describe("downloadedCount", () => {
  it("counts results present in the downloaded set", () => {
    const a = result({ infoHash: "a".repeat(40) });
    const b = result({ infoHash: "b".repeat(40), name: "Ashfall.1999.1080p" });
    expect(downloadedCount([a, b], new Set(["a".repeat(40)]))).toBe(1);
  });
});
```

(Reuse the existing `result(...)`, `view(...)`, `snapshot(...)` helpers already in this test file. If `view()` builds a `SearchView`, add `hideDownloaded: false` to its literal so it stays a valid `SearchView`.)

- [ ] **Step 2: Run to verify it fails.** Run: `npm test -- searchModel` — Expected: FAIL, exports missing.

- [ ] **Step 3: Implement in `searchModel.ts`.** Add imports:

```ts
import { downloadStateFor, type DownloadState } from "../../util/downloadState";
import { playedStateFor, type PlayedIndex } from "../../util/playedState";
```

Add `hideDownloaded: boolean;` to the `SearchView` interface (after `grouped`) and
`hideDownloaded: false,` to the object `emptyView()` returns.

Then the helpers:

```ts
// Download state of one result, from the live queue plus the fetched "ever downloaded"
// set — the browser's mirror of the TUI's downloadStateFor(hash, items, history).
export function downloadTag(
  infoHash: string,
  live: readonly { id: string; status: string }[],
  downloaded: ReadonlySet<string>,
): DownloadState | null {
  return downloadStateFor(
    infoHash.toLowerCase(),
    live.map((d) => ({ id: d.id.toLowerCase(), status: d.status })),
    [...downloaded].map((id) => ({ id })),
  );
}

// Watched marker for a result, title-level. Null when never played.
export function playedTag(name: string, index: PlayedIndex): { text: string } | null {
  const state = playedStateFor(name, index);
  if (!state.played) return null;
  if (state.upTo) return { text: `up to E${String(state.upTo.episode).padStart(2, "0")}` };
  return { text: "Played" };
}

// The declutter rule: a result you already own does not need a "cached on debrid" badge.
export function showCached(download: DownloadState | null, cached: "cached" | null): boolean {
  if (!cached) return false;
  return download !== "done";
}

// How many visible results you have already downloaded, for the toolbar count.
export function downloadedCount(
  results: readonly PublicSearchResult[],
  downloaded: ReadonlySet<string>,
): number {
  return results.reduce((n, r) => (downloaded.has(r.infoHash.toLowerCase()) ? n + 1 : n), 0);
}
```

Extend `visibleResults` to drop downloaded rows when the flag is set:

```ts
export function visibleResults(
  view: SearchView,
  reportsHealth: (source: string) => boolean,
  downloaded: ReadonlySet<string> = new Set(),
): PublicSearchResult[] {
  const all = view.snapshot?.results ?? [];
  const kept = view.hideDownloaded
    ? all.filter((r) => !downloaded.has(r.infoHash.toLowerCase()))
    : all;
  return sortResults(filterResults(kept, view.hideDead, view.textFilter, reportsHealth), view.sort);
}
```

(The `= new Set()` default keeps existing `visibleResults(view, reportsHealth)` callers
compiling until Task 6 threads the set through.)

- [ ] **Step 4: Run to verify it passes.** Run: `npm test -- searchModel` — Expected: PASS.

- [ ] **Step 5: Typecheck.** Run: `npm run typecheck` — Expected: pass (watch for other `emptyView`/`SearchView` literals needing the new field).

- [ ] **Step 6: Commit.**

```bash
git add src/web/static/searchModel.ts src/web/static/searchModel.test.ts
git commit -m "feat(web): search-model helpers for downloaded/played badges, filter and count"
```

---

### Task 5: Web client data plumbing

Fetch the downloaded set, keep it fresh from SSE completions, build the played index from
the saved data the client already loads, and expose the live-download list. No badges yet
— this task just makes the data available and is verified by build + a temporary log.

**Files:**
- Modify: `src/web/static/app.ts`
- Modify: `src/web/static/dashboard.ts` (add a pure `completedDownloadHashes` helper)
- Modify: `src/web/static/dashboard.test.ts`

**Interfaces:**
- Consumes: `DownloadedResponse` (wire), `rows: DashRow[]`, `savedState.continueWatching: PublicStreamHistoryItem[]`.
- Produces (module-level in `app.ts`): `downloadedHashes: Set<string>`, `playedIndex: PlayedIndex`, and a `liveDownloadItems(): {id;status}[]` reader over `rows`.

- [ ] **Step 1: Write the failing test** for the pure completion extractor in `dashboard.test.ts`:

```ts
import { completedDownloadHashes } from "./dashboard";

describe("completedDownloadHashes", () => {
  it("returns lower-cased ids of downloads that have completed", () => {
    const payload = {
      downloads: [
        { id: "AABB", name: "Kestrel.2010.1080p", status: "completed", progress: 100, peers: 0, speed: 0 },
        { id: "CCDD", name: "Ashfall.1999.1080p", status: "downloading", progress: 40, peers: 3, speed: 1 },
      ],
      seeds: [],
    };
    expect(completedDownloadHashes(payload)).toEqual(["aabb"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails.** Run: `npm test -- dashboard` — Expected: FAIL.

- [ ] **Step 3: Implement `completedDownloadHashes`** in `dashboard.ts`:

```ts
// InfoHashes of downloads that have reached the terminal "completed" status in this
// status frame — the client unions these into its "ever downloaded" set so the badge
// stays right for a download that finishes mid-session and leaves the queue.
export function completedDownloadHashes(payload: StatusPayload): string[] {
  return (payload.downloads ?? [])
    .filter((d) => d.status === "completed")
    .map((d) => d.id.toLowerCase());
}
```

- [ ] **Step 4: Run to verify it passes.** Run: `npm test -- dashboard` — Expected: PASS.

- [ ] **Step 5: Wire the data in `app.ts`.** Add module-level state near `cachedHashes` (app.ts:1464) and `savedState` (app.ts:3790):

```ts
let downloadedHashes = new Set<string>();
let playedIndex = buildPlayedIndex([]); // rebuilt whenever saved data loads
```

Add imports at the top of `app.ts`: `buildPlayedIndex` from `../../util/playedState` and
`completedDownloadHashes` from `./dashboard`, and `DownloadedResponse` from `../wire`.

Add a fetch, modelled on `loadSaved` (app.ts:3792):

```ts
async function loadDownloaded(): Promise<void> {
  try {
    const res = await fetch("/api/library/downloaded", { headers: authHeaders() });
    if (!res.ok) return; // absence just means "no badges" — fail soft
    const body = (await readJson(res)) as DownloadedResponse;
    downloadedHashes = new Set((body.hashes ?? []).map((h) => h.toLowerCase()));
    if (isResultsViewActive()) renderResults();
  } catch {
    // leave the set as-is; a missing badge is never worth a visible error
  }
}
```

Call `loadDownloaded()` wherever `loadSaved()` is first invoked at startup (grep for
`loadSaved()` call sites). In the SSE `status` handler (app.ts:4256, right after
`rows = mergeRows(...)`), union completions and refresh badges when the set grows:

```ts
    const done = completedDownloadHashes(payload);
    if (done.some((h) => !downloadedHashes.has(h))) {
      for (const h of done) downloadedHashes.add(h);
      if (isResultsViewActive()) renderResults();
    }
```

Rebuild `playedIndex` when saved data lands — in `loadSaved`, after
`savedState = applySaved(...)`:

```ts
    playedIndex = buildPlayedIndex(savedState.continueWatching);
    if (isResultsViewActive()) renderResults();
```

Add a small live-downloads reader for Task 6 to consume:

```ts
function liveDownloadItems(): { id: string; status: string }[] {
  return rows.filter((r) => r.kind === "download").map((r) => ({ id: r.id, status: r.status }));
}
```

(`isResultsViewActive()` — reuse the existing guard the code uses to decide whether
`renderResults()` is worth calling; grep for how `renderResults` is currently gated. If
none exists, guard on the same view/route state `renderResults` already reads.)

- [ ] **Step 6: Verify the plumbing.** Temporarily add `console.log("downloaded", downloadedHashes.size)` in `loadDownloaded`, then Run: `npm run dev -- serve --web`, open the browser, run a search, and confirm the log fires with a plausible count. Remove the log.

- [ ] **Step 7: Build (proves no `node:*` leaked in via the new util imports).** Run: `npm run build` — Expected: success.

- [ ] **Step 8: Commit.**

```bash
git add src/web/static/app.ts src/web/static/dashboard.ts src/web/static/dashboard.test.ts
git commit -m "feat(web): load the downloaded set and played index for result badges"
```

---

### Task 6: Web render — downloaded/played badges, poster treatment, filter toggle

Render the badges (list + poster), apply the declutter rule, and add the "Hide downloaded"
toggle with its count. Wiring only — every decision comes from Task 4's helpers.

**Files:**
- Modify: `src/web/static/app.ts`

**Interfaces:**
- Consumes: `downloadTag`, `playedTag`, `showCached`, `downloadedCount`, `visibleResults` (Task 4); `downloadedHashes`, `playedIndex`, `liveDownloadItems` (Task 5).

- [ ] **Step 1: Add the badge appenders** next to `appendCachedBadge` (app.ts:2439):

```ts
function appendDownloadedBadge(meta: HTMLElement, result: PublicSearchResult): void {
  const state = downloadTag(result.infoHash, liveDownloadItems(), downloadedHashes);
  if (!state) return;
  const badge = document.createElement("span");
  if (state === "done") {
    badge.className = "tag-owned";
    badge.textContent = "✓ Downloaded";
  } else if (state === "downloading") {
    badge.className = "tag-downloading";
    badge.textContent = "⤓ Downloading";
  } else {
    badge.className = "tag-downloading";
    badge.textContent = state === "paused" ? "⤓ Paused" : "⚠ Failed";
  }
  meta.append(badge);
}

function appendPlayedBadge(meta: HTMLElement, result: PublicSearchResult): void {
  const tag = playedTag(result.name, playedIndex);
  if (!tag) return;
  const badge = document.createElement("span");
  badge.className = "tag-played";
  badge.textContent = `▸ ${tag.text}`;
  meta.append(badge);
}
```

- [ ] **Step 2: Call them and apply the declutter rule** where `appendCachedBadge` is
called (in both `renderResultCard` and the list-row renderer). Replace the bare
`appendCachedBadge(meta, result)` call with:

```ts
  appendDownloadedBadge(meta, result);
  appendPlayedBadge(meta, result);
  const dl = downloadTag(result.infoHash, liveDownloadItems(), downloadedHashes);
  const cached = cachedTag(result.infoHash, cachedHashes, sources?.debridCachedCheck === true);
  if (showCached(dl, cached)) {
    const badge = document.createElement("span");
    badge.className = "tag-cached";
    badge.textContent = cached!;
    meta.append(badge);
  }
```

(This inlines what `appendCachedBadge` did so the declutter predicate gates it. Remove the
old `appendCachedBadge` call at these sites; keep the function if referenced elsewhere,
else delete it.)

- [ ] **Step 3: Poster owned/watched treatment** in `renderResultCard`. After the poster
element is created, toggle classes from the same pure state:

```ts
  const dlState = downloadTag(result.infoHash, liveDownloadItems(), downloadedHashes);
  const played = playedTag(result.name, playedIndex);
  if (dlState === "done") {
    poster.classList.add("owned");
    const pin = document.createElement("span");
    pin.className = "pin";
    pin.textContent = "✓";
    poster.append(pin);
  } else if (dlState === "downloading") {
    const pin = document.createElement("span");
    pin.className = "pin dl";
    pin.textContent = "⤓";
    poster.append(pin);
  }
  if (played) {
    const bar = document.createElement("span");
    bar.className = played.text === "Played" ? "watchbar" : "watchbar partial";
    poster.append(bar);
  }
```

- [ ] **Step 4: Thread the downloaded set into the results filter.** Where
`visibleResults(view, reportsHealth)` is called for rendering, pass the set:
`visibleResults(view, reportsHealth, downloadedHashes)`.

- [ ] **Step 5: Add the "Hide downloaded" toggle + count** to the search toolbar. Find
where the existing `hideDead`/sort controls are built in `app.ts` and add, following that
exact pattern (a button that flips state and re-renders):

```ts
  const toggle = document.createElement("button");
  toggle.className = view.hideDownloaded ? "toolbar-toggle on" : "toolbar-toggle";
  toggle.type = "button";
  toggle.textContent = "Hide downloaded";
  toggle.setAttribute("role", "switch");
  toggle.setAttribute("aria-checked", String(view.hideDownloaded));
  toggle.addEventListener("click", () => {
    view = { ...view, hideDownloaded: !view.hideDownloaded };
    renderResults();
  });

  const count = document.createElement("span");
  count.className = "result-count";
  const nDown = downloadedCount(visibleResults(view, reportsHealth, downloadedHashes), downloadedHashes);
  count.textContent = `${nDown} downloaded`;
```

(Match how the toolbar actually mutates and re-renders view state — grep the `hideDead`
toggle wiring and mirror it exactly, including whether it calls `renderResults()` or a
broader `render()`.)

- [ ] **Step 6: Manual verification.** Run: `npm run dev -- serve --web`. Confirm:
downloaded results show `✓ Downloaded` + a poster pin and recede; a watched title shows a
teal bar and `▸ Played`/`▸ up to E0x`; a downloaded result shows no `⚡ cached`; the toggle
hides downloaded rows and the count reads correctly. Names with markup-ish characters
render as text (no HTML injection).

- [ ] **Step 7: Build + full suite.** Run: `npm run build && npm test && npm run typecheck && npm run lint` — Expected: all pass.

- [ ] **Step 8: Commit.**

```bash
git add src/web/static/app.ts
git commit -m "feat(web): downloaded & played badges, poster treatment, hide-downloaded toggle"
```

---

### Task 7: Web styles — badge tokens, poster pin/watchbar, toggle

**Files:**
- Modify: `src/web/static/styles.css`

- [ ] **Step 1: Add the two palette tokens** to `:root` (after `--raised`, styles.css:16):

```css
  --done: #9ece6a;   /* downloaded / owned — a third axis, not the accent budget */
  --played: #73daca; /* watched */
```

- [ ] **Step 2: Add the badge + poster classes** (near `.tag-cached`, styles.css:1128):

```css
.tag-owned { display: inline-block; margin-left: 0.5rem; color: var(--done); font-weight: 700; }
.tag-downloading { display: inline-block; margin-left: 0.5rem; color: var(--accent); font-weight: 700; }
.tag-played { display: inline-block; margin-left: 0.5rem; color: var(--played); font-weight: 600; }

/* Poster corner pin + watched bar (result-card posters). */
.result-card .poster { position: relative; }
.result-card .poster .pin {
  position: absolute; top: 0.4rem; left: 0.4rem; width: 1.4rem; height: 1.4rem;
  border-radius: 50%; background: var(--done); color: #0c1207;
  display: flex; align-items: center; justify-content: center;
  font-weight: 800; box-shadow: 0 2px 6px rgba(0,0,0,0.45);
}
.result-card .poster .pin.dl { background: var(--accent); color: #08111f; }
.result-card .poster .watchbar {
  position: absolute; left: 0; right: 0; bottom: 0; height: 0.28rem; background: var(--played);
}
.result-card .poster .watchbar.partial { right: 40%; }
/* Owned posters recede so the eye lands on what is NOT grabbed. */
.result-card .poster.owned::before {
  content: ""; position: absolute; inset: 0; background: var(--sunken);
  opacity: 0.42; pointer-events: none;
}

/* Toolbar toggle. */
.toolbar-toggle {
  border: 1px solid var(--line); border-radius: 2rem; padding: 0.3rem 0.8rem;
  background: var(--raised); color: var(--fg); cursor: pointer;
}
.toolbar-toggle.on { border-color: var(--done); color: var(--done); }
.result-count { margin-left: 0.6rem; color: var(--dim); font-size: 0.8rem; }
```

(Confirm the list-row leading glyph, if you added one in Task 6, has a matching rule; the
plan renders download state as text badges in the list, so no extra glyph column is
required there.)

- [ ] **Step 3: Manual visual check.** Run: `npm run dev -- serve --web` and confirm the
poster pin, recede-scrim, watched bar, and toggle look right in the grid and list. Confirm
the reduced-motion block (styles.css:42) still holds — no new animation was added.

- [ ] **Step 4: Commit.**

```bash
git add src/web/static/styles.css
git commit -m "style(web): tokens and styling for downloaded/played badges and toggle"
```

---

### Task 8: TUI — played marker on results

Repoint the moved import, replace inline `positionFor` with the shared index, and add a
`▸ played` marker for films (series already show "up to E0x").

**Files:**
- Modify: `src/ui/components/Results.tsx`
- Test: the existing `Results` test(s) (grep `Results*.test.tsx`)

**Interfaces:**
- Consumes: `buildPlayedIndex`, `playedStateFor`, `seriesPosition` from `../../util/playedState`; `downloadStateFor` (now re-exported from `../downloadState`, unchanged import).

- [ ] **Step 1: Replace the inline `positionFor` memo** (Results.tsx:290-301) with the
shared index:

```tsx
  const playedIndex = useMemo(() => buildPlayedIndex(streamHistory ?? []), [streamHistory]);
  const positionFor: PositionLookup = (showKey) => seriesPosition(showKey, playedIndex);
```

Add `import { buildPlayedIndex, playedStateFor, seriesPosition } from "../../util/playedState";`
(the `downloadStateFor` import path is unchanged — Task 1 kept the shim).

- [ ] **Step 2: Write the failing test** — a played film result shows the played marker.
In the Results test file, render results including a film whose title is in a stream-history
store, and assert the frame contains `▸`. Match the file's existing render harness
(`renderWithStore`/`makeTestStore` — grep the test for the exact helper) and use the
invented cast, e.g. a store whose `streamHistory` has `Kestrel` as a played movie and a
search result `Kestrel.2010.1080p.BluRay.x264`:

```tsx
it("marks a played film in the results list", () => {
  const store = makeTestStore({
    streamHistory: [{ key: "kestrel|2010", title: "Kestrel", type: "movie", /* …minimal StreamHistoryItem… */ }],
    search: { results: [result({ name: "Kestrel.2010.1080p.BluRay.x264", infoHash: "a".repeat(40) })] },
  });
  const { lastFrame } = renderWithStore(store);
  expect(lastFrame()).toContain("▸");
});
```

- [ ] **Step 3: Run to verify it fails.** Run: `npm test -- Results` — Expected: FAIL (no `▸`).

- [ ] **Step 4: Render the played marker** for a leaf film row. In the list-row draw,
next to the `stateMark` box (Results.tsx:1054-1058), add for non-group/non-season rows:

```tsx
                      {(() => {
                        const p = playedStateFor(r.name, playedIndex);
                        return p.played ? (
                          <Box marginLeft={1} flexShrink={0}>
                            <Text color={COLOR.good}>▸</Text>
                          </Box>
                        ) : null;
                      })()}
```

(Use the calm theme's teal if one exists in `COLOR`; otherwise `COLOR.good` is an
acceptable stand-in — check `src/ui/theme` for a teal token and prefer it. The series
"up to E0x" note at 1036-1042 already signals watched for season rows; optionally recolour
that note to the same teal for consistency, but that is not required for the test.)

- [ ] **Step 5: Run to verify it passes.** Run: `npm test -- Results` — Expected: PASS.

- [ ] **Step 6: Typecheck + previews.** Run: `npm run typecheck` — Expected: pass. (No new
Store field was added, so `makeStore`/`makeTestStore` need no change — confirm the test
store still builds.)

- [ ] **Step 7: Commit.**

```bash
git add src/ui/components/Results.tsx src/ui/components/Results*.test.tsx
git commit -m "feat(ui): played marker on search results, shared with the web"
```

---

### Task 9: TUI — "Hide downloaded" toggle

A new key, so it lands in both halves of `keymap.ts` and filters the results memo. Parallel
to the existing `z`/alive toggle.

**Files:**
- Modify: `src/ui/keymap.ts` (both `HELP_GROUPS` and `footerHints`)
- Modify: `src/ui/components/Results.tsx`
- Test: the `Results` test file

**Interfaces:**
- Consumes: `downloadStateFor` / `stateFor` already in `Results.tsx`.

- [ ] **Step 1: Pick the key and confirm it is free.** Use `d`. Grep the Results keypress
handler (Results.tsx:715+) and the global key handlers for an existing `input === "d"` in
the results region; if taken, use `o`. The steps below assume `d`.

- [ ] **Step 2: Add the key to BOTH halves of `keymap.ts`.** In the results `HELP_GROUPS`
hints array (near keymap.ts:60):

```ts
      { keys: "d", label: "Hide results you have downloaded" },
```

In the results-region `footerHints` return array (near keymap.ts:264):

```ts
    { keys: "d", label: "Downloaded" },
```

- [ ] **Step 3: Write the failing test** — toggling `d` hides a downloaded result. In the
Results test file, build a store whose `queue` history contains the infoHash of one of two
results, render, send `d`, and assert the downloaded result's name is gone from the frame
while the other remains. Match the file's key-input harness (grep how the existing `z`
toggle is tested, if it is; otherwise use `stdin.write("d")`).

- [ ] **Step 4: Run to verify it fails.** Run: `npm test -- Results` — Expected: FAIL.

- [ ] **Step 5: Implement the toggle.** Add state beside `aliveOnly` (Results.tsx:309):

```ts
  const [hideDownloaded, setHideDownloaded] = useState(false);
```

Handle the key beside the `z` branch (Results.tsx:717):

```ts
      } else if (input === "d") {
        setHideDownloaded((current) => !current);
        setCursor(0);
```

Apply it in the results memo (Results.tsx:312-318), after the existing
`sortResults(filterResults(...))`:

```ts
  const results = useMemo(() => {
    const cat = CATEGORIES.find((c) => c.key === section);
    const base = cat?.group
      ? search.results.filter((r) => getSource(r.source).groups?.includes(cat.group!))
      : search.results;
    const sorted = sortResults(filterResults(base, aliveOnly, textFilter), sort);
    return hideDownloaded ? sorted.filter((r) => stateFor(r.infoHash) !== "done") : sorted;
  }, [search.results, section, sort, aliveOnly, textFilter, hideDownloaded, queueItems, queueHistory]);
```

(Only `"done"` is filtered — an in-flight download stays visible so you can see its
progress. `stateFor`/`queueItems`/`queueHistory` are already defined above the memo.)

- [ ] **Step 6: Run to verify it passes.** Run: `npm test -- Results` — Expected: PASS.

- [ ] **Step 7: Full gate.** Run: `npm test && npm run typecheck && npm run lint && npm run build` — Expected: all pass (one known `exhaustive-deps` warning in `App.tsx` only).

- [ ] **Step 8: Commit.**

```bash
git add src/ui/keymap.ts src/ui/components/Results.tsx src/ui/components/Results*.test.tsx
git commit -m "feat(ui): hide-downloaded toggle on search results (key: d)"
```

---

### Task 10: Docs

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document the feature.** In the README's features/search section, add a
sentence that search results now show a downloaded (`✓`) and watched (`▸`) marker in both
front ends, and that the browser grid can hide already-downloaded results. Re-read the web
UI limitations list and delete any now-false "no download state on results" caveat.

- [ ] **Step 2: Verify no stale claim remains.** Grep `README.md` for "download" near the
web-UI limitations and confirm accuracy.

- [ ] **Step 3: Commit.**

```bash
git add README.md
git commit -m "docs: note downloaded/played result badges and the hide-downloaded filter"
```

---

## Self-Review

**Spec coverage:**
- Three-axis badges (downloaded/played vs release/swarm) → Tasks 4, 6, 7 (web), 8 (TUI). ✓
- Full download history (not just live) → Task 3 route + Task 5 fetch/augment. ✓
- Title-level played → Task 2 module, consumed in 6 and 8. ✓
- Declutter rule (hide cached when owned) → `showCached` (Task 4), applied Task 6. ✓
- Hide-downloaded filter + count → web Tasks 4/6, TUI Task 9. ✓
- Shared-module moves (layering rule) → Task 1 (downloadState), Task 2 (playedState). ✓
- No new Store field → confirmed in Tasks 5/8 (component-local state, existing store data). ✓
- Both front ends, no `src/web`→`src/ui` import, no `innerHTML`, app.ts wiring-only → Global Constraints, honoured per task. ✓
- Docs → Task 10. ✓

**Placeholder scan:** No "TBD"/"handle edge cases" left; each code step carries real code.
A few steps say "grep the existing X and mirror it" — deliberate, because the exact
toolbar/keypress harness varies and the plan names the precise anchor line to mirror.

**Type consistency:** `downloadStateFor` signature identical across Tasks 1/4/9;
`PlayedIndex`/`playedStateFor`/`seriesPosition` names identical across Tasks 2/4/6/8;
`DownloadedResponse` identical across Tasks 3/5; `hideDownloaded` field name identical
across Tasks 4/6. ✓

**Scope:** One coherent feature (result badges + filter) across both front ends —
appropriate for a single plan.
