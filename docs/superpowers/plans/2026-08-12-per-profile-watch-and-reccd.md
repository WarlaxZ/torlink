# Per-profile watch history and reccd Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Partition watch history, favourites, saved searches, and reccd recommendations per authenticated Cloudflare Access login, so the server owner can share the server with a friend without their activity mixing.

**Architecture:** Introduce a front-end-agnostic *profile* keyed by the verified Access email. The **owner** profile is the existing top-level storage (`config.favourites`/`savedSearches`/`reccToken` and `stream-history.json`) — unchanged. **Friend** profiles get namespaced storage (`config.profiles[id]` and `stream-history/<id>.json`). Which profile a web request uses is resolved from the email that `verifyAccessAssertion` already extracts and the server currently discards. The TUI and any non-Access request resolve to the owner profile via default parameters, so they are unaffected.

**Tech Stack:** TypeScript, Node (`node:fs`, `node:crypto`), Vitest, Ink/React (TUI), plain DOM (web). reccd HTTP client already exists.

## Global Constraints

- **Fixtures name invented titles only** — reuse the cast `Kestrel`, `Ashfall`, `Tin.Rivers`, `Kepler`, `Harrowgate`; use invented emails (`owner@example.com`, `friend@example.com`). Never a real title.
- **`src/web` must not import `src/ui`; `src/core` must not import `src/ui`/`src/web`.** Share by placing code in `src/core`/`src/util`/`src/config`.
- **No `innerHTML`/`insertAdjacentHTML`/`outerHTML`/`document.write` in `src/web/static/`** (not touched by this plan, but do not introduce).
- **Config writes are read-modify-write per request**: `loadConfig()` → change → `saveConfig()`. Never hold a snapshot across a write. All new setters return a fresh `Config`; callers save it immediately.
- **`ownerEmail`, `profiles`, and per-profile reccd tokens are host/secret config → NOT web-writable.** Do not add them to `sanitiseSettingsPatch`. `ownerEmail` is resolved env-first (`TORLINK_OWNER_EMAIL`) then config, exactly like `cfAccessTeamDomain`.
- **Fail soft**: with no `ownerEmail`, or no Access, every request resolves to the owner profile — today's single-user behaviour. The feature is a strict no-op until `ownerEmail` is set.
- **Gate before done**: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`. One known pre-existing lint warning in `src/ui/App.tsx` (`react-hooks/exhaustive-deps`) stays.
- **Commit style**: Conventional Commits. Commit at the end of each task.

---

## File Structure

- `src/core/profile.ts` — **new.** Pure profile-identity logic: `OWNER_PROFILE`, `slugForEmail`, `resolveProfileId`, `isOwnerProfile`. No I/O.
- `src/core/profile.test.ts` — **new.** Unit tests for the above.
- `src/config/paths.ts` — **modify.** Add `streamHistoryDir` and `reccProvisionLockFileForProfile`.
- `src/config/config.ts` — **modify.** `ownerEmail` + `profiles` schema; `resolveOwnerEmail`; profile-aware `resolveReccConfig`; profile list accessors/setters; `loadConfig` validation.
- `src/config/config.test.ts` (or the existing config test file) — **modify.** Cover the new helpers and validation.
- `src/core/streamHistory.ts` — **modify.** `loadStreamHistory`/`saveStreamHistory`/`forgetStreamHistory` take an optional `profileId` (default owner); friend files live under `streamHistoryDir`.
- `src/core/streamHistory.test.ts` — **modify.** Friend vs owner isolation.
- `src/recc/provision.ts` — **modify.** `shouldProvision`/`ensureReccAccount` accept a `profileId`; friend accounts write to `profiles[id]` with a per-profile lock.
- `src/recc/provision.test.ts` — **modify.** Friend provisioning writes to the profile.
- `src/web/routes.ts` — **modify.** `handleWebApi` gains an `accessEmail` param, threaded to every handler that touches the four lists; each resolves `profileId` from its already-loaded config.
- `src/web/routes.test.ts` — **modify.** Two emails get two independent lists; owner path unchanged.
- `src/web/server.ts` — **modify.** Capture `verdict.email` and pass it to `handleWebApi`.
- `README.md` — **modify.** "Sharing the server behind Cloudflare Access" section.

---

## Task 1: Profile identity module (`src/core/profile.ts`)

**Files:**
- Create: `src/core/profile.ts`
- Test: `src/core/profile.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module; imports only `node:crypto`).
- Produces:
  - `export const OWNER_PROFILE = "owner"`
  - `export function slugForEmail(email: string): string`
  - `export function resolveProfileId(email: string | null | undefined, ownerEmail: string | undefined): string`
  - `export function isOwnerProfile(profileId: string): boolean`

- [ ] **Step 1: Write the failing test**

```ts
// src/core/profile.test.ts
import { describe, expect, it } from "vitest";
import { OWNER_PROFILE, isOwnerProfile, resolveProfileId, slugForEmail } from "./profile";

describe("resolveProfileId", () => {
  it("returns the owner profile when no email is present", () => {
    expect(resolveProfileId(undefined, "owner@example.com")).toBe(OWNER_PROFILE);
    expect(resolveProfileId(null, "owner@example.com")).toBe(OWNER_PROFILE);
    expect(resolveProfileId("", "owner@example.com")).toBe(OWNER_PROFILE);
  });

  it("returns the owner profile when no owner email is configured (fail-soft)", () => {
    expect(resolveProfileId("friend@example.com", undefined)).toBe(OWNER_PROFILE);
  });

  it("maps the owner's own email to the owner profile, case-insensitively", () => {
    expect(resolveProfileId("Owner@Example.com", "owner@example.com")).toBe(OWNER_PROFILE);
  });

  it("maps a friend to a stable non-owner slug", () => {
    const a = resolveProfileId("friend@example.com", "owner@example.com");
    const b = resolveProfileId("friend@example.com", "owner@example.com");
    expect(a).toBe(b);
    expect(a).not.toBe(OWNER_PROFILE);
    expect(isOwnerProfile(a)).toBe(false);
  });

  it("gives distinct, filesystem-safe slugs to distinct emails that differ only in a separator", () => {
    const a = slugForEmail("a.b@example.com");
    const b = slugForEmail("a_b@example.com");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[a-f0-9]+$/);
    expect(b).toMatch(/^[a-f0-9]+$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/profile.test.ts`
Expected: FAIL — cannot find module `./profile`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/profile.ts
// Front-end-agnostic profile identity. A "profile" is the container for the four
// per-user lists (watch history, favourites, saved searches, reccd account). Which
// profile a web request uses is derived from the Cloudflare Access email; the TUI
// and any non-Access request use the owner profile. Lives in src/core because both
// front ends resolve it and eslint forbids src/web importing src/ui.
import { createHash } from "node:crypto";

/**
 * The reserved id for the server owner — the existing top-level config fields and
 * stream-history.json. Not a hex slug, so it can never collide with slugForEmail.
 */
export const OWNER_PROFILE = "owner";

/**
 * A stable, collision-free, filesystem-safe id for a friend's email. A hash rather
 * than a sanitised string precisely so `a.b@x` and `a_b@x` cannot merge into one
 * profile — a lossy strip of unsafe characters would let them. 128 bits is ample.
 */
export function slugForEmail(email: string): string {
  const normalised = email.trim().toLowerCase();
  return createHash("sha256").update(normalised).digest("hex").slice(0, 32);
}

/**
 * The profile a request belongs to. Fails soft to the owner: no email, no configured
 * owner, or the owner's own email all resolve to OWNER_PROFILE, so torlink behaves
 * exactly as it does today until an owner email is set and a *different* user signs in.
 */
export function resolveProfileId(
  email: string | null | undefined,
  ownerEmail: string | undefined,
): string {
  const e = email?.trim().toLowerCase();
  if (!e) return OWNER_PROFILE;
  const owner = ownerEmail?.trim().toLowerCase();
  if (!owner) return OWNER_PROFILE;
  if (e === owner) return OWNER_PROFILE;
  return slugForEmail(e);
}

export function isOwnerProfile(profileId: string): boolean {
  return profileId === OWNER_PROFILE;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/profile.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/profile.ts src/core/profile.test.ts
git commit -m "feat(core): profile identity resolution keyed by Access email"
```

---

## Task 2: Config schema, owner resolution, and profile accessors

**Files:**
- Modify: `src/config/config.ts`
- Test: `src/config/config.test.ts` (create if absent; otherwise add to the existing config test file — grep `resolveReccConfig` under `src/**/*.test.ts` to find it)

**Interfaces:**
- Consumes: `OWNER_PROFILE`, `isOwnerProfile` from `src/core/profile` (Task 1).
- Produces:
  - `export interface ProfileState { favourites?: FavouriteItem[]; savedSearches?: string[]; reccToken?: string; reccAccountName?: string; reccAccountClaimed?: boolean }`
  - `Config.ownerEmail?: string`, `Config.profiles?: Record<string, ProfileState>`
  - `export function resolveOwnerEmail(config: Config): string | undefined`
  - `resolveReccConfig(config: Config, profileId?: string): ReccClientConfig` (new optional 2nd arg; default owner)
  - `export function profileFavourites(config: Config, profileId: string): FavouriteItem[]`
  - `export function withProfileFavourites(config: Config, profileId: string, favourites: FavouriteItem[]): Config`
  - `export function profileSavedSearches(config: Config, profileId: string): string[]`
  - `export function withProfileSavedSearches(config: Config, profileId: string, savedSearches: string[]): Config`
  - `export function withProfileReccAccount(config: Config, profileId: string, patch: { reccToken: string; reccAccountName: string; reccAccountClaimed: boolean }): Config`

- [ ] **Step 1: Write the failing test**

```ts
// src/config/config.test.ts  (add these; keep any existing tests in the file)
import { describe, expect, it } from "vitest";
import {
  profileFavourites,
  profileSavedSearches,
  resolveOwnerEmail,
  resolveReccConfig,
  withProfileFavourites,
  withProfileReccAccount,
  withProfileSavedSearches,
  type Config,
} from "./config";
import { OWNER_PROFILE, slugForEmail } from "../core/profile";

const base: Config = { downloadDir: "/dl", trackers: [] };
const FRIEND = slugForEmail("friend@example.com");

describe("resolveOwnerEmail", () => {
  it("prefers the env var, trimmed and lower-cased", () => {
    process.env.TORLINK_OWNER_EMAIL = "  Owner@Example.com ";
    try {
      expect(resolveOwnerEmail({ ...base, ownerEmail: "other@example.com" })).toBe("owner@example.com");
    } finally {
      delete process.env.TORLINK_OWNER_EMAIL;
    }
  });
  it("falls back to config, and undefined when unset", () => {
    expect(resolveOwnerEmail({ ...base, ownerEmail: "owner@example.com" })).toBe("owner@example.com");
    expect(resolveOwnerEmail(base)).toBeUndefined();
  });
});

describe("profile list accessors", () => {
  it("owner reads and writes the top-level fields", () => {
    const cfg = withProfileFavourites(base, OWNER_PROFILE, [{ id: "x", name: "Kestrel", addedAt: 1 } as never]);
    expect(cfg.favourites).toHaveLength(1);
    expect(profileFavourites(cfg, OWNER_PROFILE)).toHaveLength(1);
    expect(profileFavourites(cfg, FRIEND)).toEqual([]);
  });
  it("a friend reads and writes profiles[id], leaving the owner untouched", () => {
    const cfg = withProfileSavedSearches(base, FRIEND, ["harrowgate"]);
    expect(profileSavedSearches(cfg, FRIEND)).toEqual(["harrowgate"]);
    expect(cfg.savedSearches ?? []).toEqual([]);
    expect(profileSavedSearches(cfg, OWNER_PROFILE)).toEqual([]);
  });
});

describe("resolveReccConfig per profile", () => {
  it("owner uses the top-level token; a friend uses its own", () => {
    const cfg = withProfileReccAccount(
      { ...base, reccUrl: "https://reccd.stream", reccToken: "owner-tok" },
      FRIEND,
      { reccToken: "friend-tok", reccAccountName: "anon", reccAccountClaimed: false },
    );
    expect(resolveReccConfig(cfg).reccToken).toBe("owner-tok");
    expect(resolveReccConfig(cfg, OWNER_PROFILE).reccToken).toBe("owner-tok");
    expect(resolveReccConfig(cfg, FRIEND).reccToken).toBe("friend-tok");
    expect(resolveReccConfig(cfg, FRIEND).reccUrl).toBe("https://reccd.stream");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/config/config.test.ts`
Expected: FAIL — the new exports do not exist.

- [ ] **Step 3: Add the schema**

In the `Config` interface (near the reccd fields at `src/config/config.ts:40-57` and `favourites` at `:99`), add:

```ts
  // The Access email that owns this install. Its profile is the existing top-level
  // fields and stream-history.json; every other authenticated email gets its own
  // profile. Host/security config: env (TORLINK_OWNER_EMAIL) or config, never
  // web-writable — mirrors cfAccessTeamDomain.
  ownerEmail?: string;
  // Per-friend state, keyed by slugForEmail(email). The OWNER never appears here —
  // the owner is the top-level fields above. Absent until a second user signs in.
  profiles?: Record<string, ProfileState>;
```

Above the `Config` interface, add the type (place it near `FavouriteItem`'s import/definition):

```ts
/** One friend's isolated lists. Mirrors the owner's top-level fields. */
export interface ProfileState {
  favourites?: FavouriteItem[];
  savedSearches?: string[];
  reccToken?: string;
  reccAccountName?: string;
  reccAccountClaimed?: boolean;
}
```

- [ ] **Step 4: Add the helpers**

Add an import at the top of `src/config/config.ts`:

```ts
import { OWNER_PROFILE, isOwnerProfile } from "../core/profile";
```

Add `resolveOwnerEmail` beside the other `resolve*` helpers (near `resolveCloudflareAccess`, `src/config/config.ts:413`):

```ts
const OWNER_EMAIL_ENV = "TORLINK_OWNER_EMAIL";

/**
 * The Access email that owns this install, normalised (trimmed + lower-cased), or
 * undefined. env wins over config, matching every other resolve* helper. Undefined
 * means "no owner set" — the whole feature then fails soft to single-user.
 */
export function resolveOwnerEmail(config: Config): string | undefined {
  const v = process.env[OWNER_EMAIL_ENV]?.trim() || config.ownerEmail?.trim();
  return v ? v.toLowerCase() : undefined;
}
```

Replace `resolveReccConfig` (`src/config/config.ts:377-381`) with the profile-aware form:

```ts
export function resolveReccConfig(config: Config, profileId: string = OWNER_PROFILE): ReccClientConfig {
  // reccUrl is shared infrastructure — every profile talks to the same reccd host.
  const url = process.env[RECC_URL_ENV]?.trim() || config.reccUrl?.trim() || undefined;
  if (isOwnerProfile(profileId)) {
    const token = process.env[RECC_TOKEN_ENV]?.trim() || config.reccToken?.trim() || undefined;
    return { reccUrl: url, reccToken: token };
  }
  // A friend never inherits the env/owner token — isolation is the whole point.
  const token = config.profiles?.[profileId]?.reccToken?.trim() || undefined;
  return { reccUrl: url, reccToken: token };
}
```

Add the list accessors/setters near the bottom of the file (after `loadConfig`):

```ts
export function profileFavourites(config: Config, profileId: string): FavouriteItem[] {
  if (isOwnerProfile(profileId)) return config.favourites ?? [];
  return config.profiles?.[profileId]?.favourites ?? [];
}

export function withProfileFavourites(config: Config, profileId: string, favourites: FavouriteItem[]): Config {
  if (isOwnerProfile(profileId)) return { ...config, favourites };
  const prev = config.profiles?.[profileId] ?? {};
  return { ...config, profiles: { ...config.profiles, [profileId]: { ...prev, favourites } } };
}

export function profileSavedSearches(config: Config, profileId: string): string[] {
  if (isOwnerProfile(profileId)) return config.savedSearches ?? [];
  return config.profiles?.[profileId]?.savedSearches ?? [];
}

export function withProfileSavedSearches(config: Config, profileId: string, savedSearches: string[]): Config {
  if (isOwnerProfile(profileId)) return { ...config, savedSearches };
  const prev = config.profiles?.[profileId] ?? {};
  return { ...config, profiles: { ...config.profiles, [profileId]: { ...prev, savedSearches } } };
}

export function withProfileReccAccount(
  config: Config,
  profileId: string,
  patch: { reccToken: string; reccAccountName: string; reccAccountClaimed: boolean },
): Config {
  if (isOwnerProfile(profileId)) {
    return { ...config, reccUrl: DEFAULT_RECC_URL, ...patch };
  }
  const prev = config.profiles?.[profileId] ?? {};
  return { ...config, profiles: { ...config.profiles, [profileId]: { ...prev, ...patch } } };
}
```

> `DEFAULT_RECC_URL` is exported from `src/recc/provision.ts`. If importing it into `config.ts` creates a cycle (config → recc → config), inline the string literal `"https://reccd.stream"` here with a comment pointing at `provision.ts` as the canonical copy, OR set only the token fields for the owner and leave `reccUrl` to the caller. Prefer setting the token fields only: `return { ...config, ...patch }` for the owner — the owner's `reccUrl` is already set by the time provisioning runs.

Use the simpler owner branch to avoid the cycle:

```ts
  if (isOwnerProfile(profileId)) {
    return { ...config, ...patch };
  }
```

- [ ] **Step 5: Validate the new fields in `loadConfig`**

Inside `loadConfig` (after the `favourites` block, `src/config/config.ts:478`), add:

```ts
    cfg.ownerEmail =
      typeof parsed.ownerEmail === "string" && parsed.ownerEmail.trim().length > 0
        ? parsed.ownerEmail.trim()
        : undefined;
    cfg.profiles = sanitiseProfiles(parsed.profiles);
```

Add the helper (near `isFavouriteItem`):

```ts
function sanitiseProfiles(input: unknown): Record<string, ProfileState> | undefined {
  if (!input || typeof input !== "object") return undefined;
  const out: Record<string, ProfileState> = {};
  for (const [id, raw] of Object.entries(input as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const state: ProfileState = {};
    if (Array.isArray(r.favourites)) {
      state.favourites = r.favourites
        .filter(isFavouriteItem)
        .map((f) => ({ ...f, addedAt: typeof f.addedAt === "number" ? f.addedAt : 0 }))
        .slice(0, 100);
    }
    if (Array.isArray(r.savedSearches)) {
      state.savedSearches = r.savedSearches
        .filter((q): q is string => typeof q === "string" && q.trim().length > 0)
        .slice(0, 50);
    }
    if (typeof r.reccToken === "string" && r.reccToken.trim()) state.reccToken = r.reccToken;
    if (typeof r.reccAccountName === "string") state.reccAccountName = r.reccAccountName;
    if (typeof r.reccAccountClaimed === "boolean") state.reccAccountClaimed = r.reccAccountClaimed;
    out[id] = state;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run src/config/config.test.ts && npx tsc --noEmit`
Expected: PASS and no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/config/config.ts src/config/config.test.ts
git commit -m "feat(config): ownerEmail, per-profile state, and profile-aware reccd config"
```

---

## Task 3: Per-profile watch history (`src/core/streamHistory.ts`)

**Files:**
- Modify: `src/config/paths.ts`, `src/core/streamHistory.ts`
- Test: `src/core/streamHistory.test.ts`

**Interfaces:**
- Consumes: `OWNER_PROFILE`, `isOwnerProfile` (Task 1); `streamHistoryDir` (added here).
- Produces (signatures change — new optional trailing arg, default owner, so existing callers are unaffected):
  - `loadStreamHistory(profileId?: string): Promise<StreamHistoryItem[]>`
  - `saveStreamHistory(items: readonly StreamHistoryItem[], profileId?: string): Promise<void>`
  - `forgetStreamHistory(key: string, profileId?: string, deps?): Promise<StreamHistoryItem[]>`

- [ ] **Step 1: Add the directory path**

In `src/config/paths.ts`, after `streamHistoryFile` (`:34`):

```ts
// Per-friend stream history. The OWNER keeps streamHistoryFile above unchanged; a
// friend's history is <dataDir>/stream-history/<profileId>.json. A directory, not a
// suffix on the same file, so listing/clearing one friend never risks the others.
export const streamHistoryDir = path.join(dataDir, "stream-history");
```

- [ ] **Step 2: Write the failing test**

```ts
// src/core/streamHistory.test.ts  (add; keep existing tests)
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { slugForEmail } from "./profile";

describe("stream history is isolated per profile", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "torlink-sh-"));
    process.env.TORLINK_STATE_DIR = dir;
    vi.resetModules(); // paths.ts reads TORLINK_STATE_DIR at import time
  });
  afterEach(async () => {
    delete process.env.TORLINK_STATE_DIR;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("keeps a friend's history in a separate file from the owner's", async () => {
    const { loadStreamHistory, saveStreamHistory } = await import("./streamHistory");
    const friend = slugForEmail("friend@example.com");
    const item = (key: string) => ({
      key, title: key, rawName: `${key}.1080p`, infoHash: key, magnet: "magnet:", startedAt: 1,
    });
    await saveStreamHistory([item("Kestrel")]); // owner (default)
    await saveStreamHistory([item("Harrowgate")], friend);

    expect((await loadStreamHistory()).map((e) => e.key)).toEqual(["Kestrel"]);
    expect((await loadStreamHistory(friend)).map((e) => e.key)).toEqual(["Harrowgate"]);
  });
});
```

> Add `import { vi } from "vitest";` if not already imported in the file.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/core/streamHistory.test.ts`
Expected: FAIL — `saveStreamHistory` ignores the second argument / writes one file.

- [ ] **Step 4: Make the module profile-aware**

In `src/core/streamHistory.ts`:

Add imports:

```ts
import path from "node:path";
import { streamHistoryFile, streamHistoryDir } from "../config/paths";
import { OWNER_PROFILE, isOwnerProfile } from "./profile";
```

(replace the existing `import { streamHistoryFile } from "../config/paths";`)

Add a path resolver:

```ts
function fileFor(profileId: string): string {
  return isOwnerProfile(profileId) ? streamHistoryFile : path.join(streamHistoryDir, `${profileId}.json`);
}
```

Change the three functions:

```ts
export function saveStreamHistory(
  items: readonly StreamHistoryItem[],
  profileId: string = OWNER_PROFILE,
): Promise<void> {
  const file = fileFor(profileId);
  return write(async () => {
    if (!isOwnerProfile(profileId)) await fs.mkdir(streamHistoryDir, { recursive: true }).catch(() => {});
    await writeJsonAtomic(file, items.slice(0, STREAM_HISTORY_CAP));
  });
}

export async function loadStreamHistory(profileId: string = OWNER_PROFILE): Promise<StreamHistoryItem[]> {
  let raw: string;
  try {
    raw = await fs.readFile(fileFor(profileId), "utf8");
  } catch {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isStreamHistoryItem).slice(0, STREAM_HISTORY_CAP);
  } catch {
    return [];
  }
}

export async function forgetStreamHistory(
  key: string,
  profileId: string = OWNER_PROFILE,
  deps: {
    load?: () => Promise<StreamHistoryItem[]>;
    save?: (items: readonly StreamHistoryItem[]) => Promise<void>;
  } = {},
): Promise<StreamHistoryItem[]> {
  const next = removeStreamHistory(await (deps.load ?? (() => loadStreamHistory(profileId)))(), key);
  await (deps.save ?? ((items) => saveStreamHistory(items, profileId)))(next);
  return next;
}
```

> Note: existing callers (`forgetStreamHistory(key)` and `forgetStreamHistory(key, { load, save })`) — the TUI at `src/ui/App.tsx:2148` calls `forgetStreamHistory(key)`. That still resolves to the owner and still works. Any caller that passed a deps object as the 2nd arg must move it to the 3rd. Grep `forgetStreamHistory(` across `src/` and fix any call that passed deps positionally.

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/core/streamHistory.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors. If `tsc` flags a `forgetStreamHistory` caller, fix per the note above and re-run.

- [ ] **Step 6: Commit**

```bash
git add src/config/paths.ts src/core/streamHistory.ts src/core/streamHistory.test.ts
git commit -m "feat(core): per-profile stream history files (owner keeps legacy path)"
```

---

## Task 4: Per-profile reccd provisioning (`src/recc/provision.ts`)

**Files:**
- Modify: `src/config/paths.ts`, `src/recc/provision.ts`
- Test: `src/recc/provision.test.ts`

**Interfaces:**
- Consumes: `OWNER_PROFILE`, `isOwnerProfile` (Task 1); `withProfileReccAccount`, `resolveReccConfig` (Task 2); `reccProvisionLockFileForProfile` (added here).
- Produces:
  - `shouldProvision(config: Config, profileId?: string): boolean`
  - `ensureReccAccount(opts?: EnsureReccAccountOptions & { profileId?: string }): Promise<void>`

- [ ] **Step 1: Add the per-profile lock path**

In `src/config/paths.ts`, after `reccProvisionLockFile` (`:24`):

```ts
// A friend's provisioning lock, one per profile so two friends signing up at once
// don't block each other. The owner keeps reccProvisionLockFile above.
export function reccProvisionLockFileForProfile(profileId: string): string {
  return path.join(configDir, `recc-provision.${profileId}.lock`);
}
```

- [ ] **Step 2: Write the failing test**

```ts
// src/recc/provision.test.ts  (add; keep existing tests)
import { describe, expect, it, vi } from "vitest";
import { ensureReccAccount, shouldProvision } from "./provision";
import { slugForEmail } from "../core/profile";
import type { Config } from "../config/config";

const FRIEND = slugForEmail("friend@example.com");
const base: Config = { downloadDir: "/dl", trackers: [] };

describe("per-profile provisioning", () => {
  it("shouldProvision looks at the friend's own token, not the owner's", () => {
    const ownerHasToken: Config = { ...base, reccToken: "owner-tok" };
    // Owner already provisioned, but the friend has nothing → the friend still needs one.
    expect(shouldProvision(ownerHasToken, FRIEND)).toBe(true);
    const friendHasToken: Config = { ...ownerHasToken, profiles: { [FRIEND]: { reccToken: "f" } } };
    expect(shouldProvision(friendHasToken, FRIEND)).toBe(false);
  });

  it("writes the new account into profiles[id], leaving the owner untouched", async () => {
    let saved: Config | undefined;
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ name: "anon-123", token: "friend-tok" }),
    });
    await ensureReccAccount({
      profileId: FRIEND,
      fetchImpl: fetchImpl as never,
      lockFile: `/tmp/torlink-test-${FRIEND}.lock`,
      loadConfigImpl: async () => ({ ...base }),
      saveConfigImpl: async (c) => { saved = c; },
    });
    expect(saved?.profiles?.[FRIEND]?.reccToken).toBe("friend-tok");
    expect(saved?.reccToken).toBeUndefined(); // owner untouched
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/recc/provision.test.ts`
Expected: FAIL — `shouldProvision`/`ensureReccAccount` take no `profileId`.

- [ ] **Step 4: Parameterise provisioning by profile**

In `src/recc/provision.ts`:

Add imports:

```ts
import { OWNER_PROFILE, isOwnerProfile } from "../core/profile";
import { resolveReccConfig, withProfileReccAccount } from "../config/config";
import { reccProvisionLockFileForProfile } from "../config/paths";
```

(extend the existing config/paths imports rather than duplicating).

Change `shouldProvision` to take a profile and check the *profile's* token via `resolveReccConfig`:

```ts
export function shouldProvision(config: Config, profileId: string = OWNER_PROFILE): boolean {
  const auto = config.reccAutoSignup;
  if (auto !== undefined && auto !== true) return false;
  const { reccUrl, reccToken } = resolveReccConfig(config, profileId);
  if (reccToken) return false;
  if (reccUrl && normaliseUrl(reccUrl) !== DEFAULT_RECC_URL) return false;
  return true;
}
```

Add `profileId` to `EnsureReccAccountOptions`:

```ts
  /** Which profile to provision. Defaults to the owner (top-level fields). */
  profileId?: string;
```

In `ensureReccAccount`, resolve the profile, its lock, and route the write through `withProfileReccAccount`:

```ts
export async function ensureReccAccount(opts: EnsureReccAccountOptions = {}): Promise<void> {
  const profileId = opts.profileId ?? OWNER_PROFILE;
  const load = opts.loadConfigImpl ?? loadConfig;
  const save = opts.saveConfigImpl ?? saveConfig;
  const lockFile = opts.lockFile
    ?? (isOwnerProfile(profileId) ? reccProvisionLockFile : reccProvisionLockFileForProfile(profileId));
  const fetchImpl = opts.fetchImpl ?? (fetch as FetchImpl);

  try {
    if (!shouldProvision(await load(), profileId)) return;
    if (!(await takeLock(lockFile))) {
      log.debug("recc provision: another process holds the lock, skipping");
      return;
    }
    try {
      const res = await fetchImpl(`${DEFAULT_RECC_URL}/signup/anonymous`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
      });
      if (!res.ok) { log.debug(`recc provision: signup returned ${res.status}`); return; }
      const body: unknown = await res.json();
      if (!isAnonSignupBody(body)) { log.debug("recc provision: unexpected signup response shape"); return; }

      const fresh = await load();
      if (!shouldProvision(fresh, profileId)) {
        log.debug("recc provision: config changed under us, discarding the new account");
        return;
      }
      const patch: ProvisionedPatch = {
        reccUrl: DEFAULT_RECC_URL,
        reccToken: body.token,
        reccAccountName: body.name,
        reccAccountClaimed: false,
      };
      await save(withProfileReccAccount(fresh, profileId, {
        reccToken: patch.reccToken,
        reccAccountName: patch.reccAccountName,
        reccAccountClaimed: patch.reccAccountClaimed,
      }));
      opts.onProvisioned?.(patch);
      log.debug(`recc provision: created anonymous account ${body.name} for profile ${profileId}`);
    } finally {
      await fs.unlink(lockFile).catch(() => {});
    }
  } catch (err) {
    log.debug(`recc provision: ${err instanceof Error ? err.message : String(err)}`);
  }
}
```

> The owner path is unchanged: `withProfileReccAccount(fresh, OWNER_PROFILE, …)` spreads the same fields onto the top level that the old `{ ...fresh, ...patch }` did (minus `reccUrl`, which the owner already has by the time provisioning succeeds; if any existing owner test asserts `reccUrl` is written, keep `reccUrl: DEFAULT_RECC_URL` in the owner branch of `withProfileReccAccount`). Run the existing provision tests and honour whatever they assert.

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/recc/provision.test.ts && npx tsc --noEmit`
Expected: PASS. If a pre-existing owner test fails on `reccUrl`, adjust the owner branch of `withProfileReccAccount` (Task 2) to also set `reccUrl: DEFAULT_RECC_URL` — but resolve the import cycle by inlining the literal with a comment, as noted in Task 2.

- [ ] **Step 6: Commit**

```bash
git add src/config/paths.ts src/recc/provision.ts src/recc/provision.test.ts
git commit -m "feat(recc): provision an isolated anonymous account per friend profile"
```

---

## Task 5: Thread identity through the web (`src/web/routes.ts` + `src/web/server.ts`)

This is the widest task. `handleWebApi` gains an `accessEmail` parameter; every handler that touches the four lists resolves `profileId` from its own already-loaded config and uses the profile-aware accessors.

**Files:**
- Modify: `src/web/routes.ts`, `src/web/server.ts`
- Test: `src/web/routes.test.ts`

**Interfaces:**
- Consumes: `resolveProfileId` (Task 1); `resolveOwnerEmail`, `profileFavourites`, `withProfileFavourites`, `profileSavedSearches`, `withProfileSavedSearches`, `resolveReccConfig(config, profileId)` (Task 2); `loadStreamHistory`/`saveStreamHistory`/`forgetStreamHistory` with `profileId` (Task 3); `ensureReccAccount({ profileId })` (Task 4).
- Produces: `handleWebApi(deps, method, urlPath, query, authHeader, bodyText, accessEmail?: string)`.

**The call sites to convert** (from `rg -n "resolveReccConfig|loadStreamHistory|saveStreamHistory|forgetStreamHistory|config\.favourites|config\.savedSearches|profileFavourites" src/web/routes.ts` — re-run this grep to get current line numbers, then convert each):
- `recordStreamStart` (`~525`): `loadStreamHistory` / `saveStreamHistory` / `resolveReccConfig` for the `started` event.
- `/api/sources` capability payload (`~815`): `resolveReccConfig(config).reccUrl` — **leave as owner** (this reports whether reccd is configured at all; capability, not per-user). Do NOT thread here.
- favourites GET/POST + `favourited`/`unfavourited` reccd events (`~1205`).
- saved-searches GET/POST.
- recommendations fetch (`fetchRecommendations`), title suggestions (`fetchTitleSuggestions`).
- watch-history list endpoint (`loadStreamHistory`) and forget endpoint (`forgetStreamHistory`).
- generic rate event `/api/recc/event` (`~1869`).

- [ ] **Step 1: Write the failing test**

```ts
// src/web/routes.test.ts  (add; keep existing tests)
import { describe, expect, it } from "vitest";
import { handleWebApi } from "./routes";
import { slugForEmail } from "../core/profile";
// Reuse the file's existing WebDeps test factory. If none exists, build a minimal
// deps object with in-memory loadConfigImpl/saveConfigImpl and stream-history impls,
// following the pattern already used by the other tests in this file.

describe("web favourites are isolated per Access email", () => {
  it("a friend's favourite does not appear in the owner's list", async () => {
    let config = { downloadDir: "/dl", trackers: [], ownerEmail: "owner@example.com" } as never;
    const deps = makeTestDeps({
      loadConfigImpl: async () => config,
      saveConfigImpl: async (c: never) => { config = c; },
    });

    // Friend adds a favourite (exact route/body per this file's favourites endpoint).
    await handleWebApi(deps, "POST", "/api/favourites", new URLSearchParams(), undefined,
      JSON.stringify({ /* favourite payload used elsewhere in this test file */ }),
      "friend@example.com");

    // Owner reads favourites → empty; friend reads → one.
    const ownerList = await handleWebApi(deps, "GET", "/api/favourites", new URLSearchParams(), undefined, "", "owner@example.com");
    const friendList = await handleWebApi(deps, "GET", "/api/favourites", new URLSearchParams(), undefined, "", "friend@example.com");
    expect(JSON.stringify(ownerList)).not.toContain(slugForEmail("friend@example.com"));
    // Assert the owner payload has zero favourites and the friend payload has one,
    // reading the shape the favourites GET handler actually returns.
  });
});
```

> Adapt the assertions to the favourites endpoint's real request/response shape (read the handler first). The point the test must prove: with `ownerEmail` set, a write as `friend@example.com` lands in `config.profiles[slug]` and is invisible to a read as `owner@example.com`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/web/routes.test.ts`
Expected: FAIL — `handleWebApi` ignores the 7th argument; the friend's favourite lands in the shared list.

- [ ] **Step 3: Add the parameter and resolve profileId per handler**

In `handleWebApi` (`src/web/routes.ts:2114`), add the trailing parameter:

```ts
export async function handleWebApi(
  deps: WebDeps,
  method: string,
  urlPath: string,
  query: URLSearchParams,
  authHeader: string | undefined,
  bodyText: string,
  accessEmail?: string,
): Promise<WebResponse> {
```

For **each** converted handler, right after it loads config, resolve the profile and use it. The pattern:

```ts
const config = await (deps.loadConfigImpl ?? loadConfig)();
const profileId = resolveProfileId(accessEmail, resolveOwnerEmail(config));
```

Then substitute:
- `resolveReccConfig(config)` → `resolveReccConfig(config, profileId)`
- `loadStreamHistory()` → `loadStreamHistory(profileId)`; `saveStreamHistory(x)` → `saveStreamHistory(x, profileId)`; `forgetStreamHistory(key)` → `forgetStreamHistory(key, profileId)`
- reads of `config.favourites` → `profileFavourites(config, profileId)`; writes that build a new config with favourites → `withProfileFavourites(config, profileId, next)` before `saveConfig`
- `config.savedSearches` → `profileSavedSearches` / `withProfileSavedSearches` likewise

`recordStreamStart` takes the email through and provisions a friend's reccd account lazily. Change its signature to accept `accessEmail` and add, before sending the `started` event:

```ts
const profileId = resolveProfileId(accessEmail, resolveOwnerEmail(config));
// A friend's first stream provisions their own reccd account so their taste never
// mixes with the owner's. Fire-and-forget, same rule as the event send below.
if (!isOwnerProfile(profileId) && !resolveReccConfig(config, profileId).reccToken) {
  void ensureReccAccount({ profileId }).catch(() => {});
}
const reccConfig = resolveReccConfig(config, profileId);
```

Add the imports at the top of `routes.ts`:

```ts
import { resolveProfileId, isOwnerProfile } from "../core/profile";
import {
  resolveOwnerEmail, profileFavourites, withProfileFavourites,
  profileSavedSearches, withProfileSavedSearches,
} from "../config/config";
import { ensureReccAccount } from "../recc/provision";
```

(merge with existing imports from those modules).

Thread `accessEmail` from `handleWebApi` into `recordStreamStart` and any other converted helper that currently receives `deps` but not the email.

- [ ] **Step 4: Pass the verified email from the server**

In `src/web/server.ts`, capture the email at the Access check (`:521-536`) and pass it to the router (`:611`):

```ts
      let accessEmail: string | undefined;
      if (accessCfg) {
        const exempt = urlPath === "/health" || isStreamPath(urlPath) || isPlayPath(urlPath);
        if (!exempt) {
          const assertion = accessTokenFromHeaders(req.headers);
          const verdict = await verifyAccessAssertion(assertion, accessKeySet!, accessCfg);
          if (!verdict.ok) {
            writeJson(res, 403, { error: "forbidden" });
            log(`${method} ${urlPath} -> 403 (access: ${verdict.reason})`);
            return;
          }
          accessEmail = verdict.email;
        }
      }
```

And at the `handleWebApi(...)` call (`:611`), add `accessEmail` as the final argument:

```ts
          out = await handleWebApi(
            routeDeps,
            method === "HEAD" ? "GET" : method,
            urlPath,
            url.searchParams,
            req.headers.authorization,
            body.text,
            accessEmail,
          );
```

- [ ] **Step 5: Run tests + full gate**

Run: `npx vitest run src/web/routes.test.ts && npm test && npm run typecheck && npm run lint && npm run build`
Expected: PASS. `npm run build` also confirms `src/web/static/` still imports no `node:*`.

- [ ] **Step 6: Manual smoke (wiring is only verified by running it)**

Run: `npm run dev -- serve --web`, then with `ownerEmail` set in config, send two requests with different `Cf-Access-Jwt-Assertion`-derived emails (or temporarily hardcode `accessEmail` in a dev build) and confirm favourites/watch-history diverge. Revert any temporary hack.

- [ ] **Step 7: Commit**

```bash
git add src/web/routes.ts src/web/server.ts src/web/routes.test.ts
git commit -m "feat(web): partition watch history, favourites, saved searches, and reccd per Access login"
```

---

## Task 6: Confirm the TUI is owner-only (parity check) + docs

The TUI needs no functional change: every profile-aware function defaults to `OWNER_PROFILE`, and the TUI passes no profile, so it operates on the owner's existing storage. This task proves that with a test and documents the feature.

**Files:**
- Test: `src/core/streamHistory.test.ts` (add one assertion) — or a small `src/config/config.test.ts` assertion.
- Modify: `README.md`.

- [ ] **Step 1: Add a regression test that the default is the owner**

```ts
// Add to src/config/config.test.ts
import { OWNER_PROFILE } from "../core/profile";
it("resolveReccConfig with no profile is identical to the owner profile", () => {
  const cfg = { downloadDir: "/dl", trackers: [], reccToken: "owner-tok" } as Config;
  expect(resolveReccConfig(cfg)).toEqual(resolveReccConfig(cfg, OWNER_PROFILE));
});
```

Run: `npx vitest run src/config/config.test.ts`
Expected: PASS.

- [ ] **Step 2: Document the feature in `README.md`**

Add a short section (place near any existing Cloudflare Access / `serve --web` docs):

```markdown
### Sharing the server behind Cloudflare Access

When torlink runs behind Cloudflare Access with named users, set `ownerEmail` (in
`config.json`, or the `TORLINK_OWNER_EMAIL` env var) to your own Access email. Then:

- **You** (that email, and the terminal UI) keep the existing watch history,
  favourites, saved searches, and recommendations.
- **Anyone else** who signs in through Access gets their own private watch history,
  favourites, saved searches, and their own anonymous reccd account — so their viewing
  never touches yours.

Sources, tokens, and machine settings stay shared. With no `ownerEmail` set, torlink
behaves exactly as before (single shared state).
```

- [ ] **Step 3: Full gate**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: PASS (the one pre-existing `App.tsx` exhaustive-deps warning aside).

- [ ] **Step 4: Commit**

```bash
git add README.md src/config/config.test.ts
git commit -m "docs: document per-login isolation behind Cloudflare Access"
```

---

## PR notes

State explicitly in the PR body: **reading identity from Cloudflare Access headers is deliberately web-only** — Access headers exist only on the web transport and the TUI has no remote users, so the TUI always operates as the owner. This is the documented "a surface can't express it / host-specific" exception to the both-front-ends rule. The profile concept and all four profile-scoped accessors live in `src/core`/`src/config` and are driven by both surfaces (the TUI via owner defaults).

Base the PR against `origin`/`WarlaxZ/torlink` (`gh pr create --repo WarlaxZ/torlink --base main`); never `forked-from`. Push as the `WarlaxZ` gh user.

---

## Self-Review

- **Spec coverage:** profiles keyed by email (Task 1) ✓; owner explicit via `ownerEmail`/env (Task 2) ✓; reccd auto-provision per profile (Task 4 + lazy trigger in Task 5) ✓; owner-keeps-legacy storage / no migration (Tasks 2–3) ✓; four lists partitioned — watch history (Task 3), favourites + saved searches (Task 2 accessors, wired Task 5), reccd (Tasks 2/4/5) ✓; fail-soft to owner (Task 1 + defaults) ✓; web-only identity, TUI owner (Task 6 + PR note) ✓; tests + fixtures rule (each task) ✓; docs (Task 6) ✓.
- **Placeholder scan:** the one soft spot is Task 5 Step 1's test body, which references "the favourites payload used elsewhere in this file" — this is deliberate (the implementer must read the real endpoint shape first) and the *behaviour* to prove is stated exactly. No `TODO`/`TBD` remain.
- **Type consistency:** `resolveProfileId(email, ownerEmail)`, `resolveReccConfig(config, profileId)`, `profileFavourites/withProfileFavourites`, `saveStreamHistory(items, profileId)`, `ensureReccAccount({ profileId })`, `handleWebApi(..., accessEmail)` are used with the same signatures across tasks. `OWNER_PROFILE`/`isOwnerProfile` come from `src/core/profile` everywhere.
- **Import-cycle watch:** `config.ts` importing `DEFAULT_RECC_URL` from `provision.ts` would cycle (provision imports config). Task 2 avoids it (owner branch spreads only the token patch); if `reccUrl` must be written, inline the literal. Flagged in Tasks 2 and 4.
