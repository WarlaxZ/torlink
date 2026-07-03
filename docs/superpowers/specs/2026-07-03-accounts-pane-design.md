# Accounts pane

**Date:** 2026-07-03
**Status:** Approved (design)
**Builds on:** the RuTracker source feature (same branch `feat/rutracker-source`).

## Motivation

Credential-backed services (Real-Debrid, RuTracker) are currently reached by
per-service hotkeys (`k`, `R`) that pop an overlay. That doesn't scale, isn't
discoverable, and gives no at-rest view of what you're signed into. This adds a
single **Accounts** pane: one findable home for signing in/out and seeing status,
with room to grow as more auth-backed services are added. The `k` and `R`
hotkeys are removed in favour of the pane.

## Scope

**In scope**

- A new **Accounts** section in the sidebar's Library group (under Downloads /
  Seeding), rendering an accounts list view.
- Rows for **Real-Debrid** and **RuTracker**, each showing sign-in status.
- Per-row actions: `↵` sign in / edit / switch, `x` sign out, `↑`/`↓` move.
- Credential entry reuses the **existing** overlay prompts (`TokenPrompt`,
  `RutrackerPrompt`) — no new entry UI.
- Removal of the `k` and `R` hotkeys and their help hints; Splash CTA + tip
  repointed to the Accounts pane.
- A real RuTracker **sign-out** (wires up `clearSession`, which the RuTracker
  feature imported but never called).

**Out of scope (YAGNI)**

- The existing `S` / `Shift+S` source on/off toggle (`SourcesPrompt`) — a
  different concept (which sources to *search*), left untouched.
- Any new auth service beyond Real-Debrid + RuTracker.
- Config-file/schema changes.
- Inline credential fields in the pane (we reuse the overlays instead).

## Architecture

The content pane already renders `Results` / `Downloads` / `Seeding` as
always-mounted boxes toggled by `display: section === X ? "flex" : "none"`
(`App.tsx`). Accounts follows the same pattern.

### New: `src/ui/components/Accounts.tsx`
A presentational + input-owning list, matching the sibling views' conventions:

- Props (all already live in `App`, passed down — no new store state):
  ```ts
  interface AccountsProps {
    rdToken: string;              // store.config.realDebridToken ?? ""
    rdStatus: RdStatus | null;
    rutrackerUser?: string;
    onManageRd: () => void;       // = openTokenPrompt
    onSignOutRd: () => void;      // = clearRealDebridToken
    onManageRutracker: () => void;// = openRutrackerPrompt
    onSignOutRutracker: () => void;
  }
  ```
- Reads `region` from the store; `focused = region === "content" && section === "accounts"`.
- `useInput(..., { isActive: focused })`: `↑`/`↓` move the cursor (via `wrapStep`),
  `↵` calls the focused row's manage action, `x` calls its sign-out action (only
  when signed in).
- Renders one row per service: tag (`SOURCE_STYLE`-style colour), name, a status
  line (`✓ connected as … / premium until …` for RD via
  `formatAccountStatus`; `✓ Signed in as <user>` / `· Not signed in` for
  RuTracker), and a right-aligned key hint (`↵ sign in` or `↵ switch · x sign out`).
- The service list is a local array of `{ id, label, signedIn, statusLine,
  onManage, onSignOut }`, so adding a service later is one entry.

### Changes to existing files

| File | Change |
|---|---|
| `src/ui/store.ts` | add `"accounts"` to the `Section` union; add an `openAccounts()` action to the store interface + provider value |
| `src/ui/components/Sidebar.tsx` | add `{ key: "accounts", label: "Accounts" }` to the `LIBRARY` nav group |
| `src/ui/App.tsx` | define `openAccounts()` (setView "browser", setSection "accounts", setRegion "content", setShowHelp false) and inject into store; define `signOutRutracker()` (`clearSession()` + `setRutrackerUser(undefined)` + `clearRutrackerCache()` + `clearCacheByPrefix("rt-")` + notice); render `<Accounts .../>` with `display: section === "accounts" ? "flex" : "none"`; **remove** the `input === "k"` and `input === "R"` branches from the global `useInput` |
| `src/ui/keymap.ts` | remove the `k` and `R` hints from `HELP_GROUPS`; add an "Accounts" help group / footer hints (`↵ sign in`, `x sign out`) for `section === "accounts"` |
| `src/ui/views/Splash.tsx` | repoint the CTA from `openTokenPrompt` to `openAccounts`; change the "press k to connect Real-Debrid" tip to point at the Accounts tab |

`openTokenPrompt`, `openRutrackerPrompt`, `clearRealDebridToken` stay as-is and
are passed into `Accounts` as the manage/sign-out callbacks. The overlay prompts
(`TokenPrompt`, `RutrackerPrompt`) are unchanged and still own input when open;
existing `editingToken`/`editingRutracker` guards already cover that.

## Data flow

```
Sidebar "Accounts" selected ──► section="accounts" ──► <Accounts> visible + input-active
        │
   ↵ on Real-Debrid ──► onManageRd() = openTokenPrompt() ──► TokenPrompt overlay
   x on Real-Debrid ──► onSignOutRd() = clearRealDebridToken()
   ↵ on RuTracker  ──► onManageRutracker() = openRutrackerPrompt() ──► RutrackerPrompt overlay
   x on RuTracker  ──► onSignOutRutracker() = clearSession()+clear user+caches

Splash CTA / tip ──► openAccounts() ──► (browser view, Accounts pane, content focus)
```

## Error handling / edge cases

- Sign-out when a service isn't signed in: the `x` action is a no-op / hidden for
  not-signed-in rows.
- Real-Debrid token set via `REALDEBRID_API_TOKEN` env: `clearRealDebridToken`
  already refuses and notices the user — unchanged.
- Opening an overlay from the pane returns focus to the pane on close (existing
  prompt-close behaviour leaves `section`/`region` as they were).
- Removing `k`/`R` must not leave dangling references: sweep `keymap.ts`,
  `Splash.tsx`, `HELP_GROUPS`, and footer hints.

## Testing

- `Accounts.test.tsx` (ink-testing-library): renders both service rows; shows
  "Not signed in" / "Not connected" when logged out, and "Signed in as <user>"
  / connected status when the props say so.
- `keymap` test: `section === "accounts"` footer hints include sign-in/sign-out;
  the `k`/`R` hints are gone from `HELP_GROUPS`.
- Sign-out logic: `signOutRutracker` clears the session file + evicts the `rt-`
  cache (unit-level where practical; otherwise asserted via the wired calls).
- Regression: full `npm test`, `npm run typecheck`, `npm run build` stay green.

## Notes

Removing the hotkeys resolves the Task-6 note that `clearSession` had no call
site — the Accounts sign-out is that call site.
