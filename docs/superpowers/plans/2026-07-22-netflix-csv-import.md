# Netflix CSV Import → reccd — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a torlink user upload their Netflix "viewing activity" CSV into reccd (`POST /import/netflix`) from both the TUI (Accounts pane) and a CLI subcommand, chunking to stay under reccd's 1 MiB cap.

**Architecture:** One shared core module (`src/recc/netflixImport.ts`) does chunking + upload + result formatting. Two thin frontends call it: a headless CLI runner (`torlnk import-netflix <file>`) and a TUI overlay (`NetflixImportPrompt`) wired into the Accounts pane. Auth/URL reuse `resolveReccConfig()`; HTTP uses the injectable `FetchImpl` pattern already in `src/recc/client.ts`.

**Tech Stack:** TypeScript (ESM, Node ≥ 22), React + Ink for the TUI, Vitest for tests. Multipart upload uses global `FormData`/`Blob` (native in Node 22) + global `fetch`.

Spec: `docs/superpowers/specs/2026-07-22-netflix-csv-import-design.md`

---

## File Structure

- **Create** `src/recc/netflixImport.ts` — `chunkNetflixCsv`, `uploadNetflixCsv`, `formatImportSummary`, and the `NetflixImportResult` / `NetflixImportOutcome` types.
- **Create** `src/recc/netflixImport.test.ts` — unit tests for the above.
- **Modify** `src/cli/args.ts` — add the `import-netflix` command + `HELP_TEXT` line.
- **Modify** `src/cli/args.test.ts` — parser tests for `import-netflix`.
- **Create** `src/cli/runImportNetflix.ts` — headless runner (read file → upload → print).
- **Modify** `src/index.tsx` — dispatch the `import-netflix` command.
- **Create** `src/ui/components/NetflixImportPrompt.tsx` — the TUI overlay (intro → path → progress/result) and the shared `NetflixImportView` type.
- **Modify** `src/ui/components/Accounts.tsx` — `i` key + `onImportRecc` prop, gated on reccd being linked.
- **Modify** `src/ui/keymap.ts` — Accounts help entry + footer hint.
- **Modify** `src/ui/App.tsx` — import overlay state, runner, wiring, and overlay-guard lists.
- **Modify** `README.md` — document the feature (both surfaces).

---

## Task 1: Core — `chunkNetflixCsv`

Splits the CSV into `<budget`-byte chunks, prepending the `Title,Date` header to every chunk (reccd skips line 0 as the header). Pure function, so the budget is injectable to keep tests tiny.

**Files:**
- Create: `src/recc/netflixImport.ts`
- Test: `src/recc/netflixImport.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/recc/netflixImport.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { chunkNetflixCsv } from "./netflixImport.js";

const HEADER = "Title,Date";

describe("chunkNetflixCsv", () => {
  it("returns one chunk containing the header and all rows when under budget", () => {
    const csv = `${HEADER}\nThe Matrix,1/2/20\nHeat,3/4/21`;
    const chunks = chunkNetflixCsv(csv);
    expect(chunks).toEqual([`${HEADER}\nThe Matrix,1/2/20\nHeat,3/4/21`]);
  });

  it("returns [] when there are no data rows", () => {
    expect(chunkNetflixCsv(HEADER)).toEqual([]);
    expect(chunkNetflixCsv(`${HEADER}\n`)).toEqual([]);
  });

  it("skips blank data lines", () => {
    const csv = `${HEADER}\nThe Matrix,1/2/20\n\n\nHeat,3/4/21\n`;
    expect(chunkNetflixCsv(csv)).toEqual([`${HEADER}\nThe Matrix,1/2/20\nHeat,3/4/21`]);
  });

  it("splits into multiple chunks that each re-include the header, honoring the byte budget", () => {
    const rows = ["A,1/1/20", "B,2/2/20", "C,3/3/20", "D,4/4/20"];
    const csv = `${HEADER}\n${rows.join("\n")}`;
    // Budget only fits the header (~11 bytes) + ~2 rows (~9 bytes each) per chunk.
    const chunks = chunkNetflixCsv(csv, 30);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.startsWith(`${HEADER}\n`)).toBe(true);
    // Every original row appears exactly once across all chunks.
    const seen = chunks.flatMap((c) => c.split("\n").slice(1));
    expect(seen.sort()).toEqual([...rows].sort());
  });

  it("emits an over-budget row as its own single chunk rather than dropping it", () => {
    const big = `${"X".repeat(100)},1/1/20`;
    const csv = `${HEADER}\nsmall,1/1/20\n${big}`;
    const chunks = chunkNetflixCsv(csv, 30);
    expect(chunks.some((c) => c.includes(big))).toBe(true);
  });

  it("tolerates CRLF line endings", () => {
    const csv = `${HEADER}\r\nThe Matrix,1/2/20\r\nHeat,3/4/21\r\n`;
    expect(chunkNetflixCsv(csv)).toEqual([`${HEADER}\nThe Matrix,1/2/20\nHeat,3/4/21`]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/recc/netflixImport.test.ts`
Expected: FAIL — `chunkNetflixCsv` is not exported / module missing.

- [ ] **Step 3: Write minimal implementation**

Create `src/recc/netflixImport.ts`:

```ts
import { log } from "../util/logger";

// ~900 KiB of CSV text per chunk, comfortably under reccd's 1 MiB multipart
// cap once the boundary/part-header overhead is added.
export const CHUNK_BUDGET_BYTES = 900 * 1024;

// Splits a Netflix viewing-activity CSV into chunks whose serialized size stays
// under `budgetBytes`. Line 0 is the `Title,Date` header, which reccd skips; it
// is prepended to every chunk so each upload is a valid standalone CSV. A single
// row larger than the budget is emitted alone rather than dropped.
export function chunkNetflixCsv(csvText: string, budgetBytes = CHUNK_BUDGET_BYTES): string[] {
  const lines = csvText.split(/\r?\n/);
  const header = lines[0] ?? "";
  const rows = lines.slice(1).filter((r) => r.trim() !== "");
  if (rows.length === 0) return [];

  const headerBytes = Buffer.byteLength(`${header}\n`, "utf8");
  const chunks: string[] = [];
  let current: string[] = [];
  let size = headerBytes;

  for (const row of rows) {
    const rowBytes = Buffer.byteLength(`${row}\n`, "utf8");
    if (current.length > 0 && size + rowBytes > budgetBytes) {
      chunks.push([header, ...current].join("\n"));
      current = [];
      size = headerBytes;
    }
    current.push(row);
    size += rowBytes;
  }
  if (current.length > 0) chunks.push([header, ...current].join("\n"));

  const oversized = chunks.filter((c) => Buffer.byteLength(c, "utf8") > budgetBytes).length;
  if (oversized > 0) {
    log.debug(`netflix import: ${oversized} chunk(s) exceed the ${budgetBytes}B budget (single oversized rows)`);
  }
  return chunks;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/recc/netflixImport.test.ts`
Expected: PASS (all `chunkNetflixCsv` tests).

- [ ] **Step 5: Commit**

```bash
git add src/recc/netflixImport.ts src/recc/netflixImport.test.ts
git commit -m "feat(recc): chunk Netflix CSV under reccd's upload cap"
```

---

## Task 2: Core — `formatImportSummary`

A pure one-liner used by both the CLI and the TUI, so it lives in the core module and is unit-tested once.

**Files:**
- Modify: `src/recc/netflixImport.ts`
- Test: `src/recc/netflixImport.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/recc/netflixImport.test.ts`:

```ts
import { formatImportSummary } from "./netflixImport.js";

describe("formatImportSummary", () => {
  it("renders imported, matched and unmatched counts", () => {
    expect(
      formatImportSummary({ imported: 342, resolved: 128, unresolved: 214, unresolvedTitles: [], chunks: 1 }),
    ).toBe("Imported 342 · 128 matched · 214 unmatched");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/recc/netflixImport.test.ts -t formatImportSummary`
Expected: FAIL — `formatImportSummary` not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `src/recc/netflixImport.ts` (types first, then the function):

```ts
export interface NetflixImportResult {
  imported: number;
  resolved: number;
  unresolved: number;
  unresolvedTitles: string[];
  chunks: number;
}

export function formatImportSummary(r: NetflixImportResult): string {
  return `Imported ${r.imported} · ${r.resolved} matched · ${r.unresolved} unmatched`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/recc/netflixImport.test.ts -t formatImportSummary`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/recc/netflixImport.ts src/recc/netflixImport.test.ts
git commit -m "feat(recc): add Netflix import summary formatter"
```

---

## Task 3: Core — `uploadNetflixCsv`

Uploads each chunk as `multipart/form-data` to `POST {reccUrl}/import/netflix` with bearer auth, aggregates the per-chunk results (summing counts, de-duplicating `unresolvedTitles`), reports progress, and surfaces errors as a discriminated outcome (mirroring `fetchRecommendations`).

**Files:**
- Modify: `src/recc/netflixImport.ts`
- Test: `src/recc/netflixImport.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/recc/netflixImport.test.ts`:

```ts
import { vi } from "vitest";
import { uploadNetflixCsv } from "./netflixImport.js";
import type { FetchImpl } from "../util/net";

function jsonRes(status: number, body: unknown = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const CONFIG = { reccUrl: "http://host:4100", reccToken: "tok" };
const CSV = "Title,Date\nThe Matrix,1/2/20\nHeat,3/4/21";

describe("uploadNetflixCsv", () => {
  it("POSTs multipart to /import/netflix with a bearer token and returns the aggregated result", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonRes(202, { imported: 2, resolved: 1, unresolved: 1, unresolvedTitles: ["Heat"] }));
    const outcome = await uploadNetflixCsv(CONFIG, CSV, { fetchImpl: fetchImpl as unknown as FetchImpl });

    expect(outcome).toEqual({
      ok: true,
      result: { imported: 2, resolved: 1, unresolved: 1, unresolvedTitles: ["Heat"], chunks: 1 },
    });
    const [url, init] = fetchImpl.mock.calls[0] as [string, { method: string; headers: Record<string, string>; body: FormData }];
    expect(url).toBe("http://host:4100/import/netflix");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Bearer tok");
    expect(init.body).toBeInstanceOf(FormData);
    const file = init.body.get("file") as Blob;
    expect(await file.text()).toContain("Title,Date");
  });

  it("aggregates counts and de-duplicates unresolved titles across chunks", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(202, { imported: 1, resolved: 1, unresolved: 1, unresolvedTitles: ["Heat"] }))
      .mockResolvedValueOnce(jsonRes(202, { imported: 1, resolved: 0, unresolved: 2, unresolvedTitles: ["Heat", "Dune"] }));
    // Tiny budget forces two chunks.
    const outcome = await uploadNetflixCsv(CONFIG, CSV, {
      fetchImpl: fetchImpl as unknown as FetchImpl,
      budgetBytes: 25,
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.imported).toBe(2);
      expect(outcome.result.unresolved).toBe(3);
      expect(outcome.result.unresolvedTitles).toEqual(["Heat", "Dune"]);
      expect(outcome.result.chunks).toBe(2);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("reports progress per chunk", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(202, { imported: 1, resolved: 1, unresolved: 0, unresolvedTitles: [] }));
    const seen: Array<[number, number]> = [];
    await uploadNetflixCsv(CONFIG, CSV, {
      fetchImpl: fetchImpl as unknown as FetchImpl,
      budgetBytes: 25,
      onProgress: (done, total) => seen.push([done, total]),
    });
    expect(seen).toEqual([[1, 2], [2, 2]]);
  });

  it("returns a not-linked error when reccUrl is missing", async () => {
    const outcome = await uploadNetflixCsv({ reccToken: "t" }, CSV);
    expect(outcome).toEqual({ ok: false, error: "reccd is not linked — set it up in Accounts first" });
  });

  it("returns a no-rows error for a header-only CSV", async () => {
    const fetchImpl = vi.fn();
    const outcome = await uploadNetflixCsv(CONFIG, "Title,Date", { fetchImpl: fetchImpl as unknown as FetchImpl });
    expect(outcome).toEqual({ ok: false, error: "no rows found in the CSV" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps 401 to a token error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(401, { error: "unauthorized" }));
    const outcome = await uploadNetflixCsv(CONFIG, CSV, { fetchImpl: fetchImpl as unknown as FetchImpl });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBe("reccd rejected the token — check reccToken");
  });

  it("reports which chunk failed and includes the partial result so far", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(202, { imported: 1, resolved: 1, unresolved: 0, unresolvedTitles: [] }))
      .mockRejectedValueOnce(new Error("ECONNRESET"));
    const outcome = await uploadNetflixCsv(CONFIG, CSV, {
      fetchImpl: fetchImpl as unknown as FetchImpl,
      budgetBytes: 25,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain("chunk 2/2");
      expect(outcome.partial?.imported).toBe(1);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/recc/netflixImport.test.ts -t uploadNetflixCsv`
Expected: FAIL — `uploadNetflixCsv` not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `src/recc/netflixImport.ts` (add the `FetchImpl` / `ReccClientConfig` imports at the top alongside the existing `log` import):

```ts
import type { FetchImpl } from "../util/net";
import type { ReccClientConfig } from "./client";
```

Then append:

```ts
export type NetflixImportOutcome =
  | { ok: true; result: NetflixImportResult }
  | { ok: false; error: string; partial?: NetflixImportResult };

export interface UploadNetflixOptions {
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
  budgetBytes?: number;
  onProgress?: (done: number, total: number) => void;
}

interface RawImportResponse {
  imported?: number;
  resolved?: number;
  unresolved?: number;
  unresolvedTitles?: string[];
}

// Uploads a Netflix CSV to reccd, one <1 MiB multipart chunk at a time. Unlike
// the fire-and-forget postEvent, the user is waiting on this, so failures are
// surfaced as a discriminated outcome (with any partial progress) rather than
// swallowed. reccd's import is idempotent, so a chunk boundary that overlaps a
// previous upload updates in place instead of double-counting.
export async function uploadNetflixCsv(
  config: ReccClientConfig,
  csvText: string,
  opts: UploadNetflixOptions = {},
): Promise<NetflixImportOutcome> {
  if (!config.reccUrl) return { ok: false, error: "reccd is not linked — set it up in Accounts first" };
  const fetchImpl = opts.fetchImpl ?? (fetch as FetchImpl);
  const chunks = chunkNetflixCsv(csvText, opts.budgetBytes);
  if (chunks.length === 0) return { ok: false, error: "no rows found in the CSV" };

  const agg: NetflixImportResult = {
    imported: 0,
    resolved: 0,
    unresolved: 0,
    unresolvedTitles: [],
    chunks: chunks.length,
  };
  const seen = new Set<string>();

  for (let i = 0; i < chunks.length; i++) {
    const where = `chunk ${i + 1}/${chunks.length}`;
    const form = new FormData();
    form.set("file", new Blob([chunks[i]!], { type: "text/csv" }), "netflix.csv");

    let res: Response;
    try {
      res = await fetchImpl(`${config.reccUrl}/import/netflix`, {
        method: "POST",
        headers: { authorization: `Bearer ${config.reccToken ?? ""}` },
        body: form, // FormData is a valid RequestInit["body"]; no cast (repo tsconfig has no DOM lib, so `BodyInit` isn't global)
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30000),
      });
    } catch (err) {
      log.debug(`netflix import: ${where} failed to reach ${config.reccUrl}: ${err instanceof Error ? err.message : String(err)}`);
      return { ok: false, error: `couldn't reach reccd (${where})`, partial: agg };
    }

    if (res.status === 401) return { ok: false, error: "reccd rejected the token — check reccToken", partial: agg };
    if (!res.ok) return { ok: false, error: `import failed (HTTP ${res.status}, ${where})`, partial: agg };

    const body = (await res.json().catch(() => ({}))) as RawImportResponse;
    agg.imported += body.imported ?? 0;
    agg.resolved += body.resolved ?? 0;
    agg.unresolved += body.unresolved ?? 0;
    for (const t of body.unresolvedTitles ?? []) {
      if (!seen.has(t)) {
        seen.add(t);
        agg.unresolvedTitles.push(t);
      }
    }
    opts.onProgress?.(i + 1, chunks.length);
  }

  return { ok: true, result: agg };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/recc/netflixImport.test.ts`
Expected: PASS (all core tests).

- [ ] **Step 5: Commit**

```bash
git add src/recc/netflixImport.ts src/recc/netflixImport.test.ts
git commit -m "feat(recc): upload Netflix CSV to reccd with chunked multipart"
```

---

## Task 4: CLI — parse `import-netflix`

Add the `import-netflix <file>` command to the parser and help text.

**Files:**
- Modify: `src/cli/args.ts` (union at `:5-30`, dispatch in `parseCliArgs`, `HELP_TEXT` at `:127`)
- Test: `src/cli/args.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/cli/args.test.ts` (inside the `describe("parseCliArgs", ...)` block):

```ts
  it("parses import-netflix with a file path", () => {
    expect(parseCliArgs(["import-netflix", "/home/me/NetflixViewingActivity.csv"])).toEqual({
      kind: "import-netflix",
      file: "/home/me/NetflixViewingActivity.csv",
    });
  });
  it("rejects import-netflix with no file", () => {
    expect(parseCliArgs(["import-netflix"])).toEqual({
      kind: "invalid",
      arg: "import-netflix (missing file)",
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/args.test.ts -t import-netflix`
Expected: FAIL — parser returns `{ kind: "invalid", arg: "import-netflix" }` for the first case.

- [ ] **Step 3: Write minimal implementation**

In `src/cli/args.ts`, add to the `CliCommand` union (after the `update` member at `:29`):

```ts
  | { kind: "import-netflix"; file: string }
```

In `parseCliArgs`, add this branch just after the `if (a === "update")` line (`:80`):

```ts
  if (a === "import-netflix") {
    const file = args[1];
    if (!file) return { kind: "invalid", arg: "import-netflix (missing file)" };
    return { kind: "import-netflix", file };
  }
```

In `HELP_TEXT`, add a usage line after the `torlnk update` line (`:137`):

```
  torlnk import-netflix <csv>  send a Netflix "viewing activity" CSV to reccd
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/cli/args.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/args.ts src/cli/args.test.ts
git commit -m "feat(cli): parse the import-netflix subcommand"
```

---

## Task 5: CLI — runner + dispatch

The headless runner reads the file, calls the core, prints a summary and the full unmatched-title list, and exits non-zero on error.

**Files:**
- Create: `src/cli/runImportNetflix.ts`
- Modify: `src/index.tsx` (echo list at `:33`, dispatch chain `:50-78`)

- [ ] **Step 1: Create the runner**

Create `src/cli/runImportNetflix.ts`:

```ts
import { readFile } from "node:fs/promises";
import { loadConfig, resolveReccConfig } from "../config/config";
import { uploadNetflixCsv, formatImportSummary } from "../recc/netflixImport";

// Headless `torlnk import-netflix <file>`. Throws on any failure so index.tsx's
// failHeadless prints the message and exits non-zero.
export async function runImportNetflix(filePath: string): Promise<void> {
  const config = await loadConfig();
  const reccConfig = resolveReccConfig(config);
  if (!reccConfig.reccUrl) {
    throw new Error(
      "reccd is not linked. Set TORLINK_RECC_URL / TORLINK_RECC_TOKEN, or configure it in the TUI Accounts pane.",
    );
  }

  let csvText: string;
  try {
    csvText = await readFile(filePath, "utf8");
  } catch {
    throw new Error(`could not read file: ${filePath}`);
  }

  const outcome = await uploadNetflixCsv(reccConfig, csvText, {
    onProgress: (done, total) => {
      if (total > 1) console.log(`uploading chunk ${done}/${total}…`);
    },
  });

  if (!outcome.ok) {
    if (outcome.partial) console.log(`${formatImportSummary(outcome.partial)} (partial)`);
    throw new Error(outcome.error);
  }

  console.log(formatImportSummary(outcome.result));
  const unmatched = outcome.result.unresolvedTitles;
  if (unmatched.length > 0) {
    console.log(`\nunmatched titles (${unmatched.length}):`);
    for (const title of unmatched) console.log(`  ${title}`);
  }
}
```

- [ ] **Step 2: Wire the dispatch in `src/index.tsx`**

Add `import-netflix` to the `echo` list at `:33`:

```ts
  echo:
    cmd.kind === "update" ||
    cmd.kind === "watch" ||
    cmd.kind === "serve" ||
    cmd.kind === "files" ||
    cmd.kind === "import-netflix",
```

Add a dispatch branch after the `files` branch (`:77`), before the final `} else {`:

```ts
} else if (cmd.kind === "import-netflix") {
  void import("./cli/runImportNetflix").then(({ runImportNetflix }) =>
    runImportNetflix(cmd.file)
      .then(() => process.exit(0))
      .catch(failHeadless),
  );
}
```

- [ ] **Step 3: Verify it typechecks**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Smoke-test the runner end-to-end**

Run (no reccd needed — this exercises the not-linked guard and exit code):

```bash
env -u TORLINK_RECC_URL -u TORLINK_RECC_TOKEN npx tsx src/index.tsx import-netflix /tmp/does-not-exist.csv; echo "exit=$?"
```

Expected: prints a "reccd is not linked" message and `exit=1`. (If reccd *is* configured locally, it instead prints "could not read file: …" and `exit=1` — both are correct non-zero exits.)

- [ ] **Step 5: Commit**

```bash
git add src/cli/runImportNetflix.ts src/index.tsx
git commit -m "feat(cli): run headless Netflix CSV import"
```

---

## Task 6: TUI — `NetflixImportPrompt` component

A self-contained overlay with three phases: an **intro/privacy** screen, a **path** input (drag-to-paste works because terminals paste the dropped file's path), and a **progress → result** view (summary + scrollable unmatched list). Presentational: the parent (`App.tsx`) owns the async upload and feeds `state` back in. Modeled on `ReccdPrompt.tsx`.

**Files:**
- Create: `src/ui/components/NetflixImportPrompt.tsx`

- [ ] **Step 1: Create the component**

Create `src/ui/components/NetflixImportPrompt.tsx`:

```tsx
import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { TextField } from "./TextField";
import { Panel } from "./Panel";
import { COLOR, ICON } from "../theme";
import { formatImportSummary, type NetflixImportResult } from "../../recc/netflixImport";

export interface NetflixImportView {
  phase: "form" | "running" | "done";
  progress?: { done: number; total: number };
  result?: NetflixImportResult;
  error?: string;
}

interface NetflixImportPromptProps {
  width: number;
  state: NetflixImportView;
  onSubmit: (path: string) => void;
  onClose: () => void;
}

// How many unmatched titles to show at once; the rest are summarized as "+N more".
const MAX_VISIBLE_UNMATCHED = 8;

export function NetflixImportPrompt({ width, state, onSubmit, onClose }: NetflixImportPromptProps) {
  const [screen, setScreen] = useState<"intro" | "path">("intro");
  const [pathVal, setPathVal] = useState("");

  useInput((_input, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    // Advance the intro screen with Enter. On the path screen the TextField owns
    // Enter (it fires onSubmit), so we do nothing here.
    if (state.phase === "form" && screen === "intro" && key.return) setScreen("path");
    // On the result screen, Enter closes the overlay.
    if (state.phase === "done" && key.return) onClose();
  });

  if (state.phase === "running") {
    const p = state.progress;
    const label = p && p.total > 1 ? `Uploading chunk ${p.done}/${p.total}…` : "Uploading…";
    return (
      <Box flexDirection="column" width={width}>
        <Panel title="import Netflix history" width={width} focused height={3}>
          <Text>
            <Text color={COLOR.accent}>{`${ICON.dot} `}</Text>
            {label}
          </Text>
        </Panel>
      </Box>
    );
  }

  if (state.phase === "done") {
    const unmatched = state.result?.unresolvedTitles ?? [];
    const visible = unmatched.slice(0, MAX_VISIBLE_UNMATCHED);
    const extra = unmatched.length - visible.length;
    return (
      <Box flexDirection="column" width={width}>
        <Panel title="import Netflix history" width={width} focused height={Math.min(14, 4 + visible.length)}>
          {state.error ? (
            <Text color={COLOR.warn}>{`${ICON.warn} ${state.error}`}</Text>
          ) : null}
          {state.result ? (
            <Text>
              <Text color={COLOR.good}>{`${ICON.done} `}</Text>
              {formatImportSummary(state.result)}
              {state.error ? <Text dimColor> (partial)</Text> : null}
            </Text>
          ) : null}
          {visible.length > 0 ? (
            <Box flexDirection="column" marginTop={1}>
              <Text dimColor>unmatched titles:</Text>
              {visible.map((t, i) => (
                <Text key={`${i}-${t}`} dimColor>{`  ${t}`}</Text>
              ))}
              {extra > 0 ? <Text dimColor>{`  +${extra} more`}</Text> : null}
            </Box>
          ) : null}
        </Panel>
        <Box marginTop={1}>
          <Text color={COLOR.alt}>↵ / esc</Text>
          <Text dimColor> close</Text>
        </Box>
      </Box>
    );
  }

  // phase === "form"
  if (screen === "intro") {
    return (
      <Box flexDirection="column" width={width}>
        <Panel title="import Netflix history" width={width} focused height={9}>
          <Text>Import what you've watched on Netflix so reccd can tailor recommendations.</Text>
          <Box marginTop={1}>
            <Text dimColor>
              Your privacy: torlink doesn't care what you watch. Titles are sent only to your own
              reccd server to seed recommendations — nothing else is done with them, and nothing
              leaves your setup.
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>
              Get the file: Netflix → Account → Profile &amp; Parental Controls → Viewing activity →
              Download all. You'll get a CSV.
            </Text>
          </Box>
        </Panel>
        <Box marginTop={1}>
          <Text color={COLOR.alt}>↵</Text>
          <Text dimColor> continue</Text>
          <Text dimColor>{`     ${ICON.dot}     `}</Text>
          <Text color={COLOR.alt}>esc</Text>
          <Text dimColor> cancel</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={width}>
      <Panel title="import Netflix history" width={width} focused height={4}>
        <Text dimColor>Path to your Netflix CSV (tip: drag the file onto the terminal to paste it):</Text>
        <Box marginTop={1}>
          <Text color={COLOR.accent}>{`${ICON.pointer} `}</Text>
          <Box flexGrow={1} minWidth={0}>
            <TextField
              placeholder="~/Downloads/NetflixViewingActivity.csv"
              onChange={setPathVal}
              onSubmit={() => {
                const trimmed = pathVal.trim();
                if (trimmed) onSubmit(trimmed);
              }}
            />
          </Box>
        </Box>
      </Panel>
      <Box marginTop={1}>
        <Text color={COLOR.alt}>↵</Text>
        <Text dimColor> import</Text>
        <Text dimColor>{`     ${ICON.dot}     `}</Text>
        <Text color={COLOR.alt}>esc</Text>
        <Text dimColor> cancel</Text>
      </Box>
    </Box>
  );
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `npm run typecheck`
Expected: no errors. (Confirms `TextField`, `Panel`, `COLOR`/`ICON`, and the core types all resolve.)

- [ ] **Step 3: Commit**

```bash
git add src/ui/components/NetflixImportPrompt.tsx
git commit -m "feat(ui): add Netflix import prompt overlay"
```

---

## Task 7: TUI — Accounts `i` key

Add an import action to the reccd row, shown only when reccd is linked (the RCD row's `signedIn`).

**Files:**
- Modify: `src/ui/components/Accounts.tsx` (props `:11-27`, `Row` `:29-45`, RCD row `:97-111`, `useInput` `:116-124`, actions render `:158-173`)

- [ ] **Step 1: Add the prop and Row fields**

In the `AccountsProps` interface, add after `onSignOutRecc` (`:26`):

```ts
  onImportRecc: () => void;
```

In the `Row` interface, add after `onSignOut` (`:44`):

```ts
  importable?: boolean;
  onImport?: () => void;
```

In the function parameter destructuring, add after `onSignOutRecc` (`:60`):

```ts
  onImportRecc,
```

- [ ] **Step 2: Mark the RCD row importable**

In the RCD row object (`:97-111`), add these two fields after `onSignOut: onSignOutRecc,`:

```ts
      importable: true,
      onImport: onImportRecc,
```

- [ ] **Step 3: Handle the `i` key**

In `useInput` (`:116-124`), add a branch after the `x` handler (`:121`):

```ts
      else if (input === "i" && rows[clamped]!.importable && rows[clamped]!.signedIn) rows[clamped]!.onImport?.();
```

- [ ] **Step 4: Show the hint on the RCD row**

In the signed-in actions block (`:159-166`), replace the `x` sign-out `Text` group with one that appends the import hint when the row is importable. Change:

```tsx
                    <Text color={COLOR.alt}>x</Text>
                    <Text dimColor>{` ${r.verbSignOut}`}</Text>
                  </Text>
```

to:

```tsx
                    <Text color={COLOR.alt}>x</Text>
                    <Text dimColor>{` ${r.verbSignOut}`}</Text>
                    {r.importable ? (
                      <Text>
                        <Text dimColor>{`  ${ICON.dot}  `}</Text>
                        <Text color={COLOR.alt}>i</Text>
                        <Text dimColor> import</Text>
                      </Text>
                    ) : null}
                  </Text>
```

- [ ] **Step 5: Verify it typechecks**

Run: `npm run typecheck`
Expected: errors reported at the `<Accounts .../>` call site in `App.tsx` about the missing `onImportRecc` prop — that is expected and fixed in Task 9. If there are any *other* errors in `Accounts.tsx` itself, fix them.

- [ ] **Step 6: Commit**

```bash
git add src/ui/components/Accounts.tsx
git commit -m "feat(ui): add import action to the reccd account row"
```

---

## Task 8: TUI — keymap help + footer

**Files:**
- Modify: `src/ui/keymap.ts` (Accounts help group `:30-37`, accounts footer branch `:124-132`)

- [ ] **Step 1: Add the help-sheet entry**

In the `"Accounts"` `HELP_GROUPS` entry, add after the `x` / "Sign out" hint (`:35`):

```ts
      { keys: "i", label: "Import Netflix history (reccd)" },
```

- [ ] **Step 2: Add the footer hint**

In `footerHints`, in the `section === "accounts"` branch (`:124-132`), add after the `x` / "Sign out" hint:

```ts
      { keys: "i", label: "Import" },
```

- [ ] **Step 3: Verify it typechecks**

Run: `npm run typecheck`
Expected: no *new* errors from `keymap.ts` (the `App.tsx` `onImportRecc` error from Task 7 may still show until Task 9).

- [ ] **Step 4: Commit**

```bash
git add src/ui/keymap.ts
git commit -m "feat(ui): document the Netflix import key in help and footer"
```

---

## Task 9: TUI — wire the overlay into App

Add the overlay state + runner, render the prompt, pass `onImportRecc` to `Accounts`, and add `importingNetflix` to the overlay-guard expressions so it owns input and hides the main content/footer while open.

**Files:**
- Modify: `src/ui/App.tsx` (imports `:78-89`, state `:166`, callbacks near `:671-699`, input guard `:1501`, render-guard `:1401`, overlay render near `:1681-1692`, guards `:1996` & `:2066`, `<Accounts>` `:2026-2041`)

- [ ] **Step 1: Add imports**

Near the other component imports (after the `ReccdPrompt` import at `:82`), add:

```ts
import { NetflixImportPrompt, type NetflixImportView } from "./components/NetflixImportPrompt";
```

Add the core function import (next to the existing `resolveReccConfig` import group; add to the recc client import or a new line):

```ts
import { uploadNetflixCsv } from "../recc/netflixImport";
```

- [ ] **Step 2: Add overlay state**

After `const [editingRecc, setEditingRecc] = useState(false);` (`:166`), add:

```ts
  const [importingNetflix, setImportingNetflix] = useState(false);
  const [netflixImport, setNetflixImport] = useState<NetflixImportView>({ phase: "form" });
```

- [ ] **Step 3: Add open/close/run callbacks**

After the `clearReccConfig` callback (`:699`), add:

```ts
  const closeNetflixImport = useCallback(() => setImportingNetflix(false), []);

  const openNetflixImport = useCallback(() => {
    setView("browser");
    setShowHelp(false);
    setNetflixImport({ phase: "form" });
    setImportingNetflix(true);
  }, []);

  const runNetflixImport = useCallback(
    (path: string) => {
      setNetflixImport({ phase: "running", progress: { done: 0, total: 0 } });
      void (async () => {
        let csvText: string;
        try {
          csvText = await fs.readFile(path, "utf8");
        } catch {
          setNetflixImport({ phase: "done", error: `Couldn't read ${path}` });
          return;
        }
        const outcome = await uploadNetflixCsv(resolveReccConfig(config), csvText, {
          onProgress: (done, total) => setNetflixImport({ phase: "running", progress: { done, total } }),
        });
        if (outcome.ok) {
          setNetflixImport({ phase: "done", result: outcome.result });
        } else {
          setNetflixImport({ phase: "done", error: outcome.error, result: outcome.partial });
        }
      })();
    },
    [config],
  );
```

Note: `fs`, `useCallback`, `setView`, and `setShowHelp` are already imported/defined in `App.tsx` (used by `openReccPrompt` at `:673-678` and elsewhere). If the file uses `fs` as `import { promises as fs }`, keep that; verify `fs.readFile(path, "utf8")` matches the existing usage at `:706` (`fs.mkdir`).

- [ ] **Step 4: Block global input while the overlay is open**

Next to `if (editingRecc) return; // the reccd prompt owns input` (`:1501`), add on the following line:

```ts
      if (importingNetflix) return; // the Netflix import prompt owns input
```

- [ ] **Step 5: Add to the three overlay-guard expressions**

Each of these lines lists the open overlays; append `|| importingNetflix` to each:

- The render/scroll guard at `:1401` (the boolean starting `showHelp || editingFolder || editingToken || editingRecc || ...`).
- The guard at `:1996` (same shape).
- The footer-hide guard at `:2066` (same shape).

For each, change the trailing `... || keepPrompt || ratePrompt` / `... || keepPrompt` to also include `|| importingNetflix`. Example for `:1401`:

```ts
        showHelp || editingFolder || editingToken || editingRecc || editingPlayer || editingSources || editingDns || editingRutracker || editingTrackers || editingLimits || editingVpn || pendingP2P || pendingDownload || fileSelection || streamFiles || preparing || torrentPrompt || keepPrompt || ratePrompt || importingNetflix
```

- [ ] **Step 6: Render the overlay**

After the `editingRecc` overlay block (ends at `:1692` with `) : null}`), add:

```tsx
        {importingNetflix ? (
          <Box marginTop={1}>
            <NetflixImportPrompt
              width={Math.max(30, Math.min(cols - 4, 72))}
              state={netflixImport}
              onSubmit={runNetflixImport}
              onClose={closeNetflixImport}
            />
          </Box>
        ) : null}
```

- [ ] **Step 7: Pass the prop to Accounts**

In the `<Accounts ... />` element, after `onSignOutRecc={clearReccConfig}` (`:2041`), add:

```tsx
                onImportRecc={openNetflixImport}
```

- [ ] **Step 8: Verify it typechecks**

Run: `npm run typecheck`
Expected: no errors (the `onImportRecc` error from Task 7 is now resolved).

- [ ] **Step 9: Full test + lint**

Run: `npm test && npm run lint`
Expected: all tests pass, lint clean.

- [ ] **Step 10: Manual smoke-test the TUI**

Run: `npm run dev`, go to the **Accounts** pane (sidebar → Accounts). With reccd **not** configured, confirm the RCD row shows no `i import` hint. Configure reccd (Enter on RCD), then confirm the `i` hint appears; press `i` and confirm the intro/privacy screen shows, Enter advances to the path prompt, and Esc closes. (A real upload needs a running reccd; the not-linked path is covered by the CLI smoke-test.)

- [ ] **Step 11: Commit**

```bash
git add src/ui/App.tsx
git commit -m "feat(ui): wire Netflix import overlay into the app"
```

---

## Task 10: Docs

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document the feature**

Find the section of `README.md` that describes the reccd integration (search for "reccd" or "For You"). Add a short subsection describing both surfaces. Use this content:

```markdown
### Import your Netflix history

Seed reccd with what you've already watched on Netflix so its recommendations
know your taste.

1. In Netflix: Account → Profile & Parental Controls → Viewing activity →
   **Download all**. You'll get a CSV.
2. Import it, either way:
   - **In the app:** open the **Accounts** pane, select **reccd**, press **i**,
     and give it the CSV path (you can drag the file onto the terminal to paste
     the path).
   - **From the shell:** `torlnk import-netflix ~/Downloads/NetflixViewingActivity.csv`

torlink doesn't care what you watch — titles are sent only to your own reccd
server to seed recommendations. Large exports are uploaded in batches
automatically, and re-importing the same file won't double-count anything.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document Netflix history import"
```

---

## Self-Review Notes

- **Spec coverage:** shared core (Tasks 1–3) ✓; TUI prompt gated on reccd linked (Tasks 6–9) ✓; instructions/privacy screen first (Task 6, intro screen) ✓; summary + scrollable unmatched list (Task 6, done screen) ✓; CLI subcommand (Tasks 4–5) ✓; auto-chunk under 1 MiB (Task 1) ✓; aggregation + dedupe (Task 3) ✓; error handling incl. 401/partial (Task 3, Task 5, Task 9) ✓; drag-to-paste (Task 6 path screen, no code needed) ✓; tests (Tasks 1–4) ✓; docs (Task 10) ✓.
- **Type consistency:** `NetflixImportResult`, `NetflixImportOutcome`, `NetflixImportView`, `uploadNetflixCsv`, `chunkNetflixCsv`, `formatImportSummary` used with identical names/shapes across core, CLI, and TUI tasks. `onImportRecc` prop name matches between `Accounts.tsx` (Task 7) and the `<Accounts>` call site (Task 9).
- **No placeholders:** every code step shows complete code; TUI tasks that can't be unit-tested (no Ink test harness in the repo, matching `ReccdPrompt` having no test) are verified by `npm run typecheck` + a manual smoke-test, consistent with existing patterns.
```
