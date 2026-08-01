/**
 * What else the player page can offer: the rest of the torrent, what to play
 * next, and the way back to the show.
 *
 * WHY THE PAGE NEEDS ANY OF THIS. `/play/:sid/:idx` is a separate document that
 * knows one file. Finish an episode and the only affordance is Back, which
 * before this change was a full page load onto an empty search box. The terminal
 * has never had that problem — `playFromPicker` (`src/ui/App.tsx`) keeps the
 * picker open on purpose, "so the user can go straight to the next episode" —
 * and this is the browser catching up rather than a new idea.
 *
 * A PURE MODULE, tested, because `app.ts` and `player.ts` are DOM wiring only
 * (CLAUDE.md): "what to show" and "what to send" are decisions and they live
 * here. `player.ts` turns the rows below into elements and does nothing else
 * with them.
 */
import { parseRelease } from "../../util/release";
import { sortStreamFiles } from "../../util/streamFileSort";
import { fileLabel, playerPath } from "./streamFlow";
import { searchForRoute, DEFAULT_ROUTE } from "./route";
import type { PublicStreamFile, StreamFilesResponse } from "../wire";

export interface EpisodeRow {
  file: PublicStreamFile;
  /** `fileLabel`'s line, so this list and the picker read identically. */
  label: string;
  /** `/play/:sid/:idx?k=…&n=…` — the same page, a different file. */
  href: string;
  /** True for the one file this player page is for. */
  current: boolean;
  /**
   * A season heading to print ABOVE this row, or null.
   *
   * On the row rather than in a separate tree because the list is flat and the
   * heading is a property of where a row sits in it: a caller renders rows in
   * order and emits a heading whenever one is present, which is one loop and no
   * nesting. A tree would be a second shape to keep in step with the ordering.
   */
  heading: string | null;
}

export interface Breadcrumb {
  label: string;
  href: string;
}

export interface UpNextView {
  /**
   * Every playable file, in the picker's display order, headings folded in.
   *
   * EMPTY for a single-file session. A film has nothing to list, and an "all
   * episodes" heading over the one row you are already on is noise.
   */
  rows: EpisodeRow[];
  /**
   * The row after the current one, or null when there isn't one.
   *
   * "The next file in the order shown" — NOT `nextEpisodeIndex`'s "the next
   * unwatched episode". That function answers a different question: which row a
   * picker opening cold should land on, given only a high-water mark. Here the
   * user has just played the current file, which is a fact this page holds and
   * a cold picker does not, so there is nothing left to infer and no history to
   * consult. Reusing it would be a reuse in name only, and it would get the
   * rewatch case wrong — going back to E02 and asking for the next thing must
   * offer E03, not the E06 the high-water mark points at.
   */
  next: EpisodeRow | null;
  /** The show or film this session is, and a search that finds it. Never null. */
  breadcrumb: Breadcrumb;
}

/** The dashboard, for when a release name tells us nothing to search for. */
const HOME: Breadcrumb = { label: "torlnk", href: "/" };

/**
 * Where the breadcrumb points.
 *
 * A SEARCH, not a restored session: the session behind this player page is
 * ephemeral and its capability dies with it, so the honest destination is the
 * query that found the thing. `searchForRoute` composes it, so this link and the
 * URL the dashboard writes for itself cannot spell the same state differently.
 *
 * The tab is picked from what the name parses as, because landing on All when
 * the user was on TV shows loses the filter they chose. `parseRelease` decides
 * "series" from a season or episode number, so a pack is a series and a bare
 * title with a year is a film — the same judgement every other surface makes.
 */
function breadcrumbFor(name: string): Breadcrumb {
  const parsed = parseRelease(name);
  if (!parsed) return HOME;
  const group = parsed.type === "series" ? "TV" : parsed.type === "movie" ? "Movies" : "";
  const href = searchForRoute({
    ...DEFAULT_ROUTE,
    query: parsed.title,
    group: group || DEFAULT_ROUTE.group,
  });
  return href ? { label: parsed.title, href: `/${href}` } : HOME;
}

/** The season a file's own name commits to, or null. Season packs name none. */
function seasonOf(filename: string): number | null {
  const parsed = parseRelease(filename);
  return parsed?.season ?? null;
}

/**
 * The whole of what the player page renders below its own file.
 *
 * `index` is the SESSION index from the page's URL, which is why the rows carry
 * `file.index` rather than their position: `.files` has already dropped the
 * `.nfo`s, so the two differ, and a link built from a list position plays a
 * different episode than the one clicked. An index naming no file in the list —
 * a hand-edited URL, or the index of a file the video filter removed — is an
 * ordinary answer: nothing is marked current and nothing is next.
 */
export function upNextView(
  body: StreamFilesResponse,
  sessionId: string,
  index: number,
  capability: string,
): UpNextView {
  const breadcrumb = breadcrumbFor(body.name);
  if (body.files.length < 2) return { rows: [], next: null, breadcrumb };

  // "name", the picker's default: a season pack listed in whatever order the
  // torrent named its files is the bug `sortStreamFiles` was extracted to fix,
  // and the two lists must not disagree about episode order.
  const sorted = sortStreamFiles(body.files, "name");
  const seasons = sorted.map((f) => seasonOf(f.filename));
  // Headings only when they DISTINGUISH something. Multi-season packs exist and
  // sixty ungrouped rows is a wall, but a lone "Season 3" over a list that is
  // entirely season 3 says nothing the page has not already said — and a
  // torrent that numbers nothing at all must stay a plain list.
  const multiSeason = new Set(seasons.filter((s) => s !== null)).size > 1;
  let lastSeason: number | null = null;
  const rows: EpisodeRow[] = sorted.map((file, at) => {
    const season = seasons[at] ?? null;
    const heading = multiSeason && season !== null && season !== lastSeason
      ? `Season ${season}`
      : null;
    if (season !== null) lastSeason = season;
    return {
      file,
      label: fileLabel(file),
      href: playerPath(sessionId, file, capability),
      current: file.index === index,
      heading,
    };
  });

  const at = rows.findIndex((row) => row.current);
  return { rows, next: at >= 0 ? (rows[at + 1] ?? null) : null, breadcrumb };
}
