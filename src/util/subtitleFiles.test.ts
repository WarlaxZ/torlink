import { describe, expect, it } from "vitest";
import {
  isBrowserRenderable,
  isSubtitleFilename,
  preferredSubtitle,
  subtitleLanguage,
  subtitlesFor,
} from "./subtitleFiles";

const f = (filename: string): { filename: string } => ({ filename });

// `filename` is a basename only, as `StreamFile.filename` really is — `path`
// carries the torrent-relative path the `Subs/` layout needs. Mirrors what a
// real producer (torrentStream.ts, realdebrid.ts, torbox.ts) now emits.
const fp = (filename: string, path: string): { filename: string; path: string } => ({
  filename,
  path,
});

describe("isSubtitleFilename", () => {
  it("accepts the five subtitle extensions", () => {
    for (const ext of ["srt", "vtt", "ass", "ssa", "sub"]) {
      expect(isSubtitleFilename(`Kestrel.2010.1080p.${ext}`)).toBe(true);
    }
  });

  it("rejects video and everything else", () => {
    expect(isSubtitleFilename("Kestrel.2010.1080p.BluRay.x264.mkv")).toBe(false);
    expect(isSubtitleFilename("readme.nfo")).toBe(false);
    expect(isSubtitleFilename("no-extension")).toBe(false);
  });

  it("is case insensitive", () => {
    expect(isSubtitleFilename("Kestrel.2010.EN.SRT")).toBe(true);
  });
});

describe("isBrowserRenderable", () => {
  it("is true for srt and vtt, which convert to WebVTT", () => {
    expect(isBrowserRenderable("Kestrel.2010.eng.srt")).toBe(true);
    expect(isBrowserRenderable("Kestrel.2010.eng.vtt")).toBe(true);
  });

  it("is false for ass, ssa and sub", () => {
    // <track> cannot render these without a subtitle engine. They are still
    // matched and still handed to VLC/mpv, which render them natively.
    expect(isBrowserRenderable("Kestrel.2010.eng.ass")).toBe(false);
    expect(isBrowserRenderable("Kestrel.2010.eng.ssa")).toBe(false);
    expect(isBrowserRenderable("Kestrel.2010.eng.sub")).toBe(false);
  });
});

describe("subtitleLanguage", () => {
  it("reads a three-letter code before the extension", () => {
    expect(subtitleLanguage("Kepler.S02E04.1080p.WEB-DL.eng.srt")).toEqual({
      code: "en",
      label: "English",
    });
  });

  it("reads a two-letter code", () => {
    expect(subtitleLanguage("Kepler.S02E04.es.srt").code).toBe("es");
  });

  it("reads a spelled-out language anywhere in the path", () => {
    expect(subtitleLanguage("Subs/Kepler.S02E04/3_Portuguese.srt")).toEqual({
      code: "pt",
      label: "Portuguese",
    });
  });

  it("marks forced and SDH variants in the label but keeps the code", () => {
    expect(subtitleLanguage("Kepler.S02E04.eng.forced.srt")).toEqual({
      code: "en",
      label: "English (forced)",
    });
    expect(subtitleLanguage("Kepler.S02E04.eng.sdh.srt")).toEqual({
      code: "en",
      label: "English (SDH)",
    });
  });

  it("falls back to the basename when no language is detectable", () => {
    // Better than labelling every unknown "Subtitles": a user with two of them
    // needs to tell them apart, and the filename is the only thing that does.
    expect(subtitleLanguage("Subs/2_track.srt")).toEqual({ code: "", label: "2_track" });
  });

  it("does not read a language out of the show title", () => {
    // "Ashfall" contains no code, but a naive scan for "as" or "fa" would find
    // one. Language tokens must be delimited.
    expect(subtitleLanguage("Ashfall.1999.1080p.srt").code).toBe("");
  });
});

describe("subtitlesFor", () => {
  it("rule 1: matches a subtitle whose basename starts with the video's", () => {
    const video = f("Kepler.S02E04.1080p.WEB-DL.mkv");
    const sub = f("Kepler.S02E04.1080p.WEB-DL.eng.srt");
    expect(subtitlesFor(video, [video, sub, f("readme.nfo")])).toEqual([sub]);
  });

  it("rule 2: matches on a shared SxxExx token across folders", () => {
    // The layout scene season packs actually use, and the reason rule 1 alone
    // is not enough.
    const video = f("Kepler.S02E04.1080p.WEB-DL.mkv");
    const mine = f("Subs/Kepler.S02E04/2_English.srt");
    const theirs = f("Subs/Kepler.S02E05/2_English.srt");
    expect(subtitlesFor(video, [video, mine, theirs])).toEqual([mine]);
  });

  it("rule 2 does not fire across different seasons", () => {
    const video = f("Kepler.S02E04.1080p.WEB-DL.mkv");
    const other = f("Subs/Kepler.S03E04/2_English.srt");
    expect(subtitlesFor(video, [video, other])).toEqual([]);
  });

  it("rule 3: a lone video takes every subtitle in the torrent", () => {
    const video = f("Kestrel.2010.1080p.BluRay.x264.mkv");
    const a = f("Subs/English.srt");
    const b = f("Subs/Spanish.srt");
    expect(subtitlesFor(video, [video, a, b])).toEqual([a, b]);
  });

  it("rule 3 does NOT fire when the torrent holds several videos", () => {
    // THE REGRESSION THIS GUARDS. A season pack plus one unmatched subtitle
    // must attach that subtitle to nothing, rather than to all ten episodes.
    const e04 = f("Kepler.S02E04.1080p.WEB-DL.mkv");
    const e05 = f("Kepler.S02E05.1080p.WEB-DL.mkv");
    const orphan = f("Subs/whatever.srt");
    expect(subtitlesFor(e04, [e04, e05, orphan])).toEqual([]);
  });

  it("rule 3 does not fire for several NON-episodic videos either", () => {
    // The case the rule-2 early return cannot cover, and the one that matters
    // for a movie-pack torrent: two videos carrying no SxxExx token at all, so
    // control actually reaches rule 3's `videos.length === 1` guard. Without
    // this, that guard could be replaced by `return subs` and the suite would
    // stay green.
    const a = f("Kestrel.2010.1080p.BluRay.x264.mkv");
    const b = f("Ashfall.1999.1080p.mkv");
    const orphan = f("Subs/English.srt");
    expect(subtitlesFor(a, [a, b, orphan])).toEqual([]);
  });

  it("prefers rule 1 over rule 2 rather than merging them", () => {
    // A pack with both layouts: the exact-basename match is the confident one,
    // and returning both would put a duplicate language in the track menu.
    const video = f("Kepler.S02E04.1080p.WEB-DL.mkv");
    const exact = f("Kepler.S02E04.1080p.WEB-DL.eng.srt");
    const folder = f("Subs/Kepler.S02E04/2_English.srt");
    expect(subtitlesFor(video, [video, exact, folder])).toEqual([exact]);
  });

  it("rule 2 fires from `path` when `filename` is only a basename", () => {
    // The real shape StreamFile.filename takes: a bare basename, the folder
    // discarded. Without `path` carrying "Subs/Kepler.S02E04/...", rule 2 has
    // nothing to read the SxxExx token from and this pack goes unsubtitled.
    const video = f("Kepler.S02E04.1080p.WEB-DL.mkv");
    const mine = fp("2_English.srt", "Subs/Kepler.S02E04/2_English.srt");
    const theirs = fp("2_English.srt", "Subs/Kepler.S02E05/2_English.srt");
    expect(subtitlesFor(video, [video, mine, theirs])).toEqual([mine]);
  });

  it("does NOT fire rule 2 from filename alone when `path` is absent", () => {
    // The honest fallback: a basename-only subtitle carries no folder, so no
    // SxxExx token is available anywhere, and the matcher must say "no match"
    // rather than silently misfiring or guessing.
    const video = f("Kepler.S02E04.1080p.WEB-DL.mkv");
    const orphan = f("2_English.srt");
    expect(subtitlesFor(video, [video, orphan])).toEqual([]);
  });

  it("returns nothing when the torrent has no subtitles at all", () => {
    // The season pack that prompted this feature: ten episodes, nothing else.
    const video = f("Harrowgate.S03.1080p.WEB-DL.mkv");
    expect(subtitlesFor(video, [video])).toEqual([]);
  });

  it("never matches the video against itself", () => {
    const video = f("Kestrel.2010.1080p.BluRay.x264.mkv");
    expect(subtitlesFor(video, [video])).toEqual([]);
  });
});

describe("preferredSubtitle", () => {
  it("prefers English over whatever came first", () => {
    const spa = f("Kepler.S02E04.spa.srt");
    const eng = f("Kepler.S02E04.eng.srt");
    expect(preferredSubtitle([spa, eng])).toBe(eng);
  });

  it("prefers a plain English track over a forced one", () => {
    // A forced track only subtitles the foreign-language lines, so handing it
    // to VLC as THE subtitle would leave most dialogue bare.
    const forced = f("Kepler.S02E04.eng.forced.srt");
    const full = f("Kepler.S02E04.eng.srt");
    expect(preferredSubtitle([forced, full])).toBe(full);
  });

  it("falls back to the first when no English exists", () => {
    const spa = f("Kepler.S02E04.spa.srt");
    const por = f("Kepler.S02E04.por.srt");
    expect(preferredSubtitle([spa, por])).toBe(spa);
  });

  it("returns null for no matches", () => {
    expect(preferredSubtitle([])).toBeNull();
  });
});
