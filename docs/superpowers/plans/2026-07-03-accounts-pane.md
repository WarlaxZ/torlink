# Accounts Pane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "Accounts" sidebar pane that lists credential-backed services (Real-Debrid, RuTracker) with sign-in status and sign-in/out actions, and remove the `k`/`R` hotkeys in favour of it.

**Architecture:** A new `"accounts"` section renders an always-mounted `<Accounts>` content view (toggled by `display`, like Results/Downloads/Seeding). The pane is presentational + input-owning, fed status values and callbacks from App (where they already live). Credential entry reuses the existing `TokenPrompt`/`RutrackerPrompt` overlays; the pane just launches them and offers sign-out.

**Tech Stack:** TypeScript, React + Ink 7, vitest, ink-testing-library.

## Global Constraints

- Node >= 22, ESM (`"type": "module"`); relative imports omit file extensions.
- Reuse existing overlay prompts for credential entry — do NOT build inline entry fields.
- The section key string is exactly `"accounts"`; the sidebar label is exactly `"Accounts"`.
- Do NOT touch the `S`/`Shift+S` source on/off toggle (`SourcesPrompt`) — different concept.
- RuTracker sign-out must call `clearSession()` (from `src/sources/rutracker/session`) — this is the call site that was missing.
- Run `npm run typecheck` and `npm test` before each commit; keep the tree green (baseline: 239 tests passing). UI-wiring tasks also run `npm run build`.
- Commit messages end with the `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` trailer.

---

### Task 1: Section + store action (wired end-to-end) + sidebar entry

Adds the `"accounts"` section, the `openAccounts` store action **declared AND implemented/supplied by App**, and the sidebar nav entry. Doing the App wiring here keeps typecheck green after every task. Selecting Accounts shows a blank content pane until Task 4 adds the render — harmless.

**Files:**
- Modify: `src/ui/store.ts` (Section union + `openAccounts` on the `Store` interface)
- Modify: `src/ui/App.tsx` (define `openAccounts`, add to the store value object + deps)
- Modify: `src/ui/components/Sidebar.tsx` (LIBRARY nav entry)
- Test: `src/ui/components/Sidebar.test.tsx` (create if absent)

**Interfaces:**
- Produces: `Section` includes `"accounts"`; `Store.openAccounts: () => void` (a working callback that navigates to the Accounts pane).

- [ ] **Step 1: Write the failing test**

Create `src/ui/components/Sidebar.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { StoreContext, type Store } from "../store";
import { Sidebar } from "./Sidebar";
import { DownloadQueue } from "../../download/queue";

function baseStore(): Store {
  // Minimal store stub — only the fields Sidebar reads.
  return {
    section: "all",
    setSection: () => {},
    region: "sidebar",
    setRegion: () => {},
    queue: { activeCount: 0, seedingCount: 0 } as unknown as DownloadQueue,
  } as unknown as Store;
}

describe("Sidebar", () => {
  it("lists an Accounts entry in the library group", () => {
    const { lastFrame } = render(
      <StoreContext.Provider value={baseStore()}>
        <Sidebar />
      </StoreContext.Provider>,
    );
    expect(lastFrame() ?? "").toContain("Accounts");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/ui/components/Sidebar.test.tsx`
Expected: FAIL — frame does not contain "Accounts".

- [ ] **Step 3: Add the section value**

In `src/ui/store.ts`, change the `Section` type (currently `export type Section = Category | "downloads" | "seeding";`) to:

```typescript
export type Section = Category | "downloads" | "seeding" | "accounts";
```

- [ ] **Step 4: Declare the store action**

In `src/ui/store.ts`, in the `Store` interface, right after the `openTokenPrompt: () => void;` line, add:

```typescript
  // Jump to the browser view, select the Accounts pane, and focus it.
  openAccounts: () => void;
```

- [ ] **Step 5: Add the sidebar nav entry**

In `src/ui/components/Sidebar.tsx`, extend the `LIBRARY` array:

```typescript
const LIBRARY: NavItem[] = [
  { key: "downloads", label: "Downloads" },
  { key: "seeding", label: "Seeding" },
  { key: "accounts", label: "Accounts" },
];
```

- [ ] **Step 6: Define and supply `openAccounts` in App**

In `src/ui/App.tsx`, near the other prompt `useCallback` handlers, add:

```typescript
const openAccounts = useCallback(() => {
  setView("browser");
  setShowHelp(false);
  setSection("accounts");
  setRegion("content");
}, []);
```

Use the raw `setSection` (the `useState` setter, in scope alongside `section`), NOT `changeSection` — `changeSection` persists the last *category*, and Accounts isn't a category.

Then in the `store` `useMemo` value object, add `openAccounts,` right after the `openTokenPrompt,` entry, and add `openAccounts` to that `useMemo`'s dependency array.

- [ ] **Step 7: Run tests + typecheck to verify green**

Run: `npx vitest run src/ui/components/Sidebar.test.tsx && npm run typecheck`
Expected: Sidebar test PASS; typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add src/ui/store.ts src/ui/App.tsx src/ui/components/Sidebar.tsx src/ui/components/Sidebar.test.tsx
git commit -m "feat(accounts): add accounts section, openAccounts store action, sidebar entry

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Accounts component

The list view. Pure/presentational + its own input handling; takes all data + callbacks as props, so it is fully testable in isolation.

**Files:**
- Create: `src/ui/components/Accounts.tsx`
- Test: `src/ui/components/Accounts.test.tsx`

**Interfaces:**
- Consumes: `useStore` (reads `region`, `section`); `Panel`; `wrapStep` from `../move`; `COLOR`, `GUTTER`, `ICON` from `../theme`; `truncate` from `../../util/format`; `formatAccountStatus`, `RdStatus` from `../../integrations/rdStatus`.
- Produces:
  ```ts
  interface AccountsProps {
    rdToken: string;
    rdStatus: RdStatus | null;
    rutrackerUser?: string;
    onManageRd: () => void;
    onSignOutRd: () => void;
    onManageRutracker: () => void;
    onSignOutRutracker: () => void;
  }
  export function Accounts(props: AccountsProps): JSX.Element
  ```

- [ ] **Step 1: Write the failing test**

Create `src/ui/components/Accounts.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { StoreContext, type Store } from "../store";
import { Accounts } from "./Accounts";

function storeStub(): Store {
  return { region: "content", section: "accounts" } as unknown as Store;
}

const noop = () => {};
const baseProps = {
  rdToken: "",
  rdStatus: null,
  rutrackerUser: undefined,
  onManageRd: noop,
  onSignOutRd: noop,
  onManageRutracker: noop,
  onSignOutRutracker: noop,
};

function renderAccounts(overrides: Partial<typeof baseProps> = {}) {
  return render(
    <StoreContext.Provider value={storeStub()}>
      <Accounts {...baseProps} {...overrides} />
    </StoreContext.Provider>,
  );
}

describe("Accounts", () => {
  it("lists Real-Debrid and RuTracker", () => {
    const frame = renderAccounts().lastFrame() ?? "";
    expect(frame).toContain("Real-Debrid");
    expect(frame).toContain("RuTracker");
  });

  it("shows signed-out state when no credentials", () => {
    expect(renderAccounts().lastFrame() ?? "").toContain("Not signed in");
  });

  it("shows the RuTracker username when signed in", () => {
    const frame = renderAccounts({ rutrackerUser: "alice" }).lastFrame() ?? "";
    expect(frame).toContain("alice");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/ui/components/Accounts.test.tsx`
Expected: FAIL — cannot resolve `./Accounts`.

- [ ] **Step 3: Implement the component**

Create `src/ui/components/Accounts.tsx`:

```tsx
import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { useStore } from "../store";
import { Panel } from "./Panel";
import { wrapStep } from "../move";
import { COLOR, GUTTER, ICON } from "../theme";
import { truncate } from "../../util/format";
import { formatAccountStatus, type RdStatus } from "../../integrations/rdStatus";

interface AccountsProps {
  rdToken: string;
  rdStatus: RdStatus | null;
  rutrackerUser?: string;
  onManageRd: () => void;
  onSignOutRd: () => void;
  onManageRutracker: () => void;
  onSignOutRutracker: () => void;
}

interface Row {
  tag: string;
  color: string;
  label: string;
  homepage: string;
  signedIn: boolean;
  status: string;
  onManage: () => void;
  onSignOut: () => void;
}

export function Accounts({
  rdToken,
  rdStatus,
  rutrackerUser,
  onManageRd,
  onSignOutRd,
  onManageRutracker,
  onSignOutRutracker,
}: AccountsProps) {
  const { region, section, contentWidth, listRows } = useStore();
  const focused = region === "content" && section === "accounts";
  const [cursor, setCursor] = useState(0);

  const rows: Row[] = [
    {
      tag: "RD",
      color: COLOR.good,
      label: "Real-Debrid",
      homepage: "real-debrid.com",
      signedIn: rdToken !== "",
      status: formatAccountStatus(rdStatus, new Date()),
      onManage: onManageRd,
      onSignOut: onSignOutRd,
    },
    {
      tag: "RUT",
      color: "#8fce5a",
      label: "RuTracker",
      homepage: "rutracker.org",
      signedIn: !!rutrackerUser,
      status: rutrackerUser ? `Signed in as ${truncate(rutrackerUser, 24)}` : "Not signed in",
      onManage: onManageRutracker,
      onSignOut: onSignOutRutracker,
    },
  ];

  const clamped = Math.min(cursor, rows.length - 1);

  useInput(
    (input, key) => {
      if (key.upArrow) setCursor(wrapStep(clamped, -1, rows.length));
      else if (key.downArrow) setCursor(wrapStep(clamped, 1, rows.length));
      else if (key.return) rows[clamped]!.onManage();
      else if (input === "x" && rows[clamped]!.signedIn) rows[clamped]!.onSignOut();
    },
    { isActive: focused },
  );

  const panelH = Math.max(5, listRows - 1);

  return (
    <Panel title="accounts" width={contentWidth} focused={focused} height={panelH}>
      <Box>
        <Text dimColor>Sign in to services that need an account to search or stream.</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {rows.map((r, i) => {
          const here = i === clamped && focused;
          return (
            <Box key={r.label} marginTop={i > 0 ? 1 : 0}>
              <Box width={GUTTER} flexShrink={0}>
                <Text color={COLOR.accent} bold>{here ? ICON.pointer : ""}</Text>
              </Box>
              <Box width={5} flexShrink={0}>
                <Text color={r.color} bold={here}>{r.tag}</Text>
              </Box>
              <Box flexGrow={1} minWidth={0} marginLeft={1} flexDirection="column">
                <Text bold={here} color={here ? COLOR.accent : undefined} dimColor={!here}>
                  {r.label}
                  <Text dimColor>{`  ${ICON.dot} ${r.homepage}`}</Text>
                </Text>
                {r.signedIn ? (
                  <Text>
                    <Text color={COLOR.good}>{`${ICON.done} `}</Text>
                    <Text dimColor>{r.status}</Text>
                  </Text>
                ) : (
                  <Text dimColor>{`${ICON.dot} ${r.label === "Real-Debrid" ? "Not connected" : "Not signed in"}`}</Text>
                )}
              </Box>
              <Box flexShrink={0} marginLeft={1}>
                {r.signedIn ? (
                  <Text>
                    <Text color={COLOR.alt}>↵</Text>
                    <Text dimColor> switch</Text>
                    <Text dimColor>{`  ${ICON.dot}  `}</Text>
                    <Text color={COLOR.alt}>x</Text>
                    <Text dimColor> sign out</Text>
                  </Text>
                ) : (
                  <Text>
                    <Text color={COLOR.alt}>↵</Text>
                    <Text dimColor> sign in</Text>
                  </Text>
                )}
              </Box>
            </Box>
          );
        })}
      </Box>
    </Panel>
  );
}
```

Note: the test's `storeStub` doesn't provide `contentWidth`/`listRows`; Ink tolerates `undefined` width/height (renders unconstrained), so the render tests still pass. Do not add those to the stub.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/ui/components/Accounts.test.tsx && npm run typecheck`
Expected: PASS (3 tests); typecheck clean (the component compiles standalone; it isn't rendered by App until Task 4).

- [ ] **Step 5: Commit**

```bash
git add src/ui/components/Accounts.tsx src/ui/components/Accounts.test.tsx
git commit -m "feat(accounts): accounts list component with per-service status

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Keymap — drop k/R hints, add Accounts hints

Update help + footer hints: remove the removed hotkeys, add the pane's hints.

**Files:**
- Modify: `src/ui/keymap.ts`
- Test: `src/ui/keymap.test.ts`

**Interfaces:**
- Consumes: existing `HELP_GROUPS`, `footerHints(region, section, downloadFocus?, seedFocus?, debridConfigured?)`.

- [ ] **Step 1: Add failing tests**

In `src/ui/keymap.test.ts`, add (adapt imports to the file's existing style — it already imports `footerHints` and/or `HELP_GROUPS`):

```typescript
import { footerHints, HELP_GROUPS } from "./keymap";

describe("accounts keymap", () => {
  it("shows sign-in/out hints on the accounts section", () => {
    const keys = footerHints("content", "accounts").map((h) => h.keys);
    expect(keys).toContain("↵");
    expect(keys).toContain("x");
  });

  it("no longer advertises the k or R credential hotkeys", () => {
    const allKeys = HELP_GROUPS.flatMap((g) => g.hints.map((h) => h.keys));
    expect(allKeys).not.toContain("k");
    expect(allKeys).not.toContain("R");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/ui/keymap.test.ts`
Expected: FAIL (k/R still present; accounts branch missing).

- [ ] **Step 3: Remove the k and R hints**

In `src/ui/keymap.ts`, in the `HELP_GROUPS` "Navigate" hints array, delete these two lines:

```typescript
      { keys: "k", label: "Real-Debrid token" },
```
```typescript
      { keys: "R", label: "RuTracker login" },
```

- [ ] **Step 4: Add an Accounts help group**

In `src/ui/keymap.ts`, add a new group to the `HELP_GROUPS` array (after the "Navigate" group):

```typescript
  {
    title: "Accounts",
    hints: [
      { keys: "↑ ↓", label: "Move between services" },
      { keys: "↵", label: "Sign in / switch account" },
      { keys: "x", label: "Sign out" },
    ],
  },
```

- [ ] **Step 5: Add the accounts footer branch**

In `src/ui/keymap.ts`, inside `footerHints`, add this branch before the final `return` (the results-view default), alongside the existing `if (section === "seeding")` / `if (section === "downloads")` branches:

```typescript
  if (section === "accounts") {
    return [
      NAVIGATE,
      { keys: "↵", label: "Sign in" },
      { keys: "x", label: "Sign out" },
      SWITCH,
      ALWAYS,
    ];
  }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/ui/keymap.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/ui/keymap.ts src/ui/keymap.test.ts
git commit -m "feat(accounts): keymap hints for accounts pane; drop k/R hotkey hints

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: App integration — render pane, sign-out, drop keybinds

Render the `<Accounts>` pane, define `signOutRutracker`, and remove the `k`/`R` keybinds. (`openAccounts` was already defined and supplied in Task 1.)

**Files:**
- Modify: `src/ui/App.tsx`

**Interfaces:**
- Consumes: `Accounts` (Task 2); `openTokenPrompt`, `clearRealDebridToken`, `openRutrackerPrompt`, `rdStatus`, `rutrackerUser`, `setRutrackerUser`, `clearRutrackerCache`, `clearCacheByPrefix`, `setNotice`, `ICON` (all already in App); `clearSession` from `../sources/rutracker/session`.

- [ ] **Step 1: Import the component and clearSession**

Near the other component imports in `src/ui/App.tsx`:

```typescript
import { Accounts } from "./components/Accounts";
```

Ensure `clearSession` is imported from the rutracker session module. Find the existing `import { ... } from "../sources/rutracker/session";` line and add `clearSession as clearRutrackerSession` to it (it currently imports `login as rutrackerLogin`, `getSession as getRutrackerSession`, `loadSession as loadRutrackerSession`, `type Captcha`). Result includes:

```typescript
  clearSession as clearRutrackerSession,
```

- [ ] **Step 2: Define signOutRutracker**

In `src/ui/App.tsx`, near the other `useCallback` prompt handlers (e.g. after `openRutrackerPrompt`), add:

```typescript
const signOutRutracker = useCallback(() => {
  void clearRutrackerSession().then(() => {
    setRutrackerUser(undefined);
    clearRutrackerCache();
    clearCacheByPrefix("rt-");
    setNotice(`${ICON.done} Signed out of RuTracker`);
  });
}, [setNotice]);
```

(`openAccounts` was already added in Task 1.)

- [ ] **Step 3: Remove the k and R keybinds**

In `src/ui/App.tsx`, in the global `useInput` handler, delete the entire `if (input === "k") { ... }` branch and the entire `if (input === "R") { ... }` branch. Leave `if (input === "S")` and `if (input === "D")` untouched.

- [ ] **Step 4: Render the Accounts pane**

In `src/ui/App.tsx`, next to the `<Box display={section === "seeding" ? "flex" : "none"}><Seeding /></Box>` block, add:

```tsx
            <Box display={section === "accounts" ? "flex" : "none"} flexDirection="column">
              <Accounts
                rdToken={store.config.realDebridToken ?? ""}
                rdStatus={rdStatus}
                rutrackerUser={rutrackerUser}
                onManageRd={openTokenPrompt}
                onSignOutRd={clearRealDebridToken}
                onManageRutracker={openRutrackerPrompt}
                onSignOutRutracker={signOutRutracker}
              />
            </Box>
```

Match the exact wrapper style (`<Box display={...}>`) used by the sibling view blocks in that JSX region.

- [ ] **Step 5: Typecheck, full suite, build**

Run: `npm run typecheck && npm test && npm run build`
Expected: typecheck clean; all tests pass (≥ 245 now); build succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/ui/App.tsx
git commit -m "feat(accounts): render accounts pane, wire sign-in/out, drop k/R keybinds

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Splash repoint + remove dead store field

Point the splash CTA/tip at the Accounts pane, and drop the now-unused `openTokenPrompt` store field.

**Files:**
- Modify: `src/ui/views/Splash.tsx`
- Modify: `src/ui/store.ts` (remove `openTokenPrompt` from the `Store` interface)
- Modify: `src/ui/App.tsx` (remove `openTokenPrompt` from the store value object + deps)

**Interfaces:**
- Consumes: `store.openAccounts` (Task 1 + 4).

- [ ] **Step 1: Confirm Splash is the only store consumer of openTokenPrompt**

Run: `grep -rn "openTokenPrompt" src/ | grep -v "App.tsx"`
Expected: matches only in `src/ui/views/Splash.tsx` and `src/ui/store.ts`. (App keeps its LOCAL `openTokenPrompt` callback — it's passed as the `onManageRd` prop — so do NOT delete the `const openTokenPrompt = useCallback(...)` definition in App; only remove it from the store interface/value.)

- [ ] **Step 2: Repoint Splash to openAccounts**

In `src/ui/views/Splash.tsx`, change the destructure to use `openAccounts` instead of `openTokenPrompt`:

```typescript
  const { submitQuery, searchHistory, quitAll, cols, rows, debridConfigured, rdStatus, openAccounts } = useStore();
```

Replace the `k` key handler:

```typescript
      if (input === "a") {
        openAccounts();
        return;
      }
```

And change the tip text line to:

```tsx
          <Text dimColor>Tip — open the Accounts tab to connect Real-Debrid for instant, private streaming.</Text>
```

- [ ] **Step 3: Remove openTokenPrompt from the store interface**

In `src/ui/store.ts`, delete the `openTokenPrompt: () => void;` line (and its comment) from the `Store` interface. Keep `openAccounts`.

- [ ] **Step 4: Remove openTokenPrompt from the store value object**

In `src/ui/App.tsx`, remove the `openTokenPrompt,` entry from the `store` `useMemo` value object and from that `useMemo`'s dependency array. (Keep the `const openTokenPrompt = useCallback(...)` definition — still used as the `onManageRd` prop.)

- [ ] **Step 5: Typecheck, full suite, build**

Run: `npm run typecheck && npm test && npm run build`
Expected: typecheck clean; all tests pass; build succeeds.

- [ ] **Step 6: Manual smoke (optional, if a TTY is available)**

Run: `npm start`
- Sidebar shows "Accounts"; select it → Real-Debrid + RuTracker rows with status.
- `↵` opens the matching prompt; `x` signs out a signed-in service.
- `?` help no longer lists `k`/`R`; shows the Accounts group.
- Pressing `k`/`R` does nothing.

- [ ] **Step 7: Commit**

```bash
git add src/ui/views/Splash.tsx src/ui/store.ts src/ui/App.tsx
git commit -m "feat(accounts): route splash CTA to accounts pane; drop dead openTokenPrompt store field

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: README

Document the Accounts pane and the removed hotkeys.

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the docs**

In `README.md`: (a) update the RuTracker note added earlier — replace "Press `R` to sign in" with wording that says sign in from the **Accounts** tab in the sidebar; (b) if Real-Debrid is documented with a `k` hotkey anywhere, update it to point at the Accounts tab too. Keep the README's existing tone. Do not restructure unrelated sections.

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document the Accounts pane and updated sign-in flow

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review Notes

- **Spec coverage:** accounts section + sidebar (Task 1), Accounts component + status rows (Task 2), keymap hints + k/R hint removal (Task 3), App render + sign-out (incl. `clearSession` call site) + k/R keybind removal + `openAccounts` (Task 4), Splash repoint + dead-field cleanup (Task 5), docs (Task 6). All spec sections covered.
- **Cross-task type consistency:** `Section` gains `"accounts"` (T1) used in T2/T3/T4; `openAccounts` declared + implemented + supplied (T1), consumed by Splash (T5); `AccountsProps` (T2) matched by the render props (T4); `signOutRutracker` defined + passed (T4).
- **Green after every task:** `openAccounts` is wired end-to-end in T1 (declared, implemented in App, supplied to the store value), so typecheck stays clean from T1 onward. T2's component compiles standalone; T4 renders it. No task leaves the build red.
- **YAGNI honoured:** no store state lifted (props from App), overlays reused, `SourcesPrompt`/`S` untouched.
