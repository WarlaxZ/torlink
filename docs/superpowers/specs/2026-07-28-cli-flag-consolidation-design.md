# CLI flag consolidation

**Date:** 2026-07-28
**Status:** approved, ready to plan

## Problem

The CLI has grown four names for concepts that only need one, and one name that
means two different things. The overlap is not cosmetic: it produced a real
failure where `torlnk serve --web --web-host 0.0.0.0 --token a` bound loopback
and said nothing, because `serve` never reads `--web-host` and `readFlags`
silently eats any unrecognised `--flag value` pair.

Current surface:

| Command | Flags |
|---|---|
| bare TUI (`run`) | `--web`, `--web-port`, `--web-host`, `--web-token`, `--token` |
| `watch <dir>` | `--to` / `--dir`, `--seed-time`, `--delete-files`, `--daemon` |
| `serve` | `--port`, `--host`, `--token`, `--to` / `--dir`, `--seed-time`, `--delete-files`, `--daemon`, `--web`, `--web-port` |
| `files` | `--port`, `--host`, `--token`, `--dir`, `--daemon` |

The specific collisions:

1. `--host` vs `--web-host` — two names for one concept. `--web-host` works on
   the TUI only and is silently ignored under `serve`.
2. `--token` vs `--web-token` — pure alias with a precedence rule
   (`--web-token` beats `--token`) that needs a README table to explain.
3. `--to` vs `--dir` — synonyms on `watch`/`serve` (a *destination*), but on
   `files` `--dir` is the *source* folder. One word, two opposite meanings.
4. `--port` vs `--web-port` — defensible today (two listeners cannot share a
   port), but it establishes `--web-*` as a general prefix, which is what makes
   1 and 2 read as plausible.
5. Unknown flags are silently swallowed on `watch`/`serve`/`files`. The bare TUI
   correctly rejects them. This is the root cause of failure 1 being silent.

## Decision

A hard break to one canonical name per concept. No deprecation aliases: removed
spellings become startup errors with a targeted hint. Flags are the cheap thing
to break — a wrong flag fails loudly at start, once, and you fix your systemd
unit.

### Target flag surface

| Flag | Meaning | Valid on |
|---|---|---|
| `--host <addr>` | the interface this process binds | run, serve, files |
| `--port <n>` | the port it binds — API, UI, or both | run, serve, files |
| `--token <secret>` | auth for whatever this process exposes | run, serve, files |
| `--to <dir>` | where downloads land | watch, serve |
| `--web` | also mount the browser UI on this process's port | run, serve |
| `--seed-time <dur>`, `--delete-files`, `--daemon` | unchanged | as today |

Removed: `--web-host`, `--web-port`, `--web-token`, `--dir`.

Defaults stay per-command so a TUI and a daemon on one box do not collide:
`serve` 9161, `files` 9160, TUI `--web` 9162.

### One port per process

`serve --web` stops starting a second listener. The web server already routes
the entire daemon API — `src/web/routes.ts:1105` delegates every non-`/api/`
path to `handleApi`, explicitly so the two cannot drift — so under `--web` the
web server binds `--port` and is the only server. Without `--web`, `serve` runs
its bare API server exactly as today.

The two path namespaces are already disjoint, so no path remapping is needed:

- daemon API: `/health`, `/status`, `/downloads`, `/add`, `/control`
- web UI: `/api/*`, `/stream/*`, `/play/*`, static assets at `/`

### Source vs destination

`--dir` is deleted. A bare directory argument always means "the folder this
command operates on"; `--to` always means "where output goes".

```
torlnk watch ~/inbox --to ~/movies     # source positional, destination flagged
torlnk serve --to ~/movies             # destination flagged
torlnk files ~/movies                  # source positional
```

`files` therefore takes its folder positionally and optionally, defaulting to
the configured downloads folder as `--dir` does today.

### Unknown flags are errors

`watch`, `serve` and `files` reject any flag they do not define, matching the
bare TUI. Removed flags get a specific hint rather than a generic message:

```
error: --web-host is not a flag; the web ui binds --host
error: --web-port is not a flag; the web ui binds --port
error: --web-token is not a flag; use --token
error: --dir is not a flag; use --to (or pass the folder positionally to `files`)
```

## Explicitly not changing

- **URL paths.** A moved URL fails silently inside someone's script; a wrong
  flag fails loudly at startup. `/add` and `/api/add` coexisting is mild
  redundancy, not a real cost.
- **`TORLINK_API_TOKEN` / `TORLINK_FILES_TOKEN`.** Two env names for two
  separately-exposed daemons is a deliberate split, not an accidental alias.

## Accepted costs

- `serve --web` moves the UI from `:9162` to `:9161`. Bookmarks and reverse
  proxy config break once, visibly.
- Losing `--web-port` means the JSON API can no longer be firewalled separately
  from the UI. `src/daemon/serve.ts:319` calls that separation intentional; we
  are judging it over-engineered for a single-user daemon and dropping it
  knowingly.

## Affected code

- `src/cli/args.ts` — `CliCommand` shapes, `parseRun`, the `serve`/`watch`/
  `files` branches, `readFlags` strictness, `HELP_TEXT`.
- `src/index.tsx` — `serve`/`files` option construction, the `App` props for the
  TUI web mount, the `TORLINK_API_TOKEN` fallback comment.
- `src/ui/App.tsx` — `webHost`/`webPort`/`webToken` props become `host`/`port`/
  `token`; the orphan-flag warning list.
- `src/daemon/serve.ts` — single-listener path under `--web`; startup log.
- `src/daemon/files.ts` — folder from the positional argument.
- `README.md` — the flag tables, the token-precedence table (deletable), the
  `--web-host` example.
- Tests: `src/cli/args.test.ts`, `src/ui/App.web.test.tsx`, `src/web/server.test.ts`,
  `src/daemon/serve.test.ts`.

## Success criteria

- `torlnk serve --web --host 0.0.0.0 --token a` serves the API and the UI on
  `0.0.0.0:9161`, and logs one listening line.
- `torlnk serve --web --web-host 0.0.0.0` exits non-zero with the hint above.
- `torlnk files ~/movies` serves that folder; `torlnk files` serves the
  downloads folder.
- No non-loopback bind is possible without a token, on any command.
- `--help` and `README.md` describe exactly the flags that exist, and the token
  precedence table is gone because precedence no longer exists.
