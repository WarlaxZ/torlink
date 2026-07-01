# Log the Real-Debrid Error Body on Retry-Exhaustion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When `fetchResilient` gives up on a retryable status, capture a truncated snippet of the response body and surface it via `onAttempt`, so the Real-Debrid logger records *why* RD refused (e.g. `body={"error":"fair_usage_limit",...}`).

**Architecture:** Add an optional `bodySnippet` to `fetchResilient`'s `onAttempt` info, populated (via a safe `try/catch` body read) only on the final give-up. The RD `onAttempt` logger appends `body=<snippet>`. The thrown `HttpError` and `mapStatus` are untouched, so the user-facing message is unaffected.

**Tech Stack:** TypeScript (ESM, Node 22), vitest, tsup. Tests colocate as `src/**/*.test.ts`. `npm test` / `npx vitest run <path>` / `npm run typecheck`.

**Build order:** `net.ts` (bodySnippet + safe read) → `realdebrid.ts` (log `body=`).

---

## File Structure

**Modified**
- `src/util/net.ts` — `onAttempt` info gains `bodySnippet?`; a `readBodySnippet(res)` helper reads/truncates the body safely; called on give-up.
- `src/util/net.test.ts` — bodySnippet tests.
- `src/integrations/realdebrid.ts` — `onAttempt` logs `body=<snippet>` when present.
- `src/integrations/realdebrid.test.ts` — light spy test that the give-up line includes `body=`.

---

## Task 1: `bodySnippet` on give-up in `fetchResilient`

**Files:**
- Modify: `src/util/net.ts`
- Test: `src/util/net.test.ts`

- [ ] **Step 1: Write the failing tests — append to `src/util/net.test.ts` inside `describe("fetchResilient", ...)`**

```typescript
  // A response-like object that exposes a body via text().
  function bodyRes(status: number, body: string): Response {
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: () => null },
      text: async () => body,
    } as unknown as Response;
  }

  it("passes the response body snippet to onAttempt only on give-up", async () => {
    const seen: Array<{ willRetry: boolean; bodySnippet?: string }> = [];
    await expect(
      fetchResilient("http://x", {
        ...opts,
        retries: 1,
        onAttempt: (i) => seen.push({ willRetry: i.willRetry, bodySnippet: i.bodySnippet }),
        fetchImpl: async () => bodyRes(503, '{"error":"fair_usage_limit","error_code":35}'),
      }),
    ).rejects.toBeInstanceOf(HttpError);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual({ willRetry: true, bodySnippet: undefined });
    expect(seen[1].willRetry).toBe(false);
    expect(seen[1].bodySnippet).toContain("fair_usage_limit");
  });

  it("truncates the body snippet to 200 chars", async () => {
    let snippet: string | undefined;
    await expect(
      fetchResilient("http://x", {
        ...opts,
        retries: 0,
        onAttempt: (i) => {
          if (!i.willRetry) snippet = i.bodySnippet;
        },
        fetchImpl: async () => bodyRes(503, "x".repeat(500)),
      }),
    ).rejects.toBeInstanceOf(HttpError);
    expect(snippet).toHaveLength(200);
  });

  it("yields undefined bodySnippet when the body read fails (best-effort)", async () => {
    let snippet: string | undefined = "sentinel";
    await expect(
      fetchResilient("http://x", {
        ...opts,
        retries: 0,
        onAttempt: (i) => {
          if (!i.willRetry) snippet = i.bodySnippet;
        },
        fetchImpl: async () =>
          ({
            status: 503,
            ok: false,
            headers: { get: () => null },
            text: async () => {
              throw new Error("boom");
            },
          }) as unknown as Response,
      }),
    ).rejects.toBeInstanceOf(HttpError);
    expect(snippet).toBeUndefined();
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/util/net.test.ts`
Expected: FAIL — `bodySnippet` is always undefined (not read yet), so the first test's `seen[1].bodySnippet` assertion and the truncation test fail.

- [ ] **Step 3: Implement — `src/util/net.ts`**

Add the snippet cap constant near the other constants (e.g. below `DEFAULT_CAP_MS`):
```typescript
const BODY_SNIPPET_MAX = 200;
```

Add a safe body-read helper (module scope, e.g. after `isAbortError`). The `try/catch` wraps the `res.text()` **call itself**, so a response object without a `text` method (as some test fakes and edge responses are) can't throw synchronously:
```typescript
// Best-effort short snippet of a response body, for diagnostics. Never throws —
// a missing/failed body yields undefined. Truncated so a stray HTML page can't
// bloat a log line.
async function readBodySnippet(res: Response): Promise<string | undefined> {
  try {
    const text = await res.text();
    return text.slice(0, BODY_SNIPPET_MAX).trim() || undefined;
  } catch {
    return undefined;
  }
}
```

Add `bodySnippet?: string` to the `onAttempt` info type in `FetchResilientOptions`:
```typescript
  onAttempt?: (info: {
    status: number;
    attempt: number;
    retries: number;
    retryAfterMs?: number;
    delayMs: number;
    willRetry: boolean;
    bodySnippet?: string;
  }) => void;
```

In the retry loop, the current tail is:
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
Change it to read the body snippet on give-up and include it in the `onAttempt` call:
```typescript
    const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
    const willRetry = attempt < retries;
    const floorMs = retryAfterMs ?? minBackoffMs;
    const delayMs = willRetry ? backoffDelay(attempt, baseMs, capMs, floorMs) : 0;
    const bodySnippet = willRetry ? undefined : await readBodySnippet(res);
    onAttempt?.({ status: res.status, attempt, retries, retryAfterMs, delayMs, willRetry, bodySnippet });
    if (!willRetry) {
      throw new HttpError(
        res.status,
        `Request to ${url} failed after ${retries} retries (HTTP ${res.status}).`,
      );
    }
    await sleepImpl(delayMs);
```
(The thrown `HttpError` is unchanged — the body flows ONLY through `onAttempt`, never into the error or `mapStatus`.)

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/util/net.test.ts`
Expected: PASS (new + all existing net tests — the existing `fakeRes` has no `text()`, which `readBodySnippet` handles by returning undefined).

- [ ] **Step 5: Commit**

```bash
git add src/util/net.ts src/util/net.test.ts
git commit -m "feat: capture a response-body snippet on retry-exhaustion via onAttempt"
```

---

## Task 2: Log the body in the Real-Debrid give-up line

**Files:**
- Modify: `src/integrations/realdebrid.ts`
- Test: `src/integrations/realdebrid.test.ts`

- [ ] **Step 1: Write the failing test — append to `src/integrations/realdebrid.test.ts`**

(Reuse the existing `import { log } from "../util/logger";` and `vi` import added by the earlier logging work; `getInfo` and `RealDebridError` are already imported.) Append:

```typescript
describe("request logging — error body", () => {
  it("logs the RD error body on the give-up line", async () => {
    const spy = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      const fetchImpl = async (): Promise<Response> =>
        ({
          status: 503,
          ok: false,
          headers: { get: () => null },
          text: async () => '{"error":"fair_usage_limit"}',
        }) as unknown as Response;
      // retries default for getInfo is 4; sleepImpl no-op so no real wait.
      await expect(getInfo("tok", "id1", { fetchImpl, sleepImpl: async () => {} })).rejects.toThrow();
      const lines = spy.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.includes("giving up") && l.includes('body={"error":"fair_usage_limit"}'))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/integrations/realdebrid.test.ts`
Expected: FAIL — the give-up line has no `body=` yet.

- [ ] **Step 3: Implement — `src/integrations/realdebrid.ts`**

In `request()`, the `onAttempt` currently is:
```typescript
      onAttempt: ({ status, attempt, retries, retryAfterMs, willRetry }) =>
        log.warn(
          `rd ${method} ${path} status=${status} attempt=${attempt + 1}/${retries + 1}` +
            (retryAfterMs !== undefined ? ` retryAfter=${Math.round(retryAfterMs / 1000)}s` : "") +
            (willRetry ? " retrying" : " giving up"),
        ),
```
Destructure `bodySnippet` and append it when present:
```typescript
      onAttempt: ({ status, attempt, retries, retryAfterMs, willRetry, bodySnippet }) =>
        log.warn(
          `rd ${method} ${path} status=${status} attempt=${attempt + 1}/${retries + 1}` +
            (retryAfterMs !== undefined ? ` retryAfter=${Math.round(retryAfterMs / 1000)}s` : "") +
            (willRetry ? " retrying" : " giving up") +
            (bodySnippet ? ` body=${bodySnippet}` : ""),
        ),
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/integrations/realdebrid.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify + commit**

Run: `npm run typecheck && npm test && npm run build`
Expected: all green; `dist/cli.cjs` emitted.
```bash
git add src/integrations/realdebrid.ts src/integrations/realdebrid.test.ts
git commit -m "feat: log the Real-Debrid error body on the give-up line"
```

---

## Final verification

- [ ] **Run everything**

Run: `npm run typecheck && npm test && npm run build`
Expected: all green.

- [ ] **Manual check** (`npm run dev`, trigger the RD stall, inspect `~/.local/share/torlink/torlink.log`)
  - The `rd POST /unrestrict/link status=503 … giving up` line now ends with `body=<RD error JSON>` — revealing the actual reason (`fair_usage_limit`, `too_many_active_downloads`, `hoster_unavailable`, or an empty/other body).
  - Confirm no token/`Bearer`/magnet appears (`grep -i bearer ~/.local/share/torlink/torlink.log` → nothing).

---

## Notes

- The body read happens only on give-up (one read per exhausted call), is `try/catch`-guarded (never throws; a fake/edge response without `text()` yields undefined), and is capped at 200 chars.
- Routing via `onAttempt` (not the thrown `HttpError`) keeps `mapStatus` and the user-facing error message unchanged.
- Non-RD callers ignore `bodySnippet`; the extra read only fires on the give-up of a retryable status, which is rare.
