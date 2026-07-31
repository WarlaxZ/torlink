# Web Stream Flow Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the browser's play flow findable, legible and abortable — a modal `<dialog>` picker that opens in the viewport, a busy state on every Play button, a viewport-anchored progress pill, and a Cancel that actually stops the session.

**Architecture:** The terminal (`src/ui/App.tsx`) already does all three; the browser is behind on each. Decisions go into pure modules (`src/util/prepareLine.ts`, `src/web/static/streamBusy.ts`, `src/web/static/streamFlow.ts`) where tests can reach them, and `app.ts` stays DOM wiring. The waiting line moves *down* into `src/util` so both front ends share one string.

**Tech Stack:** TypeScript, vitest, Ink (TUI), hand-rolled DOM (`src/web/static`, bundled by tsup with `platform: "browser"`).

**Spec:** `docs/superpowers/specs/2026-07-31-web-stream-flow-parity-design.md`

## Global Constraints

- **No `innerHTML` / `insertAdjacentHTML` / `document.write` / `outerHTML` anywhere in `src/web/static/`.** Every node is `createElement` + `textContent`. Filenames come from whoever uploaded the torrent.
- **`src/web` must not import from `src/ui`**, and `src/util` must import from neither. Lint enforces this.
- **`src/util/prepareLine.ts` must import nothing at all** — it is pulled into a browser bundle. `npm run build` is the only check that `src/web/static/` reaches no `node:*`.
- **Never introduce a real film or show title** into a test, fixture, doc comment or user-facing copy. Use only: `Kestrel.2010.1080p.BluRay.x264`, `Ashfall.1999.1080p`, `Tin.Rivers.2024.2160p.WEB-DL.DV.HDR.Atmos.7.1-GROUP`, `Kepler.S02E04.1080p.WEB-DL`, `Harrowgate.S03.1080p.WEB-DL`.
- **Conventional Commits.** Each task ends in one commit.
- **Before saying done:** `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`. One known pre-existing lint warning (`react-hooks/exhaustive-deps`, `src/ui/App.tsx`) — leave it.
- The cancel notice string is exactly `"Stream cancelled."` — the terminal's own (`src/ui/App.tsx:1251`).

---

### Task 1: The shared waiting line

The terminal builds this string inline at `src/ui/App.tsx:2386-2393`. It moves down to `src/util` so the browser can use the same one; writing it a second time in `src/web` would be the fifth recorded copy-then-drift bug in this repo.

**Files:**
- Create: `src/util/prepareLine.ts`
- Create: `src/util/prepareLine.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `PrepareFacts` (interface), `prepareLine(facts: PrepareFacts): string`.

- [ ] **Step 1: Write the failing test**

Create `src/util/prepareLine.test.ts`. The first three assertions are the *exact* strings the TUI renders today, minus its `  (esc cancels)` suffix — that is what makes Task 2 provably behaviour-preserving.

```ts
import { describe, expect, it } from "vitest";
import { prepareLine } from "./prepareLine";

describe("prepareLine", () => {
  // The three strings src/ui/App.tsx:2386-2393 built inline before this module
  // existed. They are asserted verbatim so Task 2's swap cannot change what the
  // terminal renders.
  it("says who is caching and how far along, for a debrid resolve", () => {
    expect(
      prepareLine({
        source: "rd",
        phase: "caching",
        providerLabel: "Real-Debrid",
        label: "Harrowgate.S03.1080p.WEB-DL",
        pct: 42,
        elapsedSec: 12,
      }),
    ).toBe("Caching on Real-Debrid… 42% · 12s");
  });

  it("names the release while looking for peers, where there is no percent to give", () => {
    expect(
      prepareLine({
        source: "torrent",
        phase: "caching",
        label: "Kestrel.2010.1080p.BluRay.x264",
        pct: 0,
        elapsedSec: 3,
      }),
    ).toBe("Finding peers… Kestrel.2010.1080p.BluRay.x264 · 3s");
  });

  it("says only how long it has been fetching a link, which has no percent either", () => {
    expect(
      prepareLine({
        source: "rd",
        phase: "fetching",
        providerLabel: "TorBox",
        label: "Ashfall.1999.1080p",
        pct: 0,
        elapsedSec: 7,
      }),
    ).toBe("Fetching link… 7s");
  });

  it("falls back to a generic provider name rather than rendering 'undefined'", () => {
    const line = prepareLine({
      source: "rd",
      phase: "caching",
      label: "Ashfall.1999.1080p",
      pct: 5,
      elapsedSec: 1,
    });
    expect(line).toBe("Caching on debrid… 5% · 1s");
    expect(line).not.toContain("undefined");
    expect(line).not.toContain("null");
  });

  // Floors rather than rounds, for the reason dashboard.ts gives: rounding 99.6
  // up to 100 on something still working reads as a stuck UI.
  it("clamps and floors a nonsense percent instead of rendering it", () => {
    const at = (pct: number): string =>
      prepareLine({ source: "rd", phase: "caching", providerLabel: "RD", label: "n", pct, elapsedSec: 0 });
    expect(at(140)).toContain("100%");
    expect(at(-3)).toContain("0%");
    expect(at(Number.NaN)).toContain("0%");
    expect(at(99.7)).toContain("99%");
  });

  it("clamps a nonsense elapsed time the same way", () => {
    const at = (elapsedSec: number): string =>
      prepareLine({ source: "torrent", phase: "caching", label: "n", pct: 0, elapsedSec });
    expect(at(-1)).toContain("· 0s");
    expect(at(Number.NaN)).toContain("· 0s");
    expect(at(12.9)).toContain("· 12s");
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run src/util/prepareLine.test.ts`
Expected: FAIL — `Failed to resolve import "./prepareLine"`.

- [ ] **Step 3: Write the implementation**

Create `src/util/prepareLine.ts`:

```ts
// What a user waiting for a stream to resolve reads, for both front ends.
//
// This lived inline in src/ui/App.tsx's render (a three-armed ternary in a
// <Spinner label>) until the browser needed the same line. It moved down here
// rather than being written a second time: this codebase records four bugs
// caused by copy-then-drift — a byte formatter, an uploadSpeed field, a
// progress unit, an API path table — and a waiting line the two front ends
// disagree about is the same bug in a place the user is staring at for minutes.
//
// IMPORTS NOTHING, and must keep importing nothing: it is pulled into
// src/web/static's browser bundle (platform: "browser" in tsup.web.config.ts),
// where a transitive `node:*` fails the build. That is also why it is its own
// module rather than a function in a larger util.
//
// The affordance is NOT part of the line. The terminal appends
// "  (esc cancels)" and the browser puts a Cancel button next to it — a
// keybinding hint is CLAUDE.md's "a surface can't express it", and it is the
// only thing about this line that differs between the two.

export interface PrepareFacts {
  /**
   * Which network is resolving this. Spelled "rd" rather than "debrid" because
   * these field names are the TUI's `preparing` state verbatim, so its call
   * site is a spread and cannot silently mismatch. The browser's wire form is
   * `PublicStreamSession.backend`, which spells the same thing "debrid" — the
   * one mapping between them lives in streamFlow.ts's pollDecision.
   */
  source: "rd" | "torrent";
  /** Ignored when `source` is "torrent", which has no link-fetch step. */
  phase: "caching" | "fetching";
  /** Only meaningful when caching on debrid. Absent falls back to "debrid". */
  providerLabel?: string | null;
  /** The release name, already shortened by the caller. */
  label: string;
  /** Integer percent, 0-100. Clamped here rather than by callers. */
  pct: number;
  elapsedSec: number;
}

/**
 * The waiting line, without any affordance appended.
 *
 * The elapsed seconds are load-bearing, not decoration: a Real-Debrid cache
 * sits at one percent for minutes at a time, and a number that moves is the
 * whole difference between "working" and "hung".
 */
export function prepareLine(facts: PrepareFacts): string {
  const secs = `${whole(facts.elapsedSec, 0)}s`;
  if (facts.source === "torrent") return `Finding peers… ${facts.label} · ${secs}`;
  if (facts.phase === "fetching") return `Fetching link… ${secs}`;
  const who = facts.providerLabel ?? "debrid";
  return `Caching on ${who}… ${whole(facts.pct, 100)}% · ${secs}`;
}

// Defended against a backend reporting something outside its documented range,
// and against a NaN — `Math.floor(NaN)` is NaN, which would render the word
// "NaN" at the user. Floors rather than rounds: see dashboard.ts's same rule.
function whole(value: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(max, Math.floor(value)));
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx vitest run src/util/prepareLine.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/util/prepareLine.ts src/util/prepareLine.test.ts
git commit -m "feat(util): share the stream-preparing line between both front ends"
```

---

### Task 2: The terminal consumes it

Behaviour-preserving by construction — Task 1 asserts the three strings verbatim.

**Files:**
- Modify: `src/ui/App.tsx:2386-2393`

**Interfaces:**
- Consumes: `prepareLine` from Task 1.
- Produces: nothing new.

- [ ] **Step 1: Check the current render, so the swap is provably like-for-like**

Run: `sed -n 2384,2396p src/ui/App.tsx`

You should see a `<Spinner label={…}>` with a three-armed ternary. Confirm the `preparing` state's fields (`src/ui/App.tsx:320-330`) are `label`, `phase`, `pct`, `source`, `providerLabel?` — they match `PrepareFacts` exactly, which is why the call below is a spread.

- [ ] **Step 2: Add the import**

Add to the `src/util` imports near the top of `src/ui/App.tsx` (match the surrounding import style; find the existing block with `grep -n 'from "../util/' src/ui/App.tsx | head -3`):

```tsx
import { prepareLine } from "../util/prepareLine";
```

- [ ] **Step 3: Replace the inline ternary**

Replace the whole `<Spinner label={…} />` element at `src/ui/App.tsx:2386-2394` with:

```tsx
            <Spinner
              // The line itself is shared with the browser (src/util/prepareLine.ts)
              // so the two front ends cannot drift on what a waiting user reads.
              // The key hint is appended here and only here: the browser has a
              // Cancel button in its place.
              label={`${prepareLine({ ...preparing, elapsedSec: prepElapsed })}  (esc cancels)`}
            />
```

- [ ] **Step 4: Verify the terminal still typechecks and its tests pass**

Run: `npx tsc --noEmit -p tsconfig.json && npx vitest run src/ui`
Expected: PASS. If `tsc` complains that `preparing` has extra fields, that is a spread supplying more than `PrepareFacts` declares — allowed for a spread of a variable (excess-property checks apply only to object literals). If it complains about a *missing* field, the `preparing` state shape has changed since this plan was written: pass the fields explicitly instead of spreading.

- [ ] **Step 5: Commit**

```bash
git add src/ui/App.tsx
git commit -m "refactor(ui): build the preparing line from the shared helper"
```

---

### Task 3: `pollDecision` speaks the shared line

**Files:**
- Modify: `src/web/static/streamFlow.ts` (`pollDecision`, and delete `resolvePercent`)
- Modify: `src/web/static/streamFlow.test.ts` (the `pollDecision` describe block, `src/web/static/streamFlow.test.ts:256-306`)

**Interfaces:**
- Consumes: `prepareLine` from Task 1.
- Produces: `pollDecision(session: PublicStreamSession, elapsedMs: number, name: string, providerLabel?: string | null): PollDecision` — one new trailing optional parameter. `PollDecision` itself is unchanged.

- [ ] **Step 1: Write the failing tests**

In `src/web/static/streamFlow.test.ts`, replace the three tests named `"shows the percent the session reports, so it doesn't look hung"`, `"clamps a nonsense percent rather than rendering it"` and `"clips a very long name for the notice"` with these. Note the `session` helper defaults to `backend: "torrent"` (`src/web/static/streamFlow.test.ts:32`), so a debrid case must say so.

```ts
  it("names the provider and the percent for a debrid resolve", () => {
    const d = pollDecision(
      session({ state: "resolving", backend: "debrid", progress: 42 }),
      12_000,
      "Harrowgate.S03.1080p.WEB-DL",
      "Real-Debrid",
    );
    expect(d.kind).toBe("poll");
    if (d.kind !== "poll") return;
    expect(d.label).toBe("Caching on Real-Debrid… 42% · 12s");
    expect(d.delayMs).toBe(POLL_MS);
  });

  it("names the release, not a percent, while finding peers in a swarm", () => {
    const d = pollDecision(
      session({ state: "resolving", backend: "torrent", progress: 42 }),
      3_000,
      "Kestrel.2010.1080p.BluRay.x264",
    );
    expect(d.kind).toBe("poll");
    if (d.kind !== "poll") return;
    expect(d.label).toBe("Finding peers… Kestrel.2010.1080p.BluRay.x264 · 3s");
  });

  // The elapsed seconds are what tell a user that a resolve sitting at one
  // percent for minutes is working rather than hung. Deleting them is the
  // mutation this guards.
  it("counts the seconds up, so a stalled percent still shows movement", () => {
    const at = (ms: number): string => {
      const d = pollDecision(session({ state: "resolving", backend: "debrid", progress: 7 }), ms, "n", "RD");
      return d.kind === "poll" ? d.label : "";
    };
    expect(at(0)).toContain("· 0s");
    expect(at(1_000)).toContain("· 1s");
    expect(at(65_400)).toContain("· 65s");
  });

  it("clamps a nonsense percent rather than rendering it", () => {
    const at = (progress: number): string => {
      const d = pollDecision(session({ state: "resolving", backend: "debrid", progress }), 0, "n", "RD");
      return d.kind === "poll" ? d.label : "";
    };
    expect(at(140)).toContain("100%");
    expect(at(-3)).toContain("0%");
    expect(at(Number.NaN)).toContain("0%");
    expect(at(99.7)).toContain("99%");
  });

  // Asserts the TRUNCATED name is present, not merely that some "…" is: every
  // line prepareLine produces contains an ellipsis of its own ("Finding peers…"),
  // so `toContain("…")` would pass while the name went unclipped. That is the
  // vacuous-assertion trap CLAUDE.md records.
  it("clips a very long name for the waiting line", () => {
    const long = "x".repeat(300);
    const d = pollDecision(session({ state: "resolving", backend: "torrent" }), 0, long);
    expect(d.kind).toBe("poll");
    if (d.kind !== "poll") return;
    expect(d.label).not.toContain(long);
    expect(d.label).toContain(`${"x".repeat(79)}…`);
  });
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx vitest run src/web/static/streamFlow.test.ts -t pollDecision`
Expected: FAIL — the labels read `Preparing "…" — 42%`, not the new strings.

- [ ] **Step 3: Implement**

In `src/web/static/streamFlow.ts`, add the import beside the existing `../../util/*` imports:

```ts
// The sixth value import out of this directory, and the same argument as the
// other five: what a waiting user reads is a decision both front ends make, so
// it is shared rather than written twice. See src/util/prepareLine.ts.
import { prepareLine } from "../../util/prepareLine";
```

Replace `pollDecision`'s signature and its `poll` return with:

```ts
export function pollDecision(
  session: PublicStreamSession,
  elapsedMs: number,
  name: string,
  providerLabel?: string | null,
): PollDecision {
  if (session.state !== "resolving") return { kind: "settled" };
  const label = shortName(name);
  if (elapsedMs >= RESOLVE_TIMEOUT_MS) {
    return {
      kind: "timeout",
      message: `Gave up waiting for “${label}” to be ready. It may still be caching — try again in a few minutes.`,
    };
  }
  return {
    kind: "poll",
    delayMs: POLL_MS,
    // `phase: "caching"` unconditionally: the wire has one `resolving` state
    // and no way to distinguish the provider's link-fetch step from its cache,
    // so the browser never renders prepareLine's "Fetching link…" arm. The TUI
    // does, from its own richer local state. Reporting a percent of 0 as
    // "Caching… 0%" is honest for that moment; inventing a phase would not be.
    label: prepareLine({
      source: session.backend === "debrid" ? "rd" : "torrent",
      phase: "caching",
      providerLabel,
      label,
      pct: session.progress,
      elapsedSec: elapsedMs / 1000,
    }),
  };
}
```

Then **delete** the now-unused `resolvePercent` function and its comment block at the bottom of `src/web/static/streamFlow.ts` — `prepareLine` owns the clamp now. Verify nothing else calls it:

```bash
grep -rn "resolvePercent" src/
```

Expected: no hits after the deletion.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run src/web/static/streamFlow.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: PASS. The `runPlay` test at `src/web/static/streamFlow.test.ts:575` (`"keeps polling while the session is resolving, and shows the percent"`) may also assert on the old label — if it fails, update its expectation to the new string; do not weaken it to a substring match.

- [ ] **Step 5: Commit**

```bash
git add src/web/static/streamFlow.ts src/web/static/streamFlow.test.ts
git commit -m "feat(web): report a resolve with the terminal's own waiting line"
```

---

### Task 4: `runPlay` gains an abort signal and a progress channel

Two changes to one contract, so one task: the third positional parameter becomes an options bag (it was `wanted?`, and there are now three things to pass), and progress gets its own effect so the pill and the notice line stop competing for `fx.notice`.

**Files:**
- Modify: `src/web/static/streamFlow.ts` (`PlayEffects`, `runPlay`)
- Modify: `src/web/static/streamFlow.test.ts` (the `harness` helper at `src/web/static/streamFlow.test.ts:448-489`, every `runPlay(row(), fx, wanted)` call site, plus new abort tests)

**Interfaces:**
- Consumes: `pollDecision` from Task 3.
- Produces:
  - `PlayEffects.start(row: DashRow, confirmed: boolean, signal?: AbortSignal): Promise<StartResult>`
  - `PlayEffects.poll(sessionId: string, signal?: AbortSignal): Promise<PublicStreamSession | null>`
  - `PlayEffects.sleep(ms: number, signal?: AbortSignal): Promise<void>`
  - `PlayEffects.progress(line: string | null): void` — **required**, so forgetting it cannot leave a pill on screen forever
  - `PlayOptions { wanted?: EpisodeRef | null; providerLabel?: string | null; signal?: AbortSignal }`
  - `runPlay(row: DashRow, fx: PlayEffects, opts?: PlayOptions): Promise<void>`
  - `CANCELLED_NOTICE = "Stream cancelled."`

- [ ] **Step 1: Write the failing tests**

First update the `harness` helper in `src/web/static/streamFlow.test.ts` (at `:448`) to record the two new effects — add to `calls`:

```ts
    progress: [] as (string | null)[],
    slept: [] as { ms: number; aborts: boolean }[],
```

and to `fx`:

```ts
    progress: (line) => calls.progress.push(line),
```

and replace its `sleep` with one that records whether it was handed a signal:

```ts
    sleep: async (ms, signal) => {
      calls.slept.push({ ms, aborts: signal !== undefined });
      clock += ms;
    },
```

Then add this block at the end of `describe("runPlay", …)`:

```ts
  describe("cancelling", () => {
    // A resolve can run for ten minutes. Before this there was no way out of
    // one but reloading the page, which orphaned the session either way.
    it("does not start anything at all when already aborted", async () => {
      const ac = new AbortController();
      ac.abort();
      const { fx, calls } = harness({ start: async () => started({ files: [file("movie.mp4", 0)] }) });
      await runPlay(row(), fx, { signal: ac.signal });
      expect(calls.starts).toEqual([]);
      expect(calls.opened).toEqual([]);
      expect(calls.notices).toEqual(["Stream cancelled."]);
    });

    // THE RACE THAT MATTERS. An abort landing after the POST succeeded but
    // before the first poll must still DELETE the session — otherwise
    // cancelling at the worst possible moment leaks the exact resource that
    // cancelling exists to release, and the torrent runs until the idle reaper.
    it("stops the session when the abort lands after it was started", async () => {
      const ac = new AbortController();
      const { fx, calls } = harness({
        start: async () => {
          ac.abort();
          return started({ state: "resolving", progress: 0 });
        },
      });
      await runPlay(row(), fx, { signal: ac.signal });
      expect(calls.stopped).toEqual(["s1"]);
      expect(calls.notices).toContain("Stream cancelled.");
      expect(calls.polls).toBe(0);
      expect(calls.opened).toEqual([]);
    });

    it("stops polling and releases the session when cancelled mid-resolve", async () => {
      const ac = new AbortController();
      let polls = 0;
      const { fx, calls } = harness({
        start: async () => started({ state: "resolving", progress: 10 }),
        poll: async () => {
          polls++;
          if (polls === 2) ac.abort();
          return session({ state: "resolving", progress: 10 + polls });
        },
      });
      await runPlay(row(), fx, { signal: ac.signal });
      expect(polls).toBe(2);
      expect(calls.stopped).toEqual(["s1"]);
      expect(calls.notices).toContain("Stream cancelled.");
    });

    it("hands the signal to start, poll and sleep, so an in-flight fetch dies too", async () => {
      const ac = new AbortController();
      const seen: { start?: boolean; poll?: boolean } = {};
      let polls = 0;
      const { fx, calls } = harness({
        start: async (_row, _confirmed, signal) => {
          seen.start = signal === ac.signal;
          return started({ state: "resolving", progress: 0 });
        },
        poll: async (_id, signal) => {
          seen.poll = signal === ac.signal;
          polls++;
          return polls === 1 ? session({ state: "resolving" }) : session({ files: [file("movie.mp4", 0)] });
        },
      });
      await runPlay(row(), fx, { signal: ac.signal });
      expect(seen.start).toBe(true);
      expect(seen.poll).toBe(true);
      expect(calls.slept.every((s) => s.aborts)).toBe(true);
    });
  });

  describe("progress", () => {
    it("reports the waiting line on its own channel, not as a notice", async () => {
      let polls = 0;
      const { fx, calls } = harness({
        start: async () => started({ state: "resolving", backend: "debrid", progress: 40 }),
        poll: async () => {
          polls++;
          return polls === 1
            ? session({ state: "resolving", backend: "debrid", progress: 60 })
            : session({ files: [file("movie.mp4", 0)] });
        },
      });
      await runPlay(row(), fx, { providerLabel: "Real-Debrid" });
      expect(calls.progress[0]).toBe("Caching on Real-Debrid… 40% · 0s");
      expect(calls.notices).toEqual([]);
    });

    // The pill must come down however the flow ends, or it sits over the page
    // for good. Asserted for a success, a failure and a cancel.
    it("clears the waiting line however the flow ends", async () => {
      const ok = harness({ start: async () => started({ files: [file("movie.mp4", 0)] }) });
      await runPlay(row(), ok.fx);
      expect(ok.calls.progress.at(-1)).toBeNull();

      const bad = harness({ start: async () => started({ state: "error", error: "no peers" }) });
      await runPlay(row(), bad.fx);
      expect(bad.calls.progress.at(-1)).toBeNull();

      const ac = new AbortController();
      ac.abort();
      const off = harness();
      await runPlay(row(), off.fx, { signal: ac.signal });
      expect(off.calls.progress.at(-1)).toBeNull();
    });
  });
```

Finally, update the existing `wanted` call sites to the options bag. Find them:

```bash
grep -n "runPlay(row(), fx, " src/web/static/streamFlow.test.ts
```

Each `runPlay(row(), fx, someWanted)` becomes `runPlay(row(), fx, { wanted: someWanted })`.

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx vitest run src/web/static/streamFlow.test.ts`
Expected: FAIL — `progress` is not a property of `PlayEffects`, and `runPlay`'s third argument is not an object.

- [ ] **Step 3: Implement**

In `src/web/static/streamFlow.ts`, add to `PlayEffects` (and change the three existing members' signatures):

```ts
  /** POST /api/stream. `confirmed` is only ever true after a human said so. */
  start(row: DashRow, confirmed: boolean, signal?: AbortSignal): Promise<StartResult>;
  /** GET /api/stream/:sid, or null when it can't be read. */
  poll(sessionId: string, signal?: AbortSignal): Promise<PublicStreamSession | null>;
  /**
   * The waiting line, or null to take it down.
   *
   * A SEPARATE CHANNEL FROM `notice`, deliberately. `notice` is a transient
   * line that hides itself after a few seconds; this one has to persist for as
   * long as the resolve does, which can be minutes, and it has a Cancel button
   * attached. Sharing one effect meant the progress label re-firing every
   * second stamped over any real message the user needed to read.
   *
   * REQUIRED, not optional: an implementation that forgets it would leave a
   * pill fixed over the page for good.
   */
  progress(line: string | null): void;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
```

Add above `runPlay`:

```ts
/**
 * The one wording for a cancelled stream, shared with the TUI's own
 * `cancelPreparing` (src/ui/App.tsx:1251) by being the same string.
 */
export const CANCELLED_NOTICE = "Stream cancelled.";

/**
 * The three things `runPlay` needs that are DATA rather than effects.
 *
 * An options bag rather than three positional parameters: `wanted` was the
 * third argument and the other two would make a call site read
 * `runPlay(row, fx, null, "Real-Debrid", signal)`, where transposing two
 * arguments typechecks and silently plays the wrong episode.
 */
export interface PlayOptions {
  /** A Continue-watching row's own suggested episode. See wantedEpisodeFor. */
  wanted?: EpisodeRef | null;
  /** Who is caching, for the waiting line. Absent renders "debrid". */
  providerLabel?: string | null;
  /**
   * Cancels the flow. Threaded into `start`, `poll` and `sleep` rather than
   * merely checked between them, so a cancel kills an in-flight fetch instead
   * of waiting it out — and, crucially, a session that HAD started is stopped
   * on the way out (see the abort tests).
   */
  signal?: AbortSignal;
}
```

Rewrite `runPlay`:

```ts
export async function runPlay(
  row: DashRow,
  fx: PlayEffects,
  opts: PlayOptions = {},
): Promise<void> {
  const { wanted, providerLabel, signal } = opts;

  // Every exit from here down goes through one of these two, so the waiting
  // line cannot be left up by a path someone forgot about.
  const done = (): void => fx.progress(null);
  const cancel = (sessionId: string | null): void => {
    if (sessionId) fx.stop(sessionId);
    done();
    fx.notice(CANCELLED_NOTICE);
  };

  if (signal?.aborted) {
    cancel(null);
    return;
  }

  let start = await fx.start(row, false, signal);

  if (start.kind === "confirm") {
    if (!fx.confirm(confirmFallbackMessage(start.reason, row.name))) {
      done();
      fx.notice("Playback cancelled — nothing was streamed.");
      return;
    }
    start = await fx.start(row, true, signal);
    // A second 409 means the server didn't accept the confirmation. Do not loop
    // asking: one prompt per click.
    if (start.kind === "confirm") {
      done();
      fx.notice("Couldn't start that stream.");
      return;
    }
  }
  if (start.kind !== "started") {
    done();
    if (start.kind === "failed") fx.onUnresolved?.();
    return;
  }

  const { sessionId, capability } = start;
  // From here on a session EXISTS, so every early return owes it a stop —
  // including an abort. This is the leak the "abort lands after it was
  // started" test guards.
  if (signal?.aborted) {
    cancel(sessionId);
    return;
  }

  let session = start.session;
  const began = fx.now();
  for (;;) {
    const decision = pollDecision(session, fx.now() - began, row.name, providerLabel);
    if (decision.kind === "settled") break;
    if (decision.kind === "timeout") {
      done();
      fx.notice(decision.message);
      fx.stop(sessionId);
      return;
    }
    fx.progress(decision.label);
    await fx.sleep(decision.delayMs, signal);
    if (signal?.aborted) {
      cancel(sessionId);
      return;
    }
    const next = await fx.poll(sessionId, signal);
    if (!next) {
      // An aborted fetch also lands here, and must not be reported as a
      // transport failure — the user asked for this.
      if (signal?.aborted) {
        cancel(sessionId);
        return;
      }
      // The session is gone or unreadable. Not stopped here: a DELETE we can't
      // read the answer to adds nothing, and the id may not exist at all.
      done();
      fx.notice("Lost track of that stream — try again.");
      return;
    }
    session = next;
  }

  done();

  const outcome = streamOutcome(session, wanted);
  if (outcome.kind === "error") {
    // Already worded for a human by the core, which reuses the TUI's strings.
    fx.notice(outcome.message);
    fx.stop(sessionId);
    return;
  }
  if (outcome.kind === "empty") {
    fx.notice("There is nothing playable in that torrent.");
    fx.stop(sessionId);
    return;
  }
  if (outcome.kind === "single") {
    fx.open(playerPath(sessionId, outcome.file, capability));
    return;
  }
  fx.choose(sessionId, capability, row.name, outcome.files, outcome.preselect);
}
```

Also update `runPlay`'s doc comment: replace the paragraph beginning "`wanted` is data, not an effect" with one describing `PlayOptions` and adding a third numbered rule:

```
 * 3. A CANCEL RELEASES THE SESSION. Every exit after `start` succeeded stops
 *    the session, an abort included — a cancel that leaked the torrent would
 *    be worse than no cancel, because the user believes they stopped it.
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run src/web/static/streamFlow.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: PASS. `tsc` will now flag `app.ts`'s `runPlay` call (it passes `wanted` positionally and has no `progress`) — that is Task 7's job. If you want a green tree at this commit, apply the two-line stopgap in Step 5.

- [ ] **Step 5: Keep `app.ts` compiling, then commit**

`app.ts` must typecheck at every commit. Apply the minimal stopgap in `src/web/static/app.ts`'s `play()`: add `progress: showNotice` beside `notice: showNotice` in the effects object (temporary — Task 7 replaces it with the pill), and change the trailing `}, wanted);` to `}, { wanted });`.

```bash
npx tsc --noEmit -p tsconfig.json && npx vitest run src/web/static/
git add src/web/static/streamFlow.ts src/web/static/streamFlow.test.ts src/web/static/app.ts
git commit -m "feat(web): let a resolve be cancelled, and report progress on its own channel"
```

---

### Task 5: Derived busy state

**Files:**
- Create: `src/web/static/streamBusy.ts`
- Create: `src/web/static/streamBusy.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `FlowState`, `ControlState`, `BUSY_LABEL`, `controlState(flow: FlowState, key: string, idleLabel: string): ControlState`, `isBusy(flow: FlowState): boolean`.

- [ ] **Step 1: Write the failing test**

Create `src/web/static/streamBusy.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { BUSY_LABEL, controlState, isBusy, type FlowState } from "./streamBusy";

const idle: FlowState = { prepare: null, picking: null };
const preparing: FlowState = { prepare: { key: "abc", title: "Harrowgate.S03.1080p.WEB-DL" }, picking: null };
const picking: FlowState = { prepare: null, picking: "Kestrel" };

describe("controlState", () => {
  it("leaves every control alone when nothing is in flight", () => {
    expect(controlState(idle, "abc", "play")).toEqual({ disabled: false, busy: false, label: "play" });
    expect(controlState(idle, "Kestrel", "Play next")).toEqual({
      disabled: false,
      busy: false,
      label: "Play next",
    });
  });

  it("marks the control that started the flow as busy", () => {
    expect(controlState(preparing, "abc", "play")).toEqual({
      disabled: true,
      busy: true,
      label: BUSY_LABEL,
    });
  });

  // The point of the whole module. A Play button that stays enabled while a
  // prepare runs, and silently does nothing when pressed, is what taught users
  // to hammer it — one prepare at a time is the terminal's rule
  // (src/ui/App.tsx:1317) and this is it, rendered.
  it("disables every OTHER control rather than letting it no-op silently", () => {
    expect(controlState(preparing, "def", "play")).toEqual({
      disabled: true,
      busy: false,
      label: "play",
    });
    expect(controlState(preparing, "Kestrel", "Play")).toEqual({
      disabled: true,
      busy: false,
      label: "Play",
    });
  });

  it("treats a pick search exactly as it treats a prepare", () => {
    expect(controlState(picking, "Kestrel", "Play")).toEqual({
      disabled: true,
      busy: true,
      label: BUSY_LABEL,
    });
    expect(controlState(picking, "abc", "play")).toEqual({
      disabled: true,
      busy: false,
      label: "play",
    });
  });

  // A pick hands off to a prepare, so both can be set for one tick. The row
  // actually resolving is the more specific truth and wins; without this the
  // title's button would claim to be busy while the row's did the work.
  it("prefers the prepare when a pick has already handed off to one", () => {
    const both: FlowState = { prepare: { key: "abc", title: "Kestrel" }, picking: "Kestrel" };
    expect(controlState(both, "abc", "play").busy).toBe(true);
    expect(controlState(both, "Kestrel", "Play")).toEqual({
      disabled: true,
      busy: false,
      label: "Play",
    });
  });

  // Info hashes and titles are two namespaces and are never compared across.
  // A key from the wrong one simply never matches, which lands it in the
  // disabled branch — the correct answer for it anyway.
  it("never mistakes a title for an info hash", () => {
    expect(controlState(preparing, "Harrowgate.S03.1080p.WEB-DL", "Play").busy).toBe(false);
  });
});

describe("isBusy", () => {
  it("is the one-at-a-time gate the terminal has and the browser did not", () => {
    expect(isBusy(idle)).toBe(false);
    expect(isBusy(preparing)).toBe(true);
    expect(isBusy(picking)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run src/web/static/streamBusy.test.ts`
Expected: FAIL — `Failed to resolve import "./streamBusy"`.

- [ ] **Step 3: Write the implementation**

Create `src/web/static/streamBusy.ts`:

```ts
// Whether a Play control is busy, disabled, or neither — and the one gate that
// stops a second stream starting while the first is still resolving.
//
// Pure, and here rather than in app.ts for the reason every model in this
// directory is: there is no jsdom in this repo, so a conditional that lives in
// app.ts is a conditional no test can reach. "If you are writing a conditional
// in app.ts that decides what to show, it belongs in a pure module" — CLAUDE.md,
// and this has been caught in review twice.
//
// DERIVED, NEVER STORED ON THE ELEMENT. The queue's rows are rebuilt four times
// a second by the SSE tick, so a `disabled` set once on click is gone by the
// next frame. app.ts re-applies this over the live DOM after every render.

export interface FlowState {
  /**
   * The row a prepare is running for, or null. `key` is the info hash — the
   * same `DashRow.id` that `runPlay` was handed, so the two cannot disagree
   * about which row is busy.
   */
  prepare: { key: string; title: string } | null;
  /**
   * The title a pickController search is running for, or null. A TITLE, not a
   * hash: a one-click Play on a recommendation has no torrent yet, which is
   * exactly what it is off finding.
   */
  picking: string | null;
}

export interface ControlState {
  disabled: boolean;
  /** Render `aria-busy` and a spinner. Exactly one control can be busy. */
  busy: boolean;
  label: string;
}

/** What the control that started the flow says while it waits. */
export const BUSY_LABEL = "preparing…";

/**
 * What one Play control should look like right now.
 *
 * The rule is the terminal's, made visible: ONE prepare or pick at a time
 * (`if (preparing || streamFiles || activeStream) return` — src/ui/App.tsx:1317
 * and :1445). The browser had the same rule per-row and silently returned when
 * it fired, so a button stayed lit and did nothing when pressed — which is how
 * a user learns to press it repeatedly, starting nothing each time. So every
 * control that is not the busy one is DISABLED, not merely ineligible.
 *
 * `idleLabel` is passed in rather than assumed because the six Play controls do
 * not share one word: "play", "Play", "Play next". Nothing here decides copy.
 */
export function controlState(flow: FlowState, key: string, idleLabel: string): ControlState {
  // The prepare wins when both are set: a pick that has found its release and
  // handed off is now a prepare, and the row doing the work is the truer answer
  // than the title that asked for it.
  const active = flow.prepare?.key ?? flow.picking;
  if (active === null || active === undefined) {
    return { disabled: false, busy: false, label: idleLabel };
  }
  // Two namespaces (info hashes, titles) and no comparison across them: a key
  // from the other one never matches, and disabled is the right answer for it.
  if (active === key) return { disabled: true, busy: true, label: BUSY_LABEL };
  return { disabled: true, busy: false, label: idleLabel };
}

/**
 * Whether a new play or pick may start at all.
 *
 * The browser's guard was `playing.has(row.id)` — per-row, so two different
 * rows could resolve at once, each polling a session for up to ten minutes,
 * with one shared progress line between them reporting whichever wrote last.
 */
export function isBusy(flow: FlowState): boolean {
  return flow.prepare !== null || flow.picking !== null;
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx vitest run src/web/static/streamBusy.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/web/static/streamBusy.ts src/web/static/streamBusy.test.ts
git commit -m "feat(web): derive the Play buttons' busy state from one flow state"
```

---

### Task 6: The picker becomes a modal `<dialog>`

**Files:**
- Modify: `src/web/static/index.html:63-79` (move `#picker` out of `<main>`, make it a `<dialog>`)
- Modify: `src/web/static/styles.css:370-372` (`.picker`), plus a `::backdrop`
- Modify: `src/web/static/app.ts` (`picker` element type, `showPicker`, `hidePicker`, the Cancel handler)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: nothing new; `showPicker`'s signature is unchanged.

- [ ] **Step 1: Move the markup and make it a dialog**

In `src/web/static/index.html`, **delete** the `#picker` block (currently the first child of `<main id="app">`, `src/web/static/index.html:63-79`) and re-insert it **immediately after** `<p id="notice" …></p>` and **before** `<main id="app" hidden>`, as:

```html
    <!-- The stream file picker. Shown only when a session resolves to more than
         one playable file; every child below the heading is built by app.js with
         createElement, because the filenames come out of a torrent.

         A MODAL <dialog>, and OUTSIDE <main id="app">, both deliberately:

         - Modal because it used to be an inline card at the top of the document.
           Press play on a season pack 500px down a browse and the question
           appeared off screen, with nothing where the user was looking to say
           anything had happened. showModal() centres it in the viewport, takes
           focus, and closes on Escape.
         - Outside #app because #app carries `hidden` until the page loads, and a
           <dialog> inside a display:none subtree does not render at all. Its old
           position was justified by sitting above both panes so neither list's
           re-render could replace it (the queue's happens four times a second);
           a top-level sibling keeps that and adds nothing to it. -->
    <dialog id="picker" class="card picker">
      <p id="picker-title" class="picker-title"></p>
      <ul id="picker-files" class="picker-files"></ul>
      <div class="picker-actions">
        <!-- The terminal picker's "s" key, as a button: title order or
             largest-first. Its label is set by app.js from the current mode. -->
        <button id="picker-sort" type="button"></button>
        <button id="picker-cancel" type="button">Cancel</button>
      </div>
    </dialog>
```

Note there is no `hidden` attribute: a `<dialog>` is closed until opened.

- [ ] **Step 2: Fix the CSS, which would otherwise leave the closed dialog on screen**

In `src/web/static/styles.css`, replace the `.picker` rule (`src/web/static/styles.css:370-372`):

```css
/* The stream file picker. Overrides .card's row layout — it is a heading above a
   list, not a form — in the same way .fallback does on the player page.
   
   SCOPED TO [open], and this is load-bearing rather than tidy: a bare
   `.picker { display: block }` overrides the UA's own
   `dialog:not([open]) { display: none }` and leaves the closed picker visible
   at the top of the page for good. */
.picker[open] {
  display: block;
}

/* A dialog carries a UA border, padding and `margin: auto`; .card supplies the
   first two and centring is what we want from the third, so only the border is
   reset. max-height keeps a 40-episode pack scrollable inside the dialog rather
   than taller than the viewport, which would put Cancel off screen — the exact
   problem this change exists to fix. */
.picker {
  border: 1px solid var(--line);
  max-height: min(80vh, 40rem);
  max-width: min(46rem, calc(100vw - 2rem));
  overflow-y: auto;
}

/* Dim rather than black: the list behind is context — which release this is a
   pack of — not something to hide. */
.picker::backdrop {
  background: rgb(0 0 0 / 55%);
}
```

- [ ] **Step 3: Wire it in `app.ts`**

In `src/web/static/app.ts`:

1. Change the element type at `src/web/static/app.ts:209`:

```ts
const picker = el<HTMLDialogElement>("picker");
```

2. Replace `hidePicker` (`src/web/static/app.ts:674-679`):

```ts
// Closes the picker WITHOUT stopping its session — the caller is handing that
// session to the player. Clearing `pickerSession` before `close()` is what tells
// the `close` listener below to leave it alone, so the two ways out of a picker
// (chose a file / walked away) stay distinguishable with no extra flag.
function hidePicker(): void {
  pickerSession = null;
  if (picker.open) picker.close();
}
```

3. Replace the `pickerCancel` handler (`src/web/static/app.ts:786-790`) with a Cancel that just closes, plus the `close` listener that does the actual releasing:

```ts
pickerCancel.addEventListener("click", () => picker.close());

// EVERY way out of the picker lands here — the Cancel button, Escape, and
// `hidePicker`. Escape is the reason this is a `close` listener rather than more
// work in the click handler: a <dialog> closes on Escape natively, bypassing any
// button handler, and the session it was offering has a torrent attached. Left
// running it would sit there until the idle reaper collected it.
//
// `pickerSession` being null means a file was chosen and the session now belongs
// to the player (hidePicker cleared it first, on purpose) — nothing to release.
picker.addEventListener("close", () => {
  const sessionId = pickerSession;
  pickerSession = null;
  drawPicker = null;
  pickerFiles.replaceChildren();
  if (sessionId) stopSession(sessionId);
});
```

4. In `showPicker`, replace `picker.hidden = false;` (`src/web/static/app.ts:769`) with the modal open, and add the orphan fix at the top of the function. Replace the opening lines of `showPicker` (`src/web/static/app.ts:711-712`) with:

```ts
  // A session already on offer here is one nobody is going to answer now, and it
  // has a torrent attached. Releasing it is a fix for a leak that predates the
  // modal: the old code overwrote `pickerSession` and left the previous session
  // running until the idle reaper. Guarded on inequality so a redraw of the same
  // session can never stop the session it is redrawing.
  if (pickerSession !== null && pickerSession !== sessionId) stopSession(pickerSession);
  pickerSession = sessionId;
  pickerTitle.textContent = `Which file from “${shortName(name)}”?`;
```

and replace `picker.hidden = false;` with:

```ts
  // showModal(), not show(): the backdrop and the focus trap are the point. It
  // throws if the dialog is already open, which a second choose() can do.
  if (!picker.open) picker.showModal();
```

5. Rewrite the stale comment above `showPicker` (`src/web/static/app.ts:684-692`). Replace the paragraph beginning "`infoHash` is a PARAMETER" with:

```
// `infoHash` is a PARAMETER, not a module-level variable read when a file is
// chosen, and it stays one. The hazard it was written against — a second play()
// opening a picker for a different torrent while this one is open, so that
// choosing a file from the FIRST records its filename as watched against the
// SECOND torrent's favourite — is now unreachable twice over: the picker is a
// modal, and `isBusy` refuses a second play while one is in flight at all (the
// terminal's own one-at-a-time rule, src/ui/App.tsx:1445). Closing over the hash
// at the call site costs nothing and remains the correct shape, so the belt stays
// on with the braces.
```

- [ ] **Step 4: Verify**

```bash
npx tsc --noEmit -p tsconfig.json && npm run lint && npm run build
grep -n "picker.hidden" src/web/static/app.ts
```

Expected: typecheck, lint and build all pass; the `grep` returns **no hits** (any remaining `picker.hidden` would silently do nothing on a `<dialog>`).

- [ ] **Step 5: Verify by running it — this is wiring, which no unit test here reaches**

```bash
npm run dev -- serve --web
```

In the browser: search for a show, press **play** on a season pack while scrolled well down the page. Confirm all five:
1. The picker appears centred in the viewport over a dimmed backdrop, wherever you were scrolled.
2. Keyboard focus is inside it (the "next" row, if one is badged).
3. **Escape** closes it, and the queue does not gain a stuck session.
4. **Cancel** closes it likewise.
5. Choosing a file opens the player.

- [ ] **Step 6: Commit**

```bash
git add src/web/static/index.html src/web/static/styles.css src/web/static/app.ts
git commit -m "fix(web): open the file picker as a modal, in the viewport

Press play on a season pack 500px down a browse and the 'which episode?'
question appeared at the top of the document, off screen, with nothing
where the user was looking to say anything had happened.

Also releases a session the picker was offering when a second picker
replaces it — a leak that predates the modal — and on Escape, which
closes a <dialog> natively and bypassed the Cancel handler."
```

---

### Task 7: The progress pill, with Cancel

**Files:**
- Modify: `src/web/static/index.html` (the pill, beside `#notice`)
- Modify: `src/web/static/styles.css` (`.prepare`)
- Modify: `src/web/static/app.ts` (`flow` state, `showPrepare`/`hidePrepare`, `play()`'s effects, the Cancel wiring)

**Interfaces:**
- Consumes: `PlayOptions`, `CANCELLED_NOTICE`, `PlayEffects.progress` (Task 4); `prepareLine` indirectly via `pollDecision` (Task 3); `FlowState`/`isBusy` (Task 5).
- Produces: module-level `flow: FlowState`, `prepareAbort: AbortController | null`, `setFlowPrepare(prepare: FlowState["prepare"]): void`.

- [ ] **Step 1: Add the markup**

In `src/web/static/index.html`, immediately after the `</dialog>` from Task 6:

```html
    <!-- The waiting line for a resolving stream, anchored to the viewport.
         Resolving a torrent Real-Debrid has never seen genuinely takes minutes,
         and the only progress report used to be #notice — a paragraph above
         <main> that scrolls away, so a user 500px down a browse saw nothing at
         all and pressed play again. Bottom LEFT because .to-top already owns
         bottom right.

         aria-live is OFF on purpose. The line changes every second (the elapsed
         count moves even when the percent does not), so a live region would talk
         over a screen-reader user continuously for minutes. #notice keeps the
         milestones worth announcing: started, cancelled, failed. -->
    <div id="prepare" class="prepare" role="status" aria-live="off" hidden>
      <span id="prepare-line" class="prepare-line"></span>
      <button id="prepare-cancel" type="button">Cancel</button>
    </div>
```

- [ ] **Step 2: Style it**

Append to `src/web/static/styles.css`:

```css
/* The resolving-stream pill. Fixed bottom left; .to-top is bottom right at
   z-index 4, and sharing a corner would overlap them. */
.prepare {
  position: fixed;
  left: 1rem;
  bottom: 1rem;
  z-index: 4;
  display: flex;
  align-items: center;
  gap: 0.6rem;
  max-width: min(30rem, calc(100vw - 7rem));
  padding: 0.5rem 0.7rem;
  border: 1px solid var(--accent);
  border-radius: 2px;
  background: var(--raised);
  font-size: 0.75rem;
}

.prepare-line {
  color: var(--dim);
  overflow-wrap: anywhere;
  /* The elapsed seconds and the percent both tick; without this the whole line
     jitters sideways once a second. */
  font-variant-numeric: tabular-nums;
}

.prepare button {
  flex-shrink: 0;
}

/* On a phone the pill and .to-top would sit side by side in 375px. Full width
   above it instead. */
@media (max-width: 30rem) {
  .prepare {
    left: 1rem;
    right: 1rem;
    bottom: 3.5rem;
    max-width: none;
  }
}
```

- [ ] **Step 3: Wire it in `app.ts`**

Add the element handles beside the other `el<…>` calls near `src/web/static/app.ts:207`:

```ts
const prepare = el<HTMLDivElement>("prepare");
const prepareLineText = el<HTMLSpanElement>("prepare-line");
const prepareCancel = el<HTMLButtonElement>("prepare-cancel");
```

Add the imports: `import { controlState, isBusy, type FlowState } from "./streamBusy";` (`controlState` is used in Task 8), and add `CANCELLED_NOTICE` to the existing `./streamFlow` import list.

Replace the `playing` set (`src/web/static/app.ts:555-559`) with the flow state:

```ts
// What the one in-flight play or pick is, if any. ONE, not a set: the terminal
// allows one prepare or pick at a time (src/ui/App.tsx:1317, :1445) and the
// browser's per-row set let two rows resolve at once, each polling for up to ten
// minutes, sharing one progress line that reported whichever wrote last.
//
// Every Play button on the page is repainted from this (paintPlayBusy), so the
// rule is visible rather than enforced by a silent early return — a lit button
// that does nothing when pressed is what taught people to press it repeatedly.
const flow: FlowState = { prepare: null, picking: null };

// Cancels the in-flight prepare. Held here so the pill's Cancel button can reach
// it; runPlay threads the signal into its fetches and its sleep, and stops the
// session on the way out.
let prepareAbort: AbortController | null = null;
```

Add the pill's own functions near `showNotice`:

```ts
// The waiting line, or null to take it down. runPlay's `progress` effect —
// separate from `notice` because this one persists for the length of a resolve
// (minutes) and carries a Cancel, while a notice hides itself after seconds.
function showPrepare(line: string | null): void {
  if (line === null) {
    prepare.hidden = true;
    prepareLineText.textContent = "";
    return;
  }
  prepareLineText.textContent = line;
  prepare.hidden = false;
}

prepareCancel.addEventListener("click", () => {
  // Feedback on the press itself: aborting kills an in-flight fetch, but the
  // sleep between polls can still be most of a second, and a Cancel that looks
  // inert gets pressed again.
  prepareCancel.disabled = true;
  prepareAbort?.abort();
});
```

Rewrite `play()` (`src/web/static/app.ts:821-848`) — the guard, the flow bookkeeping and the new options:

```ts
async function play(
  row: DashRow,
  onUnresolved?: () => void,
  next?: EpisodeRef | null,
): Promise<void> {
  // One at a time, and the buttons say so (paintPlayBusy), so this early return
  // is now a backstop rather than the whole mechanism.
  if (isBusy(flow)) return;
  const wanted = wantedEpisodeFor(row.name, savedState.continueWatching, next);
  const ac = new AbortController();
  prepareAbort = ac;
  prepareCancel.disabled = false;
  flow.prepare = { key: row.id, title: row.name };
  paintPlayBusy();
  try {
    await runPlay(
      row,
      {
        start: startSession,
        poll: pollSession,
        stop: stopSession,
        confirm: (message) => confirm(message),
        notice: showNotice,
        progress: showPrepare,
        // Closes over THIS row's hash, not a module-level variable — see
        // showPicker's comment for why that distinction is load-bearing.
        choose: (sessionId, capability, name, files, preselect) =>
          showPicker(row.id, sessionId, capability, name, files, preselect),
        open: (path) => openPlayer(path),
        sleep,
        now: () => Date.now(),
        onUnresolved,
      },
      {
        wanted,
        // The provider's display name for the waiting line, from the same
        // DEBRID_LABELS table the add button uses (searchModel.ts) — not a
        // second one written here.
        providerLabel: sources?.debridProvider ? debridProviderLabel(sources.debridProvider) : null,
        signal: ac.signal,
      },
    );
  } finally {
    prepareAbort = null;
    flow.prepare = null;
    // runPlay clears the pill itself on every exit; this is belt and braces for
    // a throw, which would skip it.
    showPrepare(null);
    paintPlayBusy();
  }
}
```

Add `debridProviderLabel` to the existing `./searchModel` import list. Verify it is exported there:

```bash
grep -n "export function debridProviderLabel" src/web/static/searchModel.ts
```

`paintPlayBusy` is Task 8's; for this commit add the stub so the tree compiles, and Task 8 fills it in:

```ts
// Repaints every Play control from `flow`. Task 8 fills this in; a no-op here
// keeps this commit's tree green.
function paintPlayBusy(): void {}
```

- [ ] **Step 4: Verify it compiles and nothing regressed**

```bash
npx tsc --noEmit -p tsconfig.json && npm run lint && npm run build && npm test
```

Expected: all pass.

- [ ] **Step 5: Verify by running it**

```bash
npm run dev -- serve --web
```

Press play on something that has to resolve, scrolled well down the page. Confirm:
1. The pill appears bottom left with a line like `Caching on Real-Debrid… 12% · 4s` (or `Finding peers… <name> · 4s` with no provider connected), and the **seconds tick up**.
2. It is visible wherever you scroll.
3. **Cancel** takes the pill down and shows `Stream cancelled.` in the notice line.
4. After a cancel, the queue has no session left resolving — check the terminal's log output for the session being stopped.
5. On a narrow window (< 30rem) the pill sits above the back-to-top button rather than overlapping it.

- [ ] **Step 6: Commit**

```bash
git add src/web/static/index.html src/web/static/styles.css src/web/static/app.ts
git commit -m "feat(web): show resolve progress where the user is, and let them cancel it

A resolve can run for minutes and reported progress only into #notice, a
paragraph above <main> that scrolls away — so a user reading nothing
pressed play again. The line is now a viewport-anchored pill carrying the
terminal's own wording and elapsed count, plus the Cancel the browser
never had."
```

---

### Task 8: Paint the busy state on all six Play buttons

**Files:**
- Modify: `src/web/static/app.ts` — `paintPlayBusy`, a `tagPlayKey` helper, and the six button sites: `:468` (queue row), `:1646` (search result), `:3034` (library row), `:3075` (continue-watching resume), `:2674` (For You `Play`), `:3100` (`Play next`)

**Interfaces:**
- Consumes: `controlState`, `BUSY_LABEL` (Task 5); `flow`, `paintPlayBusy` stub (Task 7).
- Produces: `tagPlayKey(button: HTMLButtonElement, key: string, idleLabel: string): void`.

- [ ] **Step 1: Add the helper and the paint pass**

In `src/web/static/app.ts`, replace the `paintPlayBusy` stub from Task 7 with:

```ts
// Stamps a Play control with the identity `flow` will match it against, and the
// word it says when idle.
//
// A SEPARATE ATTRIBUTE FROM tagControl's `data-row-key`, and that is not
// duplication. `data-row-key` is resultFocus's identity — for a search result it
// is the GROUP key (one row per title, several releases inside), not the info
// hash `play()` was handed. Matching busy state on it would mark the wrong
// control the moment a title has more than one release.
//
// `data-idle-label` is stamped because the paint overwrites `textContent`: once
// a button reads "preparing…", the word it should return to is no longer
// anywhere in the DOM.
function tagPlayKey(button: HTMLButtonElement, key: string, idleLabel: string): void {
  button.dataset.playKey = key;
  button.dataset.idleLabel = idleLabel;
}

// Repaints every Play control on the page from `flow`.
//
// DERIVED ON EVERY RENDER, never set once on click: the queue's rows are rebuilt
// four times a second by the SSE tick, and a `disabled` set in a click handler is
// gone by the next frame. That is the bug this whole pass exists to close — the
// button that was pressed looked untouched, so it got pressed again.
function paintPlayBusy(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-play-key]")) {
    const key = button.dataset.playKey ?? "";
    const state = controlState(flow, key, button.dataset.idleLabel ?? button.textContent ?? "play");
    button.disabled = state.disabled;
    button.textContent = state.label;
    // A boolean attribute, so it is removed rather than set to "false":
    // aria-busy="false" is technically correct but noisier to read in devtools
    // and is what the rest of this file does with aria-current.
    if (state.busy) button.setAttribute("aria-busy", "true");
    else button.removeAttribute("aria-busy");
  }
}
```

- [ ] **Step 2: Tag all six sites**

Each site gets one `tagPlayKey` call. The key must be **exactly** what `flow` will hold — the info hash for the four `play()` paths, the title for the two `pickController` paths.

At `src/web/static/app.ts:468-471` (queue row), after `tagControl(playButton, row.id, "play")`:

```ts
    tagPlayKey(playButton, row.id, "play");
```

At `src/web/static/app.ts:1646-1649` (search result) — `rowForPlay(result).id` is `result.infoHash` (`searchModel.ts:411`):

```ts
  tagPlayKey(playButton, result.infoHash, "play");
```

At `src/web/static/app.ts:3034-3036` (library row) — the row plays `dashRowForPlay(f.id, f.name)`:

```ts
  tagPlayKey(playButton, f.id, "play");
```

At `src/web/static/app.ts:3075-3077` (continue-watching resume) — `playContinueWatching` plays `dashRowForPlay(item.infoHash, item.rawName)` (`src/web/static/app.ts:2970`), so the key is the **info hash**, not the title:

```ts
  tagPlayKey(playButton, item.infoHash, "play");
```

At `src/web/static/app.ts:2672-2677` (For You `Play`, inside `paintReccPlay`) — this one goes through `pickController.start(item.title, …)`, so the key is the title:

```ts
  tagPlayKey(playButton, item.title, "Play");
```

At `src/web/static/app.ts:3098-3106` (`Play next`) — also `pickController.start(item.title, …)`:

```ts
    tagPlayKey(playNext, item.title, "Play next");
```

Two of those six — For You `Play` and `Play next` — had **no guard of any kind** before this: they call `pickController.start` directly, which the `playing` set never covered.

- [ ] **Step 3: Repaint after every render, and drive `flow.picking`**

Find where the panes render and add a `paintPlayBusy()` call after each list is replaced. The paint must run after *any* `replaceChildren` that can produce a Play control:

```bash
grep -n "replaceChildren" src/web/static/app.ts | cut -c1-110
```

For each render function that builds rows containing a Play button — the queue/dashboard render, `renderResults`, the library render, the continue-watching render, and `paintReccPlay`'s own caller — add `paintPlayBusy();` as the last statement.

Then wire `flow.picking` from the pick controller's phase. In `renderPickPhase` (`src/web/static/app.ts:1259-1266`), add the flow bookkeeping:

```ts
function renderPickPhase(state: PickState): void {
  const { phase } = state;
  // The one-click Play's search is a flow too, and while it runs no other Play
  // button should look pressable — same rule as a prepare. Only "searching"
  // counts: by "playing" the controller has handed off to play(), which owns
  // `flow.prepare` from there.
  flow.picking = phase.kind === "searching" ? phase.title : null;
  paintPlayBusy();
  if (phase.kind === "searching") showNotice(pickSearchingLine(phase.title));
  else if (phase.kind === "playing") showNotice(phase.note);
  else if (phase.kind === "none") showNotice(pickNoneLine(phase.title));
}
```

Guard `pickController.start`'s two call sites with the same one-at-a-time rule. At `src/web/static/app.ts:2676` and `:3106`, wrap the handler bodies:

```ts
  playButton.addEventListener("click", () => {
    if (isBusy(flow)) return;
    pickController.start(item.title, { kind: "film" });
  });
```

```ts
    playNext.addEventListener("click", () => {
      if (isBusy(flow)) return;
      pickController.start(item.title, intent, () => void playContinueWatching(item));
    });
```

- [ ] **Step 4: Verify**

```bash
npx tsc --noEmit -p tsconfig.json && npm run lint && npm run build && npm test
grep -c "tagPlayKey(" src/web/static/app.ts
```

Expected: all green, and the `grep -c` reports **7** (one definition plus six call sites).

- [ ] **Step 5: Verify by running it — the part no unit test reaches**

```bash
npm run dev -- serve --web
```

Confirm each:
1. Press **play** on a queue row: that button reads `preparing…` and is disabled; **every other** Play button on the page is disabled too.
2. Wait through several SSE ticks (the queue repaints four times a second) and confirm the busy state **persists** — this is the regression the derive-on-render rule exists to prevent.
3. When it finishes (or you Cancel), every button returns to `play` / `Play` / `Play next` — check all three words came back correctly, since the paint overwrites `textContent`.
4. On the **For You** tab, press `Play` on a film: it reads `preparing…` through the search and the resolve that follows.
5. Press `Play next` on a Continue-watching row and confirm the same.

- [ ] **Step 6: Commit**

```bash
git add src/web/static/app.ts
git commit -m "feat(web): show every Play button's busy state, derived on render

Pressing play changed nothing on screen, so the natural response was to
press it again. Queue rows rebuild four times a second, so the state is
derived from the flow on every render rather than set on click. Two of
the six Play buttons — For You and Play next — had no guard at all."
```

---

### Task 9: Docs, and the whole-tree check

**Files:**
- Modify: `README.md:225-239` (the browser's "can't do yet" list) and `README.md:279` (the browser play paragraph)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Check what the README now gets wrong**

Run: `sed -n 225,240p README.md; sed -n 278,282p README.md`

The "What the browser can't do yet" list must not claim anything this change fixed. The play paragraph at `README.md:279` says torlnk "picks the video file (or asks, if there are several)" — still true, but it should now say where it asks and that the wait is cancellable.

- [ ] **Step 2: Update the play paragraph**

In `README.md`, replace the sentence "In the browser, torlnk resolves the torrent — through the active debrid provider if you have one connected, otherwise straight from the swarm — picks the video file (or asks, if there are several), and opens a player page." with:

```markdown
In the browser, torlnk resolves the torrent — through the active debrid provider if you have one
connected, otherwise straight from the swarm — picks the video file (or asks, if there are several), and
opens a player page. While it resolves, the button you pressed says so and a line in the corner of the
window counts up — `Caching on Real-Debrid… 42% · 12s`, the same words the terminal uses — because a
torrent your provider has never seen genuinely takes minutes. That line carries a **Cancel** that stops
the session, the browser's answer to the terminal's `esc`. When there are several files to choose from,
the question opens over the page rather than at the top of it, so it finds you wherever you had scrolled.
```

- [ ] **Step 3: Check the limitations list is still true**

Read `README.md:225-239`. None of its three bullets — no restarting a stopped seed, no subtitles or scrubber, no settings page — is affected by this change, so **leave them**. Confirm rather than assume:

```bash
grep -nE "can't|cannot|no way to" README.md | sed -n 1,25p | cut -c1-120
```

If any line claims the browser cannot cancel a stream or that the picker appears at the top of the page, fix it. If none does, this step is a no-op — say so in the commit body rather than inventing an edit.

- [ ] **Step 4: Run the full gate**

```bash
npm test && npm run typecheck && npm run lint && npm run build
```

Expected: all pass. Exactly one lint warning is expected and pre-existing (`react-hooks/exhaustive-deps`, `src/ui/App.tsx`); any second warning is yours.

Then confirm nothing was missed across the tree:

```bash
grep -rn "resolvePercent" src/                     # expect: no hits (Task 3 deleted it)
grep -rn "picker.hidden" src/                      # expect: no hits (Task 6)
grep -rn "playing\.\(has\|add\|delete\)" src/web/  # expect: no hits (Task 7 replaced the set)
grep -rn "innerHTML\|insertAdjacentHTML" src/web/static/  # expect: no hits, ever
```

- [ ] **Step 5: Verify both front ends run**

The TUI was modified (Task 2), so it gets run too — not just its tests:

```bash
npm run dev
```

Press `v` on a result and confirm the preparing line still reads `Caching on …% · Ns  (esc cancels)` or `Finding peers… <name> · Ns  (esc cancels)`, and that `esc` still cancels.

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs: describe the browser's resolve progress and its cancel"
```

---

## Self-Review

**Spec coverage.** Every section of the spec maps to a task: §1 modal `<dialog>` → Task 6 (including all three UA-behaviour traps and the orphan-session fix); §2 the pill and `src/util/prepareLine.ts` → Tasks 1, 2, 3, 7 (the `aria-live="off"` decision is in Task 7's markup comment); §3 abort through `runPlay` → Task 4, with the start-then-abort race as its own named test; §4 derived busy state and one-at-a-time → Tasks 5 and 8, all six button sites enumerated with their keys; "deliberately not changing" → the `window.confirm` is untouched by every task above, and belongs in the PR body; Files table → Tasks 1-9 cover every row.

**Two corrections to the spec, made here rather than left to be discovered:**

1. **`PrepareFacts` needs `phase`, not just a backend.** The terminal has a third arm — `Fetching link… 12s` (`src/ui/App.tsx:2392`) — which the spec's four-field shape could not express. The field names now mirror the TUI's `preparing` state exactly so its call site is a spread. The browser never renders that arm (the wire has one `resolving` state), which Task 3 documents at the call site.
2. **The busy paint cannot reuse `tagControl`'s `data-row-key`.** On a search result that attribute holds the *group* key for `resultFocus`, not the info hash `play()` receives — so matching on it would mark the wrong control as soon as a title has two releases. Task 8 introduces `data-play-key` instead.

**Placeholder scan.** No TBDs; every code step carries the actual code, every verification step the actual command and its expected output. Task 9 Step 3 is conditional by design ("if none does, this step is a no-op — say so rather than inventing an edit") because whether the README currently over-claims is a fact to check, not to guess.

**Type consistency.** `prepareLine`/`PrepareFacts` (T1) are consumed unchanged by T2 and T3. `pollDecision`'s fourth parameter (T3) is supplied by `runPlay` from `PlayOptions.providerLabel` (T4), which `app.ts` fills from `debridProviderLabel` (T7). `PlayEffects.progress` (T4) is implemented as `showPrepare` (T7). `FlowState`/`controlState`/`isBusy`/`BUSY_LABEL` (T5) are consumed by `paintPlayBusy` and `play()` (T7, T8) with the same names throughout. `CANCELLED_NOTICE` is defined once (T4) and asserted by string in T4's tests. `paintPlayBusy` is deliberately stubbed in T7 and filled in T8, noted at both ends so the tree compiles at every commit.
