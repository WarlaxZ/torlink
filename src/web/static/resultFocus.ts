// Where focus should go after the results list is rebuilt.
//
// The list is replaced wholesale (`renderResults` → `replaceChildren`) on every
// snapshot frame AND on every selection, so the button the user just activated
// stops existing. Measured before this module: focus fell to `<body>` on every
// click, which makes the list unusable from the keyboard and makes any
// arrow-key navigation impossible — there is nowhere for the arrows to start.
//
// The DECISION lives here so a test can reach it; `app.ts` performs the
// `.focus()` call. There is no jsdom in this repo, which is exactly why a
// conditional like this must not live in `app.ts`.

export interface FocusSnapshot {
  /** The row's stable identity — a group key, or an info hash. */
  rowKey: string;
  /** Which control within the row: "name", "disclosure", "play", … */
  control: string;
}

/**
 * The control to focus after a re-render, or null to leave focus alone.
 *
 * Null in means null out: focus was somewhere else on the page (the search box,
 * the sort select) and a list re-render has no business moving it. The list
 * re-renders roughly once per source that answers, so getting this wrong would
 * steal the caret mid-word.
 *
 * A row that has gone away falls back to the first surviving row rather than
 * giving up, because "focus is now on nothing" is the bug being fixed — a user
 * who filtered the selected row away still expects to keep driving the list.
 */
export function focusTargetAfterRender(
  before: FocusSnapshot | null,
  rowKeys: readonly string[],
): FocusSnapshot | null {
  if (!before) return null;
  const first = rowKeys[0];
  if (first === undefined) return null;
  if (rowKeys.includes(before.rowKey)) return before;
  // The control is carried over deliberately: someone tabbing through play
  // buttons keeps landing on play buttons.
  return { rowKey: first, control: before.control };
}
