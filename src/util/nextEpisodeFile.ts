/**
 * Which file in a multi-file torrent the picker should open on.
 *
 * A DECISION, not wiring, and both front ends need it: the TUI's
 * `StreamFilePrompt` and the browser's picker both open on a season pack the
 * user is part-way through, and a Continue-watching row that honestly says
 * "next S03E05" is a lie if the cursor then sits on S03E01.
 *
 * It lives beside `videoFiles.ts` rather than in it because it imports
 * `release.ts` (and so `parse-torrent-title`), and `videoFiles.ts` promises to
 * stay dependency-free. Like that module it is generic over the *shape*: Node
 * holds `ResolvedFile`, the browser holds `PublicStreamFile`, and both have a
 * filename, which is all this reads. Bundled for the browser via
 * `src/web/static/streamFlow.ts`, so: no `node:*` imports, direct or transitive.
 *
 * A SUGGESTION, never a claim. Nothing here has asked a tracker whether the
 * episode exists, and "no opinion" (null) is an ordinary answer that leaves the
 * picker behaving exactly as it always has.
 */
import { parseRelease } from "./release";
import type { EpisodeRef } from "./episode";
import type { NamedFile } from "./videoFiles";

export interface NextEpisodeHint {
  /**
   * The episode to look for.
   *
   * PASS `nextEpisode(item)` FROM `src/core/streamHistory.ts` — the whole reason
   * this is a `{season, episode}` pair rather than two loose numbers is that the
   * "+1" over the row's high-water mark must be computed in exactly one place,
   * the same one `nextLabel` displays from. This codebase has four recorded
   * copy-then-drift bugs; a second `+1` would be the fifth.
   *
   * Null for a film and for a season pack that names no episode — that judgement
   * is `nextEpisode`'s and is deliberately not re-derived here.
   */
  next?: EpisodeRef | null;
  /**
   * Filenames already streamed — `watchedFor(config.favourites, infoHash)`, plus
   * whatever this picker session has played. Used only when the parse has
   * nothing to say.
   */
  watched?: readonly string[];
}

/** The last path segment, for either separator. Torrent paths use both. */
function basename(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}

/**
 * Whether a filename names the wanted episode.
 *
 * Filenames are not release names, so two spellings are tried: the basename
 * ("Harrowgate.S03/Harrowgate.S03E05.1080p.mkv"), then the whole path with its
 * separators read as dots, which catches the layout that puts the episode in the
 * directory and nothing in the file ("Harrowgate.S03E05/video.mkv"). Basename
 * first, so a file's own numbering always beats its folder's.
 */
function namesEpisode(filename: string, next: { season: number; episode: number }): boolean {
  const spellings = [basename(filename)];
  const flattened = filename.replace(/[\\/]+/g, ".");
  if (flattened !== spellings[0]) spellings.push(flattened);
  for (const spelling of spellings) {
    const parsed = parseRelease(spelling);
    if (parsed && parsed.season === next.season && parsed.episode === next.episode) return true;
  }
  return false;
}

/**
 * The index in `files` to open the picker on, or null when there is no opinion.
 *
 * An index into the list AS GIVEN. Callers that re-order for display (the TUI's
 * picker sorts by title or size) must resolve it back to the file's own identity
 * before using it as a cursor position — an index into an array the user is not
 * looking at points at the wrong row.
 */
export function nextEpisodeIndex<T extends NamedFile>(
  files: readonly T[],
  hint: NextEpisodeHint,
): number | null {
  if (files.length === 0) return null;
  const next = hint.next;
  if (next) {
    const parsed = files.findIndex((file) => namesEpisode(file.filename, next));
    if (parsed >= 0) return parsed;
  }
  // Nothing parsed. If we know what has been watched, the first thing that
  // hasn't is a better guess than the first thing overall. An empty watched list
  // says nothing, and every file watched says nothing either.
  if (hint.watched && hint.watched.length > 0) {
    const seen = new Set(hint.watched);
    const unwatched = files.findIndex((file) => !seen.has(file.filename));
    if (unwatched >= 0) return unwatched;
  }
  return null;
}
