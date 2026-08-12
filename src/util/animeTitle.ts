// src/util/animeTitle.ts

// Turn a raw anime torrent release name into a title string suitable for an
// AniList search, or null when nothing usable survives.
//
// AniList indexes anime by romaji / English / native title plus synonyms, and
// its search tolerates extra words far better than OMDb's exact title match —
// but fansub release names bury the title under group tags, quality blocks and
// an absolute episode number, and often glue several language variants together
// with "/". This strips it down to one best candidate.
//
// Pure and browser-safe: no node:* imports, direct or transitive.

// Does a string contain any Latin letter? Used to prefer a romaji/English
// alternative title (which AniList ranks strongly) over a CJK-only one.
function hasLatin(s: string): boolean {
  return /[A-Za-z]/.test(s);
}

// Is a token pure release noise (resolution / codec / source / sub markers)?
// Deliberately small and anchored to whole tokens — the goal is only to notice
// that a candidate is entirely metadata, not to enumerate every release word.
const NOISE = /^(?:\d{3,4}p|4k|2160p|1080p|720p|480p|hevc|x264|x265|h264|h265|10bit|aac|flac|ac3|eac3|ddp?\d?|web-?dl|webrip|bluray|bdrip|bdremux|remux|hdr|dv|multi-?subs?|dual|audio|sub|subs|raws?|tv|bili?bili|amzn|iqiyi|iq|baha|com)$/i;

// Split a title into whitespace tokens and drop the trailing run of pure-noise
// tokens ("Kestrel no Yoru WebRip 1080p" -> "Kestrel no Yoru"). Only trailing
// noise is trimmed; interior words are left alone.
function trimTrailingNoise(s: string): string {
  const tokens = s.split(/\s+/).filter(Boolean);
  while (tokens.length && NOISE.test(tokens[tokens.length - 1]!)) tokens.pop();
  return tokens.join(" ");
}

export function animeSearchTitle(rawName: string): string | null {
  let s = rawName;

  // 1. Strip leading bracketed group/source tags: "[NanakoRaws] ", "(2026) ".
  //    Looped because releases often stack two ("[ANi] [Baha] ..."); a single
  //    `.replace(..., "g")` call only removes the first, since `^` does not
  //    re-match mid-string even with the `g` flag.
  const leadingTag = /^\s*(?:\[[^\]]*\]|\([^)]*\))\s*/;
  while (leadingTag.test(s)) s = s.replace(leadingTag, "");

  // 2. Cut everything from the first remaining bracketed block onward — that is
  //    where the quality/codec/subtitle metadata lives ("... [WebRip 1080p]").
  const bracket = s.search(/[[(]/);
  if (bracket >= 0) s = s.slice(0, bracket);

  // 3. Strip an episode tail: "- 06", "- 1173", "- 第63话", "S01E04", "E06".
  s = s.replace(/\s*-\s*(?:第\s*\d+\s*话|\d{1,4})\s*$/u, "");
  s = s.replace(/\s+S\d{1,2}(?:E\d{1,4})?\s*$/i, "");
  s = s.replace(/\s+E\d{1,4}\s*$/i, "");

  // 4. Several language variants joined by "/" or "|": prefer a Latin-script
  //    segment (romaji/English), else keep the first.
  const parts = s.split(/[/|]/).map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1) {
    s = parts.find((p) => hasLatin(p)) ?? parts[0]!;
  } else {
    s = parts[0] ?? "";
  }

  // 5. Trim trailing pure-noise tokens and collapse whitespace.
  s = trimTrailingNoise(s).replace(/\s+/g, " ").trim();

  return s.length > 0 ? s : null;
}
