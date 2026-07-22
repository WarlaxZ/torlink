# Trakt Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Trakt import feature to torlink that drives reccd's OAuth device-code flow (connect → poll → import) to pull the user's trakt.tv watch history and ratings into reccd, mirroring the existing Netflix importer's TUI + CLI surface.

**Architecture:** A shared core (`src/recc/traktImport.ts`) exposes three thin HTTP calls over reccd's Trakt endpoints plus a `runTraktFlow` orchestrator implementing "try import first, fall back to connect+poll+import". The TUI (`TraktImportPrompt` + App wiring, reached via a new `ImportSourcePrompt` chooser on the reccd row) and the CLI (`runImportTrakt`) both drive `runTraktFlow` via callbacks. No new config — Trakt reuses the existing reccd URL + bearer token; trakt.tv credentials live server-side in reccd.

**Tech Stack:** TypeScript (ESM), React + Ink (terminal UI), Vitest, Node ≥ 22 built-in `fetch`/`FormData`.

**Reference:** Design spec at `docs/superpowers/specs/2026-07-22-trakt-import-design.md`. The Netflix importer is the template throughout: `src/recc/netflixImport.ts`, `src/cli/runImportNetflix.ts`, `src/ui/components/NetflixImportPrompt.tsx`.

---

## File Structure

New files:
- `src/recc/importSummary.ts` — shared `formatImportSummary` (extracted from `netflixImport.ts`).
- `src/recc/traktImport.ts` — Trakt HTTP calls + `runTraktFlow` orchestrator.
- `src/recc/traktImport.test.ts` — tests for the above.
- `src/cli/runImportTrakt.ts` — headless `torlnk import-trakt` handler.
- `src/ui/components/TraktImportPrompt.tsx` — the Trakt import modal.
- `src/ui/components/TraktImportPrompt.test.tsx` — phase-machine test.
- `src/ui/components/ImportSourcePrompt.tsx` — the "Import from…" Netflix/Trakt chooser.
- `src/ui/components/ImportSourcePrompt.test.tsx` — chooser test.

Modified files:
- `src/recc/netflixImport.ts` — re-export `formatImportSummary` from `importSummary.ts`.
- `src/cli/args.ts` — `import-trakt` command + help text.
- `src/index.tsx` — dispatch `import-trakt`.
- `src/cli/args.test.ts` — parse `import-trakt`.
- `src/ui/App.tsx` — Trakt state/handlers/render + chooser; point `onImportRecc` at the chooser.
- `src/ui/components/Accounts.tsx` — no signature change (already passes `onImportRecc`); verified in Task 7.
- `src/ui/keymap.ts` — update the `i` help label.
- `README.md` — Trakt import docs.

---

## Task 1: Extract the shared import-summary formatter

**Files:**
- Create: `src/recc/importSummary.ts`
- Modify: `src/recc/netflixImport.ts:43-56`
- Test: `src/recc/netflixImport.test.ts` (existing test at lines 53-59 must still pass)

- [ ] **Step 1: Create the shared module**

Create `src/recc/importSummary.ts`:

```ts
// Shared by the Netflix and Trakt importers. Both reccd import endpoints return
// the same imported/resolved/unresolved counts, so the summary line is formatted
// in one place. Structural typing means any result object with these three
// numeric fields (NetflixImportResult, TraktImportResult) is accepted.
export interface ImportSummaryFields {
  imported: number;
  resolved: number;
  unresolved: number;
}

// `unresolved` is an event-level count (a title watched twice counts twice),
// whereas any accompanying `unresolvedTitles` list is the distinct set — so the
// number here can legitimately exceed the length of that list.
export function formatImportSummary(r: ImportSummaryFields): string {
  return `Imported ${r.imported} · ${r.resolved} matched · ${r.unresolved} unmatched`;
}
```

- [ ] **Step 2: Re-export from netflixImport.ts**

In `src/recc/netflixImport.ts`, delete the local `formatImportSummary` function and its doc comment (lines 51-56) and add a re-export near the top imports (after line 3):

```ts
export { formatImportSummary } from "./importSummary";
```

Leave `NetflixImportResult` (lines 43-49) as-is. Consumers that import `formatImportSummary` from `./netflixImport` (the test at `netflixImport.test.ts:2`, `NetflixImportPrompt.tsx:6`, `runImportNetflix.ts:3`) keep working via the re-export.

- [ ] **Step 3: Run the existing tests to confirm nothing broke**

Run: `npx vitest run src/recc/netflixImport.test.ts`
Expected: PASS (all existing cases, including `formatImportSummary` at lines 53-59).

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/recc/importSummary.ts src/recc/netflixImport.ts
git commit -m "refactor: extract shared formatImportSummary into importSummary.ts"
```

---

## Task 2: Trakt HTTP client functions

**Files:**
- Create: `src/recc/traktImport.ts`
- Test: `src/recc/traktImport.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/recc/traktImport.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { connectTrakt, checkTraktStatus, runTraktImport } from "./traktImport.js";
import type { FetchImpl } from "../util/net";

function jsonRes(status: number, body: unknown = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const CONFIG = { reccUrl: "http://host:4100", reccToken: "tok" };

describe("connectTrakt", () => {
  it("POSTs to /import/trakt/connect with a bearer token and returns device info", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes(200, { userCode: "AB12-CD34", verificationUrl: "https://trakt.tv/activate", interval: 5, expiresIn: 600 }),
    );
    const outcome = await connectTrakt(CONFIG, { fetchImpl: fetchImpl as unknown as FetchImpl });
    expect(outcome).toEqual({
      ok: true,
      info: { userCode: "AB12-CD34", verificationUrl: "https://trakt.tv/activate", interval: 5, expiresIn: 600 },
    });
    const [url, init] = fetchImpl.mock.calls[0] as [string, { method: string; headers: Record<string, string> }];
    expect(url).toBe("http://host:4100/import/trakt/connect");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Bearer tok");
  });

  it("flags notConfigured on a 501", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(501, { error: "trakt not configured" }));
    const outcome = await connectTrakt(CONFIG, { fetchImpl: fetchImpl as unknown as FetchImpl });
    expect(outcome).toEqual({ ok: false, error: "Trakt isn't enabled on your reccd server", notConfigured: true });
  });

  it("maps 401 to a token error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(401, { error: "unauthorized" }));
    const outcome = await connectTrakt(CONFIG, { fetchImpl: fetchImpl as unknown as FetchImpl });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBe("reccd rejected the token — check reccToken");
  });

  it("returns a not-linked error when reccUrl is missing", async () => {
    const outcome = await connectTrakt({ reccToken: "t" });
    expect(outcome).toEqual({ ok: false, error: "reccd is not linked — set it up in Accounts first" });
  });
});

describe("checkTraktStatus", () => {
  it("returns the status string", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(200, { status: "pending" }));
    const outcome = await checkTraktStatus(CONFIG, { fetchImpl: fetchImpl as unknown as FetchImpl });
    expect(outcome).toEqual({ ok: true, status: "pending" });
    expect((fetchImpl.mock.calls[0] as [string])[0]).toBe("http://host:4100/import/trakt/connect/status");
  });

  it("rejects an unexpected status value", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(200, { status: "banana" }));
    const outcome = await checkTraktStatus(CONFIG, { fetchImpl: fetchImpl as unknown as FetchImpl });
    expect(outcome.ok).toBe(false);
  });
});

describe("runTraktImport", () => {
  it("returns the aggregated result on 202", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes(202, { imported: 5, resolved: 5, unresolved: 0, unresolvedTitles: [] }),
    );
    const outcome = await runTraktImport(CONFIG, { fetchImpl: fetchImpl as unknown as FetchImpl });
    expect(outcome).toEqual({ ok: true, result: { imported: 5, resolved: 5, unresolved: 0, unresolvedTitles: [] } });
    expect((fetchImpl.mock.calls[0] as [string])[0]).toBe("http://host:4100/import/trakt");
  });

  it("flags notConnected on a 400", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(400, { error: "not connected" }));
    const outcome = await runTraktImport(CONFIG, { fetchImpl: fetchImpl as unknown as FetchImpl });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.notConnected).toBe(true);
  });

  it("flags notConnected on a reconnect-required 400", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(400, { error: "reconnect required" }));
    const outcome = await runTraktImport(CONFIG, { fetchImpl: fetchImpl as unknown as FetchImpl });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.notConnected).toBe(true);
  });

  it("flags notConfigured on a 501", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(501, { error: "trakt not configured" }));
    const outcome = await runTraktImport(CONFIG, { fetchImpl: fetchImpl as unknown as FetchImpl });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.notConfigured).toBe(true);
  });

  it("coerces stringy numeric fields and drops non-string titles", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes(202, { imported: "3", resolved: "2", unresolved: "1", unresolvedTitles: ["Heat", 42] }),
    );
    const outcome = await runTraktImport(CONFIG, { fetchImpl: fetchImpl as unknown as FetchImpl });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.imported).toBe(3);
      expect(outcome.result.unresolvedTitles).toEqual(["Heat"]);
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/recc/traktImport.test.ts`
Expected: FAIL — cannot find module `./traktImport.js` / exports not defined.

- [ ] **Step 3: Implement the client**

Create `src/recc/traktImport.ts`:

```ts
import { log } from "../util/logger";
import type { FetchImpl } from "../util/net";
import type { ReccClientConfig } from "./client";

const NOT_LINKED = "reccd is not linked — set it up in Accounts first";
const BAD_TOKEN = "reccd rejected the token — check reccToken";
const NOT_CONFIGURED = "Trakt isn't enabled on your reccd server";
const UNREACHABLE = "couldn't reach reccd";

export interface TraktRequestOptions {
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
}

export interface TraktConnectInfo {
  userCode: string;
  verificationUrl: string;
  interval: number; // seconds between status polls
  expiresIn: number; // seconds until the device code expires
}

export type TraktStatus = "pending" | "connected" | "expired";

export interface TraktImportResult {
  imported: number;
  resolved: number;
  unresolved: number;
  unresolvedTitles: string[];
}

export type TraktConnectOutcome =
  | { ok: true; info: TraktConnectInfo }
  | { ok: false; error: string; notConfigured?: boolean };

export type TraktStatusOutcome =
  | { ok: true; status: TraktStatus }
  | { ok: false; error: string; notConfigured?: boolean };

export type TraktImportOutcome =
  | { ok: true; result: TraktImportResult }
  | { ok: false; error: string; notConnected?: boolean; notConfigured?: boolean };

function post(config: ReccClientConfig, path: string, fetchImpl: FetchImpl, timeoutMs: number): Promise<Response> {
  return fetchImpl(`${config.reccUrl}${path}`, {
    method: "POST",
    // reccd's server always requires a token, so an empty string here (rather
    // than omitting the header) is deliberate: a forgotten reccToken produces a
    // clean 401 instead of a silently different request.
    headers: { authorization: `Bearer ${config.reccToken ?? ""}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

export async function connectTrakt(config: ReccClientConfig, opts: TraktRequestOptions = {}): Promise<TraktConnectOutcome> {
  if (!config.reccUrl) return { ok: false, error: NOT_LINKED };
  const fetchImpl = opts.fetchImpl ?? (fetch as FetchImpl);
  let res: Response;
  try {
    res = await post(config, "/import/trakt/connect", fetchImpl, opts.timeoutMs ?? 15000);
  } catch (err) {
    log.debug(`trakt connect: failed to reach ${config.reccUrl}: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, error: UNREACHABLE };
  }
  if (res.status === 401) return { ok: false, error: BAD_TOKEN };
  if (res.status === 501) return { ok: false, error: NOT_CONFIGURED, notConfigured: true };
  if (!res.ok) return { ok: false, error: `Trakt request failed (HTTP ${res.status})` };
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const userCode = body.userCode;
  const verificationUrl = body.verificationUrl;
  if (typeof userCode !== "string" || typeof verificationUrl !== "string") {
    return { ok: false, error: "unexpected response from reccd" };
  }
  return {
    ok: true,
    info: {
      userCode,
      verificationUrl,
      interval: Number(body.interval) || 5,
      expiresIn: Number(body.expiresIn) || 600,
    },
  };
}

export async function checkTraktStatus(config: ReccClientConfig, opts: TraktRequestOptions = {}): Promise<TraktStatusOutcome> {
  if (!config.reccUrl) return { ok: false, error: NOT_LINKED };
  const fetchImpl = opts.fetchImpl ?? (fetch as FetchImpl);
  let res: Response;
  try {
    res = await post(config, "/import/trakt/connect/status", fetchImpl, opts.timeoutMs ?? 15000);
  } catch (err) {
    log.debug(`trakt status: failed to reach ${config.reccUrl}: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, error: UNREACHABLE };
  }
  if (res.status === 401) return { ok: false, error: BAD_TOKEN };
  if (res.status === 501) return { ok: false, error: NOT_CONFIGURED, notConfigured: true };
  if (!res.ok) return { ok: false, error: `Trakt request failed (HTTP ${res.status})` };
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (body.status === "pending" || body.status === "connected" || body.status === "expired") {
    return { ok: true, status: body.status };
  }
  return { ok: false, error: "unexpected response from reccd" };
}

export async function runTraktImport(config: ReccClientConfig, opts: TraktRequestOptions = {}): Promise<TraktImportOutcome> {
  if (!config.reccUrl) return { ok: false, error: NOT_LINKED };
  const fetchImpl = opts.fetchImpl ?? (fetch as FetchImpl);
  let res: Response;
  try {
    res = await post(config, "/import/trakt", fetchImpl, opts.timeoutMs ?? 60000);
  } catch (err) {
    log.debug(`trakt import: failed to reach ${config.reccUrl}: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, error: UNREACHABLE };
  }
  if (res.status === 401) return { ok: false, error: BAD_TOKEN };
  if (res.status === 501) return { ok: false, error: NOT_CONFIGURED, notConfigured: true };
  if (res.status === 400) return { ok: false, error: "not connected to Trakt yet", notConnected: true };
  if (!res.ok) return { ok: false, error: `Trakt import failed (HTTP ${res.status})` };
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const titles: string[] = [];
  const seen = new Set<string>();
  for (const t of Array.isArray(body.unresolvedTitles) ? body.unresolvedTitles : []) {
    if (typeof t === "string" && !seen.has(t)) {
      seen.add(t);
      titles.push(t);
    }
  }
  return {
    ok: true,
    result: {
      imported: Number(body.imported) || 0,
      resolved: Number(body.resolved) || 0,
      unresolved: Number(body.unresolved) || 0,
      unresolvedTitles: titles,
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/recc/traktImport.test.ts`
Expected: PASS (all cases in Step 1).

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/recc/traktImport.ts src/recc/traktImport.test.ts
git commit -m "feat: add Trakt HTTP client (connect/status/import) for reccd"
```

---

## Task 3: Trakt flow orchestrator

**Files:**
- Modify: `src/recc/traktImport.ts` (append)
- Test: `src/recc/traktImport.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `src/recc/traktImport.test.ts`:

```ts
import { runTraktFlow } from "./traktImport.js";

const noSleep = vi.fn().mockResolvedValue(undefined);

describe("runTraktFlow", () => {
  it("returns immediately when already connected (import succeeds first try)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes(202, { imported: 4, resolved: 4, unresolved: 0, unresolvedTitles: [] }),
    );
    const onConnect = vi.fn();
    const outcome = await runTraktFlow(CONFIG, { onConnect }, { fetchImpl: fetchImpl as unknown as FetchImpl, sleepImpl: noSleep });
    expect(outcome.ok).toBe(true);
    expect(onConnect).not.toHaveBeenCalled(); // no device flow needed
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("runs connect → poll → import when not connected", async () => {
    const fetchImpl = vi
      .fn()
      // 1. initial import probe → not connected
      .mockResolvedValueOnce(jsonRes(400, { error: "not connected" }))
      // 2. connect → device code
      .mockResolvedValueOnce(jsonRes(200, { userCode: "AB12-CD34", verificationUrl: "https://trakt.tv/activate", interval: 5, expiresIn: 600 }))
      // 3. status poll → pending, then connected
      .mockResolvedValueOnce(jsonRes(200, { status: "pending" }))
      .mockResolvedValueOnce(jsonRes(200, { status: "connected" }))
      // 4. final import → success
      .mockResolvedValueOnce(jsonRes(202, { imported: 7, resolved: 7, unresolved: 0, unresolvedTitles: [] }));
    const onConnect = vi.fn();
    const outcome = await runTraktFlow(CONFIG, { onConnect }, { fetchImpl: fetchImpl as unknown as FetchImpl, sleepImpl: noSleep });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.result.imported).toBe(7);
    expect(onConnect).toHaveBeenCalledWith(
      expect.objectContaining({ userCode: "AB12-CD34", verificationUrl: "https://trakt.tv/activate" }),
    );
  });

  it("stops with an error when the device code expires", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(400, { error: "not connected" }))
      .mockResolvedValueOnce(jsonRes(200, { userCode: "AB12", verificationUrl: "u", interval: 5, expiresIn: 5 }))
      .mockResolvedValueOnce(jsonRes(200, { status: "expired" }));
    const outcome = await runTraktFlow(CONFIG, {}, { fetchImpl: fetchImpl as unknown as FetchImpl, sleepImpl: noSleep });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("expired");
  });

  it("short-circuits when Trakt is not configured on the server", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(501, { error: "trakt not configured" }));
    const onConnect = vi.fn();
    const outcome = await runTraktFlow(CONFIG, { onConnect }, { fetchImpl: fetchImpl as unknown as FetchImpl, sleepImpl: noSleep });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.notConfigured).toBe(true);
    expect(onConnect).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/recc/traktImport.test.ts`
Expected: FAIL — `runTraktFlow` is not exported.

- [ ] **Step 3: Implement the orchestrator**

Append to `src/recc/traktImport.ts`:

```ts
import type { SleepImpl } from "../util/net";

export interface TraktFlowCallbacks {
  // Fires once the device code is issued: show the code + verification URL.
  onConnect?: (info: TraktConnectInfo) => void;
  // Fires on each poll result while waiting for the user to authorize.
  onStatus?: (status: TraktStatus) => void;
  // Fires just before the (post-authorization) import runs.
  onImporting?: () => void;
}

export interface TraktFlowOptions extends TraktRequestOptions {
  sleepImpl?: SleepImpl;
}

const defaultSleep: SleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Orchestrates the full import. reccd persists the Trakt token, so the first
// step is an optimistic import: if a token is already stored it succeeds and we
// return straight away (no re-authorization). Only a "not connected" result
// drops into the device-code handshake (connect → poll → import).
export async function runTraktFlow(
  config: ReccClientConfig,
  callbacks: TraktFlowCallbacks = {},
  opts: TraktFlowOptions = {},
): Promise<TraktImportOutcome> {
  const sleep = opts.sleepImpl ?? defaultSleep;

  const first = await runTraktImport(config, opts);
  if (first.ok || !first.notConnected) return first; // success, or a real error (incl. notConfigured)

  const connect = await connectTrakt(config, opts);
  if (!connect.ok) return connect;
  callbacks.onConnect?.(connect.info);

  const interval = Math.max(1, connect.info.interval);
  const maxPolls = Math.max(1, Math.ceil(connect.info.expiresIn / interval));
  for (let i = 0; i < maxPolls; i++) {
    await sleep(interval * 1000);
    const status = await checkTraktStatus(config, opts);
    if (!status.ok) return status;
    callbacks.onStatus?.(status.status);
    if (status.status === "connected") {
      callbacks.onImporting?.();
      return runTraktImport(config, opts);
    }
    if (status.status === "expired") break;
  }
  return { ok: false, error: "Trakt authorization expired — try again" };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/recc/traktImport.test.ts`
Expected: PASS (all cases, including Task 2's).

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/recc/traktImport.ts src/recc/traktImport.test.ts
git commit -m "feat: add runTraktFlow orchestrator (try-import then connect+poll+import)"
```

---

## Task 4: CLI command

**Files:**
- Create: `src/cli/runImportTrakt.ts`
- Modify: `src/cli/args.ts:30`, `src/cli/args.ts:82-86`, `src/cli/args.ts:145`, `src/index.tsx:33`, `src/index.tsx:78-85`
- Test: `src/cli/args.test.ts` (append)

- [ ] **Step 1: Write the failing arg-parsing test**

Append to `src/cli/args.test.ts` (near the existing `import-netflix` cases at lines 43-53):

```ts
it("parses import-trakt", () => {
  expect(parseCliArgs(["import-trakt"])).toEqual({ kind: "import-trakt" });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/cli/args.test.ts`
Expected: FAIL — parser returns `{ kind: "invalid", arg: "import-trakt" }`.

- [ ] **Step 3: Add the command to the parser**

In `src/cli/args.ts`, add to the `CliCommand` union after line 30 (`| { kind: "import-netflix"; file: string }`):

```ts
  | { kind: "import-trakt" }
```

Add the parse branch after the `import-netflix` branch (after line 86):

```ts
  if (a === "import-trakt") return { kind: "import-trakt" };
```

Add a help line in `HELP_TEXT` after line 145 (the `import-netflix` line):

```ts
  torlnk import-trakt          connect Trakt and import your history into reccd
```

- [ ] **Step 4: Run the arg test to verify it passes**

Run: `npx vitest run src/cli/args.test.ts`
Expected: PASS.

- [ ] **Step 5: Create the CLI handler**

Create `src/cli/runImportTrakt.ts`:

```ts
import { loadConfig, resolveReccConfig } from "../config/config";
import { runTraktFlow } from "../recc/traktImport";
import { formatImportSummary } from "../recc/importSummary";

// Headless `torlnk import-trakt`. Interactive: it prints a code + URL to stderr
// and blocks (polling) while the user authorizes at trakt.tv, then imports.
// Throws on failure so index.tsx's failHeadless prints the message and exits
// non-zero.
export async function runImportTrakt(): Promise<void> {
  const config = await loadConfig();
  const reccConfig = resolveReccConfig(config);
  if (!reccConfig.reccUrl) {
    throw new Error(
      "reccd is not linked. Set TORLINK_RECC_URL / TORLINK_RECC_TOKEN, or configure it in the TUI Accounts pane.",
    );
  }

  const outcome = await runTraktFlow(reccConfig, {
    // Prompts and progress go to stderr so stdout carries only the final summary.
    onConnect: (info) => {
      console.error(`\nGo to ${info.verificationUrl} and enter code: ${info.userCode}`);
      console.error("Waiting for you to authorize…");
    },
    onImporting: () => console.error("Authorized. Importing from Trakt…"),
  });

  if (!outcome.ok) throw new Error(outcome.error);

  console.log(formatImportSummary(outcome.result));
  const unmatched = outcome.result.unresolvedTitles;
  if (unmatched.length > 0) {
    console.log(`\nunmatched titles (${unmatched.length}):`);
    for (const title of unmatched) console.log(`  ${title}`);
  }
}
```

- [ ] **Step 6: Wire dispatch in index.tsx**

In `src/index.tsx`, add `import-trakt` to the `containUnhandledRejections` echo list (line 33):

```ts
  echo: cmd.kind === "update" || cmd.kind === "watch" || cmd.kind === "serve" || cmd.kind === "files" || cmd.kind === "import-netflix" || cmd.kind === "import-trakt",
```

Add a dispatch branch after the `import-netflix` block (after line 85, before the closing `} else {`):

```ts
} else if (cmd.kind === "import-trakt") {
  // Like import-netflix: no forced exit(0) on success, so the summary/titles
  // aren't truncated when stdout is a pipe. Errors exit non-zero via failHeadless.
  void import("./cli/runImportTrakt").then(({ runImportTrakt }) => runImportTrakt().catch(failHeadless));
```

- [ ] **Step 7: Type-check and run the CLI against a bad config to confirm the error path**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `TORLINK_RECC_URL= node --import tsx src/index.tsx import-trakt`
Expected: prints "reccd is not linked. Set TORLINK_RECC_URL…" to stderr and exits non-zero (verifies the not-linked guard without needing a live reccd).

Note: if the repo has a build/run script (check `package.json` scripts), prefer it, e.g. `npm run dev -- import-trakt`. The behavior to confirm is the not-linked message + non-zero exit.

- [ ] **Step 8: Commit**

```bash
git add src/cli/runImportTrakt.ts src/cli/args.ts src/cli/args.test.ts src/index.tsx
git commit -m "feat: add headless torlnk import-trakt command"
```

---

## Task 5: TraktImportPrompt component

**Files:**
- Create: `src/ui/components/TraktImportPrompt.tsx`
- Test: `src/ui/components/TraktImportPrompt.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/ui/components/TraktImportPrompt.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { TraktImportPrompt, type TraktImportView } from "./TraktImportPrompt";

const ESC = String.fromCharCode(27);

describe("TraktImportPrompt", () => {
  it("shows the code and verification URL in the connect phase", () => {
    const state: TraktImportView = {
      phase: "connect",
      connect: { userCode: "AB12-CD34", verificationUrl: "https://trakt.tv/activate" },
    };
    const { lastFrame } = render(<TraktImportPrompt width={60} state={state} onClose={vi.fn()} />);
    expect(lastFrame()).toContain("AB12-CD34");
    expect(lastFrame()).toContain("trakt.tv/activate");
  });

  it("shows the summary in the done phase", () => {
    const state: TraktImportView = {
      phase: "done",
      result: { imported: 9, resolved: 9, unresolved: 0, unresolvedTitles: [] },
    };
    const { lastFrame } = render(<TraktImportPrompt width={60} state={state} onClose={vi.fn()} />);
    expect(lastFrame()).toContain("Imported 9");
  });

  it("shows an error in the done phase", () => {
    const state: TraktImportView = { phase: "done", error: "Trakt isn't enabled on your reccd server" };
    const { lastFrame } = render(<TraktImportPrompt width={60} state={state} onClose={vi.fn()} />);
    expect(lastFrame()).toContain("Trakt isn't enabled");
  });

  it("closes on escape", () => {
    const onClose = vi.fn();
    const { stdin } = render(<TraktImportPrompt width={60} state={{ phase: "checking" }} onClose={onClose} />);
    stdin.write(ESC);
    expect(onClose).toHaveBeenCalled();
  });
});
```

Note: confirm the test harness is `ink-testing-library` by checking an existing component test (e.g. `src/ui/components/ReccdPrompt.test.tsx`); match its import style.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/ui/components/TraktImportPrompt.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the component**

Create `src/ui/components/TraktImportPrompt.tsx` (modeled on `NetflixImportPrompt.tsx`; the `done`-phase scrollable unmatched list mirrors it):

```tsx
import { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { Panel } from "./Panel";
import { COLOR, ICON } from "../theme";
import { formatImportSummary } from "../../recc/importSummary";
import type { TraktImportResult } from "../../recc/traktImport";

export interface TraktImportView {
  phase: "checking" | "connect" | "running" | "done";
  connect?: { userCode: string; verificationUrl: string };
  progress?: { message: string };
  result?: TraktImportResult;
  error?: string;
}

interface TraktImportPromptProps {
  width: number;
  state: TraktImportView;
  onClose: () => void;
}

const MAX_VISIBLE_UNMATCHED = 8;

export function TraktImportPrompt({ width, state, onClose }: TraktImportPromptProps) {
  const [scroll, setScroll] = useState(0);
  const unmatched = state.result?.unresolvedTitles ?? [];
  const maxScroll = Math.max(0, unmatched.length - MAX_VISIBLE_UNMATCHED);

  useEffect(() => {
    if (state.phase !== "done") setScroll(0);
  }, [state.phase]);

  useInput((_input, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    if (state.phase === "done") {
      if (key.return) onClose();
      else if (key.upArrow) setScroll((s) => Math.max(0, s - 1));
      else if (key.downArrow) setScroll((s) => Math.min(maxScroll, s + 1));
    }
  });

  if (state.phase === "checking") {
    return (
      <Box flexDirection="column" width={width}>
        <Panel title="import Trakt history" width={width} focused height={3}>
          <Text>
            <Text color={COLOR.accent}>{`${ICON.dot} `}</Text>
            Checking your Trakt connection…
          </Text>
        </Panel>
      </Box>
    );
  }

  if (state.phase === "connect") {
    return (
      <Box flexDirection="column" width={width}>
        <Panel title="import Trakt history" width={width} focused height={7}>
          <Text>To connect Trakt, open this page and enter the code:</Text>
          <Box marginTop={1}>
            <Text color={COLOR.accent}>{state.connect?.verificationUrl ?? "https://trakt.tv/activate"}</Text>
          </Box>
          <Box marginTop={1}>
            <Text>code: </Text>
            <Text color={COLOR.good} bold>{state.connect?.userCode ?? ""}</Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>{`${ICON.dot} Waiting for you to authorize…`}</Text>
          </Box>
        </Panel>
        <Box marginTop={1}>
          <Text color={COLOR.alt}>esc</Text>
          <Text dimColor> cancel</Text>
        </Box>
      </Box>
    );
  }

  if (state.phase === "running") {
    return (
      <Box flexDirection="column" width={width}>
        <Panel title="import Trakt history" width={width} focused height={3}>
          <Text>
            <Text color={COLOR.accent}>{`${ICON.dot} `}</Text>
            {state.progress?.message ?? "Importing from Trakt…"}
          </Text>
        </Panel>
      </Box>
    );
  }

  // phase === "done"
  const offset = Math.min(scroll, maxScroll);
  const visible = unmatched.slice(offset, offset + MAX_VISIBLE_UNMATCHED);
  const scrollable = unmatched.length > MAX_VISIBLE_UNMATCHED;
  const listHeader = scrollable
    ? `unmatched titles (${offset + 1}–${offset + visible.length} of ${unmatched.length}):`
    : "unmatched titles:";
  return (
    <Box flexDirection="column" width={width}>
      <Panel title="import Trakt history" width={width} focused height={4 + visible.length + (unmatched.length > 0 ? 1 : 0)}>
        {state.error ? <Text color={COLOR.warn}>{`${ICON.warn} ${state.error}`}</Text> : null}
        {state.result ? (
          <Text>
            <Text color={COLOR.good}>{`${ICON.done} `}</Text>
            {formatImportSummary(state.result)}
          </Text>
        ) : null}
        {unmatched.length > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>{listHeader}</Text>
            {visible.map((t, i) => (
              <Text key={`${offset + i}-${t}`} dimColor>{`  ${t}`}</Text>
            ))}
          </Box>
        ) : null}
      </Panel>
      <Box marginTop={1}>
        {scrollable ? (
          <Text>
            <Text color={COLOR.alt}>↑↓</Text>
            <Text dimColor> scroll</Text>
            <Text dimColor>{`     ${ICON.dot}     `}</Text>
          </Text>
        ) : null}
        <Text color={COLOR.alt}>↵ / esc</Text>
        <Text dimColor> close</Text>
      </Box>
    </Box>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/ui/components/TraktImportPrompt.test.tsx`
Expected: PASS.

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/ui/components/TraktImportPrompt.tsx src/ui/components/TraktImportPrompt.test.tsx
git commit -m "feat: add TraktImportPrompt component"
```

---

## Task 6: Import-source chooser

**Files:**
- Create: `src/ui/components/ImportSourcePrompt.tsx`
- Test: `src/ui/components/ImportSourcePrompt.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/ui/components/ImportSourcePrompt.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { ImportSourcePrompt } from "./ImportSourcePrompt";

const ESC = String.fromCharCode(27);
const DOWN = "\u001B[B"; // down-arrow escape sequence

describe("ImportSourcePrompt", () => {
  it("lists Netflix and Trakt", () => {
    const { lastFrame } = render(
      <ImportSourcePrompt width={50} onSelect={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(lastFrame()).toContain("Netflix");
    expect(lastFrame()).toContain("Trakt");
  });

  it("selects Netflix (first item) on enter", () => {
    const onSelect = vi.fn();
    const { stdin } = render(<ImportSourcePrompt width={50} onSelect={onSelect} onCancel={vi.fn()} />);
    stdin.write("\r"); // enter
    expect(onSelect).toHaveBeenCalledWith("netflix");
  });

  it("selects Trakt after moving down", () => {
    const onSelect = vi.fn();
    const { stdin } = render(<ImportSourcePrompt width={50} onSelect={onSelect} onCancel={vi.fn()} />);
    stdin.write(DOWN); // down arrow
    stdin.write("\r");
    expect(onSelect).toHaveBeenCalledWith("trakt");
  });

  it("cancels on escape", () => {
    const onCancel = vi.fn();
    const { stdin } = render(<ImportSourcePrompt width={50} onSelect={vi.fn()} onCancel={onCancel} />);
    stdin.write(ESC);
    expect(onCancel).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/ui/components/ImportSourcePrompt.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the chooser**

Create `src/ui/components/ImportSourcePrompt.tsx`:

```tsx
import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { Panel } from "./Panel";
import { wrapStep } from "../move";
import { COLOR, GUTTER, ICON } from "../theme";

export type ImportSource = "netflix" | "trakt";

interface ImportSourcePromptProps {
  width: number;
  onSelect: (source: ImportSource) => void;
  onCancel: () => void;
}

const OPTIONS: Array<{ id: ImportSource; label: string; hint: string }> = [
  { id: "netflix", label: "Netflix", hint: "upload your viewing-activity CSV" },
  { id: "trakt", label: "Trakt", hint: "connect trakt.tv and pull your history" },
];

export function ImportSourcePrompt({ width, onSelect, onCancel }: ImportSourcePromptProps) {
  const [cursor, setCursor] = useState(0);
  const clamped = Math.min(cursor, OPTIONS.length - 1);

  useInput((_input, key) => {
    if (key.escape) onCancel();
    else if (key.upArrow) setCursor(wrapStep(clamped, -1, OPTIONS.length));
    else if (key.downArrow) setCursor(wrapStep(clamped, 1, OPTIONS.length));
    else if (key.return) onSelect(OPTIONS[clamped]!.id);
  });

  return (
    <Box flexDirection="column" width={width}>
      <Panel title="import history" width={width} focused height={2 + OPTIONS.length}>
        <Text dimColor>Import your watch history into reccd from:</Text>
        <Box flexDirection="column" marginTop={1}>
          {OPTIONS.map((o, i) => {
            const here = i === clamped;
            return (
              <Box key={o.id}>
                <Box width={GUTTER} flexShrink={0}>
                  <Text color={COLOR.accent} bold>{here ? ICON.pointer : ""}</Text>
                </Box>
                <Text bold={here} color={here ? COLOR.accent : undefined} dimColor={!here}>
                  {o.label}
                  <Text dimColor>{`  ${ICON.dot} ${o.hint}`}</Text>
                </Text>
              </Box>
            );
          })}
        </Box>
      </Panel>
      <Box marginTop={1}>
        <Text color={COLOR.alt}>↵</Text>
        <Text dimColor> choose</Text>
        <Text dimColor>{`     ${ICON.dot}     `}</Text>
        <Text color={COLOR.alt}>esc</Text>
        <Text dimColor> cancel</Text>
      </Box>
    </Box>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/ui/components/ImportSourcePrompt.test.tsx`
Expected: PASS.

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/ui/components/ImportSourcePrompt.tsx src/ui/components/ImportSourcePrompt.test.tsx
git commit -m "feat: add ImportSourcePrompt chooser (Netflix / Trakt)"
```

---

## Task 7: Wire the chooser + Trakt flow into App.tsx

**Files:**
- Modify: `src/ui/App.tsx` (imports ~22/84, state ~169-175, handlers ~710-754, input guards 1456/1558/2064/2135, render ~1751-1760, Accounts prop 2110)

The reccd row's `i` keybind already calls `onImportRecc` (`Accounts.tsx:128`, prop passed at `App.tsx:2110`). We repoint `onImportRecc` at a new chooser; the chooser then opens either the existing Netflix prompt or the new Trakt prompt. `Accounts.tsx` needs no change.

- [ ] **Step 1: Add imports**

In `src/ui/App.tsx`, after the Netflix core import (line 22 `import { uploadNetflixCsv } from "../recc/netflixImport";`):

```ts
import { runTraktFlow, type TraktStatus } from "../recc/traktImport";
```

After the `NetflixImportPrompt` import (line 84):

```ts
import { TraktImportPrompt, type TraktImportView } from "./components/TraktImportPrompt";
import { ImportSourcePrompt, type ImportSource } from "./components/ImportSourcePrompt";
```

- [ ] **Step 2: Add state**

After the Netflix import state block (`src/ui/App.tsx:170`, the `netflixImport` line) and its `netflixImportGen` ref (line 175), add:

```ts
  const [importChooser, setImportChooser] = useState(false);
  const [importingTrakt, setImportingTrakt] = useState(false);
  const [traktImport, setTraktImport] = useState<TraktImportView>({ phase: "checking" });
  // Same generation guard as Netflix: an in-flight poll/import can't be aborted,
  // but a late completion must not flash stale state onto a reopened overlay.
  const traktImportGen = useRef(0);
```

- [ ] **Step 3: Add the chooser + Trakt handlers**

After `runNetflixImport` (ends at `src/ui/App.tsx:754`), add:

```ts
  const openImportChooser = useCallback(() => {
    setView("browser");
    setShowHelp(false);
    setImportChooser(true);
  }, []);

  const closeImportChooser = useCallback(() => setImportChooser(false), []);

  const closeTraktImport = useCallback(() => {
    traktImportGen.current++; // supersede any in-flight run so it can't update state after close
    setImportingTrakt(false);
  }, []);

  const openTraktImport = useCallback(() => {
    if (!config) return;
    setImportChooser(false);
    const gen = ++traktImportGen.current;
    const isCurrent = (): boolean => traktImportGen.current === gen;
    setTraktImport({ phase: "checking" });
    setImportingTrakt(true);
    void (async () => {
      const outcome = await runTraktFlow(resolveReccConfig(config), {
        onConnect: (info) => {
          if (isCurrent()) {
            setTraktImport({ phase: "connect", connect: { userCode: info.userCode, verificationUrl: info.verificationUrl } });
          }
        },
        onStatus: (status: TraktStatus) => {
          if (isCurrent() && status === "pending") {
            setTraktImport((s) => (s.phase === "connect" ? s : { phase: "checking" }));
          }
        },
        onImporting: () => {
          if (isCurrent()) setTraktImport({ phase: "running", progress: { message: "Importing from Trakt…" } });
        },
      });
      if (!isCurrent()) return;
      if (outcome.ok) setTraktImport({ phase: "done", result: outcome.result });
      else setTraktImport({ phase: "done", error: outcome.error });
    })();
  }, [config]);

  const chooseImportSource = useCallback(
    (source: ImportSource) => {
      if (source === "netflix") {
        setImportChooser(false);
        openNetflixImport();
      } else {
        openTraktImport();
      }
    },
    [openNetflixImport, openTraktImport],
  );
```

- [ ] **Step 4: Add to the input-owner guard lists**

There are two long boolean chains that must include the new overlays (lines 1456 and 2064) and two `if (...) return;` input guards (line 1558 area and 2135). Add `|| importChooser || importingTrakt` to each of the boolean chains at `src/ui/App.tsx:1456`, `:2064`, and `:2135`. For the render `useInput` guard block near line 1558, add these two lines alongside `if (importingNetflix) return;`:

```ts
      if (importChooser) return; // the import-source chooser owns input
      if (importingTrakt) return; // the Trakt import prompt owns input
```

- [ ] **Step 5: Add to the render tree**

After the Netflix prompt render block (`src/ui/App.tsx:1751-1760`), add:

```tsx
        {importChooser ? (
          <Box marginTop={1}>
            <ImportSourcePrompt
              width={Math.max(30, Math.min(cols - 4, 72))}
              onSelect={chooseImportSource}
              onCancel={closeImportChooser}
            />
          </Box>
        ) : null}

        {importingTrakt ? (
          <Box marginTop={1}>
            <TraktImportPrompt
              width={Math.max(30, Math.min(cols - 4, 72))}
              state={traktImport}
              onClose={closeTraktImport}
            />
          </Box>
        ) : null}
```

- [ ] **Step 6: Repoint the Accounts import callback**

Change `onImportRecc={openNetflixImport}` (`src/ui/App.tsx:2110`) to:

```tsx
                onImportRecc={openImportChooser}
```

- [ ] **Step 7: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors. (If `cols` isn't in scope at the render site, it is — confirmed at `App.tsx:133`; it's the same variable the Netflix prompt uses at line 1754.)

- [ ] **Step 8: Run the full test suite**

Run: `npx vitest run`
Expected: PASS (all existing + new tests).

- [ ] **Step 9: Manual smoke test (TUI)**

Run the app (check `package.json` for the dev/start script, e.g. `npm run dev` or `npm start`). In the TUI: Accounts tab → select reccd (must be connected) → press `i` → confirm the "import history" chooser lists Netflix and Trakt → choose Netflix routes to the CSV prompt; choose Trakt shows "Checking your Trakt connection…" then either a summary (if already connected) or the connect screen with a code + URL. Press esc to confirm the overlay closes and input returns to the pane.

- [ ] **Step 10: Commit**

```bash
git add src/ui/App.tsx
git commit -m "feat: wire Trakt import + source chooser into the Accounts pane"
```

---

## Task 8: Keymap label + README docs

**Files:**
- Modify: `src/ui/keymap.ts:36`
- Modify: `README.md:117-126`, `README.md:169`

- [ ] **Step 1: Update the keymap help label**

In `src/ui/keymap.ts`, change line 36 from:

```ts
      { keys: "i", label: "Import Netflix history (reccd)" },
```

to:

```ts
      { keys: "i", label: "Import history — Netflix or Trakt (reccd)" },
```

- [ ] **Step 2: Update the README**

In `README.md`, retitle the section at line 117 from `### Import your Netflix history` to `### Import your history` and add a Trakt subsection after the Netflix instructions (after line 126). Insert:

```markdown
#### From Trakt

Already track your watching on [Trakt](https://trakt.tv)? Pull your watch history and ratings straight in — no file needed.

- **In the app:** open the **Accounts** tab, select **reccd** (once it's connected), press **`i`**, and choose **Trakt**. You'll get a short code and a URL — open the URL, enter the code to authorize, and torlink imports automatically. After the first time you won't need to re-authorize.
- **From the shell:** `torlnk import-trakt` — it prints the code + URL, waits for you to authorize, then imports.

This needs the reccd server to have a Trakt app configured (`RECCD_TRAKT_CLIENT_ID` / `RECCD_TRAKT_CLIENT_SECRET`); without it, torlink will tell you Trakt isn't enabled on your server.
```

Also add a usage line after the `import-netflix` line at `README.md:169`:

```
    torlnk import-trakt           connect Trakt and import your history into reccd
```

- [ ] **Step 3: Verify docs build/lint if applicable**

Run: `git diff --stat`
Expected: shows `src/ui/keymap.ts` and `README.md` changed. (No test covers README; keymap has no dedicated test — the full suite from Task 7 Step 8 already covers regressions.)

- [ ] **Step 4: Final full check**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/ui/keymap.ts README.md
git commit -m "docs: document Trakt import (keymap label + README)"
```

---

## Self-Review Notes

- **Spec coverage:** shared core (Tasks 2-3) ✓; try-import→connect→poll→import flow (`runTraktFlow`, Task 3) ✓; chooser on reccd row (Tasks 6-7) ✓; `TraktImportPrompt` phases checking/connect/running/done (Task 5) ✓; interactive CLI (Task 4) ✓; no new config (reuses `resolveReccConfig`, Tasks 4 & 7) ✓; 501→friendly message (`NOT_CONFIGURED` surfaced through `done`/CLI error) ✓; shared `formatImportSummary` (Task 1) ✓; error-handling table mapped in the client (Task 2) ✓; tests for core/CLI/prompt (Tasks 2,3,4,5,6) ✓; keymap + README (Task 8) ✓.
- **Type consistency:** `TraktImportView`, `TraktImportResult`, `TraktConnectInfo`, `TraktStatus`, `TraktFlowCallbacks`, `ImportSource` names used consistently across tasks. `runTraktFlow(config, callbacks, opts)` signature matches between definition (Task 3) and both callers (Tasks 4, 7).
- **Line-number caveat:** `App.tsx` line references are from the current tree; if earlier tasks shift lines, locate by the quoted anchor text rather than the number.
