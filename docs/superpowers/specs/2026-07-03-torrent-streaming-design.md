# Torrent streaming

**Date:** 2026-07-03
**Status:** Approved (design)
**Builds on:** the existing Real-Debrid streaming feature (`v` = "Stream via Real-Debrid").

## Motivation

Today the **Stream** action (`v`) works **only via Real-Debrid**: it resolves the
magnet through RD into a direct HTTPS URL and hands that to an external media
player (mpv/iina/vlc). Users without a Real-Debrid account get nothing when they
press `v`.

WebTorrent is already a dependency (used to download-to-disk and seed in
`src/download/engine.ts`) and can serve a torrent's files over a local HTTP
server while downloading. This adds a **torrent streaming** path so that `v`
works without Real-Debrid — the file streams peer-to-peer straight to the same
media player.

## Scope

**In scope**

- A new torrent-stream module that turns a magnet into a locally-served,
  playable HTTP URL via WebTorrent, exposing files in the **same
  `{ url, filename, bytes }` shape** Real-Debrid produces.
- Decision logic on `v` that routes between Real-Debrid and torrent based on RD
  state (see below).
- Reuse of the existing stream picker (`streamCandidates` / `StreamFilePrompt`)
  and player launch (`launchPlayer`) — unchanged.
- Ephemeral temp storage for the stream, with an **offer-to-keep** prompt when
  the stream ends and the file fully downloaded.
- An active-stream indicator with a key to stop the stream.
- Two privacy warnings (one-time-remembered and always-warn) — see below.
- One new config field for the remembered privacy acknowledgement.
- Unit tests (TDD) for the decision logic, the file-shape adapter, and cleanup.

**Out of scope (YAGNI)**

- Streaming *from* Real-Debrid changes — the RD path is untouched.
- In-app playback / rendering — we keep handing a URL to an external player.
- Sequential-download tuning, subtitle handling, transcoding.
- Any new keybinding — the single `v` key is retained.
- Streaming multiple torrents at once — one active stream at a time (mirrors the
  existing one-prepare-at-a-time guard in `streamResult`).

## Decision logic (single `v` key)

`streamResult` (`src/ui/App.tsx`) branches on Real-Debrid state. **"Not
configured" and "not working" are deliberately different states:**

| RD state | Meaning | Behaviour |
|---|---|---|
| **Not configured** | No RD token (`resolveRealDebridToken` empty) | Stream via torrent. Show the **one-time** privacy warning (remembered); once acknowledged, go straight to torrent on future streams. |
| **Configured but not working** | Token present but non-premium, RD API error, or stall | **Always** show a confirm combining the specific RD problem + the P2P privacy warning. Only proceed to torrent on explicit "yes". Never automatic. The remembered acknowledgement does **not** suppress this. |
| **Working** | Token present, premium active, RD resolves | Real-Debrid stream, exactly as today. |

Rationale: a user who configured RD expects its anonymity (RD proxies; torrent
exposes the real IP to peers). So we never *silently* fall back to peer-to-peer
when RD was set up — we surface the problem and require an explicit choice every
time. Only a user with no RD at all gets the auto-torrent path (and even they
are warned once).

Note on "non-premium": a present-but-non-premium token counts as **configured
but not working** → always-warn confirm, not auto.

## Architecture

### New: torrent stream engine

A new module (proposed `src/integrations/torrentStream.ts`) responsible for the
magnet → playable-URL lifecycle. It is kept **separate** from the download
`TorrentEngine`/queue so streaming does not interfere with the download list or
seeding, and so its lifecycle (temp dir, local server) is self-contained.

Responsibilities:

1. Create a WebTorrent client whose files download to an **ephemeral temp dir**
   (e.g. under the OS temp dir).
2. `add(magnet, { path: tmpDir })`, wait for the `metadata` event.
3. Start WebTorrent's built-in local HTTP server bound to an ephemeral port.
4. Enumerate `torrent.files` and adapt them to the existing stream file shape
   `{ url, filename, bytes }`, where `url` is the local server URL for that file
   (`http://localhost:<port>/…`) and `bytes` is `file.length`. This lets the
   existing `streamCandidates` picker and `launchPlayer` consume torrent files
   with **no changes**.
5. Return a handle exposing: the file list, and `stop()` which closes the
   server, destroys the client, and (unless the caller keeps it) deletes the
   temp dir.

The exact WebTorrent server/URL API (`torrent.createServer()` vs. per-file
stream URL) is pinned down during implementation; the module boundary above is
what matters.

### File-shape adapter

The current `ResolvedFile` type (`{ url, filename, bytes }`) lives in
`src/integrations/realdebrid.ts`. To share it with torrent streaming without a
circular dependency, the plan will either (a) move the type to a neutral
location (e.g. `src/util/player.ts`, which already imports it) and have both RD
and torrent-stream produce it, or (b) define a shared `StreamFile` alias. The
plan step picks one; the intent is a single shape that `streamCandidates`,
`StreamFilePrompt`, and `playStream` operate on regardless of source.

### App/UI wiring (`src/ui/App.tsx`)

- `streamResult` gains the decision branch above. The RD path is factored out
  so the torrent path is a sibling, not a rewrite.
- New state for an **active torrent stream** (the engine handle + display name),
  plus notice/indicator rendering.
- New prompt(s) for: the one-time privacy warning, the always-warn RD-failed
  confirm, and the offer-to-keep prompt. These reuse the existing
  `ConfirmPrompt` component where possible.

### Lifecycle & storage

External players (especially macOS `open -a`) detach, so we **cannot reliably
detect player exit**. Therefore:

- After launching the player, the app shows an **active-stream indicator**:
  e.g. `Streaming <name> via torrent — press x to stop`.
- The torrent keeps downloading/serving in the background while watched.
- On **stop** (user presses the stop key) or **app quit**:
  - If the file **fully downloaded**, prompt **"Keep this download?"**
    - Yes → move/register the file into the downloads folder and seed it via the
      existing download queue (reusing the queue's re-seed-from-existing path).
    - No → tear down and delete the temp dir.
  - If **partial**, tear down and delete the temp dir (no keep prompt, or a
    keep prompt that is disabled — the plan picks the simpler of the two).
- Only **one** active torrent stream at a time; starting a new one stops the
  previous (with its cleanup/keep handling).

### Privacy warnings

- **One-time (not-configured path):** a new config field
  `torrentStreamAck?: boolean` (name TBD in plan) records that the user has
  acknowledged that torrent streaming exposes their IP. First torrent stream
  shows the warning as a `ConfirmPrompt`; on confirm, set the flag and never ask
  again for the not-configured path.
- **Always (configured-but-not-working path):** a confirm that states the
  specific RD problem *and* the P2P exposure, shown **every time**, independent
  of `torrentStreamAck`.

### Config

- Add `torrentStreamAck?: boolean` to `Config` (`src/config/config.ts`), with a
  helper if the pattern warrants it. Defaults to unset/false. Follows the
  existing optional-field convention (unknown/absent degrades to "not
  acknowledged").

## Error handling

- **Metadata timeout / no peers:** if WebTorrent gets no metadata within a
  bounded window (mirroring RD's stall handling), stop, clean up, and show a
  clear notice ("No peers found — couldn't start the stream.").
- **No player found:** the existing `StreamPlayerPrompt` path still applies — but
  note the local URL is only valid while the stream engine is alive, so the
  keep-alive/indicator must remain until the user resolves the player prompt or
  cancels.
- **Cancellation** mid-prepare: reuse the existing `cancelPreparing` pattern;
  ensure the engine is torn down and temp dir removed.
- **Temp cleanup on crash/quit:** best-effort cleanup on stop and on app
  unmount; a stale temp dir is not fatal (OS temp is reclaimable).

## Testing (TDD)

Write tests first, prove they fail, then implement:

1. **Decision logic** — given RD state (not configured / non-premium / API error
   / working), assert the chosen action (torrent-auto / always-warn confirm /
   RD stream). Pure function extracted from `streamResult` so it's testable
   without the UI.
2. **File-shape adapter** — given a fake WebTorrent torrent (files with
   `name`/`length`), assert it maps to `{ url, filename, bytes }` and that
   `streamCandidates` picks the largest video, matching RD behaviour.
3. **Privacy-warning gating** — one-time flag suppresses the not-configured
   warning after acknowledgement, but the configured-but-not-working confirm
   always fires.
4. **Cleanup** — `stop()` without keep deletes the temp dir; with keep, it is
   preserved/handed to the queue.

WebTorrent's network layer is mocked (same approach as
`src/download/queue.test.ts`, which avoids spinning up a real client). Run the
linter and the full `vitest` suite before considering the work done.

## Open items for the plan (not blocking design approval)

- Exact WebTorrent server API and per-file URL format.
- Whether to move `ResolvedFile` or introduce a `StreamFile` alias.
- Final config field name and any accessor helper.
- Whether partial-download offers a (disabled) keep prompt or none.
