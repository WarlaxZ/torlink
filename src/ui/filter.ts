// The TUI's import site for the shared result filter.
//
// The implementation moved to `src/util/resultFilter.ts` when the browser
// search UI needed the same filtering; the one thing that could not move with
// it was the `getSource` registry lookup, which drags in all 23 scrapers and so
// cannot appear in a browser bundle. It is supplied here instead, so the TUI's
// call sites keep their three-argument signature and the browser passes the
// same fact from `GET /api/sources`.
import { getSource } from "../sources/registry";
import type { SourceId } from "../sources/types";
import type { FilterableResult } from "../util/resultFilter";
import { filterResults as filterResultsWith } from "../util/resultFilter";

export function filterResults<T extends FilterableResult>(
  list: readonly T[],
  hideDead: boolean,
  textFilter: string = "",
): T[] {
  // The cast is the same widening `FilterableResult.source: string` forced on
  // the shared module (which cannot import `SourceId` — it imports nothing).
  // `getSource` already falls back to DEFAULT_SOURCE for an id it doesn't know,
  // so an unrecognised string is answered, not thrown.
  return filterResultsWith(
    list,
    hideDead,
    textFilter,
    (source) => getSource(source as SourceId).reportsHealth,
  );
}
