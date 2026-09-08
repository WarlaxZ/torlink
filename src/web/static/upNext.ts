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
import { parseRelease, type ParsedRelease } from "../../util/release";
import { restPlaylist, type RestKind } from "../../util/restPlaylist";
import { sortStreamFiles } from "../../util/streamFileSort";
import { fileLabel, playerPath } from "./streamFlow";
import { formatBytes } from "./dashboard";
import { searchForRoute, DEFAULT_ROUTE } from "./route";
import type { PublicStreamFile, StreamFilesResponse } from "../wire";

export interface EpisodeRow {
  file: PublicStreamFile;
  /** `fileLabel`'s line — the fallback shown when nothing more specific parses out. */
  label: string;
  /**
   * `S05E04`, `S03` for a season-pack file that names no episode, `E04` for the
   * rarer case of an episode with no season, or null when the filename names
   * neither. Meant to sit at the START of the row in its own colour — the thing
   * that actually distinguishes one row from the next in a sixty-file list,
   * rather than being buried in the middle of a filename.
   */
  badge: string | null;
  /**
   * What to show after the badge: the episode's own title when the filename
   * commits to one ("King of Hell"), plus its size — or `label` when nothing
   * survives extraction. Composed here, not in player.ts, for the same reason
   * `label` always was: CLAUDE.md keeps "what to show" out of the DOM-wiring file.
   */
  text: string;
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
  /**
   * The show or film's own name, for a heading over the list — "The Boys" atop
   * sixty rows of its own filenames. Null when the release name parses to
   * nothing, in which case there is nothing honest to put in a heading and
   * `player.ts` renders none, same as `breadcrumb`'s dashboard fallback.
   */
  title: string | null;
  /**
   * The text for the "play on from here" download, or null for no button.
   *
   * HERE RATHER THAN IN `player.ts` because it is two decisions, and both are the
   * kind CLAUDE.md keeps out of the DOM-wiring files: whether a playlist from this
   * file onwards contains anything worth downloading, and whether it is honest to
   * call it a season. `restPlaylist` (src/util/restPlaylist.ts) is the same
   * function the server uses to pick the files, so the label and the file it
   * downloads cannot disagree — which they did: a bonus feature offered "rest of
   * season" and delivered every remaining extra followed by the whole show.
   */
  restLabel: string | null;
}

/** The dashboard, for when a release name tells us nothing to search for. */
const HOME: Breadcrumb = { label: "torlnk", href: "/" };

/**
 * Where the breadcrumb points, for any name that describes this session.
 *
 * Exported separately from {@link upNextView} because the player page renders it
 * TWICE: once from `?n=` before any request, so there is a way back even when
 * every fetch below fails, and again from the session's release name once
 * `.files` lands. The first of those is the one that matters — a session the
 * registry has reaped leaves a page that can neither play nor list anything, and
 * a breadcrumb that only appeared on success would be missing exactly then.
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
export function breadcrumbFor(name: string): Breadcrumb {
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

/**
 * The links out of the "needs a real player" card.
 *
 * This card is the end of the most common journey through the browser UI, and
 * it was a cul-de-sac: it named a problem, offered three ways to hand the file
 * to another application, and gave no way to avoid landing here again. Both
 * routes below are about NOT being here.
 *
 * - "Find a playable release" re-runs the search for the same title. Most shows
 *   are uploaded several times and an x264 copy is usually one of them, so the
 *   fix is very often two clicks away and there was nothing pointing at it.
 * - "Avoid this next time" opens the dashboard's playback preferences, which
 *   exist precisely to stop a release like this being picked — and which this
 *   screen never mentioned.
 *
 * Empty when the filename parses to nothing, because "search for nothing" is
 * not a route out. `?prefs=1` is a one-shot intent, not view state: app.ts
 * opens the disclosure and the next `replaceState` drops the parameter.
 */
export function escapeRoutes(filename: string): Breadcrumb[] {
  const crumb = breadcrumbFor(filename);
  if (crumb.href === HOME.href) return [{ label: "Avoid this next time", href: "/?prefs=1" }];
  return [
    { label: `Find a playable ${crumb.label}`, href: crumb.href },
    { label: "Avoid this next time", href: "/?prefs=1" },
  ];
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** "S05E04", "S03" for a season pack, "E04" for episode-with-no-season, or null. */
function badgeFor(parsed: ParsedRelease | null): string | null {
  if (!parsed) return null;
  const { season, episode } = parsed;
  if (season != null && episode != null) return `S${pad(season)}E${pad(episode)}`;
  if (season != null) return `S${pad(season)}`;
  if (episode != null) return `E${pad(episode)}`;
  return null;
}

/**
 * Where a release's own quality/source/codec tagging starts, once the episode
 * marker is behind it — "2160p" in "King.of.Hell.2160p.10bit.AMZN...". This is
 * NOT `parseRelease`: that answers "what does this release say", not "which
 * substring said it", and `parse-torrent-title` gives no match positions to
 * work from. A short, deliberately generic word list rather than every format
 * in the wild, because a marker this function fails to recognise just means the
 * fallback (the full filename) is shown — never a wrong guess.
 */
const QUALITY_MARKER =
  /\b(\d{3,4}[ip]|web[-.]?dl|webrip|web|bluray|bdrip|brrip|hdtv|dvdrip|remux|hdr|sdr|dv|hevc|avc|x264|x265|h264|h265|aac|ac3|dts|atmos|ddp?\d(\.\d)?|proper|repack|limited|extended|unrated|\d{1,2}bit)\b/i;

/**
 * The text between an episode's own `SxxEyy` marker and its quality tagging —
 * "King of Hell" out of "The.Boys.S05E04.King.of.Hell.2160p...HEVC-Vyndros.mkv"
 * — or null when nothing worth showing survives. Only ever called for a file
 * `parseRelease` has already said names an episode, on the theory that a season
 * pack's own filename ("Harrowgate.S03E01...") never carries a per-episode
 * title worth pulling out separately from the season/episode badge.
 *
 * Operates on the BASENAME: `file.filename` can carry the torrent's folder
 * ("Show (2019)/Show.S05E04....mkv"), and a folder name is not part of any one
 * episode's title.
 */
function episodeTitleOf(filename: string): string | null {
  const base = filename.slice(filename.lastIndexOf("/") + 1).replace(/\.[A-Za-z0-9]{2,4}$/, "");
  const marker = base.match(/[Ss]\d{1,2}[Ee]\d{1,3}/);
  if (!marker || marker.index === undefined) return null;
  const rest = base.slice(marker.index + marker[0].length).replace(/[._]+/g, " ").trim();
  if (!rest) return null;
  const quality = rest.match(QUALITY_MARKER);
  const candidate = (quality ? rest.slice(0, quality.index) : rest)
    .trim()
    .replace(/[.,;:\-\s]+$/, "");
  // No letters at all means it parsed to a stray number or separator, not a title.
  return candidate && /[A-Za-z]/.test(candidate) ? candidate : null;
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
  const title = parseRelease(body.name)?.title ?? null;
  if (body.files.length < 2) return { rows: [], next: null, breadcrumb, title: null, restLabel: null };

  // "name", the picker's default: a season pack listed in whatever order the
  // torrent named its files is the bug `sortStreamFiles` was extracted to fix,
  // and the two lists must not disagree about episode order.
  const sorted = sortStreamFiles(body.files, "name");
  const parsed = sorted.map((f) => parseRelease(f.filename));
  const seasons = parsed.map((p) => p?.season ?? null);
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
    const label = fileLabel(file);
    const episodeTitle = parsed[at]?.episode != null ? episodeTitleOf(file.filename) : null;
    return {
      file,
      label,
      badge: badgeFor(parsed[at] ?? null),
      text: episodeTitle ? `${episodeTitle} · ${formatBytes(file.bytes)}` : label,
      href: playerPath(sessionId, file, capability),
      current: file.index === index,
      heading,
    };
  });

  // A playlist of one file is the button that is already at the top of the page,
  // so one entry means no button. Note this is STRICTER than "there is a next
  // row": from the last episode of a season the next row may well be an extra,
  // and the season is still over.
  const rest = restPlaylist(body.files, index);
  const restLabel = rest.indexes.length > 1 ? restLabelFor(rest.kind) : null;

  const at = rows.findIndex((row) => row.current);
  return { rows, next: at >= 0 ? (rows[at + 1] ?? null) : null, breadcrumb, title, restLabel };
}

/**
 * What to call the playlist.
 *
 * "Rest of season" is a promise, and it is only true when the file we started
 * from named an episode. From a bonus feature the playlist is everything from
 * there on, and calling that a season is a lie the user only discovers in VLC.
 */
function restLabelFor(kind: RestKind): string {
  return kind === "season" ? "Download rest of season .m3u" : "Download the rest as .m3u";
}
