# For You Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the For You page, let the user rate the highlighted pick (watched / like / dislike — posting the matching reccd event and dismissing it) and add it to the watchlist (`w`), closing the recommendation feedback loop.

**Architecture:** Reuse the existing `RatePrompt` modal (extended with an optional "watched" action) owned by `App`; `ForYou` asks App to open it for the selected pick and hands over a "dismiss this pick" closure that runs only on a real rating. Watchlist add reuses the existing `toggleSavedSearch` store action. Refresh already exists (`r`) and is untouched.

**Tech Stack:** TypeScript (ESM), React + Ink, Vitest + ink-testing-library.

**Reference:** Spec at `docs/superpowers/specs/2026-07-22-foryou-feedback-design.md`.

**Test-run notes (important):**
- Run vitest scoped and excluding stale nested worktrees: `npx vitest run --exclude '**/.claude/**' <path>`.
- `npx eslint` is broken repo-wide (missing `@eslint/js`) — do NOT run it; rely on `npx tsc --noEmit` + vitest.

---

## File Structure

Modified:
- `src/ui/components/RatePrompt.tsx` (+ `RatePrompt.test.tsx`) — optional watched action + title.
- `src/ui/hooks/useRecommendations.ts` — `dismiss(imdbId)`.
- `src/ui/components/ForYou.tsx` (+ `ForYou.test.tsx`) — `f` (rate) and `w` (watchlist) keys + new props.
- `src/ui/App.tsx` — extend `ratePrompt` state, add `openRatePick`, wire ForYou props, extend RatePrompt render.
- `src/ui/keymap.ts` — For You `?` group + footer hints.

No new files.

---

## Task 1: Extend RatePrompt with an optional "watched" action

**Files:**
- Modify: `src/ui/components/RatePrompt.tsx`
- Test: `src/ui/components/RatePrompt.test.tsx`

- [ ] **Step 1: Add failing tests**

Append these cases inside the `describe("RatePrompt", ...)` block in `src/ui/components/RatePrompt.test.tsx` (the file already defines `flush`, `ESC`, and imports):

```tsx
  it("shows the watched affordance and calls onWatched when 'w' is pressed (when onWatched given)", async () => {
    const onWatched = vi.fn();
    const { stdin, lastFrame } = render(
      <RatePrompt name="The Matrix" onLike={vi.fn()} onDislike={vi.fn()} onWatched={onWatched} onDismiss={vi.fn()} />,
    );
    await flush();
    expect(lastFrame()).toContain("watched");
    stdin.write("w");
    await flush();
    expect(onWatched).toHaveBeenCalled();
  });

  it("does not render the watched affordance when onWatched is omitted", async () => {
    const { lastFrame } = render(
      <RatePrompt name="The Matrix" onLike={vi.fn()} onDislike={vi.fn()} onDismiss={vi.fn()} />,
    );
    await flush();
    expect(lastFrame()).not.toContain("watched");
  });

  it("uses a custom title when provided", async () => {
    const { lastFrame } = render(
      <RatePrompt name="The Matrix" title="Rate this pick" onLike={vi.fn()} onDislike={vi.fn()} onDismiss={vi.fn()} />,
    );
    await flush();
    expect(lastFrame()).toContain("Rate this pick");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --exclude '**/.claude/**' src/ui/components/RatePrompt.test.tsx`
Expected: FAIL — `onWatched`/`title` props don't exist; "watched" not rendered.

- [ ] **Step 3: Implement**

Replace the entire contents of `src/ui/components/RatePrompt.tsx` with:

```tsx
import { Box, Text, useInput } from "ink";
import { Panel } from "./Panel";
import { COLOR, ICON } from "../theme";
import { cleanText, truncate } from "../../util/format";

interface RatePromptProps {
  width?: number;
  name: string;
  // Heading; defaults to the post-stream phrasing. For You passes "Rate this pick".
  title?: string;
  onLike: () => void;
  onDislike: () => void;
  // Optional: when provided, a "watched" action (key `w`) is shown. Post-stream
  // callers omit it, so that prompt stays like/dislike only.
  onWatched?: () => void;
  onDismiss: () => void;
}

// Shown after a stream ends, or from For You: a quick feedback signal. Styled
// like the other inline prompts; owns keyboard input while mounted.
export function RatePrompt({ width = 40, name, title = "How was it?", onLike, onDislike, onWatched, onDismiss }: RatePromptProps) {
  useInput((input, key) => {
    if (key.escape) {
      onDismiss();
      return;
    }
    if (onWatched && input === "w") {
      onWatched();
      return;
    }
    if (input === "l") {
      onLike();
      return;
    }
    if (input === "d") {
      onDislike();
    }
  });

  return (
    <Box flexDirection="column" width={width}>
      <Panel title={title} width={width} focused height={2}>
        <Box>
          <Text color={COLOR.accent}>{`${ICON.pointer} `}</Text>
          <Box flexGrow={1} minWidth={0}>
            <Text color={COLOR.text} wrap="wrap">
              {truncate(cleanText(name), 40)}
            </Text>
          </Box>
        </Box>
      </Panel>
      <Box marginTop={1}>
        {onWatched ? (
          <Text>
            <Text color={COLOR.alt}>w</Text>
            <Text dimColor> watched</Text>
            <Text dimColor>{`     ${ICON.dot}     `}</Text>
          </Text>
        ) : null}
        <Text color={COLOR.alt}>l</Text>
        <Text dimColor> like</Text>
        <Text dimColor>{`     ${ICON.dot}     `}</Text>
        <Text color={COLOR.alt}>d</Text>
        <Text dimColor> dislike</Text>
        <Text dimColor>{`     ${ICON.dot}     `}</Text>
        <Text color={COLOR.alt}>esc</Text>
        <Text dimColor> skip</Text>
      </Box>
    </Box>
  );
}
```

Note: the nested `<Text>` wrapper for the watched affordance mirrors how Ink composes inline coloured spans elsewhere in this file (adjacent `<Text>` children inside a row `<Box>`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --exclude '**/.claude/**' src/ui/components/RatePrompt.test.tsx`
Expected: PASS (the 3 original cases + 3 new).

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: `TypeScript: No errors found`, exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/ui/components/RatePrompt.tsx src/ui/components/RatePrompt.test.tsx
git commit -m "feat: RatePrompt optional watched action + custom title"
```

---

## Task 2: Add `dismiss(imdbId)` to useRecommendations

**Files:**
- Modify: `src/ui/hooks/useRecommendations.ts`

(The hook has no direct test; its `dismiss` is exercised through ForYou in Task 3. This task is a small, type-checked addition.)

- [ ] **Step 1: Add `dismiss` to the state interface**

In `src/ui/hooks/useRecommendations.ts`, add to the `RecommendationsState` interface (after `refresh: () => void;`):

```ts
  dismiss: (imdbId: string) => void;
```

- [ ] **Step 2: Implement `dismiss` and return it**

After the `refresh` definition (`const refresh = useCallback(() => void load(), [load]);`), add:

```ts
  // Optimistically remove a pick from the list (e.g. once it's been rated).
  // Events are fire-and-forget, so we don't wait on reccd before dropping it.
  const dismiss = useCallback((imdbId: string) => {
    setItems((prev) => prev.filter((it) => it.imdbId !== imdbId));
  }, []);
```

Then add `dismiss` to the returned object:

```ts
  return { items, loading, error, type, genre, explore, refresh, dismiss, setType, setGenre, toggleExplore };
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors. (ForYou doesn't consume `dismiss` yet; that's Task 3.)

- [ ] **Step 4: Commit**

```bash
git add src/ui/hooks/useRecommendations.ts
git commit -m "feat: add dismiss(imdbId) to useRecommendations"
```

---

## Task 3: ForYou — `f` (rate) and `w` (watchlist) keys

**Files:**
- Modify: `src/ui/components/ForYou.tsx`
- Test: `src/ui/components/ForYou.test.tsx`

- [ ] **Step 1: Add failing tests**

Append these cases inside the `describe("ForYou", ...)` block in `src/ui/components/ForYou.test.tsx` (the file already defines `flush`, `ESC`, `REC`, `CONFIG`, `fetchStub`):

```tsx
  it("opens the rate prompt for the selected pick on 'f' and dismisses it when rated", async () => {
    const { impl } = fetchStub();
    const onRatePick = vi.fn();
    const { stdin, lastFrame } = render(
      <ForYou
        reccConfig={CONFIG}
        visible
        active
        setSection={vi.fn()}
        submitQuery={vi.fn()}
        onRatePick={onRatePick}
        toggleSavedSearch={vi.fn()}
        fetchImpl={impl}
      />,
    );
    await flush();
    stdin.write("f");
    await flush();
    expect(onRatePick).toHaveBeenCalledWith("Chernobyl", expect.any(Function));
    // Invoking the provided callback dismisses the pick from the list.
    const onRated = onRatePick.mock.calls[0]![1] as () => void;
    onRated();
    await flush();
    expect(lastFrame()).not.toContain("Chernobyl");
  });

  it("adds the selected pick to the watchlist on 'w' without dismissing it", async () => {
    const { impl } = fetchStub();
    const toggleSavedSearch = vi.fn();
    const { stdin, lastFrame } = render(
      <ForYou
        reccConfig={CONFIG}
        visible
        active
        setSection={vi.fn()}
        submitQuery={vi.fn()}
        onRatePick={vi.fn()}
        toggleSavedSearch={toggleSavedSearch}
        fetchImpl={impl}
      />,
    );
    await flush();
    stdin.write("w");
    await flush();
    expect(toggleSavedSearch).toHaveBeenCalledWith("Chernobyl");
    expect(lastFrame()).toContain("Chernobyl"); // stays in the list
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --exclude '**/.claude/**' src/ui/components/ForYou.test.tsx`
Expected: FAIL — `f`/`w` do nothing; `onRatePick`/`toggleSavedSearch` props not accepted/used.

- [ ] **Step 3: Add the two props (optional, mirroring `setCaptureMode`)**

In `src/ui/components/ForYou.tsx`, add to the `ForYouProps` interface (after `submitQuery: (q: string) => void;`):

```ts
  onRatePick?: (name: string, onRated: () => void) => void;
  toggleSavedSearch?: (query: string) => void;
```

Add them to the destructured params (after `submitQuery,`):

```ts
  onRatePick,
  toggleSavedSearch,
```

- [ ] **Step 4: Import `useEffect` and clamp selection after dismissal**

Change the React import at the top from:

```ts
import { useState } from "react";
```

to:

```ts
import { useEffect, useState } from "react";
```

Add this effect right after the `const [editingGenre, setEditingGenre] = useState(false);` line (so a dismissal that shrinks the list can't leave `selected` past the end):

```ts
  // Keep the highlight in range when the list shrinks (e.g. after a pick is
  // rated and dismissed).
  useEffect(() => {
    if (selected >= count && count > 0) setSelected(count - 1);
  }, [count, selected]);
```

- [ ] **Step 5: Add the `w` and `f` key branches**

In the `useInput` handler, insert these two branches between the `else if (input === "r") recs.refresh();` line and the `else if (key.return) {` line:

```ts
      else if (input === "w") {
        const item = recs.items[selected];
        if (item) toggleSavedSearch?.(item.title);
      }
      else if (input === "f") {
        const item = recs.items[selected];
        if (item) onRatePick?.(item.title, () => recs.dismiss(item.imdbId));
      }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run --exclude '**/.claude/**' src/ui/components/ForYou.test.tsx`
Expected: PASS (all existing cases + the 2 new).

- [ ] **Step 7: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/ui/components/ForYou.tsx src/ui/components/ForYou.test.tsx
git commit -m "feat: For You rate (f) and add-to-watchlist (w) keys"
```

---

## Task 4: Wire into App.tsx

**Files:**
- Modify: `src/ui/App.tsx`

- [ ] **Step 1: Extend the `ratePrompt` state shape**

Find (line ~250):

```ts
  const [ratePrompt, setRatePrompt] = useState<{ name: string } | null>(null);
```

Replace with:

```ts
  const [ratePrompt, setRatePrompt] = useState<{
    name: string;
    showWatched?: boolean;
    title?: string;
    onRated?: () => void;
  } | null>(null);
```

The existing post-stream call `setRatePrompt({ name: active.name });` (line ~1004) stays valid and unchanged (the new fields are optional).

- [ ] **Step 2: Add the `openRatePick` handler**

Find the end of the `toggleSavedSearch` useCallback (lines ~475-487; it ends with `}, []);` right after `setNotice("Watchlist updated.");`). Immediately after it, add:

```ts
  // Opens the shared RatePrompt for a For You pick (adds the "watched" action and
  // a fitting title). `onRated` fires only on a real rating (not on skip), so the
  // caller can dismiss the pick from its list.
  const openRatePick = useCallback((name: string, onRated: () => void) => {
    setRatePrompt({ name, showWatched: true, title: "Rate this pick", onRated });
  }, []);
```

- [ ] **Step 3: Extend the RatePrompt render**

Find the RatePrompt render block (lines ~2068-2092) and replace it with:

```tsx
        {ratePrompt ? (
          <Box marginTop={1}>
            <RatePrompt
              width={Math.max(24, Math.min(cols - 4, 62))}
              name={ratePrompt.name}
              title={ratePrompt.title}
              onWatched={
                ratePrompt.showWatched
                  ? () => {
                      if (config) {
                        void postEvent(
                          resolveReccConfig(config),
                          { type: "watched", rawName: ratePrompt.name, ts: Date.now(), source: "torlink" },
                        );
                      }
                      ratePrompt.onRated?.();
                      setRatePrompt(null);
                    }
                  : undefined
              }
              onLike={() => {
                if (config) {
                  void postEvent(
                    resolveReccConfig(config),
                    { type: "liked", rawName: ratePrompt.name, ts: Date.now(), source: "torlink" },
                  );
                }
                ratePrompt.onRated?.();
                setRatePrompt(null);
              }}
              onDislike={() => {
                if (config) {
                  void postEvent(
                    resolveReccConfig(config),
                    { type: "disliked", rawName: ratePrompt.name, ts: Date.now(), source: "torlink" },
                  );
                }
                ratePrompt.onRated?.();
                setRatePrompt(null);
              }}
              onDismiss={() => setRatePrompt(null)}
            />
          </Box>
        ) : null}
```

(Change vs current: adds `title`, adds `onWatched` conditional, and adds `ratePrompt.onRated?.();` before `setRatePrompt(null)` in onLike/onDislike. `onDismiss` deliberately does NOT call `onRated`, so skip keeps the pick. Post-stream usage passes no `onRated`/`showWatched`, so `onRated?.()` is a no-op and no watched action shows.)

- [ ] **Step 4: Pass the new props to `<ForYou>`**

Find the `<ForYou>` render (lines ~2207-2214):

```tsx
              <ForYou
                reccConfig={resolveReccConfig(store.config)}
                visible={section === "forYou"}
                active={store.region === "content" && section === "forYou"}
                setSection={store.setSection}
                submitQuery={store.submitQuery}
                setCaptureMode={store.setCaptureMode}
              />
```

Add two props (leave `active` unchanged — see note):

```tsx
              <ForYou
                reccConfig={resolveReccConfig(store.config)}
                visible={section === "forYou"}
                active={store.region === "content" && section === "forYou"}
                setSection={store.setSection}
                submitQuery={store.submitQuery}
                setCaptureMode={store.setCaptureMode}
                onRatePick={openRatePick}
                toggleSavedSearch={store.toggleSavedSearch}
              />
```

Note: no `&& !ratePrompt` is needed on `active`. The store's `region` field already resolves to `"help"` whenever `ratePrompt` is set (it's in the `region` ternary at `App.tsx:1519` and in the store `useMemo` deps at `App.tsx:1586`), so `store.region === "content"` is already false while the prompt is open, making ForYou's `useInput` inert automatically.

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Full test suite**

Run: `npx vitest run --exclude '**/.claude/**'`
Expected: all tests pass (no regressions).

- [ ] **Step 7: Manual smoke (optional but recommended)**

Run the app (`npm run dev`), open For You (with reccd configured and some picks): press `f` → the "Rate this pick" prompt shows `w watched · l like · d dislike · esc skip`; choosing one dismisses the pick and (with reccd reachable) posts the event; `esc` keeps it. Press `w` on a pick → "Watchlist updated." notice, pick stays, and it appears in the Watchlist sidebar section.

- [ ] **Step 8: Commit**

```bash
git add src/ui/App.tsx
git commit -m "feat: wire For You rate/watchlist actions into App"
```

---

## Task 5: Keymap hints

**Files:**
- Modify: `src/ui/keymap.ts`

- [ ] **Step 1: Update the For You `?` help group**

Find (lines ~59-69):

```ts
  {
    title: "For You",
    hints: [
      { keys: "↑ ↓", label: "Move between picks" },
      { keys: "↵", label: "Search this title" },
      { keys: "t", label: "Cycle movie / TV / all" },
      { keys: "g", label: "Filter by genre" },
      { keys: "e", label: "Toggle explore mode" },
      { keys: "r", label: "Refresh recommendations" },
    ],
  },
```

Replace the `hints` array to add the two new keys (place after the `e` line, before `r`):

```ts
  {
    title: "For You",
    hints: [
      { keys: "↑ ↓", label: "Move between picks" },
      { keys: "↵", label: "Search this title" },
      { keys: "t", label: "Cycle movie / TV / all" },
      { keys: "g", label: "Filter by genre" },
      { keys: "e", label: "Toggle explore mode" },
      { keys: "f", label: "Rate — watched / like / dislike" },
      { keys: "w", label: "Add to watchlist" },
      { keys: "r", label: "Refresh recommendations" },
    ],
  },
```

- [ ] **Step 2: Update the For You footer hints**

Find (lines ~141-152):

```ts
  if (section === "forYou") {
    return [
      NAVIGATE,
      { keys: "↵", label: "Search title" },
      { keys: "t", label: "Type" },
      { keys: "g", label: "Genre" },
      { keys: "e", label: "Explore" },
      { keys: "r", label: "Refresh" },
      SWITCH,
      ALWAYS,
    ];
  }
```

Replace with (add `f` and `w`):

```ts
  if (section === "forYou") {
    return [
      NAVIGATE,
      { keys: "↵", label: "Search title" },
      { keys: "f", label: "Rate" },
      { keys: "w", label: "Watch" },
      { keys: "t", label: "Type" },
      { keys: "g", label: "Genre" },
      { keys: "e", label: "Explore" },
      { keys: "r", label: "Refresh" },
      SWITCH,
      ALWAYS,
    ];
  }
```

- [ ] **Step 3: Type-check + full suite**

Run: `npx tsc --noEmit && npx vitest run --exclude '**/.claude/**'`
Expected: no type errors; all tests pass. (No dedicated keymap test; footer width is terse enough — the `?` sheet carries the full list.)

- [ ] **Step 4: Commit**

```bash
git add src/ui/keymap.ts
git commit -m "docs: For You keymap hints for rate (f) and watchlist (w)"
```

---

## Self-Review Notes

- **Spec coverage:** rate prompt with watched/like/dislike (Tasks 1, 4) ✓; posts correct reccd events (Task 4) ✓; dismiss on rate, not on skip (Tasks 2, 3, 4 — `onRated` only wired to like/dislike/watched, not `onDismiss`) ✓; `w` add-to-watchlist without dismissal (Task 3) ✓; refresh untouched ✓; keymap help + footer (Task 5) ✓; tests for RatePrompt watched, ForYou `f`/`w` (Tasks 1, 3) ✓.
- **Deviation from spec (intentional, simpler):** the spec's step to gate ForYou's `active` prop with `&& !ratePrompt` is omitted — verified unnecessary because `store.region` already becomes `"help"` when `ratePrompt` is set (it's in the region ternary and the memo deps), so ForYou is already inert while the prompt is open. Adding the gate would be redundant.
- **Type consistency:** `onRatePick(name, onRated)` signature matches between ForYou prop (Task 3), the `openRatePick` handler (Task 4), and the ForYou test (Task 3). `dismiss(imdbId)` matches between the hook (Task 2) and its ForYou call site (Task 3). `ratePrompt` shape (`{ name, showWatched?, title?, onRated? }`) is consistent between the state decl and the render (Task 4).
- **Props optionality:** `onRatePick`/`toggleSavedSearch` are optional (like `setCaptureMode`), so the existing ForYou tests that don't pass them still compile; ForYou calls them with `?.`.
- **Line-number caveat:** anchors are quoted exactly; locate by the quoted text if line numbers have shifted.
