# Real-Debrid integration polish — design

**Date:** 2026-06-30
**Branch:** `feat/real-debrid-integration`
**Status:** Approved (pending spec review)

## Goal

Make the existing Real-Debrid integration feel clean, polished, and intuitive.
The plumbing already works (token validation on entry, cached-torrent reuse,
progress reporting, user-safe errors, no re-seeding of RD downloads). This work
closes the UX gaps around discoverability, status visibility, file selection,
long waits, expired tokens, and link access.

## Scope

Seven cohesive, RD-facing improvements. One spec, built in dependency order
(see Sequencing). Out of scope: changing the resolve/download pipelines
themselves, P2P flow changes, encryption of the stored token.

## Existing architecture (reference)

- `src/integrations/realdebrid.ts` — API client. `resolveMagnet(token, magnet, opts)`
  is the main pipeline (addMagnet → selectFiles → poll → unrestrict). Accepts
  `opts.signal` (AbortSignal) and `opts.onProgress(pct)`. `validateToken` returns
  `{ username, type, premium }` where `premium` is seconds of premium remaining.
  `RealDebridError` carries `status` (HTTP code).
- `src/config/config.ts` — `Config { downloadDir, realDebridToken?, mediaPlayer? }`,
  persisted to `config.json`. `resolveRealDebridToken` (env var wins over file).
- `src/util/player.ts` — `pickStreamFile(files)` (largest video, else largest file),
  `detectPlayer`, `launchPlayer`.
- `src/download/queue.ts` — `addDebrid`/`runDebrid` (RD download path; downloads all
  files; never seeds).
- `src/ui/App.tsx` — `streamResult` (`v`), `startDebridDownload` (`r`), `playStream`,
  transient `notice` state (auto-clears 4s), prompt overlays (`TokenPrompt`,
  `StreamPlayerPrompt`, `FolderPrompt`, `ConfirmPrompt`). Header is `<Logo />` +
  `notice` in a space-between row.
- `src/ui/keymap.ts` — `HELP_GROUPS` (full `?` overlay) and `footerHints(...)`
  (terse context row). `r`/`v` hints only render when `debridConfigured`.
- `src/ui/theme.ts` — `COLOR` (accent, good, warn, bad, alt…), `ICON` (done ✓,
  warn ⚠, pointer ❯…).

## Features

### 1. Multi-file stream picker

When `resolveMagnet` returns **2+ video files**, show a new `StreamFilePrompt`
overlay (same pattern as `TokenPrompt`): scrollable list of files with name +
human size, largest video pre-selected, `↑↓` move, `↵` stream, `esc` cancel.
With 0–1 video files, keep the silent `pickStreamFile` path (no prompt).

- **Applies to streaming (`v`) only.** RD downloads (`r`) keep fetching all files.
- New component `src/ui/components/StreamFilePrompt.tsx`.
- App state: `streamFiles: ResolvedFile[] | null`; render the prompt when set;
  on select → `playStream(file.url, name)`; on cancel → clear + "Stream cancelled."
- "Video file" determined by the existing `VIDEO_EXTS` set in `player.ts`.

### 2. Persistent RD status

- App state `rdUser: { username: string; premiumUntil: Date | null } | null`.
- Populated by `validateToken` on (a) token entry and (b) once at app launch,
  fire-and-forget and fail-silent (never blocks startup or shows an error toast
  on launch).
- A helper converts `validateToken`'s `premium` seconds → `premiumUntil` Date
  (null when not premium). Pure, unit-tested.
- Header badge next to `<Logo />`:
  - premium: `rd ✓ <user>` in good color, plus `· <N>d` when expiry is within
    a threshold (e.g. ≤ 14 days) in warn color.
  - free/expired/invalid: `rd ⚠ free` (or `expired`) in warn/bad color.
  - no token: badge hidden.
- The transient green `notice` continues to render on the right of the header.

### 3. Discoverability

- **Splash:** when no token set, one dim line: `Tip — press k to connect
  Real-Debrid for instant, private streaming.` When connected: `Real-Debrid:
  connected as <user>`.
- **Footer (`footerHints`, results context):** when RD is *not* configured, add
  a dim `k Real-Debrid` hint (mirror of how `r`/`v` show only when configured).

### 4. Cancellable, smarter "Preparing…"

- Pass an `AbortSignal` into `resolveMagnet` from `streamResult` (download path
  already does). `esc` during preparation aborts → "Stream cancelled."
- Notice text adapts to phase:
  - `0 < pct < 100` → `Caching on Real-Debrid… N%` (RD downloading server-side).
  - cached / `pct >= 100` / link fetch → `Fetching link…`.
- Show the existing `Spinner` plus an elapsed-seconds counter so long waits read
  as alive, not hung.

### 5. Inline re-auth on 401

In the `streamResult` / `startDebridDownload` catch blocks, when the caught
`RealDebridError.status` is 401/403:

- clear `rdUser`,
- set notice `Real-Debrid token expired — re-enter it`,
- open `TokenPrompt` immediately (instead of dead-ending on a generic error).

### 6. Explicit copy-link

- **Streaming:** in the prepared-stream state (`StreamPlayerPrompt` / streaming),
  bind `c` = copy link, so copying is intentional rather than only the
  no-player-found fallback.
- **Downloads:** store the resolved direct URL(s) on the RD queue item; bind
  `y` = copy direct link in the downloads pane (`y` is free there). For
  multi-file RD items, copy the **single primary (largest) file's link**.

### 7. Token management on the `k` prompt

- `TokenPrompt` gains a status line above the input, derived from `rdUser`:
  `premium · expires <date>` / `free account` / `not connected`.
- When a token is saved, show a `ctrl+x clear` hint; clearing removes the token
  from config and clears `rdUser`.

## Data flow

`validateToken` → `rdUser` (App state) → consumed by header badge (#2), splash &
footer (#3), token prompt status line (#7). 401 from resolve/download paths →
clears `rdUser` + reopens `TokenPrompt` (#5). `resolveMagnet` files →
`StreamFilePrompt` selection (#1) → `playStream`. Resolved URLs persisted on
queue items → copy-link (#6).

## Error handling

- Launch-time validation failures: silent (badge simply stays hidden / shows
  `⚠`). Never block or toast on startup.
- 401/403 during an action: inline re-auth (#5).
- Other `RealDebridError`s: existing user-safe notices, unchanged.
- Abort during prepare: "Stream cancelled.", no error state.
- Clipboard write failure (#6): reuse existing behavior — notice reflects
  success/failure of `writeClipboard`.

## Testing

- Pure logic via `vitest`:
  - premium-seconds → `premiumUntil` Date + "expires"/days-left formatting.
  - `pickStreamFile` / video filtering used by the picker trigger (2+ videos).
  - 401/403 detection branch selection (given a `RealDebridError`).
- Ink components (`StreamFilePrompt`, badge, prompt status line) kept thin and
  verified by rendering; no heavy snapshot coupling.

## Sequencing

1. **#2 `rdUser` state + premium formatting** — backbone read by #3, #5, #7.
2. **#1 stream picker** and **#4 cancellable prepare** — stream flow.
3. **#5 inline re-auth**, **#6 copy-link**, **#7 token management** — round-out.

## Open decisions (resolved)

- Multi-file picker: streaming only. ✅
- Multi-file copy-link: primary/largest link only. ✅
