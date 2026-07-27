// The For You feed's decision logic: which request the filters produce, which
// answer is allowed to reach the screen, and what each button posts.
//
// Separate from app.ts for the reason every model in this directory is — there
// is no jsdom here, so anything with a decision in it has to be reachable
// without a DOM. The three rules this file exists to hold are the three the
// TUI's `useRecommendations` documents, and they are behavioural, not cosmetic:
// lazy first load, refetch on a real filter change, and a request counter so a
// slow earlier answer cannot overwrite a newer one.
//
// Bundled for the browser: no node:* imports.
import { ALL_TAB, categoryTabs, type SourcesResponse } from "./searchModel";
import type {
  PublicReccEventType,
  PublicRecommendation,
  PublicRecommendations,
  ReccEventRequest,
} from "../wire";

export type {
  PublicReccEventType,
  PublicRecommendation,
  PublicRecommendations,
  ReccEventRequest,
} from "../wire";

/** The type filter, including the browser's own name for "no filter". */
export type ReccType = "all" | "movie" | "tv";

export interface ReccFilters {
  type: ReccType;
  /** Free text, sent trimmed. Empty means no genre filter. */
  genre: string;
  explore: boolean;
}

/** What the feed opens on — the TUI's own defaults. */
export const DEFAULT_FILTERS: ReccFilters = { type: "all", genre: "", explore: false };

/**
 * The request one set of filters produces.
 *
 * `type=all` is sent rather than omitted, and the server accepts it: the select
 * has a value for "everything" and round-tripping it keeps this function a
 * straight mapping instead of a special case. Genre is trimmed and dropped when
 * empty (a `?genre=` with nothing in it reads to reccd as a genre named ""),
 * and `explore` only appears when it is on.
 */
export function recommendationsUrl(filters: ReccFilters): string {
  const params = new URLSearchParams({ type: filters.type });
  const genre = filters.genre.trim();
  if (genre) params.set("genre", genre);
  if (filters.explore) params.set("explore", "true");
  return `/api/recommendations?${params.toString()}`;
}

/** True when two filter sets would produce the same request. */
export function sameFilters(a: ReccFilters, b: ReccFilters): boolean {
  return a.type === b.type && a.genre.trim() === b.genre.trim() && a.explore === b.explore;
}

/** What the feed area should be showing. */
export type ReccPhase =
  /** The tab has never been opened. Nothing has been asked of reccd. */
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; items: PublicRecommendation[] }
  /** No reccd configured. A fact about the install, not a failure — see PublicRecommendations. */
  | { kind: "not-configured" }
  | { kind: "error"; error: string };

export interface ReccState {
  filters: ReccFilters;
  phase: ReccPhase;
}

export interface ReccEffects {
  /**
   * `GET /api/recommendations`, or null when the request itself failed
   * (offline, 401, unreadable body). Null is distinct from a `{status:"error"}`
   * body: the first is our side failing, the second is reccd's answer.
   */
  fetch(filters: ReccFilters): Promise<PublicRecommendations | null>;
  render(state: ReccState): void;
}

export interface ReccController {
  /**
   * The For You tab was opened. Loads on the FIRST call only — every later one
   * is a no-op, so switching panes back and forth is free.
   */
  open(): void;
  setType(type: ReccType): void;
  setGenre(genre: string): void;
  setExplore(explore: boolean): void;
  /** The refresh button: reload the current filters unconditionally. */
  refresh(): void;
  /** Drop one pick from the list without a round trip (it has just been rated). */
  dismiss(imdbId: string): void;
  state(): ReccState;
}

/** The transport failed, as opposed to reccd answering. Said honestly, not left spinning. */
const TRANSPORT_ERROR = "Couldn't reach the server for recommendations.";

function phaseFor(body: PublicRecommendations | null): ReccPhase {
  if (body === null) return { kind: "error", error: TRANSPORT_ERROR };
  if (body.status === "not-configured") return { kind: "not-configured" };
  if (body.status === "error") return { kind: "error", error: body.error };
  return { kind: "ready", items: body.items };
}

/**
 * The feed's fetch state, holding the three rules `useRecommendations` holds.
 *
 * 1. **Lazy.** Nothing is requested until `open()`. The feed is one of three
 *    panes and most page loads never look at it; fetching on startup would ask
 *    reccd to score twenty titles for a tab nobody opened.
 * 2. **Refetch on a filter that actually changed.** Re-selecting the type
 *    already selected, or blurring the genre box without editing it, is not a
 *    reason to re-ask reccd — and a filter changed before the tab is opened
 *    must not fetch either, or rule 1 is gone.
 * 3. **A late answer for filters you have left is dropped.** Without the
 *    counter, switching from movies to tv while the movie request is slow shows
 *    the movie feed under a "tv" filter — the classic out-of-order-response
 *    bug, silent, and indistinguishable from reccd being wrong.
 */
export function createReccController(fx: ReccEffects): ReccController {
  let state: ReccState = { filters: { ...DEFAULT_FILTERS }, phase: { kind: "idle" } };
  let opened = false;
  // Incremented per request. The value a response carries is compared against
  // this on return; anything older is stale by definition.
  let counter = 0;

  const render = (): void => fx.render(state);

  const load = (): void => {
    const req = ++counter;
    const filters = { ...state.filters };
    state = { filters, phase: { kind: "loading" } };
    render();
    void (async () => {
      const body = await fx.fetch(filters);
      if (req !== counter) return; // superseded by a newer request
      state = { filters, phase: phaseFor(body) };
      render();
    })();
  };

  const setFilters = (next: ReccFilters): void => {
    if (sameFilters(state.filters, next)) {
      // Still store it: "Horror " and "Horror" are the same request but the
      // second is what the box now says, and the state must not disagree.
      state = { ...state, filters: next };
      return;
    }
    state = { ...state, filters: next };
    // Before the tab has ever been opened this only records the choice. The
    // load happens on open(), once, with whatever the filters are by then.
    if (!opened) {
      render();
      return;
    }
    load();
  };

  return {
    open(): void {
      if (opened) return;
      opened = true;
      load();
    },
    setType(type): void {
      setFilters({ ...state.filters, type });
    },
    setGenre(genre): void {
      setFilters({ ...state.filters, genre });
    },
    setExplore(explore): void {
      setFilters({ ...state.filters, explore });
    },
    refresh(): void {
      opened = true;
      load();
    },
    dismiss(imdbId): void {
      if (state.phase.kind !== "ready") return;
      const items = state.phase.items.filter((it) => it.imdbId !== imdbId);
      if (items.length === state.phase.items.length) return;
      state = { ...state, phase: { kind: "ready", items } };
      render();
    },
    state(): ReccState {
      return state;
    },
  };
}

/** The line above the feed. Every phase says something; none of them is a blank pane. */
export interface ReccStatusLine {
  text: string;
  tone: "info" | "error";
  /** False once there are cards to look at — the status line is not a caption. */
  show: boolean;
}

export function reccStatus(state: ReccState): ReccStatusLine {
  const phase = state.phase;
  switch (phase.kind) {
    case "idle":
      return { text: "Picks based on what you've watched.", tone: "info", show: true };
    case "loading":
      return { text: "Finding recommendations…", tone: "info", show: true };
    case "not-configured":
      // The TUI's wording, pointed at the surface a browser user can reach.
      return {
        text: "Recommendations aren't set up yet. Set up reccd in the TUI's Accounts pane, or set TORLINK_RECC_URL and TORLINK_RECC_TOKEN.",
        tone: "info",
        show: true,
      };
    case "error":
      return { text: phase.error, tone: "error", show: true };
    case "ready":
      return phase.items.length === 0
        ? {
            text: "No picks yet — stream something and they'll show up here.",
            tone: "info",
            show: true,
          }
        : { text: "", tone: "info", show: false };
  }
}

/** The cards to render, or an empty list in every phase that has none. */
export function reccItems(state: ReccState): PublicRecommendation[] {
  return state.phase.kind === "ready" ? state.phase.items : [];
}

/**
 * The "because you liked …" line under a pick.
 *
 * reccd's strongest reason only, as the TUI's list shows — the rest go in the
 * card's `title` attribute, which is an attribute and not markup. Empty when
 * reccd gave none, and the card then simply has no reason line rather than an
 * empty one.
 */
export function reasonLine(item: PublicRecommendation): string {
  return item.reasons[0] ?? "";
}

/** Every reason, for the hover text. */
export function reasonTitle(item: PublicRecommendation): string {
  return item.reasons.join(" · ");
}

/**
 * The card's second line: the year, and nothing else.
 *
 * `score` is deliberately NOT shown. It is an unbounded ranking number — a live
 * reccd returns values like 63.72 — not a 0..1 confidence, so any attempt to
 * dress it as a percentage ("6372% match") is both wrong and unfixable without
 * knowing reccd's scale. The order of the cards already carries everything the
 * score means to a reader, which is why the TUI does not print it either.
 */
export function pickSub(item: PublicRecommendation): string {
  return String(item.year);
}

/**
 * What the buttons on a card do. Named for the user's intent, not for the wire:
 * "watchlist" is not a reccd event type and the mapping below is the only place
 * that translation happens.
 */
export type ReccAction = "watched" | "like" | "dislike" | "watchlist";

/**
 * Intent → the event reccd is told about.
 *
 * THE MAPPING IS THE WHOLE POINT OF THIS TABLE. `like` is `"liked"` and
 * `dislike` is `"disliked"` — a swap here is invisible on screen (the button
 * still highlights, the card still leaves the list) and quietly teaches the
 * recommender the opposite of what the user said. `watchlist` posts
 * `"favourited"`, which is the event the TUI's own favourite toggle posts.
 */
export const ACTION_EVENT: Record<ReccAction, PublicReccEventType> = {
  watched: "watched",
  like: "liked",
  dislike: "disliked",
  watchlist: "favourited",
};

/** The button caption for each action. */
export const ACTION_LABEL: Record<ReccAction, string> = {
  watched: "watched",
  like: "like",
  dislike: "dislike",
  watchlist: "watchlist",
};

/** The order the buttons appear in: the three ratings, then the watchlist. */
export const RECC_ACTIONS: readonly ReccAction[] = ["watched", "like", "dislike", "watchlist"];

/**
 * True when acting removes the pick from the feed.
 *
 * The three ratings do — the TUI dismisses a rated pick immediately rather than
 * waiting on reccd, because the event is fire-and-forget and there is nothing
 * to wait for. Adding to the watchlist does not: it is not a verdict on the
 * pick, and a card that vanished when you saved it for later would read as an
 * error.
 */
export function dismissesPick(action: ReccAction): boolean {
  return action !== "watchlist";
}

/** The `POST /api/recc-event` body for one action on one pick. */
export function reccEventBody(action: ReccAction, item: PublicRecommendation): ReccEventRequest {
  // reccd matches on the name it gave us, so the pick's own title goes back
  // unchanged — not a release name, and not something the browser rewrote.
  return { type: ACTION_EVENT[action], rawName: item.title };
}

/** What to tell the user after an action lands. */
export function actionNotice(action: ReccAction, item: PublicRecommendation): string {
  if (action === "watchlist") return `Added “${item.title}” to your watchlist.`;
  return `Thanks — noted “${item.title}” as ${ACTION_EVENT[action]}.`;
}

/**
 * Which search category a pick should open in, for the "search" button.
 *
 * The TUI switches to the section matching the type filter (`TYPE_SECTION`);
 * this is the same decision against the browser's tab strip. Checked against
 * the groups the SERVER actually offered rather than hardcoded, so a config
 * without a Movies or TV group can never select a tab that does not exist —
 * that would search nothing and look like a broken feed.
 */
export function searchGroupForType(type: ReccType, sources: SourcesResponse | null): string {
  if (type === "all") return ALL_TAB;
  const wanted = type === "movie" ? "Movies" : "TV";
  return categoryTabs(sources).includes(wanted) ? wanted : ALL_TAB;
}
