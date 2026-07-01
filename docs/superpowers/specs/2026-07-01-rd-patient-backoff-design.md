# Patient Real-Debrid retry pacing — design

**Date:** 2026-07-01
**Branch:** fix/rd-patient-backoff
**Status:** Approved (pending spec review)

## Problem

Real-Debrid downloads stall on `POST /unrestrict/link` returning **HTTP 503**.
The diagnostic log (added earlier) shows the 503 carries **no `Retry-After`
header** and no error slug — a bare "service busy" — and, crucially, our client
retries it **5 times in ~2 seconds**, hammering a rate-limited endpoint. Some
unrestricts succeed and others 503 in the same session, so it's transient
contention, not an account cap. `fetchResilient` uses full-jitter backoff
(`floor(random() * exp)`) with a 500ms base, which has **no lower bound** — a
retry can fire ~0–500ms after a 503, so simply raising the base doesn't stop the
near-instant retries.

## Goal

Pace Real-Debrid retries so a no-`Retry-After` 503 gets real breathing room —
retries seconds apart, not a sub-second burst — giving RD's rate window time to
recover, without affecting the torrent-source scrapers that share the same
network layer.

## Decisions (confirmed)

- **Concurrency stays 2** (unchanged) — pacing does the work, not serialization.
- **Patient backoff**: RD retries floored at ~2s, growing to a ~30s cap, honoring
  `Retry-After` when present.

## Existing architecture (reference)

- `src/util/net.ts` — `fetchResilient(url, opts)` retry loop. On a retryable
  status it computes `retryAfterMs = parseRetryAfter(header)` then sleeps
  `backoffDelay(attempt, baseMs, capMs, retryAfterMs)`. `backoffDelay` = `floor(
  rand() * min(cap, base*2^attempt))`, and if a 4th `retryAfterMs` arg is given it
  returns `max(jittered, retryAfterMs)` — i.e. `retryAfterMs` acts as a floor.
  Defaults: `baseMs=500`, `capMs=20000`, `retries=5`. `onAttempt` reports each
  retry. The Cloudflare-503 short-circuit is bypassed for RD via `retryCdn503`.
- `src/integrations/realdebrid.ts` — `request()` calls `fetchResilient` with
  `retries: opts.retries ?? 2`, `retryCdn503: true`, and an `onAttempt` logger.
  Idempotent calls (`getInfo`, `unrestrictLink`, `selectFiles`, `listTorrents`)
  pass `retries: 4`; `addMagnet` passes `retries: 0`. `request()` does NOT
  currently set `baseMs`/`capMs`, so it inherits the 500/20000 defaults.
- `src/download/queue.ts` — pipeline-level requeue already backs off ≥5s
  (`DEBRID_BACKOFF_BASE_MS`) for up to `MAX_DEBRID_ATTEMPTS = 3` attempts. Not
  changed here.

## Components

### 1. `minBackoffMs` floor — `src/util/net.ts`

Add an optional `minBackoffMs?: number` to `FetchResilientOptions`. In the retry
loop, when computing the delay, use it as the floor **when there is no
`Retry-After`** (and let a present `Retry-After` still win if larger):

```
const floor = retryAfterMs ?? minBackoffMs;   // undefined when neither set
const delayMs = willRetry ? backoffDelay(attempt, baseMs, capMs, floor) : 0;
```

Because `backoffDelay` does `max(jittered, floor)`, every retryable delay is at
least `minBackoffMs` (or `Retry-After`, whichever is larger), regardless of
jitter. Default: `minBackoffMs` unset → behavior identical to today (no floor) —
scrapers and all other callers are unaffected.

### 2. Real-Debrid settings — `src/integrations/realdebrid.ts`

In `request()`, pass patient pacing to `fetchResilient` (alongside the existing
`retries`, `retryCdn503`, `onAttempt`):

```
baseMs: 2000,
capMs: 30000,
minBackoffMs: 2000,
```

Effect for a persistently-503ing idempotent call (`retries: 4`): delays are
floored at ~2s and grow with the exponential (`exp` = 2s, 4s, 8s, 16s, capped
30s), jittered above the floor — roughly `2s, 2–4s, 2–8s, 2–16s` — up to ~30–40s
of patient retrying per call before it throws. `addMagnet` (`retries: 0`) is
unaffected (no retries). The pipeline then requeues (≥5s, 3 attempts) as today,
so each item gets several patient passes before failing.

## Data flow

RD call → `request()` sets `baseMs/capMs/minBackoffMs` → `fetchResilient` floors
each 503 retry at `minBackoffMs` (or `Retry-After`) → `onAttempt` logs each
spaced retry → on final failure the pipeline requeues. Non-RD callers pass no
`minBackoffMs`, so their backoff is unchanged.

## Error handling / edge cases

- No `Retry-After` (the observed RD case): floor = `minBackoffMs` (2s).
- `Retry-After` present and larger than 2s: `max` picks it (we wait as RD asks).
- `Retry-After` present but smaller than 2s: floor (2s) wins — still patient.
- Non-RD callers (`minBackoffMs` unset): `floor = retryAfterMs ?? undefined` →
  identical to current behavior.
- `addMagnet` (retries 0): loop runs once, no backoff — unaffected.

## Testing

- `net.test.ts`:
  - With `minBackoffMs` set and a 503 that has **no** `Retry-After`, the recorded
    sleep delay is **≥ minBackoffMs** (deterministic — it's a floor, independent
    of jitter). Assert via a `sleepImpl` that records the delay.
  - A present `Retry-After` **larger** than `minBackoffMs` still wins (delay ≥
    that value).
  - Without `minBackoffMs`, behavior is unchanged (a small-base 503 can sleep
    below any floor) — the existing tests already cover this; add no floor.
- RD wiring (`request()` passing the three settings) verified by typecheck + the
  existing realdebrid suite.

## Scope / sequencing

Small, focused. Build order:
1. `minBackoffMs` option + floor wiring in `net.ts` + tests.
2. `realdebrid.ts` `request()` passes `baseMs: 2000, capMs: 30000, minBackoffMs: 2000`.

## Out of scope

- Concurrency changes (staying at 2).
- Pipeline-level requeue backoff (already ≥5s; unchanged).
- Reducing retry counts (keeping 4 for idempotent calls).

## Open decisions (resolved)

- Concurrency stays 2. ✅
- Patient backoff: base 2s, cap 30s, floor (minBackoffMs) 2s, honoring
  Retry-After. ✅
