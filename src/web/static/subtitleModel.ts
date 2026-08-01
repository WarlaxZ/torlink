// What subtitles the player page should offer, and what it should say about the
// ones it cannot offer.
//
// Pure and tested, because nothing in player.ts is reachable by a unit test and
// these are decisions about WHAT TO SHOW — exactly the kind of conditional
// CLAUDE.md keeps out of the wiring file.
import { subtitlePath, type PlayerTarget } from "./playerModel";
import type { StreamInfoResponse } from "../wire";

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

// ffprobe's tags are ISO 639-2; the page wants words. Only the languages worth
// naming — anything else falls through to the count form below.
const LANGUAGE_NAMES: Record<string, string> = {
  eng: "English",
  spa: "Spanish",
  por: "Portuguese",
  fre: "French",
  fra: "French",
  ger: "German",
  deu: "German",
  ita: "Italian",
  dut: "Dutch",
  nld: "Dutch",
  pol: "Polish",
  rus: "Russian",
  jpn: "Japanese",
  kor: "Korean",
  chi: "Chinese",
  zho: "Chinese",
  ara: "Arabic",
  swe: "Swedish",
  dan: "Danish",
  nor: "Norwegian",
  fin: "Finnish",
  tur: "Turkish",
};

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
