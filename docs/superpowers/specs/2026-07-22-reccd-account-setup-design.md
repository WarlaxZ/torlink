# reccd Account Setup — Design

**Date:** 2026-07-22
**Status:** Approved (design)
**Depends on:** the reccd integration and "For You" UI already on branch `docs/recommendation-engine-spec`
(config fields `reccUrl`/`reccToken`, `resolveReccConfig`, the `ForYou` view).

## Problem

reccd's connection (`reccUrl` + `reccToken`) can currently only be set by hand-editing
`config.json` or via `TORLINK_RECC_URL` / `TORLINK_RECC_TOKEN` env vars. There's no in-app way to
configure it, so it doesn't persist conveniently and isn't discoverable. Since the "For You" nav
item is hidden until reccd is configured, a first-time user has no obvious path to set it up.

This adds an in-TUI setup for reccd in the existing **Accounts** pane, persisted to `config.json`
(no env vars needed), with a live connection status. reccd is framed as a **private, self-hosted
service** — appropriate until it's deployed somewhere shared.

## Architecture

Mirrors the existing Real-Debrid account flow (a status module + an Accounts row + a token prompt),
adapted to reccd's two required values (URL + token).

### 1. Connection status — `src/recc/status.ts`

```
type ReccConnection = "unconfigured" | "connected" | "badToken" | "unreachable";

interface ReccStatus { state: ReccConnection; host?: string; }

async function checkReccConnection(
  config: ReccClientConfig,
  opts?: { fetchImpl?: FetchImpl; timeoutMs?: number },
): Promise<ReccStatus>;

function formatReccStatus(status: ReccStatus): string;
```

- `checkReccConnection` returns `unconfigured` immediately when `reccUrl` is unset. Otherwise it
  does `GET ${reccUrl}/profile` with `Bearer ${reccToken ?? ""}` and a short timeout (~6s):
  - 200 → `connected`
  - 401 → `badToken`
  - any other status, network error, or timeout → `unreachable`
  - `host` is the URL's host:port (best-effort parse; falls back to the raw `reccUrl`).
- `formatReccStatus`: `connected` → `Connected · <host>`; `badToken` → `Token rejected`;
  `unreachable` → `Unreachable · <host>`; `unconfigured` → `Not configured`.
- Uses the same injected-`FetchImpl` pattern as `fetchRecommendations`/`postEvent` so it's testable
  without a network. `/profile` is chosen because it's a cheap authenticated GET that cleanly
  distinguishes 200 vs 401.

### 2. Setup prompt — `src/ui/components/ReccdPrompt.tsx`

A two-field prompt modeled on the existing RuTracker login prompt (`RutrackerPrompt.tsx`):

- Field 1: **URL** — `TextField`, `defaultValue` = current `reccUrl`, placeholder `http://localhost:4100`.
- Field 2: **Token** — `TextField` with `mask`, `defaultValue` = current `reccToken`.
- Tab / ↑↓ move between fields; `↵` submits `(url, token)`; `esc` cancels. Uses `PromptHints`.
- Title: `reccd — private, self-hosted recommendations`.
- Props: `{ width; url: string; token: string; onSubmit: (url: string, token: string) => void; onCancel: () => void }`.
- Trimming/normalization (e.g. stripping a trailing slash from the URL) happens in the App handler,
  not the prompt, so the prompt stays presentational.

### 3. Accounts row — `src/ui/components/Accounts.tsx`

Add a third `Row`:
- `tag: "RCD"`, `label: "reccd"`, `homepage: "self-hosted · private service"`.
- `signedIn` = `reccUrl` is configured.
- `status` = `formatReccStatus(reccStatus)` (from a new prop).
- `onManage` = open the ReccdPrompt; `onSignOut` = clear reccUrl/reccToken.
- New props on `AccountsProps`: `reccConfigured: boolean`, `reccStatus: ReccStatus | null`,
  `reccEnvOverride?: boolean`, `onManageRecc: () => void`, `onSignOutRecc: () => void`.
- When `reccEnvOverride` is true, append a dim note to the row (e.g. `(env override active)`) so a
  value typed here that "doesn't take" isn't confusing — env still wins, matching Real-Debrid.

### 4. App wiring — `src/ui/App.tsx`

- State: `editingRecc: boolean`, `reccStatus: ReccStatus | null`.
- Open handler (`onManageRecc`): set `editingRecc = true`. Render `<ReccdPrompt … />` hoisted like
  the other prompts (added to the body/footer `display`-none guards and its own render block).
- Submit handler: normalize the URL (trim, strip trailing slash; empty → undefined), write
  `reccUrl`/`reccToken` into config via the existing `setConfigState` + `saveConfig` path, close the
  prompt, and re-check status.
- Clear handler (`onSignOutRecc`): set `reccUrl`/`reccToken` to undefined in config, save, re-check.
- Status lifecycle: compute `checkReccConnection(resolveReccConfig(config))` on load and whenever the
  reccd config changes (mirrors how `rdStatus` is refreshed). Pass `reccStatus`, `reccConfigured`
  (`store.reccConfigured`), and `reccEnvOverride` (whether a `TORLINK_RECC_*` env var is set) to
  `Accounts`.
- Because saving updates `config`, `store.reccConfigured` flips true and the "For You" nav item
  appears immediately (already wired).

### 5. For You fallback copy

Update the `ForYou` not-configured hint to point at the Accounts pane
("Set up reccd in Accounts (↵)") instead of "edit config.json". This branch is normally
unreachable (the nav item is hidden until configured) but remains as a runtime fallback.

## Persistence & precedence

- Values are saved to `config.json` (`reccUrl`/`reccToken`) — no env vars required.
- `resolveReccConfig` precedence is unchanged: `TORLINK_RECC_URL`/`TORLINK_RECC_TOKEN` env vars still
  win over config, consistent with `resolveRealDebridToken`. The Accounts row surfaces when an env
  override is active.

## Testing

- `src/recc/status.test.ts`: `checkReccConnection` classification (unconfigured / 200 / 401 /
  non-2xx / network-throw) with an injected fetch; `formatReccStatus` for each state; host parsing.
- `src/ui/components/ReccdPrompt.test.tsx`: renders two fields; typing URL + token and submitting
  calls `onSubmit(url, token)`; `esc` calls `onCancel`.
- `src/ui/components/Accounts.test.tsx` (extend if present, else add): the reccd row renders with its
  status, `↵` calls `onManageRecc`, `x` calls `onSignOutRecc` when configured, and the env-override
  note shows when `reccEnvOverride`.
- Full suite + `tsc --noEmit` green.

## Out of scope

- Multi-user / choosing which reccd user (single token per install, as today).
- A discovery/onboarding wizard beyond the Accounts row.
- Changing `resolveReccConfig` precedence.
