# Playing the containers browsers refuse: MKV and hard audio in the web player

Date: 2026-07-31
Status: design, approved for planning

## The problem

The web dashboard has a play button. For most of what a torrent index returns, pressing it
produces the fallback card — "This one needs a real player" — because `playerModel.ts` allows
exactly `mp4`, `m4v` and `webm`, guessed from the filename, and a browser genuinely cannot
demux Matroska. `README.md:294` says so out loud.

That card is honest and it is not a bug. But the play button is the primary affordance of the
web UI, and for the majority of releases it currently leads to a dead end with instructions.

The fix is not a browser flag. Something has to hand the browser a container and codec pair it
can actually take. Two things can do that: the debrid provider, which will transcode server-side
for a file it already holds, and a local `ffmpeg`, which can remux the container and re-encode
only the audio at near-zero CPU cost.

## Scope

**In scope.** Making playback work in the browser for:

- MKV carrying H.264 video with any audio, on both the debrid and the WebTorrent backends.
- Files whose audio is DTS, TrueHD, E-AC3 or anything else a browser won't decode, where the
  video itself is fine.
- Accurate up-front classification, so a file that genuinely cannot play says so immediately
  instead of showing a black rectangle for twelve seconds first.

**Explicitly out of scope, and this is a deliberate gap, not an omission.** Video-level
transcoding — HEVC, AV1, Dolby Vision. Those need a full re-encode; at 2160p that is unusable
without per-platform hardware-acceleration detection (VideoToolbox, NVENC, QSV), which is a
larger project with its own host-requirements story. A local HEVC file continues to get the
fallback card and the VLC hand-off. Rung 2 below covers a good share of HEVC anyway, because the
provider's own transcode re-encodes the video for us at no cost to this machine.

The argv builder in rung 3 is designed so that adding video transcoding later is a change to one
pure function and its tests, not a change to the route or session plumbing.

## Which front end this lands in

**Browser only**, and this is one of the two cases `CLAUDE.md` names as qualifying: *a surface
can't express it*. The terminal has no `<video>` element. The TUI's play path already hands the
stream URL to mpv, IINA or VLC (`src/util/player.ts`), all of which demux MKV and decode DTS
natively — the problem this design solves does not exist there.

**The PR body must state this exemption and this reason.** One thing does cross over: ffmpeg
detection lands in `src/util/`, not `src/web/`, both because of the layering rule and because a
future TUI use (a "your host can transcode" line in diagnostics) should not have to move it.

## Design: a source ladder

One pure function picks a rung per file. Each rung falls through to the next when its
precondition fails, and the last rung is today's behaviour, so no file gets worse than it is now.

| Rung | Source | Cost to this host | Covers |
| --- | --- | --- | --- |
| 1. Direct play | today's `302` / range proxy, unchanged | none | mp4/webm with browser-safe codecs |
| 2. Provider transcode | provider's HLS manifest | none — bytes never touch torlnk | debrid backend, incl. much HEVC |
| 3. Local HLS | `ffmpeg`: `-c:v copy`, audio → AAC | modest CPU, full bitrate in and out | torrent backend; debrid where rung 2 is unavailable |
| 4. Fallback card | unchanged | none | everything else, honestly |

Rung 2 sits above rung 3 on purpose, and this is the one trade-off worth naming: the provider's
output is a re-encode and therefore a quality loss, where a local remux would be lossless. It is
still preferred because it costs this machine nothing, and because it is the rung that works when
the viewer is a phone away from the house on a connection torlnk's upstream cannot feed. There is
no user setting for this. If it turns out to be wanted, it is a later change.

### Rung 2: the provider's transcode

Real-Debrid exposes `GET /streaming/transcode/{id}`, returning HLS manifest URLs for a file it has
already unrestricted. `{id}` is the download id from the `/unrestrict/link` response — which
`src/integrations/debrid/realdebrid.ts:305` currently reads past and discards, keeping only
`download`, `filename` and `filesize`.

So:

- `ResolvedFile` / `StreamFile` (`src/util/player.ts:14`) gains an optional provider-side id.
  Optional because the WebTorrent backend has no such thing. This ripples into `src/web/wire.ts`.
- `DebridProvider` (`src/integrations/debrid/types.ts`) gains an optional
  `transcodeManifest?(token, fileId, opts): Promise<string | null>`, resolving to one HLS manifest
  URL — the highest quality the provider offers, since choosing between qualities is not a
  decision this design asks the user to make — or `null` when the provider will not transcode this
  particular file. **Optional because its absence is the capability flag** — exactly the existing pattern for `checkCached?`, which is
  absent on Real-Debrid because RD removed instant availability in 2024.
- `/api/sources` reports a new capability flag alongside `debridConfigured`, `debridProvider` and
  `debridCachedCheck` (`src/web/wire.ts:340`), so the browser knows whether rung 2 exists at all
  without being told anything about credentials.

**TorBox is an open question and must not be assumed.** Their API surface here is unverified;
`requestdl` is a direct link, not a manifest. If TorBox has no equivalent, it simply does not
implement the optional method, the capability flag is false, and TorBox sessions land on rung 3.
Verifying this against their current API docs is a task in the plan, not an assumption in this
design.

**The CORS question is the first task in the plan and gates the whole rung.** hls.js fetches the
manifest *and every media segment* over XHR from our own origin, so the provider must send
`Access-Control-Allow-Origin`. This is unverified. One `curl -I` against a real transcode URL
answers it. The three outcomes:

- Headers present → rung 2 as designed, zero bytes through torlnk.
- Absent → the manifest and segments must be proxied through torlnk, which restores a bandwidth
  cost (at the transcode's lower bitrate, so still well below rung 3's). This is a real amount of
  extra work — a second proxy route with its own auth — and if it is needed, rung 2 should be
  reconsidered against just shipping rung 3, rather than built on reflex.
- Partial (manifest yes, segments no, or vice versa) → treat as absent.

Linking out to the provider's own web player page was considered and rejected: it requires the
viewer to be logged into the provider in *that* browser, and the phone on the sofa is not.

### Rung 3: local ffmpeg

For the WebTorrent backend this is the only rung that can work, which is why it is in scope
rather than deferred — a user with no debrid account must not be left with a play button that
never plays anything.

- **Binary discovery** reuses the shape of `PLAYER_CANDIDATES` in `src/util/player.ts:33`: a CLI
  name looked up on PATH, plus known Windows install paths with `%ENV%` tokens, and **fail soft
  when absent**. No ffmpeg means rung 3 is unavailable and the ladder falls to rung 4 — i.e.
  exactly today's behaviour. ffmpeg is not becoming a hard dependency of torlnk.
- **Distribution**: detection only. No new npm dependency, no download in `postinstall`. Every
  current dependency is pure JS and this design does not change that. If bundling ffmpeg is ever
  wanted, `scripts/ensure-webrtc.cjs` is the precedent, but it is not proposed here.
- **The argv is a pure function** returning `string[]` — `-c:v copy`, audio to AAC, fMP4 HLS
  segments — so the interesting decisions are unit-testable without executing anything.
- **A transcode-session registry** mirrors `StreamSessionRegistry` (`src/core/streamSession.ts`):
  one ffmpeg process and one temp segment directory per (session, file), reference-counted, torn
  down when the stream session ends or after an idle timeout. The failure this must not have is a
  leaked ffmpeg pulling a torrent forever after the tab closed.
- **A new route family, `/hls/…`.** `/stream/:sid/:idx` and its Range-forwarding proxy are not
  touched. That proxy is the thing that makes direct play free, and it is the most carefully
  commented code in `src/web/` for good reason.
- **Auth**: segment URLs carry the same `?k=` session capability as `/stream/`, for the same
  reason — `<video>` and hls.js cannot send a bearer token.
- **Seeking into an incomplete torrent** will stall while pieces arrive. Sequential transcoding is
  the ideal access pattern for a torrent, so ordinary playback is fine; a seek far ahead is not.
  It buffers, and the existing stall detection is what reports it if it never resolves.

### Classification: stop guessing from the extension

Rung selection needs to know the real codecs. Two sources, in preference order:

1. **`ffprobe`** over an HTTP range against the file. Accurate. Available only when the binary is.
2. **The release name.** `src/util/release.ts` already parses HEVC, DTS, resolution and friends
   out of a title. Strictly better than the current extension-only check and needs no binary, so
   classification improves even on a host with no ffmpeg at all.

This is worth shipping on its own merits regardless of the rest. Today an mp4 carrying HEVC gets
optimism, twelve seconds of black, then the card (`STALL_MS` in `playerModel.ts`). With
classification it is instant and correct.

### Client side

- `chooseSource(probe, capabilities)` is a pure function in `playerModel.ts`, next to
  `canDirectPlay`, unit-tested. `player.ts` stays DOM wiring. `CLAUDE.md` records this being
  caught in review twice; a conditional in `player.ts` deciding *what to show* or *what to send*
  is the thing not to write.
- **iOS forces a native-HLS path, it is not a preference.** iPhone Safari has no Media Source
  Extensions, so hls.js cannot run there — but Safari plays HLS natively from `video.src`. So:
  `canPlayType("application/vnd.apple.mpegurl")` → assign `src` directly; otherwise load hls.js.
  Given the audience is largely "a phone on the sofa", the native path is the more important half.
- **hls.js is dynamically `import()`ed**, so a direct-play mp4 never downloads it, and it needs an
  entry in `noExternal` in `tsup.web.config.ts`. That file explains at length why: tsup treats
  `dependencies` as external, which for a browser bundle leaves a bare specifier no browser can
  resolve, the build reports success, and nothing in the test suite can see it.
- The existing `error`/stall detection and fallback card remain the failure path for every rung.
  A rung that fails at runtime lands on the card, which already says the right thing.

## Error handling

The rule is that every failure lands somewhere honest, and nothing silently degrades to a black
rectangle.

| Failure | Result |
| --- | --- |
| `ffprobe` absent | classify from the release name |
| Classification wrong (either source) | `error`/stall detection → fallback card, as today |
| Provider has no transcode capability | rung 3 |
| Provider transcode request fails or 404s | rung 3 |
| Manifest blocked by CORS | rung 3 (see the gate above) |
| ffmpeg absent | rung 4 — today's behaviour exactly |
| ffmpeg exits non-zero mid-stream | card, and the session is reaped |
| Video codec needs a re-encode, and rung 2 was unavailable | rung 4, with the card naming the reason |
| Tab closed | segment dir removed, ffmpeg killed, refcount to zero |

## Testing

There is no jsdom in this repo and this design does not add one.

- **Pure modules get real tests**: `chooseSource`, the argv builder, the classification merge of
  probe and release-name signals, the manifest URL parse.
- **Routes are tested against a real `http.Server`**, the way `src/web/stream.test.ts` already
  does — the comment there is explicit that a fake HTTP client cannot show that a Range survived
  a socket, and the same is true of segment delivery and capability rejection.
- **ffmpeg is not executed in the suite.** The process boundary is injected, as
  `streamTorrentImpl` and `resolveDebridImpl` already are on `StreamSessionDeps`.
- **Wiring is verified by running it**: `npm run dev -- serve --web`, against both backends, on a
  desktop browser and an actual iPhone — the iOS native-HLS path cannot be tested any other way.
- **Fixtures use the invented cast only.** `Tin.Rivers.2024.2160p.WEB-DL.DV.HDR.Atmos.7.1-GROUP`
  is already the HEVC-plus-Atmos case, `Kestrel.2010.1080p.BluRay.x264` the H.264 one. No real
  titles, per `CLAUDE.md`.

## Documentation

- `README.md:294` currently promises that mkv, HEVC and DTS will not play. It changes, and the
  replacement has to stay honest about the remaining gap: video-level HEVC on a local torrent
  still needs a real player.
- The web UI's own limitations list is checked against reality in the same change.

## Sequencing

Three increments, each shippable alone:

1. **Classification.** Release-name and `ffprobe`-backed codec detection replacing the extension
   check. No transcoding. Immediately removes the twelve-second black rectangle. Small.
2. **Rung 2**, gated on the CORS check being the very first thing done. Zero host cost, covers the
   debrid majority.
3. **Rung 3.** The bulk of the work, and what makes the play button work without a debrid account.
