# Diagnostic Logging for Real-Debrid — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an always-on, best-effort diagnostic log that records why Real-Debrid API calls fail (status, slug, Retry-After, attempts) and how the download scheduler responds — written to a rotating file, never leaking the token/headers/bodies.

**Architecture:** A tiny `logger` module (pure `formatLine`/`shouldRotate` helpers + a `createLogger` factory with injectable IO, plus a process singleton). `fetchResilient` gains a generic `onAttempt` callback so the RD client can log per-retry detail without coupling the shared network layer to the logger. RD `request()` and the queue scheduler emit concise log lines via the singleton.

**Tech Stack:** TypeScript (ESM, Node 22), vitest, tsup. Tests colocate as `src/**/*.test.ts`. `npm test` / `npx vitest run <path>` / `npm run typecheck` / `npm run build`. The singleton disables disk writes under vitest (`process.env.VITEST`) so the suite never touches the real log.

**Build order:** logger + paths → `net.ts` onAttempt hook → RD request() logging → queue lifecycle logging → surface log path.

---

## File Structure

**New**
- `src/util/logger.ts` — `formatLine`, `shouldRotate`, `createLogger`, and the `log` singleton.
- `src/util/logger.test.ts` — tests for the pure helpers + factory (fake IO).

**Modified**
- `src/config/paths.ts` — add `logFile`.
- `src/util/net.ts` — add optional `onAttempt` callback to `fetchResilient`.
- `src/util/net.test.ts` — tests for `onAttempt`.
- `src/integrations/realdebrid.ts` — log RD retries/failures via the singleton.
- `src/integrations/realdebrid.test.ts` — one spy test that `request()` logs on failure.
- `src/download/queue.ts` — log scheduler lifecycle.
- `src/cli/args.ts` — add the log path to `HELP_TEXT`.
- `src/index.tsx` — a session-start log line.

---

## Task 1: Logger module + log path

**Files:**
- Create: `src/util/logger.ts`
- Modify: `src/config/paths.ts`
- Test: `src/util/logger.test.ts`

- [ ] **Step 1: Add the log path — `src/config/paths.ts`**

After the `historyFile`/`seedsFile` exports, add:
```typescript
export const logFile = path.join(dataDir, "torlink.log");
```

- [ ] **Step 2: Write the failing test — `src/util/logger.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { formatLine, shouldRotate, createLogger } from "./logger";

const AT = new Date("2026-07-01T00:00:00.000Z");

describe("formatLine", () => {
  it("prefixes an ISO timestamp and a padded level", () => {
    expect(formatLine("warn", "hello", AT)).toBe("2026-07-01T00:00:00.000Z WARN  hello\n");
    expect(formatLine("debug", "d", AT)).toBe("2026-07-01T00:00:00.000Z DEBUG d\n");
  });
});

describe("shouldRotate", () => {
  it("rotates only once the file has content and the write would exceed the cap", () => {
    expect(shouldRotate(0, 500, 1000)).toBe(false);
    expect(shouldRotate(600, 300, 1000)).toBe(false);
    expect(shouldRotate(600, 500, 1000)).toBe(true);
  });
});

describe("createLogger", () => {
  function harness(over: Record<string, unknown> = {}) {
    const lines: string[] = [];
    let rotated = 0;
    const logger = createLogger({
      file: "/x/torlink.log",
      maxBytes: 1000,
      enabled: true,
      debug: false,
      now: () => AT,
      append: async (_f: string, d: string) => {
        lines.push(d);
      },
      rotate: async () => {
        rotated++;
      },
      sizeOf: async () => 0,
      ...over,
    });
    return { logger, lines, rotated: () => rotated };
  }

  it("writes error/warn/info always; debug only when enabled", async () => {
    const off = harness({ debug: false });
    off.logger.info("i");
    off.logger.debug("d");
    await off.logger.flush();
    expect(off.lines.join("")).toContain("INFO  i");
    expect(off.lines.join("")).not.toContain(" d\n");

    const on = harness({ debug: true });
    on.logger.debug("d2");
    await on.logger.flush();
    expect(on.lines.join("")).toContain("DEBUG d2");
  });

  it("no-ops entirely when disabled", async () => {
    const h = harness({ enabled: false });
    h.logger.error("nope");
    await h.logger.flush();
    expect(h.lines).toEqual([]);
  });

  it("rotates when the running size would exceed the cap, then still writes", async () => {
    const h = harness({ sizeOf: async () => 999 });
    h.logger.warn("x".repeat(50));
    await h.logger.flush();
    expect(h.rotated()).toBe(1);
    expect(h.lines.length).toBe(1);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run src/util/logger.test.ts`
Expected: FAIL — `Cannot find module './logger'`.

- [ ] **Step 4: Implement — `src/util/logger.ts`**

```typescript
import { appendFile, rename, stat } from "node:fs/promises";
import { logFile } from "../config/paths";

export type LogLevel = "error" | "warn" | "info" | "debug";

// Cap the log at ~1 MB; on exceed we keep exactly one ".1" rollover.
export const MAX_LOG_BYTES = 1_000_000;

// A single log line: "<ISO> <LEVEL padded> <message>\n".
export function formatLine(level: LogLevel, message: string, now: Date): string {
  return `${now.toISOString()} ${level.toUpperCase().padEnd(5)} ${message}\n`;
}

// Rotate only when the file already has content AND this write would push it
// past the cap (so an empty file never rotates before its first line).
export function shouldRotate(currentBytes: number, addBytes: number, max: number): boolean {
  return currentBytes > 0 && currentBytes + addBytes > max;
}

export interface LoggerDeps {
  file: string;
  maxBytes?: number;
  enabled?: boolean; // when false, every call is a no-op (used under tests)
  debug?: boolean; // when false, debug() is dropped
  now?: () => Date;
  append?: (file: string, data: string) => Promise<void>;
  rotate?: (file: string) => Promise<void>;
  sizeOf?: (file: string) => Promise<number>;
}

export interface Logger {
  error(message: string): void;
  warn(message: string): void;
  info(message: string): void;
  debug(message: string): void;
  // Resolves when all queued writes have flushed (used by tests).
  flush(): Promise<void>;
}

export function createLogger(deps: LoggerDeps): Logger {
  const max = deps.maxBytes ?? MAX_LOG_BYTES;
  const enabled = deps.enabled ?? true;
  const debugOn = deps.debug ?? false;
  const now = deps.now ?? ((): Date => new Date());
  const append = deps.append ?? ((f, d): Promise<void> => appendFile(f, d, "utf8"));
  const rotate =
    deps.rotate ?? ((f): Promise<void> => rename(f, `${f}.1`).then(() => undefined).catch(() => undefined));
  const sizeOf =
    deps.sizeOf ??
    (async (f): Promise<number> => {
      try {
        return (await stat(f)).size;
      } catch {
        return 0;
      }
    });

  let bytes = -1; // unknown until the first write reads the file size
  let chain: Promise<void> = Promise.resolve();

  function write(level: LogLevel, message: string): void {
    if (!enabled) return;
    if (level === "debug" && !debugOn) return;
    const line = formatLine(level, message, now());
    const add = Buffer.byteLength(line, "utf8");
    chain = chain.then(async () => {
      try {
        if (bytes < 0) bytes = await sizeOf(deps.file);
        if (shouldRotate(bytes, add, max)) {
          await rotate(deps.file);
          bytes = 0;
        }
        await append(deps.file, line);
        bytes += add;
      } catch {
        // best-effort: a logging failure must never affect the app
      }
    });
  }

  return {
    error: (m): void => write("error", m),
    warn: (m): void => write("warn", m),
    info: (m): void => write("info", m),
    debug: (m): void => write("debug", m),
    flush: (): Promise<void> => chain,
  };
}

// Process-wide logger. Disabled under vitest so the test suite never writes to
// the real log; debug lines are gated behind TORLINK_DEBUG.
export const log = createLogger({
  file: logFile,
  enabled: !process.env["VITEST"],
  debug: !!process.env["TORLINK_DEBUG"],
});
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npx vitest run src/util/logger.test.ts`
Expected: PASS.

- [ ] **Step 6: Verify + commit**

Run: `npm run typecheck && npm test`
Expected: PASS.
```bash
git add src/util/logger.ts src/util/logger.test.ts src/config/paths.ts
git commit -m "feat: add best-effort rotating diagnostic logger"
```

---

## Task 2: `onAttempt` hook in `fetchResilient`

**Files:**
- Modify: `src/util/net.ts`
- Test: `src/util/net.test.ts`

- [ ] **Step 1: Write the failing tests — append to `src/util/net.test.ts` (inside `describe("fetchResilient", ...)`)**

```typescript
  it("reports each retryable response to onAttempt (retry then success)", async () => {
    let n = 0;
    const seen: Array<{ status: number; attempt: number; willRetry: boolean; retryAfterMs?: number }> = [];
    const res = await fetchResilient("http://x", {
      ...opts,
      retries: 3,
      onAttempt: (i) => seen.push({ status: i.status, attempt: i.attempt, willRetry: i.willRetry, retryAfterMs: i.retryAfterMs }),
      fetchImpl: async () => (++n === 1 ? fakeRes(503, { "retry-after": "2" }) : fakeRes(200)),
    });
    expect(res.status).toBe(200);
    expect(seen).toEqual([{ status: 503, attempt: 0, willRetry: true, retryAfterMs: 2000 }]);
  });

  it("reports the final give-up to onAttempt with willRetry=false", async () => {
    const seen: boolean[] = [];
    await expect(
      fetchResilient("http://x", {
        ...opts,
        retries: 1,
        onAttempt: (i) => seen.push(i.willRetry),
        fetchImpl: async () => fakeRes(503),
      }),
    ).rejects.toBeInstanceOf(HttpError);
    expect(seen).toEqual([true, false]);
  });

  it("does not call onAttempt on a first-try success", async () => {
    let called = false;
    await fetchResilient("http://x", {
      ...opts,
      onAttempt: () => (called = true),
      fetchImpl: async () => fakeRes(200),
    });
    expect(called).toBe(false);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/util/net.test.ts`
Expected: FAIL — `onAttempt` is not a recognized option / not invoked.

- [ ] **Step 3: Implement — `src/util/net.ts`**

Add the callback type to `FetchResilientOptions`:
```typescript
  // Called on each retryable response (before the backoff sleep) and on the
  // final give-up. Lets callers observe retries without this layer knowing about
  // logging. `delayMs` is 0 when giving up; `willRetry` distinguishes the two.
  onAttempt?: (info: {
    status: number;
    attempt: number;
    retries: number;
    retryAfterMs?: number;
    delayMs: number;
    willRetry: boolean;
  }) => void;
```

Destructure it (add `onAttempt` to the options destructure at the top of `fetchResilient`, alongside `retryCdn503`):
```typescript
    retryCdn503 = false,
    onAttempt,
    signal,
```

Replace the give-up/backoff tail of the retry loop. The current code (after the Cloudflare guard) is:
```typescript
    if (attempt >= retries) {
      throw new HttpError(
        res.status,
        `Request to ${url} failed after ${retries} retries (HTTP ${res.status}).`,
      );
    }

    const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
    await sleepImpl(backoffDelay(attempt, baseMs, capMs, retryAfterMs));
```
Replace with:
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

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/util/net.test.ts`
Expected: PASS (new tests + all existing net tests).

- [ ] **Step 5: Verify + commit**

Run: `npm run typecheck && npm test`
Expected: PASS.
```bash
git add src/util/net.ts src/util/net.test.ts
git commit -m "feat: add onAttempt hook to fetchResilient for retry observability"
```

---

## Task 3: Real-Debrid request logging

**Files:**
- Modify: `src/integrations/realdebrid.ts`
- Test: `src/integrations/realdebrid.test.ts`

- [ ] **Step 1: Write the failing test — append to `src/integrations/realdebrid.test.ts`**

Add `import { log } from "../util/logger";` and `import { vi } from "vitest";` (merge `vi` into the existing vitest import). Add:

```typescript
describe("request logging", () => {
  it("logs a warning when a Real-Debrid call fails", async () => {
    const spy = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      const fetchImpl = async (): Promise<Response> =>
        ({ status: 404, ok: false, headers: { get: () => null }, json: async () => ({ error: "unknown_ressource" }) }) as unknown as Response;
      await expect(getInfo("tok", "id1", { fetchImpl, sleepImpl: async () => {} })).rejects.toThrow();
      expect(spy).toHaveBeenCalled();
      expect(spy.mock.calls.some((c) => String(c[0]).includes("/torrents/info"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/integrations/realdebrid.test.ts`
Expected: FAIL — `log.warn` is not called (no logging yet).

- [ ] **Step 3: Implement — `src/integrations/realdebrid.ts`**

Add the import near the top (after the `net` import):
```typescript
import { log } from "../util/logger";
```

In `request()`, add an `onAttempt` logger to the `fetchResilient` options (insert after `retryCdn503: true,`):
```typescript
      onAttempt: ({ status, attempt, retries, retryAfterMs, willRetry }) =>
        log.warn(
          `rd ${method} ${path} status=${status} attempt=${attempt + 1}/${retries + 1}` +
            (retryAfterMs !== undefined ? ` retryAfter=${Math.round(retryAfterMs / 1000)}s` : "") +
            (willRetry ? " retrying" : " giving up"),
        ),
```

Add a debug line at the very start of `request()` (first statement of the function body, before building headers):
```typescript
  log.debug(`rd ${method} ${path} →`);
```

Log the mapped-error catch. Replace:
```typescript
  } catch (e) {
    if (e instanceof HttpError) throw mapStatus(e.status, e.message);
    throw new RealDebridError(e instanceof Error ? e.message : String(e));
  }
```
with:
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

Log the non-retryable `!ok` failure. Replace:
```typescript
  if (!res.ok) {
    let code: string | undefined;
    try {
      const parsed = (await res.json()) as { error?: string };
      code = parsed?.error;
    } catch {
      /* body may be empty or non-JSON */
    }
    throw mapStatus(res.status, code);
  }
  return res;
```
with:
```typescript
  if (!res.ok) {
    let code: string | undefined;
    try {
      const parsed = (await res.json()) as { error?: string };
      code = parsed?.error;
    } catch {
      /* body may be empty or non-JSON */
    }
    log.warn(`rd ${method} ${path} failed status=${res.status}${code ? ` slug=${code}` : ""}`);
    throw mapStatus(res.status, code);
  }
  log.debug(`rd ${method} ${path} ${res.status}`);
  return res;
```

Only `method` + `path` are ever logged — never the URL query, the `Authorization` header/token, or the form body.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/integrations/realdebrid.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify + commit**

Run: `npm run typecheck && npm test`
Expected: PASS.
```bash
git add src/integrations/realdebrid.ts src/integrations/realdebrid.test.ts
git commit -m "feat: log Real-Debrid API retries and failures (token never logged)"
```

---

## Task 4: Scheduler lifecycle logging

**Files:**
- Modify: `src/download/queue.ts`

- [ ] **Step 1: Import the logger**

In `src/download/queue.ts`, add near the other util imports:
```typescript
import { log } from "../util/logger";
```

- [ ] **Step 2: Add a short label helper**

Near the top of the file (module scope, after the imports/constants), add:
```typescript
// Compact, log-safe label for a queue item (infoHash id + short name). The name
// already lives in queue.json, so this leaks nothing new.
function rdLabel(id: string, name: string): string {
  return `${id.slice(0, 8)} ${name.slice(0, 40)}`;
}
```

- [ ] **Step 3: Log the lifecycle in `driveDebrid`**

In `driveDebrid`, log the transient requeue decision. The catch block currently is:
```typescript
      } catch (e) {
        const attempts = (this.debridAttempts.get(id) ?? 0) + 1;
        this.debridAttempts.set(id, attempts);
        const stillHere = this.items.get(id)?.status === "downloading";
        if (isTransient(e) && attempts < MAX_DEBRID_ATTEMPTS && stillHere) {
          retry = true;
          const it = this.items.get(id);
          if (it) {
            it.phase = "queued";
            it.speed = 0;
            this.changed();
          }
        } else {
          this.failDebrid(id, e);
          return;
        }
      } finally {
        this.debridSem.release();
      }
      if (!retry) return;
      await sleep(backoffDelay(this.debridAttempts.get(id) ?? 1, DEBRID_BACKOFF_BASE_MS, DEBRID_BACKOFF_CAP_MS, DEBRID_BACKOFF_BASE_MS));
```
Add a log line inside the transient branch (right after `retry = true;`), and a debug line before the backoff sleep:
```typescript
        if (isTransient(e) && attempts < MAX_DEBRID_ATTEMPTS && stillHere) {
          retry = true;
          const it = this.items.get(id);
          if (it) {
            it.phase = "queued";
            it.speed = 0;
            this.changed();
            log.warn(
              `queue ${rdLabel(id, it.name)} requeue reason=transient attempt=${attempts}/${MAX_DEBRID_ATTEMPTS}`,
            );
          }
        } else {
          this.failDebrid(id, e);
          return;
        }
      } finally {
        this.debridSem.release();
      }
      if (!retry) return;
      const backoff = backoffDelay(this.debridAttempts.get(id) ?? 1, DEBRID_BACKOFF_BASE_MS, DEBRID_BACKOFF_CAP_MS, DEBRID_BACKOFF_BASE_MS);
      log.debug(`queue ${id.slice(0, 8)} backoff=${Math.round(backoff / 1000)}s`);
      await sleep(backoff);
```

- [ ] **Step 4: Log start, failure, and completion**

In `runDebrid`, at the point it flips the item to `resolving` (the `if (start) { start.phase = "resolving"; this.changed(); }` block), add a debug line:
```typescript
      const start = this.items.get(id);
      if (start) {
        start.phase = "resolving";
        this.changed();
        log.debug(`queue ${rdLabel(id, start.name)} resolving`);
      }
```

In `failDebrid`, after it sets the failed state (right after `it.phase = undefined;` and before `this.changed();`), add:
```typescript
    it.status = "failed";
    it.error = e instanceof Error ? e.message : String(e);
    it.speed = 0;
    it.peers = 0;
    it.phase = undefined;
    log.warn(`queue ${rdLabel(id, it.name)} failed reason="${it.error}"`);
    this.changed();
```

In `completeDebrid`, after `it.phase = undefined;` (before `this.recordHistory(it);`), add:
```typescript
    it.phase = undefined;
    log.info(`queue ${rdLabel(it.id, it.name)} complete`);
    this.recordHistory(it);
```

- [ ] **Step 5: Verify + commit**

Run: `npm run typecheck && npm test`
Expected: PASS (the singleton is disabled under vitest, so no test writes to the log; queue tests are unaffected).
```bash
git add src/download/queue.ts
git commit -m "feat: log Real-Debrid scheduler lifecycle (queued/requeue/fail/complete)"
```

---

## Task 5: Surface the log path

**Files:**
- Modify: `src/cli/args.ts`
- Modify: `src/index.tsx`

- [ ] **Step 1: Add the log path to `HELP_TEXT` — `src/cli/args.ts`**

Add an import at the top of the file (after the existing imports):
```typescript
import { logFile } from "../config/paths";
```
Change the closing of `HELP_TEXT` from:
```typescript
tip: quote magnet links (they contain & characters)
`;
```
to:
```typescript
tip: quote magnet links (they contain & characters)
logs: ${logFile}
`;
```

- [ ] **Step 2: Log a session-start line — `src/index.tsx`**

Add the import (after `import { VERSION } from "./version";`):
```typescript
import { log } from "./util/logger";
```
Immediately after the alt-screen write line (`process.stdout.write("\x1b[?1049h...`), add:
```typescript
log.info(`session start — torlink v${VERSION}`);
```

- [ ] **Step 3: Verify + commit**

Run: `npm run typecheck && npm test && npm run build`
Expected: all green; `dist/cli.cjs` emitted. (If `src/cli/args.test.ts` asserts exact `HELP_TEXT` contents, update that assertion to include the new `logs:` line and note it.)
```bash
git add src/cli/args.ts src/index.tsx
git commit -m "feat: surface the diagnostic log path in --help and mark session start"
```

---

## Final verification

- [ ] **Run everything**

Run: `npm run typecheck && npm test && npm run build`
Expected: all green.

- [ ] **Manual smoke** (`npm run dev`)
  - `torlnk --version` still works; `torlnk --help` shows a `logs: <path>` line.
  - Queue a couple of Real-Debrid downloads, then inspect `~/.local/share/torlink/torlink.log`: it should contain `session start`, `queue … resolving`, and — on a stall/"busy" — `rd … status=… retryAfter=… giving up` and `queue … failed reason="…"` lines.
  - Confirm the token/magnet never appear in the log (`grep -i bearer ~/.local/share/torlink/torlink.log` returns nothing; no `magnet:` links).
  - Re-run with `TORLINK_DEBUG=1` and confirm per-request `rd … →` debug lines appear.

---

## Notes

- The singleton is disabled under `process.env.VITEST`, so the existing suite (which exercises many RD failure paths) never appends to the real log. Logger behavior itself is covered via `createLogger` with injected IO.
- Redaction is structural: call sites pass only method, path, status, slug, Retry-After, attempt, and item id/name — never headers, token, or bodies.
- `net.ts` stays logger-agnostic; only the RD client supplies an `onAttempt` that logs, so torrent-source scrapers sharing `fetchResilient` are unaffected.
