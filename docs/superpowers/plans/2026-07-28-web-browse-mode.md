# Web Browse Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the web UI browse curated top lists by submitting a blank search box, exactly as the TUI does.

**Architecture:** The core already supports this — browse mode *is* `query === ""` flowing through `runSearch`, and each source maps an empty query to its own top/latest endpoint. The web layer fences it off in two places, so this is: stop rejecting blank `q` on the server, add an explicit `mode` field to the browser's view state (the empty string is currently overloaded to mean "nothing has run yet"), and change the DOM guard plus the labels.

**Tech Stack:** TypeScript, node:http, plain-DOM browser bundle (no framework), vitest. No jsdom in this repo — browser logic lives in pure modules (`searchModel.ts`) and only DOM binding lives in `app.ts`.

**Spec:** `docs/superpowers/specs/2026-07-28-web-browse-mode-design.md`

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/web/routes.ts:447-457` | Modify | `parseSearchParams` — blank `q` becomes valid (browse); absent `q` stays a 400 |
| `src/web/routes.test.ts:749-783` | Modify | Invert the blank-query rejection cases |
| `src/web/server.test.ts` (`describe("/api/search")`, from `:592`) | Modify | Socket-level proof a blank-`q` stream opens 200 and reaches `done` |
| `src/web/static/searchModel.ts:85-113, 152-175` | Modify | Add `mode` to `SearchView`; `searchStatus` switches on it |
| `src/web/static/searchModel.test.ts:48-50, 189-230, 248-258` | Modify | Test helper gains `mode`; new browse status branches; blank `searchUrl` |
| `src/web/static/app.ts:576, 606, 657-662` | Modify | Drop the empty guard, set `mode`, re-run on tab switch while browsing |
| `src/web/static/index.html:52-53` | Modify | Label and placeholder that say blank = browse |
| `README.md:184` | Modify | Mention browse in the web section |

No new files. No changes to `src/core`, `src/sources`, `src/ui`, or `src/web/wire.ts`.

---

## Task 1: Server accepts a blank query as browse

**Files:**
- Modify: `src/web/routes.ts:447-457`
- Test: `src/web/routes.test.ts:770-772`

- [ ] **Step 1: Rewrite the failing test**

In `src/web/routes.test.ts`, find this case inside `describe("parseSearchParams")` (around line 770):

```ts
  it.each(["", "q=", "q=%20%20"])("rejects a missing or blank query (%s)", (qs) => {
    expect(parseSearchParams(new URLSearchParams(qs))).toEqual({ ok: false, error: "missing query" });
  });
```

Replace it with these three cases:

```ts
  // A blank q is not a mistake, it is browse mode: the same empty query the TUI
  // sends when you press Enter on an empty box, which every source maps to its
  // own top/latest endpoint. See runSearch — it has no empty-query check.
  it.each(["q=", "q=%20%20"])("accepts a blank query as browse (%s)", (qs) => {
    expect(parseSearchParams(new URLSearchParams(qs))).toEqual({
      ok: true,
      params: { query: "", group: null },
    });
  });

  it("browses one group when a blank query names a tab", () => {
    expect(parseSearchParams(new URLSearchParams("q=&group=Movies"))).toEqual({
      ok: true,
      params: { query: "", group: "Movies" },
    });
  });

  // q must still be *present*. A bare GET /api/search with no params is far
  // more likely to be a stray request than an intent to fan out to 23 sources.
  it("rejects a request with no q at all", () => {
    expect(parseSearchParams(new URLSearchParams(""))).toEqual({ ok: false, error: "missing query" });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/web/routes.test.ts -t parseSearchParams`

Expected: FAIL — the two new accepting cases get `{ ok: false, error: "missing query" }`. The "no q at all" case already passes.

- [ ] **Step 3: Make blank valid in `parseSearchParams`**

In `src/web/routes.ts`, change the first two lines of the function body (line 447-449):

```ts
export function parseSearchParams(
  query: URLSearchParams,
): { ok: true; params: SearchParams } | { ok: false; error: string } {
  const q = (query.get("q") ?? "").trim();
  if (!q) return { ok: false, error: "missing query" };
```

to:

```ts
export function parseSearchParams(
  query: URLSearchParams,
): { ok: true; params: SearchParams } | { ok: false; error: string } {
  const raw = query.get("q");
  if (raw === null) return { ok: false, error: "missing query" };
  const q = raw.trim();
```

Leave the rest of the function (the `group` handling) exactly as it is.

- [ ] **Step 4: Update the doc comment above the function**

The existing comment explains why a blank query is rejected, which is now wrong. Replace this paragraph in the block comment above `parseSearchParams`:

```
 * Separate from the streaming itself because SSE gives up its status code the
 * moment the headers go out: once we have written `200 text/event-stream`,
 * "you forgot the query" can only be an error *frame*, which a client has to
 * parse to discover it asked wrong. So the decidable part is a pure function
 * the socket layer runs first and answers 400 from.
```

with:

```
 * Separate from the streaming itself because SSE gives up its status code the
 * moment the headers go out: once we have written `200 text/event-stream`,
 * "you asked wrong" can only be an error *frame*, which a client has to parse
 * to discover it. So the decidable part is a pure function the socket layer
 * runs first and answers 400 from.
 *
 * A blank `q` is *valid*: it is browse mode, the empty query the TUI sends when
 * you press Enter on an empty box, which each source maps to its own top/latest
 * endpoint. But `q` must be *present* — a bare `GET /api/search` is far more
 * likely to be a stray request than an intent to fan out to every source, so
 * absent and blank are deliberately different answers.
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/web/routes.test.ts -t parseSearchParams`

Expected: PASS, all cases.

- [ ] **Step 6: Commit**

```bash
git add src/web/routes.ts src/web/routes.test.ts
git commit -m "feat(web): accept a blank search query as browse mode"
```

---

## Task 2: Prove a blank query streams over a real socket

`parseSearchParams` passing is not proof the stream works — the 400 was answered in `server.ts` before the SSE headers, so this asserts the whole path end to end.

**Files:**
- Test: `src/web/server.test.ts` (inside `describe("/api/search")`, which starts at `:592`)

- [ ] **Step 1: Write the failing test**

In `src/web/server.test.ts`, inside `describe("/api/search")`, add this after the existing `it("narrows to a group", ...)` test. It reuses the `searchServer()` helper already defined in that describe block (which stubs `searchImpl` so no network is touched):

```ts
  // Browse mode: q present but blank. The server must not 400 this, and the
  // stream must complete exactly like a real search.
  it("streams a blank query as browse", async () => {
    const base = await searchServer();
    const res = await fetch(`${base}/api/search?q=`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    const text = await res.text();
    expect(text.match(/event: results/g)).toHaveLength(3);
    expect(text).toContain("event: done");
    expect(text).toContain("yts result");
  });

  // The tab-switch path in Task 4 depends on this: a browse still has to be
  // narrowed by group, and only a socket test proves the fan-out really is.
  it("narrows a browse to a group", async () => {
    const base = await searchServer();
    const text = await (await fetch(`${base}/api/search?q=&group=TV`)).text();
    expect(text).toContain("eztv result");
    expect(text).not.toContain("yts result");
  });
```

Do **not** add a standalone `no q at all` test here: the pre-existing table
`it.each([["/api/search", "missing query"], …])` further down this describe block
already asserts exactly that, and duplicating it is bookkeeping that will drift.
That table also has a row `["/api/search?q=", "missing query"]` which asserts the
behaviour Task 1 just inverted — **remove that one row** and leave the other two.

- [ ] **Step 2: Run the tests**

Run: `npx vitest run src/web/server.test.ts -t "/api/search"`

Expected: PASS both — Task 1 already made the server accept this. If the blank-query test fails with a 400, the Task 1 change did not land.

- [ ] **Step 3: Commit**

```bash
git add src/web/server.test.ts
git commit -m "test(web): cover the blank-query search stream at the socket level"
```

---

## Task 3: Add an explicit `mode` to the browser's view state

`SearchView.query` currently means two things at once — the query text, and "has anything been submitted yet". `searchStatus` returns the idle line whenever `!view.query`, so a blank browse query would render identically to a fresh page. This task adds the field and the browse status lines together, because the field is useless without a reader.

**Files:**
- Modify: `src/web/static/searchModel.ts:85-113` (`SearchView`, `emptyView`) and `:152-175` (`searchStatus`)
- Test: `src/web/static/searchModel.test.ts:48-50` (helper), `:189-230` (status), `:248-258` (url)

- [ ] **Step 1: Update the test helper so existing tests still describe a search**

In `src/web/static/searchModel.test.ts`, the helper at line 48 is:

```ts
function view(over: Partial<SearchView> = {}): SearchView {
  return { ...emptyView(), query: "sintel", ...over };
}
```

Change it to set the mode alongside the query, and add a browse-flavoured sibling:

```ts
function view(over: Partial<SearchView> = {}): SearchView {
  return { ...emptyView(), query: "sintel", mode: "search", ...over };
}

/** A view mid-browse: the blank query the TUI sends on an empty submit. */
function browsing(over: Partial<SearchView> = {}): SearchView {
  return { ...emptyView(), query: "", mode: "browse", ...over };
}
```

- [ ] **Step 2: Write the failing browse status tests**

In the same file, add these to `describe("searchStatus")` (which starts at line 189), after the existing tests:

```ts
  it("counts sources while browsing, without calling it a search", () => {
    const v = browsing({ running: true, snapshot: snapshot([], { done: 12, total: 23 }) });
    expect(searchStatus(v, 0).text).toBe("Loading 12/23 sources");
    expect(searchStatus(v, 5).text).toBe("loading… 12/23 sources");
  });

  it("says nothing is new rather than quoting an empty query", () => {
    const v = browsing({ snapshot: snapshot([], { total: 2, done: 2 }) });
    expect(searchStatus(v, 0).text).toBe("Nothing new right now.");
    expect(searchStatus(v, 0).tone).toBe("dim");
  });

  it("labels browse results as the newest across all sources", () => {
    const v = browsing({ snapshot: snapshot([result()], { total: 3, done: 3 }) });
    expect(searchStatus(v, 4).text).toBe("4 results · newest across all sources");
  });

  // The mode-independent branches must keep winning over the browse lines:
  // "every source is down" and "your filters did this" are still the truth.
  it("keeps the outage and filter branches while browsing", () => {
    const down = {
      perSource: {
        a: { loading: false, error: "timed out", code: "timed out", count: 0 },
        b: { loading: false, error: "HTTP 503", code: "HTTP 503", count: 0 },
      },
      total: 2,
      done: 2,
    };
    const failed = searchStatus(browsing({ snapshot: snapshot([], down) }), 0);
    expect(failed.text).toBe("Couldn't reach any source. They may be down.");
    expect(failed.tone).toBe("error");

    const filtered = browsing({ snapshot: snapshot([result()], { total: 2, done: 2 }), textFilter: "zzz" });
    expect(searchStatus(filtered, 0).text).toBe("Nothing matches those filters.");
  });

  it("still shows the idle line before anything is submitted", () => {
    expect(searchStatus(emptyView(), 0).text).toBe("Search across every enabled source.");
  });
```

- [ ] **Step 3: Write the failing blank-URL test**

Still in `searchModel.test.ts`, add to `describe("searchUrl")` (line 248):

```ts
  it("sends q= for a browse, so the server can tell blank from absent", () => {
    expect(searchUrl("", "All", "")).toBe("/api/search?q=&group=All");
  });
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run src/web/static/searchModel.test.ts`

Expected: FAIL — typecheck errors on `mode` not existing in `SearchView`, and the browse status assertions get `"Search across every enabled source."`. The `searchUrl` test should already pass (`URLSearchParams` keeps an empty value's key).

- [ ] **Step 5: Add the `mode` field**

In `src/web/static/searchModel.ts`, change `SearchView` (line 85-97) to:

```ts
export interface SearchView {
  /** The submitted query. Empty in `browse` mode and before the first submit. */
  query: string;
  /**
   * Which of three states the pane is in. This is NOT derivable from `query`:
   * browse mode submits the empty string, so `!query` alone cannot tell "the
   * user asked for the top lists" from "nothing has been submitted yet", and
   * conflating them makes a browse render as a fresh page.
   */
  mode: "idle" | "search" | "browse";
  /** `ALL_TAB` or one of the server's group names. */
  group: string;
  /** The latest frame, or null before one arrives. */
  snapshot: PublicSearchSnapshot | null;
  /** True between submitting and the `done` frame (or an error). */
  running: boolean;
  sort: Sort;
  hideDead: boolean;
  textFilter: string;
}
```

and add `mode` to `emptyView()` (line 99-113):

```ts
export function emptyView(): SearchView {
  return {
    query: "",
    mode: "idle",
    group: ALL_TAB,
    snapshot: null,
    running: false,
    // "none", NOT a seeders sort. `core/search.ts` has already ordered every
    // snapshot by seeders then recency and the TUI leaves that alone, so a
    // browser that applied its own default would put a different hit at the top
    // of the same query. See sortResults: "none" returns the list as given.
    sort: "none",
    hideDead: false,
    textFilter: "",
  };
}
```

- [ ] **Step 6: Teach `searchStatus` the browse lines**

Replace the body of `searchStatus` in `src/web/static/searchModel.ts` (line 152-175) with:

```ts
export function searchStatus(view: SearchView, shown: number): SearchStatus {
  if (view.mode === "idle") return { text: "Search across every enabled source.", tone: "dim" };
  const browse = view.mode === "browse";
  const progress = progressLabel(view.snapshot);
  if (view.running) {
    // "Loading" not "Searching" while browsing: nothing was searched for. Same
    // word the TUI's spinner uses for the same state. Both casings are spelled
    // out rather than derived — `noUncheckedIndexedAccess` makes `verb[0]`
    // possibly-undefined, and a two-word table is clearer than appeasing it.
    const head =
      shown > 0
        ? `${browse ? "loading" : "searching"}… ${progress}`
        : `${browse ? "Loading" : "Searching"} ${progress}`;
    return { text: head, tone: "dim" };
  }
  const down = erroredSources(view.snapshot);
  const total = view.snapshot?.total ?? 0;
  if (shown === 0) {
    // Every source failing and every source finding nothing look identical in a
    // results list, so they must not read the same. This is the whole reason
    // `perSource.error` is on the wire. Both of these outrank the mode: they are
    // true whether or not the user typed anything.
    if (total > 0 && down.length >= total) {
      return { text: "Couldn't reach any source. They may be down.", tone: "error" };
    }
    if (view.hideDead || view.textFilter.trim()) {
      return { text: "Nothing matches those filters.", tone: "dim" };
    }
    if (browse) return { text: "Nothing new right now.", tone: "dim" };
    return { text: `No results for “${view.query}”.`, tone: "dim" };
  }
  const note = down.length > 0 ? ` · ${down.length} source${down.length === 1 ? "" : "s"} down` : "";
  // The TUI drops the count while browsing because its panel title already says
  // "latest". The web has no such title, so keep the count and append the
  // phrase rather than replacing one true thing with another.
  const tail = browse ? " · newest across all sources" : "";
  return { text: `${shown} result${shown === 1 ? "" : "s"}${note}${tail}`, tone: "dim" };
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run src/web/static/searchModel.test.ts`

Expected: PASS. Every pre-existing test in this file must still pass — the `search`-mode strings are unchanged.

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck`

Expected: errors only in `src/web/static/app.ts`, where `emptyView()`-derived views are spread without a `mode` — Task 4 fixes those. If `app.ts` reports nothing, `mode` was made optional by mistake; it must be required.

- [ ] **Step 9: Commit**

```bash
git add src/web/static/searchModel.ts src/web/static/searchModel.test.ts
git commit -m "feat(web): add an explicit browse mode to the search view state"
```

---

## Task 4: Wire it up in the DOM

`app.ts` has no test coverage by design (no DOM environment in this repo), so this task is typecheck-and-hand-verify. Keep the edits to binding only — no decisions.

**Files:**
- Modify: `src/web/static/app.ts:576` (tab switch), `:606` (`startSearch`), `:657-662` (submit)
- Modify: `src/web/static/index.html:52-53`

- [ ] **Step 1: Set the mode in `startSearch`**

In `src/web/static/app.ts`, the function at line 606 begins:

```ts
function startSearch(query: string): void {
  stopSearch();
  searchView = { ...searchView, query, snapshot: null, running: true };
```

Change those first lines to derive the mode from the query:

```ts
function startSearch(query: string): void {
  stopSearch();
  // An empty query is browse mode, not a mistake — the server accepts it and
  // every source answers with its own top/latest list. See parseSearchParams.
  const mode = query ? "search" : "browse";
  searchView = { ...searchView, query, mode, snapshot: null, running: true };
```

Leave the rest of the function unchanged; `searchUrl(query, ...)` already emits `q=` for an empty query.

- [ ] **Step 2: Drop the empty-query guard in the submit handler**

At line 657-662 the handler is:

```ts
searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const query = queryInput.value.trim();
  if (!query) return;
  startSearch(query);
});
```

Change it to:

```ts
searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  // No guard on an empty value: submitting a blank box is how you browse the
  // top lists, the same as pressing Enter on an empty box in the TUI.
  startSearch(queryInput.value.trim());
});
```

- [ ] **Step 3: Make a tab switch re-run a browse**

At line 576, inside the tab click handler in `renderTabs`, the re-run is guarded on the query being non-empty, which would silently do nothing while browsing:

```ts
        if (searchView.query) startSearch(searchView.query);
        else renderResults();
```

Change it to switch on the mode instead:

```ts
        // `mode`, not `query`: a browse has an empty query but absolutely needs
        // re-running, because the server only fetched the old tab's sources.
        if (searchView.mode === "idle") renderResults();
        else startSearch(searchView.query);
```

- [ ] **Step 4: Say so in the markup**

In `src/web/static/index.html`, lines 51-53 are:

```html
          <label for="query">Search every source</label>
          <input id="query" type="search" placeholder="the matrix 1999" autocomplete="off" />
          <button type="submit">Search</button>
```

Change the placeholder so browse is discoverable (the label and button stay — the button still submits a blank box):

```html
          <label for="query">Search every source</label>
          <input
            id="query"
            type="search"
            placeholder="the matrix 1999 — or leave blank to browse"
            autocomplete="off"
          />
          <button type="submit">Search</button>
```

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npm run lint`

Expected: both clean. The `mode` errors from Task 3 Step 8 are now resolved.

- [ ] **Step 6: Run the full test suite**

Run: `npm test`

Expected: PASS. Nothing outside `src/web` was touched, so any failure here is a real regression.

- [ ] **Step 7: Commit**

```bash
git add src/web/static/app.ts src/web/static/index.html
git commit -m "feat(web): browse the top lists by submitting a blank search"
```

---

## Task 5: Verify it in a real browser

The browser bundle is served from `dist/web`, **not** `src` — see `README.md:269-271`. Skipping the build here shows stale assets and reads exactly like a cache bug.

**Files:** none modified.

- [ ] **Step 1: Build**

Run: `npm run build`

Expected: exit 0, and `dist/web/app.js` newer than your edit to `src/web/static/app.ts`.

- [ ] **Step 2: Start the server headless**

Run: `npx tsx src/index.tsx serve --web --web-port 9162`

Expected: it stays running and reports the UI on `http://127.0.0.1:9162`. Leave it up for the next steps (run it in the background so you keep a shell).

- [ ] **Step 3: Drive it in Chrome DevTools**

Navigate to `http://127.0.0.1:9162`, then:
- Confirm the search input's placeholder reads `the matrix 1999 — or leave blank to browse`.
- Submit the empty box. Confirm the status line goes `Loading n/23 sources` → `n results · newest across all sources`, and that real rows appear.
- Check the network panel: the request is `GET /api/search?q=&group=All` with status **200** and content-type `text/event-stream`, and it carries `event: results` frames and one `event: done`.
- Check the console for errors — there should be none.
- Click the **movies** tab. Confirm the request re-fires as `q=&group=Movies` and the rows change.
- Type a real query and submit. Confirm the status line reverts to `n results` with no `newest across all sources` tail.

- [ ] **Step 4: Confirm the guard that remains**

Run: `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:9162/api/search`

Expected: `400`. A bare request with no `q` must not start a 23-source fan-out.

- [ ] **Step 5: Stop the server**

Kill the process from Step 2.

- [ ] **Step 6: Document it**

In `README.md`, line 184 currently reads:

```
Add `--web` and torlink also serves a browser interface — search every source, posters and plots, play something, the queue, and your For You feed — over the same queue as the process hosting it. Handy for a seedbox you check from your phone, or just for using torlink without a terminal open.
```

Change it to mention browse, matching how line 52 describes it for the TUI:

```
Add `--web` and torlink also serves a browser interface — search every source (or submit an empty box to browse the curated library, same as the TUI), posters and plots, play something, the queue, and your For You feed — over the same queue as the process hosting it. Handy for a seedbox you check from your phone, or just for using torlink without a terminal open.
```

- [ ] **Step 7: Commit**

```bash
git add README.md
git commit -m "docs: note that the web UI can browse from a blank search"
```

---

## Done when

- `npm test`, `npm run typecheck` and `npm run lint` are all clean.
- `GET /api/search?q=` streams results; `GET /api/search` is a 400.
- A blank submit in the browser shows top lists with the `newest across all sources` status, and switching tabs re-fetches.
- A real query behaves exactly as it did before.
