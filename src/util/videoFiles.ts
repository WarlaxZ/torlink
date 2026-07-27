/**
 * The video-first file heuristic, shared by every surface that has to answer
 * "which file in this torrent did they actually want to watch?".
 *
 * THIS MODULE MUST STAY DEPENDENCY-FREE. It is imported by `src/util/player.ts`
 * (Node: the TUI and the download queue) *and* by `src/web/static/streamFlow.ts`,
 * which tsup bundles with `platform: "browser"`. A single `node:*` import added
 * here — or an import of anything that transitively reaches one — breaks the web
 * build, loudly, which is the point: that build is the enforcement.
 *
 * It lives here rather than being reimplemented in the browser bundle because
 * this project has been bitten three times by exactly that shape of copy: a
 * hand-copied status payload that dropped `uploadSpeed`, a byte formatter that
 * diverged from the TUI's precision, and a progress unit read as a fraction on
 * one side and a percent on the other. Two copies of "is this a video file"
 * would drift the same way — the TUI would offer a picker of three files where
 * the dashboard offered thirty — and the divergence would be invisible until
 * someone compared the two screens.
 *
 * The functions are generic over the *shape* rather than tied to `StreamFile`,
 * because the two callers hold different types for the same thing: Node has
 * `StreamFile` (with an upstream `url`) and the browser has `PublicStreamFile`
 * (with a `handle` and an `index`). Both have a filename and a size, which is
 * all the heuristic ever reads, and returning the caller's own element type
 * means the browser keeps the `index` that addresses the file on the server.
 */

/** Extensions we treat as playable video, most-common first. */
const VIDEO_EXTS = new Set([
  "mkv",
  "mp4",
  "m4v",
  "avi",
  "mov",
  "webm",
  "ts",
  "m2ts",
  "flv",
  "wmv",
  "mpg",
  "mpeg",
]);

/** Lowercase extension after the last dot, or "" when there isn't one. */
function ext(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

/** Whether a filename looks like video, by extension. */
export function isVideoFilename(filename: string): boolean {
  return VIDEO_EXTS.has(ext(filename));
}

/** The minimum a file has to look like for the heuristic to read it. */
export interface NamedFile {
  filename: string;
}

export interface SizedFile extends NamedFile {
  bytes: number;
}

/**
 * Pick the file most worth streaming: the largest video file, or — if nothing
 * looks like video — the largest file overall. Returns null for an empty list.
 */
export function pickStreamFile<T extends SizedFile>(files: readonly T[]): T | null {
  if (files.length === 0) return null;
  const pool = streamCandidates(files);
  return pool.reduce((best, f) => (f.bytes > best.bytes ? f : best), pool[0]!);
}

/**
 * The files worth offering for streaming: the video files if any exist,
 * otherwise every file. Used to decide whether to show a picker (2+ items) and
 * what to list.
 *
 * "Otherwise every file" rather than "otherwise nothing" on purpose: a release
 * that ships a single `.bin` or an unrecognised container is still worth
 * handing to VLC, and an empty picker would be a dead end.
 */
export function streamCandidates<T extends NamedFile>(files: readonly T[]): T[] {
  const videos = files.filter((f) => isVideoFilename(f.filename));
  return videos.length > 0 ? videos : [...files];
}
