# Web UI Phase 2: Streaming — Implementation Plan

**Goal:** Play a torrent from the browser — Real-Debrid by 302, WebTorrent by range proxy, VLC by `.m3u`, and an honest fallback when the browser can't decode the file.

**Spec:** `docs/superpowers/specs/2026-07-27-web-ui-design.md`. Phase 1 plan (and its recorded traps): `2026-07-27-web-ui-phase-1.md`.

**Architecture:** One URL shape, two backends. `/stream/:sid/:idx?k=` either 302s to a Real-Debrid link (browser talks straight to their CDN — native seeking, zero bytes through the daemon) or reverse-proxies range requests to the local WebTorrent server (whose URLs are `localhost:<ephemeral>` and unreachable from a phone). `core/streamSession.ts` already owns both backends behind one `StreamSession`; this phase is transport and frontend.

---

## What already exists

- `src/core/streamSession.ts` — `StreamSessionRegistry` with `start`/`get`/`list`/`stop`/`stopAll`, per-session `AbortController`, orphaned-handle guard. `StreamSession` carries `id`, `capability`, `backendHandle`, `backend`, `name`, `state`, `files: StreamFile[]` (upstream URLs), `progress`, `error`, `createdAt`.
- `src/core/streamRoute.ts` — `classifyStreamRoute(config, rdStatus)` → `realdebrid` | `torrent-auto` | `torrent-confirm`.
- `src/util/player.ts` — `StreamFile`, `pickStreamFile`, `streamCandidates` (video-first heuristic).
- `src/web/server.ts` — `startWebServer`, `writeWebResponse` (returns the status actually written), `isApiPath`, injected logger.
- `src/web/wire.ts` — types-only wire contracts.
- `src/daemon/auth.ts` — `isAuthorized`, `hostHeaderOk`, `isCrossSiteRequest`.

## Carried-forward constraints — these are not optional

1. **Serialise by picking fields, never by omitting.** `capability` and every `files[].url` must not reach a browser. `JSON.stringify(session)` is the obvious wrong reach. A field added later must default to private.
2. **A guard's mutant must die.** Every new guard gets a mutation check with the failure quoted.
3. **An injected transport can't observe the real one's defaults.** A test with a fake `fetch` cannot prove anything about redirect following, keep-alive, or range handling by the real client. Assert on the `init` argument instead.
4. **Resource leaks are invisible to output assertions.** Use `vi.getTimerCount()` / `listenerCount` / socket counts.
5. **Never `console` from the web layer.** Ink owns stdout in TUI-hosted mode.
6. **Editing `src/web/static/` needs `npm run build`** before the change is served.

---

## Unit 1 — Session API and safe serialisation

**Files:** `src/web/wire.ts`, `src/core/streamSession.ts`, `src/web/routes.ts`, `+ tests`

- `wire.ts` gains `PublicStreamFile { filename, bytes, index, handle }` and `PublicStreamSession { id, backend, name, state, progress, error?, files }`. Document that `handle` is a path, not a URL, and that the capability is returned once at creation and never inside a session body.
- `core/streamSession.ts` gains `toPublicSession(session, capability?)` built by **explicit field picking**. A test must assert the output contains no `capability` and no upstream `url` — iterate the serialised JSON rather than checking known keys, so a field added later fails the test.
- Routes:
  - `POST /api/stream` `{magnet, infoHash, name}` → start a session, return `{sessionId, capability, session}`.
  - `GET /api/stream/:sid` → `PublicStreamSession`.
  - `DELETE /api/stream/:sid?keep=1` → stop.
  - All require the bearer token; all are `/api/*` so the CSRF gate already covers the mutating ones.
- Route classification uses `classifyStreamRoute` with the loaded config so Real-Debrid is preferred exactly as in the TUI. A `torrent-confirm` result must be reported to the client as a distinct state, never silently downgraded — that decision exists to stop a non-premium account leaking the user's IP.

**Mutation checks:** `toPublicSession` leaking `capability`; leaking `files[].url`; the token gate on each new route; `torrent-confirm` being treated as `torrent-auto`.

---

## Unit 2 — The stream handle

**Files:** `src/web/stream.ts` (new), `src/web/server.ts`, `+ tests`

`GET /stream/:sid/:idx?k=<capability>`:

- **Capability auth, not the bearer token.** `<video>` and VLC cannot send headers. Compare with the same constant-time helper `isAuthorized` uses; a wrong or missing `k` is 401. The capability grants **read access to one session's media only** — it must not satisfy any `/api/*` route.
- **Real-Debrid** → `302` with `Location` set to the unrestricted link. The raw RD URL must never appear in any JSON body or log line.
- **WebTorrent** → reverse-proxy to the local server: forward `Range`, propagate `206`, `Content-Range`, `Content-Length`, `Accept-Ranges`, and the upstream status. Destroy the upstream request when the client disconnects, or a seek storm leaks one socket per abandoned request.
- `HEAD` must work — players probe with it before ranging.
- An unknown `sid`, an out-of-range `idx`, or a session not in `ready` is a 404, never a 500.

**Mutation checks:** capability check removed; capability accepted on an `/api/*` route; `Range` not forwarded; upstream status not propagated; client-disconnect teardown removed (assert socket/listener counts, not output).

---

## Unit 3 — `.m3u` playlist and player page

**Files:** `src/web/stream.ts`, `src/web/static/player.html`, `player.ts`, `+ tests`

- `GET /stream/:sid/:idx.m3u?k=` → `Content-Type: audio/x-mpegurl`, `Content-Disposition: attachment`, body = one absolute URL. This is the only reliable cross-platform "open in VLC": there is no registered desktop `vlc://`.
- Absolute URLs need a base. Derive from the `Host` header; honour `X-Forwarded-Proto`/`Host` **only** under an explicit `trustProxy` option, because trusting them unconditionally is redirect poisoning.
- `GET /play/:sid/:idx` → a player page: `<video>` pointed at the handle, plus buttons for `.m3u`, copy-URL, and `vlc-x-callback://` (iOS/macOS) and `intent://…#Intent;package=org.videolan.vlc` (Android).
- **Direct-play with an honest fallback.** Extension picks initial optimism (`mp4`/`m4v`/`webm` → attempt). On a `<video>` `error` or stall, replace the player with a card explaining that this release needs a real player, with the VLC options. Do not show a black rectangle and hope.

**Mutation checks:** `trustProxy` ignored (forwarded headers honoured unconditionally); m3u content type; the fallback never triggering.

---

## Unit 4 — Wire it into the dashboard

**Files:** `src/web/static/app.ts`, `dashboard.ts`, `styles.css`, `+ tests`

- A **Play** action on rows that have something playable. Clicking it `POST`s `/api/stream`, polls `GET /api/stream/:sid` while `state === "resolving"` (Real-Debrid caching can take minutes — show the percent), then opens the player.
- Multiple video files → a picker, using `streamCandidates`' video-first heuristic rather than a raw file list.
- A `torrent-confirm` route must prompt before proceeding, matching the TUI: the user configured Real-Debrid and it isn't working, so falling back to P2P without asking would expose their IP.
- Stop a session when the player closes; a `DELETE` on unload is best-effort, so the registry also needs the existing idle reaping to matter — log if sessions accumulate.

---

## Unit 5 — Docs, verification, milestone

- README: streaming section — what plays in a browser and what needs VLC, and why (mkv/HEVC/DTS is most of the scene).
- Full suite, typecheck, lint, build.
- **Real verification in a browser**, not just tests: start a session against a real public-domain torrent, confirm the handle serves bytes with correct range headers, confirm `.m3u` downloads and contains an absolute URL, confirm the fallback card appears for a file the browser can't decode.
- Commit and push.

---

## Out of scope for Phase 2

ffmpeg transcoding or remuxing (the `TranscodeProvider` seam is named in the spec, nothing implements it), client-side mkv demuxing, subtitle handling, a playlist of multiple episodes, resume-where-you-left-off.
