import { parseRelease } from "./release";
import { historyKeyFor } from "./streamHistoryKey";
import type { EpisodeRef } from "./episode";

// A stream-history row, reduced to just what "played?" needs. Both StreamHistoryItem
// (TUI) and PublicStreamHistoryItem (web) satisfy this.
export type HistoryLike = {
  key: string;
  type?: string;
  season?: number;
  episode?: number;
};

export interface PlayedIndex {
  // Series keyed by the normalised title (the stored key with any trailing `|series`
  // removed) so it agrees with the results list's group key (showKeyOf).
  series: Map<string, EpisodeRef>;
  // Everything else keyed by its stored key verbatim (year included).
  titles: Set<string>;
}

const stripSeries = (key: string): string => key.replace(/\|series$/, "");

export function buildPlayedIndex(history: readonly HistoryLike[]): PlayedIndex {
  const series = new Map<string, EpisodeRef>();
  const titles = new Set<string>();
  // `?? []`-style tolerance: a partial/undefined row must degrade to "not played",
  // never throw — the same guard the TUI's positionFor documents.
  for (const item of history ?? []) {
    if (!item || typeof item.key !== "string") continue;
    if (item.type === "series") {
      if (item.season === undefined || item.episode === undefined) continue;
      series.set(stripSeries(item.key), { season: item.season, episode: item.episode });
    } else {
      titles.add(item.key);
    }
  }
  return { series, titles };
}

export interface PlayedState {
  played: boolean;
  upTo?: EpisodeRef;
}

// Derive the same key the store wrote with, then look it up. A miss is ordinary — an
// unparseable name is simply "not played".
export function playedStateFor(releaseName: string, index: PlayedIndex): PlayedState {
  const parsed = parseRelease(releaseName);
  if (!parsed) return { played: false };
  if (parsed.type === "series") {
    const showKey = stripSeries(historyKeyFor(parsed));
    const upTo = index.series.get(showKey);
    if (!upTo) return { played: false };
    // The show is in history, so title-level it IS played. But only surface the
    // precise "up to E0x" when this release names the SAME season as the high-water
    // mark: an episode number carried over from another season reads as a false
    // claim — the exact dishonesty positionNote guards against. Different season (or
    // a season-less reference) stays a plain "played".
    if (parsed.season !== undefined && parsed.season === upTo.season) {
      return { played: true, upTo };
    }
    return { played: true };
  }
  return index.titles.has(historyKeyFor(parsed)) ? { played: true } : { played: false };
}

// The TUI's season rows already hold a normalised show key; this is the drop-in for
// the old inline positionFor.
export function seriesPosition(showKey: string, index: PlayedIndex): EpisodeRef | null {
  return index.series.get(showKey) ?? null;
}
