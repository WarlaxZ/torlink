/**
 * Which subtitle file belongs to which video, and what language it is in.
 *
 * THIS MODULE MUST STAY DEPENDENCY-FREE, for the reason ./videoFiles.ts gives
 * at length: it is imported by src/util/player.ts (Node) *and* by the browser
 * bundle, and this codebase has recorded four bugs caused by a helper being
 * copied between the two front ends and then drifting. A `node:*` import here —
 * or any import that transitively reaches one — breaks `npm run build`, loudly,
 * which is the enforcement.
 *
 * Deliberately separate from ./videoFiles.ts rather than added to it: a
 * subtitle must never enter `streamCandidates`, or it becomes something the
 * user can pick to *play*.
 */
import { isVideoFilename, type NamedFile } from "./videoFiles";

const SUBTITLE_EXTS = new Set(["srt", "vtt", "ass", "ssa", "sub"]);

// The two a <track> can carry, once srtToVtt has run. ass/ssa/sub need a real
// subtitle engine to render, which the browser has no equivalent of.
const RENDERABLE_EXTS = new Set(["srt", "vtt"]);

function ext(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

/** Whether a filename looks like a subtitle, by extension. */
export function isSubtitleFilename(filename: string): boolean {
  return SUBTITLE_EXTS.has(ext(filename));
}

/** Whether the browser can show this one as a `<track>` after conversion. */
export function isBrowserRenderable(filename: string): boolean {
  return RENDERABLE_EXTS.has(ext(filename));
}

// Path and extension stripped: "Subs/Kepler.S02E04/2_English.srt" -> "2_English".
function basename(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

// Languages worth naming. Two- and three-letter codes plus the English name,
// all mapping to one BCP-47 tag so <track srclang> is always well-formed.
//
// `iso3` is a separate, narrower list from `tokens`: `tokens` is every spelling
// a release name uses (including non-ISO aliases like Spanish "esp"), because
// `subtitleLanguage` below has to match filenames written by whoever uploaded
// the torrent. `iso3` is only the language's real ISO 639-2 tag(s) — what
// ffprobe actually emits — and is what `LANGUAGE_NAMES` below is built from.
// Conflating the two would let a filename alias like "esp" masquerade as an
// ffprobe tag it never produces.
const LANGUAGES: { code: string; label: string; iso3: string[]; tokens: string[] }[] = [
  { code: "en", label: "English", iso3: ["eng"], tokens: ["en", "eng", "english"] },
  {
    code: "es",
    label: "Spanish",
    iso3: ["spa"],
    tokens: ["es", "spa", "esp", "spanish", "castellano", "latino"],
  },
  { code: "pt", label: "Portuguese", iso3: ["por"], tokens: ["pt", "por", "portuguese", "brazilian"] },
  { code: "fr", label: "French", iso3: ["fre", "fra"], tokens: ["fr", "fre", "fra", "french"] },
  { code: "de", label: "German", iso3: ["ger", "deu"], tokens: ["de", "ger", "deu", "german"] },
  { code: "it", label: "Italian", iso3: ["ita"], tokens: ["it", "ita", "italian"] },
  { code: "nl", label: "Dutch", iso3: ["dut", "nld"], tokens: ["nl", "dut", "nld", "dutch"] },
  { code: "pl", label: "Polish", iso3: ["pol"], tokens: ["pl", "pol", "polish"] },
  { code: "ru", label: "Russian", iso3: ["rus"], tokens: ["ru", "rus", "russian"] },
  { code: "ja", label: "Japanese", iso3: ["jpn"], tokens: ["ja", "jpn", "japanese"] },
  { code: "ko", label: "Korean", iso3: ["kor"], tokens: ["ko", "kor", "korean"] },
  { code: "zh", label: "Chinese", iso3: ["chi", "zho"], tokens: ["zh", "chi", "zho", "chinese"] },
  { code: "ar", label: "Arabic", iso3: ["ara"], tokens: ["ar", "ara", "arabic"] },
  { code: "sv", label: "Swedish", iso3: ["swe"], tokens: ["sv", "swe", "swedish"] },
  { code: "da", label: "Danish", iso3: ["dan"], tokens: ["da", "dan", "danish"] },
  { code: "no", label: "Norwegian", iso3: ["nor"], tokens: ["no", "nor", "norwegian"] },
  { code: "fi", label: "Finnish", iso3: ["fin"], tokens: ["fi", "fin", "finnish"] },
  { code: "tr", label: "Turkish", iso3: ["tur"], tokens: ["tr", "tur", "turkish"] },
];

/**
 * ffprobe's tags are ISO 639-2, lowercase, three letters — this maps one to the
 * display name the fallback card and the embedded-subtitle notice both use.
 *
 * Built off `LANGUAGES.iso3` rather than duplicated: this table and
 * `subtitleLanguage` below used to be copied between `src/util` and
 * `src/web/static` as two separately-maintained lists of the same 22
 * languages, which is exactly the copy-then-drift shape this codebase has
 * already recorded four bugs from (see CLAUDE.md). One table, two shapes of
 * lookup, driven off the same data.
 */
export const LANGUAGE_NAMES: Record<string, string> = Object.fromEntries(
  LANGUAGES.flatMap((l) => l.iso3.map((tag) => [tag, l.label] as const)),
);

// Split on every separator a release name uses, so a token match is delimited.
// Without this, "Ashfall" contains "as" and "fa" and every file would look
// Spanish or Persian — a real failure mode, not a hypothetical one.
function tokensOf(path: string): string[] {
  return path.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * The language of a subtitle file, read from its path.
 *
 * Scans the WHOLE path, not just the basename: the `Subs/` layout puts the
 * language in the filename ("2_English.srt") while the flat layout puts it
 * before the extension ("....eng.srt"), and both are common.
 *
 * Later tokens win. "Kepler.S02E04.German.Dub.eng.srt" is an English subtitle
 * for a German dub, and the token nearest the extension is the subtitle's own.
 */
export function subtitleLanguage(filename: string): { code: string; label: string } {
  const tokens = tokensOf(filename);
  let found: { code: string; label: string } | null = null;
  for (const token of tokens) {
    const hit = LANGUAGES.find((l) => l.tokens.includes(token));
    if (hit) found = { code: hit.code, label: hit.label };
  }
  if (!found) return { code: "", label: basename(filename) };
  // A forced track subtitles only the foreign-language lines and an SDH one
  // adds sound description. Both are the same language and a different thing to
  // choose, so the distinction belongs in the label, not the code.
  if (tokens.includes("forced")) return { ...found, label: `${found.label} (forced)` };
  if (tokens.includes("sdh")) return { ...found, label: `${found.label} (SDH)` };
  return found;
}

// "S02E04" as written by anything: S02E04, s02e04, 2x04.
const EPISODE_RE = /\bs(\d{1,2})[\s._-]*e(\d{1,3})\b|\b(\d{1,2})x(\d{2,3})\b/i;

function episodeToken(path: string): string | null {
  const m = EPISODE_RE.exec(path);
  if (!m) return null;
  const season = m[1] ?? m[3];
  const episode = m[2] ?? m[4];
  if (!season || !episode) return null;
  return `s${Number(season)}e${Number(episode)}`;
}

/**
 * The subtitle files that belong to one video, by three rules in order. The
 * first rule that yields anything wins — they are not merged, because a pack
 * carrying both layouts would otherwise show the same language twice.
 *
 * 1. The subtitle's basename starts with the video's basename.
 * 2. Both paths carry the same SxxExx token — the `Subs/` folder layout.
 * 3. The torrent holds exactly one video, so every subtitle in it is that
 *    video's.
 *
 * Fuzzy title matching was considered and rejected: it would occasionally
 * attach the wrong episode's subtitle, which is worse than attaching none.
 */
export function subtitlesFor<T extends NamedFile>(video: T, files: readonly T[]): T[] {
  const subs = files.filter((f) => f !== video && isSubtitleFilename(f.filename));
  if (subs.length === 0) return [];

  const videoBase = basename(video.filename).toLowerCase();
  const byPrefix = subs.filter((s) => basename(s.filename).toLowerCase().startsWith(videoBase));
  if (byPrefix.length > 0) return byPrefix;

  const token = episodeToken(video.filename);
  if (token) {
    const byEpisode = subs.filter((s) => episodeToken(s.filename) === token);
    if (byEpisode.length > 0) return byEpisode;
    // A video that names an episode and found no subtitle naming the same one
    // stops here. Falling through to rule 3 would be impossible anyway (a pack
    // has several videos), but stopping says why.
    return [];
  }

  const videos = files.filter((f) => isVideoFilename(f.filename));
  return videos.length === 1 ? subs : [];
}

/**
 * The one subtitle to hand a player that accepts only one.
 *
 * English first because that is what this audience overwhelmingly wants, and a
 * full track over a forced one because a forced track subtitles only the
 * foreign-language lines — handing it over as THE subtitle would leave most of
 * the dialogue bare. The browser gets all of them regardless; only the external
 * player is limited to one.
 */
export function preferredSubtitle<T extends NamedFile>(matches: readonly T[]): T | null {
  if (matches.length === 0) return null;
  const english = matches.filter((m) => subtitleLanguage(m.filename).code === "en");
  const full = english.find((m) => !subtitleLanguage(m.filename).label.includes("("));
  return full ?? english[0] ?? matches[0] ?? null;
}
