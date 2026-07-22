# For You Feedback Design

**Date:** 2026-07-22
**Status:** Approved

## Summary

Add the ability to give reccd feedback on a "For You" recommendation directly
from the pick list: mark it **watched**, **liked**, or **disliked**. Choosing an
action posts the corresponding event to reccd and dismisses the pick from the
list, closing the loop so acting on suggestions improves future recommendations.
Refresh already exists (the `r` key re-fetches) and is unchanged.

## Background

- The For You page (`src/ui/components/ForYou.tsx`) renders `Recommendation`
  items (`{ imdbId, title, year, score, reasons }`) from `useRecommendations`
  (`src/ui/hooks/useRecommendations.ts`). It owns its own `useInput` handler
  (gated `active && configured && !editingGenre`) with keys j/k/↑↓ (move), `t`
  (type), `e` (explore), `g` (genre), `r` (refresh), Enter (search the title).
- reccd already accepts the event types we need via `postEvent`
  (`src/recc/client.ts`): `ReccEventType` includes `watched`, `liked`,
  `disliked` (plus `started`, `favourited`, `unfavourited`, `abandoned`). An
  event is `{ type, rawName, ts, source }`; all torlink call sites use
  `source: "torlink"` and `ts: Date.now()`.
- `RatePrompt` (`src/ui/components/RatePrompt.tsx`) is a small inline modal shown
  after a stream ends: `l` like / `d` dislike / `esc` skip. It's owned by App
  via `ratePrompt` state (`src/ui/App.tsx:250`), rendered at ~2068, and the App
  global `useInput` guards it with `if (ratePrompt) return` (~1638) so the modal
  owns keyboard input while open.
- Today no `watched`/`liked`/`disliked` event is ever emitted from For You.

## Goals

- From a highlighted For You pick, open a prompt to mark it watched / liked /
  disliked, posting the matching reccd event.
- Dismiss the acted-on pick from the list immediately (fire-and-forget events),
  advancing selection to the next pick.
- Reuse the existing `RatePrompt` component and the existing App-owned modal
  input-guarding, so we don't reinvent focus handling.

## Non-Goals (YAGNI)

- Changing refresh (already works via `r`).
- Auto-refetching when the list empties (deferred; user opted for manual `r`).
- Undo of a rating, or any local persistence of dismissed picks.
- Any new reccd endpoint or event type (all already exist).

## Design

### Interaction

- New key **`f`** on For You (mnemonic: feedback) opens the RatePrompt for the
  currently-highlighted pick.
- The prompt shows **`w` watched · `l` like · `d` dislike · `esc` skip** when
  opened from For You.
- Choosing watched/like/dislike:
  1. posts `{ type: "watched" | "liked" | "disliked", rawName: item.title,
     ts: Date.now(), source: "torlink" }` to reccd via `postEvent`,
  2. dismisses that pick from the list (`useRecommendations.dismiss(imdbId)`),
  3. closes the prompt.
- `esc`/skip closes the prompt and leaves the pick in place.

### Component changes

**`RatePrompt`** — add an optional `onWatched?: () => void` prop. When provided,
the prompt renders the `w watched` affordance and handles the `w` key; when
omitted (the existing post-stream caller), behavior is unchanged (like/dislike
only). An optional `title?` prop lets the For You invocation use a heading like
"Rate this pick" instead of the post-stream "How was it?" (default keeps
"How was it?").

**`useRecommendations`** — add `dismiss(imdbId: string)` that removes the item
with that id from `items`. Selection lives in ForYou, so ForYou re-clamps
`selected` after the list shrinks (e.g. via an effect keyed on `items.length`,
mirroring how it already resets selection to 0 on type/explore changes).

**`ForYou`** — add a new prop `onRatePick: (name: string, onRated: () => void) => void`.
The `useInput` handler gains `else if (input === "f")` that, for the selected
item, calls `onRatePick(item.title, () => recs.dismiss(item.imdbId))` (no-op if
there is no selected item).

ForYou's own `useInput` must be inert while the rate prompt is open — otherwise
keys like `r`/`t`/`e` would act on the list underneath the modal. ForYou's
handler is gated by its `active` prop, and App computes that prop, so App will
pass `active={store.region === "content" && section === "forYou" && !ratePrompt}`.
When the prompt opens, `active` flips to false, ForYou's handler goes inert, and
the App-owned RatePrompt (guarded by the existing `if (ratePrompt) return` in the
global handler) owns input exclusively. When the prompt closes, `active` returns
to true.

**`App`** — extend `ratePrompt` state to
`{ name: string; showWatched?: boolean; title?: string; onRated?: () => void } | null`.
- The post-stream call (`src/ui/App.tsx:1004`) stays `setRatePrompt({ name })`
  — unchanged behavior.
- A new handler `openRatePick(name, onRated)` sets
  `setRatePrompt({ name, showWatched: true, title: "Rate this pick", onRated })`,
  passed to `<ForYou onRatePick=...>`.
- The `<ForYou>` `active` prop changes from
  `store.region === "content" && section === "forYou"` to that same expression
  `&& !ratePrompt`, so ForYou's handler is inert while the prompt is open.
- The `<RatePrompt>` render passes `onWatched` only when `showWatched` is true.
  Each of onLike/onDislike/onWatched: post the matching event (as today for
  like/dislike), then call `ratePrompt.onRated?.()`, then `setRatePrompt(null)`.
  `onDismiss` stays `setRatePrompt(null)` (does NOT call `onRated`, so skip keeps
  the pick).

### Data flow

```
ForYou: press `f` on pick P
  → onRatePick(P.title, dismissClosure)                 [prop up to App]
    → App.setRatePrompt({ name, showWatched, title, onRated: dismissClosure })
      → RatePrompt renders (owns input; App global handler guarded)
        → user presses w/l/d
          → App.postEvent(reccConfig, { type, rawName: name, ... })
          → onRated()  ⇒ ForYou/useRecommendations.dismiss(P.imdbId)
          → setRatePrompt(null)
        → user presses esc ⇒ setRatePrompt(null) only (pick kept)
```

## Keymap / Footer

- `keymap.ts` For You `?` group (lines ~59-69): add `{ keys: "f", label: "Rate — watched / like / dislike" }`.
- `keymap.ts` footer hints for `forYou` (lines ~141-152): add `{ keys: "f", label: "Rate" }`.

## Error Handling

`postEvent` is fire-and-forget and swallows all failures (network, non-2xx) — a
reccd outage must never disrupt the UI. Dismissal happens regardless of whether
the event reaches reccd (consistent with the rest of the app's event posting).
If `reccConfig.reccUrl` is unset, `postEvent` no-ops; For You already shows a
setup hint when reccd is unconfigured, so the rate key is only meaningful when
configured (and harmlessly no-ops otherwise).

## Testing

- `ForYou.test.tsx`: pressing `f` on a pick invokes `onRatePick` with the pick's
  title; the provided `onRated` closure dismisses the pick from the list.
- `RatePrompt.test.tsx` (new or extended): with `onWatched` provided, the `w`
  affordance renders and `w` fires `onWatched`; without it, only like/dislike
  render (post-stream behavior preserved).
- `useRecommendations` (via ForYou or a focused test): `dismiss(imdbId)` removes
  the item and selection re-clamps without going out of range.
- App-level wiring is exercised where feasible; if no App test harness exists,
  rely on the component/hook tests plus the type-checker (matching the existing
  test coverage boundary).

## Files

Modified:
- `src/ui/components/ForYou.tsx` (+ `ForYou.test.tsx`)
- `src/ui/hooks/useRecommendations.ts`
- `src/ui/components/RatePrompt.tsx` (+ `RatePrompt.test.tsx`)
- `src/ui/App.tsx`
- `src/ui/keymap.ts`
