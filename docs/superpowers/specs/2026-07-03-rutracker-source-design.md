# RuTracker source for torlink

**Date:** 2026-07-03
**Status:** Approved (design)

## Motivation

The sibling fork [`Danissimo13/torlink-rutracker`](https://github.com/Danissimo13/torlink-rutracker)
adds one substantive feature over the common `baairon/torlink` ancestor:
**RuTracker** as a search source, split into four category pseudo-sources. This
spec ports that feature into our fork (which has diverged with DoH,
Real-Debrid, source health, and a prompt-overlay UI).

RuTracker is unlike every source we currently have: it is **login-gated**. There
is no anonymous access. A user must sign in with their own RuTracker account,
and RuTracker may demand a captcha. This drives most of the design complexity.

## Scope

**In scope**

- RuTracker as four category pseudo-sources: `rt-games`, `rt-movies`, `rt-tv`,
  `rt-anime`, appearing in the existing Games / Movies / TV / Anime groups.
- In-app login flow with cookie-session persistence to disk.
- Captcha fallback surfaced via a clickable terminal hyperlink + copy-link.
- CP1251 (windows-1251) request/response encoding (RuTracker is a Russian site).
- Tests (TDD): parsing, group inference, CP1251 round-trip, cookie/captcha
  parsing, login outcomes.

**Out of scope (YAGNI)**

- Auto-launching an OS browser for the captcha (their `util/open.ts`). We reuse
  our existing `hyperlink()` + clipboard instead.
- RuTracker's non-torrent forums / general browsing.
- Porting their `Sidebar.tsx` / `Sources.tsx` restructuring — our fork already
  has its own `SourcesPrompt` and sidebar.

## Architecture

A self-contained module `src/sources/rutracker/`:

### `session.ts`
Owns authentication and everything CP1251:

- `AuthRequiredError` — thrown when there is no session or the session expired.
- `RUTRACKER_HOSTS` — `rutracker.org`, `.net`, `.nl` (tried in order).
- `decodeCp1251(buf)` and CP1251 form-encoding for the login POST body
  (usernames/passwords may contain Cyrillic; the login submit button value is a
  fixed CP1251 byte sequence).
- Session persistence: `loadSession()`, `getSession()`, `saveSession()`,
  `clearSession()`. Stored to `rutrackerFile` via our atomic-write helpers.
  **Only `bb_*` cookies and the username are persisted — never the password.**
- `login(username, password, { signal, captcha })` returning a `LoginOutcome`:
  - `{ kind: "ok", session }` — cookies captured, session saved.
  - `{ kind: "captcha", captcha }` — RuTracker wants a captcha; carries
    `{ sid, field, imageUrl }`.
  - `{ kind: "failed", message }` — bad credentials / bad captcha.
- `pickCookies(setCookie[])` — keep `bb_*`, require a real `bb_session`
  (reject empty / `deleted`).
- `parseCaptcha(html)` — extract `cap_sid`, the dynamic `cap_code_*` field name,
  and the captcha image URL.

### `index.ts`
Owns search and result parsing:

- Four sources via `makeSource(id, group)`: `rutrackerGames/Movies/Tv/Anime`,
  all labelled "RuTracker".
- A single shared fetch per query (an in-flight cache keyed by query + cookie,
  ~60s TTL) so four active sources cause **one** network sweep, not four. Each
  source then filters the shared results down to its own group.
- Fetch flow: `GET /forum/tracker.php?nm=<query>` on the first reachable host →
  parse rows → take top-N by seeders (cap `MAX_DETAILS = 12`) → for each, fetch
  the topic page and scrape the `magnet:` link. Rows without a magnet/infohash
  are dropped.
- Session-expiry detection: if the search page shows the login form and no
  results table, throw `AuthRequiredError`.
- `buildGroupMap(html)` / `parseRows(html, groupMap)` — infer our
  Games/Movies/TV/Anime group from RuTracker's forum sections and keyword rules
  (Cyrillic-aware). Rows we can't classify are skipped.
- `clearRutrackerCache()` — drop the in-flight cache (called after login).

## Integration points

| File | Change |
|---|---|
| `src/sources/types.ts` | add `rt-games`, `rt-movies`, `rt-tv`, `rt-anime` to `SourceId` |
| `src/sources/registry.ts` | import + register the four sources (they auto-appear in `sourcesByGroup()` and `SourcesPrompt`) |
| `src/config/paths.ts` | add `rutrackerFile` under the data dir |
| `src/sources/cache.ts` | add `clearCacheByPrefix(prefix)` to evict RuTracker entries on login |
| `src/ui/components/RutrackerPrompt.tsx` | **new** login prompt, mirrors `TokenPrompt`'s structure |
| `src/ui/App.tsx` | `editingRutracker` state; render prompt; login handler; input-ownership guard |
| `src/ui/keymap.ts` + `HelpOverlay` | bind **`R`** → "RuTracker login" in the Navigate group |
| search flow (`useConcurrentSearch` consumer) | when a RuTracker source's `perSource` error is an auth error, surface a notice: "Press R to log in to RuTracker" |

## Login UI (`RutrackerPrompt.tsx`)

Follows our existing prompt-overlay convention (own its input while open; `esc`
cancels; rendered like `TokenPrompt`):

1. **Username** and **Password** (masked) fields.
2. On submit → `login()`. While the request is in flight, show a busy state.
3. If the outcome is `captcha`, reveal a **captcha code** field and render the
   captcha image URL as an OSC 8 clickable hyperlink (`hyperlink()`), plus a
   **copy-link** action (`writeClipboard`) for terminals that don't support
   clickable links. User opens it, reads the code, types it, resubmits.
4. On `ok`: save session, `clearRutrackerCache()` + evict the source cache, close
   the prompt, and (if there's an active query) let results refresh.
5. On `failed`: show the message inline and let the user retry.

Trigger paths: the `R` keybind opens it any time; a failed RuTracker search shows
a notice pointing the user at `R`.

## Data flow

```
user presses R ──► RutrackerPrompt ──► session.login()
                                          │
                        ┌─────────────────┼──────────────────┐
                      ok │            captcha │            failed │
                        ▼                     ▼                   ▼
                 saveSession()        show captcha field    show message
                 clear caches         (hyperlink + copy)    (retry)
                 close prompt
                        │
   search ──► rt-* source.search() ──► shared fetchAll() ──► tracker.php
                        │                    │                    │
                 (no session)          per-topic scrape      AuthRequiredError
                        ▼                    ▼                on expiry ──► notice "press R"
               AuthRequiredError        magnet links
```

## Security / privacy

- The password is never written to disk; only `bb_*` session cookies + username.
- Credentials go only to `rutracker.*` over HTTPS.
- Cookie file is written with our existing atomic-write path (same treatment as
  the Real-Debrid token and other state).

## Testing (TDD — tests first)

- `parse.test.ts` — `parseRows` and `buildGroupMap` against fixture HTML
  (seeders/size/added extraction, group inference, unclassifiable rows dropped).
- `session.test.ts` — CP1251 encode/decode round-trip, `pickCookies`
  (accept/reject cases), `parseCaptcha`, and `login()` outcomes with `fetch`
  mocked (ok / captcha / failed / host-failover).
- Then: `npm run typecheck`, lint, and full `npm test` (vitest run).

## Open decisions (revisitable)

- **Captcha UX** was chosen as clickable-link + copy while the user was AFK.
  Auto-browser-launch remains an easy follow-up if desired.
