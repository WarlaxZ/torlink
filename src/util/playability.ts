// What a browser can be expected to play, and why it can't when it can't.
//
// Front-end agnostic on purpose: the web's `.info` route builds this server
// side, and the player page's rung selection reads it client side. Both need the
// same vocabulary, so it lives here rather than in either of them.
//
// Nothing here imports node:*. It is reachable from the browser bundle.
import { parseRelease } from "./release";

/**
 * One subtitle track muxed inside the file, as ffprobe reports it.
 *
 * Reported, never extracted: pulling one out would mean spawning ffmpeg, which
 * this project does not do in production, and it would only help files the
 * browser can already play. What this buys is the ability to TELL the user the
 * tracks are there — the failure that prompted it was a season pack whose three
 * embedded tracks were invisible in both front ends.
 */
export interface EmbeddedSubtitle {
  /** ffprobe's own language tag ("eng", "spa"), or "" when untagged. */
  language: string;
  /** The stream's title tag ("SDH", "Forced"), or "". */
  label: string;
}

/** What we know about one file's container and codecs, and how we know it. */
export interface MediaFacts {
  /** Lowercase container: "mkv", "mp4", "webm". Empty when unknown. */
  container: string;
  /** Normalised video codec: "h264", "hevc", "av1", "vp9", "mpeg2". Empty when unknown. */
  videoCodec: string;
  /**
   * Normalised audio codec: "aac", "dts", "truehd", "ac3", "eac3", "flac",
   * "opus", "mp3". Empty when unknown.
   */
  audioCodec: string;
  /**
   * `probe` came from ffprobe and is trustworthy. `name` was inferred from a
   * release name and is a good guess — a release named x264 can still carry
   * something else. Consumers must not treat the two as equally reliable when
   * deciding whether to spend money (CPU, bandwidth) on the answer.
   */
  source: "probe" | "name";
  /**
   * Subtitle tracks muxed into the file. Always empty from `classifyFromName`:
   * a release name cannot know what is inside the container.
   */
  subtitles: EmbeddedSubtitle[];
}

/** Why a browser will refuse this file. Empty means it should play. */
export type Blocker = "container" | "video" | "audio";

/** Lowercase extension without the dot, or "" when there isn't a usable one. */
export function extensionOf(filename: string): string {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(filename);
  return m ? m[1]!.toLowerCase() : "";
}

// Containers every browser that matters demuxes. Short on purpose: mkv is not
// one of them in any shipping browser, and mkv is what most of the scene ships.
const SAFE_CONTAINERS = new Set(["mp4", "m4v", "webm"]);

// Codecs a browser will decode from one of those containers. Conservative:
// ac3/eac3 are Safari-only, and av1 is absent on older hardware, so neither is
// listed. Being wrong in this direction costs a fallback card; being wrong in
// the other costs a black rectangle.
const SAFE_VIDEO = new Set(["h264", "vp8", "vp9"]);
const SAFE_AUDIO = new Set(["aac", "mp3", "opus", "vorbis", "flac"]);

/**
 * Map the release parser's vocabulary onto the names above.
 *
 * `parse-torrent-title` reports whatever the release said — "x264", "H.264",
 * "AVC", "x265", "HEVC" — so this cannot be a lookup of exact strings, and a
 * codec it has never heard of must come back empty rather than wrong.
 *
 * Note what is deliberately NOT here: any inference from resolution. Most 2160p
 * releases are HEVC, but "most" is not a fact about the file in hand, and being
 * wrong would show a "can't decode the video" card for a 4K H.264 file that
 * would have played. ffprobe is how that guess becomes knowledge.
 */
export function normaliseVideoCodec(raw: string | undefined): string {
  const s = (raw ?? "").toLowerCase();
  if (!s) return "";
  if (/x?265|hevc/.test(s)) return "hevc";
  if (/x?264|avc/.test(s)) return "h264";
  if (/av1/.test(s)) return "av1";
  if (/vp9/.test(s)) return "vp9";
  if (/mpeg-?2|xvid|divx/.test(s)) return "mpeg2";
  return "";
}

/**
 * The audio codec a release name implies, worst-case first.
 *
 * `audioList` carries every match — a release can say both "TrueHD" and
 * "Atmos", or both "DTS" and "AAC" for a dual-audio file. The pessimistic pick
 * is right: if any track named is one a browser refuses, the browser may well
 * select it, and a file that stalls on track 2 is the failure this avoids.
 *
 * Atmos maps to truehd because that is what carries it in practice, and because
 * the distinction does not matter to the only question being asked — a browser
 * decodes neither.
 */
export function normaliseAudioCodec(list: string[] | undefined): string {
  const all = (list ?? []).map((a) => a.toLowerCase()).join(" ");
  if (!all) return "";
  if (/truehd|atmos/.test(all)) return "truehd";
  if (/dts/.test(all)) return "dts";
  if (/e-?ac-?3|ddp|dd\+/.test(all)) return "eac3";
  if (/ac-?3|dolby digital|\bdd\b/.test(all)) return "ac3";
  if (/flac/.test(all)) return "flac";
  if (/opus/.test(all)) return "opus";
  if (/aac/.test(all)) return "aac";
  if (/mp3/.test(all)) return "mp3";
  return "";
}

/**
 * Best-effort facts from names alone. No binary, no network, always available.
 *
 * `releaseName` is preferred for codecs because a debrid provider often hands
 * back a renamed file ("1.mkv") while the torrent it came from is named in
 * full. The container still comes from the actual filename: that is the one
 * thing the filename is authoritative about.
 */
export function classifyFromName(filename: string, releaseName?: string): MediaFacts {
  // parseRelease returns null when no usable title survives — a name that was
  // only quality and codec noise. That costs us the codec fields and nothing
  // else: the container still comes from the filename, so such a file is
  // classified exactly as an unknown-codec one, which is the honest answer.
  const parsed = parseRelease(releaseName || filename);
  return {
    container: extensionOf(filename),
    videoCodec: normaliseVideoCodec(parsed?.codec),
    audioCodec: normaliseAudioCodec(parsed?.audioList),
    source: "name",
    subtitles: [],
  };
}

/**
 * Every reason a browser will refuse this file.
 *
 * An unknown *container* blocks — that is the existing behaviour and it is
 * right, because showing a card is honest and takes one tap to work around
 * where a black rectangle looks like the app is broken. An unknown *codec* does
 * not block: most release names say nothing about audio, and blocking there
 * would send files to the card that play fine.
 */
export function blockersFor(facts: MediaFacts): Blocker[] {
  const blockers: Blocker[] = [];
  if (!SAFE_CONTAINERS.has(facts.container)) blockers.push("container");
  if (facts.videoCodec && !SAFE_VIDEO.has(facts.videoCodec)) blockers.push("video");
  if (facts.audioCodec && !SAFE_AUDIO.has(facts.audioCodec)) blockers.push("audio");
  return blockers;
}
