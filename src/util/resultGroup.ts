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
  /** Never empty. In the order the caller supplied. */
  members: T[];
}

/** One line of the rendered list: a group heading, or a release. */
export type GroupRow<T> =
  | { kind: "group"; key: string; title: string; year?: number; members: T[]; expanded: boolean }
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
  return (
    raw
      // "www.uindex.org    -    Kestrel 2010": a tracker stamps its own domain on
      // the front of the release name. Five of 129 live results for one film were
      // stranded in a group of their own by this alone.
      .replace(/^\s*(?:www\.)?[a-z0-9-]+\.[a-z]{2,12}\s*[-–—]\s*/i, "")
      .replace(/\.(?:mkv|mp4|m4v|avi|7z|zip|iso)$/i, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .replace(/^(?:the|a|an)\s+/, "")
      .trim()
  );
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
export function groupKeyFor(name: string, hint?: OmdbType): string {
  const parsed = parseRelease(name, hint);
  // parseRelease returns null for some real names (a Korean-titled release in
  // live data). A group of one is the right answer, not a crash.
  if (!parsed) return `raw|${normaliseTitle(name) || name.trim().toLowerCase()}`;
  const title = normaliseTitle(parsed.title) || parsed.title.trim().toLowerCase();
  if (parsed.type === "series") {
    const season = parsed.season !== undefined ? `s${parsed.season}` : "s";
    // No episode number on a series release means a season pack — the edge case
    // that catches "next episode" bugs elsewhere in this codebase, and the one
    // that must not share a key with S03E01.
    const episode = parsed.episode !== undefined ? `e${parsed.episode}` : "pack";
    return `${title}|series|${season}|${episode}`;
  }
  return `${title}|${parsed.year ?? ""}|${parsed.type ?? ""}`;
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
    const key = groupKeyFor(item.name, hint);
    const existing = byKey.get(key);
    if (existing) {
      existing.members.push(item);
      continue;
    }
    const parsed = parseRelease(item.name, hint);
    const group: ResultGroup<T> = {
      key,
      title: parsed?.title ?? item.name,
      members: [item],
    };
    if (parsed?.year !== undefined) group.year = parsed.year;
    byKey.set(key, group);
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
