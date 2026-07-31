# Title Autocomplete From reccd — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When reccd is configured, both torlink front ends offer live title suggestions as you type in the search box, and picking one puts the canonical title and year into the search.

**Architecture:** A new `fetchTitleSuggestions` in `src/recc/client.ts` calls reccd's `GET /search`. The TUI calls it directly (same process, same config); the browser goes through a new `GET /api/title-search` proxy in `src/web/routes.ts`, because `reccToken` must never reach a browser. Every decision — the min-length gate, the labels, what a pick submits, and the stale-reply guard — lives in pure modules (`src/util/titleSuggest.ts`, `src/web/static/suggestModel.ts`) that have real tests. `src/ui` renders them through a hook; `src/web/static/app.ts` is DOM wiring only.

**Tech Stack:** TypeScript, React + Ink (terminal), vanilla DOM + TS (browser), vitest, `ink-testing-library`.

**Spec:** `docs/superpowers/specs/2026-07-31-title-autocomplete-design.md`

## Global Constraints

These apply to **every** task below. They are not restated per task.

- **`src/web` must never import from `src/ui`, and `src/core` from neither.** Lint enforces it (`eslint.config.js`). Share by putting the shared piece in `src/util/`.
- **No `innerHTML`, `insertAdjacentHTML`, `outerHTML` or `document.write` anywhere in `src/web/static/`.** Every node is `createElement` + `textContent`. This is a stored-XSS rule, not a style preference.
- **`src/web/static/` must not import `node:*`.** `npm run build` is the only thing that checks this — run it.
- **`app.ts` is DOM wiring only.** A conditional deciding *what to show* or *what to send* belongs in a pure module. This has been caught in review twice.
- **Config writes from the web are read-modify-write per request:** `loadConfig()` → change → `saveConfig()`. Never hold a snapshot between requests. (This feature only reads config, but the same per-request `loadConfig()` rule applies — a reccd URL can be pasted into the Accounts pane at any moment.)
- **Test fixtures name invented titles only.** Reuse this cast, do not invent more: `Kestrel.2010.1080p.BluRay.x264`, `Ashfall.1999.1080p`, `Tin.Rivers.2024.2160p.WEB-DL.DV.HDR.Atmos.7.1-GROUP`, `Kepler.S02E04.1080p.WEB-DL`, `Harrowgate.S03.1080p.WEB-DL`. Never a real film or show.
- **Conventional Commits.** Commit messages in this plan are given verbatim; use them.
- **Verified constants from reccd, do not change them:** `SEARCH_MIN_QUERY_LENGTH = 2`, `SEARCH_LIMIT_DEFAULT = 10`, `SEARCH_LIMIT_MAX = 25` (`reccd/src/api/server.ts:68-70`).
- **Before saying it is done:** `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`. One known pre-existing lint warning (`react-hooks/exhaustive-deps`, `src/ui/App.tsx`) stays — do not fix it.

## File Structure

| File | Responsibility |
|---|---|
| `src/util/titleSuggest.ts` **new** | The domain type `TitleSuggestion`, the tuning constants, the min-length gate, display labels, `submitTextFor`, and the stale-reply reducer. Pure. Imported by **both** front ends and by `src/recc/client.ts`. |
| `src/util/titleSuggest.test.ts` **new** | Tests for the above, including the out-of-order mutation guard. |
| `src/recc/client.ts` | Gains `fetchTitleSuggestions` + `isTitleSuggestion`. |
| `src/recc/client.test.ts` | Gains a `fetchTitleSuggestions` describe block. |
| `src/web/wire.ts` | `PublicTitleSuggestions`; `reccConfigured` on `SourcesResponse`. |
| `src/web/routes.ts` | `GET /api/title-search` handler + dispatch entry; `reccConfigured` in `sourcesResponse`; a `fetchTitleSuggestionsImpl` dep. |
| `src/web/routes.test.ts` | Tests for both. |
| `src/web/static/suggestModel.ts` **new** | Browser list state: open/closed, highlight index and its wrap, and what an accept sends. Pure. |
| `src/web/static/suggestModel.test.ts` **new** | Tests for the above. |
| `src/web/static/index.html` | The listbox container inside the search card. |
| `src/web/static/styles.css` | Its styling. |
| `src/web/static/app.ts` | DOM wiring: debounce timer, fetch, render rows, key handling. |
| `src/ui/hooks/useTitleSuggest.ts` **new** | Debounce + fetch + seq for the terminal, modelled on `useTitlePreview`. |
| `src/ui/components/TextField.tsx` | Gains `completion` / `onComplete` so Tab can complete. |
| `src/ui/components/SearchBar.tsx` | Renders the suggestion rows; passes completion through. |
| `src/ui/components/Results.tsx` | Owns the hook for the results pane; guards its Esc handler. |
| `src/ui/views/Splash.tsx` | Owns the hook for the splash; guards its Esc and Tab handlers; hint label. |
| `src/ui/keymap.ts` | The Tab-completes entry in `HELP_GROUPS`. |
| `README.md` | Both surfaces; the browser limitations list. |

---

## Task 1: The shared pure module

**Files:**
- Create: `src/util/titleSuggest.ts`
- Test: `src/util/titleSuggest.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export type TitleSuggestionType = "movie" | "tv";
  export interface TitleSuggestion {
    imdbId: string;
    title: string;
    year: number;
    type: TitleSuggestionType;
    matchedAka: string | null;
  }
  export const SUGGEST_MIN_QUERY_LENGTH: 2;
  export const SUGGEST_LIMIT: 8;
  export const SUGGEST_DEBOUNCE_MS: 250;
  export const SUGGEST_TIMEOUT_MS: 2500;
  export const SUGGEST_ROWS_TERMINAL: 5;
  export interface SuggestState {
    items: TitleSuggestion[];
    appliedSeq: number;
    suppressedText: string | null;
  }
  export function emptySuggestState(): SuggestState;
  export function shouldQuery(raw: string): boolean;
  export function shouldQueryFor(state: SuggestState, raw: string): boolean;
  export function applyReply(state: SuggestState, seq: number, items: TitleSuggestion[]): SuggestState;
  export function suppressFor(state: SuggestState, raw: string): SuggestState;
  export function topSuggestion(state: SuggestState): TitleSuggestion | null;
  export function suggestionLabel(hit: TitleSuggestion): string;
  export function akaNote(hit: TitleSuggestion): string | null;
  export function submitTextFor(hit: TitleSuggestion): string;
  export function tabHintLabel(open: boolean): string;
  ```

- [ ] **Step 1: Write the failing test**

Create `src/util/titleSuggest.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  emptySuggestState,
  shouldQuery,
  shouldQueryFor,
  applyReply,
  suppressFor,
  topSuggestion,
  suggestionLabel,
  akaNote,
  submitTextFor,
  tabHintLabel,
  SUGGEST_MIN_QUERY_LENGTH,
  type TitleSuggestion,
} from "./titleSuggest";

const KESTREL: TitleSuggestion = {
  imdbId: "tt0000001",
  title: "Kestrel",
  year: 2010,
  type: "movie",
  matchedAka: null,
};
const KEPLER: TitleSuggestion = {
  imdbId: "tt0000002",
  title: "Kepler",
  year: 2019,
  type: "tv",
  matchedAka: null,
};
const ASHFALL_AKA: TitleSuggestion = {
  imdbId: "tt0000003",
  title: "Ashfall",
  year: 1999,
  type: "movie",
  matchedAka: "Ashfall Rising",
};

describe("shouldQuery", () => {
  // Must agree with reccd's SEARCH_MIN_QUERY_LENGTH exactly: a lower number
  // fires requests guaranteed to return [], a higher one hides results reccd
  // would have given.
  it("matches reccd's minimum query length", () => {
    expect(SUGGEST_MIN_QUERY_LENGTH).toBe(2);
  });

  it("refuses anything shorter than two characters after trimming", () => {
    expect(shouldQuery("")).toBe(false);
    expect(shouldQuery(" ")).toBe(false);
    expect(shouldQuery("k")).toBe(false);
    expect(shouldQuery("  k  ")).toBe(false);
  });

  it("accepts two or more characters", () => {
    expect(shouldQuery("ke")).toBe(true);
    expect(shouldQuery("kestrel")).toBe(true);
    expect(shouldQuery("  ke  ")).toBe(true);
  });
});

describe("suggestionLabel", () => {
  // reccd's vocabulary is movie/tv; torlink says film/show everywhere else.
  it("renders a film with its year", () => {
    expect(suggestionLabel(KESTREL)).toBe("Kestrel (2010) · film");
  });

  it("renders a series as a show", () => {
    expect(suggestionLabel(KEPLER)).toBe("Kepler (2019) · show");
  });
});

describe("akaNote", () => {
  it("is null for a primary-title hit", () => {
    expect(akaNote(KESTREL)).toBeNull();
  });

  it("names the alternate title that caused the hit", () => {
    expect(akaNote(ASHFALL_AKA)).toBe('also known as "Ashfall Rising"');
  });
});

describe("submitTextFor", () => {
  // THE YEAR IS THE POINT. Canonicalising through a catalog is only worth
  // doing if it separates a remake from its original, and torrent release
  // names carry the year.
  it("includes the year", () => {
    expect(submitTextFor(KESTREL)).toBe("Kestrel 2010");
  });

  it("uses the primary title even when the hit came via an AKA", () => {
    expect(submitTextFor(ASHFALL_AKA)).toBe("Ashfall 1999");
  });
});

describe("applyReply", () => {
  it("applies a reply newer than the last one applied", () => {
    const next = applyReply(emptySuggestState(), 1, [KESTREL]);
    expect(next.items).toEqual([KESTREL]);
    expect(next.appliedSeq).toBe(1);
  });

  /**
   * MUTATION GUARD — the stale-response bug, which is real here rather than
   * hypothetical. reccd answers q="th" in ~311ms and q="dark kni" in ~71ms
   * (its own measured numbers), so the broad, stale reply lands AFTER the
   * narrow fresh one and would overwrite it: the list would disagree with the
   * input box. Debouncing does not fix this — two keystroke bursts separated
   * by more than the debounce window both fire, and nothing orders the replies.
   */
  it("discards a reply older than the newest one applied", () => {
    const fresh = applyReply(emptySuggestState(), 2, [KEPLER]);
    const stale = applyReply(fresh, 1, [KESTREL]);
    expect(stale.items).toEqual([KEPLER]);
    expect(stale.appliedSeq).toBe(2);
    expect(stale).toBe(fresh);
  });

  it("discards a reply whose seq equals the one already applied", () => {
    const first = applyReply(emptySuggestState(), 3, [KEPLER]);
    expect(applyReply(first, 3, [KESTREL]).items).toEqual([KEPLER]);
  });

  it("applies an empty reply, clearing what was there", () => {
    const some = applyReply(emptySuggestState(), 1, [KESTREL]);
    expect(applyReply(some, 2, []).items).toEqual([]);
  });
});

describe("shouldQueryFor", () => {
  it("defers to shouldQuery when nothing is suppressed", () => {
    expect(shouldQueryFor(emptySuggestState(), "ke")).toBe(true);
    expect(shouldQueryFor(emptySuggestState(), "k")).toBe(false);
  });

  // Accepting a suggestion writes its text into the box, which fires the
  // change handler again — without this the list would immediately reopen on
  // the text the user just picked. Escape reuses the same latch.
  it("refuses the exact text that was suppressed", () => {
    const s = suppressFor(emptySuggestState(), "Kestrel 2010");
    expect(shouldQueryFor(s, "Kestrel 2010")).toBe(false);
    expect(shouldQueryFor(s, "  Kestrel 2010  ")).toBe(false);
  });

  it("queries again as soon as the text changes", () => {
    const s = suppressFor(emptySuggestState(), "Kestrel 2010");
    expect(shouldQueryFor(s, "Kestrel 2010 1080p")).toBe(true);
  });
});

describe("suppressFor", () => {
  it("clears the list so nothing is left on screen", () => {
    const some = applyReply(emptySuggestState(), 1, [KESTREL, KEPLER]);
    expect(suppressFor(some, "ke").items).toEqual([]);
  });

  // The seq must survive: a request fired before Escape is still in flight,
  // and resetting the counter would let its reply reopen the dismissed list.
  it("keeps the applied seq so an in-flight reply cannot reopen the list", () => {
    const some = applyReply(emptySuggestState(), 4, [KESTREL]);
    const dismissed = suppressFor(some, "ke");
    expect(dismissed.appliedSeq).toBe(4);
    expect(applyReply(dismissed, 3, [KEPLER]).items).toEqual([]);
  });
});

describe("topSuggestion", () => {
  it("is null with no items", () => {
    expect(topSuggestion(emptySuggestState())).toBeNull();
  });

  it("is reccd's best-first first item", () => {
    const s = applyReply(emptySuggestState(), 1, [KESTREL, KEPLER]);
    expect(topSuggestion(s)).toEqual(KESTREL);
  });
});

describe("tabHintLabel", () => {
  it("offers completion while a list is open and browse otherwise", () => {
    expect(tabHintLabel(true)).toBe("complete");
    expect(tabHintLabel(false)).toBe("browse");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/util/titleSuggest.test.ts`
Expected: FAIL — `Failed to resolve import "./titleSuggest"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/util/titleSuggest.ts`:

```ts
// Title autocomplete against reccd's `GET /search`, shared by both front ends.
//
// Everything here is pure and free of I/O and DOM, because both surfaces need
// the same answers and neither one's wiring is unit-testable: `app.ts` has no
// jsdom to run in, and the Ink tree is verified by rendering it. So the
// decisions live here, where they can be pinned by a test.

/** reccd's own vocabulary for what a title is. */
export type TitleSuggestionType = "movie" | "tv";

/**
 * One hit from reccd's `GET /search`, narrowed to what torlink renders.
 *
 * reccd also returns `genres`, `rating` and `votes` (its `SearchHit extends
 * CatalogTitle`). They are dropped at the client boundary: nothing on screen
 * uses them, and carrying unused fields through `wire.ts` invites a future
 * reader to assume something does.
 */
export interface TitleSuggestion {
  imdbId: string;
  title: string;
  year: number;
  type: TitleSuggestionType;
  /**
   * The alternate title that caused the hit, or null for a primary-title hit.
   * This is what lets the UI say "you typed X, we mean Y" — the reason reccd
   * returns it at all.
   */
  matchedAka: string | null;
}

/**
 * Matches reccd's `SEARCH_MIN_QUERY_LENGTH` (`reccd/src/api/server.ts:70`)
 * exactly. A smaller number fires requests reccd answers with `[]` and no DB
 * round trip; a larger one hides results reccd would have given.
 */
export const SUGGEST_MIN_QUERY_LENGTH = 2;

/** Asked for. The terminal renders 5 of these and the browser all 8. */
export const SUGGEST_LIMIT = 8;

/**
 * reccd's own measured latency is 174–311ms for broad prefixes, so this is
 * deliberately slower than the 150ms `useTitlePreview` uses against OMDb —
 * at 150ms the requests would queue behind each other.
 */
export const SUGGEST_DEBOUNCE_MS = 250;

/**
 * Not the 10s `fetchRecommendations` uses. A suggestion arriving after ten
 * seconds is noise: the user has finished typing and pressed Enter.
 */
export const SUGGEST_TIMEOUT_MS = 2500;

/** Vertical space is scarce in a terminal; the browser has no such limit. */
export const SUGGEST_ROWS_TERMINAL = 5;

export interface SuggestState {
  items: TitleSuggestion[];
  /**
   * The sequence number of the newest reply applied. Replies arrive out of
   * order (see `applyReply`), and this is what makes that harmless.
   */
  appliedSeq: number;
  /**
   * Text the user has already resolved — by accepting a suggestion or by
   * dismissing the list — for which no further request should fire.
   * Trimmed. Null when nothing is suppressed.
   */
  suppressedText: string | null;
}

export function emptySuggestState(): SuggestState {
  return { items: [], appliedSeq: 0, suppressedText: null };
}

export function shouldQuery(raw: string): boolean {
  return raw.trim().length >= SUGGEST_MIN_QUERY_LENGTH;
}

export function shouldQueryFor(state: SuggestState, raw: string): boolean {
  if (!shouldQuery(raw)) return false;
  return raw.trim() !== state.suppressedText;
}

/**
 * Fold a reply into the state, ignoring it if a newer one already landed.
 *
 * THIS GUARD IS LOAD-BEARING. reccd answers a two-character query in ~311ms
 * and an eight-character one in ~71ms, so typing through a broad prefix leaves
 * the slow, stale reply to land after the fast, fresh one. Without the
 * sequence check the visible list would disagree with the input box, and
 * debouncing does not help: two bursts separated by more than the debounce
 * window both fire and nothing orders their replies.
 */
export function applyReply(state: SuggestState, seq: number, items: TitleSuggestion[]): SuggestState {
  if (seq <= state.appliedSeq) return state;
  return { ...state, items, appliedSeq: seq };
}

/**
 * Close the list and stop asking about `raw`. Used by both accepting a
 * suggestion and dismissing with escape — accepting writes the suggestion's
 * text into the box, which fires the change handler again, and without this
 * the list would reopen on the text just picked.
 *
 * `appliedSeq` deliberately survives, so a request fired before this cannot
 * reopen the list when it answers.
 */
export function suppressFor(state: SuggestState, raw: string): SuggestState {
  return { ...state, items: [], suppressedText: raw.trim() };
}

export function topSuggestion(state: SuggestState): TitleSuggestion | null {
  return state.items[0] ?? null;
}

/** e.g. `Kestrel (2010) · film`. */
export function suggestionLabel(hit: TitleSuggestion): string {
  // reccd says movie/tv; torlink says film/show everywhere a user can read it.
  const kind = hit.type === "tv" ? "show" : "film";
  return `${hit.title} (${hit.year}) · ${kind}`;
}

/** The "you typed X, we mean Y" line, or null for a primary-title hit. */
export function akaNote(hit: TitleSuggestion): string | null {
  return hit.matchedAka === null ? null : `also known as "${hit.matchedAka}"`;
}

/**
 * What accepting this suggestion puts in the search box.
 *
 * Title AND year. The year is why canonicalising through a catalog is worth
 * doing: it separates a remake from its original, and torrent release names
 * carry it. Note `ForYou` submits title only — see the spec's known limits.
 */
export function submitTextFor(hit: TitleSuggestion): string {
  return `${hit.title} ${hit.year}`;
}

/** The splash's Tab hint, which changes meaning while a list is open. */
export function tabHintLabel(open: boolean): string {
  return open ? "complete" : "browse";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/util/titleSuggest.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add src/util/titleSuggest.ts src/util/titleSuggest.test.ts
git commit -m "feat(util): title suggestion model, with the stale-reply guard"
```

---

## Task 2: Fetch suggestions from reccd

**Files:**
- Modify: `src/recc/client.ts` (append after `fetchRecommendations`, which ends at line 138)
- Test: `src/recc/client.test.ts` (append a new `describe`)

**Interfaces:**
- Consumes: `TitleSuggestion`, `SUGGEST_LIMIT`, `SUGGEST_TIMEOUT_MS` from `src/util/titleSuggest.ts` (Task 1). `ReccClientConfig` and `FetchImpl` already exist in this file.
- Produces:
  ```ts
  export type FetchTitleSuggestionsResult =
    | { ok: true; items: TitleSuggestion[] }
    | { ok: false; error: string };
  export function fetchTitleSuggestions(
    config: ReccClientConfig,
    query: { q: string; limit?: number },
    opts?: { fetchImpl?: FetchImpl; timeoutMs?: number },
  ): Promise<FetchTitleSuggestionsResult>;
  ```

- [ ] **Step 1: Write the failing test**

Append to `src/recc/client.test.ts`. Also extend its import line to
`import { postEvent, fetchRecommendations, fetchTitleSuggestions } from "./client.js";`

```ts
describe("fetchTitleSuggestions", () => {
  const HIT = {
    imdbId: "tt0000001",
    title: "Kestrel",
    year: 2010,
    type: "movie",
    matchedAka: null,
  };
  // reccd returns more than torlink models — this is what actually comes back.
  const WIRE_HIT = { ...HIT, genres: ["Drama"], rating: 7.4, votes: 90000 };

  it("gets {reccUrl}/search with q, limit and a bearer token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(200, [WIRE_HIT]));
    const res = await fetchTitleSuggestions(
      { reccUrl: "http://localhost:4100", reccToken: "dev-token" },
      { q: "kes" },
      { fetchImpl },
    );
    expect(res).toEqual({ ok: true, items: [HIT] });
    const [url, init] = fetchImpl.mock.calls[0] as [string, { method: string; headers: Record<string, string> }];
    expect(url).toBe("http://localhost:4100/search?q=kes&limit=8");
    expect(init.method).toBe("GET");
    expect(init.headers.authorization).toBe("Bearer dev-token");
  });

  it("drops the fields torlink does not render", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(200, [WIRE_HIT]));
    const res = await fetchTitleSuggestions({ reccUrl: "http://r", reccToken: "t" }, { q: "kes" }, { fetchImpl });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.items[0]).not.toHaveProperty("votes");
    expect(res.items[0]).not.toHaveProperty("rating");
    expect(res.items[0]).not.toHaveProperty("genres");
  });

  // reccd parses a trailing year out of q itself, and its own fallback rescues
  // titles that genuinely end in a year. Stripping it here would break both.
  it("forwards a year in the query verbatim rather than parsing it out", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(200, []));
    await fetchTitleSuggestions({ reccUrl: "http://r", reccToken: "t" }, { q: "kestrel 2010" }, { fetchImpl });
    const [url] = fetchImpl.mock.calls[0] as [string];
    expect(url).toBe("http://r/search?q=kestrel+2010&limit=8");
  });

  it("does not call fetch at all when reccUrl is not configured", async () => {
    const fetchImpl = vi.fn();
    const res = await fetchTitleSuggestions({}, { q: "kes" }, { fetchImpl });
    expect(res.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports a rejected token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(401, { error: "unauthorized" }));
    const res = await fetchTitleSuggestions({ reccUrl: "http://r", reccToken: "bad" }, { q: "kes" }, { fetchImpl });
    expect(res).toEqual({ ok: false, error: "reccd rejected the token — check reccToken" });
  });

  // A reccd predating GET /search 404s. That is "this feature is unavailable",
  // not a fault, and must leave the search box behaving exactly as it does now.
  it("treats a 404 as an older reccd without the endpoint", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(404, { error: "not found" }));
    const res = await fetchTitleSuggestions({ reccUrl: "http://r", reccToken: "t" }, { q: "kes" }, { fetchImpl });
    expect(res).toEqual({ ok: false, error: "this reccd has no title search" });
  });

  it("reports any other non-ok status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(500));
    const res = await fetchTitleSuggestions({ reccUrl: "http://r", reccToken: "t" }, { q: "kes" }, { fetchImpl });
    expect(res.ok).toBe(false);
  });

  it("rejects a body that is not an array", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(200, { items: [WIRE_HIT] }));
    const res = await fetchTitleSuggestions({ reccUrl: "http://r", reccToken: "t" }, { q: "kes" }, { fetchImpl });
    expect(res.ok).toBe(false);
  });

  // All-or-nothing, matching isRecommendation: a body we only half understand
  // is a contract change, and silently rendering the half we parsed would hide
  // it until someone noticed rows missing.
  it("rejects the whole array when one member is malformed", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(200, [WIRE_HIT, { imdbId: "tt2" }]));
    const res = await fetchTitleSuggestions({ reccUrl: "http://r", reccToken: "t" }, { q: "kes" }, { fetchImpl });
    expect(res.ok).toBe(false);
  });

  it("rejects a hit whose type is neither movie nor tv", async () => {
    const bad = { ...WIRE_HIT, type: "tvEpisode" };
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(200, [bad]));
    const res = await fetchTitleSuggestions({ reccUrl: "http://r", reccToken: "t" }, { q: "kes" }, { fetchImpl });
    expect(res.ok).toBe(false);
  });

  it("accepts a hit that matched on an AKA", async () => {
    const aka = { ...WIRE_HIT, matchedAka: "Ashfall Rising" };
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(200, [aka]));
    const res = await fetchTitleSuggestions({ reccUrl: "http://r", reccToken: "t" }, { q: "ash" }, { fetchImpl });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.items[0]?.matchedAka).toBe("Ashfall Rising");
  });

  it("never throws on a network error", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await fetchTitleSuggestions({ reccUrl: "http://r", reccToken: "t" }, { q: "kes" }, { fetchImpl });
    expect(res.ok).toBe(false);
  });

  it("honours an explicit limit", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(200, []));
    await fetchTitleSuggestions({ reccUrl: "http://r", reccToken: "t" }, { q: "kes", limit: 3 }, { fetchImpl });
    const [url] = fetchImpl.mock.calls[0] as [string];
    expect(url).toBe("http://r/search?q=kes&limit=3");
  });

  it("still fires with an empty bearer token when reccToken is omitted", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(200, []));
    await fetchTitleSuggestions({ reccUrl: "http://r" }, { q: "kes" }, { fetchImpl });
    const [, init] = fetchImpl.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers.authorization).toBe("Bearer ");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/recc/client.test.ts`
Expected: FAIL — `fetchTitleSuggestions is not a function` (or an import error).

- [ ] **Step 3: Write minimal implementation**

Append to `src/recc/client.ts`, and add to its imports at the top:

```ts
import {
  SUGGEST_LIMIT,
  SUGGEST_TIMEOUT_MS,
  type TitleSuggestion,
  type TitleSuggestionType,
} from "../util/titleSuggest";
```

Then append:

```ts
export type FetchTitleSuggestionsResult =
  | { ok: true; items: TitleSuggestion[] }
  | { ok: false; error: string };

function isSuggestionType(v: unknown): v is TitleSuggestionType {
  return v === "movie" || v === "tv";
}

// All-or-nothing, like isRecommendation above: a body we only half understand
// is a contract change, and rendering the half we parsed would hide it.
function isTitleSuggestion(v: unknown): v is TitleSuggestion & Record<string, unknown> {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.imdbId === "string" &&
    typeof r.title === "string" &&
    typeof r.year === "number" &&
    isSuggestionType(r.type) &&
    (r.matchedAka === null || typeof r.matchedAka === "string")
  );
}

/**
 * reccd's `GET /search` — partial input to a ranked list of catalog titles.
 *
 * A blocking read like `fetchRecommendations`, and a discriminated result for
 * the same reason. But the CALLERS treat failure differently: this fires per
 * keystroke, so every one of these errors is rendered as "no suggestions" and
 * nothing else. An error banner per keystroke is worse than no suggestions.
 *
 * `q` is sent verbatim. reccd parses a trailing year out of it itself and has
 * its own literal-interpretation fallback for titles that genuinely end in a
 * year, so stripping one here would break both.
 */
export async function fetchTitleSuggestions(
  config: ReccClientConfig,
  query: { q: string; limit?: number },
  opts: { fetchImpl?: FetchImpl; timeoutMs?: number } = {},
): Promise<FetchTitleSuggestionsResult> {
  if (!config.reccUrl) return { ok: false, error: "title search not configured" };
  const fetchImpl = opts.fetchImpl ?? (fetch as FetchImpl);
  const params = new URLSearchParams();
  params.set("q", query.q);
  params.set("limit", String(query.limit ?? SUGGEST_LIMIT));
  try {
    const res = await fetchImpl(`${config.reccUrl}/search?${params.toString()}`, {
      method: "GET",
      headers: { authorization: `Bearer ${config.reccToken ?? ""}` },
      signal: AbortSignal.timeout(opts.timeoutMs ?? SUGGEST_TIMEOUT_MS),
    });
    if (res.status === 401) return { ok: false, error: "reccd rejected the token — check reccToken" };
    // A reccd older than the /search endpoint. Not a fault — the feature is
    // simply unavailable, and the search box must behave as it did before.
    if (res.status === 404) return { ok: false, error: "this reccd has no title search" };
    if (!res.ok) return { ok: false, error: `title search unavailable (HTTP ${res.status})` };
    const body: unknown = await res.json();
    if (!Array.isArray(body) || !body.every(isTitleSuggestion)) {
      return { ok: false, error: "unexpected response from reccd" };
    }
    // Narrowed deliberately: reccd also sends genres, rating and votes, and
    // nothing here renders them.
    const items: TitleSuggestion[] = body.map((r) => ({
      imdbId: r.imdbId,
      title: r.title,
      year: r.year,
      type: r.type,
      matchedAka: r.matchedAka,
    }));
    return { ok: true, items };
  } catch (err) {
    log.debug(
      `recc fetchTitleSuggestions: failed to reach ${config.reccUrl}/search: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { ok: false, error: "couldn't reach reccd" };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/recc/client.test.ts`
Expected: PASS, including the pre-existing `postEvent` and `fetchRecommendations` blocks.

- [ ] **Step 5: Commit**

```bash
git add src/recc/client.ts src/recc/client.test.ts
git commit -m "feat(recc): fetch title suggestions from reccd's GET /search"
```

---

## Task 3: The browser's proxy route and capability flag

**Files:**
- Modify: `src/web/wire.ts` (`SourcesResponse` at line 340; append the new response type near `PublicRecommendations`, around line 541)
- Modify: `src/web/routes.ts` (`WebDeps` around line 153; `sourcesResponse` around line 726; a new handler beside `recommendations` around line 1426; dispatch beside `/api/recommendations` at line 1627)
- Test: `src/web/routes.test.ts`

**Interfaces:**
- Consumes: `fetchTitleSuggestions`, `FetchTitleSuggestionsResult` (Task 2); `TitleSuggestion`, `SUGGEST_LIMIT` (Task 1); the existing `resolveReccConfig` (`src/config/config.ts:257`).
- Produces:
  ```ts
  // src/web/wire.ts
  export type PublicTitleSuggestions =
    | { status: "ok"; items: TitleSuggestion[] }
    | { status: "not-configured" }
    | { status: "error"; error: string };
  // SourcesResponse gains:
  reccConfigured: boolean;
  // src/web/routes.ts WebDeps gains:
  fetchTitleSuggestionsImpl?: (
    config: ReccClientConfig,
    query: { q: string; limit?: number },
  ) => Promise<FetchTitleSuggestionsResult>;
  // route: GET /api/title-search?q=
  ```

- [ ] **Step 1: Write the failing test**

Append to `src/web/routes.test.ts`. Reuse that file's existing `deps`, `searchConfig`, `handleWebApi` and `AUTH` helpers exactly as the `GET /api/recommendations` block at line 1910 does.

```ts
describe("GET /api/title-search", () => {
  const HIT = {
    imdbId: "tt0000001",
    title: "Kestrel",
    year: 2010,
    type: "movie" as const,
    matchedAka: null,
  };

  beforeEach(() => {
    // Both override the config file inside resolveReccConfig, so a developer
    // with a real reccd exported would never see the not-configured path — and
    // the "configured" tests would talk to their actual service.
    vi.stubEnv("TORLINK_RECC_URL", "");
    vi.stubEnv("TORLINK_RECC_TOKEN", "");
  });

  function suggestDeps(over: Partial<WebDeps> = {}): WebDeps {
    return deps({
      loadConfigImpl: async () => searchConfig({ reccUrl: "http://recc.local", reccToken: "t" }),
      fetchTitleSuggestionsImpl: async () => ({ ok: true, items: [HIT] }),
      ...over,
    });
  }

  function look(d: WebDeps, qs = "q=kes"): Promise<WebResponse> {
    return handleWebApi(d, "GET", "/api/title-search", new URLSearchParams(qs), AUTH, "");
  }

  // The gate is the only thing between an anonymous caller and the user's
  // reccd: this route does not delegate to handleApi, so nothing re-checks.
  it("rejects an unauthenticated caller when a token is set", async () => {
    const fetchTitleSuggestionsImpl = vi.fn(async () => ({ ok: true as const, items: [HIT] }));
    const res = await handleWebApi(
      suggestDeps({ token: "secret", fetchTitleSuggestionsImpl }),
      "GET",
      "/api/title-search",
      new URLSearchParams("q=kes"),
      undefined,
      "",
    );
    expect(res.status).toBe(401);
    expect(fetchTitleSuggestionsImpl).not.toHaveBeenCalled();
  });

  it("returns reccd's hits", async () => {
    const res = await look(suggestDeps());
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ status: "ok", items: [HIT] });
  });

  /**
   * 200 with its own status, NOT a 500 — the same call `/api/recommendations`
   * and `/api/title` make. Nothing is broken: the user has no reccd, and the
   * browser needs to be able to tell that apart from the server falling over.
   */
  it("answers not-configured without asking reccd", async () => {
    const fetchTitleSuggestionsImpl = vi.fn(async () => ({ ok: true as const, items: [HIT] }));
    const res = await look(
      suggestDeps({ loadConfigImpl: async () => searchConfig({}), fetchTitleSuggestionsImpl }),
    );
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ status: "not-configured" });
    expect(fetchTitleSuggestionsImpl).not.toHaveBeenCalled();
  });

  it("reports a reccd failure as a status, not a 500", async () => {
    const res = await look(
      suggestDeps({ fetchTitleSuggestionsImpl: async () => ({ ok: false, error: "couldn't reach reccd" }) }),
    );
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ status: "error", error: "couldn't reach reccd" });
  });

  /**
   * THE WHOLE REASON THIS ROUTE EXISTS. The browser must never be able to read
   * the reccd token or URL — if it could, the TUI's proxy would be pointless
   * and a shared link would leak the user's server.
   *
   * Asserted against the SERIALISED body, and with a token value that appears
   * nowhere else in the fixture, so the negative cannot quietly go vacuous.
   */
  it("leaks neither the reccd token nor its URL", async () => {
    const res = await look(
      suggestDeps({
        loadConfigImpl: async () =>
          searchConfig({ reccUrl: "http://recc.internal:4100", reccToken: "zzq-secret-9317" }),
      }),
    );
    const body = JSON.stringify(res.json);
    expect(body).not.toContain("zzq-secret-9317");
    expect(body).not.toContain("recc.internal");
  });

  it("400s a missing q rather than asking reccd for everything", async () => {
    const fetchTitleSuggestionsImpl = vi.fn(async () => ({ ok: true as const, items: [HIT] }));
    const res = await look(suggestDeps({ fetchTitleSuggestionsImpl }), "");
    expect(res.status).toBe(400);
    expect(fetchTitleSuggestionsImpl).not.toHaveBeenCalled();
  });

  // reccd answers a short q with [] and no DB round trip; not asking at all is
  // the same answer for free.
  it("answers a too-short q with an empty ok, without asking reccd", async () => {
    const fetchTitleSuggestionsImpl = vi.fn(async () => ({ ok: true as const, items: [HIT] }));
    const res = await look(suggestDeps({ fetchTitleSuggestionsImpl }), "q=k");
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ status: "ok", items: [] });
    expect(fetchTitleSuggestionsImpl).not.toHaveBeenCalled();
  });

  it("forwards the query verbatim, year and all", async () => {
    const fetchTitleSuggestionsImpl = vi.fn(async () => ({ ok: true as const, items: [] }));
    await look(suggestDeps({ fetchTitleSuggestionsImpl }), "q=kestrel+2010");
    expect(fetchTitleSuggestionsImpl).toHaveBeenCalledWith(
      expect.objectContaining({ reccUrl: "http://recc.local" }),
      { q: "kestrel 2010", limit: 8 },
    );
  });
});

describe("GET /api/sources reccConfigured", () => {
  beforeEach(() => {
    vi.stubEnv("TORLINK_RECC_URL", "");
    vi.stubEnv("TORLINK_RECC_TOKEN", "");
  });

  async function flag(config: Parameters<typeof searchConfig>[0]): Promise<boolean> {
    const res = await handleWebApi(
      deps({ loadConfigImpl: async () => searchConfig(config) }),
      "GET",
      "/api/sources",
      new URLSearchParams(),
      AUTH,
      "",
    );
    return (res.json as { reccConfigured: boolean }).reccConfigured;
  }

  it("is false with no reccd", async () => {
    expect(await flag({})).toBe(false);
  });

  it("is true with a configured reccUrl", async () => {
    expect(await flag({ reccUrl: "http://recc.local", reccToken: "t" })).toBe(true);
  });

  // resolveReccConfig, not raw config.reccUrl — the browser must agree with the
  // TUI about whether reccd is on, and the TUI resolves it this way.
  it("counts TORLINK_RECC_URL", async () => {
    vi.stubEnv("TORLINK_RECC_URL", "http://recc.env");
    expect(await flag({})).toBe(true);
  });

  it("never carries the URL or token alongside the flag", async () => {
    const res = await handleWebApi(
      deps({
        loadConfigImpl: async () =>
          searchConfig({ reccUrl: "http://recc.internal:4100", reccToken: "zzq-secret-9317" }),
      }),
      "GET",
      "/api/sources",
      new URLSearchParams(),
      AUTH,
      "",
    );
    const body = JSON.stringify(res.json);
    expect(body).not.toContain("zzq-secret-9317");
    expect(body).not.toContain("recc.internal");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/web/routes.test.ts`
Expected: FAIL — `fetchTitleSuggestionsImpl` is not a known `WebDeps` property, and `reccConfigured` is `undefined`.

- [ ] **Step 3: Write minimal implementation**

**3a.** In `src/web/wire.ts`, add the import at the top:

```ts
import type { TitleSuggestion } from "../util/titleSuggest";
```

Add to `SourcesResponse` (after `omdbConfigured`, around line 389):

```ts
  /**
   * Whether reccd is configured (file or `TORLINK_RECC_URL`), which is what
   * makes title autocomplete available.
   *
   * A capability flag, never the URL or the token — the same contract as
   * `debridConfigured` and `omdbConfigured`, and here for the same reason:
   * this is the one payload the browser fetches before it can render anything.
   *
   * WHAT IT SAVES. Without it, a reccd-less server has every keystroke in the
   * search box fire `/api/title-search` purely to be told
   * `{status: "not-configured"}` — a request per character to learn a fact
   * that is true for the whole session.
   */
  reccConfigured: boolean;
```

Add near `PublicRecommendations`:

```ts
/**
 * The body of `GET /api/title-search?q=`.
 *
 * THE SAME THREE-WAY SHAPE AS `PublicRecommendations` AND `PublicTitleMeta`,
 * deliberately: "the server has no reccd" is a thing the UI must be able to
 * say, not a failure, and a fourth bespoke encoding of that idea would be
 * drift.
 *
 * `"error"` carries reccd's own message so the browser and the TUI could show
 * the same sentence — but the browser deliberately does not. This fires per
 * keystroke, and an error banner per character is worse than no suggestions,
 * so the browser renders every non-`"ok"` status as an empty list. The field
 * is here because throwing the reason away at the wire would make a broken
 * reccd indistinguishable from a working one with no matches.
 */
export type PublicTitleSuggestions =
  | { status: "ok"; items: TitleSuggestion[] }
  | { status: "not-configured" }
  | { status: "error"; error: string };
```

**3b.** In `src/web/routes.ts`, extend the imports:

```ts
import { fetchTitleSuggestions, type FetchTitleSuggestionsResult } from "../recc/client";
import { shouldQuery, SUGGEST_LIMIT } from "../util/titleSuggest";
import type { PublicTitleSuggestions } from "./wire";
```

(`fetchRecommendations`, `postEvent`, `ReccClientConfig`, `resolveReccConfig` and `PublicRecommendations` are already imported — extend the existing import statements rather than adding duplicates.)

Add to `WebDeps`, after `fetchRecommendationsImpl`:

```ts
  /** reccd's title search, for `/api/title-search`. Injected to keep tests off the network. */
  fetchTitleSuggestionsImpl?: (
    config: ReccClientConfig,
    query: { q: string; limit?: number },
  ) => Promise<FetchTitleSuggestionsResult>;
```

In `sourcesResponse`, after the `omdbConfigured` line:

```ts
    // resolveReccConfig, not config.reccUrl, so TORLINK_RECC_URL counts — the
    // browser must agree with the TUI about whether reccd is on, and the TUI
    // resolves it the same way. A boolean, never the URL or the token.
    reccConfigured: resolveReccConfig(config).reccUrl !== undefined,
```

Add the handler after `recommendations` / before `RECC_EVENTS`:

```ts
/**
 * `GET /api/title-search?q=` — reccd's catalog search, proxied.
 *
 * THIS ROUTE EXISTS SO THE BROWSER NEVER SEES `reccToken`. The TUI calls
 * `fetchTitleSuggestions` directly; a page cannot, and handing it the token so
 * it could would put the user's reccd credentials in a tab.
 *
 * `loadConfig()` per request, not a boot snapshot, for the same reason
 * `recommendations` does it: a reccd URL can be pasted into the Accounts pane
 * at any moment, and `serve --web` is a separate process from any running TUI.
 */
async function titleSearch(deps: WebDeps, query: URLSearchParams): Promise<WebResponse> {
  const raw = query.get("q");
  // Absent, not empty: a client that forgot the param is a bug worth a 400,
  // and it matches reccd's own behaviour for a missing q.
  if (raw === null) return { status: 400, json: { error: "missing q" } };

  const config = await (deps.loadConfigImpl ?? loadConfig)();
  const reccConfig = resolveReccConfig(config);
  if (!reccConfig.reccUrl) {
    const out: PublicTitleSuggestions = { status: "not-configured" };
    return { status: 200, json: out };
  }

  // reccd answers a shorter query with [] and no DB round trip. Not asking is
  // the same answer without the round trip, and it keeps the min-length rule in
  // exactly one place (util/titleSuggest.ts) for both front ends.
  if (!shouldQuery(raw)) {
    const out: PublicTitleSuggestions = { status: "ok", items: [] };
    return { status: 200, json: out };
  }

  // `fetchTitleSuggestions` never throws and bounds itself with its own
  // timeout, so a reccd that is down or hanging costs this request that timeout
  // and nothing else.
  const result = await (deps.fetchTitleSuggestionsImpl ?? fetchTitleSuggestions)(reccConfig, {
    q: raw,
    limit: SUGGEST_LIMIT,
  });
  if (!result.ok) {
    const out: PublicTitleSuggestions = { status: "error", error: result.error };
    return { status: 200, json: out };
  }
  // Assigned, not re-mapped: the client already narrowed reccd's row to the
  // fields torlink renders, and this assignment is where the compiler checks
  // that `TitleSuggestion` and the wire type still agree.
  const out: PublicTitleSuggestions = { status: "ok", items: result.items };
  return { status: 200, json: out };
}
```

Add the dispatch entry immediately after the `/api/recommendations` one, inside the same past-the-token-gate block:

```ts
  if (method === "GET" && urlPath === "/api/title-search") {
    return titleSearch(deps, query);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/web/routes.test.ts`
Expected: PASS. If pre-existing `/api/sources` tests fail on an exact-object match, add `reccConfigured` to their expected objects — do not weaken the assertion to `objectContaining`.

- [ ] **Step 5: Commit**

```bash
git add src/web/wire.ts src/web/routes.ts src/web/routes.test.ts
git commit -m "feat(web): proxy reccd title search, and report reccConfigured"
```

---

## Task 4: The browser's list model

**Files:**
- Create: `src/web/static/suggestModel.ts`
- Test: `src/web/static/suggestModel.test.ts`

**Interfaces:**
- Consumes: everything from `src/util/titleSuggest.ts` (Task 1).
- Produces:
  ```ts
  export interface ListState { suggest: SuggestState; highlight: number } // -1 = none
  export function emptyListState(): ListState;
  export function isOpen(s: ListState): boolean;
  export function withReply(s: ListState, seq: number, items: TitleSuggestion[]): ListState;
  export function moveHighlight(s: ListState, delta: 1 | -1): ListState;
  export function highlightAt(s: ListState, index: number): ListState;
  export function closedFor(s: ListState, raw: string): ListState;
  export function acceptPlan(s: ListState, raw: string): { kind: "suggestion" | "raw"; text: string };
  export function rowPlan(s: ListState): { label: string; aka: string | null; highlighted: boolean }[];
  ```

- [ ] **Step 1: Write the failing test**

Create `src/web/static/suggestModel.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  emptyListState,
  isOpen,
  withReply,
  moveHighlight,
  highlightAt,
  closedFor,
  acceptPlan,
  rowPlan,
} from "./suggestModel";
import { shouldQueryFor, type TitleSuggestion } from "../../util/titleSuggest";

const KESTREL: TitleSuggestion = {
  imdbId: "tt0000001", title: "Kestrel", year: 2010, type: "movie", matchedAka: null,
};
const KEPLER: TitleSuggestion = {
  imdbId: "tt0000002", title: "Kepler", year: 2019, type: "tv", matchedAka: null,
};
const ASHFALL_AKA: TitleSuggestion = {
  imdbId: "tt0000003", title: "Ashfall", year: 1999, type: "movie", matchedAka: "Ashfall Rising",
};

const THREE = [KESTREL, KEPLER, ASHFALL_AKA];

describe("isOpen", () => {
  it("is closed with nothing to show", () => {
    expect(isOpen(emptyListState())).toBe(false);
  });

  it("is open once there are hits", () => {
    expect(isOpen(withReply(emptyListState(), 1, [KESTREL]))).toBe(true);
  });

  it("is closed again when a reply brings nothing", () => {
    const open = withReply(emptyListState(), 1, [KESTREL]);
    expect(isOpen(withReply(open, 2, []))).toBe(false);
  });
});

describe("withReply", () => {
  it("starts with nothing highlighted, so Enter still submits what was typed", () => {
    expect(withReply(emptyListState(), 1, THREE).highlight).toBe(-1);
  });

  it("drops a highlight that a new, shorter reply would put out of range", () => {
    const moved = moveHighlight(withReply(emptyListState(), 1, THREE), 1);
    expect(moved.highlight).toBe(0);
    expect(withReply(moved, 2, [KEPLER]).highlight).toBe(-1);
  });

  // The stale-reply guard belongs to the shared model; this proves the browser
  // wrapper actually routes through it rather than assigning items directly.
  it("ignores a reply older than the newest applied", () => {
    const fresh = withReply(emptyListState(), 2, [KEPLER]);
    expect(withReply(fresh, 1, [KESTREL]).suggest.items).toEqual([KEPLER]);
  });
});

describe("moveHighlight", () => {
  it("enters the list from nothing on down", () => {
    expect(moveHighlight(withReply(emptyListState(), 1, THREE), 1).highlight).toBe(0);
  });

  it("enters at the last row from nothing on up", () => {
    expect(moveHighlight(withReply(emptyListState(), 1, THREE), -1).highlight).toBe(2);
  });

  it("wraps past the end", () => {
    let s = withReply(emptyListState(), 1, THREE);
    s = moveHighlight(s, 1);
    s = moveHighlight(s, 1);
    s = moveHighlight(s, 1);
    expect(s.highlight).toBe(2);
    expect(moveHighlight(s, 1).highlight).toBe(0);
  });

  it("wraps past the start", () => {
    const first = moveHighlight(withReply(emptyListState(), 1, THREE), 1);
    expect(moveHighlight(first, -1).highlight).toBe(2);
  });

  it("does nothing with a closed list", () => {
    expect(moveHighlight(emptyListState(), 1).highlight).toBe(-1);
  });
});

describe("highlightAt", () => {
  it("highlights the clicked row", () => {
    const s = highlightAt(withReply(emptyListState(), 1, THREE), 2);
    expect(s.highlight).toBe(2);
    expect(acceptPlan(s, "ash")).toEqual({ kind: "suggestion", text: "Ashfall 1999" });
  });

  // Ignored, not clamped: the only caller is a row's own listener, so an
  // out-of-range index means the rows changed under the click — and searching a
  // DIFFERENT title than the one clicked is worse than doing nothing.
  it("ignores an index the list no longer has", () => {
    const s = withReply(emptyListState(), 1, [KESTREL]);
    expect(highlightAt(s, 3).highlight).toBe(-1);
    expect(highlightAt(s, -1).highlight).toBe(-1);
  });
});

describe("acceptPlan", () => {
  // Enter with nothing highlighted must submit what the user typed. Silently
  // substituting a suggestion for their own words is the one thing autocomplete
  // must never do.
  it("submits the raw text when nothing is highlighted", () => {
    const s = withReply(emptyListState(), 1, THREE);
    expect(acceptPlan(s, "kes")).toEqual({ kind: "raw", text: "kes" });
  });

  it("submits the highlighted suggestion's title and year", () => {
    const s = moveHighlight(withReply(emptyListState(), 1, THREE), 1);
    expect(acceptPlan(s, "kes")).toEqual({ kind: "suggestion", text: "Kestrel 2010" });
  });

  it("uses the primary title when the highlight matched via an AKA", () => {
    let s = withReply(emptyListState(), 1, THREE);
    s = moveHighlight(s, -1);
    expect(acceptPlan(s, "ashfall ris")).toEqual({ kind: "suggestion", text: "Ashfall 1999" });
  });

  it("submits the raw text when the list is closed", () => {
    expect(acceptPlan(emptyListState(), "kes")).toEqual({ kind: "raw", text: "kes" });
  });
});

describe("closedFor", () => {
  it("closes the list and clears the highlight", () => {
    const s = moveHighlight(withReply(emptyListState(), 1, THREE), 1);
    const shut = closedFor(s, "kes");
    expect(isOpen(shut)).toBe(false);
    expect(shut.highlight).toBe(-1);
  });

  // Escape must stick. Without the suppression latch the next debounce tick
  // would re-fire the same query and reopen what the user just dismissed.
  it("stops the same text being queried again", () => {
    const shut = closedFor(withReply(emptyListState(), 1, THREE), "kes");
    expect(shouldQueryFor(shut.suggest, "kes")).toBe(false);
    expect(shouldQueryFor(shut.suggest, "kest")).toBe(true);
  });
});

describe("rowPlan", () => {
  it("is empty for a closed list", () => {
    expect(rowPlan(emptyListState())).toEqual([]);
  });

  it("labels every row and marks the highlighted one", () => {
    const s = moveHighlight(withReply(emptyListState(), 1, THREE), 1);
    expect(rowPlan(s)).toEqual([
      { label: "Kestrel (2010) · film", aka: null, highlighted: true },
      { label: "Kepler (2019) · show", aka: null, highlighted: false },
      { label: 'Ashfall (1999) · film', aka: 'also known as "Ashfall Rising"', highlighted: false },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/web/static/suggestModel.test.ts`
Expected: FAIL — `Failed to resolve import "./suggestModel"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/web/static/suggestModel.ts`:

```ts
import {
  akaNote,
  applyReply,
  emptySuggestState,
  submitTextFor,
  suggestionLabel,
  suppressFor,
  type SuggestState,
  type TitleSuggestion,
} from "../../util/titleSuggest";

// The search box's suggestion list, as state plus transitions.
//
// It lives here rather than in app.ts because every function below answers
// either "what should be on screen" or "what should be sent" — the two
// questions app.ts is not allowed to decide, since nothing in it is reachable
// by a test.

export interface ListState {
  suggest: SuggestState;
  /** Index into `suggest.items`, or -1 for "nothing highlighted". */
  highlight: number;
}

export function emptyListState(): ListState {
  return { suggest: emptySuggestState(), highlight: -1 };
}

export function isOpen(s: ListState): boolean {
  return s.suggest.items.length > 0;
}

/**
 * Fold in a reply from `/api/title-search`.
 *
 * The highlight resets to -1 rather than being preserved: the rows have
 * changed, so a kept index would point at a different title than the one the
 * user was looking at — and pressing Enter would then search for something
 * they never highlighted.
 */
export function withReply(s: ListState, seq: number, items: TitleSuggestion[]): ListState {
  const suggest = applyReply(s.suggest, seq, items);
  if (suggest === s.suggest) return s;
  return { suggest, highlight: -1 };
}

/** Move the highlight, wrapping, and entering the list from -1. */
export function moveHighlight(s: ListState, delta: 1 | -1): ListState {
  const n = s.suggest.items.length;
  if (n === 0) return s;
  if (s.highlight === -1) return { ...s, highlight: delta === 1 ? 0 : n - 1 };
  return { ...s, highlight: (s.highlight + delta + n) % n };
}

/**
 * Highlight a specific row — what a click means, before it accepts.
 *
 * Out-of-range indices are ignored rather than clamped: the only caller is a
 * row's own listener, so an out-of-range index means the rows changed under the
 * click, and accepting a *different* title than the one clicked is worse than
 * doing nothing.
 */
export function highlightAt(s: ListState, index: number): ListState {
  if (index < 0 || index >= s.suggest.items.length) return s;
  return { ...s, highlight: index };
}

/** Close the list, and stop asking about `raw` so it cannot reopen itself. */
export function closedFor(s: ListState, raw: string): ListState {
  return { suggest: suppressFor(s.suggest, raw), highlight: -1 };
}

/**
 * What to search for on Enter or a click.
 *
 * With nothing highlighted this is the raw text, always. Substituting a
 * suggestion for what the user actually typed is the one thing autocomplete
 * must never do silently.
 */
export function acceptPlan(s: ListState, raw: string): { kind: "suggestion" | "raw"; text: string } {
  const hit = s.highlight >= 0 ? s.suggest.items[s.highlight] : undefined;
  if (!hit) return { kind: "raw", text: raw };
  return { kind: "suggestion", text: submitTextFor(hit) };
}

/** One entry per row to render. Strings only — the caller sets textContent. */
export function rowPlan(s: ListState): { label: string; aka: string | null; highlighted: boolean }[] {
  return s.suggest.items.map((hit, i) => ({
    label: suggestionLabel(hit),
    aka: akaNote(hit),
    highlighted: i === s.highlight,
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/web/static/suggestModel.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/static/suggestModel.ts src/web/static/suggestModel.test.ts
git commit -m "feat(web): suggestion list model for the search box"
```

---

## Task 5: Wire the browser's search box

**Files:**
- Modify: `src/web/static/index.html` (the search card, lines 83-88)
- Modify: `src/web/static/styles.css`
- Modify: `src/web/static/app.ts` (element refs around line 230; a new section before the `searchForm` submit handler at line 1243)

**Interfaces:**
- Consumes: everything from `suggestModel.ts` (Task 4); `SUGGEST_DEBOUNCE_MS`, `shouldQueryFor` from `src/util/titleSuggest.ts` (Task 1); `PublicTitleSuggestions` from `./wire` (Task 3); the existing `authHeaders()` (`app.ts:301`), `sources` (the `SourcesResponse | null` module variable), and `searchForTitle(title, group?)` (`app.ts:2452`).
- Produces: nothing other tasks consume.

- [ ] **Step 1: Add the markup and styling**

In `src/web/static/index.html`, inside `<form id="search" class="card">`, immediately after the `<input id="query" …>` line, add:

```html
          <!-- Title suggestions from reccd, when it is configured. A full-width
               row inside the card's flex layout so it sits under the input
               rather than beside it. Empty and `hidden` until there is
               something to show; app.ts fills it with createElement +
               textContent, never innerHTML. -->
          <ul id="suggest" class="suggest" role="listbox" aria-label="Title suggestions" hidden></ul>
```

In `src/web/static/styles.css`, append:

```css
/* The search box's title suggestions. `flex: 1 0 100%` breaks it onto its own
   row inside .card, which lays its children out as a strip of controls. */
.suggest {
  flex: 1 0 100%;
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: 0.5rem;
  overflow: hidden;
}

.suggest li {
  padding: 0.4rem 0.6rem;
  cursor: pointer;
}

.suggest li + li {
  border-top: 1px solid var(--line);
}

.suggest li[aria-selected="true"],
.suggest li:hover {
  background: var(--line);
}

.suggest .aka {
  display: block;
  font-size: 0.75rem;
  color: var(--dim);
}
```

- [ ] **Step 2: Wire it in `app.ts`**

Add to the element refs near line 230, after `queryInput`:

```ts
const suggestList = el<HTMLUListElement>("suggest");
```

Add the imports to the existing import block:

```ts
import {
  emptyListState,
  isOpen as suggestOpen,
  withReply,
  moveHighlight,
  highlightAt,
  closedFor,
  acceptPlan,
  rowPlan,
  type ListState,
} from "./suggestModel.js";
import { SUGGEST_DEBOUNCE_MS, shouldQueryFor } from "../../util/titleSuggest.js";
import type { PublicTitleSuggestions } from "../wire.js";
```

(Match the extension convention the file already uses for its relative imports.)

Add this section immediately before the `searchForm.addEventListener("submit", …)` handler at line 1243:

```ts
// ---- title suggestions -------------------------------------------------

// Every decision here belongs to suggestModel.ts; this block is the timer, the
// fetch, the DOM, and the key handling. If you find yourself writing an `if`
// that decides what to show or what to send, it goes in the model.
let suggestState: ListState = emptyListState();
let suggestTimer: ReturnType<typeof setTimeout> | null = null;
// Monotonic, and the reason a slow reply cannot overwrite a fast one — see
// applyReply. A 2-char query costs reccd ~311ms and an 8-char one ~71ms, so
// out-of-order arrival is the normal case, not the edge case.
let suggestSeq = 0;

function renderSuggest(): void {
  suggestList.replaceChildren();
  const rows = rowPlan(suggestState);
  for (const [index, row] of rows.entries()) {
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    li.setAttribute("aria-selected", row.highlighted ? "true" : "false");
    // textContent, not innerHTML: a title is a string from a catalog we do not
    // control, and src/web/static has no innerHTML path anywhere by rule.
    const label = document.createElement("span");
    label.textContent = row.label;
    li.append(label);
    if (row.aka !== null) {
      const aka = document.createElement("span");
      aka.className = "aka";
      aka.textContent = row.aka;
      li.append(aka);
    }
    // mousedown, not click: click lands after the input has already blurred,
    // and a blur that closes the list would cancel the pick.
    li.addEventListener("mousedown", (event) => {
      event.preventDefault();
      // Reuse the keyboard path rather than a second accept: highlight the
      // clicked row, then accept, so a click and an Enter cannot drift apart.
      suggestState = highlightAt(suggestState, index);
      acceptSuggest();
    });
    suggestList.append(li);
  }
  suggestList.hidden = rows.length === 0;
}

function closeSuggest(): void {
  if (suggestTimer !== null) clearTimeout(suggestTimer);
  suggestTimer = null;
  suggestState = closedFor(suggestState, queryInput.value);
  renderSuggest();
}

/** Run whatever the model says this keypress or click means. */
function acceptSuggest(): void {
  const plan = acceptPlan(suggestState, queryInput.value);
  // Latch before searching: accepting writes text into the box, which fires the
  // input handler again, and without the latch the list would reopen on the
  // text just picked.
  suggestState = closedFor(suggestState, plan.text);
  renderSuggest();
  searchForTitle(plan.text);
}

async function loadSuggest(raw: string, seq: number): Promise<void> {
  try {
    const res = await fetch(`/api/title-search?q=${encodeURIComponent(raw)}`, {
      headers: authHeaders(),
    });
    if (!res.ok) return;
    const body = (await res.json()) as PublicTitleSuggestions;
    // Every non-ok status renders as no suggestions. This fires per keystroke,
    // so a banner per character would be worse than silence — and the Accounts
    // pane is where a reccd problem belongs.
    const items = body.status === "ok" ? body.items : [];
    suggestState = withReply(suggestState, seq, items);
    renderSuggest();
  } catch {
    // A suggestion we cannot fetch is a search box that behaves exactly as it
    // did before this feature existed. Nothing to report.
  }
}

queryInput.addEventListener("input", () => {
  if (suggestTimer !== null) clearTimeout(suggestTimer);
  // The capability flag from /api/sources, so a reccd-less server never spends
  // a request per character discovering that again.
  if (sources?.reccConfigured !== true) return;
  const raw = queryInput.value;
  if (!shouldQueryFor(suggestState.suggest, raw)) {
    suggestState = withReply(suggestState, ++suggestSeq, []);
    renderSuggest();
    return;
  }
  const seq = ++suggestSeq;
  suggestTimer = setTimeout(() => void loadSuggest(raw, seq), SUGGEST_DEBOUNCE_MS);
});

queryInput.addEventListener("keydown", (event) => {
  if (!suggestOpen(suggestState)) return;
  if (event.key === "ArrowDown") {
    event.preventDefault();
    suggestState = moveHighlight(suggestState, 1);
    renderSuggest();
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    suggestState = moveHighlight(suggestState, -1);
    renderSuggest();
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    closeSuggest();
    return;
  }
  if (event.key === "Enter") {
    // Only intercept when a row is actually highlighted; otherwise let the form
    // submit normally with what the user typed.
    if (suggestState.highlight < 0) {
      closeSuggest();
      return;
    }
    event.preventDefault();
    acceptSuggest();
  }
});

// Leaving the box closes the list — an open dropdown over a pane the user has
// moved on from is a stuck artefact, not a suggestion.
queryInput.addEventListener("blur", () => closeSuggest());
```

- [ ] **Step 3: Typecheck, lint, and build**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: PASS. `npm run build` is the only check that `src/web/static/` pulls in no `node:*` — `titleSuggest.ts` and `suggestModel.ts` must both be node-free.

- [ ] **Step 4: Verify by running it**

Nothing in `app.ts` is reachable by a unit test — there is no jsdom, deliberately. So run it:

```bash
npm run dev -- serve --web
```

With reccd configured, in the search box:
1. Type `ke` — suggestions appear after a beat.
2. `↓` highlights the first row; `↑` from nothing highlights the last; both wrap.
3. `Enter` on a highlight searches `Title Year`; `Enter` with nothing highlighted searches what you typed.
4. `Escape` closes the list and it stays closed until you type something different.
5. Clicking a row searches it.
6. An AKA hit shows the "also known as" line.

Then **without** reccd configured (unset `TORLINK_RECC_URL` and clear it from config): typing fires no `/api/title-search` requests at all — check the network panel.

- [ ] **Step 5: Commit**

```bash
git add src/web/static/index.html src/web/static/styles.css src/web/static/app.ts
git commit -m "feat(web): title suggestions in the search box"
```

---

## Task 6: The terminal's hook, field and bar

**Files:**
- Create: `src/ui/hooks/useTitleSuggest.ts`
- Modify: `src/ui/components/TextField.tsx` (props at lines 5-20; the `useInput` tab arm at line 141)
- Modify: `src/ui/components/SearchBar.tsx`
- Test: `src/ui/components/SearchBar.test.tsx` **new**

**Interfaces:**
- Consumes: `TitleSuggestion`, `SuggestState`, `emptySuggestState`, `applyReply`, `suppressFor`, `shouldQueryFor`, `topSuggestion`, `submitTextFor`, `suggestionLabel`, `akaNote`, `SUGGEST_DEBOUNCE_MS`, `SUGGEST_ROWS_TERMINAL` (Task 1); `fetchTitleSuggestions` (Task 2); `ReccClientConfig` from `src/recc/client`; `FetchImpl` from `src/util/net`.
- Produces:
  ```ts
  // src/ui/hooks/useTitleSuggest.ts
  export interface TitleSuggest {
    items: TitleSuggestion[];   // already capped at SUGGEST_ROWS_TERMINAL
    open: boolean;
    completion: string | null;  // submitTextFor(top), or null
    dismiss: () => void;
    accept: (text: string) => void;
  }
  export function useTitleSuggest(args: {
    reccConfig: ReccClientConfig;
    query: string;
    enabled: boolean;
    fetchImpl?: FetchImpl;
    debounceMs?: number;
  }): TitleSuggest;
  // TextField gains props:  completion?: string | null;  onComplete?: (text: string) => void;
  // SearchBar gains props:  suggestions?: TitleSuggestion[];  completion?: string | null;
  //                         onComplete?: (text: string) => void;
  ```

- [ ] **Step 1: Write the failing test**

Create `src/ui/components/SearchBar.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { SearchBar } from "./SearchBar";
import type { TitleSuggestion } from "../../util/titleSuggest";

const KESTREL: TitleSuggestion = {
  imdbId: "tt0000001", title: "Kestrel", year: 2010, type: "movie", matchedAka: null,
};
const KEPLER: TitleSuggestion = {
  imdbId: "tt0000002", title: "Kepler", year: 2019, type: "tv", matchedAka: null,
};
const ASHFALL_AKA: TitleSuggestion = {
  imdbId: "tt0000003", title: "Ashfall", year: 1999, type: "movie", matchedAka: "Ashfall Rising",
};

describe("SearchBar suggestions", () => {
  it("shows nothing extra when there are no suggestions", () => {
    const { lastFrame } = render(
      <SearchBar width={60} value="kes" editing onSubmit={() => {}} />,
    );
    expect(lastFrame()).not.toContain("Kestrel");
  });

  it("lists each suggestion with its year and kind", () => {
    const { lastFrame } = render(
      <SearchBar
        width={60}
        value="ke"
        editing
        suggestions={[KESTREL, KEPLER]}
        completion="Kestrel 2010"
        onSubmit={() => {}}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Kestrel (2010) · film");
    expect(frame).toContain("Kepler (2019) · show");
  });

  it("shows the aka note on a hit that matched an alternate title", () => {
    const { lastFrame } = render(
      <SearchBar
        width={60}
        value="ashfall ris"
        editing
        suggestions={[ASHFALL_AKA]}
        completion="Ashfall 1999"
        onSubmit={() => {}}
      />,
    );
    expect(lastFrame() ?? "").toContain("Ashfall Rising");
  });

  // Suggestions belong to the box you are typing in. Leaving them under a
  // collapsed bar would leave a stale list on screen with nothing editing it.
  it("shows no suggestions when the bar is not being edited", () => {
    const { lastFrame } = render(
      <SearchBar
        width={60}
        value="ke"
        editing={false}
        suggestions={[KESTREL]}
        completion="Kestrel 2010"
        onSubmit={() => {}}
      />,
    );
    expect(lastFrame() ?? "").not.toContain("Kestrel (2010)");
  });

  /**
   * TAB COMPLETES ONLY WHEN THERE IS SOMETHING TO COMPLETE. The rest of the
   * time it must still leave the field — that is what it has always done
   * (TextField's onExitDown), and both the results pane and the splash depend
   * on it.
   */
  it("completes to the top suggestion on tab", async () => {
    const onComplete = vi.fn();
    const onExitDown = vi.fn();
    const { stdin } = render(
      <SearchBar
        width={60}
        value="ke"
        editing
        suggestions={[KESTREL, KEPLER]}
        completion="Kestrel 2010"
        onComplete={onComplete}
        onExitDown={onExitDown}
        onSubmit={() => {}}
      />,
    );
    await new Promise((r) => setTimeout(r, 10));
    stdin.write("\t");
    await new Promise((r) => setTimeout(r, 10));
    expect(onComplete).toHaveBeenCalledWith("Kestrel 2010");
    expect(onExitDown).not.toHaveBeenCalled();
  });

  it("still leaves the field on tab with no completion available", async () => {
    const onComplete = vi.fn();
    const onExitDown = vi.fn();
    const { stdin } = render(
      <SearchBar width={60} value="ke" editing onComplete={onComplete} onExitDown={onExitDown} onSubmit={() => {}} />,
    );
    await new Promise((r) => setTimeout(r, 10));
    stdin.write("\t");
    await new Promise((r) => setTimeout(r, 10));
    expect(onExitDown).toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });

  // The arrows are search history's and stay that way — a suggestion list is
  // not worth taking a working binding away from.
  it("leaves the up arrow to search history even with a list open", async () => {
    const { stdin, lastFrame } = render(
      <SearchBar
        width={60}
        value=""
        editing
        history={["Tin Rivers 2024"]}
        suggestions={[KESTREL]}
        completion="Kestrel 2010"
        onSubmit={() => {}}
      />,
    );
    await new Promise((r) => setTimeout(r, 10));
    stdin.write("[A");
    await new Promise((r) => setTimeout(r, 10));
    expect(lastFrame() ?? "").toContain("Tin Rivers 2024");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/components/SearchBar.test.tsx`
Expected: FAIL — `suggestions`, `completion` and `onComplete` are not valid `SearchBarProps`.

- [ ] **Step 3: Write minimal implementation**

**3a.** In `src/ui/components/TextField.tsx`, add to `TextFieldProps` after `history`:

```ts
  /**
   * What tab should complete the field to, or null for "nothing to complete".
   * When set, tab completes instead of calling `onExitDown` — see the tab arm
   * in `useInput` for why that swap is safe.
   */
  completion?: string | null;
  /** Called after tab completed the field, with the text written into it. */
  onComplete?: (text: string) => void;
```

Add both to the destructured parameter list, with `completion = null`.

Replace the tab arm (currently lines 141-144):

```ts
      if (key.tab) {
        // Completion wins over leaving the field, but ONLY when there is
        // something to complete: the rest of the time tab still exits, which is
        // what the results pane and the splash both rely on. Both callers read
        // the same `completion` value this does, so no ordering between Ink's
        // input handlers matters.
        if (completion !== null) {
          recall(completion);
          onComplete?.(completion);
          return;
        }
        onExitDown?.();
        return;
      }
```

Escape is deliberately **not** handled here. `Results` and `Splash` already own it (`setMode("list")` and `quitAll()` respectively), Ink runs every `useInput` handler for a keypress so this one could not swallow it, and the parents hold the suggestion state anyway.

**3b.** Rewrite `src/ui/components/SearchBar.tsx`:

```tsx
import { Box, Text } from "ink";
import { TextField } from "./TextField";
import { Panel } from "./Panel";
import { COLOR, ICON } from "../theme";
import { akaNote, suggestionLabel, type TitleSuggestion } from "../../util/titleSuggest";

interface SearchBarProps {
  width: number;
  value: string;
  placeholder?: string;
  editing: boolean;
  history?: string[];
  /**
   * Title suggestions from reccd, already capped by the caller. Rendered only
   * while editing — a list under a collapsed bar is a stale artefact with
   * nothing editing it.
   */
  suggestions?: TitleSuggestion[];
  /** What tab completes to, or null. */
  completion?: string | null;
  onComplete?: (text: string) => void;
  onSubmit: (value: string) => void;
  onChange?: (value: string) => void;
  onExitDown?: () => void;
  onExitLeft?: () => void;
}

export function SearchBar({
  width,
  value,
  placeholder = "Search torrents…",
  editing,
  history,
  suggestions,
  completion = null,
  onComplete,
  onSubmit,
  onChange,
  onExitDown,
  onExitLeft,
}: SearchBarProps) {
  const rows = editing ? (suggestions ?? []) : [];
  return (
    <Box flexDirection="column">
      <Panel title="search" width={width} focused={editing} height={2}>
        <Box>
          <Text color={COLOR.accent}>{`${ICON.pointer} `}</Text>
          <Box flexGrow={1} minWidth={0}>
            {editing ? (
              <TextField
                defaultValue={value}
                placeholder={placeholder}
                history={history}
                completion={completion}
                onComplete={onComplete}
                width={Math.max(1, width - 6)}
                onSubmit={onSubmit}
                onChange={onChange}
                onExitDown={onExitDown}
                onExitLeft={onExitLeft}
              />
            ) : value ? (
              <Text wrap="truncate-end">{value}</Text>
            ) : (
              <Text dimColor>{placeholder}</Text>
            )}
          </Box>
        </Box>
      </Panel>
      {/* Rendered only when there is something to show, so an empty list costs
          no vertical space and the layout does not jitter as replies arrive. */}
      {rows.map((hit, i) => {
        const aka = akaNote(hit);
        return (
          <Box key={hit.imdbId} paddingLeft={2}>
            <Text dimColor wrap="truncate-end">
              {suggestionLabel(hit)}
              {aka ? ` · ${aka}` : ""}
              {/* The top row is what tab takes, so it says so. */}
              {i === 0 && completion !== null ? "   ⇥" : ""}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
```

**3c.** Create `src/ui/hooks/useTitleSuggest.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import type { FetchImpl } from "../../util/net";
import { fetchTitleSuggestions, type ReccClientConfig } from "../../recc/client";
import {
  applyReply,
  emptySuggestState,
  shouldQueryFor,
  submitTextFor,
  suppressFor,
  topSuggestion,
  SUGGEST_DEBOUNCE_MS,
  SUGGEST_ROWS_TERMINAL,
  type SuggestState,
  type TitleSuggestion,
} from "../../util/titleSuggest";

export interface TitleSuggest {
  /** Already capped at SUGGEST_ROWS_TERMINAL. */
  items: TitleSuggestion[];
  open: boolean;
  /** What tab completes to, or null when there is nothing to complete. */
  completion: string | null;
  /** Escape: close the list, and do not reopen it for the current text. */
  dismiss: () => void;
  /** Tab completed the field — stop asking about the text now in it. */
  accept: (text: string) => void;
}

interface Args {
  reccConfig: ReccClientConfig;
  /** The live draft in the field, not the submitted query. */
  query: string;
  /** False on a pane that is not being edited, so nothing fires off screen. */
  enabled: boolean;
  fetchImpl?: FetchImpl;
  debounceMs?: number;
}

/**
 * Title suggestions from reccd for the terminal's search box, debounced.
 *
 * Modelled on `useTitlePreview`, with one deliberate difference: no cache. That
 * hook caches by a stable selection key because scrolling revisits the same
 * rows; here every keystroke is a different query, so a cache would only grow.
 *
 * State lives here and NOT in `Store`: a `Store` field needs matching entries
 * in `makeStore` (scripts/render-previews-impl.tsx) and `makeTestStore`
 * (src/ui/testHarness.ts) or `npm run previews` and `npm run typecheck` break
 * respectively — the right price for state other panes read, and no other pane
 * reads this.
 */
export function useTitleSuggest(args: Args): TitleSuggest {
  const { reccConfig, query, enabled, fetchImpl, debounceMs = SUGGEST_DEBOUNCE_MS } = args;
  const [state, setState] = useState<SuggestState>(emptySuggestState);
  // Monotonic, and the reason a slow reply cannot overwrite a fast one. reccd
  // answers a 2-char query in ~311ms and an 8-char one in ~71ms, so
  // out-of-order arrival is the normal case. A ref, not state: bumping it must
  // not itself cause a render.
  const seq = useRef(0);
  // The effect keys on `query`, but must read the *current* suppression latch
  // without listing `state` as a dependency — which would re-run it on every
  // reply and re-fire the request that produced it.
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (!enabled || !reccConfig.reccUrl) return;
    if (!shouldQueryFor(stateRef.current, query)) {
      // Clear anything on screen for a query too short to ask about, so
      // backspacing out of a search does not leave stale rows behind.
      const s = ++seq.current;
      setState((prev) => applyReply(prev, s, []));
      return;
    }
    let cancelled = false;
    const s = ++seq.current;
    const t = setTimeout(() => {
      void fetchTitleSuggestions(reccConfig, { q: query }, { fetchImpl }).then((res) => {
        if (cancelled) return;
        // Every failure renders as no suggestions. This fires per keystroke, so
        // surfacing the reason would mean an error line per character — and the
        // Accounts pane is where a reccd problem belongs.
        setState((prev) => applyReply(prev, s, res.ok ? res.items : []));
      });
    }, debounceMs);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // `reccConfig` is rebuilt each render by resolveReccConfig, so depend on its
    // fields rather than the object — otherwise this re-fires every render.
  }, [enabled, reccConfig.reccUrl, reccConfig.reccToken, query, fetchImpl, debounceMs]);

  const dismiss = useCallback(() => {
    setState((prev) => suppressFor(prev, query));
  }, [query]);

  const accept = useCallback((text: string) => {
    setState((prev) => suppressFor(prev, text));
  }, []);

  // Capped here rather than in the fetch: reccd is asked for SUGGEST_LIMIT so
  // both surfaces send it the same question, and the terminal renders fewer.
  const items = enabled ? state.items.slice(0, SUGGEST_ROWS_TERMINAL) : [];
  const top = topSuggestion({ ...state, items });
  return {
    items,
    open: items.length > 0,
    completion: top ? submitTextFor(top) : null,
    dismiss,
    accept,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ui/components/SearchBar.test.tsx src/ui/components/TextField.test.ts`
Expected: PASS both — the pre-existing `TextField` tests must be untouched by the tab change.

- [ ] **Step 5: Commit**

```bash
git add src/ui/hooks/useTitleSuggest.ts src/ui/components/TextField.tsx src/ui/components/SearchBar.tsx src/ui/components/SearchBar.test.tsx
git commit -m "feat(ui): title suggestions under the search bar, completed with tab"
```

---

## Task 7: Wire the terminal's two search boxes

**Files:**
- Modify: `src/ui/components/Results.tsx` (the escape handler at lines 583-588; the `SearchBar` element at line 708)
- Modify: `src/ui/views/Splash.tsx` (the `useInput` handler at lines 59-73; the `SearchBar` at line 128; the hint row at lines 137-149)
- Test: `src/ui/components/Results.test.tsx` (append), `src/ui/views/Splash.test.tsx` (append — the file already exists)

**Interfaces:**
- Consumes: `useTitleSuggest` / `TitleSuggest` (Task 6); `tabHintLabel` (Task 1); `resolveReccConfig` (`src/config/config.ts:257`).
- Produces: nothing other tasks consume.

**How `reccConfig` and `fetchImpl` reach these two components: as PROPS, not through the store.**

Both `Results` and `Splash` currently take everything from `useStore()` — including `omdbApiKey` — so the store looks like the obvious route. It is the wrong one here, for two reasons:

1. A new `Store` field needs a matching entry in **`makeStore`** (`scripts/render-previews-impl.tsx`) *and* **`makeTestStore`** (`src/ui/testHarness.ts`), or `npm run previews` and `npm run typecheck` break respectively. That is the right price for state other panes read — and nothing else reads this.
2. There is already a precedent for exactly this pair of values in exactly this file. `App.tsx:2871-2882` passes `ForYou` a `reccConfig={resolveReccConfig(store.config)}` prop and `ForYou` declares `reccConfig: ReccClientConfig` plus an optional `fetchImpl?: FetchImpl` (`src/ui/components/ForYou.tsx:18,26`) — the `fetchImpl` existing precisely so its tests never dial out.

So: give `Results` and `Splash` the same two props, and pass them from `App.tsx` the same way `ForYou`'s are passed. `Results` is currently rendered with no props at all and `Splash` with three, so both call sites in `App.tsx` need editing.

**The two key collisions this task exists to handle.** Ink runs *every* active `useInput` handler for a keypress — one handler cannot swallow a key from another. So both of these are resolved by having each handler read the same `suggest` value, which makes the outcome independent of the order they run in:

| Key | Existing owner | New behaviour |
|---|---|---|
| `Esc` in the results search box | `Results.tsx:585` → `setMode("list")` | List open → `dismiss()`. Otherwise unchanged. |
| `Esc` on the splash | `Splash.tsx:70` → `quitAll()` | List open → `dismiss()`. Otherwise **still quits.** |
| `Tab` on the splash | `Splash.tsx:65` → `setView("browser")` **and** `TextField` → `onExitDown` | Completion available → the splash handler returns early and `TextField` completes. |

- [ ] **Step 1: Write the failing test**

Append to `src/ui/components/Results.test.tsx` (reuse that file's existing render harness and store helpers):

```tsx
describe("Results search suggestions", () => {
  // Escape has two jobs now, and the order matters to the user: the first
  // escape puts the list away, the second leaves the box. Collapsing both into
  // one keypress would make dismissing a list cost you your place.
  it("dismisses the suggestion list before leaving the search box", async () => {
    // Render with reccd configured and a fetchImpl that returns one hit, enter
    // search mode, type two characters, wait past the debounce, then send
    // escape twice — asserting the list is gone after the first and the pane
    // has left search mode after the second.
  });
});
```

> **Implementer:** fill this body in using the harness already in `Results.test.tsx` — its store factory, its `render`, and the debounce-waiting pattern from `ForYou.test.tsx:279` and `:303`, which **polls until the chain settles rather than sleeping a fixed time**. Copy that; a fixed `setTimeout(300)` here would be flaky on a loaded machine. Inject the suggestion fetch through the new `fetchImpl` prop from the note above — never the real network.

Append the same for `Splash`:

```tsx
describe("Splash search suggestions", () => {
  it("dismisses the suggestion list on escape rather than quitting", async () => {
    // With a list open, escape must not call quitAll.
  });

  it("still quits on escape with no list open", async () => {
    // The unchanged behaviour, pinned so the guard above cannot swallow it.
  });

  it("completes on tab with a suggestion available, instead of entering the app", async () => {
    // setView must not be called; the field's value becomes "Kestrel 2010".
  });

  it("still enters the app on tab with no suggestions", async () => {
    // The unchanged behaviour.
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/ui/components/Results.test.tsx src/ui/views/Splash.test.tsx`
Expected: FAIL — escape leaves search mode with the list still open; tab enters the app instead of completing.

- [ ] **Step 3: Write minimal implementation**

**3a.** In `src/ui/components/Results.tsx`:

```tsx
// The live draft, which is what suggestions are for — `query` is the last
// SUBMITTED search, and suggesting against that would lag a whole search behind.
const [draft, setDraft] = useState(query);
const suggest = useTitleSuggest({
  reccConfig,
  query: draft,
  enabled: mode === "search",
  fetchImpl,
});
```

Replace the search/filter escape handler:

```tsx
  useInput(
    (_input, key) => {
      if (!key.escape) return;
      // Escape escalates: the first one puts the suggestion list away, the
      // second leaves the box. Doing both at once would make dismissing a list
      // cost you your place in the pane.
      if (mode === "search" && suggest.open) {
        suggest.dismiss();
        return;
      }
      setMode("list");
    },
    { isActive: focused && (mode === "search" || mode === "filter") },
  );
```

And the `SearchBar`:

```tsx
      <SearchBar
        width={contentWidth}
        value={query}
        editing={mode === "search"}
        placeholder={PLACEHOLDER}
        history={searchHistory}
        suggestions={suggest.items}
        completion={suggest.completion}
        onChange={setDraft}
        onComplete={(text) => {
          setDraft(text);
          suggest.accept(text);
        }}
        onSubmit={onSubmit}
        onExitDown={() => setMode("list")}
        onExitLeft={() => setRegion("sidebar")}
      />
```

`reccConfig` reaches `Results` the way `omdbApiKey` already does — from `App.tsx`, via `resolveReccConfig(store.config)`. Add the prop and pass it at the call site.

**3b.** In `src/ui/views/Splash.tsx`:

```tsx
const [draft, setDraft] = useState("");
const suggest = useTitleSuggest({ reccConfig, query: draft, enabled: true, fetchImpl });
```

Rewrite its `useInput`:

```tsx
  useInput(
    (input, key) => {
      // The search field is always focused on the splash, so it owns every
      // printable keystroke — no single-key shortcuts here, or typing a query
      // like "alex" would trigger them. Tab drops into the app's sidebar menu
      // (where the shortcuts live); esc / ^c quit.
      if (key.tab) {
        // With something to complete, tab belongs to the field: TextField reads
        // the same `completion` value this does, so which handler Ink runs first
        // does not matter.
        if (suggest.completion !== null) return;
        setView("browser");
        setRegion("sidebar");
        return;
      }
      // Escape escalates rather than quitting outright — putting a suggestion
      // list away must not be able to close the app.
      if (key.escape && suggest.open) {
        suggest.dismiss();
        return;
      }
      if (key.escape || (key.ctrl && input === "c")) quitAll();
    },
    { isActive: isRawModeSupported },
  );
```

The `SearchBar` gains the same six props as in 3a (`suggestions`, `completion`, `onChange`, `onComplete`, plus its existing ones). And the hint row's Tab label becomes honest:

```tsx
          <Text color={COLOR.alt}>⇥</Text>
          <Text dimColor>{` ${tabHintLabel(suggest.open)}`}</Text>
```

`reccConfig` reaches `Splash` from `App.tsx` the same way, via `resolveReccConfig(store.config)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/ui/`
Expected: PASS, including the pre-existing `Results.test.tsx` and `Sidebar.test.tsx`.

- [ ] **Step 5: Verify by running it**

```bash
npm run dev
```

On the splash: type `ke`, see the list, press Tab — the field becomes `Kestrel 2010` and the app does **not** switch to the sidebar. Press Tab again with the list closed — it does. Press Esc with a list open — the app does **not** quit. Press Esc again — it does.

Then in the results pane, press `/`, type `ke`, and check the same Tab and two-stage Esc behaviour. Confirm `↑` still recalls your last search with a list on screen.

Finally, with reccd **unconfigured**, confirm both boxes behave exactly as they did before.

- [ ] **Step 6: Commit**

```bash
git add src/ui/components/Results.tsx src/ui/components/Results.test.tsx src/ui/views/Splash.tsx src/ui/views/Splash.test.tsx src/ui/App.tsx
git commit -m "feat(ui): wire title suggestions into the results and splash search boxes"
```

---

## Task 8: Help, docs and the full check

**Files:**
- Modify: `src/ui/keymap.ts` (the `Search` group in `HELP_GROUPS`, line 45)
- Modify: `README.md` (the browser limitations list at line 207; the Recommendations section at line 497)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Add the help entry**

In `src/ui/keymap.ts`, in the `Search` group's `hints`, immediately after the `↑` recall line:

```ts
      { keys: "⇥", label: "Complete to the top title suggestion (needs reccd)" },
```

**`footerHints` is deliberately not changed, and this is the reason.** It takes `region` and `section`, not the search box's editing mode, so it cannot express "tab completes right now" — and its `tab` entry is the shared `SWITCH` hint used by every pane. Threading an editing-mode parameter through it for one conditional label would be disproportionate, and the footer is already not mode-aware: while you are typing a search it advertises `d`, `r` and `v`, none of which apply. The splash's own hint row *is* mode-aware and *was* updated (Task 7). Say this in the PR body — it is a stated deviation from the "a new key goes in both halves of keymap.ts" rule, not an oversight.

- [ ] **Step 2: Check the existing keymap test still passes**

Run: `npx vitest run src/ui/keymap.test.ts`
Expected: PASS. If it asserts an exact hint count or list for the `Search` group, update it to include the new entry.

- [ ] **Step 3: Document it**

In `README.md`'s Recommendations section (after the paragraph about the browser's **for you** tab, around line 507), add:

```markdown
### Title autocomplete

With reccd connected, both search boxes suggest titles as you type — the catalog's own
spelling and year, so you don't have to remember either. In the terminal, press `⇥` to take the
top suggestion; in the browser, arrow to one and press Enter, or click it. Picking one searches
for the title *and* its year, which is what separates a remake from the original.

Suggestions are **titles, not releases**: reccd's catalog holds films and shows, so you'll be
offered `Harrowgate` and never `Harrowgate S03` — narrow to a season yourself once the results
are in. There's no typo tolerance either; the match is on the start of any word, so `dark kni`
finds a `The Dark Kni…` but `dark knght` finds nothing.

Without reccd, both boxes behave exactly as they always have — nothing is requested and nothing
changes on screen.
```

In the **What the browser can't do yet** list, extend the settings bullet's parenthetical so the reccd URL is covered by the same "TUI-only" statement as tokens, or add to that bullet: reccd's URL and token are configured in the terminal, and the browser only learns *whether* one is set.

- [ ] **Step 4: Run the full check**

```bash
npm test && npm run typecheck && npm run lint && npm run build
```

Expected: all green, with the single known pre-existing lint warning (`react-hooks/exhaustive-deps`, `src/ui/App.tsx`) and nothing else.

Then re-read the CLAUDE.md completeness sweep and do it:
- `grep -rn "reccConfigured" src/` — every consumer updated?
- `grep -rn "SearchBar" src/` — both call sites pass the new props?
- `grep -rn "not.toContain" src/web/routes.test.ts` — does each still name something the test actually puts in play?

- [ ] **Step 5: Commit**

```bash
git add src/ui/keymap.ts src/ui/keymap.test.ts README.md
git commit -m "docs: title autocomplete in the help overlay and the README"
```

---

## Task 9: The reccd wishlist

**Files:**
- Create: `docs/superpowers/notes/2026-07-31-reccd-search-wishlist.md`

**Interfaces:**
- Consumes: everything learned building Tasks 1-8.
- Produces: a note to hand to reccd.

- [ ] **Step 1: Write it up**

Having built the client, write down what reccd could add that would measurably improve this
feature. Write it as a short note with a reason per item, not a feature list. Cover at least:

- **A `type=movie|tv` filter on `/search`.** `type` is returned but not filterable, and the
  browser's category tabs already know whether the user is after a film or a show.
- **A poster or artwork URL on each hit.** The browser currently needs a second OMDb round trip
  per row to show a thumbnail, which is why suggestions are text-only.
- **Typo tolerance for the zero-result case** — reccd's own design doc already flags a trigram
  similarity pass as additive.
- **Accepting a release name**, so torlink could canonicalise `Kestrel.2010.1080p.BluRay.x264`
  into `Kestrel (2010)` through the same endpoint instead of parsing it locally.
- Anything else that came up while implementing. Latency on 2-character queries is the obvious
  candidate — reccd measured it at ~311ms and left the fix as a product call.

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/notes/2026-07-31-reccd-search-wishlist.md
git commit -m "docs: what reccd could add to make title search better"
```

---

## Self-Review

**Spec coverage** — every section of the spec maps to a task:

| Spec section | Task |
|---|---|
| What reccd actually returns | 1 (type), 2 (guard, dropped fields) |
| Data path — TUI direct | 6, 7 |
| Data path — browser proxy | 3 |
| Tuning table | 1 (constants), 2 (timeout), 5 + 6 (debounce) |
| Failure cases table | 2 (401/404/malformed/timeout), 3 (not-configured), 5 + 6 (silent) |
| No unavailability latch | 2 — none written, by design |
| Stale responses | 1 (`applyReply` + guard test), 4, 5, 6 |
| Capability flag | 3 |
| `src/util/titleSuggest.ts` | 1 |
| `src/web/static/suggestModel.ts` | 4 |
| Terminal UI, keys, both call sites, hook-not-Store | 6, 7 |
| Browser UI, listbox, no `innerHTML` | 4, 5 |
| Testing | every task |
| Known limits | 8 (README) |
| Before it is done | 8 |
| The "what else could reccd add" ask | 9 |

**Type consistency** — checked across tasks: `TitleSuggestion` is defined once (Task 1) and imported by `client.ts` (2), `wire.ts` (3), `suggestModel.ts` (4) and `SearchBar.tsx` (6). `suppressFor` is used under that name in 1, 4 and 6. `shouldQueryFor` in 1, 5 and 6. `highlightAt` is declared, implemented, tested and consumed in 4 and 5. `isOpen` is aliased to `suggestOpen` at its `app.ts` import (5) to avoid shadowing, and used unaliased in `suggestModel.test.ts` (4).

**Two places the plan is deliberately less prescriptive**, both flagged inline rather than left silent:

- **Task 7's test bodies are described, not written.** They need `Results.test.tsx`'s existing store/render harness and its debounce-polling pattern, which an implementer must read to use correctly — writing a body against a harness I have not read would produce a test that does not compile. The assertions themselves are fully specified.
- **`footerHints` is not updated**, with the reason stated in Task 8 and required in the PR body. This is a stated deviation from a CLAUDE.md rule, made because that function has no parameter that could express the condition.
