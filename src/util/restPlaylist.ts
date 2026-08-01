/**
 * Which files a "play on from here" playlist contains — the rule, shared.
 *
 * WHY IT IS HERE AND NOT IN `src/web/stream.ts`, where it started. Two surfaces
 * need the same answer: the server picks the files that go into the `.m3u`, and
 * the player page decides what the button is called and whether to show it at
 * all. Two implementations of one rule is the copy-then-drift bug this codebase
 * has recorded four times, so the rule is in one place and both call it.
 *
 * WHAT WAS WRONG WITH THE OLD RULE. "This file and every later one in name order"
 * is only accidentally right. Started from a bonus feature it yields every
 * remaining extra and then the whole season, under a button that says "rest of
 * season" — which is what a user reported. Started from an episode it happens to
 * be correct only while the extras sort clear of the episodes, and a torrent that
 * names one `Show.S03E02.Deleted.Scenes` breaks even that.
 *
 * Generic over the shape for the reason `sortStreamFiles` is: the server holds
 * `StreamFile` with an upstream `url`, the browser holds `PublicStreamFile` with a
 * `handle`, and each keeps the field that addresses its own file. Browser-safe:
 * no `node:*` here or in anything it reaches — `npm run build` is what proves it.
 */
import { parseRelease } from "./release";
import { sortStreamFiles } from "./streamFileSort";
import { streamCandidates, type SizedFile } from "./videoFiles";
import type { EpisodeRef } from "./episode";

/**
 * What the playlist turned out to mean. The caller words the button from this: a
 * season may be called a season, and anything else must not be.
 */
export type RestKind = "season" | "everything";

export interface RestPlaylist {
  kind: RestKind;
  /** Session indexes in play order, the current file first. Never empty. */
  indexes: number[];
}

/** A file that knows its own position in the session — the `:idx` of its handle. */
export interface IndexedFile extends SizedFile {
  index: number;
}

export function restPlaylist<T extends IndexedFile>(
  files: readonly T[],
  index: number,
): RestPlaylist {
  // The picker's order, and the episode list's: a playlist that ran E08, E02, E03
  // is the bug `sortStreamFiles` was extracted to fix. `streamCandidates` drops
  // the `.nfo`s, because handing a text file to a media player is how a playlist
  // stalls halfway through a season.
  const ordered = sortStreamFiles(streamCandidates(files), "name");
  const at = ordered.findIndex((file) => file.index === index);
  // A hand-edited URL, or the index of a file the video filter removed. One entry
  // is the honest answer: that file does exist and does play.
  if (at < 0) return { kind: "everything", indexes: [index] };

  const here = episodeOf(ordered[at]!.filename);
  const rest = ordered.slice(at);
  if (!here) return { kind: "everything", indexes: rest.map((file) => file.index) };

  // A season means the files that name an episode OF THIS SEASON. The current
  // file is always in, whatever the filter would otherwise say about it.
  const indexes = rest
    .filter((file, offset) => {
      if (offset === 0) return true;
      const ep = episodeOf(file.filename);
      return ep !== null && ep.season === here.season;
    })
    .map((file) => file.index);
  return { kind: "season", indexes };
}

/**
 * The episode a filename commits to, or null.
 *
 * BOTH numbers are required. A season-pack file and a bonus feature inside a
 * season folder both parse to a season with no episode, and treating that as
 * "episode 1 of that season" is exactly what would sweep the extras back in.
 */
function episodeOf(filename: string): EpisodeRef | null {
  const parsed = parseRelease(filename);
  if (parsed?.season === undefined || parsed.episode === undefined) return null;
  return { season: parsed.season, episode: parsed.episode };
}
