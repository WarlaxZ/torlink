// What subtitles the player page should offer, and what it should say about the
// ones it cannot offer.
//
// Pure and tested, because nothing in player.ts is reachable by a unit test and
// these are decisions about WHAT TO SHOW — exactly the kind of conditional
// CLAUDE.md keeps out of the wiring file.
import { subtitlePath, type PlayerTarget } from "./playerModel";
import type { StreamInfoResponse } from "../wire";
import { LANGUAGE_NAMES, preferredSubtitle } from "../../util/subtitleFiles";

/** One `<track>` the page should build. */
export interface TrackSpec {
  src: string;
  srclang: string;
  label: string;
  default: boolean;
}

/**
 * The `<track>` elements for this file.
 *
 * Only renderable siblings (srt/vtt, converted server-side). An ass/ssa track
 * would appear in the browser's menu and then show nothing, which is worse than
 * being absent — the user would think subtitles were on.
 *
 * The first English track is `default`; when nothing is English, nothing is,
 * because switching a viewer into a language they may not read is worse than
 * leaving the menu one click away.
 */
export function subtitleTracks(
  info: StreamInfoResponse | null,
  target: PlayerTarget,
): TrackSpec[] {
  const files = (info?.subtitles.files ?? []).filter((f) => f.renderable);
  const firstEnglish = files.find((f) => f.language === "en");
  return files.map((f) => ({
    src: subtitlePath(target, f.index),
    srclang: f.language,
    label: f.label,
    default: f === firstEnglish,
  }));
}

/**
 * One line naming the subtitle tracks muxed inside this file, for the fallback
 * card.
 *
 * This exists because of a real report: a season pack whose episodes each
 * carried three subtitle tracks played fine in VLC with the subtitles right
 * there in its menu, and nothing in torlink ever said so. The browser cannot
 * render them — that would mean extracting with ffmpeg — but it can say they
 * are there, which is the difference between a dead end and an instruction.
 */
/**
 * What to say when a `<track>` the page offered fails to load — the sibling
 * `.vtt` route answered 502, or the session was reaped between the menu being
 * built and the user picking a language from it.
 *
 * Names the language rather than staying generic, because the whole point is
 * to replace "I turned subtitles on and nothing happened" with an answer to
 * *why*: the file itself, not the browser, is what's missing.
 */
export function subtitleErrorNotice(spec: TrackSpec): string {
  const language = spec.label || "Subtitles";
  return `${language} subtitles couldn't load — try another language or turn them off.`;
}

/**
 * Decides which `<track>` load failures are worth a notice, so a file with
 * nine or ten sibling subtitle files doesn't turn one bad session into a wall
 * of the same message.
 *
 * A `<track>` is not fetched at all until it is enabled — the browser does not
 * probe every menu entry up front — so an `error` event almost always means
 * the user just selected that language and it failed *right now*. That is
 * worth reporting: it is the one thing on screen they were waiting on.
 *
 * What it is not worth repeating is the SAME track failing twice (a retry, or
 * more than one `error` event for one selection): once told, telling again
 * adds nothing. Each report is remembered by `src`, which is unique per track,
 * so switching to a different language after a failure still gets its own
 * notice — that failure is new information — while re-selecting the one that
 * already failed does not nag a second time.
 */
export interface TrackFailureTracker {
  report(spec: TrackSpec): string | null;
}

export function createTrackFailureTracker(): TrackFailureTracker {
  const reported = new Set<string>();
  return {
    report(spec: TrackSpec): string | null {
      if (reported.has(spec.src)) return null;
      reported.add(spec.src);
      return subtitleErrorNotice(spec);
    },
  };
}

/** A "Download subtitle" link for the player page's action row, or none. */
export interface SubtitleDownload {
  label: string;
  href: string;
}

/**
 * The preferred renderable subtitle's `.vtt` URL, as a download link — or
 * `null` when nothing matched.
 *
 * This exists because the `.m3u` no longer carries an `#EXTVLCOPT:input-slave`
 * line: measured against a real VLC 3.0.11, that line is refused outright
 * ("unsafe option \"input-slave\" has been ignored for security reasons"), so
 * it never side-loaded anything. mpv and IINA still get the subtitle
 * side-loaded via `subtitleArgs` (src/util/subtitleFlags.ts) when torlink
 * itself launches the player, but VLC users who download the playlist and
 * open it themselves get nothing that way — this link is what closes that
 * gap: they can save the file and open it in VLC by hand.
 *
 * Only renderable siblings, same rule as `subtitleTracks`: an .ass/.ssa
 * source would download as bytes that are valid WebVTT syntactically but
 * carry none of the original styling, and offering it under "Download
 * subtitle" implies it is the real file, which it is not.
 */
export function subtitleDownload(
  info: StreamInfoResponse | null,
  target: PlayerTarget,
): SubtitleDownload | null {
  const files = (info?.subtitles.files ?? []).filter((f) => f.renderable);
  const preferred = preferredSubtitle(files);
  if (!preferred) return null;
  return { label: "Download subtitle", href: subtitlePath(target, preferred.index) };
}

export function embeddedNotice(info: StreamInfoResponse | null): string {
  const tracks = info?.subtitles.embedded ?? [];
  if (tracks.length === 0) return "";
  const named = tracks.map((t) => LANGUAGE_NAMES[t.language.toLowerCase()]).filter(Boolean);
  if (named.length === tracks.length) {
    return `Subtitles in this file: ${named.join(", ")} — pick one in your player.`;
  }
  const plural = tracks.length === 1 ? "track" : "tracks";
  const pronoun = tracks.length === 1 ? "it" : "one";
  return `This file has ${tracks.length} subtitle ${plural} — pick ${pronoun} in your player.`;
}
