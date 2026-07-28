// The result filter (hide-dead + token scoring), shared by the TUI and the
// browser, for the same reason `resultSort.ts` is: `src/web/static/` is bundled
// with `platform: "browser"` and lint forbids it importing `src/ui/**`, so the
// one place both front-ends can reach is `src/util`.
//
// IMPORTS NOTHING. The original `src/ui/filter.ts` imported `getSource` from
// the source registry — which pulls in all 23 scrapers and their Node
// dependencies — for a single boolean per row. That boolean is now a parameter,
// which is what makes the rest of the function shareable. `src/ui/filter.ts`
// supplies the registry lookup; the browser supplies the same fact out of
// `GET /api/sources`, which reports `reportsHealth` per source precisely so it
// can.

/** The fields the filter reads. Structural, so `TorrentResult` and `PublicSearchResult` both fit. */
export interface FilterableResult {
  name: string;
  seeders: number;
  source: string;
}

/**
 * Whether a source's feed carries real swarm counts.
 *
 * THIS IS WHY IT IS INJECTED RATHER THAN ASSUMED. Several sources report
 * `seeders: 0` for every row because their feed has no swarm data at all — 0
 * means "unknown", not "dead" — so a hide-dead filter that judged them on the
 * number would empty those tabs completely. Defaulting an unknown source id to
 * `true` here would do exactly that, which is why both callers pass a real
 * lookup and the browser's comes from the server rather than a guess.
 */
export type ReportsHealth = (source: string) => boolean;

export function filterResults<T extends FilterableResult>(
  list: readonly T[],
  hideDead: boolean,
  textFilter: string,
  reportsHealth: ReportsHealth,
): T[] {
  let filtered: T[] = list.slice();

  if (hideDead) {
    // Sources without swarm data report seeders: 0 for everything (unknown, not
    // dead), so the filter only judges rows whose source actually reports health.
    filtered = filtered.filter((r) => r.seeders > 0 || !reportsHealth(r.source));
  }

  const text = textFilter.trim().toLowerCase();
  if (text) {
    const tokens = text.split(/\s+/);
    const scored = filtered.map((r) => {
      const name = r.name.toLowerCase();
      let score = 0;

      // Every token must be present
      const matchesAll = tokens.every((token) => name.includes(token));
      if (!matchesAll) return { r, score: 0 };

      score += 10; // Base score for matching all tokens

      const normalizedText = tokens.join(" ");
      if (name.includes(normalizedText)) {
        score += 50; // Exact substring gets highest boost
      } else {
        // Boost if tokens appear in the same order
        let lastIndex = -1;
        let inOrder = true;
        for (const token of tokens) {
          const idx = name.indexOf(token, lastIndex + 1);
          if (idx === -1 || idx < lastIndex) {
            inOrder = false;
            break;
          }
          lastIndex = idx;
        }
        if (inOrder) score += 20;
      }

      return { r, score };
    });

    filtered = scored
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.r);
  }

  return filtered;
}
