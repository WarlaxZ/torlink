// The browser's release-pick decisions: which quality preference the header
// disclosure is actually storing, which episode a Continue Watching row is up
// to, and the state machine behind the one-click Play button.
//
// Separate from app.ts for the reason every model in this directory is — there
// is no jsdom here, so a decision that lives only in app.ts is a decision no
// test can reach. This file is a pure module: nothing in it touches the DOM,
// and it imports nothing that reaches `node:*`. `src/web/static/` is bundled
// with `platform: "browser"` (tsup.web.config.ts); `src/util/releasePick.ts`
// itself imports only `./release` for exactly this reason, so it is the one
// safe way to reach `pickBestRelease`/`pickStatusLine` from here.
import {
  pickBestRelease,
  pickStatusLine,
  type Pick,
  type PickableResult,
  type PickIntent,
  type QualityPrefs,
} from "../../util/releasePick";
import type { PublicQualityPrefs, PublicStreamHistoryItem } from "../wire";

/**
 * Wire → internal. `QualityPrefs.maxResolution` is OPTIONAL (absent means "no
 * limit"); `PublicQualityPrefs.maxResolution` is `MaxResolution | null` so the
 * wire form round-trips explicitly instead of an omitted key meaning the same
 * thing as an explicit null. This is the one place that converts between the
 * two, so the asymmetry cannot leak into a second spot and drift.
 */
export function prefsFromWire(p: PublicQualityPrefs): QualityPrefs {
  const out: QualityPrefs = { require: [...p.require], exclude: [...p.exclude] };
  return p.maxResolution ? { ...out, maxResolution: p.maxResolution } : out;
}

/** Internal → wire. The inverse of `prefsFromWire`; see its comment. */
export function prefsToWire(p: QualityPrefs): PublicQualityPrefs {
  return { maxResolution: p.maxResolution ?? null, require: [...p.require], exclude: [...p.exclude] };
}

/**
 * The episode a Continue Watching row is up to, or null when there is nothing
 * honest to offer. `next` is computed server-side by `nextEpisode`
 * (routes.ts:824) and is null for a film AND for a series watched via a season
 * pack — in both cases there is no honest next episode to hand back, so this
 * returns null rather than inventing one. The browser must NOT import
 * `src/core/streamHistory.ts` to recompute it itself — that pulls in
 * `node:fs` and breaks the bundle (see savedModel.ts:285, and the four
 * copy-then-drift bugs it documents).
 */
export function intentForHistoryRow(item: PublicStreamHistoryItem): PickIntent | null {
  return item.next ? { kind: "episode", season: item.next.season, episode: item.next.episode } : null;
}

// The film rule lives in `src/util/releasePick.ts`'s sibling
// `autoPlayableFilm.ts` (Task 7c) because both front ends need it and
// `src/web` may not import `src/ui`. Re-exported here so every pick-related
// decision this directory needs — this module's three functions plus this —
// arrives from one import site; Task 14 imports it through here, not around it.
export { autoPlayableFilm } from "../../util/autoPlayableFilm";

/**
 * What the Play button's async round trip should show. A closed set —
 * `app.ts` renders each variant, it does not decide when one applies.
 */
export type PickPhase =
  | { kind: "idle" }
  | { kind: "searching"; title: string }
  | { kind: "playing"; note: string }
  | { kind: "none"; title: string };

export interface PickState {
  phase: PickPhase;
}

export interface PickEffects<T extends PickableResult> {
  /**
   * Search for candidates by title. Empty means genuinely nothing found —
   * distinct from a transport failure, which is `app.ts`'s existing search
   * error surface to handle, not this controller's: a pick is one step of a
   * flow that already has a place to report "couldn't reach the server".
   */
  search(title: string): Promise<T[]>;
  /**
   * Read FRESH each call, never cached by the caller: the header disclosure
   * can change the preference at any moment, including while a search is in
   * flight. `start()` reads it once, at the moment the search begins, and
   * uses that same snapshot for both the ranking and the status line — see
   * the comment in `start` for why reading it twice would be wrong.
   */
  prefs(): QualityPrefs;
  /** Hand the winner to playback. `pick.fromPack` tells the caller to select the episode inside. */
  play(pick: Pick<T>, intent: PickIntent): void;
  render(state: PickState): void;
}

export interface PickController {
  /**
   * Search for `title`, rank the results against the current preference, and
   * play the winner. `onNone`, when given, runs only when nothing survived
   * the search — the Continue Watching fallback ("resume where the last
   * stream left off") that Task 14's `autoPlay` needs when a fresh pick finds
   * nothing, without writing that branch inline in `app.ts`.
   */
  start(title: string, intent: PickIntent, onNone?: () => void): void;
  state(): PickState;
}

/**
 * The one-click Play flow: search, rank, play. Shaped after
 * `createReccController` (`reccModel.ts:129`) — closure-held state, an
 * `fx.render(state)` call on every transition, and a monotonic counter so a
 * slow search that resolves after a newer one was started is discarded rather
 * than overwriting the newer one's result. Without the counter, starting a
 * second pick while the first is still searching (a slow source, a fast
 * click-through) can play the FIRST title's release under the SECOND title's
 * "playing" note — silent, and indistinguishable from the ranking being wrong.
 */
export function createPickController<T extends PickableResult>(fx: PickEffects<T>): PickController {
  let state: PickState = { phase: { kind: "idle" } };
  let counter = 0;

  const render = (): void => fx.render(state);

  return {
    start(title, intent, onNone): void {
      const req = ++counter;
      // Read once, here, before the await. Reading again after the search
      // resolves would let a preference change made mid-search describe a
      // cap in the status line that was never the cap the ranking actually
      // used — the two calls could observe different values of a mutable
      // preference object the caller (app.ts) may rewrite at any time.
      const prefs = fx.prefs();
      state = { phase: { kind: "searching", title } };
      render();
      void (async () => {
        const results = await fx.search(title);
        if (req !== counter) return; // superseded by a newer start()
        const pick = pickBestRelease(results, prefs, intent);
        if (!pick) {
          state = { phase: { kind: "none", title } };
          render();
          onNone?.();
          return;
        }
        state = { phase: { kind: "playing", note: pickStatusLine(pick, prefs.maxResolution) } };
        render();
        fx.play(pick, intent);
      })();
    },
    state(): PickState {
      return state;
    },
  };
}
