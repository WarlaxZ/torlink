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
  /**
   * What the release name says about picture and sound. Raw parser vocabulary,
   * NOT a normalised enum: `resolution` can be "1080p", "1080i" or "4k", so
   * consumers must go through `resolutionHeight()` in `releasePick.ts` rather
   * than comparing strings. The `*List` fields are the parser's own `colorlist`
   * / `audiolist`, which carry every match rather than just the first — a
   * release can be both HDR and DV.
   */
  resolution?: string;
  codec?: string;
  colorList?: string[];
  audioList?: string[];
  channels?: number;
  bitdepth?: number;
  remux?: boolean;
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

// parse-torrent-title always returns *some* title, even for a name that is
// pure quality/codec/source noise — it leaves the unclassified residue behind
// as `title` ("1080p.WEB-DL.x265" -> title "1080p", "x264-GROUP" -> title
// "x264", "WEB-DL" -> title "WEB"). Rather than hand-maintain a list of
// resolution/codec/source words (which rots as new release formats appear),
// ask the parser itself: it already classified every token it recognised into
// resolution/source/codec/group/etc. If EVERY token of the title is also a
// token the parser recognised elsewhere, nothing survives as an actual title —
// it is noise.
//
// Tokens are compared individually, not glued into one string per field and
// substring-matched: a short real title can legitimately appear *inside* an
// unrelated metadata token ("Up" is a substring of "GROUP"), and joining
// before matching wrongly condemned it. Token-for-token comparison does not.
//
// Some flags come back as bare booleans rather than strings ("PROPER" ->
// {proper: true, title: "PROPER"}), so they never reach the string/array
// branches below. Fold `true`-valued keys in too, using the key's own name —
// still the parser's own vocabulary, not a hand-rolled word list. `false`
// values are not a recognised word and are left out.
function isNoiseOnly(title: string, parsed: Record<string, unknown>): boolean {
  const tokensOf = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const titleTokens = tokensOf(title);
  if (titleTokens.length === 0) return true;
  const recognised = new Set<string>();
  for (const [key, value] of Object.entries(parsed)) {
    if (key === "title" || key === "year" || key === "season" || key === "episode") continue;
    if (typeof value === "string") {
      for (const t of tokensOf(value)) recognised.add(t);
    } else if (Array.isArray(value)) {
      for (const v of value) {
        if (typeof v === "string") for (const t of tokensOf(v)) recognised.add(t);
      }
    } else if (value === true) {
      recognised.add(key.toLowerCase());
    }
  }
  return recognised.size > 0 && titleTokens.every((t) => recognised.has(t));
}

// Extract a clean title (+ year, + medium) from a raw torrent release name so
// it can be looked up on OMDb. Returns null when no usable title survives
// (e.g. the name was only quality/codec noise). A parsed season/episode always
// wins over the section hint; otherwise the hint fills in the medium.
export function parseRelease(name: string, hint?: SectionHint): ParsedRelease | null {
  const p = parse(name);
  const title = (p.title ?? "").trim();
  if (!title || isNoiseOnly(title, p as unknown as Record<string, unknown>)) return null;
  const year = typeof p.year === "number" ? p.year : undefined;
  const isSeries = p.season != null || p.episode != null;
  // Season/episode is decisive; otherwise trust the section the user is in;
  // failing that, a bare year with no episode markers implies a movie.
  const type: OmdbType | undefined = isSeries ? "series" : (hint ?? (year ? "movie" : undefined));
  const key = `${title.toLowerCase()}|${year ?? ""}|${type ?? ""}`;
  const result: ParsedRelease = { title, year, type, key };
  if (typeof p.season === "number") result.season = p.season;
  if (typeof p.episode === "number") result.episode = p.episode;
  if (typeof p.resolution === "string") result.resolution = p.resolution;
  if (typeof p.codec === "string") result.codec = p.codec;
  if (typeof p.channels === "number") result.channels = p.channels;
  if (typeof p.bitdepth === "number") result.bitdepth = p.bitdepth;
  if (p.remux === true) result.remux = true;
  // `colorlist`/`audiolist` are only present when the parser matched more than
  // one; fall back to the singular field so a single match is not lost.
  const colorList = p.colorlist ?? (typeof p.color === "string" ? [p.color] : undefined);
  if (colorList?.length) result.colorList = colorList;
  const audioList = p.audiolist ?? (typeof p.audio === "string" ? [p.audio] : undefined);
  if (audioList?.length) result.audioList = audioList;
  return result;
}
