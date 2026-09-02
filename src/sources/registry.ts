import { bittorrented } from "./bittorrented";
import { eztv } from "./eztv";
import { fitgirl } from "./fitgirl";
import { nyaa, nyaaLiterature } from "./nyaa";
import { subsplease } from "./subsplease";
import { torrentsCsv } from "./torrentscsv";
import { tpbBooks, tpbMovies, tpbMusic, tpbPorn, tpbTv } from "./piratebay";
import { x1337Movies, x1337Music, x1337Porn, x1337Tv } from "./x1337";
import { yts } from "./yts";
import {
  rutrackerGames,
  rutrackerMovies,
  rutrackerTv,
  rutrackerAnime,
  rutrackerMusic,
  rutrackerBooks,
} from "./rutracker";
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
  tpbMusic,
  x1337Music,
  tpbBooks,
  nyaaLiterature,
  rutrackerGames,
  rutrackerMovies,
  rutrackerTv,
  rutrackerAnime,
  rutrackerMusic,
  rutrackerBooks,
  bittorrented,
  tpbPorn,
  x1337Porn,
];

export const DEFAULT_SOURCE: Source = SOURCES[0]!;

export function getSource(id: SourceId): Source {
  return SOURCES.find((s) => s.id === id) ?? DEFAULT_SOURCE;
}

// The sources actually searched, given the user's disabled list. Order is
// preserved so results and status lines stay stable. Adult sources are omitted
// unless the adult ("Porn") category is enabled — this single choke-point keeps
// them out of both the "All" aggregate and per-source searching when disabled.
export function enabledSources(
  disabled: readonly SourceId[],
  adultEnabled = false,
): Source[] {
  return SOURCES.filter(
    (s) => (adultEnabled || !s.adult) && !disabled.includes(s.id),
  );
}

// Flip a source's disabled state, returning a new list (never mutates input).
export function toggleDisabledSource(
  disabled: readonly SourceId[],
  id: SourceId,
): SourceId[] {
  return disabled.includes(id) ? disabled.filter((d) => d !== id) : [...disabled, id];
}

// The category tab a saved/history item belongs to, from its stored source id.
// Deliberately does NOT fall back to DEFAULT_SOURCE's group like getSource()
// does: an unrecognised or absent id (a deleted/renamed source, or a legacy
// hand-pasted magnet with no source at all) must land in the always-visible
// "Unknown" bucket rather than being silently misfiled into a real tab.
export function categoryForSource(id: SourceId | undefined): SourceGroup | "Unknown" {
  if (id === undefined) return "Unknown";
  return SOURCES.find((s) => s.id === id)?.groups?.[0] ?? "Unknown";
}

// Whether a source id is one of the adult ("Porn") sources. An unrecognised or
// absent id answers false, for the same reason categoryForSource answers
// "Unknown" rather than guessing.
export function isAdultSource(id: SourceId | undefined): boolean {
  if (id === undefined) return false;
  return SOURCES.find((s) => s.id === id)?.adult === true;
}

// Drops adult items unless the setting says show them. The single choke point
// both the web routes and the TUI filter saved/history items through, so an
// adult item can never reach either front end by a path that forgot to check.
export function visibleWithAdultHistory<T extends { source?: SourceId }>(
  items: readonly T[],
  adultHistoryVisible: boolean,
): T[] {
  return adultHistoryVisible ? [...items] : items.filter((i) => !isAdultSource(i.source));
}

const CATEGORY_ORDER = ["All", "Games", "Movies", "TV", "Anime", "Music", "Books", "Porn", "Unknown"];

// Which category tabs actually have at least one item, in a fixed display
// order. "All" is always present, even with zero items, so there is always
// somewhere to land.
export function nonEmptyCategories(categories: readonly string[]): string[] {
  const present = new Set(categories);
  return CATEGORY_ORDER.filter((c) => c === "All" || present.has(c));
}

// "Porn" is kept last and only surfaced when adult content is enabled.
const GROUP_ORDER: readonly SourceGroup[] = ["Games", "Movies", "TV", "Anime", "Music", "Books"];
const ADULT_GROUP_ORDER: readonly SourceGroup[] = [...GROUP_ORDER, "Porn"];

export function sourcesByGroup(adultEnabled = false): { group: SourceGroup; sources: Source[] }[] {
  const order = adultEnabled ? ADULT_GROUP_ORDER : GROUP_ORDER;
  return order
    .map((group) => ({
      group,
      sources: SOURCES.filter((s) => (adultEnabled || !s.adult) && s.groups?.includes(group)),
    }))
    .filter((g) => g.sources.length > 0);
}
