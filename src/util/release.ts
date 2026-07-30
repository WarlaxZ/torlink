import { parse } from "parse-torrent-title";
import type { OmdbType } from "../recc/omdb";

export interface ParsedRelease {
  title: string;
  year?: number;
  type?: OmdbType;
  // Stable key for caching OMDb lookups: many torrents of the same title (just
  // different quality/group) collapse to one lookup.
  key: string;
  /**
   * Season and episode, when the release named them. Both optional and
   * independent: a SEASON PACK ("Harrowgate.S03") yields a season with no
   * episode, so a consumer must not treat a known season as implying episode 1.
   */
  season?: number;
  episode?: number;
}

// Which medium a category section implies, if any.
export type SectionHint = "movie" | "series" | undefined;

export function hintForSection(section: string): SectionHint {
  if (section === "movies") return "movie";
  if (section === "tv") return "series";
  return undefined; // "all" and everything else: let OMDb decide
}

// The same question asked with a source *group* name rather than a TUI section
// key. The web UI's category tabs come from `sourcesByGroup` ("Movies", "TV",
// "Anime", …) while the TUI's sidebar uses lowercase section keys, and this is
// the seam where those two vocabularies meet — written down once here rather
// than left as a `.toLowerCase()` at the call site that happens to line up.
export function hintForGroup(group: string | null | undefined): SectionHint {
  return hintForSection((group ?? "").toLowerCase());
}

// Extract a clean title (+ year, + medium) from a raw torrent release name so
// it can be looked up on OMDb. Returns null when no usable title survives
// (e.g. the name was only quality/codec noise). A parsed season/episode always
// wins over the section hint; otherwise the hint fills in the medium.
export function parseRelease(name: string, hint?: SectionHint): ParsedRelease | null {
  const p = parse(name);
  const title = (p.title ?? "").trim();
  if (!title) return null;
  const year = typeof p.year === "number" ? p.year : undefined;
  const isSeries = p.season != null || p.episode != null;
  // Season/episode is decisive; otherwise trust the section the user is in;
  // failing that, a bare year with no episode markers implies a movie.
  const type: OmdbType | undefined = isSeries ? "series" : (hint ?? (year ? "movie" : undefined));
  const key = `${title.toLowerCase()}|${year ?? ""}|${type ?? ""}`;
  const result: ParsedRelease = { title, year, type, key };
  if (typeof p.season === "number") result.season = p.season;
  if (typeof p.episode === "number") result.episode = p.episode;
  return result;
}
