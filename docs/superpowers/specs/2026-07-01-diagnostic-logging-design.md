# Diagnostic logging for Real-Debrid — design

**Date:** 2026-07-01
**Branch:** feat/diagnostic-logging
**Status:** Approved (pending spec review)

## Problem

Real-Debrid downloads keep "getting stuck" (mostly failing with "Real-Debrid is
busy"), but the app writes **no log files** — the only evidence is the persisted
`queue.json` (terminal states, no detail on *why*). Every diagnosis so far has
been inference: we can't see whether a "busy" failure is a bare 503, a specific
RD error slug (`fair_usage_limit` / `too_many_requests` / `hoster_unavailable`),
or a long `Retry-After` — i.e. transient rate-limit (client-fixable) vs an
account/traffic cap (server-side). We need real visibility.

## Goal

A lightweight, always-on diagnostic log that records **why** Real-Debrid calls
fail and **how** the download scheduler responds, so the next stall can be read
straight from a file instead of guessed at. The RD token, request headers, and
magnet bodies must never be written.

## Decisions (confirmed)

- **Always-on** for warnings/errors + RD API failures + scheduler decisions;
  `TORLINK_DEBUG=1` additionally logs every request/response (verbose).
- **Scope:** RD API failures + scheduler lifecycle (not torrent-source scrapes).
- **Location:** a single rotating `torlink.log` in the data dir (~1MB cap, one
  `.1` rollover); path surfaced in `--help`.

## Existing architecture (reference)

- `src/config/paths.ts` — `dataDir` via `env-paths("torlink", { suffix: "" })`
  (`TORLINK_STATE_DIR` override); exports `queueFile`/`historyFile`/etc.
- `src/util/net.ts` — `fetchResilient(url, opts)` does the retry/backoff loop; on
  a retryable status it reads `Retry-After` and sleeps `backoffDelay(...)`, then
  either returns a non-retryable response or throws `HttpError`. It is generic —
  used by torrent-source scrapers too, so it must stay logger-agnostic.
- `src/integrations/realdebrid.ts` — `request()` calls `fetchResilient` then maps
  errors via `mapStatus(status, code)` (the RD `error` slug is parsed from the
  JSON body on a non-retryable `!ok` response). Retryable statuses (503 etc.) are
  retried *inside* `fetchResilient`, so `request()` only sees the final thrown
  `HttpError` (status, no slug/Retry-After) — hence the need for a callback (below).
- `src/download/queue.ts` — the RD scheduler: `addDebrid` → `driveDebrid`
  (semaphore + retry/backoff loop) → `runDebrid` (one attempt) → `completeDebrid`
  / `failDebrid`. `changed()`/`persist()` on state transitions.
- `src/index.tsx` — CLI entry; `HELP_TEXT` printed for `--help`.
- No logging today beyond `console.*` in `index.tsx`.

## Components

### 1. Logger — `src/util/logger.ts` (new)

A minimal, best-effort append logger.

- Levels: `error`, `warn`, `info` always written; `debug` only when
  `process.env.TORLINK_DEBUG` is truthy.
- Line format: `<ISO timestamp> <LEVEL> <message>` where callers pass an already
  key=value-formatted message. A pure `formatLine(level, message, now)` helper is
  unit-tested.
- Writes go to `logFile` and are **serialized** (an internal append-promise chain)
  so lines don't interleave. All IO is wrapped so a logging failure never throws
  into the app (best-effort).
- **Rotation:** an in-memory byte counter (seeded from the file's size on first
  write) triggers rotation when it would exceed `MAX_LOG_BYTES` (~1_000_000):
  rename `torlink.log` → `torlink.log.1` (replacing any existing `.1`), reset the
  counter. A pure `shouldRotate(currentBytes, addBytes, max)` helper is tested.
- Testability: the module exposes the pure helpers (`formatLine`, `shouldRotate`)
  and the level-gating decision (`isDebugEnabled()` / an injectable flag) so the
  logic is tested without touching disk; the thin file-append path is exercised
  via a temp `TORLINK_STATE_DIR` in one integration-style test (best-effort, so it
  only asserts a line lands, not timing).
- Public API (shape): `log.error(msg)`, `log.warn(msg)`, `log.info(msg)`,
  `log.debug(msg)`. A module-level singleton reads `logFile` from paths.

### 2. Paths — `src/config/paths.ts`

Add `export const logFile = path.join(dataDir, "torlink.log");` (the rollover
path is `logFile + ".1"`, derived in the logger).

### 3. Network hook — `src/util/net.ts`

Add an optional callback to `FetchResilientOptions`, invoked when a **retryable
response** is received (before sleeping) and when giving up:

```
onAttempt?: (info: {
  status: number;
  attempt: number;      // 0-based attempt that just failed
  retries: number;      // configured budget
  retryAfterMs?: number;
  delayMs: number;      // backoff about to be applied (0 when giving up)
  willRetry: boolean;
}) => void;
```

`fetchResilient` calls `onAttempt` in the retryable-status branch (with
`willRetry = attempt < retries`, `delayMs` = the computed backoff, and the parsed
`Retry-After`). It stays logger-agnostic — the callback is supplied by callers.
No behavior change when the callback is absent. (This is the only way to capture
per-retry `Retry-After`/attempt data, since retried responses never reach
`request()`.)

### 4. Real-Debrid logging — `src/integrations/realdebrid.ts`

- Pass an `onAttempt` to `fetchResilient` inside `request()` that logs each
  retry: `log.warn(\`rd ${path} status=${status} retryAfter=${..}s attempt=${attempt+1}/${retries+1} ${willRetry ? "retrying" : "giving up"}\`)`.
- On the non-retryable `!ok` branch (where the slug `code` is known), and in the
  `catch` that maps a thrown `HttpError`, log a `warn` line with method, path,
  status, and slug (when available) before throwing.
- In `TORLINK_DEBUG` mode, also `log.debug` each request start (method + path) and
  success (status). **Only** method + path are logged — never the URL query, the
  `Authorization` header/token, or the form body (magnets/links).

### 5. Scheduler lifecycle logging — `src/download/queue.ts`

Add concise `log.info`/`log.warn` lines (id + short name) at the key transitions
in `driveDebrid`/`runDebrid`/`failDebrid`/`completeDebrid`:
- enqueue / waiting for slot (queued),
- attempt start (resolving),
- transient requeue with `reason`, `attempt/budget`, and `backoff`,
- terminal failure with the surfaced `error`,
- completion.
Item name is truncated; id is the infoHash (already in `queue.json`).

### 6. Surface the path — `src/index.tsx`

Add a line to `HELP_TEXT` (shown by `--help`): `Logs: <logFile>`. Optionally a
one-line `log.info("session start …")` at launch so each run is delimited.

## Data flow

RD call → `request()` → `fetchResilient` (retries; fires `onAttempt` per retry →
`log.warn`) → returns/throws → `request()` logs the final failure (status+slug) →
error propagates to `driveDebrid`, which logs requeue/fail decisions. All lines
land in `logFile`, rotating at the cap. `TORLINK_DEBUG` adds per-request debug
lines.

## Error handling / safety

- The logger is **best-effort**: every file operation is wrapped; a logging
  error is swallowed (optionally surfaced once to stderr) and never affects
  downloads or the UI.
- **Redaction is structural**: call sites pass only safe fields (method, path,
  status, slug, Retry-After, attempt, item id/name). Headers, token, and bodies
  are never handed to the logger.
- Rotation guarantees bounded disk use (≤ ~2MB: current + one rollover).
- Serialized writes prevent interleaved/corrupt lines under concurrency (multiple
  RD pipelines logging at once).

## Testing

- `logger.test.ts`: `formatLine` output (timestamp/level/message); `shouldRotate`
  threshold; debug-gating (debug suppressed when the flag is off, emitted when
  on); one temp-dir test that a written line appears in `logFile` and that
  exceeding the cap produces a `.1` rollover.
- `net.test.ts`: `fetchResilient` invokes `onAttempt` once per retryable response
  with correct `status`/`attempt`/`willRetry`/`retryAfterMs`, and not at all on a
  first-try success; absence of the callback changes nothing.
- RD/queue logging: verified via typecheck + a spy asserting `request()`/scheduler
  call the logger on a failure path where cheap; the lines themselves are
  low-risk side effects.

## Scope / sequencing

One cohesive feature. Build order:
1. Logger module + `paths.logFile` (pure helpers + best-effort writer) + tests.
2. `net.ts` `onAttempt` hook + test.
3. RD `request()` logging (wire `onAttempt`, log failures, debug request lines).
4. Scheduler lifecycle logging in `queue.ts`.
5. Surface log path in `--help` (+ optional session-start line).

## Open decisions (resolved)

- Always-on (warn/error/info) + `TORLINK_DEBUG` verbose. ✅
- Scope: RD failures + scheduler lifecycle. ✅
- Rotating `torlink.log` in data dir, ~1MB, one rollover; path in `--help`. ✅
- Token/headers/bodies never logged. ✅
