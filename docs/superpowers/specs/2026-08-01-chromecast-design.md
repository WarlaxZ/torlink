# Casting a stream to a Chromecast, from either front end

Date: 2026-08-01
Status: design, approved for planning

## The problem

Both front ends can play a torrent and both can hand it to something else — the terminal spawns
mpv, IINA or VLC; the browser plays it inline, or hands out a URL, a `.m3u` and a mobile VLC
link. Neither can put it on the television, which for a great deal of what this app is used for
is the only screen that matters. The user's route today is to download the `.m3u`, open it in a
desktop app and cast that app's window, which re-encodes the whole film through the laptop to
show it on a device that could have fetched the bytes itself.

## The constraint that decides the architecture

`serve --web` is plain HTTP (`src/web/server.ts:389`) and the normal way in is
`http://192.168.x.x:9161`. Google's Cast Web Sender SDK is secure-context-only: on a LAN IP
`chrome.cast` never initialises. A cast button built on the SDK is therefore a button that works
only for whoever is browsing `localhost` — which is the dead-button failure this repo has already
refused once, when `vlcLinks` was made to return `[]` on macOS because "a button there would be a
button that does nothing".

So torlink does the casting itself: it discovers Chromecasts on the LAN over mDNS and drives them
over the CASTV2 protocol, the way `catt` and `castnow` do. That choice pays for itself twice —
it works over plain HTTP and from a phone, and it puts the casting in `src/core`, where both
front ends are clients of one implementation rather than two.

## Scope

**In scope.** Discovering Chromecast devices; casting one file to one of them from either front
end; pause, resume, stop, and a live position on screen; the subtitle the user already picked;
and marking the file played, so a cast lands in Continue watching exactly as a local play does.

**Out of scope, deliberately.** Seeking and volume from torlink — the TV's own remote and the
Google Home app do those, and each control added here is another failure mode over a flaky LAN
socket. Casting to anything that is not a Chromecast (AirPlay, DLNA). Multi-device groups.
Queueing a season onto the device. Video-level transcoding, for exactly the reason the
hard-containers design gives: HEVC and AV1 need a full re-encode, which needs per-platform
hardware acceleration, which is its own project.

**Two things this design does not build on, because they do not exist in the tree.** Both were
checked rather than assumed, and each removes something an earlier draft of this document
promised:

- **There is no persisted time position anywhere in torlink.** `StreamHistoryItem`
  (`src/core/streamHistory.ts:24`) carries a season and an episode and no seconds, and neither
  front end tracks `currentTime` for resume — `recordPlayedFile` advances progress at *episode*
  granularity. So the position a cast reports is **displayed and not stored**, and casting marks
  the file played through the same hook a local play uses. A real resume point is a feature for
  both front ends and both players, and it is not this one.
- **The source ladder's local-`ffmpeg` rung was never implemented.** `src/util/ffmpegBin.ts`
  exists but its only consumer is `findFfprobe` in `src/core/probe.ts`; nothing spawns a
  transcode. The rungs that exist are direct play and the debrid provider's HLS
  (`chooseSource`, `src/web/static/playerModel.ts:169`). Casting therefore covers exactly what
  the browser covers: **an MKV on the debrid backend casts via the provider's transcode; an MKV
  from a torrent cannot cast**, and says so. It starts working the day rung 3 lands, with no
  change here, because casting asks the same ladder.

## Where the code lives

```
src/core/cast/protocol.ts     pure: CastMessage codec + length framing
src/core/cast/discover.ts     mDNS query → CastDevice[]
src/core/cast/connection.ts   TLS socket, heartbeat, channels, LAUNCH/LOAD/commands
src/core/cast/session.ts      the one active cast, its status, its history writes
src/util/playability.ts       gains a capability profile (existing module)
src/web/routes.ts             three routes; types in src/web/wire.ts
src/web/static/castModel.ts   pure: every browser-side decision
src/ui/                       the picker's `c`, the cast row, keymap, store
```

`src/core/cast` imports nothing from `src/ui` or `src/web`, per the layering rule. In particular
it never builds a URL — the caller passes one in. That is what keeps it from reaching for
`src/web/links.ts`, and it is also what makes it testable without a server.

### `protocol.ts`

A `CastMessage` has six fields and its shape never varies: `protocol_version` (enum),
`source_id`, `destination_id`, `namespace` (strings), `payload_type` (enum) and `payload_utf8`
(string). Everything torlink sends or reads is JSON in `payload_utf8`; the binary payload field
is never used. Encoding that by hand is around sixty lines, so `protobufjs` — roughly a megabyte
into the bundled CLI, whose whole runtime dependency list is ten packages — is not warranted.

Framing is a 4-byte big-endian length followed by the message. The frame *reader* is a named
function with its own tests rather than inline socket code, because a length prefix split across
two TCP reads is the bug every hand-rolled framer has on its first day, and a reader that also
refuses an absurd claimed length cannot be made to buffer without bound by a hostile answer on
port 8009.

### `discover.ts`

`discover(deps, timeoutMs)` sends a PTR query for `_googlecast._tcp.local` through
`multicast-dns` and assembles `CastDevice { id, name, model, host, port }` from the SRV record
(host and port), the A record (address) and the TXT keys `id`, `fn` (friendly name) and `md`
(model).

`multicast-dns` is the one new dependency, and it is the half worth taking: DNS name compression,
several interfaces answering at once and multicast group membership are real edge cases, where
the protocol above is a fixed six-field message. The mdns factory is injected, so the tests feed
canned records and never open a socket.

A response missing an SRV record is dropped rather than half-built — a device with no port is not
a device. Two interfaces answering for the same TV collapse by `id`. Results are cached briefly
and refreshed on request, because "the TV was off ten seconds ago" is the normal case, not an
error.

### `connection.ts`

A TLS socket to `<host>:8009` with `rejectUnauthorized: false`. The certificate is device-signed
and there is no chain to check it against; the reason this is acceptable rather than merely
convenient is that nothing secret goes over it — the payload is a URL that is already available
to anyone holding the `?k=` token on the LAN.

On top of that: `urn:x-cast:com.google.cast.tp.heartbeat` PING every 5 seconds, namespace-routed
virtual channels, `LAUNCH` of the default media receiver `CC1AD845`, then `LOAD` on
`urn:x-cast:com.google.cast.media`, and `PAUSE` / `PLAY` / `STOP` plus `MEDIA_STATUS` after that.
The socket factory is injected, so every failure row in the table below is a test against a fake
socket rather than a story about a television.

The `LOAD` request must name a `contentType` the default receiver recognises, and it differs per
rung: `video/mp4` or `video/webm` for direct play, `application/vnd.apple.mpegurl` with
`streamType: "BUFFERED"` for the provider HLS rung. Getting it wrong is a `LOAD_FAILED` rather
than a guess, so the mapping is a pure function beside the profile it belongs to and has its own
test.

### `session.ts`

`CastSessionRegistry` holds at most one active cast per process: the device, what is playing, and
the last `MEDIA_STATUS`. The position in that status is state, not a store — it drives the line
on screen and nothing writes it to disk, because there is nowhere to write it to (see Scope).

What *is* persisted is the same thing a local play persists: on a successful `LOAD`, the file is
marked played through `markWatched` and `recordPlayedFile`, so a cast advances Continue watching
like anything else. On `LOAD`, not on cast start — a device that refuses the file must not earn
a ✓, which is the rule `playFromPicker`'s `onPlayed` callback already follows in the TUI.

## Chromecast is a second capability profile, not a second list

`src/util/playability.ts` currently hard-codes one set of answers —
`SAFE_CONTAINERS`/`SAFE_VIDEO`/`SAFE_AUDIO` — for the question "will a browser play this".
`blockersFor(facts)` becomes `blockersFor(facts, profile = BROWSER)` and a `CHROMECAST` profile
joins it. Same module, because it is the same question asked of a different decoder, and a second
list somewhere else is the copy-then-drift bug this codebase has recorded four times.

| | Browser (unchanged) | Chromecast |
| --- | --- | --- |
| Containers | `mp4`, `m4v`, `webm` | same — MKV is not one, on either |
| Video | `h264`, `vp8`, `vp9` | same |
| Audio | `aac`, `mp3`, `opus`, `vorbis`, `flac` | those **plus `ac3` and `eac3`** |

Two calls in that table are deliberate and each has a cost:

- **HEVC and AV1 stay blocked**, even though a Chromecast Ultra or a Google TV device decodes
  HEVC. The `md` TXT key names a model, but a model name is a guess about a device's decoder and
  about the television behind it, and there is no video transcode to fall back to. The refusal a
  user gets is the same one the browser gives, for the same honest reason.
- **AC3 and E-AC3 are allowed**, which is passthrough and therefore depends on the television or
  receiver on the other side of the HDMI cable. Where that link cannot take it the result is
  silent video, which is a bad failure. It is still the right call, and more clearly so now that
  there is no local transcode to fall back to: every Chromecast generation lists AC-3 and E-AC-3,
  and blocking them would simply *refuse a file that would almost certainly have played* — on the
  torrent backend it would refuse it outright, with no rung underneath. Silence is recoverable in
  one keypress; a refusal is not recoverable at all. A test pins the choice so it cannot be
  reversed by accident.

This is also what makes a small feature possible on the other side: a file the browser refuses
but the device accepts — an MP4 carrying AC3 — currently ends at the "this one needs a real
player" card. With two profiles that card can offer to cast it, which is the point of having
profiles rather than one list.

## One URL shape, both front ends

The cast target is always `/stream/<sid>/<idx>?k=…` on torlink's own web server, chosen by the
same source ladder the browser player walks — direct play, then the provider's HLS transcode,
then an honest refusal — with `CHROMECAST` in place of `BROWSER`. Consequences:

- The browser's cast button reuses the stream session the page already has.
- The TUI's cast ensures the in-process web server is up, opens a session, and casts the same
  URL. It announces that ("Started the web UI on … so the TV can reach the file") rather than
  starting a server behind the user's back.
- An MKV on the debrid backend casts, by the provider's transcode. An MKV from a torrent does
  not, and says which of the two it is. HEVC says why it cannot, on either backend.
- There is one auth story: the `?k=` token, which the device carries in the query string.

**The origin comes from `displayHosts(...).lan`, never from the request's `Host` header.** A user
browsing `http://localhost:9161` would otherwise hand the television a `localhost` URL. The last
spec in this directory investigated a `127.0.0.1` playlist report and found it was a second
server on another port; this is the same failure arriving for real, and the guard against it is a
test that pins the LAN address even when `Host` says `localhost`.

### Why the TUI cannot cast its own stream server

`src/integrations/torrentStream.ts:73` binds the WebTorrent HTTP server to `localhost` on an
ephemeral port, so a Chromecast cannot fetch from it. The alternative to routing through the web
server would be binding that one to `0.0.0.0`, which exposes the file to everything on the
network with no auth at all, and which has no ladder above it at all — so a debrid MKV would cast
from the browser and not from the terminal. Rejected on both counts.

A second reason, which is the one that makes this cheap: the TUI holds resolved files and never
registers them with `Runtime.sessions` (nothing in `src/ui/App.tsx` calls into the registry it
constructs at line 265). Casting needs a session id either way, so `StreamSessionRegistry` gains
an `adopt` method for already-resolved files — one small, tested addition instead of a second
resolve.

## Subtitles

The subtitle the user has already picked is passed as a `tracks` entry in the `LOAD` request,
pointing at the existing `.vtt` representation of the stream route (`splitRepresentation`,
`src/web/stream.ts:184`), which `srtToVtt` already produces.

That representation gains `Access-Control-Allow-Origin: *`. The receiver fetches tracks
cross-origin and drops them **silently** without it, which would read as "casting ignores
subtitles". The header goes on the subtitle representation only, and the media representation
must keep not having it — a test asserts both halves. It is acceptable there because the
subtitle is already gated by the same `?k=` token as the media, so the header widens who may
*read the response* for a request that was already authorised, not who may make it.

Track choice is fixed at cast time. Changing it re-loads on the device, which is a visible
half-second and simpler than a second control surface.

## When mDNS is blocked

mDNS does not cross a Docker bridge or a VLAN, and torlink gets run behind both. Without a
fallback the feature is dead there, behind a message that reads like a bug.

So one TUI-only config field holds a device address — a host, optionally `host:port`, defaulting
to 8009 — and `/api/cast/devices` returns it in the list whether discovery saw it or not.
Configuration is TUI-only by the existing rule, and the browser needs no new capability flag,
because an empty device list is already the signal it needs.

## The browser

Every decision lives in `src/web/static/castModel.ts`; `player.ts` renders what it is handed and
decides nothing, per the rule that has been caught in review twice. The module answers:

- the button's state and label — `Cast to TV`, `Finding devices…`, `Playing on <name>`
- the disabled reason where there is one — `No Chromecast found on this network`, or
  `HEVC can't be cast`
- the status line for a `MEDIA_STATUS` — `0:12:04 / 1:48:22`, buffering, paused
- which of play, pause and stop to offer

Placement is the existing hand-off row, beside copy-URL, `.m3u` and the mobile VLC link:
casting *is* a hand-off, and that row is already where "play this somewhere else" lives. Starting
a cast pauses the local `<video>` and swaps the controls for the cast status; stopping hands
playback back to the page at the device's position.

Routes in `src/web/routes.ts`, types in `src/web/wire.ts`:

| Route | Body |
| --- | --- |
| `GET /api/cast/devices` | discovered devices plus the configured one |
| `POST /api/cast/start` | `{ sid, index, subtitle? }` |
| `POST /api/cast/command` | `{ action: "play" \| "pause" \| "stop" }` |

Status rides the existing SSE stream (`src/web/sse.ts`) rather than a poll, so a cast started
from a laptop appears on a phone pointed at the same server.

## The terminal

`c` in the stream file picker — free in that section of `src/ui/keymap.ts` today, and the
mnemonic. It opens a device list in the same overlay shape as "Choose sources". On selection the
stream pane becomes a cast row: device name, title, position, `p` to pause, `x` to stop. `x`
already means "stop active stream" in all three list panes, so a cast stops with the key that
already stops a stream.

Per the table in `CLAUDE.md`, that means:

- **both** halves of `src/ui/keymap.ts` — `HELP_GROUPS` and `footerHints`
- the new `Store` fields in **both** `makeStore` (`scripts/render-previews-impl.tsx`) and
  `makeTestStore` (`src/ui/testHarness.ts`)

## The per-process consequence, named rather than hidden

The TUI and `serve --web` are separate processes, so the registry is per-process: a cast started
in the terminal is not visible to a browser talking to a standalone `serve --web`, and the
reverse. Where the TUI hosts the web UI itself (shift+w) it is one process and both surfaces see
the one cast.

Sharing it across processes means a TUI↔daemon RPC that does not exist today — out of scope. What
this design owes the user is that the screen says "not casting" rather than implying it knows
about a cast it cannot see.

## Failures, each with its own message

| What happens | What the user sees |
| --- | --- |
| No devices answer | `No Chromecast found on this network.` — and in the TUI, that mDNS may not cross their network's boundaries |
| TLS connect refused or timed out | `<name> didn't answer — it may be off.` The device stays in the list |
| Receiver refuses `LAUNCH` | `<name> wouldn't start the player.` |
| `LOAD_FAILED` / `LOAD_CANCELLED` | `<name> couldn't play this file.` — with the receiver's own reason where it gives one |
| Socket drops mid-play | one reconnect attempt, then `Lost the connection to <name>.` — and the ✓ already written on `LOAD` stays, because the file was played |
| The file has a blocker and no rung above it | `A Chromecast can't play this one — <reason>.` The button is disabled with that reason rather than absent, so it is clear the device is the limit and not the network |

## Testing

Every row is a test written before the change it covers.

| Test | What it pins |
| --- | --- |
| `src/core/cast/protocol.test.ts` | a `CastMessage` round-trips; a frame whose length prefix arrives split across two chunks yields exactly one message; two messages in one chunk yield two; a frame claiming an absurd length is rejected rather than buffered |
| `src/core/cast/discover.test.ts` | canned SRV/A/TXT records → devices with name and model; a response missing SRV is dropped; duplicates from two interfaces collapse by `id`; the configured manual entry appears with no discovery at all; the timeout resolves with what arrived rather than throwing |
| `src/core/cast/connection.test.ts` | against a fake socket: heartbeat cadence; `LAUNCH` precedes `LOAD`; each failure row above; one reconnect then give up |
| `src/core/cast/session.test.ts` | a second start replaces the first; a successful `LOAD` marks the file played exactly once; a `LOAD_FAILED` marks nothing; `MEDIA_STATUS` positions reach the status the front ends read and are never written to disk |
| `src/core/streamSession.test.ts` | `adopt` yields a `ready` session with a fresh id and capability, without calling either resolve impl; stopping an adopted session does not touch a backend it does not own |
| `src/util/playability.test.ts` | **the browser profile's verdicts are exactly what they are today** — the regression guard for touching a shared module — then MKV blocked for Chromecast, AC3 and E-AC3 allowed (the recorded trade-off), HEVC and DTS blocked |
| `src/web/static/castModel.test.ts` | every button state and disabled reason; the status line's formatting including a stream with no known duration; the fallback card offers casting only where the Chromecast profile has no blockers |
| `src/web/routes.test.ts` | the three routes and their authorisation; the cast URL is built from the LAN address even when `Host` is `localhost`; `POST /api/cast/command` with nothing casting is a clean refusal, not a crash |
| `src/web/stream.test.ts` | the `.vtt` representation carries `Access-Control-Allow-Origin`, and the media representation still does **not** |
| `src/ui/keymap.test.ts` | `c` appears in both `HELP_GROUPS` and `footerHints` for the picker |

Fixtures use the repo's cast — `Kepler`, `Harrowgate`, `Kestrel`, `Tin.Rivers` — and device names
are invented too (`Living Room TV`, `Kitchen display`). Note the trap `CLAUDE.md` records: the
playability tests assert on substrings of fixture names, so a later rename must re-check them.

Then `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` — the last being the only
thing that proves `castModel.ts` pulled no `node:*` into the browser bundle.

## Documentation

- `README.md`: casting joins the streaming section, naming what a Chromecast will and will not
  take — an MKV casts on the debrid backend and not from a torrent, HEVC casts on neither — and
  the fact that discovery needs mDNS, with the configured-address fallback for Docker and VLANs.
- The web UI's limitations list: re-read to confirm the "needs a real player" wording is still
  true now that the fallback card can cast. Casting itself is not a limitation and adds no entry.
- `package.json` gains one runtime dependency, `multicast-dns`, taking the list from ten to
  eleven.
