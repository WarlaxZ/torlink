# Capture the Real-Debrid error body on retry-exhaustion — design

**Date:** 2026-07-01
**Branch:** feat/log-rd-error-body
**Status:** Approved (pending spec review)

## Problem

Real-Debrid `POST /unrestrict/link` returns HTTP 503 persistently (even with the
new patient backoff, retries spaced ~2s apart still all 503). We can't tell
whether it's an account cap (`fair_usage_limit` / too many active downloads) or
RD-side flakiness, because the **503 response body is never logged**. On a
retryable status, `fetchResilient` retries then throws an `HttpError` carrying
only the status — the body (RD's `{"error": "...", "error_code": N}`) is
discarded. So every `failed status=503` log line is reasonless. (Non-retryable
failures like 404/401 already log the slug, because `request()` reads their body;
only the retried-then-exhausted path is blind.)

## Goal

Surface the Real-Debrid error body on the "giving up" log line, so a stall shows
exactly why RD refused — without leaking the token/headers and without corrupting
the user-facing error message.

## Existing architecture (reference)

- `src/util/net.ts` — `fetchResilient` retry loop. On a retryable status it now
  computes `retryAfterMs`, `willRetry = attempt < retries`, `floorMs =
  retryAfterMs ?? minBackoffMs`, `delayMs`, calls `onAttempt?.({ status, attempt,
  retries, retryAfterMs, delayMs, willRetry })`, then `if (!willRetry) throw new
  HttpError(...)` else `await sleepImpl(delayMs)`. The response body is never read
  on this path.
- `src/integrations/realdebrid.ts` — `request()` passes an `onAttempt` that logs
  each retry/give-up (`rd METHOD path status=… attempt=…/… [retryAfter=…s]
  retrying|giving up`). On a non-retryable `!ok`, `request()` reads
  `res.json().error` and logs `slug=…`. `mapStatus(status, code)` maps errors —
  and `request()`'s `catch` calls `mapStatus(e.status, e.message)`, so
  `HttpError.message` is treated as the slug/`code`. **The error body must not be
  routed through the thrown error**, or the slug matcher could misfire.
- `src/util/logger.ts` — best-effort `log` singleton (warn/info/debug), disabled
  under vitest.

## Design

### 1. `onAttempt` gains an optional `bodySnippet` — `src/util/net.ts`

Extend the `onAttempt` info object with `bodySnippet?: string`. On a retryable
response, when **giving up** (`willRetry === false`), read a short body snippet
before firing `onAttempt`:

- `const bodySnippet = willRetry ? undefined : (await res.text().catch(() => "")).slice(0, 200).trim() || undefined;`
- Read the body **only on give-up** (one read per exhausted call, not per retry).
- Best-effort: a body-read failure yields `undefined` (never throws).
- Pass `bodySnippet` in the `onAttempt` call. It is only populated on the
  give-up call; on ordinary retries it is `undefined`.

The subsequent `throw new HttpError(...)` is unchanged (body is NOT put on the
error — it flows only through `onAttempt`, keeping `mapStatus` untouched).

Reading `res.text()` is safe here: the response is about to be discarded (we're
throwing), and it's only read once.

### 2. Log it in the Real-Debrid `onAttempt` — `src/integrations/realdebrid.ts`

Append `body=<snippet>` to the existing give-up log line when `bodySnippet` is
present:
```
rd ${method} ${path} status=${status} attempt=${a+1}/${r+1}[ retryAfter=Ns] giving up[ body=<snippet>]
```
Only method + path + status + attempt + retryAfter + the RD error body are logged
— never the token, `Authorization` header, URL query, or request body.

## Data flow

Retryable 503 exhausts retries → `fetchResilient` reads a truncated body snippet
→ passes it via `onAttempt` (give-up call) → RD's `onAttempt` logs `body=…` →
the raw `HttpError`/`mapStatus`/user message paths are unchanged.

## Error handling / safety

- Body read wrapped in `.catch(() => "")`; empty/failed → `bodySnippet`
  undefined → the log line simply omits `body=`.
- Truncated to 200 chars: bounded even if a hoster returns an HTML page.
- No secret exposure: the body is RD's error JSON; the token lives only in the
  request `Authorization` header, which is never read or logged.
- `mapStatus` and the thrown `HttpError` are unchanged — no risk of the body
  corrupting the user-facing error message.
- Non-RD callers pass an `onAttempt` that ignores `bodySnippet` (or none at all)
  — behavior unchanged; the extra body read happens for any caller only on
  give-up of a retryable status, which is rare and harmless.

## Testing

- `net.test.ts`: on retry-exhaustion of a 503 whose body is
  `{"error":"fair_usage_limit"}`, the final `onAttempt` call receives a
  `bodySnippet` containing that text (and `willRetry === false`); intermediate
  retries receive `bodySnippet === undefined`; a body-read failure yields
  `undefined` (no throw); the snippet is capped at 200 chars.
- RD wiring (`onAttempt` appending `body=`) verified by typecheck + a spy test
  (a failing getInfo logs a give-up line containing `body=`), or by inspection —
  keep it light, matching the existing RD-logging test style.

## Scope / sequencing

Small, focused. Build order:
1. `net.ts` — `bodySnippet` in `onAttempt` + read-on-give-up + tests.
2. `realdebrid.ts` — append `body=<snippet>` to the give-up log line.

## Out of scope

- Any retry/pacing/concurrency changes (already handled).
- Parsing the slug out of the body — the raw truncated JSON is enough to read the
  reason; no need to re-parse.

## Open decisions (resolved)

- Capture on give-up only (one read/line), not per retry. ✅
- Route via `onAttempt` (not the thrown error) to protect `mapStatus`. ✅
- Always-on (rides the existing warn give-up line); 200-char cap; no secrets. ✅
