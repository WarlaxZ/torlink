import {
  akaNote,
  applyReply,
  emptySuggestState,
  submitTextFor,
  suggestionLabel,
  suppressFor,
  type SuggestState,
  type TitleSuggestion,
} from "../../util/titleSuggest";

// The search box's suggestion list, as state plus transitions.
//
// It lives here rather than in app.ts because every function below answers
// either "what should be on screen" or "what should be sent" — the two
// questions app.ts is not allowed to decide, since nothing in it is reachable
// by a test.

export interface ListState {
  suggest: SuggestState;
  /** Index into `suggest.items`, or -1 for "nothing highlighted". */
  highlight: number;
}

export function emptyListState(): ListState {
  return { suggest: emptySuggestState(), highlight: -1 };
}

export function isOpen(s: ListState): boolean {
  return s.suggest.items.length > 0;
}

/**
 * Fold in a reply from `/api/title-search`.
 *
 * The highlight resets to -1 rather than being preserved: the rows have
 * changed, so a kept index would point at a different title than the one the
 * user was looking at — and pressing Enter would then search for something
 * they never highlighted.
 */
export function withReply(s: ListState, seq: number, items: TitleSuggestion[]): ListState {
  const suggest = applyReply(s.suggest, seq, items);
  if (suggest === s.suggest) return s;
  return { suggest, highlight: -1 };
}

/** Move the highlight, wrapping, and entering the list from -1. */
export function moveHighlight(s: ListState, delta: 1 | -1): ListState {
  const n = s.suggest.items.length;
  if (n === 0) return s;
  if (s.highlight === -1) return { ...s, highlight: delta === 1 ? 0 : n - 1 };
  return { ...s, highlight: (s.highlight + delta + n) % n };
}

/**
 * Highlight a specific row — what a click means, before it accepts.
 *
 * Out-of-range indices are ignored rather than clamped: the only caller is a
 * row's own listener, so an out-of-range index means the rows changed under the
 * click, and accepting a *different* title than the one clicked is worse than
 * doing nothing.
 */
export function highlightAt(s: ListState, index: number): ListState {
  if (index < 0 || index >= s.suggest.items.length) return s;
  return { ...s, highlight: index };
}

/** Close the list, and stop asking about `raw` so it cannot reopen itself. */
export function closedFor(s: ListState, raw: string): ListState {
  return { suggest: suppressFor(s.suggest, raw), highlight: -1 };
}

/**
 * What to search for on Enter or a click.
 *
 * With nothing highlighted this is the raw text, always. Substituting a
 * suggestion for what the user actually typed is the one thing autocomplete
 * must never do silently.
 */
export function acceptPlan(s: ListState, raw: string): { kind: "suggestion" | "raw"; text: string } {
  const hit = s.highlight >= 0 ? s.suggest.items[s.highlight] : undefined;
  if (!hit) return { kind: "raw", text: raw };
  return { kind: "suggestion", text: submitTextFor(hit) };
}

/** One entry per row to render. Strings only — the caller sets textContent. */
export function rowPlan(s: ListState): { label: string; aka: string | null; highlighted: boolean }[] {
  return s.suggest.items.map((hit, i) => ({
    label: suggestionLabel(hit),
    aka: akaNote(hit),
    highlighted: i === s.highlight,
  }));
}
