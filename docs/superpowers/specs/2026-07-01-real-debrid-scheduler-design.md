# Real-Debrid download scheduler — design

**Date:** 2026-07-01
**Branch:** feat/real-debrid-scheduler
**Status:** Approved (pending spec review)

## Problem

Queueing several Real-Debrid downloads at once (now frictionless since the
queue-in-place change) fires every pipeline in parallel with no cap. Each
pipeline is chatty with RD's API (paginated find-by-hash, addMagnet, selectFiles,
`getInfo` polling every 2s, `unrestrict/link` per file), so a batch trips RD's
rate limit and returns HTTP 503 → items fail with "Real-Debrid is busy — try
again shortly." Diagnosis of a real 13-item batch: 4 completed, 6 failed at 99%
(cached fine, then 503 on the final unrestrict), 3 stuck at `resolving/0%`.
Three concrete problems:

1. **Unbounded concurrency** — `addDebrid()` calls `runDebrid()` immediately per
   item (`queue.ts`), no limit. Pressing retry (`retryFailed()`) re-fires all
   failed items at once, re-creating the burst.
2. **503 treated as terminal** — a transient rate-limit failure hard-fails the
   item; RD calls only retry twice (`realdebrid.ts` `request()` → `retries ?? 2`).
3. **No stall timeout** — `resolveMagnet`'s poll loop waits forever for RD to
   report "downloaded"; a torrent RD never caches sits at "preparing… 0%"
   indefinitely with no signal.

## Goal

Bound Real-Debrid concurrency so a batch drains a couple at a time instead of
storming the API; treat 503/"busy" as transient (backoff + limited auto-requeue);
give up gracefully on a torrent RD isn't caching; and make retry-all respect the
same cap. Result: queue as many as you like, they complete steadily, and the ones
that genuinely can't be fetched fail with a clear reason.

## Decisions (confirmed)

- Max concurrent RD pipelines: **2**.
- Waiting items show a distinct **"queued — waiting"** state.
- Stuck-resolve handling: **stall timeout** (no caching progress for ~3 min → fail
  with a clear message; genuinely-progressing torrents are left alone).
- 503 handling: **auto-retry with backoff + limited auto-requeue** (budget 3).

## Existing architecture (reference)

- `src/download/queue.ts` — `addDebrid(input, dir, token, deps)` builds a
  `QueueItem` (`via: "realdebrid"`, `phase: "resolving"`) and returns
  `this.runDebrid(...)`. `runDebrid` drives `deps.resolveMagnet` (onProgress →
  `phase "resolving"`, progress clamped to 99) then `deps.downloadFiles`, and on
  error sets `status "failed"` + `error` itself. `debridAborts: Map<id,
  AbortController>` holds in-flight pipelines (set at `runDebrid` start, deleted
  in `finally`). `retry`/`retryFailed` re-run `runDebrid` directly. `DebridDeps`
  is the test-injection seam.
- `src/integrations/realdebrid.ts` — `resolveMagnet(token, magnet, opts)` poll
  loop breaks on status `downloaded`, throws on `ERROR_STATUSES`
  (`messageForTorrentStatus`); `opts` has `signal`, `onProgress`,
  `pollIntervalMs` (default 2000), `sleepImpl`. `request()` maps errors via
  `mapStatus` (401/403 token, slug map, 404, 503 "busy", generic) and uses
  `retries ?? 2`; `addMagnet` passes `retries: 0`. `RealDebridError` carries
  `status`.
- `src/util/net.ts` — `fetchResilient` retries `RETRY_STATUS`
  (408/425/429/500/502/503/504) with exponential backoff honoring `Retry-After`.
- `src/download/types.ts` — `QueueItem.phase?: "resolving" | "downloading"`.
- `src/ui/components/Downloads.tsx` — `rightStats` shows "preparing on
  Real-Debrid… N%" for `via === "realdebrid" && phase === "resolving"`.

## Components

### 1. Async semaphore — `src/util/semaphore.ts` (new, pure)

A minimal counting semaphore: `acquire(): Promise<void>` resolves immediately
while under the limit, else queues a resolver; `release()` wakes the next waiter
FIFO. Interface kept tiny (`new Semaphore(n)`, `acquire`, `release`, and a
`size`/`available` accessor for tests). Pure and unit-tested independent of the
queue.

### 2. Concurrency scheduler in `DownloadQueue`

- Constant `MAX_ACTIVE_DEBRID = 2`; a single `Semaphore(2)` instance per queue.
- New phase value: add `"queued"` to `QueueItem.phase` (`types.ts`). A waiting
  item is `status: "downloading"`, `phase: "queued"`.
- `addDebrid` change: build the item with `phase: "queued"`, store + persist,
  then return `this.driveDebrid(id)`. It no longer calls `runDebrid` directly.
- New `driveDebrid(id): Promise<void>` — the scheduling + retry wrapper. Loop up
  to the attempt budget; each iteration acquires and releases the semaphore
  exactly once via a per-attempt `try/finally`:
  1. set `phase: "queued"` (shows "waiting"),
  2. `await sem.acquire()`,
  3. `try`:
     - if the item is gone or no longer `downloading` (cancelled while waiting) →
       `return` (the `finally` releases),
     - `await this.runDebrid(id, token, deps)` — success path completes the item
       inside `runDebrid`; `return`,
     - on error: if `isTransient(e)` and attempts remain, set a local
       `retry = true` (do NOT return — fall through to `finally`); else mark the
       item `failed` (`error = e.message`, clear phase/speed/peers) and `return`,
  4. `finally { sem.release() }` — runs once per acquire, on every exit path,
  5. after the `try/finally`, if `retry`: increment the attempt count,
     backoff-sleep, then `continue` the loop (re-acquire on the next iteration).
  - Because release is only ever in the single `finally`, each `acquire` is
    balanced by exactly one `release`.
  - The returned promise settles when the item reaches a terminal state
    (completed or failed), preserving the existing `await queue.addDebrid(...)`
    contract used by tests.
- `runDebrid` refactor: **one attempt that throws on failure** — remove its
  self-marking `catch` (the `status "failed"` assignment) and let the error
  propagate to `driveDebrid`; keep the success path (`completeDebrid`) and the
  cancelled-mid-resolve early return. The `AbortController`/`debridAborts`
  bookkeeping stays (set at start, deleted in `finally`).
- Attempt tracking: a private `debridAttempts: Map<id, number>` (runtime only,
  not persisted); cleared when the item completes, fails terminally, or is
  cancelled. Budget `MAX_DEBRID_ATTEMPTS = 3`.
- Transient backoff: `min(cap, base * 2^attempt)` with jitter (base ~5s, cap
  ~60s); reuse `net.ts`'s `backoffDelay` if convenient, else a small local calc.
- `retry(id)` / `retryFailed()` for RD items: set `status "downloading"`,
  `phase "queued"`, reset attempts, and call `driveDebrid(id)` — so retry-all
  enqueues everything but the semaphore still runs only 2 at a time.
- `cancel(id)`: unchanged in intent — abort the in-flight controller (if any),
  delete the item, clear its attempts entry. A cancelled item still waiting on
  the semaphore is detected at step 3 after acquire.

### 3. Transient-error classification — `src/integrations/realdebrid.ts`

- Export `isTransient(e: unknown): boolean` — true for `RealDebridError` with
  `status` in {429, 500, 502, 503, 504}, or a non-RD network error (no status).
  False for token (401/403), 404, and the torrent-status messages
  (dead/magnet_error/virus) which are terminal.
- Bump the retry budget for idempotent RD calls: `getInfo`, `selectFiles`,
  `unrestrictLink`, `listTorrents` pass `retries: 4` (via their `RequestOptions`);
  `addMagnet` stays `retries: 0`. (`resolveMagnet`'s own calls inherit these.)

### 4. Stall timeout — `resolveMagnet` in `realdebrid.ts`

- New option `stallMs` (default 180_000). In the poll loop track the last seen
  progress and accumulate elapsed no-progress time by counting poll intervals
  (`stalledMs += pollIntervalMs` when `info.progress <= lastProgress`, reset to 0
  and update `lastProgress` when it increases). When `stalledMs >= stallMs`,
  throw `RealDebridError("Real-Debrid isn't caching this torrent — it may have no
  seeders (removed or dead).")`. No wall-clock dependency (counts intervals), so
  it's deterministic under the existing `sleepImpl`/`pollIntervalMs` test seams.
- This throws a *terminal* (non-transient) error, so `driveDebrid` fails the item
  rather than requeuing it.

### 5. UI — `src/ui/components/Downloads.tsx`

- `rightStats`: add a case before the resolving case — `if (via ===
  "realdebrid" && phase === "queued") return "queued — waiting for Real-Debrid";`.
- Result-row markers (`downloadStateFor`/`stateMark`) are unchanged: a queued
  item is `status "downloading"` → still shows the `↓` marker (it's on its way).

## Data flow

`addDebrid` → item `phase "queued"` → `driveDebrid` waits on the semaphore →
slot free → `runDebrid` (phase `resolving` → `downloading`) → `completeDebrid`
(success) or throw. Throw → `driveDebrid`: `isTransient` + budget → requeue
(`phase "queued"`, backoff) ; else terminal → `failed`. `retry`/`retryFailed`
re-enter via `driveDebrid`. UI reads `phase` to show queued vs preparing.

## Error handling

- Transient (503/429/5xx/network): retried at the call level (backoff, honoring
  Retry-After), then requeued up to the budget; final give-up marks `failed` with
  the last message.
- Terminal (token, dead/magnet_error/virus, 404, stall): fail immediately with
  the specific message; no requeue.
- Cancellation while queued or in-flight: detected after acquire / via the abort
  signal; the item is already removed, semaphore released, no failure recorded.
- Double-release safety: exactly one `release` per `acquire` in `driveDebrid`.

## Testing

- `semaphore.test.ts`: at most N concurrent acquisitions; waiters resume FIFO on
  release; `available` accounting.
- `realdebrid.test.ts`: `isTransient` per status/class; `resolveMagnet` stall —
  `getInfo` stub returning progress 0 with small `pollIntervalMs`/`stallMs` and a
  mock `sleepImpl` throws the stall error; progress that keeps increasing does
  NOT stall.
- `queue.test.ts` (stubbed `DebridDeps.resolveMagnet` with controllable
  resolution): adding N RD items runs at most 2 concurrently and the rest show
  `phase "queued"`; `retryFailed` re-runs within the cap; a transient-failing
  stub is auto-requeued and eventually succeeds within budget; a terminal-failing
  stub fails immediately without requeue.
- UI: typecheck + manual smoke (queue a batch → 2 preparing, rest "queued —
  waiting"; they drain 2 at a time).

## Scope / sequencing

One cohesive feature (the RD scheduler). Natural build order:
1. `Semaphore` (pure) + tests.
2. `isTransient` + idempotent-call retry bump (realdebrid) + tests.
3. `resolveMagnet` stall timeout + tests.
4. `QueueItem` phase `"queued"` + `Downloads` "queued — waiting" copy.
5. Scheduler: semaphore + `driveDebrid` + `runDebrid` refactor + retry paths, in
   `queue.ts` + queue tests. (The structural change — last, so the pieces it uses
   already exist and are tested.)

## Open decisions (resolved)

- Concurrency 2; auto-requeue budget 3; stall window 3 min. ✅
- Retry-all respects the cap (via re-queue through the scheduler). ✅
