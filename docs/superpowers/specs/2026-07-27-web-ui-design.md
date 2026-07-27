# Web UI — design

**Date:** 2026-07-27
**Status:** approved, ready for planning
**Scope of this document:** Phases 1 and 2 (core extraction + web skeleton, then streaming).
Phases 3 and 4 are described only as boundaries; each gets its own spec.

## Problem

torlink is a TUI. Everything it can do — search, queue, stream, For You — is reachable
only from a terminal on the machine running it. The daemon already exposes a small HTTP
API (`src/daemon/serve.ts`: `/health`, `/status`, `/downloads`, `/add`, `/control`), but
that API is a scripting doorway, not an interface: no search, no streaming, no posters.

We want a browser interface with the same reach as the TUI, usable from another device on
the LAN, able to play what it finds.

The obstacle is not the web server. A Node process can render Ink to stdout and listen on
a socket at the same time; that part is routine. The obstacle is that the *orchestration*
lives in the React layer. `src/daemon/runtime.ts` knows only about the download queue.
Search, Real-Debrid resolution, stream sessions and the recommendation feed are driven
from `src/ui/App.tsx` and its hooks, where no headless caller can reach them.

## Approach

Introduce a headless service layer that both front-ends consume, and a transport layer
that is only transport.

```
src/core/              new — headless orchestration, no React, no http
  search.ts              fan-out across sources, dedupe, health, sort
  streamSession.ts       start/track/stop stream sessions (RD or WebTorrent)
  posterCache.ts         fetch-once disk cache of poster originals
  feed.ts                recc / For You + OMDb enrichment      (phase 4)

src/web/               new — transport only
  server.ts              startWebServer(runtime, opts)
  routes/*.ts            json api, SSE, /stream, /poster
  static/                vanilla TS/HTML/CSS, built into dist/web

src/daemon/runtime.ts  widened: owns sessions and posters alongside queue
src/daemon/serve.ts    mounts startWebServer under --web
src/ui/App.tsx         becomes a view over core, shrinking substantially
```

`startWebServer(runtime, opts)` is the single mount point. `torlnk serve --web` and
`torlnk --web` are two callers of one module — no duplicated logic between the daemon and
the TUI.

### Why the extraction comes first

Phase 1 is largely "move code and prove nothing broke". That is deliberate. Search,
streaming and the feed are each small once `core/` exists and each is unbuildable before
it. Attempting the web UI as a bolt-on would mean reimplementing search fan-out and stream
lifecycle a second time, in a second place, with a second set of bugs.

The extraction is more tractable than `App.tsx`'s size suggests. The logic is already
concentrated in three hooks, and their hard parts are already exported pure functions:

- `src/ui/hooks/useConcurrentSearch.ts` — `mergeDuplicateResults`, `shouldBench`, the
  health/bench interaction and the sort are pure and separately tested today. Only the
  fan-out `useEffect` needs rehoming.
- `src/ui/hooks/useTitlePreview.ts` — OMDb lookup and poster fetch.
- `src/ui/hooks/useRecommendations.ts` — recc feed (phase 4).

Each hook becomes a thin `useState` subscriber over the corresponding core module.

## Core modules

### `core/search.ts`

```ts
runSearch(
  query: string,
  sources: readonly Source[],
  opts: { onSource?: (id: SourceId, state: SourceState) => void; signal?: AbortSignal },
): Promise<TorrentResult[]>
```

Callback-driven progressive emission: each source that completes (or fails, or times out)
pushes a `SourceState` update, so both the TUI and the browser can render partial results
as they arrive rather than waiting for the slowest source. The existing 25s per-source
timeout, `sourceHealth` bench/skip behaviour and `AuthRequiredError` carve-out move across
unchanged, along with their tests.

### `core/streamSession.ts`

```ts
startSession(input: { magnet: string; infoHash: string; route: StreamRoute }): Promise<Session>
getSession(id: string): Session | null
stopSession(id: string, opts?: { keep?: boolean }): Promise<void>

interface Session {
  id: string
  route: "realdebrid" | "torrent"
  state: "resolving" | "ready" | "error"
  files: StreamFile[]        // upstream urls (RD link or localhost WebTorrent url)
  progress?: number          // RD cache progress, or torrent completion
  error?: string
  capability: string         // random; gates ?k= media access
}
```

`Session.files` holds *upstream* URLs and stays server-side. The `/api/stream` response
maps each file to `{ filename, bytes, handle }` where `handle` is the `/stream/:sid/:idx`
path; a client never receives an RD link or a `localhost:<ephemeral>` URL.

One type over two backends. `classifyStreamRoute` (`src/ui/streamRoute.ts`) is reused
unchanged, so the RD-vs-torrent decision — including the "token present but premium
inactive → require explicit confirmation" case that exists to avoid silently exposing the
user's IP — behaves identically in the browser and the TUI.

Sessions are owned by the runtime, so both front-ends see one list. A session started from
the TUI is playable in the browser and vice versa.

### `core/posterCache.ts`

```ts
getPoster(url: string): Promise<{ path: string; bytes: number } | null>
```

SHA-1 of the URL as the cache key, stored under the `env-paths` cache directory, pruned
LRU at a size cap. Never throws; a miss that cannot be fetched returns `null` and callers
fall back to their existing placeholder.

One cached original serves both front-ends. The browser receives the full-quality JPEG
bytes — the improvement asked for, since a browser has no reason to be limited to what a
terminal can show. The TUI's `renderJpegPoster` half-blocks that same file instead of
re-fetching, so the cache is a net reduction in network traffic even for terminal-only use.

## HTTP surface

Mounted by `startWebServer(runtime, opts)`.

The existing `/health`, `/status`, `/downloads`, `/add` and `/control` routes keep their
current paths and payloads. They are a documented API that may already be scripted
against; new work lands under `/api/*` and the old paths remain as aliases.

```
GET    /                          UI shell
GET    /assets/*                  static assets
GET    /api/status                queue + seeds (existing statusPayload, extended)
GET    /api/events                SSE deltas, with heartbeat
POST   /api/add                   as today
POST   /api/control               as today
GET    /api/poster?url=…          cached full-quality poster bytes
POST   /api/stream                { magnet, infoHash } → { sessionId, capability, files[] }
GET    /api/stream/:sid           session state (resolve progress, peers, error)
DELETE /api/stream/:sid           stop session (?keep=1 to keep files)
GET    /stream/:sid/:idx?k=…      302 → RD  |  range-proxy → WebTorrent
GET    /stream/:sid/:idx.m3u?k=…  playlist for VLC / the OS default player
GET    /play/:sid/:idx            player page
```

SSE rather than polling; the queue already emits the necessary events.

### The stream handle

One URL shape, two backends. `/stream/:sid/:idx?k=…` resolves as:

- **Real-Debrid** → `302` to the unrestricted link. The browser talks straight to RD's
  CDN: native range and seeking, zero bytes through the daemon, and the raw RD URL never
  appears in page source. RD is expected to be the primary streaming route in practice.
- **WebTorrent** → reverse-proxy the range request to the local WebTorrent server
  (`createServer()` already speaks HTTP ranges). This exists because those URLs are
  `http://localhost:<ephemeral>/…` and will not resolve from a phone on the LAN.

The `?k=` capability parameter is required because `<video>`, `<img>` and VLC do not send
`Authorization` headers. It is a per-session random string that expires with the session
and grants read access to that session's media only.

### Playback and the codec boundary

Browsers play mp4/H.264/AAC. They do not play the mkv/HEVC/DTS combination common in
scene releases. This design does not attempt to fix that.

No server-side probe in phase 1. File extension sets initial optimism (`mp4`, `m4v`,
`webm` → attempt direct play); anything else, or a `<video>` `error`/stall event, flips to
an honest fallback card offering:

- the `.m3u` playlist link (`Content-Type: audio/x-mpegurl`), which the OS hands to the
  default media player — the only reliably cross-platform "open in VLC" mechanism;
- `vlc-x-callback://` on iOS/macOS and `intent://…#Intent;package=org.videolan.vlc` on
  Android, where those schemes are actually registered;
- copy-URL.

There is no universally registered desktop `vlc://` scheme, so we do not pretend there is.

A named `TranscodeProvider` seam is defined so ffmpeg remux/transcode can be added later.
Nothing implements it in this scope, and no ffmpeg dependency is introduced.

## Security

Reuses `src/daemon/auth.ts` — `isAuthorized`, `hostHeaderOk`, and the existing rule that
binding a non-loopback host without a token is a startup error rather than a silent open
door. Three additions:

**Browser auth without a CSRF surface.** The token is entered once, held in
`sessionStorage`, and sent as an `Authorization` header on every JSON call. Because no
cookie authenticates the API, there is no cross-site request forgery vector to defend.
Media and static GETs that cannot carry headers use the `?k=` capability instead, which
grants read access to one session's bytes and cannot mutate anything.

**Residual risk of the 302, stated plainly.** The browser ends up holding an RD
unrestricted URL in its network log. Anyone who obtains that URL can consume the account's
bandwidth until it expires. This is inherent to direct play and is the accepted trade for
native seeking and zero daemon bandwidth. A proxy-RD-bytes mode remains a possible future
config flag.

**Reverse proxy headers are opt-in.** `X-Forwarded-Proto` and `X-Forwarded-Host` are
honoured only under an explicit `--trust-proxy` flag. The `.m3u` endpoint needs absolute
URLs, and trusting those headers unconditionally would let any client poison the generated
address.

A simple attempt limiter applies to token submission.

Deployment guidance (Caddy / Tailscale for off-network access) ships as documentation, not
code.

## Error handling

Stream failures reuse the TUI's existing message strings —
`messageForTorrentStatus`, `TOKEN_REJECTED_MESSAGE`, the no-peers metadata timeout — so
both front-ends report the same condition in the same words. A failed session surfaces as
`state: "error"` with that message rather than a generic 500.

`startWebServer` takes an **injected logger and never touches `console` directly**.
`serve.ts` passes `console`; the TUI passes its own log sink. Ink owns stdout, so a stray
`console.log` from a request handler corrupts the rendered frame — a failure mode that is
both ugly and hard to trace back to its cause. This is a hard constraint, not a preference.

Route handlers follow the existing `handleApi(runtime, …) → { status, body }` shape: pure
functions over the runtime, with `node:http` confined to a thin outer layer.

## Testing

- Core modules tested headlessly, with injected `fetch`/fs seams matching the conventions
  already used across the codebase.
- Route handlers unit-tested without sockets, as `serve.ts` does today.
- Stream handle: RD path asserted as `302` with the expected `Location`; WebTorrent path
  asserted to forward `Range` and propagate `206` and `Content-Range` from a fake upstream.
- Poster cache: hit, miss, fetch failure, and prune-at-cap, with injected fs and fetch.
- Frontend logic is written as pure state reducers and tested directly. No jsdom or
  happy-dom dependency is added; DOM binding stays thin enough not to warrant it.
- **The existing TUI suite must pass unchanged.** The phase 1 extraction is only correct if
  it is invisible from the terminal; that suite is the safety net proving it.

## Phasing

| Phase | Contents | Depends on |
|---|---|---|
| **1. Core extraction + skeleton** | `core/search.ts`, `core/streamSession.ts`, `core/posterCache.ts`; widened `runtime.ts`; `startWebServer` with status/add/control + SSE + `/api/poster`; queue dashboard UI; TUI hooks rewired as subscribers. | — |
| **2. Streaming** | Stream handle (RD 302 + WebTorrent range proxy), capability tokens, `.m3u`, player page with direct-play and fallback card, session lifecycle and cleanup. | 1 |
| **3. Search in the browser** | Search UI, source health display, filters and sort, full-quality poster grid, add-to-queue and stream-from-result. | 1, 2 |
| **4. For You** | `core/feed.ts`, recc feed UI, rate/watchlist actions, import status. | 1 |

Phase 1 is independently valuable even if nothing follows it: a live queue dashboard, and a
poster cache that makes the TUI itself faster.

## Out of scope

- ffmpeg transcoding or remuxing (seam defined, not implemented).
- Client-side mkv demuxing via Media Source Extensions.
- Authentication beyond a shared token — no user accounts.
- Proxying Real-Debrid bytes through the daemon.
- Phase 3 and 4 implementation detail; each gets its own spec.
