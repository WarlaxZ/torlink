# Patient Real-Debrid Retry Pacing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop Real-Debrid downloads stalling by pacing retries — floor the backoff so a 503 with no `Retry-After` waits seconds (not ~0.2s) between attempts.

**Architecture:** Add a `minBackoffMs` floor option to `fetchResilient` (off by default, so scrapers are unaffected); the Real-Debrid client passes `baseMs: 2000, capMs: 30000, minBackoffMs: 2000` so its 503 retries are spaced ~2–16s apart, honoring `Retry-After` when larger.

**Tech Stack:** TypeScript (ESM, Node 22), vitest, tsup. Tests colocate as `src/**/*.test.ts`. `npm test` / `npx vitest run <path>` / `npm run typecheck`.

**Build order:** `minBackoffMs` floor in `net.ts` (TDD) → RD `request()` passes the pacing settings.

---

## File Structure

**Modified**
- `src/util/net.ts` — add `minBackoffMs?` to `FetchResilientOptions`; use it as the backoff floor when there's no `Retry-After`.
- `src/util/net.test.ts` — floor tests.
- `src/integrations/realdebrid.ts` — `request()` passes `baseMs`/`capMs`/`minBackoffMs`.

---

## Task 1: `minBackoffMs` backoff floor in `fetchResilient`

**Files:**
- Modify: `src/util/net.ts`
- Test: `src/util/net.test.ts`

- [ ] **Step 1: Write the failing tests — append to `src/util/net.test.ts` inside `describe("fetchResilient", ...)`**

```typescript
  it("floors the backoff at minBackoffMs when there is no Retry-After", async () => {
    const delays: number[] = [];
    let n = 0;
    await fetchResilient("http://x", {
      baseMs: 1,
      capMs: 1,
      retries: 3,
      minBackoffMs: 1000,
      sleepImpl: async (ms: number) => {
        delays.push(ms);
      },
      fetchImpl: async () => (++n === 1 ? fakeRes(503) : fakeRes(200)),
    });
    expect(delays).toHaveLength(1);
    expect(delays[0]).toBeGreaterThanOrEqual(1000);
  });

  it("honors a Retry-After larger than minBackoffMs", async () => {
    const delays: number[] = [];
    let n = 0;
    await fetchResilient("http://x", {
      baseMs: 1,
      capMs: 1,
      retries: 3,
      minBackoffMs: 1000,
      sleepImpl: async (ms: number) => {
        delays.push(ms);
      },
      fetchImpl: async () => (++n === 1 ? fakeRes(503, { "retry-after": "5" }) : fakeRes(200)),
    });
    expect(delays[0]).toBeGreaterThanOrEqual(5000);
  });

  it("without minBackoffMs the backoff can be below a second (unchanged default)", async () => {
    const delays: number[] = [];
    let n = 0;
    await fetchResilient("http://x", {
      baseMs: 1,
      capMs: 1,
      retries: 3,
      sleepImpl: async (ms: number) => {
        delays.push(ms);
      },
      fetchImpl: async () => (++n === 1 ? fakeRes(503) : fakeRes(200)),
    });
    expect(delays[0]).toBeLessThan(1000);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/util/net.test.ts`
Expected: FAIL — `minBackoffMs` isn't applied, so the first two tests see a sub-1000ms (≈0) delay. (`baseMs:1, capMs:1` makes the un-floored jitter ~0.)

- [ ] **Step 3: Implement — `src/util/net.ts`**

Add the option to `FetchResilientOptions` (near `retryCdn503`/`onAttempt`):
```typescript
  // Minimum backoff (ms) for a retryable response that has no Retry-After
  // header — a floor so retries aren't near-instant. Off by default; set by
  // trusted APIs (Real-Debrid) whose 503s are rate limits with no Retry-After.
  minBackoffMs?: number;
```

Destructure it in `fetchResilient` (add alongside `retryCdn503`/`onAttempt`):
```typescript
    retryCdn503 = false,
    onAttempt,
    minBackoffMs,
    signal,
```

In the retry loop, the current tail is:
```typescript
    const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
    const willRetry = attempt < retries;
    const delayMs = willRetry ? backoffDelay(attempt, baseMs, capMs, retryAfterMs) : 0;
    onAttempt?.({ status: res.status, attempt, retries, retryAfterMs, delayMs, willRetry });
    if (!willRetry) {
      throw new HttpError(
        res.status,
        `Request to ${url} failed after ${retries} retries (HTTP ${res.status}).`,
      );
    }
    await sleepImpl(delayMs);
```
Change the delay computation to use the floor (`Retry-After` wins when present, else `minBackoffMs`):
```typescript
    const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
    const willRetry = attempt < retries;
    const floorMs = retryAfterMs ?? minBackoffMs;
    const delayMs = willRetry ? backoffDelay(attempt, baseMs, capMs, floorMs) : 0;
    onAttempt?.({ status: res.status, attempt, retries, retryAfterMs, delayMs, willRetry });
    if (!willRetry) {
      throw new HttpError(
        res.status,
        `Request to ${url} failed after ${retries} retries (HTTP ${res.status}).`,
      );
    }
    await sleepImpl(delayMs);
```
(`backoffDelay(attempt, base, cap, floor)` returns `max(jittered, floor)` when `floor` is defined, so `delayMs >= minBackoffMs` on every retry when no `Retry-After`. `onAttempt` still reports the raw `retryAfterMs` — unchanged.)

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/util/net.test.ts`
Expected: PASS (new + all existing net tests).

- [ ] **Step 5: Commit**

```bash
git add src/util/net.ts src/util/net.test.ts
git commit -m "feat: add minBackoffMs floor to fetchResilient retry backoff"
```

---

## Task 2: Real-Debrid passes patient pacing

**Files:**
- Modify: `src/integrations/realdebrid.ts`

- [ ] **Step 1: Set the pacing in `request()`**

In `src/integrations/realdebrid.ts`, the `fetchResilient(...)` options in `request()` currently are:
```typescript
    res = await fetchResilient(`${BASE}${path}`, {
      method,
      headers,
      body: bodyStr,
      signal: opts.signal,
      fetchImpl: opts.fetchImpl,
      sleepImpl: opts.sleepImpl,
      retries: opts.retries ?? 2,
      retryCdn503: true,
      onAttempt: ({ status, attempt, retries, retryAfterMs, willRetry }) =>
        log.warn(
          `rd ${method} ${path} status=${status} attempt=${attempt + 1}/${retries + 1}` +
            (retryAfterMs !== undefined ? ` retryAfter=${Math.round(retryAfterMs / 1000)}s` : "") +
            (willRetry ? " retrying" : " giving up"),
        ),
    });
```
Add the three pacing settings (patient, floored backoff for RD's no-`Retry-After` 503s):
```typescript
    res = await fetchResilient(`${BASE}${path}`, {
      method,
      headers,
      body: bodyStr,
      signal: opts.signal,
      fetchImpl: opts.fetchImpl,
      sleepImpl: opts.sleepImpl,
      retries: opts.retries ?? 2,
      retryCdn503: true,
      baseMs: 2000,
      capMs: 30000,
      minBackoffMs: 2000,
      onAttempt: ({ status, attempt, retries, retryAfterMs, willRetry }) =>
        log.warn(
          `rd ${method} ${path} status=${status} attempt=${attempt + 1}/${retries + 1}` +
            (retryAfterMs !== undefined ? ` retryAfter=${Math.round(retryAfterMs / 1000)}s` : "") +
            (willRetry ? " retrying" : " giving up"),
        ),
    });
```
(`addMagnet` passes `retries: 0`, so it never sleeps — unaffected. Idempotent calls keep `retries: 4` and now retry ~2s → ~16s apart, capped 30s.)

- [ ] **Step 2: Verify**

Run: `npm run typecheck && npm test`
Expected: PASS. (The existing realdebrid tests inject `sleepImpl: async () => {}`, so the larger delays add no real wait; retry-count behavior is unchanged.)

- [ ] **Step 3: Commit**

```bash
git add src/integrations/realdebrid.ts
git commit -m "feat: pace Real-Debrid retries patiently (2s floor, 30s cap)"
```

---

## Final verification

- [ ] **Run everything**

Run: `npm run typecheck && npm test && npm run build`
Expected: all green; `dist/cli.cjs` emitted.

- [ ] **Manual check** (`npm run dev`, then inspect `~/.local/share/torlink/torlink.log`)
  - Trigger the RD stall (queue/retry). The log's `rd POST /unrestrict/link status=503 … retrying` lines should now be **seconds apart** (≥2s), not sub-second bursts — and more downloads should get through as RD's rate window recovers between attempts.

---

## Notes

- The floor is only a floor: `backoffDelay` still applies exponential growth + jitter above it, and `Retry-After` (if RD ever sends one) still wins when larger.
- Scrapers and any other `fetchResilient` caller pass no `minBackoffMs`, so their backoff is byte-for-byte unchanged.
- If the stalls persist even with patient pacing, the remaining lever is reducing concurrency to 1 (a one-line `MAX_ACTIVE_DEBRID` change) — deliberately out of scope here per the decision to keep 2.
