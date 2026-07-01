# Surface the real Real-Debrid failure reason in the UI — design

**Date:** 2026-07-01
**Branch:** fix/rd-error-message-surfacing
**Status:** Approved (pending spec review)

## Problem

Real-Debrid downloads stop with the generic **"Real-Debrid is busy — try again
shortly."**, giving the user no real clue. The logs proved the actual reason is
`hoster_unavailable` (error_code 19), but that slug never reaches the user-facing
message: on a retryable 503, `fetchResilient` throws `HttpError(503, "Request to
… failed after N retries")` with no slug, and `request()`'s catch feeds that URL
string into `mapStatus(status, code)` as the "code" — which never matches
`messageForErrorSlug`, so it falls to the generic 503 message. The slug lives
only in the response body (now captured for logging as `bodySnippet`).

## Goal

Show the accurate reason on the failed download's row (and clarify it): e.g.
"Real-Debrid host unavailable — try again later." instead of "busy" — so the user
knows it's RD-side and will clear with time. Keep the generic fallback when no
slug is available.

## Existing architecture (reference)

- `src/util/net.ts` — `HttpError { status; message }`. On give-up of a retryable
  status, `fetchResilient` computes `bodySnippet` (truncated response body) and
  throws `HttpError(status, "Request to … failed …")`. The `bodySnippet` is passed
  to `onAttempt` but not attached to the error.
- `src/integrations/realdebrid.ts` — `request()` `catch`: `if (e instanceof
  HttpError) { log.warn(…); throw mapStatus(e.status, e.message); }`. `mapStatus`
  order: 401/403 → `messageForErrorSlug(code)` → 404 → 503 ("busy") → generic.
  `messageForErrorSlug` currently lumps `hoster_unavailable` in with
  `file_unavailable`/`*no_longer_available` → "This is no longer available on
  Real-Debrid (it may have been removed)."
- `src/ui/components/Downloads.tsx` — `rightStats(it)` failed case returns
  `truncate(it.error || "failed", 28)`; the render then truncates again to the
  available `statsW`. So the inner 28-cap is the tight limit on error text.

## Components

### 1. Carry the response body on the error — `src/util/net.ts`

- Add an optional `body?: string` to `HttpError` (`constructor(status, message?,
  body?)`).
- In `fetchResilient`'s give-up branch, attach the already-read `bodySnippet`:
  `throw new HttpError(res.status, "Request to … failed …", bodySnippet)`. Generic
  — net stays RD-agnostic; other `HttpError` throws are unchanged (body optional).

### 2. Map the slug into the message — `src/integrations/realdebrid.ts`

- Add a tiny pure `parseErrorSlug(body: string | undefined): string | undefined`
  that `JSON.parse`s the body and returns `.error` (best-effort; `undefined` on
  missing/non-JSON).
- In `request()`'s `catch`, use it: `throw mapStatus(e.status,
  parseErrorSlug(e.body))` (instead of `e.message`). Now a 503 whose body is
  `{"error":"hoster_unavailable"}` maps via `messageForErrorSlug`; with no
  body/slug, `mapStatus(status, undefined)` yields the same generic fallback as
  today (503 → "busy"). No regression.

### 3. Accurate wording — `messageForErrorSlug` in `src/integrations/realdebrid.ts`

Split `hoster_unavailable` (transient host outage) from removal, and tighten the
copy so the distinctive words come first (they survive truncation):
- `*infring*` → `"Removed from Real-Debrid (copyright claim)."`
- `hoster_unavailable` → `"Real-Debrid host unavailable — try again later."`
- `file_unavailable` / `*no_longer_available` → `"No longer available on
  Real-Debrid (removed)."`
- `*too_many*` / `slow_down` / `*fair_usage*` → `"Real-Debrid rate limit — wait a
  moment and retry."`
- else → `null` (generic fallback).

### 4. Let the error text breathe — `src/ui/components/Downloads.tsx`

`rightStats` failed case: return the full `it.error || "failed"` (drop the inner
`truncate(…, 28)`); the render's existing `truncate(rightStats(it), statsW)`
still bounds it to the available column width. The message leads with the
distinctive words, so even a narrow column shows the clue.

## Data flow

RD 503 exhausts → `fetchResilient` throws `HttpError` **with** the body →
`request()` catch parses the `{error}` slug → `mapStatus(status, slug)` →
`messageForErrorSlug` → accurate `RealDebridError.message` → surfaces as the
queue item's `error` → shown (untruncated-to-28) in the downloads row.

## Error handling / edge cases

- No body or non-JSON body → `parseErrorSlug` returns `undefined` → generic
  fallback (unchanged behavior).
- 401/403 still short-circuit to the token message (checked before the slug in
  `mapStatus`) — unchanged.
- Unknown slug → `messageForErrorSlug` returns `null` → generic
  `Real-Debrid error: <slug> (HTTP <status>)` (still more informative than
  before, since the slug is now the `code`).
- Non-RD `fetchResilient` callers: `HttpError.body` is optional and only set on
  give-up; they ignore it. No behavior change.

## Testing

- `net.test.ts`: on give-up of a retryable 503 with a body, the thrown
  `HttpError.body` contains that body (extends the existing bodySnippet test).
- `realdebrid.test.ts`:
  - `parseErrorSlug('{"error":"hoster_unavailable"}')` → `"hoster_unavailable"`;
    `parseErrorSlug(undefined)`/malformed → `undefined`.
  - `messageForErrorSlug` new/rewored strings (update existing assertions):
    `hoster_unavailable` → host-unavailable message; `file_unavailable` →
    removed; `infringing_file` → copyright; rate-limit slugs → rate-limit
    message.
  - A `getInfo` (or request-level) test: a 503 whose body is
    `{"error":"hoster_unavailable"}` rejects with a `RealDebridError` whose
    message is the host-unavailable text (NOT "busy").
- `Downloads.tsx` change verified by typecheck (and covered by the message being
  the item's `error`); the widened truncation is a display tweak.

## Scope / sequencing

Small. Build order:
1. `net.ts` `HttpError.body` + attach on give-up + test.
2. `realdebrid.ts` `parseErrorSlug` + wire the catch + reword `messageForErrorSlug`
   + update/extend tests.
3. `Downloads.tsx` drop the inner 28-char cap on the failed-error text.

## Out of scope

- Fixing `hoster_unavailable` itself (RD-side; time-based recovery).
- Auto-retry-later scheduling.

## Open decisions (resolved)

- Wording per §3 (host-unavailable is transient, distinct from removed). ✅
- Widen the failed-row error text (drop the 28-char inner cap). ✅
