# Proxy Debrid Streams Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An opt-in mode where debrid media flows through this server instead of redirecting to the provider's CDN — one egress IP, and the unrestricted link (a bearer credential against the account) never reaches the client.

**Architecture:** One config flag, `proxyDebridStreams`, toggled in the TUI. When on, the debrid branch of `handleStreamRequest` calls the existing `proxyUpstream` instead of answering `302`. That proxy is taught two things it does not currently do — `https` upstreams and bounded redirect following — via an explicit per-call protocol allow-list, so the WebTorrent path's `http:`-only invariant is untouched. Increment 2 adds a `/hls/provider/…` family that proxies the provider's HLS manifest and its segments, addressing segments by **index into a server-built list** rather than by any client-supplied string.

**Tech Stack:** TypeScript, Node 22+ (`node:http`, `node:https`), vitest, Ink (the TUI toggle).

## Branch and dependency situation — read this first

This plan is written against `main`. **`main` does not have the `.info` route, `chooseSource`, or the provider-transcode rung** — those are in PR #57 (`feat/web-player-codec-classification`), open and mergeable at the time of writing.

- **Increment 1 (Tasks 1–4) does not depend on #57** and can be built on `main` today.
- **Task 3 has a conditional step** that only applies if #57 has merged.
- **Increment 2 (Tasks 5–8) requires #57 to be merged.** If it has not merged, stop after Task 4 and say so.

Check with `git log --oneline main | grep -c "container and codec facts"` — `1` means #57 is in.

## Global Constraints

Every task's requirements implicitly include all of these.

- **`src/web` must not import from `src/ui`; `src/core` must not import from `src/ui` or `src/web`.** Enforced by `eslint.config.js`.
- **Never log an unrestricted link or a capability.** `handleStreamRequest`'s contract is that the caller logs the *path* only; every route added here inherits it. A log line may name a refused *scheme*, never a URL.
- **No client-supplied string may become an upstream request URL.** This is the SSRF rule and it is why segments are addressed by index in Increment 2.
- **A new TUI key means editing BOTH halves of `src/ui/keymap.ts`** — `HELP_GROUPS` and `footerHints`. `CLAUDE.md` is explicit; one without the other is a key nobody can discover.
- **Configuration is TUI-only on purpose.** The web is a client of config, not an editor of it. Do not add a settings control to `src/web/static/`.
- **Config booleans are read as `=== true`, not normalised in `loadConfig`.** That is the existing pattern for `adultContent` and `torrentStreamAck`, and it means a hand-edited junk value degrades to "off" rather than throwing.
- **Test fixtures name invented films and shows, never real ones:** `Kestrel.2010.1080p.BluRay.x264`, `Ashfall.1999.1080p`, `Tin.Rivers.2024.2160p.WEB-DL.DV.HDR.Atmos.7.1-GROUP`, `Kepler.S02E04.1080p.WEB-DL`, `Harrowgate.S03.1080p.WEB-DL`.
- **Routes are tested against a real `http.Server`**, the way `src/web/stream.test.ts` already does — its own comment explains that a fake HTTP client cannot show that a `Range` survived a socket.
- **Before saying a task is done:** `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`. There is one known pre-existing lint warning (`react-hooks/exhaustive-deps`, `src/ui/App.tsx`) — leave it.
- **Conventional Commits.**

---

## Increment 1 — the media half

### Task 1: The proxy target decision

**Files:**
- Create: `src/web/proxyTarget.ts`
- Create: `src/web/proxyTarget.test.ts`

Pure, so the two things that decide whether a request is made at all — the scheme and the redirect budget — are testable without a socket. This is also the module that carries the https testing gap noted in the spec: the *decision* is unit-tested here, and the actual TLS behaviour is verified by hand.

**Interfaces:**
- Produces:
  - `type ProxyRefusal = "unparseable" | "scheme" | "hops"`
  - `type ProxyTarget = { ok: true; url: URL } | { ok: false; reason: ProxyRefusal }`
  - `const HTTP_ONLY: readonly string[]` — `["http:"]`
  - `const HTTP_AND_HTTPS: readonly string[]` — `["http:", "https:"]`
  - `function resolveProxyTarget(target: string, allowed: readonly string[], hopsRemaining: number): ProxyTarget`
  - `function resolveRedirect(location: string, from: URL, allowed: readonly string[], hopsRemaining: number): ProxyTarget`

- [ ] **Step 1: Write the failing test**

Create `src/web/proxyTarget.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  HTTP_AND_HTTPS,
  HTTP_ONLY,
  resolveProxyTarget,
  resolveRedirect,
} from "./proxyTarget";

describe("resolveProxyTarget", () => {
  it("accepts an http url when http is allowed", () => {
    const t = resolveProxyTarget("http://127.0.0.1:5000/webtorrent/a", HTTP_ONLY, 3);
    expect(t.ok).toBe(true);
    if (t.ok) expect(t.url.hostname).toBe("127.0.0.1");
  });

  it("refuses https when only http is allowed — the WebTorrent invariant", () => {
    // This is the check that exists today and must keep existing: the local
    // backend serves plain http on loopback and nothing else.
    expect(resolveProxyTarget("https://cdn.example/a.mkv", HTTP_ONLY, 3)).toEqual({
      ok: false,
      reason: "scheme",
    });
  });

  it("accepts https when https is allowed — the debrid case", () => {
    const t = resolveProxyTarget("https://cdn.example/a.mkv", HTTP_AND_HTTPS, 3);
    expect(t.ok).toBe(true);
    if (t.ok) expect(t.url.protocol).toBe("https:");
  });

  it.each(["file:///etc/passwd", "ftp://host/x", "data:text/plain,hi", "gopher://h/1"])(
    "refuses %s even with both http schemes allowed",
    (target) => {
      expect(resolveProxyTarget(target, HTTP_AND_HTTPS, 3)).toEqual({
        ok: false,
        reason: "scheme",
      });
    },
  );

  it("refuses an unparseable target", () => {
    expect(resolveProxyTarget("not a url", HTTP_AND_HTTPS, 3)).toEqual({
      ok: false,
      reason: "unparseable",
    });
  });

  it("refuses when the hop budget is exhausted", () => {
    expect(resolveProxyTarget("https://cdn.example/a.mkv", HTTP_AND_HTTPS, 0)).toEqual({
      ok: false,
      reason: "hops",
    });
  });
});

describe("resolveRedirect", () => {
  const from = new URL("https://cdn.example/d/TOKEN/Kestrel.2010.1080p.BluRay.x264.mkv");

  it("resolves an absolute redirect", () => {
    const t = resolveRedirect("https://node7.cdn.example/x.mkv", from, HTTP_AND_HTTPS, 2);
    expect(t.ok).toBe(true);
    if (t.ok) expect(t.url.hostname).toBe("node7.cdn.example");
  });

  it("resolves a path-relative redirect against the previous url", () => {
    // Providers do send these, and treating one as absolute yields a request to
    // a hostname that does not exist.
    const t = resolveRedirect("/other/path.mkv", from, HTTP_AND_HTTPS, 2);
    expect(t.ok).toBe(true);
    if (t.ok) expect(t.url.href).toBe("https://cdn.example/other/path.mkv");
  });

  it("refuses a redirect that changes to a scheme we do not allow", () => {
    // A redirect is attacker-influenced in exactly the way the original URL is
    // not: it comes from the response, so the allow-list has to be re-applied.
    expect(resolveRedirect("file:///etc/passwd", from, HTTP_AND_HTTPS, 2)).toEqual({
      ok: false,
      reason: "scheme",
    });
  });

  it("refuses once the budget runs out", () => {
    expect(resolveRedirect("https://node7.cdn.example/x", from, HTTP_AND_HTTPS, 0)).toEqual({
      ok: false,
      reason: "hops",
    });
  });

  it("refuses an unparseable location", () => {
    expect(resolveRedirect("http://[bad", from, HTTP_AND_HTTPS, 2)).toEqual({
      ok: false,
      reason: "unparseable",
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/web/proxyTarget.test.ts`
Expected: FAIL — `Failed to resolve import "./proxyTarget"`.

- [ ] **Step 3: Write the implementation**

Create `src/web/proxyTarget.ts`:

```ts
// Whether the stream proxy may make a given request at all: the scheme, and how
// many redirects are left.
//
// Pure and separate from the proxy itself because these are the two decisions
// worth testing, and because exercising a real https upstream needs a TLS server
// and a self-signed certificate — disproportionate here. So the decision is
// tested and the socket behaviour is verified by hand. `src/web/stream.test.ts`
// documents the same trade when it refuses to fake its HTTP client.

export type ProxyRefusal = "unparseable" | "scheme" | "hops";

export type ProxyTarget = { ok: true; url: URL } | { ok: false; reason: ProxyRefusal };

/**
 * What the WebTorrent backend is allowed to be: plain http on loopback and
 * nothing else. Kept as a named constant so the call site reads as a decision
 * rather than as an array literal someone might "tidy up".
 */
export const HTTP_ONLY: readonly string[] = ["http:"];

/** What a debrid CDN is allowed to be. */
export const HTTP_AND_HTTPS: readonly string[] = ["http:", "https:"];

export function resolveProxyTarget(
  target: string,
  allowed: readonly string[],
  hopsRemaining: number,
): ProxyTarget {
  // Budget first: a caller with none left must not even parse, so a redirect
  // loop cannot be walked one URL further than intended.
  if (hopsRemaining <= 0) return { ok: false, reason: "hops" };
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return { ok: false, reason: "unparseable" };
  }
  if (!allowed.includes(url.protocol)) return { ok: false, reason: "scheme" };
  return { ok: true, url };
}

/**
 * The same decision for a `Location` header.
 *
 * Resolved against the URL it came from, because a provider may answer with a
 * path rather than an absolute URL. The allow-list is re-applied deliberately: a
 * redirect target comes out of a response, so it is influenced in a way the
 * original URL was not, and a `Location: file:///…` must not be followed.
 */
export function resolveRedirect(
  location: string,
  from: URL,
  allowed: readonly string[],
  hopsRemaining: number,
): ProxyTarget {
  if (hopsRemaining <= 0) return { ok: false, reason: "hops" };
  let absolute: string;
  try {
    absolute = new URL(location, from).toString();
  } catch {
    return { ok: false, reason: "unparseable" };
  }
  return resolveProxyTarget(absolute, allowed, hopsRemaining);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/web/proxyTarget.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/proxyTarget.ts src/web/proxyTarget.test.ts
git commit -m "feat: decide a proxy target's scheme and redirect budget"
```

---

### Task 2: Teach the proxy https and redirects

**Files:**
- Modify: `src/web/stream.ts` — `proxyUpstream` (from ~line 350) and its one call site
- Modify: `src/web/stream.test.ts`

The WebTorrent path must come out of this behaving identically. Its existing tests are the net, and **not one of them may be edited to accommodate this change** — if one starts failing, the change is wrong.

**Interfaces:**
- Consumes: `resolveProxyTarget`, `resolveRedirect`, `HTTP_ONLY`, `HTTP_AND_HTTPS`, `type ProxyRefusal` (Task 1).
- Produces: `proxyUpstream(deps, req, res, target, opts: { allowedProtocols: readonly string[] }): Promise<number>` — the options parameter is required, so a future caller cannot get the permissive default by forgetting it.

- [ ] **Step 1: Write the failing test**

Add to `src/web/stream.test.ts`. The upstream helper in that file already serves `/missing` and `/slow`; add a redirect branch to it, near those:

```ts
    // Redirect chains: a provider's download URL can 302 to a specific CDN node.
    if (req.url?.startsWith("/redirect/")) {
      const hops = Number(req.url.slice("/redirect/".length));
      res.writeHead(302, { Location: hops > 1 ? `/redirect/${hops - 1}` : "/media" });
      res.end();
      return;
    }
```

then the tests:

```ts
describe("proxy redirects", () => {
  it("follows a single redirect and serves the body", async () => {
    upstream = await startUpstream();
    const { reg, id, capability } = await torrentSession([
      { url: `${upstream.base}/redirect/1`, filename: "Kestrel.2010.1080p.BluRay.x264.mkv", bytes: MEDIA.length },
    ]);
    const base = await start(reg);
    const res = await fetch(`${base}/stream/${id}/0?k=${capability}`);
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(MEDIA.length);
  });

  it("re-sends the Range header on the redirected request", async () => {
    // Dropping Range on a hop silently restarts a seek from byte zero, and the
    // client gets bytes it will treat as the start of the file.
    upstream = await startUpstream();
    const { reg, id, capability } = await torrentSession([
      { url: `${upstream.base}/redirect/1`, filename: "Kestrel.2010.1080p.BluRay.x264.mkv", bytes: MEDIA.length },
    ]);
    const base = await start(reg);
    const res = await fetch(`${base}/stream/${id}/0?k=${capability}`, {
      headers: { Range: "bytes=100-199" },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 100-199/${MEDIA.length}`);
    // Both hops saw it, not just the first.
    expect(upstream.seen.filter((s) => s.range === "bytes=100-199").length).toBe(2);
  });

  it("502s rather than looping when a chain is too long", async () => {
    upstream = await startUpstream();
    const { reg, id, capability } = await torrentSession([
      { url: `${upstream.base}/redirect/9`, filename: "Kestrel.2010.1080p.BluRay.x264.mkv", bytes: 1 },
    ]);
    const base = await start(reg);
    const res = await fetch(`${base}/stream/${id}/0?k=${capability}`);
    expect(res.status).toBe(502);
  });

  it("still refuses an https upstream on the torrent path", async () => {
    // The WebTorrent backend is loopback http and nothing else. This is the
    // invariant the per-call allow-list exists to preserve.
    const { reg, id, capability } = await torrentSession([
      { url: "https://cdn.example/Kestrel.2010.1080p.BluRay.x264.mkv", filename: "Kestrel.2010.1080p.BluRay.x264.mkv", bytes: 1 },
    ]);
    const base = await start(reg);
    const res = await fetch(`${base}/stream/${id}/0?k=${capability}`);
    expect(res.status).toBe(502);
    expect(logs.join("\n")).toContain("https:");
    // The scheme is loggable; the URL never is.
    expect(logs.join("\n")).not.toContain("cdn.example");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/web/stream.test.ts`
Expected: FAIL — the redirect tests get `302` bodies rather than media, because nothing follows them. The https-refusal test passes already; it is there to stay passing.

- [ ] **Step 3: Rewrite `proxyUpstream`**

In `src/web/stream.ts`, add `import https from "node:https";` beside the `http` import, and the Task 1 imports. Replace the function with the version below. The shape change is that the request is issued by an inner named function so a redirect can call it again, and `current` tracks which request the teardown must destroy.

```ts
// How many redirects a provider may send us through. Three is enough for the
// "unrestrict → CDN region → node" shape seen in practice and small enough that
// a loop costs three requests rather than a hang.
const MAX_PROXY_HOPS = 3;

export interface ProxyOptions {
  /**
   * Which URL schemes this call may reach. REQUIRED rather than defaulted, so a
   * future caller cannot get the permissive set by forgetting the argument.
   * `HTTP_ONLY` for the WebTorrent backend, `HTTP_AND_HTTPS` for a debrid CDN.
   */
  allowedProtocols: readonly string[];
}

/**
 * Reverse-proxy one request to an upstream.
 *
 * Resolves once the response is on its way (headers written, body piping) or has
 * failed — not when the body finishes. The caller only needs the status.
 *
 * Two things this does beyond a single request: it refuses any scheme outside
 * `opts.allowedProtocols`, and it follows up to MAX_PROXY_HOPS redirects because
 * `http.request` does not and a debrid download URL can 302 to a CDN node.
 */
function proxyUpstream(
  deps: StreamDeps,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  target: string,
  opts: ProxyOptions,
): Promise<number> {
  const first = resolveProxyTarget(target, opts.allowedProtocols, MAX_PROXY_HOPS);
  if (!first.ok) {
    // The reason, never the URL: an unrestricted link is a credential.
    deps.log(`stream: refusing upstream (${first.reason})`);
    writeJson(res, 502, { error: "bad upstream" });
    return Promise.resolve(502);
  }

  const headers: http.OutgoingHttpHeaders = {};
  // The Range header is the entire reason this proxy is not a redirect: drop it
  // and every seek restarts the file from byte zero, and a browser that asked
  // for `bytes=0-` gets a 200 it cannot scrub. It is re-sent on every hop for
  // the same reason.
  const range = req.headers.range;
  if (range !== undefined) headers.Range = range;
  // Passed through so a backend that answers 304 can; harmless otherwise.
  if (req.headers["if-range"] !== undefined) headers["If-Range"] = req.headers["if-range"];

  return new Promise<number>((resolve) => {
    let settled = false;
    const done = (status: number): void => {
      if (settled) return;
      settled = true;
      resolve(status);
    };
    // Which request the teardown below must destroy. Reassigned on each hop,
    // because destroying the first one after a redirect would leak the second.
    let current: http.ClientRequest | null = null;

    const fail = (reason: ProxyRefusal | "socket"): void => {
      deps.log(`stream: upstream failed (${reason})`);
      if (settled || res.headersSent || res.writableEnded || res.destroyed) {
        res.destroy();
        done(502);
        return;
      }
      writeJson(res, 502, { error: "bad upstream" });
      done(502);
    };

    const send = (url: URL, hopsRemaining: number): void => {
      const transport = url.protocol === "https:" ? https : http;
      const upstream = transport.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port,
          path: `${url.pathname}${url.search}`,
          method: req.method === "HEAD" ? "HEAD" : "GET",
          headers,
          // No keep-alive: this proxy's client is a media element that abandons
          // requests constantly, and a pooled socket outliving an aborted
          // request is precisely the leak the teardown below exists to prevent.
          agent: false,
        },
        (up) => {
          const status = up.statusCode ?? 502;
          const location = up.headers.location;
          if (status >= 300 && status < 400 && typeof location === "string") {
            // Drain rather than destroy: a redirect body is small and reading it
            // lets the socket close cleanly instead of resetting.
            up.resume();
            const next = resolveRedirect(location, url, opts.allowedProtocols, hopsRemaining - 1);
            if (!next.ok) {
              fail(next.reason);
              return;
            }
            send(next.url, hopsRemaining - 1);
            return;
          }

          const out: http.OutgoingHttpHeaders = {};
          for (const name of PASS_THROUGH) {
            const value = up.headers[name];
            if (value !== undefined) out[name] = value;
          }
          // The upstream's status, never a hardcoded 200: a 206 answered as 200
          // tells the client its Range was ignored, and a player that asked for
          // the middle of a file will treat the bytes it gets as the start.
          res.writeHead(status, out);
          done(status);
          up.pipe(res);
          // A mid-body upstream failure cannot become a status code; all that is
          // left is to cut the client off so it sees a truncated body rather
          // than a hang.
          up.on("error", () => res.destroy());
        },
      );
      current = upstream;

      upstream.on("error", () => {
        // Nothing can be said to a client that is already gone or already
        // answered. This branch also covers the ordinary teardown case, where
        // the destroy below is *why* the request errored.
        fail("socket");
      });
      upstream.end();
    };

    // The teardown. A user scrubbing a timeline fires and abandons range
    // requests by the dozen; without this each one leaves a socket to the
    // upstream (and the piece requests behind it) alive with nobody reading.
    // `close` fires for both a client disconnect and our own end, so
    // `writableEnded` is what tells them apart: only the abandoned case needs
    // the upstream destroyed.
    res.on("close", () => {
      if (!res.writableEnded) current?.destroy();
    });

    send(first.url, MAX_PROXY_HOPS);
  });
}
```

Note `upstream.end()` is now explicit: the original relied on `http.request` being ended by the caller's return path, and an inner function needs it stated.

- [ ] **Step 4: Update the one existing call site**

At the end of `handleStreamRequest`, the torrent fall-through becomes:

```ts
  // HTTP_ONLY, deliberately: the WebTorrent backend serves plain http on
  // loopback and nothing else, and widening it here would widen it for a
  // backend whose URLs this process constructs rather than receives.
  return proxyUpstream(deps, req, res, file.url, { allowedProtocols: HTTP_ONLY });
```

- [ ] **Step 5: Run the whole stream suite**

Run: `npx vitest run src/web/stream.test.ts src/web/server.test.ts`
Expected: PASS, including every pre-existing test **unedited**. If one of the old ones fails, the rewrite changed behaviour it should not have — fix the code, not the test.

- [ ] **Step 6: Commit**

```bash
git add src/web/stream.ts src/web/stream.test.ts
git commit -m "feat: proxy can reach https upstreams and follow bounded redirects"
```

---

### Task 3: The flag, and the debrid branch that reads it

**Files:**
- Modify: `src/config/config.ts` — add `proxyDebridStreams?: boolean` to `Config`
- Modify: `src/web/stream.ts` — the debrid branch (~line 407)
- Modify: `src/web/server.ts` — pass the flag into `StreamDeps`
- Modify: `src/web/stream.test.ts`

Read as `=== true`, with no `loadConfig` normalisation — the existing pattern for `adultContent` and `torrentStreamAck`, and it means a hand-edited junk value degrades to "off".

**Interfaces:**
- Produces:
  - `Config.proxyDebridStreams?: boolean`
  - `StreamDeps.proxyDebrid?: boolean` — resolved per request by the server, not read from config inside `stream.ts` (which must not load config; it is handed what it needs).

- [ ] **Step 1: Write the failing test**

Add to the `describe("stream handle — Real-Debrid")` block in `src/web/stream.test.ts`:

```ts
  it("302s by default — the flag off must change nothing", async () => {
    const { base, capability, id } = await rdSession();
    const res = await fetch(`${base}/stream/${id}/0?k=${capability}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(RD_URL);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("proxies instead of redirecting when the flag is on", async () => {
    upstream = await startUpstream();
    const reg = registry({
      idFactory: () => "sid-rd",
      capabilityFactory: () => "cap-rd",
      resolveDebridImpl: async () => [
        { url: `${upstream.base}/media`, filename: "Kestrel.2010.1080p.BluRay.x264.mkv", bytes: MEDIA.length },
      ],
    });
    const s = await reg.start({
      infoHash: "0".repeat(40),
      magnet: "magnet:?xt=urn:btih:" + "0".repeat(40),
      name: "Kestrel.2010.1080p.BluRay.x264-GROUP",
      route: { kind: "debrid", provider: "realdebrid" },
      debridToken: "rd-token",
    });
    expect(s.state).toBe("ready");
    const base = await start(reg, { streamDeps: { proxyDebrid: true } });

    const res = await fetch(`${base}/stream/sid-rd/0?k=cap-rd`, { redirect: "manual" });
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(MEDIA.length);
    // The client never learns where the bytes came from.
    expect(res.headers.get("location")).toBeNull();
  });

  it("forwards a Range while proxying, so seeking still works", async () => {
    upstream = await startUpstream();
    const reg = registry({
      idFactory: () => "sid-rd",
      capabilityFactory: () => "cap-rd",
      resolveDebridImpl: async () => [
        { url: `${upstream.base}/media`, filename: "Kestrel.2010.1080p.BluRay.x264.mkv", bytes: MEDIA.length },
      ],
    });
    await reg.start({
      infoHash: "0".repeat(40),
      magnet: "magnet:?xt=urn:btih:" + "0".repeat(40),
      name: "Kestrel.2010.1080p.BluRay.x264-GROUP",
      route: { kind: "debrid", provider: "realdebrid" },
      debridToken: "rd-token",
    });
    const base = await start(reg, { streamDeps: { proxyDebrid: true } });
    const res = await fetch(`${base}/stream/sid-rd/0?k=cap-rd`, {
      headers: { Range: "bytes=10-19" },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 10-19/${MEDIA.length}`);
  });

  it("never logs the upstream url while proxying", async () => {
    upstream = await startUpstream();
    const reg = registry({
      idFactory: () => "sid-rd",
      capabilityFactory: () => "cap-rd",
      resolveDebridImpl: async () => [
        { url: `${upstream.base}/media?secret=SECRETTOKEN123`, filename: "Kestrel.2010.1080p.BluRay.x264.mkv", bytes: MEDIA.length },
      ],
    });
    await reg.start({
      infoHash: "0".repeat(40),
      magnet: "magnet:?xt=urn:btih:" + "0".repeat(40),
      name: "Kestrel.2010.1080p.BluRay.x264-GROUP",
      route: { kind: "debrid", provider: "realdebrid" },
      debridToken: "rd-token",
    });
    const base = await start(reg, { streamDeps: { proxyDebrid: true } });
    await fetch(`${base}/stream/sid-rd/0?k=cap-rd`);
    expect(logs.join("\n")).not.toContain("SECRETTOKEN123");
  });
```

If `startWebServer` has no `streamDeps` option on your base (it arrives with PR #57), add it now exactly as that PR does:

```ts
  streamDeps?: Omit<Partial<StreamDeps>, "sessions" | "log">;
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/web/stream.test.ts`
Expected: FAIL — the proxy tests get `302` because the flag is not read yet.

- [ ] **Step 3: Add the config field**

In `src/config/config.ts`, inside `interface Config`, after `torrentStreamAck`:

```ts
  // Send debrid media through this server instead of redirecting the client to
  // the provider's CDN. Absent/false = redirect, which is the cheap default.
  //
  // Two reasons to turn it on, and the first applies even to a single user: the
  // unrestricted link is a bearer credential against the account, and a redirect
  // hands it to the client, where proxying keeps it server-side. The second is
  // that every viewer then reaches the provider from this machine's address
  // rather than their own.
  //
  // It is NOT free: every byte is pulled down from the provider and pushed back
  // up to the viewer, so the cost lands on this machine's upstream — three
  // remote viewers of a 1080p remux need roughly 75 Mbps of upload.
  proxyDebridStreams?: boolean;
```

- [ ] **Step 4: Read it in the debrid branch**

In `src/web/stream.ts`, add to `StreamDeps`:

```ts
  /**
   * Proxy debrid media through this server rather than redirecting to the
   * provider. Resolved per request by the caller — this module never loads
   * config, it is handed what it needs.
   */
  proxyDebrid?: boolean;
```

and change the debrid branch:

```ts
  if (session.backend === "debrid") {
    if (deps.proxyDebrid === true) {
      // HTTP_AND_HTTPS: a provider CDN is https, and this is the only call site
      // allowed to reach one.
      return proxyUpstream(deps, req, res, file.url, { allowedProtocols: HTTP_AND_HTTPS });
    }
    // 302, not 307: the method is GET/HEAD either way, and 302 is what every
    // player (and every home-router HTTP client) handles without argument.
    // `Cache-Control: no-store` because an unrestricted link is time-limited and
    // account-bound — a cached redirect outlives the link it points at.
    res.writeHead(302, { Location: file.url, "Cache-Control": "no-store", "Content-Length": "0" });
    res.end();
    return 302;
  }
```

- [ ] **Step 5: Wire it in `server.ts`**

Where `StreamDeps` is built, resolve the flag per request rather than at startup — `CLAUDE.md` is explicit that a held config snapshot silently serves stale values, and `serve --web` is a separate process from any TUI that might flip it:

```ts
            proxyDebrid: (await (options.webDeps?.loadConfigImpl ?? loadConfig)()).proxyDebridStreams === true,
```

If reading config on every stream request measures badly (it is one small file read), memoise it with a short TTL — but do **not** read it once at boot.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/web/stream.test.ts src/web/server.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: If PR #57 has merged, stop the HLS leak**

Check: `git log --oneline main | grep -c "container and codec facts"`. **If that prints `0`, skip this step entirely** — there is no `.info` route yet and nothing to do.

If it prints `1`, add to the `.info` branch of `handleStreamRequest`, replacing the `hls` line:

```ts
    // While proxying, the provider's manifest must NOT be handed out: hls.js
    // would fetch ~2000 segments straight from the provider, so every viewer's
    // IP would still reach it — one egress IP for mp4s and none for MKVs, which
    // is worse than either end state because it looks like it is working. The
    // /hls/provider route replaces this null; until it exists an MKV falls to
    // the fallback card, which is where it sat before rung 2.
    const hls =
      deps.proxyDebrid === true ? null : deps.resolveHls ? await deps.resolveHls(session, parsed.index) : null;
```

and a test beside the other `.info` cases:

```ts
  it("reports no provider manifest while proxying, so segments cannot leak", async () => {
    const { base, capability, id } = await infoSession({
      streamDeps: {
        probeImpl: async () => null,
        proxyDebrid: true,
        resolveHls: async () => "https://4.stream.real-debrid.example/t/ID20/eng1/none/aac/full.m3u8",
      },
    });
    const body = await (await fetch(`${base}/stream/${id}/0.info?k=${capability}`)).json();
    expect(body.hls).toBeNull();
  });
```

- [ ] **Step 8: Full checks and commit**

Run: `npm test && npm run typecheck && npm run lint && npm run build`

```bash
git add src/config/config.ts src/web/stream.ts src/web/stream.test.ts src/web/server.ts
git commit -m "feat: optionally proxy debrid media instead of redirecting"
```

---

### Task 4: The TUI toggle, and the docs

**Files:**
- Modify: `src/ui/App.tsx` — a key handler beside the `"X"` one (~line 2255)
- Modify: `src/ui/keymap.ts` — **both** `HELP_GROUPS` and `footerHints`
- Modify: `src/ui/keymap.test.ts`
- Modify: `README.md`

`R` for "relay". It is free: `r` is bound but `R` is not — `grep -oE 'keys: "[^"]+"' src/ui/keymap.ts` lists every binding, and the uppercase settings keys are `S`, `P`, `D`, `L`, `V` plus `shift+w` / `shift+x`.

**Interfaces:** none exported.

- [ ] **Step 1: Write the failing test**

`src/ui/keymap.test.ts` already asserts things about the help groups; find its existing pattern and add:

```ts
it("documents the debrid proxy toggle in the global help", () => {
  const global = HELP_GROUPS.find((g) => g.title.toLowerCase().includes("global"));
  expect(global?.items.some((i) => i.keys === "R")).toBe(true);
});

it("does not bind R twice", () => {
  // The uppercase settings keys are a crowded space; a duplicate is a key that
  // silently does the wrong one of two things.
  const all = HELP_GROUPS.flatMap((g) => g.items.map((i) => i.keys));
  expect(all.filter((k) => k === "R")).toHaveLength(1);
});
```

Match the real group title and item shape from the file rather than guessing — read the top of `keymap.ts` first.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/ui/keymap.test.ts`
Expected: FAIL — no `R` binding.

- [ ] **Step 3: Add both halves of the keymap**

In `HELP_GROUPS`, in the global group, after the `V` line:

```ts
      { keys: "R", label: "Relay debrid streams through this machine" },
```

In `footerHints`, the global/always list that carries `V` — add the same key with a short label. Find `ALWAYS` or the equivalent shared array; if `V` is only in the help and not the footer, follow that precedent and leave the footer alone, but say so in the commit message.

- [ ] **Step 4: Add the handler**

In `src/ui/App.tsx`, beside the `if (input === "X")` block:

```ts
      if (input === "R") {
        setShowHelp(false);
        const enabled = config?.proxyDebridStreams !== true;
        persistConfig({ proxyDebridStreams: enabled });
        setNotice(
          enabled
            ? "Debrid streams now relay through this machine — uses your upload bandwidth."
            : "Debrid streams go straight from the provider to the player.",
        );
        return;
      }
```

The notice names the cost on the way in, because that is the moment someone can still change their mind.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/ui/ && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Document it**

In `README.md`, in the **Debrid (optional)** section, add a short subsection. It must cover, in this order:

1. **The credential.** By default the player is redirected to the provider and is handed the unrestricted link, which is a bearer URL against the account. Relaying keeps it on the server. This applies with one user and no sharing.
2. **The cost, in numbers.** Every byte comes down from the provider and back up to the viewer, so it lands on upload: roughly 25 Mbps up per 1080p remux viewer, ~80 for 4K. Three remote viewers of a 1080p remux need ~75 Mbps up, which most domestic lines do not have. A viewer on your LAN costs upload nothing.
3. **How to turn it on**: `R` in the terminal. The browser adapts on its own and has no setting, like every other piece of configuration.
4. **One factual line** that sharing a debrid account is against Real-Debrid's terms and they enforce on concurrency and device count, not only on IP diversity. State it; do not argue either side.

- [ ] **Step 7: Full checks and commit**

Run: `npm test && npm run typecheck && npm run lint && npm run build`

```bash
git add src/ui/App.tsx src/ui/keymap.ts src/ui/keymap.test.ts README.md
git commit -m "feat: R relays debrid streams through this machine"
```

**Increment 1 is shippable here.** Open the PR if Increment 2 is blocked on #57.

---

## Increment 2 — the HLS half

**Requires PR #57 merged.** If `git log --oneline main | grep -c "container and codec facts"` prints `0`, stop and report.

### Task 5: Rewrite a provider manifest

**Files:**
- Create: `src/web/hlsManifest.ts`
- Create: `src/web/hlsManifest.test.ts`

Pure. This is where the segment list is built, and the list is what makes the segment route safe.

**Interfaces:**
- Produces:
  - `interface RewrittenManifest { body: string; segments: string[] }`
  - `function rewriteManifest(text: string, base: string, pathPrefix: string): RewrittenManifest`

- [ ] **Step 1: Write the failing test**

Create `src/web/hlsManifest.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { rewriteManifest } from "./hlsManifest";

const BASE = "https://4.stream.real-debrid.example/t/ID20/eng1/none/aac/full.m3u8";
const PREFIX = "/hls/provider/sid-1/0";

const MANIFEST = [
  "#EXTM3U",
  "#EXT-X-TARGETDURATION:6",
  "#EXT-X-ALLOW-CACHE:YES",
  "#EXT-X-MEDIA-SEQUENCE:0",
  "#EXTINF:5, nodesc",
  "00000.ts",
  "#EXTINF:5, nodesc",
  "00001.ts",
  "#EXT-X-ENDLIST",
  "",
].join("\n");

describe("rewriteManifest", () => {
  it("replaces each segment line with an index under the prefix", () => {
    const { body } = rewriteManifest(MANIFEST, BASE, PREFIX);
    expect(body).toContain("/hls/provider/sid-1/0/seg/0");
    expect(body).toContain("/hls/provider/sid-1/0/seg/1");
    expect(body).not.toContain("00000.ts");
    expect(body).not.toContain("real-debrid.example");
  });

  it("resolves each segment to an absolute url against the manifest", () => {
    const { segments } = rewriteManifest(MANIFEST, BASE, PREFIX);
    expect(segments).toEqual([
      "https://4.stream.real-debrid.example/t/ID20/eng1/none/aac/00000.ts",
      "https://4.stream.real-debrid.example/t/ID20/eng1/none/aac/00001.ts",
    ]);
  });

  it("keeps every tag line untouched, including ENDLIST", () => {
    // The tags are what make it a VOD playlist with a known duration; losing
    // ENDLIST turns a seekable film into a live stream.
    const { body } = rewriteManifest(MANIFEST, BASE, PREFIX);
    expect(body).toContain("#EXT-X-TARGETDURATION:6");
    expect(body).toContain("#EXTINF:5, nodesc");
    expect(body).toContain("#EXT-X-ENDLIST");
  });

  it("handles an absolute segment url", () => {
    const text = ["#EXTM3U", "#EXTINF:5,", "https://other.example/a/00000.ts", "#EXT-X-ENDLIST"].join("\n");
    const { segments, body } = rewriteManifest(text, BASE, PREFIX);
    expect(segments).toEqual(["https://other.example/a/00000.ts"]);
    expect(body).toContain("/hls/provider/sid-1/0/seg/0");
  });

  it("rewrites a URI= attribute, which is a segment reference too", () => {
    // An EXT-X-MAP init segment. Left alone it is a direct request to the
    // provider from the viewer — the exact leak this whole route prevents.
    const text = ['#EXTM3U', '#EXT-X-MAP:URI="init.mp4"', "#EXTINF:5,", "00000.ts", "#EXT-X-ENDLIST"].join("\n");
    const { segments, body } = rewriteManifest(text, BASE, PREFIX);
    expect(segments[0]).toBe("https://4.stream.real-debrid.example/t/ID20/eng1/none/aac/init.mp4");
    expect(body).toContain('URI="/hls/provider/sid-1/0/seg/0"');
  });

  it("preserves blank lines and trailing newline shape", () => {
    const { body } = rewriteManifest(MANIFEST, BASE, PREFIX);
    expect(body.endsWith("\n")).toBe(true);
  });

  it("returns no segments for a master playlist listing variants", () => {
    // A master playlist's URIs are other playlists, not media. Real-Debrid
    // returns a media playlist directly, so this is the shape we do NOT expect —
    // and treating variant playlists as segments would proxy them as opaque
    // bytes and break playback silently. Returning none makes it a 404 instead.
    const text = ["#EXTM3U", "#EXT-X-STREAM-INF:BANDWIDTH=800000", "low.m3u8", ""].join("\n");
    const { segments } = rewriteManifest(text, BASE, PREFIX);
    expect(segments).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/web/hlsManifest.test.ts`
Expected: FAIL — `Failed to resolve import "./hlsManifest"`.

- [ ] **Step 3: Write the implementation**

Create `src/web/hlsManifest.ts`:

```ts
// Rewriting a provider's HLS manifest so its segments come through this server.
//
// The output of this function is what makes the segment route safe: it returns
// the absolute segment URLs as a LIST, and the manifest it hands the client
// refers to them BY INDEX. A client therefore cannot name an upstream URL, which
// is the difference between a proxy and an SSRF hole.
//
// Pure: no network, no cache. The route calls it once per manifest fetch.

export interface RewrittenManifest {
  /** The manifest to send to the client. */
  body: string;
  /** Absolute upstream URLs, in the order the body's indices refer to them. */
  segments: string[];
}

// A URI="..." attribute, used by EXT-X-MAP for an init segment and by
// EXT-X-MEDIA for an alternate rendition. Left unrewritten, an init segment is a
// direct request from the viewer to the provider.
const URI_ATTR = /URI="([^"]*)"/;

// Variant-playlist markers. A master playlist's URIs are other playlists rather
// than media, and proxying one as an opaque segment breaks playback in a way
// that is hard to trace, so those lines are left alone and produce no segments.
const VARIANT_TAGS = ["#EXT-X-STREAM-INF", "#EXT-X-I-FRAME-STREAM-INF"];

export function rewriteManifest(text: string, base: string, pathPrefix: string): RewrittenManifest {
  const segments: string[] = [];
  const take = (uri: string): string | null => {
    let absolute: string;
    try {
      absolute = new URL(uri, base).toString();
    } catch {
      return null;
    }
    segments.push(absolute);
    return `${pathPrefix}/seg/${segments.length - 1}`;
  };

  const lines = text.split("\n");
  const out: string[] = [];
  let previousWasVariant = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("#")) {
      const attr = URI_ATTR.exec(trimmed);
      if (attr && !VARIANT_TAGS.some((t) => trimmed.startsWith(t))) {
        const replacement = take(attr[1]!);
        out.push(replacement ? trimmed.replace(URI_ATTR, `URI="${replacement}"`) : line);
      } else {
        out.push(line);
      }
      previousWasVariant = VARIANT_TAGS.some((t) => trimmed.startsWith(t));
      continue;
    }

    if (trimmed === "") {
      out.push(line);
      continue;
    }

    // A URI line following a variant tag is another playlist, not media.
    if (previousWasVariant) {
      out.push(line);
      previousWasVariant = false;
      continue;
    }

    const replacement = take(trimmed);
    out.push(replacement ?? line);
  }

  const body = out.join("\n");
  return { body: body.endsWith("\n") ? body : `${body}\n`, segments };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/web/hlsManifest.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/hlsManifest.ts src/web/hlsManifest.test.ts
git commit -m "feat: rewrite a provider HLS manifest to index-addressed segments"
```

---

### Task 6: Remember the segment list

**Files:**
- Create: `src/core/hlsSegmentCache.ts`
- Create: `src/core/hlsSegmentCache.test.ts`

Deliberately the same shape as `src/core/probeCache.ts`, which the rung-2 work added: bounded, keyed by `(sid, index)` through `JSON.stringify` so a session id containing the separator cannot collide, and no teardown hook because a bound needs none.

**Interfaces:**
- Produces: `class HlsSegmentCache { constructor(max?: number); get(sid: string, index: number): string[] | undefined; set(sid: string, index: number, segments: string[]): void; urlAt(sid: string, index: number, n: number): string | undefined }`

- [ ] **Step 1: Write the failing test**

Create `src/core/hlsSegmentCache.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { HlsSegmentCache } from "./hlsSegmentCache";

const SEGS = ["https://s.example/0.ts", "https://s.example/1.ts"];

describe("HlsSegmentCache", () => {
  it("returns what was stored, keyed by session and index together", () => {
    const c = new HlsSegmentCache(4);
    c.set("sid-1", 0, SEGS);
    expect(c.get("sid-1", 0)).toEqual(SEGS);
    expect(c.get("sid-1", 1)).toBeUndefined();
    expect(c.get("sid-2", 0)).toBeUndefined();
  });

  it("does not confuse a session id containing the separator", () => {
    const c = new HlsSegmentCache(4);
    c.set("a:1", 0, SEGS);
    expect(c.get("a", 1)).toBeUndefined();
  });

  it("urlAt returns the nth segment", () => {
    const c = new HlsSegmentCache(4);
    c.set("sid-1", 0, SEGS);
    expect(c.urlAt("sid-1", 0, 1)).toBe("https://s.example/1.ts");
  });

  it("urlAt is undefined out of range, so the route can 404", () => {
    const c = new HlsSegmentCache(4);
    c.set("sid-1", 0, SEGS);
    expect(c.urlAt("sid-1", 0, 2)).toBeUndefined();
    expect(c.urlAt("sid-1", 0, -1)).toBeUndefined();
  });

  it("urlAt is undefined for a non-integer index", () => {
    // Belt and braces: the route parses \d+, but an array read with a float or
    // NaN index silently yields undefined rather than erroring, and relying on
    // that is how a future refactor loses the check.
    const c = new HlsSegmentCache(4);
    c.set("sid-1", 0, SEGS);
    expect(c.urlAt("sid-1", 0, 1.5)).toBeUndefined();
    expect(c.urlAt("sid-1", 0, Number.NaN)).toBeUndefined();
  });

  it("urlAt is undefined when nothing is cached", () => {
    expect(new HlsSegmentCache(4).urlAt("sid-1", 0, 0)).toBeUndefined();
  });

  it("evicts the oldest entry past its bound", () => {
    const c = new HlsSegmentCache(2);
    c.set("s", 0, SEGS);
    c.set("s", 1, SEGS);
    c.set("s", 2, SEGS);
    expect(c.get("s", 0)).toBeUndefined();
    expect(c.get("s", 2)).toEqual(SEGS);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/core/hlsSegmentCache.test.ts`
Expected: FAIL — `Failed to resolve import "./hlsSegmentCache"`.

- [ ] **Step 3: Write the implementation**

Create `src/core/hlsSegmentCache.ts`:

```ts
// The absolute upstream URLs of one file's HLS segments, in manifest order.
//
// This is the list a client indexes into. It exists so that a segment request
// carries an integer rather than a URL: the difference between a proxy and an
// SSRF hole.
//
// Same shape as ./probeCache.ts and for the same reasons: bounded rather than
// tied to session lifetime, so it needs no teardown hook, and a stale entry is
// harmless because session ids are never reused.

const DEFAULT_MAX = 16;

export class HlsSegmentCache {
  private readonly entries = new Map<string, string[]>();

  constructor(private readonly max: number = DEFAULT_MAX) {}

  // JSON-encoded rather than `${sid}:${index}`: a session id containing the
  // separator would otherwise collide with a different (sid, index) pair.
  private key(sid: string, index: number): string {
    return JSON.stringify([sid, index]);
  }

  get(sid: string, index: number): string[] | undefined {
    return this.entries.get(this.key(sid, index));
  }

  set(sid: string, index: number, segments: string[]): void {
    const key = this.key(sid, index);
    this.entries.delete(key);
    this.entries.set(key, segments);
    // Map iterates in insertion order, so the first key is the oldest.
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** The nth segment's upstream URL, or undefined — which the route 404s. */
  urlAt(sid: string, index: number, n: number): string | undefined {
    if (!Number.isSafeInteger(n) || n < 0) return undefined;
    return this.get(sid, index)?.[n];
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/core/hlsSegmentCache.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/hlsSegmentCache.ts src/core/hlsSegmentCache.test.ts
git commit -m "feat: cache a file's HLS segment urls for index addressing"
```

---

### Task 7: Serve `/hls/provider/:sid/:idx/…`

**Files:**
- Create: `src/web/hlsProvider.ts`
- Create: `src/web/hlsProvider.test.ts`
- Modify: `src/web/server.ts` — mount it, own one `HlsSegmentCache`
- Modify: `src/web/stream.ts` — `.info` returns the box path while proxying

**Interfaces:**
- Consumes: `rewriteManifest` (Task 5), `HlsSegmentCache` (Task 6), `authorizeStreamFile` if present (it arrives with the local-HLS plan; if absent, repeat the four guards inline exactly as `handleStreamRequest` does and note it for extraction later), `makeResolveHls` (PR #57), `proxyUpstream` + `HTTP_AND_HTTPS` (Task 2).
- Produces:
  - `function isHlsProviderPath(urlPath: string): boolean`
  - `function parseHlsProviderPath(urlPath: string): { sid: string; index: number; rest: "manifest" } | { sid: string; index: number; rest: "segment"; n: number } | null`
  - `function hlsProviderManifestPath(sid: string, index: number): string` — `/hls/provider/:sid/:idx/index.m3u8`
  - `async function handleHlsProviderRequest(deps, req, res, urlPath, query): Promise<number>`

- [ ] **Step 1: Write the failing test**

Create `src/web/hlsProvider.test.ts`. Use the real-`http.Server` harness style from `stream.test.ts`: a local upstream serving a manifest and segments, and the web server in front of it.

```ts
describe("parseHlsProviderPath", () => {
  it("parses the manifest path", () => {
    expect(parseHlsProviderPath("/hls/provider/abc/3/index.m3u8")).toEqual({
      sid: "abc",
      index: 3,
      rest: "manifest",
    });
  });

  it("parses a segment path", () => {
    expect(parseHlsProviderPath("/hls/provider/abc/3/seg/17")).toEqual({
      sid: "abc",
      index: 3,
      rest: "segment",
      n: 17,
    });
  });

  it("decodes an encoded session id", () => {
    expect(parseHlsProviderPath("/hls/provider/a%2Fb/0/index.m3u8")?.sid).toBe("a/b");
  });

  // Same \d+ grammar as parseStreamPath, deliberately: one address written twice
  // that disagreed would 404 in one place and serve in the other.
  it.each([
    "/hls/provider/abc/-1/index.m3u8",
    "/hls/provider/abc/1.5/index.m3u8",
    "/hls/provider/abc/0/seg/-1",
    "/hls/provider/abc/0/seg/1.5",
    "/hls/provider/abc/0/seg/0/extra",
    "/hls/provider/abc/0/other.m3u8",
    "/hls/provider/abc/0/seg/../../etc/passwd",
    "/hls/provider//0/index.m3u8",
    "/hls/provider/a%ZZ/0/index.m3u8",
  ])("rejects %s", (p) => {
    expect(parseHlsProviderPath(p)).toBeNull();
  });
});

describe("handleHlsProviderRequest", () => {
  it("401s without the capability, before fetching anything upstream", async () => {
    // expect 401, and expect the upstream saw zero requests
  });

  it("404s an unknown session and an out-of-range file index", async () => {
    // expect 404, 404
  });

  it("405s a POST", async () => {
    // expect 405
  });

  it("serves a rewritten manifest with the HLS content type", async () => {
    // expect content-type application/vnd.apple.mpegurl
    // expect body to contain "/hls/provider/<sid>/0/seg/0"
    // expect body NOT to contain the upstream host or "00000.ts"
  });

  it("serves segment 0 by proxying the first url from the manifest", async () => {
    // fetch the manifest first, then /seg/0; expect the segment bytes
  });

  it("404s a segment index past the end of the manifest", async () => {
    // fetch manifest (2 segments), then /seg/9 -> 404
  });

  it("404s a segment when the manifest has not been fetched yet", async () => {
    // /seg/0 with a cold cache -> 404, and the upstream saw no request
  });

  it("NEVER lets a client-supplied string reach an upstream request", async () => {
    // THE SSRF TEST. Inject the requester so every upstream URL is recorded.
    // Drive: /seg/0 (legitimate), then paths carrying traversal, an absolute
    // URL and a bare hostname. Assert every non-legitimate one is a 404 AND
    // that the only URL the requester ever saw is the one from the manifest.
  });

  it("forwards a Range to a segment", async () => {
    // hls.js does issue ranged segment requests; expect 206
  });

  it("never logs the upstream url or the capability", async () => {
    // expect(logs.join("\n")).not.toContain("SECRETTOKEN123")
    // expect(logs.join("\n")).not.toContain(capability)
  });

  it("502s when the provider manifest fetch fails", async () => {
    // upstream 404 for the manifest -> 502 from this route
  });
});
```

Fill each body against the harness. **Every assertion above is the contract and none may be dropped** — in particular the SSRF test must assert on what the injected requester *saw*, not merely on the status code, because a 404 from a rejected path and a 404 from a missing segment are indistinguishable to a status-only test.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/web/hlsProvider.test.ts`
Expected: FAIL — `Failed to resolve import "./hlsProvider"`.

- [ ] **Step 3: Implement the route**

Create `src/web/hlsProvider.ts`, mirroring `src/web/stream.ts`'s structure:

- `isHlsProviderPath(urlPath)` — `urlPath === "/hls/provider"` or starts with `"/hls/provider/"`.
- `parseHlsProviderPath` — two anchored regexes, `\d+` for both the file index and the segment number, `decodeURIComponent` on the sid inside a try/catch (a stray `%` is a malformed link, not a session id), and `Number.isSafeInteger` on both numbers.
- `handleHlsProviderRequest`:
  1. reject a method other than GET/HEAD with 405;
  2. parse, 404 if it does not parse;
  3. **the four guards before anything expensive** — session, capability (`isAuthorized`, with the empty-capability guard), readiness, file bounds;
  4. **manifest**: call `resolveHls(session, index)` for the provider URL; `502` if null; fetch it; `502` on a non-2xx; `rewriteManifest(text, providerUrl, hlsProviderManifestPath(sid, index))`; store `segments` in the cache; respond `200` with `Content-Type: application/vnd.apple.mpegurl` and `Cache-Control: no-store` (the body contains capability-bearing paths);
  5. **segment**: `cache.urlAt(sid, index, n)`; `404` if undefined; otherwise `proxyUpstream(deps, req, res, url, { allowedProtocols: HTTP_AND_HTTPS })`.

Point 5 is the whole security design: the only value that reaches `proxyUpstream` came out of a manifest this server fetched.

- [ ] **Step 4: Point `.info` at it**

In `src/web/stream.ts`'s `.info` branch, replace the Task 3 Step 7 `null` with the box's own path:

```ts
    // While proxying, hand the browser OUR manifest path rather than the
    // provider's URL. `chooseSource` and `mountHls` need no change — they get a
    // URL either way, and the client appends ?k= to a relative path exactly as
    // it does for /stream/ and .m3u.
    const hls =
      deps.proxyDebrid === true
        ? (await (deps.resolveHls?.(session, parsed.index) ?? Promise.resolve(null))) === null
          ? null
          : hlsProviderManifestPath(parsed.sid, parsed.index)
        : ((await deps.resolveHls?.(session, parsed.index)) ?? null);
```

That double call is clumsy; hoist it:

```ts
    const providerHls = deps.resolveHls ? await deps.resolveHls(session, parsed.index) : null;
    // A provider path only when there is actually something to proxy.
    const hls =
      providerHls === null
        ? null
        : deps.proxyDebrid === true
          ? hlsProviderManifestPath(parsed.sid, parsed.index)
          : providerHls;
```

Add a comment to `StreamInfoResponse.hls` in `src/web/wire.ts` saying the field is either the provider's absolute URL or this server's own relative path, and that the client treats both the same way.

- [ ] **Step 5: Mount it in `server.ts`**

Route `isHlsProviderPath(urlPath)` to `handleHlsProviderRequest`, beside the `isStreamPath` branch and outside `handleWebApi` for the same reason — it owns its socket. Construct one `HlsSegmentCache` per process and pass it in. Log the path only.

- [ ] **Step 6: Run everything**

Run: `npm test && npm run typecheck && npm run lint && npm run build`

- [ ] **Step 7: Commit**

```bash
git add src/web/hlsProvider.ts src/web/hlsProvider.test.ts src/web/stream.ts src/web/stream.test.ts src/web/wire.ts src/web/server.ts
git commit -m "feat: proxy the provider HLS manifest and its segments"
```

---

### Task 8: Verify it for real, then finish the docs

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-07-31-proxy-debrid-streams.md` — record what was measured

- [ ] **Step 1: Verify against a live provider**

`npm run dev -- serve --web`, with a debrid token configured and `proxyDebridStreams: true` in config.

- An **mp4** plays, and the browser's network panel shows the bytes coming from the torlnk origin with **no request to the provider's domain at all**.
- An **MKV** plays via HLS, and every segment request goes to `/hls/provider/…` — again nothing to the provider from the browser.
- **Scrub it.** Seeking is what the `Range` forwarding exists for, and a redirect chain is where it breaks.
- Flip the flag off, restart nothing, reload the player: it should go back to redirecting. (The flag is read per request.)

This is also where the **https upstream** is exercised at all — Task 1 tests only the decision. Note in this file that it was done.

- [ ] **Step 2: Measure the cost once, and write the number down**

While one remote (non-LAN) viewer streams, record this machine's upload rate. The README quotes ~25 Mbps for a 1080p remux; if the real figure is materially different, correct the README rather than leaving a number nobody checked.

- [ ] **Step 3: Finish the README**

Task 4 Step 6 wrote the section for the media half. Extend it: with relaying on, MKVs play through this server too, so the upload cost applies to those as well — it is not only the direct-play files.

- [ ] **Step 4: Commit and open the PR**

```bash
git add README.md docs/superpowers/plans/2026-07-31-proxy-debrid-streams.md
git commit -m "docs: measured cost of relaying debrid streams"
```

The PR body must state:

- **Both reasons**, credential first.
- **The upstream arithmetic**, with the measured number.
- **The SSRF design** — segments addressed by index into a server-built list — and that a test asserts no client string reaches an upstream request.
- **The Real-Debrid terms note**, once, factually.
- That configuration is TUI-only by the `CLAUDE.md` exemption, and that the browser needed **no changes** because `.info` hands it the right URL either way.

---

## Self-review notes

- **Spec coverage.** The flag → Task 3. TUI-only toggle → Task 4. `proxyUpstream` allow-list and redirects → Tasks 1–2. The HLS half → Tasks 5–7. Index-addressed segments and the SSRF rule → Tasks 5, 6, 7. Error-handling table → Task 2 (`fail`), Task 3, Task 7. Testing section including the stated https gap → Task 1's module comment and Task 8 Step 1. Docs in spec order → Task 4 Step 6 and Task 8 Step 3. The "third state" where the flag is on before the HLS half exists → Task 3 Step 7.
- **Two things the spec left to the plan, decided here.** The TUI key is `R` ("relay"), verified free against every binding in `keymap.ts`. `StreamDeps` gains `proxyDebrid?: boolean` rather than `stream.ts` loading config, because that module is handed what it needs and must not read the filesystem.
- **One conditional task.** Task 3 Step 7 applies only if PR #57 has merged, with the check spelled out. Increment 2 is blocked on it entirely.
- **Naming consistency.** `resolveProxyTarget`, `resolveRedirect`, `HTTP_ONLY`, `HTTP_AND_HTTPS`, `ProxyRefusal`, `ProxyOptions.allowedProtocols`, `MAX_PROXY_HOPS`, `Config.proxyDebridStreams`, `StreamDeps.proxyDebrid`, `rewriteManifest`, `RewrittenManifest`, `HlsSegmentCache` (`get`/`set`/`urlAt`), `isHlsProviderPath`, `parseHlsProviderPath`, `hlsProviderManifestPath`, `handleHlsProviderRequest` — each defined in exactly one task and used by that name everywhere after.

## Corrections

Recorded after the final whole-branch review, without editing the task steps above — anyone
re-running this plan from scratch should know these three diverged during implementation:

- **Task 4's key is `N`, not `R`.** `R` turned out to be a retired credential hotkey (guarded by
  a live `keymap.test.ts` assertion, `not.toContain("R")`), so the actual binding — in
  `src/ui/keymap.ts` and the `input === "N"` handler in `src/ui/App.tsx` — is `N`, not the `R`
  ("relay") used throughout Task 4's steps and code samples.
- **Task 3 Step 5's snippet is unconditional; the shipped code has a test seam.** The code reads
  `options.streamDeps?.proxyDebrid ?? (await (options.webDeps?.loadConfigImpl ?? loadConfig)()).proxyDebridStreams === true`
  in `src/web/server.ts`, not a bare config read — so a test can drive the proxying branch via
  `streamDeps: { proxyDebrid: true }` without a real config file.
- **Task 4's test snippet used the wrong shape.** `HELP_GROUPS` entries expose `.hints`, not
  `.items`, and there is no group titled "global" in `src/ui/keymap.ts` — the snippet as written
  would not compile against the real module.
