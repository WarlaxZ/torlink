# reccd Auto-Provisioned Accounts, and Claiming Them — Design

**Date:** 2026-07-31
**Status:** Approved (design)
**Spans two repositories:** `torlink` (this one) and `reccd` (`../reccd`, deployed at
<https://reccd.stream>).
**Supersedes the framing of:** `2026-07-22-reccd-account-setup-design.md`, which described reccd as
"a private, self-hosted service" with a hand-pasted URL and token. That is still supported and still
the only path for a self-hosted reccd; it is no longer the default.

## Problem

Using reccd today requires a human to stand up a Postgres+pgvector deployment, run
`npm run user:add`, copy a bearer token, and paste it plus a URL into torlink's Accounts pane. Until
all of that is done the "For You" nav item is hidden, so the recommendation engine — a large part of
what torlink does — is invisible to every user who has not read the README closely.

reccd is now hosted at `https://reccd.stream` with a self-service `POST /signup`. So the setup can be
reduced to nothing at all: torlink can create an account on first run and start working. The cost is
that the account has no name the user chose and no password, so it is bound to one `config.json` and
one machine. **Claiming** fixes that — setting a username and password on the existing account,
keeping every event already recorded against it.

Two things reccd cannot do yet, and this design adds both:

- create an account without a human-chosen name and password;
- change an account's name or password after creation. `POST /login` re-authenticates but cannot
  rename, and the only post-creation write to `activity.users` is `reissueToken`.

## Non-goals

- Auto-provisioning against a **self-hosted** reccd. If the user has set `reccUrl`, torlink never
  signs up on their behalf — see the bail-out conditions in §2.
- Group / household recommendations. torlink never sends `with=`, so the fact that self-signup
  accounts are excluded from group recommendations in both directions costs it nothing.
- Migrating an existing account, or merging two accounts. A user who ends up with an orphan
  anonymous account and a claimed one has two accounts; nothing here reconciles them.
- Encrypting the token at rest. It sits in `config.json` in plaintext, matching `realDebridToken`,
  `torBoxToken` and `omdbApiKey`.

## 0. The overriding constraint: reccd is a value-add, never a dependency

**No reccd failure — down, slow, rate-limiting, DNS-black-holed, returning garbage, or newly
unreachable months after a successful signup — may degrade anything in torlink other than
recommendations themselves.** Search, download, stream, favourites, the file browser and both front
ends must behave identically with `reccd.stream` resolving to nothing. This constraint outranks every
other goal in this document; where they conflict, this wins.

The codebase already holds this line — `postEvent`'s comment ("reccd being unreachable, slow, or
erroring must never affect torlink") and `routes.ts:1043`'s note that an unhandled rejection here is
"the exact *reccd must never take the process with it* rule" — and this change adds the first reccd
call that runs **at startup**, which is the one place a mistake would be fatal rather than cosmetic.
So the rule becomes concrete requirements:

1. **Nothing awaits `ensureReccAccount`.** Not `App.tsx`'s render path, not `runServe` before it
   binds its port. Both call sites are `void ensureReccAccount().catch(() => {})` — the explicit
   `.catch` is not redundant belt-and-braces, it is what stops an unhandled rejection killing the
   process under Node's default behaviour, which is precisely the hazard `routes.ts:1043` documents.
2. **`ensureReccAccount` never rejects and never throws**, including on a filesystem error taking or
   releasing the lock, a malformed response body, or `saveConfig` failing. Its return type is
   `Promise<void>`; there is no result to inspect and no error to report.
3. **Every reccd call carries an `AbortSignal.timeout`.** Signup 8s, `/profile` 6s (existing),
   `/events` 3s (existing), claim 10s. A hung TCP connect must not become a hung torlink.
4. **A reccd outage after a successful signup is the normal case, not an edge case.** Once
   provisioning has written `reccUrl`, For You is *visible* — so unlike today's unconfigured user,
   this user can reach a pane that depends on a remote host. `fetchRecommendations` already returns
   `{ ok: false, error }` rather than throwing, and both front ends already render that; this design
   adds no new path. What it does add is the obligation to check that both surfaces still read
   sensibly when the answer is "couldn't reach reccd" — an empty pane with a quiet line, not a
   spinner forever and not an error dialog.
5. **The status check must tolerate an older reccd.** A self-hosted deployment without §1.3's
   `account` field, or with a malformed one, degrades to no name suffix. No optional-chain-free field
   access on that response.

§4 tabulates the individual outcomes; this section is the rule they all serve, and §5 tests it
directly rather than by inspection.

## 1. reccd (`../reccd`)

### 1.1 `POST /signup/anonymous`

Public (`config: { public: true }`), rate-limited **3 requests/hour per IP** — tighter than
`/signup`'s 5, because nothing human-driven calls it and one machine needs it once, ever. Registered
inside the existing `app.after(() => { ... })` block, for the reason the comment above `/signup`
already gives: `@fastify/rate-limit`'s `onRoute` hook must have run first or the limit silently does
not apply.

No request body. reccd generates the name from a fixed adjective/noun word list plus four hex
characters — `quiet-heron-4f2a` — retrying up to **5** times on a `23505` unique violation before
returning `503 { "error": "could not allocate a name" }`. The word lists must not name real people,
places that read as people, or titles; two neutral lists (textures/moods and birds/trees) are
enough, and 4 hex characters of suffix means collisions are already rare at list sizes of ~40 each.

Creates the user with `createUser(pool, name, { isPublic: true })` — no `password`, so
`password_hash` is `NULL`, which is what makes the account claimable.

Response `201 { "id": number, "name": string, "token": string }`, matching `/signup`.

### 1.2 `POST /claim`

Authenticated by the normal bearer flow (no `config.public`), so no additional rate limit: a caller
must already hold a valid account token to make an attempt at all.

Body `{ name, password }`, validated exactly as `/signup` does, with the same error strings so the two
routes cannot drift:

- non-string `name`/`password`, or a malformed/`null` body → `400 { "error": "name and password must be strings" }`
- `name` empty or over 64 characters after trimming → `400 { "error": "name must be 1-64 characters" }`
- `password` shorter than 8 characters → `400 { "error": "password must be at least 8 characters" }`

Then a single guarded write, in a new `claimUser(pool, userId, name, password)` in `src/db/users.ts`:

```sql
UPDATE activity.users
   SET name = $1, password_hash = $2
 WHERE id = $3 AND password_hash IS NULL AND is_public = true
```

- 0 rows affected → `400 { "error": "account already claimed" }`
- `23505` → `409 { "error": "name already taken" }`
- success → `200 { "name": string }`

`is_public = true` in the `WHERE` clause is load-bearing, not defensive tidiness. Without it, a
household account created by `npm run user:add` (also `password_hash IS NULL`) could rename itself
using its own token, and every other user's `with=<oldname>` list would silently stop resolving.
`countUsers`, `findHouseholdUserByName` and the group-recommendation exclusion all key on names and
`is_public`, so a rename in that population is a data-integrity problem rather than a user
preference.

The account stays `is_public = true` after claiming. It is still a self-service account; claiming
grants a login, not household membership.

### 1.3 `GET /profile` gains `account`

```
{ ...tasteProfile, seenImdbIds: [...], account: { name: string, claimed: boolean } }
```

`claimed` is `password_hash IS NOT NULL`. This is three lines and it removes an entire class of drift:
torlink already pings `/profile` to classify the connection for its Accounts pane, so it learns the
authoritative name and claim state on every status check — including when the account was claimed
from a different machine, which local config could never know about.

### 1.4 reccd docs

`README.md`'s API section gains both routes, and the sentence listing the endpoints that do not
require a bearer token must grow `POST /signup/anonymous`. The existing "Deployment warning" about
`cf-connecting-ip` spoofing now covers three rate-limited public routes rather than two — reword it
to say so, because `/signup/anonymous` is the cheapest of the three to abuse.

## 2. torlink — `src/recc/provision.ts`

One new module. It owns `DEFAULT_RECC_URL = "https://reccd.stream"`, which is the only place that
constant appears.

### 2.1 `ensureReccAccount(deps): Promise<void>`

Runs at most once per process, in the background, and resolves to nothing. It never throws and never
surfaces an error to the user: a failure means For You stays hidden exactly as it does today.

**Bail out immediately, before any network call, unless all three hold:**

| Condition | Why |
| --- | --- |
| `config.reccToken` absent **and** `TORLINK_RECC_TOKEN` unset | An account already exists. |
| The resolved `reccUrl` is either absent **or** exactly `DEFAULT_RECC_URL` | Absent is the fresh install. Equal to `DEFAULT_RECC_URL` covers the user who typed `https://reccd.stream` into the Accounts pane and left the token blank, or who signed up by hand — provisioning against the host they already named is what they were trying to do. Any **other** URL is a self-hosted reccd: signing up against it guesses at an endpoint their deployment may not have, and signing up against `reccd.stream` instead ignores what they configured. Both are wrong, so do nothing. |
| `config.reccAutoSignup !== false` | The explicit opt-out. |

Reuses `resolveReccConfig`'s env-over-config precedence rather than reading `process.env` again, so
there is one definition of "configured".

**Then, in order:**

1. **Take a cross-process lock.** `fs.open(path.join(configDir, "recc-provision.lock"), "wx")`. On
   `EEXIST`, stat the file: mtime under 60s old → return silently, another process is mid-signup;
   older → `unlink` and retry the open exactly once, then give up. This is the load-bearing part.
   Per `CLAUDE.md`, `serve --web` is a separate process from any TUI and `serializeWrites()` only
   serializes within one process, so two cold starts without this lock produce two accounts, one
   token overwriting the other, and the user's history split across an orphan they can never reach.
2. **`POST {DEFAULT_RECC_URL}/signup/anonymous`.** Single attempt, 8s timeout, injected `fetch`,
   every failure swallowed to `log.debug`. Deliberately the `postEvent` posture and deliberately not
   `fetchResilient`: retrying into a rate limit or an outage piles up concurrent requests at the
   worst moment. A `429` — shared CGNAT, a corporate egress IP, a Docker host running several
   installs — is an expected outcome, not an error. Nothing is written, and the next launch tries
   again; one request per launch is self-limiting.
3. **Re-read, then write.** `loadConfig()` fresh, and if `reccToken` has appeared in the meantime,
   discard the new account rather than overwrite — an orphan account on reccd is a much smaller
   problem than a lost token. Otherwise set `reccUrl`, `reccToken` and `reccAccountName`, then
   `saveConfig()`. Read-modify-write per operation, never a snapshot held across the network call,
   per `CLAUDE.md`.
4. **Release the lock in a `finally`** — unlink, ignoring `ENOENT`.

**`ensureReccAccount` takes an `onProvisioned?: (patch) => void` callback, and the TUI must pass
one.** This is not a nicety. `App.tsx`'s `persistConfig` (line 653) writes the **whole** config object
from React state — `saveConfig({ ...prev, ...patch })`. Provisioning writes `config.json` behind that
state's back, so without a callback the very next `persistConfig` call in that session (changing the
sort, toggling a source, adding a favourite) serialises a snapshot with no `reccToken` and **silently
deletes the account the user just got**. The callback applies the patch via `setConfigState` *without*
re-saving, so React's copy and the file agree. `runServe` passes nothing — it holds no equivalent
snapshot, and `routes.ts` already calls `loadConfig()` per request.

### 2.2 `claimReccAccount` in `src/recc/client.ts`

Lives with the other reccd calls rather than in `provision.ts`: it is an authenticated API call the
user is waiting on, so it blocks and reports, unlike provisioning.

```ts
type ClaimResult =
  | { ok: true; name: string }
  | { ok: false; reason: "nameTaken" | "alreadyClaimed" | "invalid" | "unauthorized" | "unreachable"; message: string };
```

Mapped from `200` / `409` / `400 account already claimed` / other `400` / `401` / anything else. The
`message` is what the Accounts pane prints, so it must be a sentence rather than a status code.

### 2.3 Config

Three new fields on `Config`, all optional:

- `reccAccountName?: string` — the generated or claimed name. Written **once at signup**, and
  thereafter only by the TUI's Accounts pane, and only when `/profile`'s `account.name` actually
  differs from what is stored. Both halves of that rule matter: `checkReccConnection` is called from
  exactly one place today (`src/ui/App.tsx:967` — the web never runs a status check), and this field
  must not turn a network read into a config write on every poll. That would be the same
  two-process write race §2.1 builds a lock to avoid, reintroduced on a timer. Display prefers the
  live `/profile` value; the stored one is a fallback so the pane can name the account while offline.
- `reccAccountClaimed?: boolean` — written `false` at signup, `true` after a successful claim, and
  corrected by the TUI status check under the same differs-only rule as the name. It exists because
  the **web server cannot ask reccd**: `/api/sources` is the one payload the browser fetches before
  it can render anything, and hanging a network round trip off it to learn a fact that changes once
  per account lifetime is the wrong trade. Persisting it is the cheap side of that trade.
- `reccAutoSignup?: boolean` — absent or `true` means auto-provision; `false` is the opt-out.
  Absent-means-on is deliberate: this must work on a fresh install with no `config.json` at all.

`Config` is not a `Store` field, so the `makeStore`/`makeTestStore` rule in `CLAUDE.md` does not
apply here — but the Accounts pane state that surfaces it may be, and if so both must be updated.

### 2.4 Where it is called

Fired and forgotten from two places, both after config load:

- `src/ui/App.tsx` startup, alongside the existing status check;
- `runServe` in `src/daemon/serve.ts`, so a headless seedbox and `serve --web` get an account too.

The lock in §2.1 is what makes calling it from both safe. Neither call site awaits it or reacts to
it; the next status check picks up the result.

## 3. What each surface shows

**Both surfaces get working recommendations with no per-surface work.** They read the same
`config.json`, so once provisioning has written a token the browser's For You lights up exactly as
the terminal's does. This satisfies `CLAUDE.md`'s "a feature ships in both" by construction, and the
PR body should say so in as many words rather than leaving a reviewer to work it out.

### 3.1 Terminal — the Accounts pane

The existing reccd row's status line grows the account identity:

```
reccd    Connected · reccd.stream · quiet-heron-4f2a (unclaimed)
```

`formatReccStatus` takes the name and claim state and renders that suffix; `ReccStatus` gains
`account?: { name: string; claimed: boolean }`, populated from `/profile`. An unconfigured or
unreachable row is unchanged.

The presentation string staying in `src/recc/status.ts` is fine rather than a layering slip:
`formatReccStatus` and `checkReccConnection` are imported only by `src/ui/` (`App.tsx`,
`Accounts.tsx`, `ReccdPrompt.tsx`), and the web has no status path at all. If the browser ever grows
one, the suffix moves to the front end and only the `account` data stays here — flagged now so that
change is a decision rather than a discovery.

**`c`** on that row opens a claim prompt — two fields, username and password, reusing `ReccdPrompt`'s
existing two-field layout rather than a new component shape. `c` is free in the Accounts pane, which
currently binds `↑ ↓`, `↵`, `x`, `i` and `a`. It is offered only when the row is reccd **and** the
account is unclaimed; on any other row or a claimed account the key does nothing, and the hint is
suppressed rather than shown-but-dead — the same rule the Downloads pane's `x` label already follows.
The key goes in **both** halves of `src/ui/keymap.ts` (`HELP_GROUPS` and `footerHints`), per
`CLAUDE.md`. On success, write
`reccAccountName` and re-run the status check. On `nameTaken`, keep the prompt open with the message;
on `alreadyClaimed`, close it and refresh status, because the local state was simply stale.

Disconnecting reccd from this pane sets `reccAutoSignup: false` as well as clearing `reccUrl` and
`reccToken` — otherwise the next launch silently signs the user back up, which is the single most
obvious way to make this feature feel broken.

### 3.2 Browser

`/api/sources` gains **one** field, alongside `debridConfigured` and `omdbConfigured` and for the same
stated reason — no credential ever leaves the server:

```ts
reccAccount: { name: string; claimed: boolean } | null
```

`null` means no reccd is configured. Nesting it rather than adding a flat `reccClaimed: boolean` is
what makes it self-describing: a flat boolean is `false` both for "unclaimed account" and "no account
at all", so every reader would have to cross-reference something else to tell them apart, and one
reader eventually won't. The username is not a credential — it is the name the user will log in
*with*, and reccd will show it publicly once claimed — so returning it is safe and lets the browser
name the account instead of describing it abstractly.

Deliberately no companion `reccConfigured` flag: `/api/recommendations` already answers
`200 { status: "not-configured" }` when `reccUrl` is unset (`routes.ts:1400`), precisely so the
browser can say "set up reccd". A second field carrying that same fact is the copy-then-drift pattern
`CLAUDE.md` records four bugs from, and `reccAccount: null` already covers it for anyone who needs it
before the feed loads.

The For You pane shows one quiet line when configured but unclaimed:

> Recommendations are saved to an unclaimed account — claim it in the terminal UI to sign in elsewhere.

The decision goes in `src/web/static/reccModel.ts` as a new pure function
`reccClaimHint(reccAccount: PublicReccAccount | null | undefined): string | null`, returning the
sentence only when the account exists and is unclaimed. `undefined` means "`/api/sources` has not
answered yet" and returns `null`, following `resultPosters.ts`'s `omdbConfigured: boolean | null`
precedent so the sentence never flashes on a slow load.

It is deliberately **not** folded into the existing `reccStatus(state)`, which returns
`show: false` once there are cards to look at — the claim hint has to be visible precisely when the
feed is working, which is the one case that function suppresses. Separate line, separate function.
`app.ts` only mounts the text node. Per `CLAUDE.md`: no `innerHTML`, `createElement` +
`textContent` only.

**Claim entry is terminal-only, deliberately.** It is credential entry, and `CLAUDE.md` already
scopes tokens and account configuration to the TUI with the browser as a client of that config. The
web is not silent about it — it reports the state and names where to change it, which is the
difference between a deliberate boundary and a missing feature.

## 4. Failure behaviour, gathered in one place

| Situation | Behaviour |
| --- | --- |
| `reccd.stream` unreachable on first run | Nothing written, `log.debug`, For You hidden as today. Retried next launch. |
| `429` from `/signup/anonymous` | Identical to unreachable. No retry within the process. |
| `503 could not allocate a name` | Identical to unreachable. |
| Another process holds the lock | Return silently. No wait, no second signup. |
| Stale lock (>60s) | Unlink, retry once, then give up. |
| A token appeared during the request | Discard the new account, keep the existing token. |
| `saveConfig` fails | Swallowed by `serializeWrites`' existing `.catch`. Retried next launch. |
| User claims a name already taken | `409`, prompt stays open with the message. |
| User claims an account claimed elsewhere | `400`, prompt closes, status refreshes from `/profile`. |
| Token rejected (`401`) after a manual config edit | Existing `badToken` status. Provisioning does **not** fire, because a token is present. |
| A **self-hosted** `reccUrl` set, no token | Bail out, no request. The Accounts row already reads `Token rejected` or `Unreachable · <host>`, which names the problem; auto-provisioning against someone else's deployment is not the fix. |
| `reccUrl` set to `reccd.stream`, no token | Provisioning **does** fire — see the §2.1 table. This is the hand-setup user who left the token blank. |

### 4.1 What the lock does not cover, knowingly

The lock is a file in `configDir`, so it is per-machine. Two boxes sharing a config directory over
NFS/Syncthing/a dotfiles repo, or a `config.json` copied to a second machine before first run there,
can each provision and end up with two accounts — the second token overwriting the first in whichever
copy syncs last, and the earlier account's history orphaned. This is **out of scope**: torlink has no
other cross-machine coordination and inventing one for this would be the tail wagging the dog. The
mitigation is the one that already exists in this design — claiming. A claimed account has a login,
so a user in that position can point both machines at the same account deliberately. Worth a sentence
in the README where the opt-out is documented, not code.

## 5. Testing

**reccd.** Unit tests for `claimUser` against the real test schema: a fresh public account claims;
an already-claimed account returns 0 rows; a household (`is_public = false`, password-less) account
returns 0 rows — this is the one that guards the `with=` integrity argument in §1.2; a name colliding
with an existing user raises `23505`. Server tests for both routes covering each documented status
code, plus the `/signup/anonymous` rate limit, following the `app.after()` pattern
`server.test.ts` already uses for the `/signup` limit tests. A `/profile` test asserting
`account.claimed` flips after a claim.

**torlink.** A new `src/recc/provision.test.ts` with an injected `fetch` and a temp config dir:
each bail-out condition (token set, `reccUrl` set, env override set, `reccAutoSignup: false`) makes
zero requests; the happy path writes all three fields; a `429` and a network error write nothing;
and — the test that justifies the module existing — **two concurrent `ensureReccAccount` calls
produce exactly one signup request and one token**. `client.test.ts` gains the `ClaimResult` mapping
for every status code. `status.test.ts` covers the `account` field, including a `/profile` response
without it (an older self-hosted reccd), which must degrade to no suffix rather than throwing.
`reccModel.test.ts` covers `reccClaimHint` for all four inputs — unclaimed, claimed, `null`,
`undefined`. `routes.test.ts` covers `/api/sources`' `reccAccount`, including that it is `null` when
no reccd is configured and that **no token appears anywhere in the response body**.

One more torlink test earns its place, because the bug it guards is silent and destructive: after
`ensureReccAccount` provisions with an `onProvisioned` callback, a subsequent whole-config write from
the caller's snapshot must still contain `reccToken`. That is the §2.1 `persistConfig` hazard, and
without a test the only symptom is a user's account vanishing the next time they change the sort.

Two of the bail-out cases deserve named tests rather than a loop, because they are the ones a
refactor would most plausibly get backwards: `reccUrl` set to a self-hosted host with no token makes
**zero** requests, and `reccUrl` set to `https://reccd.stream` with no token makes **one**.

**§0 is tested, not merely asserted.** `provision.test.ts` proves each of these against an injected
`fetch`, because "it fails soft" is the kind of claim that rots the first time someone adds an
`await`:

- `ensureReccAccount` **resolves** — never rejects — for a fetch that throws, one that never settles
  until aborted, a `429`, a `503`, a `200` with a body that is not JSON, a `201` missing `token`, and
  a `saveConfig` that throws.
- A fetch that hangs is abandoned by the timeout rather than hanging the caller, and the config is
  left untouched.
- A `chmod`-ed-unwritable config dir (lock cannot be created) resolves silently. Skipped on Windows.
- The startup call sites are checked by reading them, not mocked: a test asserts the string
  `ensureReccAccount` appears in `App.tsx` and `serve.ts` only in a `void`-prefixed,
  `.catch`-suffixed form. Crude, but it is the one requirement in §0 that a unit test of the module
  itself cannot reach, and `deps-pin.test.ts` sets the precedent for a source-shape assertion.
- `status.test.ts` covers a `/profile` response with no `account` field and one where `account` is a
  string rather than an object — both must yield a status with no suffix and no throw.

No test may contact `reccd.stream`. Fixtures use the invented cast in `CLAUDE.md`; the generated
account names in fixtures use the same word-list shape (`quiet-heron-4f2a`) and name nothing real.

Wiring is verified by running it: `npm run dev -- serve --web` against a local reccd, and a fresh
`config.json` in a throwaway config dir to watch a real first run.

## 6. Docs to update

- torlink `README.md`: the new default behaviour stated plainly — **torlink contacts
  `https://reccd.stream` on first launch and creates an anonymous account** — the opt-out
  (`reccAutoSignup: false`, or setting `TORLINK_RECC_URL`/`reccUrl` to a self-hosted instance), what
  claiming does, and the fact that an unclaimed account cannot be reached from another machine.
- The web UI's own limitations list: check whether "reccd must be configured in the terminal" is
  still true, and whether the claim boundary belongs there.
- `docs/superpowers/specs/2026-07-22-reccd-account-setup-design.md`: a status note at the top
  pointing here, since its "private, self-hosted service" framing is now the secondary path.
- reccd `README.md`: §1.4.

## 7. Deliberate calls worth naming

**torlink now contacts a specific third-party host on first launch by default.** That is a product
decision made knowingly by the repo owner, not an implementation detail that slipped in. The
mitigations are that it happens only when nothing is configured, it is one request, it sends no
information about the user beyond the request itself, it fails silently, and the opt-out is
documented in the README rather than buried. A reviewer who dislikes it should be arguing with §2.1's
bail-out table, which is where the policy lives.

**An anonymous account holds no secret the user can write down.** The token in `config.json` is the
only credential; lose the file and the history is gone. That is the honest cost of zero
configuration, and claiming is the answer to it — which is why claiming ships in this change rather
than after it.
