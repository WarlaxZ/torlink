# RuTracker Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add RuTracker as four category search sources (`rt-games`, `rt-movies`, `rt-tv`, `rt-anime`) with an in-app login flow, cookie persistence, and captcha fallback.

**Architecture:** A self-contained `src/sources/rutracker/` module (`session.ts` for auth + CP1251, `index.ts` for search + parsing) plugged into the existing source registry. Login is a new prompt-overlay component (`RutrackerPrompt.tsx`) mirroring `TokenPrompt`, triggered by an `R` keybind or after an auth-failed search. Four sources share one network sweep per query via an in-flight cache.

**Tech Stack:** TypeScript, React + Ink 7, undici (`fetchResilient` — already DoH-aware), vitest, ink-testing-library.

## Global Constraints

- Node >= 22, ESM (`"type": "module"`); relative imports omit extensions (project uses `tsup`/`tsx` resolution — match existing `import ... from "../types"` style).
- Never write the RuTracker password to disk — only `bb_*` cookies + username.
- All network calls go through `fetchResilient` from `src/util/net.ts` (keeps DoH + retries + our User-Agent).
- RuTracker is windows-1251 (CP1251) encoded — decode responses and encode the login form body accordingly.
- `SOURCE_STYLE` in `src/ui/theme.ts` is `Record<SourceId, …>` (exhaustive): adding a `SourceId` REQUIRES a matching entry or the build fails.
- Run `npm run typecheck` and `npm test` (vitest) before each commit; keep the tree green.
- Commit messages end with the `Co-Authored-By` trailer used in this repo.

---

### Task 1: Foundation — SourceIds, paths, cache helper, theme styles

Adds the four source IDs and everything that must change in lockstep to keep the build compiling (theme is exhaustive over `SourceId`). No sources registered yet, so runtime behaviour is unchanged.

**Files:**
- Modify: `src/sources/types.ts` (SourceId union)
- Modify: `src/config/paths.ts` (add `rutrackerFile`)
- Modify: `src/sources/cache.ts` (add `clearCacheByPrefix`)
- Modify: `src/ui/theme.ts` (`SOURCE_STYLE` entries)

**Interfaces:**
- Produces: `SourceId` gains `"rt-games" | "rt-movies" | "rt-tv" | "rt-anime"`; `rutrackerFile: string`; `clearCacheByPrefix(prefix: string): void`.

- [ ] **Step 1: Add the four SourceIds**

In `src/sources/types.ts`, extend the union:

```typescript
export type SourceId =
  | "fitgirl"
  | "yts"
  | "eztv"
  | "nyaa"
  | "subsplease"
  | "solid"
  | "torrents-csv"
  | "tpb-movies"
  | "tpb-tv"
  | "x1337-movies"
  | "x1337-tv"
  | "rt-games"
  | "rt-movies"
  | "rt-tv"
  | "rt-anime";
```

- [ ] **Step 2: Add the persistence path**

In `src/config/paths.ts`, after the `seedsFile` line, add:

```typescript
export const rutrackerFile = path.join(dataDir, "rutracker.json");
```

- [ ] **Step 3: Add the cache-eviction helper**

In `src/sources/cache.ts`, append:

```typescript
// Drop every cached entry whose source id starts with `prefix`. Used after a
// RuTracker login so the next search re-fetches with the fresh session.
export function clearCacheByPrefix(prefix: string): void {
  for (const k of cache.keys()) {
    if (k.startsWith(prefix)) cache.delete(k);
  }
}
```

(The cache key format is `${sourceId}::${query}`, so prefix `"rt-"` matches all four RuTracker sources.)

- [ ] **Step 4: Add theme styles (keeps the exhaustive Record valid)**

In `src/ui/theme.ts`, add four entries to `SOURCE_STYLE`:

```typescript
  "rt-games": { tag: "RUT", color: "#8fce5a" },
  "rt-movies": { tag: "RUT", color: "#8fce5a" },
  "rt-tv": { tag: "RUT", color: "#8fce5a" },
  "rt-anime": { tag: "RUT", color: "#8fce5a" },
```

- [ ] **Step 5: Verify it compiles**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/sources/types.ts src/config/paths.ts src/sources/cache.ts src/ui/theme.ts
git commit -m "feat(rutracker): add source ids, state path, cache eviction, theme styles

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Session module (auth + CP1251)

The login/cookie/captcha layer, fully unit-tested. Pure functions plus a `login()` that talks to RuTracker via `fetchResilient`.

**Files:**
- Create: `src/sources/rutracker/session.ts`
- Test: `src/sources/rutracker/session.test.ts`

**Interfaces:**
- Consumes: `rutrackerFile` (Task 1); `serializeWrites`, `writeJsonAtomic` from `src/util/atomic.ts`; `fetchResilient`, `HttpError`, `USER_AGENT` from `src/util/net.ts`.
- Produces:
  - `class AuthRequiredError extends Error`
  - `const RUTRACKER_HOSTS: string[]`
  - `interface RutrackerSession { cookie: string; username?: string; savedAt: number }`
  - `decodeCp1251(buf: ArrayBuffer): string`
  - `loadSession(): Promise<RutrackerSession | null>`, `getSession(): RutrackerSession | null`, `clearSession(): Promise<void>`
  - `interface Captcha { sid: string; field: string; imageUrl: string }`
  - `interface LoginCaptchaAnswer { sid: string; field: string; code: string }`
  - `type LoginOutcome = { kind: "ok"; session } | { kind: "captcha"; captcha } | { kind: "failed"; message }`
  - `login(username, password, opts?: { signal?; captcha?: LoginCaptchaAnswer }): Promise<LoginOutcome>`
  - internal-but-exported-for-test: `pickCookies`, `parseCaptcha`

- [ ] **Step 1: Write the failing tests**

Create `src/sources/rutracker/session.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { decodeCp1251, pickCookies, parseCaptcha } from "./session";

describe("decodeCp1251", () => {
  it("decodes Windows-1251 Cyrillic bytes", () => {
    const bytes = new Uint8Array([0xca, 0xe8, 0xed, 0xee]);
    expect(decodeCp1251(bytes.buffer)).toBe("Кино");
  });
});

describe("pickCookies", () => {
  it("keeps bb_* cookies and requires a real bb_session", () => {
    const cookie = pickCookies([
      "bb_session=abc123; path=/; HttpOnly",
      "bb_data=xyz; path=/",
      "other=nope; path=/",
    ]);
    expect(cookie).toBe("bb_session=abc123; bb_data=xyz");
  });

  it("returns null when bb_session is deleted or missing", () => {
    expect(pickCookies(["bb_session=deleted; path=/"])).toBeNull();
    expect(pickCookies(["bb_data=xyz; path=/"])).toBeNull();
  });
});

describe("parseCaptcha", () => {
  it("extracts sid, dynamic field name, and image url", () => {
    const html = `
      <input type="hidden" name="cap_sid" value="SID123">
      <img src="//static.rutracker.cc/captcha/1234.jpg">
      <input type="text" name="cap_code_abc">`;
    const cap = parseCaptcha(html);
    expect(cap).toEqual({
      sid: "SID123",
      field: "cap_code_abc",
      imageUrl: "https://static.rutracker.cc/captcha/1234.jpg",
    });
  });

  it("returns null when there is no captcha", () => {
    expect(parseCaptcha("<p>no captcha here</p>")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/sources/rutracker/session.test.ts`
Expected: FAIL — cannot resolve `./session`.

- [ ] **Step 3: Implement the session module**

Create `src/sources/rutracker/session.ts`:

```typescript
import { promises as fs } from "node:fs";
import { rutrackerFile } from "../../config/paths";
import { serializeWrites, writeJsonAtomic } from "../../util/atomic";
import { fetchResilient, HttpError, USER_AGENT } from "../../util/net";

export class AuthRequiredError extends Error {
  constructor(message = "Rutracker needs login") {
    super(message);
    this.name = "AuthRequiredError";
  }
}

export const RUTRACKER_HOSTS = ["rutracker.org", "rutracker.net", "rutracker.nl"];

export interface RutrackerSession {
  cookie: string;
  username?: string;
  savedAt: number;
}

const decoder = new TextDecoder("windows-1251");

export function decodeCp1251(buf: ArrayBuffer): string {
  return decoder.decode(buf);
}

const HIGH_BYTE = new Map<string, number>();
for (let b = 0x80; b <= 0xff; b++) {
  const ch = decoder.decode(new Uint8Array([b]));
  if (ch && ch !== "�") HIGH_BYTE.set(ch, b);
}

function encodeCp1251Form(value: string): string {
  let out = "";
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) {
      out += encodeURIComponent(ch);
    } else {
      const byte = HIGH_BYTE.get(ch);
      out += byte === undefined ? "%3F" : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

let current: RutrackerSession | null = null;
let loaded = false;
const write = serializeWrites();

export async function loadSession(): Promise<RutrackerSession | null> {
  if (loaded) return current;
  loaded = true;
  try {
    const raw = await fs.readFile(rutrackerFile, "utf8");
    const parsed = JSON.parse(raw) as Partial<RutrackerSession>;
    if (parsed && typeof parsed.cookie === "string" && parsed.cookie) {
      current = {
        cookie: parsed.cookie,
        username: typeof parsed.username === "string" ? parsed.username : undefined,
        savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : Date.now(),
      };
    }
  } catch {
    current = null;
  }
  return current;
}

export function getSession(): RutrackerSession | null {
  return current;
}

async function saveSession(session: RutrackerSession): Promise<void> {
  current = session;
  loaded = true;
  await write(() => writeJsonAtomic(rutrackerFile, session));
}

export async function clearSession(): Promise<void> {
  current = null;
  loaded = true;
  await write(() => fs.rm(rutrackerFile, { force: true }));
}

// CP1251 bytes for the RuTracker login submit button value ("вход").
const LOGIN_SUBMIT = "%E2%F5%EE%E4";

export function pickCookies(setCookie: string[]): string | null {
  const wanted = new Map<string, string>();
  for (const line of setCookie) {
    const pair = line.split(";", 1)[0]!.trim();
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;

    const name = pair.slice(0, eq);
    const value = pair.slice(eq + 1);

    if (name === "bb_session" && (!value || value === "deleted")) return null;
    if (name.startsWith("bb_")) wanted.set(name, value);
  }
  if (!wanted.has("bb_session")) return null;
  return [...wanted].map(([k, v]) => `${k}=${v}`).join("; ");
}

export interface Captcha {
  sid: string;
  field: string;
  imageUrl: string;
}

export type LoginOutcome =
  | { kind: "ok"; session: RutrackerSession }
  | { kind: "captcha"; captcha: Captcha }
  | { kind: "failed"; message: string };

export function parseCaptcha(html: string): Captcha | null {
  const sid = html.match(/name="cap_sid"\s+value="([^"]+)"/i)?.[1];
  const field = html.match(/name="(cap_code_[^"]+)"/i)?.[1];
  const img = html.match(/<img[^>]+src="([^"]*captcha[^"]*)"/i)?.[1];
  if (!sid || !field || !img) return null;
  const imageUrl = img.startsWith("//") ? `https:${img}` : img;
  return { sid, field, imageUrl };
}

export interface LoginCaptchaAnswer {
  sid: string;
  field: string;
  code: string;
}

export async function login(
  username: string,
  password: string,
  opts: { signal?: AbortSignal; captcha?: LoginCaptchaAnswer } = {},
): Promise<LoginOutcome> {
  const u = username.trim();
  if (!u || !password) return { kind: "failed", message: "Enter a username and password." };

  let body =
    `login_username=${encodeCp1251Form(u)}` +
    `&login_password=${encodeCp1251Form(password)}` +
    `&login=${LOGIN_SUBMIT}`;
  if (opts.captcha) {
    body +=
      `&cap_sid=${encodeURIComponent(opts.captcha.sid)}` +
      `&${encodeURIComponent(opts.captcha.field)}=${encodeCp1251Form(opts.captcha.code)}`;
  }

  let lastError: unknown;
  for (const host of RUTRACKER_HOSTS) {
    try {
      const res = await fetchResilient(`https://${host}/forum/login.php`, {
        method: "POST",
        headers: {
          "User-Agent": USER_AGENT,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
        redirect: "manual",
        signal: opts.signal,
        retries: 1,
      });

      const cookie = pickCookies(res.headers.getSetCookie());
      if (cookie) {
        const session: RutrackerSession = { cookie, username: u, savedAt: Date.now() };
        await saveSession(session);
        return { kind: "ok", session };
      }

      const captcha = parseCaptcha(decodeCp1251(await res.arrayBuffer()));
      if (captcha) return { kind: "captcha", captcha };
      return {
        kind: "failed",
        message: opts.captcha
          ? "Incorrect captcha or credentials."
          : "Login failed — check your username and password.",
      };
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      lastError = e;
    }
  }

  throw lastError instanceof Error ? lastError : new HttpError(0, "Rutracker unreachable");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/sources/rutracker/session.test.ts`
Expected: PASS (all 6).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/sources/rutracker/session.ts src/sources/rutracker/session.test.ts
git commit -m "feat(rutracker): session auth, cookie persistence, CP1251, captcha parse

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Search + parsing module

The four sources, HTML parsing, forum→group inference, and the shared single-sweep fetch.

**Files:**
- Create: `src/sources/rutracker/index.ts`
- Test: `src/sources/rutracker/parse.test.ts`

**Interfaces:**
- Consumes: from `./session`: `AuthRequiredError`, `decodeCp1251`, `getSession`, `loadSession`, `RUTRACKER_HOSTS`. From `../rss`: `unescapeEntities`. From `../magnet`: `normalizeInfoHash`. From `../../util/net`: `fetchResilient`, `HttpError`, `USER_AGENT`. Types from `../types`.
- Produces:
  - `buildGroupMap(html: string): Map<number, SourceGroup>`
  - `parseRows(html: string, groupMap?: Map<number, SourceGroup>): Row[]` where `Row = { topicId; name; group; seeders; leechers; sizeBytes; added? }`
  - `clearRutrackerCache(): void`
  - `rutrackerGames`, `rutrackerMovies`, `rutrackerTv`, `rutrackerAnime` (each a `Source`)
  - re-export `AuthRequiredError`

- [ ] **Step 1: Write the failing tests**

Create `src/sources/rutracker/parse.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { parseRows, buildGroupMap } from "./index";
import { decodeCp1251 } from "./session";

const ROW = (forum: string, title: string, forumId = 635) => `
<tr class="tCenter hl-tr">
  <td class="row1 f-name-col"><div class="f-name"><a class="gen f" href="tracker.php?f=${forumId}">${forum}</a></div></td>
  <td class="row4 med tLeft t-title-col tt"><div class="wbr t-title"><a data-topic_id="123" class="med tLink bold" href="viewtopic.php?t=123">${title}</a></div></td>
  <td class="row4 small nowrap tor-size" data-ts_text="13192355840"><a class="small tr-dl dl-stub" href="dl.php?t=123">12.3 GB</a></td>
  <td class="row4 nowrap" data-ts_text="42"><b class="seedmed">42</b></td>
  <td class="row4 leechmed bold" data-ts_text="3">3</td>
  <td class="row4 small nowrap" data-ts_text="1700000000">date</td>
</tr>`;

const TABLE = (rows: string) => `<table id="tor-tbl"><tbody>${rows}</tbody></table>`;

describe("parseRows", () => {
  it("extracts the size, seeders, leechers and added timestamp", () => {
    const rows = parseRows(TABLE(ROW("Зарубежное кино", "Dune Part Two 2024 2160p")));
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.topicId).toBe("123");
    expect(r.name).toBe("Dune Part Two 2024 2160p");
    expect(r.sizeBytes).toBe(13192355840);
    expect(r.seeders).toBe(42);
    expect(r.leechers).toBe(3);
    expect(r.added).toBe(1700000000);
  });

  it("classifies by forum name when no forum map is available", () => {
    const groupFor = (forum: string) => parseRows(TABLE(ROW(forum, "Title")))[0]?.group;
    expect(groupFor("Аниме (HD Video)")).toBe("Anime");
    expect(groupFor("PC игры")).toBe("Games");
    expect(groupFor("Зарубежные сериалы")).toBe("TV");
    expect(groupFor("Зарубежное кино")).toBe("Movies");
  });

  it("drops results that aren't one of the four tabs", () => {
    expect(parseRows(TABLE(ROW("Рок-музыка (lossless)", "Some Album")))).toHaveLength(0);
    expect(parseRows(TABLE("<tr><td>nothing</td></tr>"))).toHaveLength(0);
  });
});

const SELECT = `
<select name="f[]" multiple="multiple">
  <optgroup label="&nbsp;Кино, Видео и ТВ">
    <option id="fs-7" value="7" class='root_forum has_sf' >Зарубежное кино&nbsp;</option>
    <option id="fs-313" value="313" class='fp-7' > |- Зарубежное кино (HD Video)&nbsp;</option>
    <option id="fs-33" value="33" class='root_forum has_sf' >Аниме&nbsp;</option>
    <option id="fs-1390" value="1390" class='fp-33' > |- Наруто&nbsp;</option>
  </optgroup>
  <optgroup label="&nbsp;Сериалы">
    <option id="fs-266" value="266" class='fp-189' > |- Сериалы США и Канады (HD Video)&nbsp;</option>
  </optgroup>
  <optgroup label="&nbsp;Игры">
    <option id="fs-973" value="973" class='fp-548' > |- PS4&nbsp;</option>
  </optgroup>
  <optgroup label="&nbsp;Музыка">
    <option id="fs-408" value="408" class='fp-409' > |- Поп-музыка (lossless)&nbsp;</option>
  </optgroup>
</select>`;

describe("buildGroupMap", () => {
  const map = buildGroupMap(SELECT);
  it("maps top sections onto the four tabs", () => {
    expect(map.get(313)).toBe("Movies");
    expect(map.get(266)).toBe("TV");
    expect(map.get(973)).toBe("Games");
  });
  it("overrides the section for anime nested under films", () => {
    expect(map.get(33)).toBe("Anime");
    expect(map.get(1390)).toBe("Anime");
  });
  it("omits sections with no tab", () => {
    expect(map.has(408)).toBe(false);
  });
});

describe("parseRows with a forum map", () => {
  it("classifies a title-only anime forum by id, not its name", () => {
    const map = buildGroupMap(SELECT);
    const rows = parseRows(TABLE(ROW("Наруто", "Naruto Shippuuden", 1390)), map);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.group).toBe("Anime");
  });
});

describe("decodeCp1251", () => {
  it("decodes Windows-1251 Cyrillic bytes", () => {
    const bytes = new Uint8Array([0xca, 0xe8, 0xed, 0xee]);
    expect(decodeCp1251(bytes.buffer)).toBe("Кино");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/sources/rutracker/parse.test.ts`
Expected: FAIL — cannot resolve `./index`.

- [ ] **Step 3: Implement the search module**

Create `src/sources/rutracker/index.ts`:

```typescript
import { fetchResilient, HttpError, USER_AGENT } from "../../util/net";
import { unescapeEntities } from "../rss";
import { normalizeInfoHash } from "../magnet";
import type {
  SearchOptions,
  Source,
  SourceGroup,
  SourceId,
  TorrentResult,
} from "../types";
import {
  AuthRequiredError,
  decodeCp1251,
  getSession,
  loadSession,
  RUTRACKER_HOSTS,
} from "./session";

export { AuthRequiredError } from "./session";

const MAX_DETAILS = 12;

interface Row {
  topicId: string;
  name: string;
  group: SourceGroup;
  seeders: number;
  leechers: number;
  sizeBytes: number;
  added?: number;
}

const SECTION_GROUP: Record<string, SourceGroup> = {
  "Сериалы": "TV",
  "Игры": "Games",
  "Кино, Видео и ТВ": "Movies",
  "Документалистика и юмор": "Movies",
};

const ANIME_RE = /аниме|anime|манга|manga|ранобэ/i;

const KEYWORD_RULES: { group: SourceGroup; re: RegExp }[] = [
  { group: "Anime", re: ANIME_RE },
  { group: "TV", re: /сериал|телесериал/i },
  { group: "Games", re: /игр|game|консол|playstation|xbox|nintendo|ps[2345]|repack/i },
  { group: "Movies", re: /кино|фильм|видео|мультфильм|movie/i },
];

const GROUP_SOURCE: Record<SourceGroup, SourceId> = {
  Games: "rt-games",
  Movies: "rt-movies",
  TV: "rt-tv",
  Anime: "rt-anime",
};

interface ForumNode {
  name: string;
  parent?: number;
  section: string;
}

export function buildGroupMap(html: string): Map<number, SourceGroup> {
  const sel = html.match(/<select[^>]*name="f\[\]"[\s\S]*?<\/select>/i)?.[0];
  if (!sel) return new Map();

  const nodes = new Map<number, ForumNode>();
  const re = /<optgroup label="([^"]*)"|<option[^>]*value="(-?\d+)"[^>]*class='([^']*)'[^>]*>([\s\S]*?)<\/option>/g;
  let section = "";
  let m: RegExpExecArray | null;
  while ((m = re.exec(sel))) {
    if (m[1] !== undefined) {
      section = stripTags(m[1]);
      continue;
    }

    const id = Number(m[2]);
    if (id < 0) continue;

    const parent = m[3]!.match(/fp-(\d+)/);
    const name = stripTags(m[4]!).replace(/^\|-\s*/, "");

    nodes.set(id, { name, parent: parent ? Number(parent[1]) : undefined, section });
  }

  const isAnime = (id: number): boolean => {
    let cur: number | undefined = id;
    for (let i = 0; cur !== undefined && i < 12; i++) {
      const node = nodes.get(cur);
      if (!node) break;
      if (ANIME_RE.test(node.name)) return true;
      cur = node.parent;
    }

    return false;
  };

  const out = new Map<number, SourceGroup>();
  for (const [id, node] of nodes) {
    const group =
      node.section === "Сериалы"
        ? "TV"
        : isAnime(id)
          ? "Anime"
          : SECTION_GROUP[node.section];
    if (group) out.set(id, group);
  }

  return out;
}

function keywordGroup(forum: string): SourceGroup | null {
  for (const r of KEYWORD_RULES) if (r.re.test(forum)) return r.group;
  return null;
}

function stripTags(html: string): string {
  return unescapeEntities(
    html
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

export function parseRows(html: string, groupMap?: Map<number, SourceGroup>): Row[] {
  const map = groupMap ?? buildGroupMap(html);
  const start = html.indexOf("tor-tbl");
  const body = start >= 0 ? html.slice(start) : html;
  const out: Row[] = [];
  for (const tr of body.split(/<tr[\s>]/i).slice(1)) {
    const topic = tr.match(/viewtopic\.php\?t=(\d+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!topic) continue;
    const name = stripTags(topic[2]!);
    if (!name) continue;
    const forumLink = tr.match(/tracker\.php\?f=(\d+)"[^>]*>([\s\S]*?)<\/a>/i);
    const forumId = forumLink ? Number(forumLink[1]) : undefined;
    const group =
      (forumId !== undefined ? map.get(forumId) : undefined) ??
      keywordGroup(stripTags(forumLink?.[2] ?? ""));
    if (!group) continue;
    const sizeBytes = Number(
      tr.match(/class="[^"]*tor-size[^"]*"[^>]*data-ts_text="(\d+)"/i)?.[1] ??
      0,
    );
    const seeders = Number(
      tr.match(/class="[^"]*seedmed[^"]*"[^>]*>\s*(\d+)/i)?.[1] ?? 0,
    );
    const leechers = Number(
      tr.match(/class="[^"]*leechmed[^"]*"[^>]*>\s*(\d+)/i)?.[1] ?? 0,
    );
    const stamps = [...tr.matchAll(/data-ts_text="(\d{9,11})"/gi)].map((mm) =>
      Number(mm[1]),
    );
    const added = stamps
      .reverse()
      .find((n) => n >= 1_000_000_000 && n <= 4_000_000_000);
    out.push({
      topicId: topic[1]!,
      name,
      group,
      seeders,
      leechers,
      sizeBytes,
      added,
    });
  }
  return out;
}

async function fetchText(
  url: string,
  cookie: string,
  opts: SearchOptions,
  retries: number,
): Promise<{ html: string; status: number }> {
  const res = await fetchResilient(url, {
    headers: { "User-Agent": USER_AGENT, Cookie: cookie },
    signal: opts.signal,
    retries,
  });
  const html = decodeCp1251(await res.arrayBuffer());
  return { html, status: res.status };
}

async function topicMagnet(
  base: string,
  cookie: string,
  topicId: string,
  opts: SearchOptions,
): Promise<string | null> {
  try {
    const { html } = await fetchText(
      `${base}/forum/viewtopic.php?t=${topicId}`,
      cookie,
      opts,
      1,
    );
    const raw = html.match(/magnet:\?xt=urn:btih:[^"'<>\s]+/i)?.[0];
    return raw ? unescapeEntities(raw) : null;
  } catch {
    return null;
  }
}

interface FetchEntry {
  at: number;
  cookie: string;
  promise: Promise<TorrentResult[]>;
}
const FETCH_TTL_MS = 60_000;
const inflight = new Map<string, FetchEntry>();

async function fetchAll(
  query: string,
  opts: SearchOptions,
): Promise<TorrentResult[]> {
  await loadSession();
  const session = getSession();
  if (!session) throw new AuthRequiredError();

  const q = query.trim();
  const path = q
    ? `/forum/tracker.php?nm=${encodeURIComponent(q)}`
    : `/forum/tracker.php?nm=`;

  let base = "";
  let html = "";
  let lastError: unknown;
  for (const host of RUTRACKER_HOSTS) {
    try {
      const candidate = `https://${host}`;
      const res = await fetchText(
        `${candidate}${path}`,
        session.cookie,
        opts,
        2,
      );
      if (/id="login-form|name="login_username"/i.test(res.html) && !res.html.includes("tor-tbl")) {
        throw new AuthRequiredError(
          "Rutracker session expired — log in again.",
        );
      }
      html = res.html;
      base = candidate;
      break;
    } catch (e) {
      if (opts.signal?.aborted || e instanceof AuthRequiredError) throw e;
      lastError = e;
    }
  }

  if (!base) {
    throw lastError instanceof Error ? lastError : new HttpError(0, "Rutracker unreachable");
  }

  const rows = parseRows(html, buildGroupMap(html));
  rows.sort((a, b) => b.seeders - a.seeders);
  const top = rows.slice(0, MAX_DETAILS);

  const settled = await Promise.all(
    top.map(async (row): Promise<TorrentResult | null> => {
      const magnet = await topicMagnet(base, session.cookie, row.topicId, opts);
      const infoHash = magnet?.match(/urn:btih:([a-z0-9]+)/i)?.[1];
      if (!magnet || !infoHash) return null;
      return {
        infoHash: normalizeInfoHash(infoHash),
        name: row.name,
        sizeBytes: row.sizeBytes,
        seeders: row.seeders,
        leechers: row.leechers,
        source: GROUP_SOURCE[row.group],
        magnet,
        added: row.added,
      };
    }),
  );
  return settled.filter((r): r is TorrentResult => r !== null);
}

function sharedFetch(
  query: string,
  opts: SearchOptions,
): Promise<TorrentResult[]> {
  const session = getSession();
  const key = query.trim().toLowerCase();
  const hit = inflight.get(key);
  if (
    hit &&
    Date.now() - hit.at < FETCH_TTL_MS &&
    hit.cookie === (session?.cookie ?? "")
  ) {
    return hit.promise;
  }
  const promise = fetchAll(query, opts);
  inflight.set(key, { at: Date.now(), cookie: session?.cookie ?? "", promise });
  promise.catch(() => inflight.delete(key));
  return promise;
}

export function clearRutrackerCache(): void {
  inflight.clear();
}

function makeSource(id: SourceId, group: SourceGroup): Source {
  return {
    id,
    label: "RuTracker",
    group,
    homepage: "https://rutracker.org",
    search: async (query, opts = {}) => {
      const all = await sharedFetch(query, opts);
      return all.filter((r) => r.source === id);
    },
  };
}

export const rutrackerGames = makeSource("rt-games", "Games");
export const rutrackerMovies = makeSource("rt-movies", "Movies");
export const rutrackerTv = makeSource("rt-tv", "TV");
export const rutrackerAnime = makeSource("rt-anime", "Anime");
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/sources/rutracker/parse.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/sources/rutracker/index.ts src/sources/rutracker/parse.test.ts
git commit -m "feat(rutracker): search, HTML parsing, forum-to-group mapping, shared fetch

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Register the sources

Wire the four sources into the registry so they appear in search and `SourcesPrompt`.

**Files:**
- Modify: `src/sources/registry.ts`
- Modify: `src/sources/registry.test.ts` (add coverage)

**Interfaces:**
- Consumes: `rutrackerGames`, `rutrackerMovies`, `rutrackerTv`, `rutrackerAnime` (Task 3).

- [ ] **Step 1: Add a failing registry test**

In `src/sources/registry.test.ts`, add (adapt to the file's existing import style):

```typescript
import { SOURCES } from "./registry";

it("includes the four RuTracker sources", () => {
  const ids = SOURCES.map((s) => s.id);
  expect(ids).toEqual(
    expect.arrayContaining(["rt-games", "rt-movies", "rt-tv", "rt-anime"]),
  );
  for (const s of SOURCES.filter((x) => x.id.startsWith("rt-"))) {
    expect(s.label).toBe("RuTracker");
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/sources/registry.test.ts`
Expected: FAIL — RuTracker ids not present.

- [ ] **Step 3: Register the sources**

In `src/sources/registry.ts`, add the import near the others:

```typescript
import {
  rutrackerGames,
  rutrackerMovies,
  rutrackerTv,
  rutrackerAnime,
} from "./rutracker";
```

Then append them to the `SOURCES` array (order controls status-line order — place each RuTracker entry after the last source of its group; simplest is to append all four at the end):

```typescript
  rutrackerGames,
  rutrackerMovies,
  rutrackerTv,
  rutrackerAnime,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/sources/registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/sources/registry.ts src/sources/registry.test.ts
git commit -m "feat(rutracker): register the four RuTracker sources

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Login prompt component

A prompt-overlay for entering credentials and (when required) a captcha code. Modelled on `TokenPrompt`; captcha image is a clickable hyperlink + copy-link.

**Files:**
- Create: `src/ui/components/RutrackerPrompt.tsx`
- Test: `src/ui/components/RutrackerPrompt.test.tsx`

**Interfaces:**
- Consumes: `TextField`, `Panel` (existing components); `COLOR`, `ICON` from `../theme`; `hyperlink` from `../../util/terminal`; `writeClipboard` from `../../util/clipboard`; `Captcha` type from `../../sources/rutracker/session`.
- Produces:
  - `type LoginStatus = { kind: "idle" } | { kind: "busy" } | { kind: "error"; message: string }`
  - `RutrackerPrompt` React component with props:
    ```typescript
    interface RutrackerPromptProps {
      width: number;
      currentUser?: string;
      status: LoginStatus;
      captcha?: Captcha;
      onSubmit: (username: string, password: string, captchaCode?: string) => void;
      onCopyCaptcha: (url: string) => void;
      onCancel: () => void;
    }
    ```

- [ ] **Step 1: Write the failing test**

Create `src/ui/components/RutrackerPrompt.test.tsx`:

```typescript
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { RutrackerPrompt } from "./RutrackerPrompt";

describe("RutrackerPrompt", () => {
  it("renders the username and password fields", () => {
    const { lastFrame } = render(
      <RutrackerPrompt
        width={60}
        status={{ kind: "idle" }}
        onSubmit={() => {}}
        onCopyCaptcha={() => {}}
        onCancel={() => {}}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Username");
    expect(frame).toContain("Password");
  });

  it("shows a captcha hint when a captcha is required", () => {
    const { lastFrame } = render(
      <RutrackerPrompt
        width={60}
        status={{ kind: "idle" }}
        captcha={{ sid: "s", field: "cap_code_x", imageUrl: "https://x/y.jpg" }}
        onSubmit={() => {}}
        onCopyCaptcha={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(lastFrame() ?? "").toContain("Captcha");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/ui/components/RutrackerPrompt.test.tsx`
Expected: FAIL — cannot resolve `./RutrackerPrompt`.

- [ ] **Step 3: Implement the component**

Create `src/ui/components/RutrackerPrompt.tsx`:

```tsx
import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { TextField } from "./TextField";
import { Panel } from "./Panel";
import { COLOR, ICON } from "../theme";
import { hyperlink } from "../../util/terminal";
import type { Captcha } from "../../sources/rutracker/session";

export type LoginStatus =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "error"; message: string };

type FieldKey = "user" | "pass" | "captcha" | "copy";

interface RutrackerPromptProps {
  width: number;
  currentUser?: string;
  status: LoginStatus;
  captcha?: Captcha;
  onSubmit: (username: string, password: string, captchaCode?: string) => void;
  onCopyCaptcha: (url: string) => void;
  onCancel: () => void;
}

function Field({
  label,
  active,
  children,
}: {
  label: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Box>
      <Box width={10} flexShrink={0}>
        <Text color={active ? COLOR.accent : undefined} dimColor={!active}>
          {label}
        </Text>
      </Box>
      <Text color={active ? COLOR.accent : COLOR.alt}>{`${ICON.pointer} `}</Text>
      <Box flexGrow={1} minWidth={0}>
        {children}
      </Box>
    </Box>
  );
}

export function RutrackerPrompt({
  width,
  currentUser,
  status,
  captcha,
  onSubmit,
  onCopyCaptcha,
  onCancel,
}: RutrackerPromptProps) {
  const [field, setField] = useState<FieldKey>("user");
  const [username, setUsername] = useState(currentUser ?? "");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const busy = status.kind === "busy";

  const submit = (): void => {
    if (!username.trim() || !password) return;
    if (captcha && !code.trim()) return;
    onSubmit(username.trim(), password, captcha ? code.trim() : undefined);
  };

  const order: FieldKey[] = captcha ? ["user", "pass", "captcha", "copy"] : ["user", "pass"];

  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (busy) return;
    if (key.return && field === "copy" && captcha) {
      onCopyCaptcha(captcha.imageUrl);
      return;
    }
    if (key.upArrow) {
      const i = order.indexOf(field);
      setField(order[Math.max(0, i - 1)]!);
    } else if (key.downArrow) {
      const i = order.indexOf(field);
      setField(order[Math.min(order.length - 1, i + 1)]!);
    }
  });

  return (
    <Box flexDirection="column" width={width}>
      <Panel title="rutracker login" width={width} focused height={captcha ? 9 : 4}>
        <Field label="Username" active={field === "user" && !busy}>
          <TextField
            isDisabled={busy || field !== "user"}
            defaultValue={username}
            placeholder="username"
            onChange={setUsername}
            onSubmit={() => setField("pass")}
            onExitDown={() => setField("pass")}
          />
        </Field>
        <Field label="Password" active={field === "pass" && !busy}>
          <TextField
            isDisabled={busy || field !== "pass"}
            mask
            placeholder="password"
            onChange={setPassword}
            onSubmit={() => (captcha ? setField("captcha") : submit())}
            onExitDown={() => captcha && setField("captcha")}
          />
        </Field>
        {captcha ? (
          <>
            <Box marginTop={1}>
              <Text color={COLOR.warn}>
                {`${ICON.warn} Captcha required — open `}
                {hyperlink(captcha.imageUrl, "the image")}
                {`, then type the code.`}
              </Text>
            </Box>
            <Field label="Captcha" active={field === "captcha" && !busy}>
              <TextField
                isDisabled={busy || field !== "captcha"}
                placeholder="code from image"
                onChange={setCode}
                onSubmit={submit}
              />
            </Field>
            <Box>
              <Box width={10} flexShrink={0} />
              <Text
                color={field === "copy" ? COLOR.accent : COLOR.alt}
                inverse={field === "copy"}
                bold={field === "copy"}
              >
                {" Copy link "}
              </Text>
            </Box>
          </>
        ) : null}
        <Box marginTop={1}>
          {status.kind === "busy" ? (
            <Text dimColor>Signing in…</Text>
          ) : status.kind === "error" ? (
            <Text color={COLOR.bad}>{`${ICON.error} ${status.message}`}</Text>
          ) : currentUser ? (
            <Text dimColor>{`Signed in as ${currentUser}. Re-enter to switch accounts.`}</Text>
          ) : (
            <Text dimColor>Credentials are sent only to rutracker.org.</Text>
          )}
        </Box>
      </Panel>
      <Box marginTop={1}>
        <Text color={COLOR.alt}>↵</Text>
        <Text dimColor> next / sign in</Text>
        <Text dimColor>{`     ${ICON.dot}     `}</Text>
        <Text color={COLOR.alt}>↑↓</Text>
        <Text dimColor> field</Text>
        <Text dimColor>{`     ${ICON.dot}     `}</Text>
        <Text color={COLOR.alt}>esc</Text>
        <Text dimColor> cancel</Text>
      </Box>
    </Box>
  );
}
```

Note: verify `TextField`'s props (`isDisabled`, `mask`, `defaultValue`, `placeholder`, `onChange`, `onSubmit`, `onExitDown`) against `src/ui/components/TextField.tsx` before implementing; adjust prop names to match our fork if they differ.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/ui/components/RutrackerPrompt.test.tsx`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/ui/components/RutrackerPrompt.tsx src/ui/components/RutrackerPrompt.test.tsx
git commit -m "feat(rutracker): login prompt component with captcha fallback

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Wire login into the app (keybind, prompt, auth-notice)

Hook the prompt into `App.tsx` following the existing `editingToken` pattern: an `R` keybind opens it, a failed-auth RuTracker search surfaces a notice, and a successful login clears caches so results refresh.

**Files:**
- Modify: `src/ui/App.tsx`
- Modify: `src/ui/keymap.ts` (help hint)

**Interfaces:**
- Consumes: `RutrackerPrompt`, `LoginStatus` (Task 5); `login`, `clearSession`, `getSession`, `loadSession`, `AuthRequiredError` from `../sources/rutracker/session`; `clearRutrackerCache` from `../sources/rutracker`; `clearCacheByPrefix` from `../sources/cache`; `writeClipboard` from `../util/clipboard`; store's `setNotice`.

- [ ] **Step 1: Add the help hint**

In `src/ui/keymap.ts`, in the `HELP_GROUPS` "Navigate" hints array, after the `D` (Custom DNS) entry add:

```typescript
      { keys: "R", label: "RuTracker login" },
```

- [ ] **Step 2: Add imports in App.tsx**

Near the other component imports:

```typescript
import { RutrackerPrompt, type LoginStatus } from "./components/RutrackerPrompt";
```

Near the other source/session imports:

```typescript
import {
  login as rutrackerLogin,
  clearSession as clearRutrackerSession,
  getSession as getRutrackerSession,
  loadSession as loadRutrackerSession,
  type Captcha,
} from "../sources/rutracker/session";
import { clearRutrackerCache } from "../sources/rutracker";
import { clearCacheByPrefix } from "../sources/cache";
import { writeClipboard } from "../util/clipboard";
```

- [ ] **Step 3: Add prompt state**

Alongside the other `editing*` state declarations (`editingDns`, etc.):

```typescript
const [editingRutracker, setEditingRutracker] = useState(false);
const [rutrackerStatus, setRutrackerStatus] = useState<LoginStatus>({ kind: "idle" });
const [rutrackerCaptcha, setRutrackerCaptcha] = useState<Captcha | undefined>(undefined);
const [rutrackerUser, setRutrackerUser] = useState<string | undefined>(undefined);
```

- [ ] **Step 4: Load any saved session on mount**

Add an effect (near other mount effects):

```typescript
useEffect(() => {
  void loadRutrackerSession().then((s) => setRutrackerUser(s?.username));
}, []);
```

- [ ] **Step 5: Add open/close/submit handlers**

```typescript
const openRutrackerPrompt = useCallback(() => {
  setRutrackerCaptcha(undefined);
  setRutrackerStatus({ kind: "idle" });
  setRutrackerUser(getRutrackerSession()?.username);
  setEditingRutracker(true);
}, []);

const closeRutrackerPrompt = useCallback(() => {
  setEditingRutracker(false);
  setRutrackerStatus({ kind: "idle" });
  setRutrackerCaptcha(undefined);
}, []);

const submitRutrackerLogin = useCallback(
  (username: string, password: string, captchaCode?: string) => {
    setRutrackerStatus({ kind: "busy" });
    const captchaAnswer =
      rutrackerCaptcha && captchaCode
        ? { sid: rutrackerCaptcha.sid, field: rutrackerCaptcha.field, code: captchaCode }
        : undefined;
    void rutrackerLogin(username, password, { captcha: captchaAnswer })
      .then((outcome) => {
        if (outcome.kind === "ok") {
          setRutrackerUser(outcome.session.username);
          clearRutrackerCache();
          clearCacheByPrefix("rt-");
          setNotice(`${ICON.done} Signed in to RuTracker`);
          closeRutrackerPrompt();
        } else if (outcome.kind === "captcha") {
          setRutrackerCaptcha(outcome.captcha);
          setRutrackerStatus({ kind: "idle" });
        } else {
          setRutrackerStatus({ kind: "error", message: outcome.message });
        }
      })
      .catch((e: unknown) => {
        setRutrackerStatus({
          kind: "error",
          message: e instanceof Error ? e.message : "Couldn't reach RuTracker.",
        });
      });
  },
  [rutrackerCaptcha, setNotice, closeRutrackerPrompt],
);

const copyCaptchaLink = useCallback(
  (url: string) => {
    void writeClipboard(url).then((ok) =>
      setNotice(ok ? `${ICON.done} Captcha link copied` : "Couldn't copy the captcha link."),
    );
  },
  [setNotice],
);
```

(Confirm `setNotice` and `ICON` are already imported/available in `App.tsx`; `ICON` comes from `./theme`, `setNotice` from the store. Add imports only if missing.)

- [ ] **Step 6: Open on the `R` keybind**

In the global `useInput` handler, alongside the existing config-key handling (where `k`/`S`/`D` open their prompts), add a branch. Match the file's existing structure — if keys are matched with `input === "..."`:

```typescript
if (input === "R") {
  openRutrackerPrompt();
  return;
}
```

Place this where the other capital-letter config keys (`S`, `D`) are handled, and ensure it only fires when no prompt currently owns input.

- [ ] **Step 7: Guard input while the prompt is open**

In the same handler, next to the existing `if (editingDns) return;` guards, add:

```typescript
if (editingRutracker) return; // the RuTracker prompt owns input
```

Also add `editingRutracker` to any `showHelp || editing... ` composite conditions and dependency arrays that list the other `editing*` flags (mirror every place `editingDns` appears).

- [ ] **Step 8: Render the prompt**

Next to the `{editingDns ? ( ... )}` render block, add:

```tsx
{editingRutracker ? (
  <RutrackerPrompt
    width={promptWidth}
    currentUser={rutrackerUser}
    status={rutrackerStatus}
    captcha={rutrackerCaptcha}
    onSubmit={submitRutrackerLogin}
    onCopyCaptcha={copyCaptchaLink}
    onCancel={closeRutrackerPrompt}
  />
) : null}
```

Use the same width prop the sibling prompts use (match `TokenPrompt`/`DnsPrompt`'s `width={...}` in the file — shown as `promptWidth` here as a placeholder for that exact expression).

- [ ] **Step 9: Surface an auth notice after a failed RuTracker search**

Find where `search.perSource` errors are consumed (the effect around `App.tsx` that reacts to Real-Debrid token rejections is the model, ~line 200). Add an effect that, when any `rt-*` source reports an auth error and the user isn't already in the prompt, nudges them:

```typescript
useEffect(() => {
  const rtError = ["rt-games", "rt-movies", "rt-tv", "rt-anime"].some(
    (id) => /log in|login|session/i.test(search.perSource[id]?.error ?? ""),
  );
  if (rtError && !editingRutracker && !getRutrackerSession()) {
    setNotice("RuTracker needs login — press R to sign in.");
  }
}, [search.perSource, editingRutracker, setNotice]);
```

Adjust `search`/`perSource` access to match how the search state is named in `App.tsx` (it may come from a `useConcurrentSearch` hook result).

- [ ] **Step 10: Typecheck and run the full suite**

Run: `npm run typecheck && npm test`
Expected: no type errors; all tests pass.

- [ ] **Step 11: Manual smoke test**

Run: `npm run build && npm start`
- Press `?` — confirm "R  RuTracker login" appears in Navigate.
- Press `R` — confirm the login prompt opens, `esc` closes it.
- (If you have a RuTracker account) sign in; confirm a search shows `RUT`-tagged results in the right category tabs.

- [ ] **Step 12: Commit**

```bash
git add src/ui/App.tsx src/ui/keymap.ts
git commit -m "feat(rutracker): wire login prompt, R keybind, and auth notice into the app

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Documentation

Mention RuTracker in the README so users know it exists and that it needs an account.

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a short RuTracker note**

In `README.md`, in the sources/finding section, add a sentence noting RuTracker is available across Games/Movies/TV/Anime and requires a free RuTracker account (press `R` to sign in; credentials go only to rutracker.org and only the session cookie is stored locally). Match the README's existing tone.

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: note RuTracker source and login

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review Notes

- **Spec coverage:** four category sources (Tasks 3–4), login + cookie persistence + CP1251 (Task 2), captcha via hyperlink + copy (Task 5), search/parse/group inference (Task 3), `R` keybind + auth notice (Task 6), tests throughout, README (Task 7). DoH synergy is automatic via `fetchResilient`. All spec sections covered.
- **Out-of-scope respected:** no `util/open.ts`, no forum browsing, no sidebar restructuring.
- **Known adaptation points (flagged inline, not placeholders):** Task 5 Step 3 — verify `TextField` prop names; Task 6 Steps 6–9 — match `App.tsx`'s exact keybind structure, prompt width expression, and search-state variable names, mirroring the existing `editingDns`/`editingToken` wiring. These are integration seams that depend on our fork's current `App.tsx`, which the implementer must read.
