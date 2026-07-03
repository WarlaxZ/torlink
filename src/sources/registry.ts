import { eztv } from "./eztv";
import { fitgirl } from "./fitgirl";
import { nyaa } from "./nyaa";
import { subsplease } from "./subsplease";
import { torrentsCsv } from "./torrentscsv";
import { tpbMovies, tpbTv } from "./piratebay";
import { x1337Movies, x1337Tv } from "./x1337";
import { yts } from "./yts";
import type { Source, SourceGroup, SourceId } from "./types";

export const SOURCES: readonly Source[] = [
  fitgirl,
  yts,
  tpbMovies,
  x1337Movies,
  eztv,
  torrentsCsv,
  tpbTv,
  x1337Tv,
  nyaa,
  subsplease,
];

export const DEFAULT_SOURCE: Source = SOURCES[0]!;

export function getSource(id: SourceId): Source {
  return SOURCES.find((s) => s.id === id) ?? DEFAULT_SOURCE;
}

// The sources actually searched, given the user's disabled list. Order is
// preserved so results and status lines stay stable.
export function enabledSources(disabled: readonly SourceId[]): Source[] {
  if (disabled.length === 0) return [...SOURCES];
  return SOURCES.filter((s) => !disabled.includes(s.id));
}

// Flip a source's disabled state, returning a new list (never mutates input).
export function toggleDisabledSource(
  disabled: readonly SourceId[],
  id: SourceId,
): SourceId[] {
  return disabled.includes(id) ? disabled.filter((d) => d !== id) : [...disabled, id];
}

const GROUP_ORDER: readonly SourceGroup[] = ["Games", "Movies", "TV", "Anime"];

export function sourcesByGroup(): { group: SourceGroup; sources: Source[] }[] {
  return GROUP_ORDER.map((group) => ({
    group,
    sources: SOURCES.filter((s) => s.group === group),
  })).filter((g) => g.sources.length > 0);
}
