# TorBox support alongside Real-Debrid

Date: 2026-07-30

## Why

torlink resolves magnets through Real-Debrid. The community has largely moved to
TorBox, so torlink should support both — as two interchangeable debrid providers,
not as a primary and a bolt-on.

The work is mostly *not* the HTTP client. Real-Debrid's types have leaked out of
`src/integrations/`: `RdStatus` is imported by eight files across `src/ui/`,
`src/core/` and `src/web/`, and `resolveMagnet`/`isTransient` by
`src/core/streamSession.ts` and `src/download/queue.ts`. CLAUDE.md's rule applies
directly — when a second consumer appears, move the shared piece down rather than
copying it. Four bugs in this codebase came from copy-then-drift; this change is
where the fifth would be born.

## Decisions taken

| Question | Decision |
| --- | --- |
| Both tokens configured — which is used? | An explicit `debridProvider` preference. One provider active at a time; the other token stays on disk but idle. No silent fallback between providers. |
| Scope | Parity with today's RD use, plus TorBox's instant-availability (cached) check. No usenet/web-download support. |
| Cached marker on Real-Debrid | Absent. RD removed its instant-availability endpoint in 2024, so the marker only ever appears when TorBox is active. Nothing on screen implies RD results are uncached. |
| Persisted `via` enum | Collapse to `"debrid"` plus a separate `provider` field, migrating legacy `"realdebrid"` on read. |
| npm package name | Stays `torlnk-rd`. Only `package.json`'s description and keywords are updated; renaming a published package needs its own change. |

## Unverified assumptions

There is no TorBox account available for this change. The client is written to
the shapes documented in TorBox's official SDK docs
(`github.com/TorBox-App/torbox-sdk-js/documentation/`). Three details are
documented-but-untested and must be confirmed against a real token before this
is trusted in anger:

1. **`createtorrent` response field names.** The SDK documents
   `CreateTorrentOkResponse` as `{success, detail, error, data}` with `data`
   loosely typed. The implementation reads the torrent id defensively (accepting
   `torrent_id` or `id`) and fails with a clear error if neither is present,
   rather than guessing.
2. **`progress` scale.** Assumed 0–1 float, converted to 0–100 at the client
   boundary. If TorBox in fact reports 0–100, the conversion is one line and one
   test.
3. **Free-plan capability.** `plan: 0` is TorBox's free tier. Assumed to permit
   adding torrents (so `DebridStatus.active` is `true` for it, with
   `planLabel: "Free"`), unlike Real-Debrid where a non-premium account cannot
   use torrents at all and `classifyStreamRoute` refuses. If the free tier
   cannot add torrents, `active` becomes `false` for `plan: 0` and the existing
   `torrent-confirm` path covers it with no other change.

Each assumption is marked with a comment in the code naming it as unverified.

## Architecture

### The provider seam

New directory `src/integrations/debrid/`:

| File | Contents |
| --- | --- |
| `types.ts` | `DebridProviderId = "realdebrid" \| "torbox"`; neutral `DebridStatus`; the `DebridProvider` interface |
| `realdebrid.ts` | today's `src/integrations/realdebrid.ts`, moved, plus a `RealDebridUser → DebridStatus` mapping |
| `torbox.ts` | new client |
| `status.ts` | today's `src/integrations/rdStatus.ts`, retyped onto `DebridStatus` |
| `index.ts` | `getDebridProvider(id)` registry |

```ts
export interface DebridStatus {
  provider: DebridProviderId;
  planLabel: string;        // "Premium", "Free", "Pro"…
  active: boolean;          // can this account add torrents?
  expiresAt?: string;       // ISO date, when the provider gives one
  username?: string;
}

export interface DebridProvider {
  id: DebridProviderId;
  label: string;            // "Real-Debrid" / "TorBox" — UI copy comes from here
  homepage: string;
  tokenUrl: string;         // where the user gets a token
  tokenEnvVar: string;
  validateToken(token: string, opts?: RequestOptions): Promise<DebridStatus>;
  resolveMagnet(token: string, magnet: string, opts?: ResolveOptions): Promise<StreamFile[]>;
  // Present only where the provider supports it. Absence is the capability flag.
  checkCached?(token: string, hashes: string[], opts?: RequestOptions): Promise<Set<string>>;
  isTransient(e: unknown): boolean;
  isTokenRejection(e: unknown): boolean;
}
```

`DebridStatus` is where most of the diff lands. RD derives it from
`RealDebridUser.type` plus `premium` seconds; TorBox from `/api/user/me`'s
integer `plan` (0 Free, 1 Essential, 2 Pro, 3 Standard) plus the
`premiumExpiresAt` date string. `formatAccountStatus`, `daysUntil` and
`expiringSoon` in `status.ts` work on the neutral type and are provider-blind.

Two simplifications fall out of the move:

- `ResolvedFile` is already a bare alias for `StreamFile` from `src/util/player.ts`
  (`realdebrid.ts:3,23`). Its four consumers — `src/download/http.ts`,
  `src/ui/components/StreamFilePrompt.tsx`, and the two test fixtures — point at
  `StreamFile` directly, and the type stops belonging to Real-Debrid.
- `RdStatus` becomes `DebridStatus`. Mechanical, and `npm run typecheck` finds
  every site.

Renaming is confined to what a second implementation actually touches: the
status type, token resolution, config fields, capability flags and UI copy.
RD-internal names (`RealDebridError`, `messageForErrorSlug`, `parseErrorSlug`,
`TOKEN_REJECTED_MESSAGE`) stay as they are.

### The TorBox client

Base `https://api.torbox.app/v1`. Auth is `Authorization: Bearer <token>`.
The pipeline is shorter than RD's — there is no `selectFiles` equivalent:

```
POST /api/torrents/createtorrent   (magnet)
  → poll GET /api/torrents/mylist?id=<id>&bypass_cache=true  until download_finished
  → GET  /api/torrents/requestdl?token=…&torrent_id=…&file_id=…   per file
```

Endpoints used:

| Purpose | Call |
| --- | --- |
| Validate token, account status | `GET /api/user/me` |
| Add a magnet | `POST /api/torrents/createtorrent`, form field `magnet` |
| Poll progress / list files | `GET /api/torrents/mylist?id=&bypass_cache=true` |
| Direct link for one file | `GET /api/torrents/requestdl?token=&torrent_id=&file_id=` |
| Cached check | `GET /api/torrents/checkcached?hash=h1,h2&format=list` |

It reuses `fetchResilient` from `src/util/net.ts` and the `RequestOptions`
seam (`fetchImpl`/`sleepImpl`/`signal`/`retries`) so it is testable exactly the
way `realdebrid.test.ts` tests RD — a router stub injected as `fetchImpl`, no
network and no module mocking.

Hash reuse needs no equivalent of RD's five-page `findTorrentByHash` scan:
`createtorrent` on a magnet already in the account returns the existing torrent.

Four TorBox-specific hazards, each with a test:

1. **`success: false` arrives with HTTP 200.** RD's `request()` throws only on
   `!res.ok`; a straight port would read a failure as a success. TorBox's
   `request()` parses the `{success, error, detail}` envelope regardless of
   status and throws a `TorBoxError` carrying both the HTTP status and the
   `error` slug.
2. **`requestdl` puts the API key in the query string.** `realdebrid.ts:191,242,245`
   logs the request path on every call, so a port logs the token. TorBox's
   `request()` logs a query-stripped path. Guards: a unit test asserting no
   `log.*` call contains the token, and a leak assertion in `routes.test.ts`
   that the token never appears in any HTTP response — mirroring the existing
   `RD_URL`/`real-debrid.com` guard at `routes.test.ts:326`.
3. **`progress` is a 0–1 float.** Every `onProgress` consumer assumes 0–100.
   CLAUDE.md names "a progress unit" as one of its four recorded drift bugs;
   this is that bug's second draft. Converted once, at the client boundary.
   `uploadSpeed` — another name on that list — is present in `mylist` and simply
   not read, since nothing in torlink displays debrid upload speed.
4. **Rate limits are shaped differently:** 60/hour for uncached `createtorrent`,
   300/minute otherwise. `isTransient` reads TorBox's envelope slug as well as
   429/5xx, so a rate-limited add is requeued rather than failed.

Like RD's `addMagnet`, `createtorrent` runs with `retries: 0` — it is not
idempotent, and a retry after a transient 5xx that actually succeeded would
leave a duplicate in the user's account.

### Config

```ts
// on Config
torBoxToken?: string;                              // env TORBOX_API_TOKEN
debridProvider?: "realdebrid" | "torbox";
```

`resolveActiveDebrid(config): { provider: DebridProviderId; token: string } | null`
— the single read point, resolving as: the explicit `debridProvider` if its token
resolves; otherwise the one provider that has a token; otherwise, with both
present and no preference, Real-Debrid. Each provider's token resolves env-first
exactly as `resolveRealDebridToken` does today, so a token can be supplied
without ever touching `config.json`.

`resolveRealDebridToken` stays, unchanged and still tested; a
`resolveTorBoxToken` sits beside it.

Config writes from the web remain read-modify-write per request, per CLAUDE.md —
though token entry and provider choice stay TUI-only (see below).

### Persisted enums and their migration

```ts
type DownloadVia = "p2p" | "debrid";           // was "p2p" | "realdebrid"
type StreamBackend = "debrid" | "torrent";      // was "realdebrid" | "torrent"
// download items gain:  provider?: DebridProviderId
```

A single `normalizeVia()` helper in `src/download/types.ts` maps a legacy
`"realdebrid"` to `{ via: "debrid", provider: "realdebrid" }`. It is applied at
every persisted-item read point — restored queue items and download history —
so existing user data survives the upgrade. Items written before providers
existed are Real-Debrid by definition, so the migration is lossless.

### Core flow

- **`src/core/streamRoute.ts`** — `StreamRoute` becomes
  `{kind:"debrid", provider} | {kind:"torrent-auto"} | {kind:"torrent-confirm", reason}`.
  `classifyStreamRoute(config, status)` keeps its three-way shape; the refusal
  reason is built from the provider's `label` (`your ${label} plan isn't active`)
  instead of hard-coding "Real-Debrid". It still never silently downgrades to P2P.
- **`src/core/streamSession.ts`** — `StreamSession` gains
  `provider?: DebridProviderId`; `StartStreamInput` gains `debridProvider`
  alongside `debridToken`. The `ResolveDebridImpl` seam takes the provider id and
  dispatches through the registry. A missing token still throws rather than
  falling back to P2P.
- **`src/download/queue.ts`** — `setRealDebridToken` becomes
  `setDebridToken(provider, token)`; `addDebrid` takes the provider; queue items
  record it. `DebridDeps.resolveMagnet` gains the provider parameter. The
  scheduler, `MAX_ACTIVE_DEBRID`, backoff, pause/resume and restart
  reconciliation are unchanged in behaviour — only the label in
  "Interrupted — download again via Real-Debrid" becomes provider-derived.
- **`src/web/stream.ts`** — the `302` to `file.url` for a debrid-backed session
  now triggers on `backend === "debrid"`. TorBox's `requestdl` links are
  time-limited credentials exactly as RD's unrestricted links are, so the
  existing `Cache-Control: no-store` handling and the "never write a debrid link
  into the file" guard apply unchanged.

### The cached marker

When TorBox is the active provider, results carry a `Cached` tag. One batched
`checkcached` call per page of results, keyed by infoHash. Best-effort and fail
soft: a failed or timed-out check shows no tags at all rather than surfacing an
error, and never blocks the results from rendering.

When Real-Debrid is active the marker is absent entirely — no column, no
placeholder, no "unknown" state. RD removed its instant-availability endpoint in
2024, so there is nothing honest to show, and an empty slot would read as
"not cached".

The decision of *whether* to ask and *what* to render lives in a pure module
shared by both front ends: `src/core/cachedHashes.ts`. It goes in `src/core/`
rather than `src/util/` because it tests the provider's `checkCached` capability
and so imports from `src/integrations/` — `src/util/` sits *below* the
integrations layer (`src/util/net.ts` is imported by the clients, not the other
way round), and putting it there would invert the dependency.

## Both front ends

Per CLAUDE.md, this feature lands in both surfaces in the same change.

### Terminal UI (`src/ui/`)

| Touchpoint | Change |
| --- | --- |
| `components/Accounts.tsx` | A TorBox row beside Real-Debrid — label, homepage, `formatAccountStatus` — with the active provider marked and a key to switch |
| `components/TokenPrompt.tsx` | Parameterised by provider: panel title and the "get a token" hyperlink come from `DebridProvider.tokenUrl`/`label` |
| `components/RdBadge.tsx` | → `DebridBadge.tsx`, showing the active provider's label and its expiry warning |
| `components/Results.tsx` | Per-row action hint uses the active provider's label; `Cached` tag when TorBox is active |
| `components/Downloads.tsx` | Phase labels ("preparing on Real-Debrid… n%") become provider-derived |
| `downloadState.ts` | The `RD`/`P2P` badge gains `TB` |
| `keymap.ts` | The `r` entry's label is provider-derived, in **both** `HELP_GROUPS` and `footerHints` |
| `store.ts` | `rdStatus` → `debridStatus`; new `debridProvider` |
| `views/Splash.tsx` | The connect tip names the configured provider, or invites either when neither is set |
| `App.tsx` | `setDebridToken(provider, …)`, `clearDebridToken(provider)` (still refusing when that provider's env var is set), provider-aware stream and download flows |

Every new/renamed `Store` field gets a matching entry in **both**
`makeStore` (`scripts/render-previews-impl.tsx:138`) and `makeTestStore`
(`src/ui/testHarness.ts:182`) — otherwise `npm run previews` and
`npm run typecheck` respectively break. `npm run previews` is re-run so
`preview/accounts.svg` and `preview/help.svg` stop showing RD-only copy.

### Browser UI (`src/web/`)

| Touchpoint | Change |
| --- | --- |
| `routes.ts` `/api/sources` | Keeps `debridConfigured: boolean`; adds `debridProvider: DebridProviderId \| null` and `debridCachedCheck: boolean`. Never the token. |
| `routes.ts` `/api/stream` | Resolves the active provider instead of the RD token; `rdStatusImpl` seam becomes `debridStatusImpl` |
| `routes.ts` `/api/add` | `via: "debrid"` resolves the active provider; the 400 for a missing token keeps matching the TUI's wording, with the provider named |
| `routes.ts` `POST /api/cached` | New: `{hashes: string[]}` → `{cached: string[]}`. Refused (409) when the active provider has no `checkCached`. |
| `wire.ts` | `PublicStreamSession.backend: "debrid" \| "torrent"`; the `SourcesResponse` additions; `CachedRequest`/`CachedResponse` |
| `static/app.ts` | The add-button label comes from `sources.debridProvider`; cached badges built with `createElement` + `textContent` |
| `static/searchModel.ts` | `addPlan` keeps its prompt semantics; the button label and the cached-tag decision are pure functions here, not conditionals in `app.ts` |

Nothing goes through `innerHTML`/`insertAdjacentHTML`/`outerHTML` — release names
come from whoever uploaded a torrent, so that path is stored XSS. No conditional
deciding *what to show* or *what to send* lives in `app.ts`; per CLAUDE.md (and
two prior review catches) those belong in the pure modules.

### Deliberately TUI-only

Entering tokens and choosing the active provider stay in the terminal, the same
carve-out that already applies to RD tokens, sources, limits, folders and DNS.
The browser is a client of that config and adapts via the `/api/sources`
capability flags. This is stated explicitly in the PR body, as CLAUDE.md requires.

## Error handling

- A rejected token surfaces the provider's own name, and the TUI re-prompts for
  that provider specifically — the other provider's token is untouched.
- Transient failures requeue within the existing attempt budget and backoff; only
  the classification of *what counts as transient* is provider-specific.
- A cached-check failure is silent by design (see above).
- A missing token never falls back to P2P silently. `classifyStreamRoute` still
  returns `torrent-confirm` with a reason the user has to accept.
- No cross-provider fallback. If TorBox is active and fails, torlink reports
  TorBox failing — it does not quietly try Real-Debrid, because "why is this
  slow / why did my RD quota move" is unanswerable after a silent switch.

## Testing

New:

- `src/integrations/debrid/torbox.test.ts` — mirrors `realdebrid.test.ts`'s
  router-stub style. Covers: the bearer header; `success:false` on HTTP 200
  throwing; `createtorrent` running with no retries; the poll loop reaching
  `download_finished`; `requestdl` called once per file; the 0–1 → 0–100
  progress conversion; `checkcached` batching and its empty-object/empty-list
  response; rate-limit classification via `isTransient`; abort mid-poll; and
  **that the token never reaches `log.*`**.
- `src/integrations/debrid/status.test.ts` — both providers' `DebridStatus`
  mapping and the expiry formatting, including TorBox's four plan integers.
- `src/core/cachedHashes.test.ts` — batching, provider-capability gate, fail-soft.

Updated: `config.test.ts` (the new token and `resolveActiveDebrid` precedence,
env-first), `streamRoute.test.ts`, `streamSession.test.ts`, `queue.test.ts`
(provider parameter; the legacy-`via` migration), `routes.test.ts` (the TorBox
token leak assertion; the new `/api/cached` route), `stream.test.ts`,
`keymap.test.ts`, `downloadState.test.ts`, `Accounts.test.tsx`,
`searchModel.test.ts`, `runtime.test.ts`.

Fixtures use the established cast — `Kestrel.2010.1080p.BluRay.x264`,
`Kepler.S02E04.1080p.WEB-DL`, `Harrowgate.S03.1080p.WEB-DL` — and never a real
title. Because this change renames symbols and copy rather than fixtures, the
bulk-rename traps in CLAUDE.md apply to the *assertions*: after renaming
"Real-Debrid" strings, grep `not.toContain`/`not.toBe` for the old names and
confirm each negative assertion still names something the test actually puts in
play. `stream.test.ts`'s "never writes a Real-Debrid link into the file" is
exactly the kind of check that goes vacuous if the string it hunts for stops
existing.

Browser wiring is verified by running it — `npm run dev -- serve --web` — since
there is no jsdom. `npm run build` is the only check that `src/web/static/`
imports no `node:*`.

## Docs

- **`README.md`** — the "Real-Debrid (optional)" section becomes a debrid section
  covering both providers: how to get each token, `REALDEBRID_API_TOKEN` and
  `TORBOX_API_TOKEN`, how to pick the active provider, and that the cached
  marker is TorBox-only because RD no longer offers the check. The web UI's own
  limitations list is re-checked against reality.
- **`package.json`** — description and keywords mention TorBox. Published name
  stays `torlnk-rd`.
- **`CONTRIBUTING.md:61`** and **`CLAUDE.md:17`** — the capability-flag example
  is updated for the new `/api/sources` fields.

## Out of scope

- TorBox usenet and web-download support. Unrelated to torrent search.
- Cross-provider fallback on failure.
- Renaming the published npm package.
- A cached indicator for Real-Debrid. The endpoint no longer exists.

## Definition of done

`npm test`, `npm run typecheck`, `npm run lint`, `npm run build` all clean —
leaving the one known pre-existing `react-hooks/exhaustive-deps` warning in
`src/ui/App.tsx` alone. `npm run previews` re-run. Both front ends exercised by
hand: the TUI Accounts pane switching providers, and `serve --web` showing the
right button label and cached tags.
