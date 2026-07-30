# TorBox Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make TorBox a first-class debrid provider alongside Real-Debrid, selected by an explicit preference, in both the terminal UI and the browser UI.

**Architecture:** A `DebridProvider` interface in `src/integrations/debrid/` with two implementations behind a registry. Real-Debrid's leaked types (`RdStatus`, `ResolvedFile`, `resolveMagnet`) are replaced by neutral ones so `src/core/`, `src/download/`, `src/ui/` and `src/web/` never name a provider. Config gains a second token plus a `debridProvider` preference; one `resolveActiveDebrid()` is the single read point.

**Tech Stack:** TypeScript (ESM, `node16` resolution), Vitest, Ink + React (TUI), hand-rolled DOM (web), `tsup` for bundling.

**Spec:** `docs/superpowers/specs/2026-07-30-torbox-support-design.md`

## Global Constraints

- **Both front ends, same change.** Every user-facing behaviour lands in `src/ui/` *and* `src/web/`. Entering tokens and picking the provider are TUI-only under the existing configuration carve-out.
- **Layering, enforced by `eslint.config.js`:** `src/web` must not import from `src/ui`; `src/core` must not import from `src/ui` or `src/web`. `src/util/` sits *below* `src/integrations/` — never import integrations from util.
- **No `innerHTML` / `insertAdjacentHTML` / `document.write` / `outerHTML` anywhere in `src/web/static/`.** Every node is `createElement` + `textContent`.
- **`src/web/static/app.ts` is DOM wiring only.** Any conditional deciding *what to show* or *what to send* goes in a pure module.
- **Config writes from the web are read-modify-write per request:** `loadConfig()` → change → `saveConfig()`. Never hold a snapshot between requests.
- **Test fixtures never name a real film or show.** Use only: `Kestrel.2010.1080p.BluRay.x264`, `Ashfall.1999.1080p`, `Tin.Rivers.2024.2160p.WEB-DL.DV.HDR.Atmos.7.1-GROUP`, `Kepler.S02E04.1080p.WEB-DL`, `Harrowgate.S03.1080p.WEB-DL`.
- **After any rename, grep `not.toContain` / `not.toBe` for the old strings** and confirm each negative assertion still names something the test actually puts in play. A negative assertion whose target no longer exists passes vacuously.
- **Unverified TorBox shapes must carry a code comment saying so.** Three of them: `createtorrent` response field names, the `progress` scale (assumed 0–1), and whether `plan: 0` (free) can add torrents (assumed yes).
- **Every task ends green:** `npm test`, `npm run typecheck`, `npm run lint`. `npm run build` is the only check that `src/web/static/` imports no `node:*` — run it on any task touching `src/web/static/`. Leave the one known pre-existing `react-hooks/exhaustive-deps` warning in `src/ui/App.tsx` alone.
- **Conventional Commits.** Commit at the end of every task.

## File Structure

**Created:**

| Path | Responsibility |
| --- | --- |
| `src/integrations/debrid/types.ts` | `DebridProviderId`, `DebridStatus`, `DebridProvider`, `RequestOptions`, `ResolveOptions` |
| `src/integrations/debrid/status.ts` | Provider-blind presentation: `daysUntil`, `expiringSoon`, `formatAccountStatus` |
| `src/integrations/debrid/realdebrid.ts` | Today's RD client (moved) + its `DebridProvider` object |
| `src/integrations/debrid/torbox.ts` | The TorBox client + its `DebridProvider` object |
| `src/integrations/debrid/index.ts` | `getDebridProvider`, `DEBRID_PROVIDER_IDS` |
| `src/integrations/debrid/torbox.test.ts` | TorBox client tests |
| `src/integrations/debrid/status.test.ts` | Status mapping + formatting for both providers |
| `src/core/cachedHashes.ts` | Cached-check batching and the provider-capability gate |
| `src/core/cachedHashes.test.ts` | Tests for the above |
| `src/ui/components/DebridBadge.tsx` | Header indicator, replacing `RdBadge.tsx` |
| `src/download/persist.test.ts` | Tests the legacy-`via` migration |

**Deleted:** `src/integrations/realdebrid.ts`, `src/integrations/rdStatus.ts`, `src/integrations/rdStatus.test.ts`, `src/ui/components/RdBadge.tsx` (each superseded by a file above or renamed).

**Modified:** `src/config/config.ts`, `src/core/streamRoute.ts`, `src/core/streamSession.ts`, `src/download/types.ts`, `src/download/persist.ts`, `src/download/history.ts`, `src/download/queue.ts`, `src/download/http.ts`, `src/daemon/runtime.ts`, `src/ui/App.tsx`, `src/ui/store.ts`, `src/ui/testHarness.ts`, `src/ui/keymap.ts`, `src/ui/downloadState.ts`, `src/ui/components/{Accounts,TokenPrompt,Results,Downloads,StreamFilePrompt}.tsx`, `src/ui/views/Splash.tsx`, `src/web/{routes,wire,stream}.ts`, `src/web/static/{app,searchModel}.ts`, `scripts/render-previews-impl.tsx`, `README.md`, `package.json`, `CONTRIBUTING.md`, `CLAUDE.md`, plus each affected test.

---

## Phase 1 — the neutral seam (no behaviour change)

### Task 1: The neutral `DebridStatus` and the provider interface

**Files:**
- Create: `src/integrations/debrid/types.ts`
- Create: `src/integrations/debrid/status.ts`
- Create: `src/integrations/debrid/status.test.ts`
- Delete: `src/integrations/rdStatus.ts`, `src/integrations/rdStatus.test.ts`
- Modify: `src/integrations/realdebrid.ts` (add the status mapping), and every `RdStatus` consumer: `src/ui/store.ts:7,183`, `src/ui/components/RdBadge.tsx:3`, `src/ui/components/TokenPrompt.tsx:6`, `src/ui/components/Accounts.tsx:8`, `src/core/streamRoute.ts:2`, `src/web/routes.ts:34`, `src/ui/App.tsx:20`

**Interfaces:**
- Produces: `DebridProviderId`, `DebridStatus`, `DebridProvider`, `daysUntil(date, now)`, `expiringSoon(status, now)`, `formatAccountStatus(status | null, now)`, `debridStatusFromRealDebridUser(user, now)`. Every later task consumes these.

`DebridStatus` keeps `expiresAt` as a `Date | null` (not an ISO string) so `daysUntil` needs no parsing at every call site, and `planLabel` is **lowercase** so today's `formatAccountStatus` strings ("free account", "premium · 14d left") are preserved byte-for-byte and the existing assertions keep their meaning.

- [ ] **Step 1: Write the failing test**

Create `src/integrations/debrid/status.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { daysUntil, expiringSoon, formatAccountStatus } from "./status";
import type { DebridStatus } from "./types";
import { debridStatusFromRealDebridUser } from "./realdebrid";

const NOW = new Date("2026-07-30T00:00:00Z");

function status(over: Partial<DebridStatus> = {}): DebridStatus {
  return {
    provider: "realdebrid",
    username: "ada",
    active: true,
    planLabel: "premium",
    expiresAt: null,
    ...over,
  };
}

describe("debrid status presentation", () => {
  it("reports not connected for a null status", () => {
    expect(formatAccountStatus(null, NOW)).toBe("not connected");
  });

  it("names the plan when the account cannot add torrents", () => {
    expect(formatAccountStatus(status({ active: false, planLabel: "free" }), NOW)).toBe("free account");
  });

  it("counts whole days remaining, rounded up", () => {
    const expiresAt = new Date("2026-08-13T12:00:00Z");
    expect(daysUntil(expiresAt, NOW)).toBe(15);
    expect(formatAccountStatus(status({ expiresAt }), NOW)).toBe("premium · 15d left");
  });

  it("floors days remaining at zero for a past date", () => {
    expect(daysUntil(new Date("2026-07-01T00:00:00Z"), NOW)).toBe(0);
  });

  it("warns at or below 14 days and not above", () => {
    expect(expiringSoon(status({ expiresAt: new Date("2026-08-13T00:00:00Z") }), NOW)).toBe(true);
    expect(expiringSoon(status({ expiresAt: new Date("2026-08-14T00:00:00Z") }), NOW)).toBe(false);
    expect(expiringSoon(status({ expiresAt: null }), NOW)).toBe(false);
  });

  it("falls back to the bare plan label when there is no expiry", () => {
    expect(formatAccountStatus(status(), NOW)).toBe("premium");
  });
});

describe("debridStatusFromRealDebridUser", () => {
  it("maps an active premium account, preferring the expiration date", () => {
    const s = debridStatusFromRealDebridUser(
      { username: "ada", type: "premium", premium: 86_400, expiration: "2026-08-20T00:00:00Z" },
      NOW,
    );
    expect(s).toEqual({
      provider: "realdebrid",
      username: "ada",
      active: true,
      planLabel: "premium",
      expiresAt: new Date("2026-08-20T00:00:00Z"),
    });
  });

  it("derives the expiry from remaining seconds when there is no date", () => {
    const s = debridStatusFromRealDebridUser({ username: "ada", type: "premium", premium: 86_400 }, NOW);
    expect(s.expiresAt).toEqual(new Date("2026-07-31T00:00:00Z"));
  });

  it("ignores an unparseable expiration and uses the seconds", () => {
    const s = debridStatusFromRealDebridUser(
      { username: "ada", type: "premium", premium: 86_400, expiration: "not a date" },
      NOW,
    );
    expect(s.expiresAt).toEqual(new Date("2026-07-31T00:00:00Z"));
  });

  it("marks a free account inactive with no expiry", () => {
    const s = debridStatusFromRealDebridUser({ username: "ada", type: "free", premium: 0 }, NOW);
    expect(s.active).toBe(false);
    expect(s.planLabel).toBe("free");
    expect(s.expiresAt).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/integrations/debrid/status.test.ts`
Expected: FAIL — cannot resolve `./status` or `./types`.

- [ ] **Step 3: Write `src/integrations/debrid/types.ts`**

```ts
import type { FetchImpl } from "../../util/net";
import type { StreamFile } from "../../util/player";

/** Every debrid service torlink can resolve a magnet through. */
export type DebridProviderId = "realdebrid" | "torbox";

/**
 * A render-ready, provider-blind view of a connected debrid account. Both front
 * ends and `classifyStreamRoute` read only this — nothing above
 * `src/integrations/debrid/` knows a provider's own account shape.
 */
export interface DebridStatus {
  provider: DebridProviderId;
  username: string;
  /** Can this account add torrents at all? Drives the torrent-confirm refusal. */
  active: boolean;
  /** Lowercase, e.g. "premium", "free", "pro". Rendered directly. */
  planLabel: string;
  /** Best estimate of when the plan lapses; null when unknown or not applicable. */
  expiresAt: Date | null;
}

export interface RequestOptions {
  fetchImpl?: FetchImpl;
  sleepImpl?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  /** Retry budget. Set 0 for non-idempotent calls where a retry could duplicate work. */
  retries?: number;
}

export interface ResolveOptions extends RequestOptions {
  /** Provider-side caching progress, 0–100 (never a 0..1 fraction). */
  onProgress?: (percent: number) => void;
  pollIntervalMs?: number;
  /** The torrent's infoHash (hex), so an already-added torrent is reused. */
  knownHash?: string;
  /** Fail if provider-side caching makes no progress for this many ms. */
  stallMs?: number;
}

/**
 * One debrid service. `label`, `homepage` and `tokenUrl` exist so no UI copy
 * anywhere hardcodes a provider's name — a second provider would otherwise mean
 * hunting every "Real-Debrid" string again.
 */
export interface DebridProvider {
  id: DebridProviderId;
  /** Display name, e.g. "Real-Debrid". */
  label: string;
  /** Two-letter tag for the compact header badge and the downloads list. */
  shortLabel: string;
  homepage: string;
  /** Where the user gets an API token. */
  tokenUrl: string;
  /** Env var that overrides the persisted token. */
  tokenEnvVar: string;
  validateToken(token: string, opts?: RequestOptions): Promise<DebridStatus>;
  resolveMagnet(token: string, magnet: string, opts?: ResolveOptions): Promise<StreamFile[]>;
  /**
   * Which of `hashes` the provider already has cached. Present ONLY where the
   * provider supports it — its absence is the capability flag. Real-Debrid
   * removed its instant-availability endpoint in 2024 and so does not have it.
   */
  checkCached?(token: string, hashes: string[], opts?: RequestOptions): Promise<Set<string>>;
  /** Worth requeuing (rate limit, transient server load) vs terminal. */
  isTransient(e: unknown): boolean;
  /** The token was rejected — the UI should re-prompt for THIS provider. */
  isTokenRejection(e: unknown): boolean;
}
```

- [ ] **Step 4: Write `src/integrations/debrid/status.ts`**

```ts
import type { DebridStatus } from "./types";

// At or below this many days left, the header badge nudges the user.
const EXPIRY_WARN_DAYS = 14;

/** Whole days from `now` until `date`, rounded up, floored at 0. */
export function daysUntil(date: Date, now: Date): number {
  return Math.max(0, Math.ceil((date.getTime() - now.getTime()) / 86_400_000));
}

export function expiringSoon(status: DebridStatus, now: Date): boolean {
  return !!status.expiresAt && daysUntil(status.expiresAt, now) <= EXPIRY_WARN_DAYS;
}

/** One-line account state for the token prompt and the accounts pane. */
export function formatAccountStatus(status: DebridStatus | null, now: Date): string {
  if (!status) return "not connected";
  if (!status.active) return `${status.planLabel} account`;
  if (status.expiresAt) return `${status.planLabel} · ${daysUntil(status.expiresAt, now)}d left`;
  return status.planLabel;
}
```

- [ ] **Step 5: Add the mapping to `src/integrations/realdebrid.ts`**

Append (it still lives at the old path until Task 2 moves it):

```ts
import type { DebridStatus } from "./debrid/types";

/** `RealDebridUser` → the provider-blind `DebridStatus`. */
export function debridStatusFromRealDebridUser(user: RealDebridUser, now: Date): DebridStatus {
  const active = isPremiumActive(user);
  let expiresAt: Date | null = null;
  if (active) {
    const fromSeconds = new Date(now.getTime() + (user.premium ?? 0) * 1000);
    if (user.expiration) {
      const parsed = new Date(user.expiration);
      expiresAt = Number.isNaN(parsed.getTime()) ? fromSeconds : parsed;
    } else {
      expiresAt = fromSeconds;
    }
  }
  return {
    provider: "realdebrid",
    username: user.username,
    active,
    planLabel: active ? "premium" : "free",
    expiresAt,
  };
}
```

- [ ] **Step 6: Run the new test to verify it passes**

Run: `npx vitest run src/integrations/debrid/status.test.ts`
Expected: PASS (all 9 tests).

- [ ] **Step 7: Migrate every `RdStatus` consumer**

Delete `src/integrations/rdStatus.ts` and `src/integrations/rdStatus.test.ts`, then rewrite the imports. Use `\b`-anchored replacements, never bare-string `sed`:

```bash
perl -pi -e 's/\bRdStatus\b/DebridStatus/g; s/\bpremiumExpiringSoon\b/expiringSoon/g; s/\brdStatusFromUser\b/debridStatusFromRealDebridUser/g' \
  src/ui/store.ts src/ui/components/RdBadge.tsx src/ui/components/TokenPrompt.tsx \
  src/ui/components/Accounts.tsx src/core/streamRoute.ts src/web/routes.ts src/ui/App.tsx
```

Then fix each import path by hand — `../integrations/rdStatus` becomes `../integrations/debrid/status` for the functions and `../integrations/debrid/types` for the type; `debridStatusFromRealDebridUser` comes from `../integrations/realdebrid`.

The two field renames are **not** mechanical and must be done by hand, because `status.premium` is a boolean but `user.premium` is a number of seconds — a blind rename would corrupt `realdebrid.ts`. In the seven files above only:

- `status.premium` → `status.active`
- `status.premiumUntil` → `status.expiresAt`

Sites: `src/ui/components/RdBadge.tsx:10,13,15`, `src/core/streamRoute.ts:15`, plus anywhere `npm run typecheck` reports.

- [ ] **Step 8: Verify the whole suite and check no negative assertion went vacuous**

```bash
grep -rn "not.toContain\|not.toBe" src --include='*.ts' --include='*.tsx' | grep -i "rdstatus\|premiumUntil\|premiumExpiring" | cut -c1-140
npm test && npm run typecheck && npm run lint
```
Expected: the grep prints nothing; the suite is green.

- [ ] **Step 9: Commit**

```bash
git add -A src/integrations src/ui src/core src/web
git commit -m "refactor: provider-blind DebridStatus replaces RdStatus

RdStatus had eight consumers across ui/, core/ and web/, all keyed to
Real-Debrid's account shape. A second provider needs a neutral type, so this
moves the presentation layer to src/integrations/debrid/status.ts and maps
RealDebridUser into it at the integration boundary.

No behaviour change: planLabel is lowercase so every formatAccountStatus
string is preserved byte-for-byte."
```

---

### Task 2: Move the Real-Debrid client behind the interface

**Files:**
- Create: `src/integrations/debrid/realdebrid.ts` (moved), `src/integrations/debrid/realdebrid.test.ts` (moved), `src/integrations/debrid/index.ts`
- Delete: `src/integrations/realdebrid.ts`, `src/integrations/realdebrid.test.ts`
- Modify: `src/integrations/rdStatus`-free consumers of `ResolvedFile` — `src/download/http.ts:6`, `src/ui/components/StreamFilePrompt.tsx:6`, `src/util/player.test.ts`, `src/download/http.test.ts`, `src/ui/components/StreamFilePrompt.test.tsx`; plus `src/core/streamSession.ts:3-4`, `src/download/queue.ts:19`, `src/web/routes.ts:35`, `src/ui/App.tsx:19,22`, `src/daemon/runtime.test.ts:124`

**Interfaces:**
- Consumes: Task 1's `DebridProvider`, `DebridStatus`.
- Produces: `realDebridProvider: DebridProvider`; `getDebridProvider(id): DebridProvider`; `DEBRID_PROVIDER_IDS: readonly DebridProviderId[]`.

- [ ] **Step 1: Write the failing test**

Append to `src/integrations/debrid/status.test.ts`:

```ts
import { getDebridProvider, DEBRID_PROVIDER_IDS } from "./index";

describe("the debrid provider registry", () => {
  it("returns the Real-Debrid provider with its UI metadata", () => {
    const p = getDebridProvider("realdebrid");
    expect(p.id).toBe("realdebrid");
    expect(p.label).toBe("Real-Debrid");
    expect(p.shortLabel).toBe("RD");
    expect(p.tokenEnvVar).toBe("REALDEBRID_API_TOKEN");
  });

  it("does not offer a cached check for Real-Debrid — the endpoint was removed in 2024", () => {
    expect(getDebridProvider("realdebrid").checkCached).toBeUndefined();
  });

  it("lists every provider this build carries", () => {
    // TorBox joins this list in Task 6, when its client is real.
    expect([...DEBRID_PROVIDER_IDS]).toEqual(["realdebrid"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/integrations/debrid/status.test.ts`
Expected: FAIL — cannot resolve `./index`.

- [ ] **Step 3: Move the client and add its provider object**

```bash
git mv src/integrations/realdebrid.ts src/integrations/debrid/realdebrid.ts
git mv src/integrations/realdebrid.test.ts src/integrations/debrid/realdebrid.test.ts
```

In the moved `realdebrid.ts`, fix the relative imports (`../util/net` → `../../util/net`, `../util/logger` → `../../util/logger`, `../util/player` → `../../util/player`, `./debrid/types` → `./types`), delete the local `RequestOptions`/`ResolveOptions` declarations in favour of importing them from `./types`, keep `export type { RequestOptions, ResolveOptions }` re-exports so the moved test needs no rewrite, and append:

```ts
import type { DebridProvider } from "./types";

export const realDebridProvider: DebridProvider = {
  id: "realdebrid",
  label: "Real-Debrid",
  shortLabel: "RD",
  homepage: "real-debrid.com",
  tokenUrl: "https://real-debrid.com/apitoken",
  tokenEnvVar: "REALDEBRID_API_TOKEN",
  validateToken: async (token, opts) => debridStatusFromRealDebridUser(await validateToken(token, opts), new Date()),
  resolveMagnet,
  // No checkCached: Real-Debrid withdrew /torrents/instantAvailability in 2024.
  isTransient,
  isTokenRejection,
};
```

Fix the moved test's import path (`../util/net` → `../../util/net` etc.) and nothing else.

- [ ] **Step 4: Write `src/integrations/debrid/index.ts`**

**No TorBox stub.** The registry starts with Real-Debrid alone and Task 6 adds
TorBox once its client is real, so no commit on this branch ever contains a
provider whose methods reject with "not implemented".

```ts
import type { DebridProvider, DebridProviderId } from "./types";
import { realDebridProvider } from "./realdebrid";

/**
 * Every provider torlink can resolve through, in the order the accounts pane
 * lists them. Deliberately a runtime list and not `keyof`: the accounts pane
 * and the sources capability flag both iterate it.
 */
export const DEBRID_PROVIDER_IDS = ["realdebrid"] as const satisfies readonly DebridProviderId[];

const PROVIDERS: Partial<Record<DebridProviderId, DebridProvider>> = {
  realdebrid: realDebridProvider,
};

export function getDebridProvider(id: DebridProviderId): DebridProvider {
  const provider = PROVIDERS[id];
  // Reachable only from a hand-edited config naming a provider this build does
  // not carry; resolveActiveDebrid validates the id, so this is a type guard.
  if (!provider) throw new Error(`Unknown debrid provider: ${id}`);
  return provider;
}

export type { DebridProvider, DebridProviderId, DebridStatus, RequestOptions, ResolveOptions } from "./types";
```

- [ ] **Step 5: Point the `ResolvedFile` consumers at `StreamFile`**

`ResolvedFile` is a bare alias for `StreamFile` (`realdebrid.ts:23`), so it never needed to be an RD type:

```bash
perl -pi -e 's/\bResolvedFile\b/StreamFile/g' \
  src/download/http.ts src/ui/components/StreamFilePrompt.tsx \
  src/util/player.test.ts src/download/http.test.ts src/ui/components/StreamFilePrompt.test.tsx
```

Then change each of those five files' import to `import type { StreamFile } from "<relative>/util/player";` and delete the now-duplicate `StreamFile` import where one already existed. Keep `export type ResolvedFile = StreamFile;` in `debrid/realdebrid.ts` — the moved test uses it.

- [ ] **Step 6: Fix the remaining import paths**

The move breaks every importer of the old path. Find them all rather than
working from a list — Task 1 already turned up three consumers its own brief
had missed:

```bash
grep -rn "integrations/realdebrid\|\"\.\./realdebrid\"\|\"\./realdebrid\"" src scripts \
  --include='*.ts' --include='*.tsx' | cut -c1-140
```

Known at time of writing: `src/core/streamSession.ts:3-4`, `src/download/queue.ts:19`,
`src/web/routes.ts:34-35`, `src/ui/App.tsx:19-22`, `src/daemon/runtime.test.ts:124`,
`src/download/http.ts`, `src/ui/components/StreamFilePrompt.tsx` — all become
`"../integrations/debrid/realdebrid"`, depth-adjusted per file.

**One goes the other way.** `src/integrations/debrid/status.test.ts:4` currently
imports `debridStatusFromRealDebridUser` from `"../realdebrid"` (Task 1 had to
reach *up* out of `debrid/`, because the client had not moved yet). After the
move it is a sibling, so that import becomes `"./realdebrid"`. Missing this is a
compile error, not a silent bug — but it is the one import in the codebase whose
path gets *shorter*, so it is easy to skip when sweeping for the long form.

- [ ] **Step 7: Verify**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: all green. The suite should be the same count as before plus Task 2's 3 new tests.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor: Real-Debrid client behind a DebridProvider interface

git mv, so the diff stays reviewable. ResolvedFile was already a bare alias
for StreamFile, so its four consumers now name StreamFile directly and the
type stops belonging to Real-Debrid.

The registry carries Real-Debrid alone; TorBox joins it in Task 6, once its
client is real."
```

---

### Task 3: Migrate the persisted `via` enum

**Files:**
- Modify: `src/download/types.ts:23-27,66`, `src/download/persist.ts:22-40`, `src/download/history.ts:10-21,44-58`, `src/ui/downloadState.ts:24-29`
- Test: `src/download/persist.test.ts` (create if absent), `src/ui/downloadState.test.ts:33`

**Interfaces:**
- Produces: `DownloadVia = "p2p" | "debrid"`; `QueueItem.provider?: DebridProviderId`; `HistoryItem.provider?: DebridProviderId`; `normalizeVia(raw): { via?: DownloadVia; provider?: DebridProviderId }`; `deliveryMethod(via, provider)`.

Items written before providers existed are Real-Debrid by definition, so the migration is lossless.

- [ ] **Step 1: Write the failing test**

Create `src/download/persist.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { normalizeVia } from "./types";

describe("normalizeVia", () => {
  it("maps a legacy \"realdebrid\" item onto via+provider", () => {
    expect(normalizeVia("realdebrid")).toEqual({ via: "debrid", provider: "realdebrid" });
  });

  it("leaves a current \"debrid\" value alone and names no provider", () => {
    expect(normalizeVia("debrid")).toEqual({ via: "debrid" });
  });

  it("passes p2p through", () => {
    expect(normalizeVia("p2p")).toEqual({ via: "p2p" });
  });

  it("treats an absent or unrecognised value as p2p, the pre-debrid default", () => {
    expect(normalizeVia(undefined)).toEqual({ via: "p2p" });
    expect(normalizeVia("nonsense")).toEqual({ via: "p2p" });
  });
});
```

And in `src/ui/downloadState.test.ts`, replace the existing `deliveryMethod` assertions with:

```ts
it("badges each delivery method, including the legacy RD default", () => {
  expect(deliveryMethod("p2p", undefined)).toBe("P2P");
  expect(deliveryMethod(undefined, undefined)).toBe("P2P");
  expect(deliveryMethod("debrid", "realdebrid")).toBe("RD");
  expect(deliveryMethod("debrid", "torbox")).toBe("TB");
  // A debrid item with no recorded provider predates the provider field.
  expect(deliveryMethod("debrid", undefined)).toBe("RD");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/download/persist.test.ts src/ui/downloadState.test.ts`
Expected: FAIL — `normalizeVia` is not exported; `deliveryMethod` takes one argument.

- [ ] **Step 3: Update `src/download/types.ts`**

Replace lines 23-30 with:

```ts
import type { DebridProviderId } from "../integrations/debrid/types";

// How an item is being fetched: classic peer-to-peer (webtorrent) or via a
// debrid service (resolve the magnet to direct links, then download over HTTP).
// `provider` says which service; see normalizeVia for the legacy value.
export type DownloadVia = "p2p" | "debrid";

// Debrid downloads move through: "queued" (waiting for a concurrency slot),
// "resolving" (the provider caches the torrent on its cloud), then
// "downloading" (we pull the direct links).
export type DownloadPhase = "queued" | "resolving" | "downloading";

/**
 * Read a persisted `via`. Items written before TorBox support used
 * `"realdebrid"` as the whole value; those are Real-Debrid by definition, so
 * the migration is lossless. Anything unrecognised (including absent) is
 * "p2p", which is what an item written before debrid support at all was.
 */
export function normalizeVia(raw: unknown): { via?: DownloadVia; provider?: DebridProviderId } {
  if (raw === "realdebrid") return { via: "debrid", provider: "realdebrid" };
  if (raw === "debrid") return { via: "debrid" };
  return { via: "p2p" };
}
```

Then add `provider?: DebridProviderId;` to `QueueItem` beside `via` (`types.ts:66`), commented:

```ts
  // Which debrid service fetched this, when `via` is "debrid". Absent on a
  // debrid item means it predates the provider field, i.e. Real-Debrid.
  provider?: DebridProviderId;
```

- [ ] **Step 4: Apply the migration at both read points**

`src/download/persist.ts` — replace the `loadQueue` return (`:37`):

```ts
    return Array.isArray(parsed)
      ? parsed.filter(isQueueItem).map((it) => ({ ...it, ...normalizeVia((it as { via?: unknown }).via) }))
      : [];
```

with `import { normalizeVia, type QueueItem } from "./types";` at the top.

`src/download/history.ts` — add `provider?: DebridProviderId;` to `HistoryItem` beside `via` (`:16`), and replace the `loadHistory` return (`:53`):

```ts
    return Array.isArray(parsed)
      ? parsed
          .filter(isHistoryItem)
          .map((it) => ({ ...it, ...normalizeVia((it as { via?: unknown }).via) }))
          .slice(0, HISTORY_CAP)
      : [];
```

- [ ] **Step 5: Update `deliveryMethod`**

`src/ui/downloadState.ts:24-29`:

```ts
// Which delivery method a download uses, for the downloads-list badge. Absent
// `via` means a legacy/plain magnet, i.e. peer-to-peer. A debrid item with no
// `provider` predates that field and is Real-Debrid.
export function deliveryMethod(
  via: DownloadVia | undefined,
  provider: DebridProviderId | undefined,
): "RD" | "TB" | "P2P" {
  if (via !== "debrid") return "P2P";
  return provider === "torbox" ? "TB" : "RD";
}
```

- [ ] **Step 6: Fix the remaining `via: "realdebrid"` writers and readers**

```bash
grep -rn '"realdebrid"' src --include='*.ts' --include='*.tsx' | grep -v "integrations/debrid" | cut -c1-140
grep -rn "deliveryMethod(" src --include='*.tsx' --include='*.ts' | cut -c1-140
```

Every hit outside `src/integrations/debrid/` that concerns a download item becomes `via: "debrid"` plus a `provider`. `src/download/queue.ts:302` is the writer; Task 11 gives it a real provider — for now write `via: "debrid", provider: "realdebrid"`. Update every `deliveryMethod(...)` call site to pass `item.provider`.

- [ ] **Step 7: Verify**

Run: `npm test && npm run typecheck && npm run lint`
Expected: green.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: persisted download via becomes debrid + provider

One normalizeVia() at loadQueue and loadHistory maps the legacy
via: \"realdebrid\" onto { via: \"debrid\", provider: \"realdebrid\" }, so
existing queue and history files survive the upgrade unchanged."
```

---

## Phase 2 — the TorBox client

### Task 4: The TorBox client — request plumbing, error mapping, and `validateToken`

**Files:**
- Create: `src/integrations/debrid/torbox.ts`, `src/integrations/debrid/torbox.test.ts`

**Interfaces:**
- Consumes: Task 1's `DebridStatus`, `RequestOptions`.
- Produces: `TorBoxError` (with `status?`, `code?`), `TOKEN_REJECTED_MESSAGE`, `isTransient`, `isTokenRejection`, `validateToken`, and a module-private `request()`. Tasks 5 and 6 build on `request()`; Task 6 assembles these into `torBoxProvider` and registers it.

Two hazards land here. **TorBox returns `success: false` with HTTP 200** — RD's `request()` throws only on `!res.ok`, so a straight port reads failures as successes. And **`requestdl` puts the API key in the query string**, while RD's `request()` logs the path on every call (`realdebrid.ts:191,242,245`) — a port would log the token.

- [ ] **Step 1: Write the failing test**

Create `src/integrations/debrid/torbox.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isTokenRejection, isTransient, TOKEN_REJECTED_MESSAGE, validateToken } from "./torbox";
import { log } from "../../util/logger";

const TOKEN = "tb-secret-token-abc123";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** A JSON Response, hand-rolled so no network is involved. */
function jsonRes(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

/**
 * A fetch stub routing on pathname. Values are either a Response or a function
 * of the call count, so a poll sequence can change answer between attempts.
 */
function router(
  routes: Record<string, Response | ((n: number) => Response)>,
  calls: Call[],
): typeof fetch {
  const counts = new Map<string, number>();
  return ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const { pathname } = new URL(url);
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const route = routes[pathname];
    if (!route) return Promise.resolve(jsonRes(404, { success: false, error: "NOT_FOUND" }));
    const n = (counts.get(pathname) ?? 0) + 1;
    counts.set(pathname, n);
    return Promise.resolve(typeof route === "function" ? route(n) : route);
  }) as unknown as typeof fetch;
}

const noSleep = () => Promise.resolve();

describe("TorBox request plumbing", () => {
  it("sends the token as a bearer header, never in the query string", async () => {
    const calls: Call[] = [];
    const fetchImpl = router(
      { "/v1/api/user/me": jsonRes(200, { success: true, data: { email: "ada@example.com", plan: 2 } }) },
      calls,
    );
    await validateToken(TOKEN, { fetchImpl, sleepImpl: noSleep });
    expect(calls[0]!.headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]!.url).not.toContain(TOKEN);
  });

  it("throws when success is false even though the status is 200", async () => {
    const calls: Call[] = [];
    const fetchImpl = router(
      { "/v1/api/user/me": jsonRes(200, { success: false, error: "DATABASE_ERROR", detail: "try later" }) },
      calls,
    );
    await expect(
      validateToken(TOKEN, { fetchImpl, sleepImpl: noSleep, retries: 0 }),
    ).rejects.toThrow(/try later|DATABASE_ERROR/);
  });

  it("reports a rejected token from a 401", async () => {
    const calls: Call[] = [];
    const fetchImpl = router(
      { "/v1/api/user/me": jsonRes(401, { success: false, error: "BAD_TOKEN" }) },
      calls,
    );
    const err = await validateToken(TOKEN, { fetchImpl, sleepImpl: noSleep, retries: 0 })
      .catch((e: unknown) => e);
    expect(isTokenRejection(err)).toBe(true);
    expect((err as Error).message).toBe(TOKEN_REJECTED_MESSAGE);
  });

  it("reports a rejected token from AUTH_ERROR on a 200 envelope", async () => {
    const calls: Call[] = [];
    const fetchImpl = router(
      { "/v1/api/user/me": jsonRes(200, { success: false, error: "AUTH_ERROR" }) },
      calls,
    );
    const err = await validateToken(TOKEN, { fetchImpl, sleepImpl: noSleep, retries: 0 })
      .catch((e: unknown) => e);
    expect(isTokenRejection(err)).toBe(true);
  });

  it("classifies TorBox's rate limits as transient so an add is requeued", async () => {
    const calls: Call[] = [];
    for (const slug of ["TOO_MANY_REQUESTS", "MONTHLY_LIMIT", "ACTIVE_LIMIT"]) {
      const fetchImpl = router({ "/v1/api/user/me": jsonRes(200, { success: false, error: slug }) }, calls);
      const err = await validateToken(TOKEN, { fetchImpl, sleepImpl: noSleep, retries: 0 })
        .catch((e: unknown) => e);
      expect(isTransient(err), slug).toBe(true);
    }
  });

  it("does not treat a bad token as transient", async () => {
    const calls: Call[] = [];
    const fetchImpl = router({ "/v1/api/user/me": jsonRes(401, { success: false, error: "BAD_TOKEN" }) }, calls);
    const err = await validateToken(TOKEN, { fetchImpl, sleepImpl: noSleep, retries: 0 })
      .catch((e: unknown) => e);
    expect(isTransient(err)).toBe(false);
  });
});

describe("TorBox logging", () => {
  const spies: ReturnType<typeof vi.spyOn>[] = [];

  beforeEach(() => {
    for (const level of ["debug", "info", "warn", "error"] as const) {
      spies.push(vi.spyOn(log, level).mockImplementation(() => {}));
    }
  });

  afterEach(() => {
    for (const s of spies.splice(0)) s.mockRestore();
  });

  it("never writes the token to the log, even for a failing call", async () => {
    const calls: Call[] = [];
    const fetchImpl = router({ "/v1/api/user/me": jsonRes(500, { success: false, error: "OOPS" }) }, calls);
    await validateToken(TOKEN, { fetchImpl, sleepImpl: noSleep, retries: 0 }).catch(() => {});
    const logged = spies.flatMap((s) => s.mock.calls.flat()).join("\n");
    expect(logged).not.toContain(TOKEN);
    // Proves the assertion above is not vacuous — something WAS logged.
    expect(logged).toContain("torbox");
  });
});

describe("TorBox validateToken", () => {
  const NOW_ISO = "2026-08-20T00:00:00Z";

  async function statusFor(data: Record<string, unknown>) {
    const calls: Call[] = [];
    const fetchImpl = router({ "/v1/api/user/me": jsonRes(200, { success: true, data }) }, calls);
    return validateToken(TOKEN, { fetchImpl, sleepImpl: noSleep });
  }

  it("maps a Pro plan with an expiry", async () => {
    expect(await statusFor({ email: "ada@example.com", plan: 2, premiumExpiresAt: NOW_ISO })).toEqual({
      provider: "torbox",
      username: "ada@example.com",
      active: true,
      planLabel: "pro",
      expiresAt: new Date(NOW_ISO),
    });
  });

  it("labels each plan integer", async () => {
    expect((await statusFor({ email: "a@b.c", plan: 0 })).planLabel).toBe("free");
    expect((await statusFor({ email: "a@b.c", plan: 1 })).planLabel).toBe("essential");
    expect((await statusFor({ email: "a@b.c", plan: 3 })).planLabel).toBe("standard");
  });

  it("treats an unknown plan integer as active with a generic label", async () => {
    const s = await statusFor({ email: "a@b.c", plan: 9 });
    expect(s.active).toBe(true);
    expect(s.planLabel).toBe("plan 9");
  });

  // ASSUMPTION, unverified: TorBox's free tier can add (cached) torrents, so
  // active is true for plan 0. If it cannot, this becomes false and the
  // existing torrent-confirm path covers it with no other change.
  it("treats the free plan as able to add torrents", async () => {
    expect((await statusFor({ email: "a@b.c", plan: 0 })).active).toBe(true);
  });

  it("has no expiry when premiumExpiresAt is absent or unparseable", async () => {
    expect((await statusFor({ email: "a@b.c", plan: 2 })).expiresAt).toBeNull();
    expect((await statusFor({ email: "a@b.c", plan: 2, premiumExpiresAt: "nope" })).expiresAt).toBeNull();
  });

  it("falls back to a placeholder username when TorBox sends no email", async () => {
    expect((await statusFor({ plan: 2 })).username).toBe("TorBox account");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/integrations/debrid/torbox.test.ts`
Expected: FAIL — `src/integrations/debrid/torbox.ts` does not exist yet.

- [ ] **Step 3: Write the plumbing**

Create `src/integrations/debrid/torbox.ts`:

```ts
import { fetchResilient, HttpError, USER_AGENT } from "../../util/net";
import { log } from "../../util/logger";
import type { DebridProvider, RequestOptions } from "./types";

const BASE = "https://api.torbox.app/v1";

/** A user-facing failure from TorBox. `message` is safe to show in the UI. */
export class TorBoxError extends Error {
  status?: number;
  code?: string;
  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.name = "TorBoxError";
    this.status = status;
    this.code = code;
  }
}

export const TOKEN_REJECTED_MESSAGE = "TorBox rejected the token (invalid or expired).";

// HTTP statuses worth retrying (rate limit / transient server load).
const TRANSIENT_STATUS = new Set([429, 500, 502, 503, 504]);

// TorBox reports its own limits in the envelope's `error` slug rather than as a
// 429: 60/hour for uncached createtorrent, 300/minute otherwise. These are worth
// requeuing; a bad token or a dead magnet is not.
const TRANSIENT_SLUGS = new Set([
  "TOO_MANY_REQUESTS",
  "MONTHLY_LIMIT",
  "ACTIVE_LIMIT",
  "DATABASE_ERROR",
  "UNKNOWN_ERROR",
]);

const AUTH_SLUGS = new Set(["BAD_TOKEN", "AUTH_ERROR", "OAUTH_VERIFICATION_ERROR"]);

export function isTransient(e: unknown): boolean {
  if (!(e instanceof TorBoxError)) return false;
  if (e.status !== undefined && TRANSIENT_STATUS.has(e.status)) return true;
  return e.code !== undefined && TRANSIENT_SLUGS.has(e.code);
}

export function isTokenRejection(e: unknown): boolean {
  if (e instanceof TorBoxError) {
    if (e.status === 401 || e.status === 403) return true;
    if (e.code && AUTH_SLUGS.has(e.code)) return true;
  }
  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return msg.includes(TOKEN_REJECTED_MESSAGE);
}

function mapFailure(status: number | undefined, slug: string | undefined, detail: string | undefined): TorBoxError {
  if (status === 401 || status === 403 || (slug && AUTH_SLUGS.has(slug))) {
    return new TorBoxError(TOKEN_REJECTED_MESSAGE, status, slug);
  }
  if (slug === "TOO_MANY_REQUESTS" || slug === "ACTIVE_LIMIT") {
    return new TorBoxError("TorBox rate limit — wait a moment and retry.", status, slug);
  }
  if (slug === "MONTHLY_LIMIT") {
    return new TorBoxError("TorBox monthly download limit reached.", status, slug);
  }
  if (slug === "DOWNLOAD_TOO_LARGE") {
    return new TorBoxError("TorBox won't take this torrent — it exceeds your plan's size limit.", status, slug);
  }
  if (slug === "NO_SERVERS_AVAILABLE_ERROR") {
    return new TorBoxError("TorBox has no free servers — try again shortly.", status, slug);
  }
  // `detail` is TorBox's own human-readable sentence; prefer it when present.
  if (detail) return new TorBoxError(`TorBox: ${detail}`, status, slug);
  if (slug) return new TorBoxError(`TorBox error: ${slug}.`, status, slug);
  return new TorBoxError(`TorBox request failed${status ? ` (HTTP ${status})` : ""}.`, status, slug);
}

/** Every TorBox JSON response is wrapped in this. */
interface Envelope<T> {
  success?: boolean;
  error?: unknown;
  detail?: string;
  data?: T;
}

function slugOf(error: unknown): string | undefined {
  return typeof error === "string" ? error : undefined;
}

// Strip the query string before anything reaches the log. requestdl carries the
// API token as `?token=`, and RD's client logs the path on every call — a
// straight port of that would write the user's token to disk.
function logPath(path: string): string {
  const q = path.indexOf("?");
  return q === -1 ? path : `${path.slice(0, q)}?…`;
}

/**
 * One TorBox call, returning the envelope's `data`.
 *
 * TorBox answers `{success: false}` with HTTP 200, so unlike the Real-Debrid
 * client this cannot key off `res.ok` alone — the envelope is checked whatever
 * the status was.
 */
async function request<T>(
  token: string,
  method: "GET" | "POST",
  path: string,
  body: Record<string, string> | undefined,
  opts: RequestOptions,
): Promise<T> {
  const shown = logPath(path);
  log.debug(`torbox ${method} ${shown} →`);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "User-Agent": USER_AGENT,
  };
  let bodyStr: string | undefined;
  if (body) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    bodyStr = new URLSearchParams(body).toString();
  }

  let res: Response;
  try {
    res = await fetchResilient(`${BASE}${path}`, {
      method,
      headers,
      body: bodyStr,
      signal: opts.signal,
      fetchImpl: opts.fetchImpl,
      sleepImpl: opts.sleepImpl,
      retries: opts.retries ?? 2,
      retryCdn503: true,
      baseMs: 2000,
      capMs: 30000,
      minBackoffMs: 2000,
      onAttempt: ({ status, attempt, retries, retryAfterMs, willRetry }) =>
        log.warn(
          `torbox ${method} ${shown} status=${status} attempt=${attempt + 1}/${retries + 1}` +
            (retryAfterMs !== undefined ? ` retryAfter=${Math.round(retryAfterMs / 1000)}s` : "") +
            (willRetry ? " retrying" : " giving up"),
        ),
    });
  } catch (e) {
    if (e instanceof HttpError) {
      let slug: string | undefined;
      let detail: string | undefined;
      try {
        const parsed = JSON.parse(e.body ?? "") as Envelope<unknown>;
        slug = slugOf(parsed.error);
        detail = parsed.detail;
      } catch {
        /* body may be empty or non-JSON */
      }
      log.warn(`torbox ${method} ${shown} failed status=${e.status}${slug ? ` slug=${slug}` : ""}`);
      throw mapFailure(e.status, slug, detail);
    }
    log.warn(`torbox ${method} ${shown} error=${e instanceof Error ? e.message : String(e)}`);
    throw new TorBoxError(e instanceof Error ? e.message : String(e));
  }

  let env: Envelope<T>;
  try {
    env = (await res.json()) as Envelope<T>;
  } catch {
    if (!res.ok) throw mapFailure(res.status, undefined, undefined);
    throw new TorBoxError("TorBox returned a response torlink could not read.", res.status);
  }

  // The load-bearing difference from the Real-Debrid client: success is the
  // envelope's business, not the HTTP status's.
  if (!res.ok || env.success === false) {
    const slug = slugOf(env.error);
    log.warn(`torbox ${method} ${shown} failed status=${res.status}${slug ? ` slug=${slug}` : ""}`);
    throw mapFailure(res.status, slug, env.detail);
  }
  log.debug(`torbox ${method} ${shown} ${res.status}`);
  return env.data as T;
}

```

**No `torBoxProvider` object yet.** It is assembled in Task 6, once
`resolveMagnet` and `checkCached` exist and it is registered — so no commit on
this branch carries a provider whose methods reject. This task exports plain
functions, and its tests call them directly.

- [ ] **Step 4: Write `validateToken`, mapping `/api/user/me` onto `DebridStatus`**

TorBox's `/api/user/me` returns `{plan, premiumExpiresAt, email}`. Plans: `0`
Free, `1` Essential, `2` Pro, `3` Standard.

Append to `src/integrations/debrid/torbox.ts`:

```ts
// TorBox's plan integers, from its API docs. An unrecognised integer is
// labelled generically rather than guessed at.
const PLAN_LABELS: Record<number, string> = {
  0: "free",
  1: "essential",
  2: "pro",
  3: "standard",
};

interface TorBoxUser {
  email?: string;
  plan?: number;
  premiumExpiresAt?: string;
}

function parseDate(raw: string | undefined): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function validateToken(token: string, opts: RequestOptions): Promise<DebridStatus> {
  const user = await request<TorBoxUser>(token, "GET", "/api/user/me", undefined, opts);
  const plan = user?.plan ?? 0;
  return {
    provider: "torbox",
    // TorBox has no usernames; the account's email is what it identifies by.
    username: user?.email ?? "TorBox account",
    // ASSUMPTION, unverified against a live account: every TorBox plan —
    // including free (plan 0) — can add torrents, unlike Real-Debrid where a
    // non-premium account cannot. If the free tier turns out to refuse
    // torrents, this becomes `plan > 0` and classifyStreamRoute's existing
    // torrent-confirm path covers it with no other change.
    active: true,
    planLabel: PLAN_LABELS[plan] ?? `plan ${plan}`,
    expiresAt: parseDate(user?.premiumExpiresAt),
  };
}
```

Add `DebridStatus` to the type import at the top of the file.

Add `DebridStatus` to the type import at the top of the file.

- [ ] **Step 5: Run the whole TorBox suite to verify it passes**

Run: `npx vitest run src/integrations/debrid/torbox.test.ts`
Expected: PASS — plumbing, logging and validateToken. No test is skipped.

- [ ] **Step 6: Verify and commit**

```bash
npm test && npm run typecheck && npm run lint
git add -A
git commit -m "feat: TorBox client plumbing and token validation

TorBox answers success:false with HTTP 200, so unlike the Real-Debrid client
this checks the envelope whatever the status was. requestdl carries the API
key in the query string, so the log path is query-stripped — a straight port
of RD's per-call path logging would write the user's token to disk.

The free-plan-can-add-torrents assumption is unverified against a live
account and is commented as such at both the code and the test."
```

---

### Task 5: `resolveMagnet` — createtorrent, poll, requestdl

**Files:**
- Modify: `src/integrations/debrid/torbox.ts`
- Test: `src/integrations/debrid/torbox.test.ts`

**Interfaces:**
- Consumes: Task 4's `request()`.
- Produces: a working `resolveMagnet(token, magnet, opts): Promise<StreamFile[]>`.

Pipeline: `POST /api/torrents/createtorrent` → poll `GET /api/torrents/mylist?id=&bypass_cache=true` until `download_finished` → `GET /api/torrents/requestdl?token=&torrent_id=&file_id=` per file. There is no `selectFiles` equivalent.

Two hazards: **`progress` is a 0–1 float** while every `onProgress` consumer assumes 0–100 (CLAUDE.md records "a progress unit" as one of four drift bugs); and **`createtorrent` is not idempotent**, so like RD's `addMagnet` it runs with `retries: 0`.

- [ ] **Step 1: Write the failing test**

Append to `src/integrations/debrid/torbox.test.ts`:

```ts
const MAGNET = "magnet:?xt=urn:btih:aabbccddeeff00112233445566778899aabbccdd&dn=Kestrel.2010.1080p.BluRay.x264";
const HASH = "aabbccddeeff00112233445566778899aabbccdd";

const CREATE = "/v1/api/torrents/createtorrent";
const MYLIST = "/v1/api/torrents/mylist";
const REQUESTDL = "/v1/api/torrents/requestdl";

function torrent(over: Record<string, unknown> = {}) {
  return {
    id: 4242,
    hash: HASH,
    name: "Kestrel.2010.1080p.BluRay.x264",
    download_finished: true,
    download_present: true,
    progress: 1,
    files: [{ id: 0, name: "Kestrel.2010.1080p.BluRay.x264.mkv", size: 8_000_000_000 }],
    ...over,
  };
}

describe("TorBox resolveMagnet", () => {
  it("returns one StreamFile per file, with the direct URL", async () => {
    const calls: Call[] = [];
    const fetchImpl = router(
      {
        [CREATE]: jsonRes(200, { success: true, data: { torrent_id: 4242, hash: HASH } }),
        [MYLIST]: jsonRes(200, { success: true, data: torrent() }),
        [REQUESTDL]: jsonRes(200, { success: true, data: "https://cdn.torbox.app/dl/kestrel.mkv" }),
      },
      calls,
    );
    const files = await resolveMagnet(TOKEN, MAGNET, { fetchImpl, sleepImpl: noSleep });
    expect(files).toEqual([
      {
        url: "https://cdn.torbox.app/dl/kestrel.mkv",
        filename: "Kestrel.2010.1080p.BluRay.x264.mkv",
        bytes: 8_000_000_000,
      },
    ]);
    const create = calls.find((c) => c.url.includes("createtorrent"))!;
    expect(create.method).toBe("POST");
    expect(create.body).toContain(encodeURIComponent(MAGNET).slice(0, 20));
  });

  it("converts TorBox's 0-1 progress into the 0-100 every caller assumes", async () => {
    const calls: Call[] = [];
    const seen: number[] = [];
    const fetchImpl = router(
      {
        [CREATE]: jsonRes(200, { success: true, data: { torrent_id: 4242, hash: HASH } }),
        [MYLIST]: (n: number) =>
          n < 3
            ? jsonRes(200, { success: true, data: torrent({ download_finished: false, progress: n === 1 ? 0.25 : 0.5 }) })
            : jsonRes(200, { success: true, data: torrent() }),
        [REQUESTDL]: jsonRes(200, { success: true, data: "https://cdn.torbox.app/dl/kestrel.mkv" }),
      },
      calls,
    );
    await resolveMagnet(TOKEN, MAGNET, {
      fetchImpl,
      sleepImpl: noSleep,
      pollIntervalMs: 1,
      onProgress: (p) => seen.push(p),
    });
    expect(seen).toEqual([25, 50, 100]);
  });

  it("adds the magnet with no retries — a retry would duplicate the torrent", async () => {
    const calls: Call[] = [];
    const fetchImpl = router({ [CREATE]: jsonRes(503, { success: false, error: "OOPS" }) }, calls);
    await expect(
      resolveMagnet(TOKEN, MAGNET, { fetchImpl, sleepImpl: noSleep }),
    ).rejects.toThrow(/TorBox/);
    expect(calls.filter((c) => c.url.includes("createtorrent"))).toHaveLength(1);
  });

  it("accepts `id` as well as `torrent_id` in the createtorrent response", async () => {
    const calls: Call[] = [];
    const fetchImpl = router(
      {
        [CREATE]: jsonRes(200, { success: true, data: { id: 4242, hash: HASH } }),
        [MYLIST]: jsonRes(200, { success: true, data: torrent() }),
        [REQUESTDL]: jsonRes(200, { success: true, data: "https://cdn.torbox.app/dl/kestrel.mkv" }),
      },
      calls,
    );
    const files = await resolveMagnet(TOKEN, MAGNET, { fetchImpl, sleepImpl: noSleep });
    expect(files).toHaveLength(1);
  });

  it("fails clearly when createtorrent names no torrent id", async () => {
    const calls: Call[] = [];
    const fetchImpl = router({ [CREATE]: jsonRes(200, { success: true, data: { hash: HASH } }) }, calls);
    await expect(
      resolveMagnet(TOKEN, MAGNET, { fetchImpl, sleepImpl: noSleep }),
    ).rejects.toThrow(/did not return a torrent id/);
  });

  it("gives up when caching makes no progress for stallMs", async () => {
    const calls: Call[] = [];
    const fetchImpl = router(
      {
        [CREATE]: jsonRes(200, { success: true, data: { torrent_id: 4242, hash: HASH } }),
        [MYLIST]: jsonRes(200, { success: true, data: torrent({ download_finished: false, progress: 0.1 }) }),
      },
      calls,
    );
    await expect(
      resolveMagnet(TOKEN, MAGNET, {
        fetchImpl,
        sleepImpl: noSleep,
        pollIntervalMs: 10,
        stallMs: 30,
      }),
    ).rejects.toThrow(/no seeders|isn't caching/);
  });

  it("stops polling when the signal aborts", async () => {
    const calls: Call[] = [];
    const ctrl = new AbortController();
    const fetchImpl = router(
      {
        [CREATE]: jsonRes(200, { success: true, data: { torrent_id: 4242, hash: HASH } }),
        [MYLIST]: () => {
          ctrl.abort();
          return jsonRes(200, { success: true, data: torrent({ download_finished: false, progress: 0.1 }) });
        },
      },
      calls,
    );
    await expect(
      resolveMagnet(TOKEN, MAGNET, {
        fetchImpl,
        sleepImpl: noSleep,
        pollIntervalMs: 1,
        signal: ctrl.signal,
      }),
    ).rejects.toThrow(/cancelled/);
  });

  it("reports a torrent TorBox could not fetch", async () => {
    const calls: Call[] = [];
    const fetchImpl = router(
      {
        [CREATE]: jsonRes(200, { success: true, data: { torrent_id: 4242, hash: HASH } }),
        [MYLIST]: jsonRes(200, {
          success: true,
          data: torrent({ download_finished: false, download_state: "error", progress: 0 }),
        }),
      },
      calls,
    );
    await expect(
      resolveMagnet(TOKEN, MAGNET, { fetchImpl, sleepImpl: noSleep, pollIntervalMs: 1 }),
    ).rejects.toThrow(/TorBox couldn't/);
  });

  it("errors rather than returning an empty file list", async () => {
    const calls: Call[] = [];
    const fetchImpl = router(
      {
        [CREATE]: jsonRes(200, { success: true, data: { torrent_id: 4242, hash: HASH } }),
        [MYLIST]: jsonRes(200, { success: true, data: torrent({ files: [] }) }),
      },
      calls,
    );
    await expect(
      resolveMagnet(TOKEN, MAGNET, { fetchImpl, sleepImpl: noSleep }),
    ).rejects.toThrow(/no downloadable/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/integrations/debrid/torbox.test.ts -t "resolveMagnet"`
Expected: FAIL — `resolveMagnet` is not exported from `./torbox` yet.

- [ ] **Step 3: Implement**

In `src/integrations/debrid/torbox.ts` add:

```ts
import type { StreamFile } from "../../util/player";
import type { ResolveOptions } from "./types";

const DEFAULT_POLL_MS = 2000;

// Give up if TorBox reports no caching progress for this long (usually no
// seeders). Only inactivity counts — a torrent still making progress is never
// timed out. Same policy and value as the Real-Debrid client.
const DEFAULT_STALL_MS = 180_000;

// download_state values that mean "this will never finish".
const ERROR_STATES = new Set(["error", "stalled", "missingFiles", "uploading (no peers)"]);

interface TorBoxFile {
  id?: number;
  name?: string;
  short_name?: string;
  size?: number;
}

interface TorBoxTorrent {
  id?: number;
  hash?: string;
  name?: string;
  download_finished?: boolean;
  download_present?: boolean;
  download_state?: string;
  /** 0..1 fraction. Converted to 0-100 before it leaves this module. */
  progress?: number;
  files?: TorBoxFile[];
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new TorBoxError("TorBox request cancelled.");
}

async function createTorrent(token: string, magnet: string, opts: ResolveOptions): Promise<number> {
  // No retries: createtorrent isn't idempotent, and a retry after a transient
  // 5xx that actually succeeded would leave a duplicate in the account.
  const data = await request<Record<string, unknown>>(
    token,
    "POST",
    "/api/torrents/createtorrent",
    { magnet },
    { ...opts, retries: 0 },
  );
  // ASSUMPTION, unverified against a live account: the id arrives as
  // `torrent_id`. The SDK docs type `data` loosely, so `id` is accepted too and
  // a missing id fails loudly rather than being guessed at.
  const raw = data?.["torrent_id"] ?? data?.["id"];
  const id = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(id)) {
    throw new TorBoxError("TorBox did not return a torrent id for this magnet.");
  }
  return id;
}

async function getTorrent(token: string, id: number, opts: ResolveOptions): Promise<TorBoxTorrent> {
  const data = await request<TorBoxTorrent | TorBoxTorrent[]>(
    token,
    "GET",
    `/api/torrents/mylist?id=${id}&bypass_cache=true`,
    undefined,
    { ...opts, retries: opts.retries ?? 4 },
  );
  // mylist returns an object when queried by id and a list otherwise; accept both.
  return Array.isArray(data) ? (data[0] ?? {}) : (data ?? {});
}

async function requestDownloadLink(
  token: string,
  torrentId: number,
  fileId: number,
  opts: ResolveOptions,
): Promise<string> {
  // The token goes in the query string here — that is TorBox's contract for
  // this route. `request()` strips the query before logging.
  const url = await request<string>(
    token,
    "GET",
    `/api/torrents/requestdl?token=${encodeURIComponent(token)}&torrent_id=${torrentId}&file_id=${fileId}`,
    undefined,
    { ...opts, retries: opts.retries ?? 4 },
  );
  if (typeof url !== "string" || !url) {
    throw new TorBoxError("TorBox returned no download link for this file.");
  }
  return url;
}

/**
 * Drive a magnet through the full TorBox pipeline and return direct,
 * downloadable links:
 *   createtorrent → poll mylist until download_finished → requestdl per file.
 * `onProgress` reports TorBox-side caching progress as 0-100.
 */
export async function resolveMagnet(
  token: string,
  magnet: string,
  opts: ResolveOptions = {},
): Promise<StreamFile[]> {
  const {
    onProgress,
    pollIntervalMs = DEFAULT_POLL_MS,
    sleepImpl = realSleep,
    signal,
    stallMs = DEFAULT_STALL_MS,
  } = opts;

  throwIfAborted(signal);
  // No reuse-by-hash scan: createtorrent on a magnet already in the account
  // returns that torrent, so RD's five-page findTorrentByHash has no equivalent.
  const id = await createTorrent(token, magnet, opts);

  let torrent: TorBoxTorrent = {};
  let lastProgress = -1;
  let stalledMs = 0;
  for (;;) {
    throwIfAborted(signal);
    torrent = await getTorrent(token, id, opts);
    // TorBox reports progress as a 0..1 fraction; every onProgress consumer in
    // torlink assumes 0-100. Converted exactly once, here.
    const percent = Math.min(100, Math.max(0, Math.round((torrent.progress ?? 0) * 100)));
    onProgress?.(percent);
    if (torrent.download_finished === true && torrent.download_present === true) break;
    if (torrent.download_state && ERROR_STATES.has(torrent.download_state)) {
      throw new TorBoxError(
        `TorBox couldn't fetch this torrent (${torrent.download_state}) — it may have no seeders.`,
      );
    }
    if (percent > lastProgress) {
      lastProgress = percent;
      stalledMs = 0;
    } else {
      stalledMs += pollIntervalMs;
      if (stalledMs >= stallMs) {
        throw new TorBoxError(
          "TorBox isn't caching this torrent — it may have no seeders (removed or dead).",
        );
      }
    }
    await sleepImpl(pollIntervalMs);
  }
  onProgress?.(100);

  const files = torrent.files ?? [];
  if (files.length === 0) throw new TorBoxError("TorBox returned no downloadable files.");

  const out: StreamFile[] = [];
  for (const file of files) {
    throwIfAborted(signal);
    const fileId = file.id ?? 0;
    out.push({
      url: await requestDownloadLink(token, id, fileId, opts),
      filename: file.name ?? file.short_name ?? `file-${fileId}`,
      bytes: file.size ?? 0,
    });
  }
  return out;
}
```

Nothing wires it into a provider object yet — Task 6 assembles `torBoxProvider` once `checkCached` exists too.

Note on the progress test's expectation `[25, 50, 100]`: the loop emits `25` (poll 1), `50` (poll 2), `100` (poll 3, which finishes), and the trailing `onProgress?.(100)` would make a fourth. Change the loop so the trailing call is skipped when the last emitted value was already 100:

```ts
  if (lastProgress !== 100) onProgress?.(100);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/integrations/debrid/torbox.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

```bash
npm test && npm run typecheck && npm run lint
git add -A
git commit -m "feat: TorBox resolveMagnet — createtorrent, poll, requestdl

TorBox reports progress as a 0-1 fraction and every onProgress consumer in
torlink assumes 0-100; converted exactly once at the client boundary, with a
test. createtorrent runs with retries: 0 for the same reason RD's addMagnet
does — it is not idempotent."
```

---

### Task 6: `checkCached`, and registering TorBox

**Files:**
- Modify: `src/integrations/debrid/torbox.ts`, `src/integrations/debrid/index.ts`
- Test: `src/integrations/debrid/torbox.test.ts`, `src/integrations/debrid/status.test.ts`

**Interfaces:**
- Produces: `checkCached(token, hashes, opts): Promise<Set<string>>` returning lowercase hex hashes; `torBoxProvider` assembled from every piece; TorBox registered.

`GET /api/torrents/checkcached?hash=h1,h2&format=list`. TorBox returns an empty object *or* an empty list when nothing is cached, so both must parse.

- [ ] **Step 1: Write the failing test**

Append to `src/integrations/debrid/torbox.test.ts`:

```ts
const CHECKCACHED = "/v1/api/torrents/checkcached";
const HASH_B = "ffeeddccbbaa99887766554433221100ffeeddcc";

describe("TorBox checkCached", () => {
  it("returns the cached hashes, lowercased", async () => {
    const calls: Call[] = [];
    const fetchImpl = router(
      {
        [CHECKCACHED]: jsonRes(200, {
          success: true,
          data: [{ hash: HASH.toUpperCase(), name: "Kestrel.2010.1080p.BluRay.x264", size: 1 }],
        }),
      },
      calls,
    );
    const cached = await checkCached(TOKEN, [HASH, HASH_B], { fetchImpl, sleepImpl: noSleep });
    expect(cached.has(HASH)).toBe(true);
    expect(cached.has(HASH_B)).toBe(false);
    expect(calls[0]!.url).toContain(`hash=${HASH}%2C${HASH_B}`);
    expect(calls[0]!.url).toContain("format=list");
  });

  it("treats an empty object as nothing cached", async () => {
    const calls: Call[] = [];
    const fetchImpl = router({ [CHECKCACHED]: jsonRes(200, { success: true, data: {} }) }, calls);
    const cached = await checkCached(TOKEN, [HASH], { fetchImpl, sleepImpl: noSleep });
    expect(cached.size).toBe(0);
  });

  it("treats an empty list as nothing cached", async () => {
    const calls: Call[] = [];
    const fetchImpl = router({ [CHECKCACHED]: jsonRes(200, { success: true, data: [] }) }, calls);
    const cached = await checkCached(TOKEN, [HASH], { fetchImpl, sleepImpl: noSleep });
    expect(cached.size).toBe(0);
  });

  it("makes no request for an empty hash list", async () => {
    const calls: Call[] = [];
    const fetchImpl = router({}, calls);
    const cached = await checkCached(TOKEN, [], { fetchImpl, sleepImpl: noSleep });
    expect(cached.size).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/integrations/debrid/torbox.test.ts -t "checkCached"`
Expected: FAIL — `checkCached` is undefined on the provider.

- [ ] **Step 3: Implement**

```ts
/**
 * Which of `hashes` TorBox already has cached. Real-Debrid has no equivalent —
 * it withdrew /torrents/instantAvailability in 2024 — which is why this is
 * optional on `DebridProvider`.
 *
 * TorBox answers with an empty object OR an empty list when nothing is cached,
 * so both shapes parse to an empty set.
 */
export async function checkCached(
  token: string,
  hashes: string[],
  opts: RequestOptions = {},
): Promise<Set<string>> {
  if (hashes.length === 0) return new Set();
  const query = new URLSearchParams({ hash: hashes.join(","), format: "list" });
  const data = await request<unknown>(
    token,
    "GET",
    `/api/torrents/checkcached?${query.toString()}`,
    undefined,
    { ...opts, retries: opts.retries ?? 1 },
  );
  const rows = Array.isArray(data) ? data : [];
  const out = new Set<string>();
  for (const row of rows) {
    const hash = (row as { hash?: unknown } | null)?.hash;
    if (typeof hash === "string" && hash) out.add(hash.toLowerCase());
  }
  return out;
}
```

- [ ] **Step 4: Assemble `torBoxProvider` and register TorBox**

Every piece now exists, so the provider object is built once, with no rejecting
method, and joins the registry in the same commit.

Append to `src/integrations/debrid/torbox.ts`:

```ts
export const torBoxProvider: DebridProvider = {
  id: "torbox",
  label: "TorBox",
  shortLabel: "TB",
  homepage: "torbox.app",
  tokenUrl: "https://torbox.app/settings",
  tokenEnvVar: "TORBOX_API_TOKEN",
  validateToken,
  resolveMagnet,
  checkCached,
  isTransient,
  isTokenRejection,
};
```

In `src/integrations/debrid/index.ts`, add the import, extend the id list, and
add the map entry — the map can go back to a total `Record` now that both
providers are present:

```ts
import { torBoxProvider } from "./torbox";

export const DEBRID_PROVIDER_IDS = ["realdebrid", "torbox"] as const satisfies readonly DebridProviderId[];

const PROVIDERS: Record<DebridProviderId, DebridProvider> = {
  realdebrid: realDebridProvider,
  torbox: torBoxProvider,
};

export function getDebridProvider(id: DebridProviderId): DebridProvider {
  return PROVIDERS[id];
}
```

Update Task 2's registry test, which asserted the one-provider list:

```ts
  it("lists every provider id", () => {
    expect([...DEBRID_PROVIDER_IDS]).toEqual(["realdebrid", "torbox"]);
  });

  it("returns the TorBox provider, which can check cached availability", () => {
    const p = getDebridProvider("torbox");
    expect(p.label).toBe("TorBox");
    expect(p.shortLabel).toBe("TB");
    expect(p.tokenEnvVar).toBe("TORBOX_API_TOKEN");
    expect(p.checkCached).toBeDefined();
  });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/integrations/debrid/torbox.test.ts`
Expected: PASS.

- [ ] **Step 6: Verify and commit**

```bash
npm test && npm run typecheck && npm run lint
git add -A
git commit -m "feat: TorBox instant-availability check

Optional on DebridProvider because Real-Debrid has no equivalent: its
instant-availability endpoint was withdrawn in 2024. Absence of the method
is the capability flag."
```

---

## Phase 3 — config and the active provider

### Task 7: The second token and the provider preference

**Files:**
- Modify: `src/config/config.ts:21-77,96-104`
- Test: `src/config/config.test.ts`

**Interfaces:**
- Produces: `Config.torBoxToken`, `Config.debridProvider`; `resolveTorBoxToken(config)`; `resolveDebridTokenFor(config, provider)`; `resolveActiveDebrid(config): { provider: DebridProviderId; token: string } | null`. Every later task's provider lookup goes through `resolveActiveDebrid`.

- [ ] **Step 1: Write the failing test**

Append to `src/config/config.test.ts`. Note the existing suite's env-var hygiene: save and restore `process.env` around each case.

```ts
import { resolveActiveDebrid, resolveDebridTokenFor, resolveTorBoxToken } from "./config";

describe("resolveTorBoxToken", () => {
  const KEY = "TORBOX_API_TOKEN";
  let saved: string | undefined;
  beforeEach(() => { saved = process.env[KEY]; delete process.env[KEY]; });
  afterEach(() => { if (saved === undefined) delete process.env[KEY]; else process.env[KEY] = saved; });

  it("reads the persisted token", () => {
    expect(resolveTorBoxToken({ ...defaultConfig, torBoxToken: "  tb-1  " })).toBe("tb-1");
  });

  it("lets the env var win, so the token need never touch disk", () => {
    process.env[KEY] = " tb-env ";
    expect(resolveTorBoxToken({ ...defaultConfig, torBoxToken: "tb-file" })).toBe("tb-env");
  });

  it("is empty when neither is set", () => {
    expect(resolveTorBoxToken(defaultConfig)).toBe("");
  });
});

describe("resolveActiveDebrid", () => {
  const KEYS = ["REALDEBRID_API_TOKEN", "TORBOX_API_TOKEN"] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => { for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
  afterEach(() => {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; }
  });

  it("is null when no token is configured at all", () => {
    expect(resolveActiveDebrid(defaultConfig)).toBeNull();
  });

  it("uses the only configured provider, whichever it is", () => {
    expect(resolveActiveDebrid({ ...defaultConfig, realDebridToken: "rd-1" }))
      .toEqual({ provider: "realdebrid", token: "rd-1" });
    expect(resolveActiveDebrid({ ...defaultConfig, torBoxToken: "tb-1" }))
      .toEqual({ provider: "torbox", token: "tb-1" });
  });

  it("honours the explicit preference when both are configured", () => {
    const both = { ...defaultConfig, realDebridToken: "rd-1", torBoxToken: "tb-1" };
    expect(resolveActiveDebrid({ ...both, debridProvider: "torbox" }))
      .toEqual({ provider: "torbox", token: "tb-1" });
    expect(resolveActiveDebrid({ ...both, debridProvider: "realdebrid" }))
      .toEqual({ provider: "realdebrid", token: "rd-1" });
  });

  it("falls back to Real-Debrid when both are configured and nothing is preferred", () => {
    expect(resolveActiveDebrid({ ...defaultConfig, realDebridToken: "rd-1", torBoxToken: "tb-1" }))
      .toEqual({ provider: "realdebrid", token: "rd-1" });
  });

  it("ignores a preference whose token is missing rather than reporting nothing configured", () => {
    expect(resolveActiveDebrid({ ...defaultConfig, torBoxToken: "tb-1", debridProvider: "realdebrid" }))
      .toEqual({ provider: "torbox", token: "tb-1" });
  });

  it("ignores a hand-edited nonsense preference", () => {
    const cfg = { ...defaultConfig, realDebridToken: "rd-1", debridProvider: "nonsense" as never };
    expect(resolveActiveDebrid(cfg)).toEqual({ provider: "realdebrid", token: "rd-1" });
  });

  it("counts an env-only token, so a preference works with nothing on disk", () => {
    process.env["TORBOX_API_TOKEN"] = "tb-env";
    expect(resolveActiveDebrid({ ...defaultConfig, debridProvider: "torbox" }))
      .toEqual({ provider: "torbox", token: "tb-env" });
  });
});

describe("resolveDebridTokenFor", () => {
  it("reads the token for a named provider", () => {
    const cfg = { ...defaultConfig, realDebridToken: "rd-1", torBoxToken: "tb-1" };
    expect(resolveDebridTokenFor(cfg, "realdebrid")).toBe("rd-1");
    expect(resolveDebridTokenFor(cfg, "torbox")).toBe("tb-1");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/config/config.test.ts`
Expected: FAIL — the three functions are not exported.

- [ ] **Step 3: Implement**

In `src/config/config.ts`, add to `Config` beside `realDebridToken` (`:26`):

```ts
  // TorBox API token. Stored as-is in config.json, same trade-off as
  // realDebridToken above; a TORBOX_API_TOKEN env var overrides it at read time.
  torBoxToken?: string;
  // Which debrid service resolves magnets when more than one token is set.
  // Stored as an opaque string: an unrecognised value is ignored rather than
  // treated as "nothing configured" (see resolveActiveDebrid).
  debridProvider?: string;
```

And after `resolveRealDebridToken` (`:104`):

```ts
const TORBOX_TOKEN_ENV = "TORBOX_API_TOKEN";

export function resolveTorBoxToken(config: Config): string {
  const env = process.env[TORBOX_TOKEN_ENV];
  return (env?.trim() || config.torBoxToken?.trim()) ?? "";
}

export function resolveDebridTokenFor(config: Config, provider: DebridProviderId): string {
  return provider === "torbox" ? resolveTorBoxToken(config) : resolveRealDebridToken(config);
}

/**
 * The debrid provider that will actually resolve a magnet, and its token — the
 * single read point for that decision.
 *
 * The explicit `debridProvider` preference wins, but only if its token
 * resolves: a preference pointing at a provider the user has since signed out
 * of must not read as "no debrid configured", which would silently route a
 * stream into a public swarm. Otherwise the one configured provider is used,
 * and with both configured and no preference, Real-Debrid — the provider
 * torlink had first, so an upgrading user's behaviour does not change.
 */
export function resolveActiveDebrid(config: Config): { provider: DebridProviderId; token: string } | null {
  const preferred = config.debridProvider;
  if (preferred === "realdebrid" || preferred === "torbox") {
    const token = resolveDebridTokenFor(config, preferred);
    if (token) return { provider: preferred, token };
  }
  const rd = resolveRealDebridToken(config);
  if (rd) return { provider: "realdebrid", token: rd };
  const tb = resolveTorBoxToken(config);
  if (tb) return { provider: "torbox", token: tb };
  return null;
}
```

Import `DebridProviderId` from `../integrations/debrid/types`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/config/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

```bash
npm test && npm run typecheck && npm run lint
git add -A
git commit -m "feat: TorBox token and an explicit debrid provider preference

resolveActiveDebrid is the single read point. A preference pointing at a
provider whose token has gone is ignored rather than read as \"no debrid
configured\" — that would route a stream into a public swarm silently, the
one outcome the routing decision exists to prevent."
```

---

## Phase 4 — core wiring

### Task 8: Provider-aware stream routing

**Files:**
- Modify: `src/core/streamRoute.ts`
- Test: `src/core/streamRoute.test.ts`

**Interfaces:**
- Produces: `StreamRoute = { kind: "debrid"; provider: DebridProviderId } | { kind: "torrent-auto" } | { kind: "torrent-confirm"; reason: string }`.

- [ ] **Step 1: Write the failing test**

Replace `src/core/streamRoute.test.ts` with:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyStreamRoute } from "./streamRoute";
import { defaultConfig } from "../config/config";
import type { DebridStatus } from "../integrations/debrid/types";

function status(over: Partial<DebridStatus> = {}): DebridStatus {
  return { provider: "realdebrid", username: "ada", active: true, planLabel: "premium", expiresAt: null, ...over };
}

describe("classifyStreamRoute", () => {
  const KEYS = ["REALDEBRID_API_TOKEN", "TORBOX_API_TOKEN"] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => { for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
  afterEach(() => {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; }
  });

  it("auto-routes to a torrent when no debrid is configured", () => {
    expect(classifyStreamRoute(defaultConfig, null)).toEqual({ kind: "torrent-auto" });
  });

  it("routes to the active provider", () => {
    expect(classifyStreamRoute({ ...defaultConfig, realDebridToken: "rd-1" }, status()))
      .toEqual({ kind: "debrid", provider: "realdebrid" });
    expect(classifyStreamRoute({ ...defaultConfig, torBoxToken: "tb-1" }, status({ provider: "torbox" })))
      .toEqual({ kind: "debrid", provider: "torbox" });
  });

  it("routes to the provider even when the status is unknown", () => {
    expect(classifyStreamRoute({ ...defaultConfig, torBoxToken: "tb-1" }, null))
      .toEqual({ kind: "debrid", provider: "torbox" });
  });

  it("demands a confirm, naming the provider, when the account cannot add torrents", () => {
    expect(classifyStreamRoute({ ...defaultConfig, realDebridToken: "rd-1" }, status({ active: false })))
      .toEqual({ kind: "torrent-confirm", reason: "your Real-Debrid plan isn't active" });
    expect(
      classifyStreamRoute(
        { ...defaultConfig, torBoxToken: "tb-1" },
        status({ provider: "torbox", active: false, planLabel: "free" }),
      ),
    ).toEqual({ kind: "torrent-confirm", reason: "your TorBox plan isn't active" });
  });

  it("ignores a status belonging to a provider that is not the active one", () => {
    // A stale status left over from a provider switch must not refuse a stream.
    expect(classifyStreamRoute({ ...defaultConfig, torBoxToken: "tb-1" }, status({ active: false })))
      .toEqual({ kind: "debrid", provider: "torbox" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/streamRoute.test.ts`
Expected: FAIL — routes report `kind: "realdebrid"`.

- [ ] **Step 3: Implement**

```ts
import { type Config, resolveActiveDebrid } from "../config/config";
import { getDebridProvider } from "../integrations/debrid";
import type { DebridProviderId, DebridStatus } from "../integrations/debrid/types";

export type StreamRoute =
  | { kind: "debrid"; provider: DebridProviderId }
  | { kind: "torrent-auto" }
  | { kind: "torrent-confirm"; reason: string };

// Decide how `v` should stream, given debrid config + last-known account status.
// "Not configured" (no token) auto-routes to torrent; a present-but-inactive
// account is "configured but not working" and requires an explicit confirm so we
// never silently expose the user's IP after they set a provider up.
export function classifyStreamRoute(config: Config, status: DebridStatus | null): StreamRoute {
  const active = resolveActiveDebrid(config);
  if (!active) return { kind: "torrent-auto" };
  // A status from a different provider is stale (the user switched); it says
  // nothing about the active account, so it must not refuse the stream.
  if (status && status.provider === active.provider && !status.active) {
    return {
      kind: "torrent-confirm",
      reason: `your ${getDebridProvider(active.provider).label} plan isn't active`,
    };
  }
  return { kind: "debrid", provider: active.provider };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/streamRoute.test.ts`
Expected: PASS.

- [ ] **Step 5: Fix the callers**

`npm run typecheck` will point at `src/ui/App.tsx:1341` and `src/web/routes.ts:369`, each testing `route.kind === "realdebrid"`. Change both to `"debrid"`. Leave the rest of their logic for Tasks 12–14.

- [ ] **Step 6: Verify and commit**

```bash
npm test && npm run typecheck && npm run lint
git add -A
git commit -m "feat: stream routing names the active debrid provider

The refusal reason is built from the provider's label, and a status belonging
to a provider that is no longer active is ignored rather than used to refuse
a stream."
```

---

### Task 9: Provider-aware stream sessions

**Files:**
- Modify: `src/core/streamSession.ts:3-9,35-39,49-60,120-157`, `src/web/stream.ts:327`
- Test: `src/core/streamSession.test.ts:222+`

**Interfaces:**
- Produces: `StreamBackend = "debrid" | "torrent"`; `StreamSession.provider?: DebridProviderId`; `StartStreamInput.debridProvider?`; `ResolveDebridImpl = (provider, token, magnet, opts) => Promise<StreamFile[]>`; `NO_DEBRID_TOKEN`.

- [ ] **Step 1: Write the failing test**

In `src/core/streamSession.test.ts`, rename the `describe("StreamSessionRegistry — Real-Debrid route")` block to `"— debrid route"` and add:

```ts
it("records which provider served the session and passes it to the resolver", async () => {
  const seen: string[] = [];
  const registry = new StreamSessionRegistry({
    resolveDebridImpl: (provider, _token, _magnet) => {
      seen.push(provider);
      return Promise.resolve([{ url: "https://cdn.torbox.app/dl/a.mkv", filename: "a.mkv", bytes: 1 }]);
    },
  });
  const session = await registry.start({
    infoHash: "aabb",
    magnet: "magnet:?xt=urn:btih:aabb",
    name: "Kepler.S02E04.1080p.WEB-DL",
    route: { kind: "debrid", provider: "torbox" },
    debridToken: "tb-1",
    debridProvider: "torbox",
  });
  expect(session.backend).toBe("debrid");
  expect(session.provider).toBe("torbox");
  expect(session.state).toBe("ready");
  expect(seen).toEqual(["torbox"]);
});

it("errors rather than falling back to P2P when the token is missing", async () => {
  const registry = new StreamSessionRegistry({
    resolveDebridImpl: () => Promise.reject(new Error("should not be called")),
  });
  const session = await registry.start({
    infoHash: "aabb",
    magnet: "magnet:?xt=urn:btih:aabb",
    name: "Harrowgate.S03.1080p.WEB-DL",
    route: { kind: "debrid", provider: "torbox" },
  });
  expect(session.state).toBe("error");
  expect(session.error).toBe(NO_DEBRID_TOKEN);
});
```

Update the existing tests in that block to pass `route: { kind: "debrid", provider: "realdebrid" }` and the 4-argument `resolveDebridImpl`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/core/streamSession.test.ts`
Expected: FAIL — `route.kind` "debrid" is not assignable, `provider` is not on `StreamSession`.

- [ ] **Step 3: Implement**

In `src/core/streamSession.ts`:

```ts
import { getDebridProvider } from "../integrations/debrid";
import type { DebridProviderId, ResolveOptions } from "../integrations/debrid/types";

export type StreamBackend = "debrid" | "torrent";

export type ResolveDebridImpl = (
  provider: DebridProviderId,
  token: string,
  magnet: string,
  opts: ResolveOptions,
) => Promise<StreamFile[]>;

export const NO_DEBRID_TOKEN = "No debrid token configured for this stream.";
```

Add to `StreamSession`, beside `backend`:

```ts
  // Which debrid service served it, when `backend` is "debrid".
  provider?: DebridProviderId;
```

Add to `StartStreamInput`, beside `debridToken`:

```ts
  // Which provider `debridToken` belongs to. Required for the debrid route.
  debridProvider?: DebridProviderId;
```

Default the impl through the registry (`:82`):

```ts
    this.resolveDebridImpl =
      deps.resolveDebridImpl ??
      ((provider, token, magnet, opts) => getDebridProvider(provider).resolveMagnet(token, magnet, opts));
```

In `begin()` (`:121-126`):

```ts
    const viaDebrid = input.route.kind === "debrid";
    const session: StreamSession = {
      // …
      backend: viaDebrid ? "debrid" : "torrent",
      ...(viaDebrid && input.route.kind === "debrid" ? { provider: input.route.provider } : {}),
      // …
    };
```

In `resolveInto()` (`:147-157`):

```ts
    const viaDebrid = input.route.kind === "debrid";
    try {
      if (viaDebrid) {
        const provider = input.debridProvider ?? (input.route.kind === "debrid" ? input.route.provider : undefined);
        if (!input.debridToken || !provider) throw new Error(NO_DEBRID_TOKEN);
        session.files = await this.resolveDebridImpl(provider, input.debridToken, input.magnet, {
          knownHash: input.infoHash,
          signal: abort.signal,
          onProgress: (percent) => {
            session.progress = percent;
          },
        });
      } else {
```

In `src/web/stream.ts:327`, change `session.backend === "realdebrid"` to `session.backend === "debrid"`. Reword the comments at `:12`, `:221`, `:282` from "Real-Debrid" to "the debrid provider" — the contract (a time-limited credential, `Cache-Control: no-store`) is unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/streamSession.test.ts src/web/stream.test.ts`
Expected: PASS. If `stream.test.ts` fails, it is asserting the old `backend` literal — update it.

- [ ] **Step 5: Check the negative assertions still bite**

```bash
grep -rn "not.toContain\|not.toBe" src/web/stream.test.ts src/web/routes.test.ts | cut -c1-140
```
Confirm each still names a string the test actually puts in play. In particular `stream.test.ts:856` ("never writes a Real-Debrid link into the file") must still use a URL the test really resolves — if its fixture URL changed, the assertion is vacuous.

- [ ] **Step 6: Verify and commit**

```bash
npm test && npm run typecheck && npm run lint && npm run build
git add -A
git commit -m "feat: stream sessions carry a debrid provider

StreamBackend collapses realdebrid to debrid; the session records which
provider served it, and ResolveDebridImpl dispatches through the registry."
```

---

### Task 10: Provider-aware download queue

**Files:**
- Modify: `src/download/queue.ts:30-37,67-121,271-317,323-374,379-433,437-470,1037-1043`, `src/daemon/runtime.ts:9,46,60-64,116-125,152-156`
- Test: `src/download/queue.test.ts:118+`, `src/daemon/runtime.test.ts:97-99,181`, `src/daemon/serve.test.ts:8`

**Interfaces:**
- Produces: `DebridDeps.resolveMagnet(provider, token, magnet, opts)`; `queue.setDebridToken(provider, token)`; `queue.addDebrid(input, dir, provider, token, deps?)`.

- [ ] **Step 1: Write the failing test**

In `src/download/queue.test.ts`, rename `describe("DownloadQueue Real-Debrid path")` to `"DownloadQueue debrid path"`, update every `resolveMagnet` stub to the 4-argument form and every `addDebrid` call to pass a provider, then add:

```ts
it("records the provider on the item and in history", async () => {
  const deps: DebridDeps = {
    resolveMagnet: (provider, _t, _m) => {
      expect(provider).toBe("torbox");
      return Promise.resolve([{ url: "https://cdn.torbox.app/dl/a.mkv", filename: "a.mkv", bytes: 10 }]);
    },
    downloadFiles: () => Promise.resolve(),
  };
  const queue = makeQueue();
  await queue.addDebrid(
    { id: HASH, name: "Kestrel.2010.1080p.BluRay.x264", magnet: MAGNET },
    "/tmp/dl",
    "torbox",
    "tb-1",
    deps,
  );
  const entry = queue.historyItems().find((h) => h.id === HASH)!;
  expect(entry.via).toBe("debrid");
  expect(entry.provider).toBe("torbox");
});

it("classifies a transient failure using the ACTIVE provider's rules", async () => {
  // A TorBox rate limit is transient; RD's isTransient would not recognise it,
  // so a shared classifier would fail the item instead of requeuing it.
  let attempts = 0;
  const deps: DebridDeps = {
    resolveMagnet: () => {
      attempts += 1;
      if (attempts === 1) {
        const e = new TorBoxError("TorBox rate limit — wait a moment and retry.", 200, "TOO_MANY_REQUESTS");
        return Promise.reject(e);
      }
      return Promise.resolve([{ url: "https://cdn.torbox.app/dl/a.mkv", filename: "a.mkv", bytes: 10 }]);
    },
    downloadFiles: () => Promise.resolve(),
    sleep: () => Promise.resolve(),
  };
  const queue = makeQueue();
  await queue.addDebrid(
    { id: HASH, name: "Ashfall.1999.1080p", magnet: MAGNET },
    "/tmp/dl",
    "torbox",
    "tb-1",
    deps,
  );
  expect(attempts).toBe(2);
  expect(queue.historyItems().some((h) => h.id === HASH)).toBe(true);
});
```

(`makeQueue`, `HASH`, `MAGNET` and `historyItems` follow the existing helpers in that file; reuse them rather than adding new ones. Import `TorBoxError` from `../integrations/debrid/torbox`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/download/queue.test.ts`
Expected: FAIL — `addDebrid` takes 4 arguments, `resolveMagnet` takes 3.

- [ ] **Step 3: Implement**

In `src/download/queue.ts`:

```ts
// :19 — replace the realdebrid import
import { getDebridProvider } from "../integrations/debrid";
import type { DebridProviderId } from "../integrations/debrid/types";

// :30-37
export interface DebridDeps {
  resolveMagnet: (
    provider: DebridProviderId,
    token: string,
    magnet: string,
    opts: ResolveOptions,
  ) => Promise<StreamFile[]>;
  downloadFiles: typeof downloadFiles;
  sleep?: (ms: number) => Promise<void>;
}

export const defaultDebridDeps: DebridDeps = {
  resolveMagnet: (provider, token, magnet, opts) =>
    getDebridProvider(provider).resolveMagnet(token, magnet, opts),
  downloadFiles,
};
```

Replace the per-queue `debridToken` field with `debridAuth: { provider: DebridProviderId; token: string } | null = null` (`:114-121`), and:

```ts
  // Keep the queue's notion of the active debrid provider and token in sync with
  // config so a retry (which has neither in hand) can re-run the pipeline.
  setDebridToken(provider: DebridProviderId | null, token: string): void {
    this.debridAuth = provider && token ? { provider, token } : null;
  }
```

`addDebrid` (`:279`) gains a `provider: DebridProviderId` parameter before `token`, sets `this.debridAuth = { provider, token }`, writes `via: "debrid", provider` on the item (`:302`), and passes the provider down to `driveDebrid`/`runDebrid`. In `runDebrid` (`:388`):

```ts
      const files = await deps.resolveMagnet(provider, token, this.items.get(id)?.magnet ?? "", {
```

Transient classification (`driveDebrid`, `:355-358`) becomes provider-specific:

```ts
        if (getDebridProvider(provider).isTransient(e) && attempt < MAX_DEBRID_ATTEMPTS) {
```

Rename the private log helper `rdLabel` to `debridLabel` and drop "Real-Debrid" from its message strings. The restart-reconciliation copy (`:1037-1043`) becomes provider-derived:

```ts
      it.error = `Interrupted — download again via ${getDebridProvider(it.provider ?? "realdebrid").label}.`;
```

Update every `resume`/`retry` path (`:723-739`, `:859-873`) to read `this.debridAuth` and bail with a clear error when it is null.

In `src/daemon/runtime.ts`: `:60-64` becomes `queue.setDebridToken(active?.provider ?? null, active?.token ?? "")` from `resolveActiveDebrid(cfg)`; `:46`'s banner reports the active provider's label or "off"; `:116-125`'s add options carry `debridProvider` beside `debridToken`; `:152-156` passes both to `addDebrid`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/download/queue.test.ts src/daemon`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

```bash
npm test && npm run typecheck && npm run lint
git add -A
git commit -m "feat: download queue resolves through the active debrid provider

Transient classification is the provider's own: a TorBox rate limit arrives
as a success:false envelope slug that RD's isTransient would not recognise,
so a shared classifier would fail the item instead of requeuing it."
```

---

## Phase 5 — the front ends

### Task 11: TUI — the accounts pane, the token prompt, and the badge

**Files:**
- Create: `src/ui/components/DebridBadge.tsx`
- Delete: `src/ui/components/RdBadge.tsx`
- Modify: `src/ui/components/Accounts.tsx`, `src/ui/components/TokenPrompt.tsx`
- Test: `src/ui/components/Accounts.test.tsx`

**Interfaces:**
- Produces: `DebridBadge({ status })`; `Accounts` props `debrid: DebridAccountProps[]` and `activeDebrid`; `TokenPrompt` prop `provider: DebridProvider`.

- [ ] **Step 1: Write the failing test**

Replace the Real-Debrid assertion in `src/ui/components/Accounts.test.tsx` with:

```ts
it("lists both debrid providers and marks the active one", () => {
  const { lastFrame } = render(<Accounts {...props()} />);
  const frame = lastFrame() ?? "";
  expect(frame).toContain("Real-Debrid");
  expect(frame).toContain("TorBox");
  expect(frame).toContain("active");
});

it("offers the make-active key only on a signed-in provider that is not already active", () => {
  const { lastFrame } = render(<Accounts {...props({ activeDebrid: "realdebrid" })} />);
  expect(lastFrame() ?? "").toContain("a use");
});
```

Extend that file's existing props helper with `debrid` rows for both providers (Real-Debrid signed in, TorBox signed in) and `activeDebrid: "realdebrid"`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/components/Accounts.test.tsx`
Expected: FAIL — "TorBox" is not in the frame.

- [ ] **Step 3: Write `src/ui/components/DebridBadge.tsx`**

```tsx
import { Text } from "ink";
import { COLOR, ICON } from "../theme";
import { daysUntil, expiringSoon } from "../../integrations/debrid/status";
import { getDebridProvider } from "../../integrations/debrid";
import type { DebridStatus } from "../../integrations/debrid/types";

// Compact, always-on debrid indicator for the header. Renders nothing when no
// account is known so the header stays clean before a token is set.
export function DebridBadge({ status }: { status: DebridStatus | null }) {
  if (!status) return null;
  const now = new Date();
  const tag = getDebridProvider(status.provider).shortLabel.toLowerCase();
  if (!status.active) {
    return <Text color={COLOR.warn}>{`${ICON.warn} ${tag} ${status.planLabel}`}</Text>;
  }
  if (status.expiresAt && expiringSoon(status, now)) {
    return (
      <Text color={COLOR.warn}>{`${ICON.warn} ${tag} ${status.username} · ${daysUntil(status.expiresAt, now)}d`}</Text>
    );
  }
  return <Text color={COLOR.good}>{`${ICON.done} ${tag} ${status.username}`}</Text>;
}
```

Then `git rm src/ui/components/RdBadge.tsx`.

- [ ] **Step 4: Generalise `Accounts.tsx`**

Replace the `rdToken`/`rdStatus`/`onManageRd`/`onSignOutRd` props with a list, so a third provider is data rather than code:

```tsx
export interface DebridAccountProps {
  provider: DebridProviderId;
  token: string;
  status: DebridStatus | null;
  envOverride?: boolean;
  onManage: () => void;
  onSignOut: () => void;
}

interface AccountsProps {
  debrid: DebridAccountProps[];
  /** Which provider actually resolves magnets, or null when none is configured. */
  activeDebrid: DebridProviderId | null;
  onSetActiveDebrid: (provider: DebridProviderId) => void;
  // …the rutracker / recc / omdb props unchanged
}
```

Add `activatable?: boolean` and `isActive?: boolean` to the local `Row` type, and build one row per entry:

```tsx
    ...debrid.map((d): Row => {
      const meta = getDebridProvider(d.provider);
      const isActive = activeDebrid === d.provider;
      return {
        tag: meta.shortLabel,
        color: COLOR.good,
        label: isActive ? `${meta.label}  ${ICON.dot} active` : meta.label,
        homepage: meta.homepage,
        signedIn: d.token !== "",
        ok: d.token !== "",
        status: `${formatAccountStatus(d.status, new Date())}${d.envOverride ? " · env override active" : ""}`,
        emptyStatus: "Not connected",
        verbSignedIn: "switch",
        verbSignOut: "sign out",
        verbSignedOut: "sign in",
        onManage: d.onManage,
        onSignOut: d.onSignOut,
        activatable: d.token !== "" && !isActive,
        isActive,
      };
    }),
```

Extend `useInput` with the make-active key, and render its hint beside the others:

```tsx
      else if (input === "a" && rows[clamped]!.activatable) rows[clamped]!.onActivate?.();
```

Add `onActivate?: () => void` to `Row` and set it to `() => onSetActiveDebrid(d.provider)`. In the signed-in hints block, after the `importable` branch:

```tsx
                    {r.activatable ? (
                      <Text>
                        <Text dimColor>{`  ${ICON.dot}  `}</Text>
                        <Text color={COLOR.alt}>a</Text>
                        <Text dimColor> use</Text>
                      </Text>
                    ) : null}
```

- [ ] **Step 5: Parameterise `TokenPrompt.tsx`**

Take a `provider: DebridProvider` prop and derive every string from it — nothing hardcodes "real-debrid":

```tsx
      <Panel title={`${provider.label.toLowerCase()} token`} width={width} focused height={2}>
```

```tsx
        <Text dimColor>
          Get a token at{" "}
          {hyperlink(provider.tokenUrl, provider.tokenUrl.replace(/^https?:\/\//, ""))}
        </Text>
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/ui/components`
Expected: PASS. `App.tsx` will not compile yet — Task 12 wires it.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(tui): accounts pane lists both debrid providers

One row per provider, built from the registry's metadata, with 'a' to make
the highlighted one active. TokenPrompt and the header badge derive every
string from DebridProvider, so a third provider is data rather than code."
```

---

### Task 12: TUI — store, keymap, and App wiring

**Files:**
- Modify: `src/ui/store.ts:168,183-184`, `src/ui/testHarness.ts:182-186`, `scripts/render-previews-impl.tsx:138-140`, `src/ui/keymap.ts:55,118,210`, `src/ui/App.tsx`, `src/ui/components/{Results,Downloads}.tsx`, `src/ui/views/Splash.tsx`
- Test: `src/ui/keymap.test.ts`, `src/ui/App.web.test.tsx`, `src/ui/views/Splash.test.tsx`

**Interfaces:**
- Produces: `Store.debridStatus`, `Store.debridProvider`, `Store.debridConfigured`; `footerHints(..., debridLabel?: string, ...)`.

A new/renamed `Store` field needs an entry in **both** `makeStore` (`scripts/render-previews-impl.tsx`) and `makeTestStore` (`src/ui/testHarness.ts`), or `npm run previews` and `npm run typecheck` respectively break.

- [ ] **Step 1: Write the failing test**

In `src/ui/keymap.test.ts`:

```ts
it("names the active provider in the footer hint", () => {
  const hints = footerHints("content", "search", null, null, "TorBox");
  expect(hints.find((h) => h.keys === "r")?.label).toBe("TorBox");
});

it("offers no debrid hint when none is configured", () => {
  expect(footerHints("content", "search", null, null, undefined).some((h) => h.keys === "r")).toBe(false);
});

it("keeps the r help entry provider-neutral", () => {
  const entries = HELP_GROUPS.flatMap((g) => g.hints);
  expect(entries.find((h) => h.keys === "r")?.label).toBe("Download via debrid (Real-Debrid / TorBox)");
});

it("documents the accounts make-active key", () => {
  const entries = HELP_GROUPS.flatMap((g) => g.hints);
  expect(entries.some((h) => h.keys === "a")).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/keymap.test.ts`
Expected: FAIL — `footerHints`'s 5th parameter is a boolean; the `r` label still says "Download via Real-Debrid".

- [ ] **Step 3: Update `keymap.ts`**

`:55` → `{ keys: "r", label: "Download via debrid (Real-Debrid / TorBox)" }`. Add to the accounts group: `{ keys: "a", label: "Make the highlighted debrid provider active" }`. Change the `debridConfigured = false` parameter (`:118`) to `debridLabel?: string`, and `:210` to:

```ts
    ...(debridLabel ? [{ keys: "r", label: debridLabel }] : []),
```

- [ ] **Step 4: Update the store and both fixtures**

`src/ui/store.ts`: rename `rdStatus` → `debridStatus`, add:

```ts
  // Which debrid service resolves magnets, or null when none is configured.
  debridProvider: DebridProviderId | null;
```

Keep `debridConfigured` and its comment, reworded to "a debrid token".

Add matching entries to `makeTestStore` (`src/ui/testHarness.ts:182-186`) and `makeStore` (`scripts/render-previews-impl.tsx:138-140`): `debridStatus: null, debridProvider: null`.

- [ ] **Step 5: Update `App.tsx`**

Rename `rdStatus` state → `debridStatus`. Replace `setRealDebridToken`/`clearRealDebridToken` with provider-parameterised versions, keeping the env-var refusal:

```tsx
  const setDebridToken = useCallback(
    (provider: DebridProviderId, raw: string) => {
      closeTokenPrompt();
      if (!config) return;
      const meta = getDebridProvider(provider);
      const token = raw.trim();
      if (!token) {
        setNotice(`${meta.label} token unchanged.`);
        return;
      }
      const field = provider === "torbox" ? "torBoxToken" : "realDebridToken";
      // First token set also becomes the active provider: the user just
      // configured it, so silently leaving the other one in charge would be
      // the opposite of what they asked for.
      const next: Config = { ...config, [field]: token };
      if (!resolveActiveDebrid(config)) next.debridProvider = provider;
      setConfig(next);
      void (async () => {
        try {
          const status = await meta.validateToken(token);
          setDebridStatus(status);
          if (!status.active) {
            setNotice(`${meta.label}: ${status.username}'s ${status.planLabel} account can't add torrents.`);
            return;
          }
          setNotice(`${ICON.done} ${meta.label} connected as ${status.username}`);
        } catch (e) {
          setDebridStatus(null);
          setNotice(`${meta.label}: ${e instanceof Error ? e.message : "could not validate token"}`);
        }
      })();
    },
    [config, setConfig, closeTokenPrompt],
  );

  const clearDebridToken = useCallback(
    (provider: DebridProviderId) => {
      closeTokenPrompt();
      if (!config) return;
      const meta = getDebridProvider(provider);
      if (process.env[meta.tokenEnvVar]?.trim()) {
        setNotice(`Token is set via ${meta.tokenEnvVar} — unset the env var to clear it.`);
        return;
      }
      const field = provider === "torbox" ? "torBoxToken" : "realDebridToken";
      const next: Config = { ...config, [field]: undefined };
      // Never leave the preference pointing at a provider that has no token:
      // resolveActiveDebrid would ignore it, but the accounts pane would still
      // show it as active.
      if (next.debridProvider === provider) next.debridProvider = undefined;
      setConfig(next);
      if (debridStatus?.provider === provider) setDebridStatus(null);
      setNotice(`${meta.label} token cleared.`);
    },
    [config, setConfig, closeTokenPrompt, debridStatus],
  );

  const setActiveDebrid = useCallback(
    (provider: DebridProviderId) => {
      if (!config) return;
      const meta = getDebridProvider(provider);
      setConfig({ ...config, debridProvider: provider });
      setDebridStatus(null); // re-probed below; a stale status is a wrong badge
      setNotice(`${ICON.done} Using ${meta.label} for streams and debrid downloads.`);
      void (async () => {
        try {
          setDebridStatus(await meta.validateToken(resolveDebridTokenFor(config, provider)));
        } catch {
          setDebridStatus(null);
        }
      })();
    },
    [config, setConfig],
  );
```

Then, mechanically:

- `:363-367` launch validation uses `resolveActiveDebrid(cfg)` and that provider's `validateToken`.
- `:436-451` token-expiry notice uses the active provider's `isTokenRejection` and label.
- `:582-585` calls `queue.setDebridToken(active?.provider ?? null, active?.token ?? "")`.
- `:1059-1069` `startDebridDownload` resolves via `resolveActiveDebrid`, passes the provider to `addDebrid`, and its "set a token first" notice becomes "Set a Real-Debrid or TorBox token first — open the Accounts tab."
- `:1328-1405` the `v` flow tests `route.kind === "debrid"`, takes the token from `resolveActiveDebrid`, and its `preparing` label/source come from the provider.
- `:2112` renders `<DebridBadge status={debridStatus} />`.
- `:2125` "Caching on Real-Debrid… n%" → `` `Caching on ${label}… ${pct}%` ``.
- `:2161-2164` passes the provider being edited to `TokenPrompt`; hold it in the `editingToken` state (`{ provider } | null` instead of a boolean).
- `:2360-2371` the confirm prompt's `altLabel` becomes `` `use ${label}` ``.
- `:2382-2386` "Real-Debrid unavailable" → `` `${label} unavailable` ``.
- `:2579-2584` passes the new `Accounts` props (a `debrid` array built from `DEBRID_PROVIDER_IDS`, `activeDebrid`, `onSetActiveDebrid`).
- `:2642` passes the active provider's label into `footerHints`.

Same treatment for `Results.tsx` (`:158-164`, `:342`), `Downloads.tsx` (`:42-52`, `:159-161`) and `Splash.tsx` (`:81-86`): every "Real-Debrid" string becomes the active provider's label, passed in as a prop.

- [ ] **Step 6: Verify, including the previews**

```bash
npm test && npm run typecheck && npm run lint
npm run previews
git diff --stat preview/
```
Expected: green, and `preview/accounts.svg` / `preview/help.svg` show the new copy.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(tui): provider-aware store, keymap and App wiring

Setting the first token also makes that provider active, and clearing a
token clears a preference pointing at it — otherwise the pane would show a
provider as active that resolveActiveDebrid ignores.

Store field renames land in both makeTestStore and makeStore; previews
re-rendered."
```

---

### Task 13: Web — routes, wire types, and the capability flags

**Files:**
- Modify: `src/web/routes.ts:110-129,221-237,336-403,706-710,734-796`, `src/web/wire.ts:120-131,295-309,343-356`
- Test: `src/web/routes.test.ts`

**Interfaces:**
- Produces: `SourcesResponse.debridProvider`, `SourcesResponse.debridCachedCheck`; `PublicStreamSession.backend: "debrid" | "torrent"`; `WebDeps.debridStatusImpl`.

- [ ] **Step 1: Write the failing test**

In `src/web/routes.test.ts`:

```ts
it("reports which debrid provider is active, and whether it can check cached", async () => {
  const res = await get("/api/sources", {
    loadConfigImpl: () => Promise.resolve({ ...defaultConfig, torBoxToken: "tb-1" }),
  });
  expect(res.json).toMatchObject({
    debridConfigured: true,
    debridProvider: "torbox",
    debridCachedCheck: true,
  });
});

it("reports no cached check when Real-Debrid is active", async () => {
  const res = await get("/api/sources", {
    loadConfigImpl: () => Promise.resolve({ ...defaultConfig, realDebridToken: "rd-1" }),
  });
  expect(res.json).toMatchObject({ debridProvider: "realdebrid", debridCachedCheck: false });
});

it("reports nothing configured when there is no token", async () => {
  const res = await get("/api/sources", { loadConfigImpl: () => Promise.resolve(defaultConfig) });
  expect(res.json).toMatchObject({ debridConfigured: false, debridProvider: null, debridCachedCheck: false });
});

it("never puts a TorBox token in any response", async () => {
  const TB = "tb-super-secret-token";
  const res = await get("/api/sources", {
    loadConfigImpl: () => Promise.resolve({ ...defaultConfig, torBoxToken: TB }),
  });
  expect(JSON.stringify(res.json)).not.toContain(TB);
  // Proves the assertion is not vacuous: the response DOES describe TorBox.
  expect(JSON.stringify(res.json)).toContain("torbox");
});

it("routes a stream through the active provider", async () => {
  const seen: string[] = [];
  // `resolveDebridImpl` is a StreamSessionRegistry dep, not a WebDeps one —
  // routes.test.ts already builds its runtime with one (see the existing
  // Real-Debrid stream tests around routes.test.ts:429-445). Reuse that
  // helper rather than adding a new injection point; only the stub's
  // signature changes, gaining the leading provider argument.
  const res = await post("/api/stream", { magnet: MAGNET }, {
    loadConfigImpl: () => Promise.resolve({ ...defaultConfig, torBoxToken: "tb-1" }),
    debridStatusImpl: () => Promise.resolve(null),
    runtime: runtimeWithDebrid((provider: string) => {
      seen.push(provider);
      return Promise.resolve([{ url: "https://cdn.torbox.app/dl/a.mkv", filename: "a.mkv", bytes: 1 }]);
    }),
  });
  expect(res.status).toBe(200);
  expect(res.json.session.backend).toBe("debrid");
  expect(seen).toEqual(["torbox"]);
});

it("names both providers when a debrid add has no token", async () => {
  const res = await post("/api/add", { magnet: MAGNET, name: "Kestrel.2010.1080p.BluRay.x264", via: "debrid" }, {
    loadConfigImpl: () => Promise.resolve(defaultConfig),
  });
  expect(res.status).toBe(400);
  expect(res.json.error).toBe("Set a Real-Debrid or TorBox token first — open the Accounts tab.");
});
```

(`get`, `post`, `MAGNET` follow that file's existing helpers.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/web/routes.test.ts`
Expected: FAIL — `debridProvider` is not in the `/api/sources` body.

- [ ] **Step 3: Implement**

`src/web/wire.ts`:

```ts
// :131
  backend: "debrid" | "torrent";
  /** Which debrid service served it, when `backend` is "debrid". */
  provider?: "realdebrid" | "torbox";
```

```ts
// beside debridConfigured, :309
  /**
   * Which debrid service resolves magnets, or null when none is configured.
   * A capability flag like `debridConfigured`, never a credential: it is what
   * lets the browser label its add button the way the TUI labels `r`.
   */
  debridProvider: "realdebrid" | "torbox" | null;
  /**
   * Whether the active provider can answer "is this cached?".
   *
   * TorBox can; Real-Debrid cannot — it withdrew its instant-availability
   * endpoint in 2024. When false the browser shows no cached marker at all,
   * rather than an "unknown" state that would read as "not cached".
   */
  debridCachedCheck: boolean;
```

`src/web/routes.ts`:

- Rename `rdStatusImpl` → `debridStatusImpl` and widen it to `(provider: DebridProviderId, token: string) => Promise<DebridStatus | null>`. Keep the whole docstring; replace "Real-Debrid"/"RD" with "the provider" and `rdStatus` with `debridStatus`.
- Rename `RD_STATUS_PROBE_MS` → `DEBRID_STATUS_PROBE_MS`; `fetchRdStatus` → `fetchDebridStatus`, which calls `getDebridProvider(provider).validateToken(token, { retries: 0, signal: AbortSignal.timeout(...) })` and returns null on any failure.
- `startStream` (`:361-391`): `const active = resolveActiveDebrid(config)`, probe only when `active`, pass `debridToken: active?.token` and `debridProvider: active?.provider`.
- `/api/sources` (`:706-710`):

```ts
    // Booleans and an id, never a token. resolveActiveDebrid, not the raw
    // config fields, so both env vars count — the browser must agree with the
    // TUI about which provider is on, and the TUI resolves it the same way.
    debridConfigured: active !== null,
    debridProvider: active?.provider ?? null,
    debridCachedCheck: active ? getDebridProvider(active.provider).checkCached !== undefined : false,
```

- `addToQueue` (`:779-785`): resolve via `resolveActiveDebrid`, set both `options.debridToken` and `options.debridProvider`, and return the both-providers error above.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/web`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

```bash
npm test && npm run typecheck && npm run lint && npm run build
git add -A
git commit -m "feat(web): /api/sources reports the active debrid provider

Two new capability flags, no credential: debridProvider so the browser can
label its button the way the TUI labels r, and debridCachedCheck so it knows
whether a cached marker is even answerable."
```

---

### Task 14: Web — the add button and its copy

**Files:**
- Modify: `src/web/static/searchModel.ts:296-325`, `src/web/static/app.ts:1061-1068,1210,1242`
- Test: `src/web/static/searchModel.test.ts`

**Interfaces:**
- Produces: `debridProviderLabel(id)`, `debridAddLabel(id)`, `debridAddedNotice(id)`; `addPlan(via, debridConfigured, name, providerLabel)`.

`app.ts` is DOM wiring only — the label and the prompt text are decisions, so they live in `searchModel.ts` where a test can reach them. This has been caught in review twice.

- [ ] **Step 1: Write the failing test**

In `src/web/static/searchModel.test.ts`:

```ts
describe("debrid copy", () => {
  it("labels the button after the active provider", () => {
    expect(debridAddLabel("realdebrid")).toBe("add via RD");
    expect(debridAddLabel("torbox")).toBe("add via TorBox");
  });

  it("names the provider in the added notice", () => {
    expect(debridAddedNotice("torbox")).toBe("Added via TorBox.");
    expect(debridAddedNotice("realdebrid")).toBe("Added via Real-Debrid.");
  });

  it("names the provider in the swarm-exposure prompt", () => {
    const plan = addPlan("p2p", true, "Kestrel.2010.1080p.BluRay.x264", "TorBox");
    expect(plan.kind).toBe("confirm");
    expect(plan.kind === "confirm" && plan.message).toContain("TorBox");
  });

  it("still never prompts for an explicit debrid add", () => {
    expect(addPlan("debrid", true, "Ashfall.1999.1080p", "TorBox")).toEqual({ kind: "add", via: "debrid" });
  });

  it("still never prompts when no debrid is configured", () => {
    expect(addPlan("p2p", false, "Ashfall.1999.1080p", undefined)).toEqual({ kind: "add", via: "p2p" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/web/static/searchModel.test.ts`
Expected: FAIL — `debridAddLabel` is not exported.

- [ ] **Step 3: Implement**

In `src/web/static/searchModel.ts` (which imports nothing from `node:*` — keep it that way):

```ts
/** A debrid provider id as it crosses the wire. Mirrors `DebridProviderId`. */
export type WireDebridProvider = "realdebrid" | "torbox";

/**
 * Display copy per provider. Repeated here rather than imported from
 * `src/integrations/debrid` because this module is bundled for the browser and
 * must import nothing from `node:*` — the literal union above is the same
 * guard `wire.ts` uses for the same reason.
 */
const LABELS: Record<WireDebridProvider, { label: string; short: string }> = {
  realdebrid: { label: "Real-Debrid", short: "RD" },
  torbox: { label: "TorBox", short: "TorBox" },
};

export function debridProviderLabel(provider: WireDebridProvider): string {
  return LABELS[provider].label;
}

export function debridAddLabel(provider: WireDebridProvider): string {
  return `add via ${LABELS[provider].short}`;
}

export function debridAddedNotice(provider: WireDebridProvider): string {
  return `Added via ${LABELS[provider].label}.`;
}
```

Give `addPlan` a fourth parameter and use it in the message:

```ts
export function addPlan(
  via: AddVia,
  debridConfigured: boolean,
  name: string,
  providerLabel: string | undefined,
): AddPlan {
  if (via === "debrid" || !debridConfigured) return { kind: "add", via };
  const label = providerLabel ?? "your debrid provider";
  return {
    kind: "confirm",
    via: "p2p",
    // The existing sentence, with ${label} where "Real-Debrid" was hardcoded.
    // Copy it from the current implementation — do not retype it from here.
    message: `…${label}…`,
  };
}
```

Do **not** invent new wording. Read the existing message first and change only the provider name inside it:

```bash
grep -n "confirm\|message:" src/web/static/searchModel.ts | cut -c1-160
grep -rn "Real-Debrid" src/web/static/searchModel.test.ts | cut -c1-160
```

Substitute `${label}` for the hardcoded "Real-Debrid" in that exact sentence, then update the existing assertion in `searchModel.test.ts` to match. The prompt's meaning — that a plain add with debrid configured is about to put the user's IP in a public swarm — must not change.

In `src/web/static/app.ts`, replace `:1061-1068`:

```ts
  // Offered only where the TUI offers `r`: when a debrid token is actually
  // configured. A button that always answered "set a token first" is noise.
  if (sources?.debridConfigured && sources.debridProvider) {
    const debridButton = document.createElement("button");
    debridButton.type = "button";
    debridButton.textContent = debridAddLabel(sources.debridProvider);
    debridButton.addEventListener("click", () => void addResult(result, "debrid"));
    actions.append(debridButton);
  }
```

`:1210` passes the label, and `:1242` uses the notice:

```ts
  const plan = addPlan(
    via,
    sources?.debridConfigured === true,
    result.name,
    sources?.debridProvider ? debridProviderLabel(sources.debridProvider) : undefined,
  );
```

```ts
  showNotice(
    plan.via === "debrid" && sources?.debridProvider
      ? debridAddedNotice(sources.debridProvider)
      : "Added to the queue.",
  );
```

- [ ] **Step 4: Run tests and verify the bundle**

Run: `npx vitest run src/web/static && npm run build`
Expected: PASS, and the build succeeds — proving `src/web/static/` still imports no `node:*`.

- [ ] **Step 5: Exercise it by hand**

```bash
npm run dev -- serve --web
```
Search for something, and confirm the add button reads "add via RD" or "add via TorBox" per the configured provider. There is no jsdom, so this is the only check of the wiring.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(web): add button and notices name the active provider

The label and the swarm-exposure prompt are decisions, so they live in
searchModel.ts where a test can reach them; app.ts stays DOM wiring."
```

---

## Phase 6 — the cached marker

### Task 15: The cached-check module

**Files:**
- Create: `src/core/cachedHashes.ts`, `src/core/cachedHashes.test.ts`

**Interfaces:**
- Produces: `CACHED_BATCH`, `batchHashes(hashes, size?)`, `cachedHashesFor(provider, token, hashes, opts?)`.

It lives in `src/core/` rather than `src/util/` because it imports from `src/integrations/` and `src/util/` sits *below* that layer.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import { batchHashes, cachedHashesFor, CACHED_BATCH } from "./cachedHashes";
import type { DebridProvider } from "../integrations/debrid/types";

function provider(over: Partial<DebridProvider> = {}): DebridProvider {
  return {
    id: "torbox",
    label: "TorBox",
    shortLabel: "TB",
    homepage: "torbox.app",
    tokenUrl: "https://torbox.app/settings",
    tokenEnvVar: "TORBOX_API_TOKEN",
    validateToken: () => Promise.reject(new Error("unused")),
    resolveMagnet: () => Promise.reject(new Error("unused")),
    isTransient: () => false,
    isTokenRejection: () => false,
    ...over,
  };
}

describe("batchHashes", () => {
  it("splits into batches of at most `size`", () => {
    expect(batchHashes(["a", "b", "c"], 2)).toEqual([["a", "b"], ["c"]]);
  });

  it("returns no batches for no hashes", () => {
    expect(batchHashes([], 2)).toEqual([]);
  });

  it("lowercases and de-duplicates, so one hash is asked about once", () => {
    expect(batchHashes(["AA", "aa", "bb"], 10)).toEqual([["aa", "bb"]]);
  });

  it("defaults to CACHED_BATCH", () => {
    expect(batchHashes(Array.from({ length: CACHED_BATCH + 1 }, (_, i) => `h${i}`))).toHaveLength(2);
  });
});

describe("cachedHashesFor", () => {
  it("returns an empty set when the provider cannot check", async () => {
    // Real-Debrid's case: no checkCached at all, so there is nothing to call.
    expect((await cachedHashesFor(provider({ checkCached: undefined }), "t", ["aa"])).size).toBe(0);
  });

  it("returns an empty set with no token, without calling the provider", async () => {
    const checkCached = vi.fn(() => Promise.resolve(new Set(["aa"])));
    expect((await cachedHashesFor(provider({ checkCached }), "", ["aa"])).size).toBe(0);
    expect(checkCached).not.toHaveBeenCalled();
  });

  it("unions the results of every batch", async () => {
    const checkCached = vi.fn((_t: string, hashes: string[]) => Promise.resolve(new Set([hashes[0]!])));
    const cached = await cachedHashesFor(provider({ checkCached }), "t", ["aa", "bb", "cc"], { batchSize: 2 });
    expect([...cached].sort()).toEqual(["aa", "cc"]);
    expect(checkCached).toHaveBeenCalledTimes(2);
  });

  it("fails soft: a throwing batch yields no tags rather than an error", async () => {
    const checkCached = vi.fn((_t: string, hashes: string[]) =>
      hashes.includes("bb") ? Promise.reject(new Error("rate limited")) : Promise.resolve(new Set(hashes)),
    );
    const cached = await cachedHashesFor(provider({ checkCached }), "t", ["aa", "bb"], { batchSize: 1 });
    // The good batch still counts; the failed one simply contributes nothing.
    expect([...cached]).toEqual(["aa"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/cachedHashes.test.ts`
Expected: FAIL — cannot resolve `./cachedHashes`.

- [ ] **Step 3: Implement**

```ts
import type { DebridProvider, RequestOptions } from "../integrations/debrid/types";

/** How many hashes go into one checkcached call. */
export const CACHED_BATCH = 100;

/** Lowercase, de-duplicate, and split into batches of at most `size`. */
export function batchHashes(hashes: readonly string[], size = CACHED_BATCH): string[][] {
  const unique = [...new Set(hashes.map((h) => h.toLowerCase()).filter(Boolean))];
  const out: string[][] = [];
  for (let i = 0; i < unique.length; i += size) out.push(unique.slice(i, i + size));
  return out;
}

export interface CachedHashesOptions extends RequestOptions {
  batchSize?: number;
}

/**
 * Which of `hashes` the provider already has cached.
 *
 * Best-effort by design. A provider with no `checkCached` (Real-Debrid), a
 * missing token, or a failing call all yield an empty set — the marker is an
 * extra the user did not ask for, and an error toast because an advisory lookup
 * timed out would be worse than no marker. Batches are independent, so one
 * failure does not discard the answers that did arrive.
 */
export async function cachedHashesFor(
  provider: DebridProvider,
  token: string,
  hashes: readonly string[],
  opts: CachedHashesOptions = {},
): Promise<Set<string>> {
  const { batchSize, ...requestOpts } = opts;
  if (!provider.checkCached || !token) return new Set();
  const batches = batchHashes(hashes, batchSize);
  const results = await Promise.all(
    batches.map((batch) => provider.checkCached!(token, batch, requestOpts).catch(() => new Set<string>())),
  );
  const out = new Set<string>();
  for (const set of results) for (const hash of set) out.add(hash);
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/cachedHashes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: batched, fail-soft cached-availability lookup

In src/core/ rather than src/util/ because it reads a provider capability and
src/util/ sits below the integrations layer. Batches are independent so one
rate-limited call does not discard the answers that did arrive."
```

---

### Task 16: The cached marker in both front ends

**Files:**
- Modify: `src/web/routes.ts` (new route), `src/web/wire.ts`, `src/web/static/app.ts`, `src/web/static/searchModel.ts`, `src/ui/App.tsx`, `src/ui/store.ts`, `src/ui/testHarness.ts`, `scripts/render-previews-impl.tsx`, `src/ui/components/Results.tsx`
- Test: `src/web/routes.test.ts`, `src/web/static/searchModel.test.ts`

**Interfaces:**
- Produces: `POST /api/cached` (`CachedRequest` → `CachedResponse`); `cachedTag(infoHash, cached, canCheck)`; `Store.cachedHashes`.

- [ ] **Step 1: Write the failing test**

In `src/web/routes.test.ts`:

```ts
it("answers which hashes the active provider has cached", async () => {
  const res = await post("/api/cached", { hashes: [HASH_A, HASH_B] }, {
    loadConfigImpl: () => Promise.resolve({ ...defaultConfig, torBoxToken: "tb-1" }),
    checkCachedImpl: () => Promise.resolve(new Set([HASH_A])),
  });
  expect(res.status).toBe(200);
  expect(res.json).toEqual({ cached: [HASH_A] });
});

it("refuses when the active provider cannot check", async () => {
  const res = await post("/api/cached", { hashes: [HASH_A] }, {
    loadConfigImpl: () => Promise.resolve({ ...defaultConfig, realDebridToken: "rd-1" }),
  });
  expect(res.status).toBe(409);
});

it("refuses when no debrid is configured", async () => {
  const res = await post("/api/cached", { hashes: [HASH_A] }, {
    loadConfigImpl: () => Promise.resolve(defaultConfig),
  });
  expect(res.status).toBe(409);
});

it("answers an empty list for an empty request without calling the provider", async () => {
  const checkCachedImpl = vi.fn();
  const res = await post("/api/cached", { hashes: [] }, {
    loadConfigImpl: () => Promise.resolve({ ...defaultConfig, torBoxToken: "tb-1" }),
    checkCachedImpl,
  });
  expect(res.json).toEqual({ cached: [] });
  expect(checkCachedImpl).not.toHaveBeenCalled();
});

it("rejects a non-array hashes field", async () => {
  const res = await post("/api/cached", { hashes: "aabb" }, {
    loadConfigImpl: () => Promise.resolve({ ...defaultConfig, torBoxToken: "tb-1" }),
  });
  expect(res.status).toBe(400);
});
```

In `src/web/static/searchModel.test.ts`:

```ts
describe("cachedTag", () => {
  it("marks a cached result when the provider can check", () => {
    expect(cachedTag("aabb", new Set(["aabb"]), true)).toBe("cached");
  });

  it("shows nothing for an uncached result — absence is not a claim", () => {
    expect(cachedTag("aabb", new Set(["ccdd"]), true)).toBeNull();
  });

  it("shows nothing at all when the provider cannot check", () => {
    // Real-Debrid withdrew its instant-availability endpoint; an "unknown"
    // state would read as "not cached", which is a claim we cannot make.
    expect(cachedTag("aabb", new Set(["aabb"]), false)).toBeNull();
  });

  it("matches case-insensitively", () => {
    expect(cachedTag("AABB", new Set(["aabb"]), true)).toBe("cached");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/web/routes.test.ts src/web/static/searchModel.test.ts`
Expected: FAIL — no `/api/cached` route (404), `cachedTag` is not exported.

- [ ] **Step 3: Add the wire types and the route**

`src/web/wire.ts`:

```ts
/**
 * `POST /api/cached` — which of these torrents the active debrid provider
 * already has, so a result can be marked before the user commits to it.
 *
 * Info hashes only: a search result carries no magnet on this wire (that was a
 * ~6MB-per-search decision) and a hash is all the provider needs.
 */
export interface CachedRequest {
  hashes: string[];
}

/** Lowercase hex info hashes the provider has cached. A subset of the request. */
export interface CachedResponse {
  cached: string[];
}
```

`src/web/routes.ts` — add a `checkCachedImpl?: (provider: DebridProviderId, token: string, hashes: string[]) => Promise<Set<string>>` dep defaulting to `cachedHashesFor`, and:

```ts
/**
 * Which of the posted hashes the active provider has cached.
 *
 * 409, not an empty list, when the active provider cannot answer: an empty
 * `cached` array is a claim ("none of these are cached") and Real-Debrid — which
 * withdrew its instant-availability endpoint in 2024 — cannot make it. The
 * browser learns the same thing from `/api/sources`'s `debridCachedCheck` and
 * does not render the marker at all; this status is the guard for a client that
 * asks anyway.
 */
async function checkCached(deps: WebDeps, bodyText: string): Promise<RouteResult> {
  const body = parseJsonBody(bodyText);
  if (!body) return { status: 400, json: { error: "invalid JSON body" } };
  if (!Array.isArray(body.hashes)) {
    return { status: 400, json: { error: "hashes must be an array of info hashes" } };
  }
  const hashes = body.hashes.filter((h): h is string => typeof h === "string" && h.length > 0);
  const config = await (deps.loadConfigImpl ?? loadConfig)();
  const active = resolveActiveDebrid(config);
  if (!active || getDebridProvider(active.provider).checkCached === undefined) {
    return { status: 409, json: { error: "the active debrid provider cannot check cached availability" } };
  }
  if (hashes.length === 0) {
    const empty: CachedResponse = { cached: [] };
    return { status: 200, json: empty };
  }
  const cached = await (deps.checkCachedImpl ??
    ((p: DebridProviderId, t: string, h: string[]) => cachedHashesFor(getDebridProvider(p), t, h)))(
    active.provider,
    active.token,
    hashes,
  );
  const out: CachedResponse = { cached: hashes.map((h) => h.toLowerCase()).filter((h) => cached.has(h)) };
  return { status: 200, json: out };
}
```

Register it beside the other `POST` routes.

- [ ] **Step 4: Add `cachedTag` and wire the browser**

In `src/web/static/searchModel.ts`:

```ts
/**
 * The cached marker for one result, or null for no marker.
 *
 * `canCheck` false means the active provider cannot answer — Real-Debrid
 * withdrew its instant-availability endpoint in 2024 — so nothing is rendered.
 * An "unknown" badge would read as "not cached", which is a claim torlink is
 * not in a position to make. Absence of a marker on an uncached result is the
 * same principle at result level.
 */
export function cachedTag(infoHash: string, cached: ReadonlySet<string>, canCheck: boolean): "cached" | null {
  if (!canCheck) return null;
  return cached.has(infoHash.toLowerCase()) ? "cached" : null;
}
```

In `src/web/static/app.ts`: after results render, when `sources?.debridCachedCheck`, `POST /api/cached` with the visible hashes, store the result in a module-level `Set`, and re-render. Build the tag with `createElement` + `textContent` only:

```ts
  const tag = cachedTag(result.infoHash, cachedHashes, sources?.debridCachedCheck === true);
  if (tag) {
    const badge = document.createElement("span");
    badge.className = "tag tag-cached";
    badge.textContent = tag;
    meta.append(badge);
  }
```

Add a `.tag-cached` rule to `src/web/static/index.html`'s stylesheet, in the calm palette already used there.

- [ ] **Step 5: Wire the TUI**

Add to `Store` (and to **both** `makeTestStore` and `makeStore`):

```ts
  // Info hashes the active debrid provider has cached, for the results marker.
  // Empty when the provider cannot answer — see cachedTag's reasoning.
  cachedHashes: ReadonlySet<string>;
```

In `App.tsx`, after a search settles, when the active provider has `checkCached`, call `cachedHashesFor` and set the state; clear it on a new search and on a provider switch. In `Results.tsx` render a dim `cached` tag on a row whose hash is in the set — reuse the existing per-row tag styling rather than adding a column.

- [ ] **Step 6: Verify**

```bash
npm test && npm run typecheck && npm run lint && npm run build
npm run previews
npm run dev -- serve --web
```
Expected: green. With a TorBox token configured, search results carry a `cached` marker in both surfaces; with Real-Debrid configured, no marker appears anywhere.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: cached marker on search results, TorBox only

409 rather than an empty list when the provider cannot answer: an empty
cached array is the claim \"none of these are cached\", and Real-Debrid cannot
make it. No marker at all beats an unknown state that reads as uncached."
```

---

## Phase 7 — docs and the final sweep

### Task 17: Documentation and package metadata

**Files:**
- Modify: `README.md:5,98-117,267,271,280,336`, `package.json:4,44-45`, `CONTRIBUTING.md:61`, `CLAUDE.md:17`

- [ ] **Step 1: Rewrite README's debrid section**

Retitle "Real-Debrid (optional)" to "Debrid (optional)" and cover both providers: where each token comes from (`real-debrid.com/apitoken`, `torbox.app/settings`), the `REALDEBRID_API_TOKEN` and `TORBOX_API_TOKEN` env vars, that the Accounts tab picks which one is active with `a`, and that the `cached` marker appears only under TorBox because Real-Debrid withdrew its instant-availability endpoint in 2024. Keep the existing `r`/`v` key docs and the "fetched, not seeded" note, reworded to name neither provider specifically.

- [ ] **Step 2: Re-check the web UI's limitations list**

`README.md:267-280` describes what the browser can and cannot do. Confirm each line is still true — the provider switch and token entry are still TUI-only, and the browser now labels its add button per provider and can show a cached marker.

- [ ] **Step 3: Update `package.json`**

`:4` description mentions both providers; `:44-45` keywords gain `torbox`. The published name stays `torlnk-rd` — renaming a published package orphans existing installs and belongs in its own change. Note that reasoning in `RELEASING.md:18` beside the existing `-rd` explanation.

- [ ] **Step 4: Update the two capability-flag mentions**

`CONTRIBUTING.md:61` and `CLAUDE.md:17` both cite `debridConfigured` as the example capability flag. Add `debridProvider` and `debridCachedCheck` alongside it.

- [ ] **Step 5: Verify and commit**

```bash
npm test && npm run typecheck && npm run lint && npm run build
git add -A
git commit -m "docs: TorBox setup, the provider switch, and the cached marker

The published package name stays torlnk-rd; the reasoning is recorded in
RELEASING.md rather than left as a stale -rd suffix nobody explained."
```

---

### Task 18: Final sweep

**Files:** whatever the greps below turn up.

- [ ] **Step 1: Hunt every stale Real-Debrid-only reference**

```bash
grep -rn "Real-Debrid\|realdebrid\|RealDebrid\|\brd\b" src README.md CONTRIBUTING.md package.json \
  --include='*.ts' --include='*.tsx' --include='*.md' --include='*.json' \
  | grep -v "integrations/debrid" | cut -c1-140
```
Every remaining hit must be either genuinely Real-Debrid-specific (the RD client, `REALDEBRID_API_TOKEN`, the `realdebrid` provider id, the `torlnk-rd` package name) or a deliberate mention in prose. Fix anything that describes debrid-in-general with RD's name.

- [ ] **Step 2: Confirm no negative assertion went vacuous**

```bash
grep -rn "not.toContain\|not.toBe(" src --include='*.ts' --include='*.tsx' | cut -c1-160
```
For each, confirm the string it hunts for is something the test actually puts in play. `src/web/stream.test.ts:856` ("never writes a Real-Debrid link into the file") and `src/web/routes.test.ts:326-328` (`RD_URL` / `real-debrid.com` never in a response) are the two that matter most — a rename that changed the fixture URL but not the assertion leaves them passing because *nothing* contains the old string.

- [ ] **Step 3: Confirm no token can reach a log or a response**

```bash
grep -rn "token" src/integrations/debrid/torbox.ts | grep -n "log\." | cut -c1-160
npx vitest run -t "never writes the token to the log"
npx vitest run -t "never puts a TorBox token"
```
Expected: no `log.` line interpolates a token; both tests pass.

- [ ] **Step 4: Full verification**

```bash
npm test && npm run typecheck && npm run lint && npm run build && npm run previews
git status --short
```
Expected: green. The only lint warning is the known pre-existing `react-hooks/exhaustive-deps` in `src/ui/App.tsx`. `git status` shows only intended preview re-renders.

- [ ] **Step 5: Exercise both front ends by hand**

```bash
npm run dev            # TUI: Accounts tab — both rows, `a` switches, badge follows
npm run dev -- serve --web   # browser: button label, cached marker
```

Confirm: switching the active provider in the TUI changes the header badge and the footer hint; the browser's add button label matches the active provider after a refresh; a config edited in one surface is seen by the other.

- [ ] **Step 6: Commit anything the sweep changed**

```bash
git add -A
git commit -m "chore: final TorBox sweep — stale RD-only copy and log hygiene"
```

---

## Notes for the implementer

**Three TorBox shapes are documented but never tested against a live account.** Each is commented as such in the code, and each has a named fallback:

1. `createtorrent`'s id field — the client accepts `torrent_id` or `id` and fails loudly otherwise (Task 5).
2. `progress` is assumed to be a 0–1 float — if it is really 0–100, drop the `* 100` in `resolveMagnet` and fix the one test (Task 5).
3. `plan: 0` (free) is assumed able to add torrents — if not, `active` becomes `plan > 0` in `validateToken` and `classifyStreamRoute`'s existing `torrent-confirm` path covers it with no other change (Task 5).

**Task 6 is where TorBox becomes reachable.** Before it, `DEBRID_PROVIDER_IDS`
lists Real-Debrid alone and `torbox.ts` exports plain functions. Nothing on this
branch commits a provider object with a rejecting method, and no test is ever
committed skipped — if a task cannot land green without one, the task boundary
is wrong and you should say so rather than skipping.

**The two renames that are not mechanical.** `status.premium` (boolean) and `user.premium` (seconds) collide, so a blind `s/premium/active/` corrupts the RD client — Task 1 Step 7 does those by hand. And `via: "realdebrid"` appears both as a persisted value and as a routing literal; Task 3 handles the persisted one, Task 8 the routing one.
