# Pause / resume for Real-Debrid downloads — design

**Date:** 2026-07-01
**Branch:** feat/rd-pause-resume
**Status:** Approved (pending spec review)

## Problem

Pressing `p` (pause) does nothing on a Real-Debrid download: `queue.pause()`
early-returns for `via === "realdebrid"` because HTTP transfers had no
range-resume ("not in v1"), so RD items could only be cancelled. The user wants
`p` to actually pause an RD download — stop it (queued, resolving, or
in-progress) and resume later, continuing an in-progress transfer from where it
stopped rather than re-downloading.

## Goal

Per-item pause/resume for Real-Debrid downloads in every phase. Pausing an
in-progress download keeps the partial file(s) and frees the concurrency slot;
resuming continues via HTTP `Range` against a freshly-resolved link.

## Decisions (confirmed)

- **Per-item** pause (like P2P): a paused item frees its concurrency slot; other
  queued items may proceed.
- **Resume continues** from where it stopped (HTTP `Range` + append), re-resolving
  the link first so an expired link is never an issue.

## Existing architecture (reference)

- `src/download/http.ts` — `downloadFiles(files, destDir, opts)` streams each file
  to disk sequentially; on **any** abort/error it `cleanup()`s (deletes) every
  file it wrote and throws. No resume, no `Range`.
- `src/download/queue.ts`:
  - `pause(id)`: `if (it.via === "realdebrid") return;` — RD no-op today.
  - `runDebrid(id)`: creates an `AbortController` (stored in `debridAborts`), sets
    phase `resolving` → `resolveMagnet(knownHash)` → phase `downloading`,
    `progress = 0`, `totalBytes` from files → `downloadFiles(files, dest, { signal,
    onProgress })` → `completeDebrid`. Throws on failure.
  - `driveDebrid(id)`: semaphore-gated retry wrapper; on a thrown error it either
    requeues (transient) or `failDebrid`s.
  - `cancel(id)`: `this.debridAborts.get(id)?.abort()` (no reason) + deletes the
    item.
  - `restore(items)`: rewrites persisted RD items with `status: "downloading"` to
    `failed: "Interrupted…"`; leaves `paused` items alone.
  - `resume(id)` exists for P2P (re-adds to the engine); has no RD branch.
- `QueueItem` (`types.ts`) persists `downloadedBytes`, `progress`, `status`,
  `phase`, `via`, `dir`, `directUrl`.
- UI: `Downloads.tsx` `togglePause` (`p`) already calls `queue.togglePause(id)`;
  footer/keymap already show pause/resume; a `paused` row renders "paused N%".

## Components

### 1. Resume-aware `downloadFiles` — `src/download/http.ts`

Per file, before fetching, stat the destination size:
- **complete** (`f.bytes > 0 && existing >= f.bytes`): skip; count `f.bytes`
  toward aggregate progress.
- **partial** (`0 < existing < f.bytes`): request with header `Range:
  bytes=${existing}-`.
  - Response `206` → **append** (`createWriteStream(dest, { flags: "a" })`); seed
    this file's byte counter at `existing`.
  - Response `200` (server ignored `Range`) → **restart** the file (truncate,
    `flags: "w"`, counter from 0).
- **fresh** (`existing === 0`): download as today (`flags: "w"`).

Aggregate progress seeds `doneBytes` from already-complete files and each
resumed file starts its counter at its on-disk size, so the reported `%` is
correct immediately on resume.

**Cleanup by abort reason.** Replace the unconditional `cleanup(written)` on
abort with a reason check:
- `signal.reason === "pause"` → **keep** all partial files (do not delete); throw
  to unwind.
- otherwise (cancel / genuine error) → delete this torrent's destination files
  (all `files`' dest paths, so a resumed-then-cancelled download leaves nothing)
  and throw, as today.

`downloadFiles` only decides keep-vs-delete; it does not need to know about queue
state. (Node's `AbortController.abort(reason)` sets `signal.reason`, available in
Node 22.)

### 2. Pause / resume in `DownloadQueue` — `src/download/queue.ts`

- **`pause(id)`**: remove the RD early-return. For an RD item that is `downloading`
  (any phase): set `status: "paused"`, zero live stats (`speed`/`peers`/`eta`),
  and `this.debridAborts.get(id)?.abort("pause")`. Persist + `changed()` +
  `maybeStopPoll()`. The partial files stay on disk; `downloadedBytes`/`progress`
  are already persisted.
- **`driveDebrid` pause handling**: after `runDebrid` throws, if the item's
  current `status === "paused"`, `return` without `failDebrid`/requeue (the
  semaphore is released in the existing `finally`, freeing the slot). This is the
  only change to the catch flow.
- **`resume(id)`**: add an RD branch. Require a token (same guard as `retry`);
  set `status: "downloading"`, reset attempts, and `void this.driveDebrid(id,
  token, deps)`. Re-running the pipeline re-resolves (fresh link) and
  `downloadFiles` continues the partial via `Range`.
- **`cancel(id)`**: abort with reason `"cancel"` (`abort("cancel")`) so
  `downloadFiles` deletes partials; unchanged otherwise.
- `togglePause` already dispatches pause/resume by status — works for RD once the
  above land.

### 3. Types / persistence

No schema change: `status: "paused"`, `downloadedBytes`, `progress` already exist
and persist. A paused RD item restored after restart stays `paused` (restore only
rewrites `downloading` RD items); resuming it re-resolves + `Range`-continues from
the on-disk bytes.

### 4. UI

No structural change. `p` (togglePause) now pauses/resumes RD items; the footer
already advertises pause/resume; a paused RD row shows "paused N%".

## Data flow

`p` → `togglePause` → `pause(id)` (status paused, `abort("pause")`) →
`downloadFiles` keeps partials + throws → `runDebrid` rethrows → `driveDebrid`
sees `paused`, returns (slot freed). `p` again → `resume(id)` → `driveDebrid` →
`runDebrid` re-resolves → `downloadFiles` resumes each partial via `Range` from
its on-disk size → `completeDebrid`.

## Error handling / edge cases

- Pause vs cancel distinguished by `signal.reason`; only cancel/error delete
  partials.
- Server ignores `Range` (`200`) → restart that file (no corruption from
  appending to a full response).
- Resume re-resolve fails (e.g. `hoster_unavailable`) → behaves like a normal
  download failure (transient requeue / fail) — pause didn't special-case it.
- `f.bytes` unknown (`0`): can't detect "complete"; an existing partial is
  attempted with `Range`, and the `200`-fallback restarts if unsupported.
- Multi-file torrent: complete files are skipped, the partial resumed, later
  files downloaded fresh — all via the per-file size check.
- Pause during `resolving`: `resolveMagnet` aborts; nothing on disk; resume
  re-resolves cleanly.
- Restart while paused: item restores as `paused`; partials + `downloadedBytes`
  persist; resume continues.
- Brief cosmetic flicker: `runDebrid` sets `progress = 0` after re-resolve on
  resume; `downloadFiles`'s first progress callback (seeded from disk) corrects it
  immediately. Acceptable.

## Testing

- `http.test.ts` (stubbed `fetchImpl`): resumes a partial via `Range: bytes=N-`
  and appends (final file = full content); restarts when the server answers `200`
  to a `Range` request; skips an already-complete file; progress seeds from
  existing bytes; **keeps** partials on `abort("pause")` and **deletes** on
  `abort("cancel")`.
- `queue.test.ts` (stubbed `DebridDeps`): `pause` on a downloading RD item →
  `status "paused"`, not failed/requeued, slot freed (a queued item starts);
  `resume` → re-drives to completion; pause of a queued item stays paused and
  doesn't run.

## Scope / sequencing

One cohesive feature. Build order:
1. `downloadFiles` — resume (`Range`/append/`206`/`200`-restart/skip + progress
   seed) and reason-based cleanup + tests.
2. `queue.cancel` — abort with `"cancel"` reason (tiny, enables the reason split).
3. `queue.pause`/`resume` for RD + `driveDebrid` pause handling + tests.
4. Verify UI (`p` toggles RD pause/resume) + manual smoke.

## Out of scope

- Pausing P2P differently (unchanged).
- Global "hold all" (chose per-item).
- Fixing `hoster_unavailable` (RD-side; separate).

## Open decisions (resolved)

- Per-item; paused frees its slot. ✅
- Resume continues via `Range`, re-resolving first (no link-expiry problem). ✅
- Pause keeps partials; cancel deletes — distinguished by `signal.reason`. ✅
