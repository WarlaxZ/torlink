# Real-Debrid Integration Polish — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing Real-Debrid integration feel discoverable, status-aware, and intuitive — adding a multi-file stream picker, persistent account status, onboarding hints, a cancellable/clearer "preparing" phase, inline re-auth on expiry, explicit copy-link, and token management.

**Architecture:** A new pure module `rdStatus.ts` turns the RD `/user` payload into a small `RdStatus` value used by a header badge, the splash, and the token prompt. The stream flow gains an `AbortController` + a dedicated "preparing" line and a `StreamFilePrompt` overlay (same pattern as the existing `TokenPrompt`/`StreamPlayerPrompt`). Pure logic is TDD'd with vitest; Ink components stay thin and are verified by typecheck + a manual smoke run.

**Tech Stack:** TypeScript (ESM, Node 22), Ink 7 + React 19, vitest, tsup. Tests colocate as `src/**/*.test.ts`. Run all tests with `npm test`; a single file with `npx vitest run <path>`. Typecheck with `npm run typecheck`.

**Build order rationale:** `rdStatus` state (Tasks 1–3) is the backbone the splash, re-auth, and token-prompt features read from, so it lands first. Stream-flow work (Tasks 4–6) follows, then the cross-cutting polish (Tasks 7–9).

---

## File Structure

**New files**
- `src/integrations/rdStatus.ts` — pure helpers: `RdStatus`, `rdStatusFromUser`, `daysUntil`, `premiumExpiringSoon`, `formatAccountStatus`.
- `src/integrations/rdStatus.test.ts` — unit tests for the above.
- `src/ui/components/RdBadge.tsx` — header status badge.
- `src/ui/components/StreamFilePrompt.tsx` — interactive file picker overlay.

**Modified files**
- `src/integrations/realdebrid.ts` — export `TOKEN_REJECTED_MESSAGE`, use it in `mapStatus`; add `isTokenRejection`.
- `src/util/player.ts` — add `streamCandidates(files)`.
- `src/util/player.test.ts` — tests for `streamCandidates`.
- `src/download/types.ts` — add `directUrl?: string` to `QueueItem`.
- `src/download/queue.ts` — set `directUrl` after RD resolve.
- `src/ui/store.ts` — add `rdStatus`, `copyLink` to `Store`.
- `src/ui/App.tsx` — rdStatus state, launch validation, stream picker + preparing UI + abort, inline re-auth, copy-link wiring, token clear, badge in header.
- `src/ui/components/TokenPrompt.tsx` — status line + `ctrl+x` clear.
- `src/ui/views/Splash.tsx` — discoverability lines.
- `src/ui/keymap.ts` — `k Real-Debrid` hint when unconfigured; `y Link` hint for active RD downloads.

---

## Task 1: `rdStatus` pure module

Turns a `RealDebridUser` into a compact, render-ready status. Pure functions take an explicit `now: Date` so they're deterministic in tests.

**Files:**
- Create: `src/integrations/rdStatus.ts`
- Test: `src/integrations/rdStatus.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/integrations/rdStatus.test.ts
import { describe, it, expect } from "vitest";
import {
  rdStatusFromUser,
  daysUntil,
  premiumExpiringSoon,
  formatAccountStatus,
} from "./rdStatus";
import type { RealDebridUser } from "./realdebrid";

const NOW = new Date("2026-06-30T00:00:00.000Z");

function user(overrides: Partial<RealDebridUser> = {}): RealDebridUser {
  return { username: "ash", type: "premium", premium: 100 * 86_400, ...overrides };
}

describe("rdStatusFromUser", () => {
  it("marks an active premium account and derives expiry from premium seconds", () => {
    const s = rdStatusFromUser(user({ premium: 10 * 86_400, expiration: undefined }), NOW);
    expect(s.username).toBe("ash");
    expect(s.premium).toBe(true);
    expect(s.premiumUntil?.toISOString()).toBe("2026-07-10T00:00:00.000Z");
  });

  it("prefers a valid expiration string over the seconds estimate", () => {
    const s = rdStatusFromUser(user({ expiration: "2026-12-01T00:00:00.000Z" }), NOW);
    expect(s.premiumUntil?.toISOString()).toBe("2026-12-01T00:00:00.000Z");
  });

  it("treats a free/expired account as not premium with no expiry", () => {
    const s = rdStatusFromUser(user({ type: "free", premium: 0 }), NOW);
    expect(s.premium).toBe(false);
    expect(s.premiumUntil).toBeNull();
  });
});

describe("daysUntil", () => {
  it("rounds up and never goes negative", () => {
    expect(daysUntil(new Date("2026-07-10T00:00:00.000Z"), NOW)).toBe(10);
    expect(daysUntil(new Date("2026-06-29T00:00:00.000Z"), NOW)).toBe(0);
  });
});

describe("premiumExpiringSoon", () => {
  it("is true within 14 days, false otherwise", () => {
    const soon = rdStatusFromUser(user({ premium: 5 * 86_400, expiration: undefined }), NOW);
    const later = rdStatusFromUser(user({ premium: 100 * 86_400, expiration: undefined }), NOW);
    expect(premiumExpiringSoon(soon, NOW)).toBe(true);
    expect(premiumExpiringSoon(later, NOW)).toBe(false);
  });
});

describe("formatAccountStatus", () => {
  it("describes connection state for the token prompt", () => {
    expect(formatAccountStatus(null, NOW)).toBe("not connected");
    const free = rdStatusFromUser(user({ type: "free", premium: 0 }), NOW);
    expect(formatAccountStatus(free, NOW)).toBe("free account");
    const prem = rdStatusFromUser(user({ premium: 10 * 86_400, expiration: undefined }), NOW);
    expect(formatAccountStatus(prem, NOW)).toBe("premium · 10d left");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/integrations/rdStatus.test.ts`
Expected: FAIL — `Cannot find module './rdStatus'`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/integrations/rdStatus.ts
import { isPremiumActive, type RealDebridUser } from "./realdebrid";

// Below this many days of premium left, the header badge nudges the user.
const EXPIRY_WARN_DAYS = 14;

// A compact, render-ready view of the connected Real-Debrid account.
export interface RdStatus {
  username: string;
  premium: boolean;
  // When premium, the best estimate of when it lapses; null when free/expired.
  premiumUntil: Date | null;
}

export function rdStatusFromUser(user: RealDebridUser, now: Date): RdStatus {
  const premium = isPremiumActive(user);
  let premiumUntil: Date | null = null;
  if (premium) {
    const fromSeconds = new Date(now.getTime() + (user.premium ?? 0) * 1000);
    if (user.expiration) {
      const parsed = new Date(user.expiration);
      premiumUntil = Number.isNaN(parsed.getTime()) ? fromSeconds : parsed;
    } else {
      premiumUntil = fromSeconds;
    }
  }
  return { username: user.username, premium, premiumUntil };
}

// Whole days from `now` until `date`, rounded up, floored at 0.
export function daysUntil(date: Date, now: Date): number {
  return Math.max(0, Math.ceil((date.getTime() - now.getTime()) / 86_400_000));
}

export function premiumExpiringSoon(status: RdStatus, now: Date): boolean {
  return !!status.premiumUntil && daysUntil(status.premiumUntil, now) <= EXPIRY_WARN_DAYS;
}

// One-line account state for the token prompt.
export function formatAccountStatus(status: RdStatus | null, now: Date): string {
  if (!status) return "not connected";
  if (!status.premium) return "free account";
  if (status.premiumUntil) return `premium · ${daysUntil(status.premiumUntil, now)}d left`;
  return "premium";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/integrations/rdStatus.test.ts`
Expected: PASS (all cases green).

- [ ] **Step 5: Commit**

```bash
git add src/integrations/rdStatus.ts src/integrations/rdStatus.test.ts
git commit -m "feat: add rdStatus helpers for Real-Debrid account state"
```

---

## Task 2: rdStatus state in App + launch validation + store wiring

Hold the validated account in App state, populate it on launch (fire-and-forget) and on token entry, and expose it via the store so the splash can read it.

**Files:**
- Modify: `src/ui/App.tsx`
- Modify: `src/ui/store.ts`

- [ ] **Step 1: Add `rdStatus` to the Store interface**

In `src/ui/store.ts`, add the import and the field. After the existing import block near the top, add:

```typescript
import type { RdStatus } from "../integrations/rdStatus";
```

In the `Store` interface, just after the `debridConfigured: boolean;` line (currently `store.ts:85`), add:

```typescript
  // The validated Real-Debrid account, or null when unknown/not connected.
  rdStatus: RdStatus | null;
  // Copy an arbitrary link (e.g. a resolved RD direct URL) to the clipboard.
  copyLink: (url: string, name: string) => void;
```

- [ ] **Step 2: Add state + helpers in App.tsx**

In `src/ui/App.tsx`, extend the realdebrid/rdStatus imports. Replace the line (`App.tsx:12`):

```typescript
import { validateToken, isPremiumActive, resolveMagnet } from "../integrations/realdebrid";
```

with:

```typescript
import { validateToken, isPremiumActive, resolveMagnet } from "../integrations/realdebrid";
import { rdStatusFromUser, type RdStatus } from "../integrations/rdStatus";
```

> The token-rejection helper (`isTokenRejection`) is imported later, in Task 7, where it is first used — so this task stays self-contained and typechecks cleanly on its own.

Add the state declaration immediately after the `const [notice, setNotice] = useState<string | null>(null);` line (`App.tsx:109`):

```typescript
  const [rdStatus, setRdStatus] = useState<RdStatus | null>(null);
```

- [ ] **Step 3: Validate the saved token once at launch**

In the boot effect, after `setConfigState(cfg);` (`App.tsx:126`), add a fire-and-forget validation that never blocks startup and never toasts on failure:

```typescript
      const launchToken = resolveRealDebridToken(cfg);
      if (launchToken) {
        void validateToken(launchToken)
          .then((u) => {
            if (alive) setRdStatus(rdStatusFromUser(u, new Date()));
          })
          .catch(() => {
            /* offline or bad token at launch: leave the badge hidden, no toast */
          });
      }
```

- [ ] **Step 4: Set rdStatus on token entry**

In `setRealDebridToken` (`App.tsx:225-236`), replace the success/`catch` body so it records the status:

```typescript
      void (async () => {
        try {
          const user = await validateToken(token);
          setRdStatus(rdStatusFromUser(user, new Date()));
          if (!isPremiumActive(user)) {
            setNotice(`Real-Debrid: ${user.username}'s account isn't premium — torrents need premium.`);
            return;
          }
          setNotice(`${ICON.done} Real-Debrid connected as ${user.username}`);
        } catch (e) {
          setRdStatus(null);
          setNotice(`Real-Debrid: ${e instanceof Error ? e.message : "could not validate token"}`);
        }
      })();
```

- [ ] **Step 5: Expose rdStatus + copyLink via the store**

Add a `copyLink` callback near `copyMagnet` (`App.tsx:367`):

```typescript
  const copyLink = useCallback((url: string, name: string) => {
    void (async () => {
      const ok = await writeClipboard(url);
      setNotice(
        ok
          ? `Copied link: ${truncate(cleanText(name), 40)}`
          : `Couldn't copy the link for ${truncate(cleanText(name), 32)}.`,
      );
    })();
  }, []);
```

In the `store` `useMemo` object (`App.tsx:438-471`), add after `debridConfigured: ...,`:

```typescript
      rdStatus,
      copyLink,
```

Add `rdStatus` and `copyLink` to the `useMemo` dependency array (alongside `copyMagnet`).

- [ ] **Step 6: Verify typecheck and tests**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/ui/App.tsx src/ui/store.ts
git commit -m "feat: track validated Real-Debrid account in app state"
```

---

## Task 3: RdBadge header component

A small always-on badge next to the logo showing connection + premium state.

**Files:**
- Create: `src/ui/components/RdBadge.tsx`
- Modify: `src/ui/App.tsx`

- [ ] **Step 1: Create the component**

```tsx
// src/ui/components/RdBadge.tsx
import { Text } from "ink";
import { COLOR, ICON } from "../theme";
import { daysUntil, premiumExpiringSoon, type RdStatus } from "../../integrations/rdStatus";

// Compact, always-on Real-Debrid indicator for the header. Renders nothing when
// no account is known so the header stays clean before a token is set.
export function RdBadge({ status }: { status: RdStatus | null }) {
  if (!status) return null;
  const now = new Date();
  if (!status.premium) {
    return <Text color={COLOR.warn}>{`${ICON.warn} rd free`}</Text>;
  }
  if (status.premiumUntil && premiumExpiringSoon(status, now)) {
    return (
      <Text color={COLOR.warn}>{`${ICON.warn} rd ${status.username} · ${daysUntil(status.premiumUntil, now)}d`}</Text>
    );
  }
  return <Text color={COLOR.good}>{`${ICON.done} rd ${status.username}`}</Text>;
}
```

- [ ] **Step 2: Render it in the header**

In `src/ui/App.tsx`, add the import alongside the other component imports (after `import { Logo } from "./components/Logo";`, `App.tsx:32`):

```typescript
import { RdBadge } from "./components/RdBadge";
```

Replace the header row (`App.tsx:586-589`):

```tsx
        <Box justifyContent="space-between">
          <Logo />
          {notice ? <Text color={COLOR.good}>{notice}</Text> : null}
        </Box>
```

with:

```tsx
        <Box justifyContent="space-between">
          <Logo />
          <Box>
            <RdBadge status={rdStatus} />
            {notice ? <Text color={COLOR.good}>{`  ${notice}`}</Text> : null}
          </Box>
        </Box>
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck`
Expected: PASS.

Manual smoke (optional but recommended): `npm run dev`, press `k`, paste a valid token → header shows `✓ rd <user>`.

- [ ] **Step 4: Commit**

```bash
git add src/ui/components/RdBadge.tsx src/ui/App.tsx
git commit -m "feat: show persistent Real-Debrid status badge in header"
```

---

## Task 4: Discoverability — splash hint + footer hint

Surface that Real-Debrid exists for users who haven't set a token.

**Files:**
- Modify: `src/ui/views/Splash.tsx`
- Modify: `src/ui/keymap.ts`
- Modify: `src/ui/keymap.test.ts`

- [ ] **Step 1: Write the failing footer-hint test**

In `src/ui/keymap.test.ts`, add a test (match the existing import of `footerHints`; if not already imported, import it from `./keymap`):

```typescript
import { footerHints } from "./keymap";

describe("footerHints Real-Debrid discoverability", () => {
  it("shows a k hint on results when RD is not configured", () => {
    const hints = footerHints("content", "all", null, null, false);
    expect(hints.some((h) => h.keys === "k" && /real-debrid/i.test(h.label))).toBe(true);
    expect(hints.some((h) => h.keys === "r")).toBe(false);
  });

  it("shows r and v instead of the k hint when configured", () => {
    const hints = footerHints("content", "all", null, null, true);
    expect(hints.some((h) => h.keys === "r")).toBe(true);
    expect(hints.some((h) => h.keys === "k" && /real-debrid/i.test(h.label))).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/ui/keymap.test.ts`
Expected: FAIL — no `k`/Real-Debrid hint in the unconfigured case.

- [ ] **Step 3: Update `footerHints`**

In `src/ui/keymap.ts`, in the final `return [...]` block (`keymap.ts:106-120`), replace the debrid conditional:

```typescript
    ...(debridConfigured
      ? [
          { keys: "r", label: "Real-Debrid" },
          { keys: "v", label: "Stream" },
        ]
      : []),
```

with:

```typescript
    ...(debridConfigured
      ? [
          { keys: "r", label: "Real-Debrid" },
          { keys: "v", label: "Stream" },
        ]
      : [{ keys: "k", label: "Real-Debrid" }]),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/ui/keymap.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the splash hint**

In `src/ui/views/Splash.tsx`, pull `debridConfigured` and `rdStatus` from the store. Replace the destructure (`Splash.tsx:14`):

```typescript
  const { submitQuery, quitAll, cols, rows } = useStore();
```

with:

```typescript
  const { submitQuery, quitAll, cols, rows, debridConfigured, rdStatus } = useStore();
```

Then add a hint line just after the category row `</Box>` (after `Splash.tsx:46`, before the search-bar `<Box marginTop={1} width={barWidth}>`):

```tsx
      <Box marginTop={1}>
        {debridConfigured ? (
          <Text dimColor>
            {`Real-Debrid: connected${rdStatus?.username ? ` as ${rdStatus.username}` : ""}`}
          </Text>
        ) : (
          <Text dimColor>Tip — press k to connect Real-Debrid for instant, private streaming.</Text>
        )}
      </Box>
```

- [ ] **Step 6: Verify**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/ui/views/Splash.tsx src/ui/keymap.ts src/ui/keymap.test.ts
git commit -m "feat: surface Real-Debrid in splash and footer for new users"
```

---

## Task 5: `streamCandidates` helper

Decides the set of files the picker should offer (videos if any, else everything), reusing the same video logic as `pickStreamFile`.

**Files:**
- Modify: `src/util/player.ts`
- Modify: `src/util/player.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/util/player.test.ts` (the `f(filename, bytes)` helper already exists there):

```typescript
import { streamCandidates } from "./player";

describe("streamCandidates", () => {
  it("returns only video files when any are present", () => {
    const files = [f("readme.txt", 10), f("movie.mkv", 900), f("sample.mp4", 50)];
    const out = streamCandidates(files);
    expect(out.map((x) => x.filename).sort()).toEqual(["movie.mkv", "sample.mp4"]);
  });

  it("falls back to all files when none look like video", () => {
    const files = [f("disc.iso", 900), f("readme.txt", 10)];
    expect(streamCandidates(files).length).toBe(2);
  });

  it("returns an empty array for no files", () => {
    expect(streamCandidates([])).toEqual([]);
  });
});
```

> Add the `import { streamCandidates }` to the existing top-of-file import from `./player` rather than a second import line if you prefer; a separate import line also compiles.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/util/player.test.ts`
Expected: FAIL — `streamCandidates is not a function`.

- [ ] **Step 3: Implement**

In `src/util/player.ts`, add after `pickStreamFile` (`player.ts:51`):

```typescript
/**
 * The files worth offering for streaming: the video files if any exist,
 * otherwise every file. Used to decide whether to show a picker (2+ items) and
 * what to list. Mirrors pickStreamFile's video heuristic.
 */
export function streamCandidates(files: ResolvedFile[]): ResolvedFile[] {
  const videos = files.filter((f) => VIDEO_EXTS.has(ext(f.filename)));
  return videos.length > 0 ? videos : files;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/util/player.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/util/player.ts src/util/player.test.ts
git commit -m "feat: add streamCandidates helper for the stream file picker"
```

---

## Task 6: StreamFilePrompt component

An overlay listing stream candidates, largest pre-selected.

**Files:**
- Create: `src/ui/components/StreamFilePrompt.tsx`

- [ ] **Step 1: Create the component**

```tsx
// src/ui/components/StreamFilePrompt.tsx
import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { Panel } from "./Panel";
import { COLOR, GUTTER, ICON } from "../theme";
import { formatBytes, cleanText, truncate } from "../../util/format";
import type { ResolvedFile } from "../../integrations/realdebrid";

interface StreamFilePromptProps {
  width: number;
  files: ResolvedFile[];
  onSelect: (file: ResolvedFile) => void;
  onCancel: () => void;
}

// Pick a file to stream when a torrent holds several videos. Files arrive
// largest-first (sorted by the caller), so cursor 0 is the most likely pick.
export function StreamFilePrompt({ width, files, onSelect, onCancel }: StreamFilePromptProps) {
  const [cursor, setCursor] = useState(0);
  const clamped = Math.min(cursor, Math.max(0, files.length - 1));

  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.upArrow) setCursor(Math.max(0, clamped - 1));
    else if (key.downArrow) setCursor(Math.min(files.length - 1, clamped + 1));
    else if (key.return) {
      const file = files[clamped];
      if (file) onSelect(file);
    }
  });

  const nameW = Math.max(10, width - 16);

  return (
    <Box flexDirection="column" width={width}>
      <Panel title="choose a file to stream" width={width} focused height={Math.min(files.length, 8)}>
        {files.slice(0, 8).map((file, i) => {
          const here = i === clamped;
          return (
            <Box key={file.url}>
              <Box width={GUTTER} flexShrink={0}>
                <Text color={COLOR.accent}>{here ? ICON.pointer : ""}</Text>
              </Box>
              <Box flexGrow={1} minWidth={0}>
                <Text color={here ? COLOR.accent : undefined} dimColor={!here} bold={here} wrap="truncate-end">
                  {truncate(cleanText(file.filename), nameW)}
                </Text>
              </Box>
              <Box flexShrink={0} marginLeft={1} justifyContent="flex-end">
                <Text dimColor>{file.bytes > 0 ? formatBytes(file.bytes) : "-"}</Text>
              </Box>
            </Box>
          );
        })}
      </Panel>
      <Box marginTop={1}>
        <Text color={COLOR.alt}>↑↓</Text>
        <Text dimColor> move</Text>
        <Text dimColor>{`     ${ICON.dot}     `}</Text>
        <Text color={COLOR.alt}>↵</Text>
        <Text dimColor> stream</Text>
        <Text dimColor>{`     ${ICON.dot}     `}</Text>
        <Text color={COLOR.alt}>esc</Text>
        <Text dimColor> cancel</Text>
      </Box>
    </Box>
  );
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `npm run typecheck`
Expected: PASS (component compiles; not yet wired in).

- [ ] **Step 3: Commit**

```bash
git add src/ui/components/StreamFilePrompt.tsx
git commit -m "feat: add StreamFilePrompt overlay for multi-file streams"
```

---

## Task 7: Wire the picker + cancellable, phase-aware "Preparing…" into App

This task combines spec items #1 (picker) and #4 (cancellable/clearer preparing) because they share the same `streamResult` rewrite and overlay/input plumbing.

**Files:**
- Modify: `src/integrations/realdebrid.ts` (Step 1 — token-rejection exports, also used by Task 8)
- Modify: `src/ui/App.tsx`

- [ ] **Step 1: Export the token-rejection message + predicate**

In `src/integrations/realdebrid.ts`, add a constant above `mapStatus` (`realdebrid.ts:88`):

```typescript
// Exported so the UI can recognise an expired/invalid token from a surfaced
// error message (e.g. one stored on a failed download item) and re-prompt.
export const TOKEN_REJECTED_MESSAGE = "Real-Debrid rejected the token (invalid or expired).";
```

In `mapStatus`, replace the 401/403 branch body to use the constant:

```typescript
  if (status === 401 || status === 403) {
    return new RealDebridError(TOKEN_REJECTED_MESSAGE, status, code);
  }
```

Add a predicate after the `RealDebridError` class (`realdebrid.ts:60`):

```typescript
// True for an error that means the token was rejected — by HTTP status when we
// have the typed error, or by message when only the surfaced string survives.
export function isTokenRejection(e: unknown): boolean {
  if (e instanceof RealDebridError && (e.status === 401 || e.status === 403)) return true;
  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return msg.includes(TOKEN_REJECTED_MESSAGE);
}
```

- [ ] **Step 2: Add picker + preparing state in App.tsx**

In `src/ui/App.tsx`, add the imports: `streamCandidates` from player (extend the line `App.tsx:13`):

```typescript
import { detectPlayer, launchPlayer, pickStreamFile, streamCandidates } from "../util/player";
```

Add the StreamFilePrompt import after the StreamPlayerPrompt import (`App.tsx:46`):

```typescript
import { StreamFilePrompt } from "./components/StreamFilePrompt";
import type { ResolvedFile } from "../integrations/realdebrid";
```

Add `isTokenRejection` to the realdebrid import (this task's `streamResult` rewrite and Task 8 both use it). The line edited in Task 2 becomes:

```typescript
import {
  validateToken,
  isPremiumActive,
  resolveMagnet,
  isTokenRejection,
} from "../integrations/realdebrid";
```

Add state after `const [rdStatus, ...]` (from Task 2):

```typescript
  const [streamFiles, setStreamFiles] = useState<ResolvedFile[] | null>(null);
  const [preparing, setPreparing] = useState<{ label: string; phase: "caching" | "fetching"; pct: number } | null>(null);
  const prepareAbort = useRef<AbortController | null>(null);
```

- [ ] **Step 3: Add an elapsed-seconds ticker for the preparing line**

Add this state + effect near the other effects (after the notice auto-clear effect, `App.tsx:421`):

```typescript
  const [prepElapsed, setPrepElapsed] = useState(0);
  useEffect(() => {
    if (!preparing) {
      setPrepElapsed(0);
      return;
    }
    const started = Date.now();
    const t = setInterval(() => setPrepElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(t);
  }, [preparing]);
```

- [ ] **Step 4: Rewrite `streamResult` and add a finisher**

Replace `streamResult` (`App.tsx:292-322`) with:

```typescript
  // Hand a resolved file to the player path and clear any picker/preparing UI.
  const finishStream = useCallback(
    (file: ResolvedFile, name?: string) => {
      setStreamFiles(null);
      setPreparing(null);
      void playStream(file.url, name ?? file.filename);
    },
    [playStream],
  );

  const cancelPreparing = useCallback(() => {
    prepareAbort.current?.abort();
    prepareAbort.current = null;
    setPreparing(null);
    setNotice("Stream cancelled.");
  }, []);

  const streamResult = useCallback(
    (input: DownloadInput) => {
      if (!config) return;
      const token = resolveRealDebridToken(config);
      if (!token) {
        setNotice("Set a Real-Debrid token first (press k).");
        return;
      }
      const label = truncate(cleanText(input.name), 32);
      const controller = new AbortController();
      prepareAbort.current = controller;
      setPreparing({ label, phase: "caching", pct: 0 });
      void (async () => {
        try {
          const files = await resolveMagnet(token, input.magnet, {
            knownHash: input.id,
            signal: controller.signal,
            // 0<pct<100 means RD is still caching server-side; otherwise we're
            // about to fetch the direct link.
            onProgress: (pct) =>
              setPreparing((p) =>
                p ? { ...p, phase: pct > 0 && pct < 100 ? "caching" : "fetching", pct } : p,
              ),
          });
          if (controller.signal.aborted) return;
          prepareAbort.current = null;
          const candidates = streamCandidates(files).sort((a, b) => b.bytes - a.bytes);
          if (candidates.length === 0) {
            setPreparing(null);
            setNotice("Real-Debrid returned nothing to stream.");
            return;
          }
          if (candidates.length > 1) {
            setPreparing(null);
            setStreamFiles(candidates);
            return;
          }
          finishStream(candidates[0]!, input.name);
        } catch (e) {
          prepareAbort.current = null;
          setPreparing(null);
          if (isTokenRejection(e)) {
            setRdStatus(null);
            setNotice("Real-Debrid token expired — re-enter it.");
            setShowHelp(false);
            setEditingToken(true);
            return;
          }
          setNotice(`Real-Debrid: ${e instanceof Error ? e.message : "couldn't prepare stream"}`);
        }
      })();
    },
    [config, finishStream],
  );
```

> This rewrite delivers spec items #1 (picker via `streamFiles`), #4 (preparing state + abort), and the streaming half of #5 (inline re-auth via `isTokenRejection`).

- [ ] **Step 5: Render the picker overlay and preparing line**

In the render, add the preparing line right after the header `</Box>` block and before the top rule (after `App.tsx:589`):

```tsx
        {preparing ? (
          <Box>
            <Spinner
              label={
                preparing.phase === "caching"
                  ? `Caching on Real-Debrid… ${preparing.pct}% · ${prepElapsed}s  (esc cancels)`
                  : `Fetching link… ${prepElapsed}s  (esc cancels)`
              }
            />
          </Box>
        ) : null}
```

Add the picker overlay alongside the other prompts, after the `StreamPlayerPrompt` block (`App.tsx:629`):

```tsx
        {streamFiles ? (
          <Box marginTop={1}>
            <StreamFilePrompt
              width={Math.max(24, Math.min(cols - 4, 72))}
              files={streamFiles}
              onSelect={(file) => finishStream(file)}
              onCancel={() => {
                setStreamFiles(null);
                setNotice("Stream cancelled.");
              }}
            />
          </Box>
        ) : null}
```

- [ ] **Step 6: Gate global input + body visibility for the new overlays**

In the main `useInput` (`App.tsx:503`), add early returns alongside the existing prompt guards (after `if (pendingP2P) return;`, `App.tsx:512`):

```typescript
      if (streamFiles) return; // the file picker owns input
      if (preparing) {
        if (key.escape) cancelPreparing();
        return; // swallow other keys while preparing
      }
```

In the `store` `useMemo`, update the `region` ternary (`App.tsx:448-449`) to include the new overlays:

```typescript
      region:
        showHelp || editingFolder || editingToken || editingPlayer || pendingP2P || streamFiles
          ? "help"
          : region,
```

In the body `display` condition (`App.tsx:657-659`), add `streamFiles`:

```tsx
          display={
            showHelp || editingFolder || editingToken || editingPlayer || pendingP2P || streamFiles
              ? "none"
```

Add `streamFiles`, `preparing`, `finishStream`, `cancelPreparing`, `prepElapsed` to the relevant `useMemo`/`useInput` dependency arrays where the linter/compiler flags them (the store `useMemo` deps list and the `useInput` is not memoized so needs nothing). At minimum add `streamFiles` to the store `useMemo` deps.

- [ ] **Step 7: Verify**

Run: `npm run typecheck && npm test`
Expected: PASS.

Manual smoke (recommended): `npm run dev`; stream a single-file torrent → "Caching on Real-Debrid… N% · Ns", then it plays; press `esc` mid-prepare → "Stream cancelled."; stream a season pack → picker appears.

- [ ] **Step 8: Commit**

```bash
git add src/integrations/realdebrid.ts src/ui/App.tsx
git commit -m "feat: multi-file stream picker + cancellable, phase-aware preparing"
```

---

## Task 8: Inline re-auth for failed Real-Debrid downloads

The streaming re-auth landed in Task 7. Downloads fail asynchronously inside the queue, so detect a token-rejection on a failed item and re-prompt.

**Files:**
- Modify: `src/ui/App.tsx`

- [ ] **Step 1: Add a queue listener that re-prompts on token rejection**

In `src/ui/App.tsx`, add an effect after the existing `queue.on("completed", ...)` effect (`App.tsx:149-157`):

```typescript
  // If a Real-Debrid download fails because the token was rejected, clear the
  // stale status and re-open the token prompt — once per failure, not on every
  // queue tick.
  const reauthSeen = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!queue) return;
    const onUpdate = (): void => {
      for (const it of queue.getItems()) {
        if (it.status !== "failed" || it.via !== "realdebrid" || !it.error) continue;
        if (reauthSeen.current.has(it.id)) continue;
        if (isTokenRejection(it.error)) {
          reauthSeen.current.add(it.id);
          setRdStatus(null);
          setNotice("Real-Debrid token expired — re-enter it.");
          setShowHelp(false);
          setEditingToken(true);
        }
      }
    };
    queue.on("update", onUpdate);
    return () => {
      queue.off("update", onUpdate);
    };
  }, [queue]);
```

- [ ] **Step 2: Verify**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/ui/App.tsx
git commit -m "feat: re-prompt for token when a Real-Debrid download is rejected"
```

---

## Task 9: Explicit copy-link (streaming + downloads) and token management

Closes spec items #6 (copy-link) and #7 (token prompt status + clear).

**Files:**
- Modify: `src/download/types.ts`
- Modify: `src/download/queue.ts`
- Modify: `src/ui/App.tsx`
- Modify: `src/ui/components/TokenPrompt.tsx`
- Modify: `src/ui/components/Downloads.tsx`
- Modify: `src/ui/keymap.ts`

- [ ] **Step 1: Persist the resolved direct link on RD queue items**

In `src/download/types.ts`, add a field to the `QueueItem` interface (place it near `via`/`phase`):

```typescript
  // For Real-Debrid items: the primary resolved direct URL, so it can be copied
  // from the downloads pane. Set once links are resolved.
  directUrl?: string;
```

In `src/download/queue.ts`, in `runDebrid`, immediately after the resolved `files` are received and `item.phase` is set to `"downloading"` (the block the explorer noted at `queue.ts:191-196`), set the primary link. Use the existing `pickStreamFile` import (add it if absent: `import { pickStreamFile } from "../util/player";`):

```typescript
    it.directUrl = pickStreamFile(files)?.url;
```

Ensure the surrounding code persists item state as it already does after mutating the item (follow the existing `persist`/state-write call in that function).

- [ ] **Step 2: Streaming always copies the link**

In `src/ui/App.tsx`, update `playStream` (`App.tsx:272-290`) so a successful launch also copies the link and says so. Replace the success branch:

```typescript
      if (player && (await launchPlayer(player, url))) {
        await writeClipboard(url);
        setNotice(
          `${ICON.done} Streaming ${name ? `${truncate(cleanText(name), 28)} ` : ""}in ${player} · link copied`,
        );
        return;
      }
```

(The no-player branch already copies to the clipboard — leave it.)

- [ ] **Step 3: Copy-link key in the downloads pane**

In `src/ui/components/Downloads.tsx`, pull `copyLink` from the store. Update the destructure (`Downloads.tsx:59`):

```typescript
  const { queue, region, contentWidth, listRows, startDownload, setDownloadFocus, copyLink } = useStore();
```

In the active-item branch of `useInput` (`Downloads.tsx:76-80`), add a `y` handler:

```typescript
      else if (inActive) {
        const it = active[clamped];
        if (!it) return;
        if (input === "c") queue.cancel(it.id);
        else if (input === "p") queue.togglePause(it.id);
        else if (input === "y") {
          if (it.directUrl) copyLink(it.directUrl, it.name);
        }
      } else {
```

- [ ] **Step 4: Footer hint for copy-link on active RD downloads**

In `src/ui/keymap.ts`, in the `section === "downloads"` branch, extend the default (downloading) return (`keymap.ts:104`) to include a link hint:

```typescript
    return [
      { keys: "p", label: "Pause" },
      { keys: "c", label: "Cancel" },
      { keys: "y", label: "Link" },
      SWITCH,
      ALWAYS,
    ];
```

- [ ] **Step 5: Token prompt status line + clear**

In `src/ui/components/TokenPrompt.tsx`, extend props and render. Replace the import block and props interface:

```tsx
import { Box, Text, useInput } from "ink";
import { TextField } from "./TextField";
import { Panel } from "./Panel";
import { COLOR, ICON } from "../theme";
import { hyperlink } from "../../util/terminal";
import { formatAccountStatus, type RdStatus } from "../../integrations/rdStatus";

interface TokenPromptProps {
  width: number;
  value: string;
  status: RdStatus | null;
  onSubmit: (value: string) => void;
  onClear: () => void;
  onCancel: () => void;
}
```

Update the component signature and `useInput`, and add the status line + clear hint:

```tsx
export function TokenPrompt({ width, value, status, onSubmit, onClear, onCancel }: TokenPromptProps) {
  useInput((input, key) => {
    if (key.escape) onCancel();
    else if (key.ctrl && input === "x") onClear();
  });

  return (
    <Box flexDirection="column" width={width}>
      <Panel title="real-debrid token" width={width} focused height={2}>
        <Box>
          <Text color={COLOR.accent}>{`${ICON.pointer} `}</Text>
          <Box flexGrow={1} minWidth={0}>
            <TextField
              mask
              placeholder={value ? `current: ${masked(value)}` : "paste your API token"}
              onSubmit={onSubmit}
            />
          </Box>
        </Box>
      </Panel>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>{`account: ${formatAccountStatus(status, new Date())}`}</Text>
        <Box>
          <Text color={COLOR.alt}>↵</Text>
          <Text dimColor> save</Text>
          {value ? (
            <>
              <Text dimColor>{`     ${ICON.dot}     `}</Text>
              <Text color={COLOR.alt}>^x</Text>
              <Text dimColor> clear</Text>
            </>
          ) : null}
          <Text dimColor>{`     ${ICON.dot}     `}</Text>
          <Text color={COLOR.alt}>esc</Text>
          <Text dimColor> cancel</Text>
        </Box>
        <Text dimColor>
          Get a token at{" "}
          {hyperlink("https://real-debrid.com/apitoken", "real-debrid.com/apitoken")}
        </Text>
      </Box>
    </Box>
  );
}
```

(Keep the existing `masked` helper above the component unchanged.)

- [ ] **Step 6: Wire `status`/`onClear` into App's TokenPrompt usage**

In `src/ui/App.tsx`, add a clear handler near `setRealDebridToken` (`App.tsx:239`):

```typescript
  const clearRealDebridToken = useCallback(() => {
    closeTokenPrompt();
    if (!config) return;
    if (process.env["REALDEBRID_API_TOKEN"]?.trim()) {
      setNotice("Token is set via REALDEBRID_API_TOKEN — unset the env var to clear it.");
      return;
    }
    setConfig({ ...config, realDebridToken: undefined });
    setRdStatus(null);
    setNotice("Real-Debrid token cleared.");
  }, [config, setConfig, closeTokenPrompt]);
```

Update the `TokenPrompt` render (`App.tsx:611-616`) to pass the new props:

```tsx
            <TokenPrompt
              width={Math.max(24, Math.min(cols - 4, 62))}
              value={store.config.realDebridToken ?? ""}
              status={rdStatus}
              onSubmit={setRealDebridToken}
              onClear={clearRealDebridToken}
              onCancel={closeTokenPrompt}
            />
```

- [ ] **Step 7: Verify**

Run: `npm run typecheck && npm test`
Expected: PASS.

Manual smoke (recommended): start a Real-Debrid download, press `y` while it's active → "Copied link: …". Press `k` → status line shows `account: premium · Nd left` and a `^x clear` hint; press `ctrl+x` → "Real-Debrid token cleared.".

- [ ] **Step 8: Commit**

```bash
git add src/download/types.ts src/download/queue.ts src/ui/App.tsx src/ui/components/TokenPrompt.tsx src/ui/components/Downloads.tsx src/ui/keymap.ts
git commit -m "feat: explicit copy-link for streams/downloads and token management"
```

---

## Final verification

- [ ] **Run the full suite and typecheck**

Run: `npm run typecheck && npm test`
Expected: all green.

- [ ] **Build the CLI**

Run: `npm run build`
Expected: succeeds, emits `dist/cli.cjs`.

- [ ] **Manual end-to-end smoke** (`npm run dev`)
  - Splash shows the Real-Debrid tip with no token; press `k` → status line + clickable token link.
  - Enter a valid token → header badge `✓ rd <user>`; splash shows "connected as <user>".
  - Stream a single-file torrent → phase-aware preparing line; plays; notice says "link copied".
  - Stream a season pack → file picker; choose an episode → plays.
  - Press `esc` mid-prepare → "Stream cancelled.".
  - Start an RD download → press `y` → "Copied link: …".
  - In the token prompt, press `ctrl+x` → token cleared, badge disappears.

---

## Notes carried from earlier work

Two changes already exist uncommitted on this branch and overlap this plan's spirit; fold them into the relevant commits or commit separately first:
- `src/util/terminal.ts` (`hyperlink` helper) — required by the TokenPrompt in Task 9 Step 5 (already imported there).
- `src/util/clipboard.ts` WSL support (`clip.exe` / `powershell.exe`) — makes the copy-link features actually reach the Windows clipboard under WSL.
