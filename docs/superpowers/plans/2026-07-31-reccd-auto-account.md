# reccd Auto-Provisioned Accounts, and Claiming Them — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** torlink creates an anonymous reccd account on first run with no human involvement, and lets the user later claim it with a username and password of their choosing.

**Architecture:** reccd gains three endpoints (`POST /signup/anonymous`, `POST /claim`, plus an `account` field on `GET /profile`). torlink gains one new module, `src/recc/provision.ts`, which is called fire-and-forget from both process entry points behind a cross-process lock file; a claim prompt in the TUI's Accounts pane; and one new field on `/api/sources` so the browser can say the account is unclaimed.

**Tech Stack:** reccd — Fastify 5, `@fastify/rate-limit`, node-postgres, vitest against a real Postgres schema. torlink — TypeScript ESM, Ink + React (TUI), a hand-rolled HTTP server and a no-framework browser bundle, vitest with no jsdom.

**Spec:** `docs/superpowers/specs/2026-07-31-reccd-auto-account-design.md`. Read §0 before writing any code.

## Global Constraints

Every task's requirements implicitly include all of these.

- **reccd is a value-add, never a dependency.** No reccd failure may degrade anything but recommendations. Spec §0 is the authority and it outranks every other requirement in this document.
- **Nothing awaits `ensureReccAccount`.** Both call sites are exactly `void ensureReccAccount({...}).catch(() => {});`.
- **`ensureReccAccount` never throws and never rejects.** Return type `Promise<void>`.
- Every reccd HTTP call carries `AbortSignal.timeout`: signup **8000ms**, claim **10000ms**, `/profile` 6000ms (existing), `/events` 3000ms (existing).
- **Two repos.** Tasks 1–5 are in `../reccd` (a separate git repo — commit there separately). Tasks 6–18 are in torlink. Never `cd` out of the worktree for torlink work.
- **torlink layering, enforced by `eslint.config.js`:** `src/web` must not import from `src/ui`; `src/core` must not import from either.
- **No `innerHTML` / `insertAdjacentHTML` / `document.write` / `outerHTML` anywhere in `src/web/static/`.** `createElement` + `textContent` only. Release names and filenames are attacker-controlled.
- **Config writes from the web are read-modify-write per request.** Never hold a snapshot across a request or a network call.
- **No real film or show titles** in any test, fixture, comment, or user-facing string. Reuse the cast in `CLAUDE.md`: `Kestrel.2010.1080p.BluRay.x264`, `Ashfall.1999.1080p`, `Tin.Rivers.2024.2160p.WEB-DL.DV.HDR.Atmos.7.1-GROUP`, `Kepler.S02E04.1080p.WEB-DL`, `Harrowgate.S03.1080p.WEB-DL`.
- **`DEFAULT_RECC_URL = "https://reccd.stream"`** is defined once, in `src/recc/provision.ts`, and imported everywhere else.
- Before declaring any torlink task done: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`. One known pre-existing lint warning (`react-hooks/exhaustive-deps` in `src/ui/App.tsx`) — leave it.
- reccd tests need Postgres. `npm test` in `../reccd` uses `vitest.setup.ts`/`globalSetup` to provide `RECCD_TEST_DATABASE_URL`; if it is unset the helpers throw with that exact message. Do not work around it — get Postgres up.
- Conventional Commits. Commit at the end of every task.

## File Structure

**`../reccd`**

| File | Responsibility |
| --- | --- |
| `src/db/users.ts` (modify) | Add `claimUser`, `getUserAccount`. Sole definition of `activity.users`. |
| `src/db/users.test.ts` (modify) | Unit tests for both, against a real schema. |
| `src/api/anonName.ts` (create) | Pure name generator. No DB, no Fastify — so it is testable alone. |
| `src/api/anonName.test.ts` (create) | Shape and distinctness tests. |
| `src/api/server.ts` (modify) | The two new routes, plus `account` on `/profile`. |
| `src/api/server.test.ts` (modify) | Route tests including the rate limit. |
| `README.md` (modify) | API docs for both routes; the public-route list; the spoofing warning. |

**torlink**

| File | Responsibility |
| --- | --- |
| `src/recc/provision.ts` (create) | `DEFAULT_RECC_URL`, `shouldProvision` (pure), `ensureReccAccount` (effects + lock). |
| `src/recc/provision.test.ts` (create) | Bail-outs, the lock, every failure mode resolving. |
| `src/recc/client.ts` (modify) | `claimReccAccount` — a blocking call with a discriminated result. |
| `src/recc/status.ts` (modify) | `ReccStatus.account`, and the suffix in `formatReccStatus`. |
| `src/config/config.ts` (modify) | Three new `Config` fields. |
| `src/config/paths.ts` (modify) | `reccProvisionLockFile`. |
| `src/ui/components/ReccClaimPrompt.tsx` (create) | Two-field claim overlay. Its own file — `ReccdPrompt` keeps its own job. |
| `src/ui/components/Accounts.tsx` (modify) | `claimable` row flag, the `c` key, the hint. |
| `src/ui/keymap.ts` (modify) | Both halves — `HELP_GROUPS` and `footerHints`. |
| `src/ui/App.tsx` (modify) | The provisioning call with `onProvisioned`; claim state and handler. |
| `src/daemon/serve.ts` (modify) | The second provisioning call site. |
| `src/web/wire.ts` (modify) | `PublicReccAccount`, `SourcesResponse.reccAccount`. |
| `src/web/routes.ts` (modify) | Populate `reccAccount` in `sourcesResponse`. |
| `src/web/static/reccModel.ts` (modify) | `reccClaimHint` — pure. |
| `src/web/static/app.ts` (modify) | Mount the hint's text node. Wiring only. |
| `README.md` (modify) | Default behaviour, the opt-out, claiming, the shared-config caveat. |

---

## Task 1: reccd — `claimUser` and `getUserAccount`

**Repo:** `../reccd`

**Files:**
- Modify: `src/db/users.ts` (append after `reissueToken`, ~line 131)
- Test: `src/db/users.test.ts`

**Interfaces:**
- Consumes: `hashPassword`, `ensureUsersTable` (both already exported from this file).
- Produces:
  - `claimUser(pool: Pool, userId: number, name: string, password: string): Promise<"claimed" | "notClaimable">` — throws on `23505`, which the caller maps to 409.
  - `getUserAccount(pool: Pool, userId: number): Promise<{ name: string; claimed: boolean } | undefined>`

- [ ] **Step 1: Write the failing tests**

Append to `src/db/users.test.ts`:

```ts
describe("claimUser", () => {
  it("sets the name and password on a fresh public account", async () => {
    const user = await createUser(pool, "anon-one", { isPublic: true });
    const outcome = await claimUser(pool, user.id, "chosenname", "correcthorsebattery");
    expect(outcome).toBe("claimed");

    const creds = await findUserCredentialsByName(pool, "chosenname");
    expect(creds?.id).toBe(user.id);
    expect(creds?.passwordHash).not.toBeNull();
    expect(await verifyPassword("correcthorsebattery", creds!.passwordHash!)).toBe(true);
  });

  it("keeps the existing token working, so a claim never signs the user out", async () => {
    const user = await createUser(pool, "anon-two", { isPublic: true });
    await claimUser(pool, user.id, "stillmine", "correcthorsebattery");
    const found = await findUserByToken(pool, user.token);
    expect(found?.id).toBe(user.id);
    expect(found?.name).toBe("stillmine");
  });

  it("refuses an account that already has a password", async () => {
    const user = await createUser(pool, "anon-three", { isPublic: true, password: "correcthorsebattery" });
    expect(await claimUser(pool, user.id, "renamed", "anotherpassword")).toBe("notClaimable");
    expect(await findUserByName(pool, "anon-three")).toBeDefined();
    expect(await findUserByName(pool, "renamed")).toBeUndefined();
  });

  // The guard that protects other users' `with=` lists: a household account is
  // also password-less, and renaming one silently breaks every group
  // recommendation that names it.
  it("refuses a household (non-public) account even though it has no password", async () => {
    const user = await createUser(pool, "household-member");
    expect(await claimUser(pool, user.id, "sneaky", "correcthorsebattery")).toBe("notClaimable");
    expect(await findUserByName(pool, "household-member")).toBeDefined();
  });

  it("leaves the account public after claiming", async () => {
    const user = await createUser(pool, "anon-four", { isPublic: true });
    await claimUser(pool, user.id, "claimedpublic", "correcthorsebattery");
    expect(await isPublicUser(pool, user.id)).toBe(true);
  });

  it("throws a 23505 unique violation when the chosen name is taken", async () => {
    await createUser(pool, "taken");
    const user = await createUser(pool, "anon-five", { isPublic: true });
    await expect(claimUser(pool, user.id, "taken", "correcthorsebattery")).rejects.toMatchObject({
      code: "23505",
    });
  });

  it("returns notClaimable for an id that does not exist", async () => {
    expect(await claimUser(pool, 999999, "ghost", "correcthorsebattery")).toBe("notClaimable");
  });
});

describe("getUserAccount", () => {
  it("reports claimed: false for a password-less account", async () => {
    const user = await createUser(pool, "anon-six", { isPublic: true });
    expect(await getUserAccount(pool, user.id)).toEqual({ name: "anon-six", claimed: false });
  });

  it("reports claimed: true once a password is set", async () => {
    const user = await createUser(pool, "anon-seven", { isPublic: true });
    await claimUser(pool, user.id, "named", "correcthorsebattery");
    expect(await getUserAccount(pool, user.id)).toEqual({ name: "named", claimed: true });
  });

  it("returns undefined for an unknown id", async () => {
    expect(await getUserAccount(pool, 999999)).toBeUndefined();
  });
});
```

Add `claimUser` and `getUserAccount` to the import list at the top of the file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ../reccd && npm test -- src/db/users.test.ts`
Expected: FAIL — `claimUser is not a function` / TypeScript cannot resolve the import.

- [ ] **Step 3: Implement**

Append to `src/db/users.ts`:

```ts
// Sets a chosen name and password on an anonymous account, keeping its id,
// its token, and every event already recorded against it.
//
// The WHERE clause carries the whole policy, deliberately, so there is no
// window between a check and the write:
//
//   password_hash IS NULL  -- claim once; a second claim is not a password change
//   is_public = true       -- NOT tidiness. Household accounts created by
//                             `user:add` are also password-less, and their names
//                             are load-bearing: other users reference them in
//                             `?with=<name>` group recommendations, and
//                             findHouseholdUserByName resolves them by name. A
//                             rename there silently breaks other people's data.
//
// A name collision surfaces as a thrown 23505; the caller maps it to 409,
// matching how the /signup route already handles the same case.
export async function claimUser(
  pool: Pool,
  userId: number,
  name: string,
  password: string
): Promise<"claimed" | "notClaimable"> {
  const passwordHash = await hashPassword(password);
  const result = await pool.query(
    `UPDATE activity.users SET name = $1, password_hash = $2
      WHERE id = $3 AND password_hash IS NULL AND is_public = true`,
    [name, passwordHash, userId]
  );
  return result.rowCount === 1 ? "claimed" : "notClaimable";
}

// The account's public identity, for GET /profile. `claimed` is derived rather
// than stored: a password is exactly what makes an account reachable from
// another machine, so it IS the claim.
export async function getUserAccount(
  pool: Pool,
  userId: number
): Promise<{ name: string; claimed: boolean } | undefined> {
  const { rows } = await pool.query<{ name: string; claimed: boolean }>(
    `SELECT name, (password_hash IS NOT NULL) AS claimed FROM activity.users WHERE id = $1`,
    [userId]
  );
  return rows[0];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ../reccd && npm test -- src/db/users.test.ts`
Expected: PASS, all ten new tests.

- [ ] **Step 5: Commit**

```bash
cd ../reccd
git add src/db/users.ts src/db/users.test.ts
git commit -m "feat(db): claim an anonymous account, and report its identity

claimUser sets a name and password on a password-less public account in a
single guarded UPDATE. The is_public = true guard stops a household account
renaming itself, which would break other users' ?with= lists."
```

---

## Task 2: reccd — the anonymous name generator

**Repo:** `../reccd`

**Files:**
- Create: `src/api/anonName.ts`
- Test: `src/api/anonName.test.ts`

**Interfaces:**
- Produces: `generateAnonName(): string` — e.g. `quiet-heron-4f2a`.

- [ ] **Step 1: Write the failing test**

Create `src/api/anonName.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { generateAnonName, ADJECTIVES, NOUNS } from "./anonName.js";

describe("generateAnonName", () => {
  it("returns adjective-noun-hex4, lowercase", () => {
    expect(generateAnonName()).toMatch(/^[a-z]+-[a-z]+-[0-9a-f]{4}$/);
  });

  it("stays inside the 64-character name limit /signup enforces", () => {
    for (let i = 0; i < 200; i++) expect(generateAnonName().length).toBeLessThanOrEqual(64);
  });

  it("does not repeat itself in a small sample", () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateAnonName()));
    // Not `toBe(200)`: 200 draws from ~37.7M names carry a ~1-in-1,900 chance of
    // a genuine collision, which would fail this test on a correct
    // implementation. A floor well above the 576 word-pairs still catches the
    // failure this guards -- a seeded, cached, or memoised RNG.
    expect(seen.size).toBeGreaterThan(190);
  });

  // The cross-list rule is documented in anonName.ts and enforced nowhere else,
  // so it is enforced here. Requires ADJECTIVES and NOUNS to be exported.
  it("shares no word between the two lists, so no name pairs with itself", () => {
    const overlap = ADJECTIVES.filter((w) => NOUNS.includes(w));
    expect(overlap).toEqual([]);
  });

  it("has no duplicates within either list", () => {
    expect(new Set(ADJECTIVES).size).toBe(ADJECTIVES.length);
    expect(new Set(NOUNS).size).toBe(NOUNS.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ../reccd && npm test -- src/api/anonName.test.ts`
Expected: FAIL — cannot resolve `./anonName.js`.

- [ ] **Step 3: Implement**

Create `src/api/anonName.ts`:

```ts
import crypto from "node:crypto";

// Deliberately dull words. These become a username a stranger may see, and the
// name is ASSIGNED rather than chosen, so the bar is higher than "we wouldn't
// mind it": no real people, no place names that read as people, no film or show
// titles, nothing that reads as an insult alone or in combination, and no word
// describing a body or a character. A word must also not appear in both lists —
// a self-paired `hazel-hazel-4f2a` reads as a bug to whoever is handed it, and
// nothing in the code enforces this, so the tests below do.
// Exported so the tests can enforce the two rules above that the code cannot.
export const ADJECTIVES = [
  "quiet", "amber", "hollow", "drifting", "copper", "steady", "distant", "gentle",
  "narrow", "silver", "patient", "ochre", "pebbled", "russet", "brisk", "muted",
  "woven", "faded", "wandering", "modest", "glassy", "pewter", "tranquil", "misty",
];

export const NOUNS = [
  "heron", "alder", "willow", "plover", "cedar", "linnet", "birch", "swift",
  "hawthorn", "sparrow", "rowan", "curlew", "juniper", "wren", "maple", "godwit",
  "hazel", "finch", "aspen", "dipper", "larch", "avocet", "elder", "pipit",
];

// 24 x 24 x 65536 is a little over 37 million, so collisions are rare enough
// that the caller's retry loop is a formality rather than a hot path.
export function generateAnonName(): string {
  const adjective = ADJECTIVES[crypto.randomInt(ADJECTIVES.length)];
  const noun = NOUNS[crypto.randomInt(NOUNS.length)];
  const suffix = crypto.randomBytes(2).toString("hex");
  return `${adjective}-${noun}-${suffix}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ../reccd && npm test -- src/api/anonName.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
cd ../reccd
git add src/api/anonName.ts src/api/anonName.test.ts
git commit -m "feat(api): generate anonymous account names"
```

---

## Task 3: reccd — `POST /signup/anonymous`

**Repo:** `../reccd`

**Files:**
- Modify: `src/api/server.ts` — inside the existing `app.after(() => { ... })` block (opens ~line 182), after the `/signup` route
- Test: `src/api/server.test.ts`

**Interfaces:**
- Consumes: `generateAnonName` (Task 2), `createUser` (already imported).
- Produces: `POST /signup/anonymous` → `201 { id: number, name: string, token: string }`.

**Why inside `app.after()`:** the comment above `/signup` in this file already explains it — `@fastify/rate-limit`'s `onRoute` hook must have run before the route is declared, or the per-route limit silently does not apply and the rate-limit test gets `201` instead of `429`. Declare it next to `/signup`, not at the top level.

- [ ] **Step 1: Write the failing tests**

Add to `src/api/server.test.ts` after the `POST /signup` describe block:

```ts
describe("POST /signup/anonymous", () => {
  it("creates a usable account with no request body at all", async () => {
    const res = await app.inject({ method: "POST", url: "/signup/anonymous" });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.name).toMatch(/^[a-z]+-[a-z]+-[0-9a-f]{4}$/);
    expect(body.token).toMatch(/^[0-9a-f]{64}$/);
    expect(body.id).toBeGreaterThan(0);

    const profileRes = await app.inject({
      method: "GET",
      url: "/profile",
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(profileRes.statusCode).toBe(200);
  });

  it("creates a public, password-less account — so it is claimable", async () => {
    const res = await app.inject({ method: "POST", url: "/signup/anonymous" });
    const { name } = res.json();
    const creds = await findUserCredentialsByName(pool, name);
    expect(creds?.passwordHash).toBeNull();
    expect(await isPublicUser(pool, creds!.id)).toBe(true);
  });

  it("ignores a body rather than 400-ing on one", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/signup/anonymous",
      payload: { name: "ignored", password: "ignored-too" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().name).not.toBe("ignored");
  });

  it("gives two callers different accounts", async () => {
    const a = await app.inject({ method: "POST", url: "/signup/anonymous" });
    const b = await app.inject({ method: "POST", url: "/signup/anonymous" });
    expect(a.json().id).not.toBe(b.json().id);
    expect(a.json().token).not.toBe(b.json().token);
  });

  it("rate-limits to 3/hour per source IP, and keys on the IP not globally", async () => {
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/signup/anonymous",
        headers: { "cf-connecting-ip": "3.3.3.3" },
      });
      expect(res.statusCode).toBe(201);
    }
    const blocked = await app.inject({
      method: "POST",
      url: "/signup/anonymous",
      headers: { "cf-connecting-ip": "3.3.3.3" },
    });
    expect(blocked.statusCode).toBe(429);

    const otherIp = await app.inject({
      method: "POST",
      url: "/signup/anonymous",
      headers: { "cf-connecting-ip": "4.4.4.4" },
    });
    expect(otherIp.statusCode).toBe(201);
  });
});
```

Add `findUserCredentialsByName` and `isPublicUser` to this file's import from `../db/users.js` if they are not already there.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ../reccd && npm test -- src/api/server.test.ts -t "signup/anonymous"`
Expected: FAIL with `404` — the route does not exist.

- [ ] **Step 3: Implement**

Add the import at the top of `src/api/server.ts`:

```ts
import { generateAnonName } from "./anonName.js";
```

Inside the `app.after(() => { ... })` block, after the `/signup` route:

```ts
    // Zero-configuration signup: torlink calls this on first run so a user
    // gets recommendations without standing anything up or pasting anything.
    // No body, because there is nothing for a caller to choose -- the name is
    // ours to generate and the account has no password until it is claimed.
    //
    // 3/hour rather than /signup's 5: nothing human-driven calls this, and one
    // machine needs it exactly once. The same cf-connecting-ip spoofing caveat
    // in the README applies, and applies harder -- this is the cheapest of the
    // public routes to abuse, since it needs no payload.
    app.post(
      "/signup/anonymous",
      { config: { public: true, rateLimit: { max: 3, timeWindow: "1 hour" } } },
      async (_req, reply) => {
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            const user = await createUser(deps.pool, generateAnonName(), { isPublic: true });
            reply.code(201);
            return { id: user.id, name: user.name, token: user.token };
          } catch (err) {
            // 23505 is a name collision -- draw again. Anything else is a real
            // failure and belongs in the error handler, not this loop.
            if (err && typeof err === "object" && "code" in err && err.code === "23505") continue;
            throw err;
          }
        }
        reply.code(503);
        return { error: "could not allocate a name" };
      }
    );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ../reccd && npm test -- src/api/server.test.ts`
Expected: PASS — the 5 new tests, and every pre-existing test in the file still green.

- [ ] **Step 5: Commit**

```bash
cd ../reccd
git add src/api/server.ts src/api/server.test.ts
git commit -m "feat(api): POST /signup/anonymous for zero-configuration accounts"
```

---

## Task 4: reccd — `POST /claim`

**Repo:** `../reccd`

**Files:**
- Modify: `src/api/server.ts` — a **top-level** route (not inside `app.after()`), next to `GET /profile`
- Test: `src/api/server.test.ts`

**Interfaces:**
- Consumes: `claimUser` (Task 1).
- Produces: `POST /claim` → `200 { name }` / `400` / `409`.

**Why top-level, unlike Task 3:** this route is authenticated, so it carries no per-route `rateLimit` config and does not need `app.after()`'s ordering. Registering it at the top level also means the `onRequest` auth hook applies, which is the whole point — a caller must already hold a valid token.

- [ ] **Step 1: Write the failing tests**

Add to `src/api/server.test.ts`:

```ts
describe("POST /claim", () => {
  async function anonToken(): Promise<string> {
    const res = await app.inject({ method: "POST", url: "/signup/anonymous" });
    return res.json().token;
  }

  it("sets a name and password, and the old token keeps working", async () => {
    const token = await anonToken();
    const res = await app.inject({
      method: "POST",
      url: "/claim",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "mynewname", password: "correcthorsebattery" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ name: "mynewname" });

    const profile = await app.inject({
      method: "GET",
      url: "/profile",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(profile.statusCode).toBe(200);
  });

  it("lets the user log in afterwards, which is the entire point", async () => {
    const token = await anonToken();
    await app.inject({
      method: "POST",
      url: "/claim",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "loginable", password: "correcthorsebattery" },
    });
    const login = await app.inject({
      method: "POST",
      url: "/login",
      payload: { name: "loginable", password: "correcthorsebattery" },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps events recorded before the claim", async () => {
    const token = await anonToken();
    await app.inject({
      method: "POST",
      url: "/events",
      headers: { authorization: `Bearer ${token}` },
      payload: { events: [{ type: "watched", rawName: "Kestrel.2010.1080p.BluRay.x264", ts: 1, source: "test" }] },
    });
    await app.inject({
      method: "POST",
      url: "/claim",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "keptmyhistory", password: "correcthorsebattery" },
    });
    const profile = await app.inject({
      method: "GET",
      url: "/profile",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(profile.json().account).toEqual({ name: "keptmyhistory", claimed: true });
    expect(profile.json().seenImdbIds.length).toBeGreaterThan(0);
  });

  it("returns 401 with no token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/claim",
      payload: { name: "nobody", password: "correcthorsebattery" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 409 when the chosen name is taken", async () => {
    const token = await anonToken();
    const res = await app.inject({
      method: "POST",
      url: "/claim",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "ash", password: "correcthorsebattery" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "name already taken" });
  });

  it("returns 400 on a second claim", async () => {
    const token = await anonToken();
    await app.inject({
      method: "POST",
      url: "/claim",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "claimedonce", password: "correcthorsebattery" },
    });
    const again = await app.inject({
      method: "POST",
      url: "/claim",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "claimedtwice", password: "anotherpassword" },
    });
    expect(again.statusCode).toBe(400);
    expect(again.json()).toEqual({ error: "account already claimed" });
  });

  it("returns 400 for a household account, which is not claimable", async () => {
    // TOKEN is user "ash", created by this file's beforeEach via createUser
    // with no isPublic -- i.e. a household account, password-less.
    const res = await app.inject({
      method: "POST",
      url: "/claim",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { name: "renamedhousehold", password: "correcthorsebattery" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "account already claimed" });
  });

  it("returns 400 (not 500) for a non-string name", async () => {
    const token = await anonToken();
    const res = await app.inject({
      method: "POST",
      url: "/claim",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 123, password: "correcthorsebattery" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "name and password must be strings" });
  });

  it("returns 400 for a password shorter than 8 characters", async () => {
    const token = await anonToken();
    const res = await app.inject({
      method: "POST",
      url: "/claim",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "shortpw2", password: "short" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "password must be at least 8 characters" });
  });

  it("returns 400 for a name over 64 characters", async () => {
    const token = await anonToken();
    const res = await app.inject({
      method: "POST",
      url: "/claim",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "x".repeat(65), password: "correcthorsebattery" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "name must be 1-64 characters" });
  });
});
```

**Note on the household case:** it returns the same `400 account already claimed` as a genuine second claim. That is deliberate — the two are indistinguishable to a caller, and being precise ("this is a household account") would tell an attacker holding a stolen token which population it belongs to. The `claimUser` unit tests in Task 1 are where the two cases are told apart.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ../reccd && npm test -- src/api/server.test.ts -t "POST /claim"`
Expected: FAIL with `404`.

- [ ] **Step 3: Implement**

Add `claimUser` to the `../db/users.js` import. Then, immediately after the `GET /profile` route in `src/api/server.ts`:

```ts
  // Turns an anonymous account into one the user can log into, keeping its id,
  // its token and its whole history. Authenticated rather than public: holding
  // the account's token IS the proof of ownership, and that also means no extra
  // rate limit is needed -- an attacker has to have a valid token to make an
  // attempt at all.
  app.post("/claim", async (req, reply) => {
    const body = (req.body ?? {}) as { name?: unknown; password?: unknown };
    if (typeof body.name !== "string" || typeof body.password !== "string") {
      reply.code(400);
      return { error: "name and password must be strings" };
    }
    const name = body.name.trim();
    const password = body.password;

    // Same limits and same strings as /signup, so the two cannot drift apart.
    if (!name || name.length > 64) {
      reply.code(400);
      return { error: "name must be 1-64 characters" };
    }
    if (password.length < 8) {
      reply.code(400);
      return { error: "password must be at least 8 characters" };
    }

    try {
      const outcome = await claimUser(deps.pool, req.userId, name, password);
      if (outcome === "notClaimable") {
        // Covers both "already has a password" and "is a household account".
        // Deliberately one message: a caller cannot act on the difference, and
        // distinguishing them would tell whoever holds this token which
        // population the account belongs to.
        reply.code(400);
        return { error: "account already claimed" };
      }
      return { name };
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && err.code === "23505") {
        reply.code(409);
        return { error: "name already taken" };
      }
      throw err;
    }
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ../reccd && npm test -- src/api/server.test.ts`
Expected: PASS. The `keeps events recorded before the claim` test also needs Task 5 — if it fails on `account` being undefined, do Task 5 and re-run.

- [ ] **Step 5: Commit**

```bash
cd ../reccd
git add src/api/server.ts src/api/server.test.ts
git commit -m "feat(api): POST /claim turns an anonymous account into a login"
```

---

## Task 5: reccd — `account` on `GET /profile`, and the README

**Repo:** `../reccd`

**Files:**
- Modify: `src/api/server.ts:326-329` (the `/profile` handler)
- Modify: `README.md` — the API section's preamble, the deployment warning, and new subsections
- Test: `src/api/server.test.ts`

**Interfaces:**
- Consumes: `getUserAccount` (Task 1).
- Produces: `GET /profile` → `{ ...tasteProfile, seenImdbIds: string[], account: { name, claimed } }`.

- [ ] **Step 1: Write the failing tests**

Add to the existing `describe("GET /profile")` block in `src/api/server.test.ts`:

```ts
  it("reports the account's name and claim state", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/profile",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.json().account).toEqual({ name: "ash", claimed: false });
  });

  it("flips claimed to true after a claim", async () => {
    const signup = await app.inject({ method: "POST", url: "/signup/anonymous" });
    const token = signup.json().token;
    await app.inject({
      method: "POST",
      url: "/claim",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "profileclaimed", password: "correcthorsebattery" },
    });
    const res = await app.inject({
      method: "GET",
      url: "/profile",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.json().account).toEqual({ name: "profileclaimed", claimed: true });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ../reccd && npm test -- src/api/server.test.ts -t "profile"`
Expected: FAIL — `account` is `undefined`.

- [ ] **Step 3: Implement**

Add `getUserAccount` to the `../db/users.js` import, then replace the `/profile` handler:

```ts
  app.get("/profile", async (req) => {
    const profile = await buildTasteProfile(deps.pool, req.userId);
    // `account` rides on the profile rather than getting its own route because
    // torlink already polls /profile to classify its connection -- so it learns
    // the authoritative name and claim state on every status check, including
    // when the account was claimed from a different machine.
    const account = await getUserAccount(deps.pool, req.userId);
    return { ...profile, seenImdbIds: [...profile.seenImdbIds], account };
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ../reccd && npm test`
Expected: PASS — the whole reccd suite, including every Task 1–4 test.

- [ ] **Step 5: Update the reccd README**

Three edits in `README.md`:

1. In the API preamble (~line 288), change the endpoint list so the public routes read:
   `All endpoints except `POST /signup`, `POST /signup/anonymous` and `POST /login` require `Authorization: Bearer <user token>`...`
2. The "Deployment warning" paragraph names `/signup` and `/login`. Rewrite its first sentence to cover all three, and add: "`/signup/anonymous` is the cheapest of the three to abuse, since it needs no request body at all — the network-layer requirement above is not optional for it."
3. Add two subsections after `### POST /signup`:

````markdown
### `POST /signup/anonymous`

No request body (any body is ignored). Creates a public account with a generated name
(`quiet-heron-4f2a` — adjective, noun, four hex characters) and **no password**, and returns a bearer
token. Intended for a client that wants a working account with no user involvement at all; the
account is claimable via `POST /claim` until a password is set on it.

Response: `201 { "id": number, "name": string, "token": string }`. On the vanishingly unlikely event
of five consecutive name collisions, `503 { "error": "could not allocate a name" }`. Rate-limited to
**3 requests/hour** per source IP; exceeding it returns `429`.

Like `POST /signup`, accounts created here are public, so they are excluded from group
recommendations in both directions.

### `POST /claim`

Requires a bearer token — holding the account's token is the proof of ownership. Body
`{ "name": string, "password": string }`, validated exactly as `/signup` validates them and with the
same error strings.

Sets the name and password on an account that has neither, keeping its id, its existing token, and
every event already recorded against it. After claiming, `POST /login` works with the chosen
credentials. The account remains public.

- Success: `200 { "name": string }`.
- `409 { "error": "name already taken" }` if the name collides with any existing user.
- `400 { "error": "account already claimed" }` if the account already has a password, **or** if it is
  a household (`user:add`) account. Those two are deliberately indistinguishable to a caller: nothing
  can be done differently about either, and separating them would tell whoever holds the token which
  population the account belongs to.
- `400` for the same malformed-input cases as `/signup`.
````

- [ ] **Step 6: Verify the build**

Run: `cd ../reccd && npm run build && npm test`
Expected: both clean.

- [ ] **Step 7: Commit**

```bash
cd ../reccd
git add src/api/server.ts src/api/server.test.ts README.md
git commit -m "feat(api): report account name and claim state on GET /profile

Documents /signup/anonymous and /claim, and widens the cf-connecting-ip
spoofing warning to cover all three public routes."
```

**Deployment note for the plan's reader:** torlink's half is useless until `reccd.stream` is running this code. Deploy reccd before Task 8's manual verification, or point `TORLINK_RECC_URL` at a local reccd for it.

---

## Task 6: torlink — the three `Config` fields, and the lock path

**Repo:** torlink

**Files:**
- Modify: `src/config/config.ts:39-42` (beside the existing `reccUrl`/`reccToken`)
- Modify: `src/config/paths.ts`
- Test: `src/config/config.test.ts`

**Interfaces:**
- Produces: `Config.reccAccountName?: string`, `Config.reccAccountClaimed?: boolean`, `Config.reccAutoSignup?: boolean`, and `reccProvisionLockFile: string` from `paths.ts`.

- [ ] **Step 1: Write the failing test**

Add these two to the **existing** `describe("config recc fields")` block in `src/config/config.test.ts`
(around line 27). That block already establishes the pattern this file uses: call `saveConfig` with a
literal, then `loadConfig()` — the config path is redirected for tests by `src/test-setup.ts`, so
there is no temp-dir helper to reach for and none should be introduced.

```ts
  it("round-trips the account name, claim state and opt-out", async () => {
    await saveConfig({
      downloadDir: "/tmp/dl",
      reccUrl: "https://reccd.stream",
      reccToken: "recc-abc123",
      reccAccountName: "quiet-heron-4f2a",
      reccAccountClaimed: false,
      reccAutoSignup: false,
      trackers: [],
    });
    const cfg = await loadConfig();
    expect(cfg.reccAccountName).toBe("quiet-heron-4f2a");
    expect(cfg.reccAccountClaimed).toBe(false);
    expect(cfg.reccAutoSignup).toBe(false);
  });

  // Absent has to mean "auto-provision", because a fresh install has no
  // config.json at all — so the default must not be a stored `true`.
  it("leaves reccAutoSignup undefined when nothing set it", async () => {
    await saveConfig({ downloadDir: "/tmp/dl", trackers: [] });
    const cfg = await loadConfig();
    expect(cfg.reccAutoSignup).toBeUndefined();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/config/config.test.ts`
Expected: FAIL — TypeScript rejects the unknown properties.

- [ ] **Step 3: Implement**

In `src/config/config.ts`, after `reccToken`:

```ts
  // The reccd account's name, for display in the Accounts pane. Written once
  // when an account is auto-provisioned, and afterwards only by the TUI, and
  // only when GET /profile reports something different -- see
  // src/recc/provision.ts for why this must not become a write-per-poll.
  reccAccountName?: string;
  // Whether that account has a username and password of the user's choosing.
  // Persisted rather than fetched because `/api/sources` is the one payload the
  // browser fetches before it can render anything, and it must not grow a
  // network round trip to learn a fact that changes once per account lifetime.
  reccAccountClaimed?: boolean;
  // Auto-provision an anonymous reccd account on first run. Absent or true
  // means yes -- absent has to mean yes, because the whole point is a fresh
  // install with no config.json at all. Set false to opt out; clearing the
  // reccd connection from the Accounts pane sets it, so "clear" stays cleared.
  reccAutoSignup?: boolean;
```

In `src/config/paths.ts`, beside `configFile`:

```ts
// Guards auto-provisioning against a concurrent TUI and `serve --web`, which
// are separate processes sharing one config.json. In configDir rather than
// dataDir because what it protects is a config write.
export const reccProvisionLockFile = path.join(configDir, "recc-provision.lock");
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/config/config.test.ts && npm run typecheck`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/config/config.ts src/config/paths.ts src/config/config.test.ts
git commit -m "feat(config): reccd account name, claim state, and auto-signup opt-out"
```

---

## Task 7: torlink — `shouldProvision`, the bail-out decision

**Repo:** torlink

**Files:**
- Create: `src/recc/provision.ts`
- Test: `src/recc/provision.test.ts`

**Interfaces:**
- Consumes: `Config`, `resolveReccConfig` from `src/config/config.ts`.
- Produces: `DEFAULT_RECC_URL: string`, `shouldProvision(config: Config): boolean`.

This task is the policy, alone and pure, so it can be tested without a filesystem or a network. Task 8 adds the effects.

- [ ] **Step 1: Write the failing tests**

Create `src/recc/provision.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_RECC_URL, shouldProvision } from "./provision";
import { defaultConfig, type Config } from "../config/config";

const base = (over: Partial<Config> = {}): Config => ({ ...defaultConfig, downloadDir: "/tmp/dl", ...over });

describe("shouldProvision", () => {
  beforeEach(() => {
    // resolveReccConfig reads these, and a developer may well have them
    // exported -- without stubbing, half these cases pass by accident.
    vi.stubEnv("TORLINK_RECC_URL", "");
    vi.stubEnv("TORLINK_RECC_TOKEN", "");
  });

  it("is true on a fresh install with nothing configured", () => {
    expect(shouldProvision(base())).toBe(true);
  });

  it("is false once a token exists — the account is already there", () => {
    expect(shouldProvision(base({ reccToken: "tok" }))).toBe(false);
  });

  it("is false when TORLINK_RECC_TOKEN supplies the token", () => {
    vi.stubEnv("TORLINK_RECC_TOKEN", "from-env");
    expect(shouldProvision(base())).toBe(false);
  });

  // The case that matters: a self-hosted reccd is not ours to sign up against,
  // and signing up against reccd.stream instead would ignore what the user set.
  it("is false for a self-hosted reccUrl with no token", () => {
    expect(shouldProvision(base({ reccUrl: "http://192.168.0.98:4100" }))).toBe(false);
  });

  it("is false for a self-hosted TORLINK_RECC_URL with no token", () => {
    vi.stubEnv("TORLINK_RECC_URL", "http://192.168.0.98:4100");
    expect(shouldProvision(base())).toBe(false);
  });

  // The hand-setup user who typed the host and left the token blank. Signing
  // them up against the host they already named is what they were trying to do.
  it("is true when reccUrl is already the default host but no token is set", () => {
    expect(shouldProvision(base({ reccUrl: DEFAULT_RECC_URL }))).toBe(true);
  });

  it("tolerates a trailing slash on the configured default host", () => {
    expect(shouldProvision(base({ reccUrl: `${DEFAULT_RECC_URL}/` }))).toBe(true);
  });

  it("is false when the user has opted out", () => {
    expect(shouldProvision(base({ reccAutoSignup: false }))).toBe(false);
  });

  it("is true when reccAutoSignup is explicitly true", () => {
    expect(shouldProvision(base({ reccAutoSignup: true }))).toBe(true);
  });

  // config.json is hand-editable and this is the only field here whose absent
  // state means ON, so a junk value must fail safe towards NOT signing up. A
  // user who wrote "no" meant no. `as unknown as Config` because these are
  // exactly the values TypeScript would stop a caller writing — the point is
  // that a text editor does not typecheck.
  it.each([["no"], ["false"], [0], [null], [""], [1], ["yes"]])(
    "does not sign up when reccAutoSignup is the junk value %p",
    (value) => {
      const cfg = { ...base(), reccAutoSignup: value } as unknown as Config;
      expect(shouldProvision(cfg)).toBe(false);
    },
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/recc/provision.test.ts`
Expected: FAIL — cannot resolve `./provision`.

- [ ] **Step 3: Implement**

Create `src/recc/provision.ts`:

```ts
import { resolveReccConfig, type Config } from "../config/config";

/**
 * The hosted reccd. Defined here and imported everywhere else — a second copy
 * of this string is the copy-then-drift bug this codebase already records four
 * of.
 */
export const DEFAULT_RECC_URL = "https://reccd.stream";

function normaliseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/**
 * Whether to auto-provision an anonymous account. This is the whole policy for
 * "does torlink make an outbound request on first run", deliberately separated
 * from the doing of it so it is testable without a filesystem or a network.
 *
 * Three conditions, all of which must hold:
 *
 * 1. No token yet, from config OR env. A token means an account exists.
 * 2. No reccUrl, or one that is already the default host. Any OTHER URL is a
 *    self-hosted reccd: signing up against it guesses at an endpoint their
 *    deployment may not have, and signing up against the hosted one instead
 *    ignores what they configured. Both are wrong, so do nothing — the Accounts
 *    pane already reports "Unreachable" or "Token rejected", which names the
 *    problem. Equalling the default covers the user who typed the host in by
 *    hand and left the token blank.
 * 3. Not opted out. Absent means opted in: a fresh install has no config.json.
 */
export function shouldProvision(config: Config): boolean {
  // `=== false` would be the obvious test and it is WRONG here. This is the
  // only boolean in Config whose absent state means ON, so it is the only one
  // where the usual `=== true` idiom inverts. config.json is hand-editable, and
  // a user who opts out by writing "no", "false", or 0 has written a value that
  // is not `=== false` — with the obvious test they would be signed up anyway,
  // having explicitly asked not to be. So: absent or exactly `true` is on;
  // anything else present is an opt-out. It fails safe in the direction of not
  // contacting a third-party host, which is the only safe direction here.
  const auto = config.reccAutoSignup;
  if (auto !== undefined && auto !== true) return false;
  const { reccUrl, reccToken } = resolveReccConfig(config);
  if (reccToken) return false;
  if (reccUrl && normaliseUrl(reccUrl) !== DEFAULT_RECC_URL) return false;
  return true;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/recc/provision.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/recc/provision.ts src/recc/provision.test.ts
git commit -m "feat(recc): decide when to auto-provision a reccd account"
```

---

## Task 8: torlink — `ensureReccAccount`

**Repo:** torlink

**Files:**
- Modify: `src/recc/provision.ts`
- Test: `src/recc/provision.test.ts`

**Interfaces:**
- Consumes: `shouldProvision`, `DEFAULT_RECC_URL` (Task 7); `loadConfig`, `saveConfig`; `reccProvisionLockFile` (Task 6); `FetchImpl` from `src/util/net`; `log` from `src/util/logger`.
- Produces:
  ```ts
  export interface ProvisionedPatch {
    reccUrl: string;
    reccToken: string;
    reccAccountName: string;
    reccAccountClaimed: false;
  }
  export interface EnsureReccAccountOptions {
    fetchImpl?: FetchImpl;
    timeoutMs?: number;
    lockFile?: string;
    loadConfigImpl?: () => Promise<Config>;
    saveConfigImpl?: (config: Config) => Promise<void>;
    onProvisioned?: (patch: ProvisionedPatch) => void;
  }
  export function ensureReccAccount(opts?: EnsureReccAccountOptions): Promise<void>;
  ```

- [ ] **Step 1: Write the failing tests**

Add to `src/recc/provision.test.ts`:

```ts
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureReccAccount, type ProvisionedPatch } from "./provision";

async function tmpLock(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "torlink-provision-"));
  return path.join(dir, "recc-provision.lock");
}

/** A fetch that reports one anonymous signup and counts calls. */
function signupFetch(counter: { n: number }, body: unknown = { id: 1, name: "quiet-heron-4f2a", token: "tok123" }) {
  return (async () => {
    counter.n++;
    return { ok: true, status: 201, json: async () => body } as unknown as Response;
  }) as unknown as FetchImpl;
}

/** A config pair backed by a plain object, standing in for config.json. */
function fakeStore(initial: Config) {
  let current = initial;
  return {
    load: async () => ({ ...current }),
    save: async (c: Config) => { current = c; },
    get: () => current,
  };
}

describe("ensureReccAccount", () => {
  beforeEach(() => {
    vi.stubEnv("TORLINK_RECC_URL", "");
    vi.stubEnv("TORLINK_RECC_TOKEN", "");
  });

  it("signs up and writes url, token, name and claimed:false", async () => {
    const counter = { n: 0 };
    const store = fakeStore(base());
    await ensureReccAccount({
      fetchImpl: signupFetch(counter),
      lockFile: await tmpLock(),
      loadConfigImpl: store.load,
      saveConfigImpl: store.save,
    });
    expect(counter.n).toBe(1);
    expect(store.get().reccUrl).toBe(DEFAULT_RECC_URL);
    expect(store.get().reccToken).toBe("tok123");
    expect(store.get().reccAccountName).toBe("quiet-heron-4f2a");
    expect(store.get().reccAccountClaimed).toBe(false);
  });

  it("POSTs to /signup/anonymous with no auth header", async () => {
    let seenUrl = "";
    let seenInit: Record<string, unknown> = {};
    const impl = (async (url: string, init: Record<string, unknown>) => {
      seenUrl = String(url);
      seenInit = init;
      return { ok: true, status: 201, json: async () => ({ id: 1, name: "n", token: "t" }) } as unknown as Response;
    }) as unknown as FetchImpl;
    const store = fakeStore(base());
    await ensureReccAccount({
      fetchImpl: impl, lockFile: await tmpLock(), loadConfigImpl: store.load, saveConfigImpl: store.save,
    });
    expect(seenUrl).toBe(`${DEFAULT_RECC_URL}/signup/anonymous`);
    expect(seenInit.method).toBe("POST");
    expect(JSON.stringify(seenInit.headers ?? {})).not.toContain("authorization");
  });

  it("calls onProvisioned with the patch, so a caller's snapshot stays current", async () => {
    let patch: ProvisionedPatch | null = null;
    const store = fakeStore(base());
    await ensureReccAccount({
      fetchImpl: signupFetch({ n: 0 }), lockFile: await tmpLock(),
      loadConfigImpl: store.load, saveConfigImpl: store.save,
      onProvisioned: (p) => { patch = p; },
    });
    expect(patch).toEqual({
      reccUrl: DEFAULT_RECC_URL,
      reccToken: "tok123",
      reccAccountName: "quiet-heron-4f2a",
      reccAccountClaimed: false,
    });
  });

  // THE bug this guards: App.tsx's persistConfig writes the WHOLE config from
  // React state. Without onProvisioned, the next unrelated setting change
  // serialises a snapshot with no reccToken and deletes the account silently.
  it("gives the caller enough to keep a whole-config write from dropping the token", async () => {
    const store = fakeStore(base());
    let snapshot = base(); // stands in for App.tsx's React state
    await ensureReccAccount({
      fetchImpl: signupFetch({ n: 0 }), lockFile: await tmpLock(),
      loadConfigImpl: store.load, saveConfigImpl: store.save,
      onProvisioned: (p) => { snapshot = { ...snapshot, ...p }; },
    });
    await store.save({ ...snapshot, sort: "seeders" }); // a later unrelated change
    expect(store.get().reccToken).toBe("tok123");
  });

  it("makes no request at all when shouldProvision says no", async () => {
    const counter = { n: 0 };
    const store = fakeStore(base({ reccUrl: "http://192.168.0.98:4100" }));
    await ensureReccAccount({
      fetchImpl: signupFetch(counter), lockFile: await tmpLock(),
      loadConfigImpl: store.load, saveConfigImpl: store.save,
    });
    expect(counter.n).toBe(0);
    expect(store.get().reccToken).toBeUndefined();
  });

  it("makes exactly one request when reccUrl is already the default host", async () => {
    const counter = { n: 0 };
    const store = fakeStore(base({ reccUrl: DEFAULT_RECC_URL }));
    await ensureReccAccount({
      fetchImpl: signupFetch(counter), lockFile: await tmpLock(),
      loadConfigImpl: store.load, saveConfigImpl: store.save,
    });
    expect(counter.n).toBe(1);
  });

  // The two-process race the lock exists for.
  it("signs up once when two calls run concurrently against one lock file", async () => {
    const counter = { n: 0 };
    const lockFile = await tmpLock();
    const store = fakeStore(base());
    const slow = (async () => {
      counter.n++;
      await new Promise((r) => setTimeout(r, 30));
      return { ok: true, status: 201, json: async () => ({ id: 1, name: "n", token: "tok123" }) } as unknown as Response;
    }) as unknown as FetchImpl;
    await Promise.all([
      ensureReccAccount({ fetchImpl: slow, lockFile, loadConfigImpl: store.load, saveConfigImpl: store.save }),
      ensureReccAccount({ fetchImpl: slow, lockFile, loadConfigImpl: store.load, saveConfigImpl: store.save }),
    ]);
    expect(counter.n).toBe(1);
  });

  it("releases the lock, so the next launch is not blocked forever", async () => {
    const lockFile = await tmpLock();
    const store = fakeStore(base());
    await ensureReccAccount({
      fetchImpl: signupFetch({ n: 0 }), lockFile, loadConfigImpl: store.load, saveConfigImpl: store.save,
    });
    await expect(fs.stat(lockFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("takes over a stale lock older than 60s", async () => {
    const counter = { n: 0 };
    const lockFile = await tmpLock();
    await fs.writeFile(lockFile, "");
    const old = new Date(Date.now() - 120_000);
    await fs.utimes(lockFile, old, old);
    const store = fakeStore(base());
    await ensureReccAccount({
      fetchImpl: signupFetch(counter), lockFile, loadConfigImpl: store.load, saveConfigImpl: store.save,
    });
    expect(counter.n).toBe(1);
  });

  it("discards the new account when a token appeared during the request", async () => {
    const lockFile = await tmpLock();
    let current = base();
    const impl = (async () => {
      // Stands in for another process finishing first, mid-flight.
      current = { ...current, reccToken: "someone-elses", reccUrl: DEFAULT_RECC_URL };
      return { ok: true, status: 201, json: async () => ({ id: 2, name: "n2", token: "mine" }) } as unknown as Response;
    }) as unknown as FetchImpl;
    await ensureReccAccount({
      fetchImpl: impl, lockFile,
      loadConfigImpl: async () => ({ ...current }),
      saveConfigImpl: async (c) => { current = c; },
    });
    expect(current.reccToken).toBe("someone-elses");
  });

  // Spec §0: every one of these must RESOLVE, not reject.
  describe("fails soft — §0", () => {
    const cases: Array<[string, FetchImpl]> = [
      ["a thrown network error", (async () => { throw new Error("ENOTFOUND"); }) as unknown as FetchImpl],
      ["a 429", (async () => ({ ok: false, status: 429, json: async () => ({}) }) as unknown as Response) as unknown as FetchImpl],
      ["a 503", (async () => ({ ok: false, status: 503, json: async () => ({ error: "could not allocate a name" }) }) as unknown as Response) as unknown as FetchImpl],
      ["a body that is not JSON", (async () => ({ ok: true, status: 201, json: async () => { throw new Error("not json"); } }) as unknown as Response) as unknown as FetchImpl],
      ["a 201 with no token", (async () => ({ ok: true, status: 201, json: async () => ({ id: 1, name: "n" }) }) as unknown as Response) as unknown as FetchImpl],
      ["a 201 with a non-string token", (async () => ({ ok: true, status: 201, json: async () => ({ id: 1, name: "n", token: 42 }) }) as unknown as Response) as unknown as FetchImpl],
    ];

    for (const [label, impl] of cases) {
      it(`resolves and writes nothing on ${label}`, async () => {
        const store = fakeStore(base());
        await expect(
          ensureReccAccount({ fetchImpl: impl, lockFile: await tmpLock(), loadConfigImpl: store.load, saveConfigImpl: store.save }),
        ).resolves.toBeUndefined();
        expect(store.get().reccToken).toBeUndefined();
      });
    }

    it("resolves when saveConfig throws", async () => {
      await expect(
        ensureReccAccount({
          fetchImpl: signupFetch({ n: 0 }),
          lockFile: await tmpLock(),
          loadConfigImpl: async () => base(),
          saveConfigImpl: async () => { throw new Error("EROFS"); },
        }),
      ).resolves.toBeUndefined();
    });

    it("resolves when the lock cannot be created because its directory is missing", async () => {
      await expect(
        ensureReccAccount({
          fetchImpl: signupFetch({ n: 0 }),
          lockFile: "/nonexistent-dir-for-torlink-test/recc-provision.lock",
          loadConfigImpl: async () => base(),
          saveConfigImpl: async () => {},
        }),
      ).resolves.toBeUndefined();
    });

    it("resolves when loadConfig throws", async () => {
      await expect(
        ensureReccAccount({
          fetchImpl: signupFetch({ n: 0 }),
          lockFile: await tmpLock(),
          loadConfigImpl: async () => { throw new Error("EACCES"); },
          saveConfigImpl: async () => {},
        }),
      ).resolves.toBeUndefined();
    });

    it("abandons a hung request via the timeout rather than hanging the caller", async () => {
      const store = fakeStore(base());
      const hangs = (async (_url: string, init: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        })) as unknown as FetchImpl;
      await expect(
        ensureReccAccount({
          fetchImpl: hangs, timeoutMs: 20, lockFile: await tmpLock(),
          loadConfigImpl: store.load, saveConfigImpl: store.save,
        }),
      ).resolves.toBeUndefined();
      expect(store.get().reccToken).toBeUndefined();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/recc/provision.test.ts`
Expected: FAIL — `ensureReccAccount is not exported`.

- [ ] **Step 3: Implement**

Append to `src/recc/provision.ts`:

```ts
import { promises as fs } from "node:fs";
import { loadConfig, saveConfig } from "../config/config";
import { reccProvisionLockFile } from "../config/paths";
import type { FetchImpl } from "../util/net";
import { log } from "../util/logger";

/** What provisioning wrote. Handed to `onProvisioned` and applied to config. */
export interface ProvisionedPatch {
  reccUrl: string;
  reccToken: string;
  reccAccountName: string;
  reccAccountClaimed: false;
}

export interface EnsureReccAccountOptions {
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
  lockFile?: string;
  loadConfigImpl?: () => Promise<Config>;
  saveConfigImpl?: (config: Config) => Promise<void>;
  /**
   * Called after a successful write, with what was written.
   *
   * The TUI MUST pass this. `App.tsx`'s persistConfig writes the whole config
   * object from React state, so a config.json written behind that state's back
   * is reverted by the next unrelated setting change — the user's brand-new
   * account, silently deleted when they change the sort. The callback applies
   * the patch to React state WITHOUT re-saving, so the two agree.
   *
   * `runServe` passes nothing: it holds no equivalent snapshot, and routes.ts
   * calls loadConfig() per request.
   */
  onProvisioned?: (patch: ProvisionedPatch) => void;
}

const LOCK_STALE_MS = 60_000;

/** True if the lock was taken. Never throws. */
async function takeLock(lockFile: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fs.open(lockFile, "wx");
      await handle.close();
      return true;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== "EEXIST") return false; // unwritable dir, permissions — give up quietly
      let ageMs = 0;
      try {
        ageMs = Date.now() - (await fs.stat(lockFile)).mtimeMs;
      } catch {
        continue; // vanished between open and stat — try to take it
      }
      if (ageMs < LOCK_STALE_MS) return false; // another process is mid-signup
      // Stale: a process died holding it. Clear it and try once more.
      try {
        await fs.unlink(lockFile);
      } catch {
        return false;
      }
    }
  }
  return false;
}

function isAnonSignupBody(v: unknown): v is { name: string; token: string } {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.name === "string" && typeof r.token === "string" && r.token.length > 0;
}

/**
 * Create an anonymous reccd account on the hosted service, once, if the user
 * has nothing configured. Fire-and-forget: resolves to nothing, never rejects,
 * and a failure means recommendations stay unavailable and nothing else.
 *
 * Call it as `void ensureReccAccount({...}).catch(() => {})` — the explicit
 * catch is what stops an unhandled rejection taking the process down, which is
 * the exact hazard routes.ts documents for reccd's other fire-and-forget calls.
 *
 * Single attempt, deliberately, and NOT fetchResilient: retrying into a rate
 * limit or an outage piles up concurrent requests at the worst possible moment.
 * The next launch tries again, which is one request per launch and
 * self-limiting.
 */
export async function ensureReccAccount(opts: EnsureReccAccountOptions = {}): Promise<void> {
  const load = opts.loadConfigImpl ?? loadConfig;
  const save = opts.saveConfigImpl ?? saveConfig;
  const lockFile = opts.lockFile ?? reccProvisionLockFile;
  const fetchImpl = opts.fetchImpl ?? (fetch as FetchImpl);

  try {
    if (!shouldProvision(await load())) return;
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
      if (!res.ok) {
        log.debug(`recc provision: signup returned ${res.status}`);
        return;
      }
      const body: unknown = await res.json();
      if (!isAnonSignupBody(body)) {
        log.debug("recc provision: unexpected signup response shape");
        return;
      }

      // Read-modify-write, per CLAUDE.md: never a snapshot held across the
      // network call. If a token appeared while we were waiting, the new
      // account is discarded — an orphan account on reccd is a far smaller
      // problem than a lost token.
      const fresh = await load();
      if (resolveReccConfig(fresh).reccToken) {
        log.debug("recc provision: a token appeared meanwhile, discarding the new account");
        return;
      }
      const patch: ProvisionedPatch = {
        reccUrl: DEFAULT_RECC_URL,
        reccToken: body.token,
        reccAccountName: body.name,
        reccAccountClaimed: false,
      };
      await save({ ...fresh, ...patch });
      opts.onProvisioned?.(patch);
      log.debug(`recc provision: created anonymous account ${body.name}`);
    } finally {
      await fs.unlink(lockFile).catch(() => {});
    }
  } catch (err) {
    // Spec §0. Everything — a filesystem error, a malformed body, an aborted
    // request, a failed save — ends here, and torlink carries on unchanged.
    log.debug(`recc provision: ${err instanceof Error ? err.message : String(err)}`);
  }
}
```

Merge the `import { resolveReccConfig, type Config }` line from Task 7 with the new `loadConfig, saveConfig` import — one import statement from `../config/config`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/recc/provision.test.ts`
Expected: PASS — all of Task 7's and Task 8's tests.

- [ ] **Step 5: Verify the whole suite and the types**

Run: `npm test && npm run typecheck && npm run lint`
Expected: clean, bar the one known `react-hooks/exhaustive-deps` warning.

- [ ] **Step 6: Commit**

```bash
git add src/recc/provision.ts src/recc/provision.test.ts
git commit -m "feat(recc): auto-provision an anonymous reccd account on first run

Behind a cross-process lock file, because serve --web is a separate process
from the TUI and serializeWrites only covers one. Fire-and-forget and never
rejecting: a reccd failure must cost recommendations and nothing else."
```

---

## Task 9: torlink — `claimReccAccount`

**Repo:** torlink

**Files:**
- Modify: `src/recc/client.ts` (append)
- Test: `src/recc/client.test.ts`

**Interfaces:**
- Consumes: `ReccClientConfig`, `FetchImpl`.
- Produces:
  ```ts
  export type ClaimReccResult =
    | { ok: true; name: string }
    | { ok: false; reason: "nameTaken" | "alreadyClaimed" | "invalid" | "unauthorized" | "unreachable"; message: string };
  export function claimReccAccount(
    config: ReccClientConfig,
    name: string,
    password: string,
    opts?: { fetchImpl?: FetchImpl; timeoutMs?: number },
  ): Promise<ClaimReccResult>;
  ```

- [ ] **Step 1: Write the failing tests**

Add to `src/recc/client.test.ts`, following that file's existing fake-fetch style:

```ts
describe("claimReccAccount", () => {
  const CFG = { reccUrl: "https://reccd.stream", reccToken: "tok" };

  function reply(status: number, body: unknown) {
    return (async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as unknown as Response) as unknown as FetchImpl;
  }

  it("returns the claimed name on 200", async () => {
    const res = await claimReccAccount(CFG, "chosen", "correcthorsebattery", {
      fetchImpl: reply(200, { name: "chosen" }),
    });
    expect(res).toEqual({ ok: true, name: "chosen" });
  });

  it("POSTs name and password to /claim with the bearer token", async () => {
    let seenUrl = "";
    let seenInit: { headers?: Record<string, string>; body?: string; method?: string } = {};
    const impl = (async (url: string, init: typeof seenInit) => {
      seenUrl = String(url);
      seenInit = init;
      return { ok: true, status: 200, json: async () => ({ name: "chosen" }) } as unknown as Response;
    }) as unknown as FetchImpl;
    await claimReccAccount(CFG, "chosen", "correcthorsebattery", { fetchImpl: impl });
    expect(seenUrl).toBe("https://reccd.stream/claim");
    expect(seenInit.method).toBe("POST");
    expect(seenInit.headers?.authorization).toBe("Bearer tok");
    expect(JSON.parse(seenInit.body!)).toEqual({ name: "chosen", password: "correcthorsebattery" });
  });

  it("maps 409 to nameTaken", async () => {
    const res = await claimReccAccount(CFG, "taken", "correcthorsebattery", {
      fetchImpl: reply(409, { error: "name already taken" }),
    });
    expect(res).toEqual({ ok: false, reason: "nameTaken", message: "That username is taken — try another." });
  });

  it("maps 400 account already claimed to alreadyClaimed", async () => {
    const res = await claimReccAccount(CFG, "x", "correcthorsebattery", {
      fetchImpl: reply(400, { error: "account already claimed" }),
    });
    expect(res.ok).toBe(false);
    expect((res as { reason: string }).reason).toBe("alreadyClaimed");
  });

  it("passes any other 400's own message through, so validation reads clearly", async () => {
    const res = await claimReccAccount(CFG, "x", "short", {
      fetchImpl: reply(400, { error: "password must be at least 8 characters" }),
    });
    expect(res).toEqual({ ok: false, reason: "invalid", message: "password must be at least 8 characters" });
  });

  it("falls back to a readable message when a 400 carries no error string", async () => {
    const res = await claimReccAccount(CFG, "x", "correcthorsebattery", { fetchImpl: reply(400, {}) });
    expect(res).toEqual({ ok: false, reason: "invalid", message: "reccd rejected that username or password." });
  });

  it("maps 401 to unauthorized", async () => {
    const res = await claimReccAccount(CFG, "x", "correcthorsebattery", { fetchImpl: reply(401, {}) });
    expect((res as { reason: string }).reason).toBe("unauthorized");
  });

  it("maps a 500 to unreachable", async () => {
    const res = await claimReccAccount(CFG, "x", "correcthorsebattery", { fetchImpl: reply(500, {}) });
    expect((res as { reason: string }).reason).toBe("unreachable");
  });

  it("maps a network error to unreachable rather than throwing", async () => {
    const impl = (async () => { throw new Error("ENOTFOUND"); }) as unknown as FetchImpl;
    const res = await claimReccAccount(CFG, "x", "correcthorsebattery", { fetchImpl: impl });
    expect((res as { reason: string }).reason).toBe("unreachable");
  });

  it("reports unreachable rather than calling out when no reccUrl is configured", async () => {
    let called = false;
    const impl = (async () => { called = true; return {} as unknown as Response; }) as unknown as FetchImpl;
    const res = await claimReccAccount({}, "x", "correcthorsebattery", { fetchImpl: impl });
    expect(called).toBe(false);
    expect(res.ok).toBe(false);
  });

  it("never puts the password in a log-shaped return value", async () => {
    const res = await claimReccAccount(CFG, "x", "supersecretpassword", { fetchImpl: reply(500, {}) });
    expect(JSON.stringify(res)).not.toContain("supersecretpassword");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/recc/client.test.ts`
Expected: FAIL — `claimReccAccount` is not exported.

- [ ] **Step 3: Implement**

Append to `src/recc/client.ts`:

```ts
export type ClaimReccResult =
  | { ok: true; name: string }
  | {
      ok: false;
      reason: "nameTaken" | "alreadyClaimed" | "invalid" | "unauthorized" | "unreachable";
      message: string;
    };

// Claims an anonymous account: sets the username and password the user chose,
// keeping the account's id, token and history.
//
// Blocking and reporting, unlike postEvent: the user is watching a prompt and
// needs to be told what happened. `message` is what the pane prints, so it is a
// sentence rather than a status code — except for a plain validation 400, where
// reccd's own wording ("password must be at least 8 characters") is better than
// anything this layer could invent, so it is passed through.
export async function claimReccAccount(
  config: ReccClientConfig,
  name: string,
  password: string,
  opts: { fetchImpl?: FetchImpl; timeoutMs?: number } = {},
): Promise<ClaimReccResult> {
  if (!config.reccUrl) {
    return { ok: false, reason: "unreachable", message: "reccd is not configured." };
  }
  const fetchImpl = opts.fetchImpl ?? (fetch as FetchImpl);
  try {
    const res = await fetchImpl(`${config.reccUrl}/claim`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.reccToken ?? ""}`,
      },
      body: JSON.stringify({ name, password }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10000),
    });
    if (res.ok) return { ok: true, name };
    if (res.status === 409) {
      return { ok: false, reason: "nameTaken", message: "That username is taken — try another." };
    }
    if (res.status === 401) {
      return { ok: false, reason: "unauthorized", message: "reccd rejected the token — check the connection." };
    }
    if (res.status === 400) {
      const body: unknown = await res.json().catch(() => ({}));
      const error = typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : "";
      if (error === "account already claimed") {
        return {
          ok: false,
          reason: "alreadyClaimed",
          message: "This account already has a username and password.",
        };
      }
      return { ok: false, reason: "invalid", message: error || "reccd rejected that username or password." };
    }
    return { ok: false, reason: "unreachable", message: `reccd couldn't claim the account (HTTP ${res.status}).` };
  } catch (err) {
    // Never the password, and never the name — this string reaches the log.
    log.debug(`recc claimReccAccount: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, reason: "unreachable", message: "couldn't reach reccd" };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/recc/client.test.ts`
Expected: PASS, 11 new tests.

- [ ] **Step 5: Commit**

```bash
git add src/recc/client.ts src/recc/client.test.ts
git commit -m "feat(recc): claim an anonymous reccd account"
```

---

## Task 10: torlink — the account on `ReccStatus`

**Repo:** torlink

**Files:**
- Modify: `src/recc/status.ts`
- Test: `src/recc/status.test.ts`

**Interfaces:**
- Produces: `ReccStatus.account?: { name: string; claimed: boolean }`; `formatReccStatus` renders `Connected · host · name (unclaimed)`.

- [ ] **Step 1: Write the failing tests**

Add to `src/recc/status.test.ts`:

```ts
function fakeFetchJson(status: number, body: unknown): FetchImpl {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as unknown as Response) as unknown as FetchImpl;
}

describe("checkReccConnection — account", () => {
  it("reports the account from /profile", async () => {
    const res = await checkReccConnection(CFG, {
      fetchImpl: fakeFetchJson(200, { seenImdbIds: [], account: { name: "quiet-heron-4f2a", claimed: false } }),
    });
    expect(res).toEqual({
      state: "connected",
      host: "192.168.0.98:4100",
      account: { name: "quiet-heron-4f2a", claimed: false },
    });
  });

  // An older self-hosted reccd predates the field. It must degrade, not throw.
  it("omits account when /profile does not carry one", async () => {
    const res = await checkReccConnection(CFG, { fetchImpl: fakeFetchJson(200, { seenImdbIds: [] }) });
    expect(res).toEqual({ state: "connected", host: "192.168.0.98:4100" });
  });

  it("omits account when the field is the wrong shape", async () => {
    for (const account of ["nope", 7, null, {}, { name: "n" }, { name: 1, claimed: true }]) {
      const res = await checkReccConnection(CFG, { fetchImpl: fakeFetchJson(200, { account }) });
      expect(res.account).toBeUndefined();
      expect(res.state).toBe("connected");
    }
  });

  it("stays connected when the body is not JSON at all", async () => {
    const impl = (async () => ({
      ok: true, status: 200, json: async () => { throw new Error("not json"); },
    }) as unknown as Response) as unknown as FetchImpl;
    const res = await checkReccConnection(CFG, { fetchImpl: impl });
    expect(res).toEqual({ state: "connected", host: "192.168.0.98:4100" });
  });
});

describe("formatReccStatus — account suffix", () => {
  it("names an unclaimed account", () => {
    expect(
      formatReccStatus({ state: "connected", host: "reccd.stream", account: { name: "quiet-heron-4f2a", claimed: false } }),
    ).toBe("Connected · reccd.stream · quiet-heron-4f2a (unclaimed)");
  });

  it("names a claimed account without the marker", () => {
    expect(
      formatReccStatus({ state: "connected", host: "reccd.stream", account: { name: "ash", claimed: true } }),
    ).toBe("Connected · reccd.stream · ash");
  });

  it("is unchanged with no account", () => {
    expect(formatReccStatus({ state: "connected", host: "h:4100" })).toBe("Connected · h:4100");
  });

  it("adds no suffix to a state where it would be misleading", () => {
    const account = { name: "quiet-heron-4f2a", claimed: false };
    expect(formatReccStatus({ state: "badToken", host: "h", account })).toBe("Token rejected");
    expect(formatReccStatus({ state: "unreachable", host: "h", account })).toBe("Unreachable · h");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/recc/status.test.ts`
Expected: FAIL — `account` is not on `ReccStatus`.

- [ ] **Step 3: Implement**

In `src/recc/status.ts`:

```ts
export interface ReccAccount {
  name: string;
  claimed: boolean;
}

export interface ReccStatus {
  state: ReccConnection;
  host?: string;
  /**
   * Who reccd thinks we are, from GET /profile. Absent when the connection is
   * not up, or when reccd is an older self-hosted build that predates the
   * field — an unrecognised or malformed body must degrade to "no account
   * shown", never throw. reccd going wrong may cost this suffix and nothing.
   */
  account?: ReccAccount;
}

function parseAccount(body: unknown): ReccAccount | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const account = (body as { account?: unknown }).account;
  if (typeof account !== "object" || account === null) return undefined;
  const a = account as Record<string, unknown>;
  if (typeof a.name !== "string" || typeof a.claimed !== "boolean") return undefined;
  return { name: a.name, claimed: a.claimed };
}
```

Then in `checkReccConnection`, replace the success return:

```ts
    if (res.status === 401) return { state: "badToken", host };
    if (!res.ok) return { state: "unreachable", host };
    // A body we cannot read costs the name suffix, not the verdict: the 200
    // already proves the token works, which is what this function is for.
    const body: unknown = await res.json().catch(() => undefined);
    const account = parseAccount(body);
    return account ? { state: "connected", host, account } : { state: "connected", host };
```

And in `formatReccStatus`:

```ts
    case "connected": {
      const base = `Connected · ${status.host}`;
      if (!status.account) return base;
      const { name, claimed } = status.account;
      return `${base} · ${name}${claimed ? "" : " (unclaimed)"}`;
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/recc/status.test.ts && npm run typecheck`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/recc/status.ts src/recc/status.test.ts
git commit -m "feat(recc): name the reccd account in the connection status"
```

---

## Task 11: torlink — `reccAccount` on `/api/sources`

**Repo:** torlink

**Files:**
- Modify: `src/web/wire.ts` (after `omdbConfigured`, ~line 389)
- Modify: `src/web/routes.ts:734` (inside `sourcesResponse`)
- Test: `src/web/routes.test.ts`

**Interfaces:**
- Produces: `PublicReccAccount { name: string; claimed: boolean }`; `SourcesResponse.reccAccount: PublicReccAccount | null`.

- [ ] **Step 1: Write the failing tests**

Add to `src/web/routes.test.ts`, after the `sourcesResponse — omdbConfigured` block:

```ts
describe("sourcesResponse — reccAccount", () => {
  beforeEach(() => {
    vi.stubEnv("TORLINK_RECC_URL", "");
    vi.stubEnv("TORLINK_RECC_TOKEN", "");
  });

  const ask = (config: Partial<Config>) =>
    handleWebApi(
      deps({ loadConfigImpl: async () => ({ ...defaultConfig, downloadDir: "/tmp/dl", ...config }) }),
      "GET",
      "/api/sources",
      new URLSearchParams(),
      undefined,
      "",
    );

  it("is null when no reccd is configured", async () => {
    const res = await ask({});
    expect((res.json as SourcesResponse).reccAccount).toBeNull();
  });

  it("reports an unclaimed account", async () => {
    const res = await ask({
      reccUrl: "https://reccd.stream",
      reccToken: "tok",
      reccAccountName: "quiet-heron-4f2a",
      reccAccountClaimed: false,
    });
    expect((res.json as SourcesResponse).reccAccount).toEqual({ name: "quiet-heron-4f2a", claimed: false });
  });

  it("reports a claimed account", async () => {
    const res = await ask({
      reccUrl: "https://reccd.stream",
      reccToken: "tok",
      reccAccountName: "chosen",
      reccAccountClaimed: true,
    });
    expect((res.json as SourcesResponse).reccAccount).toEqual({ name: "chosen", claimed: true });
  });

  // A hand-configured self-hosted reccd has a token but no name — it never went
  // through provisioning. Claiming does not apply, so say nothing rather than
  // inventing a name or claiming it is unclaimed.
  it("is null when reccd is configured but no account name is known", async () => {
    const res = await ask({ reccUrl: "http://192.168.0.98:4100", reccToken: "tok" });
    expect((res.json as SourcesResponse).reccAccount).toBeNull();
  });

  it("never puts the reccd token on the wire", async () => {
    const res = await ask({
      reccUrl: "https://reccd.stream",
      reccToken: "super-secret-recc-token",
      reccAccountName: "quiet-heron-4f2a",
    });
    expect(JSON.stringify(res.json)).not.toContain("super-secret-recc-token");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/web/routes.test.ts -t reccAccount`
Expected: FAIL — `reccAccount` is not on `SourcesResponse`.

- [ ] **Step 3: Implement**

In `src/web/wire.ts`, before `SourcesResponse`:

```ts
/**
 * The reccd account this install is using, or null when there isn't one.
 *
 * The name is not a credential — it is what the user logs in *with* once
 * claimed, and reccd shows it publicly — so unlike `reccToken` it is safe to
 * put on the wire. The token never is.
 *
 * Nested rather than a flat `reccClaimed: boolean` on purpose: a flat boolean
 * is false both for "unclaimed account" and "no account at all", so every
 * reader would have to cross-reference something else to tell them apart, and
 * one reader eventually won't.
 */
export interface PublicReccAccount {
  name: string;
  claimed: boolean;
}
```

And inside `SourcesResponse`, after `omdbConfigured`:

```ts
  /**
   * The reccd account, or null when none is known. Null covers both "no reccd
   * configured" and "a self-hosted reccd configured by hand", which never went
   * through auto-provisioning and so has no name recorded — claiming does not
   * apply to it.
   *
   * There is deliberately no companion `reccConfigured` flag:
   * `/api/recommendations` already answers `{ status: "not-configured" }` when
   * reccUrl is unset, precisely so the browser can say "set up reccd". A second
   * field carrying that same fact is the copy-then-drift pattern this codebase
   * records four bugs from.
   */
  reccAccount: PublicReccAccount | null;
```

In `src/web/routes.ts`, inside `sourcesResponse` after the `omdbConfigured` line:

```ts
    // From config, never from reccd: /api/sources is the one payload the
    // browser fetches before it can render anything, and hanging a network
    // round trip off it to learn a fact that changes once per account lifetime
    // is the wrong trade. The TUI's status check is what keeps this current.
    reccAccount: config.reccAccountName
      ? { name: config.reccAccountName, claimed: config.reccAccountClaimed === true }
      : null,
```

Add `PublicReccAccount` to the `wire` import in `routes.ts` only if the file needs the type name explicitly; the object literal above does not require it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/web/routes.test.ts && npm run typecheck && npm run build`
Expected: PASS, clean. `npm run build` is the only check that `src/web/static/` imports no `node:*` — run it.

- [ ] **Step 5: Commit**

```bash
git add src/web/wire.ts src/web/routes.ts src/web/routes.test.ts
git commit -m "feat(web): report the reccd account on /api/sources"
```

---

## Task 12: torlink — the browser's unclaimed hint

**Repo:** torlink

**Files:**
- Modify: `src/web/static/reccModel.ts`
- Modify: `src/web/static/index.html`
- Modify: `src/web/static/app.ts`
- Test: `src/web/static/reccModel.test.ts`

**Interfaces:**
- Consumes: `PublicReccAccount` (Task 11).
- Produces: `reccClaimHint(account: PublicReccAccount | null | undefined): string | null`.

- [ ] **Step 1: Write the failing test**

Add to `src/web/static/reccModel.test.ts`:

```ts
describe("reccClaimHint", () => {
  it("prompts to claim an unclaimed account, naming it", () => {
    expect(reccClaimHint({ name: "quiet-heron-4f2a", claimed: false })).toBe(
      "Your picks are saved to quiet-heron-4f2a, an account with no password yet. Claim it in the terminal UI to sign in on another machine.",
    );
  });

  it("says nothing for a claimed account", () => {
    expect(reccClaimHint({ name: "ash", claimed: true })).toBeNull();
  });

  it("says nothing when there is no account", () => {
    expect(reccClaimHint(null)).toBeNull();
  });

  // /api/sources has not answered yet. Staying quiet stops the sentence
  // flashing on a slow load — the same rule resultPosters.ts follows for
  // omdbConfigured: boolean | null.
  it("says nothing before /api/sources has answered", () => {
    expect(reccClaimHint(undefined)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/web/static/reccModel.test.ts`
Expected: FAIL — `reccClaimHint` is not exported.

- [ ] **Step 3: Implement the pure function**

In `src/web/static/reccModel.ts`, add `PublicReccAccount` to the existing `../wire` import and re-export it alongside the other wire types, then append:

```ts
/**
 * The line telling the user their account has no password yet, or null for
 * every other case.
 *
 * Deliberately NOT folded into `reccStatus` above, which returns `show: false`
 * once there are cards to look at: this hint has to be visible precisely when
 * the feed is working, which is the one case that function suppresses.
 *
 * `undefined` means /api/sources has not answered yet and returns null, so the
 * sentence never flashes on a slow load.
 *
 * It points at the TUI because claiming IS terminal-only — credential entry
 * lives there, the same as tokens. Naming where to go is the difference between
 * a deliberate boundary and a missing feature.
 */
export function reccClaimHint(account: PublicReccAccount | null | undefined): string | null {
  if (!account || account.claimed) return null;
  return `Your picks are saved to ${account.name}, an account with no password yet. Claim it in the terminal UI to sign in on another machine.`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/web/static/reccModel.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Wire it into the page**

In `src/web/static/index.html`, inside the For You pane and directly below the existing recc status line element, add an empty container:

```html
<p id="recc-claim-hint" class="recc-claim-hint" hidden></p>
```

Add a rule to `src/web/static/styles.css` matching the existing muted-note styling in that file (find the selector the recc status line uses and follow it — do not invent new colour values).

In `src/web/static/app.ts`, wherever the For You pane renders after `/api/sources` resolves, add wiring only — no conditional logic beyond mounting what the model returned:

```ts
const claimHint = reccClaimHint(sources?.reccAccount);
const claimHintEl = byId("recc-claim-hint");
claimHintEl.textContent = claimHint ?? "";
claimHintEl.hidden = claimHint === null;
```

Use whatever element-lookup helper `app.ts` already uses instead of `byId` if it differs. `textContent`, never `innerHTML` — the account name comes from a server response.

- [ ] **Step 6: Verify**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: all clean. The build is what proves `reccModel.ts` still imports no `node:*`.

Then run it for real: `npm run dev -- serve --web`, open the For You pane against a config with `reccAccountName` set and `reccAccountClaimed` false, and confirm the sentence appears above the feed and disappears when `reccAccountClaimed` is true.

- [ ] **Step 7: Commit**

```bash
git add src/web/static/reccModel.ts src/web/static/reccModel.test.ts src/web/static/index.html src/web/static/styles.css src/web/static/app.ts
git commit -m "feat(web): tell the browser when the reccd account is unclaimed"
```

---

## Task 13: torlink — the claim prompt component

**Repo:** torlink

**Files:**
- Create: `src/ui/components/ReccClaimPrompt.tsx`
- Test: `src/ui/components/ReccClaimPrompt.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  interface ReccClaimPromptProps {
    width: number;
    accountName?: string;
    error?: string;
    busy?: boolean;
    onSubmit: (name: string, password: string) => void;
    onCancel: () => void;
  }
  export function ReccClaimPrompt(props: ReccClaimPromptProps): JSX.Element;
  ```

Its own file rather than a mode on `ReccdPrompt`: that component's job is a URL and a token for a self-hosted service, and bolting a second unrelated purpose onto it would make both harder to read.

- [ ] **Step 1: Write the failing test**

Create `src/ui/components/ReccClaimPrompt.test.tsx`, following the render/assert style of `src/ui/components/ReccdPrompt.test.tsx` (read it first — reuse its `render` helper and its way of driving `useInput`):

```tsx
import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { ReccClaimPrompt } from "./ReccClaimPrompt";

describe("ReccClaimPrompt", () => {
  it("names the account being claimed", () => {
    const { lastFrame } = render(
      <ReccClaimPrompt width={80} accountName="quiet-heron-4f2a" onSubmit={() => {}} onCancel={() => {}} />,
    );
    expect(lastFrame()).toContain("quiet-heron-4f2a");
  });

  it("explains what claiming gets you, since the account already works", () => {
    const { lastFrame } = render(
      <ReccClaimPrompt width={80} accountName="quiet-heron-4f2a" onSubmit={() => {}} onCancel={() => {}} />,
    );
    expect(lastFrame()).toContain("sign in");
  });

  it("shows an error from a failed attempt", () => {
    const { lastFrame } = render(
      <ReccClaimPrompt width={80} error="That username is taken — try another." onSubmit={() => {}} onCancel={() => {}} />,
    );
    expect(lastFrame()).toContain("That username is taken");
  });

  it("says it is working while a claim is in flight", () => {
    const { lastFrame } = render(
      <ReccClaimPrompt width={80} busy onSubmit={() => {}} onCancel={() => {}} />,
    );
    expect(lastFrame()?.toLowerCase()).toContain("claiming");
  });

  it("masks the password field", () => {
    const { lastFrame } = render(<ReccClaimPrompt width={80} onSubmit={() => {}} onCancel={() => {}} />);
    expect(lastFrame()).not.toContain("password from");
  });

  it("cancels on escape", () => {
    const onCancel = vi.fn();
    const { stdin } = render(<ReccClaimPrompt width={80} onSubmit={() => {}} onCancel={onCancel} />);
    stdin.write("");
    expect(onCancel).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/ui/components/ReccClaimPrompt.test.tsx`
Expected: FAIL — cannot resolve `./ReccClaimPrompt`.

- [ ] **Step 3: Implement**

Create `src/ui/components/ReccClaimPrompt.tsx`:

```tsx
import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { TextField } from "./TextField";
import { Panel } from "./Panel";
import { COLOR, ICON } from "../theme";

type FieldKey = "name" | "password";

interface ReccClaimPromptProps {
  width: number;
  /** The generated name being replaced, when it is known. */
  accountName?: string;
  /** The message from a failed attempt, kept on screen so the user can retry. */
  error?: string;
  busy?: boolean;
  onSubmit: (name: string, password: string) => void;
  onCancel: () => void;
}

function Field({ label, active, children }: { label: string; active: boolean; children: React.ReactNode }) {
  return (
    <Box>
      <Box width={10} flexShrink={0}>
        <Text color={active ? COLOR.accent : undefined} dimColor={!active}>
          {label}
        </Text>
      </Box>
      <Text color={active ? COLOR.accent : COLOR.alt}>{`${ICON.pointer} `}</Text>
      <Box flexGrow={1} minWidth={0}>
        {children}
      </Box>
    </Box>
  );
}

// Claiming an account that already works. The account was created for the user
// automatically and holds their history; this gives it a name and a password so
// they can reach it from somewhere else. Worth saying on screen, because
// "claim" alone reads like something is currently broken.
export function ReccClaimPrompt({
  width,
  accountName,
  error,
  busy = false,
  onSubmit,
  onCancel,
}: ReccClaimPromptProps) {
  const [field, setField] = useState<FieldKey>("name");
  const [nameVal, setNameVal] = useState("");
  const [passwordVal, setPasswordVal] = useState("");

  const submit = (): void => {
    if (busy) return;
    onSubmit(nameVal.trim(), passwordVal);
  };

  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.upArrow) setField("name");
    else if (key.downArrow) setField("password");
  });

  return (
    <Box flexDirection="column" width={width}>
      <Panel title="claim your reccd account" width={width} focused height={6}>
        <Box marginBottom={1}>
          <Text dimColor wrap="truncate">
            {accountName
              ? `${accountName} holds your history. Pick a username and password to sign in elsewhere.`
              : "Pick a username and password so you can sign in elsewhere."}
          </Text>
        </Box>
        <Field label="Username" active={field === "name"}>
          <TextField
            isDisabled={field !== "name"}
            placeholder="the name you'll sign in with"
            onChange={setNameVal}
            onSubmit={() => setField("password")}
            onExitDown={() => setField("password")}
          />
        </Field>
        <Field label="Password" active={field === "password"}>
          <TextField
            isDisabled={field !== "password"}
            mask
            placeholder="at least 8 characters"
            onChange={setPasswordVal}
            onSubmit={submit}
          />
        </Field>
        <Box marginTop={1}>
          {busy ? (
            <Text dimColor>Claiming…</Text>
          ) : error ? (
            <Text color={COLOR.warn} wrap="truncate">{`${ICON.warn} ${error}`}</Text>
          ) : (
            <Text dimColor>Your picks and history stay exactly as they are.</Text>
          )}
        </Box>
      </Panel>
      <Box marginTop={1}>
        <Text color={COLOR.alt}>↵</Text>
        <Text dimColor> next / claim</Text>
        <Text dimColor>{`     ${ICON.dot}     `}</Text>
        <Text color={COLOR.alt}>↑↓</Text>
        <Text dimColor> field</Text>
        <Text dimColor>{`     ${ICON.dot}     `}</Text>
        <Text color={COLOR.alt}>esc</Text>
        <Text dimColor> cancel</Text>
      </Box>
    </Box>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/ui/components/ReccClaimPrompt.test.tsx`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ui/components/ReccClaimPrompt.tsx src/ui/components/ReccClaimPrompt.test.tsx
git commit -m "feat(ui): a prompt for claiming an anonymous reccd account"
```

---

## Task 14: torlink — the `c` key on the Accounts row

**Repo:** torlink

**Files:**
- Modify: `src/ui/components/Accounts.tsx`
- Modify: `src/ui/keymap.ts:34-42` **and** `:151-161` — both halves
- Test: `src/ui/components/Accounts.test.tsx`, `src/ui/keymap.test.ts`

**Interfaces:**
- Consumes: `ReccStatus.account` (Task 10).
- Produces: `AccountsProps.onClaimRecc: () => void`; `Row.claimable?: boolean`; `Row.onClaim?: () => void`.

- [ ] **Step 1: Write the failing tests**

Add to `src/ui/components/Accounts.test.tsx` — follow the file's existing props-builder helper rather than constructing `AccountsProps` by hand:

```tsx
it("offers c to claim an unclaimed reccd account", () => {
  const { lastFrame } = renderAccounts({
    reccConfigured: true,
    reccStatus: { state: "connected", host: "reccd.stream", account: { name: "quiet-heron-4f2a", claimed: false } },
  });
  expect(lastFrame()).toContain("claim");
});

it("does not offer c once the account is claimed", () => {
  const { lastFrame } = renderAccounts({
    reccConfigured: true,
    reccStatus: { state: "connected", host: "reccd.stream", account: { name: "ash", claimed: true } },
  });
  expect(lastFrame()).not.toContain("claim");
});

// A hand-configured self-hosted reccd reports no account. Offering a claim
// there would promise something the keypress cannot do.
it("does not offer c when the connection reports no account", () => {
  const { lastFrame } = renderAccounts({
    reccConfigured: true,
    reccStatus: { state: "connected", host: "192.168.0.98:4100" },
  });
  expect(lastFrame()).not.toContain("claim");
});

it("fires onClaimRecc when c is pressed on the reccd row", () => {
  const onClaimRecc = vi.fn();
  const { stdin } = renderAccounts({
    reccConfigured: true,
    reccStatus: { state: "connected", host: "reccd.stream", account: { name: "quiet-heron-4f2a", claimed: false } },
    onClaimRecc,
  });
  // Move the cursor to the reccd row — it is third, after the two debrid rows
  // and RuTracker, so use whatever cursor helper this file already uses rather
  // than assuming an index.
  moveCursorToRecc(stdin);
  stdin.write("c");
  expect(onClaimRecc).toHaveBeenCalledTimes(1);
});

it("ignores c on a row that cannot be claimed", () => {
  const onClaimRecc = vi.fn();
  const { stdin } = renderAccounts({ onClaimRecc });
  stdin.write("c"); // cursor starts on a debrid row
  expect(onClaimRecc).not.toHaveBeenCalled();
});
```

Add to `src/ui/keymap.test.ts`:

```ts
it("advertises c for claiming in both halves of the accounts keymap", () => {
  const help = HELP_GROUPS.find((g) => g.title === "Accounts");
  expect(help?.hints.some((h) => h.keys === "c")).toBe(true);
  const footer = footerHints("content", "accounts");
  expect(footer.some((h) => h.keys === "c")).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/ui/components/Accounts.test.tsx src/ui/keymap.test.ts`
Expected: FAIL — `onClaimRecc` is not a prop; no `c` hint.

- [ ] **Step 3: Implement**

In `src/ui/components/Accounts.tsx`:

1. Add to `AccountsProps`, next to `onImportRecc`:

```ts
  onClaimRecc: () => void;
```

2. Add to the `Row` interface, next to `importable`:

```ts
  // Offered only when reccd reports an account with no password yet. A claimed
  // account, or a self-hosted reccd that reports no account at all, must not
  // advertise the key — a hint for something the keypress will not do is worse
  // than no hint.
  claimable?: boolean;
  onClaim?: () => void;
```

3. In the reccd row literal, after `onImport`:

```ts
      claimable: reccStatus?.state === "connected" && reccStatus.account?.claimed === false,
      onClaim: onClaimRecc,
```

4. In `useInput`, after the `i` branch:

```ts
      else if (input === "c" && rows[clamped]!.claimable) rows[clamped]!.onClaim?.();
```

5. In the signed-in hints block, after the `r.importable` block:

```tsx
                    {r.claimable ? (
                      <Text>
                        <Text dimColor>{`  ${ICON.dot}  `}</Text>
                        <Text color={COLOR.alt}>c</Text>
                        <Text dimColor> claim</Text>
                      </Text>
                    ) : null}
```

6. Destructure `onClaimRecc` in the component's parameter list.

In `src/ui/keymap.ts`, add to **both** places:

```ts
      { keys: "c", label: "Claim the reccd account (set a username and password)" },
```

in `HELP_GROUPS`' Accounts group, and

```ts
      { keys: "c", label: "Claim" },
```

in `footerHints`' `section === "accounts"` branch. Note `c` is already used in the **seeding** pane for "Remove from list" — a different pane, so there is no conflict, but do not touch that binding.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/ui/components/Accounts.test.tsx src/ui/keymap.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/components/Accounts.tsx src/ui/components/Accounts.test.tsx src/ui/keymap.ts src/ui/keymap.test.ts
git commit -m "feat(ui): c claims the reccd account from the Accounts pane"
```

---

## Task 15: torlink — App.tsx wiring

**Repo:** torlink

**Files:**
- Modify: `src/ui/App.tsx`
- Modify: `scripts/render-previews-impl.tsx` and `src/ui/testHarness.ts` **only if** a `Store` field is added (it should not be — see below)

**Interfaces:**
- Consumes: `ensureReccAccount` + `ProvisionedPatch` (Task 8), `claimReccAccount` (Task 9), `ReccClaimPrompt` (Task 13), `Accounts.onClaimRecc` (Task 14).

**No new `Store` field.** Claim state is local `useState` in `App.tsx`, exactly as `editingRecc` is. If you find yourself adding one, `CLAUDE.md` requires matching entries in **both** `makeStore` (`scripts/render-previews-impl.tsx`, or `npm run previews` breaks) and `makeTestStore` (`src/ui/testHarness.ts`, or `npm run typecheck` breaks). Prefer not to.

- [ ] **Step 1: Add the provisioning call**

Near the existing recc status effect (~line 970), add a one-shot effect. It must run after the config has loaded and exactly once per process:

```tsx
  // Auto-provision an anonymous reccd account on first run. Fire-and-forget
  // and never awaited: spec §0 — reccd is a value-add, and nothing here may
  // delay or break the TUI.
  //
  // onProvisioned is NOT optional here. persistConfig writes the whole config
  // object from React state (see its definition above), so an account written
  // to config.json behind that state's back is silently reverted by the next
  // unrelated setting change. Applying the patch to state without re-saving
  // keeps the two in agreement.
  const provisionStarted = useRef(false);
  useEffect(() => {
    if (!config || provisionStarted.current) return;
    provisionStarted.current = true;
    void ensureReccAccount({
      onProvisioned: (patch) => {
        setConfigState((prev) => (prev ? { ...prev, ...patch } : prev));
        setNotice(`${ICON.done} Recommendations are on — reccd account ${patch.reccAccountName} created.`);
      },
    }).catch(() => {});
  }, [config]);
```

Use whichever state setter `persistConfig` uses (`setConfigState`) — **not** `persistConfig` itself, which would write the file a second time. Import `useRef` if it is not already imported.

- [ ] **Step 2: Add the claim prompt state and handler**

```tsx
  const [claimingRecc, setClaimingRecc] = useState(false);
  const [claimBusy, setClaimBusy] = useState(false);
  const [claimError, setClaimError] = useState<string | undefined>(undefined);

  const openClaimPrompt = useCallback(() => {
    setView("browser");
    setShowHelp(false);
    setClaimError(undefined);
    setClaimingRecc(true);
  }, []);

  const closeClaimPrompt = useCallback(() => {
    setClaimingRecc(false);
    setClaimBusy(false);
    setClaimError(undefined);
  }, []);

  const submitClaim = useCallback(
    (name: string, password: string) => {
      if (!config) return;
      setClaimBusy(true);
      setClaimError(undefined);
      void (async () => {
        const result = await claimReccAccount(resolveReccConfig(config), name, password);
        setClaimBusy(false);
        if (result.ok) {
          closeClaimPrompt();
          const claimed = { reccAccountName: result.name, reccAccountClaimed: true };
          persistConfig(claimed);
          setNotice(`${ICON.done} reccd account claimed as ${result.name}.`);
          // The POST-CLAIM config, not `config`. Passing the stale one means
          // the differs-only check in refreshReccStatus compares /profile's
          // `claimed: true` against a snapshot still saying false, and writes
          // the whole config a second time for no reason — defeating the very
          // rule that check exists to enforce.
          refreshReccStatus({ ...config, ...claimed });
          return;
        }
        if (result.reason === "alreadyClaimed") {
          // Claimed from another machine. Local state was simply stale, so
          // close and let the status check correct it rather than nagging.
          closeClaimPrompt();
          persistConfig({ reccAccountClaimed: true });
          setNotice(result.message);
          refreshReccStatus({ ...config, reccAccountClaimed: true });
          return;
        }
        // nameTaken / invalid / unauthorized / unreachable: keep the prompt
        // open with the message so the user can try again without retyping.
        setClaimError(result.message);
      })();
    },
    [config, closeClaimPrompt, persistConfig, refreshReccStatus],
  );
```

- [ ] **Step 3: Render the overlay and pass the prop**

Beside the existing `editingRecc ? <ReccdPrompt .../> : null` block (~line 2409):

```tsx
        {claimingRecc ? (
          <ReccClaimPrompt
            width={overlayWidth}
            accountName={reccStatus?.account?.name ?? store.config.reccAccountName}
            error={claimError}
            busy={claimBusy}
            onSubmit={submitClaim}
            onCancel={closeClaimPrompt}
          />
        ) : null}
```

Use the same width expression the neighbouring `ReccdPrompt` uses. Pass `onClaimRecc={openClaimPrompt}` to `<Accounts />` (~line 2854).

Add `claimingRecc` to **every** `showHelp || editingFolder || editingToken || editingRecc || ...` guard chain — there are four of them (~lines 2037, 2098, 2803, 2892) — and to the input-ownership early return beside `if (editingRecc) return;` (~line 2154):

```tsx
      if (claimingRecc) return; // the claim prompt owns input
```

Missing one of those guards is the failure mode here: the pane underneath keeps handling keystrokes while the overlay is open, so typing a username also triggers pane shortcuts.

- [ ] **Step 4: Keep the account name current from /profile**

In `refreshReccStatus`, after `setReccStatus`, correct config **only when it differs** — spec §2.3:

```tsx
    void checkReccConnection(rc).then((status) => {
      setReccStatus(status);
      const account = status.account;
      if (!account) return;
      // Differs-only, deliberately: this runs on every status refresh, and an
      // unconditional write here would turn a network read into a config write
      // on a timer — the same two-process race provision.ts takes a lock to
      // avoid, reintroduced.
      if (account.name !== cfg?.reccAccountName || account.claimed !== cfg?.reccAccountClaimed) {
        persistConfig({ reccAccountName: account.name, reccAccountClaimed: account.claimed });
      }
    });
```

`refreshReccStatus` currently has `[]` deps and takes `cfg` as an argument — add `persistConfig` to its dependency array and keep using the `cfg` parameter rather than reading `config` from scope.

- [ ] **Step 5: Verify**

Run: `npm test && npm run typecheck && npm run lint`
Expected: clean, bar the one known pre-existing warning.

Then run it: `npm run dev` with a `TORLINK_CONFIG_DIR`-equivalent throwaway config dir (or an empty `config.json`) pointed at a local reccd via `TORLINK_RECC_URL`, and confirm — an account appears without you doing anything; the Accounts row names it `(unclaimed)`; `c` opens the prompt; claiming updates the row; a wrong/taken username keeps the prompt open with the message.

**Then the regression that motivated `onProvisioned`:** after provisioning, change the sort (or toggle a source), quit, and confirm `reccToken` is still in `config.json`.

- [ ] **Step 6: Commit**

```bash
git add src/ui/App.tsx
git commit -m "feat(ui): provision a reccd account on launch, and claim it from Accounts"
```

---

## Task 16: torlink — the `serve` call site

**Repo:** torlink

**Files:**
- Modify: `src/daemon/serve.ts` — inside `runServe` (line 327)
- Test: `src/recc/provision.test.ts` (the source-shape assertion)

- [ ] **Step 1: Write the failing test**

Add to `src/recc/provision.test.ts`:

```ts
// §0's one requirement a unit test of this module cannot reach: the call sites
// must not await, and must carry their own catch. An unhandled rejection from a
// fire-and-forget reccd call is the exact hazard routes.ts documents, and an
// await would put reccd on torlink's startup path. deps-pin.test.ts sets the
// precedent for asserting on source shape.
describe("call sites", () => {
  const CALL_SITES = ["src/ui/App.tsx", "src/daemon/serve.ts"];

  for (const rel of CALL_SITES) {
    it(`${rel} calls ensureReccAccount fire-and-forget, with a catch`, () => {
      const source = readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");
      expect(source).toContain("ensureReccAccount");
      // No `await ensureReccAccount` anywhere — that would put reccd on the
      // startup path.
      expect(source).not.toMatch(/await\s+ensureReccAccount/);
      // ONE regex spanning the whole call, deliberately: an earlier draft
      // sliced from `source.indexOf("ensureReccAccount(")` and asserted the
      // remainder contained ".catch(", which matched the import line first and
      // then found some unrelated `.catch(` hundreds of lines later. It passed
      // whatever the call site did. A vacuous assertion is worse than none —
      // the same trap CLAUDE.md records for `not.toContain` after a rename.
      // {0,600} covers App.tsx's multi-line onProvisioned callback.
      expect(source).toMatch(/void ensureReccAccount\([\s\S]{0,600}?\)\.catch\(/);
    });
  }
});
```

Import `readFileSync` from `node:fs` at the top of the test file.

**Prove the test is not vacuous** before moving on: temporarily delete `.catch(() => {})` from the
`serve.ts` call site and confirm the test fails. Then put it back. A source-shape assertion that
cannot fail is the trap this test replaced.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/recc/provision.test.ts -t "call sites"`
Expected: FAIL for `src/daemon/serve.ts` — it does not mention `ensureReccAccount`. `App.tsx` should already pass from Task 15.

- [ ] **Step 3: Implement**

In `src/daemon/serve.ts`, inside `runServe`, immediately after the config is loaded and **before** the server binds its port — so a slow signup delays nothing:

```ts
  // A headless seedbox and `serve --web` get an account too. Fire-and-forget,
  // never awaited: spec §0. No onProvisioned callback — unlike the TUI, this
  // process holds no config snapshot (routes.ts calls loadConfig() per
  // request), and the cross-process lock in provision.ts is what makes it safe
  // for this and a running TUI to both call it.
  void ensureReccAccount().catch(() => {});
```

Import it: `import { ensureReccAccount } from "../recc/provision";`

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/recc/provision.test.ts && npm run typecheck && npm run lint`
Expected: PASS, clean.

- [ ] **Step 5: Verify by running it**

Run: `npm run dev -- serve --web` with a throwaway empty config dir and confirm an account is provisioned and the web For You pane works with no TUI ever launched. Then start both at once against the same config dir and confirm exactly **one** account is created — `config.json` has one `reccToken`, and reccd shows one new user.

- [ ] **Step 6: Commit**

```bash
git add src/daemon/serve.ts src/recc/provision.test.ts
git commit -m "feat(serve): provision a reccd account on headless startup"
```

---

## Task 17: torlink — documentation

**Repo:** torlink

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-07-22-reccd-account-setup-design.md`

- [ ] **Step 1: Rewrite the README's reccd section**

Find the existing reccd section (grep `reccd` in `README.md`). It currently frames reccd as private and self-hosted. Lead instead with the default, then keep self-hosting as the alternative it now is. Cover, in plain terms:

- **On first launch, torlink creates an anonymous account on `https://reccd.stream` and turns recommendations on.** One request, no personal information beyond the request itself, and it fails silently — if reccd is unreachable, recommendations stay off and nothing else changes.
- It only happens when nothing is configured. A `reccUrl` pointing at your own reccd is never signed up against.
- **The opt-out**, spelled out: `"reccAutoSignup": false` in `config.json`, or point `TORLINK_RECC_URL` at your own instance. Clearing the reccd connection from the Accounts pane sets the flag for you, so cleared stays cleared.
- **Claiming**: the account works immediately but has no password, so it lives in that one `config.json`. Press `c` on the reccd row in Accounts to set a username and password; history is kept, and you can then sign in from another machine. Terminal-only, because it is credential entry — the browser tells you the account is unclaimed and points here.
- **The caveat**: an unclaimed account is reachable only from the machine holding that `config.json`. Copy the file to a second machine before its first run, or share a config directory over a sync service, and you may end up with two accounts and a split history. Claim it first if that is your setup.

- [ ] **Step 2: Check the web UI's own limitations list**

Grep `README.md` and `src/web/static/index.html` for the browser UI's list of what it cannot do. If it says reccd must be configured in the terminal, that is still true and should now also mention claiming. If it implies recommendations need setting up at all, that is no longer true — fix it.

- [ ] **Step 3: Add a status note to the superseded spec**

At the top of `docs/superpowers/specs/2026-07-22-reccd-account-setup-design.md`, directly under its `**Status:**` line:

```markdown
> **Superseded in part, 2026-07-31.** This document's framing of reccd as "a private, self-hosted
> service" configured by hand is no longer the default — see
> `2026-07-31-reccd-auto-account-design.md`, under which torlink provisions an account on
> `https://reccd.stream` on first run. Everything here still describes the self-hosted path, which
> is still supported and still the only path for your own deployment.
```

- [ ] **Step 4: Commit**

```bash
git add README.md docs/superpowers/specs/2026-07-22-reccd-account-setup-design.md
git commit -m "docs: recommendations now work out of the box, and can be claimed"
```

---

## Task 18: Full verification

**Repo:** both

- [ ] **Step 1: reccd**

```bash
cd ../reccd && npm test && npm run build
```
Expected: both clean.

- [ ] **Step 2: torlink, all four gates**

```bash
npm test && npm run typecheck && npm run lint && npm run build
```
Expected: clean, bar the one known `react-hooks/exhaustive-deps` warning in `src/ui/App.tsx`.

- [ ] **Step 3: Sweep for the traps `CLAUDE.md` names**

```bash
grep -rn "reccd.stream" src | grep -v "provision.ts" | cut -c1-120     # only provision.ts defines it
grep -rnE "innerHTML|insertAdjacentHTML|document\.write|outerHTML" src/web/static/
grep -rn "from \"../ui" src/web/ | cut -c1-120                          # layering: must be empty
grep -rn "reccClaimed" src | cut -c1-120                                # should be empty — the field is reccAccount
```
Expected: the first prints only imports, the middle two print nothing, the last prints nothing.

- [ ] **Step 4: End-to-end, by hand, against a real reccd**

With a throwaway config dir and reccd running locally (or `reccd.stream` deployed):

1. Launch the TUI with no config. An account appears; For You works; the Accounts row reads `Connected · <host> · <name> (unclaimed)`.
2. Press `c`, claim it. The row loses `(unclaimed)`. `POST /login` on reccd accepts the new credentials.
3. Open `serve --web`. The For You pane works and shows **no** claim hint.
4. Reset to a fresh config, provision, and check the browser **does** show the claim hint.
5. Stop reccd entirely and confirm search, download and streaming are untouched, and For You reports a reachability message rather than hanging or crashing — spec §0.
6. Set `"reccAutoSignup": false` on a fresh config and confirm no request is made (watch reccd's log, or use a `TORLINK_RECC_URL` pointed at a listener).

- [ ] **Step 5: PR**

Open **one PR per repo**. reccd first — torlink's half does nothing until it is deployed.

torlink's PR body must state, explicitly, per `CLAUDE.md`:

- **Auto-provisioning ships in both front ends by construction** — both read the same `config.json`, so the browser's For You lights up with no web-side change to that path.
- **Claim entry is terminal-only, deliberately**, because it is credential entry and configuration is TUI-only by design. The browser is not silent about it: `/api/sources` reports `reccAccount` and the For You pane names where to claim.
- **torlink now contacts `https://reccd.stream` on first launch by default**, with the bail-out conditions and the opt-out. This is the one thing a reviewer should be asked to agree to on purpose rather than discover.

Check the base repo before pushing — `CLAUDE.md`'s fork warning. `origin` is `WarlaxZ/torlink`; the parent remote is `forked-from` and must stay named that.

---

## Self-Review

**Spec coverage**

| Spec section | Task |
| --- | --- |
| §0 fail-soft invariant, requirements 1–5 | Tasks 8 (tests), 10 (tolerant `/profile` parse), 15–16 (call sites), 18 step 4.5 |
| §1.1 `POST /signup/anonymous` incl. 3/hour, name retry, 503 | Tasks 2, 3 |
| §1.2 `POST /claim` incl. the `is_public` guard | Tasks 1, 4 |
| §1.3 `GET /profile.account` | Task 5 |
| §1.4 reccd README | Task 5 |
| §2.1 bail-outs, lock, re-read-then-write, `onProvisioned` | Tasks 7, 8 |
| §2.2 `claimReccAccount` | Task 9 |
| §2.3 three config fields, differs-only name write | Tasks 6, 15 step 4 |
| §2.4 both call sites | Tasks 15, 16 |
| §3.1 status suffix, `c` key, both keymap halves, opt-out on disconnect | Tasks 10, 13, 14; **opt-out on disconnect — see gap below** |
| §3.2 `reccAccount`, `reccClaimHint`, no `innerHTML` | Tasks 11, 12 |
| §4 + §4.1 failure table | Tasks 8, 9 tests; §4.1 is documented, not coded — Task 17 |
| §5 testing | Every task's steps 1–4; §0's suite in Task 8 |
| §6 docs | Task 17 |

**Gap found and closed:** §3.1 requires that clearing reccd from the Accounts pane also sets `reccAutoSignup: false`, or the next launch silently signs the user back up. No task covered it. Added below as **Task 14b**, which is small enough to fold into Task 14's commit but is listed separately so it cannot be skipped.

**Type consistency:** checked `ProvisionedPatch`, `ClaimReccResult`, `ReccAccount`/`PublicReccAccount` (two names on purpose — one internal, one on the wire, matching how `wire.ts` already mirrors internal types), `shouldProvision`, `ensureReccAccount`, `claimUser`'s `"claimed" | "notClaimable"`, and `getUserAccount`. Consistent across tasks.

---

## Task 14b: clearing reccd must also opt out

**Repo:** torlink

**Files:**
- Modify: `src/ui/App.tsx` — `clearReccConfig` (~line 994)

- [ ] **Step 1: Write the failing test**

There is no unit test for `clearReccConfig` today and adding an `App.tsx` harness for one is disproportionate. Verify by hand instead, and record the reason in the code comment.

- [ ] **Step 2: Implement**

```tsx
    persistConfig({
      reccUrl: undefined,
      reccToken: undefined,
      reccAccountName: undefined,
      reccAccountClaimed: undefined,
      // Without this the next launch silently signs them straight back up,
      // which is the most obvious way to make auto-provisioning feel broken:
      // the user cleared it, and it came back. Clearing means cleared.
      reccAutoSignup: false,
    });
    setNotice("reccd connection cleared. Recommendations stay off until you set it up again.");
```

- [ ] **Step 3: Verify by hand**

Launch the TUI, let it provision, press `x` on the reccd row, quit, relaunch. Confirm `config.json` has `"reccAutoSignup": false`, no `reccToken`, and that no second account is created.

- [ ] **Step 4: Commit**

```bash
git add src/ui/App.tsx
git commit -m "fix(ui): clearing reccd opts out of auto-signup, so cleared stays cleared"
```
