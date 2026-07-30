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

/** The whole path with its separators read as dots, so a folder can be parsed. */
function flattened(path: string): string {
  return path.replace(/[\\/]+/g, ".");
}

/**
 * The episode one spelling of a filename names, or null.
 *
 * A season with no episode is null, not a half-answer: a file inside
 * "Harrowgate.S03/" has named a season and committed to no episode, and treating
 * that as episode 1 is the guess `nextEpisode` deliberately refuses to make.
 */
function episodeIn(spelling: string): EpisodeRef | null {
  const parsed = parseRelease(spelling);
  if (!parsed || parsed.season === undefined || parsed.episode === undefined) return null;
  return { season: parsed.season, episode: parsed.episode };
}

/** Whether a filename names an episode at all, under either spelling. */
function namesAnyEpisode(filename: string): boolean {
  return episodeIn(basename(filename)) !== null || episodeIn(flattened(filename)) !== null;
}

function isEpisode(found: EpisodeRef | null, next: EpisodeRef): boolean {
  return found !== null && found.season === next.season && found.episode === next.episode;
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
    // TWO PASSES OVER THE WHOLE LIST, not one pass over both spellings per file.
    // Filenames are not release names, so two spellings are tried: a file's own
    // basename ("Harrowgate.S03/Harrowgate.S03E05.1080p.mkv"), then its whole
    // path, which catches the layout that puts the episode in the directory and
    // nothing in the file ("Harrowgate.S03E05/video.mkv").
    //
    // Basename first is a rule about the LIST, and reading it per file inverts
    // it: "Harrowgate.S03E05/sample.mkv" matches on its folder, so a per-file
    // loop returns the sample and never looks at the real episode sitting next
    // to it — a cursor the picker's title sort had already got right.
    const byName = files.findIndex((file) => isEpisode(episodeIn(basename(file.filename)), next));
    if (byName >= 0) return byName;
    const byPath = files.findIndex((file) => isEpisode(episodeIn(flattened(file.filename)), next));
    if (byPath >= 0) return byPath;
  }
  // Nothing parsed as the wanted episode — which happens both when no episode
  // was wanted (a film, a pack naming no episode) and when the wanted one is
  // simply not in this torrent. Either way `watched` is an INDEPENDENT signal
  // and still worth reading: the first thing not yet watched beats the first
  // thing overall. An empty watched list says nothing, and every file watched
  // says nothing either.
  //
  // In two passes for the same reason as above. "The first file you haven't
  // watched" in torrent order is `sample.mkv` as readily as it is an episode,
  // and a file that names SOME episode is the better guess even when it is not
  // the episode asked for. The second pass keeps the case where nothing in the
  // torrent is numbered at all — a film in parts, an unrecognised naming
  // scheme — behaving as it did.
  if (hint.watched && hint.watched.length > 0) {
    const seen = new Set(hint.watched);
    const numbered = files.findIndex(
      (file) => !seen.has(file.filename) && namesAnyEpisode(file.filename),
    );
    if (numbered >= 0) return numbered;
    const unwatched = files.findIndex((file) => !seen.has(file.filename));
    if (unwatched >= 0) return unwatched;
  }
  return null;
}
