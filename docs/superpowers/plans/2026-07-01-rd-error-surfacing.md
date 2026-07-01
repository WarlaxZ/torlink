# Surface the Real-Debrid Failure Reason in the UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the real Real-Debrid failure reason (e.g. "Real-Debrid host unavailable — try again later.") on a failed download instead of the generic "busy", by threading the RD error slug from the 503 response body into the user-facing message.

**Architecture:** `HttpError` carries the response `body`; `fetchResilient` attaches the already-captured snippet on give-up. `request()` parses the RD `{error}` slug from it and feeds that to `mapStatus`; `messageForErrorSlug` gets accurate, clue-first wording (with `hoster_unavailable` split out as transient). The downloads row drops its inner 28-char error cap.

**Tech Stack:** TypeScript (ESM, Node 22), vitest, tsup. Tests colocate as `src/**/*.test.ts`. `npm test` / `npx vitest run <path>` / `npm run typecheck` / `npm run build`.

**Build order:** `net.ts` (`HttpError.body`) → `realdebrid.ts` (slug parse + wording) → `Downloads.tsx` (widen).

---

## File Structure

**Modified**
- `src/util/net.ts` — `HttpError` gains `body?`; `fetchResilient` attaches the give-up body snippet.
- `src/util/net.test.ts` — HttpError.body test.
- `src/integrations/realdebrid.ts` — `parseErrorSlug` (exported); `request()` catch maps the slug; `messageForErrorSlug` reworded.
- `src/integrations/realdebrid.test.ts` — parseErrorSlug + reworded messageForErrorSlug + end-to-end getInfo test.
- `src/ui/components/Downloads.tsx` — drop the inner 28-char cap on the failed-error text.

---

## Task 1: `HttpError` carries the response body

**Files:**
- Modify: `src/util/net.ts`
- Test: `src/util/net.test.ts`

- [ ] **Step 1: Write the failing test — append to `src/util/net.test.ts` inside `describe("fetchResilient", ...)`** (it has `opts` and, from earlier work, a `bodyRes(status, body)` helper)

```typescript
  it("attaches the response body to the HttpError on give-up", async () => {
    let err: unknown;
    try {
      await fetchResilient("http://x", {
        ...opts,
        retries: 0,
        fetchImpl: async () => bodyRes(503, '{"error":"hoster_unavailable"}'),
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).body).toContain("hoster_unavailable");
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/util/net.test.ts`
Expected: FAIL — `HttpError.body` is undefined.

- [ ] **Step 3: Implement — `src/util/net.ts`**

Add `body` to `HttpError`:
```typescript
export class HttpError extends Error {
  status: number;
  body?: string;
  constructor(status: number, message?: string, body?: string) {
    super(message ?? `HTTP ${status}`);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
  }
}
```

In `fetchResilient`'s give-up throw, pass the already-read `bodySnippet`. The current code is:
```typescript
    if (!willRetry) {
      throw new HttpError(
        res.status,
        `Request to ${url} failed after ${retries} retries (HTTP ${res.status}).`,
      );
    }
```
Change to:
```typescript
    if (!willRetry) {
      throw new HttpError(
        res.status,
        `Request to ${url} failed after ${retries} retries (HTTP ${res.status}).`,
        bodySnippet,
      );
    }
```
(`bodySnippet` is already computed just above via `readBodySnippet(res)` on give-up. Other `HttpError` throws are unchanged — the third arg is optional.)

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/util/net.test.ts`
Expected: PASS (new + all existing).

- [ ] **Step 5: Commit**

```bash
git add src/util/net.ts src/util/net.test.ts
git commit -m "feat: carry the response body on HttpError from retry-exhaustion"
```

---

## Task 2: Map the slug into the Real-Debrid message

**Files:**
- Modify: `src/integrations/realdebrid.ts`
- Test: `src/integrations/realdebrid.test.ts`

- [ ] **Step 1: Write the failing tests — `src/integrations/realdebrid.test.ts`**

First, UPDATE the existing `messageForErrorSlug` assertions to the new wording (find the `describe("messageForErrorSlug", …)` block and the substring tests added later, and change the expected strings):
- `messageForErrorSlug("infringing_file")` → `"Removed from Real-Debrid (copyright claim)."`
- `messageForErrorSlug("hoster_unavailable")` → `"Real-Debrid host unavailable — try again later."`
- `messageForErrorSlug("file_unavailable")` → `"No longer available on Real-Debrid (removed)."`
- `messageForErrorSlug("content_no_longer_available")` → `"No longer available on Real-Debrid (removed)."`
- `messageForErrorSlug("too_many_requests")` → `"Real-Debrid rate limit — wait a moment and retry."`
- `messageForErrorSlug("fair_usage_limit")` → `"Real-Debrid rate limit — wait a moment and retry."`
- `messageForErrorSlug("hoster_temporarily_unavailable")` → `null` (unchanged — still not a recognised exact slug)

Then append new tests (add `parseErrorSlug` to the `./realdebrid` import; `getInfo`, `RealDebridError` already imported):

```typescript
describe("parseErrorSlug", () => {
  it("extracts the error slug from an RD JSON body", () => {
    expect(parseErrorSlug('{"error":"hoster_unavailable","error_code":19}')).toBe("hoster_unavailable");
  });
  it("returns undefined for missing or non-JSON bodies", () => {
    expect(parseErrorSlug(undefined)).toBeUndefined();
    expect(parseErrorSlug("not json")).toBeUndefined();
    expect(parseErrorSlug("{}")).toBeUndefined();
  });
});

describe("request surfaces the RD reason on a 503", () => {
  it("maps a hoster_unavailable 503 body to the host-unavailable message (not 'busy')", async () => {
    const fetchImpl = async (): Promise<Response> =>
      ({
        status: 503,
        ok: false,
        headers: { get: () => null },
        text: async () => '{"error":"hoster_unavailable","error_code":19}',
      }) as unknown as Response;
    await expect(getInfo("tok", "id1", { fetchImpl, sleepImpl: async () => {} })).rejects.toThrow(
      /host unavailable/i,
    );
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/integrations/realdebrid.test.ts`
Expected: FAIL — `parseErrorSlug` not exported; reworded strings not yet in place; the 503 still maps to "busy".

- [ ] **Step 3: Reword `messageForErrorSlug` — `src/integrations/realdebrid.ts`**

Replace the function body with:
```typescript
export function messageForErrorSlug(slug: string | undefined): string | null {
  if (!slug) return null;
  const s = slug.toLowerCase();
  if (s.includes("infring")) return "Removed from Real-Debrid (copyright claim).";
  if (s === "hoster_unavailable") return "Real-Debrid host unavailable — try again later.";
  if (s === "file_unavailable" || s.includes("no_longer_available")) {
    return "No longer available on Real-Debrid (removed).";
  }
  if (s.includes("too_many") || s === "slow_down" || s.includes("fair_usage")) {
    return "Real-Debrid rate limit — wait a moment and retry.";
  }
  return null;
}
```

- [ ] **Step 4: Add `parseErrorSlug` — `src/integrations/realdebrid.ts`**

Add near `messageForErrorSlug`:
```typescript
// Extract Real-Debrid's `error` slug from a captured response body, if present.
// Best-effort: missing or non-JSON bodies yield undefined.
export function parseErrorSlug(body: string | undefined): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as { error?: string };
    return parsed?.error;
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 5: Use the slug in `request()`'s catch — `src/integrations/realdebrid.ts`**

The catch currently is:
```typescript
  } catch (e) {
    if (e instanceof HttpError) {
      log.warn(`rd ${method} ${path} failed status=${e.status}`);
      throw mapStatus(e.status, e.message);
    }
    log.warn(`rd ${method} ${path} error=${e instanceof Error ? e.message : String(e)}`);
    throw new RealDebridError(e instanceof Error ? e.message : String(e));
  }
```
Replace the `HttpError` branch so the mapped slug drives the message (and the warn line shows it):
```typescript
  } catch (e) {
    if (e instanceof HttpError) {
      const slug = parseErrorSlug(e.body);
      log.warn(`rd ${method} ${path} failed status=${e.status}${slug ? ` slug=${slug}` : ""}`);
      throw mapStatus(e.status, slug);
    }
    log.warn(`rd ${method} ${path} error=${e instanceof Error ? e.message : String(e)}`);
    throw new RealDebridError(e instanceof Error ? e.message : String(e));
  }
```
(`HttpError` is already imported in this file.)

- [ ] **Step 6: Run to verify pass**

Run: `npx vitest run src/integrations/realdebrid.test.ts`
Expected: PASS.

- [ ] **Step 7: Verify + commit**

Run: `npm run typecheck && npm test`
Expected: PASS.
```bash
git add src/integrations/realdebrid.ts src/integrations/realdebrid.test.ts
git commit -m "feat: surface the Real-Debrid error slug in the failure message"
```

---

## Task 3: Widen the failed-error text in the downloads row

**Files:**
- Modify: `src/ui/components/Downloads.tsx`

- [ ] **Step 1: Drop the inner 28-char cap**

In `rightStats`, the failed case currently is:
```typescript
  return truncate(it.error || "failed", 28);
```
Change it to return the full error (the render already applies `truncate(rightStats(it), statsW)`, bounding it to the available column width):
```typescript
  return it.error || "failed";
```

- [ ] **Step 2: Verify**

Run: `npm run typecheck && npm test && npm run build`
Expected: all green; `dist/cli.cjs` emitted. (`truncate` may now be unused in this file if it had no other use — check; it's still used elsewhere in Downloads for the name, so the import stays. If typecheck flags it as unused, remove the import.)

- [ ] **Step 3: Commit**

```bash
git add src/ui/components/Downloads.tsx
git commit -m "feat: let a failed download's error text use the full row width"
```

---

## Final verification

- [ ] **Run everything**

Run: `npm run typecheck && npm test && npm run build`
Expected: all green.

- [ ] **Manual check** (`npm run dev`)
  - Trigger the RD stall; the failed download's row now reads "Real-Debrid host unavailable — try again later." (or the matching slug's message) instead of "Real-Debrid is busy — try again shortly." Confirm the log's `giving up body=…` slug matches the message shown.

---

## Notes

- No body / non-JSON body → `parseErrorSlug` returns undefined → `mapStatus(status, undefined)` → same generic fallback as before (no regression).
- 401/403 still short-circuit to the token message inside `mapStatus` before the slug is consulted — unchanged.
- `truncate` remains used for the item name in Downloads, so its import stays; only the failed-error inner cap is removed.
- Non-RD `fetchResilient` callers ignore `HttpError.body` (optional, only set on give-up).
