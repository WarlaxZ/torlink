// Recently-run searches, most-recent first, so the search bar can recall them
// with the up arrow. Kept small and persisted in config.

export const SEARCH_HISTORY_CAP = 25;

/**
 * Return a new history with `query` at the front: trimmed, de-duplicated
 * (an existing entry moves to the front), and capped at `cap`. Empty queries
 * leave the history untouched.
 */
export function addToHistory(
  history: string[],
  query: string,
  cap = SEARCH_HISTORY_CAP,
): string[] {
  const q = query.trim();
  if (!q) return history;
  return [q, ...history.filter((h) => h !== q)].slice(0, cap);
}

/**
 * Compute the next history index when the user presses up/down in the field.
 * History is newest-first; index -1 means "editing the draft, not navigating".
 * `prev` moves toward older entries (capped at the oldest); `next` moves back
 * toward the draft, returning "exit" when already on the draft so the caller
 * can leave the field instead.
 */
export function historyStep(
  dir: "prev" | "next",
  index: number,
  historyLen: number,
): number | "exit" {
  if (dir === "prev") {
    if (historyLen === 0) return index;
    return Math.min(index + 1, historyLen - 1);
  }
  if (index > 0) return index - 1;
  if (index === 0) return -1;
  return "exit";
}
