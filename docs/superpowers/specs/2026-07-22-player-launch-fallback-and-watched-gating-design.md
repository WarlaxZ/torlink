# Player launch fallback & watched-tick gating

**Date:** 2026-07-22
**Status:** Approved (design)
**Builds on:** the existing streaming + media-player launch feature
(`src/util/player.ts`, `playStream`/`playFromPicker` in `src/ui/App.tsx`).

## Motivation

A user on Windows hit a permanent "No player found" trap while streaming.
Root cause (confirmed by reproduction on the affected machine):

- Their `config.mediaPlayer` was the bare string `"vlc.exe"` — saved earlier
  when a "No player found" prompt asked them to type a command.
- `playStream` (`App.tsx:618`) prefers `resolveMediaPlayer(config)` and only
  auto-detects when it is empty. So the bare value is used and **auto-detection
  is skipped entirely**.
- `launchPlayer("vlc.exe", url)` → `spawn("vlc.exe")` with no shell → `ENOENT`
  (VLC is not on `PATH`; `where vlc` returns exit 1). Windows has no launch
  fallback, so it fails.
- The working install-path fallback (`winPlayerPath`, which resolves
  `C:\Program Files\VideoLAN\VLC\vlc.exe` and launches fine) is never reached.

The trap is self-perpetuating: the fix the prompt offered (type a command) is
exactly what broke it, and every subsequent run repeats the failure.

A second, independent defect surfaced during investigation: `playFromPicker`
(`App.tsx:649`) marks an episode **watched (the tick)** eagerly, right after
`void playStream(...)`, without checking whether a player actually launched. So
a failed stream still gets ticked.

## Scope

**In scope**

- Restructure `playStream` so a **configured player that fails to launch** no
  longer dead-ends: it opens a choice prompt (**Auto-detect / Edit / Cancel**)
  instead of the plain command-entry prompt.
- **Auto-detect** path: run `detectPlayer()`, and on a player that launches,
  **overwrite `config.mediaPlayer`** with the detected (absolute) path so the
  trap self-heals permanently.
- Gate all "mark played" side effects (session `streamedFiles` + persisted
  `markWatchedInFavourite`) behind an **`onPlayed` callback** that fires only
  when a player actually launches — synchronously or via a deferred prompt
  choice.
- A new `PlayerFallbackPrompt` choice component, modelled on the existing
  choice prompts.
- Widen the pending-stream state to carry `{ url, name?, onPlayed?, configured? }`
  and a prompt-mode flag.
- Extract the launch-decision sequence into a pure, injectable, unit-tested
  helper in `src/util/player.ts`; add tests (TDD).

**Out of scope (YAGNI)**

- Changing `launchPlayer`'s internals to resolve bare command names against
  install paths — the Auto-detect path already resolves to the absolute install
  path, making this redundant.
- Detailed OS-error surfacing (e.g. printing `ENOENT`). The choice prompt names
  the player that failed (`Couldn't launch "vlc.exe".`), which is enough.
- Any change to the Real-Debrid / torrent stream *resolution* paths — this is
  purely about player selection and launch.
- New keybindings.

## Design

### 1. Success signalling: `onPlayed` callback

`playStream(url, name?, onPlayed?)` invokes `onPlayed()` the instant any player
launches successfully — from the direct configured/detected launch **or** from
a later prompt choice. Chosen over a `Promise<boolean>` return because the
deferred prompt paths make a stored callback simpler than a stored promise
resolver in React state (fewer stale-closure hazards).

- `playFromPicker` passes a callback that marks streamed + watched.
- `finishStream` passes nothing (it never marked watched).

### 2. `playStream` control flow (`App.tsx`)

```
configured = resolveMediaPlayer(config)
if configured:
    if await launchPlayer(configured, url):
        success(configured); onPlayed(); return
    → open CHOICE prompt, carrying { url, name, onPlayed, configured }
else:
    detected = await detectPlayer()
    if detected && await launchPlayer(detected, url):
        success(detected); onPlayed(); return
    → open EDIT prompt (existing StreamPlayerPrompt), carrying { url, name, onPlayed }
```

Before falling into either prompt, the URL is copied to the clipboard (as today).

### 3. `PlayerFallbackPrompt` (new choice component)

Shown only when a **configured** player fails. Modelled on an existing choice
prompt (e.g. the keep/torrent prompt) for consistency.

> `Couldn't launch "vlc.exe".`  → **Auto-detect** · **Edit command** · **Cancel (link copied)**

- **Auto-detect** → `detectPlayer()`.
  - Found and launches → overwrite `config.mediaPlayer` with the detected
    absolute path, success notice, `onPlayed()`, close.
  - Nothing found / launch fails → fall through to the Edit prompt.
- **Edit command** → existing `StreamPlayerPrompt` (type command/path). A
  successful launch saves the value and fires `onPlayed()`.
- **Cancel** → link already on clipboard; close; no `onPlayed`.

### 4. Pending state

Replace `pendingStreamUrl: string | null` with
`pendingStream: { url: string; name?: string; onPlayed?: () => void; configured?: string } | null`.
Add a prompt-mode flag so `editingPlayer` can render the choice prompt vs the
edit prompt. `setMediaPlayer` reads `onPlayed` from this state and fires it only
on a successful launch.

### 5. Picker marking gated (`playFromPicker`)

Drop the eager `setStreamedFiles(...)` / `markWatchedInFavourite(...)`. Pass them
as the `onPlayed` callback to `playStream` instead, so the tick appears only when
a player really starts.

### Data flow (tick)

`playFromPicker` → `playStream(url, name, onPlayed)` → [launch succeeds anywhere]
→ `onPlayed()` → `setStreamedFiles(add)` + (if favourited) `markWatchedInFavourite`.
The watched list rendered at `App.tsx:1557` (union of persisted `watchedFor` and
session `streamedFiles`) therefore reflects only real playbacks.

### Error handling

- Configured launch failure → choice prompt (never a silent dead-end).
- Auto-detect finding nothing / failing to launch → routed to the Edit prompt.
- Cancel / empty command → link on clipboard, no tick, existing notice.

### Testing (TDD)

Extract the launch-decision sequence into a pure helper in `player.ts` with
injectable `detect` and `launch`, returning an outcome such as
`{ played: true, player } | { played: false, configuredFailed: boolean }`. Unit
tests (in `player.test.ts`) cover:

- Configured player launches → `played:true`, `onPlayed` fired, no prompt.
- Configured player fails → `configuredFailed:true` (routes to choice prompt),
  `onPlayed` NOT fired.
- No configured player, detection launches → `played:true`.
- No configured player, detection fails → `played:false` (routes to edit
  prompt), `onPlayed` NOT fired.

The thin Ink wiring (which prompt renders, config overwrite) stays minimal on
top of the tested helper.
