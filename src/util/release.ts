import { parse } from "parse-torrent-title";
import type { OmdbType } from "../recc/omdb";

export interface ParsedRelease {
  title: string;
  year?: number;
  type?: OmdbType;
  // Stable key for caching OMDb lookups: many torrents of the same title (just
  // different quality/group) collapse to one lookup.
  key: string;
}

// Which medium a category section implies, if any.
export type SectionHint = "movie" | "series" | undefined;

export function hintForSection(section: string): SectionHint {
  if (section === "movies") return "movie";
  if (section === "tv") return "series";
  return undefined; // "all" and everything else: let OMDb decide
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
  return { title, year, type, key };
}
