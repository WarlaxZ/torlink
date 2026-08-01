# The browser's play flow: make the picker findable, the wait legible, and the wait abortable

## The complaint

Press Play on a season pack in the browser UI while scrolled 500px down a browse, and:

1. The "which episode?" picker opens **at the top of the document**, off screen. Nothing on
   screen says anything happened.
2. There is no busy state on the button that was pressed, so the natural response is to press
   it again — and again.
3. During the wait — which for a Real-Debrid torrent it has never seen is genuinely
   *minutes* — the only progress indicator is `#notice`, a non-sticky `<p>` above `<main>`,
   also off screen.

## The diagnosis: this is parity, not a new feature

`src/ui` already solves all three. The browser is three things behind the terminal, and every
symptom above falls out of exactly one of them:

| | Terminal (`src/ui/App.tsx`) | Browser today |
| --- | --- | --- |
| One prepare/pick at a time | `if (preparing \|\| streamFiles \|\| activeStream) return` — global (`:1317`, `:1445`) | per-`row.id` only (`app.ts:826`), and it **silently returns** |
| Progress while resolving | persistent line, elapsed seconds, per-source wording (`:2384-2391`) | `#notice`, non-sticky, above `<main>` |
| Abort | Escape → `AbortController`; all other keys swallowed (`:2201-2203`) | none — polls to a 10-minute timeout, escapable only by reloading |

This framing decides the CLAUDE.md question. Nothing here needs the "one surface only"
exemption except the *mechanism* for abort — `(esc cancels)` in a terminal versus a Cancel
button in a browser — which is the named "a surface can't express it" case. The feature itself
lands in both, because it is already in one.

No wire changes are required. `PublicStreamSession.backend` is already `"debrid" | "torrent"`
(`src/web/wire.ts:161`) and `app.ts` already holds `debridProvider` from `/api/sources`.

## What is being built

### 1. The picker becomes a modal `<dialog>`

`#picker` today is a `.card` at the top of `<main id="app">` with `display: block`, toggled by
`.hidden`. It becomes `<dialog id="picker">`, opened with `showModal()`.

`showModal()` centres it in the viewport, so where the user is scrolled stops mattering; it
takes focus and Escape for free; and the backdrop makes it unmistakably the thing to answer.

**It moves out of `<main id="app">`** to sit as a sibling of `#notice`. `#app` carries `hidden`
(= `display: none`) until the page loads, and a `<dialog>` inside a `display: none` subtree
will not render at all. Its original placement rationale — "above both panes, so neither
list's re-render replaces it" — is preserved by being a top-level sibling instead.

Three traps, each of which silently breaks a `<dialog>` and so is called out here rather than
discovered in review:

- **`.picker { display: block }` overrides the UA's `dialog:not([open]) { display: none }`**,
  which would leave the closed dialog permanently visible. Scope the rule to `.picker[open]`.
- **Escape closes a `<dialog>` natively and bypasses the `#picker-cancel` click handler** —
  which is where `stopSession` lives, so an Escape would orphan a live session with a torrent
  attached. A `close` listener stops `pickerSession` if it is still set. The
  file-was-chosen path already clears `pickerSession` *before* navigating, so the two cases
  stay distinguishable with no new flag.
- **Drop `hidden` entirely** in favour of `.open` / `showModal()` / `close()`. Mixing the two
  is its own footgun.

`showPicker`'s comment at `app.ts:685-692` argues the picker is inline *because* a second Play
can open a second picker for a different torrent while the first is open. Adopting the
terminal's global one-at-a-time rule (§4) makes that scenario unreachable, so the comment is
**rewritten to say that**, not left as a stale hazard analysis. The load-bearing part of it —
that `infoHash` is a parameter closed over at the call site rather than a module-level
variable — is unchanged and still correct; it costs nothing and remains the right shape.

**A pre-existing leak is fixed on the way.** Today a second `fx.choose` overwrites
`pickerSession` without stopping the previous session, which then runs until the idle reaper
collects it. `showPicker` gains: if `pickerSession` is set and is not this session, stop it.

### 2. A viewport-anchored progress pill, with Cancel

A new fixed element, bottom-**left** (`.to-top` already owns bottom-right at `z-index: 4`;
sharing a corner would overlap them). It shows the terminal's own wording:

```
Caching on Real-Debrid… 42% · 12s          [Cancel]
Finding peers… Harrowgate.S03.1080p · 12s  [Cancel]
```

The line is built by a new **`src/util/prepareLine.ts`**, consumed by *both* front ends. The
terminal builds this string inline at `App.tsx:2388-2391`; writing it a second time in
`src/web` would be the fifth recorded copy-then-drift bug in this codebase, so it moves down
rather than being copied — the same move `resultSort.ts`, `resultFilter.ts`,
`favouriteList.ts` and `savedSearchList.ts` already made.

```ts
export interface PrepareFacts {
  backend: "debrid" | "torrent";
  /** Only meaningful for backend === "debrid"; falls back to "debrid". */
  providerLabel?: string | null;
  /** The release name. Shortened by the caller's own shortName. */
  label: string;
  /** Integer percent, 0-100. Ignored for backend === "torrent". */
  pct: number;
  elapsedSec: number;
}
export function prepareLine(facts: PrepareFacts): string;
```

Each surface appends its own affordance: the terminal `  (esc cancels)`, the browser nothing
(it has a button). That split is the CLAUDE.md exemption, and it is the *only* thing that
differs between them.

`streamFlow.ts`'s `pollDecision` produces this label instead of its current
`Preparing "X" — 42%`, so there is exactly one decision site for what the waiting user reads.
It already receives `elapsedMs`; it gains the provider label as a parameter.

**Accessibility, decided rather than defaulted:** the pill is `role="status"` with
**`aria-live="off"`**. The string changes every second (elapsed seconds move even when the
percent does not), and a live region would talk over the user continuously for minutes.
`#notice` keeps the announceable milestones — started, cancelled, failed, "nothing playable".

### 3. Cancel, threaded through `runPlay`

`runPlay` takes an `AbortSignal`. It is not enough to check a flag between polls:

- it is passed to `fx.start` and `fx.poll`, so an in-flight fetch dies rather than being
  waited out;
- `fx.sleep(ms, signal)` becomes abortable, so a cancel does not wait out the remaining
  `POLL_MS`;
- the loop checks `signal.aborted` at its top.

On abort: `fx.stop(sessionId)` if a session had started, then the notice
`"Stream cancelled."` — the terminal's exact string (`App.tsx:1251`).

**The race that gets its own test:** an abort arriving *after* the `POST /api/stream` succeeded
but before the first poll must still `DELETE` the session. Otherwise cancelling at the worst
moment leaks exactly the resource cancel exists to release.

### 4. Busy state, derived on render, one prepare at a time

Queue rows are rebuilt four times a second by the SSE tick, so busy state can never be set
once on click — it must be **derived at render time** from flow state. New pure module
**`src/web/static/streamBusy.ts`**:

```ts
export interface FlowState {
  /** The row a prepare is running for, or null. */
  prepare: { key: string; title: string } | null;
  /** The title a pickController search is running for, or null. */
  picking: string | null;
}
export interface ControlState { disabled: boolean; busy: boolean; label: string }
export function controlState(flow: FlowState, key: string): ControlState;
```

- The control whose `key` matches the in-flight one: `busy: true`, `disabled: true`, label
  `"preparing…"`.
- **Every other Play control: `disabled: true`.** This is the honest rendering of
  one-at-a-time. An enabled button that silently no-ops is precisely the bug being fixed.
- Nothing in flight: all enabled, label unchanged.

`key` comes from two namespaces — an info hash for the four `play()` sites, a title for the two
`pickController` sites — and that is deliberately harmless: the rule is "the matching control is
busy, every other one is disabled", so a key from the wrong namespace simply never matches and
falls into the disabled branch, which is the correct answer for it anyway. No cross-namespace
comparison is ever made, and no synthetic combined key is invented.

`tagControl` (`app.ts:391`) already stamps `data-row-key` and `data-control`, so the paint is
one pass over `[data-control="play"]` re-applied after every render — not a flag threaded
through six render sites.

Six Play buttons exist and all six are covered. Two of them have **no guard whatever today**
because they go through `pickController`, not `play()`:

| Site | Path | Today |
| --- | --- | --- |
| `app.ts:470` queue row | `play()` | tagged, guarded per-row |
| `app.ts:1648` search result | `play()` | tagged, guarded per-row |
| `app.ts:3036` library row | `play()` | untagged, guarded per-row |
| `app.ts:3080` continue-watching resume | `play()` | untagged, guarded per-row |
| `app.ts:2676` For You `Play` | `pickController.start` | **untagged, unguarded** |
| `app.ts:3100` `Play next` | `pickController.start` | **untagged, unguarded** |

The four untagged sites gain `tagControl`. `pickController`'s existing `PickPhase`
(`pickModel.ts:64`) already distinguishes `searching`; `FlowState.picking` is read from it,
so the two flows share one busy surface instead of two competing ones.

## Deliberately not changing

**The `window.confirm` for the Real-Debrid fallback stays native.** `streamFlow.ts:375` and
`app.ts:804-806` argue synchronous-and-unmissable on purpose, for a consent decision whose
consequence — your IP address in a public swarm — cannot be taken back. Making it a styled
in-page modal makes it dismissable by reflex. This is stated in the PR body so it reads as a
decision rather than an oversight.

**`#notice` keeps its current role and styling** for everything that is not stream progress.
Only the resolving-progress line moves to the pill.

## Files

| File | Change |
| --- | --- |
| `src/util/prepareLine.ts` | **new** — the shared waiting line |
| `src/util/prepareLine.test.ts` | **new** |
| `src/web/static/streamBusy.ts` | **new** — derived control state |
| `src/web/static/streamBusy.test.ts` | **new** |
| `src/web/static/streamFlow.ts` | `AbortSignal` through `runPlay`; `pollDecision` emits `prepareLine` |
| `src/web/static/streamFlow.test.ts` | updated for the new `PlayEffects` shape; new abort tests incl. the start-then-abort race |
| `src/web/static/app.ts` | `<dialog>` wiring, the pill, `tagControl` on four sites, busy paint, orphan-session fix |
| `src/web/static/index.html` | `#picker` → `<dialog>`, moved out of `#app`; the pill element |
| `src/web/static/styles.css` | `.picker[open]`, the pill, backdrop |
| `src/ui/App.tsx` | consume `prepareLine` instead of building it inline |
| `README.md` | the web UI's own limitations list — check "no way to cancel" is no longer true |

## Verification

`npm test`, `npm run typecheck`, `npm run lint`, `npm run build` — the last being the only
check that `src/web/static/` pulled in no `node:*` (`src/util/prepareLine.ts` must import
nothing; that is why it is its own module and not part of a larger util).

Wiring is not reachable by unit test — there is no jsdom here, deliberately — so it is
verified by running it: `npm run dev -- serve --web`, then pressing Play on a season pack
while scrolled down, and cancelling a resolve mid-percent.

Because the terminal's `App.tsx` is touched, the TUI's own prepare line is verified by running
`npm run dev` and starting a stream, not only by its tests.
