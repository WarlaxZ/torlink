# Web UI: Saved Lists, Browse Artwork, and Tab-Click Loading — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close three parity gaps between the browser UI and the terminal UI — the two saved lists (watchlist and library) are unreachable from a browser, a category tab renders nothing until the search box is submitted, and only the For You feed shows poster artwork.

**Architecture:** Two TUI list helpers move down into `src/util/` so the web layer can share them (a lint rule forbids `src/web` importing `src/ui`). Three new authenticated routes in `src/web/routes.ts` read-modify-write `config.json` per request. Browser decisions go into new pure modules under `src/web/static/` (`savedModel.ts`, `resultPosters.ts`) plus one new function in `searchModel.ts`, because there is no jsdom in this repo and `app.ts` is committed to being DOM wiring only.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`), Vitest, tsup (a separate `platform: "browser"` bundle for `src/web/static/`), plain DOM — no framework in the browser bundle. Ink/React in `src/ui` only.

**Spec:** `docs/superpowers/specs/2026-07-29-web-ui-saved-lists-and-posters-design.md`

## Global Constraints

- **No `innerHTML`, `insertAdjacentHTML`, or `document.write` anywhere in `src/web/static/`.** Every node is `document.createElement` + `textContent`. Release names and filenames come from strangers on public trackers; an `innerHTML` path is stored XSS. `app.ts` says this in two places already.
- **`src/web/**` must not import from `src/ui/**`.** Enforced by `no-restricted-imports` in `eslint.config.js:78-93`. Share through `src/util/` or `src/core/`.
- **`src/web/static/**` must import nothing from `node:*`, directly or transitively.** Enforced by `platform: "browser"` in `tsup.web.config.ts`. Type-only imports are erased and therefore safe.
- **All wire types live in `src/web/wire.ts`.** Never redeclare a payload shape inside `src/web/static/`; re-export from `wire.ts` the way `searchModel.ts` does.
- **Config mutation is read-modify-write per request.** `loadConfig()` → apply → `saveConfig()`. Never hold a config snapshot between requests. `serializeWrites()` only serializes within one process, and `torlnk serve --web` is a separate process from any running TUI.
- **Tests must never touch the real `~/.config/torlnk/config.json`.** Always inject `loadConfigImpl` and `saveConfigImpl`.
- **Poster bytes always go through `/api/poster`** as a blob + `createObjectURL`. Never an `<img src>` pointing at a CDN — that leaks the user's IP and referer, which is the entire reason that route exists.
- **Existing copy constants are reused, never re-worded:** `OMDB_KEY_HINT`, `NO_KEY_POSTER_NOTE` (`"No OMDb key"`), `NO_POSTER_NOTE` (`"No poster"`), all exported from `src/web/static/previewModel.ts`.
- Commands: `npm test` (vitest run), `npm run lint`, `npm run typecheck`. A single file: `npx vitest run <path>`. A single test: `npx vitest run <path> -t "<name>"`.
- Caps, already enforced in `loadConfig`: **50** saved searches, **100** favourites.

---

### Task 1: Move the two list helpers into `src/util/`

The web layer needs `toggleFavourite` and `toggleSavedSearches`. It cannot import them from `src/ui/` — `eslint.config.js:78-93` fails the build with "src/web must not import from src/ui … Share through src/core or src/util instead." This is the same move `src/ui/sort.ts` and `src/ui/filter.ts` made when the web pane needed them (they became `src/util/resultSort.ts` and `src/util/resultFilter.ts`).

Pure rename plus import updates. **No behaviour changes and no test changes** beyond the import path.

**Files:**
- Create: `src/util/favouriteList.ts` (from `src/ui/favourites.ts`)
- Create: `src/util/favouriteList.test.ts` (from `src/ui/favourites.test.ts`)
- Create: `src/util/savedSearchList.ts` (from `src/ui/savedSearches.ts`)
- Create: `src/util/savedSearchList.test.ts` (from `src/ui/savedSearches.test.ts`)
- Delete: `src/ui/favourites.ts`, `src/ui/favourites.test.ts`, `src/ui/savedSearches.ts`, `src/ui/savedSearches.test.ts`
- Modify: `src/ui/App.tsx:59` and `src/ui/App.tsx:60-66` (the two import statements)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `src/util/favouriteList.ts` — `toggleFavourite(current: readonly FavouriteItem[], item: FavouriteItem, limit?: number): FavouriteItem[]`, `removeFavourite(current: readonly FavouriteItem[], id: string): FavouriteItem[]`, `isFavourited(current: readonly FavouriteItem[], id: string): boolean`, `watchedFor(current: readonly FavouriteItem[], id: string): string[]`, `markWatched(current: readonly FavouriteItem[], id: string, filename: string): FavouriteItem[]`
  - `src/util/savedSearchList.ts` — `toggleSavedSearches(current: readonly string[], raw: string, limit?: number): string[]`

- [ ] **Step 1: Confirm the current tests pass before moving anything**

```bash
npx vitest run src/ui/favourites.test.ts src/ui/savedSearches.test.ts
```

Expected: PASS. This is the baseline — the move must not change it.

- [ ] **Step 2: Move the four files with git mv, preserving history**

```bash
git mv src/ui/favourites.ts src/util/favouriteList.ts
git mv src/ui/favourites.test.ts src/util/favouriteList.test.ts
git mv src/ui/savedSearches.ts src/util/savedSearchList.ts
git mv src/ui/savedSearches.test.ts src/util/savedSearchList.test.ts
```

- [ ] **Step 3: Fix the import paths inside the moved files**

`src/util/favouriteList.ts` line 1 — the path to config is unchanged in depth (`src/ui` → `src/util` are both one level under `src`), so this line stays exactly as it is. Verify it reads:

```ts
import type { FavouriteItem } from "../config/config";
```

It must stay `import type`, not a value import: `src/config/config.ts` imports `node:fs`, and a value import here would make this module unusable from a browser bundle. Nothing in `src/web/static/` imports it today, but a type-only import keeps that door open at zero cost.

In `src/util/favouriteList.test.ts`, change the module path:

```ts
} from "./favouriteList";
```

In `src/util/savedSearchList.test.ts`:

```ts
import { toggleSavedSearches } from "./savedSearchList";
```

- [ ] **Step 4: Update the two imports in App.tsx**

`src/ui/App.tsx:59` becomes:

```ts
import { toggleSavedSearches } from "../util/savedSearchList";
```

The multi-line import ending at `src/ui/App.tsx:66` — change only its final line:

```ts
} from "../util/favouriteList";
```

Leave the aliased names inside it (`toggleFavourite as toggleFavouriteList` etc.) exactly as they are.

- [ ] **Step 5: Verify nothing else referenced the old paths**

```bash
grep -rn 'from "\./favourites"\|from "\./savedSearches"\|from "\.\./ui/favourites"\|from "\.\./ui/savedSearches"' src
```

Expected: no output. If anything appears, update it to the `src/util/` path.

- [ ] **Step 6: Run the moved tests, then the full suite and lint**

```bash
npx vitest run src/util/favouriteList.test.ts src/util/savedSearchList.test.ts
npm test
npm run lint
npm run typecheck
```

Expected: all PASS. The moved tests should pass identically to Step 1 — if any assertion changed, the move was not pure and must be corrected.

- [ ] **Step 7: Commit**

```bash
git add -A src/ui src/util
git commit -m "refactor: move favourite and saved-search helpers into src/util

The web layer needs both, and eslint forbids src/web importing src/ui
(they are two front-ends over src/core). Same move sort.ts and filter.ts
made when the web search pane needed them.

Pure rename plus import updates; no assertion changed.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Wire types, the config write seam, and `GET /api/saved`

**Files:**
- Modify: `src/web/wire.ts` (append new types near the end, after the recc types)
- Modify: `src/web/routes.ts` (WebDeps ~line 59-120, imports at top, new function, new route in `handleWebApi`)
- Test: `src/web/routes.test.ts` (append a new `describe`)

**Interfaces:**
- Consumes: `toPublicFavourite` is new here; `FavouriteItem` from `src/config/config`.
- Produces:
  - `src/web/wire.ts` — `PublicFavourite`, `SavedResponse`
  - `src/web/routes.ts` — `WebDeps.saveConfigImpl?: (config: Config) => Promise<void>`, and the exported helper `toPublicFavourite(f: FavouriteItem): PublicFavourite`
  - Route: `GET /api/saved` → 200 `SavedResponse`

- [ ] **Step 1: Write the failing test**

Append to `src/web/routes.test.ts`. Note the existing local `deps()` helper (at the top of that file) — extend it in Step 3, but for now write the test against the shape you want:

```ts
describe("handleWebApi — GET /api/saved", () => {
  it("returns both lists, favourites without their magnets", async () => {
    const res = await handleWebApi(
      deps({
        loadConfigImpl: async () => ({
          ...defaultConfig,
          downloadDir: "/tmp/dl",
          savedSearches: ["dune part two", "the bear s03"],
          favourites: [
            {
              id: "a".repeat(40),
              name: "Severance.S02.1080p.WEB-DL",
              magnet: `magnet:?xt=urn:btih:${"a".repeat(40)}`,
              source: "eztv" as SourceId,
              sizeBytes: 24_000_000_000,
              addedAt: 1_700_000_000_000,
              watched: ["ep1.mkv", "ep2.mkv", "ep3.mkv"],
            },
          ],
        }),
      }),
      "GET",
      "/api/saved",
      new URLSearchParams(),
      undefined,
      "",
    );

    expect(res.status).toBe(200);
    const body = res.json as SavedResponse;
    expect(body.watchlist).toEqual(["dune part two", "the bear s03"]);
    expect(body.library).toEqual([
      {
        id: "a".repeat(40),
        name: "Severance.S02.1080p.WEB-DL",
        source: "eztv",
        sizeBytes: 24_000_000_000,
        addedAt: 1_700_000_000_000,
        watched: 3,
      },
    ]);
    // The magnet must not cross this wire: the page never needs it (playing a
    // favourite goes through POST /api/stream { infoHash, name }), and neither
    // must the episode FILENAMES — `watched` is a count, because the pane
    // renders "3 watched" and the filenames are strings from inside a
    // stranger's torrent.
    expect(JSON.stringify(body)).not.toContain("magnet:");
    expect(JSON.stringify(body)).not.toContain("ep1.mkv");
  });

  it("answers empty lists for a config with neither", async () => {
    const res = await handleWebApi(
      deps(),
      "GET",
      "/api/saved",
      new URLSearchParams(),
      undefined,
      "",
    );
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ watchlist: [], library: [] });
  });

  it("requires the token when one is configured", async () => {
    const res = await handleWebApi(
      deps({ token: "secret" }),
      "GET",
      "/api/saved",
      new URLSearchParams(),
      undefined,
      "",
    );
    expect(res.status).toBe(401);
  });
});
```

Add `SavedResponse` to the `./wire` type import at the top of `routes.test.ts` (it currently imports `PublicSearchSnapshot, SourcesResponse`).

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/web/routes.test.ts -t "GET /api/saved"
```

Expected: FAIL — TypeScript cannot resolve `SavedResponse`, and the route answers 404.

- [ ] **Step 3: Add the wire types**

Append to `src/web/wire.ts`:

```ts
/**
 * One favourited torrent, as `GET /api/saved` hands it to the browser.
 *
 * TWO FIELDS ARE DELIBERATELY ABSENT.
 *
 * The MAGNET, because the page has no use for it: playing a favourite goes
 * through `POST /api/stream { infoHash, name }`, which rebuilds the magnet
 * server-side with the default tracker list. Shipping it would put a few hundred
 * bytes of tracker URLs per row on the wire to no end.
 *
 * The watched FILENAMES, replaced by a count. The pane renders "3 watched", so
 * the count is the whole requirement — and the filenames are strings from inside
 * a stranger's torrent, which is not something to hand a browser without a
 * reason.
 */
export interface PublicFavourite {
  /** The info hash, which is also the dedupe key. */
  id: string;
  name: string;
  sizeBytes?: number;
  source?: string;
  /** Epoch ms. */
  addedAt: number;
  /** How many episodes have been streamed, NOT which ones. */
  watched: number;
}

/**
 * The body of `GET /api/saved` — both saved lists in one response.
 *
 * One route rather than two because the `saved` pane shows both lists at once,
 * so two routes would mean two round trips for one screen.
 *
 * The names are the TUI's and are load-bearing: `watchlist` is
 * `config.savedSearches` (search query strings) and `library` is
 * `config.favourites` (pinned torrents). Both clients read and write the same
 * config file, so a browser that renamed either would show a different list
 * under the same word.
 */
export interface SavedResponse {
  watchlist: string[];
  library: PublicFavourite[];
}
```

- [ ] **Step 4: Add the write seam and the route to routes.ts**

In the `WebDeps` interface, directly after the `loadConfigImpl` declaration (~line 73), add:

```ts
  /**
   * Persist the config. Injected with a default in the same style as
   * `loadConfigImpl`, and for a stronger reason: the default writes the
   * developer's real `~/.config/torlnk/config.json`, so a test that forgets this
   * seam does not fail — it silently edits the machine it runs on.
   */
  saveConfigImpl?: (config: Config) => Promise<void>;
```

Add `saveConfig` to the existing `from "../config/config"` import block (lines 6-13), and `FavouriteItem` as a type:

```ts
import {
  // …existing named imports…
  saveConfig,
  type Config,
  type FavouriteItem,
} from "../config/config";
```

Add a new section, placed just before the `// ---- title metadata ----` banner:

```ts
// ---- saved lists -------------------------------------------------------
// The watchlist (config.savedSearches) and the library (config.favourites),
// which the TUI has had all along. Both are read here and mutated by the two
// routes below.
//
// EVERY MUTATION RE-READS THE CONFIG FIRST, and that is not defensive style —
// it is required. `serializeWrites()` in config.ts serializes writes within ONE
// process, and `torlnk serve --web` is a separate process from any TUI the user
// has open. A held snapshot written back would silently revert whatever the TUI
// changed meanwhile: the Real-Debrid token, the sort, disabledSources. Last
// writer wins on the one list being edited is acceptable (the TUI already does
// that to itself); last writer wins on the whole file is not.

/** A stored favourite as the browser sees it. Drops the magnet and the watched filenames. */
export function toPublicFavourite(f: FavouriteItem): PublicFavourite {
  const out: PublicFavourite = {
    id: f.id,
    name: f.name,
    addedAt: f.addedAt,
    watched: f.watched?.length ?? 0,
  };
  if (f.sizeBytes !== undefined && f.sizeBytes > 0) out.sizeBytes = f.sizeBytes;
  if (f.source !== undefined) out.source = f.source;
  return out;
}

/** `GET /api/saved`: both lists, in one round trip because the pane shows both. */
async function savedLists(deps: WebDeps): Promise<WebResponse> {
  const config = await (deps.loadConfigImpl ?? loadConfig)();
  const out: SavedResponse = {
    // loadConfig already normalises both (junk dropped, caps applied), so these
    // coalesces are for a config object built in a test, not for disk data.
    watchlist: config.savedSearches ?? [],
    library: (config.favourites ?? []).map(toPublicFavourite),
  };
  return { status: 200, json: out };
}
```

Add `PublicFavourite` and `SavedResponse` to the `from "./wire"` type import block (lines 39-54).

Register the route in `handleWebApi`, immediately after the `/api/sources` block (~line 1152):

```ts
  if (method === "GET" && urlPath === "/api/saved") {
    return savedLists(deps);
  }
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
npx vitest run src/web/routes.test.ts -t "GET /api/saved"
```

Expected: PASS, all three cases.

- [ ] **Step 6: Commit**

```bash
git add src/web/wire.ts src/web/routes.ts src/web/routes.test.ts
git commit -m "feat(web): GET /api/saved, plus a config write seam in WebDeps

The wire type drops the magnet (the page plays a favourite through
POST /api/stream { infoHash, name }) and reports watched as a count
rather than shipping episode filenames.

saveConfigImpl exists so a test that forgets it fails loudly instead of
editing the developer's real config file.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: `POST /api/watchlist`

**Files:**
- Modify: `src/web/wire.ts` (append)
- Modify: `src/web/routes.ts` (new function in the saved-lists section, new route)
- Test: `src/web/routes.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `toggleSavedSearches` from `src/util/savedSearchList` (Task 1); `WebDeps.saveConfigImpl` (Task 2).
- Produces: `WatchlistRequest`, `WatchlistResponse` in `wire.ts`; route `POST /api/watchlist`.

- [ ] **Step 1: Write the failing test**

```ts
describe("handleWebApi — POST /api/watchlist", () => {
  // A fresh capture per test: the route must WRITE, and asserting on what it
  // wrote is the only way to know it persisted rather than answered from memory.
  function capture(config: Partial<Config> = {}) {
    const saved: Config[] = [];
    const d = deps({
      loadConfigImpl: async () => ({ ...defaultConfig, downloadDir: "/tmp/dl", ...config }),
      saveConfigImpl: async (c: Config) => {
        saved.push(c);
      },
    });
    return { deps: d, saved };
  }

  const post = (d: WebDeps, body: unknown) =>
    handleWebApi(d, "POST", "/api/watchlist", new URLSearchParams(), undefined, JSON.stringify(body));

  it("adds a query, most-recent first, and persists it", async () => {
    const { deps: d, saved } = capture({ savedSearches: ["the bear s03"] });
    const res = await post(d, { query: "dune part two", action: "toggle" });

    expect(res.status).toBe(200);
    expect(res.json).toEqual({ saved: true, watchlist: ["dune part two", "the bear s03"] });
    expect(saved).toHaveLength(1);
    expect(saved[0]?.savedSearches).toEqual(["dune part two", "the bear s03"]);
  });

  it("toggle removes a query that is already saved", async () => {
    const { deps: d, saved } = capture({ savedSearches: ["dune part two", "the bear s03"] });
    const res = await post(d, { query: "dune part two", action: "toggle" });

    expect(res.json).toEqual({ saved: false, watchlist: ["the bear s03"] });
    expect(saved[0]?.savedSearches).toEqual(["the bear s03"]);
  });

  it("trims the query, so the same search cannot be saved twice", async () => {
    const { deps: d } = capture({ savedSearches: ["dune part two"] });
    const res = await post(d, { query: "  dune part two  ", action: "toggle" });
    expect(res.json).toEqual({ saved: false, watchlist: [] });
  });

  it("remove is idempotent — a double-fired click must not re-add", async () => {
    const { deps: d } = capture({ savedSearches: ["dune part two"] });
    const first = await post(d, { query: "dune part two", action: "remove" });
    expect(first.json).toEqual({ saved: false, watchlist: [] });

    // Same starting config (capture() rebuilds it per load), so this stands in
    // for the second of two clicks arriving before the list re-rendered.
    const second = await post(d, { query: "not in the list", action: "remove" });
    expect(second.json).toEqual({ saved: false, watchlist: ["dune part two"] });
  });

  it("rejects a blank query rather than answering 200 to a no-op", async () => {
    const { deps: d, saved } = capture();
    const res = await post(d, { query: "   ", action: "toggle" });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: "missing query" });
    expect(saved).toHaveLength(0);
  });

  it("rejects an unknown action and an unparseable body", async () => {
    const { deps: d } = capture();
    const bad = await post(d, { query: "dune", action: "explode" });
    expect(bad.status).toBe(400);
    expect(bad.json).toEqual({ error: "invalid action" });

    const junk = await handleWebApi(
      d,
      "POST",
      "/api/watchlist",
      new URLSearchParams(),
      undefined,
      "not json",
    );
    expect(junk.status).toBe(400);
    expect(junk.json).toEqual({ error: "invalid JSON body" });
  });

  it("preserves unrelated config fields — it must not clobber the file", async () => {
    const { deps: d, saved } = capture({
      realDebridToken: "rd-token",
      sort: "seeders:desc",
      disabledSources: ["eztv"],
    });
    await post(d, { query: "dune", action: "toggle" });
    expect(saved[0]?.realDebridToken).toBe("rd-token");
    expect(saved[0]?.sort).toBe("seeders:desc");
    expect(saved[0]?.disabledSources).toEqual(["eztv"]);
  });

  it("requires the token when one is configured", async () => {
    const res = await handleWebApi(
      deps({ token: "secret" }),
      "POST",
      "/api/watchlist",
      new URLSearchParams(),
      undefined,
      JSON.stringify({ query: "dune", action: "toggle" }),
    );
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/web/routes.test.ts -t "POST /api/watchlist"
```

Expected: FAIL — the route answers 404 (it falls through to the not-found at the end of `handleWebApi`).

- [ ] **Step 3: Add the wire types**

Append to `src/web/wire.ts`:

```ts
/**
 * The body of `POST /api/watchlist`.
 *
 * `toggle` mirrors the TUI's `w` key: save this query, or unsave it if it is
 * already there. `remove` is a separate, idempotent action rather than a second
 * toggle, for the ✕ in the list — a toggle there would RE-ADD a row the user
 * just deleted if the click double-fired, which on a phone it does.
 */
export interface WatchlistRequest {
  query: string;
  action: "toggle" | "remove";
}

/**
 * The 200 body of `POST /api/watchlist`.
 *
 * The whole list comes back, not just the verdict, so the browser never has to
 * predict server state: it flips the button optimistically and then renders
 * whatever this says. `saved` is the state of THIS query afterwards, which the
 * caller would otherwise have to search the list for.
 */
export interface WatchlistResponse {
  saved: boolean;
  watchlist: string[];
}
```

- [ ] **Step 4: Add the route implementation**

In `src/web/routes.ts`, add to the saved-lists section. First a shared body parser (the library route in Task 4 reuses it):

```ts
/** A JSON object body, or null for anything that is not one. */
function parseObjectBody(bodyText: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function watchlistAction(deps: WebDeps, bodyText: string): Promise<WebResponse> {
  const body = parseObjectBody(bodyText);
  if (!body) return { status: 400, json: { error: "invalid JSON body" } };

  const action = body.action;
  if (action !== "toggle" && action !== "remove") {
    return { status: 400, json: { error: "invalid action" } };
  }

  // Trimmed here so "  dune  " and "dune" are one entry, matching the TUI —
  // toggleSavedSearches trims too, but the emptiness check below needs the
  // trimmed value and a second trim inside the helper is not something to rely
  // on from out here.
  const query = typeof body.query === "string" ? body.query.trim() : "";
  // A blank query would make toggleSavedSearches a no-op that still answered
  // 200, telling the browser something happened when nothing did.
  if (!query) return { status: 400, json: { error: "missing query" } };

  const config = await (deps.loadConfigImpl ?? loadConfig)();
  const current = config.savedSearches ?? [];
  const watchlist =
    action === "remove" ? current.filter((q) => q !== query) : toggleSavedSearches(current, query);

  await (deps.saveConfigImpl ?? saveConfig)({ ...config, savedSearches: watchlist });

  const out: WatchlistResponse = { saved: watchlist.includes(query), watchlist };
  return { status: 200, json: out };
}
```

Import the helper at the top of `routes.ts`:

```ts
import { toggleSavedSearches } from "../util/savedSearchList";
```

Add `WatchlistResponse` to the `from "./wire"` type import block.

Register the route right after `/api/saved`:

```ts
  if (method === "POST" && urlPath === "/api/watchlist") {
    return watchlistAction(deps, bodyText);
  }
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
npx vitest run src/web/routes.test.ts -t "POST /api/watchlist"
```

Expected: PASS, all eight cases.

- [ ] **Step 6: Commit**

```bash
git add src/web/wire.ts src/web/routes.ts src/web/routes.test.ts
git commit -m "feat(web): POST /api/watchlist toggles and removes saved searches

Read-modify-write per request, so a TUI editing the same config file
concurrently loses only the one list rather than the whole file.

remove is idempotent and separate from toggle: a double-fired tap on the
list's delete button must not re-add the row.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: `POST /api/library` — toggle and remove, with the reccd taste event

The design's load-bearing detail lands here: a `PublicSearchResult` carries **no magnet** (it would be ~6MB a search), and `isFavouriteItem` in `config.ts:86-94` **rejects a favourite without one**. So the server builds it with `buildMagnet(infoHash, name)` — the same reconstruction `POST /api/stream` already performs for a hash-only play, which is why a favourite made from a search row still plays weeks later.

**Files:**
- Modify: `src/web/wire.ts` (append)
- Modify: `src/web/routes.ts`
- Test: `src/web/routes.test.ts`

**Interfaces:**
- Consumes: `toggleFavourite`, `removeFavourite`, `isFavourited` from `src/util/favouriteList` (Task 1); `buildMagnet` from `src/sources/magnet`; `parseObjectBody`, `toPublicFavourite` (Tasks 2-3); `resolveReccConfig` and `postEvent` (already imported in `routes.ts`).
- Produces: `LibraryRequest`, `LibraryResponse` in `wire.ts`; route `POST /api/library` handling `"toggle"` and `"remove"`. Task 5 adds `"watched"` to the same route.

- [ ] **Step 1: Write the failing test**

```ts
describe("handleWebApi — POST /api/library", () => {
  const HASH = "b".repeat(40);

  function fav(over: Partial<FavouriteItem> = {}): FavouriteItem {
    return {
      id: HASH,
      name: "Severance.S02.1080p.WEB-DL",
      magnet: `magnet:?xt=urn:btih:${HASH}`,
      addedAt: 1_700_000_000_000,
      ...over,
    };
  }

  function capture(config: Partial<Config> = {}) {
    const saved: Config[] = [];
    const events: ReccEvent[] = [];
    const d = deps({
      loadConfigImpl: async () => ({ ...defaultConfig, downloadDir: "/tmp/dl", ...config }),
      saveConfigImpl: async (c: Config) => {
        saved.push(c);
      },
      postEventImpl: async (_cfg, e) => {
        events.push(e);
      },
    });
    return { deps: d, saved, events };
  }

  const post = (d: WebDeps, body: unknown) =>
    handleWebApi(d, "POST", "/api/library", new URLSearchParams(), undefined, JSON.stringify(body));

  it("favourites a search hit, building a magnet the config layer accepts", async () => {
    const { deps: d, saved } = capture();
    const res = await post(d, {
      infoHash: HASH,
      name: "Severance.S02.1080p.WEB-DL",
      sizeBytes: 24_000_000_000,
      source: "eztv",
      action: "toggle",
    });

    expect(res.status).toBe(200);
    const body = res.json as LibraryResponse;
    expect(body.favourited).toBe(true);
    expect(body.library).toHaveLength(1);
    expect(body.library[0]?.name).toBe("Severance.S02.1080p.WEB-DL");
    expect(body.library[0]?.watched).toBe(0);

    // The stored entry MUST carry a magnet: a search result has none on the
    // wire, and isFavouriteItem drops an entry without one — so without
    // buildMagnet this favourite would vanish on the next loadConfig.
    const stored = saved[0]?.favourites?.[0];
    expect(stored?.magnet).toContain(`xt=urn:btih:${HASH}`);
    expect(stored?.magnet).toContain("dn=Severance.S02.1080p.WEB-DL");
    expect(stored?.magnet).toContain("tr=");
  });

  it("stamps addedAt with the server clock, never the browser's", async () => {
    const { deps: d, saved } = capture();
    const before = Date.now();
    await post(d, { infoHash: HASH, name: "Severance", action: "toggle" });
    const stored = saved[0]?.favourites?.[0];
    expect(stored?.addedAt).toBeGreaterThanOrEqual(before);
    expect(stored?.addedAt).toBeLessThanOrEqual(Date.now());
  });

  it("toggle unfavourites a torrent already in the library", async () => {
    const { deps: d, saved } = capture({ favourites: [fav()] });
    const res = await post(d, { infoHash: HASH, name: "Severance", action: "toggle" });

    expect((res.json as LibraryResponse).favourited).toBe(false);
    expect((res.json as LibraryResponse).library).toEqual([]);
    expect(saved[0]?.favourites).toEqual([]);
  });

  it("remove is idempotent", async () => {
    const { deps: d } = capture({ favourites: [fav()] });
    const gone = await post(d, { infoHash: HASH, name: "Severance", action: "remove" });
    expect((gone.json as LibraryResponse).library).toEqual([]);

    const again = await post(d, { infoHash: "c".repeat(40), name: "Other", action: "remove" });
    expect((again.json as LibraryResponse).library).toHaveLength(1);
    expect((again.json as LibraryResponse).favourited).toBe(false);
  });

  it("posts favourited / unfavourited to reccd, so the taste profile matches the TUI", async () => {
    const on = capture({ reccUrl: "http://localhost:4100" });
    await post(on.deps, { infoHash: HASH, name: "Severance.S02", action: "toggle" });
    expect(on.events).toEqual([
      expect.objectContaining({ type: "favourited", rawName: "Severance.S02", source: "torlink" }),
    ]);

    const off = capture({ reccUrl: "http://localhost:4100", favourites: [fav()] });
    await post(off.deps, { infoHash: HASH, name: "Severance.S02", action: "toggle" });
    expect(off.events).toEqual([expect.objectContaining({ type: "unfavourited" })]);
  });

  it("uses the server clock for the event ts, not a browser's", async () => {
    const { deps: d, events } = capture({ reccUrl: "http://localhost:4100" });
    const before = Date.now();
    await post(d, { infoHash: HASH, name: "Severance", action: "toggle" });
    expect(events[0]?.ts).toBeGreaterThanOrEqual(before);
  });

  it("posts no event on remove — the TUI's ✕ does not rate anything either", async () => {
    const { deps: d, events } = capture({
      reccUrl: "http://localhost:4100",
      favourites: [fav()],
    });
    await post(d, { infoHash: HASH, name: "Severance", action: "remove" });
    expect(events).toEqual([]);
  });

  it("succeeds with reccd unconfigured, and when the event post rejects", async () => {
    const quiet = capture(); // no reccUrl
    const ok = await post(quiet.deps, { infoHash: HASH, name: "Severance", action: "toggle" });
    expect(ok.status).toBe(200);
    expect(quiet.events).toEqual([]);

    const broken = deps({
      loadConfigImpl: async () => ({
        ...defaultConfig,
        downloadDir: "/tmp/dl",
        reccUrl: "http://localhost:4100",
      }),
      saveConfigImpl: async () => {},
      postEventImpl: async () => {
        throw new Error("reccd is down");
      },
    });
    const survives = await post(broken, { infoHash: HASH, name: "Severance", action: "toggle" });
    // reccd must never take a favourite with it: the event is fire-and-forget.
    expect(survives.status).toBe(200);
  });

  it("rejects a bad hash, a missing name, and an unknown action", async () => {
    const { deps: d, saved } = capture();

    expect((await post(d, { infoHash: "nope", name: "X", action: "toggle" })).status).toBe(400);
    expect((await post(d, { infoHash: HASH, name: "   ", action: "toggle" })).status).toBe(400);
    expect((await post(d, { infoHash: HASH, name: "X", action: "explode" })).status).toBe(400);
    expect(saved).toHaveLength(0);
  });

  it("preserves unrelated config fields", async () => {
    const { deps: d, saved } = capture({ realDebridToken: "rd-token", trackers: ["udp://x/announce"] });
    await post(d, { infoHash: HASH, name: "Severance", action: "toggle" });
    expect(saved[0]?.realDebridToken).toBe("rd-token");
    expect(saved[0]?.trackers).toEqual(["udp://x/announce"]);
  });

  it("requires the token when one is configured", async () => {
    const res = await handleWebApi(
      deps({ token: "secret" }),
      "POST",
      "/api/library",
      new URLSearchParams(),
      undefined,
      JSON.stringify({ infoHash: HASH, name: "X", action: "toggle" }),
    );
    expect(res.status).toBe(401);
  });
});
```

Add to `routes.test.ts`'s imports: `type FavouriteItem` from `../config/config`, `type ReccEvent` from `../recc/client`, and `type LibraryResponse` from `./wire`. (`SourceId` is already imported.)

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/web/routes.test.ts -t "POST /api/library"
```

Expected: FAIL — 404 from the route, plus unresolved `LibraryResponse`.

- [ ] **Step 3: Add the wire types**

Append to `src/web/wire.ts`:

```ts
/**
 * The body of `POST /api/library`.
 *
 * IDENTIFIED BY INFO HASH, WITH NO MAGNET, and that is forced rather than
 * chosen: `PublicSearchResult` carries no magnet (it would be ~6MB a search)
 * while a stored favourite REQUIRES one — `isFavouriteItem` drops an entry
 * without it. The server bridges that with `buildMagnet(infoHash, name)`, the
 * same reconstruction `POST /api/stream` already does for a hash-only play. So
 * `name` is not decoration here: it becomes the magnet's `dn` and the row's
 * label, and without it a favourite is 40 hex characters.
 *
 * `"watched"` records one episode filename against an existing favourite,
 * mirroring the TUI's `markWatchedInFavourite`. It requires `filename`.
 */
export interface LibraryRequest {
  /** 40 hex characters, or 32 base32. Also the dedupe key. */
  infoHash: string;
  name: string;
  sizeBytes?: number;
  source?: string;
  action: "toggle" | "remove" | "watched";
  /** Required for `"watched"`, ignored otherwise. */
  filename?: string;
}

/** The 200 body of `POST /api/library`. Same contract as `WatchlistResponse`: the caller renders what comes back. */
export interface LibraryResponse {
  /** Whether THIS torrent is in the library afterwards. */
  favourited: boolean;
  library: PublicFavourite[];
}
```

- [ ] **Step 4: Add the route implementation**

Add these imports to `src/web/routes.ts`:

```ts
import {
  isFavourited,
  removeFavourite as removeFromFavourites,
  toggleFavourite as toggleInFavourites,
} from "../util/favouriteList";
```

Extend the existing `from "../sources/magnet"` import (line 25) to `import { buildMagnet, normalizeInfoHash, parseInput } from "../sources/magnet";`.

Add to the saved-lists section:

```ts
async function libraryAction(deps: WebDeps, bodyText: string): Promise<WebResponse> {
  const body = parseObjectBody(bodyText);
  if (!body) return { status: 400, json: { error: "invalid JSON body" } };

  const action = body.action;
  if (action !== "toggle" && action !== "remove" && action !== "watched") {
    return { status: 400, json: { error: "invalid action" } };
  }

  // normalizeInfoHash accepts 40-hex or 32-base32 and lowercases; an empty
  // return means neither. Validated rather than trusted because this string
  // becomes a magnet the download engine and Real-Debrid will act on.
  const infoHash = normalizeInfoHash(typeof body.infoHash === "string" ? body.infoHash : "");
  if (!infoHash) return { status: 400, json: { error: "invalid info hash" } };

  // Required even on remove, where it is unused: a body missing it is a client
  // bug, and accepting it on one action but not another is the kind of
  // asymmetry that gets a caller written against the wrong shape.
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return { status: 400, json: { error: "missing name" } };

  const config = await (deps.loadConfigImpl ?? loadConfig)();
  const current = config.favourites ?? [];
  const wasFavourited = isFavourited(current, infoHash);

  let favourites: FavouriteItem[];
  if (action === "remove") {
    favourites = removeFromFavourites(current, infoHash);
  } else {
    const item: FavouriteItem = {
      id: infoHash,
      name,
      // The bridge this route exists to build. See LibraryRequest's comment.
      magnet: buildMagnet(infoHash, name),
      // The SERVER's clock. A browser's can be years out, and the library is
      // ordered most-recent-first — one bad addedAt pins a row to the top for
      // good.
      addedAt: Date.now(),
    };
    if (typeof body.sizeBytes === "number" && body.sizeBytes > 0) item.sizeBytes = body.sizeBytes;
    if (typeof body.source === "string" && body.source) item.source = body.source as SourceId;
    favourites = toggleInFavourites(current, item);
  }

  await (deps.saveConfigImpl ?? saveConfig)({ ...config, favourites });

  // Only a toggle rates anything. Removing a row from the library is
  // housekeeping — the TUI's ✕ posts no event either, and treating it as a
  // verdict would teach reccd that tidying up is a dislike.
  if (action === "toggle") {
    const reccConfig = resolveReccConfig(config);
    if (reccConfig.reccUrl) {
      const event: ReccEvent = {
        type: wasFavourited ? "unfavourited" : "favourited",
        rawName: name,
        // Server clock and fixed source, for the reason reccEvent states.
        ts: Date.now(),
        source: "torlink",
      };
      // `.catch` on top of postEvent's own swallowing, and for the same reason
      // reccEvent does it: this promise is unwatched, and an unhandled
      // rejection from an injected impl would take the daemon down — which is
      // the exact "reccd must never take the process with it" rule these
      // routes exist to honour.
      void (deps.postEventImpl ?? postEvent)(reccConfig, event).catch(() => {});
    }
  }

  const out: LibraryResponse = {
    favourited: isFavourited(favourites, infoHash),
    library: favourites.map(toPublicFavourite),
  };
  return { status: 200, json: out };
}
```

Add `LibraryResponse` to the `from "./wire"` type import block. Register the route after `/api/watchlist`:

```ts
  if (method === "POST" && urlPath === "/api/library") {
    return libraryAction(deps, bodyText);
  }
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
npx vitest run src/web/routes.test.ts -t "POST /api/library"
```

Expected: PASS, all eleven cases. If the "magnet the config layer accepts" case fails, check `buildMagnet` is imported from `../sources/magnet` and not reimplemented.

- [ ] **Step 6: Prove the stored favourite survives a real load**

This is the assertion that matters most and it is worth its own test. Append to the same `describe`:

```ts
  it("stores an entry that survives loadConfig's own validation", async () => {
    const { deps: d, saved } = capture();
    await post(d, { infoHash: HASH, name: "Severance.S02", action: "toggle" });
    const stored = saved[0]?.favourites?.[0];
    // isFavouriteItem's three requirements, which is what would silently drop
    // this entry on the next boot if buildMagnet were ever removed.
    expect(typeof stored?.id).toBe("string");
    expect(stored?.id.length).toBeGreaterThan(0);
    expect(stored?.name.length).toBeGreaterThan(0);
    expect(stored?.magnet.length).toBeGreaterThan(0);
  });
```

```bash
npx vitest run src/web/routes.test.ts -t "survives loadConfig"
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/web/wire.ts src/web/routes.ts src/web/routes.test.ts
git commit -m "feat(web): POST /api/library favourites and unfavourites torrents

A search result carries no magnet and a stored favourite requires one, so
the route builds it with buildMagnet(infoHash, name) — the same
reconstruction POST /api/stream already does for a hash-only play.

A toggle posts favourited/unfavourited to reccd, fire-and-forget, so a
browser favourite teaches the taste profile exactly as the TUI's b key
does. remove posts nothing: tidying up is not a verdict.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: `POST /api/library` — the `watched` action

**Files:**
- Modify: `src/web/routes.ts` (extend `libraryAction`)
- Test: `src/web/routes.test.ts` (append to the library `describe`)

**Interfaces:**
- Consumes: `markWatched` from `src/util/favouriteList`; `libraryAction` from Task 4.
- Produces: no new exports. The `"watched"` branch of `POST /api/library`.

- [ ] **Step 1: Write the failing test**

Append inside the `describe("handleWebApi — POST /api/library")` block from Task 4:

```ts
  it("records a watched episode against a favourite", async () => {
    const { deps: d, saved } = capture({ favourites: [fav({ watched: ["ep1.mkv"] })] });
    const res = await post(d, {
      infoHash: HASH,
      name: "Severance",
      action: "watched",
      filename: "ep2.mkv",
    });

    expect(res.status).toBe(200);
    expect((res.json as LibraryResponse).library[0]?.watched).toBe(2);
    expect(saved[0]?.favourites?.[0]?.watched).toEqual(["ep1.mkv", "ep2.mkv"]);
  });

  it("skips the disk write when nothing changed", async () => {
    // Already recorded: markWatched returns the same array reference, and
    // writing anyway would churn the config file every time a user re-watched
    // an episode.
    const dupe = capture({ favourites: [fav({ watched: ["ep1.mkv"] })] });
    await post(dupe.deps, { infoHash: HASH, name: "Severance", action: "watched", filename: "ep1.mkv" });
    expect(dupe.saved).toHaveLength(0);

    // Not favourited at all: there is nothing to record against. Still a 200 —
    // the browser fires this after a player launches and must not be handed an
    // error for playing something it never favourited.
    const absent = capture();
    const res = await post(absent.deps, {
      infoHash: HASH,
      name: "Severance",
      action: "watched",
      filename: "ep1.mkv",
    });
    expect(res.status).toBe(200);
    expect((res.json as LibraryResponse).favourited).toBe(false);
    expect(absent.saved).toHaveLength(0);
  });

  it("rejects watched without a filename", async () => {
    const { deps: d, saved } = capture({ favourites: [fav()] });
    const res = await post(d, { infoHash: HASH, name: "Severance", action: "watched" });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: "missing filename" });
    expect(saved).toHaveLength(0);
  });

  it("posts no reccd event for watched — it is progress, not a rating", async () => {
    const { deps: d, events } = capture({
      reccUrl: "http://localhost:4100",
      favourites: [fav()],
    });
    await post(d, { infoHash: HASH, name: "Severance", action: "watched", filename: "ep1.mkv" });
    expect(events).toEqual([]);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/web/routes.test.ts -t "records a watched episode"
```

Expected: FAIL — `libraryAction` treats `"watched"` as a toggle (it falls into the `else` branch), so it adds a *new* favourite instead of recording an episode.

- [ ] **Step 3: Extend libraryAction**

Add `markWatched` to the `../util/favouriteList` import. Then, in `libraryAction`, insert this branch **immediately after the `name` check and the `const config` / `current` / `wasFavourited` lines**, before the `let favourites` block:

```ts
  if (action === "watched") {
    const filename = typeof body.filename === "string" ? body.filename.trim() : "";
    if (!filename) return { status: 400, json: { error: "missing filename" } };

    // markWatched returns the SAME array reference when nothing changed — the
    // id is not favourited, or the episode was already recorded. Both are
    // ordinary: this fires whenever a player launches, including for a torrent
    // the user never favourited. Writing anyway would churn config.json on
    // every re-watch, so the reference check is the write gate.
    const favourites = markWatched(current, infoHash, filename);
    if (favourites !== current) {
      await (deps.saveConfigImpl ?? saveConfig)({ ...config, favourites });
    }
    const out: LibraryResponse = {
      // Not an error when absent: the browser fires this after a successful
      // play and must not be told off for playing something unfavourited.
      favourited: isFavourited(favourites, infoHash),
      library: favourites.map(toPublicFavourite),
    };
    return { status: 200, json: out };
  }
```

Note this branch returns early, which is what keeps the reccd event below it from firing for `"watched"` — progress is not a rating.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run src/web/routes.test.ts -t "POST /api/library"
```

Expected: PASS, all fifteen cases (Task 4's eleven plus these four).

- [ ] **Step 5: Run the full suite, lint and typecheck — the server side is now complete**

```bash
npm test
npm run lint
npm run typecheck
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/web/routes.ts src/web/routes.test.ts
git commit -m "feat(web): record watched episodes through POST /api/library

markWatched returns the same array reference when nothing changed, and
that reference check is the write gate: this fires on every player launch,
including for torrents that were never favourited, so writing
unconditionally would churn config.json on every re-watch.

Posts no reccd event — watching an episode is progress, not a verdict.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: `savedModel.ts` — the saved pane's decisions

**Files:**
- Create: `src/web/static/savedModel.ts`
- Test: `src/web/static/savedModel.test.ts`

**Interfaces:**
- Consumes: `PublicFavourite`, `SavedResponse`, `WatchlistRequest`, `LibraryRequest` from `../wire` (Tasks 2-4).
- Produces:
  - `emptySaved(): SavedState`
  - `interface SavedState { watchlist: string[]; library: PublicFavourite[]; loaded: boolean; error: string | null }`
  - `watchlistBody(query: string, action: "toggle" | "remove"): WatchlistRequest`
  - `libraryBody(input: LibraryInput, action: "toggle" | "remove" | "watched", filename?: string): LibraryRequest`
  - `interface LibraryInput { infoHash: string; name: string; sizeBytes?: number; source?: string }`
  - `isInLibrary(state: SavedState, infoHash: string): boolean`
  - `favouriteLabel(inLibrary: boolean): string`
  - `favouriteMeta(f: PublicFavourite): string`
  - `watchlistStatus(state: SavedState): { text: string; show: boolean; tone: "dim" | "error" }`
  - `libraryStatus(state: SavedState): { text: string; show: boolean; tone: "dim" | "error" }`
  - `applySaved(state: SavedState, response: SavedResponse): SavedState`

- [ ] **Step 1: Write the failing test**

Create `src/web/static/savedModel.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  applySaved,
  emptySaved,
  favouriteLabel,
  favouriteMeta,
  isInLibrary,
  libraryBody,
  libraryStatus,
  watchlistBody,
  watchlistStatus,
  type SavedState,
} from "./savedModel";
import type { PublicFavourite } from "../wire";

const HASH = "b".repeat(40);

function favourite(over: Partial<PublicFavourite> = {}): PublicFavourite {
  return { id: HASH, name: "Severance.S02.1080p", addedAt: 1_700_000_000_000, watched: 0, ...over };
}

function loaded(over: Partial<SavedState> = {}): SavedState {
  return { ...emptySaved(), loaded: true, ...over };
}

describe("emptySaved", () => {
  it("opens unloaded with no error, so the pane can say 'loading' rather than 'empty'", () => {
    // These are different sentences to a user: an empty library and a library
    // that has not arrived yet must not read the same.
    expect(emptySaved()).toEqual({ watchlist: [], library: [], loaded: false, error: null });
  });
});

describe("watchlistBody", () => {
  it("sends the query and the action", () => {
    expect(watchlistBody("dune part two", "toggle")).toEqual({
      query: "dune part two",
      action: "toggle",
    });
    expect(watchlistBody("dune part two", "remove")).toEqual({
      query: "dune part two",
      action: "remove",
    });
  });

  it("trims, so the box's stray spaces cannot create a second entry", () => {
    expect(watchlistBody("  dune  ", "toggle").query).toBe("dune");
  });
});

describe("libraryBody", () => {
  it("carries the name, which is what becomes the magnet's dn server-side", () => {
    expect(
      libraryBody(
        { infoHash: HASH, name: "Severance.S02.1080p", sizeBytes: 24_000_000_000, source: "eztv" },
        "toggle",
      ),
    ).toEqual({
      infoHash: HASH,
      name: "Severance.S02.1080p",
      sizeBytes: 24_000_000_000,
      source: "eztv",
      action: "toggle",
    });
  });

  it("omits sizeBytes and source when absent rather than sending zero or empty", () => {
    const body = libraryBody({ infoHash: HASH, name: "Severance" }, "remove");
    expect(body).toEqual({ infoHash: HASH, name: "Severance", action: "remove" });
    expect("sizeBytes" in body).toBe(false);
    expect("source" in body).toBe(false);
  });

  it("omits a zero size — the server treats >0 as known and 0 would read as known-and-empty", () => {
    const body = libraryBody({ infoHash: HASH, name: "Severance", sizeBytes: 0 }, "toggle");
    expect("sizeBytes" in body).toBe(false);
  });

  it("includes the filename for watched and omits it otherwise", () => {
    expect(libraryBody({ infoHash: HASH, name: "S" }, "watched", "ep1.mkv")).toEqual({
      infoHash: HASH,
      name: "S",
      action: "watched",
      filename: "ep1.mkv",
    });
    const toggled = libraryBody({ infoHash: HASH, name: "S" }, "toggle", "ep1.mkv");
    expect("filename" in toggled).toBe(false);
  });
});

describe("isInLibrary / favouriteLabel", () => {
  it("matches on the info hash", () => {
    const state = loaded({ library: [favourite()] });
    expect(isInLibrary(state, HASH)).toBe(true);
    expect(isInLibrary(state, "c".repeat(40))).toBe(false);
  });

  it("labels the button by what it will do, not by the current state", () => {
    // A button reading "favourited" invites a click that un-favourites, which
    // is the opposite of what it appears to promise.
    expect(favouriteLabel(false)).toBe("favourite");
    expect(favouriteLabel(true)).toBe("unfavourite");
  });
});

describe("favouriteMeta", () => {
  it("reports the watched count and the size", () => {
    expect(favouriteMeta(favourite({ watched: 3, sizeBytes: 24_000_000_000 }))).toBe(
      "3 watched · 22.4 GB",
    );
  });

  it("singularises one episode", () => {
    expect(favouriteMeta(favourite({ watched: 1 }))).toBe("1 watched");
  });

  it("says nothing about zero watched — a fresh favourite is not '0 watched'", () => {
    expect(favouriteMeta(favourite({ watched: 0, sizeBytes: 24_000_000_000 }))).toBe("22.4 GB");
  });

  it("says size unknown rather than 0 B", () => {
    expect(favouriteMeta(favourite({ watched: 0 }))).toBe("size unknown");
  });
});

describe("watchlistStatus / libraryStatus", () => {
  it("says loading before the first response, not empty", () => {
    expect(watchlistStatus(emptySaved())).toEqual({ text: "Loading…", show: true, tone: "dim" });
    expect(libraryStatus(emptySaved())).toEqual({ text: "Loading…", show: true, tone: "dim" });
  });

  it("explains how to fill each list when it is empty", () => {
    expect(watchlistStatus(loaded())).toEqual({
      text: "Save a search to keep it here.",
      show: true,
      tone: "dim",
    });
    expect(libraryStatus(loaded())).toEqual({
      text: "Favourite a result to keep it here.",
      show: true,
      tone: "dim",
    });
  });

  it("hides the line once there are rows to look at", () => {
    expect(watchlistStatus(loaded({ watchlist: ["dune"] })).show).toBe(false);
    expect(libraryStatus(loaded({ library: [favourite()] })).show).toBe(false);
  });

  it("shows an error over both lists, and outranks having rows", () => {
    // A stale list next to no explanation is worse than a stale list with one:
    // the user needs to know these rows may not reflect the server.
    const broken = loaded({ watchlist: ["dune"], error: "Can't reach torlnk." });
    expect(watchlistStatus(broken)).toEqual({
      text: "Can't reach torlnk.",
      show: true,
      tone: "error",
    });
    expect(libraryStatus(broken).tone).toBe("error");
  });
});

describe("applySaved", () => {
  it("takes the server's lists and marks the state loaded, clearing any error", () => {
    const next = applySaved(loaded({ error: "old failure" }), {
      watchlist: ["dune"],
      library: [favourite()],
    });
    expect(next.watchlist).toEqual(["dune"]);
    expect(next.library).toHaveLength(1);
    expect(next.loaded).toBe(true);
    expect(next.error).toBeNull();
  });

  it("tolerates a malformed response rather than throwing on the page", () => {
    // The body is whatever came back over the network; a proxy error page
    // parses to something that is not this shape at all.
    const next = applySaved(emptySaved(), {} as never);
    expect(next).toEqual({ watchlist: [], library: [], loaded: true, error: null });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/web/static/savedModel.test.ts
```

Expected: FAIL — cannot resolve `./savedModel`.

- [ ] **Step 3: Write the implementation**

Create `src/web/static/savedModel.ts`:

```ts
// The saved pane's decisions: which request each button sends, what each list
// says when it is empty or broken, and how one row is labelled.
//
// Separate from app.ts for the reason every model in this directory is — there
// is no jsdom here, so anything with a decision in it has to be reachable
// without a DOM.
//
// Bundled for the browser: no node:* imports, direct or transitive.
import { formatBytes } from "./dashboard";
import type { LibraryRequest, PublicFavourite, SavedResponse, WatchlistRequest } from "../wire";

export type { PublicFavourite, SavedResponse } from "../wire";

/** Everything the pane renders from. */
export interface SavedState {
  /** Saved search queries, most-recent first. The TUI's `watchlist`. */
  watchlist: string[];
  /** Favourited torrents, most-recent first. The TUI's `library`. */
  library: PublicFavourite[];
  /**
   * Whether a response has ever arrived.
   *
   * NOT derivable from the two lists being empty, and conflating them is the
   * bug this field exists to prevent: "you have not saved anything" and "this
   * has not loaded yet" are different sentences, and showing the first while
   * the request is still in flight tells the user their library is gone.
   */
  loaded: boolean;
  /** Why the last request failed, or null. Shown over both lists. */
  error: string | null;
}

export function emptySaved(): SavedState {
  return { watchlist: [], library: [], loaded: false, error: null };
}

/** The `POST /api/watchlist` body. Trimmed here so the box's stray spaces cannot create a second entry. */
export function watchlistBody(query: string, action: "toggle" | "remove"): WatchlistRequest {
  return { query: query.trim(), action };
}

/** What a caller must know about a torrent to favourite it. A search result satisfies this. */
export interface LibraryInput {
  infoHash: string;
  name: string;
  sizeBytes?: number;
  source?: string;
}

/**
 * The `POST /api/library` body.
 *
 * `name` IS NOT DECORATION. The server builds the stored magnet with
 * `buildMagnet(infoHash, name)` because a search result carries none, so this
 * string becomes the magnet's `dn` and the library row's label. Send the hash
 * without it and the favourite is 40 hex characters.
 *
 * `sizeBytes: 0` is omitted rather than sent: the server treats any positive
 * value as "size known", and a zero would be a claim of a zero-byte torrent.
 */
export function libraryBody(
  input: LibraryInput,
  action: "toggle" | "remove" | "watched",
  filename?: string,
): LibraryRequest {
  const body: LibraryRequest = { infoHash: input.infoHash, name: input.name, action };
  if (input.sizeBytes !== undefined && input.sizeBytes > 0) body.sizeBytes = input.sizeBytes;
  if (input.source) body.source = input.source;
  // Only where it means something. Sending it on a toggle would imply the
  // server might act on it there.
  if (action === "watched" && filename) body.filename = filename;
  return body;
}

export function isInLibrary(state: SavedState, infoHash: string): boolean {
  return state.library.some((f) => f.id === infoHash);
}

/**
 * The ★ button's label.
 *
 * Named for what the click WILL DO, not for the current state. A button reading
 * "favourited" invites a click that un-favourites — the opposite of what it
 * appears to promise.
 */
export function favouriteLabel(inLibrary: boolean): string {
  return inLibrary ? "unfavourite" : "favourite";
}

/**
 * One library row's meta line: progress, then size.
 *
 * Zero watched says nothing rather than "0 watched" — a favourite you have not
 * started is not a progress report. An unknown size says so rather than
 * printing "0 B", the same call `resultMeta` makes for a swarm it cannot see.
 */
export function favouriteMeta(f: PublicFavourite): string {
  const parts: string[] = [];
  if (f.watched > 0) parts.push(`${f.watched} watched`);
  parts.push(f.sizeBytes !== undefined && f.sizeBytes > 0 ? formatBytes(f.sizeBytes) : "size unknown");
  return parts.join(" · ");
}

/** A status line for one of the two lists, and whether it is bad news. */
export interface SavedStatus {
  text: string;
  show: boolean;
  tone: "dim" | "error";
}

// An error outranks everything, INCLUDING having rows: a stale list next to no
// explanation is worse than a stale list with one, because the user cannot tell
// that these rows may no longer match the server.
function statusFor(state: SavedState, count: number, empty: string): SavedStatus {
  if (state.error !== null) return { text: state.error, show: true, tone: "error" };
  if (!state.loaded) return { text: "Loading…", show: true, tone: "dim" };
  // Once there are rows, the rows are the content; a count would be redundant
  // with what the user is already looking at.
  return { text: empty, show: count === 0, tone: "dim" };
}

export function watchlistStatus(state: SavedState): SavedStatus {
  return statusFor(state, state.watchlist.length, "Save a search to keep it here.");
}

export function libraryStatus(state: SavedState): SavedStatus {
  return statusFor(state, state.library.length, "Favourite a result to keep it here.");
}

/**
 * Fold a `GET /api/saved` response into the state.
 *
 * Defensive about both arrays because the body is whatever came back over the
 * network — a proxy's HTML error page parses to something that is not this
 * shape at all, and a `.map` over `undefined` here would take the pane down
 * rather than show its error line.
 */
export function applySaved(state: SavedState, response: SavedResponse): SavedState {
  return {
    ...state,
    watchlist: Array.isArray(response.watchlist) ? response.watchlist : [],
    library: Array.isArray(response.library) ? response.library : [],
    loaded: true,
    error: null,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run src/web/static/savedModel.test.ts
```

Expected: PASS. If `favouriteMeta` fails on the size, check `formatBytes(24_000_000_000)` in `dashboard.ts` — adjust the expected string in the test to whatever it actually produces (it is base-1024, so `"22.4 GB"`), and do not add a second byte formatter.

- [ ] **Step 5: Commit**

```bash
git add src/web/static/savedModel.ts src/web/static/savedModel.test.ts
git commit -m "feat(web): savedModel — the saved pane's request bodies and copy

loaded is a separate field from the lists being empty on purpose: 'you
have saved nothing' and 'this has not arrived yet' are different
sentences, and showing the first mid-request tells the user their library
is gone.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: The saved pane — markup, styles and wiring

**Files:**
- Modify: `src/web/static/index.html` (the nav comment and nav block at lines 13-23; a new `<section id="pane-saved">` after `pane-recc`)
- Modify: `src/web/static/styles.css` (append a saved-pane section)
- Modify: `src/web/static/app.ts` (element handles, `ViewName`, `showView`, a saved controller, render functions)
- Test: manual, via `npm run dev` — this task is DOM wiring, which is exactly what has no test harness here. All its decisions were tested in Task 6.

**Interfaces:**
- Consumes: everything Task 6 produces; `GET /api/saved` and both POST routes (Tasks 2-5).
- Produces, inside `app.ts` (used by Task 8):
  - `let savedState: SavedState`
  - `async function loadSaved(): Promise<void>`
  - `async function toggleWatchlist(query: string): Promise<void>`
  - `async function toggleLibrary(input: LibraryInput): Promise<void>`
  - `function renderSaved(): void`

- [ ] **Step 1: Update the nav markup and its comment**

The comment at `src/web/static/index.html:13-16` currently reads "Search / For You / Queue, the three things this app is". This change falsifies the count, so replace the comment and the nav together:

```html
      <!-- Search / For You / Saved / Queue. Buttons rather than links or a
           router: it is one page with four panes, and a URL that could be
           bookmarked mid-search would promise a restored search it cannot
           deliver (the stream is not replayable).

           Saved holds both of the TUI's lists — the watchlist (saved search
           queries) and the library (favourited torrents) — in one pane rather
           than two tabs. Five tabs across the top of a phone is where this nav
           stops working. -->
      <nav id="views" class="views" hidden>
        <button id="view-search" type="button" class="view-tab" aria-pressed="true">search</button>
        <button id="view-recc" type="button" class="view-tab" aria-pressed="false">for you</button>
        <button id="view-saved" type="button" class="view-tab" aria-pressed="false">saved</button>
        <button id="view-queue" type="button" class="view-tab" aria-pressed="false">
          queue<span id="queue-count" class="badge" hidden></span>
        </button>
      </nav>
```

- [ ] **Step 2: Add the pane markup**

Insert after the closing `</section>` of `pane-recc` and before the queue's comment banner:

```html
      <!-- ---- saved ------------------------------------------------------- -->
      <!-- Both lists the TUI has: the watchlist (config.savedSearches) and the
           library (config.favourites). Every row is built by app.ts with
           createElement — a favourite's name is a release name written by
           whoever uploaded the torrent, the same stranger's string a search row
           carries. -->
      <section id="pane-saved" hidden>
        <div class="saved-split">
          <div class="saved-list">
            <h2 class="saved-heading">watchlist</h2>
            <p id="watchlist-status" class="empty">Loading…</p>
            <ul id="watchlist-rows" class="rows"></ul>
          </div>
          <div class="saved-list">
            <h2 class="saved-heading">library</h2>
            <p id="library-status" class="empty">Loading…</p>
            <ul id="library-rows" class="rows"></ul>
          </div>
        </div>
      </section>
```

- [ ] **Step 3: Add the styles**

Append to `src/web/static/styles.css`:

```css
/* ---------------------------------------------------------------------------
   The saved pane. Two lists side by side on a wide screen and stacked on a
   phone, using .rows and .row from the search pane rather than a third row
   style — a saved search and a favourite are both list rows, and the only thing
   new here is the pair of headings. */
.saved-split {
  display: grid;
  /* minmax(0, …) for the reason .rows uses it: a long release name must
     ellipsis rather than widen its track past the viewport. */
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 1rem;
  align-items: start;
}

/* The same breakpoint the search pane's .split uses, so the page reflows in one
   step rather than two. */
@media (max-width: 60rem) {
  .saved-split {
    grid-template-columns: minmax(0, 1fr);
  }
}

.saved-heading {
  margin: 0 0 0.5rem;
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--dim);
}

/* A watchlist row is a button spanning the row: the whole thing re-runs that
   search, so a small hit target inside a wide row would be a phone-hostile
   near-miss. */
.saved-query {
  border: 0;
  background: none;
  padding: 0;
  margin: 0;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  overflow-wrap: anywhere;
}

.saved-query:hover {
  color: var(--accent);
}
```

Verify `--accent`, `--dim`, `--line` and `--sunken` are the real variable names in this file before using them; match whatever is already there.

- [ ] **Step 4: Wire it up in app.ts**

Add to the imports:

```ts
import {
  applySaved,
  emptySaved,
  favouriteLabel,
  favouriteMeta,
  isInLibrary,
  libraryBody,
  libraryStatus,
  watchlistBody,
  watchlistStatus,
  type LibraryInput,
  type PublicFavourite,
  type SavedResponse,
  type SavedState,
} from "./savedModel";
```

Add element handles beside the existing ones:

```ts
const viewSavedTab = el<HTMLButtonElement>("view-saved");
const paneSaved = el<HTMLElement>("pane-saved");
const watchlistStatusLine = el<HTMLParagraphElement>("watchlist-status");
const watchlistRows = el<HTMLUListElement>("watchlist-rows");
const libraryStatusLine = el<HTMLParagraphElement>("library-status");
const libraryRows = el<HTMLUListElement>("library-rows");
```

Widen the view union and the pane switch:

```ts
type ViewName = "search" | "recc" | "saved" | "queue";
```

In `showView`, add the pane and the tab, and the lazy first load:

```ts
  paneSaved.hidden = next !== "saved";
  viewSavedTab.setAttribute("aria-pressed", String(next === "saved"));
  if (next === "recc") recc.open();
  // Refetched on every visit, not once: a favourite added from a search row
  // while this pane sat hidden must be here when the user opens it, and the
  // response is two small arrays.
  if (next === "saved") void loadSaved();
```

Register the tab listener next to the others:

```ts
viewSavedTab.addEventListener("click", () => showView("saved"));
```

Add the section itself, placed after the For You section and before `// ---- connection ---`:

```ts
// ---- saved ----------------------------------------------------------------
// The watchlist and the library. Decisions — which body each button sends, what
// an empty or broken list says — are savedModel.ts's; what is here is fetch and
// DOM.

let savedState: SavedState = emptySaved();

async function loadSaved(): Promise<void> {
  try {
    const res = await fetch("/api/saved", { headers: authHeaders() });
    if (!res.ok) {
      savedState = { ...savedState, loaded: true, error: `Couldn't load your lists (HTTP ${res.status}).` };
      renderSaved();
      return;
    }
    savedState = applySaved(savedState, (await res.json()) as SavedResponse);
  } catch {
    savedState = { ...savedState, loaded: true, error: "Couldn't load your lists — the server is not responding." };
  }
  renderSaved();
}

// Both mutators post, then render the list the SERVER returned rather than a
// list predicted here. The optimistic half is the button's own label, which
// flips before the round trip and is corrected by the response — so a failed
// toggle cannot leave a ★ claiming something the server never stored.
async function postSaved(path: string, body: unknown): Promise<Record<string, unknown> | null> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    showNotice("That didn't reach the server.");
    setConn("lost");
    return null;
  }
  if (!res.ok) {
    const envelope = await readEnvelope(res);
    showNotice(envelope.error ?? `That didn't stick (HTTP ${res.status}).`);
    return null;
  }
  return readJson(res);
}

async function toggleWatchlist(query: string): Promise<void> {
  const body = await postSaved("/api/watchlist", watchlistBody(query, "toggle"));
  if (!body) return;
  savedState = {
    ...savedState,
    watchlist: Array.isArray(body.watchlist) ? (body.watchlist as string[]) : savedState.watchlist,
    loaded: true,
    error: null,
  };
  showNotice(body.saved === true ? "Saved to your watchlist." : "Removed from your watchlist.");
  renderSaved();
}

async function removeFromWatchlist(query: string): Promise<void> {
  const body = await postSaved("/api/watchlist", watchlistBody(query, "remove"));
  if (!body) return;
  savedState = {
    ...savedState,
    watchlist: Array.isArray(body.watchlist) ? (body.watchlist as string[]) : savedState.watchlist,
    loaded: true,
    error: null,
  };
  renderSaved();
}

async function toggleLibrary(input: LibraryInput): Promise<void> {
  const body = await postSaved("/api/library", libraryBody(input, "toggle"));
  if (!body) return;
  savedState = {
    ...savedState,
    library: Array.isArray(body.library) ? (body.library as PublicFavourite[]) : savedState.library,
    loaded: true,
    error: null,
  };
  showNotice(body.favourited === true ? "Added to your library." : "Removed from your library.");
  renderSaved();
  // The ★ on the matching search row has to agree with what just happened.
  renderResults();
}

async function removeFromLibrary(infoHash: string, name: string): Promise<void> {
  const body = await postSaved("/api/library", libraryBody({ infoHash, name }, "remove"));
  if (!body) return;
  savedState = {
    ...savedState,
    library: Array.isArray(body.library) ? (body.library as PublicFavourite[]) : savedState.library,
    loaded: true,
    error: null,
  };
  renderSaved();
  renderResults();
}

// createElement + textContent, as everywhere else on this page. A saved query is
// the user's own typing, but a favourite's name is a release name from whoever
// uploaded the torrent — so this list is as much an XSS surface as the results
// list is.
function renderWatchlistRow(query: string): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "row";

  const run = document.createElement("button");
  run.type = "button";
  run.className = "saved-query";
  run.textContent = query;
  run.title = `Search for ${query}`;
  run.addEventListener("click", () => {
    queryInput.value = query;
    showView("search");
    startSearch(query);
  });

  const actions = document.createElement("div");
  actions.className = "row-actions";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.textContent = "remove";
  remove.addEventListener("click", () => void removeFromWatchlist(query));
  actions.append(remove);

  li.append(run, actions);
  return li;
}

function renderLibraryRow(f: PublicFavourite): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "row";

  const head = document.createElement("div");
  head.className = "result-head";
  const name = document.createElement("span");
  name.className = "row-name";
  name.textContent = f.name;
  name.title = f.name;
  head.append(name);

  const meta = document.createElement("span");
  meta.className = "row-meta";
  meta.textContent = favouriteMeta(f);

  const actions = document.createElement("div");
  actions.className = "row-actions";

  // Play, through the same runPlay every other Play on this page uses. A
  // favourite has no magnet on the wire and does not need one: POST /api/stream
  // rebuilds it from the hash, exactly as it does for a search hit.
  const playButton = document.createElement("button");
  playButton.type = "button";
  playButton.className = "play";
  playButton.textContent = "play";
  playButton.addEventListener("click", () =>
    void play({
      id: f.id,
      name: f.name,
      kind: "download",
      status: "queued",
      percent: 0,
      peers: 0,
      rate: 0,
      uploaded: 0,
    }),
  );
  actions.append(playButton);

  const remove = document.createElement("button");
  remove.type = "button";
  remove.textContent = "remove";
  remove.addEventListener("click", () => void removeFromLibrary(f.id, f.name));
  actions.append(remove);

  li.append(head, meta, actions);
  return li;
}

function renderSaved(): void {
  watchlistRows.replaceChildren(...savedState.watchlist.map(renderWatchlistRow));
  libraryRows.replaceChildren(...savedState.library.map(renderLibraryRow));

  const wl = watchlistStatus(savedState);
  watchlistStatusLine.textContent = wl.text;
  watchlistStatusLine.classList.toggle("error", wl.tone === "error");
  watchlistStatusLine.hidden = !wl.show;

  const lib = libraryStatus(savedState);
  libraryStatusLine.textContent = lib.text;
  libraryStatusLine.classList.toggle("error", lib.tone === "error");
  libraryStatusLine.hidden = !lib.show;
}
```

In `showUnreachable`, hide the new pane alongside the others — `showView("queue")` already does this, so no change is needed there; verify by reading it.

In `openApp`, add `renderSaved();` after `renderResults();` so the pane is not blank if the user's first click lands on it before the fetch returns.

- [ ] **Step 5: Verify it builds and the suite still passes**

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

Expected: all PASS. The build matters here: `tsup --config tsup.web.config.ts` with `platform: "browser"` is what would catch a stray `node:*` import reaching the bundle through `savedModel.ts`.

- [ ] **Step 6: Verify by hand in a browser**

```bash
npm run dev -- serve --web
```

Check, in order:
1. A `saved` tab appears between `for you` and `queue`.
2. Opening it shows two headings with "Save a search to keep it here." and "Favourite a result to keep it here." — **not** "Loading…" stuck on screen.
3. Search something, click the `saved` tab, come back — no errors in the console.

- [ ] **Step 7: Commit**

```bash
git add src/web/static/index.html src/web/static/styles.css src/web/static/app.ts
git commit -m "feat(web): a saved pane holding the watchlist and the library

Both of the TUI's lists in one pane rather than two tabs: five tabs across
the top of a phone is where this nav stops working. The nav comment
claiming three panes is updated in the same change.

Library rows play through POST /api/stream { infoHash, name }, which is
why the wire type never needed to carry a magnet.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Favourite from a search row, save a search from the box

**Files:**
- Modify: `src/web/static/index.html` (a button in the search form)
- Modify: `src/web/static/app.ts` (`renderResult`, a new listener, `openApp`)
- Test: manual — this is wiring; the labelling and body-building were tested in Task 6.

**Interfaces:**
- Consumes: `toggleLibrary`, `toggleWatchlist`, `savedState`, `isInLibrary`, `favouriteLabel` (Tasks 6-7); `PublicSearchResult`.
- Produces: no new exports.

- [ ] **Step 1: Add the save-search button to the markup**

In `src/web/static/index.html`, inside `<form id="search">`, after the Search button:

```html
          <button id="save-search" type="button">save search</button>
```

- [ ] **Step 2: Wire the save-search button**

In `app.ts`, add the handle:

```ts
const saveSearchButton = el<HTMLButtonElement>("save-search");
```

and the listener, next to the search form's submit handler:

```ts
// Saves whatever is in the box, submitted or not: the thing worth keeping is
// the query you just typed, and requiring a search first would mean running one
// to save one.
saveSearchButton.addEventListener("click", () => {
  const query = queryInput.value.trim();
  if (!query) {
    showNotice("Type a search to save it.");
    return;
  }
  void toggleWatchlist(query);
});
```

- [ ] **Step 3: Add the favourite button to each result row**

In `renderResult`, after the `add` button and before the `debridConfigured` block:

```ts
  // The library toggle. Labelled by what the click will do, and rebuilt from
  // savedState on every render — the results list is re-rendered on every
  // snapshot frame, so a hardcoded label here would go stale within a second of
  // being clicked.
  const inLibrary = isInLibrary(savedState, result.infoHash);
  const favButton = document.createElement("button");
  favButton.type = "button";
  favButton.textContent = favouriteLabel(inLibrary);
  favButton.setAttribute("aria-pressed", String(inLibrary));
  favButton.addEventListener("click", () => {
    const input: LibraryInput = { infoHash: result.infoHash, name: result.name };
    if (result.sizeBytes > 0) input.sizeBytes = result.sizeBytes;
    if (result.source) input.source = result.source;
    void toggleLibrary(input);
  });
  actions.append(favButton);
```

- [ ] **Step 4: Load the lists at startup so the labels are right on the first render**

The ★ on a search row needs `savedState` populated before any results arrive, or every row opens labelled "favourite" including ones already in the library. In `openApp`, next to the existing `void loadSources();`:

```ts
  // Ahead of any search, because renderResult labels its favourite button from
  // savedState: without this, a hit already in the library opens reading
  // "favourite" and the first click removes it.
  void loadSaved();
```

- [ ] **Step 5: Record watched episodes when the picker hands a file to the player**

`showPicker` is called by `runPlay` through the `choose` callback and receives `(sessionId, capability, name, files)` — no info hash. Rather than widen that callback's contract (it lives in `streamFlow.ts` and is shared with the queue's Play), track the hash alongside the session the picker already tracks.

**5a.** Beside the existing `let pickerSession: string | null = null;`, add:

```ts
// The info hash the open picker belongs to, so a chosen file can be recorded as
// watched against a favourite. Tracked beside pickerSession, set when a play
// starts and cleared with the picker, for the same reason pickerSession is: the
// picker outlives the call that opened it.
let pickerHash: string | null = null;
```

**5b.** In `hidePicker()`, clear it next to `pickerSession = null;`:

```ts
  pickerHash = null;
```

**5c.** In `play(row)`, set it before `runPlay`:

```ts
  pickerHash = row.id;
```

**5d.** In `showPicker`'s per-file click handler, replace the existing two lines with:

```ts
      button.addEventListener("click", () => {
        // Read BEFORE hidePicker(), which clears it.
        const infoHash = pickerHash;
        // hidePicker() clears pickerSession, so the Cancel handler can no longer
        // stop the session we are about to hand to the player.
        hidePicker();
        // Fire-and-forget, and only once a file was actually chosen. The server
        // no-ops when this torrent is not favourited, so there is nothing to
        // check here and nothing to wait for — the same shape as the TUI's
        // markPlayed, which also records only after a player launches.
        if (infoHash) {
          void postSaved(
            "/api/library",
            libraryBody({ infoHash, name }, "watched", file.filename),
          );
        }
        openPlayer(playerPath(sessionId, file, capability));
      });
```

- [ ] **Step 6: Verify the build and suite**

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

Expected: all PASS.

- [ ] **Step 7: Verify by hand**

```bash
npm run dev -- serve --web
```

1. Search for something. Each row shows a `favourite` button.
2. Click it — the notice says "Added to your library.", the button becomes `unfavourite`.
3. Open `saved` — the row is in the library with its size.
4. Reload the page, search the same thing — the row opens labelled `unfavourite`. **This is the assertion that proves the magnet round-tripped through `loadConfig`**: if `isFavouriteItem` had rejected the stored entry, the library would be empty here.
5. Type a query, click `save search`, open `saved` — it is in the watchlist. Click it — it re-runs the search.
6. Play a favourited multi-file torrent, pick a file — reopen `saved` and the library row reads "1 watched".

- [ ] **Step 8: Commit**

```bash
git add src/web/static/index.html src/web/static/app.ts
git commit -m "feat(web): favourite a search hit, save the query in the box

The favourite button is labelled from savedState on every render because
the results list is rebuilt on every snapshot frame — a hardcoded label
goes stale within a second of being clicked. savedState loads at startup
so a hit already in the library never opens reading 'favourite'.

Choosing a file from the picker records it as watched, mirroring the TUI's
markPlayed: only after a player actually launches.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: A category tab loads immediately

**Files:**
- Modify: `src/web/static/searchModel.ts` (new exported function)
- Modify: `src/web/static/app.ts` (`renderTabs`'s click handler, ~lines 595-606)
- Test: `src/web/static/searchModel.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `SearchView`, `emptyView` from `searchModel.ts`.
- Produces: `groupChangePlan(view: SearchView, group: string): "ignore" | "run"`.

- [ ] **Step 1: Write the failing test**

Append to `src/web/static/searchModel.test.ts` (add `groupChangePlan` to its import from `./searchModel`):

```ts
describe("groupChangePlan", () => {
  it("runs a browse when nothing has been submitted yet — THE BUG", () => {
    // Opening the page and clicking "Movies" used to render nothing: the old
    // code called renderResults() while idle, which re-renders an empty list.
    // Clicking a category IS a request to see that category.
    expect(groupChangePlan(emptyView(), "Movies")).toBe("run");
  });

  it("re-runs a search when one is already on screen", () => {
    // Not a filter over what is here: the server searches only the selected
    // group's sources, so the other tabs' hits were never fetched.
    const view: SearchView = { ...emptyView(), query: "dune", mode: "search", group: "All" };
    expect(groupChangePlan(view, "Movies")).toBe("run");
  });

  it("re-runs a browse, whose query is empty but still needs running", () => {
    const view: SearchView = { ...emptyView(), query: "", mode: "browse", group: "All" };
    expect(groupChangePlan(view, "TV")).toBe("run");
  });

  it("ignores a click on the tab that is already selected", () => {
    // Otherwise every stray tap on the current tab restarts a 23-source fan-out.
    const view: SearchView = { ...emptyView(), mode: "search", query: "dune", group: "Movies" };
    expect(groupChangePlan(view, "Movies")).toBe("ignore");
    expect(groupChangePlan(emptyView(), "All")).toBe("ignore");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/web/static/searchModel.test.ts -t "groupChangePlan"
```

Expected: FAIL — `groupChangePlan` is not exported.

- [ ] **Step 3: Add the function**

Append to `src/web/static/searchModel.ts`:

```ts
/**
 * What clicking a category tab should do.
 *
 * `"run"` for every real change, INCLUDING from `mode: "idle"` — which is the
 * bug this replaced. The old branch called `renderResults()` while idle, so
 * opening the page and clicking "Movies" re-rendered an empty list and waited
 * for the search box to be submitted. Clicking a category is a request to see
 * that category; a blank query then means browse, which is exactly what the
 * server does with one.
 *
 * A re-run rather than a filter over what is on screen, because the server
 * searches only the selected group's sources — the other tabs' hits were never
 * fetched. Same as the TUI, where each tab is its own slice of one fan-out.
 *
 * `"ignore"` for the tab already selected, so a stray tap on the current tab
 * does not restart a 23-source fan-out.
 */
export function groupChangePlan(view: SearchView, group: string): "ignore" | "run" {
  return view.group === group ? "ignore" : "run";
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run src/web/static/searchModel.test.ts -t "groupChangePlan"
```

Expected: PASS, all four cases.

- [ ] **Step 5: Rewire the click handler**

Add `groupChangePlan` to app.ts's import from `./searchModel`. Replace the body of the tab click listener in `renderTabs` (currently `src/web/static/app.ts:595-606`) with:

```ts
      button.addEventListener("click", () => {
        if (groupChangePlan(searchView, group) === "ignore") return;
        searchView = { ...searchView, group };
        renderTabs();
        // queryInput.value, NOT "". startSearch assigns its trimmed query back
        // into the box, so passing the empty string here would wipe text the
        // user had typed but not yet submitted. Passing the box browses when it
        // is blank and searches when it is not — and the blank case is the one
        // manual testing misses, because the box is empty when you click a tab
        // to check this works.
        startSearch(queryInput.value);
      });
```

- [ ] **Step 6: Verify**

```bash
npm run typecheck
npm run lint
npm test
```

Then by hand:

```bash
npm run dev -- serve --web
```

1. Load the page, touch nothing, click `Movies`. Results load immediately. **This is the bug fixed.**
2. Type `dune` without pressing Enter, then click `TV`. The box still says `dune` and it searched for it — it did not browse and did not clear the box.
3. Click `TV` again. Nothing re-runs (watch the `n/m sources` progress text stay put).

- [ ] **Step 7: Commit**

```bash
git add src/web/static/searchModel.ts src/web/static/searchModel.test.ts src/web/static/app.ts
git commit -m "fix(web): a category tab loads its results immediately

The old handler called renderResults() while idle, so opening the page and
clicking Movies re-rendered an empty list until the search box was
submitted. Clicking a category is a request to see it.

Passes queryInput.value rather than \"\": startSearch assigns its query
back into the box, so the empty string would wipe text typed but not
submitted.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: `omdbConfigured` on `GET /api/sources`

Without this, a keyless server has every visible row fire a `/api/title` lookup purely to be told `{status: "no-key"}`. This flag is what "degrade gracefully" actually costs.

**Files:**
- Modify: `src/web/wire.ts` (`SourcesResponse`)
- Modify: `src/web/routes.ts` (`sourcesResponse`, ~line 597-630)
- Test: `src/web/routes.test.ts`

**Interfaces:**
- Consumes: `resolveOmdbApiKey` from `src/config/config`.
- Produces: `SourcesResponse.omdbConfigured: boolean`.

- [ ] **Step 1: Write the failing test**

Append to `src/web/routes.test.ts`:

```ts
describe("sourcesResponse — omdbConfigured", () => {
  beforeEach(() => {
    // resolveOmdbApiKey reads TORLINK_OMDB_KEY, which a developer may well have
    // exported — without this the false case passes or fails by accident.
    vi.stubEnv("TORLINK_OMDB_KEY", "");
  });

  const ask = (config: Partial<Config>) =>
    handleWebApi(
      deps({ loadConfigImpl: async () => ({ ...defaultConfig, downloadDir: "/tmp/dl", ...config }) }),
      "GET",
      "/api/sources",
      new URLSearchParams(),
      undefined,
      "",
    );

  it("is false with no key, so the browser fetches no posters at all", async () => {
    const res = await ask({});
    expect((res.json as SourcesResponse).omdbConfigured).toBe(false);
  });

  it("is true from the config file", async () => {
    const res = await ask({ omdbApiKey: "abc123" });
    expect((res.json as SourcesResponse).omdbConfigured).toBe(true);
  });

  it("is true from TORLINK_OMDB_KEY, so the browser agrees with the TUI", async () => {
    vi.stubEnv("TORLINK_OMDB_KEY", "from-env");
    const res = await ask({});
    expect((res.json as SourcesResponse).omdbConfigured).toBe(true);
  });

  it("never puts the key itself on the wire", async () => {
    const res = await ask({ omdbApiKey: "super-secret-key" });
    expect(JSON.stringify(res.json)).not.toContain("super-secret-key");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/web/routes.test.ts -t "omdbConfigured"
```

Expected: FAIL — the property does not exist on `SourcesResponse`.

- [ ] **Step 3: Add the field to the wire type**

In `src/web/wire.ts`, inside `SourcesResponse`, after `debridConfigured`:

```ts
  /**
   * Whether an OMDb API key is configured (file or `TORLINK_OMDB_KEY`).
   *
   * A capability flag, never the key — the same contract as
   * `debridConfigured` above, and here for the same reason: this response is
   * the one thing the search UI fetches before it can render anything.
   *
   * WHAT IT SAVES. Without it, a keyless server has every visible result row
   * fire a `/api/title` lookup purely to be told `{status: "no-key"}` — one
   * round trip per row to learn a fact that is true for the whole page. With
   * it the browser fetches no artwork at all and shows the one setup hint.
   * That difference IS the graceful degradation.
   */
  omdbConfigured: boolean;
```

- [ ] **Step 4: Populate it**

Add `resolveOmdbApiKey` to routes.ts's `from "../config/config"` import. In `sourcesResponse`, after `debridConfigured`:

```ts
    // resolveOmdbApiKey, not config.omdbApiKey, so TORLINK_OMDB_KEY counts —
    // the browser must agree with the TUI about whether artwork is available,
    // and the TUI resolves it the same way.
    omdbConfigured: resolveOmdbApiKey(config) !== "",
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
npx vitest run src/web/routes.test.ts -t "omdbConfigured"
npm test
```

Expected: PASS. Other `sourcesResponse` tests may assert on the whole object with `toEqual`; add `omdbConfigured: false` to those expectations.

- [ ] **Step 6: Commit**

```bash
git add src/web/wire.ts src/web/routes.ts src/web/routes.test.ts
git commit -m "feat(web): report omdbConfigured on GET /api/sources

A capability flag, never the key. Without it a keyless server has every
visible row fire a /api/title lookup purely to be told no-key — one round
trip per row for a fact that is true for the whole page.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 11: `resultPosters.ts` — the poster cache

The hazard this module exists for: **the results list is rebuilt on every snapshot frame, and up to 23 of those arrive during one search** (`app.ts:559-562`). Mounting posters naively per render means 23× the fetches and a leaked blob on each one.

**Files:**
- Create: `src/web/static/resultPosters.ts`
- Test: `src/web/static/resultPosters.test.ts`

**Interfaces:**
- Consumes: `posterPath`, `NO_KEY_POSTER_NOTE`, `NO_POSTER_NOTE`, `OMDB_KEY_HINT` from `./previewModel`; `ALL_TAB`, `previewApplies` from `./searchModel`; `PublicTitleMeta` from `../wire`.
- Produces:
  - `type PosterOutcome = { kind: "poster"; url: string } | { kind: "no-key" } | { kind: "none" }`
  - `interface PosterDeps { fetchMeta(release: string, group: string): Promise<PublicTitleMeta | null>; fetchBlob(posterUrl: string): Promise<string | null>; revoke(url: string): void }`
  - `createPosterCache(deps: PosterDeps): PosterCache`
  - `interface PosterCache { want(release: string, group: string): PosterOutcome | Promise<PosterOutcome>; peek(release: string): PosterOutcome | undefined; clear(): void; hint(): string | null; note(outcome: PosterOutcome): string }`
  - `postersApply(group: string, omdbConfigured: boolean): boolean`

- [ ] **Step 1: Write the failing test**

Create `src/web/static/resultPosters.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createPosterCache, postersApply, type PosterDeps } from "./resultPosters";
import { NO_KEY_POSTER_NOTE, NO_POSTER_NOTE, OMDB_KEY_HINT } from "./previewModel";
import type { PublicTitleMeta } from "../wire";

const OK = (posterUrl: string | null): PublicTitleMeta => ({
  status: "ok",
  imdbId: "tt1160419",
  plot: "Sand.",
  posterUrl,
});

function harness(over: Partial<PosterDeps> = {}) {
  const metaCalls: string[] = [];
  const blobCalls: string[] = [];
  const revoked: string[] = [];
  let blobs = 0;
  const deps: PosterDeps = {
    fetchMeta: async (release) => {
      metaCalls.push(release);
      return OK("https://m.media-amazon.com/dune.jpg");
    },
    fetchBlob: async (url) => {
      blobCalls.push(url);
      blobs += 1;
      return `blob:${blobs}`;
    },
    revoke: (url) => revoked.push(url),
    ...over,
  };
  return { cache: createPosterCache(deps), metaCalls, blobCalls, revoked };
}

describe("postersApply", () => {
  it("is true only on the tabs OMDb knows about, and only with a key", () => {
    // previewApplies is the existing predicate for this — All, Movies, TV,
    // Anime. Not a second one: OMDb has nothing useful to say about a Games or
    // Music row.
    expect(postersApply("Movies", true)).toBe(true);
    expect(postersApply("TV", true)).toBe(true);
    expect(postersApply("Anime", true)).toBe(true);
    expect(postersApply("All", true)).toBe(true);
    expect(postersApply("Games", true)).toBe(false);
    expect(postersApply("Music", true)).toBe(false);
  });

  it("is false without a key, whatever the tab", () => {
    expect(postersApply("Movies", false)).toBe(false);
    expect(postersApply("All", false)).toBe(false);
  });
});

describe("createPosterCache", () => {
  it("fetches metadata then bytes, and answers with the object URL", async () => {
    const { cache, metaCalls, blobCalls } = harness();
    const outcome = await cache.want("Dune.Part.Two.2024.2160p.WEB-DL", "Movies");
    expect(outcome).toEqual({ kind: "poster", url: "blob:1" });
    expect(metaCalls).toEqual(["Dune.Part.Two.2024.2160p.WEB-DL"]);
    expect(blobCalls).toEqual(["https://m.media-amazon.com/dune.jpg"]);
  });

  it("answers a settled release from cache with no fetch at all", async () => {
    const { cache, metaCalls } = harness();
    await cache.want("Dune.Part.Two.2024.2160p", "Movies");
    // Synchronous on a hit — this is what makes a 23-frame re-render free.
    const again = cache.want("Dune.Part.Two.2024.2160p", "Movies");
    expect(again).toEqual({ kind: "poster", url: "blob:1" });
    expect(metaCalls).toHaveLength(1);
  });

  it("coalesces concurrent asks for one release into a single lookup", async () => {
    const { cache, metaCalls } = harness();
    // Every snapshot frame re-mounts every row. Without coalescing, one search
    // is 23 lookups per row.
    const all = await Promise.all([
      cache.want("Dune.Part.Two.2024", "Movies"),
      cache.want("Dune.Part.Two.2024", "Movies"),
      cache.want("Dune.Part.Two.2024", "Movies"),
    ]);
    expect(metaCalls).toHaveLength(1);
    expect(all).toEqual([
      { kind: "poster", url: "blob:1" },
      { kind: "poster", url: "blob:1" },
      { kind: "poster", url: "blob:1" },
    ]);
  });

  it("shares ONE blob between different releases of the same film", async () => {
    // Fifty releases of one film parse to one title server-side, so /api/title
    // answers all fifty from its own cache — but each answer names the same
    // posterUrl, and fetching the bytes per release would be fifty blobs of
    // identical JPEG held in memory. Keyed by poster URL, not release name.
    const { cache, blobCalls } = harness();
    const a = await cache.want("Dune.Part.Two.2024.2160p.WEB-DL.x265-GROUP", "Movies");
    const b = await cache.want("Dune.Part.Two.2024.1080p.BluRay.x264-OTHER", "Movies");
    expect(a).toEqual(b);
    expect(blobCalls).toEqual(["https://m.media-amazon.com/dune.jpg"]);
  });

  it("carries no-key out rather than flattening it to 'no poster'", async () => {
    const { cache, blobCalls } = harness({
      fetchMeta: async () => ({ status: "no-key" }),
    });
    const outcome = await cache.want("Dune.Part.Two.2024", "Movies");
    expect(outcome).toEqual({ kind: "no-key" });
    // Nothing to fetch bytes from, and the note must say which fix applies.
    expect(blobCalls).toEqual([]);
    expect(cache.note(outcome as never)).toBe(NO_KEY_POSTER_NOTE);
    expect(cache.hint()).toBe(OMDB_KEY_HINT);
  });

  it("reports 'none' for a title with no artwork, and no hint", async () => {
    const { cache } = harness({ fetchMeta: async () => OK(null) });
    const outcome = await cache.want("Some.Obscure.Thing.2011", "Movies");
    expect(outcome).toEqual({ kind: "none" });
    expect(cache.note(outcome as never)).toBe(NO_POSTER_NOTE);
    // With a key configured, an obscure title having no artwork must not tell
    // the user to add a key they already have.
    expect(cache.hint()).toBeNull();
  });

  it("reports 'none' when the metadata lookup or the bytes fail", async () => {
    const noMeta = harness({ fetchMeta: async () => null });
    expect(await noMeta.cache.want("X.2024", "Movies")).toEqual({ kind: "none" });

    const noBytes = harness({ fetchBlob: async () => null });
    expect(await noBytes.cache.want("X.2024", "Movies")).toEqual({ kind: "none" });

    const errored = harness({ fetchMeta: async () => ({ status: "error", error: "OMDb down" }) });
    expect(await errored.cache.want("X.2024", "Movies")).toEqual({ kind: "none" });
  });

  it("survives a fetch that throws rather than taking the render down", async () => {
    const { cache } = harness({
      fetchMeta: async () => {
        throw new Error("offline");
      },
    });
    expect(await cache.want("X.2024", "Movies")).toEqual({ kind: "none" });
  });

  it("revokes every blob on clear, and forgets the hint with them", async () => {
    const { cache, revoked } = harness();
    await cache.want("Dune.Part.Two.2024", "Movies");
    cache.clear();
    // Each object URL holds its JPEG in memory until revoked; a session of
    // searches would otherwise accumulate every poster it ever loaded.
    expect(revoked).toEqual(["blob:1"]);
    expect(cache.peek("Dune.Part.Two.2024")).toBeUndefined();
  });

  it("forgets a no-key answer on clear, so a reload that finds a key stops nagging", async () => {
    const { cache } = harness({ fetchMeta: async () => ({ status: "no-key" }) });
    await cache.want("X.2024", "Movies");
    expect(cache.hint()).toBe(OMDB_KEY_HINT);
    cache.clear();
    expect(cache.hint()).toBeNull();
  });

  it("drops an answer that lands after a clear, and revokes its blob", async () => {
    let release!: (meta: PublicTitleMeta) => void;
    const { cache, revoked } = harness({
      fetchMeta: () => new Promise<PublicTitleMeta>((resolve) => (release = resolve)),
    });
    const pending = cache.want("Dune.Part.Two.2024", "Movies");
    // A new search starts while the lookup is in flight.
    cache.clear();
    release(OK("https://m.media-amazon.com/dune.jpg"));
    await pending;
    // The blob was created for a row nobody is showing any more; revoked rather
    // than leaked back into an emptied cache, and NOT resurrected into it — a
    // late answer must not re-populate a cache that moved on.
    expect(revoked).toEqual(["blob:1"]);
    expect(cache.peek("Dune.Part.Two.2024")).toBeUndefined();
  });

  it("passes the group through so the server can hint OMDb's type", async () => {
    const groups: string[] = [];
    const { cache } = harness({
      fetchMeta: async (_release, group) => {
        groups.push(group);
        return OK("https://m.media-amazon.com/x.jpg");
      },
    });
    await cache.want("The.Bear.S03", "TV");
    expect(groups).toEqual(["TV"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/web/static/resultPosters.test.ts
```

Expected: FAIL — cannot resolve `./resultPosters`.

- [ ] **Step 3: Write the implementation**

Create `src/web/static/resultPosters.ts`:

```ts
// Poster artwork for search results, and the caching that makes it affordable.
//
// WHY THIS IS A MODULE AND NOT A FEW LINES IN app.ts. The results list is
// rebuilt on EVERY snapshot frame, and up to 23 of those arrive during one
// search (see startSearch's `results` listener). A row that started its own
// lookup on mount would therefore fire 23 lookups and create 23 object URLs,
// leaking 22 of them — so "have I already answered this?" has to live somewhere
// with a memory, and somewhere a test can reach.
//
// The For You feed solved the same problem inline for its ~20 cards. This is
// that solution extracted, with one change: the blob cache is keyed by the
// POSTER URL rather than by the release name, because fifty releases of one film
// name the same artwork and there is no reason to hold fifty copies of it.
//
// Bundled for the browser: no node:* imports, direct or transitive.
import {
  NO_KEY_POSTER_NOTE,
  NO_POSTER_NOTE,
  OMDB_KEY_HINT,
} from "./previewModel";
import { previewApplies } from "./searchModel";
import type { PublicTitleMeta } from "../wire";

/**
 * What a row's poster frame ended up as.
 *
 * `no-key` is carried out rather than flattened into `none` for the reason the
 * feed's own outcome type states: with no OMDb key every row answers the same
 * way, and a reader given twenty bare "No poster" boxes concludes the feature is
 * broken instead of that they are one setting away from artwork.
 */
export type PosterOutcome =
  | { kind: "poster"; url: string }
  | { kind: "no-key" }
  | { kind: "none" };

/** The two round trips and the cleanup, injected so this is testable without a DOM. */
export interface PosterDeps {
  /** `GET /api/title?release=&group=`. Null for any failure. */
  fetchMeta(release: string, group: string): Promise<PublicTitleMeta | null>;
  /** `GET /api/poster?url=` as a blob, returned as an object URL. Null for any failure. */
  fetchBlob(posterUrl: string): Promise<string | null>;
  /** `URL.revokeObjectURL`. */
  revoke(url: string): void;
}

export interface PosterCache {
  /**
   * The outcome for a release: synchronously when it is already known, a promise
   * when it has to be looked up. Concurrent asks for one release share a single
   * lookup.
   */
  want(release: string, group: string): PosterOutcome | Promise<PosterOutcome>;
  /** The settled outcome for a release, or undefined. No fetching. */
  peek(release: string): PosterOutcome | undefined;
  /** Drop everything and revoke every blob. Called when a new search starts. */
  clear(): void;
  /** The page's single "no OMDb key" sentence, or null. */
  hint(): string | null;
  /** What one empty frame should say. */
  note(outcome: PosterOutcome): string;
}

/**
 * Whether to fetch artwork for this tab at all.
 *
 * `previewApplies` is the existing predicate for "does OMDb know about this
 * category" (All, Movies, TV, Anime) and is reused rather than duplicated. The
 * key check is the other half, and it is the one that matters for cost: with no
 * key configured every lookup would return `no-key`, so a keyless server should
 * make none of them.
 */
export function postersApply(group: string, omdbConfigured: boolean): boolean {
  return omdbConfigured && previewApplies(group);
}

export function createPosterCache(deps: PosterDeps): PosterCache {
  // Settled outcomes by release name. The release name is the key here (not the
  // parsed title) because it is what a row has; the server's own cache collapses
  // release names to titles behind /api/title, so fifty releases of one film
  // still cost one OMDb call.
  const settled = new Map<string, PosterOutcome>();
  // Lookups in flight, so 23 re-renders share one.
  const pending = new Map<string, Promise<PosterOutcome>>();
  // Object URLs by POSTER url, so different releases of one film share a blob.
  const blobs = new Map<string, string>();
  // Bumped by clear(). An answer stamped with an older generation belongs to a
  // search that is gone: its blob is revoked and it is NOT written back, or a
  // slow answer would resurrect a cache that has moved on.
  let generation = 0;

  async function lookup(release: string, group: string, forGeneration: number): Promise<PosterOutcome> {
    const meta = await deps.fetchMeta(release, group);
    if (!meta) return { kind: "none" };
    if (meta.status === "no-key") return { kind: "no-key" };
    if (meta.status !== "ok" || !meta.posterUrl) return { kind: "none" };

    const posterUrl = meta.posterUrl;
    const existing = blobs.get(posterUrl);
    // Only valid if it belongs to this generation — clear() emptied the map, so
    // a hit here is necessarily current.
    if (existing !== undefined) return { kind: "poster", url: existing };

    const url = await deps.fetchBlob(posterUrl);
    if (url === null) return { kind: "none" };
    if (forGeneration !== generation) {
      // Created for a search nobody is looking at. Revoke rather than leak, and
      // do not record it.
      deps.revoke(url);
      return { kind: "none" };
    }
    blobs.set(posterUrl, url);
    return { kind: "poster", url };
  }

  return {
    want(release, group) {
      const hit = settled.get(release);
      if (hit !== undefined) return hit;
      const inflight = pending.get(release);
      if (inflight !== undefined) return inflight;

      const forGeneration = generation;
      const promise = lookup(release, group, forGeneration)
        // Every failure path ends at a labelled frame. A throw here would leave
        // the frame saying "Loading" for the life of the page.
        .catch((): PosterOutcome => ({ kind: "none" }))
        .then((outcome) => {
          pending.delete(release);
          // A clear() while this was in flight: drop it. lookup() has already
          // revoked any blob it made.
          if (forGeneration !== generation) return { kind: "none" } as PosterOutcome;
          settled.set(release, outcome);
          return outcome;
        });
      pending.set(release, promise);
      return promise;
    },

    peek(release) {
      return settled.get(release);
    },

    clear() {
      generation += 1;
      for (const url of blobs.values()) deps.revoke(url);
      blobs.clear();
      settled.clear();
      pending.clear();
    },

    hint() {
      // One answer is enough to know, and waiting for all of them would leave
      // the frames unexplained meanwhile. A `none` must never trigger it: with a
      // key configured, an obscure title with no artwork would otherwise tell
      // the user to add a key they already have.
      for (const outcome of settled.values()) {
        if (outcome.kind === "no-key") return OMDB_KEY_HINT;
      }
      return null;
    },

    note(outcome) {
      // The search pane's own wording, from the search pane's own constants: one
      // condition must not be described two ways on two tabs.
      return outcome.kind === "no-key" ? NO_KEY_POSTER_NOTE : NO_POSTER_NOTE;
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run src/web/static/resultPosters.test.ts
```

Expected: PASS, all fourteen cases.

- [ ] **Step 5: Commit**

```bash
git add src/web/static/resultPosters.ts src/web/static/resultPosters.test.ts
git commit -m "feat(web): a poster cache for search results

The results list is rebuilt on every snapshot frame, up to 23 a search, so
a row that fetched on mount would fire 23 lookups and leak 22 object URLs.
Settled outcomes and in-flight lookups are keyed by release name; blobs
are keyed by POSTER URL, so fifty releases of one film share one image.

A generation counter drops answers that land after a new search starts,
revoking their blobs instead of resurrecting an emptied cache.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 12: Thumbnails in the result rows

**Files:**
- Modify: `src/web/static/app.ts` (a poster cache instance, `renderResult`, `startSearch`, a hint line)
- Modify: `src/web/static/index.html` (a hint paragraph in the search pane)
- Modify: `src/web/static/styles.css` (append)
- Test: manual — wiring only; every decision was tested in Task 11.

**Interfaces:**
- Consumes: `createPosterCache`, `postersApply`, `PosterOutcome` (Task 11); `sources.omdbConfigured` (Task 10); `posterPath` (already imported in app.ts).
- Produces, inside `app.ts` (used by Task 13): `const resultPosters: PosterCache`, `function mountResultPoster(release: string, host: HTMLElement): void`, `function paintSearchHint(): void`.

- [ ] **Step 1: Add the hint paragraph to the markup**

In `src/web/static/index.html`, inside `<section id="pane-search">`, directly after `<p id="search-status" …>`:

```html
        <!-- The one "no OMDb key" sentence, shown once for the page rather than
             once per row — the same rule the For You feed follows with
             #recc-hint, and from the same constant. -->
        <p id="search-hint" class="empty" hidden></p>
```

- [ ] **Step 2: Add the styles**

Append to `src/web/static/styles.css`:

```css
/* A result row's thumbnail. The row keeps its head/meta/actions layout and
   gains a fixed-width poster column, so a row with no artwork is the row this
   page has always had rather than a hole where an image should be. */
.result-with-poster {
  display: grid;
  grid-template-columns: 3.5rem minmax(0, 1fr);
  gap: 0.6rem;
  align-items: start;
}

/* Overrides .poster's centring and cap: in a row the frame IS its column. */
.result-thumb {
  max-width: none;
  margin-inline: 0;
  margin-bottom: 0;
}

/* At 3.5rem there is no room for "NO OMDB KEY" — the row's own hint line says
   it once for the page, so the frame stays an empty box. */
.result-thumb .poster-note {
  font-size: 0.55rem;
  padding: 0.2rem;
}
```

- [ ] **Step 3: Wire the cache and the thumbnails**

Add to app.ts's imports:

```ts
import {
  createPosterCache,
  postersApply,
  type PosterOutcome,
} from "./resultPosters";
```

and the handles:

```ts
const searchHintLine = el<HTMLParagraphElement>("search-hint");
```

Add, in the search section of app.ts:

```ts
// One cache for the whole page. Cleared when a new search starts — the only
// moment the set of rows changes wholesale — which revokes every blob it holds.
const resultPosters = createPosterCache({
  async fetchMeta(release, group): Promise<PublicTitleMeta | null> {
    const params = new URLSearchParams({ release });
    // The group, not a parsed hint: the server maps it (hintForGroup) so the
    // browser never has to know that "TV" means OMDb's "series".
    if (group && group !== ALL_TAB) params.set("group", group);
    try {
      const res = await fetch(`/api/title?${params.toString()}`, { headers: authHeaders() });
      if (!res.ok) return null;
      const body = (await res.json()) as unknown;
      return body && typeof body === "object" ? (body as PublicTitleMeta) : null;
    } catch {
      return null;
    }
  },
  async fetchBlob(posterUrl): Promise<string | null> {
    // Through /api/poster, never an <img src> at the CDN: that would leak the
    // user's IP and referer on every row, which is why that route exists. It is
    // also behind the bearer token, and an <img> cannot send a header.
    try {
      const res = await fetch(posterPath(posterUrl), { headers: authHeaders() });
      if (!res.ok) return null;
      return URL.createObjectURL(await res.blob());
    } catch {
      return null;
    }
  },
  revoke: (url) => URL.revokeObjectURL(url),
});

/**
 * The page's single "no OMDb key" line.
 *
 * TWO SOURCES, and the second is the one that matters. `resultPosters.hint()`
 * answers from the lookups that were made — but with no key configured
 * `postersApply` makes NONE, so that path would stay silent on exactly the
 * install that needs the sentence. The config flag is therefore checked first,
 * gated on the tab having artwork to miss: a Games tab has no posters to explain
 * and must not carry a note about a key it would never use.
 *
 * `hint()` still matters for the race — a key revoked mid-session, where lookups
 * were made and came back `no-key`.
 */
function paintSearchHint(): void {
  const keyless =
    sources !== null && !sources.omdbConfigured && previewApplies(searchView.group);
  const hint = keyless ? OMDB_KEY_HINT : resultPosters.hint();
  searchHintLine.textContent = hint ?? "";
  searchHintLine.hidden = hint === null;
}

/**
 * Paint one poster frame.
 *
 * `compact` is the row thumbnail, where the frame is 3.5rem wide and "NO OMDB
 * KEY" does not fit — it gets an empty box with the wording on `title`, and the
 * page's hint line carries the explanation. A grid card's frame is poster-width,
 * so it shows the note as text the way the For You cards do.
 */
function paintPoster(host: HTMLElement, outcome: PosterOutcome, compact: boolean): void {
  if (outcome.kind === "poster") {
    const img = document.createElement("img");
    img.src = outcome.url;
    img.alt = "";
    host.replaceChildren(img);
    return;
  }
  const note = resultPosters.note(outcome);
  const span = document.createElement("span");
  span.className = "poster-note";
  span.textContent = compact ? "" : note;
  // An attribute, not markup — and the only way the compact frame says anything.
  span.title = note;
  host.replaceChildren(span);
}

/**
 * Mount a row's poster.
 *
 * Lazy, via IntersectionObserver: a browse can return 100+ rows, and fetching
 * artwork for rows nobody scrolled to would spend a daily-capped OMDb key on
 * them. For You is naturally ~20 picks and needs no such gate.
 */
function mountResultPoster(release: string, host: HTMLElement, compact: boolean): void {
  const known = resultPosters.peek(release);
  if (known !== undefined) {
    paintPoster(host, known, compact);
    return;
  }

  const start = (): void => {
    const outcome = resultPosters.want(release, searchView.group);
    if (!(outcome instanceof Promise)) {
      paintPoster(host, outcome, compact);
      return;
    }
    void outcome.then((settledOutcome) => {
      // The row may have been re-rendered or filtered away during the two round
      // trips; a detached node is not worth painting.
      if (host.isConnected) paintPoster(host, settledOutcome, compact);
      paintSearchHint();
    });
  };

  // No IntersectionObserver (an old browser, a test environment) means fetch
  // now: a missing optimisation must not become a missing feature.
  if (typeof IntersectionObserver !== "function") {
    start();
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.disconnect();
      start();
    }
  });
  observer.observe(host);
}
```

In `renderResult`, wrap the existing content when posters apply. Replace the final `li.append(head, meta, actions);` with:

```ts
  const withPoster = postersApply(searchView.group, sources?.omdbConfigured === true);
  if (!withPoster) {
    li.append(head, meta, actions);
    return li;
  }

  // The row's own layout is untouched — it moves wholesale into the second grid
  // column, so a keyless page and a Games tab render exactly what they always
  // did.
  li.classList.add("result-with-poster");
  const frame = document.createElement("div");
  frame.className = "poster result-thumb";
  const body = document.createElement("div");
  body.append(head, meta, actions);
  li.append(frame, body);
  mountResultPoster(result.name, frame, true);
  return li;
```

Add `previewApplies` and `OMDB_KEY_HINT` to app.ts's imports — from `./searchModel` and `./previewModel` respectively. `previewApplies` is not currently imported there (only `postersApply` wraps it), and `paintSearchHint` needs it directly to decide whether a keyless tab has artwork to explain.

In `startSearch`, next to the existing `selectedHash = null;`:

```ts
  // A new search is the only moment the whole set of rows changes, so it is the
  // only moment every blob is certainly dead.
  resultPosters.clear();
  paintSearchHint();
```

Add `paintSearchHint();` to the end of `renderResults()`.

- [ ] **Step 4: Verify build and suite**

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

Expected: all PASS.

- [ ] **Step 5: Verify by hand — with a key and without**

```bash
npm run dev -- serve --web
```

With an OMDb key configured:
1. Click `Movies`. Rows have thumbnails; scroll and further rows fill in as they appear.
2. Open devtools Network, filter `api/title`. Count the requests — it must be roughly the number of **distinct films on screen**, not the number of rows, and not rows × frames. Watch during the search, while `n/23 sources` is climbing: the count must not jump each time the list re-renders.
3. Click `Games`. No thumbnails, no `api/title` requests.

Then without a key:

```bash
TORLINK_OMDB_KEY= npm run dev -- serve --web
```

(and with `omdbApiKey` absent from config — check with `cat ~/.config/torlnk/config.json | jq .omdbApiKey`)

4. Click `Movies`. **Zero** `api/title` and `api/poster` requests, no thumbnail column, rows identical to before this change — but the hint line reads "Add an OMDb API key in the TUI's Accounts tab to see plots and posters."
5. Click `Games`. The hint line disappears: there is no artwork on that tab to explain, so a note about a key would be noise.

- [ ] **Step 6: Commit**

```bash
git add src/web/static/app.ts src/web/static/index.html src/web/static/styles.css
git commit -m "feat(web): poster thumbnails in the Movies/TV result rows

The row's head/meta/actions move wholesale into a second grid column, so a
keyless page and a Games tab render exactly what they always did.

Lazy via IntersectionObserver, because a browse can return 100+ rows and a
daily-capped OMDb key should not be spent on rows nobody scrolled to.
omdbConfigured means a keyless server fires no lookups at all.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 13: The list / grid toggle

**Files:**
- Modify: `src/web/static/searchModel.ts` (layout parsing)
- Modify: `src/web/static/searchModel.test.ts`
- Modify: `src/web/static/index.html` (the toggle in `.controls`)
- Modify: `src/web/static/styles.css` (append)
- Modify: `src/web/static/app.ts` (layout state, grid rendering)

**Interfaces:**
- Consumes: `postersApply` (Task 11); `mountResultPoster`, `paintSearchHint` (Task 12); `resultMeta`, `sourceLabel`, `visibleResults` (existing).
- Produces: `type ResultLayout = "list" | "grid"`, `parseLayout(raw: string | null): ResultLayout` in `searchModel.ts`.

- [ ] **Step 1: Write the failing test**

Append to `src/web/static/searchModel.test.ts` (add `parseLayout` to the import):

```ts
describe("parseLayout", () => {
  it("reads the two layouts", () => {
    expect(parseLayout("list")).toBe("list");
    expect(parseLayout("grid")).toBe("grid");
  });

  it("falls back to list for anything else", () => {
    // The value comes out of localStorage, which is user-writable and survives
    // upgrades — a stale or hand-edited entry must degrade to the default
    // rather than render nothing. List is the default because it is the layout
    // that works without an OMDb key.
    expect(parseLayout(null)).toBe("list");
    expect(parseLayout("")).toBe("list");
    expect(parseLayout("gallery")).toBe("list");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/web/static/searchModel.test.ts -t "parseLayout"
```

Expected: FAIL — `parseLayout` is not exported.

- [ ] **Step 3: Add parseLayout**

Append to `src/web/static/searchModel.ts`:

```ts
/** How the results are laid out. */
export type ResultLayout = "list" | "grid";

/**
 * A remembered layout, or the default.
 *
 * Parsed rather than cast because the value comes from `localStorage`: it is
 * user-writable, it survives upgrades, and a stale entry must fall back rather
 * than render nothing. `"list"` is the default deliberately — it is the layout
 * that works with no OMDb key, which is the common install.
 */
export function parseLayout(raw: string | null): ResultLayout {
  return raw === "grid" ? "grid" : "list";
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run src/web/static/searchModel.test.ts -t "parseLayout"
```

Expected: PASS.

- [ ] **Step 5: Add the toggle markup**

In `src/web/static/index.html`, inside the search pane's `.controls`, after the alive-only label:

```html
          <!-- Shown only on the tabs that have artwork to show, by app.ts:
               a grid of empty frames is worse than the list it replaced. -->
          <label class="control" id="layout-control" for="layout" hidden>
            <span>layout</span>
            <select id="layout">
              <option value="list" selected>list</option>
              <option value="grid">grid</option>
            </select>
          </label>
```

- [ ] **Step 6: Add the grid styles**

Append to `src/web/static/styles.css`:

```css
/* Grid layout for search results. Deliberately the For You feed's own grid
   metrics, so the two poster walls on this page are one visual idea — and the
   card carries the same play/add/add-via-RD row the list row does, on the card
   rather than behind a hover: nothing the list offers may be lost in the grid. */
.results-grid {
  grid-template-columns: repeat(auto-fill, minmax(10rem, 1fr));
  gap: 0.75rem;
}

.result-card {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  padding: 0.6rem;
}

.result-card .poster {
  max-width: none;
  margin-bottom: 0.5rem;
}

.result-card .row-name {
  font-size: 0.8rem;
  overflow-wrap: anywhere;
}

.result-card .row-meta {
  font-size: 0.7rem;
}

/* The actions sit at the bottom of every card whatever its title length, so a
   row of cards has one row of buttons rather than a ragged one. */
.result-card .row-actions {
  margin-top: auto;
  padding-top: 0.4rem;
  flex-wrap: wrap;
}
```

- [ ] **Step 7: Wire the toggle**

Add to app.ts's `./searchModel` import: `parseLayout, type ResultLayout`.

Handles and state:

```ts
const layoutControl = el<HTMLLabelElement>("layout-control");
const layoutSelect = el<HTMLSelectElement>("layout");

// Remembered across reloads, and read through parseLayout because localStorage
// is user-writable. Wrapped in try/catch for the reason readStoredToken is:
// storage throws rather than returning null when it is blocked (Safari private
// mode, a hardened profile), and a dead page is a worse outcome than a
// forgotten preference.
const LAYOUT_KEY = "torlnk.layout";

function readStoredLayout(): ResultLayout {
  try {
    return parseLayout(localStorage.getItem(LAYOUT_KEY));
  } catch {
    return "list";
  }
}

let layout: ResultLayout = readStoredLayout();
```

Refactor `renderResult` so the card path shares its buttons. Extract the actions builder from `renderResult` into:

```ts
// The three buttons a result offers, built once and used by both layouts: a
// grid card that offered fewer of them than the list row would be a downgrade
// dressed as a view option.
function resultActions(result: PublicSearchResult): HTMLDivElement {
  const actions = document.createElement("div");
  actions.className = "row-actions";

  const playButton = document.createElement("button");
  playButton.type = "button";
  playButton.className = "play";
  playButton.textContent = "play";
  playButton.addEventListener("click", () => void play(rowForPlay(result)));
  actions.append(playButton);

  const addButton = document.createElement("button");
  addButton.type = "button";
  addButton.textContent = "add";
  addButton.addEventListener("click", () => void addResult(result, "p2p"));
  actions.append(addButton);

  const inLibrary = isInLibrary(savedState, result.infoHash);
  const favButton = document.createElement("button");
  favButton.type = "button";
  favButton.textContent = favouriteLabel(inLibrary);
  favButton.setAttribute("aria-pressed", String(inLibrary));
  favButton.addEventListener("click", () => {
    const input: LibraryInput = { infoHash: result.infoHash, name: result.name };
    if (result.sizeBytes > 0) input.sizeBytes = result.sizeBytes;
    if (result.source) input.source = result.source;
    void toggleLibrary(input);
  });
  actions.append(favButton);

  if (sources?.debridConfigured) {
    const debridButton = document.createElement("button");
    debridButton.type = "button";
    debridButton.textContent = "add via RD";
    debridButton.addEventListener("click", () => void addResult(result, "debrid"));
    actions.append(debridButton);
  }

  return actions;
}
```

Now delete that whole block from `renderResult` — every line from `const actions = document.createElement("div");` down to and including the `debridConfigured` `if` block (four buttons' worth: play, add, favourite, add via RD) — and replace it with one line:

```ts
  const actions = resultActions(result);
```

`renderResult`'s remaining references to `actions` (the `li.append(head, meta, actions)` in the no-poster branch, and `body.append(head, meta, actions)` in the thumbnail branch added in Task 12) are unchanged — they now receive the extracted element.

Then add the card renderer:

```ts
// Same createElement/textContent rule as every other list here: a release name
// is written by whoever uploaded the torrent.
function renderResultCard(result: PublicSearchResult): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "row result-card";
  li.setAttribute("aria-selected", String(result.infoHash === selectedHash));

  // The poster is the card's primary target and what it does is select the
  // result, which fills the preview pane — the same thing clicking the name
  // does in list view.
  const posterButton = document.createElement("button");
  posterButton.type = "button";
  posterButton.className = "recc-poster";
  posterButton.title = result.name;
  const frame = document.createElement("div");
  frame.className = "poster";
  posterButton.append(frame);
  posterButton.addEventListener("click", () => selectResult(result));
  // compact: false — a card's frame is poster-width, so an empty one shows its
  // note as text rather than relying on a tooltip.
  mountResultPoster(result.name, frame, false);

  const name = document.createElement("button");
  name.type = "button";
  name.className = "result-name row-name";
  name.textContent = result.name;
  name.title = result.name;
  name.addEventListener("click", () => selectResult(result));

  const meta = document.createElement("span");
  meta.className = "row-meta";
  meta.textContent = resultMeta(result, sources);

  li.append(posterButton, name, meta, resultActions(result));
  return li;
}
```

In `renderResults`, choose the layout:

```ts
function renderResults(): void {
  const shown = visibleResults(searchView, reportsHealthLookup(sources));

  // The toggle is meaningless where there is no artwork, and a grid of empty
  // frames is worse than the list it replaced — so on a Games tab, or with no
  // OMDb key, the control is hidden and the layout is forced back to list. The
  // stored preference is untouched: it applies again the moment the user is on
  // a tab that can honour it.
  const canGrid = postersApply(searchView.group, sources?.omdbConfigured === true);
  layoutControl.hidden = !canGrid;
  const effective: ResultLayout = canGrid ? layout : "list";

  resultsList.classList.toggle("recc-grid", effective === "grid");
  resultsList.classList.toggle("results-grid", effective === "grid");
  resultsList.replaceChildren(
    ...shown.map((r) => (effective === "grid" ? renderResultCard(r) : renderResult(r))),
  );

  // …the rest of the existing renderResults body, unchanged…
}
```

And the listener:

```ts
layoutSelect.addEventListener("change", () => {
  layout = parseLayout(layoutSelect.value);
  try {
    localStorage.setItem(LAYOUT_KEY, layout);
  } catch {
    /* not remembering the layout is survivable; failing the click is not */
  }
  // No refetch: both layouts render from the same visibleResults output and the
  // same poster cache, so a toggle costs nothing.
  renderResults();
});
```

In `openApp`, reflect the stored value into the select before the first render:

```ts
  layoutSelect.value = layout;
```

- [ ] **Step 8: Verify build and suite**

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

Expected: all PASS.

- [ ] **Step 9: Verify by hand**

```bash
npm run dev -- serve --web
```

With a key:
1. Click `Movies`. A `layout` select appears. Switch to `grid` — a poster wall, each card carrying play / add / favourite / add via RD.
2. Switch back to `list` and forward to `grid` again. Watch the Network tab: **no new `api/title` or `api/poster` requests** — both layouts share the cache.
3. Reload. The page opens in `grid`.
4. Click `Games`. The `layout` control disappears and rows are the list. Click `Movies` again — back to grid.
5. Click a poster. The preview aside fills in, as clicking the name does in list view.

Without a key: the `layout` control never appears on any tab.

- [ ] **Step 10: Full verification, then commit**

```bash
npm test
npm run lint
npm run typecheck
npm run build
```

Expected: all PASS.

```bash
git add src/web/static/searchModel.ts src/web/static/searchModel.test.ts src/web/static/index.html src/web/static/styles.css src/web/static/app.ts
git commit -m "feat(web): a list/grid toggle for the result tabs with artwork

Grid cards carry the same play/add/favourite/add-via-RD row the list rows
do, on the card rather than behind a hover: a view option must not be a
downgrade. Both layouts render from one visibleResults output and one
poster cache, so toggling costs no fetches.

Hidden — and forced back to list — where there is no artwork to show. The
stored preference survives that and applies again on a tab that can
honour it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Final Verification

- [ ] **Full suite, lint, typecheck, build**

```bash
npm test && npm run lint && npm run typecheck && npm run build
```

- [ ] **Confirm no `src/web` → `src/ui` import crept in**

```bash
grep -rn 'from "\.\./ui/\|from "\.\./\.\./ui/' src/web
```

Expected: no output. (`npm run lint` also enforces this.)

- [ ] **Confirm no raw-HTML sink was introduced**

```bash
grep -rn "innerHTML\|insertAdjacentHTML\|document.write\|outerHTML" src/web/static
```

Expected: no output.

- [ ] **Confirm the browser bundle stayed browser-safe**

Already covered by `npm run build` (`platform: "browser"` in `tsup.web.config.ts` fails on any Node builtin, following transitive imports). Confirm `dist/web/app.js` exists and is non-empty.

- [ ] **Confirm the keyless path is genuinely free**

With no `omdbApiKey` in config and `TORLINK_OMDB_KEY` unset, load the page, click `Movies`, and confirm **zero** requests to `/api/title` and `/api/poster` in devtools. This is the single most important degradation check in the plan: everything else about the poster work is an enhancement, but a keyless install firing a lookup per row is a regression.

- [ ] **Confirm favourites survive a restart** — favourite something in the browser, stop the server, start it again, and check the library still has it. This is the end-to-end proof that `buildMagnet` produced an entry `isFavouriteItem` accepts.

- [ ] **Confirm the TUI agrees** — favourite something in the browser, then open the TUI and check its `library` pane shows it (and that its `watchlist` shows a search saved from the browser). Both clients read one config file; this is the parity the whole design rests on.
