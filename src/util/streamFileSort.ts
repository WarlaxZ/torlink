/**
 * How a file picker orders the files inside one torrent — the rule, shared.
 *
 * WHY IT MOVED HERE. This was module-private in `src/ui/components/StreamFilePrompt.tsx`
 * and the browser's picker had no equivalent at all, so a season pack that the
 * terminal listed E01…E10 was listed in the browser in whatever order the
 * torrent happened to name its files: E08, E02, E03 … E01, then the extras. Two
 * front ends over one core are not allowed to disagree about that (CLAUDE.md),
 * and the fix is the one this codebase keeps reaching for after four recorded
 * copy-then-drift bugs — move the helper down, don't copy it.
 *
 * IT MUST STAY BROWSER-SAFE. It is imported by `src/web/static/streamFlow.ts`,
 * which tsup bundles with `platform: "browser"`, so no `node:*` import may
 * appear here or in anything it reaches. `./format` is import-free and stays
 * that way; `npm run build` is the enforcement.
 *
 * Generic over the *shape* for the same reason `videoFiles.ts` is: Node holds
 * `StreamFile` (with an upstream `url`), the browser holds `PublicStreamFile`
 * (with a `handle` and the session's own `index`), and returning the caller's
 * own element type is what lets each keep the field that addresses the file.
 */
import { cleanText } from "./format";
import type { SizedFile } from "./videoFiles";

/** Title order, or biggest-first. The two modes the picker's toggle swaps. */
export type StreamFileSort = "name" | "size";

/** The other mode — the toggle both pickers offer, written once. */
export function nextSort(mode: StreamFileSort): StreamFileSort {
  return mode === "name" ? "size" : "name";
}

/**
 * The files in display order. A copy: both callers keep the list they were
 * given (the TUI resolves a preselect back to a row through it, the browser
 * re-sorts the same array when the mode changes), so sorting in place would
 * move rows out from under an index someone still holds.
 *
 * Title order compares `cleanText`ed names with numeric collation and no case
 * sensitivity, so "Reel 2" precedes "Reel 10" and a decorative glyph nobody can
 * see in the rendered row does not decide where the row goes.
 */
export function sortStreamFiles<T extends SizedFile>(
  files: readonly T[],
  mode: StreamFileSort,
): T[] {
  const copy = [...files];
  if (mode === "name") {
    copy.sort((a, b) =>
      cleanText(a.filename).localeCompare(cleanText(b.filename), undefined, {
        numeric: true,
        sensitivity: "base",
      }),
    );
  } else {
    copy.sort((a, b) => b.bytes - a.bytes);
  }
  return copy;
}
