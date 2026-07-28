# Web launch UX: a reachable link, a minted token, and a browser

**Date:** 2026-07-28
**Status:** approved, ready to plan

## Problem

`torlnk serve --web --host 0.0.0.0 --token a` starts a working server and then
tells the user something unusable:

```
[torlnk serve] web ui on http://0.0.0.0:9161 (token required)
[torlnk serve] listening on http://0.0.0.0:9161  (api + web ui, ...)
```

The server is fine — `GET /` answers 200 with the dashboard, the assets load,
and the token unlocks it. What is broken is the address. Both log lines
interpolate the *bind* host (`src/web/server.ts:527`, `src/daemon/serve.ts:325`),
and `0.0.0.0` is not an address a browser can visit: it resolves to loopback on
Linux by accident of the resolver, and fails outright from Windows, a phone, or
any other machine. The user is handed a URL, pastes it, gets nothing, and
concludes the web UI did not start.

Three further frictions sit on top of the same launch:

1. **Exposing the UI requires inventing a secret.** `serve` refuses a
   non-loopback bind without a token (`src/daemon/serve.ts:288`). The refusal is
   correct — never fail open — but it means the shortest path to a dashboard on
   the LAN is a detour through `openssl rand -hex 16`.
2. **The token must then be typed into the browser.** The client only reads it
   from `sessionStorage` or the unlock form (`src/web/static/app.ts:91`), so
   there is no way to hand a browser a working URL.
3. **Nothing opens.** `src/util/openUrl.ts` already exists and is already used
   for IMDb links from the TUI, but no launch path calls it.

## Decision

`serve --web` should end with a dashboard on screen, not with an address to
decipher. Four changes, each narrow:

- Print URLs a browser can actually visit.
- Mint a token when — and only when — exposing the UI would otherwise be refused.
- Carry that token in the link's fragment, and let the client adopt it.
- Open the link, unless the user said `--headless` or nothing is watching.

### Deliberately unchanged

- **Loopback stays tokenless.** With `--web` there is one server, so a token
  also gates `/add`, `/downloads` and `/control`. Minting on loopback would turn
  a working `curl 127.0.0.1:9161/add` into a 401 for every existing script.
  CSRF on the tokenless path is already handled by the Origin / Sec-Fetch-Site
  checks in `src/daemon/auth.ts`.
- **`serve --host 0.0.0.0` without `--web` still hard-errors.** Minting is
  justified by having a link to hand back. A bare API consumer needs a token it
  chose, stable across restarts — a fresh secret per boot would be worse than
  the error it replaced.
- **The TUI never auto-opens.** The user chose a terminal UI; stealing focus is
  not a favour. It gets a keypress instead.

## Design

### 1. `src/web/links.ts` — one place that knows a browsable URL

Two pure functions:

```ts
displayHosts(bindHost: string, interfaces: NetworkInterfaces): { local: string; lan: string[] }
webUrl(host: string, port: number, token?: string): string
```

`displayHosts` maps a wildcard bind (`0.0.0.0`, `::`, `*`, empty) to
`local: "127.0.0.1"` plus `lan:` — every non-internal IPv4 the host owns. Any
other bind maps to itself with an empty `lan`, and an IPv6 literal comes back
bracketed (`[::1]`) so it can be concatenated into a URL.

`webUrl` builds `http://host:port`, appending `/#k=<token>` when a token is
given.

The interface list is a parameter, not an `os.networkInterfaces()` call inside,
so the whole module unit-tests without depending on the machine's NICs.

`src/daemon/serve.ts`, `src/web/server.ts` and the TUI splash all route their
address strings through this module. The `0.0.0.0` lie is fixed once.

Startup output becomes:

```
$ torlnk serve --web
  ui  http://127.0.0.1:9161      (no token, loopback only)

$ torlnk serve --web --host 0.0.0.0
  ui  http://127.0.0.1:9161/#k=8f3c…      (this machine)
      http://192.168.1.24:9161/#k=8f3c…   (from your LAN)
  token 8f3c…  (pass --token to pin it across restarts)
```

The token also appears on its own line, unfragmented, so a script can scrape it
out of the log.

### 2. Minted token

In `runServe`: when `options.web` is set, no token was supplied (neither
`--token` nor `TORLINK_API_TOKEN`), and the host is not in `LOOPBACK_HOSTS`,
generate one with `randomBytes(16).toString("hex")` and use it exactly as a
supplied token — same auth path, same `token required` semantics.

The existing refusal at `serve.ts:288` narrows to the no-`--web` case. Its
message is unchanged for that path.

### 3. The token rides in the fragment

The link uses `#k=<token>`, not `?token=<token>`. A fragment is never sent to
the server, so the secret stays out of the access log and out of any `Referer` a
click generates. `k` matches the existing `?k=` that `searchUrl`
(`src/web/static/searchModel.ts:241`) already uses for EventSource, which cannot
set headers.

On boot, `app.ts`:

1. Reads `location.hash` for `k=<token>`.
2. Stores it under the existing `TOKEN_KEY` in `sessionStorage`.
3. Strips it with `history.replaceState(null, "", location.pathname + location.search)`.
4. Continues as if the unlock form had been submitted.

A stale or wrong token takes the existing 401 path back to the unlock form with
its error. Because step 3 already ran, a reload does not retry the bad token —
the user gets the form, not a loop.

### 4. Opening the browser

After the listener is up and the URLs are logged, `runServe` calls
`openUrl(localUrl)` — the loopback URL with the fragment, never the LAN one.
Suppressed when any of:

- `--headless` was passed,
- `--daemon` was passed (the parent has exited; the detached child has no user),
- `process.stdout.isTTY` is false (systemd, a pipe, CI).

The opener is injected into `runServe` the way `startWebServerImpl` is already
injected into `App`, so tests assert on the call instead of spawning a browser.
`openUrl` never throws and returns `false` on failure; a `false` logs one line
naming the link and nothing else. A missing `xdg-open` must never fail a boot.

### 5. `--headless`

Added to `serve`'s flag spec only. The strict per-command scanner from the
previous change already turns `--headless` on the TUI, `watch` or `files` into a
startup error, so no extra work is needed there.

Passed without `--web` it is an error — `--headless does nothing without --web` —
rather than a warning. `serve`'s scanner is strict by design; the TUI's softer
orphan-flag warning (`App.tsx:535`) exists because a TUI cannot exit with a
message the user would see.

**Vocabulary cleanup, required by this flag:** the codebase currently uses
"headless" to mean "no terminal UI" — `src/daemon/serve.ts:1` ("Headless HTTP
add API") and `src/index.tsx:43` ("Headless subcommands"). Left alone,
`serve --headless` reads as a no-op. Those comments, and any `--help` or README
wording that does the same, change to "no terminal UI" / "for servers", so
`--headless` has exactly one meaning: do not open a browser.

### 6. TUI: `W`

`W` opens `webStatus.url` via `openUrl`. That URL now comes from `links.ts`, so
it is reachable and carries `#k=` when a token is set.

Live only when the web server started (`webStatus` holds a `url`, not
`failed`). `w` is unavailable — `ForYou.tsx:105`, `Results.tsx:396` and
`RatePrompt.tsx:27` all use it for watched/watchlist. `W` is free in the global
keymap and in every component. Added to the `?` help list.

## Testing

Fake timers throughout; no real waits.

**`links.ts`** — wildcard IPv4, wildcard IPv6, explicit host passes through,
IPv6 literal gets bracketed, no non-internal interfaces yields an empty `lan`,
`webUrl` with and without a token.

**`args.ts`** — `serve --web --headless` parses; `serve --headless` alone errors
with the naming hint; `--headless` on the TUI, `watch` and `files` errors.

**`serve`** — non-loopback + `--web` mints (401 without the token, 200 with it);
loopback + `--web` does not mint; a supplied `--token` is never overridden;
non-loopback without `--web` still refuses.

**Injected opener** — called with the loopback URL including the fragment; not
called under `--headless`; not called when `isTTY` is false; not called under
`--daemon`; a `false` return logs and does not fail startup.

**Client** — a `#k=` hash is adopted into `sessionStorage`, the hash is
stripped, and the app unlocks without the form; a rejected token falls back to
the form and leaves no hash behind.

**TUI** — `W` calls `openUrl` with the splash URL; `W` does nothing when the
server failed to start.

## Out of scope

WSL2 NAT reachability. On WSL2 without mirrored networking, the LAN address this
change now prints truthfully (e.g. `172.25.6.62`) is still unreachable from
other machines without a `netsh interface portproxy` rule and a firewall opening
on the Windows host. Printing the real interface address is honest and is as far
as this change goes; detecting WSL and emitting a hint was considered and left
out.
