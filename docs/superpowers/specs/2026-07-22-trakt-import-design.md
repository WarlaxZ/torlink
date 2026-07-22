# Trakt Import Design

**Date:** 2026-07-22
**Status:** Approved

## Summary

Add a Trakt import feature to torlink, mirroring the existing Netflix importer so
users can pull their trakt.tv watch history and ratings into reccd. Unlike the
Netflix path (a CSV file upload), the Trakt integration in reccd is an OAuth
**device-code** flow where reccd itself pulls from trakt.tv. torlink's job is to
orchestrate a 3-step handshake using its existing reccd bearer token — it never
touches the trakt.tv API or holds Trakt credentials directly.

## Background

reccd recently merged a Trakt integration (see `~/projects/reccd`, commits
`95fc9e7`..`8fda169`). It exposes three endpoints, all behind reccd's existing
Bearer-token auth, all with no request body:

- `POST /import/trakt/connect` → `200 { userCode, verificationUrl, interval, expiresIn }`.
  Starts a device-code flow. `502 { error: "trakt request failed" }` on Trakt failure.
- `POST /import/trakt/connect/status` → `200 { status: "pending" | "connected" | "expired" }`.
  Polls Trakt for token approval; on `connected` the token is stored server-side.
  `502` on Trakt failure.
- `POST /import/trakt` → `202 { imported, resolved, unresolved, unresolvedTitles }`.
  Pulls watched + rated movies/shows, maps to events, ingests. `400 { error: "not connected" }`
  if no stored token; `400 { error: "reconnect required" }` if token refresh fails;
  `502` on Trakt fetch failure.

If reccd has no Trakt app credentials configured (`RECCD_TRAKT_CLIENT_ID` /
`RECCD_TRAKT_CLIENT_SECRET`), **all three routes return `501 { error: "trakt not configured" }`**.

The final `/import/trakt` response deliberately matches the `/import/netflix`
response shape, so torlink can reuse its import-summary formatting.

## Goals

- Connect a user's Trakt account via the device-code flow from within torlink.
- Import (and re-import) Trakt watch history + ratings into reccd.
- Reuse the reccd connection + bearer token already configured in torlink; no new config.
- TUI and interactive CLI parity with the Netflix importer.

## Non-Goals (YAGNI)

- Disconnect / revoke UI.
- Incremental or scheduled/automatic sync.
- Storing any Trakt data locally in torlink.
- Direct trakt.tv API calls from torlink (all trakt.tv access is reccd-side).

## Architecture

Three layers, matching the Netflix importer's structure.

### 1. Shared core — `src/recc/traktImport.ts` (+ `traktImport.test.ts`)

Small, independently-testable functions over the existing `FetchImpl` seam
(`src/util/net`) and bearer auth, each taking `ReccClientConfig`
(`{ reccUrl?, reccToken? }`). All send `Authorization: Bearer ${config.reccToken ?? ""}`
(empty string on purpose, so a missing token yields a clean 401), all use a
`AbortSignal.timeout` like the Netflix core.

```ts
export interface TraktConnectInfo {
  userCode: string;
  verificationUrl: string;
  interval: number;   // seconds between status polls
  expiresIn: number;  // seconds until the device code expires
}

export type TraktStatus = "pending" | "connected" | "expired";

export interface TraktImportResult {
  imported: number;
  resolved: number;
  unresolved: number;
  unresolvedTitles: string[];
}

// Discriminated outcomes so callers can branch on the reccd error class.
export type TraktConnectOutcome =
  | { ok: true; info: TraktConnectInfo }
  | { ok: false; error: string; notConfigured?: boolean };

export type TraktStatusOutcome =
  | { ok: true; status: TraktStatus }
  | { ok: false; error: string; notConfigured?: boolean };

export type TraktImportOutcome =
  | { ok: true; result: TraktImportResult }
  | { ok: false; error: string; notConnected?: boolean; notConfigured?: boolean };

export function connectTrakt(config: ReccClientConfig, opts?: TraktRequestOptions): Promise<TraktConnectOutcome>;
export function checkTraktStatus(config: ReccClientConfig, opts?: TraktRequestOptions): Promise<TraktStatusOutcome>;
export function runTraktImport(config: ReccClientConfig, opts?: TraktRequestOptions): Promise<TraktImportOutcome>;
```

- `notConfigured` is set when reccd returns `501` — callers surface a friendly
  "Trakt is not enabled on your reccd server" message.
- `notConnected` is set when `/import/trakt` returns `400` (`not connected` or
  `reconnect required`) — this is the signal to drop into the connect phase.

The numeric fields are coerced defensively and `unresolvedTitles` de-duped, same
as the Netflix core.

### 2. Shared summary formatter

`formatImportSummary` currently lives in `src/recc/netflixImport.ts` and takes a
`NetflixImportResult`. Extract it (and the shared result field set) so both
importers use it. Options during implementation: either move it to a small shared
module (e.g. `src/recc/importSummary.ts`) and have `netflixImport.ts` re-export
for back-compat, or generalize its parameter type. The Trakt result is the
Netflix result minus `chunks`, so the formatter must not assume `chunks` exists.

### 3. Orchestration flow — "try import first, fall back to connect"

reccd persists the Trakt token, so after first authorization re-imports must not
re-prompt. Both the TUI and CLI use this sequence:

1. **Try import.** Call `runTraktImport`.
   - `ok` → show summary. Done. (Seamless re-import.)
   - `notConfigured` → show "Trakt not enabled on your reccd server". Done.
   - `notConnected` → go to step 2.
   - other error → show error. Done.
2. **Connect.** Call `connectTrakt`. Show `userCode` + `verificationUrl`
   ("Go to <verificationUrl> and enter <userCode>").
3. **Poll.** Call `checkTraktStatus` every `interval` seconds.
   - `pending` → keep polling until `expiresIn` elapses (then show "code expired, try again").
   - `expired` → show "code expired, try again".
   - `connected` → go to step 4.
4. **Import.** Call `runTraktImport` again → show summary.

## UI

### Chooser on the reccd row

Pressing `i` on the reccd row in the Accounts pane currently triggers Netflix
import directly. It will instead open a small **"Import from…"** chooser listing
**Netflix** and **Trakt**. Selecting Netflix routes to the existing
`NetflixImportPrompt`; selecting Trakt routes to the new `TraktImportPrompt`.

Implemented as a lightweight `ImportSourcePrompt` component (a two-item select),
rather than bloating either import prompt. Esc cancels the chooser.

### `src/ui/components/TraktImportPrompt.tsx` (+ `TraktImportPrompt.test.tsx`)

Modeled on `NetflixImportPrompt.tsx` (shared `Panel`, generation-guard against
stale async setState, scrollable unresolved-titles list capped like Netflix's
`MAX_VISIBLE_UNMATCHED`).

Phases:

```ts
export interface TraktImportView {
  phase: "checking" | "connect" | "running" | "done";
  connect?: { userCode: string; verificationUrl: string };
  progress?: { message: string };   // e.g. "Waiting for authorization…"
  result?: TraktImportResult;
  error?: string;
}
```

- `checking` — brief, while the initial `runTraktImport` probe runs.
- `connect` — shows the code + URL and a "waiting for authorization" spinner
  while polling.
- `running` — the post-connect import call.
- `done` — summary (reusing `formatImportSummary`) or error.

Esc closes at any point and supersedes in-flight polling via the generation ref.

### App wiring — `src/ui/App.tsx`

Mirror the Netflix state/handlers:
- State: `importingTrakt`, `traktImport` view, `traktImportGen` ref, plus chooser
  state (`importChooser` open/closed).
- Handlers: `openImportChooser` (bound to the reccd row's `onImport`),
  `openTraktImport`, `closeTraktImport`, `runTraktFlow` (implements the
  try-import→connect→poll→import sequence with the generation guard).
- Render: add the chooser + `TraktImportPrompt` to the render tree and to the
  "a prompt owns input" guard lists (alongside `importingNetflix`).

### Keymap — `src/ui/keymap.ts`

Update the `i` help entry label from "Import Netflix history (reccd)" to
"Import history (reccd)" since it now covers both sources.

## CLI — `src/cli/runImportTrakt.ts`

New `import-trakt` command (no arguments). `loadConfig` → `resolveReccConfig`;
error if reccd is not linked. Runs the same try-import→connect→poll→import flow:
prints progress + the code/URL to **stderr**, prints the final summary to
**stdout**. Interactive: it pauses (polling) while the user authorizes at the URL.

Wiring:
- `src/cli/args.ts` — add `import-trakt` to `CliCommand`, the parser, and `HELP_TEXT`.
- `src/index.tsx` — add to the command echo list and an `else if` dispatch branch
  that lazy-imports `runImportTrakt`, routing errors through `failHeadless`.

## Config

**No new config fields.** Trakt reuses the existing reccd URL + bearer token
(`reccUrl`/`reccToken`, env overrides `TORLINK_RECC_URL`/`TORLINK_RECC_TOKEN`,
resolved by `resolveReccConfig`). trakt.tv app credentials live server-side in
reccd. Docs will note that the reccd server must set `RECCD_TRAKT_CLIENT_ID` /
`RECCD_TRAKT_CLIENT_SECRET`, and that torlink surfaces a `501` from reccd as a
clear "Trakt not enabled on your reccd server" message.

## Error Handling

| Condition | reccd response | torlink behavior |
|---|---|---|
| Trakt not enabled on server | `501 not configured` | "Trakt not enabled on your reccd server" |
| Missing/bad reccd token | `401 unauthorized` | "reccd rejected the token" (same as Netflix) |
| Not yet connected | `400 not connected` | Enter connect phase |
| Token refresh failed | `400 reconnect required` | Enter connect phase (re-authorize) |
| Trakt upstream failure | `502 trakt request failed` | "Trakt request failed, try again" |
| Device code expired | status `expired` / `expiresIn` elapsed | "Code expired, try again" |

## Testing

- `src/recc/traktImport.test.ts` (injected `fetchImpl` via `vi.fn()`):
  connect / status / import happy paths; `501` → `notConfigured`; `400` → `notConnected`;
  `401` auth mapping; status transitions (`pending`→`connected`, `expired`);
  numeric coercion + unresolved-title dedupe on the import result.
- `src/cli/args.test.ts` — parse the `import-trakt` command.
- `src/ui/components/TraktImportPrompt.test.tsx` — the phase machine
  (checking→connect→running→done) and Esc/generation supersession.
- Update the shared-formatter tests if `formatImportSummary` moves.

## Files

New:
- `src/recc/traktImport.ts`, `src/recc/traktImport.test.ts`
- `src/cli/runImportTrakt.ts`
- `src/ui/components/TraktImportPrompt.tsx`, `src/ui/components/TraktImportPrompt.test.tsx`
- `src/ui/components/ImportSourcePrompt.tsx` (chooser)
- possibly `src/recc/importSummary.ts` (extracted formatter)

Modified:
- `src/recc/netflixImport.ts` (re-export / share the formatter)
- `src/cli/args.ts`, `src/index.tsx`
- `src/ui/App.tsx`, `src/ui/components/Accounts.tsx`, `src/ui/keymap.ts`
- README (Trakt section alongside Netflix)
