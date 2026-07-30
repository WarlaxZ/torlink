# Working on torlink

## torlink has two front ends. A feature ships in both.

`src/ui` is the terminal UI (Ink + React). `src/web` is the browser UI (`torlnk serve --web`).
They are **two front ends over the same core**, not a primary and a port. Both read and write
the same `config.json`, so a list edited in one appears in the other.

**Default: any user-facing feature lands in both, in the same change.** A feature that exists
in one place is a bug report waiting to happen — the user opens the other surface, the thing
they saved is missing, and nothing on screen explains why.

If a feature genuinely belongs in one surface only, say so explicitly in the PR body with the
reason. Two reasons that actually qualify:

- **Configuration.** Tokens, sources, limits, folders and DNS are TUI-only on purpose. The web
  is a client of that config. `/api/sources` reports capability flags (`debridConfigured`,
  `omdbConfigured`) so the browser can adapt without offering to change settings.
- **A surface can't express it.** The terminal has no posters; the browser has no keybindings.

"I ran out of time" is not one of them. Half a feature is worse than a filed issue.

### What "both" concretely means

| | Terminal UI | Browser UI |
| --- | --- | --- |
| Where | `src/ui/` | `src/web/` (server) + `src/web/static/` (bundle) |
| A new list/pane | a `Section` + `Sidebar.tsx` nav entry + a component | a nav tab or pane section in `index.html` + wiring in `static/app.ts` |
| A new key | **both** halves of `src/ui/keymap.ts` — `HELP_GROUPS` and `footerHints` | n/a — buttons, not keys |
| A new `Store` field | matching entry in `makeStore` (`scripts/render-previews-impl.tsx`) or `npm run previews` breaks | n/a |
| Reaching data | direct — same process | a route in `src/web/routes.ts` + a type in `src/web/wire.ts` |
| Docs | `README.md` — and check the web UI's own limitations list is still true | same |

### The layering rule, which lint enforces

- **`src/web` must not import from `src/ui`** (`eslint.config.js`). They are siblings. Share by
  moving the shared piece down into `src/util/` or `src/core/`.
- **`src/core` must not import from `src/ui` or `src/web`.** It is the front-end-agnostic middle.
- When a second consumer appears, **move the helper down rather than copying it**. `src/util/resultSort.ts`,
  `resultFilter.ts`, `favouriteList.ts` and `savedSearchList.ts` all started in `src/ui/` and moved
  when the web needed them. This codebase records four bugs caused by copy-then-drift (a byte
  formatter, an uploadSpeed field, a progress unit, an API path table) — that is why.

### Testing the browser UI: there is no jsdom, deliberately

Nothing in `src/web/static/app.ts` is reachable by a unit test. So:

- **Decisions go in pure modules** next to it — `searchModel.ts`, `savedModel.ts`, `resultPosters.ts`,
  `dashboard.ts`, `streamFlow.ts`, `previewModel.ts`. Those get real tests.
- **`app.ts` is DOM wiring only.** If you are writing a conditional in `app.ts` that decides *what to
  show* or *what to send*, it belongs in a pure module. This has been caught in review twice.
- Wiring is verified by actually running it: `npm run dev -- serve --web`.
- `npm run build` is the only check that `src/web/static/` imports no `node:*` — run it.

### Two rules that are load-bearing, not stylistic

- **No `innerHTML` / `insertAdjacentHTML` / `document.write` / `outerHTML` anywhere in `src/web/static/`.**
  Every node is `createElement` + `textContent`. Release names and filenames come from whoever
  uploaded a torrent, so an `innerHTML` path is stored XSS.
- **Config writes from the web are read-modify-write per request**: `loadConfig()` → change → `saveConfig()`.
  Never hold a snapshot between requests. `serializeWrites()` only serializes within one process and
  `serve --web` is a separate process from any running TUI, so writing back a stale whole file would
  silently revert the user's token, sort, or disabled sources.

## Test fixtures name invented films and shows, never real ones

This is a torrent client. Fixtures that name real films read badly whatever the intent, so
**never introduce a real title** into a test, a helper, a doc comment, an example, or
user-facing copy. Reuse this cast rather than inventing more — a shared cast is greppable, and
each of these is verified to parse the way the title it replaced did:

| Title | Shape | Use it for |
| --- | --- | --- |
| `Kestrel.2010.1080p.BluRay.x264` | one-word title + year | a plain film |
| `Ashfall.1999.1080p` | one-word title + year | a second film, when you need two |
| `Tin.Rivers.2024.2160p.WEB-DL.DV.HDR.Atmos.7.1-GROUP` | two-word title, 4K, features | quality/feature ranking |
| `Kepler.S02E04.1080p.WEB-DL` | series, season **and** episode | a single episode |
| `Harrowgate.S03.1080p.WEB-DL` | series, season, **no episode** | a season pack — the edge case that catches "next episode" bugs |

For user-facing copy, prefer naming nothing at all: the web search placeholder says
"a film or show", not an invented title, because an invented one just prompts "what's that?"

### Two traps, both of which have already bitten

If you ever bulk-rename fixtures, the full suite is the only thing that will tell you it worked.

- **Match on word boundaries.** A plain `s/the bear/harrowgate/` also rewrites **"the bearer token"**
  — it corrupted ten files and the auth docs before the suite caught it. Use `perl -pi -e` with `\b`,
  not `sed` with bare strings.
- **`\b` does not save you from URL encoding.** `%20name%20` has no boundary between `0` and `n`
  (both are word characters), and `the+title` matches only its second half — so a test's input and
  its expected string drift apart and the failure looks unrelated. Grep for `%20` and `+`-joined
  forms separately, and for truncated variants (`Big%20Buck.mkv` where the full name is three words).
- **A filter or search test may reference a fixture by SUBSTRING.** `textFilter: "bunny"` against a
  fixture named `Big Buck Bunny` silently stops matching when the fixture is renamed, and the failure
  reads as a filter bug rather than a rename miss.
- **Renaming can make a negative assertion vacuous, and the suite stays green.** `stream.test.ts`
  asserted `expect(body).not.toContain("Big Buck")` to prove a filename from the URL is never
  reflected into the player HTML — a real XSS check. Rename the URL but not the assertion and it
  passes because *nothing* contains the old string any more. After any rename, grep
  `not.toContain` / `not.toBe` for the old names and confirm each still names something the test
  actually puts in play.

## Before you say it's done

`npm test`, `npm run typecheck`, `npm run lint`, `npm run build`. There is one known pre-existing
lint warning (`react-hooks/exhaustive-deps`, `src/ui/App.tsx`) — leave it; it predates this file.

`CONTRIBUTING.md` carries the rest of the house style (fail soft, cross-platform, the calm theme,
Conventional Commits) and is worth reading once.
