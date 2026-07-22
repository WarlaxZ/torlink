# Netflix CSV Import → reccd

**Date:** 2026-07-22
**Status:** Design approved, pending spec review

## Summary

Let a torlink user import their Netflix "viewing activity" CSV into the reccd
recommendations engine, so reccd can seed better recommendations from what
they've actually watched. reccd exposes this as `POST /import/netflix`
(multipart file upload, bearer auth). torlink will offer it two ways behind a
single shared core: an interactive TUI flow in the Accounts pane, and a
headless CLI subcommand.

## Background

- reccd import endpoint: `POST {reccUrl}/import/netflix`
  - Auth: `Authorization: Bearer <reccToken>` (same token torlink already uses).
  - Body: `multipart/form-data` file upload; reccd reads the **first file**
    found (field name irrelevant).
  - File: Netflix's official "Viewing activity" CSV export
    (Account → Profile & Parental Controls → Viewing activity → Download all),
    with a `Title,Date` header and `M/D/YY` dates.
  - Response: `202 { imported, resolved, unresolved, unresolvedTitles }`.
  - **Size cap: 1 MiB** (`@fastify/multipart` default in reccd).
  - **Idempotent:** keyed on `(source="netflix-import", user_id, raw_name)`.
    Re-uploading overlapping rows updates in place rather than double-counting,
    which makes chunked uploads safe.

- torlink is a React + Ink TUI (TypeScript, ESM, Node ≥ 22). It already talks
  to reccd from `src/recc/` using an injectable `FetchImpl` and
  `resolveReccConfig()` for `reccUrl`/`reccToken`. It calls `POST /events`,
  `GET /recommendations`, and `GET /profile`. There is currently **no**
  multipart / `FormData` usage in the codebase; `undici` ^8 (which provides
  `FormData`/`Blob`) is already a dependency.

## Goals

- Import a Netflix CSV into reccd from both the TUI and the CLI.
- Work for heavy users whose export exceeds reccd's 1 MiB cap.
- Reassure users about privacy before they hand over their viewing history.
- Reuse existing reccd config/auth/HTTP patterns; no duplicated logic between
  the two frontends.

## Non-goals (YAGNI)

- Watched-folder / auto-import on launch.
- Local CSV validation beyond what reccd already performs.
- Raising reccd's upload limit (handled by chunking on torlink's side instead).
- Importing from services other than Netflix.

## Architecture

One shared core module, two thin frontends.

```
                       ┌─────────────────────────────┐
   TUI (Accounts pane) │                             │
   NetflixImportPrompt ─┤                             │
                        │  src/recc/netflixImport.ts  │──▶ POST /import/netflix
   CLI subcommand       │  uploadNetflixCsv(...)      │    (per chunk, Bearer)
   import-netflix ──────┤                             │
                        └─────────────────────────────┘
```

### Core — `src/recc/netflixImport.ts` (new)

Signature (illustrative):

```ts
interface NetflixImportResult {
  imported: number;
  resolved: number;
  unresolved: number;
  unresolvedTitles: string[]; // aggregated + de-duplicated across chunks
  chunks: number;
}

interface UploadOptions {
  onProgress?: (done: number, total: number) => void;
  fetchImpl?: FetchImpl; // defaults to global fetch, per existing client.ts pattern
}

async function uploadNetflixCsv(
  config: ReccClientConfig,
  csvText: string,
  opts?: UploadOptions,
): Promise<NetflixImportResult>;
```

Behavior:

- **Config/auth:** reuse `resolveReccConfig()` output (`reccUrl`, `reccToken`);
  send `Authorization: Bearer <reccToken>`. Same `FetchImpl` injection pattern
  as `client.ts` so it is unit-testable with a mock.
- **Chunking:**
  - Split `csvText` into lines. Treat line 0 as the `Title,Date` header.
  - Accumulate data rows into batches whose serialized CSV (header + rows)
    stays under a conservative **900 KiB** budget, leaving headroom for
    multipart boundary/part-header overhead beneath reccd's 1 MiB cap.
  - Prepend the header line to **every** chunk (reccd skips line 0 as header).
  - Line-based splitting mirrors reccd's own parser, which processes the CSV
    line by line.
- **Upload per chunk:** build an `undici` `FormData` with the chunk CSV as a
  `Blob`/file (e.g. filename `netflix.csv`, type `text/csv`) and
  `POST {reccUrl}/import/netflix`. Per-chunk timeout ~30s (imports are heavier
  than the 3s/10s used for events/recommendations).
- **Aggregate:** sum `imported`/`resolved`/`unresolved` across chunks; concat
  and de-duplicate `unresolvedTitles`; report `chunks` count.
- **Progress:** invoke `onProgress(done, total)` after each chunk.
- **Errors surfaced** (unlike fire-and-forget `postEvent`):
  - Missing/blank config → clear "reccd not linked" error.
  - `401` → "token rejected".
  - `413` → "file too large" (should not occur after chunking; kept as a
    guard).
  - Network/other failure → reported, including **which chunk** failed and how
    many chunks succeeded before it, so a partial import is understandable.

### TUI frontend

Entry point gated on reccd being **linked** (i.e. `reccToken` configured):

- Add an `i` key handler on the reccd (RCD) row in
  `src/ui/components/Accounts.tsx` (alongside Enter→manage, `x`→sign-out at
  `Accounts.tsx:116-124`). The key **and** its footer hint appear only when
  reccd is linked; with no reccd link there is no import affordance.
- New overlay component `src/ui/components/NetflixImportPrompt.tsx`, modeled on
  `ReccdPrompt.tsx` / `DownloadFilePrompt.tsx`. It has three states:
  1. **Instructions / privacy screen (shown first).** Explains how to download
     the Netflix viewing-activity CSV, and handles the obvious objection:
     torlink/reccd don't care *what* you watched — the data is used solely to
     seed your recommendations and nothing else is done with it. Enter →
     continue to the path prompt; Esc → cancel.
  2. **Path prompt.** Single text input for the CSV file path. Dragging the
     file onto the terminal pastes its path automatically (terminal behavior;
     no special code). Enter → start import; Esc → cancel.
  3. **Progress → result.** Shows "Uploading chunk N/M…" during upload, then a
     result view: a **summary line**
     (`Imported 342 • 128 matched • 214 unmatched`) plus a **scrollable list of
     unresolved titles**. Esc closes.
- Wire-ups:
  - `src/ui/App.tsx`: an `importingNetflix` overlay flag + render (near the
    existing `editingRecc`/`<ReccdPrompt>` block ~`App.tsx:1681-1692`), and add
    the flag to the footer-hide guard list at `App.tsx:2066`.
  - `src/ui/keymap.ts`: add the `i` binding in the `accounts` branch
    (`keymap.ts:124-132`, gated on reccd linked) and an entry in the "Accounts"
    help group (`keymap.ts:30-37`).

### CLI frontend

- New `CliCommand` kind in `src/cli/args.ts` (alongside `watch`/`serve`/`files`
  at `args.ts:5-30`): `torlnk import-netflix <file.csv>`. Add to `HELP_TEXT`
  (`args.ts:127`).
- Headless run: resolve config via `resolveReccConfig()` → read the file →
  `uploadNetflixCsv()` → print the summary line and the **full** unmatched-title
  list to stdout. Progress printed as simple lines.
- Exit codes: non-zero on error (reccd not linked / no token, file not found,
  network/upload failure); zero on success (even with unmatched titles).

## Data flow

```
CSV file
  → read to string (fs.readFile utf8)
  → split lines; header = line 0
  → chunk rows into <900 KiB batches (header prepended to each)
  → per chunk: undici FormData(Blob) → POST /import/netflix (Bearer)
  → parse 202 JSON { imported, resolved, unresolved, unresolvedTitles }
  → aggregate (sum counts, dedupe unresolvedTitles)
  → present (TUI summary + scrollable list, or CLI stdout)
```

## Error handling

| Condition | Core behavior | TUI | CLI |
|---|---|---|---|
| reccd not linked | throw clear error | import action not shown | error + non-zero exit |
| File not found / unreadable | (caller reads file) | show error in prompt | error + non-zero exit |
| `401` token rejected | throw "token rejected" | show in result view | error + non-zero exit |
| Network / chunk failure | throw with chunk index + partial success count | show partial result + error | print partial + non-zero exit |
| `413` (guard) | throw "file too large" | show error | error + non-zero exit |
| Success, some unmatched | normal result | summary + scrollable list | summary + full list, exit 0 |

## Testing

- **Chunker** (pure function) unit tests: header preserved on every chunk;
  batch sizing respects the 900 KiB budget; single-row, empty (header-only),
  and multi-chunk inputs; row that alone approaches the budget.
- **`uploadNetflixCsv`** unit tests with a mock `FetchImpl`: correct multipart
  body + `Authorization` header per chunk; multi-chunk aggregation and
  `unresolvedTitles` de-duplication; `401` handling; mid-sequence chunk failure
  reporting (which chunk, how many succeeded).
- **CLI** arg-parsing test for `import-netflix <file>` alongside existing
  `args.ts` tests.

## Open questions

None outstanding.
