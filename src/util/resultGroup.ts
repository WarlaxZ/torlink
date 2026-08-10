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
// One definition of "the same show" — the history key uses the same one.
import { normaliseTitle, tidyTitle } from "./titleKey";
import type { OmdbType } from "../recc/omdb";
// episode.ts imports nothing, so this costs the browser bundle nothing.
import type { EpisodeRef } from "./episode";

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

/**
 * One line of the rendered list: a season heading, a group heading, or a release.
 *
 * `depth` is how far the row is indented — 0 top level, 1 inside an open season,
 * 2 a release inside an episode group inside an open season. Both front ends
 * read it rather than deriving indent themselves.
 */
export type GroupRow<T> =
  | {
      kind: "season";
      key: string;
      title: string;
      season: number;
      members: T[];
      expanded: boolean;
      depth: number;
    }
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
      depth: number;
    }
  | { kind: "release"; key: string; result: T; inGroup: boolean; depth: number };

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
 *
 * `underSeason` is the form for a row nested inside a season heading, which
 * already states the show and the season. Repeating both at every level reads as
 * noise; "S03E01" and "Season pack" say the only thing that differs.
 */
export function groupHeading(
  group: {
    title: string;
    year?: number;
    season?: number;
    seasonEnd?: number;
    episode?: number;
  },
  opts?: { underSeason?: boolean },
): string {
  if (opts?.underSeason && group.season !== undefined) {
    return group.episode !== undefined
      ? `S${pad(group.season)}E${pad(group.episode)}`
      : "Season pack";
  }
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
 * A season of one show, holding its packs and its episode groups.
 *
 * `members` is every child's members concatenated in child order, which is what
 * lets `resultAtRow` keep working untouched: packs sort first, so the first
 * member of a collapsed season row is the best season pack.
 */
export interface SeasonNode<T> {
  kind: "season";
  key: string;
  title: string;
  season: number;
  /** Packs first, then episodes ascending. Never empty. */
  children: ResultGroup<T>[];
  /** Never empty. */
  members: T[];
}

/** A top-level node: a season of a show, or a group with no season to sit under. */
export type TreeNode<T> = SeasonNode<T> | ResultGroup<T>;

/** True for a `SeasonNode`. `ResultGroup` has no `kind`, which is the discriminator. */
export function isSeasonNode<T>(node: TreeNode<T>): node is SeasonNode<T> {
  return "kind" in node;
}

/**
 * Which groups fold under a season.
 *
 * A group naming ONE season. A span pack ("S01-S03") names three and filing it
 * under season 1 would claim it is a season-1 release; a "complete series" pack
 * names none. Both stay top-level. Only the series branch of `factsFor` ever
 * sets `season`, so this needs no separate "is a series" flag.
 */
function foldsUnderSeason<T>(group: ResultGroup<T>): boolean {
  return group.season !== undefined && group.seasonEnd === undefined;
}

/**
 * "harrowgate" out of any group key — the show's identity, and what a watch
 * position is keyed on. Exported so the front ends build their lookup with the
 * same rule rather than each slicing the key their own way.
 */
export function showKeyOf(groupKey: string): string {
  const at = groupKey.indexOf("|series|");
  return at === -1 ? groupKey : groupKey.slice(0, at);
}

/** Where the user is in a show, by normalised show key. Null when unknown. */
export type PositionLookup = (showKey: string) => EpisodeRef | null;

/** The episode after a position. `nextEpisode` in src/core owns the public one. */
function nextOf(at: EpisodeRef): EpisodeRef {
  return { season: at.season, episode: at.episode + 1 };
}

/**
 * The group key of the episode to land on, or null.
 *
 * NULL WHEN THE RESULTS DO NOT HAVE IT. A position is a suggestion — nothing has
 * asked a tracker whether the next episode exists — so a season aired up to E07
 * that returns no E08 must not grow a phantom row. The results are the authority
 * on what can be selected.
 */
export function nextUpRowKey<T extends GroupableResult>(
  groups: readonly ResultGroup<T>[],
  positionFor: PositionLookup,
): string | null {
  for (const group of groups) {
    if (group.season === undefined || group.episode === undefined) continue;
    const at = positionFor(showKeyOf(group.key));
    if (!at) continue;
    const want = nextOf(at);
    if (group.season === want.season && group.episode === want.episode) return group.key;
  }
  return null;
}

/** Packs before episodes; episodes ascending. */
function compareSeasonChild<T>(a: ResultGroup<T>, b: ResultGroup<T>): number {
  if (a.episode === undefined && b.episode === undefined) return 0;
  if (a.episode === undefined) return -1;
  if (b.episode === undefined) return 1;
  return a.episode - b.episode;
}

/**
 * Fold a show's single-season groups under season nodes.
 *
 * ORDER IS PRESERVED at the top level: a show's whole season block is emitted at
 * the position of its FIRST group, so `groupResults`' promise that groups sit
 * where their best member sits — which every sort depends on — still holds.
 * Within a show, seasons are newest first.
 *
 * The sort control therefore orders releases INSIDE a group, and orders
 * unrelated results against each other. A series' internal structure is
 * structural and not re-sortable: "order these episodes by seeders" is not a
 * thing anyone wants.
 */
export function seasonTree<T extends GroupableResult>(
  groups: readonly ResultGroup<T>[],
): TreeNode<T>[] {
  const byShow = new Map<string, Map<number, ResultGroup<T>[]>>();
  for (const group of groups) {
    if (!foldsUnderSeason(group)) continue;
    const show = showKeyOf(group.key);
    let seasons = byShow.get(show);
    if (!seasons) {
      seasons = new Map();
      byShow.set(show, seasons);
    }
    const bucket = seasons.get(group.season!) ?? [];
    bucket.push(group);
    seasons.set(group.season!, bucket);
  }

  const out: TreeNode<T>[] = [];
  const done = new Set<string>();
  for (const group of groups) {
    if (!foldsUnderSeason(group)) {
      out.push(group);
      continue;
    }
    const show = showKeyOf(group.key);
    if (done.has(show)) continue;
    done.add(show);
    const seasons = byShow.get(show)!;
    for (const season of [...seasons.keys()].sort((a, b) => b - a)) {
      const children = [...seasons.get(season)!].sort(compareSeasonChild);
      out.push({
        kind: "season",
        key: `${show}|series|s${season}`,
        title: children[0]!.title,
        season,
        children,
        members: children.flatMap((child) => child.members),
      });
    }
  }
  return out;
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
  for (const node of seasonTree(groups)) {
    if (!isSeasonNode(node)) {
      pushGroupRows(rows, node, expanded, 0);
      continue;
    }
    // A season node holding a SINGLE child is dropped and its child emitted in
    // its place: wrapping one episode in a season row is the same noise as a
    // disclosure over "1 release", and without this a search returning one
    // release of one show would grow a heading it never had.
    const only = node.children.length === 1 ? node.children[0] : undefined;
    if (only) {
      pushGroupRows(rows, only, expanded, 0);
      continue;
    }
    const isOpen = expanded.has(node.key);
    rows.push({
      kind: "season",
      key: node.key,
      title: node.title,
      season: node.season,
      members: node.members,
      expanded: isOpen,
      depth: 0,
    });
    if (!isOpen) continue;
    for (const child of node.children) pushGroupRows(rows, child, expanded, 1);
  }
  return rows;
}

/**
 * The keys a fresh result set should start with open.
 *
 * WITH a position: the season holding the next episode.
 *
 * WITHOUT one: the highest-ranked season node, and only that one. Without it a search for one
 * season collapses to a single line, which reads as the list having failed.
 *
 * "Highest-ranked" rather than "the only one": a real search for one season of
 * one show also returned a different show's season and two unrelated episodes,
 * so a rule asking whether the season is alone would have left it shut on the
 * very query that motivated this. Ranking needs no counting and strays cannot
 * defeat it.
 *
 * A season the row plan DROPS (one child) is skipped — there is no row to open.
 *
 * A SEED, not a running rule: the caller puts these into the expansion set it
 * already owns, so collapsing one behaves like collapsing anything else.
 */
export function defaultExpandedKeys<T extends GroupableResult>(
  groups: readonly ResultGroup<T>[],
  positionFor?: PositionLookup,
): string[] {
  const nodes = seasonTree(groups);
  // WITH a position: the season holding the next episode, which is the whole
  // point — you searched a show to carry on watching it.
  if (positionFor) {
    for (const node of nodes) {
      if (!isSeasonNode(node) || node.children.length <= 1) continue;
      const at = positionFor(showKeyOf(node.key));
      if (at && nextOf(at).season === node.season) return [node.key];
    }
  }
  for (const node of nodes) {
    if (isSeasonNode(node) && node.children.length > 1) return [node.key];
  }
  return [];
}

/**
 * One group's rows, at a given depth. The "group of one" rule is here: a
 * disclosure arrow over "1 release" is noise, and it would make the common case
 * — a search where nothing duplicates — look like a different feature.
 */
function pushGroupRows<T extends GroupableResult>(
  rows: GroupRow<T>[],
  group: ResultGroup<T>,
  expanded: ReadonlySet<string>,
  depth: number,
): void {
  const first = group.members[0];
  if (first === undefined) return;
  if (group.members.length === 1) {
    rows.push({ kind: "release", key: group.key, result: first, inGroup: depth > 0, depth });
    return;
  }
  const isOpen = expanded.has(group.key);
  const row: GroupRow<T> = {
    kind: "group",
    key: group.key,
    title: group.title,
    members: group.members,
    expanded: isOpen,
    depth,
  };
  if (group.year !== undefined) row.year = group.year;
  if (group.season !== undefined) row.season = group.season;
  if (group.seasonEnd !== undefined) row.seasonEnd = group.seasonEnd;
  if (group.episode !== undefined) row.episode = group.episode;
  rows.push(row);
  if (!isOpen) return;
  group.members.forEach((member, i) => {
    rows.push({
      kind: "release",
      key: `${group.key}#${i}`,
      result: member,
      inGroup: true,
      depth: depth + 1,
    });
  });
}

/**
 * The release a row acts on.
 *
 * A collapsed header resolves to its FIRST member. For a group that is its best
 * one under the current sort; for a SEASON row it is the best season pack,
 * because `seasonTree` sorts packs ahead of episodes for exactly this reason —
 * `play`/`add` on a collapsed season must grab the season, not episode one. Do
 * not "fix" that ordering away.
 *
 * That is what lets every existing action keep working untouched: play, add,
 * favourite and the preview lookup all take a release, and a header hands them
 * one without any new picking logic.
 */
export function resultAtRow<T>(row: GroupRow<T>): T | null {
  return row.kind === "release" ? row.result : (row.members[0] ?? null);
}

/**
 * What pressing play on a SEASON row should do.
 *
 * A season made of loose episodes has no single "the season" torrent, so
 * `members[0]` is merely the best release of episode one — playing it silently is
 * the bug this fixes. Instead: reveal the episodes and land on the one you are up
 * to. A season that DOES contain a pack keeps today's behaviour — grab the pack
 * (`members[0]`; packs sort first) and let the resolve→file-picker path preselect
 * the next episode, which also surfaces any extras inside the pack.
 *
 * Pure and shared so both front ends decide identically; the front ends only
 * wire the two outcomes. `resultAtRow` is deliberately NOT changed — add,
 * favourite and preview still resolve a release from it.
 */
export type SeasonPlayPlan<T> =
  | { kind: "resolve"; result: T | null }
  | { kind: "reveal"; expandKey: string; selectKey: string | null; select: T | null };

export function seasonPlayPlan<T extends GroupableResult>(
  groups: readonly ResultGroup<T>[],
  seasonKey: string,
  positionFor?: PositionLookup,
): SeasonPlayPlan<T> {
  const node = seasonTree(groups).find(
    (n): n is SeasonNode<T> => isSeasonNode(n) && n.key === seasonKey,
  );
  // Not a season row (a film, a single-episode group) or gone: behave as play
  // does today — resolve the first member.
  if (!node) {
    return { kind: "resolve", result: groups.find((g) => g.key === seasonKey)?.members[0] ?? null };
  }
  // A child with no episode number is a pack: the whole season in one torrent.
  if (node.children.some((c) => c.episode === undefined)) {
    return { kind: "resolve", result: node.members[0] ?? null };
  }
  // Loose episodes only. Land on the next-up episode when the results have it,
  // else the first episode. `children` are episodes ascending (seasonTree sorts).
  const at = positionFor?.(showKeyOf(node.key)) ?? null;
  const target =
    (at &&
      node.children.find((c) => c.season === at.season && c.episode === at.episode + 1)) ||
    node.children[0]!;
  return {
    kind: "reveal",
    expandKey: node.key,
    selectKey: target.key,
    select: target.members[0] ?? null,
  };
}

/**
 * The note a season heading carries when you are part-way through it.
 *
 * "up to E07", NOT "watched" — the store holds a HIGH-WATER MARK, one entry per
 * title, and `recordStream` deliberately keeps it that way so replaying an early
 * episode does not rewind you. Claiming E01–E06 are watched is not something
 * that data can support once someone jumps around.
 *
 * Empty string, never null, so a renderer can concatenate without a branch.
 */
export function positionNote(season: number, at: EpisodeRef | null): string {
  if (!at || at.season !== season) return "";
  return `up to E${pad(at.episode)}`;
}

/** "12 releases" for a group heading. */
export function groupCountLabel(members: number): string {
  return `${members} release${members === 1 ? "" : "s"}`;
}
