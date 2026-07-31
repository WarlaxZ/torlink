// Grouping many releases of one thing into one row, for both front ends.
//
// A NEW FILE rather than an addition to resultSort.ts, whose header states it
// "IMPORTS NOTHING, deliberately" — this needs `./release`. That import is
// browser-safe and already in the web bundle (src/web/static/streamFlow.ts
// imports parseRelease, and tsup.web.config.ts has noExternal for its one
// runtime dependency), so src/web/static/searchModel.ts can reach this the same
// way it already reaches sortResults and filterResults.
//
// Structural input type and a generic return, the convention resultSort.ts and
// resultFilter.ts already follow: TorrentResult and PublicSearchResult both fit
// without either front end's types leaking in here.
import { parseRelease } from "./release";
import type { OmdbType } from "../recc/omdb";

export interface GroupableResult {
  name: string;
}

export interface ResultGroup<T> {
  /** The grouping key. Stable, and the expand/collapse identity. */
  key: string;
  /** Display title, from the parser — "Tin Rivers", not "Tin.Rivers.2024…". */
  title: string;
  year?: number;
  /**
   * What the group covers, when it is a series. THESE EXIST TO BE RENDERED.
   * Without them every heading of a show is the bare title, so a season pack and
   * five episodes of that season — six correctly distinct groups — draw six rows
   * that all read "Harrowgate", and the list looks duplicated when it is not.
   * `seasonEnd` is set only for a span ("S01-S03"); `episode` only for a single
   * episode, so a season pack is `season` with no `episode`.
   */
  season?: number;
  seasonEnd?: number;
  episode?: number;
  /** Never empty. In the order the caller supplied. */
  members: T[];
}

/** One line of the rendered list: a group heading, or a release. */
export type GroupRow<T> =
  | {
      kind: "group";
      key: string;
      title: string;
      year?: number;
      season?: number;
      seasonEnd?: number;
      episode?: number;
      members: T[];
      expanded: boolean;
    }
  | { kind: "release"; key: string; result: T; inGroup: boolean };

/**
 * Normalise a parsed title before it becomes a key.
 *
 * THE ORDER IS LOAD-BEARING. Punctuation becomes spaces BEFORE the leading
 * article is dropped: a title wrapped in another script — "супер … (the …
 * movie)" appears in live data — keeps its "the" if the article is stripped
 * first, and splits off into a group of its own.
 */
function normaliseTitle(raw: string): string {
  const base = raw
    // "www.uindex.org    -    Kestrel 2010": a tracker stamps its own domain on
    // the front of the release name. Five of 129 live results for one film were
    // stranded in a group of their own by this alone.
    .replace(/^\s*(?:www\.)?[a-z0-9-]+\.[a-z]{2,12}\s*[-–—]\s*/i, "")
    // "[Judas] Harrowgate S03": see BRACKET_PREFIX.
    .replace(BRACKET_PREFIX, "")
    .replace(/\.(?:mkv|mp4|m4v|avi|7z|zip|iso)$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^(?:the|a|an)\s+/, "")
    .trim();
  // "Harrowgate Complete Series" is the same show as "Harrowgate": the parser
  // leaves pack words in the title when no season number follows them to anchor
  // on. Stripped only from the END and never down to nothing, so a title that is
  // genuinely one of these words survives.
  const trimmed = base.replace(PACK_FILLER, "").trim();
  return trimmed || base;
}

const PACK_FILLER = /(?:[\s._-]+(?:complete|full|series|seasons?|packs?))+$/i;

/**
 * A release group in brackets on the front, the convention for fansubbed shows.
 *
 * The lookahead demands a LETTER in what is left, not merely a non-space: a film
 * actually titled "(Ashfall) 1999" would otherwise reduce to "1999", and a title
 * eaten down to a bare number groups with every other numeric residue. Bracketed
 * junk in front of nothing is not a prefix, it IS the name.
 */
const BRACKET_PREFIX = /^\s*[[({][^\])}]*[\])}]\s*(?=[^a-z]*[a-z])/i;

/**
 * The same two strips, on the DISPLAY title, which keeps its own case.
 *
 * A heading reading "Harrowgate COMPLETE SERIES" while the group beside it reads
 * "Harrowgate" is the duplicate-looking-rows complaint again, one layer up: the
 * key already treats them as one thing, so the label has to as well.
 */
function tidyTitle(raw: string): string {
  const base = raw.replace(BRACKET_PREFIX, "").trim();
  return base.replace(PACK_FILLER, "").trim() || base;
}

/**
 * The season the NAME ITSELF states, which beats the parser when they disagree.
 *
 * "Harrowgate.S03.COMPLETE.SEASON.1080p" parses as season 10 — the parser sees
 * "SEASON" and takes the "10" out of "1080p" — and that one release then sits in
 * a group of its own. The name's first explicit marker is the honest answer.
 *
 * Returns a span for "S01-S03", which is a multi-season pack and must not land
 * in the same group as season 1 alone.
 */
function seasonFromName(name: string): { season: number; seasonEnd?: number } | null {
  const marker = /(?:^|[^a-z0-9])s(?:eason)?[\s._-]*(\d{1,2})(?![\d])/i.exec(name);
  if (!marker?.[1]) return null;
  const season = Number(marker[1]);
  // "S01-S03", "S01-03": a range, from the marker we just matched onwards.
  const rest = name.slice(marker.index + marker[0].length);
  const span = /^[\s._-]*[-–—][\s._-]*s?(\d{1,2})(?![\d])/i.exec(rest);
  const end = span?.[1] ? Number(span[1]) : undefined;
  return end !== undefined && end > season ? { season, seasonEnd: end } : { season };
}

/**
 * The grouping key for one release name.
 *
 * NOT `parseRelease().key`, which is `title|year|type` and therefore
 * `kepler||series` for every episode of every season of a show — one bucket for
 * a whole series, which makes grouping useless on a TV tab. Films key on title
 * and year (so `Ashfall.1999` and `Ashfall.2024` stay apart); episodes key down
 * to the episode; a season pack keys distinctly from any episode within it.
 */
interface GroupFacts {
  key: string;
  title: string;
  year?: number;
  season?: number;
  seasonEnd?: number;
  episode?: number;
}

/**
 * Everything a group needs from one release name, parsed once.
 *
 * One function rather than a `groupKeyFor` and a second parse inside
 * `groupResults`: the key and the heading have to agree about which season a
 * release is in, and two call sites deriving that separately is how they drift.
 */
function factsFor(name: string, hint?: OmdbType): GroupFacts {
  const parsed = parseRelease(name, hint);
  // parseRelease returns null for some real names (a Korean-titled release in
  // live data). A group of one is the right answer, not a crash.
  if (!parsed) {
    const raw = normaliseTitle(name) || name.trim().toLowerCase();
    return { key: `raw|${raw}`, title: name };
  }
  const norm = normaliseTitle(parsed.title) || parsed.title.trim().toLowerCase();
  const facts: GroupFacts = { key: "", title: tidyTitle(parsed.title) || parsed.title };
  if (parsed.year !== undefined) facts.year = parsed.year;
  if (parsed.type !== "series") {
    facts.key = `${norm}|${parsed.year ?? ""}|${parsed.type ?? ""}`;
    return facts;
  }
  const stated = seasonFromName(name);
  const season = stated?.season ?? parsed.season;
  if (season !== undefined) facts.season = season;
  if (stated?.seasonEnd !== undefined) facts.seasonEnd = stated.seasonEnd;
  if (parsed.episode !== undefined) facts.episode = parsed.episode;
  const span = facts.seasonEnd !== undefined ? `-${facts.seasonEnd}` : "";
  const seasonPart = season !== undefined ? `s${season}${span}` : "s";
  // No episode number on a series release means a season pack — the edge case
  // that catches "next episode" bugs elsewhere in this codebase, and the one
  // that must not share a key with S03E01.
  const episodePart = facts.episode !== undefined ? `e${facts.episode}` : "pack";
  facts.key = `${norm}|series|${seasonPart}|${episodePart}`;
  return facts;
}

export function groupKeyFor(name: string, hint?: OmdbType): string {
  return factsFor(name, hint).key;
}

/** Zero-padded to two digits, the form every release name uses. */
function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * What a group heading says.
 *
 * Shared by both front ends because the alternative — each formatting its own —
 * is exactly the copy-then-drift this codebase records four bugs from. The
 * season and episode are the point: `title` alone made a pack and every episode
 * of one season render as identical rows.
 */
export function groupHeading(group: {
  title: string;
  year?: number;
  season?: number;
  seasonEnd?: number;
  episode?: number;
}): string {
  if (group.season !== undefined) {
    const span = group.seasonEnd !== undefined ? `-S${pad(group.seasonEnd)}` : "";
    const episode = group.episode !== undefined ? `E${pad(group.episode)}` : "";
    return `${group.title} S${pad(group.season)}${span}${episode}`;
  }
  // A film. The year is what tells two films sharing a title apart, which is the
  // same job the season does for a show.
  return group.year !== undefined ? `${group.title} (${group.year})` : group.title;
}

/**
 * Group a list that has ALREADY been filtered and sorted.
 *
 * Order is preserved in both directions — groups by their first member, members
 * as given — so every existing sort still means what it means. `sortResults`'s
 * "none" is the server's seeders-then-recency order and both front ends show it;
 * grouping must not quietly reorder that.
 */
export function groupResults<T extends GroupableResult>(
  list: readonly T[],
  hint?: OmdbType,
): ResultGroup<T>[] {
  const byKey = new Map<string, ResultGroup<T>>();
  for (const item of list) {
    const facts = factsFor(item.name, hint);
    const existing = byKey.get(facts.key);
    if (existing) {
      existing.members.push(item);
      continue;
    }
    const group: ResultGroup<T> = { key: facts.key, title: facts.title, members: [item] };
    if (facts.year !== undefined) group.year = facts.year;
    if (facts.season !== undefined) group.season = facts.season;
    if (facts.seasonEnd !== undefined) group.seasonEnd = facts.seasonEnd;
    if (facts.episode !== undefined) group.episode = facts.episode;
    byKey.set(facts.key, group);
  }
  return [...byKey.values()];
}

/**
 * Flatten groups into the rows to render, honouring what is expanded.
 *
 * A group of one is emitted as a plain release row: a disclosure arrow over
 * "1 release" is noise, and it would make the common case — a search where
 * nothing duplicates — look like a different feature.
 *
 * Shared by both front ends deliberately. The browser renders these rows with
 * createElement and the terminal with Ink boxes, but "which rows are there" is
 * one decision, and this codebase records four bugs caused by copying one
 * instead of moving it down here.
 */
export function groupRowPlan<T extends GroupableResult>(
  groups: readonly ResultGroup<T>[],
  expanded: ReadonlySet<string>,
): GroupRow<T>[] {
  const rows: GroupRow<T>[] = [];
  for (const group of groups) {
    const first = group.members[0];
    if (first === undefined) continue;
    if (group.members.length === 1) {
      rows.push({ kind: "release", key: group.key, result: first, inGroup: false });
      continue;
    }
    const isOpen = expanded.has(group.key);
    const row: GroupRow<T> = {
      kind: "group",
      key: group.key,
      title: group.title,
      members: group.members,
      expanded: isOpen,
    };
    if (group.year !== undefined) row.year = group.year;
    if (group.season !== undefined) row.season = group.season;
    if (group.seasonEnd !== undefined) row.seasonEnd = group.seasonEnd;
    if (group.episode !== undefined) row.episode = group.episode;
    rows.push(row);
    if (!isOpen) continue;
    group.members.forEach((member, i) => {
      rows.push({ kind: "release", key: `${group.key}#${i}`, result: member, inGroup: true });
    });
  }
  return rows;
}

/**
 * The release a row acts on.
 *
 * A collapsed header resolves to its FIRST member, which under the current sort
 * is its best one. That is what lets every existing action keep working
 * untouched: play, add, favourite and the preview lookup all take a release, and
 * a header hands them one without any new picking logic.
 */
export function resultAtRow<T>(row: GroupRow<T>): T | null {
  return row.kind === "release" ? row.result : (row.members[0] ?? null);
}

/** "12 releases" for a group heading. */
export function groupCountLabel(members: number): string {
  return `${members} release${members === 1 ? "" : "s"}`;
}
