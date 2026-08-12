# Screenshots for adult results — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an adult result is highlighted (and the toggle is on), show screenshots pulled from its torrent description — a strip of ~4 clickable thumbnails in the browser, one truecolor half-block image in the terminal — fetched lazily, allowlist-proxied, and failing soft to the breakdown pane.

**Architecture:** A pure extraction module (`screenshotExtract.ts`) parses TPB `descr`/1337x detail HTML into image URLs; a core resolver (`screenshots.ts`) fetches + resolves landing pages to direct URLs; a shared allowlisted image fetcher (`imageProxy.ts`, factored out of the existing poster path) serves the bytes; web routes expose both; the TUI calls the core directly. Mirrors the existing OMDb path (core + `/api/title` + `useTitlePreview`).

**Tech Stack:** TypeScript, Vitest, Ink; `torlinkFetch`/`fetchResilient` (`src/util/net.ts`) for all network; web bundle in `src/web/static` (no `node:*`).

## Global Constraints

- **Feature ships in BOTH front ends** (`CLAUDE.md`): the toggle and the screenshots land in the TUI (`src/ui`) and the web (`src/web`) in this change. The toggle is a non-secret preference, so it is not TUI-only.
- **`src/web` must not import `src/ui`; `src/core`/`src/util` import neither.** Shared logic lives in `src/util` (pure) or `src/core` (node-side).
- **Every outbound fetch is allowlist-gated** by `SCREENSHOT_HOSTS` (SSRF guard), on the initial host and after any redirect hop — same discipline as `POSTER_HOSTS` in `src/core/posterCache.ts`.
- **No `innerHTML`/`insertAdjacentHTML`/`outerHTML`/`document.write` in `src/web/static`.** Screenshot URLs are uploader-controlled; every node is `createElement` + attributes/`textContent`.
- **`app.ts` is DOM wiring only** — "what to fetch / what to show" lives in tested pure modules.
- **Config writes are read-modify-write per request** (`loadConfig` → change → `saveConfig`); never hold a snapshot between requests.
- **No real titles/studios/performers in any fixture or copy.** Fixtures use invented studios (e.g. `Meridian Studios`) in adult-release shapes.
- **Spike-verified hosts** (the only ones allowlisted at first): `imgtraffic.com`, `shotcan.com`, `pixfy.cfd`, `trafficimage.club`, `starimage.club`, `s.starimage.club`, `xxxwebdlxxx.org`.
- **Before done:** `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` pass (only the pre-existing `react-hooks/exhaustive-deps` warning in `src/ui/App.tsx` is allowed).

---

### Task 1: Pure extraction — `src/util/screenshotExtract.ts`

**Files:**
- Create: `src/util/screenshotExtract.ts`
- Test: `src/util/screenshotExtract.test.ts`

**Interfaces:**
- Produces:
  - `interface Shot { thumb: string; full: string; }`
  - `SCREENSHOT_HOSTS: Set<string>` and `screenshotHostAllowed(url: string): boolean`
  - `extractTpbLandings(descr: string): string[]`
  - `directFromLandingHtml(html: string): string | null`
  - `extract1337xImages(html: string): string[]`
  - `thumbFor(directUrl: string): string`

- [ ] **Step 1: Write the failing test**

Create `src/util/screenshotExtract.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  screenshotHostAllowed,
  extractTpbLandings,
  directFromLandingHtml,
  extract1337xImages,
  thumbFor,
} from "./screenshotExtract";

describe("screenshotHostAllowed", () => {
  it("allows the verified hosts and rejects everything else", () => {
    expect(screenshotHostAllowed("https://trafficimage.club/image/HYtPsz")).toBe(true);
    expect(screenshotHostAllowed("https://imgtraffic.com/1s/2026/07/30/a.jpeg")).toBe(true);
    expect(screenshotHostAllowed("https://evil.example/x.jpg")).toBe(false);
    // exact-host, so a look-alike suffix fails closed
    expect(screenshotHostAllowed("https://trafficimage.club.evil.example/x")).toBe(false);
    expect(screenshotHostAllowed("ftp://trafficimage.club/x")).toBe(false);
    expect(screenshotHostAllowed("not a url")).toBe(false);
  });
});

describe("extractTpbLandings", () => {
  it("pulls landing-page URLs from a TPB descr, allowlisted only", () => {
    const descr =
      "Meridian Studios 2026\n" +
      "https://trafficimage.club/image/HY8wM4\n" +
      "https://s.starimage.club/image/Yamk\n" +
      "https://xxxwebdlxxx.org/img-6a7a01cb6b01d.html\n" +
      "https://tracker.evil.example/announce";
    expect(extractTpbLandings(descr)).toEqual([
      "https://trafficimage.club/image/HY8wM4",
      "https://s.starimage.club/image/Yamk",
      "https://xxxwebdlxxx.org/img-6a7a01cb6b01d.html",
    ]);
  });
  it("returns nothing for a descr with no landing links", () => {
    expect(extractTpbLandings("just some text, no links")).toEqual([]);
  });
});

describe("directFromLandingHtml", () => {
  it("reads the og:image direct URL", () => {
    const html =
      '<meta property="og:image" content="https://trafficimage.club/images/2026/08/11/abc.jpg">';
    expect(directFromLandingHtml(html)).toBe("https://trafficimage.club/images/2026/08/11/abc.jpg");
  });
  it("returns null when there is no og:image", () => {
    expect(directFromLandingHtml("<html><body>no meta</body></html>")).toBeNull();
  });
  it("ignores an og:image on a non-allowlisted host", () => {
    const html = '<meta property="og:image" content="https://evil.example/x.jpg">';
    expect(directFromLandingHtml(html)).toBeNull();
  });
});

describe("extract1337xImages", () => {
  it("pulls direct image URLs from a detail page, filtering site chrome", () => {
    const html =
      '<img src="https://imgtraffic.com/1s/2026/07/30/a.jpeg">' +
      '<img src="https://shotcan.com/images/2026/08/02/b.jpg">' +
      '<img src="https://www.1337xx.to/images/logo.png">'; // chrome, rejected by allowlist
    expect(extract1337xImages(html)).toEqual([
      "https://imgtraffic.com/1s/2026/07/30/a.jpeg",
      "https://shotcan.com/images/2026/08/02/b.jpg",
    ]);
  });
});

describe("thumbFor", () => {
  it("derives a Chevereto medium variant when the host uses that scheme", () => {
    expect(thumbFor("https://trafficimage.club/images/2026/08/11/abc.jpg")).toBe(
      "https://trafficimage.club/images/2026/08/11/abc.md.jpg",
    );
  });
  it("leaves other hosts unchanged", () => {
    expect(thumbFor("https://imgtraffic.com/1s/2026/07/30/a.jpeg")).toBe(
      "https://imgtraffic.com/1s/2026/07/30/a.jpeg",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/util/screenshotExtract.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

Create `src/util/screenshotExtract.ts`:

```ts
// Pull screenshot image URLs out of the two adult sources' descriptions. Pure:
// no network, no node:* — the fetching lives in core/screenshots.ts. Grounded in
// a 2026-08-12 spike of real apibay + 1337x data (see the design doc for hosts).
//
// The host allowlist is the single SSRF gate: core/screenshots.ts and the image
// proxy both consult it before issuing any request, so an off-list URL in a
// stranger's description is never fetched.

export interface Shot {
  thumb: string;
  full: string;
}

// Exact-host membership (not suffix) so "trafficimage.club.evil.example" fails
// closed. Chevereto image hosts (trafficimage/starimage) plus the direct hosts
// 1337x links to. Extend as new hosts appear — until then they degrade to the
// breakdown-only pane.
export const SCREENSHOT_HOSTS = new Set([
  "imgtraffic.com",
  "shotcan.com",
  "pixfy.cfd",
  "trafficimage.club",
  "starimage.club",
  "s.starimage.club",
  "xxxwebdlxxx.org",
]);

export function screenshotHostAllowed(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  return SCREENSHOT_HOSTS.has(parsed.hostname.toLowerCase());
}

// Every http(s) URL in the text, allowlisted. TPB descrs list screenshots as
// bare landing-page URLs (and occasionally bbcode), so match URLs broadly and
// let the allowlist do the narrowing.
export function extractTpbLandings(descr: string): string[] {
  const urls = descr.match(/https?:\/\/[^\s"'<>\])]+/gi) ?? [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const u of urls) {
    if (seen.has(u) || !screenshotHostAllowed(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

// A landing page → its direct image, via og:image (the Chevereto hosts all set
// it). Allowlisted so a landing page can't point us off-list.
export function directFromLandingHtml(html: string): string | null {
  const m =
    html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ??
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  const url = m?.[1]?.trim();
  if (!url || !screenshotHostAllowed(url)) return null;
  return url;
}

// A 1337x detail page carries direct image URLs in <img src>. Allowlist filters
// out site chrome (logos, avatars) without a hand-maintained deny list.
export function extract1337xImages(html: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /<img[^>]+src=["'](https?:\/\/[^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const u = m[1]!;
    if (seen.has(u) || !screenshotHostAllowed(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

// A smaller variant for the strip. Chevereto exposes "<name>.md.jpg" beside
// "<name>.jpg"; other hosts have no known scheme, so use the URL as-is.
const CHEVERETO_THUMB_HOSTS = new Set(["trafficimage.club", "starimage.club", "s.starimage.club"]);
export function thumbFor(directUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(directUrl);
  } catch {
    return directUrl;
  }
  if (CHEVERETO_THUMB_HOSTS.has(parsed.hostname.toLowerCase())) {
    return directUrl.replace(/\.(jpe?g|png|webp)(\?.*)?$/i, ".md.$1$2");
  }
  return directUrl;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/util/screenshotExtract.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/util/screenshotExtract.ts src/util/screenshotExtract.test.ts
git commit -m "feat(util): pure screenshot-URL extraction + host allowlist"
```

---

### Task 2: Shared allowlisted image fetch — `src/core/imageProxy.ts`

Factor the network-fetch-redirect-validate span out of `posterCache.ts` so the
security-critical allowlist/redirect logic has ONE copy, then have `getPoster`
reuse it. The screenshot cache (Task 3) reuses it too. The existing poster test
suite is the guard for the refactor.

**Files:**
- Create: `src/core/imageProxy.ts`
- Modify: `src/core/posterCache.ts` (route `getPoster`'s fetch through the new helper)
- Test: `src/core/imageProxy.test.ts`

**Interfaces:**
- Produces: `fetchAllowedImageBytes(url, opts): Promise<Buffer | null>` where
  `opts = { allow: (url: string) => boolean; maxBytes: number; accept: (buf: Buffer) => boolean; timeoutMs?: number; fetchImpl?: FetchImpl }`.
  Does the manual redirect loop (one hop), re-checks `allow` on each hop, checks
  `res.ok`, content-length early-out, size cap, and `accept(buf)` magic-bytes.
  Returns `null` on any failure.
- Consumes (in posterCache): keeps `POSTER_HOSTS`, JPEG `accept`, disk cache.

- [ ] **Step 1: Write the failing test**

Create `src/core/imageProxy.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { fetchAllowedImageBytes } from "./imageProxy";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
function resp(status: number, body: Buffer | null, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}
const allow = (u: string) => new URL(u).hostname === "ok.example";
const acceptJpeg = (b: Buffer) => b.length >= 2 && b[0] === 0xff && b[1] === 0xd8;

it("returns bytes for an allowed, valid image", async () => {
  const fetchImpl = async () => resp(200, JPEG, { "content-type": "image/jpeg" });
  const buf = await fetchAllowedImageBytes("https://ok.example/a.jpg", {
    allow, maxBytes: 1000, accept: acceptJpeg, fetchImpl: fetchImpl as any,
  });
  expect(buf).not.toBeNull();
  expect(buf!.length).toBe(JPEG.length);
});

it("rejects a disallowed host without fetching", async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return resp(200, JPEG); };
  const buf = await fetchAllowedImageBytes("https://evil.example/a.jpg", {
    allow, maxBytes: 1000, accept: acceptJpeg, fetchImpl: fetchImpl as any,
  });
  expect(buf).toBeNull();
  expect(called).toBe(false);
});

it("refuses a redirect to a disallowed host", async () => {
  const fetchImpl = async (u: string) =>
    u.includes("ok.example")
      ? resp(302, null, { location: "https://evil.example/a.jpg" })
      : resp(200, JPEG);
  const buf = await fetchAllowedImageBytes("https://ok.example/a.jpg", {
    allow, maxBytes: 1000, accept: acceptJpeg, fetchImpl: fetchImpl as any,
  });
  expect(buf).toBeNull();
});

it("rejects content that fails the magic-byte check", async () => {
  const html = Buffer.from("<html>not an image</html>");
  const fetchImpl = async () => resp(200, html, { "content-type": "text/html" });
  const buf = await fetchAllowedImageBytes("https://ok.example/a.jpg", {
    allow, maxBytes: 1000, accept: acceptJpeg, fetchImpl: fetchImpl as any,
  });
  expect(buf).toBeNull();
});

it("rejects an over-cap body", async () => {
  const big = Buffer.alloc(2000, 0xff);
  big[1] = 0xd8;
  const fetchImpl = async () => resp(200, big, { "content-type": "image/jpeg" });
  const buf = await fetchAllowedImageBytes("https://ok.example/a.jpg", {
    allow, maxBytes: 1000, accept: acceptJpeg, fetchImpl: fetchImpl as any,
  });
  expect(buf).toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/core/imageProxy.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `imageProxy.ts`**

Create `src/core/imageProxy.ts` by lifting the redirect loop + validation from
`posterCache.ts:212-248`, parameterized:

```ts
import { torlinkFetch, type FetchImpl } from "../util/net";
import { log } from "../util/logger";

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 1;
const DEFAULT_TIMEOUT_MS = 8000;

export interface FetchAllowedImageOptions {
  allow: (url: string) => boolean;
  maxBytes: number;
  accept: (buf: Buffer) => boolean;
  timeoutMs?: number;
  fetchImpl?: FetchImpl;
}

// The redirect target, re-checked against `allow` (hostname, not host/prefix, to
// defeat a userinfo bypass), or null when we won't follow it.
function redirectTarget(res: Response, currentUrl: string, allow: (u: string) => boolean): string | null {
  const location = res.headers.get("location");
  if (!location) return null;
  let resolved: URL;
  try {
    resolved = new URL(location, currentUrl);
  } catch {
    return null;
  }
  if (resolved.protocol !== "https:" && resolved.protocol !== "http:") return null;
  if (!allow(resolved.href)) return null;
  return resolved.href;
}

/**
 * Fetch an image's bytes with an allowlist SSRF guard and content validation.
 * Returns null on any failure so callers fall back to a placeholder. One shared
 * copy of this security-critical span (poster + screenshot both use it).
 */
export async function fetchAllowedImageBytes(
  url: string,
  opts: FetchAllowedImageOptions,
): Promise<Buffer | null> {
  if (!opts.allow(url)) return null;
  const fetchImpl = opts.fetchImpl ?? torlinkFetch;
  try {
    const signal = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const get = (u: string): Promise<Response> => fetchImpl(u, { method: "GET", redirect: "manual", signal });
    let target = url;
    let hops = 0;
    let res = await get(target);
    while (REDIRECT_STATUS.has(res.status)) {
      if (hops++ >= MAX_REDIRECTS) return null;
      const next = redirectTarget(res, target, opts.allow);
      if (!next) return null;
      target = next;
      res = await get(target);
    }
    if (!res.ok) return null;
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > opts.maxBytes) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > opts.maxBytes) return null;
    if (!opts.accept(buf)) return null;
    return buf;
  } catch (err) {
    log.debug(`image fetch failed for ${url}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
```

- [ ] **Step 4: Refactor `getPoster` onto it**

In `src/core/posterCache.ts`, replace the inline fetch/redirect/validate block
(the `try { … buf = … } catch` at lines ~212-248, i.e. from `let buf: Buffer;`
through the JPEG magic-byte check) with a single call, keeping the disk-cache
logic around it unchanged:

```ts
  const buf = await fetchAllowedImageBytes(url, {
    allow: posterUrlAllowed,
    maxBytes: opts.maxBytes !== undefined ? MAX_POSTER_BYTES : MAX_POSTER_BYTES,
    accept: (b) => b.length >= 2 && b[0] === 0xff && b[1] === 0xd8, // JPEG only, as before
    timeoutMs: opts.timeoutMs,
    fetchImpl: opts.fetchImpl,
  });
  if (!buf) return null;
```

Add `import { fetchAllowedImageBytes } from "./imageProxy";` at the top. Delete
now-dead helpers local to posterCache that moved into imageProxy (`redirectTarget`,
the `REDIRECT_STATUS`/`MAX_POSTER_REDIRECTS`/`DEFAULT_TIMEOUT_MS` consts) — but
KEEP `posterUrlAllowed` (it wraps `POSTER_HOSTS` with the warn log) and pass it as
`allow`. Leave `getPoster`'s stat/utimes/write/prune exactly as-is.

- [ ] **Step 5: Run both suites to verify green**

Run: `npx vitest run src/core/imageProxy.test.ts src/core/posterCache.test.ts`
Expected: PASS for both — the poster suite passing proves the refactor preserved behavior.

- [ ] **Step 6: Commit**

```bash
git add src/core/imageProxy.ts src/core/imageProxy.test.ts src/core/posterCache.ts
git commit -m "refactor(core): shared allowlisted image fetch, poster reuses it"
```

---

### Task 3: Screenshot cache — `src/core/screenshotCache.ts` + `screenshotsDir`

**Files:**
- Create: `src/core/screenshotCache.ts`
- Modify: `src/config/paths.ts` (add `screenshotsDir`)
- Test: `src/core/screenshotCache.test.ts`

**Interfaces:**
- Consumes: `fetchAllowedImageBytes` (Task 2), `screenshotHostAllowed` (Task 1).
- Produces: `getScreenshot(url, opts?): Promise<CachedImage | null>` and
  `screenshotResponse(hit)` shape parity with the poster response; `SCREENSHOT_MAX_BYTES`.

- [ ] **Step 1: Add `screenshotsDir`**

In `src/config/paths.ts`, beside `postersDir` (line 49):

```ts
export const screenshotsDir = path.join(cacheDir, "screenshots");
```

- [ ] **Step 2: Write the failing test**

Create `src/core/screenshotCache.test.ts` — model it on `posterCache.test.ts`
(use a temp dir via `opts.dir` and a fake `fetchImpl`). Assert: a valid jpeg/png
is cached and returned; a disallowed host returns null; an HTML body is rejected.
Reuse the magic-byte fixtures for jpg (`ff d8`) and png (`89 50 4e 47`).

```ts
import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { getScreenshot } from "./screenshotCache";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const okFetch = (async () => new Response(JPEG, { status: 200, headers: { "content-type": "image/jpeg" } })) as any;

it("caches an allowed screenshot", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ss-"));
  const hit = await getScreenshot("https://imgtraffic.com/1s/a.jpeg", { dir, fetchImpl: okFetch });
  expect(hit).not.toBeNull();
  expect(hit!.bytes).toBe(JPEG.length);
});

it("refuses a non-allowlisted host", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ss-"));
  const hit = await getScreenshot("https://evil.example/a.jpg", { dir, fetchImpl: okFetch });
  expect(hit).toBeNull();
});
```

- [ ] **Step 3: Implement**

Create `src/core/screenshotCache.ts`. It mirrors `getPoster`'s disk-cache
scaffolding (stat/utimes hit, write-then-rename, periodic prune via the exported
`prunePosters` — reuse it, it is dir-agnostic) but uses `screenshotsDir`,
`screenshotHostAllowed`, a broader `accept` (jpg/png/webp/gif magic), and a size
cap. Extract the disk-cache scaffold into a shared helper if it reads as a
near-copy; otherwise a focused duplication of ~30 lines of fs bookkeeping is
acceptable here since the security-critical fetch is already shared (Task 2).

```ts
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { screenshotsDir } from "../config/paths";
import { fetchAllowedImageBytes } from "./imageProxy";
import { screenshotHostAllowed } from "../util/screenshotExtract";
import { prunePosters } from "./posterCache";
import { torlinkFetch, type FetchImpl } from "../util/net";
import { log } from "../util/logger";

export const SCREENSHOT_MAX_BYTES = 8 * 1024 * 1024;
export const MAX_SCREENSHOT_CACHE_BYTES = 200 * 1024 * 1024;

export interface CachedImage { path: string; bytes: number; }
export interface ScreenshotCacheOptions { dir?: string; fetchImpl?: FetchImpl; timeoutMs?: number; }

// jpg / png / webp / gif — screenshot hosts serve more than the poster path's jpeg.
function looksLikeImage(b: Buffer): boolean {
  if (b.length < 4) return false;
  if (b[0] === 0xff && b[1] === 0xd8) return true;                       // jpeg
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return true; // png
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return true;      // gif
  if (b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return true;
  return false;
}

function fileName(url: string): string {
  return `${createHash("sha1").update(url).digest("hex")}.img`;
}

let writes = 50;

export async function getScreenshot(url: string, opts: ScreenshotCacheOptions = {}): Promise<CachedImage | null> {
  if (!screenshotHostAllowed(url)) return null;
  const dir = opts.dir ?? screenshotsDir;
  const file = path.join(dir, fileName(url));
  try {
    const st = await fs.stat(file);
    if (st.isFile() && st.size > 0) {
      const now = Date.now() / 1000;
      await fs.utimes(file, now, now).catch(() => {});
      return { path: file, bytes: st.size };
    }
  } catch { /* miss */ }

  const buf = await fetchAllowedImageBytes(url, {
    allow: screenshotHostAllowed,
    maxBytes: SCREENSHOT_MAX_BYTES,
    accept: looksLikeImage,
    timeoutMs: opts.timeoutMs,
    fetchImpl: opts.fetchImpl ?? torlinkFetch,
  });
  if (!buf) return null;

  try {
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, buf);
    await fs.rename(tmp, file);
  } catch (err) {
    log.debug(`screenshot cache write failed for ${url}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  if (++writes >= 50) { writes = 0; void prunePosters(dir, MAX_SCREENSHOT_CACHE_BYTES); }
  return { path: file, bytes: buf.length };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/core/screenshotCache.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/screenshotCache.ts src/core/screenshotCache.test.ts src/config/paths.ts
git commit -m "feat(core): screenshot image cache (allowlisted, image magic bytes)"
```

---

### Task 4: Core resolver — `src/core/screenshots.ts`

**Files:**
- Create: `src/core/screenshots.ts`
- Test: `src/core/screenshots.test.ts`

**Interfaces:**
- Consumes: `extractTpbLandings`, `directFromLandingHtml`, `extract1337xImages`, `thumbFor`, `screenshotHostAllowed`, `Shot` (Task 1); `fetchResilient` (`src/util/net.ts`); the 1337x `HOSTS` list.
- Produces: `screenshotsFor(source: string, ref: string, opts: { fetchImpl?: FetchImpl; limit: number }): Promise<Shot[]>`.

- [ ] **Step 1: Write the failing test**

Create `src/core/screenshots.test.ts` driving a fake `fetchImpl` (a map from URL → Response). Cover:
- TPB: `t.php?id=42` returns `{descr}` with two landing links → each landing returns og:image HTML → two `Shot`s, `thumb` = Chevereto `.md.jpg`.
- 1337x: detail HTML with two direct `<img>` → two `Shot`s.
- `limit` caps the count.
- A landing on an off-list host in the descr is skipped.
- All-fail → `[]`.

```ts
import { describe, it, expect } from "vitest";
import { screenshotsFor } from "./screenshots";

function router(map: Record<string, string>) {
  return (async (url: string) => {
    const body = map[url];
    return new Response(body ?? "", { status: body === undefined ? 404 : 200 });
  }) as any;
}

it("resolves TPB landings to shots via og:image", async () => {
  const fetchImpl = router({
    "https://apibay.org/t.php?id=42": JSON.stringify({
      descr: "https://trafficimage.club/image/AAA\nhttps://s.starimage.club/image/BBB",
    }),
    "https://trafficimage.club/image/AAA":
      '<meta property="og:image" content="https://trafficimage.club/images/x.jpg">',
    "https://s.starimage.club/image/BBB":
      '<meta property="og:image" content="https://s.starimage.club/images/y.jpg">',
  });
  const shots = await screenshotsFor("TPB", "42", { fetchImpl, limit: 4 });
  expect(shots).toEqual([
    { full: "https://trafficimage.club/images/x.jpg", thumb: "https://trafficimage.club/images/x.md.jpg" },
    { full: "https://s.starimage.club/images/y.jpg", thumb: "https://s.starimage.club/images/y.md.jpg" },
  ]);
});

it("reads 1337x direct images from the detail page", async () => {
  const fetchImpl = router({
    "https://1337x.to/torrent/1/x/":
      '<img src="https://imgtraffic.com/1s/a.jpeg"><img src="https://shotcan.com/i/b.jpg">',
  });
  const shots = await screenshotsFor("1337x", "/torrent/1/x/", { fetchImpl, limit: 4 });
  expect(shots.map((s) => s.full)).toEqual([
    "https://imgtraffic.com/1s/a.jpeg",
    "https://shotcan.com/i/b.jpg",
  ]);
});

it("returns [] when nothing resolves", async () => {
  const shots = await screenshotsFor("TPB", "999", { fetchImpl: router({}), limit: 4 });
  expect(shots).toEqual([]);
});
```

- [ ] **Step 2: Run to verify fails**

Run: `npx vitest run src/core/screenshots.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

Create `src/core/screenshots.ts`:

```ts
import { fetchResilient, type FetchImpl } from "../util/net";
import {
  extractTpbLandings, directFromLandingHtml, extract1337xImages, thumbFor,
  screenshotHostAllowed, type Shot,
} from "../util/screenshotExtract";

const TPB_API = "https://apibay.org";
// Same failover list 1337x search uses; a ref is a path, resolved against whichever host answers.
const X1337_HOSTS = ["1337x.to", "1337x.st", "x1337x.ws", "1337xx.to"];

interface Opts { fetchImpl?: FetchImpl; limit: number; }

async function text(url: string, fetchImpl: FetchImpl): Promise<string | null> {
  try {
    const res = await fetchResilient(url, { retries: 0, fetchImpl });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

async function tpbShots(id: string, o: Opts): Promise<Shot[]> {
  const fetchImpl = o.fetchImpl ?? undefined!;
  const body = await text(`${TPB_API}/t.php?id=${encodeURIComponent(id)}`, o.fetchImpl!);
  if (!body) return [];
  let descr = "";
  try { descr = (JSON.parse(body) as { descr?: string }).descr ?? ""; } catch { return []; }
  const landings = extractTpbLandings(descr).slice(0, o.limit);
  const shots: Shot[] = [];
  for (const landing of landings) {
    const html = await text(landing, o.fetchImpl!);
    const full = html ? directFromLandingHtml(html) : null;
    if (full && screenshotHostAllowed(full)) shots.push({ full, thumb: thumbFor(full) });
  }
  return shots;
}

async function x1337Shots(pathRef: string, o: Opts): Promise<Shot[]> {
  for (const host of X1337_HOSTS) {
    const html = await text(`https://${host}${pathRef}`, o.fetchImpl!);
    if (!html) continue;
    const fulls = extract1337xImages(html).slice(0, o.limit);
    if (fulls.length) return fulls.map((full) => ({ full, thumb: thumbFor(full) }));
  }
  return [];
}

/**
 * Direct screenshot URLs for a torrent, resolved from its description. Lazy —
 * called on highlight, cached by the caller. `ref` is the apibay id for TPB, the
 * detail path for 1337x. Fails soft to []. Every fetch is allowlist-gated inside
 * the extract/resolve helpers.
 */
export async function screenshotsFor(source: string, ref: string, opts: Opts): Promise<Shot[]> {
  if (!ref) return [];
  const label = source.toLowerCase();
  if (label.includes("tpb") || label.includes("pirate")) return tpbShots(ref, opts);
  if (label.includes("1337")) return x1337Shots(ref, opts);
  return [];
}
```

> Note: `fetchResilient`'s signature must accept a `fetchImpl` override. If it does
> not today, add an optional `fetchImpl` to its options (defaulting to `torlinkFetch`)
> in `src/util/net.ts` as the first sub-step — the poster path already threads a
> `fetchImpl` for tests, so mirror that. Verify by reading `net.ts` before writing this.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/core/screenshots.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/screenshots.ts src/core/screenshots.test.ts src/util/net.ts
git commit -m "feat(core): resolve torrent-description screenshots (TPB + 1337x)"
```

---

### Task 5: Carry the ref on results (`screenshotRef`)

**Files:**
- Modify: `src/sources/types.ts` (`TorrentResult`)
- Modify: `src/sources/piratebay.ts` (`toResult` → set `screenshotRef = it.id`)
- Modify: `src/sources/x1337.ts` (`search` result → `screenshotRef = row.path`)
- Modify: `src/web/wire.ts` (`PublicSearchResult`)
- Modify: `src/web/routes.ts` (`toPublicResult`)
- Test: extend `src/sources/*` tests if present, else assert in a small new test

**Interfaces:**
- Produces: `TorrentResult.screenshotRef?: string`, `PublicSearchResult.screenshotRef?: string`.

- [ ] **Step 1: Add the field to `TorrentResult`**

In `src/sources/types.ts`, in `TorrentResult` (after `sources?`):

```ts
  /**
   * A source-specific handle for fetching this torrent's description/screenshots
   * on demand: the apibay numeric id for TPB, the detail-page path for 1337x.
   * A public listing ref (unlike the magnet), so it may cross the wire.
   */
  screenshotRef?: string;
```

- [ ] **Step 2: Populate it in the sources**

In `src/sources/piratebay.ts` `toResult`, add to the returned object:

```ts
    screenshotRef: it.id && it.id !== "0" ? it.id : undefined,
```

In `src/sources/x1337.ts` `search`, in the returned result object (after `source`):

```ts
        screenshotRef: row.path,
```

- [ ] **Step 3: Cross the wire**

In `src/web/wire.ts` `PublicSearchResult`, add (after `added?`):

```ts
  /** Source-specific ref for on-demand screenshot lookup (apibay id / 1337x path). Not a secret. */
  screenshotRef?: string;
```

In `src/web/routes.ts` `toPublicResult`, mirror the conditional-copy style used
for `numFiles`/`added`:

```ts
  if (r.screenshotRef !== undefined) out.screenshotRef = r.screenshotRef;
```

- [ ] **Step 4: Assert it flows through**

Add/extend a test — if `src/sources/piratebay.test.ts` exists, assert a parsed
result carries `screenshotRef` equal to the apibay id; likewise a `toPublicResult`
test in the routes/wire tests. If no such test file exists, add a minimal
`src/web/routes.screenshotRef.test.ts`:

```ts
import { it, expect } from "vitest";
import { toPublicResult } from "./routes";

it("passes screenshotRef through to the public result", () => {
  const pub = toPublicResult({
    infoHash: "abc", name: "Kestrel", sizeBytes: 1, seeders: 1, leechers: 0,
    source: "TPB", magnet: "magnet:?x", screenshotRef: "12345",
  } as any);
  expect(pub.screenshotRef).toBe("12345");
});
```

- [ ] **Step 5: Run + commit**

Run: `npx vitest run src/web src/sources`
Expected: PASS.

```bash
git add src/sources/types.ts src/sources/piratebay.ts src/sources/x1337.ts src/web/wire.ts src/web/routes.ts src/web/routes.screenshotRef.test.ts
git commit -m "feat: carry screenshotRef on results (apibay id / 1337x path)"
```

---

### Task 6: Settings toggle — `adultScreenshots` (default on), both surfaces

Mechanical: mirror `adultContent` / `proxyDebridStreams` at every site. Default
`true`.

**Files:**
- Modify: `src/config/config.ts` (Config field + default, `RawSettingsPatch`, `sanitiseSettingsPatch`)
- Modify: `src/web/wire.ts` (`PublicWritableSettings`, `SettingsResponse`, `SourcesResponse` capability)
- Modify: `src/web/routes.ts` (`settingsResponse`, `sourcesResponse` cap)
- Modify: `src/web/static/settingsModel.ts` (`ToggleKey`, `settingsSections`)
- Modify: `src/ui/components/Settings.tsx` (TUI toggle)
- Test: extend `src/config/config.test.ts` (sanitise) and `src/web/static/settingsModel.test.ts`

**Interfaces:**
- Produces: `Config.adultScreenshots?: boolean` (default true); wire flags `adultScreenshots: boolean` on both `PublicWritableSettings` and `SourcesResponse`.

- [ ] **Step 1: Write the failing test (sanitise + default)**

In `src/config/config.test.ts`, add:

```ts
it("sanitises adultScreenshots to a boolean", () => {
  expect(sanitiseSettingsPatch({ adultScreenshots: false })).toEqual({ adultScreenshots: false });
  expect(sanitiseSettingsPatch({ adultScreenshots: "yes" as any })).toEqual({ adultScreenshots: false });
});
```

And, wherever config defaults are asserted, that a fresh config has `adultScreenshots` default `true` (find the existing default-resolution test and mirror it; if defaults are applied in a `resolve*`/`loadConfig` path, add the default there and assert it).

- [ ] **Step 2: Run to verify fails**

Run: `npx vitest run src/config/config.test.ts -t adultScreenshots`
Expected: FAIL.

- [ ] **Step 3: Implement config**

In `src/config/config.ts`:
- `Config` interface (near `adultContent?: boolean;` at line 84): `adultScreenshots?: boolean;`
- `RawSettingsPatch` (near line 215): `adultScreenshots?: unknown;`
- `sanitiseSettingsPatch` (near line 253): `if (raw.adultScreenshots !== undefined) out.adultScreenshots = raw.adultScreenshots === true;`
- Default: add a resolver mirroring `resolveAdultContent` OR default at read: `adultScreenshots !== false` (absent ⇒ on). Prefer an explicit `resolveAdultScreenshots(config): boolean { return config.adultScreenshots !== false; }` beside `resolveAdultContent` (line 365) so "default on" is stated once.

- [ ] **Step 4: Wire + routes + web model + TUI**

- `src/web/wire.ts`: add `adultScreenshots: boolean;` to `PublicWritableSettings` (beside `adultContent`, line 555) and to `SourcesResponse` (beside `omdbConfigured`, line 495).
- `src/web/routes.ts`: in `sourcesResponse` (line 763) add `adultScreenshots: resolveAdultScreenshots(config),`; in `settingsResponse` (line 1317) / its writable-settings builder add `adultScreenshots: resolveAdultScreenshots(config),`.
- `src/web/static/settingsModel.ts`: add `"adultScreenshots"` to `ToggleKey` (line 20); in `settingsSections` (line 59+) add a toggle control mirroring the `adultContent` control (lines 68-73), label e.g. "Adult screenshots", value `s.adultScreenshots`. Place it near the adult content toggle.
- `src/ui/components/Settings.tsx`: add the toggle row mirroring the existing `adultContent` toggle (read the file, find how `adultContent` is rendered + toggled, and add `adultScreenshots` the same way).

- [ ] **Step 5: settingsModel test**

In `src/web/static/settingsModel.test.ts`, assert `settingsSections` includes an
`adultScreenshots` toggle reflecting the response value (mirror the existing
`adultContent` assertion).

- [ ] **Step 6: Run + commit**

Run: `npx vitest run src/config src/web`
Expected: PASS.

```bash
git add src/config/config.ts src/config/config.test.ts src/web/wire.ts src/web/routes.ts src/web/static/settingsModel.ts src/web/static/settingsModel.test.ts src/ui/components/Settings.tsx
git commit -m "feat: adultScreenshots toggle (default on), both surfaces"
```

---

### Task 7: Web routes — `/api/screenshots` and `/api/screenshot`

**Files:**
- Modify: `src/web/routes.ts` (two route handlers + a `deps` impl hook mirroring `getPosterImpl`)
- Test: extend the routes test file

**Interfaces:**
- Consumes: `screenshotsFor` (Task 4), `getScreenshot` (Task 3), `screenshotHostAllowed`/`SCREENSHOT_HOSTS` (Task 1), `resolveAdultContent` + `resolveAdultScreenshots` (Task 6).
- Produces: `GET /api/screenshots?source=&ref=` → `{ images: Shot[] }`; `GET /api/screenshot?url=` → image bytes.

- [ ] **Step 1: Write the failing test**

In the routes test file, add cases (using `deps` impl hooks): `/api/screenshots`
returns `{images}` from a stub `screenshotsForImpl` when adult+toggle on, and
`{images: []}` when the toggle is off; `/api/screenshot` 400s a non-allowlisted
host and 404s a cache miss, mirroring the existing `/api/poster` tests.

- [ ] **Step 2: Run to verify fails**

Run: `npx vitest run src/web/routes.test.ts -t screenshot`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `src/web/routes.ts`, beside the `/api/poster` handler (line 2100), add:

```ts
  if (method === "GET" && urlPath === "/api/screenshots") {
    const config = await (deps.loadConfigImpl ?? loadConfig)();
    if (!resolveAdultContent(config) || !resolveAdultScreenshots(config)) {
      return { status: 200, json: { images: [] } };
    }
    const source = query.get("source") ?? "";
    const ref = query.get("ref") ?? "";
    if (!source || !ref) return { status: 200, json: { images: [] } };
    const images = await (deps.screenshotsForImpl ?? screenshotsFor)(source, ref, { limit: 4 });
    return { status: 200, json: { images } };
  }

  if (method === "GET" && urlPath === "/api/screenshot") {
    const url = query.get("url") ?? "";
    if (!url) return { status: 400, json: { error: "missing url" } };
    let host: string;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        return { status: 400, json: { error: "unsupported scheme" } };
      }
      host = parsed.hostname.toLowerCase();
    } catch {
      return { status: 400, json: { error: "invalid url" } };
    }
    // Redundant with getScreenshot's own allowlist (authoritative); this only
    // picks 400-vs-404, exactly like /api/poster.
    if (!SCREENSHOT_HOSTS.has(host)) return { status: 400, json: { error: "host not allowed" } };
    const hit = await (deps.getScreenshotImpl ?? getScreenshot)(url);
    if (!hit) return { status: 404, json: { error: "screenshot unavailable" } };
    return posterResponse(hit); // same {path,bytes}->image response shape
  }
```

Add the imports (`screenshotsFor`, `getScreenshot`, `SCREENSHOT_HOSTS`,
`resolveAdultScreenshots`) and the two optional `deps` fields
(`screenshotsForImpl?`, `getScreenshotImpl?`) beside the existing `getPosterImpl`
on the `WebDeps` type. Confirm `posterResponse` sets an appropriate
`content-type` (it serves the cached bytes); if it hardcodes `image/jpeg` that is
fine for our jpeg-dominant hosts, but prefer sniffing from the first bytes if it
already does.

- [ ] **Step 4: Run + commit**

Run: `npx vitest run src/web/routes.test.ts`
Expected: PASS.

```bash
git add src/web/routes.ts src/web/routes.test.ts
git commit -m "feat(web): /api/screenshots + /api/screenshot proxy routes"
```

---

### Task 8: Web display — thumbnail strip + enlarge

**Files:**
- Modify: `src/web/static/index.html` (a `#preview-shots` container in the preview aside)
- Create: `src/web/static/screenshotStrip.ts` (pure: URLs → proxied paths) + test
- Modify: `src/web/static/previewModel.ts` (controller: async screenshot effect on `selectLocal`)
- Modify: `src/web/static/app.ts` (mount `<img>` thumbnails, click-to-enlarge)
- Test: `src/web/static/screenshotStrip.test.ts`, extend `previewModel.test.ts`

**Interfaces:**
- Consumes: `Shot` shape (mirror it locally in wire or import a shared type), the `/api/screenshots` + `/api/screenshot` routes, `adultPreviewApplies`.
- Produces: `screenshotProxyPath(url): string` and `stripItems(shots, max): {thumbSrc,fullSrc}[]` (pure, tested); controller renders shots via a new effect.

- [ ] **Step 1: Pure model test + impl**

Create `src/web/static/screenshotStrip.ts`:

```ts
import type { Shot } from "./wire"; // add `export interface Shot { thumb: string; full: string }` to wire.ts (shared web type) if not present

export function screenshotProxyPath(url: string): string {
  return `/api/screenshot?url=${encodeURIComponent(url)}`;
}

export interface StripItem { thumbSrc: string; fullSrc: string; }

// The proxied thumb/full pairs to mount, capped. Never the raw third-party URL —
// the browser only ever hits same-origin /api/screenshot.
export function stripItems(shots: Shot[], max: number): StripItem[] {
  return shots.slice(0, max).map((s) => ({
    thumbSrc: screenshotProxyPath(s.thumb),
    fullSrc: screenshotProxyPath(s.full),
  }));
}
```

Test `src/web/static/screenshotStrip.test.ts`:

```ts
import { it, expect } from "vitest";
import { screenshotProxyPath, stripItems } from "./screenshotStrip";

it("proxies through same-origin and caps the count", () => {
  const shots = Array.from({ length: 6 }, (_, i) => ({ thumb: `https://h/t${i}.jpg`, full: `https://h/f${i}.jpg` }));
  const items = stripItems(shots, 4);
  expect(items).toHaveLength(4);
  expect(items[0].thumbSrc).toBe("/api/screenshot?url=" + encodeURIComponent("https://h/t0.jpg"));
  expect(items[0].fullSrc).toBe("/api/screenshot?url=" + encodeURIComponent("https://h/f0.jpg"));
});
```

Add `export interface Shot { thumb: string; full: string; }` to `src/web/wire.ts`
(shared, since routes return it too).

- [ ] **Step 2: Controller effect (previewModel.ts)**

Extend `createPreviewController`: `selectLocal(release, group, source?, ref?)`
gains the two optional args. After rendering the local copy synchronously, if
`source && ref`, schedule (reuse the debounce) `fx.fetchScreenshots(source, ref)`;
on resolve, if still `current`, call `fx.renderShots(stripItems(shots, 4))`.
Add `fetchScreenshots(source, ref): Promise<Shot[]>` and
`renderShots(items: StripItem[]): void` to `PreviewEffects`. A staleness check on
`current` (as the OMDb path already does) prevents a slow strip landing on the
wrong row. Add a test asserting `selectLocal` with source+ref calls
`fetchScreenshots` and then `renderShots`, and that switching rows cancels a
late strip.

- [ ] **Step 3: DOM (index.html + app.ts)**

In `src/web/static/index.html`, add inside the `#preview` aside (after
`#preview-body`):

```html
<div id="preview-shots" class="preview-shots" hidden></div>
```

In `src/web/static/app.ts`:
- `fetchScreenshots`: `GET /api/screenshots?source=&ref=` with `authHeaders()`, parse `{images}`; on any error return `[]`.
- `renderShots(items)`: clear `#preview-shots` (remove children), then for each item `createElement("img")`, set `src=item.thumbSrc`, `loading="lazy"`, `alt=""`, `class="preview-shot"`, and a click handler that opens `item.fullSrc` enlarged — reuse the existing narrow-skin overlay if one exists, else a minimal lightbox: an `#screenshot-lightbox` overlay `<img>` toggled `hidden`, closed on click/Escape. NEVER innerHTML. Append each img. Unhide `#preview-shots` only when items exist; the `local`/`hidden` render paths clear + re-hide it.
- Route `selectResult`'s adult branch to `preview.selectLocal(result.name, group, result.source, result.screenshotRef)`.
- Add minimal CSS in `styles.css` for `.preview-shots` (flex-wrap, small gap), `.preview-shot` (fixed thumb height, `object-fit: cover`, `cursor: pointer`, `max-width: 100%`), and the lightbox overlay.

- [ ] **Step 4: Typecheck, then verify by running**

Run: `npm run typecheck` (expect clean), then `npm run build`, then
`TORLINK_ADULT=1 npm run dev -- serve --web --port <p>`. With adult on, on the
Porn tab: highlight a TPB result → after a moment a strip of thumbnails appears
under the breakdown; click one → it enlarges; highlight a result with no
screenshots → breakdown only, no broken images. Confirm in the Network tab the
browser only ever requests `/api/screenshots` and `/api/screenshot` (same origin),
never a third-party host. Toggle the setting off in the web settings dialog →
no strip, `/api/screenshots` returns `{images:[]}`.

- [ ] **Step 5: Commit**

```bash
git add src/web/static/screenshotStrip.ts src/web/static/screenshotStrip.test.ts src/web/static/previewModel.ts src/web/static/previewModel.test.ts src/web/static/app.ts src/web/static/index.html src/web/static/styles.css src/web/wire.ts
git commit -m "feat(web): screenshot thumbnail strip with click-to-enlarge"
```

---

### Task 9: TUI display — one screenshot as half-blocks

**Files:**
- Create: `src/ui/hooks/useScreenshots.ts` (mirror `useTitlePreview`'s shape) + test if practical
- Modify: `src/ui/components/Results.tsx` (adult branch: feed the first screenshot's rows to `PreviewPane`)
- Modify: `src/ui/components/PreviewPane.tsx` (local mode may render `posterRows` when given)
- Test: extend `src/ui/components/PreviewPane.test.tsx`

**Interfaces:**
- Consumes: `screenshotsFor` (Task 4), `cachedPosterRows` (`src/core/posterCache.ts`), `resolveAdultScreenshots` state via the `adultScreenshots` prop threaded into Results (mirror how `omdbApiKey` reaches it).
- Produces: `useScreenshots({ enabled, source, ref, cacheKey, cols, maxRows, fetchImpl? }): { rows: string[] | null | undefined }`.

- [ ] **Step 1: `useScreenshots` hook**

Create `src/ui/hooks/useScreenshots.ts` modeled on `useTitlePreview.ts`:
debounced, cached by `cacheKey`; when enabled, `screenshotsFor(source, ref, {limit:1})`
→ take `shots[0].full` → `cachedPosterRows(full, cols, maxRows)` → `rows`.
`undefined` while loading, `null` when none, `string[]` when ready.

- [ ] **Step 2: Wire into Results.tsx**

In the adult branch added by the detail-pane feature:
- thread an `adultScreenshots: boolean` prop into `Results` (mirror `omdbApiKey`'s path from the store/settings down to the component).
- call `useScreenshots({ enabled: adultSection && adultScreenshots, source: selectedResult?.source, ref: selectedResult?.screenshotRef, cacheKey: selectedResult?.infoHash ?? "", cols: Math.max(8, previewWidth-4), maxRows: Math.max(4, panelOuter-8) })`.
- pass its `rows` to `PreviewPane` as `posterRows` in the local case: `posterRows={adultSection ? screenshots.rows : preview.posterRows}`.

- [ ] **Step 3: PreviewPane local + posterRows**

In `src/ui/components/PreviewPane.tsx`, the `local` mode currently suppresses the
poster region. Change it so that in local mode a **provided** `posterRows`
(string[]) still renders (the screenshot), while `undefined`/`null` render nothing
(no "No poster available." text). I.e. in local mode: `posterRows` truthy array →
render rows; else render nothing. Title still wraps; breakdown still shows.

- [ ] **Step 4: PreviewPane test**

Extend `src/ui/components/PreviewPane.test.tsx`: in local mode with
`posterRows=[<half-block row>]`, the frame contains the row bytes and still the
name + breakdown, and with `posterRows={null}` shows neither a poster line nor
"No poster available."

- [ ] **Step 5: Typecheck + run the TUI**

Run: `npm run typecheck` (clean). Then `TORLINK_ADULT=1 npm run dev`: Porn
section, highlight a TPB result → a screenshot renders as half-blocks above the
name + breakdown; a result with none → name + breakdown only. Toggle
`adultScreenshots` off in TUI Settings → no screenshot fetch, breakdown only.

- [ ] **Step 6: Commit**

```bash
git add src/ui/hooks/useScreenshots.ts src/ui/components/Results.tsx src/ui/components/PreviewPane.tsx src/ui/components/PreviewPane.test.tsx
git commit -m "feat(tui): render one adult-result screenshot as half-blocks"
```

---

### Task 10: Docs + full verification

**Files:**
- Modify: `README.md` (extend the adult-results preview note with screenshots + the toggle)

- [ ] **Step 1: README**

Extend the preview-pane note added by the detail-pane feature: adult results now
also show screenshots pulled from the torrent description (a strip in the browser,
one image in the terminal) when the "Adult screenshots" setting is on (default on),
and it falls back to the breakdown when a description has none or uses an
unrecognised image host. Keep house style; name nothing real.

- [ ] **Step 2: Full suite**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: all pass; only the pre-existing `src/ui/App.tsx` `exhaustive-deps`
warning. `npm run build` confirms `src/web/static` pulled no `node:*` (the pure
web modules import only wire types + same-origin fetches).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: adult-result screenshots and the toggle"
```

---

## Self-Review

**Spec coverage:**
- TPB descr → landing → og:image resolution → Task 1 (`extractTpbLandings`/`directFromLandingHtml`) + Task 4 (`tpbShots`). ✓
- 1337x direct extraction → Task 1 (`extract1337xImages`) + Task 4 (`x1337Shots`). ✓
- `{thumb, full}` model + Chevereto thumb derivation → Task 1 (`thumbFor`, `Shot`). ✓
- Allowlist SSRF guard on every fetch → Task 1 (`screenshotHostAllowed`), Task 2 (redirect re-check), Tasks 3/4/7 consume it. ✓
- Image proxy modeled on /api/poster, shared security core → Task 2 + Task 3 + Task 7. ✓
- Lazy on-highlight + fail-soft → Task 4 (`[]` on failure), Task 8 (controller effect), Task 9 (hook). ✓
- `screenshotRef` on result + wire → Task 5. ✓
- Settings toggle default-on, both surfaces + capability flag → Task 6. ✓
- Web strip of 4 thumbnails + click-to-enlarge, createElement only → Task 8. ✓
- TUI one screenshot as half-blocks → Task 9. ✓
- Docs → Task 10. ✓

**Placeholder scan:** No TBD/TODO. Two steps say "read the file, mirror the
existing pattern" for genuinely mechanical, well-templated settings/DOM wiring
(Task 6 Settings.tsx, Task 8 lightbox) — each names the exact template to copy;
these are instructions, not placeholders. The `net.ts` `fetchImpl` note in Task 4
is a verify-then-implement step, not a gap.

**Type consistency:** `Shot { thumb; full }` is defined once in
`screenshotExtract.ts` and re-exported via `wire.ts` for the web; `screenshotsFor`,
`screenshotHostAllowed`, `SCREENSHOT_HOSTS`, `getScreenshot`,
`fetchAllowedImageBytes`, `screenshotRef`, `adultScreenshots`,
`resolveAdultScreenshots`, `stripItems`/`screenshotProxyPath`, `useScreenshots`
are named identically at definition and every call site. The routes return `Shot[]`
and the web `stripItems` consumes `Shot[]` — same shape. ✓

**Risk notes for the implementer:**
- Task 2's poster refactor is guarded by the existing poster suite — if it goes red,
  stop and reconcile before proceeding; the shared helper must preserve poster
  behavior exactly.
- Task 4 depends on `fetchResilient` accepting a `fetchImpl` override; verify in
  `net.ts` first and add it if missing (poster path already threads one for tests).
- All live-run verifications (Tasks 8, 9) depend on TPB/1337x being reachable and
  a real adult description existing; the spike confirmed both on 2026-08-12.
