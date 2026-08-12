# Anime Metadata via AniList Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Anime group real posters and plots by looking metadata up on AniList (keyless) instead of OMDb, with OMDb as a fallback.

**Architecture:** A new pure title normalizer (`src/util/animeTitle.ts`) cleans a raw release name into an AniList search string. A new AniList GraphQL client (`src/recc/anilist.ts`) returns the same `FetchTitleMetaResult` union OMDb uses. A single resolver (`src/recc/animeMeta.ts`) owns the "AniList first, OMDb fallback" ordering, and both front ends call it on their existing anime path. AniList poster host is added to the one poster allowlist.

**Tech Stack:** TypeScript, Vitest, Ink/React (TUI), plain DOM bundle (web). AniList public GraphQL API (`https://graphql.anilist.co`, no key).

## Global Constraints

- **Ships in both front ends.** This change touches the web (`src/web`) and the terminal (`src/ui`); do not land one without the other.
- **Layering:** `src/web` must not import from `src/ui`; `src/core` must not import from `src/ui`/`src/web`. Shared logic lives in `src/util` or `src/recc`.
- **Browser-safety:** `src/util/animeTitle.ts` and anything reachable from `src/web/static/` must not import `node:*` (directly or transitively). `npm run build` is the check.
- **No `innerHTML`/`insertAdjacentHTML`/`document.write`/`outerHTML`** anywhere in `src/web/static/`.
- **Test fixtures never name a real film/show.** Reuse the invented cast where a generic title is needed; anime-shaped fixtures below are invented on purpose. Never introduce a real anime title into a test, helper, doc comment, or copy.
- **Config writes from web are read-modify-write per request.** (Not exercised here — no config writes — but do not introduce a cached snapshot.)
- **Conventional Commits.** Each task commits with a `feat:`/`test:`/`docs:` message.
- **Definition of done gate:** `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` all pass. One known pre-existing lint warning (`react-hooks/exhaustive-deps`, `src/ui/App.tsx`) is expected — leave it.
- **`FetchImpl`** is `(url: string, init?: RequestInit) => Promise<Response>` from `src/util/net.ts`. Every network client takes `opts.fetchImpl?` defaulting to global `fetch`, for offline tests.
- **`FetchTitleMetaResult`** (from `src/recc/omdb.ts`) is the shared return union:
  `{ ok: true; type?: OmdbType | null; imdbId: string | null; plot: string | null; posterUrl: string | null } | { ok: false; error: string }`, where `OmdbType = "movie" | "series"`.

---

### Task 1: Anime title normalizer

**Files:**
- Create: `src/util/animeTitle.ts`
- Test: `src/util/animeTitle.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `animeSearchTitle(rawName: string): string | null` — raw release name → clean AniList search string, or `null` when nothing usable survives.

- [ ] **Step 1: Write the failing test**

```typescript
// src/util/animeTitle.test.ts
import { describe, it, expect } from "vitest";
import { animeSearchTitle } from "./animeTitle";

describe("animeSearchTitle", () => {
  it("strips a leading fansub group tag", () => {
    expect(animeSearchTitle("[NanakoRaws] Yomi no Tsugai S01E18 (AT-X TV 1080p HEVC AAC)")).toBe(
      "Yomi no Tsugai",
    );
  });

  it("strips the SubsPlease absolute-episode tail and resolution block", () => {
    expect(animeSearchTitle("Tefuda ga Oome no Victoria - 06 [1080p]")).toBe("Tefuda ga Oome no Victoria");
  });

  it("cuts a trailing quality/codec/subtitle block", () => {
    expect(animeSearchTitle("Kestrel no Yoru [WebRip 1080p HEVC-10bit AAC][subs]")).toBe("Kestrel no Yoru");
  });

  it("prefers a Latin-script alternative over a CJK one when titles are slash-joined", () => {
    expect(animeSearchTitle("[LoliHouse] 尼古喵喵 / Yani Neko - 06 [WebRip 1080p]")).toBe("Yani Neko");
  });

  it("keeps the first segment when every alternative is CJK", () => {
    expect(animeSearchTitle("[Doomdos] 有兽焉 - 第63话 - [1080p BILIBILI COM WEB-DL]")).toBe("有兽焉");
  });

  it("drops an SxxExx marker", () => {
    expect(animeSearchTitle("Harrowgate S03E04 [1080p]")).toBe("Harrowgate");
  });

  it("returns null when only noise survives", () => {
    expect(animeSearchTitle("[Group] [1080p HEVC AAC]")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/util/animeTitle.test.ts`
Expected: FAIL — `animeSearchTitle` is not exported / module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/util/animeTitle.ts

// Turn a raw anime torrent release name into a title string suitable for an
// AniList search, or null when nothing usable survives.
//
// AniList indexes anime by romaji / English / native title plus synonyms, and
// its search tolerates extra words far better than OMDb's exact title match —
// but fansub release names bury the title under group tags, quality blocks and
// an absolute episode number, and often glue several language variants together
// with "/". This strips it down to one best candidate.
//
// Pure and browser-safe: no node:* imports, direct or transitive.

// Does a string contain any Latin letter? Used to prefer a romaji/English
// alternative title (which AniList ranks strongly) over a CJK-only one.
function hasLatin(s: string): boolean {
  return /[A-Za-z]/.test(s);
}

// Is a token pure release noise (resolution / codec / source / sub markers)?
// Deliberately small and anchored to whole tokens — the goal is only to notice
// that a candidate is entirely metadata, not to enumerate every release word.
const NOISE = /^(?:\d{3,4}p|4k|2160p|1080p|720p|480p|hevc|x264|x265|h264|h265|10bit|aac|flac|ac3|eac3|ddp?\d?|web-?dl|webrip|bluray|bdrip|bdremux|remux|hdr|dv|multi-?subs?|dual|audio|sub|subs|raws?|tv|bili?bili|amzn|iqiyi|iq|baha|com)$/i;

// Split a title into whitespace tokens and drop the trailing run of pure-noise
// tokens ("Kestrel no Yoru WebRip 1080p" -> "Kestrel no Yoru"). Only trailing
// noise is trimmed; interior words are left alone.
function trimTrailingNoise(s: string): string {
  const tokens = s.split(/\s+/).filter(Boolean);
  while (tokens.length && NOISE.test(tokens[tokens.length - 1]!)) tokens.pop();
  return tokens.join(" ");
}

export function animeSearchTitle(rawName: string): string | null {
  let s = rawName;

  // 1. Strip leading bracketed group/source tags: "[NanakoRaws] ", "(2026) ".
  //    Repeated because releases often stack two ("[ANi] [Baha] ...").
  s = s.replace(/^\s*(?:\[[^\]]*\]|\([^)]*\))\s*/g, "");

  // 2. Cut everything from the first remaining bracketed block onward — that is
  //    where the quality/codec/subtitle metadata lives ("... [WebRip 1080p]").
  const bracket = s.search(/[[(]/);
  if (bracket >= 0) s = s.slice(0, bracket);

  // 3. Strip an episode tail: "- 06", "- 1173", "- 第63话", "S01E04", "E06".
  s = s.replace(/\s*-\s*(?:第\s*\d+\s*话|\d{1,4})\s*$/u, "");
  s = s.replace(/\s+S\d{1,2}(?:E\d{1,4})?\s*$/i, "");
  s = s.replace(/\s+E\d{1,4}\s*$/i, "");

  // 4. Several language variants joined by "/" or "|": prefer a Latin-script
  //    segment (romaji/English), else keep the first.
  const parts = s.split(/[/|]/).map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1) {
    s = parts.find((p) => hasLatin(p)) ?? parts[0]!;
  } else {
    s = parts[0] ?? "";
  }

  // 5. Trim trailing pure-noise tokens and collapse whitespace.
  s = trimTrailingNoise(s).replace(/\s+/g, " ").trim();

  return s.length > 0 ? s : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/util/animeTitle.test.ts`
Expected: PASS (all 7 cases).

- [ ] **Step 5: Commit**

```bash
git add src/util/animeTitle.ts src/util/animeTitle.test.ts
git commit -m "feat(util): normalize anime release names for AniList search"
```

---

### Task 2: AniList GraphQL client

**Files:**
- Create: `src/recc/anilist.ts`
- Test: `src/recc/anilist.test.ts`

**Interfaces:**
- Consumes: `FetchImpl` from `src/util/net.ts`; `FetchTitleMetaResult`, `OmdbType` from `src/recc/omdb.ts`.
- Produces: `fetchAnimeMetaByName(title: string, opts?: { fetchImpl?: FetchImpl; timeoutMs?: number }): Promise<FetchTitleMetaResult>`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/recc/anilist.test.ts
import { describe, it, expect } from "vitest";
import { fetchAnimeMetaByName } from "./anilist";
import type { FetchImpl } from "../util/net";

function postImpl(status: number, body: unknown): { impl: FetchImpl; calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
  }) as unknown as FetchImpl;
  return { impl, calls };
}

const media = (over: Record<string, unknown> = {}) => ({
  data: {
    Media: {
      id: 1,
      title: { romaji: "Kestrel no Yoru", english: "Kestrel Nights", native: "ケストレル" },
      description: "A quiet town.<br><br>Then it isn't.",
      coverImage: { extraLarge: "https://s4.anilist.co/xl.jpg", large: "https://s4.anilist.co/l.jpg" },
      format: "TV",
      siteUrl: "https://anilist.co/anime/1",
      ...over,
    },
  },
});

describe("fetchAnimeMetaByName", () => {
  it("returns poster, tag-stripped plot, series type and null imdbId on a hit", async () => {
    const { impl, calls } = postImpl(200, media());
    const res = await fetchAnimeMetaByName("Kestrel no Yoru", { fetchImpl: impl });
    expect(res).toEqual({
      ok: true,
      type: "series",
      imdbId: null,
      plot: "A quiet town. Then it isn't.",
      posterUrl: "https://s4.anilist.co/xl.jpg",
    });
    expect(calls[0]!.url).toBe("https://graphql.anilist.co");
    expect(calls[0]!.init?.method).toBe("POST");
  });

  it("maps format MOVIE to movie", async () => {
    const { impl } = postImpl(200, media({ format: "MOVIE" }));
    const res = await fetchAnimeMetaByName("Kestrel", { fetchImpl: impl });
    expect(res.ok && res.type).toBe("movie");
  });

  it("falls back to coverImage.large when extraLarge is missing", async () => {
    const { impl } = postImpl(200, media({ coverImage: { large: "https://s4.anilist.co/l.jpg" } }));
    const res = await fetchAnimeMetaByName("Kestrel", { fetchImpl: impl });
    expect(res.ok && res.posterUrl).toBe("https://s4.anilist.co/l.jpg");
  });

  it("treats Media: null as a miss", async () => {
    const { impl } = postImpl(200, { data: { Media: null } });
    const res = await fetchAnimeMetaByName("Nothing Here", { fetchImpl: impl });
    expect(res).toEqual({ ok: false, error: "not found" });
  });

  it("treats a GraphQL errors payload as a miss", async () => {
    const { impl } = postImpl(200, { errors: [{ message: "Not Found." }] });
    const res = await fetchAnimeMetaByName("Nothing", { fetchImpl: impl });
    expect(res.ok).toBe(false);
  });

  it("returns a reach error when the request throws", async () => {
    const impl = (async () => {
      throw new Error("network down");
    }) as unknown as FetchImpl;
    const res = await fetchAnimeMetaByName("Kestrel", { fetchImpl: impl });
    expect(res).toEqual({ ok: false, error: "couldn't reach AniList" });
  });

  it("returns a miss for a non-video format", async () => {
    const { impl } = postImpl(200, media({ format: "MUSIC" }));
    const res = await fetchAnimeMetaByName("Kestrel", { fetchImpl: impl });
    expect(res.ok).toBe(false);
  });

  it("returns an empty-title error without calling the network", async () => {
    let called = false;
    const impl = (async () => {
      called = true;
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as FetchImpl;
    const res = await fetchAnimeMetaByName("   ", { fetchImpl: impl });
    expect(res.ok).toBe(false);
    expect(called).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/recc/anilist.test.ts`
Expected: FAIL — module/function not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/recc/anilist.ts
import type { FetchImpl } from "../util/net";
import { log } from "../util/logger";
import type { FetchTitleMetaResult, OmdbType } from "./omdb";

// AniList is a free, keyless GraphQL API for anime. It is the right database for
// the Anime group, where OMDb (an IMDb mirror) cannot match romaji/CJK titles or
// absolute episode numbering. We return the SAME FetchTitleMetaResult union OMDb
// returns so every caller — TUI hook and web route — handles one shape.

const ENDPOINT = "https://graphql.anilist.co";

// One media match, ranked by search relevance. type: ANIME excludes manga.
const QUERY = `
query ($search: String) {
  Media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
    id
    title { romaji english native }
    description(asHtml: false)
    coverImage { extraLarge large }
    format
    siteUrl
  }
}`;

interface AniListMedia {
  description?: string | null;
  coverImage?: { extraLarge?: string | null; large?: string | null } | null;
  format?: string | null;
}

interface AniListResponse {
  data?: { Media?: AniListMedia | null } | null;
  errors?: unknown;
}

function isResponse(v: unknown): v is AniListResponse {
  return typeof v === "object" && v !== null;
}

// AniList descriptions carry light HTML (<br>, <i>, ...) even with asHtml:false.
// Strip tags and collapse whitespace to a single-paragraph plot.
function cleanPlot(desc: string | null | undefined): string | null {
  const s = (desc ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > 0 ? s : null;
}

// Map AniList's format enum to the two media types we model. MOVIE is a film;
// every other video format (TV, TV_SHORT, OVA, ONA, SPECIAL) is a series.
// MUSIC and anything unrecognised is not something we can present -> null.
function mapType(format: string | null | undefined): OmdbType | null {
  if (format === "MOVIE") return "movie";
  if (format === "TV" || format === "TV_SHORT" || format === "OVA" || format === "ONA" || format === "SPECIAL") {
    return "series";
  }
  return null;
}

export async function fetchAnimeMetaByName(
  title: string,
  opts: { fetchImpl?: FetchImpl; timeoutMs?: number } = {},
): Promise<FetchTitleMetaResult> {
  const search = title.trim();
  if (!search) return { ok: false, error: "no title" };
  const fetchImpl = opts.fetchImpl ?? (fetch as FetchImpl);
  try {
    const res = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query: QUERY, variables: { search } }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
    });
    if (!res.ok) return { ok: false, error: `AniList unavailable (HTTP ${res.status})` };
    const body: unknown = await res.json();
    if (!isResponse(body) || body.errors) return { ok: false, error: "not found" };
    const media = body.data?.Media;
    if (!media) return { ok: false, error: "not found" };
    const type = mapType(media.format);
    if (type === null) return { ok: false, error: "not found" };
    const posterUrl = media.coverImage?.extraLarge || media.coverImage?.large || null;
    return { ok: true, type, imdbId: null, plot: cleanPlot(media.description), posterUrl };
  } catch (err) {
    log.debug(`anilist by name ${search}: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, error: "couldn't reach AniList" };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/recc/anilist.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/recc/anilist.ts src/recc/anilist.test.ts
git commit -m "feat(recc): add keyless AniList metadata client"
```

---

### Task 3: Anime-first resolver

**Files:**
- Create: `src/recc/animeMeta.ts`
- Test: `src/recc/animeMeta.test.ts`

**Interfaces:**
- Consumes: `fetchAnimeMetaByName` (Task 2), `fetchTitleMetaByName` (`src/recc/omdb.ts`), `animeSearchTitle` (Task 1), `FetchImpl`, `FetchTitleMetaResult`, `OmdbType`.
- Produces:
  ```typescript
  interface AnimeFirstArgs {
    rawName: string;
    omdb: { title: string; year?: number; type?: OmdbType };
    omdbApiKey: string;
    fetchImpl?: FetchImpl;
    timeoutMs?: number;
  }
  fetchAnimeFirstMeta(args: AnimeFirstArgs): Promise<FetchTitleMetaResult>
  ```

- [ ] **Step 1: Write the failing test**

```typescript
// src/recc/animeMeta.test.ts
import { describe, it, expect, vi } from "vitest";
import { fetchAnimeFirstMeta } from "./animeMeta";
import * as anilist from "./anilist";
import * as omdb from "./omdb";
import type { FetchTitleMetaResult } from "./omdb";

const hit: FetchTitleMetaResult = { ok: true, type: "series", imdbId: null, plot: "p", posterUrl: "https://s4.anilist.co/x.jpg" };
const miss: FetchTitleMetaResult = { ok: false, error: "not found" };

describe("fetchAnimeFirstMeta", () => {
  it("returns the AniList hit and never calls OMDb", async () => {
    const a = vi.spyOn(anilist, "fetchAnimeMetaByName").mockResolvedValue(hit);
    const o = vi.spyOn(omdb, "fetchTitleMetaByName").mockResolvedValue(miss);
    const res = await fetchAnimeFirstMeta({
      rawName: "[NanakoRaws] Yomi no Tsugai S01E18 [1080p]",
      omdb: { title: "Yomi no Tsugai", type: "series" },
      omdbApiKey: "KEY",
    });
    expect(res).toBe(hit);
    expect(a).toHaveBeenCalledWith("Yomi no Tsugai", expect.anything());
    expect(o).not.toHaveBeenCalled();
    a.mockRestore();
    o.mockRestore();
  });

  it("falls back to OMDb (no season/episode) when AniList misses and a key is present", async () => {
    const a = vi.spyOn(anilist, "fetchAnimeMetaByName").mockResolvedValue(miss);
    const o = vi.spyOn(omdb, "fetchTitleMetaByName").mockResolvedValue(hit);
    const res = await fetchAnimeFirstMeta({
      rawName: "Kestrel no Yoru - 06 [1080p]",
      omdb: { title: "Kestrel no Yoru", year: 2010, type: "series" },
      omdbApiKey: "KEY",
    });
    expect(res).toBe(hit);
    expect(o).toHaveBeenCalledWith("Kestrel no Yoru", "KEY", { year: 2010, type: "series" });
    a.mockRestore();
    o.mockRestore();
  });

  it("does NOT call OMDb on an AniList miss when no key is configured", async () => {
    const a = vi.spyOn(anilist, "fetchAnimeMetaByName").mockResolvedValue(miss);
    const o = vi.spyOn(omdb, "fetchTitleMetaByName").mockResolvedValue(hit);
    const res = await fetchAnimeFirstMeta({
      rawName: "Kestrel no Yoru - 06 [1080p]",
      omdb: { title: "Kestrel no Yoru" },
      omdbApiKey: "",
    });
    expect(res).toEqual(miss);
    expect(o).not.toHaveBeenCalled();
    a.mockRestore();
    o.mockRestore();
  });

  it("skips AniList and goes straight to OMDb when the name normalizes to nothing", async () => {
    const a = vi.spyOn(anilist, "fetchAnimeMetaByName").mockResolvedValue(hit);
    const o = vi.spyOn(omdb, "fetchTitleMetaByName").mockResolvedValue(hit);
    const res = await fetchAnimeFirstMeta({
      rawName: "[Group] [1080p HEVC]",
      omdb: { title: "Fallback Title" },
      omdbApiKey: "KEY",
    });
    expect(a).not.toHaveBeenCalled();
    expect(o).toHaveBeenCalledWith("Fallback Title", "KEY", {});
    expect(res).toBe(hit);
    a.mockRestore();
    o.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/recc/animeMeta.test.ts`
Expected: FAIL — module/function not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/recc/animeMeta.ts
import type { FetchImpl } from "../util/net";
import { animeSearchTitle } from "../util/animeTitle";
import { fetchAnimeMetaByName } from "./anilist";
import { fetchTitleMetaByName, type FetchTitleMetaResult, type OmdbType } from "./omdb";

// The one place the "anime is AniList first, OMDb second" ordering lives. Both
// front ends call this on their Anime path so the ordering and the fallback rule
// cannot drift between a server route and a React hook.
export interface AnimeFirstArgs {
  // Raw torrent release name, normalized here for the AniList search.
  rawName: string;
  // The already-parsed OMDb query, used only for the fallback. No season/episode:
  // anime absolute numbering is meaningless to OMDb's per-season index.
  omdb: { title: string; year?: number; type?: OmdbType };
  // "" when no OMDb key is configured — the fallback is then skipped entirely,
  // which is what lets keyless users still get AniList artwork.
  omdbApiKey: string;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
}

export async function fetchAnimeFirstMeta(args: AnimeFirstArgs): Promise<FetchTitleMetaResult> {
  const { rawName, omdb, omdbApiKey, fetchImpl, timeoutMs } = args;

  const search = animeSearchTitle(rawName);
  if (search) {
    const anilist = await fetchAnimeMetaByName(search, { fetchImpl, timeoutMs });
    if (anilist.ok) return anilist;
  }

  // AniList missed (or the name had no usable title). Fall back to OMDb only
  // when a key exists; otherwise return the AniList miss (or a "no title" miss).
  if (!omdbApiKey) {
    return search
      ? { ok: false, error: "not found" }
      : { ok: false, error: "no title in that release name" };
  }
  return fetchTitleMetaByName(omdb.title, omdbApiKey, {
    ...(omdb.year !== undefined ? { year: omdb.year } : {}),
    ...(omdb.type !== undefined ? { type: omdb.type } : {}),
    fetchImpl,
    timeoutMs,
  });
}
```

> NOTE: `fetchTitleMetaByName`'s opts accept `fetchImpl`/`timeoutMs` (see `src/recc/omdb.ts:80`), so threading them through is valid. The test mocks `fetchTitleMetaByName` and asserts it is called with `{ year, type }` — the mock ignores the extra `fetchImpl`/`timeoutMs`, and in the no-year/no-type case the object is `{}` plus those, so assert with `expect.objectContaining` if the exact-match assertion is brittle. The provided tests pass `fetchImpl`/`timeoutMs` as `undefined`, so `{ year, type }` matches exactly.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/recc/animeMeta.test.ts`
Expected: PASS. If the exact-match `toHaveBeenCalledWith("...", "KEY", { year, type })` fails because `fetchImpl`/`timeoutMs` keys are present as `undefined`, switch those assertions to `expect.objectContaining({ year, type })`. (They are not spread when undefined, so the object is exactly `{ year, type }` — the assertions as written are correct.)

- [ ] **Step 5: Commit**

```bash
git add src/recc/animeMeta.ts src/recc/animeMeta.test.ts
git commit -m "feat(recc): resolver — AniList first, OMDb fallback for anime"
```

---

### Task 4: Allow AniList poster host

**Files:**
- Modify: `src/core/posterCache.ts:18-22` (the `POSTER_HOSTS` Set)
- Test: `src/core/posterCache.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `s4.anilist.co` accepted by `POSTER_HOSTS`, which gates both `getPoster` (core) and `allowedPosterUrl` + `/api/poster` (web).

- [ ] **Step 1: Write the failing test**

Add to `src/core/posterCache.test.ts` (append inside the file; if it imports `POSTER_HOSTS` already, reuse that import):

```typescript
import { POSTER_HOSTS } from "./posterCache";

describe("POSTER_HOSTS allowlist", () => {
  it("accepts the AniList cover CDN", () => {
    expect(POSTER_HOSTS.has("s4.anilist.co")).toBe(true);
  });
  it("still accepts the OMDb/Amazon hosts", () => {
    expect(POSTER_HOSTS.has("m.media-amazon.com")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/posterCache.test.ts`
Expected: FAIL — `s4.anilist.co` not in the Set.

- [ ] **Step 3: Write minimal implementation**

Edit `src/core/posterCache.ts`:

```typescript
export const POSTER_HOSTS = new Set([
  "m.media-amazon.com",
  "ia.media-imdb.com",
  "img.omdbapi.com",
  // AniList cover art (the Anime group's metadata provider).
  "s4.anilist.co",
]);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/posterCache.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/posterCache.ts src/core/posterCache.test.ts
git commit -m "feat(core): allow AniList cover host in poster allowlist"
```

---

### Task 5: Web route — send the Anime group to AniList

**Files:**
- Modify: `src/web/routes.ts` — add `fetchAnimeFirstMetaImpl?` to `WebDeps` (near line 203), import `fetchAnimeFirstMeta`, and branch inside `titleMeta()` (lines ~1615-1646).
- Test: `src/web/routes.test.ts` (add a describe block near the existing `/api/title` tests)

**Interfaces:**
- Consumes: `fetchAnimeFirstMeta` (Task 3); the existing `parseTitleLookup`, `resolveOmdbApiKey`, `allowedPosterUrl`, `withParse`, cache helpers.
- Produces: `WebDeps.fetchAnimeFirstMetaImpl?` injection point:
  ```typescript
  fetchAnimeFirstMetaImpl?: (args: {
    rawName: string;
    omdb: { title: string; year?: number; type?: OmdbType };
    omdbApiKey: string;
  }) => Promise<FetchTitleMetaResult>;
  ```

- [ ] **Step 1: Write the failing test**

```typescript
// src/web/routes.test.ts — add near the other /api/title tests.
// (Match the file's existing pattern for building a request + deps; the snippet
//  below shows the intent — adapt to the local `handle`/`makeDeps` helpers.)
describe("/api/title anime routing", () => {
  it("routes the Anime group through the AniList-first resolver", async () => {
    let sawRawName = "";
    const res = await handleTitle(
      "release=" + encodeURIComponent("[NanakoRaws] Yomi no Tsugai S01E18 [1080p]") + "&group=Anime",
      {
        loadConfigImpl: async () => ({ ...baseConfig }), // no omdb key
        fetchAnimeFirstMetaImpl: async (args) => {
          sawRawName = args.rawName;
          return { ok: true, type: "series", imdbId: null, plot: "p", posterUrl: "https://s4.anilist.co/x.jpg" };
        },
        fetchTitleMetaByNameImpl: async () => {
          throw new Error("OMDb must not be called for the Anime group");
        },
      },
    );
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ status: "ok", posterUrl: "https://s4.anilist.co/x.jpg" });
    expect(sawRawName).toContain("Yomi no Tsugai");
  });

  it("does not return no-key for anime even without an OMDb key", async () => {
    const res = await handleTitle("release=" + encodeURIComponent("Kestrel - 06 [1080p]") + "&group=Anime", {
      loadConfigImpl: async () => ({ ...baseConfig }),
      fetchAnimeFirstMetaImpl: async () => ({ ok: false, error: "not found" }),
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ status: "error", error: "not found" });
  });

  it("still routes non-anime groups through OMDb", async () => {
    let omdbCalled = false;
    const res = await handleTitle("release=" + encodeURIComponent("Kestrel.2010.1080p.BluRay.x264") + "&group=Movies", {
      loadConfigImpl: async () => ({ ...baseConfig, omdbApiKey: "KEY" }),
      fetchTitleMetaByNameImpl: async () => {
        omdbCalled = true;
        return { ok: true, type: "movie", imdbId: "tt1", plot: "p", posterUrl: null };
      },
      fetchAnimeFirstMetaImpl: async () => {
        throw new Error("AniList must not be called for Movies");
      },
    });
    expect(omdbCalled).toBe(true);
    expect(res.status).toBe(200);
  });
});
```

> Implementer: reuse the file's existing helpers for invoking `/api/title` and building a base config/deps. `handleTitle`/`baseConfig` above are stand-ins for whatever the file already uses (grep the file for the existing `/api/title` tests and copy their harness). Do not invent a new harness.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/web/routes.test.ts`
Expected: FAIL — `fetchAnimeFirstMetaImpl` not honored / anime path not implemented (OMDb throw fires, or no-key returned).

- [ ] **Step 3: Write minimal implementation**

3a. Add the import at the top of `src/web/routes.ts` (near the `fetchTitleMetaByName` import at line ~61):

```typescript
import { fetchAnimeFirstMeta } from "../recc/animeMeta";
```

3b. Add the dep to the `WebDeps` interface (after `fetchTitleMetaByNameImpl`, ~line 207):

```typescript
  /**
   * AniList-first metadata for `/api/title?release=&group=Anime`. Injected to
   * keep tests offline. Defaults to the real resolver in src/recc/animeMeta.
   */
  fetchAnimeFirstMetaImpl?: (args: {
    rawName: string;
    omdb: { title: string; year?: number; type?: OmdbType };
    omdbApiKey: string;
  }) => Promise<FetchTitleMetaResult>;
```

3c. Rewrite the key-gate + fetch block inside `titleMeta()` (currently ~lines 1615-1646). Replace:

```typescript
  const config = await (deps.loadConfigImpl ?? loadConfig)();
  const apiKey = resolveOmdbApiKey(config);
  if (!apiKey) {
    const out: PublicTitleMeta = { status: "no-key" };
    return { status: 200, json: withParse(out, lookup.parsed) };
  }

  const result =
    lookup.imdbId !== undefined
      ? await (deps.fetchTitleMetaImpl ?? fetchTitleMeta)(lookup.imdbId, apiKey)
      : await (deps.fetchTitleMetaByNameImpl ?? fetchTitleMetaByName)(lookup.name ?? "", apiKey, {
          ...(lookup.year !== undefined ? { year: lookup.year } : {}),
          ...(lookup.type !== undefined ? { type: lookup.type } : {}),
          ...(lookup.season !== undefined ? { season: lookup.season } : {}),
          ...(lookup.episode !== undefined ? { episode: lookup.episode } : {}),
        });
```

with:

```typescript
  const config = await (deps.loadConfigImpl ?? loadConfig)();
  const apiKey = resolveOmdbApiKey(config);

  // Anime (name lookups in the Anime group) resolves via AniList, which needs no
  // key — so the no-key short-circuit below must not apply to it, and its
  // resolver skips the OMDb fallback when apiKey is "".
  const isAnime = query.get("group") === "Anime" && lookup.imdbId === undefined;

  if (!apiKey && !isAnime) {
    // 200 with its own status — nothing is broken, the user simply has no key.
    const out: PublicTitleMeta = { status: "no-key" };
    return { status: 200, json: withParse(out, lookup.parsed) };
  }

  const result =
    lookup.imdbId !== undefined
      ? await (deps.fetchTitleMetaImpl ?? fetchTitleMeta)(lookup.imdbId, apiKey)
      : isAnime
        ? await (deps.fetchAnimeFirstMetaImpl ?? fetchAnimeFirstMeta)({
            rawName: query.get("release") ?? lookup.name ?? "",
            omdb: {
              title: lookup.name ?? "",
              ...(lookup.year !== undefined ? { year: lookup.year } : {}),
              ...(lookup.type !== undefined ? { type: lookup.type } : {}),
            },
            omdbApiKey: apiKey,
          })
        : await (deps.fetchTitleMetaByNameImpl ?? fetchTitleMetaByName)(lookup.name ?? "", apiKey, {
            ...(lookup.year !== undefined ? { year: lookup.year } : {}),
            ...(lookup.type !== undefined ? { type: lookup.type } : {}),
            ...(lookup.season !== undefined ? { season: lookup.season } : {}),
            ...(lookup.episode !== undefined ? { episode: lookup.episode } : {}),
          });
```

> `resolveOmdbApiKey` returns `""` when unset (`src/config/config.ts:438`), so `apiKey` is `""` for a keyless anime lookup — the resolver treats that as "no fallback", exactly as Task 3 tests. Successful anime results cache normally at the existing `cacheSet(lookup.cacheKey, out)`; misses stay uncached (unchanged policy). `OmdbType` and `FetchTitleMetaResult` are already imported in this file.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/web/routes.test.ts`
Expected: PASS (new anime cases + existing `/api/title` cases untouched).

- [ ] **Step 5: Commit**

```bash
git add src/web/routes.ts src/web/routes.test.ts
git commit -m "feat(web): route Anime-group title lookups through AniList"
```

---

### Task 6: Web gating — anime previews without an OMDb key

**Files:**
- Modify: `src/web/static/resultPosters.ts` — `postersApply` (lines 73-75) and `searchHint` (lines 99-108)
- Test: `src/web/static/resultPosters.test.ts`

**Interfaces:**
- Consumes: `previewApplies` (already imported), `OMDB_KEY_HINT`.
- Produces: `postersApply(group, omdbConfigured)` returns `true` for `"Anime"` regardless of key; `searchHint(...)` never nudges for a key on the Anime tab. Signatures unchanged, so `app.ts` call sites need no edits.

- [ ] **Step 1: Write the failing test**

Add to `src/web/static/resultPosters.test.ts`:

```typescript
import { postersApply, searchHint } from "./resultPosters";

describe("postersApply — Anime is keyless", () => {
  it("applies for Anime even without an OMDb key", () => {
    expect(postersApply("Anime", false)).toBe(true);
  });
  it("still requires a key for Movies", () => {
    expect(postersApply("Movies", false)).toBe(false);
    expect(postersApply("Movies", true)).toBe(true);
  });
  it("does not apply to a non-preview group regardless", () => {
    expect(postersApply("Games", true)).toBe(false);
  });
});

describe("searchHint — no OMDb nudge on the Anime tab", () => {
  it("returns null (no key hint) for Anime with no key", () => {
    expect(searchHint(false, "Anime", null)).toBeNull();
  });
  it("still nudges for a key on Movies with no key", () => {
    expect(searchHint(false, "Movies", null)).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/web/static/resultPosters.test.ts`
Expected: FAIL — `postersApply("Anime", false)` currently returns `false`; `searchHint(false, "Anime", null)` currently returns the key hint.

- [ ] **Step 3: Write minimal implementation**

Edit `postersApply`:

```typescript
export function postersApply(group: string, omdbConfigured: boolean): boolean {
  if (!previewApplies(group)) return false;
  // The Anime group uses AniList, which needs no key — so it previews whether or
  // not OMDb is configured. Every other group still needs an OMDb key, since a
  // keyless server would otherwise fire lookups that can only return no-key.
  if (group === "Anime") return true;
  return omdbConfigured;
}
```

Edit `searchHint` (add the Anime short-circuit after the `previewApplies` guard):

```typescript
export function searchHint(
  omdbConfigured: boolean | null,
  group: string,
  cacheHint: string | null,
): string | null {
  if (omdbConfigured === null) return null;
  if (!previewApplies(group)) return null;
  // Anime needs no OMDb key (AniList is keyless), so never nudge for one here.
  if (group === "Anime") return cacheHint;
  if (!omdbConfigured) return OMDB_KEY_HINT;
  return cacheHint;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/web/static/resultPosters.test.ts`
Expected: PASS (new cases + existing ones).

- [ ] **Step 5: Verify the client already passes group through (no code change expected)**

Run: `grep -n "postersApply(" src/web/static/app.ts`
Confirm each call passes the current tab group and `sources?.omdbConfigured === true`. Because the signature is unchanged and the Anime branch ignores the key, these call sites need no edit. If any call site hard-codes a non-Anime group, leave it. Do not change `app.ts` here.

- [ ] **Step 6: Commit**

```bash
git add src/web/static/resultPosters.ts src/web/static/resultPosters.test.ts
git commit -m "feat(web): preview anime posters without an OMDb key"
```

---

### Task 7: TUI — anime preview via AniList

**Files:**
- Modify: `src/ui/hooks/useTitlePreview.ts` — add `anime?` flag + `rawName` on the name query, branch the metadata fetch, relax the key gate.
- Modify: `src/ui/components/Results.tsx` — pass `anime` + `rawName`, relax `showPreview` for the anime section.

**Interfaces:**
- Consumes: `fetchAnimeFirstMeta` (Task 3).
- Produces: `useTitlePreview` accepts `anime?: boolean`; its `MetaQuery` name variant accepts `rawName?: string`.

- [ ] **Step 1: Extend `MetaQuery` and `Args` in `useTitlePreview.ts`**

In the `by: "name"` variant of `MetaQuery` (line ~10), add:

```typescript
      /** The raw release name, for AniList normalization on the anime path. */
      rawName?: string;
```

In `interface Args` (line ~40), add:

```typescript
  // Look this selection up on AniList first (Anime section), OMDb as fallback.
  // AniList is keyless, so the metadata effect below does not require an OMDb key
  // when this is set.
  anime?: boolean;
```

Destructure it in the hook body (line ~61), defaulting to `false`:

```typescript
    anime = false,
```

- [ ] **Step 2: Branch the metadata fetch and relax the key gate**

Add the import (top of file):

```typescript
import { fetchAnimeFirstMeta } from "../../recc/animeMeta";
```

Change the effect guard (line ~85) from:

```typescript
    if (!omdbApiKey || !enabled || !cacheKey || metas.current.has(cacheKey)) return;
```

to:

```typescript
    // Anime does not need an OMDb key (AniList is keyless); every other path
    // still does.
    if ((!omdbApiKey && !anime) || !enabled || !cacheKey || metas.current.has(cacheKey)) return;
```

Change the fetch dispatch (lines ~90-99) from:

```typescript
      const p =
        q.by === "id"
          ? fetchTitleMeta(q.imdbId, omdbApiKey, { fetchImpl })
          : fetchTitleMetaByName(q.title, omdbApiKey, {
              year: q.year,
              type: q.type,
              season: q.season,
              episode: q.episode,
              fetchImpl,
            });
```

to:

```typescript
      const p =
        q.by === "id"
          ? fetchTitleMeta(q.imdbId, omdbApiKey, { fetchImpl })
          : anime
            ? fetchAnimeFirstMeta({
                rawName: q.rawName ?? q.title,
                omdb: { title: q.title, year: q.year, type: q.type },
                omdbApiKey,
                fetchImpl,
              })
            : fetchTitleMetaByName(q.title, omdbApiKey, {
                year: q.year,
                type: q.type,
                season: q.season,
                episode: q.episode,
                fetchImpl,
              });
```

Add `anime` to the effect's dependency array (line ~115):

```typescript
  }, [omdbApiKey, enabled, cacheKey, fetchImpl, debounceMs, anime]);
```

- [ ] **Step 3: Wire `Results.tsx`**

Near `previewSection`/`showPreview` (lines ~530-535), add an anime flag and relax the key requirement:

```typescript
  const sectionIsAnime = section === "anime";
  const showPreview =
    previewOn &&
    (omdbApiKey !== "" || sectionIsAnime) &&
    previewSection &&
    mode !== "detail" &&
    contentWidth >= PREVIEW_MIN_WIDTH;
```

In the `useTitlePreview({ ... })` call (lines ~579-596), add `anime` and `rawName`:

```typescript
  const preview = useTitlePreview({
    omdbApiKey,
    enabled: showPreview,
    anime: sectionIsAnime,
    cacheKey: parsed
      ? `${parsed.key}|${previewEpisode ? `s${previewEpisode.season}e${previewEpisode.episode}` : ""}`
      : "",
    query: parsed
      ? {
          by: "name",
          title: parsed.title,
          year: parsed.year,
          type: parsed.type,
          rawName: selectedResult?.name,
          ...(previewEpisode ?? {}),
        }
      : null,
    posterCols: Math.max(8, previewWidth - 4),
    posterMaxRows: Math.max(4, panelOuter - 8),
  });
```

- [ ] **Step 4: Typecheck the TUI wiring**

Run: `npm run typecheck`
Expected: PASS (the one known pre-existing `exhaustive-deps` warning is lint, not typecheck; typecheck is clean).

- [ ] **Step 5: Verify at runtime**

Run: `npm run dev -- serve --web` and open the browser UI; run an anime search (e.g. the Anime tab) and confirm posters/plots now render with no OMDb key set. Then launch the TUI, go to the Anime section, and confirm the preview pane shows a poster/plot for a highlighted anime result. (No jsdom exists for this wiring — running it is the check, per CLAUDE.md.)

- [ ] **Step 6: Commit**

```bash
git add src/ui/hooks/useTitlePreview.ts src/ui/components/Results.tsx
git commit -m "feat(ui): preview anime via AniList in the terminal"
```

---

### Task 8: Docs + full gate

**Files:**
- Modify: `README.md` (the web UI limitations list and any OMDb-only phrasing about posters/metadata)

- [ ] **Step 1: Update README**

Grep for the web UI's limitations list and any statement that posters/metadata require OMDb:

```bash
grep -ni "omdb\|poster\|no metadata\|limitation" README.md
```

Edit the relevant lines so they read that anime posters/plots come from AniList (no key needed), while other groups still use OMDb (key required). Keep the existing tone. Do not touch `preview/web-*.jpg|png` screenshots.

- [ ] **Step 2: Full definition-of-done gate**

Run, in order, and confirm each is clean:

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

Expected: tests pass; typecheck clean; lint clean except the one known pre-existing `react-hooks/exhaustive-deps` warning in `src/ui/App.tsx`; build succeeds (this is also the check that `src/web/static` and `src/util/animeTitle.ts` pull in no `node:*`).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: anime metadata now comes from AniList"
```

---

## Self-Review

**Spec coverage:**
- AniList-first for Anime, OMDb fallback → Tasks 2, 3, 5, 7. ✓
- Always on, no key, no toggle → Tasks 5 (no-key gate skip), 6 (postersApply/searchHint), 7 (hook key gate); no config field added. ✓
- Series-level only, strip absolute episode → Task 1 (episode strip) + Task 3 (no season/episode to OMDb). ✓
- `imdbId` null for AniList → Task 2 mapping. ✓
- Title normalization pipeline → Task 1. ✓
- AniList GraphQL client shape/mapping/errors → Task 2. ✓
- Shared resolver as single home of ordering → Task 3, consumed by Tasks 5 & 7. ✓
- Poster host allowlist → Task 4. ✓
- Both front ends → web (Tasks 5, 6), TUI (Task 7). ✓
- Docs → Task 8. ✓
- All-tab limitation is intentionally *not* implemented (documented in spec). ✓ (No task, by design.)

**Placeholder scan:** No TBD/TODO. The `handleTitle`/`baseConfig` in Task 5 are explicitly flagged as stand-ins for the file's existing test harness, with instructions to grep and reuse it — because the exact harness name must match whatever `routes.test.ts` already defines.

**Type consistency:** `fetchAnimeMetaByName(title, opts)` (Task 2) is called by Task 3; `fetchAnimeFirstMeta(args)` signature (Task 3) matches the `WebDeps.fetchAnimeFirstMetaImpl` (Task 5) and the TUI call (Task 7). `FetchTitleMetaResult`/`OmdbType` reused from `omdb.ts` throughout. `postersApply`/`searchHint` signatures unchanged (Task 6), so no call-site drift.
