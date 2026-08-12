# Per-profile watch history and reccd (split by Cloudflare Access login)

**Date:** 2026-08-12
**Status:** Approved design, pending implementation plan

## Problem

torlink runs behind Cloudflare Access (Zero Trust) with named users, so the owner
can share the server with a friend. Today all "personal" state is a single global
blob per install, so the friend's activity contaminates the owner's:

- Watch history / "Continue Watching"
- Favourites
- Saved searches
- reccd recommendations (one shared account learns from everyone's watches)

The goal is to **partition these four lists by the authenticated login**, while
leaving all shared/host-specific configuration untouched.

## What stays shared (explicitly out of scope)

Sources, debrid tokens, OMDb key, custom DNS, extra trackers, VPN interface, cast
device/host, download folder, and all playback/transfer settings remain a single
shared config. Only the four personal lists fork per user.

## Key existing facts (verified in the codebase)

- **Watch history**: `<dataDir>/stream-history.json` — flat array, cap 200
  (`STREAM_HISTORY_CAP`), path at `src/config/paths.ts`. Model in
  `src/core/streamHistory.ts` (`loadStreamHistory`, `saveStreamHistory`,
  `forgetStreamHistory` — the last re-reads before writing because the TUI and
  `serve --web` are separate processes sharing the file). Written by the web at
  `src/web/routes.ts:530` and by the TUI (`src/ui/App.tsx`). Dedupe key derived in
  `src/util/streamHistoryKey.ts` (kept in `util` so the browser bundle avoids `node:fs`).
- **Favourites / saved searches**: top-level `config.json` fields
  `favourites?: FavouriteItem[]` and `savedSearches?: string[]`
  (`src/config/config.ts:96,99`). List helpers in `src/util/favouriteList.ts` and
  `src/util/savedSearchList.ts`.
- **reccd**: single anonymous account per install. Client `src/recc/client.ts`
  (`postEvent`, `fetchRecommendations`, `fetchTitleSuggestions`, `claimReccAccount`)
  all take a `ReccClientConfig { reccUrl?, reccToken? }`. Config resolved by
  `resolveReccConfig` (`src/config/config.ts`) from env or the top-level `reccToken`
  / `reccAccountName` / `reccAccountClaimed` / `reccAutoSignup` fields. Anonymous
  auto-signup in `src/recc/provision.ts` (`ensureReccAccount`,
  `DEFAULT_RECC_URL = "https://reccd.stream"`). **Event payloads carry no identity** —
  only release name, timestamp, and the literal `"torlink"` as source. Isolation is
  therefore entirely a function of *which token* the call uses.
- **Identity**: Cloudflare Access is already verified per request in
  `src/web/server.ts:521-536`. `verifyAccessAssertion` (`src/core/cloudflareAccess.ts`)
  already extracts `email` and `sub` from the JWT, but the server only checks
  `verdict.ok` and **discards the email** (`server.ts:529`). No per-user identity is
  used anywhere today. This discarded email is the hook.

## Design

### Concept: a "profile"

A **profile** is the container for the four personal lists. Which profile a request
uses is resolved from the verified Access email:

- **Web request through Access** → profile = the caller's email, slugified to a
  stable, filesystem-safe `profileId`.
- **The TUI, and any non-Access request** → the **owner** profile.

### Owner identity (decision: explicit)

A new `ownerEmail` config field designates which Access email is "you". Resolved by a
`resolveOwnerEmail` helper with `TORLINK_OWNER_EMAIL` env winning over the config
field — exactly how `cfAccessTeamDomain` / `cfAccessAud` work today (env + config,
no `Settings.tsx` UI row, since this is host-specific security config). The owner
profile *is* the existing top-level storage, and the TUI always maps to it.

### reccd per profile (decision: auto-provision)

`resolveReccConfig` becomes profile-aware and returns the profile's own `reccToken`.
When a web request's profile has no token yet and `reccAutoSignup` is on,
`ensureReccAccount` runs an anonymous signup against `reccd.stream` and writes the new
token into `profiles[id]` (read-modify-write). All reccd calls already flow through a
`ReccClientConfig`, so the only change is *which* config they receive. Account
*claiming* (name + password) stays owner/TUI-only; friends get an anonymous account,
which is sufficient for isolated recommendations.

### Data model

`config.json` gains:

```ts
ownerEmail?: string;                 // which Access email is the owner
profiles?: {
  [profileId: string]: {
    favourites?: FavouriteItem[];
    savedSearches?: string[];
    reccToken?: string;              // this profile's own reccd account
    reccAccountName?: string;
    reccAccountClaimed?: boolean;
  };
};
```

**The owner keeps today's storage; only friends get namespaced storage.** The owner
profile *is* the existing top-level `favourites` / `savedSearches` / `reccToken` fields
and the existing `stream-history.json`. A friend profile's lists live in
`profiles[id]`, and its watch history lives in `stream-history/<profileId>.json`.

This choice deletes migration entirely: there is nothing to move, because the owner's
data never changes location. It also makes the feature a strict no-op until
`ownerEmail` is set (with no owner, every request resolves to the owner view = today's
single shared state). Watch history stays a per-profile file for friends for the same
reasons it is separate today (the 200 cap and the cross-process re-read-before-write).

### Identity resolution module

New front-end-agnostic `src/core/profile.ts`:

- `resolveProfileId(email: string | null, config): string` — email present and not
  the owner → `slug(email)`; otherwise → the owner profile id.
- `slug(email)` — lowercase and reduce to a stable, filesystem-safe id. Must be
  **collision-free**: two distinct emails must never map to the same id (e.g. a hash
  of the normalised email, or percent-style encoding — not a lossy strip of unsafe
  characters, which could merge `a.b@x` and `a_b@x`).
- Owner profile id derived from `ownerEmail` (or a reserved constant when unset).

This lives in `core` so **both** front ends use it: the web passes the caller's email,
the TUI passes the owner. Pure and fully unit-tested.

### Wiring

- **Web** (`src/web/`): capture the verified `email` at `server.ts:521-536` into a
  small per-request context, resolve `profileId` once, and thread it to every route
  that touches the four lists — watch history record/read/forget (`routes.ts:530`),
  favourites (`routes.ts:1205`), reccd events (`routes.ts:539`, `routes.ts:1869`),
  recommendations, and saved searches. Routes stay thin; decisions live in
  `src/core/profile.ts` and the profile-scoped accessors.
- **TUI** (`src/ui/`): resolve the owner profile at startup and pass that id to the
  same core accessors. No new keybinding or pane — the TUI shows the owner's lists,
  which is what the owner wants.

### Migration

None. The owner's data never moves (see the data model above). Friend profiles are
created empty on first authenticated request.

### Fail-soft behaviour

Access not configured, or `ownerEmail` unset, or a request with no verifiable JWT →
everything resolves to the owner profile, i.e. today's single-user behaviour. The
feature is a no-op until Access is enforced and `ownerEmail` is set.

## Front-end parity note (CLAUDE.md rule)

The profile concept and all four profile-scoped accessors live in `core`/`util` and
are driven by both front ends. The one deliberately web-only piece is **reading
identity from Cloudflare Access headers**: Access headers exist only on the web
transport, and the TUI has no remote users, so the TUI legitimately always operates as
the owner. This is the documented "a surface can't express it / host-specific" 
exception and must be stated explicitly in the PR body.

## Testing

- `src/core/profile.ts` — email→id, owner resolution, slug safety, unset-owner
  fallback. Pure unit tests.
- Migration — unit test against a legacy `config.json` + `stream-history.json` fixture;
  assert idempotency.
- Profile-scoped list accessors — two ids yield two independent watch histories,
  favourites, and saved searches; reccd calls use the per-profile token.
- Fail-soft — no Access / no owner resolves to the owner profile.
- Fixtures use the invented cast (`Kestrel`, `Ashfall`, `Harrowgate`, `Kepler`, …) and
  invented emails only — never real titles (CLAUDE.md).
- Full gate before "done": `npm test`, `npm run typecheck`, `npm run lint`,
  `npm run build`.

## Docs

`README.md` gains a short "sharing the server behind Cloudflare Access" section
covering `ownerEmail` and what forks per user. The PR body records the web-only
identity exception.

## Out of scope (YAGNI)

- No profile-management UI (list/delete friends). Profiles auto-create on first
  authenticated request.
- No per-user sources, tokens, or machine settings.
- No reccd account claiming for friends.
- Not "full multi-user" — this is list partitioning, not multi-tenant profiles for
  everything.
