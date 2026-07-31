# Episode Position and Per-Episode Plots (Piece B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the season tree know where you are in a show — land on the next episode, mark the position, and show each episode's own plot.

**Architecture:** Two live bugfixes first so the history store is trustworthy (one shared title normaliser; record the episode from the file a player actually opened). Then a position lookup threaded into `defaultExpandedKeys` as a function, matching the `reportsHealthLookup` idiom. Then marks, then per-episode OMDb plots. Every decision lives in a pure module under `src/util/` or `src/core/`; the renderers only draw.

**Tech Stack:** TypeScript, vitest, Ink (terminal), plain DOM + tsup (browser), OMDb.

**Spec:** `docs/superpowers/specs/2026-07-31-episode-position-and-plots-design.md`

**Base:** branch `episode-position-and-plots`, off `origin/main` at `909dc31` (Piece A merged as #67).

## Global Constraints

- **Both front ends in the same change.** `src/ui/` and `src/web/static/` (`CLAUDE.md`).
- **`src/web` must not import from `src/ui`; `src/core` must not import either.** Lint enforces the first.
- **`src/util/titleKey.ts` and `src/util/streamHistoryKey.ts` import NOTHING** — they must stay reachable from `src/web/static/**`, which may not touch a `node:*` builtin even transitively. `npm run build` is the only check that catches a violation.
- **No `innerHTML` / `insertAdjacentHTML` / `document.write` / `outerHTML` in `src/web/static/`.** `createElement` + `textContent` only. Release names and filenames are attacker-controlled.
- **`app.ts` is DOM wiring only.** A conditional deciding *what to show* or *what to send* belongs in a pure module.
- **Config/history writes are read-modify-write per request** — `load()` → change → `save()`. Never hold a snapshot across a write: `serve --web` is a separate process from any running TUI.
- **Never name a real film or show** in a test, helper, doc comment, example, or user-facing copy. Cast: `Kestrel.2010.1080p.BluRay.x264`, `Ashfall.1999.1080p`, `Tin.Rivers.2024.2160p.WEB-DL.DV.HDR.Atmos.7.1-GROUP`, `Kepler.S02E04.1080p.WEB-DL`, `Harrowgate.S03.1080p.WEB-DL`.
- **Gates before any task is done:** `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`. One known pre-existing lint warning (`react-hooks/exhaustive-deps`, `src/ui/App.tsx`) — leave it.
- **Conventional Commits.**

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `src/util/titleKey.ts` | One definition of "the same show" | **Create** |
| `src/util/titleKey.test.ts` | Its tests, incl. cross-checking the two key producers | **Create** |
| `src/util/resultGroup.ts` | Grouping, season tree, row plan — imports the shared normaliser | Modify |
| `src/util/streamHistoryKey.ts` | The history dedupe key — imports the same normaliser | Modify |
| `src/core/streamHistory.ts` | `recordPlayedFile` | Modify |
| `src/ui/App.tsx` | Terminal: call `recordPlayedFile` on player launch; pass the position lookup | Modify |
| `src/web/routes.ts` | Browser: same, on the `"watched"` action; `/api/title` season/episode | Modify |
| `src/ui/components/Results.tsx` | Terminal: seed from position, select next-up, draw marks | Modify |
| `src/web/static/app.ts` | Browser: same | Modify |
| `src/recc/omdb.ts` | `&Season=`/`&Episode=` | Modify |
| `src/ui/hooks/useTitlePreview.ts` | Season/episode in `MetaQuery` **and in the cache key** | Modify |

---

### Task 1: One definition of "the same show"

Fixes a live bug: streaming `[Judas] Harrowgate S03E01` then `Harrowgate S03E02` leaves **two** Continue-watching rows for one show.

**Files:**
- Create: `src/util/titleKey.ts`, `src/util/titleKey.test.ts`
- Modify: `src/util/resultGroup.ts`, `src/util/streamHistoryKey.ts`

**Interfaces:**
- Produces: `normaliseTitle(raw: string): string` from `src/util/titleKey.ts`.

- [ ] **Step 1: Write the failing test**

`src/util/titleKey.test.ts`. It asserts the two key producers against **each other**, not against hardcoded strings, so it fails if either side drifts again:

```ts
import { describe, expect, it } from "vitest";
import { parseRelease } from "./release";
import { groupKeyFor } from "./resultGroup";
import { historyKeyFor } from "./streamHistoryKey";
import { normaliseTitle } from "./titleKey";

/** The show segment of a group key: "harrowgate" out of "harrowgate|series|s3|e1". */
const showOfGroupKey = (name: string): string => {
  const key = groupKeyFor(name, "series");
  return key.slice(0, key.indexOf("|series|"));
};

describe("normaliseTitle", () => {
  it("strips a tracker prefix, a bracket tag, pack filler and a leading article", () => {
    expect(normaliseTitle("www.uindex.org - Harrowgate")).toBe("harrowgate");
    expect(normaliseTitle("[Judas] Harrowgate")).toBe("harrowgate");
    expect(normaliseTitle("Harrowgate Complete Series")).toBe("harrowgate");
    expect(normaliseTitle("The Harrowgate")).toBe("harrowgate");
  });

  it("never reduces a title to nothing", () => {
    expect(normaliseTitle("Series")).toBe("series");
    expect(normaliseTitle("(Ashfall)")).toBe("ashfall");
  });
});

describe("the history key and the group key agree on the show", () => {
  // Four of these six disagreed before this change. A drifted key does not
  // crash — it silently stops matching the row it is looking for, which is why
  // this is asserted producer-against-producer rather than against a literal.
  const NAMES = [
    "Harrowgate.S03E01.1080p.WEB-DL",
    "[Judas] Harrowgate S03E01 (1080p)",
    "www.uindex.org - Harrowgate.S03E01.1080p",
    "The.Harrowgate.S03E01.1080p.WEB-DL",
    "Harrowgate.S03.COMPLETE.SEASON.1080p",
    "Harrowgate.Complete.Series.S03E02.1080p",
  ];

  for (const name of NAMES) {
    it(`agrees for ${name}`, () => {
      const parsed = parseRelease(name, "series");
      expect(parsed).not.toBeNull();
      expect(historyKeyFor(parsed!)).toBe(`${showOfGroupKey(name)}|series`);
    });
  }

  it("still keys a film on title, year and type", () => {
    const parsed = parseRelease("Kestrel.2010.1080p.BluRay.x264");
    expect(historyKeyFor(parsed!)).toBe(parsed!.key);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/util/titleKey.test.ts`
Expected: FAIL — `Cannot find module './titleKey'`, and once that is created, four of the six agreement cases fail.

- [ ] **Step 3: Create `src/util/titleKey.ts`**

Move the body verbatim out of `resultGroup.ts` — `normaliseTitle`, `PACK_FILLER`, `BRACKET_PREFIX` — keeping every comment. They explain non-obvious ordering and are load-bearing.

```ts
/**
 * One definition of "the same show", shared by the two things that key on it.
 *
 * IMPORTS NOTHING, deliberately, for the reason `streamHistoryKey.ts` states
 * about itself: that file must stay reachable from `src/web/static/**`, which
 * may not touch a `node:*` builtin even transitively. Leaving this in
 * `resultGroup.ts` would drag `parse-torrent-title` into every consumer of the
 * history key.
 *
 * It exists because those two producers had drifted. `historyKeyFor` lower-cased
 * the parsed title and stopped; `normaliseTitle` also stripped a tracker prefix,
 * a bracketed group tag, pack filler and a leading article. Four of six measured
 * shapes disagreed, so a show you were mid-way through showed no position, and
 * Continue-watching grew a second row for it.
 */

/**
 * Normalise a parsed title before it becomes a key.
 *
 * THE ORDER IS LOAD-BEARING. Punctuation becomes spaces BEFORE the leading
 * article is dropped: a title wrapped in another script — "супер … (the …
 * movie)" appears in live data — keeps its "the" if the article is stripped
 * first, and splits off into a group of its own.
 */
export function normaliseTitle(raw: string): string {
  const base = raw
    // "www.uindex.org    -    Kestrel 2010": a tracker stamps its own domain on
    // the front of the release name. Five of 129 live results for one film were
    // stranded in a group of their own by this alone.
    .replace(/^\s*(?:www\.)?[a-z0-9-]+\.[a-z]{2,12}\s*[-–—]\s*/i, "")
    // "[Judas] Harrowgate S03": see BRACKET_PREFIX.
    .replace(BRACKET_PREFIX, "")
    .replace(/\.(?:mkv|mp4|m4v|avi|7z|zip|iso)$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^(?:the|a|an)\s+/, "")
    .trim();
  // "Harrowgate Complete Series" is the same show as "Harrowgate": the parser
  // leaves pack words in the title when no season number follows them to anchor
  // on. Stripped only from the END and never down to nothing, so a title that is
  // genuinely one of these words survives.
  const trimmed = base.replace(PACK_FILLER, "").trim();
  return trimmed || base;
}

export const PACK_FILLER = /(?:[\s._-]+(?:complete|full|series|seasons?|packs?))+$/i;

/**
 * A release group in brackets on the front, the convention for fansubbed shows.
 *
 * The lookahead demands a LETTER in what is left, not merely a non-space: a film
 * actually titled "(Ashfall) 1999" would otherwise reduce to "1999", and a title
 * eaten down to a bare number groups with every other numeric residue. Bracketed
 * junk in front of nothing is not a prefix, it IS the name.
 */
export const BRACKET_PREFIX = /^\s*[[({][^\])}]*[\])}]\s*(?=[^a-z]*[a-z])/i;

/**
 * The same two strips, on a DISPLAY title, which keeps its own case.
 *
 * A heading reading "Harrowgate COMPLETE SERIES" while the group beside it reads
 * "Harrowgate" is the duplicate-looking-rows complaint one layer up: the key
 * already treats them as one thing, so the label has to as well.
 */
export function tidyTitle(raw: string): string {
  const base = raw.replace(BRACKET_PREFIX, "").trim();
  return base.replace(PACK_FILLER, "").trim() || base;
}
```

- [ ] **Step 4: Point `resultGroup.ts` at it**

Delete `normaliseTitle`, `tidyTitle`, `PACK_FILLER` and `BRACKET_PREFIX` from `src/util/resultGroup.ts` and import them instead:

```ts
import { normaliseTitle, tidyTitle } from "./titleKey";
```

Nothing else in that file changes — both functions keep their names and signatures.

- [ ] **Step 5: Point `streamHistoryKey.ts` at it**

Replace the body of `historyKeyFor` (`src/util/streamHistoryKey.ts:29-34`):

```ts
export function historyKeyFor(
  parsed: { title: string; year?: number; type?: string; key: string },
): string {
  if (parsed.type !== "series") return parsed.key;
  // normaliseTitle, NOT toLowerCase: this key and the results list's group key
  // have to agree on what "the same show" means, and they had drifted. Four of
  // six measured shapes disagreed, which showed up as a show with no watch
  // position and a second Continue-watching row for it.
  return `${normaliseTitle(parsed.title) || parsed.title.trim().toLowerCase()}|series`;
}
```

Add `import { normaliseTitle } from "./titleKey";` at the top, and extend the file's existing header comment with the migration note:

```
 * CHANGING THIS CHANGES STORED KEYS, and deliberately without a migration —
 * the same answer this file already gives for the previous key change.
 * `removeStreamHistory` filters on the STORED value, so rows written under an
 * older key keep working and merge into the new one the next time that title is
 * streamed. Until then such a row shows as its own Continue-watching entry.
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/util/titleKey.test.ts src/util/resultGroup.test.ts src/core/streamHistory.test.ts`
Expected: PASS. `resultGroup.test.ts` must be untouched — if it needed editing, the move was not verbatim.

- [ ] **Step 7: Gates and commit**

```bash
npm test && npm run typecheck && npm run lint && npm run build
git add src/util/titleKey.ts src/util/titleKey.test.ts src/util/resultGroup.ts src/util/streamHistoryKey.ts
git commit -m "fix(util): give the history key and the group key one idea of the same show"
```

---

### Task 2: Record the episode a player actually opened

Fixes the second live bug: playing E03 out of a season pack stores no episode, so there is no "next" to offer — the path Piece A made the likely one.

**Files:**
- Modify: `src/core/streamHistory.ts`
- Test: `src/core/streamHistory.test.ts`

**Interfaces:**
- Produces: `recordPlayedFile(current: readonly StreamHistoryItem[], infoHash: string, filename: string): StreamHistoryItem[]` — **same array reference when nothing changed**.

- [ ] **Step 1: Write the failing test**

Append to `src/core/streamHistory.test.ts`, reusing whatever item factory that file already defines; if it has none, use this shape:

```ts
describe("recordPlayedFile", () => {
  const packEntry = (): StreamHistoryItem => ({
    key: "harrowgate|series",
    title: "Harrowgate",
    type: "series",
    season: 3,
    rawName: "Harrowgate.S03.COMPLETE.1080p.WEB-DL",
    infoHash: "abc",
    magnet: "magnet:?xt=urn:btih:abc",
    startedAt: 1,
  });

  it("takes the episode from the file when the torrent name had none", () => {
    const next = recordPlayedFile([packEntry()], "abc", "Harrowgate.S03E03.1080p.WEB-DL.mkv");
    expect(next[0]!.season).toBe(3);
    expect(next[0]!.episode).toBe(3);
    // The whole point: there is now a next episode to offer.
    expect(nextEpisode(next[0]!)).toEqual({ season: 3, episode: 4 });
  });

  it("is a high-water mark, so replaying an earlier file does not rewind", () => {
    const at5 = recordPlayedFile([packEntry()], "abc", "Harrowgate.S03E05.mkv");
    const back = recordPlayedFile(at5, "abc", "Harrowgate.S03E02.mkv");
    expect(back[0]!.episode).toBe(5);
  });

  it("returns the SAME reference when nothing changed, which is the write gate", () => {
    const at5 = recordPlayedFile([packEntry()], "abc", "Harrowgate.S03E05.mkv");
    expect(recordPlayedFile(at5, "abc", "Harrowgate.S03E02.mkv")).toBe(at5);
    expect(recordPlayedFile(at5, "abc", "Harrowgate.S03E05.mkv")).toBe(at5);
  });

  it("ignores a file that names no episode, and an unknown info hash", () => {
    const one = [packEntry()];
    expect(recordPlayedFile(one, "abc", "readme.txt")).toBe(one);
    expect(recordPlayedFile(one, "nope", "Harrowgate.S03E03.mkv")).toBe(one);
  });

  it("advances across a season boundary", () => {
    const s4 = recordPlayedFile([packEntry()], "abc", "Harrowgate.S04E01.mkv");
    expect(s4[0]!.season).toBe(4);
    expect(s4[0]!.episode).toBe(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/core/streamHistory.test.ts -t recordPlayedFile`
Expected: FAIL — `recordPlayedFile is not a function`.

- [ ] **Step 3: Implement it**

Add to `src/core/streamHistory.ts`, after `recordStream`:

```ts
/**
 * Advance a title's position from the file a player ACTUALLY opened.
 *
 * `historyItemFor` parses the TORRENT's name, so streaming E03 out of
 * "Harrowgate.S03.COMPLETE" stored a season and no episode — and `nextEpisode`
 * returns null without one, so there was nothing to offer. The season tree made
 * that the likely path rather than a corner case: a collapsed season row
 * resolves to its best season pack.
 *
 * Called from the hook both front ends already fire when a player launches
 * (`markPlayed` in the TUI, the `"watched"` action in the browser), so a
 * failed or cancelled stream never moves the mark.
 *
 * SAME HIGH-WATER RULE as `recordStream`, for the same reason: replaying an
 * early episode must not rewind your progress.
 *
 * Returns the SAME ARRAY REFERENCE when nothing changed. Callers use that as
 * their write gate, exactly as `markWatched` (src/util/favouriteList.ts) does —
 * this fires on every player launch, and churning the file on every re-watch is
 * what that avoids.
 */
export function recordPlayedFile(
  current: readonly StreamHistoryItem[],
  infoHash: string,
  filename: string,
): StreamHistoryItem[] {
  const item = current.find((e) => e.infoHash === infoHash);
  if (!item) return current as StreamHistoryItem[];
  const parsed = parseRelease(filename);
  if (parsed?.season === undefined || parsed.episode === undefined) {
    return current as StreamHistoryItem[];
  }
  const later =
    parsed.season !== (item.season ?? 0)
      ? parsed.season > (item.season ?? 0)
      : parsed.episode > (item.episode ?? 0);
  if (!later) return current as StreamHistoryItem[];
  return current.map((e) =>
    e.infoHash === infoHash ? { ...e, season: parsed.season!, episode: parsed.episode! } : e,
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/core/streamHistory.test.ts`
Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 5: Gates and commit**

```bash
npm test && npm run typecheck && npm run lint && npm run build
git add src/core/streamHistory.ts src/core/streamHistory.test.ts
git commit -m "fix(core): take the watch position from the file a player opened"
```

---

### Task 3: Call it from both front ends

**Files:**
- Modify: `src/ui/App.tsx` (around `markPlayed`, line ~788)
- Modify: `src/web/routes.ts` (the `"watched"` action, line ~985)

**Interfaces:**
- Consumes: `recordPlayedFile` from Task 2.

- [ ] **Step 1: Terminal — advance the mark in `markPlayed`**

`markPlayed` currently takes `(favId, filename)` and only touches favourites. The info hash it needs is `favId` — the same torrent id. Extend it:

```tsx
  // Mark a file streamed this session and, when its torrent is favourited,
  // persist watched progress. Called only once a player actually launches, so a
  // failed/cancelled stream never earns a ✓.
  //
  // ALSO the watch position: `historyItemFor` parsed the torrent's name, which
  // for a season pack names no episode. This is the first moment we know which
  // episode was really opened.
  const markPlayed = useCallback(
    (favId: string, filename: string) => {
      setStreamedFiles((prev) => new Set(prev).add(filename));
      if (isFavouritedIn(config?.favourites ?? [], favId)) {
        markWatchedInFavourite(favId, filename);
      }
      void advancePosition(favId, filename);
    },
    [config, markWatchedInFavourite, advancePosition],
  );
```

And add `advancePosition` above it. It re-reads the file rather than trusting React state, for the reason `forgetStreamHistory` gives: `serve --web` is a separate process writing the same file.

```tsx
  // Re-reads before writing. `serve --web` is a SEPARATE PROCESS writing this
  // same file, so a writer that trusted its own React snapshot would silently
  // drop every row the browser recorded since this TUI started — the rule
  // `forgetStreamHistory` already states.
  //
  // Total swallow: this is a convenience list, and an unhandled rejection in a
  // TUI's Node process can take the terminal down with it.
  const advancePosition = useCallback(async (infoHash: string, filename: string) => {
    try {
      const current = await loadStreamHistory();
      const next = recordPlayedFile(current, infoHash, filename);
      if (next === current) return; // nothing moved — do not churn the file
      await saveStreamHistory(next);
      setStreamHistory(next);
    } catch {
      // ignored
    }
  }, []);
```

Add `recordPlayedFile` to the existing import from `../core/streamHistory` (`src/ui/App.tsx:44` area).

- [ ] **Step 2: Browser — advance the mark in the `"watched"` action**

In `src/web/routes.ts`, inside `if (action === "watched")`, after the `markWatched` block and before building the response:

```ts
    // The same moment, for the same reason as the TUI's markPlayed: this is the
    // first point at which we know WHICH episode was opened. `historyItemFor`
    // ran at stream-start, off the session resolving, before the user had
    // picked a file at all.
    //
    // Read-modify-write, never a held snapshot: a TUI may be running against
    // this same file in another process.
    try {
      const history = await loadStreamHistory();
      const advanced = recordPlayedFile(history, infoHash, filename);
      if (advanced !== history) await saveStreamHistory(advanced);
    } catch {
      // A convenience list must never fail a play the user already started.
    }
```

Add `recordPlayedFile`, `loadStreamHistory` and `saveStreamHistory` to the existing `../core/streamHistory` import at `src/web/routes.ts:7`. Check which are already imported before adding — several are.

- [ ] **Step 3: Verify by running both**

There is no jsdom, deliberately, and neither call site is unit-testable. Run them.

```bash
npm run build && npm run dev -- serve --web --port 7391
```

Play any episode from a multi-file torrent, then check the store moved:

```bash
cat "$(node -e 'import("./dist/cli.cjs").catch(()=>{}); ' 2>/dev/null; echo "$HOME/Library/Preferences/torlink/stream-history.json")" | jq '.[0] | {title, season, episode}'
```

If that path is wrong on your platform, find it via `streamHistoryFile` in `src/config/paths.ts`. Expected: `season` and `episode` name the file you actually played, not the pack.

Then the terminal: `npm run dev`, play an episode out of a season pack, and confirm the Continue-watching row reads `next S03E04` rather than showing no next at all.

- [ ] **Step 4: Gates and commit**

```bash
npm test && npm run typecheck && npm run lint && npm run build
git add src/ui/App.tsx src/web/routes.ts
git commit -m "fix: advance the watch position when a player opens an episode"
```

---

### Task 4: Land on the next episode

**Files:**
- Modify: `src/util/resultGroup.ts`
- Test: `src/util/resultGroup.test.ts`

**Interfaces:**
- Consumes: `EpisodeRef` from `src/util/episode.ts`.
- Produces: `defaultExpandedKeys(groups, positionFor?: (showKey: string) => EpisodeRef | null): string[]`; `showKeyOf(groupKey: string): string`; `nextUpRowKey(groups, positionFor): string | null`.

- [ ] **Step 1: Write the failing test**

```ts
describe("defaultExpandedKeys with a watch position", () => {
  const SHOW = [
    r("Harrowgate.S03.1080p.WEB-DL"),
    r("Harrowgate.S03.2160p.WEB-DL"),
    r("Harrowgate.S03E01.1080p.WEB-DL"),
    r("Harrowgate.S03E01.2160p.WEB-DL"),
    r("Harrowgate.S04E02.1080p.WEB-DL"),
    r("Harrowgate.S04E02.2160p.WEB-DL"),
    r("Harrowgate.S04E03.1080p.WEB-DL"),
    r("Harrowgate.S04E03.2160p.WEB-DL"),
  ];

  it("opens the season holding the next episode, not the highest-ranked one", () => {
    const groups = groupResults(SHOW, "series");
    // Highest-ranked is S04 (seasons sort newest first and S03 has the pack), so
    // this only passes if the POSITION is what chose it.
    const at = () => ({ season: 3, episode: 0 });
    expect(defaultExpandedKeys(groups, at)).toEqual(["harrowgate|series|s3"]);
  });

  it("falls back to the highest-ranked season when the show has no position", () => {
    const groups = groupResults(SHOW, "series");
    expect(defaultExpandedKeys(groups, () => null)).toEqual(defaultExpandedKeys(groups));
  });

  it("is unchanged when no lookup is given, so Piece A's behaviour is intact", () => {
    const groups = groupResults(SHOW, "series");
    expect(defaultExpandedKeys(groups)).toHaveLength(1);
  });
});

describe("nextUpRowKey", () => {
  const groups = () =>
    groupResults(
      [
        r("Harrowgate.S03E01.1080p.WEB-DL"),
        r("Harrowgate.S03E01.2160p.WEB-DL"),
        r("Harrowgate.S03E02.1080p.WEB-DL"),
        r("Harrowgate.S03E02.2160p.WEB-DL"),
      ],
      "series",
    );

  it("names the row for the episode after the position", () => {
    expect(nextUpRowKey(groups(), () => ({ season: 3, episode: 1 }))).toBe(
      "harrowgate|series|s3|e2",
    );
  });

  it("is null when the next episode is not in the results, so nothing phantom is marked", () => {
    // Position says E02 watched; there is no E03 here.
    expect(nextUpRowKey(groups(), () => ({ season: 3, episode: 2 }))).toBeNull();
  });

  it("is null with no position", () => {
    expect(nextUpRowKey(groups(), () => null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/util/resultGroup.test.ts -t "watch position"`
Expected: FAIL — `defaultExpandedKeys` takes one argument; `nextUpRowKey is not a function`.

- [ ] **Step 3: Implement**

`showOf` already exists in `src/util/resultGroup.ts` as a private helper. Export it under a clearer name and keep the private one delegating, so the browser can build its lookup with the same rule:

```ts
/** "harrowgate" out of any group key. The identity a watch position is keyed on. */
export function showKeyOf(groupKey: string): string {
  const at = groupKey.indexOf("|series|");
  return at === -1 ? groupKey : groupKey.slice(0, at);
}
```

Replace the body of the existing private `showOf` with `return showKeyOf(key);`, or delete it and call `showKeyOf` directly — either way there must be **one** implementation.

Then:

```ts
/** Where the user is in a show, by normalised show key. Null when unknown. */
export type PositionLookup = (showKey: string) => EpisodeRef | null;

/**
 * The keys a fresh result set should start with open.
 *
 * WITH a position: the season holding the next episode, which is the whole
 * point of the feature — you searched a show to carry on watching it.
 *
 * WITHOUT one: the highest-ranked season node, and only that one. Piece A's
 * reasoning, unchanged — a search for one season otherwise collapses to a single
 * line, which reads as the list having failed, and "highest-ranked" beats "the
 * only one" because a real search for one season also returned a different
 * show's season and two unrelated episodes.
 *
 * A season the row plan DROPS (one child) is skipped — there is no row to open.
 *
 * A SEED, not a running rule: the caller puts these into the expansion set it
 * already owns, so collapsing one behaves like collapsing anything else.
 */
export function defaultExpandedKeys<T extends GroupableResult>(
  groups: readonly ResultGroup<T>[],
  positionFor?: PositionLookup,
): string[] {
  const nodes = seasonTree(groups);
  if (positionFor) {
    for (const node of nodes) {
      if (!isSeasonNode(node) || node.children.length <= 1) continue;
      const at = positionFor(showKeyOf(node.key));
      if (at && nextOf(at).season === node.season) return [node.key];
    }
  }
  for (const node of nodes) {
    if (isSeasonNode(node) && node.children.length > 1) return [node.key];
  }
  return [];
}

/** The episode after a position. Not exported: `nextEpisode` in src/core owns the public one. */
function nextOf(at: EpisodeRef): EpisodeRef {
  return { season: at.season, episode: at.episode + 1 };
}

/**
 * The group key of the episode to land on, or null.
 *
 * NULL WHEN THE RESULTS DO NOT HAVE IT. A position is a suggestion — nothing has
 * asked a tracker whether the next episode exists — so a season aired up to E07
 * that returns no E08 must not grow a phantom row. The results are the authority
 * on what can be selected.
 */
export function nextUpRowKey<T extends GroupableResult>(
  groups: readonly ResultGroup<T>[],
  positionFor: PositionLookup,
): string | null {
  for (const group of groups) {
    if (group.season === undefined || group.episode === undefined) continue;
    const at = positionFor(showKeyOf(group.key));
    if (!at) continue;
    const want = nextOf(at);
    if (group.season === want.season && group.episode === want.episode) return group.key;
  }
  return null;
}
```

Add `import type { EpisodeRef } from "./episode";` at the top of `src/util/resultGroup.ts`. `episode.ts` imports nothing, so the browser bundle is unaffected.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/util/resultGroup.test.ts`
Expected: PASS, including every Piece A test — `defaultExpandedKeys(groups)` with one argument must behave exactly as before.

- [ ] **Step 5: Gates and commit**

```bash
npm test && npm run typecheck && npm run lint && npm run build
git add src/util/resultGroup.ts src/util/resultGroup.test.ts
git commit -m "feat(util): open the season you are part-way through, and name the next episode"
```

---

### Task 5: The position marks, and wiring the landing into both front ends

**Files:**
- Modify: `src/util/resultGroup.ts` (the label helper), `src/util/resultGroup.test.ts`
- Modify: `src/ui/components/Results.tsx`, `src/ui/components/Results.test.tsx`
- Modify: `src/web/static/app.ts`, `src/web/static/searchModel.ts`, `src/web/static/styles.css`
- Modify: `README.md`

**Interfaces:**
- Consumes: `defaultExpandedKeys(groups, positionFor)`, `nextUpRowKey`, `showKeyOf`, `PositionLookup`.
- Produces: `positionNote(season: number, at: EpisodeRef | null): string`.

- [ ] **Step 1: Write the failing test for the label**

```ts
describe("positionNote", () => {
  it("says how far through a season you are", () => {
    expect(positionNote(3, { season: 3, episode: 7 })).toBe("up to E07");
  });

  it("says nothing for a season you have not started", () => {
    expect(positionNote(4, { season: 3, episode: 7 })).toBe("");
  });

  it("says nothing without a position", () => {
    expect(positionNote(3, null)).toBe("");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/util/resultGroup.test.ts -t positionNote`
Expected: FAIL — `positionNote is not a function`.

- [ ] **Step 3: Implement the label**

```ts
/**
 * The note a season heading carries when you are part-way through it.
 *
 * "up to E07", not "watched" — the store holds a HIGH-WATER MARK, one entry per
 * title, and `recordStream` deliberately keeps it that way so replaying an early
 * episode does not rewind you. Claiming E01–E06 are watched is not something
 * that data can support once someone jumps around.
 *
 * Empty string, never null, so a renderer can concatenate without a branch.
 */
export function positionNote(season: number, at: EpisodeRef | null): string {
  if (!at || at.season !== season) return "";
  return `up to E${String(at.episode).padStart(2, "0")}`;
}
```

- [ ] **Step 4: Terminal — seed from the position, select next-up, draw the note**

In `src/ui/components/Results.tsx`:

Build the lookup from the store's stream history. **Verified: `Store` already has
`streamHistory: StreamHistoryItem[]` (`src/ui/store.ts:105`) and `makeTestStore` already
seeds it (`src/ui/testHarness.ts:158`) — so this is NOT a new `Store` field, and neither
`makeStore` in `scripts/render-previews-impl.tsx` nor `makeTestStore` needs touching.**
`Results()` simply does not destructure it yet; add `streamHistory` to the destructure at
the top of the component, alongside `queue` and `sort`.

```tsx
  // The watch position by normalised show key. Memoised on the history array so
  // the seed effect below does not re-run every render.
  const positionFor = useMemo<PositionLookup>(() => {
    const byShow = new Map<string, EpisodeRef>();
    for (const item of streamHistory) {
      if (item.type !== "series" || item.season === undefined || item.episode === undefined) continue;
      // The history key is `<show>|series` and the group key's show segment is
      // `<show>` — one normaliser since they were unified.
      byShow.set(item.key.replace(/\|series$/, ""), { season: item.season, episode: item.episode });
    }
    return (showKey) => byShow.get(showKey) ?? null;
  }, [streamHistory]);
```

Pass it to the seed (the effect declared **below** the one that clears `expanded` — that ordering is load-bearing and cost a debugging round in Piece A):

```tsx
    const keys = defaultExpandedKeys(groupResults(results, hintForSection(section)), positionFor);
    if (keys.length > 0) setExpanded(new Set(keys));
```

Add `positionFor` to that effect's dependency array.

Then, in the same effect, move the cursor to the next-up row once the rows exist. Do it in a second effect that runs after `rows` is computed, guarded by the same `seeded` ref so it fires once per result set:

```tsx
  // Land on the episode you are up to. Once per result set, like the expansion
  // seed and for the same reason: a running rule fights the user as sources
  // stream in. Null when the results do not have that episode — a position is a
  // suggestion, and the results are the authority on what can be selected.
  useEffect(() => {
    if (!landed.current || rows.length === 0) return;
    landed.current = false;
    const key = nextUpRowKey(groupResults(results, hintForSection(section)), positionFor);
    if (!key) return;
    const at = rows.findIndex((row) => row.key === key);
    if (at >= 0) moveTo(at);
  }, [rows, results, section, positionFor]);
```

Declare `const landed = useRef(false);` beside `seeded`, set `landed.current = true` wherever `seeded.current = true` is set, and `landed.current = false` in the query-change clear.

Draw the note on a season row, in the label expression:

```tsx
  const note = row.kind === "season" ? positionNote(row.season, positionFor(showKeyOf(row.key))) : "";
```

and append `${note ? ` · ${note}` : ""}` to the season branch of `label`.

- [ ] **Step 5: Write the terminal test**

In `src/ui/components/Results.test.tsx`, inside `describe("Results grouping", …)`. The test store needs a stream-history entry; check `makeTestStore` in `src/ui/testHarness.ts` for the field name and add one if the harness does not already accept it — **and if you add a `Store` field, `makeStore` in `scripts/render-previews-impl.tsx` needs the same entry or `npm run previews` breaks.**

```ts
it("opens the season you are part-way through and lands on the next episode", async () => {
  const u = await mountWideWithHistory(
    [
      t("a1", "Harrowgate.S03E01.1080p.WEB-DL"),
      t("a2", "Harrowgate.S03E01.2160p.WEB-DL"),
      t("b1", "Harrowgate.S03E02.1080p.WEB-DL"),
      t("b2", "Harrowgate.S03E02.2160p.WEB-DL"),
      t("c1", "Harrowgate.S04E01.1080p.WEB-DL"),
      t("c2", "Harrowgate.S04E01.2160p.WEB-DL"),
    ],
    [{ key: "harrowgate|series", title: "Harrowgate", type: "series", season: 3, episode: 1,
       rawName: "Harrowgate.S03E01.1080p.WEB-DL", infoHash: "a1",
       magnet: "magnet:?xt=urn:btih:a1", startedAt: 1 }],
  );
  // S04 is highest-ranked; the position must beat it.
  await vi.waitFor(() => expect(u.frame()).toContain("S03E02"));
  expect(u.frame()).toContain("up to E01");
  // The cursor sits on the next episode, not the season row.
  expect(lines(u).find((l) => l.includes("S03E02"))).toContain("❯");
});
```

Write `mountWideWithHistory` next to the existing `mountWide` in that file, passing the history array through `makeTestStore`.

- [ ] **Step 6: Browser — the same three things**

`src/web/static/searchModel.ts`: add `defaultExpandedKeys` is already re-exported; add `nextUpRowKey`, `positionNote`, `showKeyOf` and `type PositionLookup` to the same re-export block from `../../util/resultGroup`.

Then add a pure builder in `searchModel.ts` — **not** in `app.ts`, which is DOM wiring:

```ts
/**
 * The watch position by normalised show key, from `GET /api/saved`.
 *
 * A function, matching `reportsHealthLookup` — the row-plan helpers take a
 * lookup so `src/util/resultGroup.ts` stays front-end-agnostic.
 */
export function positionLookup(
  continueWatching: readonly PublicStreamHistoryItem[],
): PositionLookup {
  const byShow = new Map<string, EpisodeRef>();
  for (const item of continueWatching) {
    if (item.type !== "series" || item.season === undefined || item.episode === undefined) continue;
    byShow.set(item.key.replace(/\|series$/, ""), { season: item.season, episode: item.episode });
  }
  return (showKey) => byShow.get(showKey) ?? null;
}
```

Give it a test in `src/web/static/searchModel.test.ts` (a series entry resolves; a film entry does not; an unknown show is null).

In `app.ts`: hold the latest `continueWatching` from `GET /api/saved` in the module-level state beside `sources`, pass `positionLookup(...)` into the `defaultExpandedKeys` call in the seed block, select `nextUpRowKey(...)`'s row after the plan is built, and append `positionNote(...)` to the season heading via `groupFactsFor`. Add the note as its own `<span class="group-note">` — `createElement` + `textContent`, never `innerHTML`.

Add a `.group-note` rule to `styles.css`, dim, reusing an existing variable. **Do not use `--accent`** — the browser rows already spend it on "this source reports health" and "this is cached".

- [ ] **Step 7: Verify by running it**

```bash
npm run build && npm run dev -- serve --web --port 7391
```

Play an episode of a show, then search that show again. Expect: its season opens rather than the newest one, the season heading reads `· up to E0n`, and the next episode is selected. Check the console is clean.

- [ ] **Step 8: README, gates and commit**

Extend the grouping paragraph in `README.md` (the one added by Piece A, ending "…gives you every release as its own row"):

```markdown
**It remembers where you are.** Play an episode and the next time that show comes up, its
season is the one that opens, the heading says how far through you are, and the episode
you have not seen yet is the one already selected. The position moves when a player
actually starts, so a cancelled stream never counts — and it comes from the file you
really opened, so playing one episode out of a season pack still advances it.
```

```bash
npm test && npm run typecheck && npm run lint && npm run build
git add src/util/resultGroup.ts src/util/resultGroup.test.ts src/ui/components/Results.tsx src/ui/components/Results.test.tsx src/web/static/app.ts src/web/static/searchModel.ts src/web/static/searchModel.test.ts src/web/static/styles.css README.md
git commit -m "feat: land on the episode you are up to, and say how far through you are"
```

---

### Task 6: Per-episode plots

Shippable on its own. The only task touching an external API.

**Files:**
- Modify: `src/recc/omdb.ts`, `src/recc/omdb.test.ts`
- Modify: `src/ui/hooks/useTitlePreview.ts`
- Modify: `src/web/routes.ts` (`/api/title` → `titleMeta`), `src/web/routes.test.ts`
- Modify: `src/ui/components/Results.tsx`, `src/web/static/app.ts`

**Interfaces:**
- Produces: `fetchTitleMetaByName(title, { year?, type?, season?, episode?, ... })` sending `&Season=`/`&Episode=`.

- [ ] **Step 1: Write the failing tests**

In `src/recc/omdb.test.ts`, following whatever fetch-stub pattern that file already uses:

**The signature is `fetchTitleMetaByName(title, apiKey, opts)` — the API key is its own
positional argument, NOT part of `opts` (`src/recc/omdb.ts:80-90`). It resolves to
`FetchTitleMetaResult`, a discriminated union `{ ok: true, plot, imdbId, posterUrl, type }
| { ok: false, error }` — never null.** Both of those are easy to get wrong from memory.

```ts
it("asks OMDb for one episode when season and episode are given", async () => {
  const seen: string[] = [];
  const fetchImpl = (async (url: string) => {
    seen.push(url);
    return { ok: true, json: async () => ({ Response: "True", Plot: "…", imdbID: "tt1" }) };
  }) as unknown as FetchImpl;
  await fetchTitleMetaByName("Harrowgate", "k", {
    type: "series", season: 3, episode: 2, fetchImpl,
  });
  expect(seen[0]).toContain("Season=3");
  expect(seen[0]).toContain("Episode=2");
});

it("treats an episode OMDb does not have as a miss, not a throw", async () => {
  const fetchImpl = (async () => ({
    ok: true,
    json: async () => ({ Response: "False", Error: "Series or episode not found!" }),
  })) as unknown as FetchImpl;
  const got = await fetchTitleMetaByName("Harrowgate", "k", {
    type: "series", season: 3, episode: 99, fetchImpl,
  });
  expect(got.ok).toBe(false);
});
```

Follow the fetch-stub idiom already used elsewhere in `src/recc/omdb.test.ts` rather than
these literal stubs if that file has a helper.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/recc/omdb.test.ts`
Expected: FAIL — no `Season` in the URL.

- [ ] **Step 3: Implement in `omdb.ts`**

At `src/recc/omdb.ts:88`, after the existing `y`/`type` params in `fetchTitleMetaByName`:

```ts
  // OMDb returns the EPISODE's own title and plot for these. Only meaningful
  // with type=series; sending them for a film gets an error response, which the
  // existing Response:"False" path already turns into null.
  if (opts.season !== undefined) params.set("Season", String(opts.season));
  if (opts.episode !== undefined) params.set("Episode", String(opts.episode));
```

Add `season?: number; episode?: number;` to that function's inline `opts` type — the third
parameter, currently `{ year?: number; type?: OmdbType; fetchImpl?: FetchImpl; timeoutMs?: number }`.

The `{ ok: false }` path for a missing episode needs no new code: `request()` already turns
OMDb's `Response: "False"` into an error result, which both preview panes already render
through their `undefined = loading, null = none available` contract.

- [ ] **Step 4: Thread it through the terminal preview**

In `src/ui/hooks/useTitlePreview.ts`, extend the by-name variant:

```ts
export type MetaQuery =
  | { by: "id"; imdbId: string }
  | { by: "name"; title: string; year?: number; type?: OmdbType; season?: number; episode?: number };
```

and pass `season`/`episode` through to `fetchTitleMetaByName`.

**THE TRAP — write this test first.** `cacheKey` is the identity of "the same lookup", which is what makes quality variants share one request. Leave it alone and every episode of a season renders episode one's plot, a bug that reads as OMDb being wrong.

In `src/ui/components/Results.tsx`, where the preview's `cacheKey` and `query` are built from the selected row, include the season and episode of an episode group:

```tsx
  // Season and episode ARE part of the identity — without them every episode of
  // a season shares one cached lookup and shows the first one's plot.
  const previewCacheKey = [parsed?.key ?? "", ep?.season ?? "", ep?.episode ?? ""].join("|");
```

Derive `ep` from the selected row: for a `kind: "group"` row with `season` and `episode`, use those; otherwise none. Poster stays the series poster — do not pass season/episode to the poster lookup.

- [ ] **Step 5: Thread it through the browser preview**

`GET /api/title` (`src/web/routes.ts:1616` → `titleMeta`) accepts `season` and `episode` query params, parsed as integers and ignored unless both are present and `type=series`. Add a route test alongside the existing `/api/title` ones asserting the params reach the injected lookup.

In `app.ts`, include them in the preview request for a selected episode row, and in whatever key the browser caches previews under — the same trap applies.

- [ ] **Step 6: Verify by running it**

```bash
npm run build && npm run dev -- serve --web --port 7391
```

Search a show, open a season, and arrow/click down the episodes. Each episode's plot must differ. An episode OMDb lacks shows "no plot available" with the poster still there — not an error, not a blank pane.

- [ ] **Step 7: Gates and commit**

```bash
npm test && npm run typecheck && npm run lint && npm run build
git add src/recc/omdb.ts src/recc/omdb.test.ts src/ui/hooks/useTitlePreview.ts src/ui/components/Results.tsx src/web/routes.ts src/web/routes.test.ts src/web/static/app.ts
git commit -m "feat: show each episode's own plot in the preview"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
| --- | --- |
| 1a — shared normaliser, `titleKey.ts`, migration note | 1 |
| 1b — `recordPlayedFile`, same-reference write gate | 2 |
| 1b — both front ends call it on player launch | 3 |
| Phase 2 — `defaultExpandedKeys(groups, positionFor)` | 4 |
| Phase 2 — next-up row selected; null when not in results | 4 (`nextUpRowKey`), 5 (wiring) |
| Phase 3 — position marks, decision in the pure module | 5 |
| Phase 3 — don't reuse a colour that means something else | 5, steps 4 and 6 |
| Phase 4 — OMDb season/episode, cache key, `Response:"False"` → null | 6 |
| Episodes keep the series poster | 6, step 4 |
| No per-episode watched tracking | honoured — `positionNote` says "up to", nothing marks episodes watched |

**Placeholder scan:** two steps deliberately instruct *verify before writing* rather than giving final code — Task 5 step 4 (the store's stream-history field name in `Results.tsx`) and Task 6 step 1 (the real `fetchTitleMetaByName` opts shape). Both name the exact file and line to check and say the existing code is the authority. That is a check, not a TBD.

**Type consistency:** `PositionLookup = (showKey: string) => EpisodeRef | null` is used identically in Tasks 4, 5 and both front ends. `showKeyOf` has one implementation (Task 4 step 3 explicitly collapses the existing private `showOf` into it). `recordPlayedFile`'s same-reference contract is asserted in Task 2 and relied on as the write gate in Task 3.

**Risk checked and closed:** an earlier draft warned that Task 5 might need a new `Store`
field for stream history, which would have meant updating `makeStore`
(`scripts/render-previews-impl.tsx`) and `makeTestStore` (`src/ui/testHarness.ts`) or
breaking `npm run previews` and `npm run typecheck`. Verified against the code: the field
already exists (`src/ui/store.ts:105`, `testHarness.ts:158`). `Results()` just needs to
destructure it. No preview or harness change.
