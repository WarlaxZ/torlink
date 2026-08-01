/**
 * What one entry in a `.m3u` is called.
 *
 * WHY THIS IS A MODULE AND NOT A TEMPLATE STRING. The `.m3u` route deliberately
 * wrote bare URLs for a long time, on the grounds that an `#EXTINF` title means
 * interpolating a filename — which comes from whoever made the torrent — into a
 * file another application parses. That objection is right, and this is the
 * answer to it rather than a decision to ignore it:
 *
 * - **A newline is the real hazard.** A playlist is parsed line by line, so a
 *   filename carrying `\n` followed by a URL would ADD AN ENTRY pointing
 *   wherever its author chose. CR, LF and every C0/C1 control character go.
 * - A leading `#` is removed, so a title cannot pose as a directive.
 * - The result is capped, because a title is a label and not a payload.
 * - Commas STAY. `#EXTINF`'s duration separator is the *first* comma on the
 *   line and the title is everything after it, so "Ashfall, Rising" is both
 *   safe and correct.
 *
 * The point of having titles at all: a season playlist of thirteen bare URLs is
 * thirteen indistinguishable rows in whatever opens it, and the user cannot tell
 * which is the episode they want until it starts playing.
 *
 * It lives in `src/util/` because the server builds the playlist body and
 * `parseRelease` already lives here. Browser-safe: no `node:*`, directly or
 * transitively — `npm run build` is the enforcement, following imports where a
 * grep cannot.
 */
import { parseRelease } from "./release";

/** `#EXTINF` is one line; a label longer than this is not helping anyone. */
const MAX = 120;

/** C0 and C1, which covers CR, LF, NUL and every terminal escape. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * `S03E01`, and `S03E01E02` for a double bill. Case-insensitive because releases
 * write it every way, and upper-cased on the way out so one playlist does not
 * mix `s03e01` and `S03E02` rows.
 */
const TAG = /S\d{1,2}E\d{1,3}(?:E\d{1,3})*/i;

/**
 * An episode name follows the tag only when a SPACED dash introduced it — the
 * shape Sonarr and Plex write. Dot-delimited text after a tag is release junk
 * (`.1080p.WEB-DL`), and guessing otherwise puts "1080p WEB DL" in front of the
 * user as a title.
 */
const SPACED_DASH = /^\s+[-–—]\s+/;

/** Where an episode name ends: the bracketed quality group that follows it. */
const BRACKET = /\s+[([].*$/;

export function playlistTitle(filename: string): string {
  const base = basename(filename);
  const tag = TAG.exec(base);
  if (tag) {
    // The show's name in front of the tag, so a row reads "Harrowgate S03E01"
    // rather than an `S03E01` that could belong to anything. Absent when the
    // name parses to nothing, and then the tag stands alone.
    const show = parseRelease(base)?.title ?? "";
    const label = [show, tag[0].toUpperCase()].filter(Boolean).join(" ");
    const name = episodeName(base.slice(tag.index + tag[0].length));
    return clamp(sanitise(name ? `${label} · ${name}` : label)) || fallback(base);
  }
  // No tag: a film, a bonus feature, or something that parses as neither.
  // `parseRelease` is what strips `1080p.BluRay.x264` off a film's name.
  const parsed = parseRelease(base);
  const named = parsed ? [parsed.title, parsed.year].filter(Boolean).join(" ") : "";
  return clamp(sanitise(named || spaced(base))) || fallback(base);
}

/**
 * The filename alone: no directory, no extension.
 *
 * Both separators, because a torrent made on Windows names its paths with
 * backslashes and a row reading "Harrowgate.S03/" tells the user nothing.
 */
function basename(filename: string): string {
  const leaf = filename.split(/[/\\]/).pop() ?? "";
  return leaf.replace(/\.[^.]{1,10}$/, "");
}

/** The episode name after a tag, or "" when the shape says there isn't one. */
function episodeName(rest: string): string {
  if (!SPACED_DASH.test(rest)) return "";
  return rest.replace(SPACED_DASH, "").replace(BRACKET, "").trim();
}

/** A dotted or underscored name as words: `Bonus_Gag_Reel_1` → `Bonus Gag Reel 1`. */
function spaced(base: string): string {
  return base.replace(/[._]+/g, " ");
}

/**
 * Everything that must not reach the file.
 *
 * Note the ORDER: controls are removed first, so a `#` hidden behind a stripped
 * character cannot end up leading the line afterwards.
 */
function sanitise(text: string): string {
  return text.replace(CONTROL, "").replace(/\s+/g, " ").trim().replace(/^#+\s*/, "").trim();
}

function clamp(text: string): string {
  return text.length > MAX ? text.slice(0, MAX).trim() : text;
}

/**
 * The last resort. `#EXTINF:-1,` with nothing after the comma is worse than no
 * title at all, so this never returns "".
 */
function fallback(base: string): string {
  return clamp(sanitise(spaced(base))) || "stream";
}
